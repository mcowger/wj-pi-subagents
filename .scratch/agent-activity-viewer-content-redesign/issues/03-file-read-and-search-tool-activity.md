# 03 — 文件读取与检索工具轨迹

**What to build:** 为来源已确认的 Pi 原生 `read`、`grep`、`find` 和 `ls` 提供专用活动轨迹。用户能看出子代理查询了什么、范围如何、结果是否为空或不完整，但文件正文、图片、匹配内容、命中路径列表和目录条目在产生端就被删除；失败诊断可按需完整展开。

**Blocked by:** 02 — 工具活动状态机与安全兜底.

**Status:** resolved

- [x] `read` 摘要显示 path、可选 offset、limit，以及成功结果中的截断或不完整事实；文本正文、图片结果和原始成功结果不进入规范条目。
- [x] `grep` 摘要显示 pattern、path，以及全部非默认 glob、ignoreCase、literal、context 和 limit；未提供 path 时明确显示 `.`。
- [x] `grep` 成功结果只保留 no matches、limit reached、truncated 和长行截断等事实，不保留匹配正文。
- [x] `find` 摘要显示 pattern、path 和非默认 limit；未提供 path 时显示 `.`，成功结果只保留 no files、limit reached 和 truncated 等事实，不保留命中路径列表。
- [x] `ls` 摘要显示 path 和非默认 limit；未提供 path 时显示 `.`，成功结果只保留 empty directory、limit reached 和 truncated 等事实，不保留目录条目。
- [x] `read`、`grep`、`find`、`ls` 失败时仍显示与成功调用相同的全部输入参数，但不附加成功结果侧统计。
- [x] 四种工具的完整 Pi 原生错误默认折叠；摘要显示错误状态和折叠标记，展开后使用统一背景、顶格红色预格式化纯文本，保留换行与可读空白且不解析 Markdown。
- [x] 原生错误正文不做语义摘要或字符截断，只按面板宽度软换行并过滤 ANSI 与危险终端控制字符。
- [x] 专用规则只对来源验证通过的 Pi 原生实现生效；同名覆盖、未知来源、缺少必需字段或字段类型错误时完整降级为安全兜底。
- [x] 普通摘要保持单行；长路径使用中间省略，其余超宽字段从右侧省略，不产生额外可展开原始参数。
- [x] 产生端规范化测试逐项证明文件正文、图片、匹配正文、路径列表和目录条目没有跨进程；查看器测试覆盖运行中、成功、空结果、不完整结果、失败、展开错误与窄宽度。
- [x] 相关类型检查、桥接构建、定向测试和完整测试套件通过，其他 Pi 工具与未知工具仍保持既有安全兜底。

## Answer

### 交付内容

- **专用摘要闭集与契约演进**（`src/rpc-bridge-event.ts`）：`SafeAgentActivityEvent` 的工具事件新增可选 `summary`（`SafePiToolSummary`，read/grep/find/ls 四分支白名单闭集）与 `errorText`（失败事实的完整原始错误正文）。这是原子正文不兼容变化，规范活动契约 `/2` → `/3`、监督协议 `/20` → `/21`；旧契约条目/帧按既有协议故障路径拒绝。wire 闭集校验严格：`summary`/`errorText` 只允许 `origin === "pi_native"` 且工具名在 `FILE_TOOL_SUMMARY_NAMES` 闭集内的事件携带，`summary.tool` 必须与 `toolName` 一致，键集合与字段类型严格闭合，违约判 `invalid`（协议故障），不在接收端静默降级。
- **产生端专用提取**（`normalizeOwnToolActivityEvent` 第三参数 + `createOwnToolActivityNormalizer` 工厂）：Pi 的 `tool_execution_end` 事件不携带 args，工厂按工具活动 ID 缓存开始事件的参数（有界 256，溢出淘汰最早待决；重复开始覆盖；结束消费后即删），使结束事实自包含输入参数——工单 02 的"结束事实自包含摘要"在专用规则下继续成立。提取规则：
  - **输入参数白名单**：`read` path（必需）/offset/limit；`grep` pattern（必需）/path/glob/ignoreCase/literal/context/limit；`find` pattern（必需）/path/limit；`ls` path/limit。非默认值才携带（grep 默认 limit 100、find 1000、ls 500 分别对照 Pi 源码常量；`ignoreCase:false`、`literal:false`、`context:0` 等默认语义不进入摘要）；grep/find/ls 未提供 path 时按 Pi 语义明确为 `.`。
  - **成功结果事实**：`read` 的 `truncated`/`truncatedBy`("lines"|"bytes")/`firstLineExceedsLimit`；`grep` 的 `noMatches`/`matchLimitReached`/`truncated`/`truncatedBy`/`linesTruncated`；`find` 的 `noFiles`/`resultLimitReached`/`truncated`；`ls` 的 `emptyDirectory`/`entryLimitReached`/`truncated`。空结果（`No matches found`、`No files found matching pattern`、`(empty directory)`）与 read 的"用户 limit 提前停止但文件尚有更多行"（Pi 在该场景不写 details，事实只在结果正文尾部已知 continuation 文案中）按已知 Pi 输出文案在产生端识别为布尔事实，正文本身永不跨进程。details 中的 `TruncationResult` 整体（含 `content` 字段）被丢弃，只提取布尔事实。
  - **失败事实**：保留全部输入参数（无成功侧统计），`errorText` 取 `result.content` 全部 text 块连接后经 `sanitizeSafeActivityText` 净化（过滤 ANSI 与危险终端控制字符，保留换行与可读空白）的完整正文，不做语义摘要或字符截断。
  - **降级规则**：必需字段缺失、任何已知字段存在但类型错误（调用形状不符合 Pi 原生 schema 即不可信）、开始参数未缓存或来源非 `pi_native`（同名覆盖、unknown、宿主查询失败）→ 完整降级为无载荷安全兜底条目，错误正文随摘要一并降级——保证"专用条目"与"安全兜底"形状互斥，避免出现携带部分错误正文但无输入参数的混合降级形态。原始参数中的未来新增字段宽容忽略，永不跨进程。
- **查看器专用渲染**（`src/agent-activity-viewer.ts`）：`ToolDisplayEntry` 携带 `summary`/`errorText`/`entryId`；结束事实按既有身份三元组匹配原地覆盖摘要与错误正文。摘要行行首顺序固定"状态图标、折叠标记、摘要"，格式 `read · {path} · offset n · limit n · truncated (lines|bytes|first line) · more lines`、`grep · /{pattern}/ · {path} · glob g · ignoreCase · literal · context n · limit n · no matches · n matches limit · truncated · lines truncated`、`find`/`ls` 同构。**路径中间省略**（`truncateMiddleToDisplayWidth`：保留两端、单省略号、字素簇边界切分；预算扣除行首图标/折叠标记与行尾收束事实宽度，避免二次右侧截断），其余超宽字段依赖整行右侧省略兜底；成功与空结果摘要不可展开、不参与选择循环。**失败错误展开**：折叠标记 `▸`/`▾`，可展开键 `tool-error:{entryId}` 参与 Tab/Shift+Tab 循环，展开后经 `renderToolErrorBody` 以顶格红色预格式化纯文本渲染（`wrapPlainText` 按面板宽度软换行，保留换行与可读空白，不解析 Markdown、无逐行前缀；整行背景与其他工具附属正文一致）。状态色沿用工单 02 四档（运行中强调/成功中性/警告/失败整行红）。
- **净化共享**（`sanitizeSafeActivityText`）：ANSI 与危险终端控制字符过滤从查看器私有实现提升为产生端与查看器共用同一规则（`\r\n` 归一、`\t`→两空格、ANSI 序列删除、危险控制字符替换为空格），查看器 `sanitizeViewerMarkup` 改为薄委托，行为与既有一致。
- **边界说明**：`write`/`edit`/`bash`/`powershell`（工单 04）与本插件工具（工单 05/06）的专用规则未在本工单实现，它们仍走安全兜底（测试明确断言）。跨 reload 时 normalizer 的待决参数缓存按 toolCallId 关联——Pi 的 toolCallId 全局唯一生成且缓存有界淘汰，旧实例残留关联为极低概率显示性风险，不影响生命周期或协议正确性。

### 测试

- `test/canonical-activity-normalization.test.ts` 新增 13 项：read 白名单参数与未来字段忽略、成功截断事实（正文与 details content 不跨进程）、图片数据不进入事件、失败输入参数+净化 errorText（无成功侧统计）、grep 非默认参数与 `.` 默认路径、grep 四类结果事实、find/ls 同构、四工具失败矩阵、错误正文净化保留换行、必需字段缺失/类型错误完整降级、known-field 类型错误降级、同名覆盖降级、结束缺开始参数降级、运行时规范化器缓存语义（自包含合并、消费即删、重复开始覆盖、256 容量淘汰）、闭集违约矩阵（unknown 带 summary、tool 不一致、缺必需字段、成功事件带 errorText、插件工具带 errorText）。
- `test/agent-activity-viewer.test.ts` 新增 11 项：read 运行中/结束原地补事实且单行、首行超限/字节截断/图片/不完整事实文本、grep 全参数与 `.`、grep 结果事实、find/ls 空结果与限制事实、失败摘要+折叠标记+展开错误（红色预格式化、保留换行、Markdown 字面、软换行不丢字符、ANSI 过滤）、结束先到自包含摘要+收束条目不可展开、长路径宽视口完整两端/窄视口中间省略不溢出、超长 pattern 右侧省略、兜底不变、成功专用工具无展开入口。
- `test/canonical-activity.test.ts`（契约 /3）、`test/conversation-transport.test.ts`（协议 /21）版本断言更新。
- `npm run typecheck`、`npm run build:bridge`、定向测试与完整 `npm test`（347 项，342 通过，0 失败，5 项 Unix 平台用例在 Windows 跳过）全部通过；其他 Pi 工具（write/edit/bash/powershell）与未知工具仍走安全兜底。

### 手工验收

- 真实 Pi TUI 中让子代理执行 `read`（含 offset/limit 大文件）、`grep`（含 glob/ignoreCase/literal/context/limit、无匹配、达到 limit）、`find`/`ls`（含默认路径、空目录、超限）：详情中每类调用一行摘要，路径超宽时中间省略、两端可辨；无匹配/达到限制/截断/长行截断以事实后缀显示；文件正文、匹配行、命中路径、目录条目不可见。失败调用（不存在路径、offset 越界）整行红色并带折叠标记，Enter 展开完整原始错误（红色纯文本、换行保留、按宽度软换行）。三层树整体手工验收与后续工单共享，详见 spec Testing Decisions。
