# 0.8 讨论取舍与源码映射

日期：2026-09-23；核对基线：`6d8a725`。本轮只修订文档；静态核对不替代运行与人工验收。

参考：[规划零八与聊天框审核](chatgpt-conversation://6ab2cc39-fbe8-83ee-a3b6-bd9871b32950)。已读取完整讨论；其中答复明确未访问源码，故架构判断按本地实现重新核实。产品范围以 [RPD](RPD.md) 为准，旧缺陷与连续性准入沿用 [0.79 核对](../0.79/SOURCE_AUDIT.md)。

## 建议取舍

| 讨论建议 | 本轮结论 |
| --- | --- |
| 0.8 是 Perception + Timeline + Proactive Companion | 采纳，补齐授权观察、事件投影、邀请与交流反馈；保留既有 Work 计划 |
| 必须从零补 Event Bus | 修正：已有 HostEventChannel 契约及轮次订阅，先补实际接线与事件 schema，不重造内核 |
| OCR → Memory → 反馈 | 修正：观察默认短期，可直接用于本轮/邀请；长期沉淀需明确保存及来源链 |
| Timeline 优于复杂 Wiki | 采纳实施优先级，不撤销已有 Soul/Wiki 或混并 Canon/Companion |
| 独立主动 Agent | 采纳统一策略评估，不新增独立轮次或无限模型循环，复用邀请配额 |
| 气泡与展开聊天、Presentation 分离 | 采纳体验目标，已有实现上重写交互；渲染器和表现契约保留 |
| 全控制台重排、关系 72%、连续学习 4 小时 | 不作为确定设计或真实数据；范围由参考图确认，指标必须有真实来源 |
| 六周实现计划 | 改为依赖阶段与验收门槛，尚无工时依据，不承诺固定日期 |

## 实际入口与改造限制

以下链接均指向 Windows 正式源码；名称存在不代表整个 0.8 功能完成。

| 源码 | 本次核对事实 | 0.8 对应工作 |
| --- | --- | --- |
| [plugin.ts](../../../windows/code/desktop-pet/contracts/plugin.ts) | HostEventChannel 有 publish/subscribe；EventScope 是包/轮次/会话 | 增加事件版本、pairing、来源/撤销验证；验证真实生产投递，不用接口存在证明闭环 |
| [turn-port.ts](../../../windows/code/desktop-pet/core/turn-port.ts) | accepted/reply/terminal；无 delta；已有 Scope 取消 | 共用权威；默认完整回复展示，流式另列契约变化 |
| [main.mjs](../../../windows/code/desktop-pet/desktop/main.mjs) | 已有 speech-bubble、drawer、输入与工作卡编排 | 拆展示投影和仲裁，不从零引入第二套聊天管线 |
| [chat-log.ts](../../../windows/code/desktop-pet/desktop/chat-log.ts) | 会话内按角色保留 50 行；含语音及 Work 原话引用 | 与持久历史分开；重写不能丢原话定位或混淆历史承诺 |
| [view-state.ts](../../../windows/code/desktop-pet/desktop/view-state.ts) / [presentation.ts](../../../windows/code/desktop-pet/contracts/presentation.ts) | 现有 Scope 与表现类型 | 消费受验证的表现意图，保留 Live2D 表现边界 |
| [invitations.ts](../../../windows/code/desktop-pet/companion/invitations.ts) | 配额、时区、冷却已实现；event_id 外键绑定 memory_records；存在 start_voice 意图 | 扩展短期来源兼容与普通文本动作，不能假称已支持 Observation |
| [routes.mjs](../../../windows/code/desktop-pet/management/ui/routes.mjs) | 15 个页面与旧 section 映射，含 timeline/events 等，无独立 chat 页 | 逐页最小适配、保留深链；首版会话查看，发送能力另需公共接入契约 |
| [server.ts](../../../windows/code/desktop-pet/management/server.ts) | 显式静态资源映射与 continuity/presentation 分派 | 新视图须注册资源与验证路由，避免再次产生模块 404 |

## 结论与验证范围

方向符合原主线：独立能力包、单一轮次权威、受控连续性和轻量桌宠交流。需要避免的偏移是重造 Event Bus、无条件把观察写进记忆、把所有界面重新设计一遍，以及新增未经授权的活动监控。0.79 数据安全/生产闭环门槛继续有效，本轮不保证 0.7 已全面完成或未来零回归。

本轮仅检查文档链接、编号、范围与格式，不运行业务测试，不触发真实采集、Provider 调用或外部工作执行。正式 SPEC 尚未创建；RPD 阶段表不是验收通过记录。
