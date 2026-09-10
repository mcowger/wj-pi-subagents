import assert from "node:assert/strict";
import test from "node:test";
import type { AgentController } from "../src/agent-controller.ts";
import type {
  AvailableHostCapabilities,
  ExtensionApiSurface,
} from "../src/host-gate.ts";
import { InMemoryLocalSupervisorTransportAdapter } from "../src/local-supervisor-transport.ts";
import {
  RUNTIME_EPHEMERAL_ENV_KEYS,
  RUNTIME_INTERNAL_ENV_KEYS,
} from "../src/root-runtime-context.ts";
import { StreamSupervisorChannel } from "../src/stream-supervisor-channel.ts";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorRequestIdRegistry,
  type SupervisorActivityDelivery,
  type SupervisorDisplayDelivery,
} from "../src/supervisor-channel.ts";
import { createWjPiSubagentsRuntimeActivator } from "../src/wj-pi-subagents-runtime.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_ID = "activity-aggregation-root";
const LOCAL_CREDENTIAL = "local-activity-aggregation-credential-0001";
const SUPERVISOR_CREDENTIAL = "supervisor-activity-aggregation-credential-0001";

class FakeReloadEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }
}

class FakeExtensionApi {
  readonly events: FakeReloadEventBus;
  private readonly handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  private readonly tools: unknown[] = [];
  private activeTools: string[] = ["read"];

  constructor(events = new FakeReloadEventBus()) {
    this.events = events;
  }

  on(event: string, handler: (event: unknown, context: unknown) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerTool(tool: unknown): void {
    this.tools.push(tool);
  }

  registerCommand(_name: string, _options: unknown): void {}

  registerMessageRenderer(_customType: string, _renderer: unknown): void {}

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  getAllTools(): unknown[] {
    return [...this.tools];
  }

  setActiveTools(tools: readonly string[]): void {
    this.activeTools = [...tools];
  }

  sendMessage(_message: unknown, _options?: unknown): void {}

  async emit(event: string, value: unknown, context: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(value, context);
    }
  }
}

function childEnvironment(endpoint: string): Record<string, string> {
  return {
    [RUNTIME_INTERNAL_ENV_KEYS.rootId]: ROOT_ID,
    [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: "",
    [RUNTIME_INTERNAL_ENV_KEYS.agentId]: CHILD_ID,
    [RUNTIME_INTERNAL_ENV_KEYS.depth]: "1",
    [RUNTIME_INTERNAL_ENV_KEYS.maxDepth]: "3",
    [RUNTIME_INTERNAL_ENV_KEYS.maxChildrenPerAgent]: "4",
    [RUNTIME_INTERNAL_ENV_KEYS.maxAgentsPerTree]: "8",
    [RUNTIME_INTERNAL_ENV_KEYS.waitTimeoutMs]: "10000",
    [RUNTIME_INTERNAL_ENV_KEYS.managementEnabled]: "true",
    [RUNTIME_INTERNAL_ENV_KEYS.protocolVersion]: SUPERVISOR_PROTOCOL_VERSION,
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: endpoint,
    [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: LOCAL_CREDENTIAL,
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential]: SUPERVISOR_CREDENTIAL,
  };
}

async function waitForCount(values: readonly unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (values.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForMatch<T>(
  values: readonly T[],
  matches: (value: T) => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!values.some(matches) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(values.some(matches));
}

test("子模式扩展把本进程完整活动规范化上行且不在本层缓存", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  const api = new FakeExtensionApi();
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  let controller: AgentController | undefined;
  let parentChannel: StreamSupervisorChannel | undefined;
  const delivered: SupervisorActivityDelivery[] = [];
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
    onController: (value) => {
      controller = value;
    },
  });

  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: () => true,
    });
    parentChannel = channel;
    channel.onActivity((activity) => delivered.push(activity));
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, {
      ok: true,
      nodeVersion: process.versions.node,
      piVersion: "0.85.1",
      platform: process.platform,
      processTreeAdapter: {} as never,
    } as AvailableHostCapabilities);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);

    await api.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先检查输入" },
          { type: "text", text: "开始处理" },
        ],
      },
    }, context);
    await api.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "src/a.ts" },
    }, context);
    await api.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { lines: ["const a = 1;"] },
      isError: false,
    }, context);
    await waitForCount(delivered, 3);

    // 交付是规范条目：正文闭集保持，但身份由运行实例分配。
    assert.equal(delivered.length, 3);
    assert.deepEqual(delivered.map((delivery) => delivery.agent_id), [CHILD_ID, CHILD_ID, CHILD_ID]);
    assert.deepEqual(delivered[0]?.entry.body, {
      type: "message",
      content: [
        { type: "thinking", thinking: "先检查输入" },
        { type: "text", text: "开始处理" },
      ],
    });
    assert.equal(delivered[0]?.entry.agent_id, CHILD_ID);
    assert.match(delivered[0]?.entry.incarnation_id ?? "", /^[0-9a-f-]{36}$/u);
    assert.deepEqual(delivered[1]?.entry.body, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
    });
    assert.deepEqual(delivered[2]?.entry.body, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
      isError: false,
    });
    // 中间运行时不保存历史：本层回放为空。
    assert.deepEqual(controller?.getActivityReplay(CHILD_ID), []);
    assert.equal(controller?.getActivityRevision(CHILD_ID), 0);
  } finally {
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});

test("子模式扩展跨实例 reload 后恢复 display source generation 并轮换活动身份", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  const reloadEventBus = new FakeReloadEventBus();
  const api = new FakeExtensionApi(reloadEventBus);
  let activeApi = api;
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  const hostCapabilities = {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.85.1",
    platform: process.platform,
    processTreeAdapter: {} as never,
  } as AvailableHostCapabilities;
  let parentChannel: StreamSupervisorChannel | undefined;
  const delivered: SupervisorActivityDelivery[] = [];
  const displays: SupervisorDisplayDelivery[] = [];
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
  });
  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: () => true,
    });
    parentChannel = channel;
    channel.onActivity((activity) => delivered.push(activity));
    channel.onDisplay((display) => displays.push(display));
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, hostCapabilities);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);

    await api.emit("message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    }, context);
    await api.emit("message_update", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "reload 前草稿" },
    }, context);
    await waitForMatch(displays, (display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 前草稿");
    const beforeDisplay = displays.find((display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 前草稿");
    assert.equal(beforeDisplay?.event.type === "message_delta"
      ? beforeDisplay.event.displaySourceGeneration
      : undefined, 1);

    await api.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      args: { path: "before-reload.ts" },
    }, context);
    await waitForCount(delivered, 1);
    const before = delivered[0]?.entry;
    assert.ok(before);

    await api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
    const reloadedApi = new FakeExtensionApi(reloadEventBus);
    await activator(reloadedApi as unknown as ExtensionApiSurface, hostCapabilities);
    activeApi = reloadedApi;
    await reloadedApi.emit("session_start", { type: "session_start", reason: "reload" }, context);
    await waitForMatch(displays, (display) =>
      display.event.type === "display_reset" && display.event.displaySourceGeneration === 2);
    await reloadedApi.emit("message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    }, context);
    await reloadedApi.emit("message_update", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "reload 后草稿" },
    }, context);
    await waitForMatch(displays, (display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 后草稿");
    const afterDisplay = displays.find((display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 后草稿");
    assert.equal(afterDisplay?.event.type === "message_delta"
      ? afterDisplay.event.displaySourceGeneration
      : undefined, 2);
    assert.equal(afterDisplay?.event.type === "message_delta"
      ? afterDisplay.event.streamOrdinal
      : undefined, 1);

    await reloadedApi.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      args: { path: "after-reload.ts" },
    }, context);
    await waitForCount(delivered, 2);
    const after = delivered[1]?.entry;
    assert.ok(after);

    assert.notEqual(after.incarnation_id, before.incarnation_id);
    assert.deepEqual(before.body, {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
    });
    assert.deepEqual(after.body, {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
    });
  } finally {
    await activeApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});
