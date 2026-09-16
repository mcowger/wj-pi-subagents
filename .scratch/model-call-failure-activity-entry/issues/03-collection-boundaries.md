# 03 — 采集面边界：中止、兜底文案、半句输出、压缩失败与忽略项

**What to build:** 把"什么算一次模型调用失败"在链路上补全，使面板的留痕与事实一致：已中止的收尾与错误同形留痕；错误文本缺失时显示兜底文案 `Unknown error`；正文非空的失败消息同时产生正文条目与失败条目；带错误文本的压缩失败产生失败条目；而静默上下文溢出与自动重试事件仍被忽略（桥接事件闭集不扩大）。同一回合的多次失败各自成条，重试后被救回的尝试同样留痕。设计依据见同目录 `spec.md`。

**Blocked by:** 01 — 失败文本贯通到面板折叠行（契约升版）

**Status:** resolved

- [x] 收尾原因为已中止的收尾消息产生与错误完全同形的条目（同图标、同文案前缀、同样式）
- [x] 错误文本缺失时条目显示的文本为 `Unknown error`
- [x] 正文非空的失败消息同时产生一条正文条目与一条失败条目，两者身份独立
- [x] 带错误文本的压缩失败产生模型调用失败条目（采集点为 Pi 先持久化的收尾 assistant 消息，见 Answer「采集面与压缩边界」）
- [x] 无错误文本的静默上下文溢出不产生任何条目，也不自造文案
- [x] 自动重试相关事件仍被忽略，桥接事件闭集未扩大
- [x] 同一回合的多次失败各自成条，且在面板中的顺序为到达顺序
- [x] 重试后最终成功的回合里，此前失败的尝试仍留在面板上

## Comments

<!-- 评论与对话历史追加在此标题下 -->

## Answer

**实现位置**

- 采集（`src/rpc-bridge-event.ts` 的 `normalizeActivityModelCallFailure`）：收尾原因由「仅 error」扩为 `error | aborted`，同形登记、原因如实保留；`errorMessage` 缺失/空/非字符串时使用 Pi 自身兜底文案 `Unknown error`（新增模块常量 `UNKNOWN_ERROR_TEXT`）；provider/model 仍须为合法短引用，否则忽略而不升级为会话违约。
- 双条目（同文件 `message_end` 分支）：正文非空且带失败事实时返回新增的 `{ kind: "events", events }` 归一结果，按「先正文、后失败」输出两条独立活动事件；归一器仍保持无副作用的纯函数。
- 消费端：`src/rpc-bridge-process.ts` 对 `kind: "events"` 逐条成帧；`src/wj-pi-subagents-runtime.ts` 的 `readOwnActivityEvents` 逐条 `recordOwnActivity`，实时显示流引用只关联 message（控制器对非 message 条目本就忽略该引用）。
- 契约、缓存、查看器、通道、版本常量与本轮无关：即 01 号票已定死的四字段与闭集校验原样复用；`aborted` 与 `error` 在查看器投影中本就走同一 `FAILURE_VISUAL` 与同一文案前缀。

**采集面与压缩边界（评审发现的解读点，已按规格研究结论收束）**

- 规格 `spec.md` 的「Further Notes / 调研依据」明确：Pi 把模型调用失败编码在收尾 assistant 消息的收尾原因与错误文本上，而不是独立事件；采集面亦为「失败事实就在收尾 assistant 消息上…不新增 Pi 事件订阅点」。因此本工单不新增 `session_compact_failed` 这类扩展事件订阅点（规格明确「不新增 Pi 事件订阅点」）；`compaction_end` 本就在桥接闭集内，真正的阻碍是它（及 `session_compact_failed`）都不携带 provider/model——四字段契约无法在不自造身份的前提下表示压缩自身失败。既有的桥接/RPC 副本 `model_call_failure` 按既有设计也不进入父端缓存（`rpc-supervisor` 只认 child 扩展沿监督通道上行的条目），故沿该载体新增采集也无法到达面板。
- 上下文超限属于「模型调用失败在前、压缩重试在后」：Pi 先把超限失败的收尾 assistant 消息（含 provider/model 与 errorMessage）持久化到 `message_end`，随后才进入压缩（`agent-session.js` 的 `_checkCompaction` 注释「The overflow response was persisted on message_end before _checkCompaction() removed it」）。因此「带错误文本的压缩失败」在有错误文本时由上述采集点成条，provider/model 也随该消息拿到；**无错误文本的静默溢出**（长度收尾且零输出）不登记、不自造文案。
- 已知未覆盖与保留意见：压缩**自身**（summarization 调用）失败时 Pi 只在 `compaction_end.errorMessage` / `session_compact_failed.errorMessage` 上给合成文案，而这两个载体都不携带 provider/model，四字段契约无法在不自造身份的前提下表示它；本轮按上述规格边界不采集，也不改父规格。验收用例 6 的「上下文超限的压缩失败」指先于压缩持久化的超限失败（已覆盖），summarization 自身失败未被验收用例列举。两轮 Spec 轴评审均指出该边界未闭环；若维护者要求采集，需先改父规格（补 Out of Scope 或扩契约），本工单不自作决定。姊妹票 04 的不变量验收不受影响。
- 两轴代码评审（两轮）：第一轮 Standards 轴提的三项已修（`isOwnActivityBody` 谓词上移到 `rpc-bridge-event.ts` 共享、去掉多余的 displayStream 三元、去掉 `UNKNOWN_ERROR_TEXT` 无消费者的 `export`）；第二轮 Standards 轴无硬违规，仅剩低置信判断题（字段名 `failure` 实际承载收尾原因，属 01 号票定死的公开契约；`kind:"events"` 数组与 `AssistantMessageEndNormalization` 别名偏宽；两处分发点同步维护），均不具可执行的更优改法或属既有契约，本轮不改。Spec 轴的压缩解读即上述「采集面与压缩边界」，按规格研究结论收束，不扩范围。

**验证**

- `npx tsc --noEmit` 无输出；`npm test`：536 个测试，531 通过 / 0 失败 / 5 跳过。
- 新增/改写用例：`test/rpc-bridge-event.test.ts`（中止同形、`Unknown error` 兜底、正文+失败两条、上下文超限与静默溢出、`auto_retry_*` 忽略、provider/model 非法忽略）；`test/agent-activity-bridge.test.ts`（真实桥接进程按到达序转发四条事件且通道无故障）；`test/descendant-activity-aggregation.test.ts`（一次回合内：中止、半句+失败、静默溢出、auto_retry、二次失败、最终成功→共六条，身份互异，面板按到达序呈现四条错误行）；`test/agent-activity-viewer.test.ts`（已中止与错误收尾条目的主题化渲染逐字相同）。

**修改面**

- `src/rpc-bridge-event.ts`、`src/rpc-bridge-process.ts`、`src/wj-pi-subagents-runtime.ts` 与四个对应测试文件；未触碰父规格、兄弟工单、契约版本常量、生命周期语义与无关功能。
