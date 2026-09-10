import { isCanonicalUuid } from "./tree-controller.ts";
import {
  isValidDisplayEpoch,
  isValidDisplaySourceGeneration,
  isValidDisplayStreamOrdinal,
  type DisplayStreamRef,
  type SafeAgentActivityDisplayEvent,
} from "./rpc-bridge-event.ts";

/**
 * 每个实时流最多暂存的尚未连续 future 帧数量。到达第 257 个未来帧时保留
 * 已验证连续前缀、丢弃 future buffer 并冻结该流；连续前缀本身不设聚合
 * 字节上限。这是实现边界，不是用户配额。
 */
export const MAX_DISPLAY_DRAFT_FUTURE_FRAMES = 256;

/** 实时草稿的显示状态；frozen 表示异常乱序冻结，等待权威完整消息。 */
export type AgentDisplayDraftState = "streaming" | "complete" | "frozen";

export interface AgentDisplayDraftBlockView {
  readonly contentIndex: number;
  readonly contentType: "text" | "thinking";
  readonly value: string;
}

/** 顶层草稿投影：从 sequence 1 开始的连续前缀，供查看器直接渲染。 */
export interface AgentDisplayDraftView {
  /** 跨快照稳定的草稿身份；ordered wire 包含完整 source/stream identity。 */
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

interface OrderedDisplaySource {
  readonly incarnationId: string;
  readonly displayEpoch: string;
  readonly displaySourceGeneration: number;
}

interface OrderedDisplayStream extends OrderedDisplaySource {
  readonly streamId: string;
  readonly streamOrdinal: number;
}

interface DisplayDraftStream {
  readonly incarnationId: string;
  readonly streamId: string;
  readonly displayEpoch: string | undefined;
  readonly displaySourceGeneration: number | undefined;
  readonly streamOrdinal: number | undefined;
  nextSequence: number;
  state: AgentDisplayDraftState;
  readonly blocks: Map<number, DisplayDraftBlock>;
  /** 仅在块正文变化时失效，纯 future 帧不会重复物化已有正文。 */
  projectedBlocks: readonly AgentDisplayDraftBlockView[] | undefined;
  /** 尚未连续的未来帧，按 sequence 唯一暂存；冻结时整体丢弃。 */
  readonly future: Map<number, DisplayDraftFrame>;
}

/**
 * canonical wire 的单个 source 只保留一个 cursor。sealedThroughStreamOrdinal
 * 是无界 tombstone 集合的替代：任何不高于该游标的迟到流永久无效；closed
 * 则在生命周期/clear 后拒绝整个同代 source，直到更高 generation 到达。
 */
interface OrderedDisplayCursor extends OrderedDisplaySource {
  sealedThroughStreamOrdinal: number;
  closed: boolean;
  active: DisplayDraftStream | undefined;
}

/** 旧本地 raw-Pi 调用没有排序身份，只提供一个常数空间的兼容降级路径。 */
interface LegacyDisplayCursor {
  sealedStreamId: string | undefined;
  closed: boolean;
  active: DisplayDraftStream | undefined;
}

interface SourceAcceptance {
  readonly accepted: boolean;
  /** 接受较高 source 时可能移除了旧可见草稿。 */
  readonly visibleChanged: boolean;
  /** reset 需要把 source 自身的变化作为可观察结果返回。 */
  readonly sourceChanged: boolean;
}

const SOURCE_REJECTED: SourceAcceptance = Object.freeze({
  accepted: false,
  visibleChanged: false,
  sourceChanged: false,
});

/**
 * 单个代理的实时草稿状态机。完整 ordered wire 只使用一个 source cursor 和
 * 一个 active stream，因此长会话不会按 completed stream 增长元数据。future
 * 缓冲仍保留每活跃流 256 帧的原有边界；正文只由 active draft 持有。
 */
export class AgentDisplayDraftStore {
  private readonly agentId: string;
  private mode: "ordered" | "legacy" | undefined;
  private ordered: OrderedDisplayCursor | undefined;
  private legacy: LegacyDisplayCursor | undefined;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /** 应用一条身份校验过的显示事件；返回是否改变可见草稿。 */
  applyEvent(event: SafeAgentActivityDisplayEvent): boolean {
    if (event.type === "display_reset" || event.agentId !== this.agentId) return false;
    const ordered = orderedStreamOf(event);
    if (ordered !== undefined) return this.applyOrderedEvent(event, ordered);
    if (hasAnyOrderedIdentity(event)) return false;
    return this.applyLegacyEvent(event);
  }

  /**
   * 应用来自产生端的无状态 reload barrier。wire 调用必须带 generation；无
   * generation 的形状只用于本地兼容，并且不能推翻已经建立的 ordered source。
   */
  applyReset(
    incarnationId: string,
    displayEpoch: string,
    displaySourceGeneration?: number,
  ): boolean {
    if (!isCanonicalUuid(incarnationId) || !isValidDisplayEpoch(displayEpoch)) return false;
    if (displaySourceGeneration === undefined) {
      if (this.mode === "ordered") return false;
      const cursor = this.ensureLegacyCursor();
      const visibleChanged = this.discardActive(cursor.active);
      cursor.active = undefined;
      cursor.sealedStreamId = undefined;
      const changed = visibleChanged || !cursor.closed || this.mode !== "legacy";
      cursor.closed = false;
      this.mode = "legacy";
      return changed;
    }
    if (!isValidDisplaySourceGeneration(displaySourceGeneration)) return false;
    const source: OrderedDisplaySource = {
      incarnationId,
      displayEpoch,
      displaySourceGeneration,
    };
    const accepted = this.acceptOrderedSource(source);
    return accepted.accepted && (accepted.sourceChanged || accepted.visibleChanged);
  }

  /**
   * 权威完整消息到达时原地替换匹配草稿。完整 ordered identity 能把对应 ordinal
   * 封存而无需为每条历史 stream 留下墓碑；bare streamId 仅保留本地兼容。
   */
  replaceDraft(incarnationId: string, stream: string | DisplayStreamRef): boolean {
    if (!isCanonicalUuid(incarnationId)) return false;
    if (typeof stream === "string") return this.replaceLegacyDraft(incarnationId, stream);
    const ordered = orderedStreamFromRef(incarnationId, stream);
    if (ordered === undefined) return false;
    const accepted = this.acceptOrderedSource(ordered);
    if (!accepted.accepted) return false;
    const cursor = this.ordered;
    if (cursor === undefined || cursor.closed) return accepted.visibleChanged;
    if (ordered.streamOrdinal <= cursor.sealedThroughStreamOrdinal) return accepted.visibleChanged;

    const active = cursor.active;
    if (active !== undefined) {
      const activeOrdinal = active.streamOrdinal;
      if (activeOrdinal === ordered.streamOrdinal) {
        if (active.streamId !== ordered.streamId) return accepted.visibleChanged;
        const visibleChanged = this.discardActive(active);
        cursor.active = undefined;
        cursor.sealedThroughStreamOrdinal = Math.max(
          cursor.sealedThroughStreamOrdinal,
          ordered.streamOrdinal,
        );
        return accepted.visibleChanged || visibleChanged;
      }
      if (activeOrdinal !== undefined && activeOrdinal > ordered.streamOrdinal) {
        return accepted.visibleChanged;
      }
      // 更高 ordinal 的权威消息已经覆盖此低序 provisional 草稿；保留它会
      // 让草稿投影与权威历史并存，并且错误地显示已封存的旧流。
      const visibleChanged = this.discardActive(active);
      cursor.active = undefined;
      cursor.sealedThroughStreamOrdinal = Math.max(
        cursor.sealedThroughStreamOrdinal,
        ordered.streamOrdinal,
      );
      return accepted.visibleChanged || visibleChanged;
    }
    cursor.sealedThroughStreamOrdinal = Math.max(
      cursor.sealedThroughStreamOrdinal,
      ordered.streamOrdinal,
    );
    return accepted.visibleChanged;
  }

  /** 生命周期收束：清除当前草稿并关闭当前 source，等待更高 generation。 */
  settle(): boolean {
    if (this.mode === "ordered") {
      const cursor = this.ordered;
      if (cursor === undefined) return false;
      const visibleChanged = this.discardActive(cursor.active);
      if (cursor.active?.streamOrdinal !== undefined) {
        cursor.sealedThroughStreamOrdinal = Math.max(
          cursor.sealedThroughStreamOrdinal,
          cursor.active.streamOrdinal,
        );
      }
      cursor.active = undefined;
      cursor.closed = true;
      return visibleChanged;
    }
    if (this.mode === "legacy") {
      const cursor = this.legacy;
      if (cursor === undefined) return false;
      const visibleChanged = this.discardActive(cursor.active);
      if (cursor.active !== undefined) cursor.sealedStreamId = cursor.active.streamId;
      cursor.active = undefined;
      cursor.closed = true;
      return visibleChanged;
    }
    return false;
  }

  /** reload 清理与 lifecycle 相同：当前 source 关闭，较高 generation 才能重开。 */
  prepareReload(): boolean {
    return this.settle();
  }

  /** 当前草稿的连续前缀投影；没有可见内容的流不产生视图。 */
  drafts(): readonly AgentDisplayDraftView[] {
    const active = this.activeStream();
    if (active === undefined || active.blocks.size === 0) return Object.freeze([]);
    let blocks = active.projectedBlocks;
    if (blocks === undefined) {
      blocks = projectDisplayDraftBlocks(active.blocks);
      active.projectedBlocks = blocks;
    }
    return Object.freeze([Object.freeze({
      key: draftKey(active),
      state: active.state,
      blocks,
    })]);
  }

  private applyOrderedEvent(
    event: Exclude<SafeAgentActivityDisplayEvent, { type: "display_reset" }>,
    identity: OrderedDisplayStream,
  ): boolean {
    const accepted = this.acceptOrderedSource(identity);
    if (!accepted.accepted) return false;
    const cursor = this.ordered;
    if (cursor === undefined || cursor.closed) return accepted.visibleChanged;
    if (identity.streamOrdinal <= cursor.sealedThroughStreamOrdinal) return accepted.visibleChanged;

    let stream = cursor.active;
    let visibleChanged = accepted.visibleChanged;
    if (stream !== undefined) {
      const activeOrdinal = stream.streamOrdinal;
      if (activeOrdinal === identity.streamOrdinal) {
        if (stream.streamId !== identity.streamId) return visibleChanged;
      } else if (activeOrdinal !== undefined && activeOrdinal > identity.streamOrdinal) {
        return visibleChanged;
      } else {
        visibleChanged = this.discardActive(stream) || visibleChanged;
        cursor.active = undefined;
        // 一旦看到更高 ordinal，所有更低 provisional stream 都不可再复活。
        cursor.sealedThroughStreamOrdinal = Math.max(
          cursor.sealedThroughStreamOrdinal,
          identity.streamOrdinal - 1,
        );
        stream = undefined;
      }
    }

    if (stream === undefined) {
      if (identity.streamOrdinal > cursor.sealedThroughStreamOrdinal + 1) {
        cursor.sealedThroughStreamOrdinal = identity.streamOrdinal - 1;
      }
      if (event.type === "message_complete") {
        // 没有正文的 complete 也封存该 stream，不能让后到 delta 建立草稿。
        cursor.sealedThroughStreamOrdinal = Math.max(
          cursor.sealedThroughStreamOrdinal,
          identity.streamOrdinal,
        );
        return visibleChanged;
      }
      stream = this.createStream(event, identity);
      cursor.active = stream;
    }

    const result = event.type === "message_complete"
      ? this.applyComplete(stream, event)
      : this.applyDelta(stream, event);
    return visibleChanged || result === "visible-changed";
  }

  private applyLegacyEvent(
    event: Exclude<SafeAgentActivityDisplayEvent, { type: "display_reset" }>,
  ): boolean {
    if (this.mode === "ordered") return false;
    const cursor = this.ensureLegacyCursor();
    this.mode = "legacy";
    if (cursor.closed || cursor.sealedStreamId === event.streamId) return false;

    let stream = cursor.active;
    let visibleChanged = false;
    if (stream !== undefined && stream.streamId !== event.streamId) {
      visibleChanged = this.discardActive(stream);
      cursor.sealedStreamId = stream.streamId;
      cursor.active = undefined;
      stream = undefined;
    }
    if (stream === undefined) {
      if (event.type === "message_complete") {
        cursor.sealedStreamId = event.streamId;
        return visibleChanged;
      }
      stream = this.createStream(event);
      cursor.active = stream;
    }
    const result = event.type === "message_complete"
      ? this.applyComplete(stream, event)
      : this.applyDelta(stream, event);
    return visibleChanged || result === "visible-changed";
  }

  private replaceLegacyDraft(incarnationId: string, streamId: string): boolean {
    if (streamId.length === 0 || this.mode === "ordered") return false;
    const cursor = this.ensureLegacyCursor();
    this.mode = "legacy";
    const active = cursor.active;
    if (active !== undefined && active.incarnationId === incarnationId && active.streamId === streamId) {
      const visibleChanged = this.discardActive(active);
      cursor.active = undefined;
      cursor.sealedStreamId = streamId;
      return visibleChanged;
    }
    cursor.sealedStreamId = streamId;
    return false;
  }

  private acceptOrderedSource(source: OrderedDisplaySource): SourceAcceptance {
    const previousMode = this.mode;
    if (previousMode === undefined) {
      this.mode = "ordered";
      this.ordered = newOrderedCursor(source);
      return Object.freeze({ accepted: true, visibleChanged: false, sourceChanged: true });
    }
    if (previousMode === "legacy") {
      const visibleChanged = this.discardActive(this.legacy?.active);
      this.legacy = undefined;
      this.mode = "ordered";
      this.ordered = newOrderedCursor(source);
      return Object.freeze({ accepted: true, visibleChanged, sourceChanged: true });
    }
    const cursor = this.ordered;
    if (cursor === undefined) return SOURCE_REJECTED;
    if (source.displaySourceGeneration < cursor.displaySourceGeneration) return SOURCE_REJECTED;
    if (source.displaySourceGeneration === cursor.displaySourceGeneration) {
      if (!sameOrderedSource(cursor, source)) return SOURCE_REJECTED;
      return Object.freeze({ accepted: true, visibleChanged: false, sourceChanged: false });
    }
    const visibleChanged = this.discardActive(cursor.active);
    this.ordered = newOrderedCursor(source);
    return Object.freeze({ accepted: true, visibleChanged, sourceChanged: true });
  }

  private ensureLegacyCursor(): LegacyDisplayCursor {
    let cursor = this.legacy;
    if (cursor === undefined) {
      cursor = { sealedStreamId: undefined, closed: false, active: undefined };
      this.legacy = cursor;
    }
    return cursor;
  }

  private activeStream(): DisplayDraftStream | undefined {
    return this.mode === "ordered" ? this.ordered?.active : this.legacy?.active;
  }

  private discardActive(stream: DisplayDraftStream | undefined): boolean {
    return stream !== undefined && stream.blocks.size > 0;
  }

  private createStream(
    event: Extract<SafeAgentActivityDisplayEvent, { type: "message_delta" }>,
    identity?: OrderedDisplayStream,
  ): DisplayDraftStream {
    return {
      incarnationId: event.incarnationId,
      streamId: event.streamId,
      displayEpoch: identity?.displayEpoch,
      displaySourceGeneration: identity?.displaySourceGeneration,
      streamOrdinal: identity?.streamOrdinal,
      nextSequence: 1,
      state: "streaming",
      blocks: new Map(),
      projectedBlocks: undefined,
      future: new Map(),
    };
  }

  private applyDelta(
    stream: DisplayDraftStream,
    event: Extract<SafeAgentActivityDisplayEvent, { type: "message_delta" }>,
  ): DisplayDraftApplyResult {
    if (stream.state !== "streaming") return "ignored";
    if (event.sequence < stream.nextSequence) return "ignored";
    if (event.sequence > stream.nextSequence) return this.bufferFuture(stream, event);
    const appended = this.appendDelta(stream, event.contentIndex, event.contentType, event.delta);
    if (appended === "rejected") return "ignored";
    stream.nextSequence = event.sequence + 1;
    const drainedChanged = this.drainFuture(stream);
    return appended === "changed" || drainedChanged ? "visible-changed" : "accepted";
  }

  private applyComplete(
    stream: DisplayDraftStream,
    event: Extract<SafeAgentActivityDisplayEvent, { type: "message_complete" }>,
  ): DisplayDraftApplyResult {
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

  /** future 帧 first-wins；第 257 个不同 future 帧冻结而不丢弃连续前缀。 */
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

  /** 缺失帧补齐后连续应用 future；不物化未变化的已有块。 */
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
}

function newOrderedCursor(source: OrderedDisplaySource): OrderedDisplayCursor {
  return {
    ...source,
    sealedThroughStreamOrdinal: 0,
    closed: false,
    active: undefined,
  };
}

function sameOrderedSource(left: OrderedDisplaySource, right: OrderedDisplaySource): boolean {
  return left.incarnationId === right.incarnationId
    && left.displayEpoch === right.displayEpoch
    && left.displaySourceGeneration === right.displaySourceGeneration;
}

function hasAnyOrderedIdentity(
  event: Exclude<SafeAgentActivityDisplayEvent, { type: "display_reset" }>,
): boolean {
  return event.displayEpoch !== undefined
    || event.displaySourceGeneration !== undefined
    || event.streamOrdinal !== undefined;
}

function orderedStreamOf(
  event: Exclude<SafeAgentActivityDisplayEvent, { type: "display_reset" }>,
): OrderedDisplayStream | undefined {
  if (
    !isCanonicalUuid(event.incarnationId)
    || !isValidDisplayEpoch(event.displayEpoch)
    || !isValidDisplaySourceGeneration(event.displaySourceGeneration)
    || !isValidDisplayStreamOrdinal(event.streamOrdinal)
    || event.streamId.length === 0
  ) return undefined;
  return {
    incarnationId: event.incarnationId,
    displayEpoch: event.displayEpoch,
    displaySourceGeneration: event.displaySourceGeneration,
    streamId: event.streamId,
    streamOrdinal: event.streamOrdinal,
  };
}

function orderedStreamFromRef(
  incarnationId: string,
  stream: DisplayStreamRef,
): OrderedDisplayStream | undefined {
  if (
    stream.streamId.length === 0
    || !isValidDisplayEpoch(stream.displayEpoch)
    || !isValidDisplaySourceGeneration(stream.displaySourceGeneration)
    || !isValidDisplayStreamOrdinal(stream.streamOrdinal)
  ) return undefined;
  return {
    incarnationId,
    streamId: stream.streamId,
    displayEpoch: stream.displayEpoch,
    displaySourceGeneration: stream.displaySourceGeneration,
    streamOrdinal: stream.streamOrdinal,
  };
}

function draftKey(stream: DisplayDraftStream): string {
  if (
    stream.displayEpoch !== undefined
    && stream.displaySourceGeneration !== undefined
    && stream.streamOrdinal !== undefined
  ) {
    return agentDisplayDraftKey(stream.incarnationId, {
      streamId: stream.streamId,
      displayEpoch: stream.displayEpoch,
      displaySourceGeneration: stream.displaySourceGeneration,
      streamOrdinal: stream.streamOrdinal,
    });
  }
  return agentDisplayDraftKey(stream.incarnationId, stream.streamId);
}

/** 在草稿与对应权威消息之间共享的稳定显示身份。 */
export function agentDisplayDraftKey(
  incarnationId: string,
  stream: string | DisplayStreamRef,
): string {
  if (typeof stream === "string") return `${incarnationId}|${stream}`;
  return [
    incarnationId,
    stream.displayEpoch,
    stream.displaySourceGeneration,
    stream.streamOrdinal,
    stream.streamId,
  ].join("|");
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
 * 顶层运行时的实时草稿登记表：按 agent_id 分组隔离维护一个有序 cursor，
 * 即使详情未打开也持续组装连续前缀。中间运行时不缓存草稿，只逐层
 * fire-and-forget 转发显示事实。
 */
export class AgentDisplayDraftRegistry {
  private readonly stores = new Map<string, AgentDisplayDraftStore>();
  private readonly listeners = new Set<(agentId: string) => void>();

  /** 仅当可见草稿变化时通知；纯 future 帧仍会在 store 内被接纳。 */
  applyEvent(agentId: string, event: SafeAgentActivityDisplayEvent): boolean {
    const store = this.store(agentId);
    if (store === undefined || event.agentId !== agentId) return false;
    if (event.type === "display_reset") {
      const changed = store.applyReset(
        event.incarnationId,
        event.displayEpoch,
        event.displaySourceGeneration,
      );
      if (changed) this.notify(agentId);
      return changed;
    }
    if (!store.applyEvent(event)) return false;
    this.notify(agentId);
    return true;
  }

  /** 直接登记一个产生端 source reset；等价于接收 display_reset 控制事实。 */
  applyReset(
    agentId: string,
    incarnationId: string,
    displayEpoch: string,
    displaySourceGeneration?: number,
  ): boolean {
    const store = this.store(agentId);
    if (store === undefined) return false;
    const changed = store.applyReset(incarnationId, displayEpoch, displaySourceGeneration);
    if (changed) this.notify(agentId);
    return changed;
  }

  /** 权威完整消息原地替换对应草稿；返回是否移除了可见草稿。 */
  replaceDraft(agentId: string, incarnationId: string, stream: string | DisplayStreamRef): boolean {
    const store = this.store(agentId);
    if (store === undefined) return false;
    if (!store.replaceDraft(incarnationId, stream)) return false;
    this.notify(agentId);
    return true;
  }

  /** 生命周期收束：清除该代理仍未被权威消息替换的草稿并关闭当前 source。 */
  settleAgent(agentId: string): boolean {
    const store = this.stores.get(agentId);
    if (store === undefined) return false;
    if (!store.settle()) return false;
    this.notify(agentId);
    return true;
  }

  /** reload 清除正文并关闭当前 source；cursor 保持为常数大小的迟到帧屏障。 */
  clear(): boolean {
    let changed = false;
    for (const [agentId, store] of this.stores) {
      if (!store.prepareReload()) continue;
      changed = true;
      this.notify(agentId);
    }
    return changed;
  }

  /**
   * 删除该代理的全部草稿状态，包括迟到帧防线（ordered cursor）。
   *
   * 当前没有调用点：这是有意保持 dormant 的方法。display 传输是
   * fire-and-forget，没有 ACK、重试或跨事件顺序承诺；cursor 的
   * sealedThroughStreamOrdinal 是阻止已收束旧流被迟到 delta 复活的唯一
   * 屏障。现有生命周期信号（idle、failed、terminated、reload 边界）只
   * 证明“此刻不活跃”，不证明“之后不会再有该代理的 display 帧到达”——
   * 通道在途帧与已捕获回调队列里的排队帧都可能晚于本地收束。删除
   * cursor 会同时删除这道防线，因此必须等到一个可信赖的永久交付闭环
   * 事实（如监督通道确认 display delivery 已永久关闭的
   * ActivityDeliveryClosed 类信号）后才能接入。
   *
   * 在此之前每个 agent 保留一条常数大小的 cursor，这是当前容量设计下
   * 可接受的代价；只有真实的长期内存回收需求才值得设计闭环信号并
   * 启用本方法。
   */
  releaseAgent(agentId: string): boolean {
    const store = this.stores.get(agentId);
    if (store === undefined) return false;
    const hadVisibleDraft = store.drafts().length > 0;
    this.stores.delete(agentId);
    if (hadVisibleDraft) this.notify(agentId);
    return true;
  }

  /** 语义别名，供 reload 交接调用；带身份参数时建立明确的新 source。 */
  reset(): boolean;
  reset(agentId: string, incarnationId: string, displayEpoch: string): boolean;
  reset(agentId: string, incarnationId: string, displayEpoch: string, displaySourceGeneration: number): boolean;
  reset(
    agentId?: string,
    incarnationId?: string,
    displayEpoch?: string,
    displaySourceGeneration?: number,
  ): boolean {
    if (agentId !== undefined && incarnationId !== undefined && displayEpoch !== undefined) {
      return this.applyReset(agentId, incarnationId, displayEpoch, displaySourceGeneration);
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
