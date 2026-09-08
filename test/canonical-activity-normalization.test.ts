import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnToolActivityNormalizer,
  normalizeOwnToolActivityEvent,
  normalizeRpcBridgeEvent,
  parseAgentActivityEvent,
  type SafeToolOrigin,
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

test("活动事件闭集对 message 正文不再按字节拒绝，旧工具字段不属于闭集", () => {
  const large = "x".repeat(64 * 1024);
  const message = parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: large }],
  });
  assert.equal(message.kind, "event");

  // 旧契约的原始参数字段不再是合法活动事件。
  const legacyArgs = parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    args: JSON.stringify({ path: "a".repeat(64 * 1024) }),
  });
  assert.equal(legacyArgs.kind, "invalid");
});

test("产生端规范化把非专用工具事实缩减为无载荷状态事实，来源身份随输入传递", () => {
  // 专用摘要只属于 Pi 原生 read/grep/find/ls；本插件工具仍是无载荷状态事实。
  assert.deepEqual(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "spawn_agent",
    args: { template_id: "worker", name: "w" },
  }, "plugin"), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "spawn_agent",
      origin: "plugin",
    },
  });
  assert.deepEqual(normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "spawn_agent",
    result: { content: [{ type: "text", text: "agent_id 不得跨进程" }] },
    isError: false,
  }, "plugin"), {
    kind: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "spawn_agent",
      origin: "plugin",
      isError: false,
    },
  });
});

test("产生端规范化宽容未来新增字段并忽略未知载荷", () => {
  assert.deepEqual(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    pattern: "x",
    futureField: { nested: [1, 2, 3] },
    args: "遗留字段",
  }, "plugin"), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "grep",
      origin: "plugin",
    },
  });
});

test("产生端规范化拒绝来源闭集之外的身份与结构违约，但不涉及载荷内容", () => {
  // 来源身份是闭集；无效来源不降级为 unknown，而是拒绝事件。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
  }, "extension" as never).kind, "invalid");
  // 关联身份缺失无法建立条目。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolName: "read",
  }, "unknown").kind, "invalid");
  // 来源不明的合法事实仍按安全兜底产生。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    isError: false,
  }, "unknown").kind, "event");
  // 结束事实自包含状态：缺少 isError 拒绝。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
  }, "plugin").kind, "invalid");
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "read",
  }, "plugin").kind, "invalid");
});

/** Pi 原生 read 事件的原始形状（参数在 start，正文/详情在 end 的 result）。 */
function readStart(args: unknown): unknown {
  return {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args,
  };
}

function readEnd(result: unknown, isError = false): unknown {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result,
    isError,
  };
}

function summaryOf(event: { readonly summary?: unknown }): unknown {
  return event.summary;
}

test("read 开始事实保留 path/offset/limit 白名单参数并忽略未来新增字段", () => {
  const normalized = normalizeOwnToolActivityEvent(readStart({
    path: "src/index.ts",
    offset: 5,
    limit: 20,
    encoding: "future-new-field",
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "read",
    path: "src/index.ts",
    offset: 5,
    limit: 20,
  });
  // 白名单之外的未来字段永不跨进程。
  assert.equal(JSON.stringify(normalized.event).includes("future-new-field"), false);
});

test("read 成功结果只保留截断事实，文件正文与图片数据不跨进程", () => {
  const startArgs = { path: "big.log", offset: 1, limit: 2000 };
  const truncated = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "文件正文不得跨进程".repeat(1000) }],
    details: {
      truncation: {
        truncated: true,
        truncatedBy: "lines",
        totalLines: 4000,
        outputLines: 2000,
        content: "文件正文也不得进入 details",
      },
    },
  }), "pi_native", startArgs);
  assert.equal(truncated.kind, "event");
  if (truncated.kind !== "event" || truncated.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(truncated.event), {
    tool: "read",
    path: "big.log",
    offset: 1,
    limit: 2000,
    truncated: true,
    truncatedBy: "lines",
  });
  const serialized = JSON.stringify(truncated.event);
  assert.equal(serialized.includes("文件正文不得跨进程"), false);
  assert.equal(serialized.includes("details"), false);

  // 完整读取（无截断）：不附带成功事实。
  const complete = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文" }],
    details: undefined,
  }), "pi_native", startArgs);
  assert.equal(complete.kind, "event");
  if (complete.kind !== "event" || complete.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(complete.event), {
    tool: "read",
    path: "big.log",
    offset: 1,
    limit: 2000,
  });

  // 图片结果：二进制数据不进入事件，也不产生成功侧事实。
  const image = normalizeOwnToolActivityEvent(readEnd({
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  }), "pi_native", startArgs);
  assert.equal(image.kind, "event");
  if (image.kind !== "event" || image.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(image.event), {
    tool: "read",
    path: "big.log",
    offset: 1,
    limit: 2000,
  });
  const imageSerialized = JSON.stringify(image.event);
  assert.equal(imageSerialized.includes("aGVsbG8="), false);
  assert.equal(imageSerialized.includes("image"), false);
});

test("read 失败事实保留全部输入参数与净化后的完整错误正文，不附带成功侧统计", () => {
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "Offset 9000 is beyond end of file (12 lines total)" }],
    details: {},
  }, true), "pi_native", { path: "src/index.ts", offset: 9000 });
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "read",
    path: "src/index.ts",
    offset: 9000,
  });
  assert.equal(normalized.event.errorText, "Offset 9000 is beyond end of file (12 lines total)");
  // 失败事实不附带截断等成功侧统计。
  assert.equal(JSON.stringify(normalized.event).includes("truncated"), false);
});

test("grep 保留全部非默认搜索条件，未提供 path 时默认为 .", () => {
  const start = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    args: { pattern: "TODO|FIXME", glob: "*.ts", ignoreCase: true, context: 2, limit: 50 },
  }, "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), {
    tool: "grep",
    pattern: "TODO|FIXME",
    path: ".",
    glob: "*.ts",
    ignoreCase: true,
    context: 2,
    limit: 50,
  });

  // 默认值（ignoreCase:false、literal:false、context:0、limit:100）不携带。
  const defaults = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    args: { pattern: "x", ignoreCase: false, literal: false, context: 0, limit: 100 },
  }, "pi_native");
  assert.equal(defaults.kind, "event");
  if (defaults.kind !== "event" || defaults.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(defaults.event), { tool: "grep", pattern: "x", path: "." });
});

test("grep 成功事实只保留无匹配/达到限制/截断/长行截断，匹配正文不跨进程", () => {
  const startArgs = { pattern: "secret", path: "src" };
  const noMatches = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "grep",
    result: { content: [{ type: "text", text: "No matches found" }], details: undefined },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(noMatches.kind, "event");
  if (noMatches.kind !== "event" || noMatches.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(noMatches.event), {
    tool: "grep",
    pattern: "secret",
    path: "src",
    noMatches: true,
  });

  const limited = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "grep",
    result: {
      content: [{ type: "text", text: "src/a.ts:1: 匹配正文不得跨进程" }],
      details: { matchLimitReached: 100, linesTruncated: true, truncation: { truncated: true, truncatedBy: "bytes" } },
    },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(limited.kind, "event");
  if (limited.kind !== "event" || limited.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(limited.event), {
    tool: "grep",
    pattern: "secret",
    path: "src",
    matchLimitReached: 100,
    truncated: true,
    truncatedBy: "bytes",
    linesTruncated: true,
  });
  assert.equal(JSON.stringify(limited.event).includes("匹配正文"), false);
});

test("find 保留 pattern/path/非默认 limit，成功事实不含命中路径列表", () => {
  const start = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "find",
    args: { pattern: "**/*.spec.ts", limit: 500 },
  }, "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), {
    tool: "find",
    pattern: "**/*.spec.ts",
    path: ".",
    limit: 500,
  });

  const startArgs = { pattern: "*.ts", path: "src" };
  const noFiles = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "find",
    result: { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(noFiles.kind, "event");
  if (noFiles.kind !== "event" || noFiles.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(noFiles.event), {
    tool: "find",
    pattern: "*.ts",
    path: "src",
    noFiles: true,
  });

  const hit = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "find",
    result: {
      content: [{ type: "text", text: "a.ts\nb.ts\n命中路径列表不得跨进程" }],
      details: { resultLimitReached: 1000, truncation: { truncated: true, truncatedBy: "bytes" } },
    },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(hit.kind, "event");
  if (hit.kind !== "event" || hit.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(hit.event), {
    tool: "find",
    pattern: "*.ts",
    path: "src",
    resultLimitReached: 1000,
    truncated: true,
    truncatedBy: "bytes",
  });
  assert.equal(JSON.stringify(hit.event).includes("b.ts"), false);
});

test("ls 保留 path/非默认 limit，成功事实不含目录条目", () => {
  const start = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "ls",
    args: { path: "src", limit: 100 },
  }, "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), { tool: "ls", path: "src", limit: 100 });

  const startArgs = { path: "empty-dir" };
  const empty = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "ls",
    result: { content: [{ type: "text", text: "(empty directory)" }], details: undefined },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(empty.kind, "event");
  if (empty.kind !== "event" || empty.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(empty.event), {
    tool: "ls",
    path: "empty-dir",
    emptyDirectory: true,
  });

  const listed = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "ls",
    result: {
      content: [{ type: "text", text: "a/\nb.ts\n目录条目不得跨进程" }],
      details: { entryLimitReached: 500, truncation: { truncated: true, truncatedBy: "bytes" } },
    },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(listed.kind, "event");
  if (listed.kind !== "event" || listed.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(listed.event), {
    tool: "ls",
    path: "empty-dir",
    entryLimitReached: 500,
    truncated: true,
    truncatedBy: "bytes",
  });
  assert.equal(JSON.stringify(listed.event).includes("b.ts"), false);
});

test("grep/find/ls 失败时保留全部输入参数与错误正文，不附带成功侧统计", () => {
  const cases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
    readonly expectedSummary: unknown;
  }[] = [
    {
      toolName: "grep",
      startArgs: { pattern: "x", path: "src", ignoreCase: true },
      expectedSummary: { tool: "grep", pattern: "x", path: "src", ignoreCase: true },
    },
    {
      toolName: "find",
      startArgs: { pattern: "*.ts", path: "src", limit: 10 },
      expectedSummary: { tool: "find", pattern: "*.ts", path: "src", limit: 10 },
    },
    {
      toolName: "ls",
      startArgs: { path: "missing" },
      expectedSummary: { tool: "ls", path: "missing" },
    },
  ];
  for (const item of cases) {
    const normalized = normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: item.toolName,
      result: { content: [{ type: "text", text: "Path not found: missing" }] },
      isError: true,
    }, "pi_native", item.startArgs);
    assert.equal(normalized.kind, "event", item.toolName);
    if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") continue;
    assert.deepEqual(summaryOf(normalized.event), item.expectedSummary, item.toolName);
    assert.equal(normalized.event.errorText, "Path not found: missing", item.toolName);
    assert.equal(
      JSON.stringify(normalized.event).match(/noMatches|noFiles|emptyDirectory|truncated|LimitReached/g)?.length ?? 0,
      0,
      item.toolName,
    );
  }
});

test("read 用户 limit 提前停止但文件尚有更多行时保留不完整事实", () => {
  // Pi 在该场景不写 details，不完整事实只出现在结果正文的已知 continuation 文案中。
  const startArgs = { path: "big.log", limit: 100 };
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文\n\n[100 more lines in file. Use offset=101 to continue.]" }],
    details: undefined,
  }), "pi_native", startArgs);
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "read",
    path: "big.log",
    limit: 100,
    hasMoreLines: true,
  });
  // 正文与 continuation 文案本身都不跨进程。
  const serialized = JSON.stringify(normalized.event);
  assert.equal(serialized.includes("正文"), false);
  assert.equal(serialized.includes("more lines in file"), false);

  // 完整读取与被截断读取不携带该事实。
  const complete = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文" }],
  }), "pi_native", startArgs);
  assert.equal(complete.kind, "event");
  if (complete.kind !== "event" || complete.event.type !== "tool_execution_end") return;
  assert.equal((summaryOf(complete.event) as { hasMoreLines?: boolean }).hasMoreLines, undefined);
});

test("错误正文在产生端过滤 ANSI 与危险终端控制字符并保留换行", () => {
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "first\x1b[31m-red\x1b[0m\nsecond\u0007 bell\r\nthird\u202e override" }],
  }, true), "pi_native", { path: "a.txt" });
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.equal(normalized.event.errorText, "first-red\nsecond  bell\nthird  override");
});

test("缺少必需字段或类型错误的专用调用完整降级为安全兜底", () => {
  const cases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
  }[] = [
    { toolName: "read", startArgs: { offset: 1 } },
    { toolName: "read", startArgs: { path: 42 } },
    { toolName: "grep", startArgs: { path: "src" } },
    { toolName: "grep", startArgs: { pattern: null } },
    { toolName: "find", startArgs: {} },
    { toolName: "ls", startArgs: { path: { nested: true } } },
  ];
  for (const item of cases) {
    const start = normalizeOwnToolActivityEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: item.toolName,
      args: item.startArgs,
    }, "pi_native");
    assert.equal(start.kind, "event", item.toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, item.toolName);

    const end = normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: item.toolName,
      result: { content: [{ type: "text", text: "anything" }] },
      isError: false,
    }, "pi_native", item.startArgs);
    assert.equal(end.kind, "event", item.toolName);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, item.toolName);
  }

  // args 整体缺失（非 record）同样降级。
  const missing = normalizeOwnToolActivityEvent(readStart(undefined), "pi_native");
  assert.equal(missing.kind, "event");
  if (missing.kind !== "event" || missing.event.type !== "tool_execution_start") return;
  assert.equal(missing.event.summary, undefined);
});

test("任何已知字段存在但类型错误时完整降级为安全兜底", () => {
  const start = normalizeOwnToolActivityEvent(readStart({ path: "a.txt", offset: "5", limit: true }), "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.equal(start.event.summary, undefined);
});

test("同名覆盖降级：非 pi_native 来源的四种工具不产生专用摘要", () => {
  const start = normalizeOwnToolActivityEvent(readStart({ path: "a.txt" }), "unknown");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.equal(start.event.summary, undefined);

  const end = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "覆盖实现的错误正文不得跨进程" }],
  }, true), "unknown");
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.equal(end.event.summary, undefined);
  assert.equal(end.event.errorText, undefined);
});

test("结束事实缺少缓存的开始参数时降级为无摘要兜底", () => {
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文" }],
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.equal(normalized.event.summary, undefined);
  assert.equal(normalized.event.errorText, undefined);
});

test("运行时规范化器缓存开始参数供结束事实自包含，并保持有界与幂等", () => {
  const resolveOrigin = (toolName: string): SafeToolOrigin =>
    ["read", "grep", "find", "ls"].includes(toolName) ? "pi_native" : "unknown";
  const normalize = createOwnToolActivityNormalizer(resolveOrigin);

  const start = normalize({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: { path: "a.txt", offset: 2 },
  });
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), { tool: "read", path: "a.txt", offset: 2 });

  // 同 ID 结束事实自包含开始参数；缓存随即清空。
  const end = normalize({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), { tool: "read", path: "a.txt", offset: 2 });

  // 缓存已清空：同 ID 二次结束降级为无摘要兜底。
  const repeated = normalize({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(repeated.kind, "event");
  if (repeated.kind !== "event" || repeated.event.type !== "tool_execution_end") return;
  assert.equal(repeated.event.summary, undefined);

  // 重复开始覆盖旧参数：新参数进入后续结束事实。
  normalize({
    type: "tool_execution_start",
    toolCallId: "call_2",
    toolName: "ls",
    args: { path: "old-dir" },
  });
  normalize({
    type: "tool_execution_start",
    toolCallId: "call_2",
    toolName: "ls",
    args: { path: "new-dir" },
  });
  const overwritten = normalize({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "ls",
    result: { content: [{ type: "text", text: "(empty directory)" }] },
    isError: false,
  });
  assert.equal(overwritten.kind, "event");
  if (overwritten.kind !== "event" || overwritten.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(overwritten.event), {
    tool: "ls",
    path: "new-dir",
    emptyDirectory: true,
  });

  // 容量上限：256 个待决条目，溢出时插入第 257 个淘汰最早；被淘汰的
  // 开始参数降级。
  for (let index = 0; index < 256; index += 1) {
    normalize({
      type: "tool_execution_start",
      toolCallId: `bulk_${index}`,
      toolName: "read",
      args: { path: `bulk_${index}.txt` },
    });
  }
  // 溢出时插入的新开始淘汰最早的 bulk_0。
  normalize({
    type: "tool_execution_start",
    toolCallId: "bulk_new",
    toolName: "read",
    args: { path: "new.txt" },
  });
  const evicted = normalize({
    type: "tool_execution_end",
    toolCallId: "bulk_0",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(evicted.kind, "event");
  if (evicted.kind !== "event" || evicted.event.type !== "tool_execution_end") return;
  assert.equal(evicted.event.summary, undefined);

  // 溢出时插入的新开始仍然可用。
  const kept = normalize({
    type: "tool_execution_end",
    toolCallId: "bulk_new",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(kept.kind, "event");
  if (kept.kind !== "event" || kept.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(kept.event), { tool: "read", path: "new.txt" });
});

test("活动事件闭集只允许专用工具携带摘要与错误正文，结构违约判 invalid", () => {
  // 专用摘要出现在未知来源事件上属于协议违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "unknown",
    summary: { tool: "read", path: "a.txt" },
  }).kind, "invalid");
  // summary.tool 与 toolName 不一致属于违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    origin: "pi_native",
    summary: { tool: "read", path: "a.txt" },
  }).kind, "invalid");
  // 摘要结构违约（缺必需字段）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    summary: { tool: "read" },
  }).kind, "invalid");
  // errorText 只允许出现在失败事实中。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    isError: false,
    errorText: "不得在成功事实出现",
  }).kind, "invalid");
  // errorText 只允许 Pi 原生专用工具携带。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "spawn_agent",
    origin: "plugin",
    isError: true,
    errorText: "插件工具错误正文不进闭集",
  }).kind, "invalid");
  // 合法组合仍为 event。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "ls",
    origin: "pi_native",
    isError: true,
    summary: { tool: "ls", path: "." },
    errorText: "Path not found",
  }).kind, "event");
});

/** Pi 原生 write/edit/bash 事件的原始形状（参数在 start，结果在 end）。 */
function mutationStart(toolName: string, args: unknown): unknown {
  return {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName,
    args,
  };
}

function mutationEnd(toolName: string, result: unknown, isError = false): unknown {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName,
    result,
    isError,
  };
}

test("write 开始事实只保留 path，写入正文与未来字段永不跨进程", () => {
  const normalized = normalizeOwnToolActivityEvent(mutationStart("write", {
    path: "out/result.md",
    content: "机密正文不得跨进程",
    futureField: { nested: [1, 2, 3] },
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(normalized.event), { tool: "write", path: "out/result.md" });
  const serialized = JSON.stringify(normalized.event);
  assert.equal(serialized.includes("机密正文"), false);
  assert.equal(serialized.includes("futureField"), false);
});

test("write 成功与失败摘要都只显示 path，写入统计不进入闭集", () => {
  const startArgs = { path: "out/result.md", content: "line1\nline2\nline3" };
  // 成功：行数、UTF-8 字节大小等任何写入统计都不携带；成功结果正文不跨进程。
  const success = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "Successfully wrote to out/result.md" }],
    details: undefined,
  }), "pi_native", startArgs);
  assert.equal(success.kind, "event");
  if (success.kind !== "event" || success.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(success.event), { tool: "write", path: "out/result.md" });
  const serialized = JSON.stringify(success.event);
  assert.equal(serialized.includes("Successfully wrote"), false);
  assert.equal(serialized.includes("line1"), false);
  assert.equal(serialized.includes("lines"), false);
  assert.equal(serialized.includes("bytes"), false);

  // 失败：同样只显示 path，不显示未发生写入的统计；错误正文可携带。
  const failure = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "Error: EACCES: permission denied, open '/etc/hosts'" }],
  }, true), "pi_native", { path: "/etc/hosts", content: "irrelevant" });
  assert.equal(failure.kind, "event");
  if (failure.kind !== "event" || failure.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failure.event), { tool: "write", path: "/etc/hosts" });
  assert.equal(
    failure.event.errorText,
    "Error: EACCES: permission denied, open '/etc/hosts'",
  );
  assert.equal(JSON.stringify(failure.event).includes("lines"), false);
});

test("edit 成功与失败摘要都只显示 path，替换正文与 diff/patch 不跨进程", () => {
  const startArgs = {
    path: "src/a.ts",
    edits: [
      { oldText: "机密旧文本不得跨进程", newText: "新文本也不得跨进程" },
      { oldText: "second", newText: "second-new" },
    ],
  };
  // 成功：edits 数量、diff、patch、首个修改行都不携带；成功结果正文不跨进程。
  const success = normalizeOwnToolActivityEvent(mutationEnd("edit", {
    content: [{ type: "text", text: "Successfully replaced 2 block(s) in src/a.ts." }],
    details: {
      diff: "diff 正文不得跨进程",
      patch: "patch 不得跨进程",
      firstChangedLine: "首修改行不得跨进程",
    },
  }), "pi_native", startArgs);
  assert.equal(success.kind, "event");
  if (success.kind !== "event" || success.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(success.event), { tool: "edit", path: "src/a.ts" });
  const serialized = JSON.stringify(success.event);
  assert.equal(serialized.includes("机密旧文本"), false);
  assert.equal(serialized.includes("新文本也不得"), false);
  assert.equal(serialized.includes("diff"), false);
  assert.equal(serialized.includes("patch"), false);
  assert.equal(serialized.includes("firstChangedLine"), false);
  assert.equal(serialized.includes("edits"), false);

  // 失败：只显示 path，不显示编辑块数；错误正文可携带。
  const failure = normalizeOwnToolActivityEvent(mutationEnd("edit", {
    content: [{ type: "text", text: "Could not find unique text to replace in src/a.ts." }],
  }, true), "pi_native", startArgs);
  assert.equal(failure.kind, "event");
  if (failure.kind !== "event" || failure.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failure.event), { tool: "edit", path: "src/a.ts" });
  assert.equal(
    failure.event.errorText,
    "Could not find unique text to replace in src/a.ts.",
  );
  assert.equal(JSON.stringify(failure.event).includes("edits"), false);
});

test("bash 与 powershell 摘要保留完整 command 与非默认 timeout，输出与错误正文不进闭集", () => {
  for (const toolName of ["bash", "powershell"] as const) {
    const start = normalizeOwnToolActivityEvent(mutationStart(toolName, {
      command: "echo hello",
      timeout: 5,
    }), "pi_native");
    assert.equal(start.kind, "event", toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.deepEqual(
      summaryOf(start.event),
      { tool: toolName, command: "echo hello", timeout: 5 },
      toolName,
    );

    // 成功：stdout、truncation 详情与临时输出路径全部不跨进程；无 errorText。
    const success = normalizeOwnToolActivityEvent(mutationEnd(toolName, {
      content: [{ type: "text", text: "hello\n命令输出不得跨进程" }],
      details: {
        truncation: { truncated: true, truncatedBy: "lines" },
        fullOutputPath: "/tmp/pi-bash-temp",
      },
    }), "pi_native", { command: "echo hello", timeout: 5 });
    assert.equal(success.kind, "event", toolName);
    if (success.kind !== "event" || success.event.type !== "tool_execution_end") continue;
    assert.deepEqual(
      summaryOf(success.event),
      { tool: toolName, command: "echo hello", timeout: 5 },
      toolName,
    );
    assert.equal(success.event.errorText, undefined, toolName);
    const serialized = JSON.stringify(success.event);
    assert.equal(serialized.includes("命令输出"), false, toolName);
    assert.equal(serialized.includes("/tmp/pi-bash-temp"), false, toolName);

    // 失败（退出码、超时或取消）：摘要不变，异常正文不进入事件。
    const failure = normalizeOwnToolActivityEvent(mutationEnd(toolName, {
      content: [{ type: "text", text: "hello\n\nCommand exited with code 1" }],
    }, true), "pi_native", { command: "echo hello", timeout: 5 });
    assert.equal(failure.kind, "event", toolName);
    if (failure.kind !== "event" || failure.event.type !== "tool_execution_end") continue;
    assert.deepEqual(
      summaryOf(failure.event),
      { tool: toolName, command: "echo hello", timeout: 5 },
      toolName,
    );
    assert.equal(failure.event.errorText, undefined, toolName);
    assert.equal(JSON.stringify(failure.event).includes("exited with code"), false, toolName);
  }

  // 未提供 timeout 时不携带该字段。
  const noTimeout = normalizeOwnToolActivityEvent(mutationStart("bash", { command: "ls" }), "pi_native");
  assert.equal(noTimeout.kind, "event");
  if (noTimeout.kind !== "event" || noTimeout.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(noTimeout.event), { tool: "bash", command: "ls" });
});

test("bash timeout 值域偏离只导致字段不携带，不降级为兜底", () => {
  const start = normalizeOwnToolActivityEvent(
    mutationStart("bash", { command: "ls", timeout: -5 }),
    "pi_native",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), { tool: "bash", command: "ls" });
});

test("命令正文的控制字符在产生端净化且保留多行结构", () => {
  const normalized = normalizeOwnToolActivityEvent(mutationStart("bash", {
    command: "echo \u001b[31m-red\u001b[0m\nsecond\u0007 bell\r\nthird\u202e override",
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "bash",
    command: "echo -red\nsecond  bell\nthird  override",
  });
});

test("write/edit/bash/powershell 必需字段缺失或类型错误时完整降级为安全兜底", () => {
  const cases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
  }[] = [
    { toolName: "write", startArgs: { content: "x" } },
    { toolName: "write", startArgs: { path: "a.txt" } },
    { toolName: "write", startArgs: { path: 42, content: "x" } },
    { toolName: "write", startArgs: { path: "a.txt", content: 42 } },
    { toolName: "edit", startArgs: { path: "a.ts" } },
    { toolName: "edit", startArgs: { path: "a.ts", edits: "not-array" } },
    { toolName: "edit", startArgs: { path: "a.ts", edits: [{ oldText: "x" }] } },
    { toolName: "edit", startArgs: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }, "junk"] } },
    { toolName: "bash", startArgs: { timeout: 5 } },
    { toolName: "bash", startArgs: { command: 42 } },
    { toolName: "bash", startArgs: { command: "ls", timeout: "5" } },
    { toolName: "powershell", startArgs: {} },
  ];
  for (const item of cases) {
    const start = normalizeOwnToolActivityEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: item.toolName,
      args: item.startArgs,
    }, "pi_native");
    assert.equal(start.kind, "event", item.toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, item.toolName);

    const end = normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: item.toolName,
      result: { content: [{ type: "text", text: "anything" }] },
      isError: false,
    }, "pi_native", item.startArgs);
    assert.equal(end.kind, "event", item.toolName);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, item.toolName);
    assert.equal(end.event.errorText, undefined, item.toolName);
  }
});

test("同名覆盖的 write/edit/bash 不产生专用摘要，错误正文随降级丢弃", () => {
  const writeEnd = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "覆盖实现错误正文不得跨进程" }],
  }, true), "unknown", { path: "a.txt", content: "x" });
  assert.equal(writeEnd.kind, "event");
  if (writeEnd.kind !== "event" || writeEnd.event.type !== "tool_execution_end") return;
  assert.equal(writeEnd.event.summary, undefined);
  assert.equal(writeEnd.event.errorText, undefined);

  const bashEnd = normalizeOwnToolActivityEvent(mutationEnd("bash", {
    content: [{ type: "text", text: "覆盖实现输出不得跨进程" }],
  }, true), "unknown", { command: "ls" });
  assert.equal(bashEnd.kind, "event");
  if (bashEnd.kind !== "event" || bashEnd.event.type !== "tool_execution_end") return;
  assert.equal(bashEnd.event.summary, undefined);
  assert.equal(bashEnd.event.errorText, undefined);
});

test("write/bash 结束事实缺少缓存的开始参数时降级为无摘要兜底", () => {
  const writeEnd = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "ok" }],
  }), "pi_native");
  assert.equal(writeEnd.kind, "event");
  if (writeEnd.kind !== "event" || writeEnd.event.type !== "tool_execution_end") return;
  assert.equal(writeEnd.event.summary, undefined);

  const bashEnd = normalizeOwnToolActivityEvent(mutationEnd("bash", {
    content: [{ type: "text", text: "out" }],
  }), "pi_native");
  assert.equal(bashEnd.kind, "event");
  if (bashEnd.kind !== "event" || bashEnd.event.type !== "tool_execution_end") return;
  assert.equal(bashEnd.event.summary, undefined);
});

test("活动事件闭集对 Shell 工具拒绝错误正文，write/edit 可携带且键集合严格闭合", () => {
  // Shell 工具失败不携带错误正文：携带即协议违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    origin: "pi_native",
    isError: true,
    summary: { tool: "bash", command: "ls" },
    errorText: "Shell 异常正文不得进入闭集",
  }).kind, "invalid");
  // write/edit 失败携带 errorText 合法。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "write",
    origin: "pi_native",
    isError: true,
    summary: { tool: "write", path: "a.txt" },
    errorText: "permission denied",
  }).kind, "event");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "edit",
    origin: "pi_native",
    isError: true,
    summary: { tool: "edit", path: "a.ts" },
    errorText: "not found",
  }).kind, "event");
  // Shell 摘要缺 command 判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    origin: "pi_native",
    summary: { tool: "bash", timeout: 5 },
  }).kind, "invalid");
  // Shell 摘要未知键（stdout）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    origin: "pi_native",
    summary: { tool: "bash", command: "ls", stdout: "x" },
  }).kind, "invalid");
  // write 摘要未知键（lines 统计）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "write",
    origin: "pi_native",
    isError: false,
    summary: { tool: "write", path: "a.txt", lines: 3 },
  }).kind, "invalid");
  // edit 摘要未知键（edits 统计）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "edit",
    origin: "pi_native",
    isError: false,
    summary: { tool: "edit", path: "a.ts", edits: 2 },
  }).kind, "invalid");
  // plugin 来源的 write 摘要判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "write",
    origin: "plugin",
    summary: { tool: "write", path: "a.txt" },
  }).kind, "invalid");
});
