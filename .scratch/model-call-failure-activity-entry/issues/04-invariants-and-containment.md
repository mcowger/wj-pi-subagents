# 04 — 不变量验收：活动链路故障不得拖垮子代理

**What to build:** 用可重复的用例钉住本特性的边界，特别是"版本正确时活动链路不得导致子代理故障"这条硬约束：版本一致时，活动/显示链路上的构造、转发或校验失败都必须被吞掉（表现为面板数据静默缺失），不得把子代理判为失败，也不得使通道因合法条目进入故障。同时钉住失败条目的语义边界——它是活动事实，不改变生命周期、不建立控制屏障、不进入实时显示草稿、不产生任何发往父代理的消息；旧版本条目仍按不兼容处理。设计依据见同目录 `spec.md`。

**Blocked by:** 02 — 展开失败条目查看 provider、模型与错误原文; 03 — 采集面边界：中止、兜底文案、半句输出、压缩失败与忽略项

**Status:** resolved

- [x] 版本一致时，活动/显示链路的转发异常被吞掉：不沿事件回调传播，且该子代理不进入失败状态
- [x] 版本一致、条目合法时，收发两侧都不会因活动帧进入通道故障
- [x] 模型调用失败条目不进入实时显示草稿投影
- [x] 模型调用失败条目不产生任何发往父代理的消息、报告或回复事件
- [x] 模型调用失败条目不触发生命周期状态转换，也不建立或升级控制屏障
- [x] 契约版本递增后，旧版本活动条目在发布侧被拒绝、在接收侧按不兼容处理
- [x] 失败条目在活动窗口裁剪与序号分配上与既有条目同等待遇

## Comments

<!-- 评论与对话历史追加在此标题下 -->

## Answer

**交付性质**：本工单只新增可重复的不变量验收用例，不改生产代码。01/02/03 号票已实现“产生端采集 → 契约 → 通道 → 缓存 → 查看器”全链；本票把 spec「Testing Decisions」中属于 9/10/11/12 的验收边界与工单 7 条验收项在既有接缝上钉死。用例全部通过，未发现需要修实现的缺口。

**验收项与用例映射**（断言均为外部可观察行为）

1. 转发异常被吞掉且不判为失败：`test/agent-activity-controller.test.ts`「版本一致时活动链路转发异常只表现为面板数据缺失，不把子代理判为失败」——注入缓存/上行转发/草稿三个分支的抛错后 `emitActivityDelivery`（失败条目）与 `emitActivityDisplay` 不抛错，面板历史与草稿静默为空，但 `tree.getStatus` 仍为 `working`；与既有「活动流转发异常被屏障吞掉」用例同向互补。
2. 收发两侧不因合法活动帧故障：`test/agent-activity-supervisor.test.ts`「版本一致时监督通道在发布侧与接收侧都接受模型调用失败条目」补强为 `onFault` 为空且 parent/child 通道 `getPublicState().state === "ready"`。
3. 失败条目不进入实时显示草稿投影：`test/agent-activity-controller.test.ts`「模型调用失败条目不进入实时显示草稿投影」——失败条目到达不清掉同代理已有草稿、不新增草稿；产生端即使把当前 `displayStream` 一并传入，`recordOwnActivity` 仍只上行活动条目、不产生任何 display 帧（`agent-controller.ts` 对非 message 条目忽略流引用）。
4. 不产生发往父代理的消息/报告/回复：`test/agent-activity-controller.test.ts`「模型调用失败条目不产生任何发往父代理的消息、报告或回复事件」——两次失败尝试照常入缓存，`onReply` 观察者零事件（并以真实 reply 事件作正对照）；主接缝 `test/descendant-activity-aggregation.test.ts` 的贯通用例额外断言父通道 `onReply` 全程零事件。
5. 不触发生命周期转换、不建立/升级控制屏障：`test/agent-activity-controller.test.ts`「模型调用失败条目不触发生命周期状态转换，也不建立或升级控制屏障」——失败条目后生命周期代际与 `working` 状态不变、`getTerminationBarrier` 不存在，随后 `sendMessage` 与 `interruptAgent` 仍按既有语义被接受。
6. 旧版本条目发布侧拒绝、接收侧不兼容：`test/agent-activity-channel.test.ts`「旧版本模型调用失败条目在发布侧被拒绝，在接收侧按不兼容处理」——`activity/11` 失败条目在 `publishActivity` 抛 `invalid_frame`（发布端仍 ready）；把该条目塞回真实活动帧交给 `parent.receive` 得到 `protocol_fault`（`error === "invalid_frame"`）且接收端进入 `faulted`。
7. 窗口裁剪与序号分配同等对待：既有 `test/agent-activity-cache.test.ts`「模型调用失败条目在窗口裁剪与墓碑裁决上与既有条目同等待遇」（101 条裁剪、墓碑吸收）覆盖窗口；新增「模型调用失败条目在修订号与回放序号分配上与既有条目同等待遇」覆盖修订号按到达序逐条分配、幂等重复不占序号、回放序列为到达序。

**验证**

- `npx tsc --noEmit` 无输出。
- `npm test`：542 个测试，537 通过 / 0 失败 / 5 跳过（既有 5 个跳过用例不变）。
- 受影响套件单跑：65/72 条相关用例全绿（controller/cache/channel/supervisor + 贯通用例）。

**两轴代码评审（固定点 70db8e1，与实施共用同一 fixed point）**

- Standards 轴：无硬违规；既有 `CONTEXT.md` 术语（活动事实而非生命周期失败）与 ADR-0001 决策一致。提出的判断题已处理：抽出 `breakActivityBranches(controller)` 消除同文件逐字重复的故障注入块，失败条目 body 改用 `modelCallFailureEntry(...).body` 消除同文件内联重复，注释明确“失败载荷四字段”。跨测试文件的 `modelCallFailureEntry` 工厂沿用本仓库既有“每个测试文件自带局部 builder”风格（如各文件的 `messageEntry`），未新增 TS 夹具文件。
- Spec 轴：7/7 验收项均有可重复且非同一反复的用例；无范围蔓延、无实现错误。提出的接收侧精度问题已处理（补断言 `error === "invalid_frame"`）；本票只新增测试属预期（测试工作全部落在既有接缝，未新增用例接缝）。

**范围与边界**

- 未改生产代码、父规格、契约版本常量、兄弟工单与无关功能。
- 规格已知边界（压缩 summarization 自身失败不采集）沿用 03 号票结论，不在本票内改动。

