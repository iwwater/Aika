# UIR-05 · Developer Trace 整合

状态：NOT_STARTED；日期：2026-09-25。关联 [PRD](../RPD.md)、[SPEC 索引](../SPEC.md)、[工程映射](../SOURCE_MAPPING.md)。

## 1. 目标与责任边界

覆盖：UIR-R09/R12。前置：UIR-01、03、04。

ui/events/modern-timeline 及新增 Developer view；management/server.ts Trace/records/context 查询；实际维护批次/来源引用的最小投影。

本专项 UI 可直接自行设计，不等待参考图或逐页批准。不得覆盖其他未提交修改；沿唯一运行时和既有存储权威完成直接消费者适配。

## 2. 实施步骤

1. 建立 LLM/Chat、Knowledge Ingest、Timeline/Companion、Runtime Logs 四个子页；聊天历史从产品一级移入 LLM/Chat，不删除存储。
2. LLM 按 session/turn 展示实际请求/回复及已记录模型/延迟/Token，content 按需鉴权读取；字段未留存显示 unavailable，不重复请求模型填历史。
3. 整理 Trace 关联真实 batch/operation/source/candidate/最终 Wiki 引用及接受/拒绝/失败时间；缺关联时补维护 owner 的结构化元数据，禁按时间相邻猜因果。
4. Timeline/Companion 复用统一三域查询、感知状态及失效规则；0.81 collection 未交付时保持不可用说明，不读取全局键盘。
5. Developer off 释放轮询与调试内存；后端鉴权始终生效；Trace 脱敏和来源遗忘传播到详情/导出（若有），不得为调试新增无限原文日志。

## 3. 验收标准

| AC | 必需结果 | 当前证据 |
| --- | --- | --- |
| 05-A | 一个真实轮次及维护事件可定位到实际来源/结果，缺失历史明确标记 | NOT RUN |
| 05-B | Developer off 不预取敏感内容，深链不绕过开关/后端权限 | NOT RUN |
| 05-C | 已撤销来源正文从详情/缓存消失；当前 Context 试算不冒充历史 | NOT RUN |
| 05-D | Timeline/Companion 合并入口保持数据分域，暂停采集按钮在 Settings 仍可达 | NOT RUN |

## 4. 验证与交接

新增 tests/ui-rework/developer.test.mjs、trace-links.test.ts；复用 tests/management/context-inspector.test.ts、provenance.test.ts、next08/timeline-events.test.ts 与相关 trace 隐私回归。

新增测试路径是计划文件，不表示已存在或通过。报告写入 `reports/UIR-05.md`（相对专项根）；记录基线/改动文件、公开契约及消费者、每项 AC、命令退出码、真实/fixture 区别和未运行项。下一步只能消费已有证据的能力。

## 5. 兼容、风险与未做项

完整原始内容未保存时不追补；批次投影只补引用/状态，既有维护生命周期不变。

