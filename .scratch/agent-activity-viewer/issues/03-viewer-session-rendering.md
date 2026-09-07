# 03 — 查看器类会话渲染细化

**What to build:** 把 02 交付的最小查看器升级为 spec 定义的类会话观感：assistant 文本按 Markdown 渲染；工具调用渲染为单行摘要（名称 + 关键参数）；超长工具结果默认折叠、可展开；逐 token 的流式更新在显示层节流合并、缓存按完整消息/完整工具结果粒度落账。渲染目标为"接近根会话 TUI"，接受自绘实现而非宿主渲染器复用。设计依据见同目录 `spec.md`。

**Blocked by:** 02 — 面板回车进入最小查看器（渲染语义加宽建立在其查看器投影模型之上）

**Status:** resolved

- [x] assistant 文本以 Markdown 渲染，长段落、代码片段可读
- [x] 工具调用渲染为单行摘要（工具名称 + 关键参数），不逐行倾倒参数全文
- [x] 超长工具结果（如整文件读取输出）默认折叠为占位行、可展开查看全文；折叠状态在追加渲染时保持稳定
- [x] 流式事件显示层节流合并，实时感与可读性兼顾；缓存仍按完整消息/工具结果粒度落账
- [x] 渲染矩阵有纯模型测试（各类事件、折叠展开、节流合并）
- [x] TUI 手工验收：与根会话 TUI 并排对照，观感接近、无控制字符注入（步骤见 Answer；当前执行环境无可操作的父端 TUI）

## Answer

### 交付内容

1. **会话式查看器渲染**（`src/agent-activity-viewer.ts`）
   - assistant 的 text 块复用宿主 `Markdown` 渲染；thinking 块保留可识别前缀；标题、参数摘要、结果正文均经过既有 UI 事实净化。
   - 工具调用只显示名称与最多三个关键参数；桥接保存的 `JSON.stringify(result)` 在显示层解码后再判定行数/长度，长结果默认折叠，可通过 Enter、Space 或左右键展开和收起。
   - 取消完整 assistant 消息之间的前缀合并启发式；每条缓存的完整 message 保持独立边界。
2. **独立 transient token 通道**（`src/rpc-bridge-event.ts`、`src/rpc-bridge-process.ts`、`src/managed-rpc-node.ts`、`src/rpc-supervisor.ts`、`src/agent-controller.ts`）
   - Pi `message_update` 仅提取有序的 text/thinking delta，作为 `activity_display` transient 帧；完整 `message_end` 仍单独产生权威活动事件。
   - `AgentActivityCache` 不接收 display 帧，`event_count`、replay 和上游 `publishUpstreamActivity` 不包含 token delta；不增加后代汇聚协议，工单 04 范围保持未触碰。
   - 空 delta 被无害忽略；超预算 delta 会收束并丢弃当前 transient 草稿；bridge 关闭和 supervisor 终止期间会发送/转发 `message_complete` 清理未落账草稿。
3. **单一生产节流点**（`src/agent-tree-ui.ts`）
   - 移除模型内未接线的重绘许可；打开的查看器将 cache 更新、display delta、树更新与 spinner 更新统一经过 overlay 的单个 50ms timer 合并。键盘输入仍立即重绘。
   - runtime 将控制器的 transient 订阅接入查看器 source；关闭或 dispose 时同时取消 cache/display 订阅并清理 timer。

### 验证与评审

- 纯模型和集成覆盖：Markdown/宽度换行、工具 JSON 解码与折叠、展开状态、完整消息边界、token 顺序与收束、cache/上游隔离、bridge 帧校验、空/超预算 delta、终止收束、overlay 50ms 合并与订阅清理。
- 只读审查发现并修复两项 P2：空合法 delta 不再导致协议故障；主动终止不再遗留永久 transient 草稿。另收紧终止期仅转发收束帧。
- `npm run check` 通过（TypeScript 检查、bridge 构建和完整测试集）；`git diff --check` 通过。

### TUI 手工验收步骤（供父会话执行）

在加载本扩展的父 Pi TUI 会话中：1) spawn 一个真实子代理，要求其产生 Markdown、工具调用和较长工具输出；2) 打开 `/agents`，选中该节点并按 Enter；3) 对照根会话确认 Markdown、thinking、工具单行摘要和折叠结果可读，Enter/Space 展开后可看到完整结果；4) 在活动持续到达时确认约 50ms 合并重绘、自动跟随，向上滚动暂停、向下恢复；5) Esc 返回树面板，再次进入确认不会串流；6) 发送含 ANSI/方向控制字符的活动文本，确认标题、摘要与正文不执行控制序列；7) 确认查看器内容没有进入父对话流或新增父会话消息条目。
