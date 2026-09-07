# 01 — 子代理活动流数据弹道（收集 → 缓存贯通）

**What to build:** 为子代理实时活动查看器打通数据弹道：直接子代理的会话活动——assistant 消息正文（含 thinking 块）与工具执行事件（名称、参数与结果摘要）——从子代理进程经桥接事件闭集加宽、监督通道新增的活动流事件、父端分发，最终落入新的活动流缓存。本片无 UI，交付后用户尚看不到界面，但"事件从子代理会话流到父端缓存"的整条链路已可验证。设计依据见同目录 `spec.md`。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 桥接事件闭集加宽：新增携带正文的消息事件与带参数/结果摘要的工具执行事件；规范化语义与现有一致（未知事件忽略、结构违约返回 invalid 由桥接进程关闭传输、正文设字节上限、超限按既有 reply_too_large 惯例拒绝该事件而非中断会话）；规范化矩阵有纯模型测试
- [x] 监督通道新增活动流事件类型，遵循既有会话事件提交语义（每次提交独立、不承诺跨事件顺序、不建立传输确认或控制屏障）；事件校验与父端分发有测试
- [x] 活动流缓存：按 agent_id 追加、按 agent_id 全量回放读取、变更通知 + 修订号；并行多代理缓存相互隔离；子代理终止后仍可回放；纯内存、无上限累积、不落盘
- [x] 手工验收（链路级）：真实桥接进程端到端集成测试确认活动事件闭集从子代理进程到达父端并按到达序累积；真实模型端到端的执行步骤见 Answer（需在父会话中执行，当前执行环境无运行中的父端运行时）
- [x] 既有测试全绿，活动流上行对现有 reply、活动阶段、控制消息零回归

## Answer

### 交付内容

1. **桥接事件闭集加宽**（`src/rpc-bridge-event.ts`）
   - 新增 `message` 活动事件（assistant 正文：`text` + `thinking` 块；`toolCall`/`image` 块跳过，未知块类型 invalid）；由 Pi `message_end`（assistant role）规范化产生，非 assistant 的 `message_end` 仍忽略。
   - `tool_execution_start` 加宽携带 `args` JSON 摘要，`tool_execution_end` 加宽携带 `result` JSON 摘要与 `isError`；缺省字段保持缺省（旧事件形状不变）。
   - 新增共享闭集校验器 `parseAgentActivityEvent`：合法/未知 invalid/超限 `rejected(reply_too_large)`。
   - 预算常量 `ACTIVITY_MAX_TEXT_BYTES = 16 KiB`，按 **JSON 转义后 UTF-8 字节**计（含引号），保证单条活动事件无论内容都能放进 64 KiB 桥接帧与监督帧预算；正文超限返回 `rejected`（拒绝该事件，会话不中断），结构违约返回 `invalid`（桥接进程关闭传输），未知事件忽略——与既有语义一致。
   - 父端事件防线 `isSafeBridgeEvent`（`src/managed-rpc-node.ts`）同步加宽，按转义前 UTF-8 上限粗校验。

2. **监督通道活动流事件**（`src/supervisor-channel.ts`）
   - 帧闭集新增 `activity` kind；child 经 `publishActivity({agent_id?, event})` 上行，每次提交独立、无确认、无屏障、不承诺跨事件顺序。
   - `agent_id` 可为自身或子树内后代（供递归汇聚）；不在作用域内 → `identity_mismatch`；载荷违约 → 协议故障；正文超预算 → 发布端拒绝（返回 undefined 不建帧），父端收到超限帧时忽略该帧不分发、不中断会话。
   - 传输适配层（`StreamSupervisorChannel` / `ManagedRpcSupervisorChannel`）新增 `onActivity` 观察者与 `publishActivity`；`RpcSupervisor` 订阅后以新增 `activity_stream` 监督事件分发（携带事件所属 `agent_id`）。

3. **活动流缓存**（新模块 `src/agent-activity-cache.ts`）
   - 按 agent_id 追加、全量回放（按到达序）、每代理修订号、变更通知（回调携带 agentId，可退订）；并行多代理按分组键隔离；代理终止后仍可回放；纯内存、无上限累积、不落盘；非法身份与违约事件静默拒绝。

4. **父端分发与上行接线**
   - 桥接活动事件经 `RpcSupervisor.receiveRpcEvent` 以 `activity_stream` 分发 → `AgentController` 写入缓存；后代活动事件（监督通道转发）按其真实身份归档。
   - `AgentController` 新增 `getActivityReplay` / `getActivityRevision` / `onActivityChange`；子模式运行时通过 `publishUpstreamActivity` seam 把活动流沿唯一祖先方向转发上行（fire-and-forget），供递归汇聚工单（04）复用；本片不涉及扩展实例自身事件收集端与多层汇聚测试。

### 验证

- 规范化矩阵纯模型测试（`test/rpc-bridge-event.test.ts`，13 项）与活动事件闭集校验器测试。
- 真实桥接进程端到端（`test/agent-activity-bridge.test.ts`）：spawn 真实 `rpc-bridge-process.ts` + 可脚本 Pi 替身，验证加宽闭集事件按到达序到达父端、超限事件被拒绝且桥接不断、结构违约关闭传输。
- 监督通道协议测试（`test/agent-activity-channel.test.ts`，6 项）：帧校验、身份作用域、超限拒绝、屏障丢弃、字节流适配层分发。
- 监督器与控制器接线测试（`test/agent-activity-supervisor.test.ts`、`test/agent-activity-controller.test.ts`）：`activity_stream` 分发、既有活动阶段与工具配对零回归、缓存累积与上行转发、终止后回放。
- 活动缓存纯模型测试（`test/agent-activity-cache.test.ts`，6 项）。
- 全量回归：236 项测试全部通过（231 pass / 0 fail / 5 skipped 为既有跳过），`tsc --noEmit` 通过。

### 真实模型端到端验收步骤（供父会话执行）

在父 Pi 会话（加载本扩展）中：1) spawn 一个真实子代理并派发一个会产生工具调用与文本回复的任务；2) 在父端通过控制器观察接缝（`getActivityReplay(agentId)` / `onActivityChange`）确认活动事件按到达序累积，包含 `message` 正文事件与带 `args`/`result` 摘要的工具事件。链路各级（桥接规范化 → 父端事件防线 → 监督器分发 → 缓存累积）已由集成测试覆盖，此步骤仅验证真实模型会话下的事件流形态。
