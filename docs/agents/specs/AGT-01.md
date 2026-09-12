# AGT-01 · AgentSessionManager 生命周期

状态：READY（仅授权本地实现与自动验证；真实服务/人工 AC 未执行）。
需求来源：[v0.5 与增量需求](../../PRD_V0.5.md)；执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：RT-03。
- 修改范围：agent contracts/session manager/store、fake adapter。源码根为 aika-crossplatform；优先复用现有端口，不为文档目录迁移源码。
- 非目标：本份范围外功能、发布、公网部署、真实账号操作。前置自动契约通过可开发；需要真实安全属性的集成不可由 fake 放行。

## 行为与接口

与 LLM-04 后台维护区分；spawn/send/cancel/events/permission多轮生命周期，内部状态含 waiting_input；本地会话id与ACP sessionId分开。并发上限默认1、队列有界、预算/超时显式。

所有新增公共字段需在 CONTRACTS 登记版本、兼容 adapter 与消费者；持久化使用临时数据库验证升级与失败回退，不触碰用户库。

## 验收条件

| AC | 要求 |
| --- | --- |
| AGT-01-A | 重复spawn请求不生成两任务；终态后迟到事件不复活 |
| AGT-01-B | 取消幂等；批准等待/澄清/超时有明确转换 |
| AGT-01-C | 进程崩溃和应用重启标 interrupted/恢复待确认，不假装仍运行 |
| AGT-01-D | fake adapter跑同一契约包；日志有界且脱敏 |

## 验证与交付

先读当前生产实现与既有测试，列出定向命令；测试必须走本模块生产实现，fake 只替代外部依赖。记录命令、退出码、逐 AC 证据、影响消费者、未执行的真实/人工项。逻辑测试不证明 UI 可用、真机或真实服务通过。
报告路径：../reports/AGT-01_ACCEPTANCE.md。仅所有可自动 AC 通过才能写 AUTO_PASS / 待人工验收；FAIL 不可改为 NOT RUN 来推进依赖。完整验收维持待人工；不自动提交或推送。


## 全文审阅：多轮会话与任务状态

区分可复用AgentSession与当前AgentRun：Session starting/ready/busy/closed/failed；Run queued/running/waiting_approval/waiting_input/cancelling/completed/failed/cancelled/interrupted。一次ACP session/prompt结束仅结束Run，Session仍可send开启新Run；不得把prompt完成后禁止多轮send。原“终态不复活”约束针对同一runId，迟到旧run不覆盖新run。

持久sessionId/runId/workspace/owner/scope与事件seq，启动请求id幂等。cancel先发协议取消，再等待有界宽限，超时进入宿主强制结束并留实际状态，不能按点击按钮即标成功取消。未知费用不可声称严格货币预算，用时间/次数/并发可执行限额。fake必须替代adapter，session manager被测为生产实现。
