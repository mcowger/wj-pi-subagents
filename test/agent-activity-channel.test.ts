import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  SupervisorChannel,
  SupervisorProtocolError,
  SupervisorRequestIdRegistry,
  type SupervisorActivityDelivery,
  type SupervisorFrame,
  type SupervisorReceiveResult,
} from "../src/supervisor-channel.ts";
import {
  StreamSupervisorChannel,
} from "../src/stream-supervisor-channel.ts";

const ROOT_ID = "root-activity";
const CREDENTIAL = "activity-channel-credential";

interface Pair {
  readonly parent: SupervisorChannel;
  readonly child: SupervisorChannel;
  readonly childAgentId: string;
  readonly grandchildAgentId: string;
}

function childSnapshotNodes(
  childAgentId: string,
  grandchildAgentId: string,
): readonly Record<string, unknown>[] {
  return Object.freeze([
    Object.freeze({
      agent_id: childAgentId,
      parent_agent_id: null,
      template_id: "researcher",
      name: "活动子代理",
      depth: 1,
      state: "idle",
      revision: 1,
    }),
    Object.freeze({
      agent_id: grandchildAgentId,
      parent_agent_id: childAgentId,
      template_id: "worker",
      name: "孙代理",
      depth: 2,
      state: "idle",
      revision: 1,
    }),
  ]);
}

function readyPair(): Pair {
  const childAgentId = randomUUID();
  const grandchildAgentId = randomUUID();
  const registry = new SupervisorRequestIdRegistry();
  const parent = new SupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: childAgentId,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: registry,
  });
  const child = new SupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: childAgentId,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: registry,
  });
  const hello = child.startHandshake();
  const helloResult = parent.receive(hello);
  assert.equal(helloResult.kind, "accepted");
  const ack = (helloResult as Extract<SupervisorReceiveResult, { kind: "accepted" }>).outbound[0];
  assert.ok(ack);
  assert.equal(child.receive(ack).kind, "accepted");
  const snapshot = child.publishSnapshot(childSnapshotNodes(childAgentId, grandchildAgentId), 1);
  const snapshotResult = parent.receive(snapshot);
  assert.equal(snapshotResult.kind, "accepted");
  assert.equal(parent.getPublicState().state, "ready");
  return { parent, child, childAgentId, grandchildAgentId };
}

function deliver(parent: SupervisorChannel, frame: SupervisorFrame): SupervisorReceiveResult {
  return parent.receive(frame);
}

test("child 发布活动流帧，parent 校验载荷后按到达序分发", () => {
  const { parent, child, childAgentId, grandchildAgentId } = readyPair();
  const delivered: SupervisorActivityDelivery[] = [];

  const first = child.publishActivity({
    event: { type: "message", content: [{ type: "text", text: "回复正文" }] },
  });
  assert.ok(first);
  const firstResult = deliver(parent, first);
  if (firstResult.kind === "accepted" && firstResult.activity !== undefined) {
    delivered.push(firstResult.activity);
  }

  const second = child.publishActivity({
    agent_id: grandchildAgentId,
    event: { type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: "{}" },
  });
  assert.ok(second);
  const secondResult = deliver(parent, second);
  if (secondResult.kind === "accepted" && secondResult.activity !== undefined) {
    delivered.push(secondResult.activity);
  }

  assert.deepEqual(delivered, [
    {
      agent_id: childAgentId,
      event: { type: "message", content: [{ type: "text", text: "回复正文" }] },
    },
    {
      agent_id: grandchildAgentId,
      event: { type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: "{}" },
    },
  ]);
});

test("活动帧载荷违约触发协议故障，与既有帧语义一致", () => {
  const { parent, child, childAgentId } = readyPair();
  const frame = child.publishActivity({
    event: { type: "message", content: [{ type: "text", text: "正文" }] },
  });
  assert.ok(frame);
  const tampered = Object.freeze({
    ...frame,
    payload: Object.freeze({ ...frame.payload, event: { type: "agent_start" } }),
  });
  const result = deliver(parent, tampered);
  assert.equal(result.kind, "protocol_fault");
  assert.equal(parent.getPublicState().state, "faulted");
  void childAgentId;
});

test("child 拒绝越权身份与未知子树代理的活动帧", () => {
  const { child } = readyPair();
  assert.throws(() => child.publishActivity({
    agent_id: randomUUID(),
    event: { type: "message", content: [{ type: "text", text: "越权" }] },
  }), (error: unknown) => error instanceof SupervisorProtocolError);
  assert.throws(() => child.publishActivity({
    agent_id: "not-a-uuid",
    event: { type: "message", content: [{ type: "text", text: "非法" }] },
  }), (error: unknown) => error instanceof SupervisorProtocolError);
});

test("超限活动事件在发布端被拒绝而不建立帧，不中断会话", () => {
  const { parent, child } = readyPair();
  const rejected = child.publishActivity({
    event: {
      type: "message",
      content: [{ type: "text", text: "x".repeat(64 * 1024) }],
    },
  });
  assert.equal(rejected, undefined);
  assert.equal(child.getPublicState().state, "ready");
  assert.equal(parent.getPublicState().state, "ready");
});

test("握手完成前发布活动流被拒绝，终止屏障后活动帧被丢弃", () => {
  const registry = new SupervisorRequestIdRegistry();
  const child = new SupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: randomUUID(),
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: registry,
  });
  assert.throws(() => child.publishActivity({
    event: { type: "message", content: [{ type: "text", text: "过早" }] },
  }), (error: unknown) => error instanceof SupervisorProtocolError);

  const { parent, child: readyChild } = readyPair();
  readyChild.establishTerminationBarrier();
  assert.throws(() => readyChild.publishActivity({
    event: { type: "message", content: [{ type: "text", text: "屏障后" }] },
  }), (error: unknown) => error instanceof SupervisorProtocolError);
  void parent;
});

// --- 传输适配层（StreamSupervisorChannel）---

async function readyStreamPair(): Promise<{
  readonly parent: StreamSupervisorChannel;
  readonly child: StreamSupervisorChannel;
  readonly childAgentId: string;
  readonly grandchildAgentId: string;
  destroy(): void;
}> {
  const childAgentId = randomUUID();
  const grandchildAgentId = randomUUID();
  const parentToChild = new PassThrough();
  const childToParent = new PassThrough();
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parent = new StreamSupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: childAgentId,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: { stdin: parentToChild, stdout: childToParent },
    onReply: () => true,
  });
  const child = new StreamSupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: childAgentId,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: { stdin: childToParent, stdout: parentToChild },
    initialSnapshot: childSnapshotNodes(childAgentId, grandchildAgentId),
    initialSubtreeRevision: 1,
    replyDispatchTimeoutMs: 200,
  });
  const signal = new AbortController().signal;
  await child.bind(signal);
  await Promise.all([
    parent.waitForReady(signal),
    child.waitForReady(signal),
  ]);
  return {
    parent,
    child,
    childAgentId,
    grandchildAgentId,
    destroy: () => {
      parentToChild.destroy();
      childToParent.destroy();
    },
  };
}

test("活动流帧经字节流适配层分发到 parent 观察者，publish 面向调用方返回完成", async () => {
  const channels = await readyStreamPair();
  const delivered: SupervisorActivityDelivery[] = [];
  const unsubscribe = channels.parent.onActivity((activity) => delivered.push(activity));
  try {
    await channels.child.publishActivity({
      event: { type: "message", content: [{ type: "text", text: "流式正文" }] },
    });
    await channels.child.publishActivity({
      agent_id: channels.grandchildAgentId,
      event: { type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: "{}", isError: false },
    });
    // 超限事件被发布端拒绝，不产生帧也不中断通道。
    await channels.child.publishActivity({
      event: { type: "message", content: [{ type: "text", text: "x".repeat(64 * 1024) }] },
    });
    assert.deepEqual(delivered, [
      {
        agent_id: channels.childAgentId,
        event: { type: "message", content: [{ type: "text", text: "流式正文" }] },
      },
      {
        agent_id: channels.grandchildAgentId,
        event: { type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: "{}", isError: false },
      },
    ]);
    assert.equal(channels.parent.getPublicState().state, "ready");
  } finally {
    unsubscribe();
    channels.destroy();
  }
});
