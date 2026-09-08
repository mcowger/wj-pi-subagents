import { isCanonicalUuid } from "./tree-controller.ts";
import {
  parseCanonicalAgentActivityEntry,
  type CanonicalAgentActivityEntry,
} from "./canonical-activity.ts";

interface AgentActivityRecord {
  readonly entries: CanonicalAgentActivityEntry[];
  revision: number;
}

/**
 * 顶层运行时的活动流缓存：按 agent_id 分组追加、全量回放，并维护每代理
 * 修订号与变更通知。它只存在于顶层运行时进程内存，不落盘、无上限累积；
 * 代理终止后记录仍然可回放。并行多代理按分组键天然隔离。中间运行时不
 * 持有此缓存，只逐层尽力转发。
 */
export class AgentActivityCache {
  private readonly records = new Map<string, AgentActivityRecord>();
  private readonly listeners = new Set<(agentId: string) => void>();

  /** 追加一条规范活动条目；非法身份、版本不符或身份不一致被静默拒绝。 */
  append(agentId: string, entry: CanonicalAgentActivityEntry): void {
    if (!isCanonicalUuid(agentId)) return;
    const parsed = parseCanonicalAgentActivityEntry(entry);
    if (parsed.kind !== "entry") return;
    if (parsed.entry.agent_id !== agentId) return;
    let record = this.records.get(agentId);
    if (record === undefined) {
      record = { entries: [], revision: 0 };
      this.records.set(agentId, record);
    }
    record.entries.push(parsed.entry);
    record.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener(agentId);
      } catch {
        // 观察者异常不能破坏缓存状态或后续通知。
      }
    }
  }

  /** 返回该代理的全部规范条目（按到达序）；未知代理返回空数组。 */
  replay(agentId: string): readonly CanonicalAgentActivityEntry[] {
    const record = this.records.get(agentId);
    if (record === undefined) return Object.freeze([]);
    return Object.freeze([...record.entries]);
  }

  /** 当前修订号；每次成功追加加一。未知代理为 0。 */
  revision(agentId: string): number {
    return this.records.get(agentId)?.revision ?? 0;
  }

  /** 注册变更观察者；回调携带发生变更的代理身份。返回退订函数。 */
  onChange(listener: (agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
