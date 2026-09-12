# AGT-05 · 远程审批、进度与结果投递

状态：READY（仅授权本地实现与自动验证；真实服务/人工 AC 未执行）。
需求来源：[v0.5 与增量需求](../../PRD_V0.5.md)；执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：AGT-03或AGT-04、GW-02或GW-04、RT-04。
- 修改范围：permission presenter、channel/device审批adapter、进度投递。源码根为 aika-crossplatform；优先复用现有端口，不为文档目录迁移源码。
- 非目标：本份范围外功能、发布、公网部署、真实账号操作。前置自动契约通过可开发；需要真实安全属性的集成不可由 fake 放行。

## 行为与接口

审批卡只引用服务端请求，按钮带单次绑定凭据，目标为已验证私聊/设备；文件摘要从实际请求生成，不能保证未知未来恰好改3文件。结果为不可信资料，Aika汇总不能触发新执行。

所有新增公共字段需在 CONTRACTS 登记版本、兼容 adapter 与消费者；持久化使用临时数据库验证升级与失败回退，不触碰用户库。

## 验收条件

| AC | 要求 |
| --- | --- |
| AGT-05-A | 其他用户/群/过期按钮/重放0执行 |
| AGT-05-B | 批准前任务停住；取消与批准竞态只有一个赢家 |
| AGT-05-C | 进度节流，完成通知去重，发送失败不改任务真实终态 |
| AGT-05-D | 结果回原会话且不包含key/私人其他会话内容；端到端真实链路另INT-04 |

## 验证与交付

先读当前生产实现与既有测试，列出定向命令；测试必须走本模块生产实现，fake 只替代外部依赖。记录命令、退出码、逐 AC 证据、影响消费者、未执行的真实/人工项。逻辑测试不证明 UI 可用、真机或真实服务通过。
报告路径：../reports/AGT-05_ACCEPTANCE.md。仅所有可自动 AC 通过才能写 AUTO_PASS / 待人工验收；FAIL 不可改为 NOT RUN 来推进依赖。完整验收维持待人工；不自动提交或推送。


## 全文审阅：补齐用户发起入口与PC任务记录

原范围只有审批/进度，没有spawn入口，本份补TaskCommand facade与Presenter：桌面任务面板可选择已配置agent、预登记workspace别名、输入prompt，查看历史/运行状态、继续send/cancel、处理审批。远程私聊采用显式 /agent 命令（或等价结构化表单），body不接受任意本地路径，只传服务端白名单workspaceRef；自然语言建议必须用户确认后转结构化命令，不靠LLM回复JSON自动执行。

Channel走GW-01可信命令分支；Device协议需显式追加versioned agent.spawn/send/cancel与permission.respond，更新FE-14/15/16白名单和契约测试。只有agent capability允许的主体能提交，旧客户端仅chat/ping保持兼容。Task记录来自AGT-01，同一PC任务面板和远程session引用同一runId；禁止为每个界面另存第二任务状态。

结果直接呈现结构化状态+可选Aika总结，总结失败不改任务完成状态；不把Agent自由文本当执行证明。通知复用GW-01 outbox；人工审批转发不能改变action哈希/范围。增加AC-E：生产命令parser→TaskCommand→生产manager（fake adapter）真正spawn一次；未知workspace/未授权/重放0执行；PC页与远端读同runId，缺口留真实UI验收。
