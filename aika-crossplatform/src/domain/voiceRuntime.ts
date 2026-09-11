/**
 * 语音运行时的时间与轮次契约。
 *
 * `atMonotonicMs` 只能用于同一运行时内做耗时计算；`recordedAtUtc` 只用于
 * 人能读的日志和跨进程对照，不能拿来相减。音频引擎若能从采样位置换算时间，
 * `timeSource` 为 audio；Web Speech 没有可靠的音频时间轴，只能明确标 estimated。
 */

export type VoiceTimeSource = "audio" | "estimated";

export interface SpeechStartEvent {
  segmentId: string;
  sequence: number;
  audioStartAt: number;
  timeSource: VoiceTimeSource;
}

export interface SpeechSegmentTiming extends SpeechStartEvent {
  /** 用户最后有声采样对应的时间，不是 VAD 尾静音结束时间。 */
  audioEndAt: number;
}

export interface SpeechFinalResult extends SpeechSegmentTiming {
  text: string;
}

export type VoiceRuntimeEventName =
  | "speechEnd"
  | "asrFinal"
  | "turnCommitted"
  | "firstText"
  | "firstAudio"
  | "interruptDetected"
  | "playbackStopped";

export interface VoiceRuntimeEvent {
  name: VoiceRuntimeEventName;
  /** 事件在单调时间轴上的发生时间；用于 P50/P95 和耗时计算。 */
  atMonotonicMs: number;
  /** 记录事件时的 UTC 时间；不参与耗时计算。 */
  recordedAtUtc: string;
  turnId?: number;
  segmentId?: string;
  timeSource?: VoiceTimeSource;
  details?: Record<string, boolean | number | string | null>;
}

export type VoiceTelemetrySink = (event: VoiceRuntimeEvent) => void;

export type PlaybackStatus = "unknown" | "played";

/** 一次可取消的 LLM/语音轮次请求，跨 Hook 和会话层传递。 */
export interface VoiceTurnRequest {
  turnId: number;
  /**
   * Runtime 的轮次 uuid，由会话层在发起这一轮时写进来。
   *
   * 与上面的 `turnId`（语音回合号，number）是两回事，不要合并——Trace 按 uuid
   * 归组，而聊天页点朗读压根不属于任何一轮，那时这里是 undefined，**不许编一个**。
   */
  runtimeTurnId?: string;
  signal: AbortSignal;
  getPlaybackStatus?(): PlaybackStatus;
  /** 语音队列完全 drained 后由调用方触发，允许会话层解除中断监听。 */
  onPlaybackComplete?(): void;
  /** TTS 队列处理完但没有任何一句成功开始播放时触发，不得按「听过」收尾。 */
  onPlaybackFailed?(message?: string): void;
}

export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function utcNow(): string {
  return new Date().toISOString();
}
