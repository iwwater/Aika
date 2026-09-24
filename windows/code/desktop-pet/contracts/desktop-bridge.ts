import type { CompanionIntroduction } from './character.js';
import type { CharacterId, DesktopCommand, DesktopEvent, PlaybackEvent, TtsResult, TurnScope } from './index.js';

/** NDJSON over local child-process stdio, forwarded by the native shell. Never contains credentials. */
export const DESKTOP_BRIDGE_VERSION = '0.7.0' as const;
/** Additive safe diagnostics; arbitrary device/provider messages are never user-facing protocol data. */
export const DEVICE_FAILURE_CODES = ['permission_denied', 'device_unavailable', 'capture_module_failed',
  'capture_start_failed', 'capture_finish_failed', 'device_operation_failed'] as const;
export const DEVICE_FAILURE_STAGES = ['get_user_media', 'audio_worklet', 'audio_resume', 'camera_preview',
  'capture_finish', 'unknown'] as const;
export interface DeviceFailure {
  readonly code: typeof DEVICE_FAILURE_CODES[number];
  readonly stage: typeof DEVICE_FAILURE_STAGES[number];
}
export interface BridgeMedia { readonly id: string; readonly mimeType: string; readonly base64: string }
/** FIX61-08: one live PCM16 mono frame from the authorized capture. At most 200 ms at 16 kHz. */
export interface BridgeVoiceChunk {
  readonly channel: 'voice_chunk';
  /** Echoed from the voice_frame request that asked for this frame. */
  readonly requestId?: string;
  /** The authorized input session this frame belongs to. */
  readonly inputSessionId: string;
  /** Turn generation echoed from the request; a stale generation is refused. */
  readonly generation: number;
  /** Monotonic frame index; a repeat is ignored and a gap is an error, never a silent hole. */
  readonly index: number;
  /** The rate the device actually produced; the receiver resamples when it differs. */
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly pcm: string;
}
// Production capture returns required audio and zero to three actual images.
// Capture readiness and finish never wait for the camera; historical evaluation has its own frame policy.
export type BackendToDesktop =
  | import('./wake.js').WakeToDesktop
  | { readonly channel: 'work_speech'; readonly event: import('./desktop-work.js').WorkSpeechEvent }
  | { readonly channel: 'input_route'; readonly scope: TurnScope; readonly route: 'companion' | 'work' }
  | { readonly channel: 'work_state'; readonly state: import('./desktop-work.js').DesktopWorkState }
  | { readonly channel: 'presentation_policy'; readonly policy: import('./presentation-presets.js').PresentationPolicy }
  | { readonly channel: 'backend_ready'; readonly bridgeVersion: typeof DESKTOP_BRIDGE_VERSION; readonly characterId: CharacterId; readonly sessionId: string; readonly introduction?: CompanionIntroduction }
  | { readonly channel: 'event'; readonly event: DesktopEvent }
  | { readonly channel: 'capture_start' | 'capture_finish' | 'capture_stop'; readonly requestId: string; readonly scope: TurnScope }
  // FIX61-08: ack-based backpressure for the live leg. One acknowledgement per accepted voice_chunk;
  // once 20 frames are unacknowledged the renderer stops recording and shows the reason.
  | { readonly channel: 'voice_chunk_ack'; readonly inputSessionId: string; readonly generation: number; readonly index: number }
  | { readonly channel: 'play'; readonly requestId: string; readonly tts: TtsResult; readonly audioBase64: string }
  | { readonly channel: 'stop'; readonly requestId: string; readonly scope: TurnScope }
  /**
   * FIX61-08 pull leg: the backend requests exactly the next frame it wants and the renderer answers
   * with a `voice_chunk` carrying that `requestId`. One request in flight keeps the recognizer fed
   * without letting the renderer buffer unbounded audio ahead of it.
   */
  | { readonly channel: 'voice_frame'; readonly requestId: string; readonly inputSessionId: string;
      readonly generation: number; readonly index: number; readonly sampleRate: number; readonly sampleCount: number };
export type DesktopToBackend =
  | import('./wake.js').WakeFromDesktop
  | { readonly channel: 'presence'; readonly isTyping: boolean; readonly isSpeaking: boolean; readonly isTurnActive: boolean; readonly isWorkPendingConfirmation: boolean }
  | { readonly channel: 'work_action'; readonly action: import('./desktop-work.js').DesktopWorkAction }
  | { readonly channel: 'command'; readonly command: DesktopCommand }
  | BridgeVoiceChunk
  | { readonly channel: 'ack'; readonly requestId: string }
  | { readonly channel: 'capture'; readonly requestId: string; readonly result: {
    readonly scope: TurnScope; readonly audio: BridgeMedia; readonly images: readonly BridgeMedia[];
    readonly inputEndedAt: string; readonly captureStoppedAt: string;
  } }
  | { readonly channel: 'playback'; readonly requestId: string; readonly event: PlaybackEvent }
  | { readonly channel: 'rpc_error'; readonly requestId: string; readonly message: string;
    readonly scope?: TurnScope; readonly error?: DeviceFailure };

// Acks: capture_start after audio is ready, independent of camera; capture_stop/stop after tracks/output stop.
// capture_finish returns capture, never ack. play completes on one terminal PlaybackEvent.
// FIX61-08 live audio: while one voice turn is authorized, the renderer frames its captured mono PCM
// into 100 ms chunks and pushes each one as voice_chunk. The backend answers voice_chunk_ack once the
// frame entered the recognizer; more than 20 unacknowledged frames stop the capture (backpressure).
// Native EOF/window close stops all renderer devices and cancels the backend process.
// Base64 values are ephemeral copies; discard after transfer/use. Local pet-media/blob URIs
// are identifiers only: each receiving process must create its own scoped media-store entry.
