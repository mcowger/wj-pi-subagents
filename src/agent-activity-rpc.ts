import type { AgentActivitySnapshot } from "./agent-activity-cache.ts";

/**
 * Activity fan-out over Pi custom session entries (`appendEntry`).
 *
 * Custom entries never enter LLM context and surface on the RPC wire as
 * `entry_appended` events — never as `message_end` completion text — so
 * generic RPC clients stay quiet. Summary-only, never wakes the parent model.
 */
export const WJ_PI_SUBAGENTS_ACTIVITY_TYPE = "wj-pi-subagents-activity" as const;

export interface AgentActivityRpcApi {
  readonly appendEntry?: unknown;
  readonly registerEntryRenderer?: unknown;
}

export interface AgentActivityRpcController {
  readonly getActivitySnapshot: (agentId: unknown) => AgentActivitySnapshot;
  readonly onActivityChange: (listener: (agentId: string) => void) => () => void;
}


export interface AgentActivityPayload {
  readonly schema: "wj-pi-subagents.activity/1";
  readonly version: 1;
  readonly kind: "activity";
  readonly agent_id: string;
  readonly revision: number;
  readonly olderActivityOmitted: boolean;
  /** Latest snapshot entry only; bounded by the producer's 16KB text cap. */
  readonly entry: unknown;
}

/**
 * Publish the latest activity entry for one agent as a custom session entry.
 * Custom entries do not participate in LLM context and never trigger a turn;
 * on the RPC wire they arrive as `entry_appended`, not completion text.
 * Returns true only when the host synchronously accepted the submission.
 * Empty snapshots send nothing and return false.
 */
export function publishAgentActivity(
  api: AgentActivityRpcApi,
  controller: AgentActivityRpcController,
  agentId: string,
): boolean {
  let snapshot: AgentActivitySnapshot;
  try {
    snapshot = controller.getActivitySnapshot(agentId);
  } catch {
    return false;
  }
  const entries = snapshot?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const entry = entries[entries.length - 1];
  const revision = typeof snapshot.revision === "number" ? snapshot.revision : 0;
  const olderActivityOmitted = snapshot.olderActivityOmitted === true;
  const payload: AgentActivityPayload = Object.freeze({
    schema: "wj-pi-subagents.activity/1",
    version: 1,
    kind: "activity",
    agent_id: agentId,
    revision,
    olderActivityOmitted,
    entry,
  });
  let text: string;
  try {
    // Session entries persist as JSONL; reject unserializable snapshots here
    // so publish stays total and never throws into supervision handling.
    text = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (text.length === 0) return false;
  const appendEntry = (api as { appendEntry?: unknown }).appendEntry;
  if (typeof appendEntry !== "function") return false;
  try {
    (appendEntry as (customType: string, data?: unknown) => void)(
      WJ_PI_SUBAGENTS_ACTIVITY_TYPE,
      payload,
    );
  } catch {
    return false;
  }
  return true;
}

/**
 * TUI and completion stream stay quiet: the entry renderer returns undefined,
 * which Pi treats as "no content" and skips rendering entirely.
 */
export function registerAgentActivityEntryRenderer(api: AgentActivityRpcApi): void {
  const register = (api as { registerEntryRenderer?: unknown }).registerEntryRenderer;
  if (typeof register !== "function") throw new TypeError("host missing registerEntryRenderer");
  (register as (customType: string, renderer: () => undefined) => void)(
    WJ_PI_SUBAGENTS_ACTIVITY_TYPE,
    () => undefined,
  );
}

export interface AgentActivityRpcBinding {
  readonly dispose: () => void;
}

/**
 * Fan out settled activity entries (tool start/end, messages, model-call
 * failures) to the host session as custom entries. Display drafts (per-delta
 * streaming) are intentionally excluded: they are high-frequency and TUI-only.
 * Failures never propagate; worst case is a missing entry.
 */
export function bindAgentActivityRpc(
  controller: AgentActivityRpcController,
  api: AgentActivityRpcApi,
): AgentActivityRpcBinding {
  let dispose: () => void;
  try {
    dispose = controller.onActivityChange((agentId: string) => {
      try {
        publishAgentActivity(api, controller, agentId);
      } catch {
        // Activity fan-out must never break supervision event handling.
      }
    });
  } catch {
    return Object.freeze({ dispose: () => {} });
  }
  return Object.freeze({
    dispose: () => {
      try {
        dispose();
      } catch {
        // Unsubscribe failures are safe to ignore during teardown.
      }
    },
  });
}
