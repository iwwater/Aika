export type VoiceInputLanguage = "ja-JP" | "zh-CN";
export type VoicePhase = "idle" | "listening" | "thinking" | "speaking" | "error";
export type VoiceEngineKind = "web-speech" | "whisper-local" | "style-bert-vits2";

export interface VoiceCaption {
  id: number;
  speaker: "user" | "assistant";
  /** 主字幕：用户的识别结果，或 Aika 的日语正文。 */
  text: string;
  /** 次级字幕：Aika 的中文翻译，缺失时不显示第二层。 */
  translation?: string;
}

export interface SpeechOutputRequest {
  text: string;
  language: VoiceInputLanguage;
  rate?: number;
  pitch?: number;
}

export interface SpeechOutputEvents {
  onStart?(): void;
  onEnd?(): void;
  onError?(message: string): void;
}

export interface SpeechOutputEngine {
  readonly id: string;
  readonly kind: VoiceEngineKind;
  isAvailable(): boolean;
  speak(request: SpeechOutputRequest, events?: SpeechOutputEvents): void;
  stop(): void;
}

export interface SpeechInputEvents {
  onStart?(): void;
  onInterim?(text: string): void;
  onFinal?(text: string): void;
  onError?(code: string, message?: string): void;
  onEnd?(): void;
}

export interface SpeechInputEngine {
  readonly id: string;
  readonly kind: VoiceEngineKind;
  isAvailable(): boolean;
  requestPermission(): Promise<void>;
  start(language: VoiceInputLanguage, events: SpeechInputEvents): void;
  stop(): void;
  abort(): void;
  dispose(): void;
}
