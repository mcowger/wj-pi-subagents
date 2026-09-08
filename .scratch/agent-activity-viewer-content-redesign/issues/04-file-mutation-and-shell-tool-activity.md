# 04 — 文件修改与 Shell 工具轨迹

**What to build:** 为来源已确认的 Pi 原生 `write`、`edit`、`bash` 和 `powershell` 提供专用活动轨迹。用户能审计写入或修改的目标，并完整看到多行 Shell 命令，但写入正文、替换正文、diff、patch、写入/编辑统计和命令输出不会进入活动历史。

**Blocked by:** 02 — 工具活动状态机与安全兜底.

**Status:** resolved

- [x] `write` 成功摘要只显示 path，不显示根据输入计算的行数、UTF-8 字节大小或任何写入统计；content 和原始成功结果在产生端删除。
- [x] `write` 失败摘要只显示 path，不显示未发生写入的行数或大小；完整 Pi 原生错误默认折叠并可展开。
- [x] `edit` 成功摘要只显示 path，不显示 edits 数量或任何编辑统计；oldText、newText、diff、patch、首个修改行和原始成功结果在产生端删除。
- [x] `edit` 失败摘要只显示 path，不显示编辑块数；完整 Pi 原生错误默认折叠并可展开。
- [x] `write` 与 `edit` 的展开错误使用统一背景、顶格红色预格式化纯文本，不解析 Markdown、不做语义摘要或字符截断，并过滤 ANSI 与危险终端控制字符。
- [x] `bash` 与 `powershell` 状态摘要只显示工具名和可选 timeout；完整 command 始终在独立代码区域显示。
- [x] Shell command 使用统一工具正文背景，顶格、不折叠、不缩进、不做内容截断；单行与多行命令采用同一种结构，状态变化不重排命令区域。
- [x] Shell 工具结束后只表达成功或失败；stdout、stderr、退出码、超时正文、异常正文和其他结果文本均不进入规范条目，也没有结果展开入口。
- [x] Shell 取消按普通失败显示；失败摘要整行红色，但命令参数仍完整保留。
- [x] 四种专用规则只对来源验证通过的 Pi 原生实现生效；同名覆盖、未知来源或无效必需字段降级为安全兜底。
- [x] 产生端规范化测试证明写入正文、替换正文、diff/patch 与 Shell 输出没有跨进程；查看器测试覆盖成功/失败差异、错误展开、多行命令、timeout、状态原地更新和终端宽度。
- [x] 相关类型检查、桥接构建、定向测试和完整测试套件通过，文件操作本身的执行语义不发生变化。

## Answer

### 交付内容

- **专用摘要闭集与契约演进**（`src/rpc-bridge-event.ts`）：`SafePiToolSummary` 白名单闭集在 read/grep/find/ls 四分支外新增 `write`/`edit`（成功与失败摘要同形，只有 `path`；行数、UTF-8 字节大小、编辑块数等统计不进闭集）与 `bash`/`powershell`（`command` 必需 + 可选 `timeout`）四分支。原 `FILE_TOOL_SUMMARY_NAMES` 按语义拆分：`PI_TOOL_SUMMARY_NAMES`（八种专用工具）承担摘要携带资格，新增 `PI_TOOL_ERROR_TEXT_NAMES`（read/grep/find/ls/write/edit）承担错误正文携带资格——Shell 工具失败不携带任何结果或错误文本，`errorText` 出现在 shell 事件上即协议违约（wire 层拒绝）。这是原子正文不兼容变化，规范活动契约 `/3` → `/4`、监督协议 `/21` → `/22`；旧契约条目/帧按既有协议故障路径拒绝。wire 校验严格：键集合闭集（write/edit 仅 `tool`+`path`）、`timeout` 仅有限正数（与产生端一致）、bash/powershell 摘要缺失 `command` 或携带未知键（如 `stdout`）判 `invalid`。
- **产生端专用提取**（`extractPiToolSummary`）：延续工单 03 的有状态工厂（开始参数缓存、结束自包含、消费即删）：
  - `write`：`path` 与 `content` 均为 Pi schema 必需字段；`content` 只做形状验证（缺失或非 string 完整降级），正文、`Successfully wrote to …` 结果正文与任何写入统计永不进入摘要；成功与失败摘要同形 `{tool, path}`。
  - `edit`：`path` 与 `edits` 必需；`edits` 必须是元素为 `{oldText, newText}` 字符串对的数组（只做形状验证），oldText/newText、Pi `details` 中的 `diff`/`patch`/`firstChangedLine` 与结果正文全部丢弃；成功与失败摘要同形 `{tool, path}`。按工单 03 既定原则，Pi `prepareArguments` 的宽容形状（edits 为 JSON 字符串或单对象）不属原生 schema，完整降级为兜底——是展示降级，不是执行语义变化。
  - `bash`/`powershell`：`command` 必需且在产生端经 `sanitizeSafeActivityText` 净化（ANSI/危险控制字符过滤、`\r\n` 归一、保留多行），成功与失败摘要同形；`timeout` 仅有限正数才携带（Pi 的 timeout 单位为秒），值域偏离只导致字段不携带不降级。stdout、stderr、退出码、`Command exited with code N`/超时/`Command aborted` 正文、truncation 详情与临时输出路径永不进入规范条目；降级规则与必需字段矩阵覆盖 write/edit/bash/powershell。
- **查看器专用渲染**（`src/agent-activity-viewer.ts`）：`summaryFragments` 新增四分支——write/edit 摘要 `write · {path}` / `edit · {path}`（成功与失败同形，路径沿用中间省略）；shell 摘要 `bash · timeout N`（无 path，`timeout` 缺省时不出现）。`renderShellCommandBody` 在摘要行正下方渲染完整 command 独立代码区：统一工具正文背景（面板整行背景）、顶格无缩进、始终显示不折叠（无折叠标记、无展开键、不参与选择循环）、按面板宽度软换行不截断字符，单行与多行命令同构；状态变化只更新摘要行，命令区域内容与相对位置不重排。write/edit 失败沿用工单 03 的错误展开路径：折叠标记 `▸`/`▾`、可展开键 `tool-error:{entryId}`、展开后顶格红色预格式化纯文本（软换行不丢字符、不解析 Markdown、双层净化）。Shell 失败/取消整行红色但命令区完整保留，无任何结果展开入口。
- **Code review 落实**：合并 viewer 与 wire 层重复的 write/edit case 为共享 `PATH_ONLY_SUMMARY_KEYS` 单一分支；wire 层 shell `timeout` 校验收紧为有限正数与产生端一致。Standards 审查无硬违规；Spec 审查确认 12 项验收无缺失、无实质 scope creep。
- **边界说明**：文件操作执行语义未变化（本工单只做产生端规范化与查看器投影）；插件工具（工单 05/06）与实时草稿（工单 07）、容量限制（工单 08）不在本工单范围。八位短 ID、淘汰提示等均与工单 02/03 相同沿用。

### 测试

- `test/canonical-activity-normalization.test.ts` 新增 11 项：write 开始事实只保留 path 且正文/未来字段不跨进程、write 成功与失败摘要同形（统计不进闭集、错误正文可携带）、edit 成功与失败摘要同形（oldText/newText/diff/patch/firstChangedLine 不跨进程）、bash/powershell 摘要保留 command 与非默认 timeout 且 stdout/退出码/超时正文/异常正文/truncation/临时路径不跨进程、timeout 值域偏离只不携带、命令正文产生端净化保留多行、四工具必需字段缺失/类型错误降级矩阵、同名覆盖降级且错误正文随降级丢弃、结束缺开始参数降级、wire 闭集矩阵（shell 带 errorText 拒绝、write/edit 带 errorText 合法、缺 command/未知键/统计键/plugin 来源拒绝）。
- `test/agent-activity-viewer.test.ts` 新增 9 项：write 运行中/成功摘要都只显示 path（无统计、无折叠标记）、edit 成功同构、write/edit 失败摘要+展开错误（顶格红色、保留换行、Markdown 字面、ANSI 过滤）、bash 状态摘要与命令区分离且结束原地更新不重排命令区、多行命令完整显示与单行同构（顶格、无折叠标记）、bash 失败整行红色命令保留且无结果展开入口、命令软换行不截断字符（150 字符 @60 宽全保留）、未知来源 bash 兜底无命令区、命令控制字符渲染不可见。
- `test/canonical-activity.test.ts`（契约 `/4`）、`test/conversation-transport.test.ts`（协议 `/22`）版本断言更新。
- `npm run typecheck`、`npm run build:bridge`、定向测试（134 项）与完整 `npm test`（366 项，361 通过，0 失败，5 项 Unix 平台用例在 Windows 跳过）全部通过；read/grep/find/ls、未知工具与安全兜底行为无回归。

### 手工验收

- 真实 Pi TUI 中让子代理执行 `write`（新建与覆盖）、`edit`（成功与 oldText 不匹配失败）：每类调用一行摘要且成功/失败都只有 path，失败可 Enter 展开完整原始错误（红色纯文本、换行保留、按宽度软换行）；写入正文与 diff 不可见。执行 `bash`/`powershell` 单行与多行命令（含 timeout、非零退出码、取消）：状态行只显示工具名与可选 timeout，命令区完整显示且状态变化不重排；stdout/stderr/退出码不可见、无结果展开入口。三层树整体手工验收与后续工单共享，详见 spec Testing Decisions。
