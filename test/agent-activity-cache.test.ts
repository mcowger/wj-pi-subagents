import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AGENT_ACTIVITY_MAX_TOMBSTONES,
  AgentActivityCache,
} from "../src/agent-activity-cache.ts";
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

function identifiedMessageEntry(
  agentId: string,
  incarnationId: string,
  entryId: string,
  text: string,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: agentId,
    incarnation_id: incarnationId,
    entry_id: entryId,
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
    }),
  });
}

function toolEntry(
  agentId: string,
  incarnationId: string,
  entryId: string,
  phase: "start" | "end",
  toolCallId = "call-1",
  toolName = "read",
  isError = false,
  executionGeneration = 1,
): CanonicalAgentActivityEntry {
  const body = phase === "start"
    ? Object.freeze({
      type: "tool_execution_start" as const,
      toolCallId,
      toolName,
      origin: "pi_native" as const,
      executionGeneration,
    })
    : Object.freeze({
      type: "tool_execution_end" as const,
      toolCallId,
      toolName,
      origin: "pi_native" as const,
      executionGeneration,
      isError,
    });
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: agentId,
    incarnation_id: incarnationId,
    entry_id: entryId,
    body,
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
      executionGeneration: 1,
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

test("clear 建立新观察代际，空快照与后续 revision 不会复用旧序列", () => {
  const cache = new AgentActivityCache();
  cache.append(AGENT_A, messageEntry(AGENT_A, "清理前"));
  const before = cache.snapshot(AGENT_A);
  assert.equal(before.snapshotEpoch, 0);
  assert.equal(before.revision, 1);

  assert.equal(cache.clear(), true);
  const cleared = cache.snapshot(AGENT_A);
  assert.equal(cleared.snapshotEpoch, 1);
  assert.equal(cleared.revision, 0);
  assert.deepEqual(cleared.entries, []);

  cache.append(AGENT_A, messageEntry(AGENT_A, "清理后"));
  const after = cache.snapshot(AGENT_A);
  assert.equal(after.snapshotEpoch, 1);
  assert.equal(after.revision, 1);
  assert.equal(after.entries[0]?.body.type === "message"
    ? after.entries[0].body.content[0]?.type === "text"
      ? after.entries[0].body.content[0].text
      : undefined
    : undefined, "清理后");
});

test("空 cache 的 clear 仍推进快照观察代际", () => {
  const cache = new AgentActivityCache();
  assert.equal(cache.clear(), false);
  assert.equal(cache.snapshot(AGENT_A).snapshotEpoch, 1);
  assert.equal(cache.clear(), false);
  assert.equal(cache.snapshot(AGENT_A).snapshotEpoch, 2);
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

test("工具结束先到、迟到 start、重复事实和身份冲突都保持单一原子", () => {
  const cache = new AgentActivityCache();
  const incarnationId = "11111111-1111-4111-8111-111111111111";
  const entryId = "22222222-2222-4222-8222-222222222222";
  const end = toolEntry(AGENT_A, incarnationId, entryId, "end", "call-ordered");
  const start = toolEntry(AGENT_A, incarnationId, entryId, "start", "call-ordered");
  const notifications: string[] = [];
  cache.onChange((agentId) => notifications.push(agentId));

  const first = cache.record(AGENT_A, end);
  assert.equal(first.accepted, true);
  assert.equal(first.changed, true);
  assert.equal(first.disposition, "appended");
  assert.equal(first.snapshot.entries.length, 1);

  const lateStart = cache.record(AGENT_A, start);
  assert.equal(lateStart.accepted, true);
  assert.equal(lateStart.changed, false);
  assert.equal(lateStart.disposition, "duplicate");
  assert.equal(cache.replay(AGENT_A).length, 1);
  assert.equal(cache.replay(AGENT_A)[0]?.body.type, "tool_execution_end");

  const revision = cache.revision(AGENT_A);
  const duplicateEnd = cache.record(AGENT_A, end);
  assert.equal(duplicateEnd.accepted, true);
  assert.equal(duplicateEnd.changed, false);
  assert.equal(duplicateEnd.disposition, "duplicate");
  assert.equal(cache.revision(AGENT_A), revision);

  const conflicting = toolEntry(
    AGENT_A,
    incarnationId,
    entryId,
    "end",
    "call-ordered",
    "write",
  );
  const beforeConflict = cache.snapshot(AGENT_A);
  const rejected = cache.record(AGENT_A, conflicting);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.changed, false);
  assert.equal(rejected.disposition, "rejected");
  assert.deepEqual(cache.snapshot(AGENT_A), beforeConflict);
  assert.equal(cache.revision(AGENT_A), revision);
  assert.deepEqual(notifications, [AGENT_A]);
});

test("工具 start 到达后 end 原地更新，完成态不回退且精确重复幂等", () => {
  const cache = new AgentActivityCache();
  const incarnationId = "33333333-3333-4333-8333-333333333333";
  const entryId = "44444444-4444-4444-8444-444444444444";
  const start = toolEntry(AGENT_A, incarnationId, entryId, "start", "call-update");
  const end = toolEntry(AGENT_A, incarnationId, entryId, "end", "call-update");

  assert.equal(cache.record(AGENT_A, start).disposition, "appended");
  const updated = cache.record(AGENT_A, end);
  assert.equal(updated.accepted, true);
  assert.equal(updated.changed, true);
  assert.equal(updated.disposition, "updated");
  assert.equal(updated.snapshot.entries.length, 1);
  assert.deepEqual(updated.snapshot.entries[0]?.body, end.body);

  const lateStart = cache.record(AGENT_A, start);
  assert.equal(lateStart.accepted, true);
  assert.equal(lateStart.changed, false);
  assert.equal(cache.snapshot(AGENT_A).entries[0]?.body.type, "tool_execution_end");

  const conflict = toolEntry(
    AGENT_A,
    incarnationId,
    "55555555-5555-4555-8555-555555555555",
    "end",
    "call-update",
  );
  const before = cache.snapshot(AGENT_A);
  const conflictResult = cache.record(AGENT_A, conflict);
  assert.equal(conflictResult.accepted, false);
  assert.deepEqual(cache.snapshot(AGENT_A), before);
});

test("agent 与 incarnation 身份隔离，toolCallId 相同也不会串联", () => {
  const cache = new AgentActivityCache();
  const incarnationA = "66666666-6666-4666-8666-666666666666";
  const incarnationB = "77777777-7777-4777-8777-777777777777";
  const entryId = "88888888-8888-4888-8888-888888888888";
  const startA = toolEntry(AGENT_A, incarnationA, entryId, "start", "same-call");
  const endA = toolEntry(AGENT_A, incarnationA, entryId, "end", "same-call");
  const startB = toolEntry(AGENT_A, incarnationB, entryId, "start", "same-call");
  const endOtherAgent = toolEntry(AGENT_B, incarnationA, entryId, "end", "same-call");

  cache.append(AGENT_A, startA);
  cache.append(AGENT_A, startB);
  cache.append(AGENT_B, endOtherAgent);
  cache.append(AGENT_A, endA);

  assert.equal(cache.replay(AGENT_A).length, 2);
  assert.deepEqual(cache.replay(AGENT_A).map((entry) => entry.body.type), [
    "tool_execution_end",
    "tool_execution_start",
  ]);
  assert.deepEqual(cache.replay(AGENT_B), [endOtherAgent]);
});

test("同一运行实例复用 toolCallId 时按 executionGeneration 分离两个原子", () => {
  const cache = new AgentActivityCache();
  const incarnationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const start1 = toolEntry(AGENT_A, incarnationId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "start", "reused", "read", false, 1);
  const end1 = toolEntry(AGENT_A, incarnationId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "end", "reused", "read", false, 1);
  const start2 = toolEntry(AGENT_A, incarnationId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "start", "reused", "read", false, 2);
  const end2 = toolEntry(AGENT_A, incarnationId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "end", "reused", "read", false, 2);

  assert.equal(cache.record(AGENT_A, start1).accepted, true);
  assert.equal(cache.record(AGENT_A, end1).disposition, "updated");
  assert.equal(cache.record(AGENT_A, start2).accepted, true);
  assert.equal(cache.record(AGENT_A, end2).disposition, "updated");
  const replay = cache.replay(AGENT_A);
  assert.equal(replay.length, 2);
  assert.deepEqual(replay.map((entry) => entry.body.type === "tool_execution_end"
    ? entry.body.executionGeneration
    : undefined), [1, 2]);
});


test("99、100、101 个完整 atom 按代理窗口裁剪且首次淘汰持久标记", () => {
  const cache = new AgentActivityCache();
  for (let index = 1; index <= 99; index += 1) {
    const result = cache.record(AGENT_A, messageEntry(AGENT_A, `activity-${index}`));
    assert.equal(result.accepted, true);
  }
  assert.equal(cache.snapshot(AGENT_A).entries.length, 99);
  assert.equal(cache.snapshot(AGENT_A).olderActivityOmitted, false);

  cache.append(AGENT_A, messageEntry(AGENT_A, "activity-100"));
  assert.equal(cache.snapshot(AGENT_A).entries.length, 100);
  assert.equal(cache.snapshot(AGENT_A).olderActivityOmitted, false);

  cache.append(AGENT_A, messageEntry(AGENT_A, "activity-101"));
  const snapshot = cache.snapshot(AGENT_A);
  assert.equal(snapshot.entries.length, 100);
  assert.equal(snapshot.olderActivityOmitted, true);
  const firstBody = snapshot.entries[0]?.body;
  const lastBody = snapshot.entries.at(-1)?.body;
  assert.equal(firstBody?.type === "message"
    ? firstBody.content[0]?.type === "text" ? firstBody.content[0].text : undefined
    : undefined, "activity-2");
  assert.equal(lastBody?.type === "message"
    ? lastBody.content[0]?.type === "text" ? lastBody.content[0].text : undefined
    : undefined, "activity-101");
  assert.equal(snapshot.revision, cache.revision(AGENT_A));

  // omission 是合成状态，不占用 100 条额度，后续活动不会清除它。
  cache.append(AGENT_A, messageEntry(AGENT_A, "activity-102"));
  assert.equal(cache.snapshot(AGENT_A).entries.length, 100);
  assert.equal(cache.snapshot(AGENT_A).olderActivityOmitted, true);
});

test("running 工具固定保留，临时超限在显式收束后立即裁剪", () => {
  const cache = new AgentActivityCache();
  const incarnationId = "99999999-9999-4999-8999-999999999999";
  for (let index = 0; index < 101; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const entryId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}${suffix}${suffix}${suffix}`;
    const callId = `running-${index}`;
    const result = cache.record(
      AGENT_A,
      toolEntry(AGENT_A, incarnationId, entryId, "start", callId),
    );
    assert.equal(result.accepted, true);
  }
  assert.equal(cache.snapshot(AGENT_A).entries.length, 101);
  assert.equal(cache.snapshot(AGENT_A).olderActivityOmitted, false);

  const settled = cache.settleAgent(AGENT_A, "terminated");
  assert.equal(settled.accepted, true);
  assert.equal(settled.changed, true);
  assert.equal(settled.snapshot.entries.length, 100);
  assert.equal(settled.snapshot.olderActivityOmitted, true);
  const remainingCalls = cache.replay(AGENT_A).map((entry) =>
    entry.body.type === "tool_execution_start" || entry.body.type === "tool_execution_end"
      ? entry.body.toolCallId
      : "",
  );
  assert.equal(remainingCalls.includes("running-0"), false);
  assert.equal(remainingCalls.includes("running-100"), true);

  // 被裁剪的终态工具由 tombstone 吸收迟到 end，不会重新占用窗口。
  const lateEnd = toolEntry(
    AGENT_A,
    incarnationId,
    "aaaaaaaa-aaaa-4aaa-8aaa-000000000000",
    "end",
    "running-0",
  );
  const beforeLate = cache.snapshot(AGENT_A);
  const late = cache.record(AGENT_A, lateEnd);
  assert.equal(late.accepted, true);
  assert.equal(late.changed, false);
  assert.deepEqual(cache.snapshot(AGENT_A), beforeLate);
});

test("淘汰后的工具终态墓碑不被普通消息冲掉，迟到 end 与冲突事实保持有界裁决", () => {
  const cache = new AgentActivityCache();
  const incarnationId = "abababab-abab-4bab-8bab-abababababab";
  const entryId = "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd";
  const start = toolEntry(AGENT_A, incarnationId, entryId, "start", "tombstone-call");
  const end = toolEntry(AGENT_A, incarnationId, entryId, "end", "tombstone-call");
  cache.append(AGENT_A, start);
  cache.append(AGENT_A, end);
  for (let index = 0; index < 100; index += 1) {
    cache.append(AGENT_A, messageEntry(AGENT_A, `fill-${index}`));
  }
  assert.equal(cache.snapshot(AGENT_A).entries.length, 100);
  assert.equal(cache.snapshot(AGENT_A).entries.some((entry) => entry.entry_id === entryId), false);

  // 大量普通消息只会轮换 entry tombstone；tool tombstone 仍阻止旧 end 复活。
  for (let index = 0; index < AGENT_ACTIVITY_MAX_TOMBSTONES + 8; index += 1) {
    cache.append(AGENT_A, messageEntry(AGENT_A, `more-${index}`));
  }
  const beforeLate = cache.snapshot(AGENT_A);
  const late = cache.record(AGENT_A, end);
  assert.equal(late.accepted, true);
  assert.equal(late.changed, false);
  assert.deepEqual(cache.snapshot(AGENT_A), beforeLate);

  const conflicting = toolEntry(
    AGENT_A,
    incarnationId,
    entryId,
    "end",
    "tombstone-call",
    "edit",
  );
  const rejected = cache.record(AGENT_A, conflicting);
  assert.equal(rejected.accepted, false);
  assert.deepEqual(cache.snapshot(AGENT_A), beforeLate);
});

test("工具与普通条目的 tombstone 按代理合计受单一总容量约束", () => {
  const cache = new AgentActivityCache();
  const incarnationId = "dededede-dede-4ded-8ded-dededededede";
  for (let index = 0; index < 300; index += 1) {
    cache.record(AGENT_A, messageEntry(AGENT_A, `tombstone-message-${index}`));
    const suffix = index.toString(16).padStart(12, "0");
    const entryId = `eeeeeeee-eeee-4eee-8eee-${suffix}`;
    cache.record(
      AGENT_A,
      toolEntry(AGENT_A, incarnationId, entryId, "end", `tombstone-tool-${index}`),
    );
  }
  const internals = cache as unknown as {
    records: Map<string, {
      toolTombstones: Map<string, unknown>;
      entryTombstones: Map<string, unknown>;
      tombstoneOrder: Map<string, unknown>;
    }>;
  };
  const record = internals.records.get(AGENT_A);
  assert.ok(record);
  if (record === undefined) return;
  assert.equal(
    record.toolTombstones.size + record.entryTombstones.size,
    AGENT_ACTIVITY_MAX_TOMBSTONES,
  );
  assert.equal(record.tombstoneOrder.size, AGENT_ACTIVITY_MAX_TOMBSTONES);
});


test("允许保存的长正文完整保留，不按字节或正文长度截断", () => {
  const cache = new AgentActivityCache();
  const text = "完整正文🌍\n".repeat(25_000);
  const entry = messageEntry(AGENT_A, text);
  const result = cache.record(AGENT_A, entry);
  assert.equal(result.accepted, true);
  const body = result.snapshot.entries[0]?.body;
  assert.equal(body?.type, "message");
  if (body?.type === "message") {
    assert.equal(body.content[0]?.type, "text");
    if (body.content[0]?.type === "text") assert.equal(body.content[0].text, text);
  }
});

test("身份冲突不改变 revision、snapshot 或通知，append 仍保持 void 兼容", () => {
  const cache = new AgentActivityCache();
  const first = messageEntry(AGENT_A, "原始");
  const notifications: string[] = [];
  cache.onChange((agentId) => notifications.push(agentId));
  assert.equal(cache.append(AGENT_A, first), undefined);
  const before = cache.snapshot(AGENT_A);
  const conflict = identifiedMessageEntry(
    AGENT_A,
    first.incarnation_id,
    first.entry_id,
    "改写",
  );
  const rejected = cache.record(AGENT_A, conflict);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.changed, false);
  assert.deepEqual(cache.snapshot(AGENT_A), before);
  assert.equal(cache.revision(AGENT_A), 1);
  assert.deepEqual(notifications, [AGENT_A]);
  assert.equal(cache.snapshot("not-a-uuid").revision, 0);
});
