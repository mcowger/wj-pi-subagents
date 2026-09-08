# 07 — 任意后代实时显示草稿

**What to build:** 让用户在任意深度子代理仍在生成时看到连续、不会串流的实时 `text` 和 thinking 草稿，即使详情在生成中途才打开也能立即显示当前前缀。短暂乱序会等待缺帧并恢复，异常积压只冻结非权威预览；完整 assistant 消息到达后成为唯一历史正文。

**Blocked by:** 01 — 规范 assistant 活动与详情交互.

**Status:** ready-for-agent

- [ ] 每个代理的实时 `text` 与 thinking delta 逐层 fire-and-forget 转发到顶层；中间运行时不缓存草稿，顶层即使未打开详情也持续维护按代理隔离的当前草稿。
- [ ] 实时流身份至少包含 agent ID、runtime incarnation ID 和 stream ID；delta 与 complete 携带相同身份及严格递增 sequence，不同代理、重启实例或复用 stream ID 不会关联到同一草稿。
- [ ] 顶层只渲染从 sequence 1 开始的连续前缀；未来帧按 sequence 暂存，缺失帧到达后连续应用该帧及随后已缓存帧。
- [ ] 重复帧和旧帧幂等忽略；缺帧不设置时间超时，正确连续前缀不会因先收到更高 sequence 而被清空。
- [ ] 每个流最多缓存 256 个尚未连续的 future frame，连续前缀本身不设聚合字节上限。
- [ ] future buffer 超限时保留已验证前缀、丢弃 future buffer 并冻结该流；冻结后不继续应用 token，等待权威完整消息。
- [ ] 冻结 text 在当前草稿末尾显示弱化省略号；冻结 thinking 的标题显示 `Thinking · streaming incomplete`，展开时正文末尾也显示弱化省略号。
- [ ] 正常流式 thinking 默认折叠为 `Thinking · streaming`；手动展开后持续增长，完整权威消息到达后恢复普通 `Thinking`。
- [ ] 流式 `text` 实时按 Markdown 重渲染，不增加流式标签、角色标签或消息分隔线。
- [ ] `message_complete` 只收束显示流而不写历史；连续草稿在 complete 后继续显示，避免等待权威消息时闪空。
- [ ] 权威完整消息携带可精确关联实时流的身份；到达后原地替换并清除对应草稿。权威消息先到时，后续该流迟到 delta 和 complete 被忽略。
- [ ] 代理进入 `idle`、`failed` 或 `terminated` 时清除仍未被权威消息替换的草稿；同一运行实例随后到达的合法权威消息仍可进入历史。
- [ ] 实时草稿不进入持久历史、1000 条计数、父会话对话流或父模型上下文。
- [ ] 确定性测试覆盖 9 先于 8、多段 future frame、重复/旧帧、无超时、255/256/257 边界、冻结、text/thinking 提示、complete、权威消息先后顺序、生命周期清理、关闭查看器期间组装以及多层/多代理隔离。
- [ ] 相关类型检查、桥接构建、定向测试和完整测试套件通过；实时活动丢失或冻结不改变子代理生命周期状态。
