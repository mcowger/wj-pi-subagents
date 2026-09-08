import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AgentActivityViewerModel,
  displayWidth,
  renderAgentActivityViewerSurface,
} from "../src/agent-activity-viewer.ts";
import type {
  SafeAgentActivityDisplayEvent,
  SafePiToolSummary,
  SafeToolOrigin,
} from "../src/rpc-bridge-event.ts";
import { normalizeRpcBridgeEvent } from "../src/rpc-bridge-event.ts";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";
import type { AgentLifecycleState } from "../src/agent-snapshot-codec.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440002";
const INCARNATION_ID = "7f9c24e8-5b3d-4f6a-8c1e-9d2b7a4f6e81";
const VIEWPORT = 3;

function viewerAgent(state: AgentLifecycleState = "working") {
  return {
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state,
  } as const;
}

function messageEntry(
  content: ReadonlyArray<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze(content.map((block) => Object.freeze(block))),
    }),
  });
}

function textMessage(text: string): CanonicalAgentActivityEntry {
  return messageEntry([{ type: "text", text }]);
}

function toolStart(
  toolCallId: string,
  toolName: string,
  origin: SafeToolOrigin = "unknown",
  incarnationId: string = INCARNATION_ID,
  summary?: SafePiToolSummary,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: incarnationId,
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      origin,
      ...(summary === undefined ? {} : { summary }),
    }),
  });
}

function toolEnd(
  toolCallId: string,
  toolName: string,
  isError: boolean,
  origin: SafeToolOrigin = "unknown",
  incarnationId: string = INCARNATION_ID,
  summary?: SafePiToolSummary,
  errorText?: string,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: incarnationId,
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      origin,
      isError,
      ...(summary === undefined ? {} : { summary }),
      ...(errorText === undefined ? {} : { errorText }),
    }),
  });
}

function displayDelta(
  streamId: string,
  sequence: number,
  contentIndex: number,
  contentType: "text" | "thinking",
  delta: string,
): SafeAgentActivityDisplayEvent {
  return Object.freeze({
    type: "message_delta",
    streamId,
    sequence,
    contentIndex,
    contentType,
    delta,
  });
}

function displayComplete(streamId: string, sequence: number): SafeAgentActivityDisplayEvent {
  return Object.freeze({ type: "message_complete", streamId, sequence });
}

/** 4 行正文消息 + 一条完成工具 = 6 行事件正文。 */
function replayFixture(): readonly CanonicalAgentActivityEntry[] {
  return Object.freeze([
    textMessage("line1\nline2\nline3\nline4"),
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
  ]);
}

test("打开即回放全部规范条目历史", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const lines = viewer.render(160);

  assert.match(lines[0] ?? "", /worker · worker-a · working/);
  assert.ok(lines.some((line) => line.includes("line1")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("line4")));
  assert.ok(lines.some((line) => line.includes("read_file")), lines.join("\n"));
  assert.equal(viewer.getPublicState().event_count, 3);
});

test("工具开始立即建立运行中条目，结束原地更新同一条目且不产生独立结果行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  let lines = viewer.render(160).slice(1, -1).join("\n");
  assert.match(lines, /▶ read_file/u);
  assert.doesNotMatch(lines, /✓|×/u);

  viewer.syncFrom([toolStart("t1", "read_file"), toolEnd("t1", "read_file", false)]);
  lines = viewer.render(160).slice(1, -1).join("\n");
  assert.match(lines, /✓ read_file/u);
  assert.doesNotMatch(lines, /▶/u);
  // 不显示执行耗时。
  assert.doesNotMatch(lines, /ms|耗时|elapsed/u);
  // 一次调用只有一个条目：结束不产生第二行。
  assert.equal(
    viewer.render(160).slice(1, -1).filter((line) => line.includes("read_file")).length,
    1,
  );

  viewer.syncFrom([
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
    toolStart("t2", "run_cmd"),
    toolEnd("t2", "run_cmd", true),
  ]);
  lines = viewer.render(160).slice(1, -1).join("\n");
  assert.match(lines, /✓ read_file/u);
  assert.match(lines, /× run_cmd/u);
});

test("运行中强调色、成功与中性弱化、警告色、失败整行错误色", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };

  const running = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  const runningLines = renderAgentActivityViewerSurface(running, 120, theme).join("\n");
  assert.match(runningLines, /<fg:accent>[^]*▶ read_file/u);

  const success = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
  ], { viewport_height: 20 });
  const successLines = renderAgentActivityViewerSurface(success, 120, theme).join("\n");
  assert.match(successLines, /<fg:dim>[^]*✓ read_file/u);
  assert.doesNotMatch(successLines, /<fg:error>/u);

  const failure = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", true),
  ], { viewport_height: 20 });
  const failureLines = renderAgentActivityViewerSurface(failure, 120, theme).join("\n");
  assert.match(failureLines, /<fg:error>[^]*× read_file/u);
});

test("安全兜底只显示工具名与状态，不显示参数、结果或错误正文", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file", "unknown"),
    toolEnd("t1", "read_file", true, "unknown"),
    toolStart("t2", "query_database", "unknown"),
    toolEnd("t2", "query_database", false, "unknown"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  assert.match(body, /× read_file/u);
  assert.match(body, /✓ query_database/u);
  // 任何载荷、错误正文与可展开入口都不出现。
  assert.doesNotMatch(body, /collapsed|Enter to expand/u);
  assert.equal(
    viewer.render(160).slice(1, -1).filter((line) => line.includes("read_file")).length,
    1,
  );
  // 兜底条目不可展开：不参与选择循环。
  for (const key of viewer.getExpandedKeys()) {
    assert.doesNotMatch(key, /tool:/u);
  }
});

test("结束先到时自建完成条目，迟到开始被忽略且不重置状态", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read_file", false),
  ], { viewport_height: 20 });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /✓ read_file/u);

  // 迟到开始不得把完成条目退回运行中。
  viewer.syncFrom([toolEnd("t1", "read_file", false), toolStart("t1", "read_file")]);
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /✓ read_file/u);
  assert.doesNotMatch(body, /▶/u);
  assert.equal(viewer.getPublicState().event_count, 2);
});

test("重复开始与重复结束保持幂等", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file"),
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
    toolEnd("t1", "read_file", false),
  ], { viewport_height: 20 });

  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /✓ read_file/u);
  assert.doesNotMatch(body, /▶/u);
  assert.equal(
    viewer.render(160).slice(1, -1).filter((line) => line.includes("read_file")).length,
    1,
  );
});

test("代理进入 idle 时运行中工具收束为警告 result unavailable，匹配结束仍可回填", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent("idle"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.match(lines.join("\n"), /read_file · result unavailable/u);
  assert.ok(lines.some((line) => line.includes("read_file") && !line.includes("▶")));

  // 收束后身份匹配的结束事实回填真实状态。
  viewer.syncFrom([toolStart("t1", "read_file"), toolEnd("t1", "read_file", false)]);
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /✓ read_file/u);
  assert.doesNotMatch(viewer.render(160).slice(1, -1).join("\n"), /result unavailable/u);
});

test("代理进入 failed 与 terminated 时按各自语义收束运行中工具", () => {
  const failed = new AgentActivityViewerModel(viewerAgent("failed"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  const failedLines = failed.render(160).slice(1, -1);
  assert.ok(failedLines.some((line) => line.includes("read_file") && !line.includes("▶")));

  const terminated = new AgentActivityViewerModel(viewerAgent("terminated"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  const terminatedBody = terminated.render(160).slice(1, -1).join("\n");
  assert.match(terminatedBody, /read_file · terminated before result/u);

  // 终态收束后匹配结束仍可回填；失败结束回填为真实失败。
  terminated.syncFrom([toolStart("t1", "read_file"), toolEnd("t1", "read_file", true)]);
  assert.match(terminated.render(160).slice(1, -1).join("\n"), /× read_file/u);
  assert.doesNotMatch(
    terminated.render(160).slice(1, -1).join("\n"),
    /terminated before result/u,
  );
});

test("非终态生命周期不收束运行中工具，收束只发生在 idle/failed/terminated", () => {
  for (const state of [
    "starting",
    "working",
    "interrupting",
    "terminating",
  ] as const) {
    const viewer = new AgentActivityViewerModel(viewerAgent(state), [
      toolStart("t1", "read_file"),
    ], { viewport_height: 20 });
    const body = viewer.render(160).slice(1, -1).join("\n");
    assert.match(body, /▶ read_file/u, state);
    assert.doesNotMatch(body, /result unavailable|terminated before result/u, state);
  }
});

test("生命周期变化立即失效投影：working 期间进入 idle 即收束运行中工具", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent("working"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /▶ read_file/u);

  // 不需要任何新事件：进入 idle 后运行中工具立即收束为警告。
  assert.equal(viewer.updateLifecycle("idle"), "changed");
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /result unavailable/u);
});

test("不同运行实例的同名工具活动不互相回填或合并", () => {
  const otherIncarnation = "2c3b4d5e-6f70-4a81-9b2c-3d4e5f6a7b8c";
  const viewer = new AgentActivityViewerModel(viewerAgent("terminated"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /terminated before result/u);

  // 另一运行实例的同 ID 结束事实身份不匹配：既不回填也不串流。
  viewer.syncFrom([toolEnd("t1", "read_file", false, "unknown", otherIncarnation)]);
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /terminated before result/u);
  assert.doesNotMatch(body, /✓ read_file/u);
  assert.doesNotMatch(body, /▶ read_file/u);
});

test("工具取消按普通失败显示", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "bash"),
    toolEnd("t1", "bash", true),
  ], { viewport_height: 20 });

  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /× bash/u);
  const surface = renderAgentActivityViewerSurface(viewer, 120, theme).join("\n");
  assert.match(surface, /<fg:error>[^]*× bash/u);
});

test("生命周期收束不可逆：回看与重放不会把收束条目退回运行中", () => {
  const entries = [toolStart("t1", "read_file")];
  const viewer = new AgentActivityViewerModel(viewerAgent("terminated"), entries, {
    viewport_height: 20,
  });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /terminated before result/u);

  // lifecycle 回到 working 也不恢复运行中显示（收束只由条目事实回填）。
  viewer.updateLifecycle("working");
  assert.doesNotMatch(viewer.render(160).slice(1, -1).join("\n"), /▶ read_file/u);
});

test("text block 独立按正常 Markdown 完整渲染，不加角色标签或分隔线", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([
      { type: "text", text: "# First block\n\nunclosed **bold" },
      { type: "text", text: "## Second block\n\ncomplete" },
    ]),
  ], { viewport_height: 20 });
  const body = viewer.render(80).slice(1, -1).join("\n");

  assert.ok(body.includes("First block"), body);
  assert.ok(body.includes("Second block"), body);
  // 前一块未闭合语法不破坏后一块；无角色标签、消息容器或分隔线。
  assert.doesNotMatch(body, /Assistant|assistant/u);
  assert.doesNotMatch(body, /━|┃/u);
  // 每块独立解析：未闭合 bold 不会跨块吞掉后文。
  assert.ok(body.includes("complete"), body);
});

test("超长 text 仍完整渲染，不按长度折叠", () => {
  const long = "很长的报告正文。".repeat(4000);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage(long)], {
    viewport_height: 20,
  });
  const body = viewer.render(160).slice(1, -1).join("\n");

  assert.ok(body.includes("很长的报告正文。"), body);
  assert.doesNotMatch(body, /collapsed|省略|truncated/u);
});

test("thinking 默认折叠为 Thinking，不显示行数或正文预览", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([
      { type: "thinking", thinking: "内部计划第一行\n内部计划第二行\n内部计划第三行" },
      { type: "text", text: "answer" },
    ]),
  ], { viewport_height: 20 });
  const lines = viewer.render(160);
  const body = lines.slice(1, -1);

  const thinkingLines = body.filter((line) => line.includes("Thinking"));
  assert.equal(thinkingLines.length, 1, lines.join("\n"));
  assert.doesNotMatch(body.join("\n"), /内部计划/u);
  assert.doesNotMatch(thinkingLines[0] ?? "", /lines|行|…/u);
  assert.ok(body.some((line) => line.includes("answer")));
});

test("展开 thinking 后保留标题，正文顶格弱化且无逐行前缀", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([
      { type: "thinking", thinking: "计划 A\n计划 B" },
      { type: "text", text: "answer" },
    ]),
  ], { viewport_height: 20 });
  // Tab 选中第一个可展开项（thinking）并切换展开。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");

  const body = viewer.render(160).slice(1, -1);
  assert.equal(body.filter((line) => line.includes("Thinking")).length, 1, body.join("\n"));
  assert.ok(body.some((line) => line.includes("计划 A")), body.join("\n"));
  assert.ok(body.some((line) => line.includes("计划 B")));
  // 无逐行前缀、无缩进。
  assert.ok(body.some((line) => line.trimStart() === line && line.includes("计划 A")));
  assert.doesNotMatch(body.join("\n"), /┆/u);
  assert.ok(body.some((line) => line.includes("answer")));
});

test("相邻 thinking 合并为同一折叠条目，被 text 隔开的 thinking 保持分离", () => {
  // 模拟产生端输出：相邻 thinking 已在规范化时合并。
  const normalized = normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一段" },
        { type: "thinking", thinking: "第二段" },
        { type: "text", text: "中间" },
        { type: "thinking", thinking: "第三段" },
      ],
    },
  });
  assert.ok(normalized.kind === "event" && normalized.event.type === "message");
  const entry = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: normalized.event,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [entry], { viewport_height: 20 });

  const collapsed = viewer.render(160).slice(1, -1);
  assert.equal(collapsed.filter((line) => line.includes("Thinking")).length, 2, collapsed.join("\n"));

  // 展开第一组，确认两段合并在同一展开正文里；第三段仍折叠。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");
  const expandedBody = viewer.render(160).slice(1, -1).join("\n");
  assert.equal(expandedBody.split("Thinking").length - 1, 2, expandedBody);
  assert.ok(expandedBody.includes("第一段") && expandedBody.includes("第二段"), expandedBody);
  assert.doesNotMatch(expandedBody, /第三段/u);
});

test("查看器支持 Tab 与 Shift+Tab 在全部可展开条目间正反循环", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考一" }]),
    messageEntry([{ type: "thinking", thinking: "思考二" }]),
    messageEntry([{ type: "thinking", thinking: "思考三" }]),
  ], { viewport_height: 20 });

  // 打开时选择当前视口最新（最后）可展开项。
  assert.match(viewer.getSelectedKey() ?? "", /thinking:/u);
  const initial = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\t"), "changed");
  // Tab 从最新项向后循环回第一个。
  assert.notEqual(viewer.getSelectedKey(), initial);
  const afterTab = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\x1b[Z"), "changed");
  assert.equal(viewer.getSelectedKey(), initial);
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.getSelectedKey(), afterTab);
});

test("打开时默认选择当前视口最新可展开项，新活动不抢选择", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "早思考" }]),
    textMessage("正文\n正文\n正文\n正文"),
    messageEntry([{ type: "thinking", thinking: "晚思考" }]),
  ], { viewport_height: VIEWPORT });
  const initial = viewer.getSelectedKey();
  // 跟随底部时视口覆盖最后几行：选中项是视口内最新的可展开条目（晚思考）。
  assert.ok(initial !== undefined, "应建立初始选择");

  // 相同前缀同步与新事件追加都不改变选择。
  viewer.syncFrom([
    messageEntry([{ type: "thinking", thinking: "早思考" }]),
    textMessage("正文\n正文\n正文\n正文"),
    messageEntry([{ type: "thinking", thinking: "晚思考" }]),
    toolStart("new-1", "run_cmd"),
  ]);
  assert.equal(viewer.getSelectedKey(), initial);
});

test("Enter 与空格切换展开，右键展开、左键折叠", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "计划" }]),
  ], { viewport_height: 20 });

  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\x1b[C"), "changed");
  assert.ok(viewer.getExpandedKeys().length === 1);
  assert.equal(viewer.handleInput("\x1b[C"), "ignored");
  assert.equal(viewer.handleInput("\x1b[D"), "changed");
  assert.equal(viewer.getExpandedKeys().length, 0);
  assert.equal(viewer.handleInput(" "), "changed");
  assert.equal(viewer.getExpandedKeys().length, 1);
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.equal(viewer.getExpandedKeys().length, 0);
});

test("视口外 Tab 目标只触发使其可见的最小滚动", () => {
  const entries: CanonicalAgentActivityEntry[] = [
    messageEntry([{ type: "thinking", thinking: "第一条" }]),
  ];
  for (let index = 0; index < 30; index += 1) entries.push(textMessage(`填充行 ${index}`));
  entries.push(messageEntry([{ type: "thinking", thinking: "最后一条" }]));
  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, {
    viewport_height: VIEWPORT,
  });
  // 初始选择：视口（底部 3 行）内的最新可展开项。
  const initialKey = viewer.getSelectedKey();
  assert.ok(initialKey !== undefined);
  const initialOffset = viewer.getPublicState().scroll_offset;

  // Tab 回到第一条（在视口上方远处）：只滚动到刚好可见（首行）。
  assert.equal(viewer.handleInput("\t"), "changed");
  const afterOffset = viewer.getPublicState().scroll_offset;
  assert.ok(afterOffset < initialOffset, `${afterOffset} !< ${initialOffset}`);
  const lines = viewer.render(160).slice(1, -1);
  assert.equal(lines[0], "Thinking", lines.join("\n"));
});

test("展开保持屏幕位置并暂停 follow；折叠不自动恢复；滚到底部或 Tab 回最新项恢复", () => {
  const entries: CanonicalAgentActivityEntry[] = [];
  for (let index = 0; index < 6; index += 1) entries.push(textMessage(`正文块 ${index}`));
  entries.push(messageEntry([{ type: "thinking", thinking: "思考" }]));
  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, {
    viewport_height: VIEWPORT,
  });
  assert.equal(viewer.getPublicState().follow_enabled, true);

  // 选择最新 thinking（视口内）并展开：暂停 follow。
  assert.equal(viewer.handleInput("\t"), "changed");
  const selectedBefore = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\x1b[C"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);

  // 展开动作后追加新条目不拉到底部；屏幕位置保持。
  const offsetAfterExpand = viewer.getPublicState().scroll_offset;
  viewer.syncFrom(entries.concat([
    toolStart("late-1", "run_cmd"),
  ]));
  assert.equal(viewer.getPublicState().scroll_offset, offsetAfterExpand);
  assert.equal(viewer.getSelectedKey(), selectedBefore);

  // 折叠不自动恢复 follow。
  assert.equal(viewer.handleInput("\x1b[D"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);

  // Tab 回到底部最新项后恢复 follow。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(viewer.getPublicState().scroll_offset, viewer.getPublicState().max_scroll_offset);
});

test("向上滚动暂停 follow，向下滚到底恢复，footer 始终固定且不显示 paused", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(
    viewer.render(160).at(-1),
    "↑↓ scroll · Tab/Shift+Tab select · Enter expand · Esc back",
  );

  assert.equal(viewer.handleInput("\x1b[A"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(
    viewer.render(160).at(-1),
    "↑↓ scroll · Tab/Shift+Tab select · Enter expand · Esc back",
  );
  assert.doesNotMatch(viewer.render(160).at(-1) ?? "", /paused/u);

  viewer.syncFrom([...replayFixture(), toolStart("t2", "run_cmd")]);
  // 暂停后追加新条目保持用户回看位置。
  assert.equal(viewer.getPublicState().follow_enabled, false);
  const pausedOffset = viewer.getPublicState().scroll_offset;

  // 向下滚动到底部恢复跟随。
  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(
    viewer.getPublicState().scroll_offset,
    viewer.getPublicState().max_scroll_offset,
  );
  void pausedOffset;
});

test("选中条目使用整行选中背景渲染", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考" }]),
  ], { viewport_height: 20 });
  assert.equal(viewer.handleInput("\t"), "changed");

  const surface = renderAgentActivityViewerSurface(viewer, 120, Object.freeze({
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  }));
  const selectedLines = surface.filter((line) => line.includes("<bg:selectedBg>"));
  assert.equal(selectedLines.length, 1, surface.join("\n"));
  assert.match(selectedLines[0] ?? "", /Thinking/u);
});

test("逐 token 显示事件只驻留查看器投影，并在完整条目抵达时收束", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), []);
  assert.equal(viewer.applyDisplayEvent(displayDelta("message-1", 1, 0, "text", "Hel")), "changed");
  assert.equal(viewer.applyDisplayEvent(displayDelta("message-1", 2, 0, "text", "lo")), "changed");
  assert.equal(viewer.getPublicState().event_count, 0);
  assert.match(viewer.render(120).join("\n"), /Hello/u);

  assert.equal(viewer.applyDisplayEvent(displayDelta("message-1", 4, 0, "text", "!")), "changed");
  assert.doesNotMatch(viewer.render(120).join("\n"), /Hello!/u);
  assert.equal(viewer.applyDisplayEvent(displayComplete("message-1", 3)), "ignored");

  assert.equal(viewer.applyDisplayEvent(displayDelta("message-2", 1, 0, "text", "done")), "changed");
  assert.equal(viewer.applyDisplayEvent(displayComplete("message-2", 2)), "changed");
  assert.doesNotMatch(viewer.render(120).join("\n"), /done/u);
  viewer.syncFrom([textMessage("done")]);
  assert.equal(viewer.getPublicState().event_count, 1);
  assert.match(viewer.render(120).join("\n"), /done/u);
});

test("实时 thinking 草稿默认折叠并可展开观察流式内容", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), []);
  assert.equal(viewer.applyDisplayEvent(displayDelta("message-1", 1, 0, "thinking", "流式思考")), "changed");
  const collapsed = viewer.render(120).join("\n");
  assert.match(collapsed, /Thinking/u);
  assert.doesNotMatch(collapsed, /流式思考/u);

  // 选择实时 thinking 折叠条目并展开。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.match(viewer.render(120).join("\n"), /流式思考/u);
});

test("Esc 关闭查看器，其余未知输入被忽略", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  assert.equal(viewer.handleInput("\x1b"), "close");
  assert.equal(viewer.handleInput("x"), "ignored");
});

test("标题展示模板、名称与生命周期状态并净化控制字符", () => {
  const viewer = new AgentActivityViewerModel({
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "bad\tname",
    state: "working",
  }, replayFixture());
  assert.match(viewer.render(160)[0] ?? "", /worker · bad name · working/);

  assert.equal(viewer.updateLifecycle("terminated"), "changed");
  assert.match(viewer.render(160)[0] ?? "", /terminated/);
  assert.equal(viewer.updateLifecycle("terminated"), "ignored");
});

test("违约条目被静默忽略", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const stale = Object.freeze({
    contract_version: "wj-pi-subagents.activity/1",
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({ type: "message", content: [] }),
  }) as unknown as CanonicalAgentActivityEntry;
  assert.equal(viewer.syncFrom([stale]), "ignored");
  assert.equal(viewer.getPublicState().event_count, 3);
});

test("查看器表面使用既定框线布局并应用主题", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const surface = renderAgentActivityViewerSurface(viewer, 160, undefined);
  assert.ok(surface.length > 0);
  assert.ok(surface.every((line) => displayWidth(line) === 160), surface.join("\n"));
  assert.ok(surface.some((line) => line.includes("AGENT ACTIVITY")), surface.join("\n"));
});

test("正文净化 ANSI 与方向控制序列并保持宽字符显示宽度", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    textMessage("safe\x1b[31m red\x1b[0m\u202e hidden\u0007 text"),
    textMessage("宽度🌍字符"),
  ]);
  const body = viewer.render(120).slice(1, -1).join("\n");

  assert.doesNotMatch(body, /\x1b|\\u202e|\\u0007/u);
  assert.match(body, /safe red\s+hidden\s+text/u);
  assert.match(body, /宽度🌍字符/u);

  const surface = renderAgentActivityViewerSurface(viewer, 40, undefined);
  assert.ok(surface.every((line) => displayWidth(line) === 40), surface.join("\n"));
});

test("关闭重开后展开、选择、滚动与 follow 状态重置", () => {
  const replay = [
    messageEntry([{ type: "thinking", thinking: "第一条思考" }]),
    messageEntry([{ type: "thinking", thinking: "第二条思考" }]),
    messageEntry([{ type: "thinking", thinking: "第三条思考" }]),
    messageEntry([{ type: "thinking", thinking: "第四条思考" }]),
  ];
  // 第一次会话：展开并向上滚动。
  const first = new AgentActivityViewerModel(viewerAgent(), replay, {
    viewport_height: VIEWPORT,
  });
  first.handleInput("\t");
  first.handleInput("\x1b[C");
  first.handleInput("\x1b[A");
  assert.equal(first.getPublicState().follow_enabled, false);
  assert.equal(first.getExpandedKeys().length, 1);

  // 关闭后重新打开：全新实例。
  const second = new AgentActivityViewerModel(viewerAgent(), replay, {
    viewport_height: VIEWPORT,
  });
  assert.equal(second.getExpandedKeys().length, 0);
  assert.equal(second.getPublicState().follow_enabled, true);
  assert.equal(second.getPublicState().scroll_offset, second.getPublicState().max_scroll_offset);
  assert.notEqual(second.getSelectedKey(), first.getSelectedKey());
});

test("多个条目可同时保持展开", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考一" }]),
    messageEntry([{ type: "thinking", thinking: "思考二" }]),
    messageEntry([{ type: "thinking", thinking: "思考三" }]),
  ], { viewport_height: 20 });
  viewer.handleInput("\t");
  viewer.handleInput("\r");
  viewer.handleInput("\t");
  viewer.handleInput("\r");
  assert.equal(viewer.getExpandedKeys().length, 2);

  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.ok(body.includes("思考一"), body);
  assert.ok(body.includes("思考二"));
  assert.doesNotMatch(body, /思考三/u);
});

test("无缓存活动时显示明确空态", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), []);
  const lines = viewer.render(160);

  assert.ok(lines.some((line) => line.includes("No cached activity yet")), lines.join("\n"));
  assert.equal(viewer.getPublicState().event_count, 0);
  assert.equal(viewer.getSelectedKey(), undefined);
});

function dedicatedToolLine(viewer: AgentActivityViewerModel, toolName: string): string | undefined {
  return viewer.render(160).slice(1, -1).find((line) => line.includes(toolName));
}

test("read 运行中显示 path/offset/limit，结束原地补充截断事实且保持单行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read", "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/index.ts", offset: 5, limit: 20,
    }),
  ], { viewport_height: 20 });
  const running = dedicatedToolLine(viewer, "read");
  assert.match(running ?? "", /▶.*read · src\/index\.ts · offset 5 · limit 20/u);
  assert.doesNotMatch(running ?? "", /truncated/u);

  viewer.syncFrom([
    toolStart("t1", "read", "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/index.ts", offset: 5, limit: 20,
    }),
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/index.ts", offset: 5, limit: 20, truncated: true, truncatedBy: "lines",
    }),
  ]);
  const done = dedicatedToolLine(viewer, "read");
  assert.match(done ?? "", /✓.*read · src\/index\.ts · offset 5 · limit 20 · truncated \(lines\)/u);
  assert.equal(done, done?.trimEnd());
  // 专用摘要仍是一个条目一行。
  assert.equal(viewer.render(160).slice(1, -1).filter((line) => line.includes("src/index.ts")).length, 1);
});

test("read 首行超限与字节截断使用对应事实文本，图片结果不产生成功侧事实", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "big.log", truncated: true, truncatedBy: "bytes", firstLineExceedsLimit: true,
    }),
    toolEnd("t2", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "img.png",
    }),
    toolEnd("t3", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "limited.txt", limit: 100, hasMoreLines: true,
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /read · big\.log · truncated \(first line\)/u);
  assert.match(body, /read · img\.png/u);
  assert.match(body, /read · limited\.txt · limit 100 · more lines/u);
  assert.doesNotMatch(body, /Read image file/u);
});

test("grep 摘要显示 pattern、path 与全部非默认条件，未提供 path 显示 .", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "TODO", path: "src", glob: "*.ts", ignoreCase: true, literal: true,
      context: 2, limit: 50,
    }),
    toolEnd("t2", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "x", path: ".",
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.some((line) => line.includes(
    "grep · /TODO/ · src · glob *.ts · ignoreCase · literal · context 2 · limit 50",
  )), lines.join("\n"));
  // 未提供 path 时明确显示 .
  assert.ok(lines.some((line) => line.includes("grep · /x/ · .")), lines.join("\n"));
});

test("grep 结果事实：无匹配、达到限制、截断与长行截断，不显示匹配正文", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "secret", path: "src", noMatches: true,
    }),
    toolEnd("t2", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "secret", path: "src",
      matchLimitReached: 100, truncated: true, truncatedBy: "bytes", linesTruncated: true,
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /grep · \/secret\/ · src · no matches/u);
  assert.match(body, /100 matches limit · truncated \(bytes\) · lines truncated/u);
  assert.doesNotMatch(body, /src\/a\.ts:1/u);
});

test("find 与 ls 摘要显示输入参数并保留各自空结果与限制事实", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "find", false, "pi_native", INCARNATION_ID, {
      tool: "find", pattern: "*.ts", path: "src", noFiles: true,
    }),
    toolEnd("t2", "find", false, "pi_native", INCARNATION_ID, {
      tool: "find", pattern: "*.ts", path: ".", limit: 500, resultLimitReached: 1000, truncated: true, truncatedBy: "bytes",
    }),
    toolEnd("t3", "ls", false, "pi_native", INCARNATION_ID, {
      tool: "ls", path: "empty-dir", emptyDirectory: true,
    }),
    toolEnd("t4", "ls", false, "pi_native", INCARNATION_ID, {
      tool: "ls", path: ".", entryLimitReached: 500, truncated: true, truncatedBy: "lines",
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /find · \*\.ts · src · no files/u);
  assert.match(body, /find · \*\.ts · \. · limit 500 · 1000 results limit · truncated \(bytes\)/u);
  assert.match(body, /ls · empty-dir · empty directory/u);
  assert.match(body, /ls · \. · 500 entries limit · truncated \(lines\)/u);
  // 不显示命中路径列表或目录条目。
  assert.doesNotMatch(body, /a\.ts\nb\.ts|entry one/u);
});

test("专用工具失败仍显示全部输入参数与折叠标记，展开错误为顶格红色纯文本", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const errorText = "Offset 9000 is beyond end of file (12 lines total)\nsecond *line* stays literal";
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read", "pi_native", INCARNATION_ID, { tool: "read", path: "src/index.ts", offset: 9000 }),
    toolEnd("t1", "read", true, "pi_native", INCARNATION_ID, { tool: "read", path: "src/index.ts", offset: 9000 }, errorText),
  ], { viewport_height: 20 });
  const collapsed = viewer.render(160).slice(1, -1);
  const summaryLine = collapsed.find((line) => line.includes("read"));
  // 失败摘要仍是输入参数，不附带成功侧统计，并有折叠标记。
  assert.match(summaryLine ?? "", /×.*read · src\/index\.ts · offset 9000/u);
  assert.doesNotMatch(summaryLine ?? "", /truncated/u);
  assert.match(summaryLine ?? "", /▸/u);
  // 错误正文默认不展开。
  assert.doesNotMatch(collapsed.join("\n"), /beyond end of file/u);

  // 选中并展开：错误以红色预格式化纯文本顶格显示，保留换行，不解析 Markdown。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.match(viewer.getSelectedKey() ?? "", /tool-error:/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  const expanded = viewer.render(160).slice(1, -1);
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /▾/u);
  const errorLines = expanded.filter((line) => line.includes("beyond end of file") || line.includes("second"));
  assert.equal(errorLines.length, 2, expanded.join("\n"));
  // 保留换行：两行各自存在；不解析 Markdown：星号保持字面。
  assert.ok(expanded.some((line) => line.trim().startsWith("Offset 9000")), expanded.join("\n"));
  assert.ok(expanded.some((line) => line.includes("*line*")), expanded.join("\n"));
  // 红色错误样式。
  const surface = renderAgentActivityViewerSurface(viewer, 160, theme).join("\n");
  assert.match(surface, /<fg:error>[^]*beyond end of file/u);
});

test("长错误正文按面板宽度软换行且不截断字符，ANSI 与控制字符已过滤", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "grep", true, "pi_native", INCARNATION_ID, { tool: "grep", pattern: "x", path: "." },
      "E".repeat(200) + "\x1b[31m-red\x1b[0m\n\u202etail"),
  ], { viewport_height: 20 });
  viewer.handleInput("\t");
  viewer.handleInput("\r");
  const width = 60;
  const expanded = viewer.render(width).slice(1, -1);
  const errorLines = expanded.filter((line) => line.includes("E") || line.includes("tail"));
  assert.ok(errorLines.length > 2, expanded.join("\n"));
  assert.ok(errorLines.every((line) => displayWidth(line) <= width), expanded.join("\n"));
  // 字符不丢失：全部 E 都在（软换行不截断）。
  const totalE = errorLines.join("").split("E").length - 1;
  assert.equal(totalE, 200);
  assert.doesNotMatch(expanded.join("\n"), /\x1b|\u202e/u);
});

test("结束先到的专用工具仍自包含摘要；运行中收束后不可展开错误", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent("idle"), [
    toolEnd("t1", "ls", false, "pi_native", INCARNATION_ID, { tool: "ls", path: "src" }),
    toolStart("t2", "read", "pi_native", INCARNATION_ID, { tool: "read", path: "pending.txt" }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /✓.*ls · src/u);
  // 收束后的运行中工具保留输入参数摘要但无错误可展开。
  assert.match(body, /read · pending\.txt · result unavailable/u);
  for (const key of viewer.getExpandedKeys()) {
    assert.doesNotMatch(key, /tool-error:/u);
  }
});

test("长路径中间省略保留两端，其余超宽字段从右侧省略且不溢出", () => {
  const deepPath = `${"very-long-directory-name/".repeat(8)}file-with-long-name.txt`;
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, { tool: "read", path: deepPath }),
  ], { viewport_height: 20 });
  // 足够宽时两端完整保留且只有一个省略号。
  const wide = viewer.render(140).slice(1, -1).find((item) => item.includes("read")) ?? "";
  assert.ok(wide.includes("very-long-directory-name/"), wide);
  assert.ok(wide.includes("file-with-long-name.txt"), wide);
  assert.equal(wide.split("…").length - 1, 1, wide);

  // 窄宽度：行不溢出，中间省略生效，两端前缀仍可识别。
  const width = 50;
  const line = viewer.render(width).slice(1, -1).find((item) => item.includes("read")) ?? "";
  assert.ok(displayWidth(line) <= width, line);
  assert.ok(line.includes("very-long-directory…"), line);
  assert.ok(line.includes("long-name.txt"), line);
  assert.equal(line.split("…").length - 1, 1, line);

  // 非 path 字段（超长 pattern）从右侧省略：行不溢出但头部保留。
  const grepViewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t2", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "P".repeat(200), path: "src",
    }),
  ], { viewport_height: 20 });
  const grepLine = grepViewer.render(width).slice(1, -1).find((item) => item.includes("grep")) ?? "";
  assert.ok(displayWidth(grepLine) <= width, grepLine);
  assert.ok(grepLine.includes("grep · /PPPP"), grepLine);
  assert.ok(grepLine.includes("…"), grepLine);
});

test("未知来源与同名覆盖工具仍走安全兜底，不显示专用摘要", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "unknown"),
    toolEnd("t2", "grep", true, "plugin"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  // 兜底条目只显示工具名与状态，无分隔符或摘要字段。
  assert.ok(lines.some((line) => line === "✓ read"), lines.join("\n"));
  assert.ok(lines.some((line) => line === "× grep"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /·|glob|truncated/u);
});

test("成功专用工具无展开入口，不参与选择循环", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, { tool: "read", path: "a.txt" }),
    toolEnd("t2", "read", true, "pi_native", INCARNATION_ID, { tool: "read", path: "b.txt" }, "boom"),
  ], { viewport_height: 20 });
  // 唯一可展开项是失败条目；Tab 选中它且循环只在该条目上。
  const first = viewer.getSelectedKey();
  assert.match(first ?? "", /tool-error:/u);
  viewer.handleInput("\t");
  assert.equal(viewer.getSelectedKey(), first);
});
