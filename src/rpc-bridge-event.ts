import { REPLY_MAX_TEXT_BYTES } from "./child-reply-limits.ts";

/**
 * 活动事件正文按 JSON 转义后 UTF-8 字节计算。它保证单条活动事件无论内容
 * 如何都能放入桥接帧与监督帧的安全预算，不依赖调用方重新编码。
 */
export const ACTIVITY_MAX_TEXT_BYTES = 16 * 1024;
const MAX_ACTIVITY_CONTENT_BLOCKS = 64;
const MAX_TOOL_ID_BYTES = 256;

/** 活动消息事件允许的正文块闭集：assistant 文本与 thinking。 */
export type SafeAgentActivityContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string };

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
      readonly args?: string;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: string;
      readonly isError?: boolean;
    };

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
const ACTIVITY_REJECTED: AgentActivityEventNormalization = Object.freeze({
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
      if (
        !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
        || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
      ) return INVALID_EVENT;
      if (event.type === "tool_execution_start") {
        const args = summarizeActivityJson(event.args);
        if (args === "invalid") return INVALID_EVENT;
        if (args === "rejected") return REPLY_TOO_LARGE_EVENT;
        return safeEvent(Object.freeze({
          type: event.type,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(args === undefined ? {} : { args }),
        }));
      }
      const result = summarizeActivityJson(event.result);
      if (result === "invalid") return INVALID_EVENT;
      if (result === "rejected") return REPLY_TOO_LARGE_EVENT;
      if (event.isError !== undefined && typeof event.isError !== "boolean") return INVALID_EVENT;
      return safeEvent(Object.freeze({
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(result === undefined ? {} : { result }),
        ...(event.isError === undefined ? {} : { isError: event.isError }),
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
      if (content === undefined) return INVALID_ACTIVITY_EVENT;
      if (content === "rejected") return ACTIVITY_REJECTED;
      return Object.freeze({
        kind: "event",
        event: Object.freeze({ type: "message", content }),
      });
    }
    case "tool_execution_start": {
      const toolCallId = value.toolCallId;
      const toolName = value.toolName;
      if (
        !validBoundedText(toolCallId, MAX_TOOL_ID_BYTES)
        || !validBoundedText(toolName, MAX_TOOL_ID_BYTES)
      ) return INVALID_ACTIVITY_EVENT;
      if (value.args !== undefined) {
        if (typeof value.args !== "string") return INVALID_ACTIVITY_EVENT;
        if (encodedJsonLength(value.args) > ACTIVITY_MAX_TEXT_BYTES) return ACTIVITY_REJECTED;
      }
      return Object.freeze({
        kind: "event",
        event: Object.freeze({
          type: "tool_execution_start",
          toolCallId,
          toolName,
          ...(value.args === undefined ? {} : { args: value.args }),
        }),
      });
    }
    case "tool_execution_end": {
      const toolCallId = value.toolCallId;
      const toolName = value.toolName;
      if (
        !validBoundedText(toolCallId, MAX_TOOL_ID_BYTES)
        || !validBoundedText(toolName, MAX_TOOL_ID_BYTES)
      ) return INVALID_ACTIVITY_EVENT;
      if (value.result !== undefined) {
        if (typeof value.result !== "string") return INVALID_ACTIVITY_EVENT;
        if (encodedJsonLength(value.result) > ACTIVITY_MAX_TEXT_BYTES) return ACTIVITY_REJECTED;
      }
      if (value.isError !== undefined && typeof value.isError !== "boolean") {
        return INVALID_ACTIVITY_EVENT;
      }
      return Object.freeze({
        kind: "event",
        event: Object.freeze({
          type: "tool_execution_end",
          toolCallId,
          toolName,
          ...(value.result === undefined ? {} : { result: value.result }),
          ...(value.isError === undefined ? {} : { isError: value.isError }),
        }),
      });
    }
    default:
      return INVALID_ACTIVITY_EVENT;
  }
}

/** 把 Pi assistant message_end 收窄为活动消息事件；预算覆盖整条连接后正文。 */
function normalizeActivityMessageEnd(
  message: Record<string, unknown>,
): AgentActivityEventNormalization {
  const content = normalizeActivityContent(message.content);
  if (content === undefined) return INVALID_ACTIVITY_EVENT;
  if (content === "rejected") return ACTIVITY_REJECTED;
  return Object.freeze({
    kind: "event",
    event: Object.freeze({ type: "message", content }),
  });
}

function normalizeActivityContent(
  value: unknown,
): readonly SafeAgentActivityContentBlock[] | "rejected" | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTIVITY_CONTENT_BLOCKS) {
    return undefined;
  }
  const content: SafeAgentActivityContentBlock[] = [];
  let encodedBytes = 0;
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") return undefined;
    if (item.type === "toolCall" || item.type === "image") continue;
    if (item.type === "text") {
      if (typeof item.text !== "string") return undefined;
      const nextBytes = budgetedTextLength(item.text, encodedBytes, content.length);
      if (nextBytes === undefined) return undefined;
      if (nextBytes === "rejected") return "rejected";
      encodedBytes = nextBytes;
      content.push(Object.freeze({ type: "text", text: item.text }));
      continue;
    }
    if (item.type === "thinking") {
      if (typeof item.thinking !== "string") return undefined;
      const nextBytes = budgetedTextLength(item.thinking, encodedBytes, content.length);
      if (nextBytes === undefined) return undefined;
      if (nextBytes === "rejected") return "rejected";
      encodedBytes = nextBytes;
      content.push(Object.freeze({ type: "thinking", thinking: item.thinking }));
      continue;
    }
    return undefined;
  }
  return Object.freeze(content);
}

function budgetedTextLength(
  text: string,
  currentBytes: number,
  blockCount: number,
): number | "rejected" | undefined {
  if (text.length === 0) return currentBytes;
  const encoded = encodedJsonLength(text);
  const nextBytes = currentBytes + (blockCount === 0 ? 0 : 1) + encoded;
  if (nextBytes > ACTIVITY_MAX_TEXT_BYTES) return "rejected";
  return nextBytes;
}

/** 把工具参数/结果 JSON 值收窄为有界字符串；不可序列化值属于结构违约。 */
function summarizeActivityJson(value: unknown): string | "invalid" | "rejected" | undefined {
  if (value === undefined) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return "invalid";
  }
  if (encoded === undefined) return undefined;
  if (encodedJsonLength(encoded) > ACTIVITY_MAX_TEXT_BYTES) return "rejected";
  return encoded;
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
