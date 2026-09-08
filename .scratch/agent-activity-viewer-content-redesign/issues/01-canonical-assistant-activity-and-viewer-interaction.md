# 01 — 规范 assistant 活动与详情交互

**What to build:** 建立新的规范活动条目路径，使用户从 `/agents` 打开任意层级子代理后，可以安全回放完整 assistant Markdown `text`、默认折叠的 thinking，并通过一致的键盘交互浏览和展开内容。该路径从子代理产生事实一直贯通到顶层 TUI，不把活动内容写入父会话或父模型上下文，并为后续工具、实时草稿和历史容量切片提供稳定 seam。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 定义并启用版本化的规范活动条目契约，具有代理身份、运行实例身份、稳定条目身份、原子正文和严格的闭集校验；不兼容的旧活动契约不得与新运行实例混用。
- [x] assistant 活动在产生端只保留合法 `text` 和 thinking block；图片、原生工具调用、未知 block 和结构无效 block 被逐块忽略，过滤后为空的消息不落账。
- [x] 一条完整 assistant 消息作为一个原子条目保留合法 block 的原始顺序；相邻 thinking 合并，被 `text` 隔开的 thinking 保持分离。
- [x] 每个 `text` block 独立按正常 Markdown 完整渲染，不增加角色标签、消息容器或消息分隔线，也不按长度或 Markdown 类型折叠。
- [x] thinking 默认折叠为不含行数和正文预览的 `Thinking`；展开后保留标题，并以顶格、弱化、无逐行前缀、无独立背景的 Markdown 显示。
- [x] 完整正文可按传输帧约束分块；只有所有分块身份、顺序和完整性校验通过后才原子写入历史，缺块不产生部分权威正文，正文聚合不设置字节上限。
- [x] 规范 assistant 条目由中间运行时逐层尽力转发但不在中间层保存历史；只有顶层 TUI 运行时提供按代理隔离的回放与变更通知。
- [x] 查看器支持 Tab 和 Shift+Tab 在全部可展开条目间正反循环，Enter/空格切换，右键展开，左键折叠，上下键滚动，Esc 返回树面板。
- [x] 当前条目仅使用整行选中背景；打开时选择当前视口最新可展开项，新活动不抢选择，视口外目标只触发使其可见的最小滚动。
- [x] 多个条目可同时展开；展开保持当前屏幕位置并暂停 follow，折叠不自动恢复，滚到底部或 Tab 回到底部最新项后恢复 follow。
- [x] footer 始终显示 `↑↓ scroll · Tab/Shift+Tab select · Enter expand · Esc back`，不显示 paused 提示；关闭后重新打开会重置展开、选择、滚动和 follow 状态。
- [x] 标题继续显示模板 ID、名称和子代理生命周期状态；详情保持只读、仅 TUI 生效，非 TUI 模式静默不建立查看器。
- [x] 标题、摘要和正文过滤 ANSI 与危险终端控制字符，并在宽字符和窄终端下保持正确显示宽度。
- [x] 测试从规范化 seam 证明禁用 block 在跨进程前消失，并从现有查看器投影 seam 证明 Markdown、thinking、选择、展开、滚动、follow、footer、生命周期标题和安全渲染的用户可观察行为。
- [x] 相关类型检查、桥接构建、定向测试和完整测试套件通过，父会话对话流和父模型上下文中没有新增活动详情内容。

## Answer

### 交付内容

- **版本化规范活动条目契约**（新 `src/canonical-activity.ts`）：`CANONICAL_ACTIVITY_CONTRACT_VERSION = "wj-pi-subagents.activity/1"`。条目携带 `contract_version`、代理身份（`agent_id`）、运行实例身份（`incarnation_id`，每控制器实例生成一次 UUID）、稳定条目身份（`entry_id`，每原子条目 UUID）与原子正文（既有 message/tool start/tool end 事件闭集）；`parseCanonicalAgentActivityEntry` 执行固定字段集合、固定版本、UUID 身份与正文闭集的严格校验。监督协议版本随契约不兼容变化从 18 升至 19，旧版本条目在发布端抛协议错误、旧形状活动帧在接收端升级为协议故障。
- **产生端过滤与合并**（`src/rpc-bridge-event.ts`）：`normalizeActivityContent` 只保留合法 `text`/`thinking` 块，图片、原生工具调用、未知块与结构无效块逐块忽略；相邻 thinking 以空行合并为一个 thinking 组，被 `text` 隔开的 thinking 保持分离；过滤后为空的消息在桥接端按 `ignored` 处理不落账。assistant 消息正文聚合不再有 16 KiB 字节预算（`ACTIVITY_MAX_TEXT_BYTES` 收窄为工具参数/结果与单 delta 的单帧预算）。
- **分块传输与原子落账**（`src/supervisor-channel.ts`、`src/canonical-activity.ts`）：`publishActivity` 接受规范条目，序列化后超过单帧预算（32 KiB payload 边界）自动按 UTF-8 字符边界分块为同身份 chunk 帧序列；parent 端按条目身份三元组聚合，重复分块幂等、总数不一致或损坏即丢弃，只有全部分块收齐并通过闭集校验后才重组为权威条目一次性交付缓存，缺块静默等待、不产生部分正文；进行中聚合有数量防御边界，正文本身无字节上限。
- **中间层只转发、顶层缓存**（`src/agent-controller.ts`、`src/agent-activity-cache.ts`）：`recordActivity` 在 actor 为 agent（中间运行时）时只沿 `publishUpstreamActivity` 逐层 fire-and-forget 转发、不再保存历史；只有顶层运行时经 `AgentActivityCache` 按代理分组保存规范条目并提供回放、修订号与变更通知。子模式 `recordOwnActivity` 为自身活动生成规范身份后直接上行。
- **查看器投影与交互重做**（`src/agent-activity-viewer.ts`）：每个 `text` 块独立按正常 Markdown 完整渲染（无角色标签/容器/分隔线/长度折叠）；thinking 默认折叠为 `Thinking`（无行数与预览），展开后保留标题并以顶格、弱化（terminal 样式）、无逐行前缀、无独立背景的 Markdown 显示；新增 Tab/Shift+Tab 在全部可展开条目（thinking 组与长工具结果）间正反循环选择、Enter/空格切换、右键展开、左键折叠；打开时选择当前视口最新可展开项，新活动不抢选择，Tab 视口外目标只触发最小滚动；多项可同时展开；展开暂停 follow、折叠不恢复、滚到底部或 Tab 回到底部最新项恢复；footer 固定为 `↑↓ scroll · Tab/Shift+Tab select · Enter expand · Esc back`；当前条目使用整行 `selectedBg` 选中背景；关闭重开由全新实例保证状态重置。标题、摘要与正文继续过滤 ANSI 与危险控制字符并按显示宽度截断。
- **父会话隔离不变**：活动详情仍只进入顶层缓存与 TUI overlay 投影，不进入父会话对话流、父模型上下文或生命周期状态；非 TUI 模式继续静默不建立查看器。

### 测试

- 新增 `test/canonical-activity.test.ts`（契约版本、闭集校验、分块边界、乱序/重复/缺块/损坏重组）与 `test/canonical-activity-normalization.test.ts`（逐块忽略、相邻合并、空消息不落账、无字节上限）。
- 更新 `test/agent-activity-channel.test.ts`（规范条目交付、大正文分块聚合、旧契约帧协议故障、发布端拒绝）、`test/agent-activity-cache.test.ts`、`test/agent-activity-controller.test.ts`（顶层缓存/中间层只转发的四层树）、`test/agent-activity-supervisor.test.ts`、`test/agent-activity-viewer.test.ts`（Markdown、thinking、选择、展开、滚动、follow、footer、选中背景、净化、重置）、`test/agent-activity-bridge.test.ts`（禁用块跨进程前消失、大正文静默缺失不中断）、`test/agent-tree-ui.test.ts`、`test/descendant-activity-aggregation.test.ts`（子模式不缓存自身活动）、`test/rpc-bridge-event.test.ts`、`test/conversation-transport.test.ts`（协议版本 19）。
- `npm run typecheck`、`npm run build:bridge`、定向测试与完整 `npm test` 全部通过。

### 手工验收

- 真实 Pi TUI 中从 `/agents` 打开直接子代理与孙代理详情，确认 Markdown 完整渲染、thinking 折叠/展开、Tab 循环选择、多项同时展开、follow 暂停/恢复与 footer 键位提示（完整三层树手工验收与后续工单共享，详见 spec Testing Decisions）。
