import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AgentActivityCache } from "../src/agent-activity-cache.ts";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";

const AGENT_A = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_B = "660e8400-e29b-41d4-a716-446655440001";

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

test("活动缓存按 agent_id 追加规范条目，并按到达序全量回放", () => {
  const cache = new AgentActivityCache();
  const first = messageEntry(AGENT_A, "第一条");
  const second = messageEntry(AGENT_A, "第二条");
  const toolEntry = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_A,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      origin: "pi_native",
    }),
  });
  cache.append(AGENT_A, first);
  cache.append(AGENT_A, toolEntry);
  cache.append(AGENT_A, second);

  assert.deepEqual(cache.replay(AGENT_A), [first, toolEntry, second]);
});

test("修订号随追加单调递增，未知代理回放为空且修订号为 0", () => {
  const cache = new AgentActivityCache();
  assert.equal(cache.revision(AGENT_A), 0);
  assert.deepEqual(cache.replay(AGENT_A), []);

  cache.append(AGENT_A, messageEntry(AGENT_A, "一"));
  cache.append(AGENT_A, messageEntry(AGENT_A, "二"));
  assert.equal(cache.revision(AGENT_A), 2);
  cache.append(AGENT_A, messageEntry(AGENT_A, "三"));
  assert.equal(cache.revision(AGENT_A), 3);
});

test("变更通知携带代理身份，退订后不再接收", () => {
  const cache = new AgentActivityCache();
  const notified: string[] = [];
  const unsubscribe = cache.onChange((agentId) => notified.push(agentId));

  cache.append(AGENT_A, messageEntry(AGENT_A, "一"));
  unsubscribe();
  cache.append(AGENT_A, messageEntry(AGENT_A, "二"));

  assert.deepEqual(notified, [AGENT_A]);
});

test("并行多代理缓存相互隔离", () => {
  const cache = new AgentActivityCache();
  cache.append(AGENT_A, messageEntry(AGENT_A, "A1"));
  cache.append(AGENT_B, messageEntry(AGENT_B, "B1"));
  cache.append(AGENT_A, messageEntry(AGENT_A, "A2"));

  assert.deepEqual(cache.replay(AGENT_A).map((entry) => entry.body), [
    messageEntry(AGENT_A, "A1").body,
    messageEntry(AGENT_A, "A2").body,
  ]);
  assert.deepEqual(cache.replay(AGENT_B).map((entry) => entry.body), [messageEntry(AGENT_B, "B1").body]);
  assert.equal(cache.revision(AGENT_A), 2);
  assert.equal(cache.revision(AGENT_B), 1);
});

test("非法代理身份、版本不符与身份不一致的条目不进入缓存", () => {
  const cache = new AgentActivityCache();
  const notified: string[] = [];
  cache.onChange((agentId) => notified.push(agentId));

  cache.append("not-a-uuid", messageEntry(AGENT_A, "无效"));
  cache.append(AGENT_A, Object.freeze({
    ...messageEntry(AGENT_A, "旧契约"),
    contract_version: "wj-pi-subagents.activity/0",
  }) as unknown as CanonicalAgentActivityEntry);
  // 条目自述身份与分组键不一致时拒绝，防止跨代理串流。
  cache.append(AGENT_A, messageEntry(AGENT_B, "串流"));

  assert.deepEqual(cache.replay(AGENT_A), []);
  assert.deepEqual(notified, []);
});

test("子代理终止后缓存仍可回放历史活动", () => {
  const cache = new AgentActivityCache();
  cache.append(AGENT_A, messageEntry(AGENT_A, "任务前的思考"));
  cache.append(AGENT_A, messageEntry(AGENT_A, "终止前最后一条"));

  // 模拟终止：缓存没有清理入口；同一实例继续可回放、可追加。
  assert.equal(cache.replay(AGENT_A).length, 2);
  assert.deepEqual(cache.replay(AGENT_A).map((entry) => entry.body.type), ["message", "message"]);
});
