# UIR-03 · Wiki Knowledge 与参考资料

状态：NOT_STARTED；日期：2026-09-25。关联 [PRD](../RPD.md)、[SPEC 索引](../SPEC.md)、[工程映射](../SOURCE_MAPPING.md)。

## 1. 目标与责任边界

覆盖：UIR-R03/R04/R12。前置：UIR-01。

ui/modern-knowledge-view.mjs 及新增 Wiki view/read model；continuity-routes.ts、knowledge-routes.ts、CharacterPack/Continuity 只读投影与既有纠正/遗忘消费者。

本专项 UI 可直接自行设计，不等待参考图或逐页批准。不得覆盖其他未提交修改；沿唯一运行时和既有存储权威完成直接消费者适配。

## 2. 实施步骤

1. Knowledge 默认已沉淀 Wiki，User/Character 域明确；待审候选放独立次级区域，不混为 active 知识。原文档库移到参考资料并保留导入/切换/查看/删除。
2. 实现搜索、类型/标签筛选、分页与详情：正文、Analysis、Tags、Observed/Valid/Updated 时间、状态、来源。字段缺失显示未提供，不以 createdAt 冒充 observedAt。
3. Wiki read model 读取既有 stores；必要新增聚合管理查询需鉴权/配对/cursor 与缺字段语义，不创建 wiki_entries/新数据库。Tags/Analysis 优先既有真实字段；没有分析时不在渲染时调用 LLM。
4. Sources 链接解析有效 source/version 与可读片段；被删除/到期来源显示失效，不从 Trace 偷补正文；推断与事实区分。
5. 用户事实纠正/遗忘复用原维护入口及 expectedVersion；角色原作只读，外部资料沿 library 权限。确认删除后同步失效详情/列表/检索；Knowledge 不显示 Raw Trace 或隐藏 Prompt 折叠块。

## 3. 验收标准

| AC | 必需结果 | 当前证据 |
| --- | --- | --- |
| 03-A | 真实 Wiki 与文档库各自出现且无互相冒充；默认列表不混待审候选 | NOT RUN |
| 03-B | 搜索/筛选/分页/时间/来源可用；未有数据不出现假 confidence/analysis | NOT RUN |
| 03-C | 纠正/遗忘正式生效，刷新/重启不复活；跨角色/越权来源不可读 | NOT RUN |
| 03-D | Knowledge 内没有 Trace/原始请求输出，旧资料库 CRUD 功能保留 | NOT RUN |

## 4. 验证与交接

新增 tests/ui-rework/knowledge.test.mjs、knowledge-read-model.test.ts；复用 continuity-routes、strict-forget-integration、现有 knowledge 测试。用正式后端创建一条有效来源事实后读取/纠正/删除，fixture 与真实来源区分。

新增测试路径是计划文件，不表示已存在或通过。报告写入 `reports/UIR-03.md`（相对专项根）；记录基线/改动文件、公开契约及消费者、每项 AC、命令退出码、真实/fixture 区别和未运行项。下一步只能消费已有证据的能力。

## 5. 兼容、风险与未做项

0.85 的编纂质量、图谱/向量后台不做。界面缺 Analysis 可明确未生成，但不能用空壳替代 Wiki 阅读。

