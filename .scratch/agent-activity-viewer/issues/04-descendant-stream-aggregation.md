# 04 — 递归汇聚：后代子代理透明

**What to build:** 让树上任意层级的后代子代理（孙代理及更深）在父会话中同样可完整查看：每层 pi 进程中的扩展实例将本进程会话事件沿监督通道上行给直接父代理；父端缓存汇聚直接子代理上行的整棵子树事件流，按 agent_id 归档。由此根端缓存天然覆盖全树，无需新增跨进程通道。用户在树面板中选中孙代理回车后，可像直接子代理一样回放全部历史并实时查看。设计依据见同目录 `spec.md`。

**Blocked by:** 01 — 子代理活动流数据弹道（活动流缓存与监督通道事件就绪；本片与 02、03 无依赖，可并行）

**Status:** resolved

- [x] 每层扩展实例将本进程会话事件沿监督通道活动流事件上行给直接父代理；仅上行自身事件，子树流由各层逐级汇聚
- [x] 父端活动流缓存汇聚直接子代理上行的整棵子树流，按 agent_id 隔离归档；深层节点事件不串流到其他代理
- [x] 树面板中孙代理及更深节点选中回车后可完整回放与实时查看（复用 02 的查看器，无 UI 改动）
- [x] 活动流上行与现有 reply、活动阶段、控制消息互不阻塞；既有测试全绿零回归
- [x] 汇聚行为有纯模型测试（多层汇聚、逐级转发、隔离性）
- [ ] TUI 手工验收：spawn 含孙代理的真实树，根端可查看孙代理的完整活动流（当前执行环境无可操作的父端 TUI；复验步骤见 Answer）

## Answer

### 交付内容

1. **每层采集自身完整活动**（`src/wj-pi-subagents-runtime.ts`）
   - 子模式扩展监听 `message_end`、`tool_execution_start`、`tool_execution_end`，复用 `normalizeRpcBridgeEvent` 的闭集校验与正文预算，将合法的 assistant 消息、工具调用和工具结果交给当前控制器记录。
   - 根模式没有代理身份，不记录根会话；handoff 中的旧 runtime 也不会继续采集。未知事件、非 assistant 消息、结构违约和超限事件沿用既有规范化语义静默丢弃。

2. **逐级缓存和递归上行**（`src/agent-controller.ts`）
   - 新增 `recordOwnActivity()`，用当前 actor 的真实 `agent_id` 记录本进程事件；根 actor 明确拒绝该入口。
   - 自身事件和直接子代理交付的子树事件统一经过 `recordActivity()`：合法事件先进入本层 `AgentActivityCache`，只有 revision 实际递增后才调用既有 `publishUpstreamActivity`。因此每层缓存“自身 + 直接子树”，并原样保留后代的 `agent_id` 继续上行。
   - 上行失败不回滚本地缓存，也不改变生命周期；缓存的既有按 ID 分桶、修订号、终止后回放语义保持不变。

3. **完整事件单一权威来源，避免直接子重复**（`src/rpc-supervisor.ts`）
   - 子扩展的监督通道交付成为完整活动的权威来源。RPC bridge 中同一条 message/工具完整事件的副本不再二次发出 `activity_stream`。
   - RPC 工具开始/结束事件仍调用既有阶段跟踪，`activity_display`、reply、生命周期和控制消息路径保持原有职责；没有新增跨进程通道或确认屏障。

4. **根端深层查看复用现有 UI**
   - 生产 UI 无改动：树面板已有的任意节点查找、按选中 `agent_id` 调用 `readReplay` 和订阅变更逻辑可直接消费根端新增的深层缓存。
   - `test/agent-tree-ui.test.ts` 将 overlay 接线验收提升到孙节点，验证打开即回放该节点历史、其他 ID 的通知被忽略、该节点完整事件实时追加，并保持既有 50ms 合并重绘。

### TDD 与验证

- 运行时集成测试先得到预期红灯（父通道实际收到 `[]`，期望三类完整活动），再接入子模式事件钩子转绿；测试使用真实 `InMemoryLocalSupervisorTransportAdapter` 和 `StreamSupervisorChannel`，同时断言本层缓存与父通道交付。
- 纯模型测试建立 root -> child -> grandchild -> great-grandchild 四层树，分别记录三层代理自身事件，断言每层只缓存其自身/子树、每一跳携带真实 `agent_id`、根端三个分桶各自 revision 为 1，证明无重复。
- `npm run check` 通过（`tsc --noEmit`、bridge 构建、全量测试）。独立 TAP 统计：275 tests，270 pass，0 fail，5 skipped（既有跳过）。
- `git diff --check 9c22031fa319b7a8ad9c862938d94fb5ce71067c...HEAD` 通过。

### Code Review

- **Standards**：固定点 `9c22031fa319b7a8ad9c862938d94fb5ce71067c` 可解析，审查 diff 非空。复审未发现文档标准违规或 Fowler baseline smell；首轮对临时 `claimed` 的标签疑问经 `docs/agents/issue-tracker.md` 的 Wayfinder `claimed`/`resolved` 约定澄清。
- **Spec**：首轮发现自动化只覆盖到孙节点的 P2，已在 `c4477b9` 扩展为四层并经复审确认解决；未发现 scope creep 或明确错误实现。唯一残余是当前非交互子会话无法执行真实父端 TUI 手工验收，因此该清单项保持未勾选，不用 print/模拟 overlay 冒充手工结果。

### 父端 TUI 复验步骤

1. 在加载本扩展的父 Pi TUI 中 spawn 一个允许创建子代理的直接子代理，并要求它再 spawn 一个孙代理执行会产生 assistant 文本、工具调用和工具结果的任务。
2. 待孙代理已经产生部分活动后打开 `/agents`，展开并选中孙代理，按 Enter；确认先显示打开前的完整历史。
3. 让直接子代理继续向该孙代理派发一条会产生新工具活动的消息；保持查看器打开，确认新完整事件自动追加且没有重复。
4. 返回树面板并分别打开直接子代理、孙代理和另一并行分支，确认内容按节点隔离、不串流；孙代理终止后再次打开，确认历史仍可回放。
