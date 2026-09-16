# 01 — 失败文本贯通到面板折叠行（契约升版）

**What to build:** 子代理的一次模型调用以错误收尾时，父会话用户在该子代理的活动面板里看到一行红色 `▸ × Error: <错误文本首行>`。条目按"每次失败尝试一条"登记、逐条保留，且不改变该子代理的生命周期状态。本条同时把规范活动契约与监督协议版本各递增一位，让新的"模型调用失败条目"在产生端、接收端、活动缓存与查看器四处一次就位；条目一次定死四个字段（收尾原因、错误文本、provider、model），避免后续为展开体二次升版。设计依据见同目录 `spec.md`。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 正文为空、收尾原因为错误且带错误文本的收尾消息，在该子代理的活动面板渲染出一行 `× Error: <错误文本首行>`
- [x] 该条目以"模型调用失败条目"的独立身份进入活动缓存，按到达顺序出现且可被回放
- [x] 条目完整携带收尾原因、错误文本、provider 与 model 四个字段（展开体由 02 号票消费）
- [x] 规范活动契约版本与监督协议版本各递增一位，既有版本断言同步更新
- [x] 版本一致时，新条目在发布侧与接收侧都被接受，不产生无效帧、不使通道进入故障
- [x] 模型调用失败条目不触发任何生命周期状态转换，该子代理的运行状态与失败前一致
- [x] 既有三种活动条目（消息、父消息、工具）的行为与渲染完全不变

## Comments

<!-- 评论与对话历史追加在此标题下 -->

## Answer

**实现位置**

- 采集：`src/rpc-bridge-event.ts` `normalizeActivityModelCallFailure` 只从 `message_end` 的收尾 assistant 消息读取事实（`stopReason === "error"` + 非空 `errorMessage`），文本经 `sanitizeSafeActivityText` 净化后原样保留；`provider`/`model` 必须是非空短引用（≤ 256 字节）。不新增 Pi 事件订阅点。
- 契约：`SafeAgentActivityEvent` 新增第四个原子正文 `model_call_failure`，字段闭集固定为 `failure`（`error` | `aborted`）、`message`、`provider`、`model`；`parseAgentActivityEvent`（宽容路径）与 `parseCanonicalAgentActivityEvent`（严格路径）同步接纳，接收端 `isSafeModelCallFailureEvent` 只复用 `isSafeModelCallFailureReason` 谓词，不重写值域。
- 升版：`CANONICAL_ACTIVITY_CONTRACT_VERSION` → `wj-pi-subagents.activity/12`，`SUPERVISOR_PROTOCOL_VERSION` → `wj-pi-subagents/30`，三处既有版本断言同步。
- 缓存与查看器：`ActivityAtomKind` 增加第四种；查看器投影为独立 `DisplayEntry`，折叠行 `× Error: <错误文本首行>` 复用工具失败的错误色与 `×` 图标（抽出共享 `FAILURE_VISUAL`），每次失败尝试各自成条，不与工具条目合并。

**验证**

- `npm test`：527 个测试，522 通过 / 0 失败 / 5 跳过；`npx tsc --noEmit` 无输出。
- 贯通测试（`test/descendant-activity-aggregation.test.ts`）：`message_end` → 桥接归一化 → 监督通道 → 活动缓存 → 面板折叠行，断言条目四字段与渲染行，并断言生命周期事件数不变、通道无故障。
- 真实桥接进程测试（`test/agent-activity-bridge.test.ts`）、监督通道收发测试（`test/agent-activity-supervisor.test.ts`，含大错误正文分块上行）覆盖"发布侧与接收侧同时就位"。

**范围边界（后续工单须知）**

- 折叠行当前不带 `▸` 展开标记，失败条目也不提供选中/展开入口：展开体、`provider · model` 与错误正文原文由 02 号票落地（查看器投影目前只保留 `message`，02 需在该处补齐 `provider`/`model`）。
- 正文非空的失败消息（正文 + 失败两条）、`aborted` 收尾、错误文本缺失的 `Unknown error` 兜底文案、压缩失败与溢出归属 03 号票；现有测试已就这些边界断言当前行为，03 落地时需一并改写。
- 本轮代码评审（Standards 与 Spec 两轴）的结论：除本次已修的两处（`managed-rpc-node` 身份上界与谓词复用、`firstLine` 空行处理）外无阻塞项；工单 `Status` 使用 `claimed`/`resolved` 属 `docs/agents/issue-tracker.md` 的 wayfinder 工单词表。
