import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MANAGED_RPC_BRIDGE_CREDENTIAL_ENV,
  ManagedRpcBridgeClient,
} from "../src/managed-rpc-node.ts";

const BRIDGE_CREDENTIAL = "bridge-activity-credential-0123456789abcdef";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

interface BridgeSession {
  readonly process: ChildProcessWithoutNullStreams;
  readonly client: ManagedRpcBridgeClient;
  close(): Promise<void>;
}

function startBridge(events: readonly unknown[]): BridgeSession {
  const bridge = spawn(process.execPath, [
    "--experimental-strip-types",
    fileURLToPath(new URL("../src/rpc-bridge-process.ts", import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      [MANAGED_RPC_BRIDGE_CREDENTIAL_ENV]: BRIDGE_CREDENTIAL,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new ManagedRpcBridgeClient({
    stdin: bridge.stdin,
    stdout: bridge.stdout,
    stderr: bridge.stderr,
  }, {
    credential: BRIDGE_CREDENTIAL,
    rpcOptions: {
      piModulePath: new URL("./helpers/scripted-pi-rpc-client.mjs", import.meta.url).href,
      events,
    },
  });
  const close = async (): Promise<void> => {
    await client.requestClose(AbortSignal.timeout(2_000)).catch(() => {});
    await client.release();
    if (bridge.exitCode === null) bridge.kill();
  };
  return { process: bridge, client, close };
}

test("真实桥接进程把加宽的活动事件闭集传给父端，大正文不再被拒绝", async () => {
  const oversized = { text: "x".repeat(64 * 1024) };
  const session = startBridge([
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读文件", signature: "不得透传" },
          { type: "text", text: "开始处理" },
        ],
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "src/a.ts" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { lines: ["const a = 1;"], truncated: false },
      isError: false,
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "thinking", thinking: "跳过的空块" },
        ],
      },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: oversized.text }] },
    },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "结果" }] } },
    { type: "agent_settled" },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    const abort = AbortSignal.timeout(2_000);
    const started = await session.client.start(abort);
    assert.equal(started, undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    assert.deepEqual(received, [
      { type: "agent_start" },
      {
        type: "message",
        content: [
          { type: "thinking", thinking: "先读文件" },
          { type: "text", text: "开始处理" },
        ],
      },
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        origin: "unknown",
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        origin: "unknown",
        isError: false,
      },
      // 空 text 块被跳过，非空 thinking 块保留。
      {
        type: "message",
        content: [{ type: "thinking", thinking: "跳过的空块" }],
      },
      // 超过桥接帧预算的完整正文不经 RPC 桥路径发送（静默缺失）；
      // 权威传输由监督通道分块上行。
      { type: "agent_settled" },
    ]);
  } finally {
    await session.close();
  }
});

test("真实桥接进程把 message_update 转为短暂显示事件，再独立输出完整消息", async () => {
  const session = startBridge([
    {
      type: "message_start",
      message: { role: "assistant", content: [] },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "plan" },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "plan" },
        ],
      },
    },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    await session.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    assert.deepEqual(received, [
      {
        type: "activity_display",
        event: {
          type: "message_delta",
          streamId: "message-1",
          sequence: 1,
          contentIndex: 0,
          contentType: "text",
          delta: "Hel",
        },
      },
      {
        type: "activity_display",
        event: {
          type: "message_delta",
          streamId: "message-1",
          sequence: 2,
          contentIndex: 0,
          contentType: "text",
          delta: "lo",
        },
      },
      {
        type: "activity_display",
        event: {
          type: "message_delta",
          streamId: "message-1",
          sequence: 3,
          contentIndex: 1,
          contentType: "thinking",
          delta: "plan",
        },
      },
      {
        type: "activity_display",
        event: { type: "message_complete", streamId: "message-1", sequence: 4 },
      },
      {
        type: "message",
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "plan" },
        ],
      },
    ]);
  } finally {
    await session.close();
  }
});

test("真实桥接进程忽略空 token delta，保留后续有内容 delta 的序号", async () => {
  const session = startBridge([
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "text" },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "text" }] },
    },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    await session.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    assert.deepEqual(received, [
      {
        type: "activity_display",
        event: {
          type: "message_delta",
          streamId: "message-1",
          sequence: 1,
          contentIndex: 0,
          contentType: "text",
          delta: "text",
        },
      },
      {
        type: "activity_display",
        event: { type: "message_complete", streamId: "message-1", sequence: 2 },
      },
      { type: "message", content: [{ type: "text", text: "text" }] },
    ]);
  } finally {
    await session.close();
  }
});

test("超预算 token delta 收束草稿并丢弃该 stream 的后续片段", async () => {
  const session = startBridge([
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "prefix" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(20_000) },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "suffix" },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "authoritative" }] },
    },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    await session.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    assert.deepEqual(received, [
      {
        type: "activity_display",
        event: {
          type: "message_delta",
          streamId: "message-1",
          sequence: 1,
          contentIndex: 0,
          contentType: "text",
          delta: "prefix",
        },
      },
      {
        type: "activity_display",
        event: { type: "message_complete", streamId: "message-1", sequence: 2 },
      },
      { type: "message", content: [{ type: "text", text: "authoritative" }] },
    ]);
  } finally {
    await session.close();
  }
});

test("关闭真实桥接进程前会收束已有 token 草稿", async () => {
  const session = startBridge([
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    await session.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await session.client.requestClose(AbortSignal.timeout(2_000));
    unsubscribe();

    assert.deepEqual(received, [
      {
        type: "activity_display",
        event: {
          type: "message_delta",
          streamId: "message-1",
          sequence: 1,
          contentIndex: 0,
          contentType: "text",
          delta: "partial",
        },
      },
      {
        type: "activity_display",
        event: { type: "message_complete", streamId: "message-1", sequence: 2 },
      },
    ]);
  } finally {
    await session.close();
  }
});

test("真实桥接进程忽略禁用块与未知块，仅在结构违约时关闭传输", async () => {
  // 禁用与未知块逐块忽略：不跨进程、也不中断会话。
  const ignored = startBridge([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "future_secret_block", secret: "不得静默丢弃" },
          { type: "image", source: "不得跨进程" },
          { type: "text", text: "可见正文" },
        ],
      },
    },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = ignored.client.onEvent((event) => received.push(event));
    await ignored.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();
    assert.deepEqual(received, [
      { type: "message", content: [{ type: "text", text: "可见正文" }] },
    ]);
  } finally {
    await ignored.close();
  }

  // 真正的结构违约（content 非数组）仍按既有语义关闭传输。
  const faulted = startBridge([
    {
      type: "message_end",
      message: { role: "assistant", content: "not-an-array" },
    },
  ]);
  const faults: unknown[] = [];
  const unsubscribeFault = faulted.client.onTransportFault((fault) => faults.push(fault));
  try {
    const abort = AbortSignal.timeout(2_000);
    await faulted.client.start(abort).catch(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(faults, ["protocol_fault"]);
  } finally {
    unsubscribeFault();
    await faulted.close();
  }
});

void AGENT_ID;
