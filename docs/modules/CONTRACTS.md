# 模块接口与责任

这些是稳定的逻辑接口；现有函数可通过适配器兼容，不要求一次性重命名所有源码。源码仍在 `aika-crossplatform/src/`，项目文档统一位于根 `docs/`。

| 接口 | 所有者 | 输入 | 输出/保证 |
| --- | --- | --- | --- |
| SpeechInput | STT | start/stop/cancel、输入语言策略 | speechStart、segmentFinal、turnReady、error；带 sessionId/segmentId、单调音频时间及精度 |
| CompanionRuntime | LLM | submit(text, source, mode)、cancel(turnId)、交付状态通知 | turnId、replyDelta、replyCompleted、failed/cancelled、只读状态订阅 |
| SpeechOutput | TTS | enqueue(turnId, sentenceId, text, language, style)、stop(turnId) | started、sentenceCompleted、drained、stopped/error；代理播放指标须标注 |
| Presentation | 前端 | 用户操作、Runtime/STT/TTS 状态 | 展示与操作命令；不自行抽取 Memory、调用 Provider 或计算检索排名 |

- STT `segmentId` 只代表识别段，不能当对话 turnId；CompanionRuntime 为提交的对话分配 turnId。新提交不得受旧轮 busy 残留阻塞。
- 所有下游异步事件带 turnId，取消幂等；旧轮结果不得覆盖新轮。STT 的取消输入会话不能被误用于清掉用户正在说的新片段。
- 文本回复在生成完成后可保存，不依赖 TTS。语音回复的 generated 与 delivered 分开；TTS 提供进度/终态，LLM 决定保存为 complete/interrupted/cancelled。拿不到真实播放范围时标 unknown，不伪称用户已听过。
- 前端语音桥接负责把“用户重新开口”转为 Runtime cancel + TTS stop，并继续接收 STT；三模块完整联动属于 INT-02，不要求任一模块小阶段启动另外两个真实服务。
- LLM 内部统一 ReplyEnvelopeV1：schemaVersion、mood、replyText、translation、memoryCandidates、actions，允许 sticker/expression/motion。旧协议由 LLM 适配；前端不解析未闭合模型 JSON。
- 表达参数是受控枚举，TTS 不接受任意脚本。未知动作/工具不得执行；当前没有完整外部 Tool Runtime。

## 共享文件

| 当前文件/区域 | 主责 | 修改约束 |
| --- | --- | --- |
| services/providerClient、domain/prompt/character/memory/conversation、services/storage、useCompanionSession | LLM | 小阶段只测试改动涉及的 LLM/存储行为 |
| services/voice/input*、whisper*、webSpeechInput、audioCapture、sileroVad；domain/asrSegments/vadSegmenter/turnEnd | STT | 使用假时钟/录音 fixture，Provider/TTS 不作为依赖 |
| services/voice/speechQueue、webSpeechOutput；domain/sentences | TTS | 使用输出引擎 stub 与固定文本，不调用 LLM |
| components、App、样式、domain/captionHighlight、界面设置 | 前端 | 用 fake Runtime/STT/TTS 状态验收交互 |
| services/voice/contracts、domain/voiceRuntime、useVoiceConversation、voiceDiagnostics | 跨模块契约/桥接 | 按变更行为标明归属；跨边界部分进入 INT-01/02，禁止各模块复制一套契约 |

新增模块接口允许在本模块增加类型与 adapter；破坏共享契约时先记录版本/兼容方式及受影响方，只跑必要的契约检查，不用“模块内通过”掩盖未完成联调。

## 详细接口入口

LLM 各自的 `docs/llm/specs/LLM-01…05` 文件内写明实现级接口；[STT](../stt/ARCHITECTURE.md)、[TTS](../tts/ARCHITECTURE.md)、[前端](../frontend/ARCHITECTURE.md) 按共享架构文件引用对应阶段。代码块是拟定逻辑契约，现有类型通过兼容 adapter 映射；不能以名称尚未存在推断已实现，也不要机械新增重复接口。

发生冲突先依据用户最新范围和 SPEC 的行为约束统一接口，在同一改动中更新文档/适配及针对性契约测试。接口细化不自动触发全仓重构或全流程测试。
