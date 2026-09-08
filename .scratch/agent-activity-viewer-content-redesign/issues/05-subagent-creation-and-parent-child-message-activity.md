# 05 — 子代理创建与父子消息轨迹

**What to build:** 让用户既能在发送者详情中审计子代理创建和父子消息工具，也能在接收者详情中看到已被接纳的父代理输入。消息正文默认折叠、可完整展开为 Markdown；失败尝试仍可查看，但未接纳消息不会伪造为接收者活动。

**Blocked by:** 02 — 工具活动状态机与安全兜底.

**Status:** resolved

- [x] 专用规则只对本插件实际注册实现的 `get_agent_templates`、`spawn_agent`、`send_message`、`normal_reply` 和 `final_report` 生效；同名覆盖或来源不明工具走安全兜底。
- [x] `get_agent_templates` 成功只显示模板数量，不保存模板 ID、描述、工具、扩展或其他配置；失败只显示稳定错误码。
- [x] `spawn_agent` 成功显示 name、template ID 和完整 UUID 的固定前八位，不显示 depth 或初始 state；显示层不处理短 ID 碰撞，内部关联始终使用完整 UUID。
- [x] `send_message` 显示目标名称与固定八位短 ID，不显示 `accepted`；完整 message 在参数完整的工具开始事实到达后即可选择和展开。
- [x] `normal_reply` 与 `final_report` 摘要只显示工具名，不显示 `accepted`；完整 message 在工具开始后即可展开，工具状态变化不会自动折叠正文。
- [x] 三种消息工具无论成功或失败都保留完整尝试正文；失败摘要整行红色并显示规范稳定错误码，但正文继续使用正常 Markdown 文字样式。
- [x] 消息正文默认折叠，展开后使用统一整行背景、顶格无缩进的 Markdown；多个消息、报告和 thinking 可同时展开，完全相同正文不去重。
- [x] 工具参数不进行 token 级流式展示；只有完整参数随工具开始事实到达后才建立正文与展开入口。
- [x] 初始任务和后续父代理消息只有在接收侧实际接纳后才写入接收者活动历史；统一摘要为 `Parent message`，不区分首条与后续消息，也不显示父代理身份。
- [x] `Parent message` 正文完整保留、默认折叠，并按统一背景、顶格无缩进的正常 Markdown 展开；未接纳输入不创建该条目。
- [x] system prompt、模板正文、上下文文件正文及其加载清单永不进入活动历史。
- [x] 消息发送、报告提交和父消息记录不改变子代理生命周期状态，也不把接纳解释为已读、已处理、完成或会话终止。
- [x] 测试覆盖五种插件工具的运行中/成功/失败、固定短 ID、消息展开、失败正文保留、接收侧接纳、未接纳隔离、重复正文保留、同名覆盖降级和禁用系统内容。
- [x] 相关类型检查、桥接构建、定向测试和完整测试套件通过，父子消息接纳与 `final_report` 会话语义无回归。

## Answer

### 交付内容

- **插件专用摘要闭集与契约演进**（`src/rpc-bridge-event.ts`）：新增 `PLUGIN_TOOL_SUMMARY_NAMES` 闭集（`get_agent_templates`/`spawn_agent`/`send_message`/`normal_reply`/`final_report`），`SafeToolSummary` 扩展五个插件分支。专用规则只作用于来源验证为 `plugin` 的实现；同名覆盖（origin 为 `pi_native`/`unknown`）一律无载荷安全兜底。`normalizeOwnToolActivityEvent` 按来源分派到 `extractPluginToolSummary`（产生端）与 `parsePluginToolSummary`（wire 校验），成功事实提取 `result.details`、失败事实提取稳定错误码。插件失败不携带 `errorText`（wire 层拒绝），只携带 `errorCode`；`extractPluginErrorCode` 只从 `SubagentToolError` 的稳定 JSON 外壳取 `PUBLIC_ERROR_CODES` 白名单内的 `error.code`，白名单外、非 JSON 与缺失外壳静默省略。这是原子正文不兼容变化，规范活动契约 `/4` → `/5`、监督协议 `/22` → `/23`；旧契约条目/帧按既有协议故障路径拒绝。
- **产生端专用提取规则**（`extractPluginToolSummary`）：
  - `get_agent_templates`：无输入参数；成功只提取 `details` 模板数组数量，模板 ID、描述、工具、扩展等配置永不进入摘要；失败或 details 缺失/非数组时只保留无载荷工具名摘要。
  - `spawn_agent`：开始与失败摘要只保留 `name` + `template_id`；成功追加完整规范 UUID `agent_id`；depth、初始 state、任务正文等未来字段与敏感载荷一律忽略。
  - `send_message`：开始事实即自包含完整尝试正文（经 `sanitizeSafeActivityText` 净化）与目标 `agent_id`；可选 `resolveAgentName` 命中时携带目标名称，未命中不携带；`accepted` 等其它字段忽略。
  - `normal_reply`/`final_report`：摘要只含工具名 + 完整 `message`；无论成功或失败正文都保留。
  - 必需字段缺失或类型错误（非 UUID、非 string message 等）完整降级为无载荷兜底；结束事实缺少缓存的开始参数时同样降级，但失败事实的稳定错误码仍提取。
- **接收侧父消息记录**（`src/agent-controller.ts`）：`sendMessage` 只有在监督器返回 `accepted: true`（接收侧同步接纳）后才调用 `recordParentMessage`，把 `parent_message` 条目（正文净化后为 text block）写入接收者活动缓存；投递失败、压缩阻塞或任何未接纳路径不产生条目。记录只追加活动缓存，不改变子代理生命周期状态，也不把接纳解释为已读、已处理、完成或会话终止。逐条独立 `entry_id`，完全相同正文不去重。
- **查看器专用渲染**（`src/agent-activity-viewer.ts`）：`summaryFragments` 新增五分支——`get_agent_templates · N templates`（失败无数量）、`spawn_agent · name · template_id · 前八位`、`send_message · name · 前八位`、`normal_reply`/`final_report`（仅工具名）。`shortAgentId` 固定取完整 UUID 前八位，显示层不处理碰撞、不显示完整 UUID，内部关联始终使用完整 UUID。消息类工具摘要带 `▸/▾` 折叠标记与 `tool-message:{entryId}` 展开键：正文默认折叠，展开后按统一背景、顶格无缩进的正常 Markdown 渲染（与 assistant 消息正文同一路径）；工具开始→结束的原地更新不改变 `entryId`，展开状态跨状态变化保持。失败整行红色并在行尾并列规范稳定错误码（`× send_message · … · agent_unavailable`），正文继续使用正常 Markdown 文字样式、继续可展开查看。`parent_message` 条目统一渲染为 `Parent message` 单行标题（`parent-message:{entryId}` 展开键）：不区分首条与后续消息、不显示父代理身份，正文默认折叠、展开为顶格 Markdown，逐条独立展开、不去重。工具参数无 token 级流式展示——只有完整参数随工具开始事实到达后才建立正文与展开入口。
- **运行时接线**（`src/wj-pi-subagents-runtime.ts`）：`createOwnToolActivityNormalizer` 传入 `readDirectChildDisplayName` 解析器，`send_message` 摘要提取时实时查询直接子快照携带目标名称；查询失败或缺名时不携带名称，不影响正文事实。
- **边界说明**：`wait_agent` 等其余插件工具仍是无载荷状态事实；插件工具无流式参数；`final_report` 的会话语义（outcome 投影、水位）由既有 conversation 测试保证无回归。

### 测试

- `test/canonical-activity-normalization.test.ts` 新增 6 项：五种插件工具开始事实自包含白名单参数并忽略未来新增字段（depth/初始 state/任务正文/accepted/priority）、结束事实成功/失败摘要差异与白名单稳定错误码矩阵（含白名单外/非 JSON/缺失外壳静默省略）、必需字段缺失或类型错误完整降级矩阵（错误码仍提取）、同名覆盖与 `pi_native`/`unknown` 来源不产生插件摘要与错误码、插件摘要 wire 闭集矩阵（未知键/非法 UUID/负数量/空正文/白名单外错误码判 `invalid`）。
- `test/agent-activity-viewer.test.ts` 新增 7 项：五种工具运行中摘要只显示白名单参数（无 depth/accepted/正文）、成功摘要显示模板数量与固定八位短 ID（无完整 UUID/模板配置）、失败整行红色显示稳定错误码且消息失败正文保留（主题断言 `<fg:error>`）、消息工具展开为顶格 Markdown 且状态变化不折叠正文、失败正文可继续查看（独立失败模型验证错误码与正文并存）、`final_report` 失败正文保留并可展开、Parent message 条目统一标题/默认折叠/可展开/重复正文不去重/无父代理身份、未知来源插件工具名走安全兜底。
- `test/agent-controller-lifecycle.test.ts` 新增 1 项：send_message 接纳后写入接收者 `parent_message` 条目（正文一致、状态保持 working）、未接纳不产生条目、完全相同正文不去重（entry_id 独立）。
- `test/canonical-activity.test.ts`（契约 `/5`）、`test/conversation-transport.test.ts`（协议 `/23`）版本断言更新。
- `npm run typecheck`、`npm run build:bridge`、定向测试与完整 `npm test`（379 项，374 通过，0 失败，5 项 Unix 平台用例在 Windows 跳过）全部通过；父子消息接纳与 `final_report` 会话语义无回归。

### 手工验收

- 真实 Pi TUI 中让父代理执行 `spawn_agent`（成功与模板不存在失败）：摘要行显示 name、template ID 与成功时的八位短 ID，失败整行红色带 `template_not_found` 等稳定错误码。发送 `send_message`（成功与目标不可用失败）：摘要显示目标名称与短 ID，Enter 展开完整尝试正文（Markdown 渲染），失败正文同样可查看；`normal_reply`/`final_report` 同构。在子代理详情中确认接纳后的输入显示为 `Parent message` 折叠条目、展开为顶格 Markdown，未送达的输入不出现；system prompt、模板正文与上下文文件内容全程不可见。
