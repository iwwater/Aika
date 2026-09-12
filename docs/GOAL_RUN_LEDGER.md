# GOAL_RUN_LEDGER · 本轮执行持久账本

日期：2026-09-13。依据 [GOAL_EXECUTION_PLAN](GOAL_EXECUTION_PLAN.md) 波次 0～8 建立的持久清单。上下文压缩后从本账本继续，勿重做已证实节点。一次一个 SPEC；每份结束更新本账本并按授权 commit。

## 状态与规则（摘自执行计划）

- 每条 AC 分开记录：PASS / FAIL / BLOCKED / NOT RUN / DEFERRED；证据类型：production+fixture / real-service / browser / device / human。
- AUTO_PASS：所有可自动 AC 通过、改动与消费者审查完成，仍待人工验收。PARTIAL：安全可独立部分完成，仍有自动 AC 阻塞。BLOCKED：明确缺前置/环境/权限，写原因与解除条件。REVIEWED_AUTO：已审阅既有代码与证据，可作本地开发前置，不代表用户批准。
- 能跳过的是受阻步骤，不能跳过的是依赖的行为保证。安全负例不过，不启动真实外部执行。TTS-05、INT-04 真实轨禁止空集 AUTO_PASS。
- 调度阈值：连续两种有依据修复仍失败，或同一步约 30 分钟无新证据 → 落盘诊断，转无依赖节点。
- 提交规则（用户授权）：读完基线 commit 一次，此后逐 SPEC commit；不 push、不 mix 无关改动；不使用 `git add .`。
- 不入库（本地保留）：`_tb.txt`、`_tb_s.txt`、`_z.txt`（构建/进程临时日志）、`.workbuddy/`（工具状态）。

## 基线登记（Wave 0）

- 基线 commit：`049372f`（v0.5 规划/审阅/执行计划 + 新增 SPEC + speechOutput 条件等待修复，100 文件）。
- 原 dirty 文件已全部入基线 commit；遗留未跟踪仅为上述 4 个临时/工具项。
- 云 TTS 3 红复核：`npm test -- src/services/voice/speechOutput.conformance.test.ts` → **12 passed (12)，exit 0**（2026-09-13 02:22）。SPEC_STATUS_REPORT 所述 3 红已由工作区修复消除，历史报告保留不改。

## 波次清单

| 波次 | 节点 | 状态 | 证据/commit | 备注 |
| --- | --- | --- | --- | --- |
| 0 | 读文档 + git 基线登记 + commit 一次 | DONE | 049372f | 见上 |
| 0 | speechOutput 契约定向复核 | DONE | 049372f + 本文件 | 12/12 exit 0 |
| 1 | CORE-01 | REVIEWED_AUTO | 见会话日志 | 逐AC证据全；kernel 4文件77测试复跑 exit 0 |
| 1 | CORE-02 | REVIEWED_AUTO | 见会话日志 | 逐AC全；SPEC状态行"未开始"已补正 |
| 1 | CORE-03 | REVIEWED_AUTO | 见会话日志 | 编排统一门禁；自测16文件/189，范围复跑绿 |
| 1 | CORE-04 | REVIEWED_AUTO | 见会话日志 | 行数漂移：报告65/57 vs 实际73/74（≤150门限仍满足），已记录 |
| 1 | CORE-05 | REVIEWED_AUTO | 见会话日志 | cloudTtsOutput补齐有据；真实云TTS NOT RUN |
| 1 | CORE-06 | REVIEWED_AUTO | 见会话日志 | legacy无生产残留（grep核实）；AC-C基线对比口径弱（vs CORE-05 160→151），已记录 |
| 1 | CORE-07 | REVIEWED_AUTO | 见会话日志 | 突变验证有效；报告退出码笔误已更正；补齐动生产代码与SPEC"不做"条款冲突（报告已自认）；ContextSource仅1真实实现证据弱 |
| 1 | CORE-08 | REVIEWED_AUTO | 见会话日志 | deleteMessages端口contracts.ts:51核实；真实plugin-sql留INT-01 |
| 1 | CORE-09 | REVIEWED_AUTO | 见会话日志 | src/kernel 77测试绿；SPEC证据列plugin.test.ts未在报告出现（小出入） |
| 1 | LLM-01 | REVIEWED_AUTO | 见会话日志 | D=REAL RUN 30/30 协议过，6条质量失败待修（REAL RUN/REVIEW REQUIRED）；SPEC状态行已补正 |
| 1 | LLM-02 | REVIEWED_AUTO | 见会话日志 | 真实模型样本与Hook接入 NOT RUN；SPEC状态行已补正 |
| 1 | LLM-03 | REVIEWED_AUTO | 见会话日志 | 真实SQLite+qwen 10/10 REAL RUN；报告陈旧BLOCKED段已标注作废；FTS trigram 2字词局限已记录 |
| 1 | LLM-06 | REVIEWED_AUTO | 见会话日志 | 5处突变命中；真实plugin-sql留INT-01 |
| 1 | LLM-07 | REVIEWED_AUTO | 见会话日志 | 协议字段搬迁已声明并记契约；真实Tauri留INT-01 |
| 1 | LLM-08 | REVIEWED_AUTO | 见会话日志 | 3处突变命中；AC-D用例理由被自查修正（如实） |
| 1 | LLM-09 | REVIEWED_AUTO | 见会话日志 | 真实模型退化率 NOT RUN |
| 1 | LLM-10 | REVIEWED_AUTO | 见会话日志 | DeepSeek真实样本1家；另3协议fixture；突变计数8→9已更正 |
| 1 | STT-01 | REVIEWED_AUTO | d78afe3 后批次 | 复核补证报告已写；49/118 测试实跑全绿；真机 NOT RUN |
| 1 | STT-02 | REVIEWED_AUTO | d78afe3 后批次 | 复核补证报告已写；76 测试全绿；clearPending 幂等证据弱（已标注） |
| 1 | STT-04 | REVIEWED_AUTO | 见会话日志 | 报告逐 AC 齐全+8条突变；真机归 STT-03；索引状态已更新 |
| 1 | TTS-01 | REVIEWED_AUTO | d78afe3 后批次 | 复核补证报告已写；54/118 测试全绿 |
| 1 | TTS-02 | REVIEWED_AUTO | d78afe3 后批次 | 复核补证报告已写；输出契约 12 例全绿；真实音频 NOT RUN |
| 1 | FE-01 | REVIEWED_AUTO | 见会话日志 | 复核补证报告：状态层 PASS（143 测试范围全绿）；页面视觉 NOT RUN |
| 1 | FE-02 | REVIEWED_AUTO | 见会话日志 | 复核补证报告；键盘/窄屏 AC-C 留人工队列 |
| 1 | FE-03 | REVIEWED_AUTO | 见会话日志 | 复核补证报告；浏览器截图 NOT RUN |
| 1 | FE-04 | REVIEWED_AUTO | 见会话日志 | 报告逐AC全；真实模型目视 NOT RUN |
| 1 | FE-05 | REVIEWED_AUTO | 见会话日志 | MessageRetry.tsx 已被 FE-06 删除无事后注记（记录） |
| 1 | FE-06 | REVIEWED_AUTO | 见会话日志 | 撤回无撤销确认等弱项如实 |
| 1 | FE-07 | REVIEWED_AUTO | 见会话日志 | fake引擎只证顺序状态；真实声音 NOT RUN |
| 1 | FE-08 | REVIEWED_AUTO | 见会话日志 | skipped=crossSession.real（环境变量）属实 |
| 1 | FE-09 | REVIEWED_AUTO | 见会话日志 | PASS表早于冒烟修复的状态滞后已由报告加注；基线漂移+10无解释（记录） |
| 1 | FE-10 | REVIEWED_AUTO | 见会话日志 | SVG观感/真实轮次 NOT RUN |
| 1 | FE-11 | REVIEWED_AUTO | 见会话日志 | 桌面SQLite NOT RUN |
| 1 | FE-12 | REVIEWED_AUTO | 见会话日志 | 门禁为文本判定；基线漂移+15无解释（记录） |
| 1 | FE-13 | REVIEWED_AUTO | 见会话日志 | 唯一缺全量回归的报告（已记录）；浏览器闩锁复现有力 |
| 2 | INT-01 可自动消费者检查 | PARTIAL | 见会话日志 | 自动契约列 PASS（109 测试 exit 0）；浏览器/Tauri/手机/真实Provider 四列 NOT RUN 留人工队列 |
| 3 | LLM-04 后台写回 | AUTO_PASS（fixture） | 见会话日志 | MemoryMaintenance 重写+计量埋点；274 回归全绿 tsc 0；真实服务 NOT RUN |
| 3 | LLM-05 RAG | PARTIAL | 见会话日志 | A/B/C/E 全过（15/15 命中）；AC-D 真实模型 NOT RUN 无凭证；装配点改 contextSourcesPlugin |
| 3 | TTS-04 设置与错误传播 | AUTO_PASS（待人工） | 见会话日志 | 设置端口/切引擎停队列/降级可见全过；SpeechEngines 接口破坏性扩展（消费者已同步） |
| 3 | LLM-11 上下文快照 | AUTO_PASS（待人工） | 见会话日志 | context_snapshot 事件+装配期诊断+唯一脱敏点；穷举消费者已同步；516 回归全绿 |
| 3 | FE-23 时间线 | AUTO_PASS（待人工） | 见会话日志 | 订阅先行合并/隔离/设置联动全过；目视留人工 |
| 3 | FE-24 实时浮层 | NOT RUN | | **下一节点**；依赖 FE-23 |
| 3 | FE-25 上下文视图 | NOT RUN | | 依赖 FE-24 |
| 3 | LLM-12 用量台账 | NOT RUN | | LLM-04/10 后 |
| 3 | FE-26 成本页 | NOT RUN | | 硬前置 LLM-12 |
| 4 | RT-01 契约 | NOT RUN | | |
| 4 | RT-02 身份隔离 | NOT RUN | | 生产 Runtime scope 隔离 |
| 4 | RT-03 权限 | NOT RUN | | RT-03 前置于 AGT |
| 4 | RT-04 来源 | NOT RUN | | |
| 4 | GW-01 | NOT RUN | | |
| 4 | GW-02 | NOT RUN | | |
| 4 | GW-03 语音文件 | NOT RUN | | 解码/重采样端口 |
| 5 | FE-14 白名单投影 | NOT RUN | | |
| 5 | FE-17-pre | NOT RUN | | |
| 5 | FE-15 | NOT RUN | | |
| 5 | FE-17-host/tauri | NOT RUN | | |
| 5 | GW-04 | NOT RUN | | 只消费 pre+tauri 门禁 |
| 5 | FE-16 | NOT RUN | | |
| 5 | FE-17-host/dev-relay | NOT RUN | | 独立分支 |
| 6 | AGT-01 Session/Run | NOT RUN | | |
| 6 | AGT-02 | NOT RUN | | 真实拒绝写负例 |
| 6 | AGT-03 | NOT RUN | | |
| 6 | AGT-04 | NOT RUN | | |
| 6 | AGT-05 任务入口 | NOT RUN | | 从实际任务入口验收 |
| 7 | INT-04 fixture 轨 | NOT RUN | | 真实轨 BLOCKED-需授权 |
| 7 | RT-05 | NOT RUN | | |
| 7 | RT-06 | NOT RUN | | |
| 7 | GW-05 | NOT RUN | | |
| 7 | GW-06 | NOT RUN | | |
| 8 | 汇总 + 相关回归 | NOT RUN | | 本轮相关全量 test/build 一次 |
| 8 | INT-03 发布门禁 | NOT RUN | | 发布前另安排，非本轮 |

后置不动：FE-18～22、STT-03、TTS-03、INT-02、Live2D/Stage3/云Relay/原生Android/Push/Discovery。INT-03 发布前完整门禁不进本轮自动队列。

## 人工补验队列（持续追加）

见执行计划「人工补验清单」：INT-01 桌面/SQL/Remote/生产默认值/F1；LLM 真实质量；STT-03/TTS-03/INT-02/TTS-05；Inspector 浮层拖拽并行；v0.5 配对撤权/真实渠道/ACP 权限拒绝取消/INT-04 真实轨；INT-03。每项在报告写可复现步骤与预期结果。

## 会话日志

- 2026-09-13 02:22 Wave 0 完成：基线 `049372f`；speechOutput 12/12 exit 0。
- 2026-09-13 02:30 Wave 1 CORE-01～09 REVIEWED_AUTO：Explore 审阅 8 份 SPEC/报告逐 AC 证据 + 生产抽查（legacy 无生产残留、activeRuntime.ts 已删、CONTRACTS 含内核契约）；合集定向测试 `npx vitest run src/kernel src/app src/presentation src/hooks src/services/{storage,runtime,context,memory,voice}` → 41 文件 / 491 测试全绿 exit 0。修 CORE-02 SPEC 状态行、CORE-07 报告退出码笔误。CORE 批次 commit `eba6e3c`。
- 2026-09-13 02:38 Wave 1 LLM-01～03/06～10 REVIEWED_AUTO：Explore 审阅 8 份 + 生产符号核实（ProviderUsage/extractUsage/reportedTotal/isSameSentence/describeChatRequest 等）；定向 `npx vitest run src/domain src/services/trace src/services/context src/services/providerClient.test.ts` → 36 文件 / 511 测试 exit 0。修 LLM-01/02 SPEC 状态行、LLM-10 突变计数、LLM-03 报告陈旧 BLOCKED 段。LLM-01-D 的 6 条真实模型质量失败留给 Prompt 修复项（不阻塞后续 SPEC）。
- 2026-09-13 02:45 Wave 1 STT-01/02/04、TTS-01/02：Explore 初报漏检 STT-02 实现，本人复核确认 vadSegmenter/asrSegments/turnEnd/voicePresenter 管线齐全且被生产消费；实跑 voice+language 118 例、STT 定向 76 例、输出契约 12 例、TTS 54 例全 exit 0。新写 4 份复核补证报告（stt/reports/STT-01、STT-02，tts/reports/TTS-01、TTS-02），更新 stt/tts 索引状态（STT-04 → REVIEWED_AUTO）。证据弱项如实标注：clearPending 幂等、全失败不称成功、重复 dispose。
- 2026-09-13 02:52 Wave 1 FE-01～13：Explore 审阅 10 份报告（AC 证据链完整，突变自查诚实）+ 组件/页面核实；新写 FE-01/02/03 复核补证报告；实跑 `npx vitest run src/hooks src/presentation src/domain/conversation.test.ts src/domain/captionHighlight.test.ts` → 10 文件 / 143 测试 exit 0。更新 FE 索引 13 行状态。共性弱项：界面 AC 以"组件只转发"替代 DOM 证据、真机 NOT RUN 归 INT-01/03；FE-09/10/12 基线计数漂移、FE-13 缺全量回归，均记录。**Wave 1 全部完成。**
- 2026-09-13 02:55 Wave 2 INT-01：写 reports/INT-01_ACCEPTANCE.md（分列）；实跑 composition/remote/storageCompatibility/storage.conformance/companionRuntime/useCompanionSession.integration → 6 文件 / 109 测试 exit 0。结论 PARTIAL：自动契约列 PASS；浏览器页面、Tauri plugin-sql、真实手机、真实 Provider 四列 NOT RUN。旧版 Remote 基线可作 RT-02 之前的本地前置。
- 2026-09-13 03:23 Wave 3 LLM-04 AUTO_PASS（fixture）：重写 services/memory/writeback.ts 为 MemoryMaintenance（批次快照/稳定ID/单worker/退避1s→30s×3/epoch作废/journal KV持久化/8轮阈值/容量上限），新增 maintenanceJournal.ts、RequestMetric 计量埋点（providerClient/extractor/adapter），presenter 切换装配。回归 274 passed+1 skipped exit 0，项目 tsc 0 错误。报告 LLM-04_AGENT_MEMORY_WRITEBACK_ACCEPTANCE.md。注意：dispose 不异步 flush（SPEC 接受 <8 轮窗口丢失）；hook 集成测试注入阈值 1 保持重试语义。
- 2026-09-13 04:05 Wave 3 LLM-05 PARTIAL：新增 domain/knowledge + knowledgeIndex（staging/原子激活/FTS 召回+TS BM25/缓存/降级）+ knowledgeSource + contextSourcesPlugin 唯一装配点；memoryPlugin 不再提供 ContextSourcesToken。冻结语料 15/15 命中、5 无答案空命中；回归 154 测试全绿 tsc 0；矩阵/plugins/hook 消费者同步更新。AC-D 真实模型 NOT RUN。
- 2026-09-13 04:30 Wave 3 TTS-04 AUTO_PASS（待人工）：outputSettings 端口（Key 进 SecretStore、空=保持、显式删除）、SpeechEngines.output/resolveOutput 扩展、voicePresenter.applyVoiceOutput（停旧队列+世代隔离）、companionPresenter.setVoiceOutput + App 设置表单。定向 8 例 + 回归 233 全绿，tsc 0。UI 视觉/真实试听留人工/TTS-05。
- 2026-09-13 04:52 Wave 3 LLM-11 AUTO_PASS（待人工）：trace 新增 context_snapshot（字段冻结），contextAssembler.includeDiagnostics 装配期采集（kept/trimmed 同源、截断如实记录），companionRuntime 记录（record 前复核开关），脱敏走唯一 redactTraceEvent（canary 实测）；pluginGraph/traceView/TracePage 穷举更新。回归 516 全绿 tsc 0。**下一节点：FE-23 时间线（消费 LLM-11）→ FE-24 → FE-25；再 LLM-12→FE-26。**
- 2026-09-13 05:10 Wave 3 FE-23 AUTO_PASS（待人工）：observableSink（逐监听器独立副本+双重异常隔离）、inspectorPresenter（订阅先行→缓冲→tail 合并、turnId+seq 去重、50轮/5000条/512KB 淘汰、session 作废迟到查询、设置联动：关→退订清视图/重开→恢复、includeText 重投影）、LiveInspector 浮层外壳。184 回归全绿 tsc 0。**下一节点：FE-24 → FE-25；再 LLM-12→FE-26。**
