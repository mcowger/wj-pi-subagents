import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  CANONICAL_ACTIVITY_CHUNK_TOTAL_LIMIT,
  chunkCanonicalAgentActivityEntry,
  parseCanonicalAgentActivityChunk,
  parseCanonicalAgentActivityEntry,
  reassembleCanonicalAgentActivityChunks,
  type CanonicalAgentActivityChunk,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function messageEntry(text: string): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
    }),
  });
}

function validEntry(overrides: Partial<CanonicalAgentActivityEntry> = {}): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text: "回复正文" })]),
    }),
    ...overrides,
  } as CanonicalAgentActivityEntry);
}

test("规范条目契约版本是固定字符串，解析器只接受当前版本", () => {
  assert.equal(CANONICAL_ACTIVITY_CONTRACT_VERSION, "wj-pi-subagents.activity/2");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry()).kind, "entry");

  const legacy = Object.freeze({ ...validEntry(), contract_version: "wj-pi-subagents.activity/1" });
  assert.equal(parseCanonicalAgentActivityEntry(legacy).kind, "invalid");
});

test("规范条目校验代理身份、运行实例身份、条目身份与原子正文闭集", () => {
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ agent_id: "not-a-uuid" })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ incarnation_id: "incarnation" })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ entry_id: "" })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ body: { type: "agent_start" } as never })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry({ type: "message" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(undefined).kind, "invalid");

  const parsed = parseCanonicalAgentActivityEntry(validEntry());
  assert.equal(parsed.kind, "entry");
  if (parsed.kind === "entry") {
    assert.equal(parsed.entry.contract_version, CANONICAL_ACTIVITY_CONTRACT_VERSION);
    assert.deepEqual(parsed.entry.body, {
      type: "message",
      content: [{ type: "text", text: "回复正文" }],
    });
  }
});

test("规范条目拒绝额外字段与缺失字段", () => {
  const padded = { ...validEntry(), extra: true } as Record<string, unknown>;
  assert.equal(parseCanonicalAgentActivityEntry(padded).kind, "invalid");

  const missing = validEntry();
  const { contract_version: _dropped, ...rest } = missing;
  assert.equal(parseCanonicalAgentActivityEntry(rest).kind, "invalid");
});

test("分块把超过单帧预算的完整正文切成身份一致的帧序列", () => {
  const entry = messageEntry("x".repeat(200 * 1024));
  const frames = chunkCanonicalAgentActivityEntry(entry, 64 * 1024);

  assert.ok(frames.length > 1, `期望多帧，实际 ${frames.length}`);
  for (const frame of frames) {
    assert.equal(frame.contract_version, CANONICAL_ACTIVITY_CONTRACT_VERSION);
    assert.equal(frame.agent_id, entry.agent_id);
    assert.equal(frame.incarnation_id, entry.incarnation_id);
    assert.equal(frame.entry_id, entry.entry_id);
    assert.equal("chunk_total" in frame ? frame.chunk_total : frames.length, frames.length);
    assert.ok(typeof (frame as CanonicalAgentActivityChunk).payload === "string");
  }
  assert.equal((frames[0] as CanonicalAgentActivityChunk).chunk_index, 0);
  assert.equal((frames.at(-1) as CanonicalAgentActivityChunk).chunk_index, frames.length - 1);
});

test("小条目直接内联传输，不产生分块帧", () => {
  const entry = validEntry();
  const frames = chunkCanonicalAgentActivityEntry(entry, 64 * 1024);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], entry);
});

test("分块帧序列重组后得到完整规范条目", () => {
  const text = "标题\n\n" + "段落内容。".repeat(30_000);
  const entry = validEntry({
    body: Object.freeze({
      type: "message",
      content: Object.freeze([
        Object.freeze({ type: "thinking", thinking: "先想一下" }),
        Object.freeze({ type: "text", text }),
      ]),
    }),
  } as Partial<CanonicalAgentActivityEntry>);
  const frames = chunkCanonicalAgentActivityEntry(entry, 32 * 1024) as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 4);

  const reassembled = reassembleCanonicalAgentActivityChunks(frames);
  assert.ok(reassembled);
  assert.deepEqual(reassembled.body, entry.body);
  assert.equal(reassembled.agent_id, entry.agent_id);
  assert.equal(reassembled.incarnation_id, entry.incarnation_id);
  assert.equal(reassembled.entry_id, entry.entry_id);
  assert.equal(reassembled.contract_version, CANONICAL_ACTIVITY_CONTRACT_VERSION);
});

test("分块在多字节字符边界切割，重组不损坏宽字符正文", () => {
  const text = "代理活动正文🌍".repeat(9000);
  const entry = messageEntry(text);
  const frames = chunkCanonicalAgentActivityEntry(entry, 7 * 1024) as CanonicalAgentActivityChunk[];
  const reassembled = reassembleCanonicalAgentActivityChunks(frames);
  assert.ok(reassembled);
  const content = reassembled.body as Extract<CanonicalAgentActivityEntry["body"], { type: "message" }>;
  const block = content.content[0];
  assert.ok(block && block.type === "text");
  assert.equal(block.text, text);
});

test("乱序到达的分块仍可重组，重复分块幂等", () => {
  const entry = messageEntry("y".repeat(150 * 1024));
  const frames = [...chunkCanonicalAgentActivityEntry(entry, 32 * 1024)] as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 3);
  const shuffled = [frames[2]!, frames[0]!, frames[1]!, ...frames.slice(3)];
  const reassembled = reassembleCanonicalAgentActivityChunks(shuffled);
  assert.ok(reassembled);
  assert.deepEqual(reassembled.body, entry.body);

  const withDuplicate = [...shuffled, frames[1]!];
  const deduped = reassembleCanonicalAgentActivityChunks(withDuplicate);
  assert.ok(deduped);
  assert.deepEqual(deduped.body, entry.body);
});

test("缺块不产生部分权威正文", () => {
  const entry = messageEntry("z".repeat(100 * 1024));
  const frames = chunkCanonicalAgentActivityEntry(entry, 32 * 1024) as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 2);

  assert.equal(reassembleCanonicalAgentActivityChunks(frames.slice(0, -1)), undefined);

  const missingMiddle = frames.filter((frame) => frame.chunk_index !== 1);
  assert.equal(reassembleCanonicalAgentActivityChunks(missingMiddle), undefined);
});

test("分块总数越界或声明不一致的分块无效", () => {
  const base = {
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    chunk_index: 0,
    chunk_total: 2,
    payload: "abc",
  };
  assert.equal(parseCanonicalAgentActivityChunk(base).kind, "chunk");
  assert.equal(
    parseCanonicalAgentActivityChunk({ ...base, chunk_total: CANONICAL_ACTIVITY_CHUNK_TOTAL_LIMIT + 1 }).kind,
    "invalid",
  );
  assert.equal(parseCanonicalAgentActivityChunk({ ...base, chunk_index: 2 }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityChunk({ ...base, payload: "" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityChunk({ ...base, contract_version: "old" }).kind, "invalid");

  const entry = messageEntry("w".repeat(70 * 1024));
  const frames = chunkCanonicalAgentActivityEntry(entry, 32 * 1024) as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 1);
  const tampered = frames.map((frame, index) =>
    index === 0 ? { ...frame, chunk_total: frame.chunk_total + 1 } : frame
  );
  assert.equal(reassembleCanonicalAgentActivityChunks(tampered), undefined);
});

test("损坏的分块正文无法重组出条目", () => {
  const chunks: CanonicalAgentActivityChunk[] = [];
  const total = 2;
  for (let index = 0; index < total; index += 1) {
    chunks.push(Object.freeze({
      contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
      agent_id: AGENT_ID,
      incarnation_id: randomUUID(),
      entry_id: randomUUID(),
      chunk_index: index,
      chunk_total: total,
      payload: index === 0 ? '{"type":"message","content":' : "}{ broken",
    }));
  }
  assert.equal(reassembleCanonicalAgentActivityChunks(chunks), undefined);
});
