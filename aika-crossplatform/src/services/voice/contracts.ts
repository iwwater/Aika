/**
 * 识别引擎的语言码。
 * 这不是给用户选的开关——它由 domain/language.ts 按用户最近说的话推导。
 * Web Speech 一次只能给一个语言码；真正的中日混说识别要等 M3 的本地 Whisper。
 */
export type VoiceInputLanguage = "ja-JP" | "zh-CN" | "en-US";
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
  /**
   * 用户开口了。
   *
   * Web Speech 靠中间结果就能说明「人还在说」，Whisper 没有中间结果——
   * 从开口到转写回来这段时间里一个事件都没有，回合计时器会误判成静音并提前提交。
   * 所以引擎必须显式说一声。
   */
  onSpeechStart?(): void;
  onInterim?(text: string): void;
  /** 这一段的最终文本。识别不出内容时给空串，调用方据此结束「正在说」状态。 */
  onFinal?(text: string): void;
  onError?(code: string, message?: string): void;
  onEnd?(): void;
}

export interface SpeechInputEngine {
  readonly id: string;
  readonly kind: VoiceEngineKind;
  /**
   * 麦克风是不是一直开着。
   *
   * Web Speech 每识别出一段就自己停，必须重新 start()，段与段之间有空窗；
   * 本地管线的麦克风全程不关，由 VAD 自己切段。两者的调度方式不一样，
   * 上层据此决定要不要在每段结束后重启、以及说话期间靠什么检测打断。
   */
  readonly continuous: boolean;
  isAvailable(): boolean;
  requestPermission(): Promise<void>;
  start(language: VoiceInputLanguage, events: SpeechInputEvents): void;
  stop(): void;
  abort(): void;
  dispose(): void;
}
