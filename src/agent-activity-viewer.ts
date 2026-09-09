import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentLifecycleState } from "./agent-snapshot-codec.ts";
import {
  isMessageToolSummary,
  sanitizeSafeActivityText,
  type SafeAgentActivityContentBlock,
  type SafeToolOrigin,
  type SafeToolSummary,
} from "./rpc-bridge-event.ts";
import type { AgentDisplayDraftView } from "./agent-display-drafts.ts";
import type { CanonicalAgentActivityEntry } from "./canonical-activity.ts";
import {
  displayWidth,
  renderFramedPanelLine,
  renderNarrowPanelLine,
  renderPanelRule,
  safeUiFact,
  stylePanelText,
  themeBg,
  themeBold,
  themeFg,
  truncateToDisplayWidth,
  type UiPanelLineStyle,
} from "./ui-surface.ts";

export { displayWidth } from "./ui-surface.ts";

const DEFAULT_VIEWER_VIEWPORT_HEIGHT = 20;
const DEFAULT_LAYOUT_WIDTH = 80;
const THINKING_COLLAPSED_TEXT = "Thinking";
/** 流式 thinking 的折叠标题：完整权威消息到达后恢复普通 `Thinking`。 */
const THINKING_STREAMING_TEXT = "Thinking · streaming";
/** 冻结流的折叠标题：异常乱序冻结后等待权威完整消息。 */
const THINKING_FROZEN_TEXT = "Thinking · streaming incomplete";
/** 冻结草稿末尾的弱化省略号：实时预览不完整的显示事实。 */
const FROZEN_DRAFT_ELLIPSIS = "…";
const EMPTY_ACTIVITY_TEXT = "No cached activity yet";
const VIEWER_HEADER_TEXT = "AGENT ACTIVITY";
const VIEWER_FOOTER_TEXT = "↑↓ scroll · Tab/Shift+Tab select · Enter expand · Esc back";
const RENDER_VIEWER_LINES = Symbol("renderViewerLines");
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
  /** 打开时的初始实时草稿快照；后续通过 setLiveDrafts 持续替换。 */
  readonly drafts?: readonly AgentDisplayDraftView[];
}

export type AgentActivityViewerInputOutcome = "changed" | "ignored" | "close";
export type AgentActivityViewerUpdateOutcome = "changed" | "ignored";

export interface AgentActivityViewerPublicState {
  readonly event_count: number;
  readonly scroll_offset: number;
  readonly max_scroll_offset: number;
  readonly follow_enabled: boolean;
  readonly lifecycle_state: AgentLifecycleState;
  readonly selected_key: string | undefined;
}

interface ViewerStatusTail {
  readonly text: string;
  readonly style: UiPanelLineStyle;
}

interface ViewerSemanticLine {
  readonly text: string;
  readonly style: UiPanelLineStyle;
  /** 可展开条目身份；选中背景只作用于该标题行。 */
  readonly selectable_key?: string;
  /** 该行是否为当前选中条目；仅渲染层消费。 */
  readonly selected?: boolean;
  /** 标题使用粗体强调色；状态尾标仍按自身状态色渲染。 */
  readonly emphasized_title?: boolean;
  /** 位于标题右侧的工具状态图标及其独立颜色。 */
  readonly status_tail?: ViewerStatusTail;
  /** 行尾局部错误片段：仅该片段使用错误色，其余保持行样式。 */
  readonly error_tail?: string;
}

/**
 * 工具活动的运行状态。完成态不可退回运行中；unavailable/terminated 是生命
 * 周期收束语义，仍可被身份匹配的结束事实回填为真实结果。
 */
type ToolRunState =
  | { readonly phase: "running" }
  | { readonly phase: "success" }
  | { readonly phase: "failure" }
  | { readonly phase: "unavailable" }
  | { readonly phase: "terminated" };

interface ToolDisplayEntry {
  readonly kind: "tool";
  /** 条目身份：工具附属正文使用的稳定可展开键。 */
  readonly entryId: string;
  /** 运行实例身份；与工具活动 ID、执行代次共同承担回填匹配职责。 */
  readonly incarnationId: string;
  readonly toolCallId: string;
  /**
   * 执行代次：同身份与活动 ID 的重新发起会递增；本状态机对“完成后迟到
   * 开始”的忽略规则使每个已确立条目的代次固定为首次发起代。
   */
  readonly generation: number;
  toolName: string;
  origin: SafeToolOrigin;
  state: ToolRunState;
  /** 专用摘要：只有来源验证通过的专用工具携带；结束事实覆盖开始。 */
  summary: SafeToolSummary | undefined;
  /** 失败事实自包含的完整错误正文（已净化）；默认折叠，展开后红色显示。 */
  errorText: string | undefined;
  /** 插件工具失败事实的规范稳定错误码；追加在摘要行尾。 */
  errorCode: string | undefined;
}

/**
 * 标题使用统一展开标记和强调样式，工具状态图标固定在标题右侧。状态视觉为：
 * 运行中 `↻` 强调色、成功 `✓` 弱化色、失败 `×` 错误色；收束警告与
 * terminated 继续保留各自语义。
 */
const TOOL_STATE_VISUALS: Readonly<Record<ToolRunState["phase"], {
  readonly icon: string;
  readonly style: UiPanelLineStyle;
  readonly suffix?: string;
}>> = Object.freeze({
  running: Object.freeze({ icon: "↻", style: "accent" as const }),
  success: Object.freeze({ icon: "✓", style: "terminal" as const }),
  failure: Object.freeze({ icon: "×", style: "error" as const }),
  unavailable: Object.freeze({ icon: "⚠", style: "warning" as const, suffix: "result unavailable" }),
  terminated: Object.freeze({
    icon: "○",
    style: "terminal" as const,
    suffix: "terminated before result",
  }),
});

/** terminate_agent 强制回收成功：警告而非失败，成功结果与风险事实同时保留。 */
const TOOL_FORCED_VISUAL = Object.freeze({ icon: "⚠", style: "warning" as const });

/**
 * 工具条目的显示视觉。运行状态机语义不变；只有来源验证通过的专用摘要在
 * 成功事实携带特殊控制事实时覆盖显示：wait_agent 观察到目标 state failed
 * 的成功调用显示红色失败，terminate_agent 强制回收成功显示警告。
 */
function toolDisplayVisual(entry: ToolDisplayEntry): {
  readonly icon: string;
  readonly style: UiPanelLineStyle;
  readonly suffix?: string;
} {
  const base = TOOL_STATE_VISUALS[entry.state.phase];
  const summary = entry.summary;
  if (entry.state.phase !== "success" || summary === undefined) return base;
  if (summary.tool === "wait_agent" && summary.state === "failed") {
    return TOOL_STATE_VISUALS.failure;
  }
  if (summary.tool === "terminate_agent" && summary.forced === true) {
    return TOOL_FORCED_VISUAL;
  }
  return base;
}

/**
 * 可展开条目身份：规范条目内的 thinking 组使用条目身份加块序号；工具错误
 * 正文与消息正文使用独立前缀；父代理消息与实时草稿使用独立前缀。身份跨
 * 重绘稳定。
 */
function thinkingKey(entryId: string, blockIndex: number): string {
  return `thinking:${entryId}:${blockIndex}`;
}

function toolErrorKey(entryId: string): string {
  return `tool-error:${entryId}`;
}

function toolMessageKey(entryId: string): string {
  return `tool-message:${entryId}`;
}

function toolCommandKey(entryId: string): string {
  return `tool-command:${entryId}`;
}

function parentMessageKey(entryId: string): string {
  return `parent-message:${entryId}`;
}

function liveThinkingKey(draftKey: string, contentIndex: number): string {
  return `thinking:live:${draftKey}:${contentIndex}`;
}

/**
 * 活动查看器的纯交互投影：打开即消费一次全量回放，随后接受追加通知。
 * text 块独立完整渲染；thinking 默认折叠；Tab/Shift+Tab 在全部可展开
 * 条目间循环选择；展开暂停自动跟随。它只渲染到显示层，不向父会话发送
 * 消息或追加条目。
 */
export class AgentActivityViewerModel {
  private readonly agentId: string;
  private readonly templateId: string;
  private readonly name: string;
  private lifecycleState: AgentLifecycleState;
  private readonly entries: CanonicalAgentActivityEntry[] = [];
  /**
   * 顶层草稿登记表的快照：从 sequence 1 开始的连续前缀。它只渲染到显示层，
   * 不进入回放、事件数或父端缓存；由 setLiveDrafts 整体替换保持单一事实源。
   */
  private liveDrafts: readonly AgentDisplayDraftView[] = Object.freeze([]);
  private readonly viewportHeight: number;
  private readonly expandedKeys = new Set<string>();
  private selectedKey: string | undefined;
  private replayCursor = 0;
  private layoutWidth = DEFAULT_LAYOUT_WIDTH;
  private scrollOffset = 0;
  private followEnabled = true;
  private projectionRevision = 0;
  /** 最近一次进入的收束型生命周期事实；收束不可逆，不随 working 回退。 */
  private settledLifecycle: "idle" | "failed" | "terminated" | undefined;
  private cachedProjection: {
    readonly width: number;
    readonly revision: number;
    readonly lines: readonly ViewerSemanticLine[];
  } | undefined;
  private batching = false;

  constructor(
    agent: AgentActivityViewerAgent,
    replay: readonly CanonicalAgentActivityEntry[],
    options: AgentActivityViewerOptions = {},
  ) {
    this.agentId = agent.agent_id;
    this.templateId = agent.template_id;
    this.name = agent.name;
    this.lifecycleState = agent.state;
    if (agent.state === "idle" || agent.state === "failed" || agent.state === "terminated") {
      this.settledLifecycle = agent.state;
    }
    this.viewportHeight = validViewportHeight(options.viewport_height);
    this.syncFrom(replay);
    this.setLiveDrafts(options.drafts ?? []);
    this.initializeSelection();
  }

  get agent_id(): string {
    return this.agentId;
  }

  /** 标题中的生命周期状态随树快照刷新；相同状态忽略。 */
  updateLifecycle(state: AgentLifecycleState): AgentActivityViewerUpdateOutcome {
    if (state === this.lifecycleState) return "ignored";
    this.lifecycleState = state;
    // 收束事实一旦发生即不可逆；之后回到 working 也不解除已收束条目。
    if (state === "idle" || state === "failed" || state === "terminated") {
      this.settledLifecycle = state;
    }
    this.touchProjection();
    return "changed";
  }

  /** 追加一条规范活动条目；条目身份与正文闭集由上游 seam 保证。 */
  appendEntry(entry: CanonicalAgentActivityEntry): AgentActivityViewerUpdateOutcome {
    this.entries.push(entry);
    this.projectionRevision += 1;
    this.cachedProjection = undefined;
    if (!this.batching) this.settleFollow();
    return "changed";
  }

  /**
   * 以缓存全量回放对齐本地条目；只追加尚未落地的新到达部分。
   * 回放游标独立于条目数，因此被拒绝的输入不会跳过后续合法条目。
   */
  syncFrom(replay: readonly CanonicalAgentActivityEntry[]): AgentActivityViewerUpdateOutcome {
    if (replay.length < this.replayCursor) return "ignored";
    let start = this.replayCursor;
    if (this.entries.length > start && this.replayPrefixMatches(replay)) start = this.entries.length;
    let outcome: AgentActivityViewerUpdateOutcome = "ignored";
    this.batching = true;
    try {
      for (let index = start; index < replay.length; index += 1) {
        const entry = replay[index];
        if (entry !== undefined && this.appendEntry(entry) === "changed") outcome = "changed";
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
   * 以顶层草稿登记表的最新快照替换本投影的实时草稿。登记表是唯一事实源：
   * 查看 detail 打开时立即看到当前连续前缀，期间到达的新帧经登记表应用后
   * 再以快照形式到达这里。草稿增长与普通追加一样服从 follow 规则。
   */
  setLiveDrafts(drafts: readonly AgentDisplayDraftView[]): AgentActivityViewerUpdateOutcome {
    this.liveDrafts = Object.freeze([...drafts]);
    this.touchProjection();
    if (!this.batching) this.settleFollow();
    return "changed";
  }

  /** 当前选中的可展开条目身份；打开时由视口最新可展开项初始化。 */
  getSelectedKey(): string | undefined {
    return this.selectedKey;
  }

  /** 当前处于展开状态的可展开条目身份集合。 */
  getExpandedKeys(): readonly string[] {
    return Object.freeze([...this.expandedKeys]);
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
        selected: line.selectable_key !== undefined && line.selectable_key === this.selectedKey,
        ...(line.emphasized_title === undefined
          ? {}
          : { emphasized_title: line.emphasized_title }),
        ...(line.status_tail === undefined ? {} : { status_tail: line.status_tail }),
        ...(line.error_tail === undefined ? {} : { error_tail: line.error_tail }),
      }));
    while (visible.length < this.viewportHeight) {
      visible.push(Object.freeze({ text: "", style: "body" as const, selected: false }));
    }
    const footer = truncateToDisplayWidth(VIEWER_FOOTER_TEXT, contentWidth);
    return Object.freeze([
      Object.freeze({ text: identity, style: "header" as const, selected: false }),
      ...visible,
      Object.freeze({ text: footer, style: "footer" as const, selected: false }),
    ]);
  }
  handleInput(data: string): AgentActivityViewerInputOutcome {
    if (data === "\x1b") return "close";
    if (data === "\t") return this.moveSelection(1);
    if (data === "\x1b[Z") return this.moveSelection(-1);
    if (data === "\r" || data === "\n" || data === " ") return this.toggleSelectedKey();
    if (data === "\x1b[C") return this.setSelectedExpansion(true);
    if (data === "\x1b[D") return this.setSelectedExpansion(false);

    const maxOffset = this.maxScrollOffset();
    if (this.followEnabled) this.scrollOffset = maxOffset;
    if (data === "\x1b[A" || data === "k") {
      if (this.scrollOffset <= 0) return "ignored";
      this.followEnabled = false;
      this.scrollOffset -= 1;
      return "changed";
    }
    if (data === "\x1b[B" || data === "j") {
      if (this.scrollOffset >= maxOffset) return "ignored";
      this.scrollOffset += 1;
      if (this.scrollOffset >= maxOffset) this.followEnabled = true;
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
      event_count: this.entries.length,
      scroll_offset: this.scrollOffset,
      max_scroll_offset: maxOffset,
      follow_enabled: this.followEnabled,
      lifecycle_state: this.lifecycleState,
      selected_key: this.selectedKey,
    });
  }

  /** 跟随时视口始终对齐最新条目；暂停时保持用户当前回看位置。 */
  private settleFollow(maxOffset = this.maxScrollOffset()): void {
    if (this.followEnabled) this.scrollOffset = Math.max(0, maxOffset);
  }

  private maxScrollOffset(): number {
    return Math.max(0, this.eventLines(this.layoutWidth).length - this.viewportHeight);
  }

  private touchProjection(): void {
    this.projectionRevision += 1;
    this.cachedProjection = undefined;
  }

  /** 打开时选择当前视口中最新的可展开项；没有可展开项时不建立虚假选择。 */
  private initializeSelection(): void {
    const lines = this.eventLines(this.layoutWidth);
    const viewportStart = Math.max(0, lines.length - this.viewportHeight);
    for (let index = lines.length - 1; index >= viewportStart; index -= 1) {
      const key = lines[index]?.selectable_key;
      if (key !== undefined) {
        this.selectedKey = key;
        return;
      }
    }
    this.selectedKey = undefined;
  }

  /** Tab/Shift+Tab 循环选择；Tab 回到最新条目时恢复自动跟随。 */
  private moveSelection(direction: 1 | -1): AgentActivityViewerInputOutcome {
    const keys = this.selectableKeys();
    if (keys.length === 0) return "ignored";
    const latest = keys.at(-1);
    let next: string | undefined;
    if (this.selectedKey === undefined || !keys.includes(this.selectedKey)) {
      next = direction === 1 ? keys[0] : latest;
    } else {
      const index = keys.indexOf(this.selectedKey);
      next = keys[(index + direction + keys.length) % keys.length];
    }
    if (next === undefined) return "ignored";
    this.selectedKey = next;
    this.followEnabled = next === latest;
    this.ensureLineVisible(next);
    return "changed";
  }

  private selectableKeys(): readonly string[] {
    const lines = this.eventLines(this.layoutWidth);
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const line of lines) {
      if (line.selectable_key !== undefined && !seen.has(line.selectable_key)) {
        seen.add(line.selectable_key);
        keys.push(line.selectable_key);
      }
    }
    return keys;
  }

  /** 视口外目标只触发使其刚好可见的最小滚动。 */
  private ensureLineVisible(key: string): void {
    const lines = this.eventLines(this.layoutWidth);
    const index = lines.findIndex((line) => line.selectable_key === key);
    if (index < 0) return;
    if (index < this.scrollOffset) {
      this.scrollOffset = index;
      return;
    }
    if (index >= this.scrollOffset + this.viewportHeight) {
      this.scrollOffset = index - this.viewportHeight + 1;
    }
  }

  private toggleSelectedKey(): AgentActivityViewerInputOutcome {
    if (this.selectedKey === undefined) return "ignored";
    return this.setKeyExpanded(this.selectedKey, !this.expandedKeys.has(this.selectedKey));
  }

  private setSelectedExpansion(expanded: boolean): AgentActivityViewerInputOutcome {
    if (this.selectedKey === undefined) return "ignored";
    if (this.expandedKeys.has(this.selectedKey) === expanded) return "ignored";
    return this.setKeyExpanded(this.selectedKey, expanded);
  }

  private setKeyExpanded(key: string, expanded: boolean): AgentActivityViewerInputOutcome {
    if (!this.isExpandableKey(key)) return "ignored";
    if (expanded) {
      this.expandedKeys.add(key);
      // 展开保持当前屏幕位置并暂停自动跟随；折叠不自动恢复。
      this.followEnabled = false;
    } else {
      this.expandedKeys.delete(key);
    }
    this.touchProjection();
    this.settleFollow();
    return "changed";
  }

  private isExpandableKey(key: string): boolean {
    if (typeof key !== "string" || key.length === 0) return false;
    return key.startsWith("thinking:")
      || key.startsWith("tool-error:")
      || key.startsWith("tool-message:")
      || key.startsWith("tool-command:")
      || key.startsWith("parent-message:");
  }

  private replayPrefixMatches(replay: readonly CanonicalAgentActivityEntry[]): boolean {
    if (this.entries.length > replay.length) return false;
    for (let index = 0; index < this.entries.length; index += 1) {
      const left = this.entries[index];
      const right = replay[index];
      if (left === undefined || right === undefined || !sameEntry(left, right)) return false;
    }
    return true;
  }

  /**
   * 将规范条目重放为显示条目。工具开始/结束按稳定调用身份合并为同一原子
   * 条目：结束先到或开始缺失时自建完成条目；重复与迟到事实幂等；完成态
   * 不可退回运行中。重放后仍运行中的工具按当前生命周期收束。
   */
  private projectEntries(): DisplayEntry[] {
    const entries: DisplayEntry[] = [];
    const toolIndex = new Map<string, ToolDisplayEntry>();

    for (const entry of this.entries) {
      const body = entry.body;
      if (body.type === "message") {
        entries.push({ kind: "message", entryId: entry.entry_id, content: body.content });
        continue;
      }

      if (body.type === "parent_message") {
        // 接收侧实际接纳的父代理输入；未接纳输入不产生该条目。
        entries.push({ kind: "parent_message", entryId: entry.entry_id, content: body.content });
        continue;
      }

      if (body.type === "tool_execution_start") {
        // 关联身份 = 运行实例 + 工具活动 ID + 执行代次：重复开始与完成后
        // 迟到开始都幂等忽略；完成态不退回运行中。
        const identity = `${entry.incarnation_id}:${body.toolCallId}`;
        if (toolIndex.has(identity)) continue;
        const tool: ToolDisplayEntry = {
          kind: "tool",
          entryId: entry.entry_id,
          incarnationId: entry.incarnation_id,
          toolCallId: body.toolCallId,
          generation: 1,
          toolName: body.toolName,
          origin: body.origin,
          state: { phase: "running" },
          summary: body.summary,
          errorText: undefined,
          errorCode: undefined,
        };
        entries.push(tool);
        toolIndex.set(identity, tool);
        continue;
      }

      // 结束事实自包含状态与摘要：开始缺失时仍建立完成条目。只有运行实例、
      // 活动 ID 与代次都匹配的结束事实才能更新或回填既有条目。
      const identity = `${entry.incarnation_id}:${body.toolCallId}`;
      const existing = toolIndex.get(identity);
      const state: ToolRunState = body.isError ? { phase: "failure" } : { phase: "success" };
      if (existing === undefined) {
        const tool: ToolDisplayEntry = {
          kind: "tool",
          entryId: entry.entry_id,
          incarnationId: entry.incarnation_id,
          toolCallId: body.toolCallId,
          generation: 1,
          toolName: body.toolName,
          origin: body.origin,
          state,
          summary: body.summary,
          errorText: body.errorText,
          errorCode: body.errorCode,
        };
        entries.push(tool);
        toolIndex.set(identity, tool);
        continue;
      }
      // 匹配结束原地更新（幂等或回填），绝不退回运行中；结束事实携带更
      // 完整的摘要与错误正文，覆盖开始事实的输入参数摘要。
      existing.toolName = body.toolName;
      existing.origin = body.origin;
      existing.state = state;
      existing.summary = body.summary;
      existing.errorText = body.errorText;
      existing.errorCode = body.errorCode;
    }

    if (toolIndex.size > 0) {
      const settlement = this.settledLifecycle
        ?? (this.lifecycleState === "idle" || this.lifecycleState === "failed" || this.lifecycleState === "terminated"
          ? this.lifecycleState
          : undefined);
      if (settlement !== undefined) {
        for (const tool of toolIndex.values()) {
          if (tool.state.phase !== "running") continue;
          // 代理进入终态时收束仍运行中的工具；后续匹配结束事实可回填。
          if (settlement === "idle") tool.state = { phase: "unavailable" };
          else if (settlement === "failed") tool.state = { phase: "failure" };
          else tool.state = { phase: "terminated" };
        }
      }
    }
    for (const draft of this.liveDrafts) {
      if (draft.blocks.length === 0) continue;
      entries.push({ kind: "live", draft });
    }
    return entries;
  }

  /** 把规范条目闭集渲染为语义行；条目数为零时给出明确空态。 */
  private eventLines(width: number): readonly ViewerSemanticLine[] {
    const contentWidth = validRenderWidth(width);
    if (
      this.cachedProjection !== undefined
      && this.cachedProjection.width === contentWidth
      && this.cachedProjection.revision === this.projectionRevision
    ) return this.cachedProjection.lines;

    if (this.entries.length === 0 && this.liveDrafts.every((draft) => draft.blocks.length === 0)) {
      const empty = Object.freeze([{ text: EMPTY_ACTIVITY_TEXT, style: "body" as const }]);
      this.cachedProjection = { width: contentWidth, revision: this.projectionRevision, lines: empty };
      return empty;
    }

    const lines: ViewerSemanticLine[] = [];
    for (const entry of this.projectEntries()) {
      if (entry.kind === "message") {
        let blockIndex = 0;
        for (const block of entry.content) {
          if (block.type === "text") {
            lines.push(...renderMarkdownBlock(block.text, contentWidth, "body"));
          } else {
            lines.push(...renderThinkingBlock(
              block.thinking,
              contentWidth,
              thinkingKey(entry.entryId, blockIndex),
              this.expandedKeys.has(thinkingKey(entry.entryId, blockIndex)),
            ));
          }
          blockIndex += 1;
        }
        continue;
      }

      if (entry.kind === "parent_message") {
        lines.push(...renderParentMessageBlock(
          entry.content,
          contentWidth,
          parentMessageKey(entry.entryId),
          this.expandedKeys.has(parentMessageKey(entry.entryId)),
        ));
        continue;
      }

      if (entry.kind === "live") {
        renderLiveDraft(entry.draft, contentWidth, this.expandedKeys, lines);
        continue;
      }

      const visual = toolDisplayVisual(entry);
      // 工具摘要统一作为标题：可展开项以 ▸/▾ 开头，状态图标位于右侧。
      // Shell 只展开完整 command；即使收到违约错误正文也不显示输出或退出信息。
      if (entry.summary !== undefined) {
        const shell = entry.summary.tool === "bash" || entry.summary.tool === "powershell";
        const messageBody = toolMessageBody(entry.summary);
        const errorBody = shell ? undefined : entry.errorText;
        const expandable = shell || errorBody !== undefined || messageBody !== undefined;
        const expandKey = shell
          ? toolCommandKey(entry.entryId)
          : errorBody !== undefined
            ? toolErrorKey(entry.entryId)
            : toolMessageKey(entry.entryId);
        const expanded = expandable && this.expandedKeys.has(expandKey);
        // 失败事实的规范稳定错误码与收束事实并列在标题中、状态图标之前。
        const suffix = toolLineSuffix(visual, entry.errorCode);
        const summaryWidth = Math.max(
          1,
          contentWidth
            - (expandable ? 2 : 0)
            - displayWidth(suffix)
            - displayWidth(visual.icon) - 1,
        );
        // get_agent_status 目标 failed 时只将 failed 与错误码片段标红。
        const failureTail = statusFailureTail(entry.summary);
        const summaryText = formatStatusSummary(entry.summary, summaryWidth, failureTail);
        lines.push(toolTitleLine({
          label: `${summaryText}${suffix}`,
          visual,
          width: contentWidth,
          ...(expandable ? { key: expandKey, expanded } : {}),
          ...(failureTail === undefined ? {} : { errorTail: failureTail }),
        }));
        if (
          expanded
          && (entry.summary.tool === "bash" || entry.summary.tool === "powershell")
        ) {
          const command = entry.summary.command;
          lines.push(...renderGuidedBody(
            contentWidth,
            (bodyWidth) => renderShellCommandBody(command, bodyWidth),
          ));
        }
        if (expanded && errorBody !== undefined) {
          lines.push(...renderGuidedBody(
            contentWidth,
            (bodyWidth) => renderToolErrorBody(errorBody, bodyWidth),
          ));
        }
        if (expanded && messageBody !== undefined) {
          lines.push(...renderGuidedBody(
            contentWidth,
            (bodyWidth) => renderMarkdownBlock(messageBody, bodyWidth, "body"),
          ));
        }
        continue;
      }
      // 安全兜底只显示工具名与状态，不提供展开入口。
      const summary = safeUiFact(entry.toolName);
      const suffixParts = [
        ...(visual.suffix === undefined ? [] : [visual.suffix]),
        ...(entry.errorCode === undefined ? [] : [entry.errorCode]),
      ];
      lines.push(toolTitleLine({
        label: `${summary}${
          suffixParts.length === 0 ? "" : ` · ${suffixParts.join(SUMMARY_SEPARATOR)}`
        }`,
        visual,
        width: contentWidth,
      }));
    }

    const frozen = Object.freeze(lines.map((line) => Object.freeze(line)));
    this.cachedProjection = { width: contentWidth, revision: this.projectionRevision, lines: frozen };
    return frozen;
  }
}

type DisplayEntry =
  | {
      readonly kind: "message";
      readonly entryId: string;
      readonly content: readonly SafeAgentActivityContentBlock[];
    }
  | {
      readonly kind: "parent_message";
      readonly entryId: string;
      readonly content: readonly SafeAgentActivityContentBlock[];
    }
  | {
      readonly kind: "live";
      readonly draft: AgentDisplayDraftView;
    }
  | ToolDisplayEntry;

interface ToolTitleLineOptions {
  readonly label: string;
  readonly visual: ReturnType<typeof toolDisplayVisual>;
  readonly width: number;
  readonly key?: string;
  readonly expanded?: boolean;
  readonly errorTail?: string;
}

/** 工具标题固定为“可选展开标记、摘要、右侧状态图标”。 */
function toolTitleLine(options: ToolTitleLineOptions): ViewerSemanticLine {
  const marker = options.key === undefined ? "" : `${options.expanded === true ? "▾" : "▸"} `;
  const iconWidth = displayWidth(options.visual.icon);
  const headWidth = Math.max(0, options.width - iconWidth - 1);
  const head = truncateToDisplayWidth(`${marker}${options.label}`, headWidth);
  const text = head.length === 0
    ? truncateToDisplayWidth(options.visual.icon, options.width)
    : `${head} ${options.visual.icon}`;
  return Object.freeze({
    text,
    style: "terminal" as const,
    emphasized_title: true,
    status_tail: Object.freeze({ text: options.visual.icon, style: options.visual.style }),
    ...(options.key === undefined ? {} : { selectable_key: options.key }),
    ...(options.errorTail === undefined ? {} : { error_tail: options.errorTail }),
  });
}

/** 无工具状态的可展开标题同样使用统一箭头和粗体强调色。 */
function disclosureTitleLine(
  label: string,
  key: string,
  expanded: boolean,
): ViewerSemanticLine {
  return Object.freeze({
    text: `${expanded ? "▾" : "▸"} ${label}`,
    style: "terminal" as const,
    selectable_key: key,
    emphasized_title: true,
  });
}

const EXPANDED_BODY_GUIDE = "│ ";

/** 展开正文先扣除引导线宽度再渲染，保证换行后每一行都保留 `│`。 */
function renderGuidedBody(
  width: number,
  renderBody: (bodyWidth: number) => readonly ViewerSemanticLine[],
): readonly ViewerSemanticLine[] {
  if (width <= 1) {
    return Object.freeze(renderBody(1).map((line) => Object.freeze({ ...line, text: "│" })));
  }
  const bodyWidth = width - displayWidth(EXPANDED_BODY_GUIDE);
  return Object.freeze(renderBody(bodyWidth).map((line) => Object.freeze({
    ...line,
    text: `${EXPANDED_BODY_GUIDE}${line.text}`,
  })));
}

/**
 * 实时草稿渲染：text 块实时按 Markdown 重渲染，不增加流式标签、角色标签
 * 或消息分隔线；thinking 默认折叠，标题按草稿状态区分流式与冻结，手动
 * 展开后持续增长。冻结 text 在草稿末尾显示弱化省略号；冻结且展开的
 * thinking 正文末尾同样显示。
 */
function renderLiveDraft(
  draft: AgentDisplayDraftView,
  width: number,
  expandedKeys: ReadonlySet<string>,
  lines: ViewerSemanticLine[],
): void {
  const thinkingTitle = draft.state === "frozen"
    ? THINKING_FROZEN_TEXT
    : draft.state === "complete"
      ? THINKING_COLLAPSED_TEXT
      : THINKING_STREAMING_TEXT;
  for (const block of draft.blocks) {
    if (block.contentType === "text") {
      lines.push(...renderMarkdownBlock(block.value, width, "body"));
      continue;
    }
    const key = liveThinkingKey(draft.key, block.contentIndex);
    const expanded = expandedKeys.has(key);
    lines.push(disclosureTitleLine(thinkingTitle, key, expanded));
    if (expanded) {
      lines.push(...renderGuidedBody(
        width,
        (bodyWidth) => renderMarkdownBlock(block.value, bodyWidth, "terminal"),
      ));
    }
  }
  if (draft.state !== "frozen" || draft.blocks.length === 0) return;
  const last = draft.blocks.at(-1)!;
  if (last.contentType === "text") {
    lines.push(Object.freeze({ text: FROZEN_DRAFT_ELLIPSIS, style: "terminal" as const }));
    return;
  }
  if (expandedKeys.has(liveThinkingKey(draft.key, last.contentIndex))) {
    lines.push(Object.freeze({
      text: `${EXPANDED_BODY_GUIDE}${FROZEN_DRAFT_ELLIPSIS}`,
      style: "terminal" as const,
    }));
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
      ...body.map((line) => renderViewerNarrowPanelLine(
        line,
        panelWidth,
        theme,
      )),
      renderNarrowPanelLine(footer, panelWidth, "footer", false, theme),
    ]);
  }

  return Object.freeze([
    renderPanelRule(panelWidth, "top", theme),
    renderFramedPanelLine(header, contentWidth, "header", false, theme),
    renderPanelRule(panelWidth, "divider", theme),
    ...body.map((line) => renderViewerFramedPanelLine(
      line,
      contentWidth,
      theme,
    )),
    renderPanelRule(panelWidth, "divider", theme),
    renderFramedPanelLine(footer, contentWidth, "footer", false, theme),
    renderPanelRule(panelWidth, "bottom", theme),
  ]);
}

/** 标题和右侧状态需要独立着色；普通正文继续复用共享面板渲染器。 */
function renderViewerFramedPanelLine(
  line: ViewerSemanticLine,
  contentWidth: number,
  theme: unknown,
): string {
  if (line.emphasized_title !== true && line.status_tail === undefined) {
    return renderFramedPanelLine(
      line.text,
      contentWidth,
      line.style,
      line.selected === true,
      theme,
      line.error_tail,
    );
  }
  const value = truncateToDisplayWidth(line.text, contentWidth);
  const pad = " ".repeat(Math.max(0, contentWidth - displayWidth(value)));
  const borderColor = line.selected === true ? "borderAccent" : "border";
  const rendered = `${themeFg(theme, borderColor, "┃")} ${
    styleViewerSemanticText({ ...line, text: value }, theme)
  }${pad} ${themeFg(theme, borderColor, "┃")}`;
  return themeBg(theme, line.selected === true ? "selectedBg" : "customMessageBg", rendered);
}

function renderViewerNarrowPanelLine(
  line: ViewerSemanticLine,
  width: number,
  theme: unknown,
): string {
  if (line.emphasized_title !== true && line.status_tail === undefined) {
    return renderNarrowPanelLine(
      line.text,
      width,
      line.style,
      line.selected === true,
      theme,
      line.error_tail,
    );
  }
  const value = truncateToDisplayWidth(line.text, width);
  const pad = " ".repeat(Math.max(0, width - displayWidth(value)));
  return themeBg(
    theme,
    line.selected === true ? "selectedBg" : "customMessageBg",
    `${styleViewerSemanticText({ ...line, text: value }, theme)}${pad}`,
  );
}

/** 粗体强调标题、局部错误事实与右侧状态图标分别应用主题。 */
function styleViewerSemanticText(line: ViewerSemanticLine, theme: unknown): string {
  let title = line.text;
  let status: ViewerStatusTail | undefined;
  if (line.status_tail !== undefined) {
    const suffix = ` ${line.status_tail.text}`;
    if (title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length);
      status = line.status_tail;
    } else if (title === line.status_tail.text) {
      title = "";
      status = line.status_tail;
    }
  }

  let errorTail: string | undefined;
  if (line.error_tail !== undefined && title.endsWith(line.error_tail)) {
    title = title.slice(0, -line.error_tail.length);
    errorTail = line.error_tail;
  }
  const styledTitle = line.emphasized_title === true
    ? themeFg(theme, "accent", themeBold(theme, title))
    : stylePanelText(title, line.style, theme);
  const styledError = errorTail === undefined
    ? ""
    : themeFg(
      theme,
      "error",
      line.emphasized_title === true ? themeBold(theme, errorTail) : errorTail,
    );
  const styledStatus = status === undefined
    ? ""
    : ` ${stylePanelText(status.text, status.style, theme)}`;
  return `${styledTitle}${styledError}${styledStatus}`;
}

function unavailableViewerLines(width: number): readonly ViewerSemanticLine[] {
  const lines: ViewerSemanticLine[] = [
    { text: truncateToDisplayWidth(`${VIEWER_HEADER_TEXT} · temporarily unavailable`, width), style: "header" },
  ];
  while (lines.length < DEFAULT_VIEWER_VIEWPORT_HEIGHT + 1) lines.push({ text: "", style: "body" });
  lines.push({ text: truncateToDisplayWidth("Esc back", width), style: "footer" });
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}

/** text 块按正常 Markdown 完整渲染；不增加角色标签、容器或分隔线。 */
function renderMarkdownBlock(
  raw: string,
  width: number,
  style: UiPanelLineStyle,
): readonly ViewerSemanticLine[] {
  const safe = sanitizeViewerMarkup(raw);
  if (safe.length === 0) return Object.freeze([]);
  let rendered: readonly string[];
  try {
    rendered = new Markdown(safe, 0, 0, PLAIN_MARKDOWN_THEME).render(width);
  } catch {
    rendered = wrapPlainText(safe, width);
  }
  const lines = rendered.map((line) => {
    const clean = sanitizeViewerMarkup(line).replace(/[ \t]+$/u, "");
    return Object.freeze({ text: clean, style });
  });
  return Object.freeze(lines);
}

/**
 * thinking 块默认折叠为不含行数与预览的 `Thinking`；展开后保留统一标题，
 * 正文以 `│` 引导线和弱化 Markdown 显示。
 */
function renderThinkingBlock(
  raw: string,
  width: number,
  key: string,
  expanded: boolean,
): readonly ViewerSemanticLine[] {
  const title = disclosureTitleLine(THINKING_COLLAPSED_TEXT, key, expanded);
  if (!expanded) return Object.freeze([title]);
  const body = renderGuidedBody(
    width,
    (bodyWidth) => renderMarkdownBlock(raw, bodyWidth, "terminal"),
  );
  return Object.freeze([title, ...body]);
}

const PARENT_MESSAGE_TITLE = "Parent message";

/**
 * 已接纳父代理输入统一折叠为 `Parent message`：不区分首条与后续消息，
 * 不显示父代理身份。正文完整保留、默认折叠；展开后使用 `│` 引导线显示
 * 正常 Markdown。逐条独立身份，完全相同正文不去重。
 */
function renderParentMessageBlock(
  content: readonly SafeAgentActivityContentBlock[],
  width: number,
  key: string,
  expanded: boolean,
): readonly ViewerSemanticLine[] {
  const title = disclosureTitleLine(PARENT_MESSAGE_TITLE, key, expanded);
  if (!expanded) return Object.freeze([title]);
  const lines: ViewerSemanticLine[] = [title];
  let blockIndex = 0;
  for (const block of content) {
    if (block.type === "text") {
      lines.push(...renderGuidedBody(
        width,
        (bodyWidth) => renderMarkdownBlock(block.text, bodyWidth, "body"),
      ));
    } else {
      const thinkingTitleKey = `${key}:${blockIndex}`;
      lines.push(...renderGuidedBody(width, (bodyWidth) => Object.freeze([
        disclosureTitleLine(THINKING_COLLAPSED_TEXT, thinkingTitleKey, true),
        ...renderMarkdownBlock(block.thinking, bodyWidth, "terminal"),
      ])));
    }
    blockIndex += 1;
  }
  return Object.freeze(lines);
}

function wrapPlainText(value: string, width: number): readonly string[] {
  return Object.freeze(value.split("\n").flatMap((line) => wrapPlainLine(line, width)));
}

/**
 * 工具错误正文：红色预格式化纯文本。不解析 Markdown、不做语义摘要或字符
 * 截断，只按正文宽度软换行，保留换行与可读空白；调用方统一添加引导线。
 */
function renderToolErrorBody(
  errorText: string,
  width: number,
): readonly ViewerSemanticLine[] {
  const safe = sanitizeViewerMarkup(errorText);
  if (safe.length === 0) return Object.freeze([]);
  return Object.freeze(wrapPlainText(safe, width).map((line) => Object.freeze({
    text: line,
    style: "error" as const,
  })));
}

/**
 * Shell 工具的完整命令：默认折叠，展开后作为独立预格式化正文显示。
 * 单行与多行命令采用同一种软换行结构，不截断命令字符。
 */
function renderShellCommandBody(
  command: string,
  width: number,
): readonly ViewerSemanticLine[] {
  const safe = sanitizeViewerMarkup(command);
  if (safe.length === 0) return Object.freeze([]);
  return Object.freeze(wrapPlainText(safe, width).map((line) => Object.freeze({
    text: line,
    style: "body" as const,
  })));
}

/**
 * 超宽路径中间省略：保留首尾两端，中间以单个省略号连接；在字素簇边界
 * 切分，不切断组合字符或宽字符。
 */
function truncateMiddleToDisplayWidth(value: string, width: number): string {
  if (!Number.isSafeInteger(width) || width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return "…";
  const segments = [...SEGMENTER.segment(value)];
  const headBudget = Math.floor((width - 1) / 2);
  const tailBudget = width - 1 - headBudget;
  let head = "";
  let headUsed = 0;
  let headIndex = 0;
  for (; headIndex < segments.length; headIndex += 1) {
    const segment = segments[headIndex]!.segment;
    const segmentWidth = displayWidth(segment);
    if (headUsed + segmentWidth > headBudget) break;
    head += segment;
    headUsed += segmentWidth;
  }
  let tail = "";
  let tailUsed = 0;
  let tailIndex = segments.length - 1;
  while (tailIndex >= headIndex) {
    const segment = segments[tailIndex]!.segment;
    const segmentWidth = displayWidth(segment);
    if (tailUsed + segmentWidth > tailBudget) break;
    tail = segment + tail;
    tailUsed += segmentWidth;
    tailIndex -= 1;
  }
  return `${head}…${tail}`;
}

/** 路径超宽时中间省略；其余字段从右侧省略。 */
const SUMMARY_SEPARATOR = " · ";

interface SummaryFragments {
  readonly head: readonly string[];
  readonly path: string;
  readonly tail: readonly string[];
}

/** 把专用摘要拆为“路径前字段 / 路径 / 路径后字段”，供省略策略使用。 */
function summaryFragments(summary: SafeToolSummary): SummaryFragments {
  switch (summary.tool) {
    case "read": {
      const tail = [
        ...(summary.offset === undefined ? [] : [`offset ${summary.offset}`]),
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy, summary.firstLineExceedsLimit),
        ...(summary.hasMoreLines === true ? ["more lines"] : []),
      ];
      return { head: ["read"], path: summary.path, tail };
    }
    case "grep": {
      const tail = [
        ...(summary.glob === undefined ? [] : [`glob ${summary.glob}`]),
        ...(summary.ignoreCase === true ? ["ignoreCase"] : []),
        ...(summary.literal === true ? ["literal"] : []),
        ...(summary.context === undefined ? [] : [`context ${summary.context}`]),
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...(summary.noMatches === true ? ["no matches"] : []),
        ...(summary.matchLimitReached === undefined
          ? []
          : [`${summary.matchLimitReached} matches limit`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy),
        ...(summary.linesTruncated === true ? ["lines truncated"] : []),
      ];
      return { head: ["grep", `/${summary.pattern}/`], path: summary.path, tail };
    }
    case "find": {
      const tail = [
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...(summary.noFiles === true ? ["no files"] : []),
        ...(summary.resultLimitReached === undefined
          ? []
          : [`${summary.resultLimitReached} results limit`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy),
      ];
      return { head: ["find", summary.pattern], path: summary.path, tail };
    }
    case "ls": {
      const tail = [
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...(summary.emptyDirectory === true ? ["empty directory"] : []),
        ...(summary.entryLimitReached === undefined
          ? []
          : [`${summary.entryLimitReached} entries limit`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy),
      ];
      return { head: ["ls"], path: summary.path, tail };
    }
    case "write":
    case "edit": {
      // 成功与失败摘要都只有 path：写入/编辑统计不属于展示闭集。
      return { head: [summary.tool], path: summary.path, tail: [] };
    }
    case "bash":
    case "powershell": {
      // 状态摘要只显示工具名和可选 timeout；完整 command 在独立代码区域。
      const tail = summary.timeout === undefined ? [] : [`timeout ${summary.timeout}`];
      return { head: [summary.tool], path: "", tail };
    }
    case "get_agent_templates": {
      // 成功只显示模板数量；失败摘要没有该字段，也不显示模板配置。
      const tail = summary.count === undefined ? [] : [`${summary.count} templates`];
      return { head: [summary.tool], path: "", tail };
    }
    case "spawn_agent": {
      // 显示 name、template ID 与完整 UUID 的固定前八位；不显示 depth 或
      // 初始 state。成功才有 agent_id。
      const tail = summary.agent_id === undefined ? [] : [shortAgentId(summary.agent_id)];
      return { head: [summary.tool, summary.name, summary.template_id], path: "", tail };
    }
    case "send_message": {
      // 显示目标名称与固定八位短 ID；不显示 accepted。完整 message 在
      // 独立可展开正文区域。
      const head: string[] = [summary.tool];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      return { head, path: "", tail: [] };
    }
    case "normal_reply":
    case "final_report": {
      // 摘要只显示工具名；完整 message 在独立可展开正文区域。
      return { head: [summary.tool], path: "", tail: [] };
    }
    case "wait_agent": {
      // 单目标显示名称与固定八位短 ID，多目标只显示数量；实际 outcome、
      // batch release 的释放者与释放 outcome、目标 failed 的安全错误码并列。
      const head: string[] = ["wait_agent"];
      if (summary.agent_id !== undefined) {
        if (summary.name !== undefined) head.push(summary.name);
        head.push(shortAgentId(summary.agent_id));
      } else if (summary.target_count !== undefined) {
        head.push(`${summary.target_count} targets`);
      }
      const tail: string[] = [];
      if (summary.outcome !== undefined) tail.push(summary.outcome);
      if (summary.released_by !== undefined) {
        if (summary.released_by_name !== undefined) tail.push(summary.released_by_name);
        tail.push(shortAgentId(summary.released_by));
      }
      if (summary.released_outcome !== undefined) tail.push(summary.released_outcome);
      if (summary.state === "failed") {
        tail.push("failed");
        if (summary.error_code !== undefined) tail.push(summary.error_code);
      }
      return { head, path: "", tail };
    }
    case "interrupt_agent": {
      // 显示目标与真实控制结果：unchanged 与压缩阻塞为中性事实。
      const head: string[] = ["interrupt_agent"];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      const tail = summary.changed === false
        ? [summary.blocked_reason === undefined ? "unchanged" : summary.blocked_reason]
        : [];
      return { head, path: "", tail };
    }
    case "terminate_agent": {
      // 显示目标、回收数量、幂等与强制回收事实。
      const head: string[] = ["terminate_agent"];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      const tail: string[] = [];
      if (summary.changed === false) tail.push("already terminated");
      else if (summary.terminated_count !== undefined) {
        tail.push(`${summary.terminated_count} reclaimed`);
      }
      if (summary.forced === true) tail.push("forced");
      return { head, path: "", tail };
    }
    case "get_agent_status": {
      // 显示目标、生命周期状态与条件性 phase、错误码、终止结果；revision、
      // 时间与上下文占用不进入显示。
      const head: string[] = ["get_agent_status"];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      const tail: string[] = [];
      if (summary.state !== undefined) tail.push(summary.state);
      if (summary.phase !== undefined) tail.push(summary.phase);
      if (summary.termination_result !== undefined) tail.push(summary.termination_result);
      if (summary.error_code !== undefined) tail.push(summary.error_code);
      return { head, path: "", tail };
    }
    case "get_agent_tree": {
      // 成功只显示工具名与成功状态；不保存 revision、scope、节点列表或统计。
      return { head: ["get_agent_tree"], path: "", tail: [] };
    }
  }
}

/** 显示层固定八位短 ID：完整 UUID 的前八位；内部关联仍使用完整 UUID。 */
function shortAgentId(agentId: string): string {
  return agentId.slice(0, 8);
}

/** 消息类插件工具摘要自包含的完整尝试正文（成功与失败都保留）。 */
function toolMessageBody(summary: SafeToolSummary): string | undefined {
  return isMessageToolSummary(summary) ? summary.message : undefined;
}

/** 工具行尾收束事实：状态视觉后缀与规范稳定错误码并列。 */
function toolLineSuffix(
  visual: { readonly suffix?: string },
  errorCode: string | undefined,
): string {
  const parts = [
    ...(visual.suffix === undefined ? [] : [visual.suffix]),
    ...(errorCode === undefined ? [] : [errorCode]),
  ];
  return parts.length === 0 ? "" : ` · ${parts.join(SUMMARY_SEPARATOR)}`;
}

function readTruncationFacts(
  truncated: boolean | undefined,
  truncatedBy: "lines" | "bytes" | undefined,
  firstLineExceedsLimit?: boolean,
): readonly string[] {
  if (truncated !== true) return [];
  if (firstLineExceedsLimit === true) return ["truncated (first line)"];
  return [`truncated (${truncatedBy ?? "bytes"})`];
}

/**
 * 专用摘要单行格式：状态图标与折叠标记之外的全部内容。长路径中间省略
 * 保留两端；其余超宽内容依赖整行右侧省略兜底。
 */
function formatToolSummary(summary: SafeToolSummary, contentWidth: number): string {
  const fragments = summaryFragments(summary);
  const head = fragments.head.join(SUMMARY_SEPARATOR);
  const tail = fragments.tail.join(SUMMARY_SEPARATOR);
  const join = (path: string): string =>
    [head, path, tail].filter((part) => part.length > 0).join(SUMMARY_SEPARATOR);
  const full = join(fragments.path);
  if (displayWidth(full) <= contentWidth) return full;
  // 路径预算：整行减去固定部分、路径前的分隔符与省略号一位。
  const fixed = [head, tail].filter((part) => part.length > 0).join(SUMMARY_SEPARATOR);
  const budget = contentWidth - displayWidth(fixed)
    - (fixed.length > 0 ? SUMMARY_SEPARATOR.length : 0) - 1;
  const middlePath = truncateMiddleToDisplayWidth(fragments.path, Math.max(1, budget));
  return join(middlePath);
}

/** get_agent_status 目标 failed 时的行尾红色片段：failed 状态与安全错误码。 */
function statusFailureTail(summary: SafeToolSummary): string | undefined {
  if (summary.tool !== "get_agent_status" || summary.state !== "failed") return undefined;
  return summary.error_code === undefined
    ? "failed"
    : `failed${SUMMARY_SEPARATOR}${summary.error_code}`;
}

/**
 * get_agent_status 摘要格式：查询成功时整行保持成功视觉，只把行尾的
 * failed 与错误码片段留给错误色；前段超宽时先于红色片段右侧省略。
 */
function formatStatusSummary(
  summary: SafeToolSummary,
  contentWidth: number,
  failureTail: string | undefined,
): string {
  const full = formatToolSummary(summary, contentWidth);
  if (failureTail === undefined) return full;
  const redPart = `${SUMMARY_SEPARATOR}${failureTail}`;
  if (!full.endsWith(redPart)) return full;
  const dim = truncateToDisplayWidth(
    full.slice(0, full.length - redPart.length),
    Math.max(1, contentWidth - displayWidth(redPart)),
  );
  return `${dim}${redPart}`;
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
  return sanitizeSafeActivityText(value);
}

function sameEntry(left: CanonicalAgentActivityEntry, right: CanonicalAgentActivityEntry): boolean {
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function identity(text: string): string {
  return text;
}
