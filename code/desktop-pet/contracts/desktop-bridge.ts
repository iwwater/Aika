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
  | { readonly channel: 'play'; readonly requestId: string; readonly tts: TtsResult; readonly audioBase64: string }
  | { readonly channel: 'stop'; readonly requestId: string; readonly scope: TurnScope };
export type DesktopToBackend =
  | import('./wake.js').WakeFromDesktop
  | { readonly channel: 'work_action'; readonly action: import('./desktop-work.js').DesktopWorkAction }
  | { readonly channel: 'command'; readonly command: DesktopCommand }
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
// Native EOF/window close stops all renderer devices and cancels the backend process.
// Base64 values are ephemeral copies; discard after transfer/use. Local pet-media/blob URIs
// are identifiers only: each receiving process must create its own scoped media-store entry.
