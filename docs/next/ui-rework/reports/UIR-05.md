# UIR-05 验收报告 · Developer Trace 整合

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 改动范围与文件清单

- `management/ui/developer-view.mjs` (新建)：
  - 实现 Developer Mode 综合调试工作台，清晰划分四个子页：
    1. `LLM / Chat Trace`：完整调用链路、Token 统计、平均耗时与错误率分析；
    2. `Knowledge Ingest Trace`：记忆提炼批次流水、准入依据、关联轮次及最终 Wiki 条目；
    3. `Timeline Companion Trace`：双时间线与伴随事件调试；
    4. `Runtime Logs`：底层运行时诊断日志。
- `management/ui/app.mjs`：
  - 在开启开发者模式后挂载 `createDeveloperView`；
  - 开发者模式关闭时严格阻断 Trace 请求，清空内存正文缓存。
- `tests/ui-rework/developer.test.mjs` (新建)：
  - 验证四个子面板的独立性、未留存字段标注 `unavailable`、以及遗忘操作的缓存清除传播。
- `tests/ui-rework/trace-links.test.ts` (新建)：
  - 验证轮次与维护批次的严格结构化关联，杜绝基于时间相邻的因果伪造。

---

## 2. 逐项验收标准 (AC) 结果与证据

### AC 05-A：一个真实轮次及维护事件可定位到实际来源/结果，缺失历史明确标记
- **结果**：PASS
- **证据**：
  - `Knowledge Ingest Trace` 记录了批次 ID、轮次 ID、提炼候选正文、准入决策理由与入库 Wiki 映射；
  - `trace-links.test.ts` 验证未产生维护事件的轮次明确标记 `batchId: null`，杜绝因果伪造；未留存字段以 `unavailable` 显式呈现。

### AC 05-B：Developer off 不预取敏感内容，深链不绕过开关/后端权限
- **结果**：PASS
- **证据**：
  - `app.mjs` 中设置了 Developer Mode 门禁组件，当模式为关闭状态时，任何访问 Developer 及其深链的操作均被门禁卡片拦截，未向后端请求任何敏感 Trace 正文。

### AC 05-C：已撤销来源正文从详情/缓存消失；当前 Context 试算不冒充历史
- **结果**：PASS
- **证据**：
  - 遗忘操作执行时触发 `invalidateTraceBodies()`，彻底清除内存缓存；
  - `developer.test.mjs` 测试验证撤销或遗忘的目标内容立即从缓存中抹除；
  - 检索试算（Context Probe）与历史已消耗 Context 物理区隔，语义独立。

### AC 05-D：Timeline/Companion 合并入口保持数据分域，暂停采集按钮在 Settings 仍可达
- **结果**：PASS
- **证据**：
  - Timeline/Companion 作为 Developer 的子页整合呈现，保留叙事与陪伴分域；
  - 隐私与采集授权控制始终保留在 `Settings/隐私与授权感知`，正常模式下随时可达，杜绝将数据控制权藏匿于调试区。

---

## 3. 测试命令与退出码

1. **构建与后端 TypeScript Trace 关联测试**：
   ```pwsh
   npm run build; node --test dist/tests/ui-rework/trace-links.test.js
   ```
   - 退出码：`0`
   - 测试结果：**1 pass, 0 fail**。
2. **前端 Developer 面板与遗忘传播测试**：
   ```pwsh
   node --test tests/ui-rework/developer.test.mjs
   ```
   - 退出码：`0`
   - 测试结果：**3 pass, 0 fail**。

---

## 4. 结论与下一步

- **结论**：UIR-05 顺利通过验收，四大子调试面板与严谨的数据溯源链路已整合完成。
- **下一步**：推进 `UIR-06`（Plugins 宿主管理暴露与 Settings 保留业务）。
