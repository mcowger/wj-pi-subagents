import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivityCache } from "../src/agent-activity-cache.ts";
import type { SafeAgentActivityEvent } from "../src/rpc-bridge-event.ts";

const AGENT_A = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_B = "660e8400-e29b-41d4-a716-446655440001";

function message(text: string): SafeAgentActivityEvent {
  return Object.freeze({ type: "message", content: [Object.freeze({ type: "text", text })] });
}

function toolStart(callId: string, args: string): SafeAgentActivityEvent {
  return Object.freeze({
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: "read",
    args,
  });
}

test("活动缓存按 agent_id 追加，并按到达序全量回放", () => {
  const cache = new AgentActivityCache();
  cache.append(AGENT_A, message("第一条"));
  cache.append(AGENT_A, toolStart("call_1", '{"path":"a.ts"}'));
  cache.append(AGENT_A, message("第二条"));

  assert.deepEqual(cache.replay(AGENT_A), [
    message("第一条"),
    toolStart("call_1", '{"path":"a.ts"}'),
    message("第二条"),
  ]);
});

test("修订号随追加单调递增，未知代理回放为空且修订号为 0", () => {
  const cache = new AgentActivityCache();
  assert.equal(cache.revision(AGENT_A), 0);
  assert.deepEqual(cache.replay(AGENT_A), []);

  cache.append(AGENT_A, message("一"));
  cache.append(AGENT_A, message("二"));
  assert.equal(cache.revision(AGENT_A), 2);
  cache.append(AGENT_A, message("三"));
  assert.equal(cache.revision(AGENT_A), 3);
});

test("变更通知携带代理身份，退订后不再接收", () => {
  const cache = new AgentActivityCache();
  const notified: string[] = [];
  const unsubscribe = cache.onChange((agentId) => notified.push(agentId));

  cache.append(AGENT_A, message("一"));
  unsubscribe();
  cache.append(AGENT_A, message("二"));

  assert.deepEqual(notified, [AGENT_A]);
});

test("并行多代理缓存相互隔离", () => {
  const cache = new AgentActivityCache();
  cache.append(AGENT_A, message("A1"));
  cache.append(AGENT_B, message("B1"));
  cache.append(AGENT_A, message("A2"));

  assert.deepEqual(cache.replay(AGENT_A), [message("A1"), message("A2")]);
  assert.deepEqual(cache.replay(AGENT_B), [message("B1")]);
  assert.equal(cache.revision(AGENT_A), 2);
  assert.equal(cache.revision(AGENT_B), 1);
});

test("非法代理身份与无效事件不进入缓存", () => {
  const cache = new AgentActivityCache();
  const notified: string[] = [];
  cache.onChange((agentId) => notified.push(agentId));

  cache.append("not-a-uuid", message("无效"));
  cache.append(AGENT_A, { type: "agent_start" } as unknown as SafeAgentActivityEvent);

  assert.deepEqual(cache.replay(AGENT_A), []);
  assert.deepEqual(notified, []);
});

test("子代理终止后缓存仍可回放历史活动", () => {
  const cache = new AgentActivityCache();
  cache.append(AGENT_A, message("任务前的思考"));
  cache.append(AGENT_A, toolStart("call_1", '{"path":"a.ts"}'));

  // 模拟终止：缓存没有清理入口；同一实例继续可回放、可追加。
  assert.equal(cache.replay(AGENT_A).length, 2);
  cache.append(AGENT_A, message("终止前最后一条"));
  assert.deepEqual(cache.replay(AGENT_A).map((event) => event.type), [
    "message",
    "tool_execution_start",
    "message",
  ]);
});
