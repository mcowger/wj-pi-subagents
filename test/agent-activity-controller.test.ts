import assert from "node:assert/strict";
import test from "node:test";
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

  emitActivityStream(event: SafeAgentActivityEvent, agentId?: string): void {
    for (const listener of this.listeners) {
      listener(Object.freeze({
        kind: "activity_stream",
        ...(agentId === undefined ? {} : { agent_id: agentId }),
        event,
      }));
    }
  }

  emitActivityDelivery(delivery: SupervisorActivityDelivery): void {
    this.emitActivityStream(delivery.event, delivery.agent_id);
  }

  emitActivityDisplay(event: SafeAgentActivityDisplayEvent): void {
    for (const listener of this.listeners) {
      listener(Object.freeze({ kind: "activity_display", event }));
    }
  }
}

function message(text: string): SafeAgentActivityEvent {
  return Object.freeze({ type: "message", content: [Object.freeze({ type: "text", text })] });
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

test("活动流事件写入父端缓存，按到达序可回放且修订号递增", async () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  const notified: string[] = [];
  const unsubscribe = controller.onActivityChange((agentId) => notified.push(agentId));

  fake.emitActivityStream(message("第一条"));
  fake.emitActivityStream(message("第二条"));

  assert.deepEqual(controller.getActivityReplay(AGENT_ID), [
    message("第一条"),
    message("第二条"),
  ]);
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

test("后代活动事件按其真实身份分组并沿上游转发", async () => {
  const fake = new FakeSupervisor();
  const { controller, upstream } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));

  fake.emitActivityStream(message("直接子正文"));
  fake.emitActivityStream(message("孙代理正文"), GRANDCHILD_ID);

  assert.deepEqual(controller.getActivityReplay(AGENT_ID), [message("直接子正文")]);
  assert.deepEqual(controller.getActivityReplay(GRANDCHILD_ID), [message("孙代理正文")]);
  assert.deepEqual(upstream, [
    { agent_id: AGENT_ID, event: message("直接子正文") },
    { agent_id: GRANDCHILD_ID, event: message("孙代理正文") },
  ]);
});

test("每层缓存自身与直接子树活动，并把孙代理事件逐级隔离转发到根", async () => {
  const rootSupervisor = new FakeSupervisor(AGENT_ID);
  const { controller: root } = makeController(rootSupervisor);
  const rootSpawned = await root.spawnAgent({ template_id: "demo", name: "直接子代理" });
  assert.equal(rootSpawned.ok, true, JSON.stringify(rootSpawned));

  const childTree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => GRANDCHILD_ID,
    initialActor: {
      agentId: AGENT_ID,
      parentAgentId: null,
      depth: 1,
      templateId: "demo",
      name: "直接子代理",
      managementEnabled: true,
    },
  });
  const grandchildSupervisor = new FakeSupervisor(GRANDCHILD_ID);
  grandchildSupervisor.tree = childTree;
  const childToRoot: SupervisorActivityDelivery[] = [];
  const child = new AgentController({
    tree: childTree,
    actor: { kind: "agent", agent_id: AGENT_ID },
    allowUnvalidatedTemplates: true,
    createSupervisor: (input) => {
      grandchildSupervisor.actor = input.actor;
      grandchildSupervisor.reservation = input.reservation;
      return grandchildSupervisor;
    },
    replyNotificationsHandledByInbox: false,
    publishUpstreamActivity: (delivery) => {
      childToRoot.push(delivery);
      rootSupervisor.emitActivityDelivery(delivery);
    },
  });
  const childSpawned = await child.spawnAgent({ template_id: "demo", name: "孙代理" });
  assert.equal(childSpawned.ok, true, JSON.stringify(childSpawned));

  assert.equal(child.recordOwnActivity(message("直接子自身事件")), true);
  grandchildSupervisor.emitActivityStream(message("孙代理自身事件"));

  assert.deepEqual(child.getActivityReplay(AGENT_ID), [message("直接子自身事件")]);
  assert.deepEqual(child.getActivityReplay(GRANDCHILD_ID), [message("孙代理自身事件")]);
  assert.deepEqual(root.getActivityReplay(AGENT_ID), [message("直接子自身事件")]);
  assert.deepEqual(root.getActivityReplay(GRANDCHILD_ID), [message("孙代理自身事件")]);
  assert.deepEqual(childToRoot, [
    { agent_id: AGENT_ID, event: message("直接子自身事件") },
    { agent_id: GRANDCHILD_ID, event: message("孙代理自身事件") },
  ]);
  assert.equal(root.getActivityRevision(AGENT_ID), 1);
  assert.equal(root.getActivityRevision(GRANDCHILD_ID), 1);
});

test("根控制器没有可上行的自身代理身份", () => {
  const fake = new FakeSupervisor();
  const { controller } = makeController(fake);

  assert.equal(controller.recordOwnActivity(message("根事件")), false);
  assert.deepEqual(controller.getActivityReplay(AGENT_ID), []);
});

test("子代理终止后活动缓存仍可回放", async () => {
  const fake = new FakeSupervisor();
  const { controller, tree } = makeController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "活动子代理" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  fake.emitActivityStream(message("终止前的正文"));

  const terminated = await controller.terminateAgent(AGENT_ID);
  assert.equal(terminated.ok, true, JSON.stringify(terminated));
  void tree;

  assert.deepEqual(controller.getActivityReplay(AGENT_ID), [message("终止前的正文")]);
  assert.equal(controller.getActivityRevision(AGENT_ID), 1);
});
