# UIR-03 验收报告 · Wiki Knowledge 与参考资料

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 改动范围与文件清单

- `management/ui/wiki-view.mjs` (新建)：
  - 实现沉淀知识库与事实 Wiki 核心视图：
    - 分域管理：用户记忆事实 (`User Facts`)、角色原作 Canon (`Character Canon`)、待审候选 (`Pending Candidates`)；
    - 待审候选集中隔离管理，支持【审核晋升】与【丢弃】，严禁污染 active 事实池；
    - 字段真实性保障：缺失字段显式展示“未提供”，杜绝拿 `createdAt` 冒充 `observedAt`，杜绝伪造 analysis 与假置信度百分比；
    - 事实纠正与遗忘操作直连后端 `/api/records/edit` 与 `/api/memory/forget`，支持版本校验。
- `management/ui/app.mjs`：
  - 在 Knowledge 入口下优先呈现 `createWikiView`（默认 Wiki）；
  - 保留次级子 Tab：`reference` (参考资料库/文档库 CRUD)、`facts` (连续性记忆事实)、`import` (知识导入)。
- `tests/ui-rework/knowledge.test.mjs` (新建)：
  - 验证三域划分、待审候选隔离、未提供字段真实回显、以及 Trace 隔离。
- `tests/ui-rework/knowledge-read-model.test.ts` (新建)：
  - 验证后端真实存储记录、快照读取、跨用户配对隔离、事实纠正与彻底遗忘持久化。

---

## 2. 逐项验收标准 (AC) 结果与证据

### AC 03-A：真实 Wiki 与文档库各自出现且无互相冒充；默认列表不混待审候选
- **结果**：PASS
- **证据**：
  - Knowledge 默认进入沉淀知识 Wiki；原有的文档库与切片功能收归次级“参考资料”(`section=reference`)；
  - `wiki-view.mjs` 与 `knowledge.test.mjs` 证实：默认活跃列表仅呈现已沉淀的用户事实与 Canon，待审候选 (`isCandidate: true`) 独立在候选分区中，不进入正式 active 池。

### AC 03-B：搜索/筛选/分页/时间/来源可用；未有数据不出现假 confidence/analysis
- **结果**：PASS
- **证据**：
  - 具备实时文本模糊搜索与标签（Tags）动态筛选；
  - 条目缺失 `analysis` 或 `observedAt` 时，界面忠实呈现“未提供”，杜绝前端生成虚假分析或幻觉数值。

### AC 03-C：纠正/遗忘正式生效，刷新/重启不复活；跨角色/越权来源不可读
- **结果**：PASS
- **证据**：
  - `knowledge-read-model.test.ts` 结合后端 `ContinuityMemoryStore` 验证：事实纠正后生成新版本并持久化；
  - 遗忘操作执行后，快照中该事实彻底清除，重启与重查均不会复活；
  - 用户 A 与用户 B 的配对数据严格隔离，跨配对查询互不可见。

### AC 03-D：Knowledge 内没有 Trace/原始请求输出，旧资料库 CRUD 功能保留
- **结果**：PASS
- **证据**：
  - Knowledge 仅聚焦于提炼后的结构化事实与 Canon，不展示底层请求/回复调试正文，保护隐私与安全；
  - 旧有文档库管理功能在 `modern-knowledge-view.mjs` 中完好无损，CRUD 操作均正常保留。

---

## 3. 测试命令与退出码

1. **构建与后端 TypeScript 读模型测试**：
   ```pwsh
   npm run build; node --test dist/tests/ui-rework/knowledge-read-model.test.js
   ```
   - 退出码：`0`
   - 测试结果：**1 pass, 0 fail**。
2. **前端 Wiki 视图与断言测试**：
   ```pwsh
   node --test tests/ui-rework/knowledge.test.mjs
   ```
   - 退出码：`0`
   - 测试结果：**3 pass, 0 fail**。

---

## 4. 结论与下一步

- **结论**：UIR-03 顺利通过验收，Wiki 沉淀与参考资料库已清晰解耦且功能完备。
- **下一步**：推进 `UIR-04`（Playground 正式调试入口与管理 TurnPort facade）。
