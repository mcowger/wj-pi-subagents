import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentLifecycleState } from "./agent-snapshot-codec.ts";
import {
  ACTIVITY_MAX_TEXT_BYTES,
  parseAgentActivityDisplayEvent,
  sanitizeSafeActivityText,
  type SafeAgentActivityContentBlock,
  type SafeAgentActivityDisplayEvent,
  type SafePiToolSummary,
  type SafeToolOrigin,
} from "./rpc-bridge-event.ts";
import type { CanonicalAgentActivityEntry } from "./canonical-activity.ts";
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
const THINKING_COLLAPSED_TEXT = "Thinking";
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

interface ViewerSemanticLine {
  readonly text: string;
  readonly style: UiPanelLineStyle;
  /** 可展开条目身份：thinking 组；选中背景只作用于该行。 */
  readonly selectable_key?: string;
  /** 该行是否为当前选中条目；仅渲染层消费。 */
  readonly selected?: boolean;
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
  /** 条目身份：错误正文展开的稳定可展开键。 */
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
  /** 专用摘要：只有来源验证通过的 Pi 原生专用工具携带；结束事实覆盖开始。 */
  summary: SafePiToolSummary | undefined;
  /** 失败事实自包含的完整错误正文（已净化）；默认折叠，展开后红色显示。 */
  errorText: string | undefined;
}

/**
 * 安全兜底视觉规则：运行中强调色；成功与中性弱化；警告色；失败整行错误色。
 * 行首结构预留“状态图标、折叠标记、摘要”的稳定位置；兜底条目没有可展开
 * 正文，折叠标记恒为空，后续专用规则的附属正文将共用整行背景顶格显示。
 */
const TOOL_STATE_VISUALS: Readonly<Record<ToolRunState["phase"], {
  readonly icon: string;
  readonly style: UiPanelLineStyle;
  readonly suffix?: string;
}>> = Object.freeze({
  running: Object.freeze({ icon: "▶", style: "accent" as const }),
  success: Object.freeze({ icon: "✓", style: "terminal" as const }),
  failure: Object.freeze({ icon: "×", style: "error" as const }),
  unavailable: Object.freeze({ icon: "⚠", style: "warning" as const, suffix: "result unavailable" }),
  terminated: Object.freeze({
    icon: "○",
    style: "terminal" as const,
    suffix: "terminated before result",
  }),
});

interface LiveMessageBlock {
  readonly contentType: "text" | "thinking";
  value: string;
}

interface LiveMessageEntry {
  lastSequence: number;
  readonly blocks: Map<number, LiveMessageBlock>;
}

/**
 * 可展开条目身份：规范条目内的 thinking 组使用条目身份加块序号；工具错误
 * 正文使用 tool-error 前缀；实时草稿使用 live 前缀。身份跨重绘稳定。
 */
function thinkingKey(entryId: string, blockIndex: number): string {
  return `thinking:${entryId}:${blockIndex}`;
}

function toolErrorKey(entryId: string): string {
  return `tool-error:${entryId}`;
}

function liveThinkingKey(streamId: string, contentIndex: number): string {
  return `thinking:live:${streamId}:${contentIndex}`;
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
  /** 从 bridge 短暂转发的 token 增量；不进入回放、事件数或父端缓存。 */
  private readonly liveMessages = new Map<string, LiveMessageEntry>();
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
   * 接收仅显示层的有序 token 增量。乱序、重复、超预算或结构违约帧不会进入
   * 完整活动历史；检测到序号缺口时丢弃该草稿，等待权威条目收束。
   */
  applyDisplayEvent(event: SafeAgentActivityDisplayEvent): AgentActivityViewerUpdateOutcome {
    const parsed = parseAgentActivityDisplayEvent(event);
    if (parsed.kind !== "event") return "ignored";
    const update = parsed.event;
    const existing = this.liveMessages.get(update.streamId);
    if (update.type === "message_complete") {
      if (existing === undefined || update.sequence !== existing.lastSequence + 1) return "ignored";
      this.liveMessages.delete(update.streamId);
      this.touchProjection();
      return "changed";
    }
    if (existing === undefined) {
      if (update.sequence !== 1) return "ignored";
      const entry: LiveMessageEntry = { lastSequence: update.sequence, blocks: new Map() };
      entry.blocks.set(update.contentIndex, { contentType: update.contentType, value: update.delta });
      if (!isLiveMessageWithinBudget(entry)) return "ignored";
      this.liveMessages.set(update.streamId, entry);
      this.touchProjection();
      this.settleFollow();
      return "changed";
    }
    if (update.sequence !== existing.lastSequence + 1) {
      if (update.sequence > existing.lastSequence) {
        this.liveMessages.delete(update.streamId);
        this.touchProjection();
        return "changed";
      }
      return "ignored";
    }
    const block = existing.blocks.get(update.contentIndex);
    if (block !== undefined && block.contentType !== update.contentType) {
      this.liveMessages.delete(update.streamId);
      this.touchProjection();
      return "changed";
    }
    const previous = block?.value;
    if (block === undefined) {
      existing.blocks.set(update.contentIndex, { contentType: update.contentType, value: update.delta });
    } else {
      block.value += update.delta;
    }
    if (!isLiveMessageWithinBudget(existing)) {
      if (block === undefined) existing.blocks.delete(update.contentIndex);
      else block.value = previous ?? "";
      this.liveMessages.delete(update.streamId);
      this.touchProjection();
      return "changed";
    }
    existing.lastSequence = update.sequence;
    this.touchProjection();
    this.settleFollow();
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
    return key.startsWith("thinking:") || key.startsWith("tool-error:");
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
    for (const [streamId, live] of this.liveMessages) {
      const content = [...live.blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([contentIndex, block]) => Object.freeze({
          key: liveThinkingKey(streamId, contentIndex),
          block: (block.contentType === "text"
            ? Object.freeze({ type: "text" as const, text: block.value })
            : Object.freeze({ type: "thinking" as const, thinking: block.value })),
        }));
      if (content.length > 0) entries.push({ kind: "live", content });
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

    if (this.entries.length === 0 && this.liveMessages.size === 0) {
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

      if (entry.kind === "live") {
        for (const item of entry.content) {
          if (item.block.type === "text") {
            lines.push(...renderMarkdownBlock(item.block.text, contentWidth, "body"));
          } else {
            lines.push(...renderThinkingBlock(
              item.block.thinking,
              contentWidth,
              item.key,
              this.expandedKeys.has(item.key),
            ));
          }
        }
        continue;
      }

      const visual = TOOL_STATE_VISUALS[entry.state.phase];
      // 行首顺序固定为状态图标、折叠标记、摘要。专用摘要展示白名单参数
      // 与结果事实；错误正文默认折叠，展开后顶格红色预格式化纯文本。
      if (entry.summary !== undefined) {
        const expandable = entry.errorText !== undefined;
        const expanded = expandable
          && this.expandedKeys.has(toolErrorKey(entry.entryId));
        const marker = expandable ? (expanded ? "▾" : "▸") : "";
        const suffix = visual.suffix === undefined ? "" : ` · ${visual.suffix}`;
        // 摘要预算扣除行首图标/折叠标记与行尾收束事实，避免二次右侧截断。
        const summaryWidth = contentWidth
          - displayWidth(visual.icon) - 1
          - (marker === "" ? 0 : displayWidth(marker) + 1)
          - displayWidth(suffix);
        lines.push(Object.freeze({
          text: `${visual.icon} ${marker}${marker === "" ? "" : " "}${
            formatFileToolSummary(entry.summary, summaryWidth)
          }${suffix}`,
          style: visual.style,
          ...(expandable ? { selectable_key: toolErrorKey(entry.entryId) } : {}),
        }));
        if (expanded && entry.errorText !== undefined) {
          lines.push(...renderToolErrorBody(entry.errorText, contentWidth));
        }
        continue;
      }
      // 安全兜底：只显示工具名与状态；不可展开，折叠标记恒为空但位置稳定。
      const summary = safeUiFact(entry.toolName);
      const marker = "";
      lines.push(Object.freeze({
        text: `${visual.icon} ${marker}${marker === "" ? "" : " "}${summary}${
          visual.suffix === undefined ? "" : ` · ${visual.suffix}`
        }`,
        style: visual.style,
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
      readonly kind: "live";
      readonly content: readonly {
        readonly key: string;
        readonly block: SafeAgentActivityContentBlock;
      }[];
    }
  | ToolDisplayEntry;

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
        line.selected === true,
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
      line.selected === true,
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
 * thinking 块默认折叠为不含行数与预览的 `Thinking`；展开后保留标题并以
 * 顶格、弱化、无逐行前缀、无独立背景的 Markdown 显示。
 */
function renderThinkingBlock(
  raw: string,
  width: number,
  key: string,
  expanded: boolean,
): readonly ViewerSemanticLine[] {
  const title: ViewerSemanticLine = Object.freeze({
    text: THINKING_COLLAPSED_TEXT,
    style: "terminal" as const,
    selectable_key: key,
  });
  if (!expanded) return Object.freeze([title]);
  const body = renderMarkdownBlock(raw, width, "terminal");
  return Object.freeze([title, ...body]);
}

function isLiveMessageWithinBudget(entry: LiveMessageEntry): boolean {
  let bytes = 0;
  let blocks = 0;
  for (const block of entry.blocks.values()) {
    bytes += (blocks === 0 ? 0 : 1) + new TextEncoder().encode(JSON.stringify(block.value)).byteLength;
    blocks += 1;
    if (bytes > ACTIVITY_MAX_TEXT_BYTES) return false;
  }
  return true;
}

function wrapPlainText(value: string, width: number): readonly string[] {
  return Object.freeze(value.split("\n").flatMap((line) => wrapPlainLine(line, width)));
}

/**
 * 工具错误正文：红色预格式化纯文本。不解析 Markdown、不做语义摘要或字符
 * 截断，只按面板宽度软换行，保留换行与可读空白；顶格无前缀。
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
function summaryFragments(summary: SafePiToolSummary): SummaryFragments {
  switch (summary.tool) {
    case "read": {
      const tail = [
        ...(summary.offset === undefined ? [] : [`offset ${summary.offset}`]),
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy, summary.firstLineExceedsLimit),
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
  }
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
 * 保留两端；其余超宽内容依赖整行右侧省略兑底。
 */
function formatFileToolSummary(summary: SafePiToolSummary, contentWidth: number): string {
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
