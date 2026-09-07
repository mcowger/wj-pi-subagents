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
} from "../src/supervisor-channel.ts";
import { createWjPiSubagentsRuntimeActivator } from "../src/wj-pi-subagents-runtime.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_ID = "activity-aggregation-root";
const LOCAL_CREDENTIAL = "local-activity-aggregation-credential-0001";
const SUPERVISOR_CREDENTIAL = "supervisor-activity-aggregation-credential-0001";

class FakeExtensionApi {
  private readonly handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  private readonly tools: unknown[] = [];
  private activeTools: string[] = ["read"];

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

test("子模式扩展把本进程完整活动写入自身缓存并沿监督通道上行", async () => {
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
      piVersion: "0.84.4",
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

    const expected = [
      {
        type: "message",
        content: [
          { type: "thinking", thinking: "先检查输入" },
          { type: "text", text: "开始处理" },
        ],
      },
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: '{"path":"src/a.ts"}',
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: '{"lines":["const a = 1;"]}',
        isError: false,
      },
    ] as const;
    assert.deepEqual(delivered, expected.map((event) => ({ agent_id: CHILD_ID, event })));
    assert.deepEqual(controller?.getActivityReplay(CHILD_ID), expected);
  } finally {
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});
