# 02 — 展开失败条目查看 provider、模型与错误原文

**What to build:** 用户在活动面板的详情条目流里选中一条模型调用失败条目并按展开后，看到首行 `provider · model`、其后是**逐字保留换行**的错误文本原文；整段使用面板既有的红色预格式化正文样式，按面板宽度软折行，宽度变化时重新折行。折叠态维持一行标题，不新增"还有 N 行"之类提示，交互仍沿用既有的选中与展开机制。设计依据见同目录 `spec.md`。

**Blocked by:** 01 — 失败文本贯通到面板折叠行（契约升版）

**Status:** resolved

- [x] 展开体首行为 `provider · model`，其后为错误文本原文
- [x] 原文保留换行与前导空白，不被压成一行
- [x] 展开体按面板宽度软折行；面板宽度变化后按新宽度重新折行
- [x] 折叠态仍只有一行标题，不出现行数提示或额外说明文案
- [x] 展开/折叠沿用既有选中与展开交互，不新增任何操作入口（无重试、复制、跳转）
- [x] 展开体使用既有错误色预格式化正文样式，观感与工具失败的展开体一致

## Comments

<!-- 评论与对话历史追加在此标题下 -->

## Answer

**实现位置**（全部在 `src/agent-activity-viewer.ts`，无契约/桥接/通道改动）

- 展开身份：新增 `modelCallFailureKey(entryId)` → `model-call-failure:<entryId>`，并加入 `isExpandableKey` 前缀集；折叠行标题改由 `toolTitleLine` 携带 `key`/`expanded`，因此折叠态为 `▸ × Error: <错误文本首行>`，展开后为 `▾ × Error: …`；无任何新增按键或操作入口，选中/展开沿用既有 `Tab`/`Enter`/方向键与鼠标点击路径。
- 投影：`DisplayEntry` 的 `model_call_failure` 分支补齐 `provider`/`model`（01 号票只在权威正文里保留，查看器投影未消费）。
- 展开体：`modelCallFailureBodySource(provider, model, message)` 生成 `provider · model\n<错误原文>`（分隔符复用既有 `SUMMARY_SEPARATOR = " · "`），交给新增的 `guided-model-call-failure` 预格式化正文块；该块与 `guided-tool-error` 共用 `PlainTextBodyLayout`（软折行、保留换行与前导空白、逐行 `│ ` 引导线）与错误色，渲染按宽度重建并沿既有两级宽度缓存（`BODY_LAYOUT_WIDTH_CACHE_LIMIT`），宽度变化即重折行。折叠时只 `retainCached` 不产出正文行。
- 等价重构：`renderToolErrorBody` → `renderPreformattedErrorBody`（两个失败展开体共用同一渲染）；抽出 `isPreformattedBodyKind` / `cachedBodyStyle`，替换原先散在 `layout()` 里的 kind 判断，行为不变。

**验证**

- `npm test`：530 个测试，525 通过 / 0 失败 / 5 跳过；`npx tsc --noEmit` 无输出。
- 新增查看器用例（`test/agent-activity-viewer.test.ts`）：折叠行带 `▸` 且默认选中、`Enter` 展开 / 左方向键折叠；展开体首行 `provider · model`、其后逐字保留换行与前导空白、空白行仍占一行、`*literal*` 不被 Markdown 解析；40/160 两档宽度软折行且内容一致、每行不超宽；`renderAgentActivityViewerSurface` 断言展开正文为 `<fg:error>` 预格式化正文；与工具失败展开体逐行对照一致。
- 贯通用例（`test/descendant-activity-aggregation.test.ts`）：真实 `message_end` → 桥接归一化 → 监督通道 → 活动缓存 → 面板，断言折叠行与展开体四行文本，链路无故障帧。

**范围边界与已知行为**

- 两轴代码评审（Standards / Spec）结论：无阻塞项。
- Standards 轴提出的 "`Status` 使用 `claimed`" 不成立：`docs/agents/issue-tracker.md` 的 Wayfinder 约定明确 map 子票用 `Status: claimed`/`resolved`，与 triage 标签集是两套词表（01 号票同先例）。
- 同一轴提出的 `CachedBodyKind` 在三处枚举、`renderCachedBodyBlock` 中预格式化分支不可达：属既有结构（该 switch 需覆盖全部 kind 以满足穷尽性），沿既有模式新增一种，未扩大改动面。
- Spec 轴指出的折行边界：当某物理行本身带前导空白且宽于正文宽度时，`wrapPlainLine` 会在断点处吞掉该空白并可能多出一个空引导行。这是 `guided-tool-error` 早就共用的既有行为，spec 明示"按面板既有规则折行/复用既有渲染"，不在本工单内改动；未折行场景的前导空白与换行逐字保留已由用例钉住。
- 本轮未触碰：03 号票的边界（正文非空的失败消息、`aborted` 兜底文案、压缩失败归属等）、父规格、兄弟工单与无关功能。
