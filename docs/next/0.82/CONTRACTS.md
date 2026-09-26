# 0.82 共用目标契约

状态：设计基线，未实现。名称、字段、路径均为后续实施目标；N082-00 按现有导出做最薄适配并更新映射。复用 `PairingScope`、现有 Source/Model/Binding 解析、宿主资源注册和 Collection owner，禁止第二套永久正文库或全局轮次。

## 1. 模式、授权和运行状态

`CompanionModePolicy`：schemaVersion、revision、pairing、mode(active/passive)、observationIntervalMs、dailyLocalTime、timezone、policyVersion。初始 mode=passive 且 paused=true、零新授权。模式属于配对，配额沿用现有共享总账。配置 revision 与运行 generation 分开；每次暂停、目标/模式/角色变化递增 generation 并取消旧 signal。

`ModeStatus`：policy、runState(paused/running/error)、generation、reasonCode、effectiveSources、observationState、batchState、lastSuccessAt、nextRunAt。每来源状态分 disabled/starting/active/paused/stopped/revoked/expired/unavailable/error；active 要有实际 lease。部分来源失败按来源展示，不能让总状态掩盖其失败。用户恢复只恢复此前显式启用且仍有效的范围，不恢复 revoked/stopped 来源。

模式配置和 pause/resume 共用持久的 policy.revision，每次成功变更均递增；系统导致的暂停也递增并通知 UI。generation 用于在途任务失效，不代替 revision 冲突校验。来源、单样本和集合删除仍分别使用 grantRevision、sampleRevision、collectionRevision，前端不能混用。

旧 `keyboard` 保持活动语义；目标新增来源 kind 为 clipboard_text、input_text、manual_text、history_reference、download_directory；已有 screenshot_directory、clipboard_image 保留。OCR/文档解析是派生类型，不创建可绕过父来源授权的独立源。

目标授权 `SourceGrant` 在现有 Collection 授权 owner 扩展：grantId、revision、pairing、sourceKind、scope（目录真实根/递归范围或应用及输入法 allowlist）、purposes(receive/parse/context)、destination、grantedAt、expiresAt、profile、state。mode 设置不能签发 grant；旧 grant 不获得新 kind/purpose。初次授权 expectedRevision=0，重新授权带当前 revision，换范围产生新授权身份并废止旧租约；旧记录可留 tombstone。暂停保留旧有效样本；撤销失效相关样本及派生项；过期停止新接收，旧样本仍受自身 TTL 管理。

现有 `ContinuousPerceptionGrant` 已有类型，须扩展真实 targetId、targetRevision、bounds、runtimeSessionId、pairing、minPollIntervalMs、expiry、revision 及生命周期；屏幕抓取与 OCR destination 固定 local。用于生成陪伴的 `ContextUseGrant` 独立引用 observation 来源范围、模型 Binding/目的地和期限；切云/换范围重新确认。单帧 CaptureGrant 继续走原单次路径，不升级权限。

`ModeRuntime.setMode / pauseAll / resume` 与来源 activate/transition 返回真实状态；控制操作持久化幂等 operationId 与 body 摘要，重启重放返回原结果、不同 body 拒绝。停止先使 generation/授权代次失效，再 await 资源关闭；关闭失败必须报 error，不能吞异常宣称停止成功。锁屏、睡眠、Windows 会话切换、角色切换和退出都取消任务；解锁/重启保持 paused，旧屏幕会话目标重新验证后才能手动恢复。会话事件源不能依赖 keyboard/clipboard 已启用。

## 2. 来源与处理结果

目标 `SourceCandidate`：id、revision、pairing、sourceKind、grantId/revision、modeGeneration、nativeEventId/fileVersion、occurredAt(nullable)、receivedAt、origin、confidence、state、expiresAt、payloadRef。文件还含 displayName、mimeType、size、canonicalRootId、stableVersion；受管文本含 UTF-8 byteCount 与文本引用，不能放公共事件或通用日志。来源应用未知保持 unknown；clipboard、IME、OCR、外部文档不互相冒充。

`InputTextCandidate` 在候选上增加 adapterId/version、appIdentity、inputMethod、commitId、text、completeness、captureMethod。只接受已验证范围的提交片段；composition 取消不入库，文本更正指向被替代片段而不是假装获得整个文档。密码/受保护控件或无法判断场景拒绝正文。键码不作为正文公共协议；长文本限额见 TESTING，超限状态可解释。keyboard 和 IME 若两种路线同时可用，同一 commit 去重，不双写。

`DerivedText`：id、revision、parentRefs[{sourceId,version}]、processorId/version、grantRevision、processingKey、createdAt、expiresAt、status、textRef、warnings。status 为 ok/partial/unsupported/missing/failed/cancelled；不能返回图像尺寸占位并标 OCR ok。有效期不长于任何父来源；父源撤销/删除/到期即不可查询和注入。History 只存引用，查询时复验 History 本身有效性。

`CollectionStore` 目标增量端口：appendCandidate(grant,candidate,idempotencyKey)、listPending(scope,cursor,cutoff)、commitDerived(expectedSourceVersion,result,processingKey)、queryEffective(scope,filters,cursor)、invalidate(scope,reason)、claimJob/finishJob。接收按来源事件 ID 幂等；内容 hash 只做资产共享，不能抹掉不同时间的事件。处理 key=配对+来源ID/版本+processor版本+策略版本；tombstone 检查不因换处理器而绕过。提交前复验授权、generation、父来源版本与有效性，事务更新结果与作业状态。

存储沿用同一个 Collection owner/数据库，schema 增量迁移；受管正文、暂存和派生快照共同计入预算，原文件不计入受管副本。单条/区间/清空/来源撤销覆盖暂存、正文、索引、关联、缓存与候选；共享资产最后引用释放才删除，仍有效另一来源保留投影。旧三域默认查询不变，Collection 投影不复制长期正文。

## 3. adapter 与处理接口

`TextSourcePort.start({grant,signal},onCandidate): Lease`；clipboard_text 用变化版本/sequence 读取纯文本并复检；input_text 用 00 验证的提交接口。Lease.close 幂等、可等待；进程崩溃上报 unavailable 并清未消费暂存。旧 helper v1 的 keyboard 字段白名单不放宽；若使用同一 helper 承载正文，需版本协商和独立 kind/schema/staging 读取授权，旧版本明确拒绝新能力，不能静默误解析。

`FileSourcePort.start({grant,signal},onCandidate)`、resolveStable(ref,version,signal)；路径只能解析到授权实根，默认非递归。先发现/稳定读取并登记，后由批次解析。不能读取半写文件、未完成下载或更改后的旧版本；进程离线/暂停期间不默认补入历史，恢复建立新接收边界。

`DocumentParser.parse({sourceRef,version,bytesRef,mimeType,limits},signal): DerivedTextResult`；TXT/MD、文本 PDF、DOCX 为首版支持，图片交 OCR；不联网、不执行宏，不支持/加密/缺失返回明确状态，限额前置到读取及解压阶段。

`ScreenCapturePort.selectTarget / validateTarget / capture(target,signal): CapturedFrame`；可信桌面选择产生目标引用，不接受浏览器任意伪造屏幕句柄。帧含 targetRevision、capturedAt、mimeType、dimensions、bytes，处理后释放。现有单帧 1.5 MB 限制不可悄悄扩大；00 为持续路径确定独立图像预算/缩放规则并验证 OCR 质量。

`OcrPort.recognize(frame,signal): OcrResult` 复用现有文字块/阅读顺序类型；native 引擎没有可信置信字段时适配为 unknown/null 并更新直接消费者，不能编造高置信。本地无可用引擎为 unavailable，不自动走云。用户明确保存观察时经 Collection 存储接口写入，并附独立保存确认及 TTL，非周期任务默认动作。

## 4. 调度与陪伴

`BatchRunner.request({trigger:manual|daily|catchup,operationId,expectedPolicyRevision}): JobStatus`。每配对最多一个批次，运行中点击返回同一作业；batch 有输入 cutoff、分页 checkpoint、成功/失败/跳过计数及 terminal 状态。新到样本留下一批。日任务 key 包含配对和计划日；时区/时间设置变更保存 lastSuccessfulScheduledAt 与新计划，不能在已成功计划日再跑。失败自动重试最多一次、同一 job/key；不吞 partial 失败。手动成功不消耗每日计划，但 processingKey 防止重复解析。

`JobStatus` 至少含 jobId、pairing、kind(batch/observation)、trigger、policyRevision、generation、scheduledDay、cutoff、state(queued/running/succeeded/partial/failed/cancelled)、startedAt/finishedAt、checkpoint、accepted/processed/failed/skipped/dropped 计数及脱敏 reasonCode。观察任务无来源分页时 checkpoint=null。取消本身不删除合法旧样本；已成功的分项保留，重试只处理未成功且仍有效项。

`ObservationScheduler.tick / observeNow / cancel`：只在 active、running、有效持续授权和目标/引擎可用时抓屏。一次在途；错过 tick 不补抓，完成后计算下次时间。批次图像 OCR 和屏幕 OCR 共用有界处理队列，不因两模式同时触发而绕过内存限额；用户对话优先。

`ObservationCompanionPort.offer({observationId,sourceVersion,generation},signal)` 消费有效观察；先检查配额/勿扰/忙闲/新颖性，再有界生成，展示前再次复验。候选以 observation/修订去重、有效期不长于观察。生成队列容量 1，不无限模型反思；输入作为不可信来源数据，禁止触发工具或自动长期晋升。复用当前真正拥有持久配额的 Invitation runtime，不同时实例化另一套配额权威。被动模式抑制普通自动问候和情境候选，显式用户提醒保留原用途。

用户接受/回复走现有文本 TurnPort 与 Observation 上下文入口，重新验证来源；失效时说明已不可用，不恢复旧正文。本地 OCR 的文本进入云 LLM 需要独立 ContextUseGrant；未授权仍可本地 OCR，生成状态明确 unavailable/forbidden。

## 5. 管理 API 目标

统一 Bearer/同源/Origin 校验，配对由 runtime 固定，客户端不能自报。所有写操作有 operationId；已有对象写入带对应 expectedRevision，冲突 409，无权 403，不可用 503，错误正文只含脱敏 code/requestId。读取正文仅限明确鉴权 detail 端点，no-store；status/event/Trace 不带正文、绝对路径或令牌。

| 目标端点 | 请求/响应摘要 | owner |
| --- | --- | --- |
| GET /api/companion-mode | ModeStatus、来源能力、策略与批次摘要 | 01/08 |
| PUT /api/companion-mode | mode、频率、dailyLocalTime、timezone、expectedRevision、operationId；仅改策略，不授权 | 01/08 |
| POST /api/companion-mode/{pause,resume} | expectedRevision、operationId；返回真实状态/新 generation | 01/08 |
| POST /api/companion-mode/observe-now | operationId；有效持续授权下调度一次，返回 jobId | 05/06/08 |
| POST /api/collection/batches | trigger=manual、expectedPolicyRevision、operationId | 06/08 |
| GET /api/collection/batches/:id | JobStatus、计数、错误码、checkpoint 摘要，无正文 | 06/08 |
| POST /api/collection/text | text、独立来源授权引用、operationId；受限手动提交 | 03/08 |
| POST /api/collection/sources/:kind/activate | 扩展原路由：scope、purposes、destination、expiresAt、expectedRevision、operationId、userConfirmed | 01/08 |
| POST /api/perception/continuous-grants | 可信选择 targetRef、范围、期限、userConfirmed；返回持续授权 | 01/05/08 |
| POST /api/perception/context-grants | observation来源范围、Binding/目的地、期限、userConfirmed | 01/07/08 |
| POST /api/perception/{continuous-grants,context-grants}/:id/revoke | expectedRevision、operationId；来源/生成任务取消并返回终态 | 01/08 |
| POST /api/perception/observations/:id/save | expectedRevision、operationId、userConfirmed；转受管样本 | 02/05/08 |
| GET /api/collection/samples/:id/content | 有效且有权样本的受限文本/派生详情、来源修订和解析状态，no-store；图片沿旧 asset 路由 | 02/08 |

复用原 samples 查询、feedback、delete/range/clear/revoke，增加正文 detail/派生状态响应，00 明确兼容分页/cursor 与 schema。不得让新查询结果被旧 image-only UI 当作图片渲染；旧单帧感知 API 行为保持。安装、读取配置、展示能力不启动未选引擎；所有 native/timer/parser 租约交宿主统一关闭。
