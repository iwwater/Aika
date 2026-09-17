# STT-01 验收报告 · 输入契约与识别适配（复核补证）

- 性质：**复核补证报告**（2026-09-13，goal worker）。原始实现早于本文，执行者自测记录缺失；本报告按当前 HEAD 实跑定向测试据实补证，不追认历史数字。
- SPEC：[STT-01](../specs/STT-01.md)。基线 commit：`eba6e3c`（当时 HEAD）。

## 命令与退出码（2026-09-13 实跑）

| 命令（aika-crossplatform 下） | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/services/voice src/domain/language.test.ts` | 118 passed | 0 |
| `npx vitest run src/services/voice/speechInput.conformance.test.ts src/services/voice/webSpeechInput.test.ts src/services/voice/whisperClient.test.ts src/presentation/voicePresenter.test.ts` | 49 passed（15+2+16+16） | 0 |

## 逐条 AC

| AC | 证据（生产+测试） | 结果 | 证据类型 |
| --- | --- | --- | --- |
| STT-01-A 生命周期 | `speechInput.conformance.ts` 用例包（web/whisper 两真实实现共用，15 用例含启停/取消/dispose）；`inputEngine.ts` 后端解析；`useVoiceConversation.integration.test.ts` 会话级启停 | PASS | production+fixture |
| STT-01-B 固定 ASR 响应 | `webSpeechInput.test.ts`、`whisperClient.test.ts`（16 例：成功/空文本/超时/断开/坏流；含 STT-04-G probe 双超时）+ 契约包错误路径；错误经事件上报可恢复 | PASS | production+fixture |
| STT-01-C 时间来源与降级 | `domain/voiceRuntime.ts` `VoiceTimeSource = "audio" \| "estimated"`（Whisper 音频结束时间 vs Web Speech 估算）；`outputEngine`/设置页降级声明；`whisperClient` 缺本地服务超时降级 | PASS（生产实现+测试在位） | production+fixture |

## 未测/边界

- 真实麦克风/真机声学：NOT RUN（归 STT-03 DEFERRED）。
- SPEC 全文审阅结论要求的「识别请求永不返回必须有界超时」负例：`whisperClient.test.ts` 超时用例覆盖。
- 本报告不含真实 LLM/TTS/设备；模块边界遵守测试规则。

## 2026-09-17 定向修复：Silero v5 未补音频上下文

用户明确授权解决真实语音不响应。先配置本地 Whisper（[环境记录](LOCAL_WHISPER_SETUP_20260917.md)），随后用户确认底部已显示本地识别，但说了多遍仍无识别。服务日志在排查开始时只有两次工程样本请求，未见后续麦克风转写请求。

范围：仅 `services/voice/sileroVad.ts` 及新增 `sileroVad.test.ts`。Silero v5 官方 ONNX 包装器要求在每个 512 采样帧前拼接上一帧末尾的 64 采样（16 kHz；8 kHz 为 32），除了循环状态张量还需保留这段音频。原代码只保存循环状态，缺少音频上下文，真实人声音频无法越过 VAD 阈值。依据：[官方 OnnxWrapper](https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/utils_vad.py)。

修复在 v5 路径添加音频上下文，推理成功后更新末尾采样，reset 清空；v4 仍传原帧长度。阈值不变，公共接口不变，未修改其他模块。

| 验证 | 结果 | 退出码 / 边界 |
| --- | --- | --- |
| 真实 Edge 生产采集代码，浏览器测试输入设备，2 秒 | 63 帧 / 32,384 采样，peak 0.948 | 0；排除通用采集图完全不产生帧的猜测，非真人麦克风证明 |
| 修复前，生产构建诊断页，官方 JFK 音频加 3 秒静音作为浏览器输入，真实 ONNX VAD | 530 帧，peak 1.0，最大人声概率 0.080959，无 speechStart / final，0 error | 0；可复现无识别 |
| 修复后，同一输入与生产管线 | 531 帧，最大概率 0.999988，speechStart 与 final 均出现，0 error；调用真实本地 Whisper 返回转写 | 0；[浏览器原始结果](evidence/VAD_20260917_after_browser.txt) |
| `npx vitest run src/services/voice/sileroVad.test.ts src/services/voice/speechInput.conformance.test.ts src/services/voice/whisperClient.test.ts`（cwd aika-crossplatform） | 3 文件 / 34 项通过；新增上下文续接、reset、8 kHz、v4 兼容覆盖 | 0 |

临时诊断页/配置/harness 位于忽略目录 `aika-crossplatform/tmp/`，使用真实生产 Capture→VAD→Segment→ASR，仅浏览器输入设备替换为固定音频；统计包装器转发真实采集与推理，未用固定概率或伪造转写。诊断页在生产 Vite 配置下构建，避免开发模式 `/public` 模块导入拦截干扰。原始 WAV 有 LIST chunk，诊断输入已按实际 data chunk 提取并重建有效 WAV；错误构造产生的全静音试验不作为修复前人声证据。

AC 影响：STT-01-A 的 VAD reset 追加测试通过；B 的本地真实 VAD / ASR 追加固定音频证据，不能替代完整失败路径测试；C 的时间与降级契约未变。预录音频拆成多个片段且转写有变体，不作准确率或完整回合门槛通过结论。

真实用户麦克风复验、日语五句、Tauri VAD 运行、Voice→Agent→Pet：仍待现场验证；不宣称 STT-03 / INT-02 PASS。release 重建与维护重启结果追加于交接文件 §6.5。

### 修复部署后的用户反馈

用户随后确认「可以」，并报告说日语时偶发识别成中文。记录为真人输入识别已可用（用户现场反馈），完整日语固定五句、原始转写对照和质量门槛未完成；TTS / INT-02 无新增验收结论。当前本地 Whisper 客户端发送 `language=auto`，忽略界面手动语言，不据此判定发音、模型或检测中的哪项是根因。准确性与语言检测留作后续定位，未通过降低阈值或修改测试掩盖问题。
