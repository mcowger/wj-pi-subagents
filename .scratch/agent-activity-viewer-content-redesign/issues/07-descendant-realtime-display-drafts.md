# 07 — 任意后代实时显示草稿

**What to build:** 让用户在任意深度子代理仍在生成时看到连续、不会串流的实时 `text` 和 thinking 草稿，即使详情在生成中途才打开也能立即显示当前前缀。短暂乱序会等待缺帧并恢复，异常积压只冻结非权威预览；完整 assistant 消息到达后成为唯一历史正文。

**Blocked by:** 01 — 规范 assistant 活动与详情交互.

**Status:** resolved

- [x] 每个代理的实时 `text` 与 thinking delta 逐层 fire-and-forget 转发到顶层；中间运行时不缓存草稿，顶层即使未打开详情也持续维护按代理隔离的当前草稿。
- [x] 实时流身份至少包含 agent ID、runtime incarnation ID 和 stream ID；delta 与 complete 携带相同身份及严格递增 sequence，不同代理、重启实例或复用 stream ID 不会关联到同一草稿。
- [x] 顶层只渲染从 sequence 1 开始的连续前缀；未来帧按 sequence 暂存，缺失帧到达后连续应用该帧及随后已缓存帧。
- [x] 重复帧和旧帧幂等忽略；缺帧不设置时间超时，正确连续前缀不会因先收到更高 sequence 而被清空。
- [x] 每个流最多缓存 256 个尚未连续的 future frame，连续前缀本身不设聚合字节上限。
- [x] future buffer 超限时保留已验证前缀、丢弃 future buffer 并冻结该流；冻结后不继续应用 token，等待权威完整消息。
- [x] 冻结 text 在当前草稿末尾显示弱化省略号；冻结 thinking 的标题显示 `Thinking · streaming incomplete`，展开时正文末尾也显示弱化省略号。
- [x] 正常流式 thinking 默认折叠为 `Thinking · streaming`；手动展开后持续增长，完整权威消息到达后恢复普通 `Thinking`。
- [x] 流式 `text` 实时按 Markdown 重渲染，不增加流式标签、角色标签或消息分隔线。
- [x] `message_complete` 只收束显示流而不写历史；连续草稿在 complete 后继续显示，避免等待权威消息时闪空。
- [x] 权威完整消息携带可精确关联实时流的身份；到达后原地替换并清除对应草稿。权威消息先到时，后续该流迟到 delta 和 complete 被忽略。
- [x] 代理进入 `idle`、`failed` 或 `terminated` 时清除仍未被权威消息替换的草稿；同一运行实例随后到达的合法权威消息仍可进入历史。
- [x] 实时草稿不进入持久历史、100 条计数、父会话对话流或父模型上下文。
- [x] 确定性测试覆盖 9 先于 8、多段 future frame、重复/旧帧、无超时、255/256/257 边界、冻结、text/thinking 提示、complete、权威消息先后顺序、生命周期清理、关闭查看器期间组装以及多层/多代理隔离。
- [x] 相关类型检查、桥接构建、定向测试和完整测试套件通过；实时活动丢失或冻结不改变子代理生命周期状态。

## Answer

### 交付内容

- **产生端改为子代理运行时扩展**（`src/wj-pi-subagents-runtime.ts`）：新增 `OwnDisplayStreamTracker` 订阅扩展 `message_start` / `message_update` / `message_end` 事件，把 `text_delta` / `thinking_delta` 转为带严格递增 sequence 的显示流；`done` / `error`（含中断）与下一条 `message_start` 都会收束当前流，单帧超预算（沿用 16 KiB 单帧预算）时收束并丢弃后续增量。`message_end` 生成权威条目时携带同一 streamId，使 delta、complete 与权威消息共享同一（agent ID + 运行实例身份）来源。桥接进程（`src/rpc-bridge-process.ts`、`src/managed-rpc-node.ts`）与 RpcSupervisor（`src/rpc-supervisor.ts`）中原有的 bridge 短暂显示帧路径与终止期 close 收束全部移除。
- **身份闭集**（`src/rpc-bridge-event.ts`）：`SafeAgentActivityDisplayEvent` 增加 `agentId` 与 `incarnationId`（规范 UUID 闭集校验），产生端事件与身份解耦为 `AgentDisplayStreamUpdate`，由 `AgentController.recordOwnDisplayEvent` 登记完整身份后跨进程转发；assistant `message` 正文新增可选 `streamId` 字段（有界文本），权威条目据此精确关联实时流。规范契约版本升至 `wj-pi-subagents.activity/7`。
- **display 帧**（`src/supervisor-channel.ts`、`src/stream-supervisor-channel.ts`、`src/managed-rpc-supervisor-channel.ts`）：新增 `display` 帧 kind（协议版本升至 `wj-pi-subagents/25`），载荷 `{agent_id, event}`；child 端 `publishDisplayActivity` 复用 in-scope 身份校验并要求事件身份与外层一致，parent 端 `applyDisplay` 双重校验后以 `SupervisorDisplayDelivery` 浮现，双端通道均提供 `onDisplay` 分发。越权身份在发布端拒绝、接收端升级协议故障。
- **逐层转发与顶层草稿登记表**（`src/agent-controller.ts`、新 `src/agent-display-drafts.ts`）：子模式控制器经 `publishUpstreamDisplayActivity` 逐层 fire-and-forget 转发显示事实、不缓存草稿；顶层（root）控制器维护 `AgentDisplayDraftRegistry` 按 agent 分组隔离的 `AgentDisplayDraftStore`——只渲染从 sequence 1 开始的连续前缀，未来帧按 sequence 暂存（每流上限 256 帧，超限保留前缀、丢弃缓冲并冻结），重复/旧帧幂等，缺帧无超时；`message_complete` 只置 complete 状态不删除草稿；权威条目落账后按（incarnation_id, streamId）`replaceDraft` 原地替换并登记墓碑，权威先到时迟到 delta 与 complete 一律忽略；生命周期事实（agent_settled/runtime_failed/resources_confirmed）与 supervisor fault 收束未替换草稿并阻断旧流复活，迟到的合法权威消息仍照常写入历史。实时草稿不进入缓存、回放、条目计数或父模型上下文。
- **查看器投影**（`src/agent-activity-viewer.ts`、`src/agent-tree-ui.ts`）：`AgentActivityStreamSource` 以 `readDisplayDrafts` + 单参数 `onDisplayChange` 提供草稿快照；模型以 `setLiveDrafts` 整体替换保持登记表为唯一事实源，打开详情即显示当前连续前缀（构造时注入），草稿增长服从既有 follow/选择规则。流式 text 实时按正常 Markdown 重渲染（无流式/角色标签、无分隔线）；thinking 默认折叠为 `Thinking · streaming`，冻结标题为 `Thinking · streaming incomplete`，冻结 text 与展开的冻结 thinking 末尾显示弱化省略号 `…`；权威消息到达后由历史条目恢复普通 `Thinking`。

### 测试

- 新增 `test/agent-display-drafts.test.ts`：9 先于 8、多段未来帧补齐保持块序、重复/旧帧幂等、无超时（纯确定性、无定时器）、255/256/257 边界与冻结、冻结后 token 忽略与权威替换、complete 保持显示、权威先到墓碑、生命周期清理 + 重启实例/复用 stream ID/多代理隔离、关闭查看器期间组装、Markdown 实时重渲染、display 帧端到端与越权拒绝。
- 更新 `test/agent-activity-viewer.test.ts`（草稿投影、streaming/incomplete 标题、冻结省略号、权威替换两种顺序）、`test/agent-activity-controller.test.ts`（顶层草稿登记、逐层转发与隔离、recordOwnDisplayEvent 身份登记、streamId 替换、生命周期收束）、`test/agent-display-drafts.test.ts`（display 帧端到端与越权拒绝、产生端跟踪器真实 Pi 事件形状）、`test/agent-activity-supervisor.test.ts`（display 帧分发与终止期语义收敛）、`test/agent-activity-bridge.test.ts`（桥接不再产生显示事件）、`test/rpc-bridge-event.test.ts`（身份闭集）、`test/canonical-activity.test.ts`（契约 v7 + streamId）、`test/agent-tree-ui.test.ts`（快照式 display seam）、`test/conversation-transport.test.ts`（协议 v25）。
- `npm run typecheck`、`npm run build:bridge`、定向测试与完整 `npm test`（411 项，406 pass / 5 skipped）全部通过。

### 手工验收

- 与 spec Testing Decisions 的三层树手工验收（工单 01 起）共享：在真实 Pi TUI 中观察任意深度子代理生成中途的实时 text/thinking、乱序恢复与终态收束；本工单行为已由确定性测试矩阵覆盖。
