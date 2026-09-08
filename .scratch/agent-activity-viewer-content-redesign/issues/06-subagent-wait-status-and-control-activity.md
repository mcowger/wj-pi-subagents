# 06 — 子代理等待、状态与控制轨迹

**What to build:** 为本插件的等待、状态查询和控制工具提供紧凑且语义准确的活动轨迹。用户可以区分“工具调用成功”“目标代理处于失败状态”“控制暂时未改变状态”和“资源清理不完整”，而不会看到重复的完整快照、树数据或报告正文。

**Blocked by:** 02 — 工具活动状态机与安全兜底.

**Status:** resolved

- [x] 专用规则只对本插件实际注册实现的 `wait_agent`、`interrupt_agent`、`terminate_agent`、`get_agent_status` 和 `get_agent_tree` 生效；同名覆盖或来源不明工具走安全兜底。
- [x] `wait_agent` 单目标显示名称和固定八位短 ID，多目标显示数量，并显示实际 outcome；batch release 显示释放者和释放 outcome。
- [x] `wait_agent` 不保存原始结果结构、报告正文或任务结果。只要调用成功返回，reply、final_report、idle、timeout、正常 terminal 和 batch release 都使用成功符号。
- [x] `wait_agent` 返回目标 `state: failed` 时显示红色失败和安全错误码；调用本身失败时摘要整行红色并显示稳定错误码。
- [x] `interrupt_agent` 显示目标和真实控制结果：进入 interrupting 为成功，unchanged 与 compaction active 为中性，稳定调用错误为红色失败。
- [x] `terminate_agent` 显示目标、terminated count、幂等和 forced 事实：正常回收为成功，already terminated 为中性，forced 成功为警告，termination incomplete 或调用失败为红色。
- [x] `get_agent_status` 显示目标和生命周期状态；working/interrupting 可显示 activity phase，failed 显示错误码，terminated 显示 termination result。
- [x] 成功的 `get_agent_status` 始终使用成功符号；目标为 failed 时只将 failed 与错误码片段标红，查询调用失败时整行红色。
- [x] `get_agent_status` 不保存 revision、时间、上下文占用或完整快照。
- [x] `get_agent_tree` 成功只显示工具名和成功状态，不保存 revision、scope、节点列表或状态统计；失败显示稳定错误码并整行红色。
- [x] 插件工具只显示规范稳定错误码，不展示底层异常正文；目标短 ID 固定为完整 UUID 前八位，不承担内部身份或去重职责。
- [x] 所有展示结果保持消息发送、会话事件、工具调用结果和子代理生命周期状态彼此独立，不因 UI 投影写回控制面。
- [x] 测试覆盖每个 outcome/state/control result、局部与整行错误色、forced 警告、幂等结果、压缩阻塞、字段省略、同名覆盖降级和既有管理工具语义。
- [x] 相关类型检查、桥接构建、定向测试和完整测试套件通过，等待批次、控制屏障和资源回收行为无回归。

## Answer

### 交付内容

- **插件专用摘要闭集扩展**（`src/rpc-bridge-event.ts`）：`PLUGIN_TOOL_SUMMARY_NAMES` 新增 `wait_agent`/`interrupt_agent`/`terminate_agent`/`get_agent_status`/`get_agent_tree`；`SafeToolSummary` 新增五个专用分支与对应键白名单。产生端 `extractPluginToolSummary` 按工具提取：等待与控制类开始/失败事实只保留目标事实（单目标完整 UUID + 解析名称，多目标数量；timeout_ms 等其余参数忽略）；`wait_agent` 成功事实自包含实际 outcome（reply/final_report/idle/terminal/timeout/batch_released 闭集），batch release 追加释放者（完整 UUID + 解析名称）与释放 outcome，目标 `state: failed` 追加 failed 与白名单内安全错误码（底层 `error.message` 不进入摘要）；`interrupt_agent` 成功事实保留 `changed` 与压缩阻塞 `blocked_reason`（仅未变更时携带）；`terminate_agent` 保留 `changed`、`forced`（仅强制时携带）与 `terminated_count`；`get_agent_status` 保留生命周期状态、working/interrupting 时的 activity phase、failed 时的错误码与 terminated 时的 termination_result（revision、时间、上下文占用与完整快照一律不进入摘要）；`get_agent_tree` 为无载荷摘要。必需字段缺失、类型错误或闭集外枚举值（outcome/blocked_reason/released 事实/回收数量/生命周期状态）完整降级为无载荷兜底；未知新字段一律忽略。wire 层 `parsePluginToolSummary` 同步收紧：未知键、单目标与多目标不互斥、非法 UUID、非正数数量、闭集外枚举、`state` 非 failed、blocked_reason 出现在已变更事实、forced 非 true 等全部判违约。这是原子正文不兼容变化，规范活动契约 `/5` → `/6`、监督协议 `/23` → `/24`；旧契约条目/帧按既有协议故障路径拒绝。
- **查看器专用渲染**（`src/agent-activity-viewer.ts`）：`summaryFragments` 新增五分支——`wait_agent · name · 前八位 · outcome`（多目标 `N targets`，batch release 追加释放者与释放 outcome，目标 failed 追加 `failed · error_code`）、`interrupt_agent · name · 前八位`（unchanged/compaction_active 中性事实并列行尾）、`terminate_agent · name · 前八位 · N reclaimed/already terminated · forced`、`get_agent_status · name · 前八位 · state · phase/termination_result/error_code`、`get_agent_tree`（仅工具名）。短 ID 复用 `shortAgentId` 固定八位。运行状态机语义不变；新增 `toolDisplayVisual` 显示覆盖：成功事实携带特殊控制事实时——`wait_agent` 观察到目标 `state: failed` 显示红色失败（`×` + error 样式），`terminate_agent` 强制回收成功显示警告（`⚠` + warning 样式）；interrupt 中性与 already terminated 保持成功弱化色（`✓` + terminal），仅以行尾事实区分。
- **行尾局部错误片段机制**（`src/ui-surface.ts`、`src/agent-activity-viewer.ts`）：`ViewerSemanticLine` 新增 `error_tail`；`renderFramedPanelLine`/`renderNarrowPanelLine` 接受可选行尾错误片段——行尾片段使用错误色、前段保持行样式、同一选中/背景包裹，溢出时退化为整行样式。`get_agent_status` 目标 failed 的成功查询行只将 `failed · error_code` 片段标红（`formatStatusSummary` 先于红色片段对前段右侧省略），前段与图标保持成功弱化色；查询调用失败仍整行红色。片段经 `RENDER_VIEWER_LINES` 视口映射透传。
- **边界说明**：所有展示结果只读投影，消息发送、会话事件、工具调用结果与子代理生命周期状态保持独立；控制屏障、等待批次与资源回收行为未触碰。错误码仍走 `PUBLIC_ERROR_CODES` 白名单，底层异常正文不跨进程。

### 测试

- `test/canonical-activity-normalization.test.ts` 新增 6 项：五个工具开始事实白名单目标与未来字段忽略、wait_agent 全部 outcome 与 batch release/目标 failed/白名单外错误码矩阵、控制工具成功事实（changed/blocked_reason/forced/terminated_count/status 片段与 tree 无载荷）矩阵、失败事实目标 + 稳定错误码、开始参数与成功结果违约完整降级矩阵（错误码仍提取）、同名覆盖降级、wire 闭集违约矩阵。
- `test/agent-activity-viewer.test.ts` 新增 8 项：运行中摘要只显示目标事实、wait_agent 成功 outcome 与 batch release、目标 failed 红色失败与调用失败整行红色（主题断言 `<fg:error>`）、interrupt 三种结果与失败、terminate 回收数量/幂等/forced 警告（`<fg:warning>`）、get_agent_status 局部标红（`<fg:dim>` 前段 + `<fg:error>` 片段）与禁止字段省略、get_agent_tree 极简结果、未知来源安全兜底。
- 更新既有“非专用工具事实”测试改用闭集外工具名；`test/canonical-activity.test.ts`（契约 `/6`）、`test/conversation-transport.test.ts`（协议 `/24`）版本断言更新。
- `npm run typecheck`、`npm run build:bridge`、定向测试与完整 `npm test` 全部通过；等待批次、控制屏障与资源回收行为无回归。

### 手工验收

- 真实 Pi TUI 中执行 `wait_agent`（reply/timeout/batch release）确认单目标显示名称与八位短 ID、多目标显示数量、行尾 outcome；目标代理 `failed` 后的 terminal 等待整行红色并带安全错误码。`interrupt_agent` 在 working 与压缩期间分别显示成功与 `compaction_active` 中性事实；`terminate_agent` 显示 `N reclaimed`、`already terminated` 与 forced 警告色；`get_agent_status` 成功行中 failed 状态与错误码片段局部标红；`get_agent_tree` 成功仅显示工具名。
