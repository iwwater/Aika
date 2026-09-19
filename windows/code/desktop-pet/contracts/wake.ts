/** B28 local-only wake protocol. Runtime enabled is never persisted or restored. */
export const WAKE_VERSION = '0.1.0' as const;
export const WAKE_DEFAULT_SETTINGS: WakeSettings = { keyword: '乐正绫', sensitivity: 'standard', silenceMs: 3000 };
export type WakeSensitivity = 'standard' | 'sensitive' | 'strict';
export interface WakeSettings { keyword: string; sensitivity: WakeSensitivity; silenceMs: number }
export type WakePhase = 'off' | 'connecting' | 'waiting' | 'listening' | 'submitting' | 'replying' | 'paused' | 'error';
export interface WakeSnapshot {
  version: typeof WAKE_VERSION; instanceId: string; revision: number; settings: WakeSettings;
  available: boolean; detail?: string;
  session: { generation: number; enabled: boolean; phase: WakePhase; detail?: string; echoCancellation?: boolean };
}
export interface WakeManagement {
  snapshot(): WakeSnapshot;
  save(instanceId: string, expectedRevision: number, settings: unknown): Promise<WakeSnapshot>;
  enable(instanceId: string, expectedRevision: number, expectedGeneration: number, enabled: boolean): Promise<WakeSnapshot>;
}
export type WakeToDesktop =
  | { channel: 'wake_control'; generation: number; enabled: boolean; settings: WakeSettings }
  | { channel: 'wake_result'; generation: number; sequence: number; samples: number; speech: boolean; keyword?: string }
  | { channel: 'wake_error'; generation: number; detail: string };
export type WakeFromDesktop =
  | { channel: 'wake_pcm'; generation: number; sequence: number; pcm16Base64: string }
  | { channel: 'wake_status'; generation: number; phase: WakePhase; echoCancellation?: boolean; detail?: string };
/** Float32 mono 16k, <=3200 samples/frame. One in-flight frame, <=16000 queued samples.
 * No samples in diagnostics/files/cloud. Result is the ack; overload fails closed.
 * Keyword is only a local trigger. Original start_voice/finish_voice and scope remain authoritative.
 */
export interface WakeDetectorResult { keyword?: string; speech: boolean }
export interface WakeDetector {
  accept(samples: Float32Array): Promise<WakeDetectorResult>;
  /** Listening controls VAD lifetime; repeated same state is idempotent. Waiting keeps no VAD utterance buffer. */
  setCapturing(active: boolean): Promise<void>;
  /** Clear KWS/VAD and detector PCM on PTT takeover or discontinuity. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
export interface WakeDetectorOptions { modelDirectory: string; settings: WakeSettings }
