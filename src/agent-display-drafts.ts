import { isCanonicalUuid } from "./tree-controller.ts";
import type { SafeAgentActivityDisplayEvent } from "./rpc-bridge-event.ts";

/**
 * 每个实时流最多暂存的尚未连续 future 帧数量。到达第 257 个未来帧时保留
 * 已验证连续前缀、丢弃 future buffer 并冻结该流；连续前缀本身不设聚合
 * 字节上限。这是实现边界，不是用户配额。
 */
export const MAX_DISPLAY_DRAFT_FUTURE_FRAMES = 256;

/** 已收束/已替换流的身份墓碑永久保留，避免迟到帧在长会话中复活旧流。 */
/** 实时草稿的显示状态；frozen 表示异常乱序冻结，等待权威完整消息。 */
export type AgentDisplayDraftState = "streaming" | "complete" | "frozen";

export interface AgentDisplayDraftBlockView {
  readonly contentIndex: number;
  readonly contentType: "text" | "thinking";
  readonly value: string;
}

/** 顶层草稿投影：从 sequence 1 开始的连续前缀，供查看器直接渲染。 */
export interface AgentDisplayDraftView {
  /** 跨快照稳定的草稿身份：`${incarnationId}|${streamId}`。 */
  readonly key: string;
  readonly state: AgentDisplayDraftState;
  readonly blocks: readonly AgentDisplayDraftBlockView[];
}

interface DisplayDraftDeltaFrame {
  readonly type: "message_delta";
  readonly sequence: number;
  readonly contentIndex: number;
  readonly contentType: "text" | "thinking";
  readonly delta: string;
}

interface DisplayDraftCompleteFrame {
  readonly type: "message_complete";
  readonly sequence: number;
}

/** 未来帧按 sequence 唯一暂存；补齐缺口后按帧类型应用。 */
type DisplayDraftFrame = DisplayDraftDeltaFrame | DisplayDraftCompleteFrame;

interface DisplayDraftBlock {
  readonly contentType: "text" | "thinking";
  readonly chunks: string[];
  /** 对外投影时才物化；新 delta 到达后失效。 */
  joinedValue: string | undefined;
}

/** accepted 表示状态机已接纳事件，但当前可见投影保持不变。 */
type DisplayDraftApplyResult = "ignored" | "accepted" | "visible-changed";
type DisplayDraftAppendResult = "rejected" | "unchanged" | "changed";

interface DisplayEpochState {
  currentEpoch: string | undefined;
  readonly retiredEpochs: Set<string>;
  /** reset/clear 后拒绝未携带明确 epoch 的 legacy 事件。 */
  requiresEpoch: boolean;
}

interface DisplayDraftStream {
  readonly incarnationId: string;
  readonly streamId: string;
  readonly displayEpoch: string | undefined;
  nextSequence: number;
  state: AgentDisplayDraftState;
  readonly blocks: Map<number, DisplayDraftBlock>;
  /** 仅在块正文变化时失效，纯 future 帧不会重复物化已有正文。 */
  projectedBlocks: readonly AgentDisplayDraftBlockView[] | undefined;
  /** 尚未连续的未来帧，按 sequence 唯一暂存；冻结时整体丢弃。 */
  readonly future: Map<number, DisplayDraftFrame>;
}

/**
 * 单个代理的实时草稿状态机。只渲染从 sequence 1 开始的连续前缀：未来帧先
 * 到按 sequence 暂存，缺失帧到达后连续应用该帧及随后已缓存帧；重复与旧帧
 * 幂等忽略；缺帧不设时间超时；future buffer 超限保留前缀并冻结该流。
 *
 * 它只服务显示层：草稿不进入持久活动历史、条目计数或父模型上下文；完整
 * assistant 消息仍是正文历史的唯一权威来源。
 */
export class AgentDisplayDraftStore {
  private readonly agentId: string;
  private readonly streams = new Map<string, DisplayDraftStream>();
  /** 已收束/已替换流的身份墓碑永久保留，避免迟到帧在长会话中复活旧流。 */
  private readonly tombstones = new Map<string, true>();
  /** 不保存正文，只记录 incarnation + stream 的权威阻断身份。 */
  private readonly blockedStreams = new Set<string>();
  /** 每个运行实例独立维护当前 display epoch，避免不同 incarnation 串流。 */
  private readonly epochStates = new Map<string, DisplayEpochState>();

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * 应用一条身份校验过的显示事件；返回是否改变了可见草稿状态。
   * 事件身份与该代理不符时静默忽略，绝不串流到其他代理的草稿。
   */
  applyEvent(event: SafeAgentActivityDisplayEvent): boolean {
    if (event.type === "display_reset" || event.agentId !== this.agentId) return false;
    if (!this.acceptEpoch(event.incarnationId, event.displayEpoch)) return false;
    const bareKey = this.bareStreamKey(event.incarnationId, event.streamId);
    if (this.blockedStreams.has(bareKey)) return false;
    const key = this.streamKey(event.incarnationId, event.displayEpoch, event.streamId);
    if (this.tombstones.has(key)) return false;
    const stream = this.streams.get(key);
    const result = event.type === "message_complete"
      ? this.applyComplete(stream, event)
      : this.applyDelta(key, stream, event);
    return result === "visible-changed";
  }

  /** 应用来自产生端的无状态 reload barrier；只切换 epoch，不保存任何正文。 */
  applyReset(incarnationId: string, displayEpoch: string): boolean {
    if (!isCanonicalUuid(incarnationId) || !isCanonicalUuid(displayEpoch)) return false;
    const state = this.epochStates.get(incarnationId) ?? {
      currentEpoch: undefined,
      retiredEpochs: new Set<string>(),
      requiresEpoch: true,
    } satisfies DisplayEpochState;
    if (state.currentEpoch !== undefined && state.currentEpoch !== displayEpoch) {
      state.retiredEpochs.add(state.currentEpoch);
    }
    if (state.currentEpoch !== displayEpoch && state.retiredEpochs.has(displayEpoch)) return false;
    const changed = this.clearIncarnation(incarnationId);
    const stateChanged = state.currentEpoch !== displayEpoch || !state.requiresEpoch;
    state.currentEpoch = displayEpoch;
    state.requiresEpoch = true;
    this.epochStates.set(incarnationId, state);
    return changed || stateChanged;
  }

  /**
   * 权威完整消息到达：原地替换并清除对应实时流草稿。权威消息先到时也登记
   * 墓碑，使该流后续迟到的 delta 与 complete 被忽略（旧流不复活）。
   */
  replaceDraft(incarnationId: string, streamId: string): boolean {
    if (!isCanonicalUuid(incarnationId) || streamId.length === 0) return false;
    const bareKey = this.bareStreamKey(incarnationId, streamId);
    let changed = false;
    for (const [key, stream] of this.streams) {
      if (stream.incarnationId !== incarnationId || stream.streamId !== streamId) continue;
      if (stream.blocks.size > 0) changed = true;
      this.tombstone(key);
      this.streams.delete(key);
    }
    // 权威消息可能先于任何 display 帧到达；阻断身份必须独立于“是否见过流”。
    this.blockedStreams.add(bareKey);
    return changed;
  }

  /**
   * 生命周期收束（idle、failed 或 terminated）：清除所有尚未被权威消息替换
   * 的草稿并登记墓碑。之后同一运行实例迟到的合法权威消息仍可写入历史；
   * 新启动的消息流使用新 streamId，不受墓碑影响。
   */
  settle(): boolean {
    let changed = false;
    for (const stream of this.streams.values()) {
      if (stream.blocks.size > 0) changed = true;
      this.blockedStreams.add(this.bareStreamKey(stream.incarnationId, stream.streamId));
    }
    for (const key of this.streams.keys()) this.tombstone(key);
    this.streams.clear();
    return changed;
  }

  /** reload 清理：显式 epoch 流必须等待下一个 reset，避免同代未知旧流复活。 */
  prepareReload(): boolean {
    const changed = this.settle();
    for (const state of this.epochStates.values()) {
      if (state.currentEpoch !== undefined) {
        state.retiredEpochs.add(state.currentEpoch);
        state.currentEpoch = undefined;
      }
      state.requiresEpoch = true;
    }
    return changed;
  }

  /**
   * 当前草稿的连续前缀投影；没有可见内容的流不产生视图。相邻 thinking
   * 块在显示边界实时合并，底层帧重排仍保留原始 contentIndex。
   */
  drafts(): readonly AgentDisplayDraftView[] {
    const views: AgentDisplayDraftView[] = [];
    for (const [key, stream] of this.streams) {
      if (stream.blocks.size === 0) continue;
      let blocks = stream.projectedBlocks;
      if (blocks === undefined) {
        blocks = projectDisplayDraftBlocks(stream.blocks);
        stream.projectedBlocks = blocks;
      }
      views.push(Object.freeze({
        key: `${stream.incarnationId}|${stream.streamId}`,
        state: stream.state,
        blocks,
      }));
    }
    return Object.freeze(views);
  }

  private applyDelta(
    key: string,
    stream: DisplayDraftStream | undefined,
    event: Extract<SafeAgentActivityDisplayEvent, { type: "message_delta" }>,
  ): DisplayDraftApplyResult {
    if (stream !== undefined) {
      if (stream.state !== "streaming") return "ignored";
      if (event.sequence < stream.nextSequence) return "ignored";
      if (event.sequence > stream.nextSequence) return this.bufferFuture(stream, event);
      const appended = this.appendDelta(stream, event.contentIndex, event.contentType, event.delta);
      if (appended === "rejected") return "ignored";
      stream.nextSequence = event.sequence + 1;
      const drainedChanged = this.drainFuture(stream);
      return appended === "changed" || drainedChanged ? "visible-changed" : "accepted";
    }
    // 首帧缺序：仍然建立流并暂存未来帧，等待 sequence 1 补齐连续前缀。
    const created: DisplayDraftStream = {
      incarnationId: event.incarnationId,
      streamId: event.streamId,
      displayEpoch: event.displayEpoch,
      nextSequence: 1,
      state: "streaming",
      blocks: new Map(),
      projectedBlocks: undefined,
      future: new Map(),
    };
    if (event.sequence === 1) {
      this.appendDelta(created, event.contentIndex, event.contentType, event.delta);
      created.nextSequence = 2;
      this.streams.set(key, created);
      return "visible-changed";
    }
    const result = this.bufferFuture(created, event);
    this.streams.set(key, created);
    return result;
  }

  private applyComplete(
    stream: DisplayDraftStream | undefined,
    event: Extract<SafeAgentActivityDisplayEvent, { type: "message_complete" }>,
  ): DisplayDraftApplyResult {
    if (stream === undefined) {
      // 没有任何 delta 的流没有可显示草稿；complete 只收束显示流，不建立占位。
      return "ignored";
    }
    if (stream.state !== "streaming") return "ignored";
    if (event.sequence < stream.nextSequence) return "ignored";
    if (event.sequence > stream.nextSequence) return this.bufferFuture(stream, event);
    stream.state = "complete";
    stream.nextSequence = event.sequence + 1;
    return stream.blocks.size > 0 ? "visible-changed" : "accepted";
  }

  /** 就绪帧写入连续前缀；contentIndex 类型冲突属于产生端违约，幂等忽略。 */
  private appendDelta(
    stream: DisplayDraftStream,
    contentIndex: number,
    contentType: "text" | "thinking",
    delta: string,
  ): DisplayDraftAppendResult {
    const block = stream.blocks.get(contentIndex);
    if (block !== undefined) {
      if (block.contentType !== contentType) return "rejected";
      if (delta.length === 0) return "unchanged";
      block.chunks.push(delta);
      block.joinedValue = undefined;
      stream.projectedBlocks = undefined;
      return "changed";
    }
    stream.blocks.set(contentIndex, { contentType, chunks: [delta], joinedValue: delta });
    stream.projectedBlocks = undefined;
    return "changed";
  }

  /**
   * 未来帧按 sequence 幂等暂存。重复 sequence 不覆盖已有帧，也不参与容量
   * 计算；只有第 257 个不同的 future 帧才保留前缀、清空 buffer 并冻结。
   */
  private bufferFuture(
    stream: DisplayDraftStream,
    frame: DisplayDraftFrame,
  ): DisplayDraftApplyResult {
    if (stream.future.has(frame.sequence)) return "ignored";
    if (stream.future.size >= MAX_DISPLAY_DRAFT_FUTURE_FRAMES) {
      stream.future.clear();
      stream.state = "frozen";
      return stream.blocks.size > 0 ? "visible-changed" : "accepted";
    }
    stream.future.set(frame.sequence, frame);
    return "accepted";
  }

  /** 缺失帧到达后连续应用该帧及随后已缓存帧；返回可见正文或状态是否变化。 */
  private drainFuture(stream: DisplayDraftStream): boolean {
    let changed = false;
    while (stream.state === "streaming") {
      const frame = stream.future.get(stream.nextSequence);
      if (frame === undefined) return changed;
      stream.future.delete(stream.nextSequence);
      if (frame.type === "message_complete") {
        stream.state = "complete";
        stream.nextSequence = frame.sequence + 1;
        return changed || stream.blocks.size > 0;
      }
      if (this.appendDelta(stream, frame.contentIndex, frame.contentType, frame.delta) === "changed") {
        changed = true;
      }
      stream.nextSequence = frame.sequence + 1;
    }
    return changed;
  }

  private acceptEpoch(incarnationId: string, displayEpoch: string | undefined): boolean {
    const state = this.epochStates.get(incarnationId);
    if (state === undefined) {
      if (displayEpoch === undefined) return true;
      if (!isCanonicalUuid(displayEpoch)) return false;
      this.epochStates.set(incarnationId, {
        currentEpoch: displayEpoch,
        retiredEpochs: new Set<string>(),
        requiresEpoch: true,
      });
      return true;
    }
    if (displayEpoch === undefined) return !state.requiresEpoch && state.currentEpoch === undefined;
    if (!isCanonicalUuid(displayEpoch) || state.retiredEpochs.has(displayEpoch)) return false;
    if (state.currentEpoch === undefined) {
      state.currentEpoch = displayEpoch;
      state.requiresEpoch = true;
      return true;
    }
    return state.currentEpoch === displayEpoch;
  }

  private clearIncarnation(incarnationId: string): boolean {
    let changed = false;
    for (const [key, stream] of this.streams) {
      if (stream.incarnationId !== incarnationId) continue;
      if (stream.blocks.size > 0) changed = true;
      this.blockedStreams.add(this.bareStreamKey(stream.incarnationId, stream.streamId));
      this.tombstone(key);
      this.streams.delete(key);
    }
    return changed;
  }

  private bareStreamKey(incarnationId: string, streamId: string): string {
    return `${incarnationId}|${streamId}`;
  }

  private streamKey(
    incarnationId: string,
    displayEpoch: string | undefined,
    streamId: string,
  ): string {
    return `${incarnationId}|${displayEpoch ?? "legacy"}|${streamId}`;
  }
  private tombstone(key: string): void {
    // 显示流身份由 incarnationId + displayEpoch + streamId 组成；墓碑只保存
    // 短身份键，不保存正文，且与 future frame 预算完全独立。
    this.tombstones.set(key, true);
  }
}

/** 块正文按需物化；连续 delta 只向 chunks 追加，不复制既有前缀。 */
function displayDraftBlockValue(block: DisplayDraftBlock): string {
  if (block.joinedValue === undefined) block.joinedValue = block.chunks.join("");
  return block.joinedValue;
}

interface ProjectedDisplayDraftBlock {
  readonly contentIndex: number;
  readonly contentType: "text" | "thinking";
  readonly chunks: string[];
}

/** 与权威消息一致：相邻 thinking 组成一个显示组，text 会明确中断合并。 */
function projectDisplayDraftBlocks(
  blocks: ReadonlyMap<number, DisplayDraftBlock>,
): readonly AgentDisplayDraftBlockView[] {
  const projected: ProjectedDisplayDraftBlock[] = [];
  const ordered = [...blocks.entries()].sort(([left], [right]) => left - right);
  for (const [contentIndex, block] of ordered) {
    const value = displayDraftBlockValue(block);
    const previous = projected.at(-1);
    if (previous?.contentType === "thinking" && block.contentType === "thinking") {
      previous.chunks.push("\n\n", value);
      continue;
    }
    projected.push({ contentIndex, contentType: block.contentType, chunks: [value] });
  }
  return Object.freeze(projected.map((block) => Object.freeze({
    contentIndex: block.contentIndex,
    contentType: block.contentType,
    value: block.chunks.length === 1 ? block.chunks[0] ?? "" : block.chunks.join(""),
  })));
}

/**
 * 顶层运行时的实时草稿登记表：按 agent_id 分组隔离维护当前草稿，即使详情
 * 未打开也持续组装连续前缀。它只存在于顶层运行时进程内存；中间运行时不
 * 缓存草稿，只逐层 fire-and-forget 转发显示事实。
 */
export class AgentDisplayDraftRegistry {
  private readonly stores = new Map<string, AgentDisplayDraftStore>();
  private readonly listeners = new Set<(agentId: string) => void>();

  /**
   * 应用显示事件；仅当该代理的可见草稿变化时通知并返回 true。已接纳的纯
   * future 或等价事件仍会推进内部状态，但不会安排 UI 重绘。
   */
  applyEvent(agentId: string, event: SafeAgentActivityDisplayEvent): boolean {
    const store = this.store(agentId);
    if (store === undefined || event.agentId !== agentId) return false;
    if (event.type === "display_reset") {
      const changed = store.applyReset(event.incarnationId, event.displayEpoch);
      if (changed) this.notify(agentId);
      return changed;
    }
    if (!store.applyEvent(event)) return false;
    this.notify(agentId);
    return true;
  }

  /** 直接登记一个产生端 epoch；等价于接收 display_reset 控制事实。 */
  applyReset(agentId: string, incarnationId: string, displayEpoch: string): boolean {
    const store = this.store(agentId);
    if (store === undefined) return false;
    const changed = store.applyReset(incarnationId, displayEpoch);
    if (changed) this.notify(agentId);
    return changed;
  }

  /** 权威完整消息原地替换对应草稿；返回是否移除了可见草稿。 */
  replaceDraft(agentId: string, incarnationId: string, streamId: string): boolean {
    // 权威消息先到时也登记墓碑，使该流迟到的 delta 与 complete 被忽略。
    const store = this.store(agentId);
    if (store === undefined) return false;
    if (!store.replaceDraft(incarnationId, streamId)) return false;
    this.notify(agentId);
    return true;
  }

  /** 生命周期收束：清除该代理仍未被权威消息替换的草稿。 */
  settleAgent(agentId: string): boolean {
    const store = this.stores.get(agentId);
    if (store === undefined) return false;
    if (!store.settle()) return false;
    this.notify(agentId);
    return true;
  }

  /**
   * 同规格 reload 时丢弃全部非权威显示状态：草稿正文被清除，但旧流身份
   * 保留为有界墓碑，阻止交接期间迟到的 delta/complete 复活；权威活动历史
   * 由 AgentActivityCache 独立保留。
   */
  clear(): boolean {
    if (this.stores.size === 0) return false;
    let changed = false;
    for (const [agentId, store] of this.stores) {
      const before = store.drafts().length;
      const settled = store.prepareReload();
      if (before > 0 || settled) {
        changed = true;
        this.notify(agentId);
      }
    }
    return changed;
  }

  /** 语义别名，供 reload 交接调用；带身份参数时建立明确的新 epoch。 */
  reset(): boolean;
  reset(agentId: string, incarnationId: string, displayEpoch: string): boolean;
  reset(agentId?: string, incarnationId?: string, displayEpoch?: string): boolean {
    if (agentId !== undefined && incarnationId !== undefined && displayEpoch !== undefined) {
      return this.applyReset(agentId, incarnationId, displayEpoch);
    }
    return this.clear();
  }

  /** 该代理的草稿快照；未知代理为空。 */
  drafts(agentId: string): readonly AgentDisplayDraftView[] {
    return this.stores.get(agentId)?.drafts() ?? Object.freeze([]);
  }

  /** 注册草稿变更观察者；回调携带发生变更的代理身份。 */
  onChange(listener: (agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private store(agentId: string): AgentDisplayDraftStore | undefined {
    if (!isCanonicalUuid(agentId)) return undefined;
    let store = this.stores.get(agentId);
    if (store === undefined) {
      store = new AgentDisplayDraftStore(agentId);
      this.stores.set(agentId, store);
    }
    return store;
  }

  private notify(agentId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(agentId);
      } catch {
        // 观察者异常不能破坏草稿状态或后续通知。
      }
    }
  }
}
