# UIR-00 · 基线与接口冻结

状态：NOT_STARTED；日期：2026-09-25。关联 [PRD](../RPD.md)、[SPEC 索引](../SPEC.md)、[工程映射](../SOURCE_MAPPING.md)。

## 1. 目标与责任边界

覆盖：全部需求的实施基线。前置：无；直接开始。

docs/next/ui-rework/；只读核对 management/ui/、management/server.ts、app/trial-backend.ts、desktop/electron/、tests/management/。本步不重写页面。

本专项 UI 可直接自行设计，不等待参考图或逐页批准。不得覆盖其他未提交修改；沿唯一运行时和既有存储权威完成直接消费者适配。

## 2. 实施步骤

1. 记录 HEAD、工作树变动、实际启动命令、管理 session 来源与静态资源装配，逐项保留并行编辑。
2. 核对 SOURCE_MAPPING 中全部旧 page/section 和右键/工作卡深链，登记实际 DOM 入口、API method/DTO、后端 owner、鉴权、Scope、取消和修订。
3. 对角色作用域 Binding、Wiki 查询、包写操作、Playground 提交标记 existing/exposed/missing；缺口分别归 02/03/06/04，不以整版架构重构处理。
4. 冻结最小公开 DTO：配置表单回传 owner/scope/savedRevision/effectiveRevision/availability/errors，秘密仅写入；schemaVersion=1 为新增 UI read model 版本，不替换既有配置 schema。
5. 建立当前正式后端与代表页面基线，记录失败来源；确定截图/浏览器运行方法与一次真实文本模型验证资源，凭证不写报告。

## 3. 验收标准

| AC | 必需结果 | 当前证据 |
| --- | --- | --- |
| 00-A | 17 个旧 page 与 legacy section、现有高级入口均有新位置，映射无遗失 | NOT RUN |
| 00-B | 核心缺口逐个标明生产提供者/消费者及负责 SPEC，不宣称 interface 即 ready | NOT RUN |
| 00-C | 原有工作树未被覆盖，基线命令及原有失败可复现 | NOT RUN |

## 4. 验证与交接

运行现有 routes、settings、server 的定向测试；npm run check。基线失败记录责任和对本专项的影响，不盲修无关代码。

新增测试路径是计划文件，不表示已存在或通过。报告写入 `reports/UIR-00.md`（相对专项根）；记录基线/改动文件、公开契约及消费者、每项 AC、命令退出码、真实/fixture 区别和未运行项。下一步只能消费已有证据的能力。

## 5. 兼容、风险与未做项

本步只产生基线和接口清单；无数据迁移。报告作为所有后续步骤的前置。

