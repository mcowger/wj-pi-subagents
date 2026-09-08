import { REPLY_MAX_TEXT_BYTES } from "./child-reply-limits.ts";

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

const SAFE_TOOL_ORIGINS: readonly SafeToolOrigin[] = Object.freeze([
  "pi_native",
  "plugin",
  "unknown",
]);

/**
 * Pi 原生工具名闭集。只有来源验证确认当前会话注册实现仍是 Pi 内置实现时，
 * 同名工具才携带 pi_native 身份；同名覆盖后同名事件走安全兜底。
 */
export const PI_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "powershell",
  "read",
  "write",
]);

/** 加宽后的子代理会话活动事件闭集；监督通道活动流帧承载同一闭集。 */
export type SafeAgentActivityEvent =
  | {
      readonly type: "message";
      readonly content: readonly SafeAgentActivityContentBlock[];
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly origin: SafeToolOrigin;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly origin: SafeToolOrigin;
      readonly isError: boolean;
    };

/**
 * 仅供已打开查看器使用的短暂 assistant 增量；它绝不进入活动缓存。
 * sequence 在每个 streamId 内严格递增，接收端据此拒绝乱序或重复帧。
 */
export type SafeAgentActivityDisplayEvent =
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
const INVALID_ACTIVITY_DISPLAY_EVENT: AgentActivityDisplayEventNormalization = Object.freeze({ kind: "invalid" });
const IGNORED_ACTIVITY_DISPLAY_EVENT: AgentActivityDisplayEventNormalization = Object.freeze({ kind: "ignored" });
const ACTIVITY_DISPLAY_REJECTED: AgentActivityDisplayEventNormalization = Object.freeze({
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
      if (activity.kind === "rejected") return REPLY_TOO_LARGE_EVENT;
      // 结构合法但无有效正文（空块或空 content）的消息无内容可显示，
      // 忽略该事件而不是把它当成违约中断会话。
      if (
        activity.kind === "event"
        && activity.event.type === "message"
        && activity.event.content.length === 0
      ) return IGNORED_EVENT;
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
    case "message": {
      const content = normalizeActivityContent(value.content);
      if (content === undefined || content.length === 0) return INVALID_ACTIVITY_EVENT;
      return Object.freeze({
        kind: "event",
        event: Object.freeze({ type: "message", content }),
      });
    }
    case "tool_execution_start": {
      if (!validBoundedText(value.toolCallId, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (!validBoundedText(value.toolName, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (!hasOnlyToolEventKeys(value, ["type", "toolCallId", "toolName", "origin"])) {
        return INVALID_ACTIVITY_EVENT;
      }
      const origin = value.origin;
      if (!SAFE_TOOL_ORIGINS.includes(origin as SafeToolOrigin)) return INVALID_ACTIVITY_EVENT;
      return Object.freeze({
        kind: "event",
        event: Object.freeze({
          type: "tool_execution_start" as const,
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          origin: origin as SafeToolOrigin,
        }),
      });
    }
    case "tool_execution_end": {
      if (!validBoundedText(value.toolCallId, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (!validBoundedText(value.toolName, MAX_TOOL_ID_BYTES)) return INVALID_ACTIVITY_EVENT;
      if (
        typeof value.isError !== "boolean"
        || !hasOnlyToolEventKeys(value, ["type", "toolCallId", "toolName", "origin", "isError"])
      ) return INVALID_ACTIVITY_EVENT;
      const origin = value.origin;
      if (!SAFE_TOOL_ORIGINS.includes(origin as SafeToolOrigin)) return INVALID_ACTIVITY_EVENT;
      return Object.freeze({
        kind: "event",
        event: Object.freeze({
          type: "tool_execution_end" as const,
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          origin: origin as SafeToolOrigin,
          isError: value.isError,
        }),
      });
    }
    default:
      return INVALID_ACTIVITY_EVENT;
  }
}

/**
 * 校验 bridge 生成的显示层短暂事件。它与完整活动事件使用相同的正文预算，
 * 但不会被 AgentActivityCache 接收或回放。
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
  if (value.type === "message_complete") {
    return Object.freeze({
      kind: "event",
      event: Object.freeze({
        type: "message_complete" as const,
        streamId,
        sequence,
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
    }),
  });
}

/**
 * 从 Pi JSON/RPC message_update 中只提取文本与 thinking 增量。工具调用增量
 * 由完整 tool_execution_start/end 负责呈现，因此在此显示通道中明确忽略。
 */
export function normalizeAssistantMessageUpdate(
  value: unknown,
  streamId: string,
  sequence: number,
): AgentActivityDisplayEventNormalization {
  if (!isRecord(value) || value.type !== "message_update" || !isRecord(value.assistantMessageEvent)) {
    return INVALID_ACTIVITY_DISPLAY_EVENT;
  }
  const update = value.assistantMessageEvent;
  if (update.type !== "text_delta" && update.type !== "thinking_delta") {
    return IGNORED_ACTIVITY_DISPLAY_EVENT;
  }
  // Pi 声明 delta 为普通 string；空增量没有可显示内容，不应把合法上游
  // 心跳/边界事件升级为 bridge 协议故障。
  if (update.delta === "") return IGNORED_ACTIVITY_DISPLAY_EVENT;
  return parseAgentActivityDisplayEvent({
    type: "message_delta",
    streamId,
    sequence,
    contentIndex: update.contentIndex,
    contentType: update.type === "text_delta" ? "text" : "thinking",
    delta: update.delta,
  });
}

/**
 * 产生端规范化：把子代理自身观察到的原始 Pi 工具执行事实缩减为无载荷状态
 * 事实。原始参数、结果与错误正文在此处丢弃，永不跨进程；来源身份由调用方
 * 验证后随规范化输入传递。允许未来新增字段并忽略它们；关联身份缺失或来源
 * 闭集之外属于结构违约，由调用方决定是否升级，不在本函数内降级。
 */
export function normalizeOwnToolActivityEvent(
  event: unknown,
  origin: SafeToolOrigin,
): AgentActivityEventNormalization {
  if (!isRecord(event) || typeof event.type !== "string") return INVALID_ACTIVITY_EVENT;
  if (!SAFE_TOOL_ORIGINS.includes(origin)) return INVALID_ACTIVITY_EVENT;
  if (event.type === "tool_execution_start") {
    if (
      !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
      || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
    ) return INVALID_ACTIVITY_EVENT;
    return parseAgentActivityEvent({
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      origin,
    });
  }
  if (event.type === "tool_execution_end") {
    if (
      !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
      || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
      || typeof event.isError !== "boolean"
    ) return INVALID_ACTIVITY_EVENT;
    return parseAgentActivityEvent({
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      origin,
      isError: event.isError,
    });
  }
  return INVALID_ACTIVITY_EVENT;
}

/** 把 Pi assistant message_end 收窄为活动消息事件。 */
function normalizeActivityMessageEnd(
  message: Record<string, unknown>,
): AgentActivityEventNormalization {
  const content = normalizeActivityContent(message.content);
  if (content === undefined) return INVALID_ACTIVITY_EVENT;
  return Object.freeze({
    kind: "event",
    event: Object.freeze({ type: "message", content }),
  });
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
