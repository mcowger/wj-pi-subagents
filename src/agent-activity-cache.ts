import { isCanonicalUuid } from "./tree-controller.ts";
import {
  parseAgentActivityEvent,
  type SafeAgentActivityEvent,
} from "./rpc-bridge-event.ts";

interface AgentActivityRecord {
  readonly events: SafeAgentActivityEvent[];
  revision: number;
}

/**
 * 父端活动流缓存：按 agent_id 分组追加、全量回放，并维护每代理修订号与
 * 变更通知。它只存在于父进程内存，不落盘、无上限累积；代理终止后记录
 * 仍然可回放。并行多代理按分组键天然隔离。
 */
export class AgentActivityCache {
  private readonly records = new Map<string, AgentActivityRecord>();
  private readonly listeners = new Set<(agentId: string) => void>();

  /** 追加一条活动事件；非法身份或违约事件被静默拒绝，不改变缓存状态。 */
  append(agentId: string, event: SafeAgentActivityEvent): void {
    if (!isCanonicalUuid(agentId)) return;
    const parsed = parseAgentActivityEvent(event);
    if (parsed.kind !== "event") return;
    let record = this.records.get(agentId);
    if (record === undefined) {
      record = { events: [], revision: 0 };
      this.records.set(agentId, record);
    }
    record.events.push(parsed.event);
    record.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener(agentId);
      } catch {
        // 观察者异常不能破坏缓存状态或后续通知。
      }
    }
  }

  /** 返回该代理的全部活动事件（按到达序）；未知代理返回空数组。 */
  replay(agentId: string): readonly SafeAgentActivityEvent[] {
    const record = this.records.get(agentId);
    if (record === undefined) return Object.freeze([]);
    return Object.freeze([...record.events]);
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
