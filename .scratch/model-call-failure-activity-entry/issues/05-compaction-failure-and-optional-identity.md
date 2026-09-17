# 05 — 采集压缩自身失败，并允许失败条目缺省模型身份

**What to build:** 把"压缩自身（summarization 调用）失败"也采集为模型调用失败条目：子代理运行时扩展新增 `session_compact_failed` 订阅，把它归一化为失败条目（`aborted` 为真记 `aborted`，否则记 `error`；文本缺失时用 `Unknown error` 兜底），该订阅只发生在产生端扩展，桥接/RPC 事件闭集保持不变。同时把失败条目的 `provider` / `model` 改为可缺失：缺身份时条目仍完整成立，折叠行不变（`× Error: <错误文本首行>`），展开体直接以错误文本原文开头，不显示身份行、不留空行、不写占位文案；身份在场时展开体行为与现状完全一致。压缩重试事件（`summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished`）与自动重试事件一样不采集。规范活动契约与监督协议版本**不再递增**：v0.5.1 发布的是 `activity/11` 与 `/29`，当前工作区的 `activity/12` 与 `/30` 尚未发布，本次扩展并入该版本。设计依据见同目录 `spec.md`，决策记录见 `docs/adr/0001-model-call-failure-activity-entry.md` 的「修订」段。

**Blocked by:** 01 — 失败文本贯通到面板折叠行（契约升版）; 02 — 展开失败条目查看 provider、模型与错误原文（均已 resolved）

**Status:** resolved

- [x] 压缩自身失败（`session_compact_failed` 带错误文本）在该子代理的活动面板产生一条 `× Error: <错误文本首行>` 条目，且该条目不携带 provider/model
- [x] 压缩自身失败被中止（`aborted` 为真）时产生同形条目，收尾原因如实记为 `aborted`
- [x] 压缩自身失败且无错误文本时，条目显示的文本为 `Unknown error`
- [x] provider/model 缺失的条目在展开体里不出现身份行，正文直接以错误原文开头，且逐字保留换行与前导空白
- [x] provider/model 在场的条目展开体首行仍为 `provider · model`，渲染与现状逐字一致
- [x] 身份缺失的条目通过规范活动契约的严格解析（canonical wire），在发布侧与接收侧都被接受，不产生无效帧、不使通道进入故障
- [x] 压缩重试事件（`summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished`）不产生任何条目，桥接/RPC 事件闭集未新增条目
- [x] 压缩自身失败条目不改变该子代理的生命周期状态，也不进入实时显示草稿投影
- [x] 既有三种条目与既有身份完整的失败条目的行为及渲染完全不变

## Comments

<!-- 评论与对话历史追加在此标题下 -->

## Answer

**交付性质**：本工单在产生端新增压缩自身失败的采集，并把失败条目的模型身份改为可缺失；不动父规格、兄弟工单与契约版本常量。

**实现**

- 产生端采集：`src/wj-pi-subagents-runtime.ts` 新增 `session_compact_failed` 订阅，经 `readOwnActivityEvents` 走既有产生端归一化路径；新增 `normalizeOwnCompactionFailure`（`src/rpc-bridge-event.ts`）把该事件归一为无身份的 `model_call_failure`：`aborted` 为真记 `aborted`，否则记 `error`；文本缺失用 Pi 兜底文案 `Unknown error`。订阅只发生在产生端扩展，`SafeRpcBridgeEvent` / 桥接 RPC 闭集与 `IGNORED_RPC_EVENT_TYPES` 均未新增条目。
- 身份可缺失：`SafeAgentActivityEvent` 的 `provider` / `model` 改为可选（同进同出）；`parseAgentActivityEvent`（宽容路径）与 `parseCanonicalAgentActivityEvent`（严格路径）同步接纳缺身份形状，单边身份、空串、超长仍违约；查看器 `DisplayEntry` 与展开体源同步可选，缺身份时展开体直接以错误原文开头。
- 未升版：`CANONICAL_ACTIVITY_CONTRACT_VERSION` 保持 `activity/12`、`SUPERVISOR_PROTOCOL_VERSION` 保持 `/30`（v0.5.1 发布的是 `/11` 与 `/29`，该版本尚未发布）。

**验收项与用例映射**（断言均为外部可观察行为）

1. 压缩自身失败成条且无身份：`test/descendant-activity-aggregation.test.ts`「压缩自身失败沿产生端订阅登记为无身份失败条目，压缩重试事件不产生任何条目」——脚本化 `session_compact_failed` 经真实监督通道上行，交付条目 body 仅含 `type`/`failure`/`message`，面板折叠行为 `▸ × Error: summarization request failed`。
2. 中止同形、文本缺失兜底：同上的 `aborted: true` 且无 `errorMessage` 分支 → `failure: "aborted"` + `Unknown error`；`test/rpc-bridge-event.test.ts`「压缩自身失败的产生端归一化」覆盖 error/aborted/净化/非本事件拒收。
3. 缺身份展开体：`test/agent-activity-viewer.test.ts`「缺身份的失败条目折叠行不变，展开体直接以错误原文开头且不留空行」——无身份行、无空行、无占位文案，逐字保留换行与前导空白。
4. 身份在场渲染不变：既有查看器用例（展开首行 `provider · model`、软折行、错误色）全部原样通过。
5. 严格解析两端接受：`test/canonical-activity.test.ts`「/12 canonical wire 接受缺身份的模型调用失败条目」；`test/agent-activity-supervisor.test.ts`「版本一致时监督通道在发布侧与接收侧都接受模型调用失败条目」扩展为身份完整与缺身份两条条目均上行成功、`onFault` 为空且 parent/child 通道 `ready`。
6. 压缩重试事件不采集：主接缝用例内 `summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished` / `auto_retry_start` 均不产生条目；`test/rpc-bridge-event.test.ts`「自动重试与压缩重试事件不在桥接闭集内，不产生任何条目」钉住桥接侧。
7. 生命周期与草稿不受影响：主接缝用例断言生命周期事件数不变且父通道 `onReply` 零事件；失败条目非 message，本就不进入草稿投影（04 号票用例继续覆盖）。

**验证**

- `npx tsc --noEmit` 无输出。
- `npm run check`（tsc + `npm test`）：546 个测试，541 通过 / 0 失败 / 5 跳过（既有跳过项不变）。

**两轴代码评审（固定点 `4a21d68`，与本工单提交共用同一 fixed point）**

- Standards 轴：无硬违规；无 `CONTEXT.md` 禁用词（“运行故障/失败状态”）。判断项已处理：删去严格 parser 里与通用 parser 重复的“同进同出”判定，合并同一段失效文档注释与行内注释，抽出 `failureMessageText` 消除兜底文案三处重复。未采纳项：provider/model 是否打包成专用类型（wire 形状已由规格定死，打包会牵连四层契约）、跨测试 harness 复制（沿用本仓库“每测试文件自带 harness”的既有风格）。
- Spec 轴：9/9 验收项均有可重复用例；一项范围蔓延已修复——首版连带放宽了桥接收尾消息的采集（身份双缺时也成条），超出工单把“缺身份”绑定在 `session_compact_failed` 的边界，现恢复 03 号票规则（收尾消息身份非法仍忽略）并补边界断言；另一项低置信度偏差（`aborted` 缺失被判违约）已按工单原句“`aborted` 为真记 `aborted`，否则记 `error`”改为非真即 `error`。

**范围与边界**

- 未改父规格、兄弟工单、契约版本常量与无关功能；未新增桥接/RPC 事件条目类型。
- 无身份失败条目的唯一来源是产生端 `session_compact_failed` 订阅；`compaction_end` 等 RPC 事件未被转成条目。
