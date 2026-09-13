# FE SPEC 执行索引

需求见 [模块 PRD](PRD.md)，一次下发一份独立 SPEC。

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [FE-01](specs/FE-01.md) | Runtime 桥接与消息状态 | 已补证（2026-09-13 复核报告）：hook/presenter 143 测试全绿；页面视觉证据 NOT RUN |
| [FE-02](specs/FE-02.md) | 模式、场景与设置 | 已补证（2026-09-13 复核报告）：状态层 PASS；键盘/窄屏 AC-C 保留人工队列 |
| [FE-03](specs/FE-03.md) | 语音状态与字幕显示 | 已补证（2026-09-13 复核报告）：状态层 PASS；浏览器截图 NOT RUN |
| [FE-04](specs/FE-04.md) | 双语对照字幕去重 | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-05](specs/FE-05.md) | 失败轮重试（前置 CORE-08） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-06](specs/FE-06.md) | 撤回与重新生成（前置 FE-05） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-07](specs/FE-07.md) | 点击朗读 | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-08](specs/FE-08.md) | Rewind（回到这里） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-09](specs/FE-09.md) | 开发者模式入口与 Trace 查看页（F2/F4） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-10](specs/FE-10.md) | 能力调用视图与数据流图（F5/F6） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-11](specs/FE-11.md) | 长期记忆管理页（F7） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-12](specs/FE-12.md) | 存储浏览页与只读 SQL 控制台（F8） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-13](specs/FE-13.md) | 语音页露出识别语言并允许改掉 | REVIEWED_AUTO（2026-09-13：报告逐 AC 齐全，16 测试范围复跑全绿；无全量回归已记录） |
| [FE-23](specs/FE-23.md) | Live Inspector 外壳与实时订阅 | AUTO_PASS（2026-09-13）：A~C 全过，184 测试回归全绿；拖拽/窄窗目视留人工。见[验收报告](reports/FE-23_ACCEPTANCE.md) |
| [FE-24](specs/FE-24.md) | 泳道时间线、检查器与导出 | AUTO_PASS（2026-09-13）：A~D 全过，170 测试回归全绿；浮层目视留人工。见[验收报告](reports/FE-24_ACCEPTANCE.md) |
| [FE-25](specs/FE-25.md) | 上下文布局、记忆清单与实时数据流 | AUTO_PASS（2026-09-13）：A~D 全过，577 测试回归全绿；目视留人工。见[验收报告](reports/FE-25_ACCEPTANCE.md) |
| [FE-14](specs/FE-14.md) | 远程输出协议内核：OutboundChannel 与 schema v1（草案） | AUTO_PASS（2026-09-13）：A~G 全过（白名单投影/cursor 单调/重放去重/trace 四门/慢消费者限额/conformance 包+两处突变命中）；真实传输归 FE-15/16。见[验收报告](reports/FE-14_ACCEPTANCE.md) |
| [FE-15](specs/FE-15.md) | Tauri 宿主 transport（HTTP 轮询）与手机页迁移（草案） | READY；执行当前已审阅正文 |
| [FE-16](specs/FE-16.md) | 浏览器 dev 宿主 transport 与 Node ws 中继（草案） | READY；执行当前已审阅正文 |
| [FE-17](specs/FE-17.md) | 网关安全收口：分层开关、token 轮换与暴露面审计（草案） | READY；执行当前已审阅正文 |
| [FE-18](specs/FE-18.md) | 环境事件契约与 ProactivePolicy 骨架（全 fake） | 保持后置；本次仅修文档 |
| [FE-19](specs/FE-19.md) | Windows 前台进程传感器与 Context 注入 | 保持后置；本次仅修文档 |
| [FE-20](specs/FE-20.md) | 桌宠窗口与主动气泡（fake 事件验收） | 保持后置；本次仅修文档 |
| [FE-21](specs/FE-21.md) | Screen Event：帧 diff + ROI 截图 + OCR 关键词 | 保持后置；本次仅修文档 |
| [FE-22](specs/FE-22.md) | ProactivePolicy 接线与频控打磨 | 保持后置；本次仅修文档 |

已有适配不等于新 SPEC 全部验收通过；设备与后置范围保持原状态。FE-14…17 已合并全文审阅修订到正文（需求见 [模块 PRD](PRD.md) 对应章），按序一次只执行一份，按2026-09-13修订及GOAL_EXECUTION_PLAN下发。FE-18…22 为环境感知与主动陪伴五份（需求见 [模块 PRD](PRD.md) 对应草案章），同样按序一次下发一份，全部为未评审草案。

## 2026-09-13 新增执行项

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [FE-23](specs/FE-23.md) | Live Inspector 外壳与实时订阅 | READY，仅本地实现 |
| [FE-24](specs/FE-24.md) | 泳道时间线、检查器与导出 | READY，仅本地实现 |
| [FE-25](specs/FE-25.md) | 上下文布局、记忆清单与实时数据流 | READY，仅本地实现 |
| [FE-26](specs/FE-26.md) | F9 Ops 成本页 | AUTO_PASS（2026-09-13）：A~D 自动 AC 全过（幂等/分页覆盖/时区日界线/未知语义/币种分离/错误率定义/最慢尝试完整计时），全量 1133 回归全绿；UI 目视与真实费用留人工。见[验收报告](reports/FE-26_ACCEPTANCE.md) |

当前执行按[安全计划](../GOAL_EXECUTION_PLAN.md)。早期无报告项状态为未核实/待补证，不认定未实现或通过；已有报告项仍待审阅。
