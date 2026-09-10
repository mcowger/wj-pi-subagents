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
  CanonicalAgentActivityDisplayEvent,
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
const DISPLAY_EPOCH = "128c3f70-2d40-4e21-a8b4-1c9d8e7f6a50";
const RELOAD_DISPLAY_EPOCH = "2d9e4f61-7c30-4a8b-b5d1-8e6f2c9a4b70";

function streamOrdinal(streamId: string): number {
  const match = /-(\d+)$/u.exec(streamId);
  const value = match === null ? 1 : Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function displayStream(
  streamId: string,
  displaySourceGeneration = 1,
  ordinal = streamOrdinal(streamId),
) {
  return Object.freeze({
    streamId,
    displayEpoch: displaySourceGeneration === 1 ? DISPLAY_EPOCH : RELOAD_DISPLAY_EPOCH,
    displaySourceGeneration,
    streamOrdinal: ordinal,
  });
}

function displayDelta(
  streamId: string,
  sequence: number,
  contentIndex: number,
  contentType: "text" | "thinking",
  delta: string,
  agentId: string = AGENT_ID,
  incarnationId: string = INCARNATION_ID,
  displaySourceGeneration = 1,
  ordinal = streamOrdinal(streamId),
): CanonicalAgentActivityDisplayEvent {
  return Object.freeze({
    type: "message_delta",
    sequence,
    contentIndex,
    contentType,
    delta,
    ...displayStream(streamId, displaySourceGeneration, ordinal),
    agentId,
    incarnationId,
  });
}

class FakeSupervisor implements AgentSupervisor {
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  readonly agentId: string;
  activityDeliveryResetCount = 0;
  synchronousActivityDeliveryOnReset: SupervisorActivityDelivery | undefined;
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

  resetActivityDelivery(): void {
    this.activityDeliveryResetCount += 1;
    const delivery = this.synchronousActivityDeliveryOnReset;
    if (delivery !== undefined) this.emitActivityDelivery(delivery);
  }

  /** 模拟异步源已经捕获旧订阅、却在 reset 后才投递的回调。 */
  captureRaw(event: RpcSupervisorEvent): () => void {
    const captured = [...this.listeners];
    return () => {
      for (const listener of captured) listener(event);
    };
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

/** 权威条目携带完整有序 display stream identity。 */
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
      displayStream: displayStream(streamId),
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

test("reload 清空活动状态并拒绝已捕获的旧 activity/display 回调", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  // 先形成已淘汰窗口与可见草稿，证明 reset 不只是清除最后一条。
  for (let index = 0; index <= 100; index += 1) {
    fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: messageEntry(AGENT_ID, `旧历史 ${index}`) });
  }
  fake.emitActivityDisplay({
    agent_id: AGENT_ID,
    event: displayDelta("old-stream", 1, 0, "text", "旧草稿"),
  });
  assert.equal(controller.getActivitySnapshot(AGENT_ID).olderActivityOmitted, true);
  assert.equal(controller.getDisplayDrafts(AGENT_ID).length, 1);

  const lateActivity = fake.captureRaw(Object.freeze({
    kind: "activity_stream" as const,
    agent_id: AGENT_ID,
    entry: messageEntry(AGENT_ID, "迟到旧历史"),
  }));
  const lateDisplay = fake.captureRaw(Object.freeze({
    kind: "activity_display" as const,
    agent_id: AGENT_ID,
    event: displayDelta("late-old-stream", 1, 0, "text", "迟到旧草稿"),
  }));

  assert.equal(controller.resetActivityForReload(), true);
  assert.equal(fake.activityDeliveryResetCount, 1);
  assert.deepEqual(controller.getActivitySnapshot(AGENT_ID), {
    snapshotEpoch: 1,
    entries: [],
    revision: 0,
    olderActivityOmitted: false,
  });
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);

  // 这两个闭包持有 reset 前的 onEvent listener，不得把旧内容重新写入。
  lateActivity();
  lateDisplay();
  assert.deepEqual(controller.getActivityReplay(AGENT_ID), []);
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);

  // 新订阅仍接收新观察代际；display reset 建立新 epoch 后才接受新草稿。
  const nextEpoch = randomUUID();
  const nextIncarnation = randomUUID();
  fake.emitActivityDisplay({
    agent_id: AGENT_ID,
    event: Object.freeze({
      type: "display_reset" as const,
      agentId: AGENT_ID,
      incarnationId: nextIncarnation,
      displayEpoch: nextEpoch,
      displaySourceGeneration: 2,
    }),
  });
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: messageEntry(AGENT_ID, "新历史") });
  fake.emitActivityDisplay({
    agent_id: AGENT_ID,
    event: Object.freeze({
      type: "message_delta" as const,
      streamId: "new-stream",
      sequence: 1,
      contentIndex: 0,
      contentType: "text" as const,
      delta: "新草稿",
      displayEpoch: nextEpoch,
      displaySourceGeneration: 2,
      streamOrdinal: 1,
      agentId: AGENT_ID,
      incarnationId: nextIncarnation,
    }),
  });
  assert.deepEqual(controller.getActivityReplay(AGENT_ID).map((entry) => entry.body), [{
    type: "message",
    content: [{ type: "text", text: "新历史" }],
  }]);
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID)[0]?.blocks.map((block) => block.value), ["新草稿"]);
});

test("reload 重订阅后保留同步 reset snapshot 的新活动", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: messageEntry(AGENT_ID, "reload 前历史") });
  const afterReset = messageEntry(AGENT_ID, "同步 reset snapshot 后活动");
  fake.synchronousActivityDeliveryOnReset = Object.freeze({ agent_id: AGENT_ID, entry: afterReset });

  assert.equal(controller.resetActivityForReload(), true);
  assert.deepEqual(controller.getActivityReplay(AGENT_ID), [afterReset]);
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

  assert.equal(child.resetDisplayDrafts(RELOAD_DISPLAY_EPOCH, 2), true);
  const reset = upstream[1];
  assert.equal(reset?.event.type, "display_reset");
  assert.equal(reset?.event.type === "display_reset"
    ? reset.event.displaySourceGeneration
    : undefined, 2);
  assert.match(reset?.event.type === "display_reset" ? reset.event.incarnationId : "", /^[0-9a-f-]{36}$/u);
  assert.deepEqual(root.getDisplayDrafts(AGENT_ID), []);
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

test("direct termination 无 lifecycle 事件时也收束活动工具与实时草稿", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  const incarnationId = "12121212-1212-4121-8121-121212121212";
  const running = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: incarnationId,
    entry_id: "34343434-3434-4343-8343-343434343434",
    body: Object.freeze({
      type: "tool_execution_start" as const,
      toolCallId: "termination-running",
      toolName: "read",
      origin: "pi_native" as const,
      executionGeneration: 1,
    }),
  });
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: running });
  fake.emitActivityDisplay({
    agent_id: AGENT_ID,
    event: displayDelta("termination-stream", 1, 0, "text", "未完成草稿"),
  });
  for (let index = 0; index < 100; index += 1) {
    fake.emitActivityDelivery({
      agent_id: AGENT_ID,
      entry: Object.freeze({
        contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
        agent_id: AGENT_ID,
        incarnation_id: incarnationId,
        entry_id: randomUUID(),
        body: Object.freeze({
          type: "tool_execution_start" as const,
          toolCallId: `termination-fill-${index}`,
          toolName: "read",
          origin: "pi_native" as const,
          executionGeneration: 1,
        }),
      }),
    });
  }
  assert.equal(controller.getActivitySnapshot(AGENT_ID).entries.length, 101);
  assert.equal(controller.getDisplayDrafts(AGENT_ID).length, 1);

  // FakeSupervisor 不发 resources_confirmed；terminateAgent 自身必须完成同一
  // 活动收束，否则 running 工具会永久 pin 在窗口外。
  const terminated = await controller.terminateAgent(AGENT_ID);
  assert.equal(terminated.ok, true, JSON.stringify(terminated));
  const snapshot = controller.getActivitySnapshot(AGENT_ID);
  assert.equal(snapshot.entries.length, 100);
  assert.equal(snapshot.entries.some((entry) => entry.entry_id === running.entry_id), false);
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);
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
  assert.equal(replay.length, 1);
  // start/end 在顶层缓存中是一个原子；end 原地替换 running 事实。
  assert.equal(replay[0]?.body.type, "tool_execution_end");
  assert.match(replay[0]?.entry_id ?? "", /^[0-9a-f-]{36}$/u);
  assert.match(replay[0]?.incarnation_id ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(root.getActivityRevision(AGENT_ID), 2);

  // 重复提交同一 end 保持幂等：不新增 atom、不递增 revision、不通知。
  const notified: string[] = [];
  const unsubscribe = root.onActivityChange((agentId) => notified.push(agentId));
  assert.equal(child.recordOwnActivity(endBody), true);
  const replayAfterRepeat = root.getActivityReplay(AGENT_ID);
  assert.deepEqual(replayAfterRepeat, replay);
  assert.equal(root.getActivityRevision(AGENT_ID), 2);
  assert.deepEqual(notified, []);
  unsubscribe();
});

test("controller 为复用 toolCallId 的不同执行代次派生不同条目身份", async () => {
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
  const makeTool = (
    type: "tool_execution_start" | "tool_execution_end",
    generation: number,
  ): SafeAgentActivityEvent => type === "tool_execution_start"
    ? Object.freeze({
      type,
      toolCallId: "controller-reused-call",
      toolName: "read",
      origin: "pi_native",
      executionGeneration: generation,
    })
    : Object.freeze({
      type,
      toolCallId: "controller-reused-call",
      toolName: "read",
      origin: "pi_native",
      executionGeneration: generation,
      isError: false,
    });
  child.recordOwnActivity(makeTool("tool_execution_start", 1));
  child.recordOwnActivity(makeTool("tool_execution_end", 1));
  child.recordOwnActivity(makeTool("tool_execution_start", 2));
  child.recordOwnActivity(makeTool("tool_execution_end", 2));

  const replay = root.getActivityReplay(AGENT_ID);
  assert.equal(replay.length, 2);
  assert.deepEqual(replay.map((entry) => entry.body.type === "tool_execution_end"
    ? entry.body.executionGeneration
    : undefined), [1, 2]);
  assert.notEqual(replay[0]?.entry_id, replay[1]?.entry_id);
});


test("controller 代次账本跨过 256 个其它 ID 仍不复用首代且不受迟到旧 end 回退", () => {
  const published: SupervisorActivityDelivery[] = [];
  const child = makeChildModeController({
    agentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    directChildId: GRANDCHILD_ID,
    directChildSupervisor: new FakeSupervisor(GRANDCHILD_ID),
    publishUpstreamActivity: (delivery) => published.push(delivery),
  });
  const tool = (
    toolCallId: string,
    type: "tool_execution_start" | "tool_execution_end",
    executionGeneration?: number,
  ): SafeAgentActivityEvent => type === "tool_execution_start"
    ? Object.freeze({
      type,
      toolCallId,
      toolName: "custom_tool",
      origin: "unknown",
      ...(executionGeneration === undefined ? {} : { executionGeneration }),
    })
    : Object.freeze({
      type,
      toolCallId,
      toolName: "custom_tool",
      origin: "unknown",
      ...(executionGeneration === undefined ? {} : { executionGeneration }),
      isError: false,
    });

  child.recordOwnActivity(tool("long-lived", "tool_execution_start"));
  child.recordOwnActivity(tool("long-lived", "tool_execution_end"));
  for (let index = 0; index < 300; index += 1) {
    child.recordOwnActivity(tool(`other-${index}`, "tool_execution_start"));
  }
  child.recordOwnActivity(tool("long-lived", "tool_execution_start"));
  const secondStart = published.at(-1)?.entry.body;
  assert.equal(secondStart?.type, "tool_execution_start");
  if (secondStart?.type !== "tool_execution_start") return;
  assert.equal(secondStart.executionGeneration, 2);

  // 第 1 代迟到 end 仍按第 1 代派生，但不能把当前第 2 代账本改为 closed。
  child.recordOwnActivity(tool("long-lived", "tool_execution_end", 1));
  child.recordOwnActivity(tool("long-lived", "tool_execution_start"));
  const repeatedSecondStart = published.at(-1)?.entry.body;
  assert.equal(repeatedSecondStart?.type, "tool_execution_start");
  if (repeatedSecondStart?.type !== "tool_execution_start") return;
  assert.equal(repeatedSecondStart.executionGeneration, 2);
});


test("权威完整消息即使是重复事实也会清除匹配 draft，但不触发历史通知", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });

  const entry = messageEntryWithStream(AGENT_ID, "完整正文", "message-duplicate", INCARNATION_ID);
  const historyNotifications: string[] = [];
  const unsubscribe = controller.onActivityChange((agentId) => historyNotifications.push(agentId));
  fake.emitActivityDisplay({
    agent_id: AGENT_ID,
    event: displayDelta("message-duplicate", 1, 0, "text", "实时草稿"),
  });
  assert.equal(controller.getDisplayDrafts(AGENT_ID).length, 1);

  // 模拟历史已由另一条入口接纳，但该入口尚未执行 draft 清理；随后通过
  // controller 重新收到同一权威事实，专门覆盖 changed=false 的清理分支。
  const internals = controller as unknown as {
    activityCache: { append: (agentId: string, entry: CanonicalAgentActivityEntry) => void };
  };
  internals.activityCache.append(AGENT_ID, entry);
  const revisionBeforeDuplicate = controller.getActivityRevision(AGENT_ID);
  const beforeDuplicateNotifications = historyNotifications.length;

  // 同一权威完整消息再次到达：cache changed=false，但 draft 必须收束。
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry });
  assert.deepEqual(controller.getDisplayDrafts(AGENT_ID), []);
  assert.equal(controller.getActivityRevision(AGENT_ID), revisionBeforeDuplicate);
  assert.equal(historyNotifications.length, beforeDuplicateNotifications);
  unsubscribe();
});

test("controller 暴露带 omission 的原子快照，并按 agent 隔离容量", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });

  for (let index = 0; index < 101; index += 1) {
    fake.emitActivityDelivery({
      agent_id: AGENT_ID,
      entry: messageEntry(AGENT_ID, `controller-${index}`),
    });
  }
  const snapshot = controller.getActivitySnapshot(AGENT_ID);
  assert.equal(snapshot.entries.length, 100);
  assert.equal(snapshot.olderActivityOmitted, true);
  assert.equal(controller.hasOlderActivityOmitted(AGENT_ID), true);
  assert.equal(controller.getActivitySnapshot(GRANDCHILD_ID).entries.length, 0);
});

test("活动生命周期收束只结算 running 工具，不阻断之后的合法迟到活动", async () => {
  const fake = new FakeSupervisor();
  const { controller, tree } = makeController(fake);
  await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });

  const start = tree.getLifecycleGeneration(AGENT_ID);
  assert.equal(start.ok, true, JSON.stringify(start));
  if (!start.ok) return;
  assert.equal(tree.applyLifecycleEvent(AGENT_ID, {
    type: "agent_start",
    expected_generation: start.data,
  }).ok, true);
  fake.emitLifecycle(AGENT_ID, { type: "agent_start", expected_generation: start.data });

  const settledGeneration = tree.getLifecycleGeneration(AGENT_ID);
  assert.equal(settledGeneration.ok, true, JSON.stringify(settledGeneration));
  if (!settledGeneration.ok) return;
  assert.equal(tree.applyLifecycleEvent(AGENT_ID, {
    type: "agent_settled",
    expected_generation: settledGeneration.data,
  }).ok, true);
  fake.emitLifecycle(AGENT_ID, {
    type: "agent_settled",
    expected_generation: settledGeneration.data,
  });

  const late = messageEntry(AGENT_ID, "settled 后迟到正文");
  fake.emitActivityDelivery({ agent_id: AGENT_ID, entry: late });
  assert.equal(controller.getActivitySnapshot(AGENT_ID).entries.some((entry) => entry.entry_id === late.entry_id), true);
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
