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

/** 来源身份闭集谓词；wire 校验与产生端判定共用同一形状。 */
export function isSafeToolOrigin(value: unknown): value is SafeToolOrigin {
  return value === "pi_native" || value === "plugin" || value === "unknown";
}

/**
 * 允许专用摘要规则的 Pi 原生工具名闭集（工单 03：文件读取与检索）。
 * 只有来源验证为 pi_native 的同名实现才能携带专用摘要。
 */
export const FILE_TOOL_SUMMARY_NAMES: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** Pi 各检索工具的默认 limit；非默认值才进入摘要。 */
const GREP_DEFAULT_LIMIT = 100;
const FIND_DEFAULT_LIMIT = 1000;
const LS_DEFAULT_LIMIT = 500;

/**
 * Pi 原生文件读取与检索工具的专用摘要闭集。字段是硬编码白名单：原始参数
 * 中的未来新增字段、文件正文、图片数据、匹配正文、路径列表与目录条目都
 * 不在这里出现。专用解析宽容原始输入变化；摘要自身的键集合是严格闭集。
 */
export type SafePiToolSummary =
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
    };

const READ_SUMMARY_KEYS = Object.freeze([
  "tool", "path", "offset", "limit", "truncated", "truncatedBy", "firstLineExceedsLimit", "hasMoreLines",
] as const);
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
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly origin: SafeToolOrigin;
      /** 仅来源验证通过的 Pi 原生专用工具可携带的白名单摘要。 */
      readonly summary?: SafePiToolSummary;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly origin: SafeToolOrigin;
      readonly isError: boolean;
      /** 自包含摘要：成功时含结果事实，失败时只含输入参数。 */
      readonly summary?: SafePiToolSummary;
      /** 失败时的完整原始错误正文（产生端已净化）；不在成功事实出现。 */
      readonly errorText?: string;
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
      if (
        !hasOnlyToolEventKeys(value, ["type", "toolCallId", "toolName", "origin", "summary"])
      ) return INVALID_ACTIVITY_EVENT;
      if (!isSafeToolOrigin(value.origin)) return INVALID_ACTIVITY_EVENT;
      if (value.summary !== undefined) {
        if (parseFileToolSummary(value.toolName, value.origin, value.summary) === undefined) {
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
          ...(value.summary === undefined ? {} : { summary: value.summary as SafePiToolSummary }),
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
          ["type", "toolCallId", "toolName", "origin", "isError", "summary", "errorText"],
        )
      ) return INVALID_ACTIVITY_EVENT;
      if (!isSafeToolOrigin(value.origin)) return INVALID_ACTIVITY_EVENT;
      if (value.summary !== undefined) {
        if (parseFileToolSummary(value.toolName, value.origin, value.summary) === undefined) {
          return INVALID_ACTIVITY_EVENT;
        }
      }
      if (value.errorText !== undefined) {
        // 错误正文只允许 Pi 原生专用工具在失败事实中携带；空正文无意义。
        if (
          value.isError !== true
          || value.origin !== "pi_native"
          || !FILE_TOOL_SUMMARY_NAMES.has(value.toolName)
          || typeof value.errorText !== "string"
          || value.errorText.length === 0
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
          ...(value.summary === undefined ? {} : { summary: value.summary as SafePiToolSummary }),
          ...(value.errorText === undefined ? {} : { errorText: value.errorText }),
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
 * 产生端规范化：把子代理自身观察到的原始 Pi 工具执行事实缩减为安全闭集。
 * 原始结果与错误正文在此处丢弃，永不跨进程；来源身份由调用方验证后随
 * 规范化输入传递。来源验证通过的 Pi 原生文件读取与检索工具（read/grep/
 * find/ls）改用专用摘要规则：只保留白名单参数与结果事实，失败时自包含
 * 输入参数与净化后的完整错误正文。专用解析宽容未来新增字段并忽略它们；
 * 必需字段缺失或类型错误、开始参数缺失或来源验证失败时完整降级为无载荷
 * 安全兜底。允许未来新增字段并忽略它们；关联身份缺失或来源闭集之外属于
 * 结构违约，由调用方决定是否升级，不在本函数内降级。
 */
export function normalizeOwnToolActivityEvent(
  event: unknown,
  origin: SafeToolOrigin,
  startArgs?: unknown,
): AgentActivityEventNormalization {
  if (!isRecord(event) || typeof event.type !== "string") return INVALID_ACTIVITY_EVENT;
  if (!isSafeToolOrigin(origin)) return INVALID_ACTIVITY_EVENT;
  // 专用摘要只作用于来源验证通过的原生文件读取与检索工具；其余来源与
  // 工具都是无载荷安全兜底。
  const dedicatedFileTool = origin === "pi_native"
    && typeof event.toolName === "string"
    && FILE_TOOL_SUMMARY_NAMES.has(event.toolName);
  if (event.type === "tool_execution_start") {
    if (
      !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
      || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
    ) return INVALID_ACTIVITY_EVENT;
    // 专用摘要只在 Pi 原生来源下提取；同名覆盖/未知来源与降级场景都是
    // 无载荷安全兜底。
    const summary = dedicatedFileTool ? extractFileToolSummary(event.toolName, event.args) : undefined;
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
    const summary = dedicatedFileTool && isRecord(startArgs)
      ? extractFileToolSummary(event.toolName, startArgs, event.result, event.isError)
      : undefined;
    const errorText = summary !== undefined && event.isError
      ? extractErrorText(event.result)
      : undefined;
    return parseAgentActivityEvent({
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      origin,
      isError: event.isError,
      ...(summary === undefined ? {} : { summary }),
      ...(errorText === undefined ? {} : { errorText }),
    });
  }
  return INVALID_ACTIVITY_EVENT;
}

/**
 * 运行时使用的有状态专用规范化器：Pi 的工具结束事件不携带参数，本工厂按
 * 工具活动 ID 缓存开始事件的参数，供结束事实自包含输入参数。缓存有界，
 * 溢出时淘汰最旧的待决条目；宿主查询失败时全部工具保守兜底为 unknown。
 */
export function createOwnToolActivityNormalizer(
  resolveToolOrigin: (toolName: string) => SafeToolOrigin,
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
    return normalizeOwnToolActivityEvent(event, origin, startArgs);
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
 * 从原始 Pi 工具事实提取专用摘要：输入参数部分始终提取；只有成功结束
 * 才从 result.details 提取结果事实。必需字段缺失、任何已知字段存在但
 * 类型错误时返回 undefined（完整降级）；值域偏离只导致对应事实不携带。
 */
function extractFileToolSummary(
  toolName: string,
  args: unknown,
  result?: unknown,
  isError?: boolean,
): SafePiToolSummary | undefined {
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
function parseFileToolSummary(
  toolName: string,
  origin: SafeToolOrigin,
  value: unknown,
): SafePiToolSummary | undefined {
  if (origin !== "pi_native" || !FILE_TOOL_SUMMARY_NAMES.has(toolName)) return undefined;
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
      return value as unknown as SafePiToolSummary;
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
      return value as unknown as SafePiToolSummary;
    }
    case "find": {
      if (!hasOnlySummaryKeys(value, FIND_SUMMARY_KEYS)) return undefined;
      if (typeof value.pattern !== "string" || typeof value.path !== "string") return undefined;
      if (!validSummaryCount(value, "limit")) return undefined;
      if (value.noFiles !== undefined && typeof value.noFiles !== "boolean") return undefined;
      const resultLimitReached = positiveCountField(value, "resultLimitReached");
      if (value.resultLimitReached !== undefined && resultLimitReached === undefined) return undefined;
      if (!validTruncationFacts(value)) return undefined;
      return value as unknown as SafePiToolSummary;
    }
    case "ls": {
      if (!hasOnlySummaryKeys(value, LS_SUMMARY_KEYS)) return undefined;
      if (typeof value.path !== "string") return undefined;
      if (!validSummaryCount(value, "limit")) return undefined;
      if (value.emptyDirectory !== undefined && typeof value.emptyDirectory !== "boolean") return undefined;
      const entryLimitReached = positiveCountField(value, "entryLimitReached");
      if (value.entryLimitReached !== undefined && entryLimitReached === undefined) return undefined;
      if (!validTruncationFacts(value)) return undefined;
      return value as unknown as SafePiToolSummary;
    }
    default:
      return undefined;
  }
}

function hasOnlySummaryKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
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
