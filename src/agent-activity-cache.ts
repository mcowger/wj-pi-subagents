import { isDeepStrictEqual } from "node:util";
import { isCanonicalUuid } from "./tree-controller.ts";
import { DEFAULT_TOOL_EXECUTION_GENERATION } from "./rpc-bridge-event.ts";
import {
  parseCanonicalAgentActivityEntry,
  type CanonicalAgentActivityEntry,
} from "./canonical-activity.ts";

/** 每个代理可见活动窗口的原子条目上限；淘汰提示不占用该额度。 */
export const AGENT_ACTIVITY_MAX_ATOMS = 100;
/** 每个代理保留的终态身份墓碑上限；墓碑只用于阻止淘汰后的迟到复活。 */
export const AGENT_ACTIVITY_MAX_TOMBSTONES = 256;

// 这些别名让调用方可以按“窗口/条目”语义引用同一固定边界。
export const MAX_AGENT_ACTIVITY_ENTRIES = AGENT_ACTIVITY_MAX_ATOMS;
export const MAX_AGENT_ACTIVITY_TOMBSTONES = AGENT_ACTIVITY_MAX_TOMBSTONES;

export type AgentActivitySettlementState = "idle" | "failed" | "terminated";

/** 一次 record 的裁决；duplicate 表示事实合法但没有可见变化。 */
export type AgentActivityRecordDisposition =
  | "appended"
  | "updated"
  | "duplicate"
  | "rejected";

/** 顶层活动缓存的可回放快照。正文本身不按大小截断。 */
export interface AgentActivitySnapshot {
  readonly entries: readonly CanonicalAgentActivityEntry[];
  readonly revision: number;
  readonly olderActivityOmitted: boolean;
}

/** record/settle 的公开结果，兼容旧的 void append API。 */
export interface AgentActivityRecordResult {
  readonly accepted: boolean;
  /** 当前可见 entries 或 omission 标记是否发生变化。 */
  readonly changed: boolean;
  readonly disposition: AgentActivityRecordDisposition;
  readonly snapshot: AgentActivitySnapshot;
}

export type AgentActivityResult = AgentActivityRecordResult;

type ActivityAtomKind = "message" | "parent_message" | "tool";
type ActivityAtomState = "running" | "settled" | "completed";

interface ToolIdentity {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly origin: string;
  readonly executionGeneration: number;
}

interface ActivityIdentity {
  readonly logicalKey: string;
  readonly entryIdentityKey: string;
  readonly kind: ActivityAtomKind;
  readonly incarnationId: string;
  readonly entryId: string;
  readonly tool: ToolIdentity | undefined;
}

interface ActivityAtom {
  readonly identity: ActivityIdentity;
  readonly ordinal: number;
  entry: CanonicalAgentActivityEntry;
  state: ActivityAtomState;
  startEntry: CanonicalAgentActivityEntry | undefined;
  endEntry: CanonicalAgentActivityEntry | undefined;
}

/** 淘汰后只保留有限数量的终态身份，避免迟到事实重新创建旧工具。 */
interface ActivityTombstone {
  readonly identity: ActivityIdentity;
  entry: CanonicalAgentActivityEntry;
  startEntry: CanonicalAgentActivityEntry | undefined;
  endEntry: CanonicalAgentActivityEntry | undefined;
}

interface AgentActivityRecord {
  readonly atoms: ActivityAtom[];
  readonly byIdentity: Map<string, ActivityAtom>;
  readonly byEntryIdentity: Map<string, string>;
  readonly toolTombstones: Map<string, ActivityTombstone>;
  readonly entryTombstones: Map<string, ActivityTombstone>;
  /** 所有 tombstone 共用一个有界插入序，工具墓碑优先保留。 */
  readonly tombstoneOrder: Map<string, "tool" | "entry">;
  readonly tombstonesByEntryIdentity: Map<string, string>;
  revision: number;
  olderActivityOmitted: boolean;
  nextOrdinal: number;
}

interface VisibleActivityState {
  readonly entries: readonly CanonicalAgentActivityEntry[];
  readonly olderActivityOmitted: boolean;
}

type ToolActivityBody = Extract<
  CanonicalAgentActivityEntry["body"],
  { readonly type: "tool_execution_start" | "tool_execution_end" }
>;

const EMPTY_ENTRIES: readonly CanonicalAgentActivityEntry[] = Object.freeze([]);
const EMPTY_SNAPSHOT: AgentActivitySnapshot = Object.freeze({
  entries: EMPTY_ENTRIES,
  revision: 0,
  olderActivityOmitted: false,
});

/**
 * 顶层运行时的有界活动流缓存：按 agent_id 分组保存原子活动，工具 start/end
 * 使用运行实例、工具活动 ID 与执行代次聚合。它只存在于顶层运行时进程内存，不落盘；
 * 代理终止后记录、淘汰事实和有限身份墓碑仍可回放或裁决迟到事件。
 */
export class AgentActivityCache {
  private readonly records = new Map<string, AgentActivityRecord>();
  private readonly listeners = new Set<(agentId: string) => void>();

  /**
   * 旧兼容入口。旧调用方只依赖 void 返回值；实际裁决统一走 record。
   */
  append(agentId: string, entry: CanonicalAgentActivityEntry): void {
    this.record(agentId, entry);
  }

  /**
   * 记录一个规范活动事实。
   *
   * accepted=false 只表示结构、代理身份或稳定活动身份违约；合法重复和
   * 完成后迟到 start 使用 accepted=true/changed=false 表达已吸收但不重绘。
   */
  record(
    agentId: string,
    entry: CanonicalAgentActivityEntry,
  ): AgentActivityRecordResult;
  record(entry: CanonicalAgentActivityEntry): AgentActivityRecordResult;
  record(agentIdOrEntry: unknown, suppliedEntry?: unknown): AgentActivityRecordResult {
    const agentId = suppliedEntry === undefined && isRecord(agentIdOrEntry)
      ? agentIdOrEntry.agent_id
      : agentIdOrEntry;
    const entry = suppliedEntry === undefined ? agentIdOrEntry : suppliedEntry;
    if (!isCanonicalUuid(agentId)) {
      return makeResult(false, false, "rejected", EMPTY_SNAPSHOT);
    }
    const parsed = parseCanonicalAgentActivityEntry(entry);
    if (parsed.kind !== "entry" || parsed.entry.agent_id !== agentId) {
      return makeResult(false, false, "rejected", this.snapshot(agentId));
    }

    let record = this.records.get(agentId);
    if (record === undefined) {
      record = createRecord();
      this.records.set(agentId, record);
    }

    const candidate = parsed.entry;
    const identity = activityIdentity(candidate);
    // 一个 entry_id 不能同时代表两个逻辑活动，即使其中一个是工具。
    const retainedEntryKey = record.byEntryIdentity.get(identity.entryIdentityKey);
    if (retainedEntryKey !== undefined && retainedEntryKey !== identity.logicalKey) {
      return makeResult(false, false, "rejected", this.snapshot(agentId));
    }
    const tombstoneEntryKey = record.tombstonesByEntryIdentity.get(identity.entryIdentityKey);
    if (tombstoneEntryKey !== undefined && tombstoneEntryKey !== identity.logicalKey) {
      return makeResult(false, false, "rejected", this.snapshot(agentId));
    }

    const before = visibleState(record);
    const existing = record.byIdentity.get(identity.logicalKey);
    const tombstones = identity.kind === "tool"
      ? record.toolTombstones
      : record.entryTombstones;
    const tombstone = tombstones.get(identity.logicalKey);
    let disposition: AgentActivityRecordDisposition;

    if (identity.kind === "tool") {
      const outcome = this.recordToolFact(record, candidate, identity, existing, tombstone);
      if (outcome === "rejected") {
        return makeResult(false, false, "rejected", this.snapshot(agentId));
      }
      disposition = outcome;
    } else {
      const outcome = this.recordMessageFact(record, candidate, identity, existing, tombstone);
      if (outcome === "rejected") {
        return makeResult(false, false, "rejected", this.snapshot(agentId));
      }
      disposition = outcome;
    }

    // 新 atom 或结束/收束事实都在同一到达点裁剪；running 工具永远跳过。
    this.trim(record);
    return this.finishMutation(agentId, record, before, disposition);
  }

  /** record 的显式命名别名。 */
  recordEntry(
    agentId: string,
    entry: CanonicalAgentActivityEntry,
  ): AgentActivityRecordResult {
    return this.record(agentId, entry);
  }

  /**
   * 把当前代理仍运行的工具显式收束，使容量策略可以立即回收最老非 running
   * atom。生命周期不是后续活动的拒绝屏障；之后匹配的 end 仍可原地回填。
   */
  settleAgent(
    agentId: unknown,
    state: AgentActivitySettlementState = "idle",
  ): AgentActivityRecordResult {
    if (!isCanonicalUuid(agentId) || !isSettlementState(state)) {
      return makeResult(false, false, "rejected", isCanonicalUuid(agentId)
        ? this.snapshot(agentId)
        : EMPTY_SNAPSHOT);
    }
    const record = this.records.get(agentId);
    if (record === undefined) {
      return makeResult(true, false, "duplicate", EMPTY_SNAPSHOT);
    }
    const before = visibleState(record);
    let settled = false;
    for (const atom of record.atoms) {
      if (atom.identity.kind !== "tool" || atom.state !== "running") continue;
      atom.state = "settled";
      settled = true;
    }
    if (!settled) {
      return makeResult(true, false, "duplicate", this.snapshot(agentId));
    }
    // state 目前只影响收束裁决，不伪造工具结果正文；viewer 仍可用自身
    // 生命周期投影显示 unavailable/terminated 等语义。
    void state;
    this.trim(record);
    return this.finishMutation(agentId, record, before, "updated");
  }

  /** settleAgent 的简短别名，供缓存级测试和内部适配使用。 */
  settle(
    agentId: unknown,
    state: AgentActivitySettlementState = "idle",
  ): AgentActivityRecordResult {
    return this.settleAgent(agentId, state);
  }

  /** 语义更明确的别名：只收束仍运行的工具，不清除历史。 */
  settleRunningTools(
    agentId: unknown,
    state: AgentActivitySettlementState = "idle",
  ): AgentActivityRecordResult {
    return this.settleAgent(agentId, state);
  }

  /** 返回该代理的当前原子窗口；未知代理返回空快照。 */
  snapshot(agentId: unknown): AgentActivitySnapshot {
    if (!isCanonicalUuid(agentId)) return EMPTY_SNAPSHOT;
    const record = this.records.get(agentId);
    if (record === undefined) return EMPTY_SNAPSHOT;
    return makeSnapshot(record);
  }

  /** snapshot 的读取别名，便于 controller/查看器适配而不破坏旧 API。 */
  getSnapshot(agentId: unknown): AgentActivitySnapshot {
    return this.snapshot(agentId);
  }

  /** snapshot 的读取别名。 */
  readSnapshot(agentId: unknown): AgentActivitySnapshot {
    return this.snapshot(agentId);
  }

  /** 返回该代理的原子条目（按首次到达 ordinal）；未知代理为空数组。 */
  replay(agentId: string): readonly CanonicalAgentActivityEntry[] {
    return this.snapshot(agentId).entries;
  }

  /** 当前修订号；只在可见快照发生变化时递增。未知代理为 0。 */
  revision(agentId: string): number {
    return this.snapshot(agentId).revision;
  }

  /** 淘汰提示是否已经为该代理永久建立。 */
  hasOlderActivityOmitted(agentId: string): boolean {
    return this.snapshot(agentId).olderActivityOmitted;
  }

  /** 中文语义对应的简短读取别名。 */
  olderActivityOmitted(agentId: string): boolean {
    return this.hasOlderActivityOmitted(agentId);
  }

  /**
   * 丢弃全部代理的权威活动窗口、淘汰标记和迟到事实墓碑。
   * reload 后的活动是新的观察代际，旧条目不能借由迟到 end 或重复帧重新进入。
   */
  clear(): boolean {
    const changedAgentIds: string[] = [];
    for (const [agentId, record] of this.records) {
      if (record.atoms.length > 0 || record.olderActivityOmitted) changedAgentIds.push(agentId);
    }
    this.records.clear();
    for (const agentId of changedAgentIds) this.notify(agentId);
    return changedAgentIds.length > 0;
  }

  /** 注册变更观察者；回调携带发生可见变更的代理身份。 */
  onChange(listener: (agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private recordMessageFact(
    record: AgentActivityRecord,
    candidate: CanonicalAgentActivityEntry,
    identity: ActivityIdentity,
    existing: ActivityAtom | undefined,
    tombstone: ActivityTombstone | undefined,
  ): "appended" | "duplicate" | "rejected" {
    if (existing !== undefined) {
      return sameEntry(existing.entry, candidate) ? "duplicate" : "rejected";
    }
    if (tombstone !== undefined) {
      return sameEntry(tombstone.entry, candidate) ? "duplicate" : "rejected";
    }
    const atom: ActivityAtom = {
      identity,
      ordinal: record.nextOrdinal,
      entry: candidate,
      state: "completed",
      startEntry: undefined,
      endEntry: undefined,
    };
    record.nextOrdinal += 1;
    addAtom(record, atom);
    return "appended";
  }

  private recordToolFact(
    record: AgentActivityRecord,
    candidate: CanonicalAgentActivityEntry,
    identity: ActivityIdentity,
    existing: ActivityAtom | undefined,
    tombstone: ActivityTombstone | undefined,
  ): "appended" | "updated" | "duplicate" | "rejected" {
    const body = candidate.body as ToolActivityBody;
    if (existing !== undefined) {
      if (!sameToolIdentity(existing.identity, identity)) return "rejected";
      if (body.type === "tool_execution_start") {
        // 完成或收束后的迟到 start 只能被吸收，绝不能退回 running。
        if (
          existing.startEntry !== undefined
          && !sameEntry(existing.startEntry, candidate)
        ) return "rejected";
        if (existing.startEntry === undefined) existing.startEntry = candidate;
        return "duplicate";
      }
      if (existing.endEntry !== undefined) {
        return sameEntry(existing.endEntry, candidate) ? "duplicate" : "rejected";
      }
      existing.endEntry = candidate;
      existing.entry = candidate;
      existing.state = "completed";
      return "updated";
    }

    if (tombstone !== undefined) {
      if (!sameToolIdentity(tombstone.identity, identity)) return "rejected";
      if (body.type === "tool_execution_start") {
        if (
          tombstone.startEntry !== undefined
          && !sameEntry(tombstone.startEntry, candidate)
        ) return "rejected";
        // End-first 后收到 start：记录其身份事实但不复活 atom。
        if (tombstone.startEntry === undefined) tombstone.startEntry = candidate;
        return "duplicate";
      }
      if (tombstone.endEntry !== undefined) {
        return sameEntry(tombstone.endEntry, candidate) ? "duplicate" : "rejected";
      }
      // 该工具已被淘汰，迟到 end 只更新墓碑，不重新占用窗口。
      tombstone.endEntry = candidate;
      tombstone.entry = candidate;
      return "duplicate";
    }

    const isStart = body.type === "tool_execution_start";
    const atom: ActivityAtom = {
      identity,
      ordinal: record.nextOrdinal,
      entry: candidate,
      state: isStart ? "running" : "completed",
      startEntry: isStart ? candidate : undefined,
      endEntry: isStart ? undefined : candidate,
    };
    record.nextOrdinal += 1;
    addAtom(record, atom);
    return "appended";
  }

  private finishMutation(
    agentId: string,
    record: AgentActivityRecord,
    before: VisibleActivityState,
    disposition: AgentActivityRecordDisposition,
  ): AgentActivityRecordResult {
    const changed = visibleStateChanged(before, record);
    if (changed) record.revision += 1;
    const snapshot = makeSnapshot(record);
    if (changed) this.notify(agentId);
    return makeResult(true, changed, disposition, snapshot);
  }

  private trim(record: AgentActivityRecord): void {
    while (record.atoms.length > AGENT_ACTIVITY_MAX_ATOMS) {
      let evictIndex = -1;
      for (let index = 0; index < record.atoms.length; index += 1) {
        if (record.atoms[index]?.state !== "running") {
          evictIndex = index;
          break;
        }
      }
      // 所有超额 atom 都是 running，只能暂时超过窗口上限。
      if (evictIndex < 0) return;
      const atom = record.atoms.splice(evictIndex, 1)[0];
      if (atom === undefined) return;
      record.byIdentity.delete(atom.identity.logicalKey);
      if (record.byEntryIdentity.get(atom.identity.entryIdentityKey) === atom.identity.logicalKey) {
        record.byEntryIdentity.delete(atom.identity.entryIdentityKey);
      }
      this.addTombstone(record, atom);
      record.olderActivityOmitted = true;
    }
  }

  private addTombstone(record: AgentActivityRecord, atom: ActivityAtom): void {
    const tombstone: ActivityTombstone = {
      identity: atom.identity,
      entry: atom.entry,
      startEntry: atom.startEntry,
      endEntry: atom.endEntry,
    };
    const kind = atom.identity.kind === "tool" ? "tool" : "entry";
    const tombstones = kind === "tool"
      ? record.toolTombstones
      : record.entryTombstones;
    if (!tombstones.has(atom.identity.logicalKey)) {
      record.tombstoneOrder.set(atom.identity.logicalKey, kind);
    }
    tombstones.set(atom.identity.logicalKey, tombstone);
    record.tombstonesByEntryIdentity.set(atom.identity.entryIdentityKey, atom.identity.logicalKey);

    // 工具墓碑承载迟到 end 的回填屏障，优先于普通条目墓碑保留；两类
    // 合计仍严格受单代理总上限约束，避免两个 bucket 各自放大内存。
    while (record.tombstoneOrder.size > AGENT_ACTIVITY_MAX_TOMBSTONES) {
      let oldestKey: string | undefined;
      let oldestKind: "tool" | "entry" | undefined;
      for (const [key, candidateKind] of record.tombstoneOrder) {
        if (candidateKind === "entry") {
          oldestKey = key;
          oldestKind = candidateKind;
          break;
        }
        oldestKey ??= key;
        oldestKind ??= candidateKind;
      }
      if (oldestKey === undefined || oldestKind === undefined) return;
      record.tombstoneOrder.delete(oldestKey);
      const bucket = oldestKind === "tool"
        ? record.toolTombstones
        : record.entryTombstones;
      const oldest = bucket.get(oldestKey);
      bucket.delete(oldestKey);
      if (
        oldest !== undefined
        && record.tombstonesByEntryIdentity.get(oldest.identity.entryIdentityKey) === oldestKey
      ) {
        record.tombstonesByEntryIdentity.delete(oldest.identity.entryIdentityKey);
      }
    }
  }

  private notify(agentId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(agentId);
      } catch {
        // 观察者异常不能破坏缓存状态或后续通知。
      }
    }
  }
}

function createRecord(): AgentActivityRecord {
  return {
    atoms: [],
    byIdentity: new Map(),
    byEntryIdentity: new Map(),
    toolTombstones: new Map(),
    entryTombstones: new Map(),
    tombstoneOrder: new Map(),
    tombstonesByEntryIdentity: new Map(),
    revision: 0,
    olderActivityOmitted: false,
    nextOrdinal: 0,
  };
}

function addAtom(record: AgentActivityRecord, atom: ActivityAtom): void {
  record.atoms.push(atom);
  record.byIdentity.set(atom.identity.logicalKey, atom);
  record.byEntryIdentity.set(atom.identity.entryIdentityKey, atom.identity.logicalKey);
}

function activityIdentity(entry: CanonicalAgentActivityEntry): ActivityIdentity {
  const entryIdentityKey = `entry:${stableTupleKey(entry.incarnation_id, entry.entry_id)}`;
  const body = entry.body;
  if (body.type === "tool_execution_start" || body.type === "tool_execution_end") {
    const executionGeneration = body.executionGeneration ?? DEFAULT_TOOL_EXECUTION_GENERATION;
    const tool = Object.freeze({
      toolCallId: body.toolCallId,
      toolName: body.toolName,
      origin: body.origin,
      executionGeneration,
    });
    return Object.freeze({
      logicalKey: `tool:${stableTupleKey(
        entry.incarnation_id,
        `${body.toolCallId}:${executionGeneration}`,
      )}`,
      entryIdentityKey,
      kind: "tool" as const,
      incarnationId: entry.incarnation_id,
      entryId: entry.entry_id,
      tool,
    });
  }
  return Object.freeze({
    logicalKey: `${body.type}:${entryIdentityKey}`,
    entryIdentityKey,
    kind: body.type,
    incarnationId: entry.incarnation_id,
    entryId: entry.entry_id,
    tool: undefined,
  });
}

function stableTupleKey(left: string, right: string): string {
  return JSON.stringify([left, right]);
}

function sameToolIdentity(left: ActivityIdentity, right: ActivityIdentity): boolean {
  if (left.kind !== "tool" || right.kind !== "tool") return false;
  if (left.entryIdentityKey !== right.entryIdentityKey) return false;
  const leftTool = left.tool;
  const rightTool = right.tool;
  return leftTool !== undefined
    && rightTool !== undefined
    && leftTool.toolCallId === rightTool.toolCallId
    && leftTool.toolName === rightTool.toolName
    && leftTool.origin === rightTool.origin
    && leftTool.executionGeneration === rightTool.executionGeneration;
}

function sameEntry(
  left: CanonicalAgentActivityEntry,
  right: CanonicalAgentActivityEntry,
): boolean {
  return isDeepStrictEqual(left, right);
}

function visibleState(record: AgentActivityRecord): VisibleActivityState {
  return {
    entries: record.atoms.map((atom) => atom.entry),
    olderActivityOmitted: record.olderActivityOmitted,
  };
}

function visibleStateChanged(
  before: VisibleActivityState,
  record: AgentActivityRecord,
): boolean {
  if (before.olderActivityOmitted !== record.olderActivityOmitted) return true;
  if (before.entries.length !== record.atoms.length) return true;
  for (let index = 0; index < record.atoms.length; index += 1) {
    const previous = before.entries[index];
    const current = record.atoms[index]?.entry;
    if (previous === undefined || current === undefined || !sameEntry(previous, current)) return true;
  }
  return false;
}

function makeSnapshot(record: AgentActivityRecord): AgentActivitySnapshot {
  return Object.freeze({
    entries: Object.freeze(record.atoms.map((atom) => atom.entry)),
    revision: record.revision,
    olderActivityOmitted: record.olderActivityOmitted,
  });
}

function makeResult(
  accepted: boolean,
  changed: boolean,
  disposition: AgentActivityRecordDisposition,
  snapshot: AgentActivitySnapshot,
): AgentActivityRecordResult {
  return Object.freeze({ accepted, changed, disposition, snapshot });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSettlementState(value: unknown): value is AgentActivitySettlementState {
  return value === "idle" || value === "failed" || value === "terminated";
}
