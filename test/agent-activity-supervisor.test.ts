import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";
import { normalizeRpcBridgeEvent } from "../src/rpc-bridge-event.ts";
import {
  FakeRpcClient,
  RpcSupervisor,
  type RpcSupervisorEvent,
} from "../src/rpc-supervisor.ts";
import type {
  ExitObservation,
  ResourceObservation,
} from "../src/process-tree-capability.ts";
import {
  StreamSupervisorChannel,
  type SupervisorByteTransport,
} from "../src/stream-supervisor-channel.ts";
import {
  SupervisorRequestIdRegistry,
  type SupervisorReply,
} from "../src/supervisor-channel.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
} from "../src/tree-controller.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_ID = "root-activity";
const CREDENTIAL = "activity-test-credential";

class TestManagedRpcNode {
  readonly process_binding = "managed" as const;

  readonly rpc: FakeRpcClient;
  private readonly onGracefulClose: ((rpc: FakeRpcClient) => void) | undefined;

  constructor(rpc: FakeRpcClient, onGracefulClose?: (rpc: FakeRpcClient) => void) {
    this.rpc = rpc;
    this.onGracefulClose = onGracefulClose;
  }

  start(): Promise<void> {
    return this.rpc.start();
  }

  prompt(message: string): Promise<void> {
    return this.rpc.prompt(message);
  }

  steer(message: string): Promise<void> {
    return this.rpc.steer(message);
  }

  abort(): Promise<void> {
    return this.rpc.abort();
  }

  getState(): Promise<unknown> {
    return this.rpc.getState();
  }

  onEvent(listener: (event: unknown) => void): () => void {
    return this.rpc.onEvent(listener);
  }

  onTransportFault(
    listener: (fault: "eof" | "protocol_fault" | "process_exit") => void,
  ): () => void {
    return this.rpc.onTransportFault(listener);
  }

  async sendSupervisorFrame(_frame: Uint8Array): Promise<void> {}

  onSupervisorFrame(_listener: (frame: Uint8Array) => void): () => void {
    return () => {};
  }

  async requestGracefulClose(_signal: AbortSignal): Promise<void> {
    this.onGracefulClose?.(this.rpc);
  }

  async forceTerminate(): Promise<void> {}

  async waitForExit(_deadline: number | Date): Promise<ExitObservation> {
    return { state: "exited" };
  }

  async inspect(): Promise<ResourceObservation> {
    return { state: "released" };
  }

  async release(): Promise<void> {}
}

function childSnapshot(): Record<string, unknown> {
  return {
    agent_id: CHILD_ID,
    parent_agent_id: null,
    template_id: "researcher",
    name: "活动子代理",
    depth: 1,
    state: "idle",
    revision: 1,
  };
}

/** 模拟桥接进程行为：Pi 事件先经闭集规范化再进入监督器。 */
function emitBridgeEvent(rpc: FakeRpcClient, rawEvent: unknown): void {
  const normalized = normalizeRpcBridgeEvent(rawEvent);
  if (normalized.kind !== "event") throw new Error(`意外规范化结果: ${normalized.kind}`);
  rpc.emitEvent(normalized.event);
}

function activityEntries(events: readonly RpcSupervisorEvent[]): readonly CanonicalAgentActivityEntry[] {
  return events
    .filter((event): event is Extract<RpcSupervisorEvent, { kind: "activity_stream" }> =>
      event.kind === "activity_stream")
    .map((event) => event.entry);
}

function messageEntry(agentId: string, text: string): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: agentId,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
    }),
  });
}

function setup(onGracefulClose?: (rpc: FakeRpcClient) => void): {
  readonly rpc: FakeRpcClient;
  readonly supervisor: RpcSupervisor;
  readonly channels: {
    readonly parent: StreamSupervisorChannel;
    readonly child: StreamSupervisorChannel;
  };
  cleanup(): Promise<void>;
} {
  const parentToChild = new PassThrough();
  const childToParent = new PassThrough();
  const transportForParent: SupervisorByteTransport = {
    stdin: parentToChild,
    stdout: childToParent,
  };
  const transportForChild: SupervisorByteTransport = {
    stdin: childToParent,
    stdout: parentToChild,
  };
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parent = new StreamSupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: transportForParent,
    onReply: (_reply: SupervisorReply) => true,
  });
  const child = new StreamSupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: CHILD_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: transportForChild,
    initialSnapshot: [childSnapshot()],
    initialSubtreeRevision: 1,
    replyDispatchTimeoutMs: 200,
  });
  const rpc = new FakeRpcClient();
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "活动子代理" },
    managedNode: new TestManagedRpcNode(rpc, onGracefulClose),
    channel: parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const cleanup = async (): Promise<void> => {
    parentToChild.destroy();
    childToParent.destroy();
    await supervisor.terminate().catch(() => {});
  };
  return { rpc, supervisor, channels: { parent, child }, cleanup };
}

test("RPC 桥完整活动副本不再重复分发，权威活动由子扩展监督通道上行", async () => {
  const { rpc, supervisor, channels, cleanup } = setup();
  const events: RpcSupervisorEvent[] = [];
  const unsubscribe = supervisor.onEvent((event) => events.push(event));
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);

    emitBridgeEvent(rpc, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "内部推理" },
          { type: "text", text: "回复正文" },
        ],
      },
    });
    emitBridgeEvent(rpc, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "src/a.ts" },
    });
    emitBridgeEvent(rpc, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { lines: ["const a = 1;"] },
      isError: false,
    });

    assert.deepEqual(activityEntries(events), []);
  } finally {
    unsubscribe();
    await cleanup();
  }
});

test("监督通道 display 帧只作为携带代理身份的 activity_display 分发", async () => {
  const { supervisor, channels, cleanup } = setup();
  const events: RpcSupervisorEvent[] = [];
  const unsubscribe = supervisor.onEvent((event) => events.push(event));
  try {
    const startup = supervisor.start();
    await channels.child.bind(new AbortController().signal);
    assert.equal((await startup).ok, true);

    const event = {
      type: "message_delta" as const,
      streamId: "message-1",
      sequence: 1,
      contentIndex: 0,
      contentType: "text" as const,
      delta: "partial",
      displayEpoch: randomUUID(),
      displaySourceGeneration: 1,
      streamOrdinal: 1,
      agentId: CHILD_ID,
      incarnationId: randomUUID(),
    };
    await channels.child.publishDisplayActivity({ agent_id: CHILD_ID, event });

    assert.deepEqual(events.filter((event) => event.kind === "activity_display"), [{
      kind: "activity_display",
      agent_id: CHILD_ID,
      event,
    }]);
    assert.deepEqual(activityEntries(events), []);
  } finally {
    unsubscribe();
    await cleanup();
  }
});

test("活动流上行不影响既有活动阶段与工具配对跟踪", async () => {
  const { rpc, supervisor, channels, cleanup } = setup();
  const events: RpcSupervisorEvent[] = [];
  const unsubscribe = supervisor.onEvent((event) => events.push(event));
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);

    emitBridgeEvent(rpc, { type: "agent_start" });
    emitBridgeEvent(rpc, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "a.ts" },
    });
    emitBridgeEvent(rpc, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: "ok",
      isError: false,
    });
    emitBridgeEvent(rpc, { type: "agent_settled" });

    const phases = events
      .filter((event): event is Extract<RpcSupervisorEvent, { kind: "activity" }> =>
        event.kind === "activity")
      .map((event) => event.activity.phase);
    assert.ok(phases.includes("tool_calls"));
    assert.ok(phases.includes("processing"));
  } finally {
    unsubscribe();
    await cleanup();
  }
});

test("版本一致时监督通道在发布侧与接收侧都接受模型调用失败条目", async () => {
  const { supervisor, channels, cleanup } = setup();
  const events: RpcSupervisorEvent[] = [];
  const faults: unknown[] = [];
  const unsubscribe = supervisor.onEvent((event) => events.push(event));
  const unsubscribeChildFault = channels.child.onFault((fault) => faults.push(fault));
  const unsubscribeParentFault = channels.parent.onFault((fault) => faults.push(fault));
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);

    const entry: CanonicalAgentActivityEntry = Object.freeze({
      contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
      agent_id: CHILD_ID,
      incarnation_id: randomUUID(),
      entry_id: randomUUID(),
      body: Object.freeze({
        type: "model_call_failure" as const,
        failure: "error" as const,
        message: "provider payload\n".repeat(4_000),
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      }),
    });
    await channels.child.publishActivity({ entry });

    // 大错误正文按身份分块上行；接收侧重组出的条目与发布侧逐字一致。
    const deliveries = events.filter((event): event is Extract<RpcSupervisorEvent, { kind: "activity_stream" }> =>
      event.kind === "activity_stream");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.agent_id, CHILD_ID);
    assert.deepEqual(deliveries[0]?.entry, entry);
    assert.deepEqual(faults, []);
    // 收发两侧都不因合法失败条目进入通道故障。
    assert.equal(channels.parent.getPublicState().state, "ready");
    assert.equal(channels.child.getPublicState().state, "ready");
  } finally {
    unsubscribe();
    unsubscribeChildFault();
    unsubscribeParentFault();
    await cleanup();
  }
});

test("监督通道活动帧经 RpcSupervisor 分发为带 agent_id 的规范条目", async () => {
  const { supervisor, channels, cleanup } = setup();
  const events: RpcSupervisorEvent[] = [];
  const unsubscribe = supervisor.onEvent((event) => events.push(event));
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);

    const entry = messageEntry(CHILD_ID, "来自子代理");
    await channels.child.publishActivity({ entry });

    const deliveries = events
      .filter((event): event is Extract<RpcSupervisorEvent, { kind: "activity_stream" }> =>
        event.kind === "activity_stream" && event.agent_id !== undefined);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.agent_id, CHILD_ID);
    assert.deepEqual(deliveries[0]?.entry, entry);
  } finally {
    unsubscribe();
    await cleanup();
  }
});
