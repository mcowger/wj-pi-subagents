import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRpcBridgeEvent,
  parseAgentActivityEvent,
} from "../src/rpc-bridge-event.ts";

function assistantMessage(content: readonly unknown[]): unknown {
  return {
    type: "message_end",
    message: Object.freeze({ role: "assistant", content: Object.freeze(content) }),
  };
}

test("产生端逐块忽略图片、原生工具调用与未知 block", () => {
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "text", text: "结论在前" },
    { type: "image", source: "不得跨进程" },
    { type: "toolCall", id: "call_1", arguments: { secret: "不得跨进程" } },
    { type: "future_unknown_block", payload: "不得跨进程" },
    { type: "text", text: "结论在后" },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.deepEqual(normalized.event.content, [
    { type: "text", text: "结论在前" },
    { type: "text", text: "结论在后" },
  ]);
});

test("声明为 text/thinking 但结构无效的块被逐块忽略，不吞掉整条消息", () => {
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "text", text: 42 },
    { type: "thinking", thinking: { broken: true } },
    { type: "text" },
    { type: "thinking", thinking: "合法思考" },
    { type: "text", text: "合法正文" },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.deepEqual(normalized.event.content, [
    { type: "thinking", thinking: "合法思考" },
    { type: "text", text: "合法正文" },
  ]);
});

test("相邻 thinking 合并为同一块，被 text 隔开的 thinking 保持分离", () => {
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "thinking", thinking: "第一段思考" },
    { type: "thinking", thinking: "第二段思考" },
    { type: "text", text: "中间结论" },
    { type: "thinking", thinking: "第三段思考" },
    { type: "thinking", thinking: "第四段思考" },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.equal(normalized.event.content.length, 3);
  assert.deepEqual(normalized.event.content[0], {
    type: "thinking",
    thinking: "第一段思考\n\n第二段思考",
  });
  assert.deepEqual(normalized.event.content[1], { type: "text", text: "中间结论" });
  assert.deepEqual(normalized.event.content[2], {
    type: "thinking",
    thinking: "第三段思考\n\n第四段思考",
  });
});

test("过滤后无合法块的消息不产生活动事件，也不中断会话", () => {
  assert.equal(normalizeRpcBridgeEvent(assistantMessage([
    { type: "image", source: "x" },
    { type: "toolCall", id: "call_1" },
    { type: "text", text: "" },
  ])).kind, "ignored");
});

test("assistant 消息正文聚合不设置字节上限", () => {
  const large = "报告正文。".repeat(40_000);
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "text", text: large },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.equal(normalized.event.content.length, 1);
  assert.equal(normalized.event.content[0]?.type, "text");
  assert.equal(normalized.event.content[0]?.text, large);
});

test("活动事件闭集对 message 正文不再按字节拒绝，工具正文预算保持不变", () => {
  const large = "x".repeat(64 * 1024);
  const message = parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: large }],
  });
  assert.equal(message.kind, "event");

  const oversizedArgs = parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: JSON.stringify({ path: "a".repeat(64 * 1024) }),
  });
  assert.equal(oversizedArgs.kind, "rejected");
});
