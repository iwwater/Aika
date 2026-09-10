# STT 架构与接口

拟定逻辑契约，现有 `services/voice/contracts.ts` 可用 adapter 兼容。核心按 Capture→VAD→Segment→ASR→OrderedBuffer→TurnEnd 分层，Provider 只负责将单段音频转写为文本。

```ts
interface Segment { sessionId: string; segmentId: string; sequence: number;
  pcm: Float32Array; sampleRate: number; speechEndedAt: number; }
interface Transcript { segmentId: string; sequence: number; text: string;
  speechEndedAt: number; timingPrecision: "audio" | "estimated"; }
interface AsrPort { transcribe(segment: Segment, signal: AbortSignal): Promise<Transcript>; }
interface SpeechInputPort {
  start(options: { language: "auto" | "zh-CN" | "ja-JP" | "en-US" }): Promise<void>;
  stop(): void;
  cancel(): void;
  sendNow(): void;
  clear(): void;
  subscribe(listener: (event: InputEvent) => void): () => void;
  dispose(): void;
}
```

InputEvent 为带 sessionId 的判别联合：speechStart、segmentFinal(Transcript)、turnReady(text/speechEndedAt/precision)、error(code/recoverable)、stopped。时间为统一单调时钟，绝对日期仅用于记录。start 幂等，cancel 丢弃旧输入会话在途结果；stop 停止采集并按显式策略排空，不能悄悄等价 cancel。sendNow 只提交已确认文本，未完成 ASR 的处理必须标记并保证以后不重复提交旧段；clear 递增输入 epoch，使此前未完成段失效。

STT-01 交付引擎端口/错误契约；STT-02 交付有序 buffer 与 turnReady 判定；STT-03 只增加设备证据，不更改上游接口。LLM/TTS 均以事件 recorder 替代；不得在 STT 内创建对话 turnId 或调用 LLM。
