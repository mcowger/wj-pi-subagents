import type { AgentLifecycleState } from "./agent-snapshot-codec.ts";
import { parseAgentActivityEvent, type SafeAgentActivityEvent } from "./rpc-bridge-event.ts";
import {
  renderFramedPanelLine,
  renderNarrowPanelLine,
  renderPanelRule,
  safeUiFact,
  truncateToDisplayWidth,
  type UiPanelLineStyle,
} from "./ui-surface.ts";

export { displayWidth } from "./ui-surface.ts";

const DEFAULT_VIEWER_VIEWPORT_HEIGHT = 20;
const THINKING_LINE_PREFIX = "┆ ";
const EMPTY_ACTIVITY_TEXT = "No cached activity yet";
const VIEWER_HEADER_TEXT = "AGENT ACTIVITY";
const FOLLOWING_FOOTER_TEXT = "↑↓ scroll · Esc back";
const PAUSED_FOOTER_TEXT = "paused · ↓ resume · Esc back";
const RENDER_VIEWER_LINES = Symbol("renderViewerLines");

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
  readonly follow_enabled: boolean;
  readonly lifecycle_state: AgentLifecycleState;
}

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
  private scrollOffset = 0;
  private followEnabled = true;

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
    this.syncFrom(replay);
  }

  get agent_id(): string {
    return this.agentId;
  }

  /** 标题中的生命周期状态随树快照刷新；相同状态忽略。 */
  updateLifecycle(state: AgentLifecycleState): AgentActivityViewerUpdateOutcome {
    if (state === this.lifecycleState) return "ignored";
    this.lifecycleState = state;
    return "changed";
  }

  /** 追加一条活动事件；违约或超限事件被静默拒绝，与缓存防线语义一致。 */
  appendEvent(event: SafeAgentActivityEvent): AgentActivityViewerUpdateOutcome {
    const parsed = parseAgentActivityEvent(event);
    if (parsed.kind !== "event") return "ignored";
    this.events.push(parsed.event);
    this.settleFollow();
    return "changed";
  }

  /** 以缓存全量回放对齐本地事件；只追加尚未落地的新到达部分。 */
  syncFrom(replay: readonly SafeAgentActivityEvent[]): AgentActivityViewerUpdateOutcome {
    let outcome: AgentActivityViewerUpdateOutcome = "ignored";
    for (const event of replay.slice(this.events.length)) {
      if (this.appendEvent(event) === "changed") outcome = "changed";
    }
    return outcome;
  }

  render(width: number): readonly string[] {
    return Object.freeze(this[RENDER_VIEWER_LINES](width).map((line) => line.text));
  }

  [RENDER_VIEWER_LINES](width: number): readonly { readonly text: string }[] {
    const identity = truncateToDisplayWidth(
      `${VIEWER_HEADER_TEXT} · ${safeUiFact(this.templateId)} · ${safeUiFact(this.name)} · ${this.lifecycleState}`,
      width,
    );
    this.settleFollow();
    const bodyLines = this.eventLines();
    const maxOffset = Math.max(0, bodyLines.length - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const visible = bodyLines.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight)
      .map((line) => truncateToDisplayWidth(line, width));
    while (visible.length < this.viewportHeight) visible.push("");
    return Object.freeze([
      Object.freeze({ text: identity }),
      ...visible.map((text) => Object.freeze({ text })),
      Object.freeze({
        text: truncateToDisplayWidth(
          this.followEnabled ? FOLLOWING_FOOTER_TEXT : PAUSED_FOOTER_TEXT,
          width,
        ),
      }),
    ]);
  }

  handleInput(data: string): AgentActivityViewerInputOutcome {
    if (data === "\x1b") return "close";
    const maxOffset = Math.max(0, this.eventLines().length - this.viewportHeight);
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
    this.settleFollow();
    const maxOffset = Math.max(0, this.eventLines().length - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    return Object.freeze({
      event_count: this.events.length,
      scroll_offset: this.scrollOffset,
      follow_enabled: this.followEnabled,
      lifecycle_state: this.lifecycleState,
    });
  }

  /** 跟随时视口始终对齐最新事件；暂停时保持用户当前回看位置。 */
  private settleFollow(): void {
    if (!this.followEnabled) return;
    this.scrollOffset = Math.max(0, this.eventLines().length - this.viewportHeight);
  }

  /** 把活动事件闭集渲染为纯文本级行；事件数为零时给出明确空态。 */
  private eventLines(): readonly string[] {
    if (this.events.length === 0) return Object.freeze([EMPTY_ACTIVITY_TEXT]);
    const lines: string[] = [];
    for (const event of this.events) {
      switch (event.type) {
        case "message": {
          for (const block of event.content) {
            const raw = block.type === "text" ? block.text : block.thinking;
            const pieces = raw.split("\n");
            for (const piece of pieces) {
              const sanitized = safeUiFact(piece);
              lines.push(block.type === "thinking" ? `${THINKING_LINE_PREFIX}${sanitized}` : sanitized);
            }
          }
          break;
        }
        case "tool_execution_start": {
          const args = event.args === undefined ? "" : ` ${safeUiFact(event.args)}`;
          lines.push(`▶ ${safeUiFact(event.toolName)}${args}`);
          break;
        }
        case "tool_execution_end": {
          const result = event.result === undefined ? "" : ` · ${safeUiFact(event.result)}`;
          lines.push(`${event.isError === true ? "×" : "✓"} ${safeUiFact(event.toolName)}${result}`);
          break;
        }
      }
    }
    return Object.freeze(lines);
  }
}

type AgentActivityViewerLineStyle = UiPanelLineStyle;

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
  const bodyHeight = model?.getViewportHeight() ?? DEFAULT_VIEWER_VIEWPORT_HEIGHT;
  const bodyStyle = (): AgentActivityViewerLineStyle => "body";

  if (!framed) {
    return Object.freeze([
      renderNarrowPanelLine(header, panelWidth, "header", false, theme),
      ...body.map((line) => renderNarrowPanelLine(
        line.text,
        panelWidth,
        bodyStyle(),
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
      bodyStyle(),
      false,
      theme,
    )),
    renderPanelRule(panelWidth, "divider", theme),
    renderFramedPanelLine(footer, contentWidth, "footer", false, theme),
    renderPanelRule(panelWidth, "bottom", theme),
  ]);
}

function unavailableViewerLines(width: number): readonly { readonly text: string }[] {
  const lines: string[] = [
    truncateToDisplayWidth(`${VIEWER_HEADER_TEXT} · temporarily unavailable`, width),
  ];
  while (lines.length < DEFAULT_VIEWER_VIEWPORT_HEIGHT + 1) lines.push("");
  return Object.freeze([
    Object.freeze({ text: lines[0]! }),
    ...lines.slice(1).map((text) => Object.freeze({ text })),
    Object.freeze({ text: truncateToDisplayWidth("Esc back", width) }),
  ]);
}

function validViewportHeight(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : DEFAULT_VIEWER_VIEWPORT_HEIGHT;
}
