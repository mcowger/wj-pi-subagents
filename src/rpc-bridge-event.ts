import { REPLY_MAX_TEXT_BYTES } from "./child-reply-limits.ts";
import {
  AGENT_ACTIVITY_PHASES,
  AGENT_TERMINATION_RESULTS,
  type AgentActivityPhase,
  type AgentLifecycleState,
  type AgentTerminationResult,
} from "./agent-snapshot-codec.ts";
import { LIFECYCLE_STATES } from "./conversation-lifecycle.ts";
import { PUBLIC_ERROR_CODES, isCanonicalUuid } from "./tree-controller.ts";

/**
 * 活动事件正文按 JSON 转义后 UTF-8 字节计算。它限制单个实时增量帧的尺寸；
 * assistant 消息正文聚合与工具状态事实不设载荷预算：工具参数、结果与错误
 * 正文在产生端规范化时就被丢弃，不跨进程传输。
 */
export const ACTIVITY_MAX_TEXT_BYTES = 16 * 1024;
const MAX_ACTIVITY_CONTENT_BLOCKS = 64;
const MAX_TOOL_ID_BYTES = 256;
const MAX_ACTIVITY_STREAM_ID_BYTES = 128;

/** 活动消息事件允许的正文块闭集：assistant 文本与 thinking。 */
export type SafeAgentActivityContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string };

/**
 * 工具来源身份闭集。只有来源验证通过的工具才能获得 pi_native 或 plugin 身份；
 * 第三方扩展、MCP、同名覆盖与来源不明工具一律安全兜底为 unknown。
 */
export type SafeToolOrigin = "pi_native" | "plugin" | "unknown";

/** 来源身份闭集谓词；wire 校验与产生端判定共用同一形状。 */
export function isSafeToolOrigin(value: unknown): value is SafeToolOrigin {
  return value === "pi_native" || value === "plugin" || value === "unknown";
}

/**
 * 允许专用摘要规则的 Pi 原生工具名闭集（工单 03：文件读取与检索；工单 04：
 * 文件修改与 Shell）。只有来源验证为 pi_native 的同名实现才能携带专用摘要。
 */
export const PI_TOOL_SUMMARY_NAMES: ReadonlySet<string> = new Set([
  "read", "grep", "find", "ls", "write", "edit", "bash", "powershell",
]);

/**
 * 允许专用摘要规则的本插件工具名闭集（工单 05：子代理创建与父子消息；
 * 工单 06：等待与控制）。只有来源验证为 plugin 的同名实现才能携带专用
 * 摘要；同名覆盖与来源不明工具一律安全兜底。
 */
export const PLUGIN_TOOL_SUMMARY_NAMES: ReadonlySet<string> = new Set([
  "get_agent_templates", "spawn_agent", "send_message", "normal_reply", "final_report",
  "wait_agent", "interrupt_agent", "terminate_agent", "get_agent_status", "get_agent_tree",
]);

/**
 * 允许失败事实携带完整原始错误正文的 Pi 原生工具闭集。Shell 工具（bash/
 * powershell）除外：其失败只表达成功或失败，stdout、stderr、退出码、超时
 * 正文与异常正文都不进入规范条目。
 */
export const PI_TOOL_ERROR_TEXT_NAMES: ReadonlySet<string> = new Set([
  "read", "grep", "find", "ls", "write", "edit",
]);

/** Pi 各检索工具的默认 limit；非默认值才进入摘要。 */
const GREP_DEFAULT_LIMIT = 100;
const FIND_DEFAULT_LIMIT = 1000;
const LS_DEFAULT_LIMIT = 500;

/**
 * 专用工具摘要闭集（Pi 原生与本插件）。字段是硬编码白名单：原始参数中的
 * 未来新增字段、文件正文、图片数据、匹配正文、路径列表、目录条目、写入/
 * 编辑统计、命令输出、模板配置、depth、初始 state 与任务正文都不在这里
 * 出现。专用解析宽容原始输入变化；摘要自身的键集合是严格闭集。
 */
export type SafeToolSummary =
  | {
      readonly tool: "read";
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
      readonly truncated?: boolean;
      readonly truncatedBy?: "lines" | "bytes";
      readonly firstLineExceedsLimit?: boolean;
      readonly hasMoreLines?: boolean;
    }
  | {
      readonly tool: "grep";
      readonly pattern: string;
      readonly path: string;
      readonly glob?: string;
      readonly ignoreCase?: boolean;
      readonly literal?: boolean;
      readonly context?: number;
      readonly limit?: number;
      readonly noMatches?: boolean;
      readonly matchLimitReached?: number;
      readonly truncated?: boolean;
      readonly truncatedBy?: "lines" | "bytes";
      readonly linesTruncated?: boolean;
    }
  | {
      readonly tool: "find";
      readonly pattern: string;
      readonly path: string;
      readonly limit?: number;
      readonly noFiles?: boolean;
      readonly resultLimitReached?: number;
      readonly truncated?: boolean;
      readonly truncatedBy?: "lines" | "bytes";
    }
  | {
      readonly tool: "ls";
      readonly path: string;
      readonly limit?: number;
      readonly emptyDirectory?: boolean;
      readonly entryLimitReached?: number;
      readonly truncated?: boolean;
      readonly truncatedBy?: "lines" | "bytes";
    }
  | {
      readonly tool: "write";
      readonly path: string;
    }
  | {
      readonly tool: "edit";
      readonly path: string;
    }
  | {
      readonly tool: "bash";
      readonly command: string;
      readonly timeout?: number;
    }
  | {
      readonly tool: "powershell";
      readonly command: string;
      readonly timeout?: number;
    }
  | {
      readonly tool: "get_agent_templates";
      /** 成功结果的模板数量；失败摘要没有该字段。 */
      readonly count?: number;
    }
  | {
      readonly tool: "spawn_agent";
      readonly name: string;
      readonly template_id: string;
      /** 成功返回的完整 UUID；显示层负责固定八位短 ID。 */
      readonly agent_id?: string;
    }
  | {
      readonly tool: "send_message";
      readonly agent_id: string;
      /** 完整尝试正文（产生端已净化）；成功与失败都保留。 */
      readonly message: string;
      /** 产生端解析到的目标名称；解析失败时不携带。 */
      readonly name?: string;
    }
  | {
      readonly tool: "normal_reply";
      readonly message: string;
    }
  | {
      readonly tool: "final_report";
      readonly message: string;
    }
  | {
      readonly tool: "wait_agent";
      /** 单目标完整 UUID；显示层负责固定八位短 ID。多目标不携带。 */
      readonly agent_id?: string;
      /** 单目标且解析成功时的目标名称；解析失败时不携带。 */
      readonly name?: string;
      /** 多目标数量；单目标不携带。 */
      readonly target_count?: number;
      /** 成功返回的实际 outcome；开始与失败事实不携带。 */
      readonly outcome?: WaitAgentSummaryOutcome;
      /** batch_released 的释放者完整 UUID。 */
      readonly released_by?: string;
      /** batch_released 释放者名称（解析成功时）。 */
      readonly released_by_name?: string;
      /** batch_released 的释放 outcome。 */
      readonly released_outcome?: WaitAgentEventOutcomeName;
      /** 目标观察到的失败状态；仅成功事实携带。 */
      readonly state?: "failed";
      /** 目标失败时的安全错误码（白名单内）。 */
      readonly error_code?: string;
    }
  | {
      readonly tool: "interrupt_agent";
      readonly agent_id: string;
      /** 解析成功时的目标名称。 */
      readonly name?: string;
      /** 成功控制结果：true 表示已进入 interrupting。 */
      readonly changed?: boolean;
      /** 压缩阻塞原因；仅未变更时携带。 */
      readonly blocked_reason?: "compaction_active";
    }
  | {
      readonly tool: "terminate_agent";
      readonly agent_id: string;
      /** 解析成功时的目标名称。 */
      readonly name?: string;
      /** 成功回收事实：false 表示 already terminated。 */
      readonly changed?: boolean;
      /** 强制回收事实；仅强制时携带。 */
      readonly forced?: boolean;
      /** 本次回收确认的节点数量。 */
      readonly terminated_count?: number;
    }
  | {
      readonly tool: "get_agent_status";
      readonly agent_id: string;
      /** 解析成功时的目标名称。 */
      readonly name?: string;
      /** 查询到的生命周期状态。 */
      readonly state?: AgentLifecycleState;
      /** working/interrupting 时的活动阶段。 */
      readonly phase?: AgentActivityPhase;
      /** 目标 failed 时的安全错误码（白名单内）。 */
      readonly error_code?: string;
      /** 目标 terminated 时的终止结果。 */
      readonly termination_result?: AgentTerminationResult;
    }
  | {
      readonly tool: "get_agent_tree";
    };

const READ_SUMMARY_KEYS = Object.freeze([
  "tool", "path", "offset", "limit", "truncated", "truncatedBy", "firstLineExceedsLimit", "hasMoreLines",
] as const);
const PATH_ONLY_SUMMARY_KEYS = Object.freeze(["tool", "path"] as const);
const SHELL_SUMMARY_KEYS = Object.freeze(["tool", "command", "timeout"] as const);
const GREP_SUMMARY_KEYS = Object.freeze([
  "tool", "pattern", "path", "glob", "ignoreCase", "literal", "context", "limit",
  "noMatches", "matchLimitReached", "truncated", "truncatedBy", "linesTruncated",
] as const);
const FIND_SUMMARY_KEYS = Object.freeze([
  "tool", "pattern", "path", "limit", "noFiles", "resultLimitReached", "truncated", "truncatedBy",
] as const);
const LS_SUMMARY_KEYS = Object.freeze([
  "tool", "path", "limit", "emptyDirectory", "entryLimitReached", "truncated", "truncatedBy",
] as const);
const TEMPLATE_COUNT_SUMMARY_KEYS = Object.freeze(["tool", "count"] as const);
const SPAWN_SUMMARY_KEYS = Object.freeze(["tool", "name", "template_id", "agent_id"] as const);
const SEND_MESSAGE_SUMMARY_KEYS = Object.freeze(["tool", "agent_id", "message", "name"] as const);
const MESSAGE_ONLY_SUMMARY_KEYS = Object.freeze(["tool", "message"] as const);
const WAIT_SUMMARY_KEYS = Object.freeze([
  "tool", "agent_id", "name", "target_count", "outcome",
  "released_by", "released_by_name", "released_outcome", "state", "error_code",
] as const);
const INTERRUPT_SUMMARY_KEYS = Object.freeze([
  "tool", "agent_id", "name", "changed", "blocked_reason",
] as const);
const TERMINATE_SUMMARY_KEYS = Object.freeze([
  "tool", "agent_id", "name", "changed", "forced", "terminated_count",
] as const);
const STATUS_SUMMARY_KEYS = Object.freeze([
  "tool", "agent_id", "name", "state", "phase", "error_code", "termination_result",
] as const);
const TREE_SUMMARY_KEYS = Object.freeze(["tool"] as const);

/** wait_agent 摘要允许的全部 outcome 值闭集（含等待包装事实）。 */
type WaitAgentSummaryOutcome =
  | "reply"
  | "final_report"
  | "idle"
  | "terminal"
  | "timeout"
  | "batch_released";
/** wait_agent 事件 outcome 闭集（batch release 的释放者 outcome）。 */
type WaitAgentEventOutcomeName = "reply" | "final_report" | "idle" | "terminal";

const WAIT_OUTCOME_NAMES: ReadonlySet<string> = new Set<WaitAgentSummaryOutcome>([
  "reply", "final_report", "idle", "terminal", "timeout", "batch_released",
]);
const WAIT_EVENT_OUTCOME_NAMES: ReadonlySet<string> = new Set<WaitAgentEventOutcomeName>([
  "reply", "final_report", "idle", "terminal",
]);
const LIFECYCLE_STATE_NAMES: ReadonlySet<string> = new Set<string>(LIFECYCLE_STATES);
const ACTIVITY_PHASE_NAMES: ReadonlySet<string> = new Set<string>(AGENT_ACTIVITY_PHASES);
const TERMINATION_RESULT_NAMES: ReadonlySet<string> = new Set<string>(AGENT_TERMINATION_RESULTS);

function isWaitOutcomeName(value: string): value is WaitAgentSummaryOutcome {
  return WAIT_OUTCOME_NAMES.has(value);
}

function isWaitEventOutcomeName(value: string): value is WaitAgentEventOutcomeName {
  return WAIT_EVENT_OUTCOME_NAMES.has(value);
}

function isLifecycleStateName(value: string): value is AgentLifecycleState {
  return LIFECYCLE_STATE_NAMES.has(value);
}

function isActivityPhaseName(value: string): value is AgentActivityPhase {
  return ACTIVITY_PHASE_NAMES.has(value);
}

function isTerminationResultName(value: string): value is AgentTerminationResult {
  return TERMINATION_RESULT_NAMES.has(value);
}

/**
 * 活动正文事实净化：过滤 ANSI 与危险终端控制字符，保留换行与可读空白。
 * 这是终端安全要求，不视为正文截断；产生端与查看器共用同一规则。
 */
const ACTIVITY_ANSI_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[()][0-2])/gu;
const ACTIVITY_UNSAFE_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

export function sanitizeSafeActivityText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(ACTIVITY_ANSI_PATTERN, "")
    .replace(ACTIVITY_UNSAFE_PATTERN, " ");
}

/** 加宽后的子代理会话活动事件闭集；监督通道活动流帧承载同一闭集。 */
export type SafeAgentActivityEvent =
  | {
      readonly type: "message";
      readonly content: readonly SafeAgentActivityContentBlock[];
      /**
       * 与实时显示流的精确关联身份；由同一运行实例的扩展在产生端携带。
       * 缺省表示该消息没有可关联的实时流（例如启动前已存在的消息）。
       */
      readonly streamId?: string;
    }
  | {
      /** 接收侧实际接纳的父代理输入；未接纳输入不产生该事件。 */
      readonly type: "parent_message";
      readonly content: readonly SafeAgentActivityContentBlock[];
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly origin: SafeToolOrigin;
      /** 仅来源验证通过的专用工具可携带的白名单摘要。 */
      readonly summary?: SafeToolSummary;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly origin: SafeToolOrigin;
      readonly isError: boolean;
      /** 自包含摘要：成功时含结果事实，失败时只含输入参数。 */
      readonly summary?: SafeToolSummary;
      /** 失败时的完整原始错误正文（产生端已净化）；不在成功事实出现。 */
      readonly errorText?: string;
      /** 插件工具失败时的规范稳定错误码；不在成功事实出现。 */
      readonly errorCode?: string;
    };

/**
 * 产生端（子代理运行时扩展）生成的短暂 assistant 增量：还不携带代理身份。
 * sequence 在每个 streamId 内严格递增；它只在控制器登记身份后成为可跨进程
 * 转发的 SafeAgentActivityDisplayEvent。
 */
export type AgentDisplayStreamUpdate =
  | {
      readonly type: "message_delta";
      readonly streamId: string;
      readonly sequence: number;
      readonly contentIndex: number;
      readonly contentType: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly type: "message_complete";
      readonly streamId: string;
      readonly sequence: number;
    };

export type AgentDisplayStreamUpdateNormalization =
  | { readonly kind: "event"; readonly event: AgentDisplayStreamUpdate }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: "reply_too_large" }
  | { readonly kind: "invalid" };

/**
 * 仅供已打开查看器使用的短暂 assistant 增量；它绝不进入活动缓存。
 * 实时流身份至少包含 agentId、incarnationId 与 streamId，且 delta 与
 * complete 携带同一身份；sequence 在每个 streamId 内严格递增。不同代理、
 * 重启实例或复用 stream ID 不会关联到同一草稿。
 */
export type SafeAgentActivityDisplayEvent = AgentDisplayStreamUpdate & {
  readonly agentId: string;
  readonly incarnationId: string;
};

export type AgentActivityDisplayEventNormalization =
  | { readonly kind: "event"; readonly event: SafeAgentActivityDisplayEvent }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: "reply_too_large" }
  | { readonly kind: "invalid" };

export type AgentActivityEventNormalization =
  | { readonly kind: "event"; readonly event: SafeAgentActivityEvent }
  | { readonly kind: "rejected"; readonly reason: "reply_too_large" }
  | { readonly kind: "invalid" };

/** 桥接进程允许跨进程公开的 Pi 事件闭集。 */
export type SafeRpcBridgeEvent =
  | { readonly type: "agent_start" | "agent_settled" }
  | {
      readonly type: "compaction_start";
      readonly reason: "manual" | "threshold" | "overflow";
    }
  | { readonly type: "queue_update"; readonly pendingMessageCount: number }
  | {
      readonly type: "compaction_end";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly aborted: boolean;
      readonly willRetry: boolean;
      readonly failed: boolean;
    }
  | Extract<SafeAgentActivityEvent, {
      readonly type: "tool_execution_start" | "tool_execution_end";
    }>
  | Extract<SafeAgentActivityEvent, { readonly type: "message" }>
  | { readonly type: "extension_error" };

export interface SafeAssistantMessageEndEvent {
  readonly type: "message_end";
  readonly message: {
    readonly role: "assistant";
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
  };
}

export type RpcBridgeEventNormalization =
  | { readonly kind: "event"; readonly event: SafeRpcBridgeEvent | SafeAssistantMessageEndEvent }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" }
  | { readonly kind: "rejected"; readonly reason: "reply_too_large" };

export type AssistantMessageEndNormalization = RpcBridgeEventNormalization;

const IGNORED_EVENT: RpcBridgeEventNormalization = Object.freeze({ kind: "ignored" });
const INVALID_EVENT: RpcBridgeEventNormalization = Object.freeze({ kind: "invalid" });
const INVALID_ACTIVITY_EVENT: AgentActivityEventNormalization = Object.freeze({ kind: "invalid" });
/** 显示事件的非事件归一结果在产生端与身份校验两端结构一致，共用同一常量。 */
type AgentDisplayStreamRejection =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: "reply_too_large" }
  | { readonly kind: "invalid" };
const INVALID_ACTIVITY_DISPLAY_EVENT: AgentDisplayStreamRejection = Object.freeze({ kind: "invalid" });
const IGNORED_ACTIVITY_DISPLAY_EVENT: AgentDisplayStreamRejection = Object.freeze({ kind: "ignored" });
const ACTIVITY_DISPLAY_REJECTED: AgentDisplayStreamRejection = Object.freeze({
  kind: "rejected",
  reason: "reply_too_large",
});
const REPLY_TOO_LARGE_EVENT: RpcBridgeEventNormalization = Object.freeze({
  kind: "rejected",
  reason: "reply_too_large",
});

/**
 * 把 Pi 公共 RpcClient 事件缩减为安全事件。未知顶层事件属于无关观察，直接忽略；
 * 已知事件若结构违约则返回 invalid，由桥接进程关闭传输。
 */
export function normalizeRpcBridgeEvent(event: unknown): RpcBridgeEventNormalization {
  if (!isRecord(event) || typeof event.type !== "string") return INVALID_EVENT;
  switch (event.type) {
    case "agent_start":
    case "agent_settled":
      return safeEvent(Object.freeze({ type: event.type }));
    case "compaction_start":
      if (event.reason !== "manual" && event.reason !== "threshold" && event.reason !== "overflow") {
        return INVALID_EVENT;
      }
      return safeEvent(Object.freeze({ type: "compaction_start", reason: event.reason }));
    case "compaction_end":
      if (
        (event.reason !== "manual" && event.reason !== "threshold" && event.reason !== "overflow")
        || typeof event.aborted !== "boolean"
        || typeof event.willRetry !== "boolean"
        || (event.errorMessage !== undefined && typeof event.errorMessage !== "string")
      ) return INVALID_EVENT;
      return safeEvent(Object.freeze({
        type: "compaction_end",
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        failed: event.errorMessage !== undefined,
      }));
    case "queue_update":
      if (!Array.isArray(event.steering) || !Array.isArray(event.followUp)) return INVALID_EVENT;
      return safeEvent(Object.freeze({
        type: "queue_update",
        pendingMessageCount: event.steering.length + event.followUp.length,
      }));
    case "tool_execution_start":
    case "tool_execution_end": {
      // 桥接 RPC 副本只服务活动阶段跟踪；来源无法在桥接进程验证，固定
      // 标记为 unknown。参数与结果正文不再越过该闭集。
      if (
        !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
        || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
      ) return INVALID_EVENT;
      if (event.type === "tool_execution_start") {
        // 桥接输入是 Pi 原始事件：旧字段与未来新增字段一律剥离。
        return safeEvent(Object.freeze({
          type: event.type,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          origin: "unknown",
        }));
      }
      if (typeof event.isError !== "boolean") return INVALID_EVENT;
      return safeEvent(Object.freeze({
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        origin: "unknown",
        isError: event.isError,
      }));
    }
    case "message_end": {
      // assistant 正文进入活动闭集；最终回复正文仍由真正 child 扩展经独立
      // 监督通道上行，任务 RPC 不再复制回复正文。
      if (!isRecord(event.message)) return INVALID_EVENT;
      if (event.message.role !== "assistant") return IGNORED_EVENT;
      const activity = normalizeActivityMessageEnd(event.message);
      if (activity.kind === "invalid") return INVALID_EVENT;
      // 结构合法但无有效正文（空块或空 content）的消息无内容可显示，
      // 忽略该事件而不是把它当成违约中断会话。
      if (activity.event.content.length === 0) return IGNORED_EVENT;
      return safeEvent(activity.event);
    }
    case "extension_error":
      return safeEvent(Object.freeze({ type: "extension_error" }));
    default:
      return IGNORED_EVENT;
  }
}

/** child 扩展把最终 assistant 消息收窄为可进入监督 reply 的安全内容。 */
export function normalizeAssistantMessageEnd(event: unknown): AssistantMessageEndNormalization {
  if (!isRecord(event) || event.type !== "message_end") return INVALID_EVENT;
  if (!isRecord(event.message)) return INVALID_EVENT;
  // Pi 会为 user、toolResult 等角色发布同名事件，它们不属于直接回复。
  if (event.message.role !== "assistant") return IGNORED_EVENT;
  if (!Array.isArray(event.message.content) || event.message.content.length > MAX_ACTIVITY_CONTENT_BLOCKS) {
    return INVALID_EVENT;
  }
  const content: Array<{ readonly type: "text"; readonly text: string }> = [];
  let textBytes = 0;
  let replyTooLarge = false;
  for (const item of event.message.content) {
    if (!isRecord(item) || typeof item.type !== "string") return INVALID_EVENT;
    if (item.type === "thinking" || item.type === "toolCall" || item.type === "image") {
      // 非文本块不得越过最终回复的安全边界。
      continue;
    }
    if (item.type === "text") {
      if (typeof item.text !== "string") return INVALID_EVENT;
      // coordinator 使用换行连接文本块；边界必须覆盖连接后的完整正文。
      const nextBytes = textBytes + (content.length === 0 ? 0 : 1) + utf8Length(item.text);
      if (nextBytes > REPLY_MAX_TEXT_BYTES) replyTooLarge = true;
      textBytes = nextBytes;
      content.push(Object.freeze({ type: "text", text: item.text }));
      continue;
    }
    return INVALID_EVENT;
  }
  if (replyTooLarge) return REPLY_TOO_LARGE_EVENT;
  return safeEvent(Object.freeze({
    type: "message_end",
    message: Object.freeze({
      role: "assistant",
      content: Object.freeze(content),
    }),
  }));
}

/**
 * 校验子代理会话活动事件闭集。它同时服务监督通道活动帧载荷校验与父端
 * 事件防线：合法事件原样冻结返回；正文超预算按 reply_too_large 惯例拒绝；
 * 未知类型与结构违约返回 invalid，由调用方决定是否升级为协议故障。
 */
export function parseAgentActivityEvent(value: unknown): AgentActivityEventNormalization {
  if (!isRecord(value) || typeof value.type !== "string") return INVALID_ACTIVITY_EVENT;
  switch (value.type) {
    case "message":
    case "parent_message": {
      const content = normalizeActivityContent(value.content);
      if (content === undefined || content.length === 0) return INVALID_ACTIVITY_EVENT;
      // streamId 是 assistant 消息与实时显示流的精确关联身份；只有 message
      // 事件可携带，必须是产生端约定内的有界文本。
      let messageStreamId: string | undefined;
      if (value.type === "message" && value.streamId !== undefined) {
        if (!validBoundedText(value.streamId, MAX_ACTIVITY_STREAM_ID_BYTES)) {
          return INVALID_ACTIVITY_EVENT;
        }
        messageStreamId = value.streamId;
      }
      const event: SafeAgentActivityEvent = value.type === "message"
        ? Object.freeze({
          type: "message",
          content,
          ...(messageStreamId === undefined ? {} : { streamId: messageStreamId }),
        })
        : Object.freeze({ type: "parent_message", content });
      return Object.freeze({ kind: "event", event });
    }
    case "tool_execution_start": {
      if (!validBoundedText(value.toolCallId, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (!validBoundedText(value.toolName, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (
        !hasOnlyToolEventKeys(value, ["type", "toolCallId", "toolName", "origin", "summary"])
      ) return INVALID_ACTIVITY_EVENT;
      if (!isSafeToolOrigin(value.origin)) return INVALID_ACTIVITY_EVENT;
      if (value.summary !== undefined) {
        if (parseToolSummary(value.toolName, value.origin, value.summary) === undefined) {
          return INVALID_ACTIVITY_EVENT;
        }
      }
      return Object.freeze({
        kind: "event",
        event: Object.freeze({
          type: "tool_execution_start" as const,
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          origin: value.origin,
          ...(value.summary === undefined ? {} : { summary: value.summary as SafeToolSummary }),
        }),
      });
    }
    case "tool_execution_end": {
      if (!validBoundedText(value.toolCallId, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (!validBoundedText(value.toolName, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (
        typeof value.isError !== "boolean"
        || !hasOnlyToolEventKeys(
          value,
          ["type", "toolCallId", "toolName", "origin", "isError", "summary", "errorText", "errorCode"],
        )
      ) return INVALID_ACTIVITY_EVENT;
      if (!isSafeToolOrigin(value.origin)) return INVALID_ACTIVITY_EVENT;
      if (value.summary !== undefined) {
        if (parseToolSummary(value.toolName, value.origin, value.summary) === undefined) {
          return INVALID_ACTIVITY_EVENT;
        }
      }
      if (value.errorText !== undefined) {
        // 错误正文只允许 Pi 原生专用工具在失败事实中携带；Shell 工具除外；
        // 空正文无意义。
        if (
          value.isError !== true
          || value.origin !== "pi_native"
          || !PI_TOOL_ERROR_TEXT_NAMES.has(value.toolName)
          || typeof value.errorText !== "string"
          || value.errorText.length === 0
        ) return INVALID_ACTIVITY_EVENT;
      }
      if (value.errorCode !== undefined) {
        // 规范稳定错误码只属于来源验证通过的本插件工具的失败事实；成功
        // 事实、白名单外错误码与降级来源都不允许携带。
        if (
          value.isError !== true
          || value.origin !== "plugin"
          || !PLUGIN_TOOL_SUMMARY_NAMES.has(value.toolName)
          || typeof value.errorCode !== "string"
          || !isPublicErrorCode(value.errorCode)
        ) return INVALID_ACTIVITY_EVENT;
      }
      return Object.freeze({
        kind: "event",
        event: Object.freeze({
          type: "tool_execution_end" as const,
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          origin: value.origin,
          isError: value.isError,
          ...(value.summary === undefined ? {} : { summary: value.summary as SafeToolSummary }),
          ...(value.errorText === undefined ? {} : { errorText: value.errorText }),
          ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
        }),
      });
    }
    default:
      return INVALID_ACTIVITY_EVENT;
  }
}

/**
 * 校验携带完整实时流身份的显示层短暂事件。它与完整活动事件使用相同的正文
 * 预算，但不会被 AgentActivityCache 接收或回放；监督通道 display 帧、控制器
 * 转发与顶层草稿登记共用同一校验。
 */
export function parseAgentActivityDisplayEvent(
  value: unknown,
): AgentActivityDisplayEventNormalization {
  if (!isRecord(value) || typeof value.type !== "string") return INVALID_ACTIVITY_DISPLAY_EVENT;
  const streamId = value.streamId;
  const sequence = value.sequence;
  if (!validBoundedText(streamId, MAX_ACTIVITY_STREAM_ID_BYTES)) {
    return INVALID_ACTIVITY_DISPLAY_EVENT;
  }
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
    return INVALID_ACTIVITY_DISPLAY_EVENT;
  }
  // 实时流身份：代理与运行实例必须是规范 UUID，delta 与 complete 携带同一
  // 身份；不同代理、重启实例或复用 stream ID 不会关联到同一草稿。
  if (!isCanonicalUuid(value.agentId) || !isCanonicalUuid(value.incarnationId)) {
    return INVALID_ACTIVITY_DISPLAY_EVENT;
  }
  if (value.type === "message_complete") {
    return Object.freeze({
      kind: "event",
      event: Object.freeze({
        type: "message_complete" as const,
        streamId,
        sequence,
        agentId: value.agentId,
        incarnationId: value.incarnationId,
      }),
    });
  }
  if (value.type !== "message_delta") return INVALID_ACTIVITY_DISPLAY_EVENT;
  const contentIndex = value.contentIndex;
  const contentType = value.contentType;
  const delta = value.delta;
  if (
    typeof contentIndex !== "number"
    || !Number.isSafeInteger(contentIndex)
    || contentIndex < 0
    || contentIndex >= MAX_ACTIVITY_CONTENT_BLOCKS
    || (contentType !== "text" && contentType !== "thinking")
    || typeof delta !== "string"
    || delta.length === 0
  ) return INVALID_ACTIVITY_DISPLAY_EVENT;
  if (encodedJsonLength(delta) > ACTIVITY_MAX_TEXT_BYTES) {
    return ACTIVITY_DISPLAY_REJECTED;
  }
  return Object.freeze({
    kind: "event",
    event: Object.freeze({
      type: "message_delta" as const,
      streamId,
      sequence,
      contentIndex,
      contentType,
      delta,
      agentId: value.agentId,
      incarnationId: value.incarnationId,
    }),
  });
}

/**
 * 从子代理运行时扩展收到的 message_update 事件中只提取文本与 thinking 增量。
 * 工具调用增量由完整 tool_execution_start/end 负责呈现，因此在此显示通道中
 * 明确忽略；返回值不携带代理身份，由控制器登记后跨进程转发。
 */
export function normalizeAssistantMessageUpdate(
  value: unknown,
  streamId: string,
  sequence: number,
): AgentDisplayStreamUpdateNormalization {
  if (!isRecord(value) || value.type !== "message_update" || !isRecord(value.assistantMessageEvent)) {
    return INVALID_ACTIVITY_DISPLAY_EVENT;
  }
  const update = value.assistantMessageEvent;
  if (update.type !== "text_delta" && update.type !== "thinking_delta") {
    return IGNORED_ACTIVITY_DISPLAY_EVENT;
  }
  // Pi 声明 delta 为普通 string；空增量没有可显示内容，不应把合法上游
  // 心跳/边界事件升级为产生端协议故障。
  if (update.delta === "") return IGNORED_ACTIVITY_DISPLAY_EVENT;
  if (typeof update.delta !== "string") return INVALID_ACTIVITY_DISPLAY_EVENT;
  const contentIndex = update.contentIndex;
  const delta: string = update.delta;
  if (
    typeof contentIndex !== "number"
    || !Number.isSafeInteger(contentIndex)
    || contentIndex < 0
    || contentIndex >= MAX_ACTIVITY_CONTENT_BLOCKS
  ) return INVALID_ACTIVITY_DISPLAY_EVENT;
  const event: AgentDisplayStreamUpdate = Object.freeze({
    type: "message_delta",
    streamId,
    sequence,
    contentIndex,
    contentType: update.type === "text_delta" ? "text" : "thinking",
    delta,
  });
  if (encodedJsonLength(delta) > ACTIVITY_MAX_TEXT_BYTES) {
    return ACTIVITY_DISPLAY_REJECTED;
  }
  return Object.freeze({ kind: "event", event });
}

/** 由产生端 streamId 与序号构造收束帧；空 delta 一样不占用序号。 */
export function buildDisplayStreamComplete(
  streamId: string,
  sequence: number,
): AgentDisplayStreamUpdate {
  return Object.freeze({ type: "message_complete", streamId, sequence });
}

/**
 * 产生端规范化：把子代理自身观察到的原始 Pi 工具执行事实缩减为安全闭集。
 * 原始结果与错误正文在此处丢弃，永不跨进程；来源身份由调用方验证后随
 * 规范化输入传递。来源验证通过的 Pi 原生专用工具（read/grep/find/ls/write/
 * edit/bash/powershell）与本插件专用工具（get_agent_templates/spawn_agent/
 * send_message/normal_reply/final_report/wait_agent/interrupt_agent/
 * terminate_agent/get_agent_status/get_agent_tree）各自使用专用摘要规则：
 * 只保留白名单参数与结果事实，Shell 外 Pi 工具失败时自包含净化后的完整
 * 错误正文，插件工具失败时自包含规范稳定错误码。专用解析宽容未来新增字段
 * 并忽略它们；必需字段缺失或类型错误、开始参数缺失或来源验证失败时完整
 * 降级为无载荷安全兜底。允许未来新增字段并忽略它们；关联身份缺失或来源
 * 闭集之外属于结构违约，由调用方决定是否升级，不在本函数内降级。
 */
export function normalizeOwnToolActivityEvent(
  event: unknown,
  origin: SafeToolOrigin,
  startArgs?: unknown,
  resolveAgentName?: (agentId: string) => string | undefined,
): AgentActivityEventNormalization {
  if (!isRecord(event) || typeof event.type !== "string") return INVALID_ACTIVITY_EVENT;
  if (!isSafeToolOrigin(origin)) return INVALID_ACTIVITY_EVENT;
  // 专用摘要只作用于来源验证通过的原生专用工具与插件专用工具；其余来源
  // 与工具都是无载荷安全兜底。
  const dedicatedPiTool = origin === "pi_native"
    && typeof event.toolName === "string"
    && PI_TOOL_SUMMARY_NAMES.has(event.toolName);
  const dedicatedPluginTool = origin === "plugin"
    && typeof event.toolName === "string"
    && PLUGIN_TOOL_SUMMARY_NAMES.has(event.toolName);
  if (event.type === "tool_execution_start") {
    if (
      !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
      || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
    ) return INVALID_ACTIVITY_EVENT;
    // 专用摘要只在来源验证通过时提取；同名覆盖/未知来源与降级场景都是
    // 无载荷安全兜底。
    const summary = dedicatedPiTool
      ? extractPiToolSummary(event.toolName, event.args)
      : dedicatedPluginTool
        ? extractPluginToolSummary(event.toolName, event.args, undefined, undefined, resolveAgentName)
        : undefined;
    return parseAgentActivityEvent({
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      origin,
      ...(summary === undefined ? {} : { summary }),
    });
  }
  if (event.type === "tool_execution_end") {
    if (
      !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
      || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
      || typeof event.isError !== "boolean"
    ) return INVALID_ACTIVITY_EVENT;
    // Pi 的结束事件不携带参数；只有产生端缓存的开始参数齐全时，结束事实
    // 才能自包含输入参数，否则整体降级为无摘要兜底。
    const summary = dedicatedPiTool && isRecord(startArgs)
      ? extractPiToolSummary(event.toolName, startArgs, event.result, event.isError)
      : dedicatedPluginTool && isRecord(startArgs)
        ? extractPluginToolSummary(
          event.toolName,
          startArgs,
          event.result,
          event.isError,
          resolveAgentName,
        )
        : undefined;
    // 错误正文只属于允许展开错误的 Pi 工具；Shell 工具失败只表达成功或失败。
    const errorText = summary !== undefined && event.isError
      && PI_TOOL_ERROR_TEXT_NAMES.has(event.toolName)
      ? extractErrorText(event.result)
      : undefined;
    // 规范稳定错误码只属于插件工具的失败事实；非白名单错误码静默省略。
    const errorCode = dedicatedPluginTool && event.isError
      ? extractPluginErrorCode(event.result)
      : undefined;
    return parseAgentActivityEvent({
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      origin,
      isError: event.isError,
      ...(summary === undefined ? {} : { summary }),
      ...(errorText === undefined ? {} : { errorText }),
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }
  return INVALID_ACTIVITY_EVENT;
}

/**
 * 运行时使用的有状态专用规范化器：Pi 的工具结束事件不携带参数，本工厂按
 * 工具活动 ID 缓存开始事件的参数，供结束事实自包含输入参数。缓存有界，
 * 溢出时淘汰最旧的待决条目；宿主查询失败时全部工具保守兜底为 unknown。
 * 可选的目标名称解析器供 send_message 摘要携带接收者名称。
 */
export function createOwnToolActivityNormalizer(
  resolveToolOrigin: (toolName: string) => SafeToolOrigin,
  resolveAgentName?: (agentId: string) => string | undefined,
): (event: unknown) => AgentActivityEventNormalization {
  const MAX_PENDING_TOOL_ARGS = 256;
  const pendingArgs = new Map<string, unknown>();
  return (event: unknown): AgentActivityEventNormalization => {
    if (!isRecord(event) || typeof event.type !== "string") return INVALID_ACTIVITY_EVENT;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (event.type === "tool_execution_start" && toolCallId.length > 0) {
      // 同活动 ID 的重复开始覆盖旧参数；容量溢出时淘汰最早待决条目。
      pendingArgs.delete(toolCallId);
      if (isRecord(event.args)) pendingArgs.set(toolCallId, event.args);
      while (pendingArgs.size > MAX_PENDING_TOOL_ARGS) {
        const oldest = pendingArgs.keys().next().value;
        if (oldest === undefined) break;
        pendingArgs.delete(oldest);
      }
    }
    const origin = resolveToolOrigin(typeof event.toolName === "string" ? event.toolName : "");
    const startArgs = event.type === "tool_execution_end" && toolCallId.length > 0
      ? pendingArgs.get(toolCallId)
      : undefined;
    if (event.type === "tool_execution_end") pendingArgs.delete(toolCallId);
    return normalizeOwnToolActivityEvent(event, origin, startArgs, resolveAgentName);
  };
}

/**
 * 已知可选字段的类型门卫：字段缺失返回 false（用默认语义）；存在但类型
 * 不符合 Pi 原生 schema 时抛出降级信号。值域问题（如负数 limit）不算
 * 类型错误，由提取条件决定是否携带。
 */
class SummaryFieldTypeError extends Error {}

function typedField(args: Record<string, unknown>, key: string, guard: (value: unknown) => boolean): boolean {
  if (!(key in args)) return false;
  if (!guard(args[key])) throw new SummaryFieldTypeError(key);
  return true;
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * 截断事实块：Pi 各检索工具 details.truncation 的共享读取规则。只有
 * truncated 为真才携带事实；truncatedBy 值域外的变体静默忽略。
 */
function truncationFacts(
  truncation: Record<string, unknown> | undefined,
  includeFirstLine = false,
): {
  readonly truncated?: true;
  readonly truncatedBy?: "lines" | "bytes";
  readonly firstLineExceedsLimit?: true;
} | {} {
  if (truncation?.truncated !== true) return {};
  const by = truncation.truncatedBy === "lines" || truncation.truncatedBy === "bytes"
    ? truncation.truncatedBy
    : undefined;
  return {
    truncated: true,
    ...(by === undefined ? {} : { truncatedBy: by }),
    ...(includeFirstLine && truncation.firstLineExceedsLimit === true
      ? { firstLineExceedsLimit: true }
      : {}),
  };
}

/**
 * read 的不完整事实：用户 limit 提前停止但文件尚有更多行时，Pi 不写
 * details，事实只出现在结果正文的已知 continuation 文案中。
 */
const READ_MORE_LINES_PATTERN = /\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/u;

function readHasMoreLinesNotice(result: unknown): boolean {
  if (!isRecord(result) || !Array.isArray(result.content)) return false;
  const parts: string[] = [];
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return false;
    parts.push(item.text);
  }
  const lastLine = parts.join("\n").split("\n").at(-1) ?? "";
  return READ_MORE_LINES_PATTERN.test(lastLine);
}

/**
 * 从原始 Pi 工具事实提取专用摘要：输入参数部分始终提取；write 与 edit
 * 的成功与失败摘要相同（只有 path），Shell 摘要在任何状态下都含 command。
 * 必需字段缺失、任何已知字段存在但类型错误时返回 undefined（完整降级）；
 * 值域偏离只导致对应字段不携带。
 */
function extractPiToolSummary(
  toolName: string,
  args: unknown,
  result?: unknown,
  isError?: boolean,
): SafeToolSummary | undefined {
  if (!isRecord(args)) return undefined;
  const success = isError === false && isRecord(result)
    ? readRecord(result.details)
    : undefined;
  const truncation = success === undefined ? undefined : readRecord(success.truncation);
  try {
    switch (toolName) {
      case "read": {
        const path = args.path;
        if (typeof path !== "string") return undefined;
        typedField(args, "offset", isCount);
        typedField(args, "limit", isCount);
        return {
          tool: "read",
          path,
          ...optionalCount(args, "offset"),
          ...optionalCount(args, "limit"),
          ...truncationFacts(truncation, true),
          ...(isError === false
            && truncation?.truncated !== true
            && readHasMoreLinesNotice(result)
            ? { hasMoreLines: true }
            : {}),
        };
      }
      case "grep": {
        const pattern = args.pattern;
        if (typeof pattern !== "string") return undefined;
        typedField(args, "path", (value) => typeof value === "string");
        typedField(args, "glob", (value) => typeof value === "string");
        typedField(args, "ignoreCase", (value) => typeof value === "boolean");
        typedField(args, "literal", (value) => typeof value === "boolean");
        typedField(args, "context", isCount);
        typedField(args, "limit", isCount);
        return {
          tool: "grep",
          pattern,
          path: readOptionalPathInput(args),
          ...optionalInput(args, "glob", (value) => typeof value === "string" && value.length > 0),
          ...(args.ignoreCase === true ? { ignoreCase: true } : {}),
          ...(args.literal === true ? { literal: true } : {}),
          ...optionalCount(args, "context", { positive: true }),
          ...optionalCount(args, "limit", { exclude: GREP_DEFAULT_LIMIT }),
          ...(isError === false && matchesKnownEmptyResult(result, "No matches found")
            ? { noMatches: true }
            : {}),
          ...(positiveCountField(success, "matchLimitReached") === undefined
            ? {}
            : { matchLimitReached: positiveCountField(success, "matchLimitReached")! }),
          ...truncationFacts(truncation),
          ...(success?.linesTruncated === true ? { linesTruncated: true } : {}),
        };
      }
      case "find": {
        const pattern = args.pattern;
        if (typeof pattern !== "string") return undefined;
        typedField(args, "path", (value) => typeof value === "string");
        typedField(args, "limit", isCount);
        return {
          tool: "find",
          pattern,
          path: readOptionalPathInput(args),
          ...optionalCount(args, "limit", { exclude: FIND_DEFAULT_LIMIT }),
          ...(isError === false && matchesKnownEmptyResult(result, "No files found matching pattern")
            ? { noFiles: true }
            : {}),
          ...(positiveCountField(success, "resultLimitReached") === undefined
            ? {}
            : { resultLimitReached: positiveCountField(success, "resultLimitReached")! }),
          ...truncationFacts(truncation),
        };
      }
      case "ls": {
        typedField(args, "path", (value) => typeof value === "string");
        typedField(args, "limit", isCount);
        return {
          tool: "ls",
          path: readOptionalPathInput(args),
          ...optionalCount(args, "limit", { exclude: LS_DEFAULT_LIMIT }),
          ...(isError === false && matchesKnownEmptyResult(result, "(empty directory)")
            ? { emptyDirectory: true }
            : {}),
          ...(positiveCountField(success, "entryLimitReached") === undefined
            ? {}
            : { entryLimitReached: positiveCountField(success, "entryLimitReached")! }),
          ...truncationFacts(truncation),
        };
      }
      case "write": {
        // path 与 content 都是 Pi schema 必需字段；content 只用于形状验证，
        // 正文永不进入摘要。
        const path = args.path;
        if (typeof path !== "string") return undefined;
        if (typeof args.content !== "string") return undefined;
        // 成功与失败摘要都只显示 path：不显示行数、字节数或任何写入统计。
        return { tool: "write", path };
      }
      case "edit": {
        // path 与 edits 都是 Pi schema 必需字段；edits 只用于形状验证，
        // oldText/newText 永不进入摘要。
        const path = args.path;
        if (typeof path !== "string") return undefined;
        const edits = args.edits;
        if (
          !Array.isArray(edits)
          || !edits.every((item) => isRecord(item)
            && typeof item.oldText === "string" && typeof item.newText === "string")
        ) return undefined;
        // 成功与失败摘要都只显示 path：不显示编辑块数或任何编辑统计。
        return { tool: "edit", path };
      }
      case "bash":
      case "powershell": {
        // command 是必需字段；摘要与状态无关，始终自包含完整命令。
        const command = args.command;
        if (typeof command !== "string") return undefined;
        typedField(args, "timeout", (value) => typeof value === "number");
        return {
          tool: toolName,
          command: sanitizeSafeActivityText(command),
          ...optionalShellTimeout(args),
        };
      }
      default:
        return undefined;
    }
  } catch (error) {
    if (error instanceof SummaryFieldTypeError) return undefined;
    throw error;
  }
}

/**
 * 失败事实的完整原始错误正文：Pi 把工具异常包装为 content 中的 text 块。
 * 连接全部文本块、净化后返回；无可用文本时返回 undefined。
 */
function extractErrorText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const parts: string[] = [];
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    parts.push(item.text);
  }
  if (parts.length === 0) return undefined;
  const sanitized = sanitizeSafeActivityText(parts.join("\n")).trim();
  return sanitized.length === 0 ? undefined : sanitized;
}

/**
 * 插件工具失败事实的规范稳定错误码：SubagentToolError 把稳定 JSON 外壳放
 * 在 content 的 text 块中，这里只取白名单内的 error.code；其余结构、底层
 * 异常正文与白名单外错误码一律省略。
 */
function extractPluginErrorCode(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      continue;
    }
    const error = readRecord(parsed)?.error;
    const code = isRecord(error) ? error.code : undefined;
    if (typeof code === "string" && isPublicErrorCode(code)) return code;
  }
  return undefined;
}

/**
 * 从原始插件工具事实提取专用摘要：消息类工具在开始与结束（无论成败）都
 * 自包含完整尝试正文；spawn 成功追加完整 UUID；get_agent_templates 只在
 * 成功摘要携带模板数量。必需字段缺失或类型错误时返回 undefined（完整
 * 降级）；未来新增字段与任务正文、depth、初始 state 等一律忽略。
 */
function extractPluginToolSummary(
  toolName: string,
  args: unknown,
  result?: unknown,
  isError?: boolean,
  resolveAgentName?: (agentId: string) => string | undefined,
): SafeToolSummary | undefined {
  if (!isRecord(args)) return undefined;
  const successDetails = isError === false && isRecord(result)
    ? readRecord(result.details)
    : undefined;
  switch (toolName) {
    case "get_agent_templates": {
      // 工具无输入参数；details 是模板数组，成功只提取模板数量，失败或
      // details 缺失/非数组时只保留无载荷工具名摘要。
      if (isError !== false) return { tool: "get_agent_templates" };
      const details = isRecord(result) ? result.details : undefined;
      return Array.isArray(details)
        ? { tool: "get_agent_templates", count: details.length }
        : { tool: "get_agent_templates" };
    }
    case "spawn_agent": {
      const name = args.name;
      const templateId = args.template_id;
      if (typeof name !== "string" || typeof templateId !== "string") return undefined;
      const agentId = successDetails === undefined ? undefined : successDetails.agent_id;
      return {
        tool: "spawn_agent",
        name: sanitizeInlineActivityText(name),
        template_id: sanitizeInlineActivityText(templateId),
        ...(isCanonicalUuid(agentId) ? { agent_id: agentId } : {}),
      };
    }
    case "send_message": {
      const agentId = args.agent_id;
      const message = args.message;
      if (!isCanonicalUuid(agentId) || typeof message !== "string") return undefined;
      const resolvedName = readResolvedAgentName(agentId, resolveAgentName);
      return {
        tool: "send_message",
        agent_id: agentId,
        message: sanitizeSafeActivityText(message),
        ...(resolvedName === undefined ? {} : { name: resolvedName }),
      };
    }
    case "normal_reply":
    case "final_report": {
      const message = args.message;
      if (typeof message !== "string") return undefined;
      return {
        tool: toolName,
        message: sanitizeSafeActivityText(message),
      };
    }
    case "wait_agent": {
      // 开始与失败事实只保留目标事实：单目标名称与固定八位短 ID 的完整
      // UUID，多目标只保留数量；timeout_ms 等其余参数忽略。
      const agentIds = args.agent_ids;
      if (!Array.isArray(agentIds) || agentIds.length === 0) return undefined;
      const validIds: string[] = [];
      for (const candidate of agentIds) {
        if (!isCanonicalUuid(candidate)) return undefined;
        validIds.push(candidate);
      }
      const base = validIds.length === 1
        ? singleTargetFacts(validIds[0]!, resolveAgentName)
        : { target_count: validIds.length };
      if (isError !== false) return { tool: "wait_agent", ...base };
      // 成功事实自包含实际 outcome；batch release 追加释放者与释放 outcome；
      // 目标 state failed 追加安全错误码。原始结果结构、报告正文与任务结果
      // 一律不进入摘要。
      const details = successDetails;
      const outcome = details?.outcome;
      if (typeof outcome !== "string" || !isWaitOutcomeName(outcome)) return undefined;
      if (outcome === "batch_released") {
        const releasedBy = details?.released_by_agent_id;
        const releasedOutcome = details?.released_by_outcome;
        if (
          !isCanonicalUuid(releasedBy)
          || typeof releasedOutcome !== "string"
          || !isWaitEventOutcomeName(releasedOutcome)
        ) return undefined;
        const releasedName = readResolvedAgentName(releasedBy, resolveAgentName);
        return {
          tool: "wait_agent",
          ...base,
          outcome,
          released_by: releasedBy,
          ...(releasedName === undefined ? {} : { released_by_name: releasedName }),
          released_outcome: releasedOutcome,
        };
      }
      if (details === undefined || details.state !== "failed") {
        return { tool: "wait_agent", ...base, outcome };
      }
      const fault = isRecord(details.error) ? details.error.code : undefined;
      const errorCode = typeof fault === "string" && isPublicErrorCode(fault) ? fault : undefined;
      return {
        tool: "wait_agent",
        ...base,
        outcome,
        state: "failed",
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
      };
    }
    case "interrupt_agent": {
      const agentId = args.agent_id;
      if (!isCanonicalUuid(agentId)) return undefined;
      const base = singleTargetFacts(agentId, resolveAgentName);
      if (isError !== false) return { tool: "interrupt_agent", ...base };
      // 成功事实区分进入 interrupting、unchanged 与压缩阻塞；结果 state 等
      // 其余字段忽略。
      const details = successDetails;
      const changed = details?.changed;
      if (typeof changed !== "boolean") return undefined;
      const blockedReason = details?.blocked_reason;
      const knownBlock = changed === false && blockedReason === "compaction_active"
        ? blockedReason
        : undefined;
      return {
        tool: "interrupt_agent",
        ...base,
        changed,
        ...(knownBlock === undefined ? {} : { blocked_reason: knownBlock }),
      };
    }
    case "terminate_agent": {
      const agentId = args.agent_id;
      if (!isCanonicalUuid(agentId)) return undefined;
      const base = singleTargetFacts(agentId, resolveAgentName);
      if (isError !== false) return { tool: "terminate_agent", ...base };
      // 成功事实保留幂等、强制回收与回收数量事实；state 等其余字段忽略。
      const details = successDetails;
      const changed = details?.changed;
      const terminatedCount = details?.terminated_count;
      if (
        typeof changed !== "boolean"
        || typeof terminatedCount !== "number"
        || !Number.isSafeInteger(terminatedCount)
        || terminatedCount < 0
      ) return undefined;
      return {
        tool: "terminate_agent",
        ...base,
        changed,
        ...(details?.forced === true ? { forced: true } : {}),
        terminated_count: terminatedCount,
      };
    }
    case "get_agent_status": {
      const agentId = args.agent_id;
      if (!isCanonicalUuid(agentId)) return undefined;
      const base = singleTargetFacts(agentId, resolveAgentName);
      if (isError !== false) return { tool: "get_agent_status", ...base };
      // 成功事实只保留生命周期状态与条件性 phase、错误码、终止结果；
      // revision、时间、上下文占用与完整快照一律不进入摘要。
      const details = successDetails;
      const state = details?.state;
      if (typeof state !== "string" || !isLifecycleStateName(state)) return undefined;
      const phase = state === "working" || state === "interrupting"
        ? readActivityPhase(details?.activity)
        : undefined;
      const fault = state === "failed" && details !== undefined
        ? details.error
        : undefined;
      const errorCode = fault === undefined ? undefined : readPublicFaultCode(fault);
      const terminationResult = state === "terminated"
        ? readTerminationResult(details?.termination_result)
        : undefined;
      return {
        tool: "get_agent_status",
        ...base,
        state,
        ...(phase === undefined ? {} : { phase }),
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
        ...(terminationResult === undefined ? {} : { termination_result: terminationResult }),
      };
    }
    case "get_agent_tree": {
      // 无载荷摘要：成功与失败都只显示工具名与状态；revision、scope、节点
      // 列表与状态统计一律不进入摘要。
      return { tool: "get_agent_tree" };
    }
    default:
      return undefined;
  }
}

/** 直接子目标事实：完整 UUID 加可选的解析名称。 */
function singleTargetFacts(
  agentId: string,
  resolveAgentName: ((agentId: string) => string | undefined) | undefined,
): { readonly agent_id: string; readonly name?: string } {
  const name = readResolvedAgentName(agentId, resolveAgentName);
  return { agent_id: agentId, ...(name === undefined ? {} : { name }) };
}

function readActivityPhase(activity: unknown): AgentActivityPhase | undefined {
  const phase = isRecord(activity) ? activity.phase : undefined;
  return typeof phase === "string" && isActivityPhaseName(phase) ? phase : undefined;
}

function readTerminationResult(value: unknown): AgentTerminationResult | undefined {
  return typeof value === "string" && isTerminationResultName(value) ? value : undefined;
}

/** 目标故障事实中的安全错误码：只接受白名单内的稳定码，其余静默省略。 */
function readPublicFaultCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && isPublicErrorCode(code) ? code : undefined;
}

/** 单行事实净化：在正文净化基础上折叠换行，供名称、模板 ID 等内联字段使用。 */
function sanitizeInlineActivityText(value: string): string {
  return sanitizeSafeActivityText(value).replace(/\n+/gu, " ").trim();
}

function readResolvedAgentName(
  agentId: string,
  resolveAgentName: ((agentId: string) => string | undefined) | undefined,
): string | undefined {
  if (resolveAgentName === undefined) return undefined;
  try {
    const name = resolveAgentName(agentId);
    return typeof name === "string" && name.trim().length > 0
      ? sanitizeInlineActivityText(name)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Pi 已知空结果文案：content 全部为单个匹配文本时认定对应空结果事实。 */
function matchesKnownEmptyResult(result: unknown, text: string): boolean {
  if (!isRecord(result) || !Array.isArray(result.content) || result.content.length === 0) return false;
  const parts: string[] = [];
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return false;
    parts.push(item.text);
  }
  return parts.join("\n") === text;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function positiveCountField(
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** grep/find/ls 的 path：未提供或为空时按 Pi 语义明确为 "."。 */
function readOptionalPathInput(args: Record<string, unknown>): string {
  const value = args.path;
  return typeof value === "string" && value.length > 0 ? value : ".";
}

/**
 * Shell 工具的可选 timeout（秒）：只有有限正数才携带；值域偏离不降级，
 * 只导致该字段不进入摘要（避免展示未生效的调用约束）。
 */
function optionalShellTimeout(args: Record<string, unknown>): { readonly timeout?: number } | {} {
  const value = args.timeout;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { timeout: value }
    : {};
}

function optionalCount(
  args: Record<string, unknown>,
  key: string,
  options: { readonly positive?: boolean; readonly exclude?: number } = {},
): { readonly [key: string]: number } | {} {
  const value = args[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return {};
  if (options.positive === true && value <= 0) return {};
  if (options.exclude !== undefined && value === options.exclude) return {};
  return { [key]: value };
}

function optionalInput(
  args: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => boolean,
): { readonly [key: string]: unknown } | {} {
  const value = args[key];
  return guard(value) ? { [key]: value } : {};
}

/** wire 闭集校验：摘要只允许 Pi 原生专用工具携带，且键集合与类型严格闭合。 */
function parsePiToolSummary(
  toolName: string,
  origin: SafeToolOrigin,
  value: unknown,
): SafeToolSummary | undefined {
  if (origin !== "pi_native" || !PI_TOOL_SUMMARY_NAMES.has(toolName)) return undefined;
  if (!isRecord(value) || value.tool !== toolName) return undefined;
  switch (toolName) {
    case "read": {
      if (!hasOnlySummaryKeys(value, READ_SUMMARY_KEYS)) return undefined;
      const path = value.path;
      if (typeof path !== "string") return undefined;
      if (!validSummaryCount(value, "offset") || !validSummaryCount(value, "limit")) return undefined;
      if (!validTruncationFacts(value)) return undefined;
      if (
        value.firstLineExceedsLimit !== undefined
        && typeof value.firstLineExceedsLimit !== "boolean"
      ) return undefined;
      if (value.hasMoreLines !== undefined && typeof value.hasMoreLines !== "boolean") return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "grep": {
      if (!hasOnlySummaryKeys(value, GREP_SUMMARY_KEYS)) return undefined;
      if (typeof value.pattern !== "string" || typeof value.path !== "string") return undefined;
      if (value.glob !== undefined && typeof value.glob !== "string") return undefined;
      if (value.ignoreCase !== undefined && typeof value.ignoreCase !== "boolean") return undefined;
      if (value.literal !== undefined && typeof value.literal !== "boolean") return undefined;
      if (!validSummaryCount(value, "context") || !validSummaryCount(value, "limit")) return undefined;
      if (value.noMatches !== undefined && typeof value.noMatches !== "boolean") return undefined;
      const matchLimitReached = positiveCountField(value, "matchLimitReached");
      if (value.matchLimitReached !== undefined && matchLimitReached === undefined) return undefined;
      if (!validTruncationFacts(value)) return undefined;
      if (value.linesTruncated !== undefined && typeof value.linesTruncated !== "boolean") return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "find": {
      if (!hasOnlySummaryKeys(value, FIND_SUMMARY_KEYS)) return undefined;
      if (typeof value.pattern !== "string" || typeof value.path !== "string") return undefined;
      if (!validSummaryCount(value, "limit")) return undefined;
      if (value.noFiles !== undefined && typeof value.noFiles !== "boolean") return undefined;
      const resultLimitReached = positiveCountField(value, "resultLimitReached");
      if (value.resultLimitReached !== undefined && resultLimitReached === undefined) return undefined;
      if (!validTruncationFacts(value)) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "ls": {
      if (!hasOnlySummaryKeys(value, LS_SUMMARY_KEYS)) return undefined;
      if (typeof value.path !== "string") return undefined;
      if (!validSummaryCount(value, "limit")) return undefined;
      if (value.emptyDirectory !== undefined && typeof value.emptyDirectory !== "boolean") return undefined;
      const entryLimitReached = positiveCountField(value, "entryLimitReached");
      if (value.entryLimitReached !== undefined && entryLimitReached === undefined) return undefined;
      if (!validTruncationFacts(value)) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "write":
    case "edit": {
      // 摘要只有 path：行数、字节大小、编辑块数等写入/编辑统计不属于闭集。
      if (!hasOnlySummaryKeys(value, PATH_ONLY_SUMMARY_KEYS)) return undefined;
      if (typeof value.path !== "string") return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "bash":
    case "powershell": {
      if (!hasOnlySummaryKeys(value, SHELL_SUMMARY_KEYS)) return undefined;
      if (typeof value.command !== "string" || value.command.length === 0) return undefined;
      // 与产生端提取一致：只有有限正数 timeout 属于闭集。
      if (
        value.timeout !== undefined
        && !(typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0)
      ) return undefined;
      return value as unknown as SafeToolSummary;
    }
    default:
      return undefined;
  }
}

/**
 * wire 闭集校验：摘要只允许来源验证通过的本插件专用工具携带，键集合与
 * 类型严格闭合。消息类工具的完整尝试正文（成功与失败都保留）经产生端
 * 净化后进入摘要；spawn 成功的 agent_id 必须是完整规范 UUID；等待与控制
 * 工具只携带目标事实、outcome 与控制结果闭集，原始结果结构不进入摘要。
 */
function parsePluginToolSummary(
  toolName: string,
  origin: SafeToolOrigin,
  value: unknown,
): SafeToolSummary | undefined {
  if (origin !== "plugin" || !PLUGIN_TOOL_SUMMARY_NAMES.has(toolName)) return undefined;
  if (!isRecord(value) || value.tool !== toolName) return undefined;
  switch (toolName) {
    case "get_agent_templates": {
      if (!hasOnlySummaryKeys(value, TEMPLATE_COUNT_SUMMARY_KEYS)) return undefined;
      if (
        value.count !== undefined
        && !(typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0)
      ) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "spawn_agent": {
      if (!hasOnlySummaryKeys(value, SPAWN_SUMMARY_KEYS)) return undefined;
      if (typeof value.name !== "string" || value.name.length === 0) return undefined;
      if (typeof value.template_id !== "string" || value.template_id.length === 0) return undefined;
      if (value.agent_id !== undefined && !isCanonicalUuid(value.agent_id)) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "send_message": {
      if (!hasOnlySummaryKeys(value, SEND_MESSAGE_SUMMARY_KEYS)) return undefined;
      if (!isCanonicalUuid(value.agent_id)) return undefined;
      if (typeof value.message !== "string" || value.message.length === 0) return undefined;
      if (value.name !== undefined && !(typeof value.name === "string" && value.name.length > 0)) {
        return undefined;
      }
      return value as unknown as SafeToolSummary;
    }
    case "normal_reply":
    case "final_report": {
      if (!hasOnlySummaryKeys(value, MESSAGE_ONLY_SUMMARY_KEYS)) return undefined;
      if (typeof value.message !== "string" || value.message.length === 0) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "wait_agent": {
      if (!hasOnlySummaryKeys(value, WAIT_SUMMARY_KEYS)) return undefined;
      // 单目标与多目标互斥：单目标携带完整 UUID，多目标携带正数数量。
      if ((value.agent_id === undefined) === (value.target_count === undefined)) return undefined;
      if (value.agent_id !== undefined && !isCanonicalUuid(value.agent_id)) return undefined;
      if (!validOptionalName(value, "name")) return undefined;
      if (
        value.target_count !== undefined
        && !(typeof value.target_count === "number" && Number.isSafeInteger(value.target_count)
          && value.target_count > 0)
      ) return undefined;
      if (
        value.outcome !== undefined
        && !(typeof value.outcome === "string" && isWaitOutcomeName(value.outcome))
      ) return undefined;
      if (value.released_by !== undefined && !isCanonicalUuid(value.released_by)) return undefined;
      if (!validOptionalName(value, "released_by_name")) return undefined;
      if (
        value.released_outcome !== undefined
        && !(typeof value.released_outcome === "string" && isWaitEventOutcomeName(value.released_outcome))
      ) return undefined;
      if (value.state !== undefined && value.state !== "failed") return undefined;
      if (
        value.error_code !== undefined
        && !(typeof value.error_code === "string" && isPublicErrorCode(value.error_code))
      ) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "interrupt_agent": {
      if (!hasOnlySummaryKeys(value, INTERRUPT_SUMMARY_KEYS)) return undefined;
      if (!isCanonicalUuid(value.agent_id)) return undefined;
      if (!validOptionalName(value, "name")) return undefined;
      if (value.changed !== undefined && typeof value.changed !== "boolean") return undefined;
      // 压缩阻塞只属于未变更的成功事实。
      if (
        value.blocked_reason !== undefined
        && !(value.changed === false && value.blocked_reason === "compaction_active")
      ) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "terminate_agent": {
      if (!hasOnlySummaryKeys(value, TERMINATE_SUMMARY_KEYS)) return undefined;
      if (!isCanonicalUuid(value.agent_id)) return undefined;
      if (!validOptionalName(value, "name")) return undefined;
      if (value.changed !== undefined && typeof value.changed !== "boolean") return undefined;
      if (value.forced !== undefined && value.forced !== true) return undefined;
      if (
        value.terminated_count !== undefined
        && !(typeof value.terminated_count === "number" && Number.isSafeInteger(value.terminated_count)
          && value.terminated_count >= 0)
      ) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "get_agent_status": {
      if (!hasOnlySummaryKeys(value, STATUS_SUMMARY_KEYS)) return undefined;
      if (!isCanonicalUuid(value.agent_id)) return undefined;
      if (!validOptionalName(value, "name")) return undefined;
      if (
        value.state !== undefined
        && !(typeof value.state === "string" && isLifecycleStateName(value.state))
      ) return undefined;
      if (
        value.phase !== undefined
        && !(typeof value.phase === "string" && isActivityPhaseName(value.phase))
      ) return undefined;
      if (
        value.error_code !== undefined
        && !(typeof value.error_code === "string" && isPublicErrorCode(value.error_code))
      ) return undefined;
      if (
        value.termination_result !== undefined
        && !(typeof value.termination_result === "string" && isTerminationResultName(value.termination_result))
      ) return undefined;
      return value as unknown as SafeToolSummary;
    }
    case "get_agent_tree": {
      if (!hasOnlySummaryKeys(value, TREE_SUMMARY_KEYS)) return undefined;
      return value as unknown as SafeToolSummary;
    }
    default:
      return undefined;
  }
}

/** 可选的目标名称字段：缺省合法，出现时必须是长度大于 0 的字符串。 */
function validOptionalName(value: Record<string, unknown>, key: string): boolean {
  const name = value[key];
  return name === undefined || (typeof name === "string" && name.length > 0);
}

/**
 * wire 摘要校验总入口：按来源身份分派到 Pi 原生与本插件专用规则；来源
 * 降级或闭集外工具一律拒绝。
 */
function parseToolSummary(
  toolName: string,
  origin: SafeToolOrigin,
  value: unknown,
): SafeToolSummary | undefined {
  if (origin === "pi_native") return parsePiToolSummary(toolName, origin, value);
  if (origin === "plugin") return parsePluginToolSummary(toolName, origin, value);
  return undefined;
}

function hasOnlySummaryKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** 公开控制面稳定错误码闭集谓词；插件失败事实与显示层共用同一白名单。 */
function isPublicErrorCode(value: string): boolean {
  return (PUBLIC_ERROR_CODES as readonly string[]).includes(value);
}

/** truncated/truncatedBy 的共享 wire 校验；值域外的 truncatedBy 判违约。 */
function validTruncationFacts(value: Record<string, unknown>): boolean {
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") return false;
  if (
    value.truncatedBy !== undefined
    && value.truncatedBy !== "lines" && value.truncatedBy !== "bytes"
  ) return false;
  return true;
}

function validSummaryCount(value: Record<string, unknown>, key: string): boolean {
  const count = value[key];
  return count === undefined
    || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
}

/** 把 Pi assistant message_end 收窄为活动消息事件。 */
function normalizeActivityMessageEnd(
  message: Record<string, unknown>,
):
  | {
      readonly kind: "event";
      readonly event: Extract<SafeAgentActivityEvent, { readonly type: "message" }>;
    }
  | { readonly kind: "invalid" }
{
  const content = normalizeActivityContent(message.content);
  if (content === undefined) return Object.freeze({ kind: "invalid" } as const);
  const event: Extract<SafeAgentActivityEvent, { readonly type: "message" }> = Object.freeze({
    type: "message",
    content,
  });
  return Object.freeze({ kind: "event", event });
}

function normalizeActivityContent(
  value: unknown,
): readonly SafeAgentActivityContentBlock[] | undefined {
  // 空数组属于“结构合法但无正文”，由调用方决定忽略（桥接端）或判违约
  // （监督层防御，合法桥接永不发送）；只有非数组或超块数才在这里判违约。
  if (!Array.isArray(value) || value.length > MAX_ACTIVITY_CONTENT_BLOCKS) {
    return undefined;
  }
  const content: SafeAgentActivityContentBlock[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") continue;
    // 图片、原生工具调用、未来未知块与结构无效块逐块忽略；
    // 只有合法 text 与 thinking 块可以进入活动闭集。
    if (item.type === "text") {
      if (typeof item.text !== "string" || item.text.length === 0) continue;
      content.push(Object.freeze({ type: "text", text: item.text }));
      continue;
    }
    if (item.type === "thinking") {
      if (typeof item.thinking !== "string" || item.thinking.length === 0) continue;
      const previous = content.at(-1);
      if (previous?.type === "thinking") {
        // 相邻 thinking 块合并为同一 thinking 组；被 text 隔开的块保持分离。
        const merged = Object.freeze({
          type: "thinking" as const,
          thinking: `${previous.thinking}\n\n${item.thinking}`,
        });
        content[content.length - 1] = merged;
        continue;
      }
      content.push(Object.freeze({ type: "thinking", thinking: item.thinking }));
      continue;
    }
  }
  return Object.freeze(content);
}

/** 工具活动闭集字段检查：旧契约字段（args/result）出现即违约。 */
function hasOnlyToolEventKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function encodedJsonLength(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function safeEvent(
  event: SafeRpcBridgeEvent | SafeAssistantMessageEndEvent,
): RpcBridgeEventNormalization {
  return Object.freeze({ kind: "event", event });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8Length(value) <= maxBytes;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
