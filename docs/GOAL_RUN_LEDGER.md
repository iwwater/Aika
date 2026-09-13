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
| 3 | FE-24 实时浮层 | AUTO_PASS（待人工） | 见会话日志 | 时间线宁缺毋假/导出逐字节一致全过；目视留人工 |
| 3 | FE-25 上下文视图 | AUTO_PASS（待人工） | 见会话日志 | 布局三态/不回查存储/turnFlow 一致性全过 |
| 3 | LLM-12 用量台账 | AUTO_PASS（待人工） | 见会话日志 | UsageRecordV1+双 store 同用例包+recorder 采集；门禁违规（providerClient 调用方）重构修复；定向 98+全量 1104 全绿 tsc 0；真实计费 NOT RUN |
| 3 | FE-26 成本页 | AUTO_PASS（待人工） | 见会话日志 | usageStats 纯函数+OpsPresenter+工作台成本页签；幂等/分页覆盖/时区/未知语义/币种/错误率/最慢尝试全过；1133 回归全绿 tsc 0；真实费用 NOT RUN |
| 4 | RT-01 契约 | AUTO_PASS（待人工） | 见会话日志 | SourceEnvelope（trust brand 型约束）+身份六类型+能力矩阵+HostLifecycle+facade 门禁；零生产源码改动；20 定向+1151 全量全绿 tsc 0；真实宿主回归 NOT RUN |
| 4 | RT-02 身份隔离 | AUTO_PASS（待人工） | 见会话日志 | 绑定服务+scopedStorage 视图+Runtime 单生成槽/有界队列/按会话 revision+存储 scope 列（try-ALTER 12→16）+memorySource 授权门；真实双主体隔离测试过；真实 Tauri 迁移 NOT RUN |
| 4 | RT-03 权限 | AUTO_PASS（待人工） | 见会话日志 | 决策/执行两终态+原子认领+重启不自动批准+deny-all fail-closed+审计脱敏+Windows 路径边界（junction/TOCTOU 注入防线）；25 定向/1193 全量全绿 tsc 0；真实执行入口 NOT RUN |
| 4 | RT-04 来源 | AUTO_PASS（待人工） | 见会话日志 | MemorySourceKind 信任分级扩展+mayElevateToConfirmed/mayFeedUserSoul 门+writeback authorizeWriteback 提交前重查（denied 可见）；11 定向/1204 全量全绿 tsc 0；真实渠道写回 NOT RUN |
| 4 | GW-01 | AUTO_PASS（待人工） | 见会话日志 | 版本化判别联合+inbox 去重/六态+outbox 重试上限/unknown 终态+目的地绑定+每会话串行链+窄端口；8 定向/1212 全量全绿 tsc 0；真实适配器 NOT RUN |
| 4 | GW-02 | NOT RUN | | |
| 4 | GW-03 语音文件 | NOT RUN | | 解码/重采样端口 |
| 5 | FE-14 白名单投影 | AUTO_PASS（待人工） | 见会话日志 | outbound contracts/gateway/plugin/conformance：白名单投影、cursor 单调+epoch、重放去重、trace 四门、慢消费者限额、两处突变命中；11 定向/1237 全量全绿 tsc 0；真实传输 NOT RUN |
| 5 | FE-17-pre | NOT RUN | | |
| 5 | FE-15 | PARTIAL（待人工） | 见会话日志 | A 过：tauriTransport 桥 invoke/listen 复跑 FE-14 conformance 六用例；B/C/D/E（Rust handler/手机页）NOT RUN 需真实宿主 |
| 5 | FE-17-host/tauri | NOT RUN | | |
| 5 | GW-04 | AUTO_PASS（待人工） | 见会话日志 | deviceRegistry（能力交集协商/租约读时计算/reconnect epoch+cursor 窗口/trace 审批独立授权口默认拒）；27 定向/1255 全量全绿 tsc 0；真实设备端到端 NOT RUN |
| 5 | FE-16 | NOT RUN | | |
| 5 | FE-17-host/dev-relay | NOT RUN | | 独立分支 |
| 6 | AGT-01 Session/Run | AUTO_PASS（待人工） | 见会话日志 | Session/Run 状态机分离+startRequestId 幂等+取消宽限/强制结束+recover interrupted+有界脱敏日志；6 定向/1261 全量全绿 tsc 0；真实 ACP adapter NOT RUN |
| 6 | AGT-02 | AUTO_PASS（待人工） | 见会话日志 | acpProtocol（分帧/重组/超大/进程配置白名单+环境最小化+capability 只宣告 prompt）+ acpClient（initialize/session-new/prompt/cancel 映射、permission 原 id+有效 optionId、六类终态不悬空）；16 定向/1271 全量全绿 tsc 0；真实进程/Job Object NOT RUN |
| 6 | AGT-03 | AUTO_PASS（fixture 轨，待人工） | 见会话日志 | adapterManifest（版本固定拒绝 latest/权限模式/capabilities 白名单）+probeStartup（退出码/版本/不自动安装）+canary 临时仓库（deny-writes 哈希不变负例+收敛）；6 定向/1277 全量全绿 tsc 0；真实 Codex NOT RUN |
| 6 | AGT-04 | AUTO_PASS（fixture 轨，待人工） | 见会话日志 | adapterRegistry（codex+claude 独立 manifest/认证槽隔离/失败隔离不自动切换/坏 manifest 拒绝）；26 定向/1281 全量全绿 tsc 0；真实 Claude 适配器 NOT RUN |
| 6 | AGT-05 | AUTO_PASS（待人工） | 见会话日志 | TaskCommand facade（/agent 结构化命令+workspaceRef 白名单+重放去重+审批单次绑定凭据+进度节流/完成去重/投递失败旁路化+同 runId 共享）；5 定向/1286 全量全绿 tsc 0；端到端真实链路归 INT-04 |
| 7 | INT-04 fixture 轨 | PARTIAL（待人工） | 见会话日志 | fixture 轨 AUTO_PASS：负例先行（未批准/错用户/取消/重启/deny-writes）+ 双成功链路矩阵（Telegram×Codex、Device×Claude）+ 前后 diff/外文件哨兵不变/同 runId；真实轨 NOT RUN-需授权 |
| 7 | RT-05 | AUTO_PASS（待人工） | 见会话日志 | persistentScheduler（time/interval/event 三触发、misfire skip 不补跑、幂等触发键、到期权限重查 fail-closed、unknown 不重放、重试 3 次退避、容量上限、暂停/恢复/取消、坏时区 unsupported）；8 定向/1301 全量全绿 tsc 0；真实宿主长跑 NOT RUN |
| 7 | RT-06 | AUTO_PASS（待人工） | 见会话日志 | deliveryPolicy（群私提醒 drop/未授权 drop/冷却 key 持久化/quietHours defer 不按 urgency 绕过/registerOutboxItem 完成事件去重）；5 定向/1306 全量全绿 tsc 0；真实渠道发送 NOT RUN |
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
- 2026-09-13 05:18 Wave 3 FE-24 AUTO_PASS（待人工）：buildTurnTimeline（真实配对才给耗时、负差 null、重复吞掉、缺 turn_end=running）、inspectorPresenter 选中轮/时间线/导出（与页面投影逐字节一致 + coverageNote）、LiveInspector 时间线与详情渲染。170 回归全绿 tsc 0。**下一节点：FE-25；再 LLM-12→FE-26。**
- 2026-09-13 05:28 Wave 3 FE-25 AUTO_PASS（待人工）：domain/contextLayout（逻辑块顺序、kept/trimmed/notRetrieved 三态、content=null 不回查、缺快照 supported=false）、LiveInspector 上下文 pane。577 回归全绿 tsc 0。**下一节点：LLM-12 用量台账 → FE-26 成本页。**
- 2026-09-13 06:06 Wave 3 LLM-12 AUTO_PASS（待人工）：domain/usageLedger（UsageRecordV1/coverage 三态/legacy scope）+ usage 服务（sqlite/memory 双 store 同用例包、recorder 采集：per-attempt started/终态幂等 upsert、Trace enabled 同源门控、写失败旁路化+有界队列+诊断）+ providerClient onRequestUsage 样本通道（4xx 重试/fallback/断流各自取证；purpose 缺省 foreground→unknown 属契约修正）+ adapter（proactive/foreground）与 extractor（maintenance/summary）真实接线 + usagePlugin 装配。architecture 门禁（providerClient 调用方白名单）曾违规，重构为 domain 样本类型+结构切片+泛型 observe 后恢复。定向 98/受影响回归 273/全量 1104 全绿，tsc 0。真实计费 NOT RUN。**下一节点：FE-26 成本页（消费 LLM-12）→ Wave 4（RT-01~04、GW-01~03）。**
- 2026-09-13 06:47 Wave 3 FE-26 AUTO_PASS（待人工）：domain/usageStats（attemptId 幂等、错误率 failed/(completed+failed) 且取消/无终态另计、coverage 分布、missingPurposes 未采集≠0、时区日界线 localDayKey、版本化价目按生效日匹配、币种分列不换算、SPEC 算例 0.006、慢尝试只取完整计时）+opsPresenter（cursor 翻页+coverageNote、价目 KV 持久化/校验拒绝/失败回滚/损坏明说、采集关闭标注）+ OpsPage/工作台成本页签 + UsageLedgerStoreToken 只读端口。修复 presentationPlugin 漏声明 optional 触发 DEPENDENCY_NOT_DECLARED 拒启动（门禁按设计工作）。定向 29/全量 1133 全绿 tsc 0。**Wave 3 全部节点完成。下一节点：Wave 4 RT-01（契约）。**
- 2026-09-13 07:02 Wave 4 RT-01 AUTO_PASS（待人工）：domain/sourceEnvelope（SourceEnvelope v1、trust authenticated 带不导出 brand 只留认证端口构造、desktop 适配 local 主体、历史消息 unknown+unverified 不伪造归属、messageDedupeKey、legacySourceOrigin 只加映射）+ domain/identity（identity/conversation/thread/runtimeTurn/agentSession/deviceSession 六类型 + HostCapabilityMatrixV1/buildCapabilityMatrix 投影）+ services/runtime/hostLifecycle（可注入心跳/租约三态 online/offline/recovering，markStopping 立即 offline，重启换 epoch）+ app/runtimeFacade.test（RuntimeToken/companionRuntime 生产 import 白名单门禁）。旧 submit/cancel/存储契约零改动（AC-A 由既有套件+全量回归证明）。20 定向/1151 全量全绿 tsc 0。真实宿主关窗/重启 NOT RUN（INT-01 真实轨）。**下一节点：RT-02 身份隔离（必须验证生产 Runtime 的历史/摘要/取消隔离）。**
- 2026-09-13 07:32 Wave 4 RT-02 AUTO_PASS（待人工）：domain/identity 增 AccountKeyV1/ConversationScopeV1/canonical 键 + ChatMessage/SessionSummary.conversationId（NULL=legacy 本地）+ 存储 scope 参数（sqlite try-ALTER 12→16 + localStorage 同语义）+ services/identity/binding（一次性/限期/防暴力/解绑即失效/损坏 fail-closed）+ scopedStorage 视图 + Runtime 多会话化（scope 提交时固定、每会话 revision、单生成槽 settled+落库完成才换 scope、同会话保留立即接管旧时序、跨会话有界队列 SESSION_QUEUE_FULL、cancel 归属校验、dispose 全收敛）+ contextAssembler/memorySource 透传 principal 授权门 + TraceEventBase.conversationId。RT-02-E 用真实生产 Runtime+真实 SQLite 双主体隔离（历史/摘要/关系信号/取消/旧记录/排队 0 串线）。1168 全量全绿 tsc 0。真实 Tauri 迁移/真实渠道 NOT RUN。**下一节点：RT-03 权限（Permission Runtime 与审批状态机）。**
- 2026-09-13 08:05 Wave 4 RT-03 AUTO_PASS（待人工）：domain/permission（PermissionRequestV1 绑定 principal/conversation/agentSession/workspace/policyVersion/expiresAt/nonce；paramsDigestOf 摘要；checkPathBoundary：..逃逸/相邻前缀/大小写/UNC/换盘/realPathOf 注入 junction-TOCTOU 防线，解析失败即拒）+ permissionStore（内存原子 check-and-set+KV 持久化，重启 pending 不自动批准）+ permissionPolicy（read 放行/write-execute-external 审批/危险名单拒绝/群聊不可批高权限/createDenyAllPolicy fail-closed）+ permissionRuntime（approve-reject-cancel pending 限定、requestCancelAfterApproval 不回滚决定只标记、authorizeExecution 最终检查+原子认领恰好一次、audit 仅摘要无原始参数）。25 定向/1193 全量全绿 tsc 0。真实宿主执行入口 NOT RUN（AGT-02/GW 前置）。**下一节点：RT-04 来源与记忆写回信任边界。**
- 2026-09-13 08:32 Wave 4 RT-04 AUTO_PASS（待人工）：domain/memory 的 MemorySourceKind 扩展为信任分级（messages/external-bound/untrusted-material/legacy/userEdit，TEXT 零迁移）+ mayElevateToConfirmed（模型候选永不自行提升）+ mayFeedUserSoul（明确归属+经人确认，外部与不可信材料即使人工确认也不入本地画像）+ sourceKindForOrigin（群聊/Agent/引文/unknown 一律 untrusted-material）+ sqlite 读取白名单/管理页标签同步 + writeback.authorizeWriteback 提交前重查（解绑/撤权批次丢弃不重试、denied 计数可见、无钩子=旧行为）。11 定向/1204 全量全绿 tsc 0。真实渠道写回 NOT RUN。**下一节点：GW-01 渠道契约。**
- 2026-09-13 08:58 Wave 4 GW-01 AUTO_PASS（待人工）：domain/gateway（判别联合 text/voice/image/file/command、inboxKeyOf 平台账户+会话+messageId、六态 inbox、四态 outbox、附件 20MB/白名单校验）+ channelGateway（先持久接收再提交、running 崩溃→unknown 不自动重跑、每会话串行链有序、回信目的地绑定原请求、retry-after+重试上限 3、unknown 不确认不盲目重试、适配器只见三窄端口）。8 定向/1212 全量全绿 tsc 0。真实 Telegram 等适配器 NOT RUN（GW-02，需授权）。**下一节点：GW-02 渠道适配器（真实轨需授权，先做 fixture 轨）。**

- 2026-09-13 10:12 Wave 5 FE-14 AUTO_PASS（待人工）：services/outbound（contracts 版本化帧/命令/主体；outboundGateway 白名单投影+turnId 目标映射未映射零外发+cursor epoch 单调+命令校验矩阵+重放去重+trace 四门+慢消费者限额；plugin transport 缺失启动不受阻、无授权端口不接命令 fail-closed；conformance 包六用例供 FE-15/16 复用）。突变验证两处（投影放行 memoryCandidates、cursor 恒 1）均被定向用例命中后恢复。11 定向/1237 全量全绿 tsc 0。真实传输 NOT RUN（FE-15/16）。
- 2026-09-13 10:47 Wave 5 FE-17-pre AUTO_PASS（pre 步骤，待人工）：services/outbound/credentials（配对码 TTL5min/原子单次兑换/哈希存储/损坏 fail-closed；设备会话 device+principal 归属、逐设备 rotate/revoke、撤销即时生效共用 authenticate 门）+ exposurePolicy（三层暴露、所有层私有数据需认证、publicTlsAck 不构成证据 public 恒 blocked、路由白名单 SQL/秘密永不进网关、Origin fail-closed/cookie+CSRF/Bearer）。18 定向/1244 全量全绿 tsc 0。tauri/dev-relay NOT RUN；public BLOCKED。**下一节点：FE-15 Tauri HTTP 传输（Rust handler+手机页）——本地可做部分优先；GW-04 不等无关分支。**
- 2026-09-13 12:46 Wave 6 AGT-01 AUTO_PASS（待人工）：domain/agentSession（Session starting/ready/busy/closed/failed 与 Run 九态分离、isTerminalRun、startRequestId 幂等键、脱敏事件）+ services/agent/agentSessionManager（spawn/send/cancel/resolveApproval/provideInput/recover：并发上限 1+有界队列、Run 时间预算、取消幂等+协议取消→中止流→有界宽限→forceEnd 留实际状态、waiting_approval/waiting_input 显式转换、recover 标 interrupted、日志有界且 prompt 只留摘要）。6 定向/1261 全量全绿 tsc 0。真实 ACP adapter NOT RUN（AGT-03）。**下一节点：AGT-02 权限集成（waiting_approval 接 RT-03）。**
- 2026-09-13 13:22 Wave 6 AGT-02 AUTO_PASS（待人工）：services/agent/acpProtocol（parseAcpStream 分包重组+malformed/oversized、validateProcessConfig 可执行白名单+空白名拒（shell 拼接信号）+args 数组+cwd checkPathBoundary+环境最小化、ADVERTISED_CAPABILITIES 只宣告 prompt、buildPermissionResponse 原 id+有效 optionId/denyOptionId 协议拒绝选项）+ acpClient（pending 先注册再写 stdin；initialize 版本不符终态；session/prompt stopReason 结束 Run 不销毁 Session；session/cancel 真实映射；进程退出/stdin 失败 failed 终态不悬空；失败事件 yield 交付）。16 定向/1271 全量全绿 tsc 0。真实 ACP 进程/Windows Job Object/真实只读验证 NOT RUN。**下一节点：AGT-03 AgentRunManager 与审批联动（真实轨需授权）。**
- 2026-09-13 13:58 Wave 6 AGT-03 AUTO_PASS（fixture 轨，待人工）：services/agent/adapterManifest（AgentAdapterManifestV1 版本化 manifest：固定版本拒绝 latest、permissionMode deny-writes/ask/allow、authMethod、capabilities 白名单+unsupported 明细；probeStartup 注入版本命令 runner 三态不自动安装；createCanaryRepo 临时仓库哈希取证）。deny-writes fake adapter 拒绝写后 canary 文件哈希不变+进程收敛（该负例证据不证明全系统沙箱）。6 定向/1277 全量全绿 tsc 0。真实 Codex 进程/账户/预算 NOT RUN（需授权）。**下一节点：AGT-04 权限与工具策略。**
- 2026-09-13 14:26 Wave 6 AGT-04 AUTO_PASS（fixture 轨，待人工）：services/agent/adapterRegistry（codex+claude 双 manifest 独立认证槽——Anthropic 普通 API key 不是适配器登录态；选择适配器不改会话/权限语义；isolateFailure 一适配器失败不自动切换另一收费 Agent；未知/坏 manifest 负例）。26 定向/1281 全量全绿 tsc 0。真实 Claude 适配器 NOT RUN。**下一节点：AGT-05 任务入口（从实际任务入口验收）。**
- 2026-09-13 14:58 Wave 6 AGT-05 AUTO_PASS（待人工）：services/agent/taskCommand（TaskCommand 用户发起入口：/agent 结构化命令 agent.spawn/send/cancel/permission.respond、workspaceRef 服务端白名单别名+授权主体核验（body 不接受任意本地路径）、spawn 按 主体+会话+startRequestId 重放去重、审批卡单次绑定凭据 TTL10min（其他用户/群/伪造/过期/重放 0 执行）、notifyProgress 节流 5s、notifyCompletion 按 runId+终态去重且投递失败旁路化不改真实终态、runs() 同 runId 供 PC 面板与远程 session 共读）。AC-E 生产 parser→facade→生产 manager（fake adapter）真正 spawn 一次。5 定向/1286 全量全绿 tsc 0。端到端真实链路归 INT-04。**Wave 6 全部节点完成。下一节点：Wave 7 INT-04 fixture 轨。**
- 2026-09-13 15:42 Wave 7 INT-04 PARTIAL（fixture 轨 AUTO_PASS，待人工）：services/agent/int04.fixture.test——完整 fixture 链路从生产 TaskCommand 入口（不绕 parser/认证/路由）到 canary 临时仓库受控修改再到原渠道结果投递；负例先行（未批准/错误用户/取消收敛/重启 interrupted/deny-writes 批准也不写）；入口×适配器矩阵 Telegram×Codex 与 Device×Claude 两条完整成功链路（未跑组合如实记录）；前后 diff、仓库外哨兵哈希不变、PC 视图同 runId。7 定向/1293 全量全绿 tsc 0。真实轨（真实 diff+测试退出码）NOT RUN-需授权；INT-03 发布门禁独立完成。**下一节点：RT-05 持久 Scheduler。**
- 2026-09-13 16:31 Wave 7 RT-05 AUTO_PASS（待人工）：services/runtime/persistentScheduler（trigger 三类建模 time/interval/event；任务字段 id/owner/scope/timeZone/nextRunAt/misfirePolicy/enabled/attempts/executionKey/state；misfire 默认 skip 不补跑；幂等触发键同键只执行一次；到期执行前 authorize 重查 fail-closed；unknown 副作用不自动重放；可确认失败重试至多 3 次指数退避；容量 200；暂停/恢复/取消；KV 持久化重启不重放已消费任务、损坏按空 fail-closed；坏时区 unsupported 不硬编码本地时区）。8 定向/1301 全量全绿 tsc 0。真实宿主长跑 NOT RUN。**下一节点：RT-06 跨渠道主动投递策略。**
- 2026-09-13 17:14 Wave 7 RT-06 AUTO_PASS（待人工）：services/runtime/deliveryPolicy（evaluate：群组永不接私人提醒 drop、未授权目标 drop、quietHours 按本地小时 defer/异常过长丢弃、冷却 key=主体+事件类型+目标且 state 持久化重启不清零；registerOutboxItem 同完成事件多次到达只一项 outbox；审批请求不按 urgency 绕过 quietHours——审批走 RT-03；markDelivered 只写冷却）。5 定向/1306 全量全绿 tsc 0。真实渠道发送 NOT RUN（GW-02 真实轨）。**下一节点：GW-05 飞书适配（fixture 轨）。**
- 2026-09-13 12:05 Wave 5 GW-04 AUTO_PASS（待人工）：services/gateway/deviceRegistry（能力=服务端授权∩设备声明逐项可见降级、租约读时计算在线、authorize chat/notification 走能力交集而 trace/approval 独立授权口默认 not-authorized、reconnect epoch 变化/cursor 低于缓存窗口→明确 resync、心跳续租；配对/会话/撤销复用 FE-17-pre 凭证端口不造第二套）。27 定向/1255 全量全绿 tsc 0。真实设备端到端 NOT RUN（FE-15 Rust handler+INT-01）。**Wave 5 本地可执行节点完成；FE-16/FE-17-host 需真实宿主。下一节点：Wave 6 AGT-01 Session/Run 契约。**
- 2026-09-13 11:38 Wave 5 FE-15 PARTIAL（待人工）：本地部分 tauriTransport（invoke/listen 桥 OutboundTransport、命令事件监听者异常隔离、不做认证不信任 body 身份）+ fake invoke/listen 下复跑 FE-14 conformance 六用例（退订无迟到业务回调）。B/C/D/E（Rust gateway.rs handler、手机页、宿主装配平台选择）需真实 Tauri 宿主：NOT RUN/BLOCKED，留宿主轨。**下一节点：GW-04 设备列表与租约（复用 FE-17-pre 凭证端口）。**
