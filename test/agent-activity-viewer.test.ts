import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentActivityViewerModel,
  displayWidth,
  renderAgentActivityViewerSurface,
} from "../src/agent-activity-viewer.ts";
import type {
  SafeAgentActivityDisplayEvent,
  SafeAgentActivityEvent,
} from "../src/rpc-bridge-event.ts";
import { ACTIVITY_MAX_TEXT_BYTES } from "../src/rpc-bridge-event.ts";
import type { AgentLifecycleState } from "../src/agent-snapshot-codec.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440002";
const VIEWPORT = 3;

function viewerAgent(state: AgentLifecycleState = "working") {
  return {
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state,
  } as const;
}

function textMessage(text: string): SafeAgentActivityEvent {
  return Object.freeze({ type: "message", content: [Object.freeze({ type: "text", text })] });
}

function toolStart(toolCallId: string, toolName: string, args?: string): SafeAgentActivityEvent {
  return Object.freeze({
    type: "tool_execution_start",
    toolCallId,
    toolName,
    ...(args === undefined ? {} : { args }),
  });
}

function toolEnd(
  toolCallId: string,
  toolName: string,
  result?: string,
  isError?: boolean,
): SafeAgentActivityEvent {
  return Object.freeze({
    type: "tool_execution_end",
    toolCallId,
    toolName,
    ...(result === undefined ? {} : { result }),
    ...(isError === undefined ? {} : { isError }),
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

/** 4 行正文消息 + 工具开始/结束各 1 行 = 6 行事件正文。 */
function replayFixture(): readonly SafeAgentActivityEvent[] {
  return Object.freeze([
    textMessage("line1\nline2\nline3\nline4"),
    toolStart("t1", "read_file", '{"path":"src/a.ts"}'),
    toolEnd("t1", "read_file", '{"ok":true}'),
  ]);
}

test("打开即回放全部历史活动", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const lines = viewer.render(160);

  assert.match(lines[0] ?? "", /worker · worker-a · working/);
  assert.ok(lines.some((line) => line.includes("line1")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("line4")));
  assert.ok(lines.some((line) => line.includes("▶ read_file")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("read_file") && line.includes('{"ok":true}')));
  assert.equal(viewer.getPublicState().event_count, 3);
});

test("thinking 块渲染为带前缀的正文行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    Object.freeze({
      type: "message",
      content: [
        Object.freeze({ type: "thinking", thinking: "plan a\nplan b" }),
        Object.freeze({ type: "text", text: "answer" }),
      ],
    }),
  ]);
  const lines = viewer.render(160);

  assert.ok(lines.some((line) => line.includes("┆") && line.includes("plan a")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("plan b")));
  assert.ok(lines.some((line) => line.includes("answer")));
});

test("无缓存活动时显示明确空态", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), []);
  const lines = viewer.render(160);

  assert.ok(lines.some((line) => line.includes("No cached activity yet")), lines.join("\n"));
  assert.equal(viewer.getPublicState().event_count, 0);
});

test("变更通知追加新事件并保持到达序", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const outcome = viewer.syncFrom([...replayFixture(), toolStart("t2", "run_cmd", '{"cmd":"ls"}')]);

  assert.equal(outcome, "changed");
  const lines = viewer.render(160);
  const lastIndex = lines.findIndex((line) => line.includes("run_cmd"));
  assert.ok(lastIndex > lines.findIndex((line) => line.includes('{"ok":true}')), lines.join("\n"));
  assert.equal(viewer.getPublicState().event_count, 4);
});

test("同步回放未增长时忽略", () => {
  const replay = replayFixture();
  const viewer = new AgentActivityViewerModel(viewerAgent(), replay);
  assert.equal(viewer.syncFrom(replay), "ignored");
});

test("默认自动跟随最新事件", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(viewer.getPublicState().scroll_offset, 3);

  viewer.syncFrom([...replayFixture(), toolStart("t2", "run_cmd", '{"cmd":"ls"}')]);
  assert.equal(viewer.getPublicState().scroll_offset, 4);
  const visible = viewer.render(160).slice(1, -1);
  assert.ok(visible.some((line) => line.includes("run_cmd")), visible.join("\n"));
});

test("向上滚动暂停跟随，追加不再跳到底部", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  assert.equal(viewer.handleInput("\x1b[A"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(viewer.getPublicState().scroll_offset, 2);

  viewer.syncFrom([...replayFixture(), toolStart("t2", "run_cmd", '{"cmd":"ls"}')]);
  assert.equal(viewer.getPublicState().scroll_offset, 2);
  const visible = viewer.render(160).slice(1, -1);
  assert.ok(visible.every((line) => !line.includes("run_cmd")), visible.join("\n"));
});

test("已暂停跟随时底部显示提示", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  assert.match(viewer.render(160).at(-1) ?? "", /Esc/);
  assert.doesNotMatch(viewer.render(160).at(-1) ?? "", /paused/);

  viewer.handleInput("\x1b[A");
  assert.match(viewer.render(160).at(-1) ?? "", /paused/);
});

test("向下滚动回到底部恢复跟随", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  viewer.handleInput("\x1b[A");
  viewer.handleInput("\x1b[A");
  assert.equal(viewer.getPublicState().follow_enabled, false);

  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, true);

  viewer.syncFrom([...replayFixture(), toolStart("t2", "run_cmd", '{"cmd":"ls"}')]);
  assert.equal(viewer.getPublicState().scroll_offset, 4);
});

test("滚动到边界时忽略输入", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  viewer.handleInput("\x1b[A");
  viewer.handleInput("\x1b[A");
  viewer.handleInput("\x1b[A");
  assert.equal(viewer.getPublicState().scroll_offset, 0);
  assert.equal(viewer.handleInput("\x1b[A"), "ignored");

  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.handleInput("\x1b[B"), "ignored");
  assert.equal(viewer.getPublicState().follow_enabled, true);
});

test("Esc 关闭查看器，其余输入被忽略", () => {
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

test("违约与超限事件被忽略", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  assert.equal(viewer.appendEvent({ type: "unknown" } as never), "ignored");
  assert.equal(viewer.appendEvent({ type: "message" } as never), "ignored");
  const oversized = textMessage("x".repeat(ACTIVITY_MAX_TEXT_BYTES + 1));
  assert.equal(viewer.appendEvent(oversized), "ignored");
  assert.equal(viewer.getPublicState().event_count, 3);
});

test("查看器表面使用既定框线布局并应用主题", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const surface = renderAgentActivityViewerSurface(viewer, 160, undefined);
  assert.ok(surface.length > 0);
  assert.ok(surface.every((line) => displayWidth(line) === 160), surface.join("\n"));
  assert.ok(surface.some((line) => line.includes("AGENT ACTIVITY")), surface.join("\n"));

  const marked = renderAgentActivityViewerSurface(viewer, 160, Object.freeze({
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  }));
  assert.match(
    marked.find((line) => line.includes("AGENT ACTIVITY")) ?? "",
    /<bg:customMessageBg>/,
  );
  assert.ok(marked.some((line) => line.includes("worker · worker-a")), marked.join("\n"));
});

test("assistant Markdown 块可读并按宽度换行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    textMessage([
      "# Summary",
      "",
      "This is **important** and uses `inline code`.",
      "",
      "```ts",
      "const answer = 42;",
      "return answer;",
      "```",
    ].join("\n")),
  ], { viewport_height: 20 });
  const body = viewer.render(32).slice(1, -1);

  assert.ok(body.some((line) => line.includes("Summary")), body.join("\n"));
  assert.ok(body.some((line) => line.includes("important")), body.join("\n"));
  assert.doesNotMatch(body.join("\n"), /\*\*important\*\*/u);
  assert.ok(body.some((line) => line.includes("const answer = 42;")), body.join("\n"));
  assert.ok(body.filter((line) => line.length > 0).length > 4, body.join("\n"));
});

test("工具调用只显示单行关键参数摘要", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart(
      "t-summary",
      "read_file",
      JSON.stringify({
        path: "src/agent-activity-viewer.ts",
        content: "secret-content ".repeat(40),
        recursive: true,
      }),
    ),
  ]);
  const callLines = viewer.render(160).filter((line) => line.includes("read_file"));

  assert.equal(callLines.length, 1);
  assert.match(callLines[0] ?? "", /src\/agent-activity-viewer\.ts/u);
  assert.doesNotMatch(callLines[0] ?? "", /secret-content/u);
  assert.ok((callLines[0] ?? "").length < 140, callLines[0]);
});

test("超长工具结果按桥接 JSON 编码还原后默认折叠，展开后追加仍保持展开状态", () => {
  const result = Array.from({ length: 8 }, (_, index) => `result-line-${index + 1}`).join("\n");
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t-long", "read_file", JSON.stringify({ path: "big.txt" })),
    // 桥接对原始字符串执行 JSON.stringify；查看器必须在显示层还原换行。
    toolEnd("t-long", "read_file", JSON.stringify(result)),
  ], { viewport_height: 20 });

  const collapsed = viewer.render(120).slice(1, -1).join("\n");
  assert.match(collapsed, /collapsed|expand/u);
  assert.doesNotMatch(collapsed, /result-line-8/u);

  assert.equal(viewer.handleInput("\r"), "changed");
  const expanded = viewer.render(120).slice(1, -1).join("\n");
  assert.match(expanded, /result-line-8/u);

  viewer.appendEvent(textMessage("after result"));
  const afterAppend = viewer.render(120).slice(1, -1).join("\n");
  assert.match(afterAppend, /result-line-8/u);
});

test("连续完整 assistant 消息保持事件边界", () => {
  const messages = ["H", "He", "Hel", "Hell", "Hello"];
  const viewer = new AgentActivityViewerModel(viewerAgent(), messages.map(textMessage));

  const body = viewer.render(120).slice(1, -1);
  assert.deepEqual(body.filter((line) => messages.includes(line)), messages);
  assert.equal(viewer.getPublicState().event_count, messages.length);
});

test("逐 token 显示事件只驻留查看器投影，并在完整消息抵达时收束", () => {
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
  viewer.appendEvent(textMessage("done"));
  assert.equal(viewer.getPublicState().event_count, 1);
  assert.match(viewer.render(120).join("\n"), /done/u);
});

test("实时完整事件追加不会丢失快速到达的消息", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage("first")]);
  for (const text of ["second", "third", "fourth"]) viewer.appendEvent(textMessage(text));

  const body = viewer.render(120).slice(1, -1).join("\n");
  assert.match(body, /first/u);
  assert.match(body, /second/u);
  assert.match(body, /third/u);
  assert.match(body, /fourth/u);
  assert.equal(viewer.getPublicState().event_count, 4);
});

test("查看器正文净化 ANSI 与方向控制序列", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    textMessage("safe\x1b[31m red\x1b[0m\u202e hidden\u0007 text"),
    toolStart(
      "t-clean",
      "run_cmd",
      JSON.stringify({
        command: "echo\nsecret",
        stdout: "large output ".repeat(20),
      }),
    ),
  ]);
  const body = viewer.render(120).slice(1, -1).join("\n");

  assert.doesNotMatch(body, /\x1b|\\u202e|\\u0007/u);
  assert.match(body, /safe red\s+hidden\s+text/u);
  assert.match(body, /command=/u);
  assert.doesNotMatch(body, /large output/u);
});

test("展开状态按工具调用 ID 在宽度变化和追加后保持", () => {
  const result = Array.from({ length: 6 }, (_, index) => `line-${index}`).join("\n");
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("stable-id", "read_file", JSON.stringify({ path: "x.txt" })),
    toolEnd("stable-id", "read_file", JSON.stringify(result)),
  ]);
  assert.equal(viewer.setToolResultExpanded("stable-id", true), "changed");
  assert.deepEqual(viewer.getExpandedToolCallIds(), ["stable-id"]);
  assert.match(viewer.render(40).join("\n"), /line-5/u);
  assert.match(viewer.render(140).join("\n"), /line-5/u);
  viewer.appendEvent(toolStart("next", "run_cmd", JSON.stringify({ cmd: "pwd" })));
  assert.match(viewer.render(140).join("\n"), /line-5/u);
  assert.deepEqual(viewer.getExpandedToolCallIds(), ["stable-id"]);
});

test("代码块与长段落的显示结果不丢失正文", () => {
  const paragraph = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage(paragraph)]);
  const body = viewer.render(24).slice(1, -1).join(" ");

  for (const word of paragraph.split(" ")) assert.match(body, new RegExp(`\\b${word}\\b`, "u"));
  assert.ok(viewer.render(24).slice(1, -1).filter((line) => line.trim().length > 0).length > 1);
});
