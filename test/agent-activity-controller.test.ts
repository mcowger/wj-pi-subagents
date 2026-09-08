import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AgentController,
  type AgentSupervisor,
} from "../src/agent-controller.ts";
import type { SupervisorActivityDelivery } from "../src/supervisor-channel.ts";
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

  emitActivityDisplay(event: SafeAgentActivityDisplayEvent): void {
    for (const listener of this.listeners) {
      listener(Object.freeze({ kind: "activity_display", event }));
    }
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

function makeChildModeController(options: {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly depth: number;
  readonly directChildId: string;
  readonly directChildSupervisor: FakeSupervisor;
  readonly publishUpstreamActivity: (delivery: SupervisorActivityDelivery) => void;
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

test("逐 token 显示事件只通知查看器，不写入缓存或上行活动流", async () => {
  const fake = new FakeSupervisor();
  const { controller, upstream } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  const observed: Array<{ readonly agentId: string; readonly event: SafeAgentActivityDisplayEvent }> = [];
  const unsubscribe = controller.onActivityDisplayChange((agentId, event) => observed.push({ agentId, event }));
  const delta: SafeAgentActivityDisplayEvent = Object.freeze({
    type: "message_delta",
    streamId: "message-1",
    sequence: 1,
    contentIndex: 0,
    contentType: "text",
    delta: "partial",
  });
  fake.emitActivityDisplay(delta);

  assert.deepEqual(observed, [{ agentId: AGENT_ID, event: delta }]);
  assert.deepEqual(controller.getActivityReplay(AGENT_ID), []);
  assert.equal(controller.getActivityRevision(AGENT_ID), 0);
  assert.deepEqual(upstream, []);
  unsubscribe();
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
