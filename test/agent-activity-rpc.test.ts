import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WJ_PI_SUBAGENTS_ACTIVITY_TYPE,
  bindAgentActivityRpc,
  publishAgentActivity,
  registerAgentActivityEntryRenderer,
} from "../src/agent-activity-rpc.ts";
import type { CanonicalAgentActivityEntry } from "../src/canonical-activity.ts";

function makeEntry(id: string): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: "wj-pi-subagents.activity/12",
    agent_id: "11111111-1111-4111-8111-111111111111",
    incarnation_id: "22222222-2222-4222-8222-222222222222",
    entry_id: id,
    body: Object.freeze({ type: "model_call_failure", detail: "boom" }),
  }) as unknown as CanonicalAgentActivityEntry;
}

function makeController(entries: readonly CanonicalAgentActivityEntry[], revision = 7) {
  let listener: ((agentId: string) => void) | undefined;
  return {
    snapshotCalls: 0,
    getActivitySnapshot: (_agentId: unknown) => {
      return Object.freeze({
        snapshotEpoch: 1,
        entries: Object.freeze([...entries]),
        revision,
        olderActivityOmitted: false,
      });
    },
    onActivityChange: (next: (agentId: string) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    emit: (agentId: string) => listener?.(agentId),
    isSubscribed: () => listener !== undefined,
  };
}

function makeApi() {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const renderers = new Map<string, unknown>();
  return {
    appended,
    renderers,
    appendEntry: (customType: string, data?: unknown) => {
      appended.push({ customType, data });
    },
    registerEntryRenderer: (customType: string, renderer: unknown) => {
      renderers.set(customType, renderer);
    },
  };
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("agent activity rpc fan-out", () => {
  it("publishes latest entry only as a custom entry outside LLM context", () => {
    const controller = makeController([makeEntry("a"), makeEntry("b")], 9);
    const api = makeApi();
    const ok = publishAgentActivity(api, controller, AGENT_ID);
    assert.equal(ok, true);
    assert.equal(api.appended.length, 1);
    const first = api.appended[0]!;
    assert.equal(first.customType, WJ_PI_SUBAGENTS_ACTIVITY_TYPE);
    const payload = first.data as Record<string, unknown>;
    assert.equal(payload.schema, "wj-pi-subagents.activity/1");
    assert.equal(payload.kind, "activity");
    assert.equal(payload.agent_id, AGENT_ID);
    assert.equal(payload.revision, 9);
    assert.equal(payload.olderActivityOmitted, false);
    assert.equal((payload.entry as Record<string, unknown>).entry_id, "b");
  });

  it("sends nothing on empty snapshots and never throws", () => {
    const controller = makeController([]);
    const api = makeApi();
    assert.equal(publishAgentActivity(api, controller, AGENT_ID), false);
    assert.equal(api.appended.length, 0);
    const throwing = {
      getActivitySnapshot: () => {
        throw new Error("gone");
      },
      onActivityChange: () => () => {},
    };
    assert.equal(publishAgentActivity(api, throwing, AGENT_ID), false);
    const failingApi = { appendEntry: () => {
      throw new Error("host down");
    } };
    const full = makeController([makeEntry("a")]);
    assert.equal(publishAgentActivity(failingApi, full, AGENT_ID), false);
  });

  it("binds to activity changes and unsubscribes on dispose", () => {
    const controller = makeController([makeEntry("a")]);
    const api = makeApi();
    const binding = bindAgentActivityRpc(controller, api);
    assert.equal(controller.isSubscribed(), true);
    controller.emit(AGENT_ID);
    assert.equal(api.appended.length, 1);
    binding.dispose();
    assert.equal(controller.isSubscribed(), false);
    controller.emit(AGENT_ID);
    assert.equal(api.appended.length, 1);
  });

  it("registers a hidden entry renderer that renders nothing", () => {
    const api = makeApi();
    registerAgentActivityEntryRenderer(api);
    assert.equal(api.renderers.has(WJ_PI_SUBAGENTS_ACTIVITY_TYPE), true);
    const renderer = api.renderers.get(WJ_PI_SUBAGENTS_ACTIVITY_TYPE) as (...args: unknown[]) => unknown;
    assert.equal(
      renderer({ customType: WJ_PI_SUBAGENTS_ACTIVITY_TYPE, data: { agent_id: AGENT_ID, revision: 3 } }, {}, {}),
      undefined,
    );
    assert.throws(() => registerAgentActivityEntryRenderer({}), TypeError);
  });
});
