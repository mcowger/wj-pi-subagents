import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AgentController,
  type AgentSupervisor,
} from "../src/agent-controller.ts";
import type {
  SupervisorActivityDelivery,
  SupervisorDisplayDelivery,
} from "../src/supervisor-channel.ts";
import type {
  RpcSupervisorCommandResult,
  RpcSupervisorEvent,
  RpcSupervisorInterruptResult,
  RpcSupervisorStartupResult,
  RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";
import type {
  SafeAgentActivityDisplayEvent,
  SafeAgentActivityEvent,
} from "../src/rpc-bridge-event.ts";
import {
  TreeController,
  ROOT_TREE_ACTOR,
  type ReserveStartingChildInput,
  type TreeActor,
} from "../src/tree-controller.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GRANDCHILD_ID = "660e8400-e29b-41d4-a716-446655440001";
const GREAT_GRANDCHILD_ID = "770e8400-e29b-41d4-a716-446655440002";
const INCARNATION_ID = "7f9c24e8-5b3d-4f6a-8c1e-9d2b7a4f6e81";

function displayDelta(
  streamId: string,
  sequence: number,
  contentIndex: number,
  contentType: "text" | "thinking",
  delta: string,
  agentId: string = AGENT_ID,
  incarnationId: string = INCARNATION_ID,
): SafeAgentActivityDisplayEvent {
  return Object.freeze({
    type: "message_delta",
    streamId,
    sequence,
    contentIndex,
    contentType,
    delta,
    agentId,
    incarnationId,
  });
}

class FakeSupervisor implements AgentSupervisor {
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  readonly agentId: string;
  tree: TreeController | undefined;
  actor: TreeActor = ROOT_TREE_ACTOR;
  reservation: ReserveStartingChildInput | undefined;

  constructor(agentId = AGENT_ID) {
    this.agentId = agentId;
  }

  start(): Promise<RpcSupervisorStartupResult> {
    if (this.tree !== undefined && this.reservation !== undefined) {
      const reserved = this.tree.reserveStartingChild(this.actor, this.reservation);
      assert.equal(reserved.ok, true);
      this.tree.applyLifecycleEvent(this.agentId, {
        type: "startup_ready",
        expected_generation: 0,
      });
    }
    return Promise.resolve({ ok: true, agent_id: this.agentId, state: "idle" });
  }

  sendMessage(_message: string): Promise<RpcSupervisorCommandResult> {
    return Promise.resolve({ ok: true, accepted: true });
  }

  interrupt(): Promise<RpcSupervisorInterruptResult> {
    return Promise.resolve({ ok: true, accepted: true, changed: true });
  }

  terminate(): Promise<RpcSupervisorTerminationResult> {
    return Promise.resolve({
      ok: true,
      agent_id: this.agentId,
      state: "terminated",
      cleanup: "confirmed",
    });
  }

  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wasForcedTerminationUsed(): boolean {
    return false;
  }

  emitActivityDelivery(delivery: SupervisorActivityDelivery): void {
    for (const listener of this.listeners) {
      listener(Object.freeze({
        kind: "activity_stream",
        agent_id: delivery.agent_id,
        entry: delivery.entry,
      }));
    }
  }

  emitActivityDisplay(delivery: SupervisorDisplayDelivery): void {
    for (const listener of this.listeners) {
      listener(Object.freeze({
        kind: "activity_display",
        agent_id: delivery.agent_id,
        event: delivery.event,
      }));
    }
  }

  emitLifecycle(
    agentId: string,
    event: Extract<RpcSupervisorEvent, { kind: "lifecycle" }>["event"],
  ): void {
    for (const listener of this.listeners) {
      listener(Object.freeze({ kind: "lifecycle", agent_id: agentId, event }));
    }
  }

  emitRaw(event: RpcSupervisorEvent): void {
    for (const listener of this.listeners) listener(event);
  }
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

/** 权威条目携带与实时流精确关联的身份：运行实例身份 + streamId。 */
function messageEntryWithStream(
  agentId: string,
  text: string,
  streamId: string,
  incarnationId: string,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: agentId,
    incarnation_id: incarnationId,
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
      streamId,
    }),
  });
}

function makeChildModeController(options: {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly depth: number;
  readonly directChildId: string;
  readonly directChildSupervisor: FakeSupervisor;
  readonly publishUpstreamActivity: (delivery: SupervisorActivityDelivery) => void;
  readonly publishUpstreamDisplayActivity?: (delivery: SupervisorDisplayDelivery) => void;
}): AgentController {
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => options.directChildId,
    initialActor: {
      agentId: options.agentId,
      parentAgentId: options.parentAgentId,
      depth: options.depth,
      templateId: "demo",
      name: `第 ${options.depth} 层代理`,
      managementEnabled: true,
    },
  });
  options.directChildSupervisor.tree = tree;
  return new AgentController({
    tree,
    actor: { kind: "agent", agent_id: options.agentId },
    allowUnvalidatedTemplates: true,
    createSupervisor: (input) => {
      options.directChildSupervisor.actor = input.actor;
      options.directChildSupervisor.reservation = input.reservation;
      return options.directChildSupervisor;
    },
    replyNotificationsHandledByInbox: false,
    publishUpstreamActivity: options.publishUpstreamActivity,
    ...(options.publishUpstreamDisplayActivity === undefined
      ? {}
      : { publishUpstreamDisplayActivity: options.publishUpstreamDisplayActivity }),
  });
}

function makeController(fake: FakeSupervisor): {
  readonly controller: AgentController;
  readonly tree: TreeController;
  readonly upstream: SupervisorActivityDelivery[];
} {
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  fake.tree = tree;
  const upstream: SupervisorActivityDelivery[] = [];
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: (input) => {
      fake.actor = input.actor;
      fake.reservation = input.reservation;
      return fake;
    },
    replyNotificationsHandledByInbox: false,
    publishUpstreamActivity: (delivery) => upstream.push(delivery),
  });
  return { controller, tree, upstream };
}

test("顶层控制器把活动条目写入缓存，按到达序可回放且修订号递增", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  const notified: string[] = [];
  const unsubscribe = controller.onActivityChange((agentId) => notified.push(agentId));

  const first = messageEntry(AGENT_ID, "第一条");
  const second = messageEntry(AGENT_ID, "第二条");
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: first });
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: second });

  assert.deepEqual(controller.getActivityReplay(AGENT_ID), [first, second]);
  assert.equal(controller.getActivityRevision(AGENT_ID), 2);
  assert.deepEqual(notified, [AGENT_ID, AGENT_ID]);
  unsubscribe();
});

test("顶层把实时显示事实组装为按代理隔离的草稿，不写入缓存或上行活动流", async () => {
  const fake = new FakeSupervisor();
  const { controller, upstream } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  const notified: string[] = [];
  const unsubscribe = controller.onActivityDisplayChange((agentId: string) => notified.push(agentId));
  fake.emitActivityDisplay({
    agent_id: AGENT_ID,
    event: displayDelta("message-1", 1, 0, "text", "partial"),
  });

  assert.deepEqual(notified, [AGENT_ID]);
  const drafts = controller.getDisplayDrafts(AGENT_ID);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0]?.blocks.map((block) => block.value), ["partial"]);
  assert.deepEqual(controller.getDisplayDrafts(GRANDCHILD_ID), []);
  assert.deepEqual(controller.getActivityReplay(AGENT_ID), []);
  assert.equal(controller.getActivityRevision(AGENT_ID), 0);
  assert.deepEqual(upstream, []);
  unsubscribe();
});

test("任意深度的实时显示事实逐层转发到顶层并保持代理隔离", async () => {
  const rootSupervisor = new FakeSupervisor(AGENT_ID);
  const { controller: root } = makeController(rootSupervisor);
  const rootSpawned = await root.spawnAgent({ template_id: "demo", name: "直接子代理" });
  assert.equal(rootSpawned.ok, true, JSON.stringify(rootSpawned));

  const childToRoot: SupervisorDisplayDelivery[] = [];
  const grandchildSupervisor = new FakeSupervisor(GRANDCHILD_ID);
  const child = makeChildModeController({
    agentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    directChildId: GRANDCHILD_ID,
    directChildSupervisor: grandchildSupervisor,
    publishUpstreamActivity: (delivery) => rootSupervisor.emitActivityDelivery(delivery),
    publishUpstreamDisplayActivity: (delivery) => {
      childToRoot.push(delivery);
      rootSupervisor.emitActivityDisplay(delivery);
    },
  });
  const childSpawned = await child.spawnAgent({ template_id: "demo", name: "孙代理" });
  assert.equal(childSpawned.ok, true, JSON.stringify(childSpawned));

  // 孙代理的显示事实经中间层转发；中间层自身不缓存草稿。
  const grandchildDelta = displayDelta("message-7", 1, 0, "text", "孙代理实时", GRANDCHILD_ID);
  grandchildSupervisor.emitActivityDisplay({ agent_id: GRANDCHILD_ID, event: grandchildDelta });
  assert.deepEqual(child.getDisplayDrafts(GRANDCHILD_ID), []);
  assert.deepEqual(childToRoot.map((delivery) => delivery.agent_id), [GRANDCHILD_ID]);

  const rootDrafts = root.getDisplayDrafts(GRANDCHILD_ID);
  assert.equal(rootDrafts.length, 1);
  assert.deepEqual(rootDrafts[0]?.blocks.map((block) => block.value), ["孙代理实时"]);
  // 直接子与孙代理草稿按代理隔离，不串流。
  assert.deepEqual(root.getDisplayDrafts(AGENT_ID), []);
});

test("子模式 recordOwnDisplayEvent 登记完整流身份并沿上游转发", async () => {
  const rootSupervisor = new FakeSupervisor(AGENT_ID);
  const { controller: root } = makeController(rootSupervisor);
  await root.spawnAgent({ template_id: "demo", name: "直接子代理" });

  const upstream: SupervisorDisplayDelivery[] = [];
  const child = makeChildModeController({
    agentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    directChildId: GRANDCHILD_ID,
    directChildSupervisor: new FakeSupervisor(GRANDCHILD_ID),
    publishUpstreamActivity: (delivery) => rootSupervisor.emitActivityDelivery(delivery),
    publishUpstreamDisplayActivity: (delivery) => {
      upstream.push(delivery);
      rootSupervisor.emitActivityDisplay(delivery);
    },
  });

  assert.equal(child.recordOwnDisplayEvent(displayDelta("message-1", 1, 0, "text", "自身")), true);
  assert.equal(upstream.length, 1);
  const delivered = upstream[0]!;
  assert.equal(delivered.agent_id, AGENT_ID);
  assert.equal(delivered.event.agentId, AGENT_ID);
  assert.match(delivered.event.incarnationId, /^[0-9a-f-]{36}$/u);
  // 顶层收到同身份草稿；与 recordOwnActivity 的权威条目身份一致。
  const rootDrafts = root.getDisplayDrafts(AGENT_ID);
  assert.deepEqual(rootDrafts[0]?.blocks.map((block) => block.value), ["自身"]);
  // 根没有可上行的自身代理身份。
  assert.equal(root.recordOwnDisplayEvent(displayDelta("message-1", 1, 0, "text", "根")), false);
});

test("权威完整消息携带 streamId 到达后原地替换对应草稿", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });

  fake.emitActivityDisplay({ agent_id: AGENT_ID, event: displayDelta("message-1", 1, 0, "text", "实时前缀") });
  assert.equal(controller.getDisplayDrafts(AGENT_ID).length, 1);

  // 权威条目经活动流落账：身份精确关联 → 草稿被清除，历史只保留完整正文。
  const entry = messageEntryWithStream(AGENT_ID, "完整正文", "message-1", INCARNATION_ID);
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry });
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);
  assert.match(controller.getActivityReplay(AGENT_ID)[0]?.body.type ?? "", /message/u);
});

test("生命周期收束清除草稿；随后迟到的权威消息仍可写入历史", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });

  fake.emitActivityDisplay({ agent_id: AGENT_ID, event: displayDelta("message-1", 1, 0, "text", "未收束") });
  assert.equal(controller.getDisplayDrafts(AGENT_ID).length, 1);

  fake.emitLifecycle(AGENT_ID, { type: "agent_settled", expected_generation: 0 });
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);

  // 同一运行实例迟到的合法权威消息仍可写入历史。
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: messageEntry(AGENT_ID, "迟到的完整正文") });
  assert.equal(controller.getActivityReplay(AGENT_ID).length, 1);
  // 收束后迟到的同流 delta 不复活旧草稿。
  fake.emitActivityDisplay({ agent_id: AGENT_ID, event: displayDelta("message-1", 2, 0, "text", "迟到") });
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);
});

test("后代活动条目按其真实身份分组写入顶层缓存", async () => {
  const fake = new FakeSupervisor();
  const { controller, upstream } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  const direct = messageEntry(AGENT_ID, "直接子正文");
  const grandchild = messageEntry(GRANDCHILD_ID, "孙代理正文");
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: direct });
  fake.emitActivityDelivery({ agent_id: GRANDCHILD_ID, entry: grandchild });

  assert.deepEqual(controller.getActivityReplay(AGENT_ID), [direct]);
  assert.deepEqual(controller.getActivityReplay(GRANDCHILD_ID), [grandchild]);
  // 顶层运行时没有上游：缓存终止于此，不再转发。
  assert.deepEqual(upstream, []);
});

test("中间运行时只转发不缓存：四层树中仅根保存历史且不重复", async () => {
  const rootSupervisor = new FakeSupervisor(AGENT_ID);
  const { controller: root } = makeController(rootSupervisor);
  const rootSpawned = await root.spawnAgent({ template_id: "demo", name: "直接子代理" });
  assert.equal(rootSpawned.ok, true, JSON.stringify(rootSpawned));

  const grandchildSupervisor = new FakeSupervisor(GRANDCHILD_ID);
  const childToRoot: SupervisorActivityDelivery[] = [];
  const child = makeChildModeController({
    agentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    directChildId: GRANDCHILD_ID,
    directChildSupervisor: grandchildSupervisor,
    publishUpstreamActivity: (delivery) => {
      childToRoot.push(delivery);
      rootSupervisor.emitActivityDelivery(delivery);
    },
  });
  const childSpawned = await child.spawnAgent({ template_id: "demo", name: "孙代理" });
  assert.equal(childSpawned.ok, true, JSON.stringify(childSpawned));

  const greatGrandchildSupervisor = new FakeSupervisor(GREAT_GRANDCHILD_ID);
  const grandchildToChild: SupervisorActivityDelivery[] = [];
  const grandchild = makeChildModeController({
    agentId: GRANDCHILD_ID,
    parentAgentId: AGENT_ID,
    depth: 2,
    directChildId: GREAT_GRANDCHILD_ID,
    directChildSupervisor: greatGrandchildSupervisor,
    publishUpstreamActivity: (delivery) => {
      grandchildToChild.push(delivery);
      grandchildSupervisor.emitActivityDelivery(delivery);
    },
  });
  const grandchildSpawned = await grandchild.spawnAgent({ template_id: "demo", name: "曾孙代理" });
  assert.equal(grandchildSpawned.ok, true, JSON.stringify(grandchildSpawned));

  // 中间层记录自身活动：只转发，不在本层缓存。
  const childOwn = messageEntry(AGENT_ID, "直接子自身事件");
  const grandchildOwn = messageEntry(GRANDCHILD_ID, "孙代理自身事件");
  assert.equal(child.recordOwnActivity(childOwn.body), true);
  assert.equal(grandchild.recordOwnActivity(grandchildOwn.body), true);
  const greatGrandchildOwn = messageEntry(GREAT_GRANDCHILD_ID, "曾孙代理自身事件");
  greatGrandchildSupervisor.emitActivityDelivery({ agent_id: GREAT_GRANDCHILD_ID, entry: greatGrandchildOwn });

  // 中间层不保存历史。
  assert.deepEqual(child.getActivityReplay(AGENT_ID), []);
  assert.deepEqual(child.getActivityReplay(GRANDCHILD_ID), []);
  assert.deepEqual(child.getActivityReplay(GREAT_GRANDCHILD_ID), []);
  assert.deepEqual(grandchild.getActivityReplay(GRANDCHILD_ID), []);
  assert.deepEqual(grandchild.getActivityReplay(GREAT_GRANDCHILD_ID), []);

  // 只有根保存全树历史；recordOwnActivity 为自身正文生成新规范身份。
  const rootReplay = root.getActivityReplay(AGENT_ID);
  assert.equal(rootReplay.length, 1);
  assert.deepEqual(rootReplay[0]?.body, childOwn.body);
  assert.equal(rootReplay[0]?.agent_id, AGENT_ID);
  assert.deepEqual(root.getActivityReplay(GRANDCHILD_ID).map((entry) => entry.body), [grandchildOwn.body]);
  assert.deepEqual(root.getActivityReplay(GREAT_GRANDCHILD_ID), [greatGrandchildOwn]);
  assert.deepEqual(grandchildToChild.map((delivery) => delivery.entry.body), [grandchildOwn.body, greatGrandchildOwn.body]);
  assert.deepEqual(childToRoot.map((delivery) => delivery.entry.body), [childOwn.body, grandchildOwn.body, greatGrandchildOwn.body]);
  assert.equal(root.getActivityRevision(AGENT_ID), 1);
  assert.equal(root.getActivityRevision(GRANDCHILD_ID), 1);
  assert.equal(root.getActivityRevision(GREAT_GRANDCHILD_ID), 1);
});

test("根控制器没有可上行的自身代理身份", () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);

  assert.equal(controller.recordOwnActivity(messageEntry(AGENT_ID, "根事件").body), false);
  assert.deepEqual(controller.getActivityReplay(AGENT_ID), []);
});

test("子代理终止后顶层活动缓存仍可回放", async () => {
  const fake = new FakeSupervisor();
  const { controller, tree } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const beforeTermination = messageEntry(AGENT_ID, "终止前的正文");
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: beforeTermination });

  const terminated = await controller.terminateAgent(AGENT_ID);
  assert.equal(terminated.ok, true, JSON.stringify(terminated));
  void tree;

  assert.deepEqual(controller.getActivityReplay(AGENT_ID), [beforeTermination]);
  assert.equal(controller.getActivityRevision(AGENT_ID), 1);
});

test("中间层 recordOwnActivity 生成规范身份并保持正文不变", async () => {
  const rootSupervisor = new FakeSupervisor(AGENT_ID);
  const { controller: root } = makeController(rootSupervisor);
  await root.spawnAgent({ template_id: "demo", name: "直接子代理" });

  const body: SafeAgentActivityEvent = Object.freeze({
    type: "message",
    content: Object.freeze([Object.freeze({ type: "text", text: "自身正文" })]),
  });
  const child = makeChildModeController({
    agentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    directChildId: GRANDCHILD_ID,
    directChildSupervisor: new FakeSupervisor(GRANDCHILD_ID),
    publishUpstreamActivity: (delivery) => rootSupervisor.emitActivityDelivery(delivery),
  });
  assert.equal(child.recordOwnActivity(body), true);

  const replay = root.getActivityReplay(AGENT_ID);
  assert.equal(replay.length, 1);
  assert.equal(replay[0]?.agent_id, AGENT_ID);
  assert.deepEqual(replay[0]?.body, body);
  assert.match(replay[0]?.incarnation_id ?? "", /^[0-9a-f-]{36}$/u);
  assert.match(replay[0]?.entry_id ?? "", /^[0-9a-f-]{36}$/u);
});

test("工具开始与结束事实确定性共享同一条目身份", async () => {
  const rootSupervisor = new FakeSupervisor(AGENT_ID);
  const { controller: root } = makeController(rootSupervisor);
  await root.spawnAgent({ template_id: "demo", name: "直接子代理" });

  const child = makeChildModeController({
    agentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    directChildId: GRANDCHILD_ID,
    directChildSupervisor: new FakeSupervisor(GRANDCHILD_ID),
    publishUpstreamActivity: (delivery) => rootSupervisor.emitActivityDelivery(delivery),
  });
  const startBody: SafeAgentActivityEvent = Object.freeze({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
  });
  const endBody: SafeAgentActivityEvent = Object.freeze({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    isError: false,
  });
  assert.equal(child.recordOwnActivity(startBody), true);
  assert.equal(child.recordOwnActivity(endBody), true);

  const replay = root.getActivityReplay(AGENT_ID);
  assert.equal(replay.length, 2);
  // 同一条目的状态事实：条目身份与运行实例身份在开始与结束间保持一致。
  assert.equal(replay[0]?.entry_id, replay[1]?.entry_id);
  assert.equal(replay[0]?.incarnation_id, replay[1]?.incarnation_id);

  // 重复提交同一事实仍派生同一条目身份，下游可按条目身份幂等聚合。
  assert.equal(child.recordOwnActivity(endBody), true);
  const replayAfterRepeat = root.getActivityReplay(AGENT_ID);
  assert.equal(replayAfterRepeat[2]?.entry_id, replay[0]?.entry_id);
});

test("活动流转发异常被屏障吞掉：不沿 onEvent 传播，后续事件正常处理", async () => {
  const fake = new FakeSupervisor();
  const { controller, upstream } = makeController(fake);
  await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });

  // 注入转发故障：三个活动分支的目标内部调用全部抛错。
  const internal = controller as unknown as {
    tree: { updateActivity: () => void };
    recordActivity: () => void;
    handleDisplayEvent: () => void;
  };
  internal.tree.updateActivity = () => {
    throw new Error("注入缓存故障");
  };
  internal.recordActivity = () => {
    throw new Error("注入转发故障");
  };
  internal.handleDisplayEvent = () => {
    throw new Error("注入草稿故障");
  };

  // 三个活动分支的转发失败都被屏障吞掉：面板数据静默缺失，不炸事件回调。
  assert.doesNotThrow(() => {
    fake.emitRaw({
      kind: "activity",
      activity: { phase: "processing" },
    });
    fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: messageEntry(AGENT_ID, "转发分支条目") });
    fake.emitActivityDisplay({
      agent_id: AGENT_ID,
      event: displayDelta("message-9", 1, 0, "text", "草稿分支"),
    });
  });
  assert.deepEqual(controller.getActivityReplay(AGENT_ID), []);
  assert.deepEqual(upstream, []);

  // 屏障之后的生命周期事件仍正常处理：收束路径可正常到达。
  assert.doesNotThrow(() => {
    fake.emitLifecycle(AGENT_ID, { type: "agent_settled", expected_generation: 0 });
  });
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);
});
