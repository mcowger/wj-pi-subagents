# 05 — 采集压缩自身失败，并允许失败条目缺省模型身份

**What to build:** 把"压缩自身（summarization 调用）失败"也采集为模型调用失败条目：子代理运行时扩展新增 `session_compact_failed` 订阅，把它归一化为失败条目（`aborted` 为真记 `aborted`，否则记 `error`；文本缺失时用 `Unknown error` 兜底），该订阅只发生在产生端扩展，桥接/RPC 事件闭集保持不变。同时把失败条目的 `provider` / `model` 改为可缺失：缺身份时条目仍完整成立，折叠行不变（`× Error: <错误文本首行>`），展开体直接以错误文本原文开头，不显示身份行、不留空行、不写占位文案；身份在场时展开体行为与现状完全一致。压缩重试事件（`summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished`）与自动重试事件一样不采集。规范活动契约与监督协议版本**不再递增**：v0.5.1 发布的是 `activity/11` 与 `/29`，当前工作区的 `activity/12` 与 `/30` 尚未发布，本次扩展并入该版本。设计依据见同目录 `spec.md`，决策记录见 `docs/adr/0001-model-call-failure-activity-entry.md` 的「修订」段。

**Blocked by:** 01 — 失败文本贯通到面板折叠行（契约升版）; 02 — 展开失败条目查看 provider、模型与错误原文（均已 resolved）

**Status:** ready-for-agent

- [ ] 压缩自身失败（`session_compact_failed` 带错误文本）在该子代理的活动面板产生一条 `× Error: <错误文本首行>` 条目，且该条目不携带 provider/model
- [ ] 压缩自身失败被中止（`aborted` 为真）时产生同形条目，收尾原因如实记为 `aborted`
- [ ] 压缩自身失败且无错误文本时，条目显示的文本为 `Unknown error`
- [ ] provider/model 缺失的条目在展开体里不出现身份行，正文直接以错误原文开头，且逐字保留换行与前导空白
- [ ] provider/model 在场的条目展开体首行仍为 `provider · model`，渲染与现状逐字一致
- [ ] 身份缺失的条目通过规范活动契约的严格解析（canonical wire），在发布侧与接收侧都被接受，不产生无效帧、不使通道进入故障
- [ ] 压缩重试事件（`summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished`）不产生任何条目，桥接/RPC 事件闭集未新增条目
- [ ] 压缩自身失败条目不改变该子代理的生命周期状态，也不进入实时显示草稿投影
- [ ] 既有三种条目与既有身份完整的失败条目的行为及渲染完全不变

## Comments

<!-- 评论与对话历史追加在此标题下 -->
