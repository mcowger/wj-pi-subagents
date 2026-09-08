import assert from "node:assert/strict";
import test from "node:test";
import { REPLY_MAX_TEXT_BYTES } from "../src/child-reply-limits.ts";
import {
  ACTIVITY_MAX_TEXT_BYTES,
  normalizeAssistantMessageEnd,
  normalizeAssistantMessageUpdate,
  normalizeRpcBridgeEvent,
  parseAgentActivityDisplayEvent,
  parseAgentActivityEvent,
} from "../src/rpc-bridge-event.ts";

test("真正 child 回复端点只公开文本，明确丢弃 thinking、toolCall 和图片内容", () => {
  const result = normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "不得透传",
      content: [
        { type: "thinking", thinking: "不得透传的思考" },
        { type: "text", text: "完成", signature: "不得透传" },
        { type: "toolCall", id: "call-secret", name: "apply_patch", arguments: { secret: true } },
        { type: "image", data: "YWJj", mimeType: "image/png", source: "不得透传" },
      ],
    },
  });

  assert.deepEqual(result, {
    kind: "event",
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "完成" },
        ],
      },
    },
  });
});

test("任务桥接公开无载荷 agent_start 事实并剥离其余字段", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "agent_start",
    prompt: "不得透传",
    session: { secret: true },
  }), {
    kind: "event",
    event: { type: "agent_start" },
  });
});

test("桥接严格规范化 Pi 的完整压缩原因闭集，非法原因拒绝", () => {
  for (const reason of ["manual", "threshold", "overflow"] as const) {
    assert.deepEqual(normalizeRpcBridgeEvent({
      type: "compaction_start",
      reason,
      privateState: "不得透传",
    }), {
      kind: "event",
      event: { type: "compaction_start", reason },
    });
  }
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_start",
    reason: "third_party",
  }), { kind: "invalid" });
});

test("compaction_end 分离取消与真实错误，且不公开 provider 错误正文", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    result: { summary: "不得透传" },
  }), {
    kind: "event",
    event: {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      failed: false,
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: false,
    errorMessage: "TOP_SECRET_PROVIDER_ERROR",
  }), {
    kind: "event",
    event: {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      failed: true,
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: true,
    willRetry: false,
  }), {
    kind: "event",
    event: {
      type: "compaction_end",
      reason: "manual",
      aborted: true,
      willRetry: false,
      failed: false,
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: "false",
    willRetry: false,
  }), { kind: "invalid" });
});

test("显示层 message_update 只提取有序文本与 thinking delta，不进入完整活动事件闭集", () => {
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
  }, "message-1", 1), {
    kind: "event",
    event: {
      type: "message_delta",
      streamId: "message-1",
      sequence: 1,
      contentIndex: 0,
      contentType: "text",
      delta: "Hel",
    },
  });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
  }, "message-1", 2), { kind: "ignored" });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "plan" },
  }, "message-1", 2), {
    kind: "event",
    event: {
      type: "message_delta",
      streamId: "message-1",
      sequence: 2,
      contentIndex: 1,
      contentType: "thinking",
      delta: "plan",
    },
  });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{}" },
  }, "message-1", 3), { kind: "ignored" });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: -1, delta: "bad" },
  }, "message-1", 4), { kind: "invalid" });
  assert.deepEqual(parseAgentActivityDisplayEvent({
    type: "message_complete",
    streamId: "message-1",
    sequence: 3,
  }), {
    kind: "event",
    event: { type: "message_complete", streamId: "message-1", sequence: 3 },
  });
  assert.deepEqual(parseAgentActivityDisplayEvent({
    type: "message_delta",
    streamId: "",
    sequence: 1,
    contentIndex: 0,
    contentType: "text",
    delta: "bad",
  }), { kind: "invalid" });
});

test("任务桥接忽略非 assistant 的 message_end；活动路径逐块忽略未知内容块，回复路径仍拒绝", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({ type: "message_update", delta: "忽略" }), {
    kind: "ignored",
  });
  // 活动路径：未知块逐块忽略，无剩余合法块时整体忽略，不中断会话。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "future_secret_block", secret: "不得静默丢弃" }],
    },
  }), {
    kind: "ignored",
  });
  // 最终回复路径（reply 通道）仍拒绝未知内容块。
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "future_secret_block", secret: "不得静默丢弃" }],
    },
  }), {
    kind: "invalid",
  });
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: 42 }] },
  }), {
    kind: "invalid",
  });
});

test("真正 child 最终文本按拼接后的 32 KiB UTF-8 总长度区分回复超限", () => {
  const exactFirst = "x".repeat(REPLY_MAX_TEXT_BYTES - 4);
  const exact = normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: exactFirst }, { type: "text", text: "完" }],
    },
  });
  assert.equal(exact.kind, "event");

  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: exactFirst }, { type: "text", text: "abcd" }],
    },
  }), {
    kind: "rejected",
    reason: "reply_too_large",
  });

  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "测".repeat(10_923) }],
    },
  }), {
    kind: "rejected",
    reason: "reply_too_large",
  });

  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "x".repeat(REPLY_MAX_TEXT_BYTES + 1) },
        { type: "future_secret_block", secret: "仍须按非法事件拒绝" },
      ],
    },
  }), {
    kind: "invalid",
  });
});

test("真正 child 端忽略非 assistant 的 message_end，不把它当成直接回复或协议故障", () => {
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text: "工具结果" }] },
  }), {
    kind: "ignored",
  });
});

test("桥接闭集加宽：assistant 正文规范化为携带 text 与 thinking 块的消息活动事件", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "不得透传",
      content: [
        { type: "thinking", thinking: "内部推理", signature: "不得透传" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        { type: "text", text: "开始处理" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
      ],
    },
  }), {
    kind: "event",
    event: {
      type: "message",
      content: [
        { type: "thinking", thinking: "内部推理" },
        { type: "text", text: "开始处理" },
      ],
    },
  });
});

test("消息活动正文聚合不设字节上限，工具正文预算保持不变", () => {
  // assistant 正文任意长，全部合法（传输分块由监督通道承担）。
  const large = normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(ACTIVITY_MAX_TEXT_BYTES + 1024) }],
    },
  });
  assert.equal(large.kind, "event");

  // 工具参数/结果仍按单帧预算拒绝。
  assert.equal(normalizeRpcBridgeEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: { path: "a".repeat(ACTIVITY_MAX_TEXT_BYTES) },
  }).kind, "rejected");
});

test("消息活动事件仍拒绝结构违约与非字符串正文", () => {
  // 声明为 text 但结构无效的块逐块忽略，不吞掉整条消息。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: 42 }] },
  }), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: { role: "assistant", content: "不是数组" },
  }), { kind: "invalid" });
  // 空 content 数组结构合法但无正文：按 ignored 处理，不中断会话。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: { role: "assistant", content: [] },
  }), { kind: "ignored" });
});

test("空正文块被跳过，全空消息按 ignored 处理而不中断桥接", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", thinking: "" },
        { type: "text", text: "有效正文" },
      ],
    },
  }), {
    kind: "event",
    event: {
      type: "message",
      content: [{ type: "text", text: "有效正文" }],
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }, { type: "thinking", thinking: "" }],
    },
  }), { kind: "ignored" });
});

test("活动事件闭集校验器拒绝空正文，与桥接端‘空块跳过’不冲突", () => {
  assert.equal(parseAgentActivityEvent({ type: "message", content: [] }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: "" }],
  }).kind, "invalid");
  // 空字符串 args/result 不属于违约：空参数与空结果无害。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: "",
  }).kind, "event");
});

test("桥接闭集加宽：工具执行事件携带参数与结果 JSON 摘要", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: { path: "a.ts", limit: 10 },
  }), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: '{"path":"a.ts","limit":10}',
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { lines: ["a", "b"], truncated: false },
    isError: false,
  }), {
    kind: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: '{"lines":["a","b"],"truncated":false}',
      isError: false,
    },
  });
  // 缺省字段保持缺省，旧事件形状不变。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "edit",
  }), {
    kind: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "edit",
    },
  });
});

test("工具参数或结果超过活动预算拒绝该事件，不可序列化参数按结构违约拒绝", () => {
  const oversized = { text: "x".repeat(ACTIVITY_MAX_TEXT_BYTES) };
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "write",
    args: oversized,
  }), { kind: "rejected", reason: "reply_too_large" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { output: "y".repeat(ACTIVITY_MAX_TEXT_BYTES) },
    isError: true,
  }), { kind: "rejected", reason: "reply_too_large" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "write",
    args: BigInt(1),
  }), { kind: "invalid" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    isError: "false",
  }), { kind: "invalid" });
});

test("活动事件闭集校验器接受合法事件并拒绝违约、未知与超限", () => {
  assert.deepEqual(parseAgentActivityEvent({
    type: "message",
    content: [
      { type: "thinking", thinking: "推理" },
      { type: "text", text: "回复" },
    ],
  }), {
    kind: "event",
    event: {
      type: "message",
      content: [
        { type: "thinking", thinking: "推理" },
        { type: "text", text: "回复" },
      ],
    },
  });
  assert.deepEqual(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: '{"path":"a.ts"}',
  }), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: '{"path":"a.ts"}',
    },
  });
  assert.equal(parseAgentActivityEvent({ type: "agent_start" }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: 1 }],
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "",
    toolName: "read",
  }).kind, "invalid");
  // assistant 消息正文聚合不设字节上限；超长正文仍走合法闭集。
  const oversized = parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: "z".repeat(ACTIVITY_MAX_TEXT_BYTES + 1) }],
  });
  assert.equal(oversized.kind, "event");
  assert.equal(
    parseAgentActivityEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: JSON.stringify({ path: "a".repeat(ACTIVITY_MAX_TEXT_BYTES) }),
    }).kind,
    "rejected",
  );
});
