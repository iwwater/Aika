# AGT-02 · ACP 客户端与受限进程宿主

状态：READY（仅授权本地实现与自动验证；真实服务/人工 AC 未执行）。
需求来源：[v0.5 与增量需求](../../PRD_V0.5.md)；执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：AGT-01、RT-03。
- 修改范围：ACP adapter、Tauri进程端口及协议fixture。源码根为 aika-crossplatform；优先复用现有端口，不为文档目录迁移源码。
- 非目标：本份范围外功能、发布、公网部署、真实账号操作。前置自动契约通过可开发；需要真实安全属性的集成不可由 fake 放行。

## 行为与接口

按官方 initialize/session/new/session/prompt/session/update/session/cancel 与 permission request 映射；固定适配器版本与capability协商。命令可执行文件白名单，参数数组，cwd规范化、环境最小化、stdout协议/stderr日志分离。ACP是通信协议，不能当沙箱。

所有新增公共字段需在 CONTRACTS 登记版本、兼容 adapter 与消费者；持久化使用临时数据库验证升级与失败回退，不触碰用户库。

## 验收条件

| AC | 要求 |
| --- | --- |
| AGT-02-A | 分包/错JSON/未知版本/超大消息/进程退出/超时均有终态 |
| AGT-02-B | 审批回应用原request/options id，拒绝与取消真实映射 |
| AGT-02-C | 未实现fs/terminal能力不宣告；不允许shell拼接与任意cwd |
| AGT-02-D | 不能强制限制适配器自有工具时写/执行模式BLOCKED；禁止用prompt或worktree冒充隔离 |

## 验证与交付

先读当前生产实现与既有测试，列出定向命令；测试必须走本模块生产实现，fake 只替代外部依赖。记录命令、退出码、逐 AC 证据、影响消费者、未执行的真实/人工项。逻辑测试不证明 UI 可用、真机或真实服务通过。
报告路径：../reports/AGT-02_ACCEPTANCE.md。仅所有可自动 AC 通过才能写 AUTO_PASS / 待人工验收；FAIL 不可改为 NOT RUN 来推进依赖。完整验收维持待人工；不自动提交或推送。


## 全文审阅：协议与进程状态

initialize协商版本/capabilities后才session/new；session/prompt响应stopReason结束Run而非销毁Session。request_permission必须响应原JSON-RPC id以及有效optionId，拒绝用协议支持的拒绝/取消结果，不编造approve方法。澄清若协议无结构化事件，显示需用户回复而不假设可解析任意文字成为系统请求。

JSON-RPC framing按固定协议版本处理，stderr不能混入stdout parser；进程退出、stdin失败、父宿主dispose必须关闭关联请求。Windows终止需有子进程归属控制（如Job Object）并测试超时清理，不能仅kill父PID。不宣称ACP本身限制自有工具，真实只读也需验证写能力已禁用。
