# 0.82 Code Review — 2026-09-26

结论：当前实现不满足 READY_FOR_HUMAN。以下按当前工作树审查，包含尚未提交的 0.81/0.82 文件；本轮未修复实现，也未修改原验收报告。定位均相对 `windows/code/desktop-pet/`。

## 阻断发现

### CR-01 · P1 · 全局暂停与实际监听器使用两套生命周期

定位：`core/companion-mode-runtime.ts:180-188`、`app/trial-backend.ts:519-535`。

启动时，旧 CollectionGrantManager 的 active 授权会直接启动 keyboard、screenshot_directory、clipboard_image。随后创建的新 CompanionModeRuntime 初始为 paused，且 leases 为空。pauseAll 只停止自己 leases 内的来源，因此界面/API 可以报告 paused，而实际旧来源继续采集。两套授权分别存于 collection_grants 和 companion_mode_grants。系统会话事件也只挂起旧 manager，没有统一推进新任务的 generation。

修复要求：统一生产生命周期所有权，暂停/锁屏/重启策略覆盖所有真实来源和在途任务。回归必须从正式组合根启动旧来源，再调用全局暂停，验证 native 回调不再入库；验证重启后状态与真实监听器一致。

### CR-02 · P1 · 正式抓屏与像素 OCR 仍使用占位实现

定位：`app/trial-backend.ts:543-549`、`core/screen-capture-source.ts:87-115`、`core/local-ocr-engine.ts:49`。

正式组合根未注入 captureHook 或 recognizePixelHook。无 hook 的 ScreenCaptureSource 返回合成字节；OCR 后备逻辑读取 PNG 文本元数据，不能识别截图里的像素文字。因此创建了对象并不等于真实抓屏/OCR 可用，当前正式链路无法支持主动 OCR 陪伴。

修复要求：接入真实捕获和本地像素 OCR，能力缺失时报告 unavailable，禁止生产路径返回伪造帧。以真实有字截图验证识别内容，而不是只验证空白结果或注入 hook。

### CR-03 · P1 · 正文来源、自动调度和陪伴输出未形成生产闭环

定位：`app/trial-backend.ts:529-549`、`core/input-text-source.ts:39-50`、`core/clipboard-text-source.ts:39-53`。

生产入口未装配 InputTextSource、ClipboardTextSource、DownloadDirectorySource、ObservationCandidateSource。输入来源 start 没有 UIA/IME 订阅，剪贴板 start 不使用候选回调建立监听。观察调度器没有正式的 setContext、持续授权注入、tick 定时调用，也未接 onObservation；每日处理没有启动计划入口。管理界面和现有来源路由仍以旧三种来源为主。结果是手动构造事件的组件测试通过，但用户无法完成正文授权采集、每日处理和周期观察陪伴。

修复要求：补齐真实事件 → 授权 → 入库 → 调度 → 处理 → 陪伴仲裁/UI 的调用链。验收必须由正式应用入口发起，不能由测试直接调用 processCommit/tick 替代生产接线。

### CR-04 · P1 · 删除来源后派生正文仍有效，迟到结果可恢复失效父项

定位：`memory/collection-store.ts:637-658`、`:924-954`、`:986-991`。

来源 erase 作废候选但不级联作废派生文本；有效查询不检查父项有效性。commitDerived 又不校验父项、授权版本或 generation，并无条件把父项改回 processed。已处理来源被删除后，派生正文仍可查询；删除期间在途解析完成还可写回。

隔离数据库复现：erase 后有效候选为 0，有效派生文本仍为 1；随后对失效父项提交新 processingKey，派生文本增至 2。

修复要求：事务内校验父项归属、状态、版本及授权，级联失效和墓碑覆盖候选与派生数据，拒绝迟到提交。覆盖 source/item/range/all 删除与在途提交竞态。

### CR-05 · P1 · 正文批次把非空文本处理成空串并标成功

定位：`core/collection-batch-runner.ts:130-133`、`memory/collection-store.ts:874-907`。

listPending 返回对象不包含 text_content，runner 却通过类型断言读取这个字段，再回退 displayName 或空串。因此 clipboard_text/input_text/manual_text 正文不会正确传给派生结果，候选仍被标为 processed。

隔离复现：插入非空 manual_text，执行真实 runner 后得到 `status=ok, text_content=""`。

修复要求：建立有类型的正文读取契约，验证派生内容与输入正文一致；缺失正文不能伪报成功。

### CR-06 · P1 · 新正文存储未执行容量限制和物理过期清理

定位：`memory/collection-store.ts:691-713`、`:734-742`、`:834-870`。

appendCandidate/commitDerived 未执行正文容量淘汰；expire 和容量淘汰仍处理旧样本。managedBytes 只计 pending 候选且用 SQL LENGTH 计字符，处理或作废后的原正文仍占磁盘却退出统计。长期采集无法兑现受管容量与保留期。

隔离复现：managedByteLimit=10，插入正文后实际计数为 49，写入成功且未淘汰。

修复要求：统一统计实际受管字节，对候选、派生正文和物理清理实施限制；覆盖中文 UTF-8、处理后正文、过期、删除及容量边界。

### CR-07 · P1 · cancel 不取消观察，暂停后仍可发布迟到结果

定位：`core/observation-scheduler.ts:88-115`。

cancel 仅把 isBusy 清零，没有中止请求或使当前上下文失效。capture/OCR await 后不复核 generation、授权和运行状态，因此取消后仍执行 onObservation，还可能允许第二轮与旧任务重叠。

隔离复现：阻塞 capture，调用 cancel 后放行，onObservation 仍收到 1 次结果。

修复要求：作业绑定取消信号与 generation，在每个异步边界和发布前复核；旧任务 finally 不得清除新任务的 busy 状态。覆盖暂停、撤销、切换目标和新旧任务交错。

### CR-08 · P1 · DOCX 解压预算可被伪造 ZIP 长度绕过

定位：`core/document-parser.ts:240-252`。

预算仅比较文件自报的 uncompressedSize，随后同步 inflateRawSync 未设置实际输出上限，也未检查真实展开长度。下载文件可通过伪造长度越过限制，在主进程造成大内存分配或阻塞。

使用小型合成 ZIP 复现：声明展开长度为 1，实际正文为 1024 字节，预算为 64 字节，解析仍返回 ok 和完整 1024 字节。

修复要求：在解压过程中限制实际输出，stored 条目也检查真实长度；超额给出确定的失败状态，并验证进程资源有界。

## 调度缺陷

### CR-09 · P2 · 手动处理占用每日自动处理额度

定位：`core/collection-batch-runner.ts:178-188`。

成功或部分成功批次都写每日账本，没有按 trigger 区分。当天先手动执行后，hasDailySuccess 返回 true，计划任务可能被跳过。隔离复现确认 manualConsumedDaily=true。现有测试顺序没有覆盖“先手动、后每日”。修复后需证明两个触发入口互不消耗额度。

### CR-10 · P2 · 每批仅取 50 项却把每日任务标为完成

定位：`core/collection-batch-runner.ts:122`、`:171-188`。

listPending(limit=50) 只调用一次，无游标循环。超过 50 项时，余项留待后续批次，当前任务却成功并写每日完成账本；若前 50 项均为不支持类型且保持 pending，后续项还可能持续饥饿。应处理完本次 cutoff 内快照，或明确记录可续跑 checkpoint，不能将部分扫描当整日完成。

## 本轮验证与限制

| 验证 | 结果 | 证据边界 |
| --- | --- | --- |
| npm run check | 通过 | TypeScript 类型检查 |
| npm run test:next082 | 34/34 通过 | 含 build；现有自动化断言不覆盖上述反例 |
| 隔离 SQLite + 编译产物定向复现 | CR-04/05/06/09 已复现 | 临时库，无用户数据库修改 |
| 注入延迟 capture 的取消竞态 | CR-07 已复现 | 合成测试，不是实机抓屏 |
| 小型合成 ZIP 超预算 | CR-08 已复现 | 最大仅 1 KiB 正文，不是大规模资源攻击 |
| 原生 OCR/IME、0.81 回归、Pin、人工体验 | 本轮未执行 | 不引用旧报告作为本轮完成证据 |

建议先修复 CR-01～08，再补充 CR-09～10 回归和正式入口集成测试；全部通过后重新出具 Agent 验收结论，再进入人工验收。现有 34/34 只能证明这些断言通过，不能支持当前 READY_FOR_HUMAN 声明。
