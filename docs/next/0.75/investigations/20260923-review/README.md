# 0.75 代码与文档复核结论

日期：2026-09-23；审查基线：`fc0203f`。开始审查时工作树干净。范围：N075-01/02、正式与现场启动链、连续性失效、Trace、控制台数据及现场七项反馈；包含此前 0.7 review 的直接接入问题。只新增审查证据和修复计划，不修改产品源码，不撤销其他任务的提交。

目录：[结论](#1-结论与主线判断) · [发现](#2-代码-review-发现) · [现场复核](#3-现场反馈逐项复核) · [证据](#4-验证与证据边界) · [文档](#5-文档状态与修复入口)

## 1. 结论与主线判断

**需要修改，暂不能认可“运行时收口 100% 完成、真实桌宠与控制台已接通”的工程结论。** 已有实现值得保留，不应整版推倒重写。`test:next075` 7/7 通过证明受测组合成立，不能证明实际启动装配完整。

| 主线要求 | 判断 |
| --- | --- |
| 全前端逐界面重写，桌宠表现层保留 | 目标仍一致；本次没有证据表明应改渲染引擎 |
| 每页先问要求→索取参考图→重写→主动审核→通过后下一页 | N075-02 报告记录了参考图、有限自由发挥授权与用户初稿认可，因此不能仅凭 UI 已实现断言越权；实际参考图未附于当前证据目录，视觉一致性未复核 |
| 唯一正式 Runtime / 配置 / 记忆权威 | **执行偏移**：现场仍使用 `real-backend.mjs` 加独立 `serve-management.mjs`，不是文档锁定的生产组合根 |
| UI 显示真实运行状态 | **实现偏移**：总览硬编码“正常”“已加密同步”，假设与 API 结果脱节 |
| 0.7 能力作为 0.75 前置收口 | 作为补接口工作合理；部分 Context 读取已正式接入，不能重复旧“完全未接线”结论。但连续性失效、后台投影和 live Host/Flow 仍未完整闭环 |
| 用户新需求：看/删知识库、无需大抽屉看回复、Trace 区分前后台 | 均在 0.75 功能界面范围内。漫画风、头顶锚定、淡出时长是待确认设计，不是已经批准的实现规格 |

## 2. 代码 review 发现

以下均按基线源码定位；P1 为应先修的正确性/隐私/实际接入问题，P2 为其余明确缺陷。路径相对仓库根，行号固定于本次基线。

### RV75-01 · P1：现场入口仍绕过正式 Runtime，去掉 preview 不足以修复

- 位置：`windows/code/desktop-pet/tools/dev-desktop-real.mjs:8–15`、`desktop/electron/main.mjs:173–181`、`tools/serve-management.mjs:30–65`。
- 启动器删除 PET_TRIAL_CONFIG/PET_TRIAL_ACTIVATION、选择 `real-backend.mjs` 并传 `--preview`；Electron 因 preview 拒绝管理入口。独立控制台使用 dummyConfig、dummyLifecycle、独立 settings/skins，却读取另一位置的 companion DB。
- 影响：即使恢复配置环境变量，仍可能打开另一进程的管理台；保存 API 配置、外观和健康状态不一定控制正在聊天的实例。`managementUrl()` 只核对描述文件与被访问服务的身份，不能代替桌面连接身份的一致性验证。
- 修复方向：用户运行入口真正启动正式 backend，由该实例发布管理 session；实验 harness 显式隔离。不要仅把独立控制台 session 接到实验桌宠上宣称收口。

### RV75-02 · P1：遗忘 Continuity 后，已发出的正式 Context 仍被视为有效

- 位置：`memory/continuity-production.ts:67–77`、`memory/sqlite-lifecycle-port.ts:458–466`。
- Composer 在读完时检查连续性版本，但正式 `assertContextCurrent()` 只检查 knowledge 和原 Memory lifecycle，没有检查 `context.continuity` 的配对修订/Pack 修订。原 lifecycle 的来源集合不包含独立 continuity_facts 的版本权威。
- 复现：生产 Store + ProductionContinuityContext + SqliteLifecycleMemoryPort 读入 User Soul，再调用 continuity forget；新 snapshot 已无条目，旧 Context 的 assert 仍成功（见 results）。
- 影响：LLM 请求在途时遗忘/纠正，仍可能显示或播放含旧个人事实的回复。Pipeline 虽在回复前调用检查，但检查内容不完整。
- 修复方向：将连续性来源/配对版本绑定到 issued context、提交和输出检查；管理变更与后台失效使用同一权威。覆盖遗忘、纠正、来源撤销、Pack 切换及播放中的失效。

### RV75-03 · P1：Trace 默认脱敏仍保留阶段详情中的明文个人资料

- 位置：`core/trace-store.ts:112–127`；实际调用方 `tools/real-backend.mjs:149–159, 288–297`。
- record 仅摘要化 userText/replyText，stages 原样 JSON 序列化。现场 harness 将 `retrievedMemories`、提炼 `fact` 写入 details，默认未开启 debug 也会持久保存。
- 复现：默认 record 的正文变为 digest，stages 仍能查询出 `REVIEW_PRIVATE_CITY`。
- 影响：Trace 成为另一份明文记忆副本；原记忆遗忘并不自动清除此副本。“T8 隐私通过”只断言两列，未覆盖阶段载荷。
- 修复方向：Trace 采用字段白名单/结构化安全字段，record 与 appendStage 同时约束；历史敏感记录的处理须在正式数据副本上设计迁移和恢复，不能在本次 review 中删除用户数据。

### RV75-04 · P1：live Host/Flow 管理在正式组合根中仍未注入

- 位置：`app/trial-backend.ts:455–458`、`management/next65-management.ts:35–48, 63–64`。
- 组合根只传 hostRoot 和 providerRuntime，没有传 host/flow。管理类退回新建 `FlowRuntime([])`，包 loaded/active 在没有 host 时均为 false。
- 影响：新增 GET `/api/next65/truth` 可返回结果，却不能代表正在运行的 Host/Flow；R8 和 DoD 7 的“live runtime 已接通”结论过度。
- 修复方向：传实际宿主实例；若正式路径尚无该宿主，真实返回 unavailable/unsupported 并保留该项未完成，不以新建空对象充当运行态。

### RV75-05 · P2：后台先完成时 Trace 阶段丢失，失败阶段也未完整记录

- 位置：`core/memory-lifecycle-queue.ts:65–85`、`core/dialogue-pipeline.ts:227–240`、`core/trace-store.ts:137–150`。
- 后台阶段完成就 appendStage，但前台 Trace 到 finally 才插入；后台更快时 append 返回 false，调用方忽略，最终 Trace 没有 memory_plan/commit。复现确认早到阶段未保留。
- 同一 elapsedMs 同时标作规划和提交耗时；append 用 max 更新总时长，没有阶段起止时间，无法可靠解释前后台重叠。Pipeline 只在 llm 成功后追加 llm stage，异常路径未补失败 stage，取消还会记为 ok。
- 修复方向：轮次开始建 Trace、阶段按 scope/turn 和幂等 ID 更新；记录起止时间、前后台类别、排队/执行/提交及失败/取消状态。先修数据，再重构 N075-12 展示。

### RV75-06 · P2：控制台普通读取的错误处理 epoch 判断反了

- 位置：`management/ui/app.mjs:265–277`。
- 成功分支拒绝旧 epoch 正确；catch 却仅在 `auth !== authEpoch` 时调用 error。当前会话的 records/prompt/context 网络失败、401 或服务错误反而无反馈；切换鉴权后的旧请求可以污染当前错误状态。
- 修复方向：错误和成功都只接收当前 epoch/序号的结果。覆盖当前失败可见、旧会话迟到失败忽略两条用例。

### RV75-07 · P2：总览把截断缓存与硬编码描述显示为真实健康/存储状态

- 位置：`management/ui/modern-overview.mjs:27–51, 67, 156`。
- 仅获取 6 条 memory、10 条 transcript、2 条 summary，使用数组长度作总量；失败被替换为空数组。无论后端能力是否可用都显示“系统运行正常 · 记忆就绪”和“已加密同步”，未消费加密/同步能力证明。
- overviewData 没有跟随鉴权 epoch、实例或刷新失效，旧响应可写入新视图，后续操作也可能继续显示旧数据。
- 修复方向：读真实 total/能力字段；未知/不可用明确表达；状态缓存绑定实例、作用域、鉴权和请求序号，刷新重读。不得用成功文案掩盖故障。

### RV75-08 · P2：独立验收控制台使用固定可预测 token，并可写真实记忆

- 位置：`tools/serve-management.mjs:45–65, 74–86`。
- token 写死在仓库；同一服务将 SqliteManagementMemoryPort 接到 companion DB。即使只监听 loopback，也不应让可预测凭据成为可编辑真实数据的授权。
- 修复方向：验收 harness 仅接隔离样本数据库，随机会话凭据且不复用生产管理身份；真实联调走 RV75-01 的唯一入口。不要把 mock 配置配上真数据库当生产验收。

## 3. 现场反馈逐项复核

| 用户反馈 | 核实结果 | 修复/需求边界 |
| --- | --- | --- |
| Q1 右键提示离线 | preview 拦截成立；错误文案把全部失败统称离线，session 不存在/过期也可能落同文案 | RV75-01；同时分类启动、会话和路由错误；“移除 preview 即秒开”证据不足 |
| Q2 知识库能看能删 | 已有 `memory/knowledge-library.ts:195–220` 删除文档/库及修订更新；现有 list/getDocument 只给元数据。原报告引用 `knowledge/knowledge-store.ts` 路径不存在 | 增补受控正文查看/分页与 UI，复用已有删除；当前表结构及 selection 按正文现算分块，未发现这里有持久化向量/FTS 库，不安排删除不存在的索引；逻辑删除不等于备份/WAL 物理擦除 |
| Q3 想一想气泡 | 固定 top/right 是事实；`desktop/main.mjs:190` 在断线或 view.error 时隐藏，收到 error 也清 awaitingTextTurn | 不能直接认定“发生异常就永远卡死”。需构造无终态/超时/取消/断线测试，底层终态先修；不能只加倒计时隐藏仍在执行的请求 |
| Q4 免大抽屉看回复 | 合理且归 N075-15；保留历史抽屉为可选查看入口 | 只确认轻量直接显示回复诉求；形状、位置、淡出和动态锚点先问要求及参考图，不视为已批准漫画方案 |
| Q5 Provider stream error | transport 检出 SSE JSON 的 error 可解释此报错；31.7 秒只证明本地测得该阶段耗时，不能定位握手、超时或供应商责任 | **撤回“100% 服务商问题、本地完全正常”作为 review 结论**。可能包括请求参数/配额/鉴权/上游内部错误；保留安全错误码/requestId/阶段和 HTTP 信息，不记录完整敏感载荷；本次没有重新调用真实服务 |
| Q6 4.6 秒 vs 9 秒 | harness 在后台提炼前发送 reply，这只能证明先发文字事件；还发 speaking 状态并在 1 秒后设 idle，没有实际 TTS/播放回执证明“4.6 秒播放完毕” | 区分请求耗时、文字可见、音频首播/结束、后台执行；修 RV75-05 后再做界面，不直接把两个时长作为真实播放结论 |
| Q7 presentation 404 | 独立脚本确实未注入 presentation/knowledge/continuity；正式 trial-backend 已有这些注入路径 | 优先统一入口；不要继续给第二套假配置服务堆生产依赖。可选能力缺席需与未知路由区分 |

## 4. 验证与证据边界

- 基线 `fc0203f`；`npm run test:next075`：**7/7 PASS**，含构建，退出码 0，日志见 [test-next075.log](test-next075.log)。
- [reproduce.mjs](reproduce.mjs)：真实 Store/Context/Trace 模块；临时合成 SQLite，外部模型未调用；用非执行的 provider stub 隔离无关依赖。输出见 [results.txt](results.txt)。
- 复现最初尝试 `:memory:` 被 SqliteMemoryStore 的绝对路径校验拒绝，随后改为系统临时目录中的唯一合成文件；不是产品缺陷。
- `test:next07` 的 50/50 是此前 review 阶段证据，不冒充本次 `fc0203f` 基线复跑；当前 0.75 套件没有验证真实桌面启动器、真实 Host 注入、连续性在途失效或阶段 details 脱敏。
- 原 [现场目录](../20260923-integration-feedback/README.md) 当前只含 README；没有所述截图、抓包或脱敏 DB 导出。因此不能独立复核截图外观、具体现场轮次或称为“抓包级证据”。本次不读取用户真实 DB/密钥，不复制私人聊天。
- 未做真实云调用、设备/鼠标/浏览器视觉验收，未复跑全仓测试；不把这些未做项写为通过。

## 5. 文档状态与修复入口

- SPEC 顶部“所有步骤未实施”、第 1 节 N075-02 WAIT_REFERENCE、步骤表 ACCEPTED 和 N075-02 报告头 WAIT_USER_REVIEW 互相冲突；报告第 6 节却记录初稿已认可。应拆成“外壳初稿用户认可”“真实运行接入待修”，保留真实用户反馈，不能将新 review 当作撤销用户视觉认可。
- N075-01 的“100% 全部完成”应改为按能力列 IMPLEMENTED/WIRED/EXPOSED/验证缺口；T6 实测是原 memory_records 的纠正失效，不是 continuity_facts 遗忘；T7/T8 使用无后台队列的 mock memory，不能证明后台 Trace 和所有字段隐私。
- 新 DistillationScheduler 在 app/core 没有消费调用；正式生产仍用 StrictTrialMemoryProvider。不能把新类的单测等同调度策略已经接线。原有每轮队列可保留，但应准确描述。
- app/core 仍未找到 appendCompanionEvent/commitDerived 的生产提交调用；手工 seed 能进入 Context，不代表普通对话会自动生成所有 0.7 投影。已从“读取未接线”进展为“读取已接、生产写入与失效待补”。

修复执行顺序、改造范围、验收和用户参考门槛见 [修复计划](../../REPAIR_PLAN_20260923.md)。本报告不直接改写历史验收状态，历史现场记录保留以供追溯。
