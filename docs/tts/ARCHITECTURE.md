# TTS 架构与接口

TextSegments→SynthesisAdapter→PlaybackQueue→DeliveryEvents。合成结果和真正播放完成分开；文本分句不得等待全部回复，音频队列不得因合成乱序而打乱句序。

```ts
interface SpeechSentence { turnId: string; sentenceId: string; sequence: number;
  text: string; language: "zh-CN" | "ja-JP" | "en-US"; style?: string; }
interface SpeechOutputPort {
  enqueue(sentence: SpeechSentence): void;
  endTurn(turnId: string): void; // 不再追加句子后才允许 drained
  stop(turnId: string): void;
  subscribe(listener: (event: OutputEvent) => void): () => void;
  dispose(): void;
}
```

OutputEvent 是 turnId/句子标识/单调时间/precision 的判别联合：started、sentenceCompleted、drained、stopRequested、stopped、error。每轮 sequence 单调，重复 sentenceId 幂等忽略。drained 仅在 endTurn 且队列空且无在途音频时发生；失败句必须显式记录，不能据 drained 推断所有文本均已听到。

TTS-01 实现分句/队列和 endTurn；TTS-02 实现 generation 隔离与停止/交付语义；TTS-03 验证真实音频延迟。现有 Web Speech 后端可直接 speak，无可访问 PCM 时使用 progress proxy；不能伪造 samples 或精确口型数据。stop 后的合成/播放回调一律按 generation 验证，新 turn 不受旧回调影响。
