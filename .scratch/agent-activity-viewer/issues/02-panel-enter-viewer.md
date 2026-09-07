# 02 — 面板回车进入最小查看器

**What to build:** 用户在 `/agents` 树面板中选中任意节点并回车，进入该子代理的实时活动查看器：独立全屏 overlay，标题显示该子代理身份（模板、名称）与其生命周期状态；打开即回放该子代理从启动到现在的全部历史活动，随后实时追加新事件；自动滚动跟随最新事件、向上滚动暂停跟随；无缓存活动时显示明确空态；Esc 返回树面板。本片为纯文本级渲染（观感细化由 03 承担），完成后特性端到端可用。查看器内容只进显示层，绝不写入父会话对话流或父模型上下文。设计依据见同目录 `spec.md`。

**Blocked by:** 01 — 子代理活动流数据弹道（消费活动流缓存的回放读取与变更通知契约）

**Status:** resolved

- [x] 树面板交互投影的键盘输入新增回车语义：对选中节点返回"进入查看"结果；错误态、无选中行等异常输入被忽略；有纯模型测试
- [x] 查看器投影模型（纯类，参照树面板投影模式）：打开先回放全部历史，再随变更通知实时追加；自动跟随最新事件、上滚即暂停、回到底部恢复；空态提示；Esc 关闭；有纯模型测试
- [x] overlay 薄壳装配：标题展示子代理模板/名称与生命周期状态；Esc 返回面板；标题与摘要文本沿用现有 UI 事实净化惯例（剥离终端控制字符）
- [x] 仅 TUI 模式生效；非 TUI（RPC/print/headless）下绑定层静默 no-op，不产生错误
- [x] 评审验收：查看器代码路径不存在向父会话发送消息或追加条目的调用，内容不进入父模型上下文
- [x] TUI 手工验收：真实子代理运行时打开查看器，能看到历史回放与实时追加的文本活动流（手工步骤见 Answer；当前执行环境无运行中的父端 TUI 运行时，同工单 01 的验收方式，在父会话中执行）

## Answer

### 交付内容

1. **树面板回车语义**（`src/agent-tree-ui.ts`）
   - `AgentTreePanelInputOutcome` 新增 `"enter"`：`handleInput` 对 `\r` 在选中行存在时返回 `"enter"`，选中节点经既有的 `getPublicState().selected_key` 暴露；错误态（`markError`）与空树/无选中行时忽略。与既有 ↑↓←→/Esc 语义共存，Esc 关闭行为不变。
2. **查看器投影模型**（新模块 `src/agent-activity-viewer.ts`）
   - `AgentActivityViewerModel` 纯类，完全参照树面板投影模式：构造时传入身份事实（agent_id/template/name/state）与全量回放（打开即回放），`syncFrom(replay)` 按到达序追加新到达部分（绑定层收到变更通知后全量拉取对账），`appendEvent` 单条追加。
   - 自动跟随：跟随时视口始终贴底（`settleFollow` 在追加与输入前收敛）；↑ 上滚即暂停、追加不再跳底；↓ 回到底部（`scrollOffset` 达到 `maxScrollOffset()`）恢复跟随；footer 显示 `↑↓ scroll · Esc back` / `paused · ↓ resume · Esc back`。
   - 纯文本级渲染（观感细化由 03 承担）：message 事件 text 块按换行拆行直显、thinking 块带 `┆` 前缀；工具事件单行 `▶ 名称 args` / `✓|× 名称 · result`。无缓存事件时显示明确空态 `No cached activity yet`。Esc 返回 `"close"`。
   - 防线与缓存一致：追加事件经 `parseAgentActivityEvent` 闭集校验，违约/超限静默拒绝；身份与摘要文本沿用 `safeUiFact` 净化（剥离终端控制字符）。
3. **overlay 薄壳装配 + runtime 接线**（`src/agent-tree-ui.ts`、`src/wj-pi-subagents-runtime.ts`）
   - `bindAgentTreeUi` 新增可选第三参数 `AgentActivityStreamSource`（`readReplay`/`onChange`），runtime 以控制器既有接缝适配（`getActivityReplay`/`onActivityChange`，只读）。
   - 面板 `handleInput` 收到 `"enter"` 后，在面板 overlay 之上叠加打开查看器 overlay（宿主 stacked overlay 支持模式，同 `overlayOptions` 160/center/1）；查看器标题展示 `AGENT ACTIVITY · 模板 · 名称 · 生命周期状态`；Esc 关闭查看器后面板重新接管输入，可另选节点再进。
   - 树快照变更时同步刷新查看器标题的生命周期状态；查看器打开期间按 agent_id 过滤活动变更通知，只消费所查看节点的事件。装配薄壳按 Testing Decisions 不做自动化，由 TUI 手工验收覆盖。
   - 非 TUI no-op：查看器只能从 `/agents` 面板（TUI-only 路径）进入，RPC widget 与 print/json 路径不涉及任何查看器逻辑。
4. **共享 UI 原语提取**（新模块 `src/ui-surface.ts`）
   - 将 `agent-tree-ui.ts` 中的显示宽度计算、`safeUiFact` 净化、主题应用与框线渲染原语提取为共享模块，树面板与查看器共同消费，`displayWidth`/`truncateToDisplayWidth` 从 `agent-tree-ui.ts` re-export 保持既有导入兼容。无行为变化。

### 与安全边界的关系

查看器数据路径仅为：缓存 `replay`（纯读）→ 投影模型 → overlay `render` 字符串。全 diff 内无 `sendMessage`/`appendEntry`/`steer`/`notify`/`setWidget` 调用，过程内容不写父会话对话流、不进父模型上下文（Spec 轴评审逐文件确认）。

### Code review（双轴）与修复记录

- Standards 轴：无文档化标准硬违规。已修复：①删除搬移后无引用的 `AgentTreePanelTheme` 死类型；②查看器提取 `maxScrollOffset()` 收敛四处重复的滚动上限计算；③删除 `AgentActivityViewerLineStyle` 纯别名与 `bodyStyle` 常量包装。
- Spec 轴：工单可自动化验收项逐条有落点、无缺失、无实质 scope creep。判断项保留并说明：①`src/ui-surface.ts` 提取属支撑性抽取（消除树面板/查看器重复渲染原语，为工单 03 复用铺路，无行为变化）；②暂停提示 footer 属 spec L54 既有要求的提前落地，非 03 专属；③`syncFrom` 前缀对账假设缓存纯追加（工单 01 契约：按到达序追加、不重排），成立；④内容不足一屏时 ↑ 返回 ignored——无回看余量时无"暂停"可言，与树面板边界键语义一致；⑤overlay 叠加的输入路由依赖宿主行为，属不自动化薄壳，由手工验收覆盖。
- Standards 轴另指出：`Status: claimed` 与 `triage-labels.md` 五标签闭集存在约定冲突——本工单遵循 Wayfinder/调度协议的 `claimed`/`resolved` 约定（issue-tracker.md），标签闭集文档可在后续统一。

### 验证

- 纯模型测试：树面板回车语义 2 例（`test/agent-tree-ui.test.ts`，共 15 例）；查看器投影模型 14 例（回放、thinking 前缀、空态、追加序、跟随/暂停/恢复、边界键、Esc、标题净化、违约与超限拒绝、表面框线与主题，`test/agent-activity-viewer.test.ts`）。
- 全量回归：254 项测试，249 pass / 0 fail / 5 skipped（既有跳过）；`tsc --noEmit` 通过。

### TUI 手工验收步骤（供父会话执行）

在父 Pi 会话（加载本扩展，TUI 模式）中：1) spawn 一个真实子代理并派发长任务；2) `/agents` 打开面板，选中该节点按回车——应进入全屏 overlay，标题显示模板/名称/生命周期状态，正文先回放全部历史活动；3) 观察实时追加自动贴底，↑ 暂停（出现 paused 提示且追加不跳底）、↓ 回到底部恢复跟随；4) Esc 返回面板，另选节点再进，确认不串流；5) 确认父对话流无查看器内容、无新增消息条目；6) 对无活动的节点确认空态提示 `No cached activity yet`。
