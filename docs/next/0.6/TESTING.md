# TDD、回放与验收

## 1. 执行原则

新增/修复行为：明确 AC → 失败测试（记录失败原因）→ 最小生产实现 → 测试通过 → 重构 → 相关回归。测试因导入拼写错误而失败不能证明业务 RED。原样迁移先固定特征测试，保持 GREEN，不强迫人为破坏生产代码。

已有语料优先；新增边界可以重组现有片段/事件，并标明来源。用例缺口由 worker 补最少必要样本，不在小阶段反复要求用户录音。禁止随意改预期、test.skip、降低阈值或 passWithNoTests。

## 2. 测试层与门槛

| 层 | 输入和被测对象 | 运行时机 | 证明范围 |
| --- | --- | --- | --- |
| 契约/单模块 | 固定文本、ASR/HTTP/播放事件 fixture；真实被测生产模块 | 每个 SPEC | 行为和失败语义 |
| 自动集成 | 文本/音频事件回放，真实 Runtime/存储/桥接，外部模型可 fake | 改跨边界及 NEXT-08 | 模块接线、隔离、持久化 |
| 真实服务回放 | 已有录音→真实 VAD/ASR；固定文本→至少一条真实 LLM 和真实 TTS | NEXT-06 定向，NEXT-08 收口 | 当前模型/适配/资源可用性 |
| 自动宿主验证 | Windows 构建、启动、最小操作和退出 | NEXT-08 | 构建及宿主接线 |
| 人工验收 | 麦克风、扬声器、UI 实际使用 | 仅 NEXT-09 | 设备、体验与听感 |

小阶段不默认全仓 test/build。公共接口变化测受影响契约；版本末尾全量回归、静态检查及 Windows 构建，不能只汇总旧报告。

## 3. 语料登记

NEXT-01 建 `CORPUS_MANIFEST.md`，每项包含 caseId、来源路径/commit、文件 hash、语言、输入、预期/结构断言、真实或模拟、所需环境、允许用途。私有音频只写本机引用，不提交正文。外部样本可用来源 URL 与 hash，不下载来源不明素材。

优先参考旧库固定文本、`useVoiceConversation.integration.test.ts`、`speechQueue.test.ts`、`speechInput.conformance.test.ts`、`speechOutput.conformance.test.ts`、`companionRuntime.scopes.test.ts`、Memory/Context 测试；参考固定 Legacy commit，实际存在性由 worker 核对。

本机 Whisper 曾有 `E:/Work/toolchains/whisper-b5130` 与 `samples/jfk.wav` 验证记录，见旧库 `docs/stt/reports/LOCAL_WHISPER_SETUP_20260917.md`。这是历史证据，不保证文件/服务现在可用。库外资源重新核实，不复制密钥或用户数据。

最低覆盖矩阵：文本单轮/多轮、取消/迟到/快速重发、跨会话、Provider 坏流/超时/断开、Memory 纠正/遗忘、Timeline 重复/失败/删除、ASR 乱序/空结果/取消、TTS 分句/乱序/停止/失败，以及完整文本和语音各一条。

## 4. 真实回放的判定

- LLM：使用固定正常问答与多轮样本，至少各一例；真实返回非空、结构合法、终态唯一，多轮上下文实际进入请求。回答文字不做精确相等断言，不靠模型自评证明人格质量。
- ASR：至少一条现有非静音录音经过真实输入处理与识别；非空且满足冻结的参考关键词/允许转写集合；静音负例不生成用户消息。固定模型、语言策略、音频 hash 和推理参数。更广泛中日英准确率未有对应语料时明确不作承诺。
- TTS：至少一条固定文本经过真实合成，音频可解码且时长大于 0；无可导出音频的后端只能证明接口调用，不能满足“可解码音频”证据。NEXT-00 选择已有可用合成路径，必要时用已有本地后端，不能到收尾才发现无法自动测试。
- 取消、顺序、隔离用确定性 fixture 验证；真实路径补服务冒烟和实际错误证据。不用随机延迟断言替代确定性事件同步。
- 有基线输出的真实样本先复跑冻结预期，再开发，防止事后挑选容易通过的样本。没有基线则在 NEXT-01 登记客观断言及限制，不虚构准确率或延迟目标。
- 凭据/服务缺失记录 BLOCKED，可继续独立模块工作；必需真实门槛最终缺失则不得 AUTO_PASS。不得自行新增付费服务来消除阻塞。

## 5. 报告模板

每个 SPEC 报告 `reports/NEXT-XX_ACCEPTANCE.md`：基线与候选 commit、实际范围、测试命令/cwd/退出码、RED/GREEN 证据、逐 AC 的 PASS/FAIL/BLOCKED/NOT RUN、fixture/真实证据类型、共享契约影响、已知限制、待人工项。运行命令必须来自真实 package scripts 或测试配置；文档里的逻辑用例名不是可执行命令。

状态流程：NOT RUN → IN_PROGRESS → AUTO_PASS；必需 AC FAIL/BLOCKED 不可进入 AUTO_PASS。NEXT-09 记录 MANUAL_PENDING / MANUAL_FAIL / RELEASE_ACCEPTED。仅明确后置的设备与体验项目可标 DEFERRED，不把未开发功能后置后冒充本版完成。
