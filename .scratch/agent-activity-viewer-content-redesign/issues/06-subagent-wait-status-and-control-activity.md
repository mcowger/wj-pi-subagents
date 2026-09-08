# 06 — 子代理等待、状态与控制轨迹

**What to build:** 为本插件的等待、状态查询和控制工具提供紧凑且语义准确的活动轨迹。用户可以区分“工具调用成功”“目标代理处于失败状态”“控制暂时未改变状态”和“资源清理不完整”，而不会看到重复的完整快照、树数据或报告正文。

**Blocked by:** 02 — 工具活动状态机与安全兜底.

**Status:** ready-for-agent

- [ ] 专用规则只对本插件实际注册实现的 `wait_agent`、`interrupt_agent`、`terminate_agent`、`get_agent_status` 和 `get_agent_tree` 生效；同名覆盖或来源不明工具走安全兜底。
- [ ] `wait_agent` 单目标显示名称和固定八位短 ID，多目标显示数量，并显示实际 outcome；batch release 显示释放者和释放 outcome。
- [ ] `wait_agent` 不保存原始结果结构、报告正文或任务结果。只要调用成功返回，reply、final_report、idle、timeout、正常 terminal 和 batch release 都使用成功符号。
- [ ] `wait_agent` 返回目标 `state: failed` 时显示红色失败和安全错误码；调用本身失败时摘要整行红色并显示稳定错误码。
- [ ] `interrupt_agent` 显示目标和真实控制结果：进入 interrupting 为成功，unchanged 与 compaction active 为中性，稳定调用错误为红色失败。
- [ ] `terminate_agent` 显示目标、terminated count、幂等和 forced 事实：正常回收为成功，already terminated 为中性，forced 成功为警告，termination incomplete 或调用失败为红色。
- [ ] `get_agent_status` 显示目标和生命周期状态；working/interrupting 可显示 activity phase，failed 显示错误码，terminated 显示 termination result。
- [ ] 成功的 `get_agent_status` 始终使用成功符号；目标为 failed 时只将 failed 与错误码片段标红，查询调用失败时整行红色。
- [ ] `get_agent_status` 不保存 revision、时间、上下文占用或完整快照。
- [ ] `get_agent_tree` 成功只显示工具名和成功状态，不保存 revision、scope、节点列表或状态统计；失败显示稳定错误码并整行红色。
- [ ] 插件工具只显示规范稳定错误码，不展示底层异常正文；目标短 ID 固定为完整 UUID 前八位，不承担内部身份或去重职责。
- [ ] 所有展示结果保持消息发送、会话事件、工具调用结果和子代理生命周期状态彼此独立，不因 UI 投影写回控制面。
- [ ] 测试覆盖每个 outcome/state/control result、局部与整行错误色、forced 警告、幂等结果、压缩阻塞、字段省略、同名覆盖降级和既有管理工具语义。
- [ ] 相关类型检查、桥接构建、定向测试和完整测试套件通过，等待批次、控制屏障和资源回收行为无回归。
