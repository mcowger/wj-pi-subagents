# 父代理入站消息对阻塞中 wait_agent 的唤醒

Status: resolved
Type: grilling
Blocked by: 01, 02, 04, 05, 07

## Question

A→B→C 场景下，B 已经阻塞在自己的 `wait_agent`（等待 C）时，A 向 B 发送一条消息。该消息经桥接层改写为 Pi 的 `prompt + streamingBehavior: "steer"` 进入 B 的会话队列，而 `wait_agent` 不返回则当前工具批次不结束，Pi 就不会投递这条 steering 消息，A 与 B 因此互等。子代理扩展当前完全无法观察“父代理消息已到达”这一事实，需要一个不引入替代性会话协调器、又不把父代理消息误当成子代理会话事件的唤醒机制。还需要决定：由谁观察、观察点必须满足什么约束、被唤醒的等待结果长什么样、它与会话事件闭集及生命周期快照的关系，以及哪些备选方向被否决。

## Answer

### 背景与互等因果

父代理 A 向 B 发送消息时，桥接层把逻辑 `steer` 改写为 Pi 的 `{ type: "prompt", message, streamingBehavior: "steer" }`。Pi 在流式期间把该消息放入 steering 队列，并只在“当前 assistant 回合执行完工具调用之后、下一次 LLM 调用之前”投递。B 用于等待 C 的 `wait_agent` 属于当前工具批次：只要它不返回，批次就不结束，Pi 也就不会取用队列里的消息；A 的 `send_message` 虽然已同步返回 `accepted: true`，B 却读不到这条消息。问题的根源是单向可见性：父代理消息的到达在**子端扩展**里当前完全不可观察，B 无法在消息入队时结束等待。

### 决议

- **(a) 观察点**：子代理扩展注册 `pi.on("input")`，handler 内只对 `source === "rpc" && streamingBehavior === "steer"` 的输入作出反应。这正是桥接层改写后的父代理入站消息形状；`source === "extension"` 的自身注入输入被该过滤条件排除，因此不会自触发。
- **(b) input handler 必须纯同步**：handler 内不做 `await`、不做 I/O、不返回 `handled` 或 `transform`、绝不抛错。Pi 在消息入队前 `await` 该 handler，且没有超时保护；handler 一旦卡住，入队调用就不返回，会连带拖住父代理的 `send_message`，把“唤醒”退化成新的互等。
- **(c) 唤醒所有活跃 waiter**：handler 唤醒当前全部活跃 waiter。每个 waiter **先投影已经就绪的真实事件**（`reply`、`final_report`、`idle`、`terminal` 或已经稳定的生命周期快照），只有确实没有真实结果时才返回 `woken`。真实事件优先，`woken` 只是兜底事实，不遮蔽、不覆盖已经到达的会话事件。
- **(d) 无 waiter 时是纯 no-op**：没有活跃 waiter 时不登记事件、不留痕、不抛错，父代理消息照常进入 Pi 的 steering 队列。
- **(e) 唤醒后本次等待立即结束**：返回 `woken` 即收束该次等待，不继续排队、不继续计时、不等待目标事件。
- **(f) 范围只做父→子**：只处理指向本会话的父代理入站消息；子→父方向不动。它与 C→B 的上行报告链路（`ParentReplyInbox` 那套 `reply`/`final_report` 登记与唤醒）互不干扰、不重复唤醒：上行链路仍只登记真实会话事件，父入站唤醒不登记任何事件，同一次等待只会由一个来源完成。

### 结果形状

```json
{"ok":true,"data":{"agent_ids":["<目标 id>","..."],"outcome":"woken","wake_reason":"parent_input"},"notice":"Released by an incoming message from the parent agent, not by any target event: the agents you are waiting for have not finished. The pending message will be delivered after this turn's tool calls finish; do not call wait_agent again in this turn."}
```

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `agent_ids` | `data` | 本次等待登记的全部目标 id；`woken` 以等待调用为单位释放，不指向任何单个目标。 |
| `outcome` | `data` | 固定 `"woken"`，表示本次等待由父代理入站消息释放。 |
| `wake_reason` | `data` | 固定 `"parent_input"`，说明释放来源；为将来其他等待层释放原因留出区分位。 |
| `notice` | 顶层 | 固定提示文本：释放来自父代理消息而非任何目标事件，目标尚未结束；待投递消息将在本回合工具调用结束后送达，本回合不要再次 `wait_agent`。 |

三条边界：

- `woken` **不携带** `state`、`revision`（也不携带 error 等生命周期字段）。
- `woken` **不进入会话事件闭集**；会话事件闭集仍是 `reply`、`final_report`、`idle`、`terminal`。`timeout` 与 `batch_released` 是等待层/工具层包装事实，`woken` 与它们同类。
- `notice` **只在 `woken` 时附加**，其它 outcome 不携带；`notice` 不含消息正文，也不含消息条数。

### 定位说明

`woken` 与 `timeout`、`batch_released` 同级，属于**等待层/工具层的释放事实**：它只说明“这次等待因父代理入站消息而结束”，不改变任何目标的 `state`，不参与“不可覆盖事件 / 至多一次 / 回合水位”机制，不产生新的会话事件，也不推进生命周期 revision。它是一次等待调用的收束原因，不是子代理的会话事实。

### 连带必改点

- **渲染层 outcome 分支**：`wait_agent` 结果渲染需要新增 `woken` 分支（多目标数量 + outcome，无 state/revision），否则落入现有“非 reply/final_report/idle/terminal 即非法结果”的兜底。
- **活动摘要闭集**：产生端 `wait_agent` 成功摘要的 outcome 闭集需要容纳 `woken`；batch release 的“释放者 outcome”字段也必须在含 `woken` 时保持自洽。
- **批量协调器对 `woken` 的特判**：否则 `woken`（多目标、无 `agent_id`）会被当成“非本调用目标”而产出 `released_by_agent_id: undefined` 的 `batch_released`。
- **类型定义分层**：`woken` 只加到工具结果层（等待调用结果联合类型及其 `wake_reason`/`notice` 载荷），不进入控制器层的事件 outcome 联合，避免它被误当作会话事件或生命周期输入。
- **`wait_agent` 结果按 outcome 动态附加 notice**：现有工具封装只在注册时接受静态 notice，需要改为按本次结果 outcome 决定是否附加。
- **子代理行为准则新增 `wait_agent` 条目**：被父代理入站消息唤醒（`woken`）后，本回合不得再次调用 `wait_agent`；该条目与 `woken` 的 notice 同义，是同一约束的静态侧表达。

### 不采用的备选方案

- **轮询 `ctx.hasPendingMessages()`**：需要忙循环或定时轮询，既有占用与抖动风险；且信号不完整——扩展 API 的 `pi.sendMessage({ deliverAs: "steer" })` 绕过 Pi 内部的 `_queueSteer`，待处理消息计数不能代表父代理消息的到达。
- **自有协议新增父→子通知帧**：通道内部故障无法由调用方收敛——写失败会 fault 通道；监督帧在子端尚未连接时会导致桥接进程 `failAndExit`。这与“唤醒机制不得导致故障”的目标直接冲突，等于把互等换成连接故障。
- **机制强制（被唤醒后本回合再次 `wait_agent` 立即返回）**：只能把互等多推一次，不构成保证，还会让等待语义依赖“上一次是否被唤醒”的隐藏状态；改用 notice 提示与行为准则条款缓解。

### 残余局限（接受项）

- 若 B 当前工具批次里还有其它长任务，消息仍要等它们全部结束后才投递；唤醒只保证 B 结束本次 `wait_agent`，不缩短同批次其它工具的耗时。
- 若 B 被唤醒后仍再次调用 `wait_agent`，消息会被继续压住。这是接受的行为，仅靠 notice 与行为准则条款缓解，不做机制强制。
- 若 Pi 将来不再为 steer 触发 `input` 事件，本功能静默失效：没有报错、没有断连，只是回到互等状态。

### 验收与测试要点

- **控制器层**：覆盖 `woken` 结果形状（多目标 `agent_ids`、`outcome`、`wake_reason`、无 `state`/`revision`）、无 waiter 时无任何副作用（不登记事件、不改快照）、以及真实事件优先于 `woken` 的投影顺序。
- **批量协调器**：同一 message 内多个 `wait_agent` 调用各自拿到自己的 `agent_ids`，`woken` 不被误判为他人释放，不产生 `released_by_agent_id: undefined`。
- **渲染层与活动摘要**：`woken` 属于闭集内合法 outcome，成功渲染且不携带禁用字段；闭集之外的取值仍按非法结果兜底。
