import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentActivityViewerModel,
  displayWidth,
  renderAgentActivityViewerSurface,
} from "../src/agent-activity-viewer.ts";
import type { SafeAgentActivityEvent } from "../src/rpc-bridge-event.ts";
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
