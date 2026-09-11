import type {
  SpeechFinalResult,
  SpeechSegmentTiming,
  SpeechStartEvent,
} from "../../domain/voiceRuntime";

export type {
  PlaybackStatus,
  SpeechFinalResult,
  SpeechSegmentTiming,
  SpeechStartEvent,
  VoiceTurnRequest,
} from "../../domain/voiceRuntime";

/**
 * 识别引擎的语言码。
 * 这不是给用户选的开关——它由 domain/language.ts 按用户最近说的话推导。
 * Web Speech 一次只能给一个语言码；真正的中日混说识别要等 M3 的本地 Whisper。
 */
export type VoiceInputLanguage = "ja-JP" | "zh-CN" | "en-US";
export type VoicePhase = "idle" | "listening" | "thinking" | "speaking" | "error";
export type VoiceEngineKind = "web-speech" | "whisper-local" | "style-bert-vits2" | "cloud-tts";

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
  /**
   * 这一句用哪种语言念。
   *
   * 系统合成要靠它挑音色——它的每个音色只认一种语言。云端合成的模型本身是多语的，
   * 一个音色念全部三种，所以那条链路会忽略这个字段。「换语言不能换成另一个人」
   * 这条约束在云端那边是白送的，在系统合成那边要靠逐句挑音色去凑。
   */
  language: VoiceInputLanguage;
  /** 语速倍率。系统合成映射到 `rate`，云端合成乘上用户设的基线之后映射到 `speed`。 */
  rate?: number;
  /**
   * 音高倍率。
   *
   * **只有系统合成认。** OpenAI 兼容的 `/audio/speech` 没有音高参数，
   * 所以走云端时 `domain/mood.ts` 那七个语气只剩语速这一半能表达出来。
   * 换来的是能听的音色——这个取舍要让用户在设置页看得见。
   */
  pitch?: number;
  /** 内部关联字段；引擎不应把它展示给用户。 */
  turnId?: number;
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
  /**
   * 可选：提前把这一句准备好，但不要播。
   *
   * 给要走网络的引擎用。队列在开始念第 n 句时会顺手预取第 n+1 句，
   * 这样往返延迟藏在上一句的播放时间里，句与句之间不会出现说不清的静默。
   *
   * 本地合成不需要实现它——系统合成没有等待，多这一层只会白做。
   * 因此调用方一律写成 `engine.prefetch?.(…)`，没有实现就是没有这一步。
   */
  prefetch?(request: SpeechOutputRequest): void;
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
  onSpeechStart?(event: SpeechStartEvent): void;
  onInterim?(text: string, atMonotonicMs?: number): void;
  /** 一段音频已经结束，但 ASR 可能仍在路上；调用方据此阻止过早提交。 */
  onSegmentEnd?(event: SpeechSegmentTiming): void;
  /** 这一段的最终文本。识别不出内容时给空串，调用方据此结束「正在说」状态。 */
  onFinal?(result: SpeechFinalResult): void;
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
