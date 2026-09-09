import { isCanonicalUuid } from "./tree-controller.ts";
import type { SafeAgentActivityDisplayEvent } from "./rpc-bridge-event.ts";

/**
 * 每个实时流最多暂存的尚未连续 future 帧数量。到达第 257 个未来帧时保留
 * 已验证连续前缀、丢弃 future buffer 并冻结该流；连续前缀本身不设聚合
 * 字节上限。这是实现边界，不是用户配额。
 */
export const MAX_DISPLAY_DRAFT_FUTURE_FRAMES = 256;

/**
 * 每代理最多保留的已收束实时流身份墓碑数量。墓碑防止权威消息先到后迟到
 * delta 复活旧流；按 FIFO 淘汰最旧的墓碑。
 */
const MAX_DISPLAY_DRAFT_TOMBSTONES = 256;

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

/** 未来帧按 sequence 原样暂存；补齐缺口后按帧类型应用。 */
type DisplayDraftFrame = DisplayDraftDeltaFrame | DisplayDraftCompleteFrame;

interface DisplayDraftStream {
  nextSequence: number;
  state: AgentDisplayDraftState;
  readonly blocks: Map<number, { contentType: "text" | "thinking"; value: string }>;
  /** 尚未连续的未来帧，按 sequence 暂存；冻结时整体丢弃。 */
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
  /** 已收束/已替换流的身份墓碑：插入序即淘汰序，防止旧流复活。 */
  private readonly tombstones = new Map<string, true>();

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * 应用一条身份校验过的显示事件；返回是否改变了可见草稿状态。
   * 事件身份与该代理不符时静默忽略，绝不串流到其他代理的草稿。
   */
  applyEvent(event: SafeAgentActivityDisplayEvent): boolean {
    if (event.agentId !== this.agentId) return false;
    const key = `${event.incarnationId}|${event.streamId}`;
    if (this.tombstones.has(key)) return false;
    const stream = this.streams.get(key);
    if (event.type === "message_complete") return this.applyComplete(stream, event);
    return this.applyDelta(key, stream, event);
  }

  /**
   * 权威完整消息到达：原地替换并清除对应实时流草稿。权威消息先到时也登记
   * 墓碑，使该流后续迟到的 delta 与 complete 被忽略（旧流不复活）。
   */
  replaceDraft(incarnationId: string, streamId: string): boolean {
    if (!isCanonicalUuid(incarnationId)) return false;
    const key = `${incarnationId}|${streamId}`;
    this.tombstone(key);
    const removed = this.streams.delete(key);
    return removed;
  }

  /**
   * 生命周期收束（idle、failed 或 terminated）：清除所有尚未被权威消息替换
   * 的草稿并登记墓碑。之后同一运行实例迟到的合法权威消息仍可写入历史；
   * 新启动的消息流使用新 streamId，不受墓碑影响。
   */
  settle(): boolean {
    if (this.streams.size === 0) return false;
    for (const key of [...this.streams.keys()]) this.tombstone(key);
    this.streams.clear();
    return true;
  }

  /**
   * 当前草稿的连续前缀投影；没有可见内容的流不产生视图。相邻 thinking
   * 块在显示边界实时合并，底层帧重排仍保留原始 contentIndex。
   */
  drafts(): readonly AgentDisplayDraftView[] {
    const views: AgentDisplayDraftView[] = [];
    for (const [key, stream] of this.streams) {
      if (stream.blocks.size === 0) continue;
      const blocks = projectDisplayDraftBlocks(stream.blocks);
      views.push(Object.freeze({ key, state: stream.state, blocks }));
    }
    return Object.freeze(views);
  }

  private applyDelta(
    key: string,
    stream: DisplayDraftStream | undefined,
    event: Extract<SafeAgentActivityDisplayEvent, { type: "message_delta" }>,
  ): boolean {
    if (stream !== undefined) {
      if (stream.state !== "streaming") return false;
      if (event.sequence < stream.nextSequence) return false;
      if (event.sequence > stream.nextSequence) return this.bufferFuture(stream, event);
      if (!this.appendDelta(stream, event.contentIndex, event.contentType, event.delta)) return false;
      stream.nextSequence = event.sequence + 1;
      this.drainFuture(stream);
      return true;
    }
    // 首帧缺序：仍然建立流并暂存未来帧，等待 sequence 1 补齐连续前缀。
    const created: DisplayDraftStream = {
      nextSequence: 1,
      state: "streaming",
      blocks: new Map(),
      future: new Map(),
    };
    if (event.sequence === 1) {
      this.appendDelta(created, event.contentIndex, event.contentType, event.delta);
      created.nextSequence = 2;
    } else if (!this.bufferFuture(created, event)) {
      return false;
    }
    this.streams.set(key, created);
    return true;
  }

  private applyComplete(
    stream: DisplayDraftStream | undefined,
    event: Extract<SafeAgentActivityDisplayEvent, { type: "message_complete" }>,
  ): boolean {
    if (stream === undefined) {
      // 没有任何 delta 的流没有可显示草稿；complete 只收束显示流，不建立占位。
      return false;
    }
    if (stream.state !== "streaming") return false;
    if (event.sequence < stream.nextSequence) return false;
    if (event.sequence > stream.nextSequence) return this.bufferFuture(stream, event);
    stream.state = "complete";
    stream.nextSequence = event.sequence + 1;
    return true;
  }

  /** 就绪帧写入连续前缀；contentIndex 类型冲突属于产生端违约，幂等忽略。 */
  private appendDelta(
    stream: DisplayDraftStream,
    contentIndex: number,
    contentType: "text" | "thinking",
    delta: string,
  ): boolean {
    const block = stream.blocks.get(contentIndex);
    if (block !== undefined) {
      if (block.contentType !== contentType) return false;
      block.value += delta;
      return true;
    }
    stream.blocks.set(contentIndex, { contentType, value: delta });
    return true;
  }

  /**
   * 未来帧按 sequence 暂存。buffer 已满时保留已验证前缀、丢弃 future
   * buffer 并冻结该流：冻结后不继续应用 token，等待权威完整消息。
   */
  private bufferFuture(
    stream: DisplayDraftStream,
    frame: DisplayDraftFrame,
  ): boolean {
    if (stream.future.size >= MAX_DISPLAY_DRAFT_FUTURE_FRAMES) {
      stream.future.clear();
      stream.state = "frozen";
      return true;
    }
    stream.future.set(frame.sequence, frame);
    return true;
  }

  /** 缺失帧到达后连续应用该帧及随后已缓存帧；complete 缓存帧收束该流。 */
  private drainFuture(stream: DisplayDraftStream): void {
    while (stream.state === "streaming") {
      const frame = stream.future.get(stream.nextSequence);
      if (frame === undefined) return;
      stream.future.delete(stream.nextSequence);
      if (frame.type === "message_complete") {
        stream.state = "complete";
        stream.nextSequence = frame.sequence + 1;
        return;
      }
      this.appendDelta(stream, frame.contentIndex, frame.contentType, frame.delta);
      stream.nextSequence = frame.sequence + 1;
    }
  }

  private tombstone(key: string): void {
    if (this.tombstones.has(key)) return;
    this.tombstones.set(key, true);
    while (this.tombstones.size > MAX_DISPLAY_DRAFT_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) return;
      this.tombstones.delete(oldest);
    }
  }
}

/** 与权威消息一致：相邻 thinking 组成一个显示组，text 会明确中断合并。 */
function projectDisplayDraftBlocks(
  blocks: ReadonlyMap<number, { readonly contentType: "text" | "thinking"; readonly value: string }>,
): readonly AgentDisplayDraftBlockView[] {
  const projected: AgentDisplayDraftBlockView[] = [];
  const ordered = [...blocks.entries()].sort(([left], [right]) => left - right);
  for (const [contentIndex, block] of ordered) {
    const previous = projected.at(-1);
    if (previous?.contentType === "thinking" && block.contentType === "thinking") {
      projected[projected.length - 1] = Object.freeze({
        contentIndex: previous.contentIndex,
        contentType: "thinking",
        value: `${previous.value}\n\n${block.value}`,
      });
      continue;
    }
    projected.push(Object.freeze({
      contentIndex,
      contentType: block.contentType,
      value: block.value,
    }));
  }
  return Object.freeze(projected);
}

/**
 * 顶层运行时的实时草稿登记表：按 agent_id 分组隔离维护当前草稿，即使详情
 * 未打开也持续组装连续前缀。它只存在于顶层运行时进程内存；中间运行时不
 * 缓存草稿，只逐层 fire-and-forget 转发显示事实。
 */
export class AgentDisplayDraftRegistry {
  private readonly stores = new Map<string, AgentDisplayDraftStore>();
  private readonly listeners = new Set<(agentId: string) => void>();

  /** 应用一条身份校验过的显示事件；返回是否改变了该代理的可见草稿。 */
  applyEvent(agentId: string, event: SafeAgentActivityDisplayEvent): boolean {
    const store = this.store(agentId);
    if (store === undefined) return false;
    if (!store.applyEvent(event)) return false;
    this.notify(agentId);
    return true;
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
