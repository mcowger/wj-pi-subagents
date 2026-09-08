# 02 — 工具活动状态机与安全兜底

**What to build:** 将所有工具执行迁移为规范、来源可验证的原子活动条目。用户在详情中会在工具开始时立即看到运行状态，结束时看到同一条目原地更新；尚未获得专用规则、来源不明或同名覆盖的工具只暴露工具名和状态，原始参数与结果不再跨进程泄露。

**Blocked by:** 01 — 规范 assistant 活动与详情交互.

**Status:** resolved

- [x] 规范工具条目使用产生代理身份、运行实例身份、稳定工具活动 ID 和执行代次关联开始、结束、生命周期收束与迟到回填。
- [x] 工具开始立即建立一个运行中原子条目；工具结束原地更新为成功或失败，同一次调用不会产生独立开始行和结束行，也不显示执行耗时。
- [x] 工具结束事实自包含当前规则允许的摘要；开始事实缺失时仍可建立完成条目，结束先到后迟到开始被忽略，重复开始和结束保持幂等。
- [x] 完成状态不可退回运行中；只有身份、活动 ID 和执行代次全部匹配的迟到结束事实才能回填已收束条目。
- [x] 代理进入 `idle` 时，尚未完成工具收束为警告色 `result unavailable`；进入 `failed` 时收束为红色失败；进入 `terminated` 时收束为中性 `terminated before result`。
- [x] 工具来源身份随规范化输入传递。只有确认来自 Pi 原生实现或本插件注册实现的工具可进入专用规则；第三方扩展、MCP、同名覆盖和来源不明工具使用安全兜底。
- [x] 安全兜底无论运行中、成功或失败都只显示工具名与状态；失败摘要整行红色，不保留参数、结果或错误正文。
- [x] 专用解析允许未来新增字段并忽略它们；必需字段缺失或类型无效时降级为安全兜底，不升级为协议或生命周期故障。
- [x] 普通工具摘要保持单行，路径支持中间省略，其他字段支持右侧省略；Shell 命令和展开正文作为后续专用规则的多行例外。
- [x] 运行中使用强调色，成功与中性使用弱化色，警告使用警告色，工具执行失败摘要整行使用错误色；取消按普通失败处理。
- [x] 可展开工具摘要预留“状态图标、折叠标记、摘要”的稳定结构；所有工具附属正文共用整行背景且顶格显示。
- [x] 旧的通用原始工具参数和结果上送、缓存与查看器投影路径被移除；迁移完成后任何工具都至少经过规范化安全兜底。
- [x] 测试覆盖正常开始/结束、结束先到、开始缺失、重复、完成后迟到开始、七种生命周期更新中的相关收束、匹配回填、来源验证、同名覆盖、结构降级和禁止字段不跨 seam。
- [x] 相关类型检查、桥接构建、定向测试和完整测试套件通过，既有工具活动阶段和子代理生命周期状态无回归。

## Answer

### 交付内容

- **产生端规范化与来源验证**（`src/rpc-bridge-event.ts`、`src/wj-pi-subagents-runtime.ts`）：新增产生端专用规范化接口 `normalizeOwnToolActivityEvent`，把子代理自身观察到的原始 Pi 工具执行事实缩减为无载荷状态事实——原始参数、结果与错误正文在产生端即被丢弃，永不跨进程；允许未来新增字段并忽略它们。来源身份（`pi_native` / `plugin` / `unknown`）随规范化输入传递：`createToolOriginResolver` 在工具事件发生时实时查询宿主 `getAllTools()` 注册表（因此晚加载扩展的同名覆盖也能被识别），`classifyRegisteredToolOrigin` 按注册来源判定——`source: "builtin"` 且工具名在 Pi 原生工具名闭集（`read`/`write`/`edit`/`bash`/`powershell`/`grep`/`find`/`ls`，`PI_NATIVE_TOOL_NAMES`）内为 `pi_native`，注册路径与本插件自身入口同一（`sameExtensionPath`，Windows 大小写不敏感）且名字在本插件系统工具闭集内为 `plugin`，其余（第三方扩展、MCP、SDK、同名覆盖、来源不明、宿主查询失败）一律安全兜底为 `unknown`。桥接 RPC 副本无来源验证能力，固定标记 `origin: "unknown"`，且不再携带任何参数/结果正文（`src/managed-rpc-node.ts` 帧校验同步收紧）。结构违约（关联身份缺失、来源闭集之外）在归一化层拒绝后由调用方静默跳过——是展示降级，不是协议或生命周期故障。
- **同一条目身份**（`src/canonical-activity.ts`、`src/agent-controller.ts`）：工具开始与结束是同一条目的状态事实，`recordOwnActivity` 用 RFC 4122 v5 命名空间派生（`TOOL_ACTIVITY_ENTRY_NAMESPACE` + 运行实例身份 + 工具活动 ID）确定性产生同一条目 `entry_id`，使开始/结束/重复提交在缓存、回放与去重中聚合为同一原子条目；assistant 消息仍是每条独立身份的原子条目。
- **契约与协议版本**：工具事件闭集变化（移除 `args`/`result`，`origin` 必填、结束 `isError` 必填）是不兼容原子正文变化，规范活动契约版本 `/1` → `/2`，监督协议版本随之 `/19` → `/20`；旧契约条目/帧按既有协议故障路径拒绝。
- **查看器工具状态机**（`src/agent-activity-viewer.ts`）：投影改为可重放状态机。工具开始立即建立运行中原子条目；结束事实自包含状态、按（运行实例身份 + 工具活动 ID + 执行代次）三元组匹配原地更新——开始缺失/结束先到时自建完成条目，重复开始、重复结束与完成后迟到开始幂等忽略，完成状态绝不退回运行中；只有身份全匹配的迟到结束才能回填已收束条目。生命周期收束：`updateLifecycle` 立即失效投影缓存，代理进入 `idle` 时运行中工具收束为警告色 `result unavailable`、`failed` 为红色失败、`terminated` 为中性 `terminated before result`；最近一次收束型事实被记忆（`settledLifecycle`），回到 `working` 不解除收束（收束不可逆），收束后匹配结束事实仍回填真实状态。七种生命周期状态中仅 `idle`/`failed`/`terminated` 收束，`starting`/`working`/`interrupting`/`terminating` 保持运行中显示。取消按普通失败处理（取消以 `isError: true` 结束事实到达，显示与失败一致）。
- **安全兜底渲染**：无论来源与状态，兜底条目只显示工具名与状态——运行中 `▶` 强调色（accent）、成功 `✓` 与中性弱化色（dim）、警告 `⚠` 警告色、失败 `×` 整行错误色；不显示执行耗时、参数、结果、错误正文，也没有可展开入口。行首结构固定为“状态图标、折叠标记、摘要”，兜底条目的折叠标记位恒空但位置稳定；后续专用规则（工单 03-06）的附属正文将共用整行背景且顶格显示。`src/ui-surface.ts` 样式闭集扩展 `accent` 与 `warning` 两级。
- **旧路径移除**：通用原始工具参数/结果上送（桥接事件编码、帧校验、监督通道载荷）、缓存投影与查看器折叠渲染（`summarizeToolArguments`、`renderToolResult`、`decodeToolResult`、长结果折叠、`tool_result_collapse_*` 选项）全部删除；迁移后任何工具事实至少经过产生端规范化安全兜底。
- **边界说明**：`read`/`grep`/`find`/`ls` 与 `write`/`edit`/`bash`/`powershell` 的专用摘要、错误展开与路径省略，以及本插件工具的专用摘要，属于工单 03-06；本工单建立来源验证、降级与渲染框架。实时草稿与权威消息收束路径属于工单 07，本工单未触碰。

### 测试

- 新增 `test/tool-origin.test.ts`（Pi 原生名闭集、pi_native/plugin 判定、路径同一性、同名覆盖与 MCP/未知来源兜底、解析器实时查询与失败兜底）。
- 更新 `test/rpc-bridge-event.test.ts`（桥接副本无载荷 + unknown 来源、isError 必填、旧字段闭集拒绝、origin 闭集校验）、`test/canonical-activity-normalization.test.ts`（产生端规范化矩阵：载荷丢弃、未来字段忽略、来源闭集与结构违约拒绝、来源不明合法事实仍产生）、`test/canonical-activity.test.ts` 与 `test/conversation-transport.test.ts`（契约 /2、协议 /20）、`test/agent-activity-viewer.test.ts`（状态机矩阵：开始即时可见、原地更新、无独立结果行、无耗时、结束先到、重复幂等、完成后迟到开始、idle/failed/terminated 收束与非终态不收束、收束不可逆、匹配回填、跨实例不回填、取消按失败、四档颜色、兜底无载荷断言）、`test/agent-activity-cache.test.ts`、`test/agent-activity-bridge.test.ts`（真实桥接进程无载荷闭集）、`test/descendant-activity-aggregation.test.ts`（转发条目新形状）、`test/agent-activity-controller.test.ts`（工具开始/结束确定性共享同一条目身份、重复提交幂等身份）。
- `npm run typecheck`、`npm run build:bridge`、定向测试与完整 `npm test`（320 项，0 失败，5 项 Unix 平台用例在 Windows 跳过）全部通过；既有工具活动阶段（executing_tools/processing）与子代理生命周期投影无回归。

### 手工验收

- 真实 Pi TUI 中从 `/agents` 打开直接子代理详情：工具开始立即出现强调色运行行，结束原地变为弱化 `✓` 或整行红色 `×`，无参数/结果/耗时显示；代理 idle 后运行中工具显示警告 `result unavailable`，随后的真实结果回填原条目。三层树整体手工验收与后续工单共享，详见 spec Testing Decisions。
