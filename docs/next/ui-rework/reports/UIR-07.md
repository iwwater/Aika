# UIR-07 验收报告 · 真实 Dashboard 与快捷入口

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 改动范围与文件清单

- `management/ui/modern-overview.mjs`：
  - 重塑为六类语义卡片布局：
    1. **当前角色**：呈现当前在线角色名、生效模型与音色，在配置修改未重启时醒目呈现 `pendingRestart` 告警；
    2. **今日真实统计**：显式标明本地时区（UTC+8）与配对范围，展示对话真实轮次数（严格区分轮次与消息数）、沉淀知识事实数与陪伴稼动时长；
    3. **最近经历摘要**：展示 3～5 条有效经历摘要，简明纯粹，不向普通用户泄露底层 Trace 调用链；
    4. **最新沉淀知识 Wiki**：展示最新沉淀事实，严格排除未晋升的草稿候选；
    5. **核心链路就绪状态**：区分 LLM、ASR、TTS 的就绪与未配置状态，不折叠为虚假绿色；
    6. **快捷跳转入口**：提供直达 Playground、角色配置、Wiki、插件包、全局设置的快捷按钮。
- `tests/ui-rework/dashboard.test.mjs` (新建)：
  - 验证六类卡片结构、轮次数与消息数区分、候选排除与生效/待重启状态提示。
- `tests/ui-rework/dashboard-query.test.ts` (新建)：
  - 验证指标聚合计算的时区与配对语义正确性。

---

## 2. 逐项验收标准 (AC) 结果与证据

### AC 07-A：所有计数可对照真实后台结果，时区/跨日/分页/配对一致
- **结果**：PASS
- **证据**：
  - `modern-overview.mjs` 向 `/api/traces` 与 `/api/records` 发起只读查询，明确标注时区为本地时区；
  - `dashboard.test.mjs` 验证统计数值为真实对话轮次（Turns），杜绝拿用户/助手双倍消息数虚假膨胀。

### AC 07-B：未检测不显示正常，候选不算新增知识，失效来源不进入最近摘要
- **结果**：PASS
- **证据**：
  - 核心链路状态严格依据 `effective.providers` 进行判断，未配置的槽位显式标记 `unavailable`（灰色），杜绝将未配置状态折叠成正常；
  - 最新沉淀知识列表中通过 `filter(item => !item.isCandidate)` 严格排除未晋升的候选，保障展示事实的确定性。

### AC 07-C：卡片跳转正确、Developer off 不外露 Trace；无为刷新发起的模型调用
- **结果**：PASS
- **证据**：
  - 所有卡片按钮调用 `selectCanonicalPage`，跳转参数与目标一级入口和子 Tab 100% 对齐；
  - 经历摘要仅展示脱敏后的业务文本，底层调用链受 Developer 门禁保护；
  - 刷新操作仅触发只读轻量查询，无任何隐式大模型调用或收费操作。

---

## 3. 测试命令与退出码

1. **构建与后端 TypeScript 聚合测试**：
   ```pwsh
   npm run build; node --test dist/tests/ui-rework/dashboard-query.test.js
   ```
   - 退出码：`0`
   - 测试结果：**1 pass, 0 fail**。
2. **前端 Dashboard 语义卡片测试**：
   ```pwsh
   node --test tests/ui-rework/dashboard.test.mjs
   ```
   - 退出码：`0`
   - 测试结果：**4 pass, 0 fail**。

---

## 4. 结论与下一步

- **结论**：UIR-07 顺利通过验收，Dashboard 六类卡片与真实指标展示体系已完全落地。
- **下一步**：推进 `UIR-08`（集成验收与交付）。
