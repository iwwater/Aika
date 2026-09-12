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
| 1 | CORE-01 | NOT RUN | | 审生产实现+逐AC证据 |
| 1 | CORE-02 | NOT RUN | | |
| 1 | CORE-03 | NOT RUN | | 编排统一门禁 |
| 1 | CORE-04 | NOT RUN | | |
| 1 | CORE-05 | NOT RUN | | |
| 1 | CORE-06 | NOT RUN | | |
| 1 | CORE-07 | NOT RUN | | |
| 1 | CORE-08 | NOT RUN | | |
| 1 | CORE-09 | NOT RUN | | |
| 1 | LLM-01 | NOT RUN | | |
| 1 | LLM-02 | NOT RUN | | |
| 1 | LLM-03 | NOT RUN | | |
| 1 | LLM-06 | NOT RUN | | |
| 1 | LLM-07 | NOT RUN | | |
| 1 | LLM-08 | NOT RUN | | |
| 1 | LLM-09 | NOT RUN | | |
| 1 | LLM-10 | NOT RUN | | DeepSeek 真实样本仅此一家 |
| 1 | STT-01 | NOT RUN | | 缺早期报告则据实补 |
| 1 | STT-02 | NOT RUN | | |
| 1 | STT-04 | NOT RUN | | |
| 1 | TTS-01 | NOT RUN | | |
| 1 | TTS-02 | NOT RUN | | |
| 1 | FE-01 | NOT RUN | | |
| 1 | FE-02 | NOT RUN | | |
| 1 | FE-03 | NOT RUN | | |
| 1 | FE-04 | NOT RUN | | |
| 1 | FE-05 | NOT RUN | | |
| 1 | FE-06 | NOT RUN | | |
| 1 | FE-07 | NOT RUN | | |
| 1 | FE-08 | NOT RUN | | |
| 1 | FE-09 | NOT RUN | | |
| 1 | FE-10 | NOT RUN | | |
| 1 | FE-11 | NOT RUN | | |
| 1 | FE-12 | NOT RUN | | |
| 1 | FE-13 | NOT RUN | | |
| 2 | INT-01 可自动消费者检查 | NOT RUN | | 真实 Tauri/SQL/手机留人工槽 |
| 3 | LLM-04 后台写回 | NOT RUN | | 队列原子性/epoch |
| 3 | LLM-05 RAG | NOT RUN | | |
| 3 | TTS-04 设置与错误传播 | NOT RUN | | |
| 3 | LLM-11 上下文快照 | NOT RUN | | |
| 3 | FE-23 时间线 | NOT RUN | | 依赖 LLM-11 |
| 3 | FE-24 实时浮层 | NOT RUN | | 依赖 FE-23 |
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
