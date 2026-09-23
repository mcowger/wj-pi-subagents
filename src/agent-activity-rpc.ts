import { SafeTextComponent } from "./agent-tool-rendering.ts";
import type { AgentActivitySnapshot } from "./agent-activity-cache.ts";

/** RPC-visible activity fan-out: summary-only, never wakes the parent model. */
export const WJ_PI_SUBAGENTS_ACTIVITY_TYPE = "wj-pi-subagents-activity" as const;

export interface AgentActivityRpcApi {
  readonly sendMessage?: unknown;
  readonly registerMessageRenderer?: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Publish the latest activity entry for one agent as a non-waking RPC message.
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
    text = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (typeof (api as { sendMessage?: unknown }).sendMessage !== "function") return false;
  try {
    (api as { sendMessage: (message: unknown, options?: unknown) => void }).sendMessage(
      {
        customType: WJ_PI_SUBAGENTS_ACTIVITY_TYPE,
        content: [{ type: "text", text }],
        display: false,
        details: {
          agent_id: agentId,
          kind: "activity",
          revision,
          olderActivityOmitted,
        },
      },
      {
        triggerTurn: false,
      },
    );
  } catch {
    return false;
  }
  return true;
}

/** TUI stays quiet (display:false); renderer is a collapsed one-liner fallback. */
export function registerAgentActivityMessageRenderer(api: AgentActivityRpcApi): void {
  const register = (api as { registerMessageRenderer?: unknown }).registerMessageRenderer;
  if (typeof register !== "function") throw new TypeError("host missing registerMessageRenderer");
  (register as (customType: string, renderer: (message: unknown, options: unknown, theme: never) => unknown) => void)(
    WJ_PI_SUBAGENTS_ACTIVITY_TYPE,
    (message, _options, theme) => {
      let label = "agent activity";
      try {
        const record = isRecord(message) ? message : undefined;
        const details = record !== undefined && isRecord(record.details) ? record.details : undefined;
        const agentId = typeof details?.agent_id === "string" ? details.agent_id : "unknown";
        const revision = typeof details?.revision === "number" ? ` · rev ${String(details.revision)}` : "";
        label = `agent activity · ${agentId}${revision}`;
      } catch {
        // Fall back to the default label; rendering must never throw.
      }
      return new SafeTextComponent([{ text: label, color: "muted" }], theme, {});
    },
  );
}

export interface AgentActivityRpcBinding {
  readonly dispose: () => void;
}

/**
 * Fan out settled activity entries (tool start/end, messages, model-call
 * failures) to the host message stream. Display drafts (per-delta streaming)
 * are intentionally excluded: they are high-frequency and TUI-only.
 * Failures never propagate; worst case is a missing RPC line.
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
