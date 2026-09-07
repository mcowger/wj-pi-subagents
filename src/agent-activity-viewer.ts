import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentLifecycleState } from "./agent-snapshot-codec.ts";
import {
  parseAgentActivityEvent,
  type SafeAgentActivityContentBlock,
  type SafeAgentActivityEvent,
} from "./rpc-bridge-event.ts";
import {
  displayWidth,
  renderFramedPanelLine,
  renderNarrowPanelLine,
  renderPanelRule,
  safeUiFact,
  truncateToDisplayWidth,
  type UiPanelLineStyle,
} from "./ui-surface.ts";

export { displayWidth } from "./ui-surface.ts";

const DEFAULT_VIEWER_VIEWPORT_HEIGHT = 20;
const DEFAULT_LAYOUT_WIDTH = 80;
const DEFAULT_TOOL_RESULT_COLLAPSE_LINES = 4;
const DEFAULT_TOOL_RESULT_COLLAPSE_CHARS = 240;
const DEFAULT_RENDER_THROTTLE_MS = 50;
const MAX_TOOL_SUMMARY_KEYS = 3;
const MAX_TOOL_SUMMARY_VALUE_CHARS = 96;
const MAX_TOOL_SUMMARY_WIDTH = 160;
const THINKING_LINE_PREFIX = "┆ ";
const EMPTY_ACTIVITY_TEXT = "No cached activity yet";
const VIEWER_HEADER_TEXT = "AGENT ACTIVITY";
const FOLLOWING_FOOTER_TEXT = "↑↓ scroll · Enter expand · Esc back";
const PAUSED_FOOTER_TEXT = "paused · ↓ resume · Enter expand · Esc back";
const RENDER_VIEWER_LINES = Symbol("renderViewerLines");
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[()][0-2])/gu;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;
const SUMMARY_OMIT_KEYS = /^(?:content|contents|body|text|data|payload|patch|stdout|stderr)$/iu;

const PLAIN_MARKDOWN_THEME: MarkdownTheme = Object.freeze({
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
});

export interface AgentActivityViewerAgent {
  readonly agent_id: string;
  readonly template_id: string;
  readonly name: string;
  readonly state: AgentLifecycleState;
}

export interface AgentActivityViewerOptions {
  /** 同时显示的活动正文行数，不包含标题和键位提示。 */
  readonly viewport_height?: number;
  /** 结果超过该行数后默认折叠。 */
  readonly tool_result_collapse_lines?: number;
  /** 结果超过该显示字符数后默认折叠。 */
  readonly tool_result_collapse_chars?: number;
  /** 显示层重绘请求的最小间隔；不影响模型接收完整事件。 */
  readonly render_throttle_ms?: number;
  /** 供测试或宿主注入单调时钟。 */
  readonly now?: () => number;
}

export type AgentActivityViewerInputOutcome = "changed" | "ignored" | "close";
export type AgentActivityViewerUpdateOutcome = "changed" | "ignored";

export interface AgentActivityViewerPublicState {
  readonly event_count: number;
  readonly scroll_offset: number;
  readonly follow_enabled: boolean;
  readonly lifecycle_state: AgentLifecycleState;
}

interface ViewerSemanticLine {
  readonly text: string;
  readonly style: UiPanelLineStyle;
  readonly expandable_tool_call_id?: string;
}

interface MessageDisplayEntry {
  readonly kind: "message";
  content: readonly SafeAgentActivityContentBlock[];
}

interface ToolDisplayEntry {
  readonly kind: "tool";
  readonly toolCallId: string;
  toolName: string;
  args: string | undefined;
  result: string | undefined;
  isError: boolean;
  hasResult: boolean;
}

type DisplayEntry = MessageDisplayEntry | ToolDisplayEntry;

/**
 * 活动查看器的纯交互投影：打开即消费一次全量回放，随后接受追加通知；
 * 自动跟随最新事件、向上滚动暂停、回到底部恢复。它只渲染到显示层，
 * 不向父会话发送消息或追加条目。
 */
export class AgentActivityViewerModel {
  private readonly agentId: string;
  private readonly templateId: string;
  private readonly name: string;
  private lifecycleState: AgentLifecycleState;
  private readonly events: SafeAgentActivityEvent[] = [];
  private readonly viewportHeight: number;
  private readonly collapseLines: number;
  private readonly collapseChars: number;
  private readonly renderThrottleMs: number;
  private readonly now: () => number;
  private readonly expandedToolCallIds = new Set<string>();
  private replayCursor = 0;
  private layoutWidth = DEFAULT_LAYOUT_WIDTH;
  private scrollOffset = 0;
  private followEnabled = true;
  private projectionRevision = 0;
  private cachedProjection: {
    readonly width: number;
    readonly revision: number;
    readonly lines: readonly ViewerSemanticLine[];
  } | undefined;
  private renderInvalidated = true;
  private lastPaintAt: number | undefined;
  private batching = false;

  constructor(
    agent: AgentActivityViewerAgent,
    replay: readonly SafeAgentActivityEvent[],
    options: AgentActivityViewerOptions = {},
  ) {
    this.agentId = agent.agent_id;
    this.templateId = agent.template_id;
    this.name = agent.name;
    this.lifecycleState = agent.state;
    this.viewportHeight = validViewportHeight(options.viewport_height);
    this.collapseLines = validPositiveOption(
      options.tool_result_collapse_lines,
      DEFAULT_TOOL_RESULT_COLLAPSE_LINES,
    );
    this.collapseChars = validPositiveOption(
      options.tool_result_collapse_chars,
      DEFAULT_TOOL_RESULT_COLLAPSE_CHARS,
    );
    this.renderThrottleMs = validNonNegativeOption(
      options.render_throttle_ms,
      DEFAULT_RENDER_THROTTLE_MS,
    );
    this.now = options.now ?? (() => Date.now());
    this.syncFrom(replay);
  }

  get agent_id(): string {
    return this.agentId;
  }

  /** 标题中的生命周期状态随树快照刷新；相同状态忽略。 */
  updateLifecycle(state: AgentLifecycleState): AgentActivityViewerUpdateOutcome {
    if (state === this.lifecycleState) return "ignored";
    this.lifecycleState = state;
    this.invalidateRender();
    return "changed";
  }

  /** 追加一条完整活动事件；违约或超限事件被静默拒绝。 */
  appendEvent(event: SafeAgentActivityEvent): AgentActivityViewerUpdateOutcome {
    const parsed = parseAgentActivityEvent(event);
    if (parsed.kind !== "event") return "ignored";
    this.events.push(parsed.event);
    this.projectionRevision += 1;
    this.cachedProjection = undefined;
    this.invalidateRender();
    if (!this.batching) this.settleFollow();
    return "changed";
  }

  /**
   * 以缓存全量回放对齐本地事件；只追加尚未落地的新到达部分。
   * 回放游标独立于事件数，因此被拒绝的输入不会跳过后续合法事件。
   */
  syncFrom(replay: readonly SafeAgentActivityEvent[]): AgentActivityViewerUpdateOutcome {
    if (replay.length < this.replayCursor) return "ignored";
    let start = this.replayCursor;
    if (this.events.length > start && this.replayPrefixMatches(replay)) start = this.events.length;
    let outcome: AgentActivityViewerUpdateOutcome = "ignored";
    this.batching = true;
    try {
      for (let index = start; index < replay.length; index += 1) {
        const event = replay[index];
        if (event !== undefined && this.appendEvent(event) === "changed") outcome = "changed";
      }
    } finally {
      this.batching = false;
    }
    if (outcome === "changed") this.settleFollow();
    this.replayCursor = replay.length;
    return outcome;
  }

  render(width: number): readonly string[] {
    return Object.freeze(this[RENDER_VIEWER_LINES](width).map((line) => line.text));
  }

  /**
   * 返回当前显示投影的重绘许可。快速追加只令该许可保持 pending，宿主可用
   * 定时器在许可变为 true 时请求一次 TUI 重绘；完整事件仍立即保存在模型中。
   */
  shouldRender(now = this.now()): boolean {
    if (!this.renderInvalidated) return false;
    const current = finiteTime(now, this.now());
    if (
      this.lastPaintAt !== undefined
      && current >= this.lastPaintAt
      && current - this.lastPaintAt < this.renderThrottleMs
    ) return false;
    this.renderInvalidated = false;
    this.lastPaintAt = current;
    return true;
  }

  /** 当前节流窗口，供 overlay 装配层安排下一次重绘。 */
  getRenderThrottleMs(): number {
    return this.renderThrottleMs;
  }

  /** 当前已展开的工具调用 ID；状态不随追加事件丢失。 */
  getExpandedToolCallIds(): readonly string[] {
    return Object.freeze([...this.expandedToolCallIds]);
  }

  /** 按工具调用 ID切换长结果展开状态。 */
  toggleToolResult(toolCallId: string): AgentActivityViewerUpdateOutcome {
    if (!this.hasExpandableToolResult(toolCallId)) return "ignored";
    const expanded = !this.expandedToolCallIds.has(toolCallId);
    return this.setToolResultExpanded(toolCallId, expanded);
  }

  /** 显式设置长结果展开状态，便于键盘之外的薄壳接线。 */
  setToolResultExpanded(
    toolCallId: string,
    expanded: boolean,
  ): AgentActivityViewerUpdateOutcome {
    if (!this.hasExpandableToolResult(toolCallId)) return "ignored";
    const alreadyExpanded = this.expandedToolCallIds.has(toolCallId);
    if (alreadyExpanded === expanded) return "ignored";
    if (expanded) this.expandedToolCallIds.add(toolCallId);
    else this.expandedToolCallIds.delete(toolCallId);
    this.projectionRevision += 1;
    this.cachedProjection = undefined;
    this.invalidateRender();
    this.settleFollow();
    return "changed";
  }

  [RENDER_VIEWER_LINES](width: number): readonly ViewerSemanticLine[] {
    const contentWidth = validRenderWidth(width);
    this.layoutWidth = contentWidth;
    const bodyLines = this.eventLines(contentWidth);
    const maxOffset = Math.max(0, bodyLines.length - this.viewportHeight);
    this.settleFollow(maxOffset);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);
    const identity = truncateToDisplayWidth(
      `${VIEWER_HEADER_TEXT} · ${safeUiFact(this.templateId)} · ${safeUiFact(this.name)} · ${this.lifecycleState}`,
      contentWidth,
    );
    const visible = bodyLines
      .slice(this.scrollOffset, this.scrollOffset + this.viewportHeight)
      .map((line) => Object.freeze({
        text: truncateToDisplayWidth(line.text, contentWidth),
        style: line.style,
        ...(line.expandable_tool_call_id === undefined
          ? {}
          : { expandable_tool_call_id: line.expandable_tool_call_id }),
      }));
    while (visible.length < this.viewportHeight) {
      visible.push(Object.freeze({ text: "", style: "body" as const }));
    }
    const footer = truncateToDisplayWidth(
      this.followEnabled ? FOLLOWING_FOOTER_TEXT : PAUSED_FOOTER_TEXT,
      contentWidth,
    );
    this.renderInvalidated = false;
    this.lastPaintAt = finiteTime(this.now(), Date.now());
    return Object.freeze([
      Object.freeze({ text: identity, style: "header" as const }),
      ...visible,
      Object.freeze({ text: footer, style: "footer" as const }),
    ]);
  }

  handleInput(data: string): AgentActivityViewerInputOutcome {
    if (data === "\x1b") return "close";
    if (data === "\r" || data === "\n" || data === " " || data === "\x1b[C" || data === "\x1b[D") {
      const target = this.findExpandableToolCall();
      if (target === undefined) return "ignored";
      if (data === "\x1b[C") return this.setToolResultExpanded(target, true);
      if (data === "\x1b[D") return this.setToolResultExpanded(target, false);
      return this.toggleToolResult(target);
    }

    const maxOffset = this.maxScrollOffset();
    if (this.followEnabled) this.scrollOffset = maxOffset;
    if (data === "\x1b[A" || data === "k") {
      if (this.scrollOffset <= 0) return "ignored";
      this.followEnabled = false;
      this.scrollOffset -= 1;
      this.invalidateRender();
      return "changed";
    }
    if (data === "\x1b[B" || data === "j") {
      if (this.scrollOffset >= maxOffset) return "ignored";
      this.scrollOffset += 1;
      if (this.scrollOffset >= maxOffset) this.followEnabled = true;
      this.invalidateRender();
      return "changed";
    }
    return "ignored";
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  getPublicState(): AgentActivityViewerPublicState {
    const maxOffset = this.maxScrollOffset();
    this.settleFollow(maxOffset);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);
    return Object.freeze({
      event_count: this.events.length,
      scroll_offset: this.scrollOffset,
      follow_enabled: this.followEnabled,
      lifecycle_state: this.lifecycleState,
    });
  }

  /** 跟随时视口始终对齐最新事件；暂停时保持用户当前回看位置。 */
  private settleFollow(maxOffset = this.maxScrollOffset()): void {
    if (this.followEnabled) this.scrollOffset = Math.max(0, maxOffset);
  }

  private maxScrollOffset(): number {
    return Math.max(0, this.eventLines(this.layoutWidth).length - this.viewportHeight);
  }

  private invalidateRender(): void {
    this.renderInvalidated = true;
  }

  private replayPrefixMatches(replay: readonly SafeAgentActivityEvent[]): boolean {
    if (this.events.length > replay.length) return false;
    for (let index = 0; index < this.events.length; index += 1) {
      const left = this.events[index];
      const right = replay[index];
      if (left === undefined || right === undefined || !sameEvent(left, right)) return false;
    }
    return true;
  }

  private findExpandableToolCall(): string | undefined {
    const lines = this.eventLines(this.layoutWidth);
    const visibleStart = this.scrollOffset;
    const visibleEnd = visibleStart + this.viewportHeight;
    const visible = lines.slice(visibleStart, visibleEnd).find((line) =>
      line.expandable_tool_call_id !== undefined
    );
    if (visible?.expandable_tool_call_id !== undefined) return visible.expandable_tool_call_id;
    const next = lines.slice(visibleEnd).find((line) => line.expandable_tool_call_id !== undefined);
    if (next?.expandable_tool_call_id !== undefined) return next.expandable_tool_call_id;
    let previous: ViewerSemanticLine | undefined;
    for (let index = Math.min(visibleStart, lines.length) - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (candidate?.expandable_tool_call_id !== undefined) {
        previous = candidate;
        break;
      }
    }
    return previous?.expandable_tool_call_id;
  }

  private hasExpandableToolResult(toolCallId: string): boolean {
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return false;
    return this.projectEntries().some((entry) =>
      entry.kind === "tool"
      && entry.toolCallId === toolCallId
      && entry.hasResult
      && this.isLongResult(entry.result ?? "")
    );
  }

  private isLongResult(result: string): boolean {
    const safe = sanitizeViewerMarkup(result);
    return safe.split("\n").length > this.collapseLines || displayWidth(safe) > this.collapseChars;
  }

  /** 将活动事件投影成消息与工具行；连续累计消息快照只保留最新显示版本。 */
  private projectEntries(): DisplayEntry[] {
    const entries: DisplayEntry[] = [];
    const activeTools = new Map<string, ToolDisplayEntry>();
    let lastMessage: MessageDisplayEntry | undefined;

    for (let index = 0; index < this.events.length; index += 1) {
      const event = this.events[index]!;
      if (event.type === "message") {
        if (lastMessage !== undefined && canMergeMessage(lastMessage.content, event.content)) {
          lastMessage.content = event.content;
        } else {
          lastMessage = { kind: "message", content: event.content };
          entries.push(lastMessage);
        }
        continue;
      }

      lastMessage = undefined;
      if (event.type === "tool_execution_start") {
        const entry: ToolDisplayEntry = {
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          result: undefined,
          isError: false,
          hasResult: false,
        };
        entries.push(entry);
        activeTools.set(event.toolCallId, entry);
        continue;
      }

      const existing = activeTools.get(event.toolCallId);
      if (existing === undefined) {
        const entry: ToolDisplayEntry = {
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: undefined,
          result: event.result,
          isError: event.isError === true,
          hasResult: true,
        };
        entries.push(entry);
        activeTools.set(event.toolCallId, entry);
      } else {
        existing.toolName = event.toolName;
        existing.result = event.result;
        existing.isError = event.isError === true;
        existing.hasResult = true;
      }
    }
    return entries;
  }

  /** 把活动事件闭集渲染为语义行；事件数为零时给出明确空态。 */
  private eventLines(width: number): readonly ViewerSemanticLine[] {
    const contentWidth = validRenderWidth(width);
    if (
      this.cachedProjection !== undefined
      && this.cachedProjection.width === contentWidth
      && this.cachedProjection.revision === this.projectionRevision
    ) return this.cachedProjection.lines;

    if (this.events.length === 0) {
      const empty = Object.freeze([{ text: EMPTY_ACTIVITY_TEXT, style: "body" as const }]);
      this.cachedProjection = { width: contentWidth, revision: this.projectionRevision, lines: empty };
      return empty;
    }

    const lines: ViewerSemanticLine[] = [];
    for (const entry of this.projectEntries()) {
      if (entry.kind === "message") {
        for (const block of entry.content) {
          const raw = block.type === "text" ? block.text : block.thinking;
          const prefix = block.type === "thinking" ? THINKING_LINE_PREFIX : "";
          lines.push(...renderMarkdownBlock(
            raw,
            contentWidth,
            prefix,
            block.type === "thinking" ? "terminal" : "body",
          ));
        }
        continue;
      }

      const args = summarizeToolArguments(entry.args);
      lines.push(Object.freeze({
        text: `▶ ${safeUiFact(entry.toolName)}${args.length === 0 ? "" : ` · ${args}`}`,
        style: "body" as const,
      }));
      if (!entry.hasResult) continue;

      const result = sanitizeViewerMarkup(entry.result ?? "");
      const long = this.isLongResult(result);
      if (long && !this.expandedToolCallIds.has(entry.toolCallId)) {
        const count = result.split("\n").length;
        lines.push(Object.freeze({
          text: `${entry.isError ? "×" : "✓"} ${safeUiFact(entry.toolName)} · result collapsed (${count} lines; Enter to expand)`,
          style: entry.isError ? "error" : "footer",
          expandable_tool_call_id: entry.toolCallId,
        }));
        continue;
      }

      lines.push(...renderToolResult(
        entry,
        result,
        contentWidth,
        long ? entry.toolCallId : undefined,
      ));
    }

    const frozen = Object.freeze(lines.map((line) => Object.freeze(line)));
    this.cachedProjection = { width: contentWidth, revision: this.projectionRevision, lines: frozen };
    return frozen;
  }
}

/** 将纯查看器投影包装成完整主题表面，避免 overlay 内部继续透出底层会话内容。 */
export function renderAgentActivityViewerSurface(
  model: AgentActivityViewerModel | undefined,
  width: number,
  theme: unknown,
): readonly string[] {
  const panelWidth = Number.isSafeInteger(width) && width > 0 ? width : 0;
  if (panelWidth === 0) return Object.freeze([]);
  const framed = panelWidth >= 6;
  const contentWidth = framed ? panelWidth - 4 : panelWidth;
  const semanticLines = model === undefined
    ? unavailableViewerLines(contentWidth)
    : model[RENDER_VIEWER_LINES](contentWidth);
  const header = semanticLines[0]?.text ?? "";
  const footer = semanticLines.at(-1)?.text ?? "";
  const body = semanticLines.slice(1, -1);

  if (!framed) {
    return Object.freeze([
      renderNarrowPanelLine(header, panelWidth, "header", false, theme),
      ...body.map((line) => renderNarrowPanelLine(
        line.text,
        panelWidth,
        line.style,
        false,
        theme,
      )),
      renderNarrowPanelLine(footer, panelWidth, "footer", false, theme),
    ]);
  }

  return Object.freeze([
    renderPanelRule(panelWidth, "top", theme),
    renderFramedPanelLine(header, contentWidth, "header", false, theme),
    renderPanelRule(panelWidth, "divider", theme),
    ...body.map((line) => renderFramedPanelLine(
      line.text,
      contentWidth,
      line.style,
      false,
      theme,
    )),
    renderPanelRule(panelWidth, "divider", theme),
    renderFramedPanelLine(footer, contentWidth, "footer", false, theme),
    renderPanelRule(panelWidth, "bottom", theme),
  ]);
}

function unavailableViewerLines(width: number): readonly ViewerSemanticLine[] {
  const lines: ViewerSemanticLine[] = [
    { text: truncateToDisplayWidth(`${VIEWER_HEADER_TEXT} · temporarily unavailable`, width), style: "header" },
  ];
  while (lines.length < DEFAULT_VIEWER_VIEWPORT_HEIGHT + 1) lines.push({ text: "", style: "body" });
  lines.push({ text: truncateToDisplayWidth("Esc back", width), style: "footer" });
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}

function renderMarkdownBlock(
  raw: string,
  width: number,
  prefix: string,
  style: UiPanelLineStyle,
): readonly ViewerSemanticLine[] {
  const safe = sanitizeViewerMarkup(raw);
  if (safe.length === 0) return Object.freeze([]);
  const availableWidth = Math.max(1, width - displayWidth(prefix));
  let rendered: readonly string[];
  try {
    rendered = new Markdown(safe, 0, 0, PLAIN_MARKDOWN_THEME).render(availableWidth);
  } catch {
    rendered = wrapPlainText(safe, availableWidth);
  }
  const lines = rendered.map((line) => {
    const clean = sanitizeViewerMarkup(line).replace(/[ \t]+$/u, "");
    return Object.freeze({ text: `${prefix}${clean}`, style });
  });
  return Object.freeze(lines);
}

function renderToolResult(
  entry: ToolDisplayEntry,
  result: string,
  width: number,
  expandableToolCallId?: string,
): readonly ViewerSemanticLine[] {
  const marker = entry.isError ? "×" : "✓";
  const style: UiPanelLineStyle = entry.isError ? "error" : "terminal";
  if (result.length === 0) {
    return Object.freeze([{ text: `${marker} ${safeUiFact(entry.toolName)}`, style }]);
  }
  const wrapped = result
    .split("\n")
    .flatMap((line) => wrapPlainLine(line, Math.max(1, width - 2)));
  const first = wrapped[0] ?? "";
  const lines: ViewerSemanticLine[] = [{
    text: `${marker} ${safeUiFact(entry.toolName)}${first.length === 0 ? "" : ` · ${first}`}`,
    style,
    ...(expandableToolCallId === undefined ? {} : { expandable_tool_call_id: expandableToolCallId }),
  }];
  for (const line of wrapped.slice(1)) lines.push({ text: `  ${line}`, style });
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}

function summarizeToolArguments(raw: string | undefined): string {
  if (raw === undefined) return "";
  const safe = sanitizeViewerMarkup(raw);
  if (safe.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(safe);
  } catch {
    return truncateToDisplayWidth(safeUiFact(safe), MAX_TOOL_SUMMARY_WIDTH);
  }
  if (!isRecord(parsed)) return truncateToDisplayWidth(formatSummaryValue(parsed) ?? safeUiFact(safe), MAX_TOOL_SUMMARY_WIDTH);

  const entries = Object.entries(parsed);
  const shown: string[] = [];
  let omitted = 0;
  const ordered = [...entries].sort(([left], [right]) => summaryKeyRank(left) - summaryKeyRank(right));
  for (const [key, value] of ordered) {
    const formatted = formatSummaryValue(value);
    if (formatted === undefined || (SUMMARY_OMIT_KEYS.test(key) && isVerboseSummaryValue(value))) {
      omitted += 1;
      continue;
    }
    shown.push(`${safeUiFact(key)}=${formatted}`);
    if (shown.length >= MAX_TOOL_SUMMARY_KEYS) break;
  }
  omitted += Math.max(0, ordered.length - shown.length - omitted);
  if (shown.length === 0) return entries.length === 0 ? "{}" : `{${entries.length} keys}`;
  if (omitted > 0) shown.push(`+${omitted} more`);
  return truncateToDisplayWidth(shown.join(" · "), MAX_TOOL_SUMMARY_WIDTH);
}

function formatSummaryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const safe = safeUiFact(sanitizeViewerMarkup(value));
    if (safe.length > MAX_TOOL_SUMMARY_VALUE_CHARS) return undefined;
    return safe.includes(" ") ? JSON.stringify(safe) : safe;
  }
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (isRecord(value)) return `{${Object.keys(value).length} keys}`;
  return undefined;
}

function isVerboseSummaryValue(value: unknown): boolean {
  return typeof value === "string" && value.length > 24;
}

function summaryKeyRank(key: string): number {
  const rank = [
    "path", "file_path", "command", "cmd", "query", "pattern", "url", "agent_id",
    "agent_ids", "template_id", "name", "cwd", "recursive",
  ].indexOf(key);
  return rank < 0 ? 100 : rank;
}

function canMergeMessage(
  previous: readonly SafeAgentActivityContentBlock[],
  next: readonly SafeAgentActivityContentBlock[],
): boolean {
  if (previous.length !== next.length || previous.length === 0) return false;
  const previousText = contentSignature(previous);
  const nextText = contentSignature(next);
  return previousText === nextText || nextText.startsWith(previousText) || previousText.startsWith(nextText);
}

function contentSignature(content: readonly SafeAgentActivityContentBlock[]): string {
  return content.map((block) => `${block.type}\u0000${block.type === "text" ? block.text : block.thinking}`).join("\u0001");
}

function wrapPlainText(value: string, width: number): readonly string[] {
  return Object.freeze(value.split("\n").flatMap((line) => wrapPlainLine(line, width)));
}

function wrapPlainLine(value: string, width: number): string[] {
  const normalized = value.replace(/\t/gu, "   ");
  if (displayWidth(normalized) <= width) return [normalized];
  const output: string[] = [];
  let remaining = normalized;
  while (displayWidth(remaining) > width) {
    const segments = [...SEGMENTER.segment(remaining)];
    let used = 0;
    let cut = 0;
    for (const segment of segments) {
      const segmentWidth = displayWidth(segment.segment);
      if (cut > 0 && used + segmentWidth > width) break;
      if (cut === 0 && segmentWidth > width) {
        cut = segment.segment.length;
        used = segmentWidth;
        break;
      }
      used += segmentWidth;
      cut += segment.segment.length;
    }
    if (cut <= 0) break;
    let breakAt = -1;
    for (let index = 0; index < cut; index += 1) {
      if (/\s/u.test(remaining[index] ?? "")) breakAt = index;
    }
    if (breakAt > 0) {
      output.push(remaining.slice(0, breakAt).trimEnd());
      let next = breakAt + 1;
      while (/\s/u.test(remaining[next] ?? "")) next += 1;
      remaining = remaining.slice(next);
    } else {
      output.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
  }
  output.push(remaining);
  return output;
}

function sanitizeViewerMarkup(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(UNSAFE_CONTROL_PATTERN, " ");
}

function sameEvent(left: SafeAgentActivityEvent, right: SafeAgentActivityEvent): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validViewportHeight(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : DEFAULT_VIEWER_VIEWPORT_HEIGHT;
}

function validRenderWidth(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function validPositiveOption(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function validNonNegativeOption(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? value! : fallback;
}

function finiteTime(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function identity(text: string): string {
  return text;
}
