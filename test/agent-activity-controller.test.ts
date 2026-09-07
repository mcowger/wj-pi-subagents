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
import type { SafeAgentActivityEvent } from "../src/rpc-bridge-event.ts";
import {
  TreeController,
  ROOT_TREE_ACTOR,
  type ReserveStartingChildInput,
} from "../src/tree-controller.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GRANDCHILD_ID = "660e8400-e29b-41d4-a716-446655440001";

class FakeSupervisor implements AgentSupervisor {
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  tree: TreeController | undefined;
  reservation: ReserveStartingChildInput | undefined;

  start(): Promise<RpcSupervisorStartupResult> {
    if (this.tree !== undefined && this.reservation !== undefined) {
      const reserved = this.tree.reserveStartingChild(ROOT_TREE_ACTOR, this.reservation);
      assert.equal(reserved.ok, true);
      this.tree.applyLifecycleEvent(AGENT_ID, {
        type: "startup_ready",
        expected_generation: 0,
      });
    }
    return Promise.resolve({ ok: true, agent_id: AGENT_ID, state: "idle" });
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
      agent_id: AGENT_ID,
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
