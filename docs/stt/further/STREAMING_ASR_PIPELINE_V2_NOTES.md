# Streaming Voice Pipeline V2 · 资料笔记

> 来源：用户 2026-09-16 提供的外部分析（6 段字幕 × 现有代码对照评审）。本文只做登记与要点沉淀，**不是计划、不构成执行授权**。立项时以本文为输入走 PRD/SPEC 流程（候选归宿：`docs/stt` 新 SPEC，暂名 STT-05）。

## 一句话结论

对 Aika 语音链路很有价值，但**不照教程重构项目**。真正要吸收的是：Streaming STT + WebSocket 长连接 + 流式 LLM + Streaming TTS + Barge-in；现有 VAD、turnReady、模块契约、一回合一次 LLM 全部保留。

## 核心诊断

当前链路是「流式收音，但不是流式识别」：Silero VAD 检测到 speech-end 后才截取整段 Float32 交给 `WhisperClient.transcribe(samples)`，Whisper 必须等用户说完才开工。这是「没有 GPT Live 对话感」的主要延迟来源。

## 目标形态（V2）

```
Mic → AudioCapture ─┬→ Silero VAD → 本地回合判断（保留）
                    └→ WebSocket → Streaming ASR（长连接 Session）
                                      partial → UI
                                      final  → turnReady → CompanionRuntime（1 Turn = 1 LLM）
                                      replyDelta → Phrase Chunker → Streaming TTS WebSocket → Audio Player
```

关键认知修正（不能照字幕字面实现的三点）：

1. **不是每 100ms 新调一次 STT**，而是给一个持久 WebSocket ASR Session 喂 PCM frame（partial 逐步推进，final 收口）。
2. **不要每个 LLM token 单独送 TTS**，要 Phrase/Sentence Chunker：缓冲到句子/短语粒度再送 TTS，同时下一句预取进入播放队列（现有 speechQueue + prefetch 保留）。
3. **不是全项目 WebSocket 化**：只有远程 Streaming ASR / Streaming TTS 这类长期双向媒体流用 WebSocket；LLM 文本继续 HTTP+SSE；模块内部继续 TS interface / Tauri command / Rust event。

## Silero VAD 保留理由

Silero 承担的不只是 STT 切片，还负责本地回合判断与 Barge-in：Aika 说话中检测到 speechStart → `TTS.stop()` + 清空音频队列 + `Runtime.cancel(oldTurn)`，同时继续 STT。该契约已在现有架构中定义，V2 是把语音链路进一步流式化，不是推翻。

## 三档插件化方案（与现有 SpeechInputEngine / TTS Provider 契约兼容）

Voice Input：
1. Web Speech（最轻，兼容/兜底，已支持 interim）
2. Local Whisper + Silero（隐私/离线，当前实现）
3. Streaming ASR（最低延迟，陪伴模式推荐）← 新增 `StreamingAsrInput`，实现同一 `SpeechInputEngine` 契约（speechStart / segmentFinal / turnReady / error）

Voice Output：
1. System TTS（免费兜底）
2. HTTP Cloud TTS（当前方案）
3. Streaming TTS（实时陪伴模式）

上层 VoicePresenter / Turn Controller / CompanionRuntime / Memory / Soul 无需感知底层切换。

## 优先级草案（摘录）

P0：StreamingAsrInputEngine、长连接 ASR Session、partial transcript、Silero 与 Streaming ASR 并行、speechStart → TTS.stop（Barge-in 接通）、ASR/LLM/TTS latency trace。

P1：LLM Phrase Chunker、Streaming TTS Provider、Audio chunk playback queue、cancel token / generation 统一。

明确不做：FastAPI/LangGraph 重写、WebSocket 全项目化、Web Coding Agent、代码审查 Agent、微服务化。

## 参考链接

- 阿里云 Fun-ASR Realtime WebSocket API（task 建立后持续发二进制音频、持续收结果）
- 阿里云实时语音识别用户指南（DashScope SDK）
- 阿里云 Qwen-TTS Realtime（streaming input + streaming output，降 first-packet latency）
