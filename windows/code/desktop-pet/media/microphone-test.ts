// FIX61-07: microphone device choice, local test recording and diagnosis.
//
// Two rules drive this module:
//  1. The microphone test must work even when the backend failed. It is a local device check, not a
//     conversation: it never touches the camera, the network, ASR, the LLM or Timeline.
//  2. "Which device am I actually using" must be answerable from real track settings. A missing value is
//     reported as unknown, never filled with a fabricated default.
//
// FIX61-11: this file deliberately imports NOTHING from node, and does NOT re-export the preference store:
// the desktop renderer bundles it (FIX61-07 §2 puts the test there), so a filesystem dependency anywhere in
// this module's import graph would break the browser build. `MicrophonePreferenceStore` therefore lives in
// `microphone-preference.ts`, which only the backend and Electron main import.

/** A microphone test is capped at five seconds and only ever exists in memory. */
export const TEST_RECORD_MAX_MS = 5000;

export interface AudioInputDevice { readonly deviceId: string; readonly label: string; readonly kind: 'audioinput' }
export interface TrackSettingsDescription {
  readonly sampleRate: number | null;
  readonly channelCount: number | null;
  readonly label: string | null;
  readonly deviceId: string | null;
}
export interface MicrophoneLevel { readonly rms: number; readonly peak: number }
export interface MicrophoneDiagnosis { readonly code: MicrophoneDiagnosisCode; readonly message: string }
export type MicrophoneDiagnosisCode = 'device_missing' | 'label_hidden' | 'permission_denied' | 'device_busy' | 'no_signal' | 'ok';

/** Reads only what the track actually reports; absent values stay null (unknown). */
export function describeTrackSettings(settings: { sampleRate?: unknown; channelCount?: unknown; label?: unknown; deviceId?: unknown }): TrackSettingsDescription {
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
  return {
    sampleRate: number(settings.sampleRate),
    channelCount: number(settings.channelCount),
    label: text(settings.label),
    deviceId: text(settings.deviceId)
  };
}

/** The subset of the media API a microphone test uses. Injectable so tests never touch a real device. */
export interface MicrophoneMedia {
  enumerateDevices(): Promise<readonly { kind?: string; deviceId?: string; label?: string }[]>;
  getUserMedia(constraints: { audio?: unknown; video?: unknown }): Promise<MicrophoneStreamLike>;
}
export interface MicrophoneStreamLike {
  getTracks(): readonly { stop(): void; getSettings?(): { sampleRate?: unknown; channelCount?: number; deviceId?: unknown }; label?: string }[];
  getAudioTracks?(): readonly { stop(): void; getSettings?(): { sampleRate?: unknown; channelCount?: number; deviceId?: unknown }; label?: string }[];
}
export interface MicrophoneTestOwner { readonly media: MicrophoneMedia; readonly store: import('./microphone-preference.js').MicrophonePreferenceStore }

export interface MicrophoneTestSession {
  readonly leaseId: string;
  readonly deviceId: string | null;
  readonly settings: TrackSettingsDescription;
  readonly maxDurationMs: number;
}

/**
 * One explicit microphone-test lease. It is intentionally independent of the backend connection state:
 * a failed or not-yet-ready backend must not block the user from checking whether the device works.
 * It never requests the camera and never opens a conversation capture at the same time.
 */
export class MicrophoneTestLease {
  #active: { leaseId: string; stream: MicrophoneStreamLike; level: MicrophoneLevel | null; timer: ReturnType<typeof setTimeout> | null } | null = null;
  #serial = 0;
  constructor(private readonly owner: MicrophoneTestOwner) {}

  /** Metadata only: never requests permission, and never lists a camera. */
  async listDevices(): Promise<readonly AudioInputDevice[]> {
    if (!this.owner.media) return [];
    const devices = await this.owner.media.enumerateDevices();
    return devices
      .filter(device => device.kind === 'audioinput' && typeof device.deviceId === 'string' && device.deviceId.length > 0)
      .map(device => Object.freeze({ deviceId: device.deviceId!, label: typeof device.label === 'string' ? device.label : '', kind: 'audioinput' as const }));
  }

  /** The explicit user action that requests permission. Audio only. */
  async start(input: { deviceId?: string | null } = {}): Promise<MicrophoneTestSession> {
    if (!this.owner.media) throw new Error('microphone_test_unavailable');
    if (this.#active) await this.stop(this.#active.leaseId);
    const requested = input.deviceId ?? null;
    // A test lease is one microphone at a time; it never opens alongside a conversation capture.
    const stream = await this.owner.media.getUserMedia({
      audio: requested === null ? { echoCancellation: false } : { deviceId: { exact: requested }, echoCancellation: false },
      video: undefined
    });
    const track = stream.getAudioTracks?.()[0] ?? stream.getTracks()[0];
    if (!track) { for (const item of stream.getTracks()) item.stop(); throw new Error('microphone_track_unavailable'); }
    const settings = describeTrackSettings({ ...(track.getSettings?.() ?? {}), label: track.label });
    const leaseId = `mic-test-${++this.#serial}`;
    const timer = setTimeout(() => { void this.stop(leaseId); }, TEST_RECORD_MAX_MS);
    this.#active = { leaseId, stream, level: null, timer };
    return Object.freeze({ leaseId, deviceId: settings.deviceId ?? requested, settings, maxDurationMs: TEST_RECORD_MAX_MS });
  }

  active(): boolean { return this.#active !== null; }

  /**
   * FIX61-11: the stream this lease actually opened, so a recorder or a level tap can attach to the SAME
   * microphone instead of acquiring a second one. Two concurrent acquisitions for one test would open the
   * device twice and could fail or fight over it. Null when no test is running.
   */
  stream(leaseId: string): MicrophoneStreamLike | null {
    return this.#active?.leaseId === leaseId ? this.#active.stream : null;
  }

  /** A level outside the documented range is refused rather than displayed as if it were measured. */
  validateLevel(level: MicrophoneLevel): void {
    const ok = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    if (!ok(level.rms) || !ok(level.peak) || level.peak < level.rms) throw new Error('麦克风电平必须在 0~1 之间，且峰值不低于均值。');
  }

  reportLevel(leaseId: string, level: MicrophoneLevel): void {
    this.validateLevel(level);
    if (this.#active?.leaseId !== leaseId) return;
    this.#active.level = Object.freeze({ rms: level.rms, peak: level.peak });
  }
  level(leaseId: string): MicrophoneLevel | null { return this.#active?.leaseId === leaseId ? this.#active.level : null; }

  /** Releases every track and drops the buffer; the local playback object URL is the caller's to revoke. */
  async stop(leaseId: string): Promise<void> {
    const active = this.#active;
    if (!active || active.leaseId !== leaseId) return;
    this.#active = null;
    if (active.timer) clearTimeout(active.timer);
    active.level = null;
    for (const track of active.stream.getTracks()) { try { track.stop(); } catch { /* releasing one track must not block the rest */ } }
  }

  /**
   * Separate causes stay separate: an unplugged device, a hidden label, a denied permission, a busy
   * device and a silent (all-zero) capture are five different user-facing problems.
   */
  diagnose(input: { requestedDeviceId: string | null; devices: readonly AudioInputDevice[]; error?: { name?: string } | null; observedNonzero?: boolean; sampleCount?: number }): MicrophoneDiagnosis {
    const failure = input.error?.name ?? '';
    if (failure === 'NotAllowedError' || failure === 'SecurityError') return Object.freeze({ code: 'permission_denied', message: '麦克风权限被拒绝。请在系统隐私设置中允许本应用使用麦克风后重试。' });
    if (failure === 'NotReadableError' || failure === 'TrackStartError') return Object.freeze({ code: 'device_busy', message: '麦克风被其他程序占用。请关闭占用它的程序后重试。' });
    if (failure === 'NotFoundError' || failure === 'OverconstrainedError') return Object.freeze({ code: 'device_missing', message: '所选麦克风不存在或已被拔出。请重新选择设备。' });
    if (input.requestedDeviceId !== null && !input.devices.some(device => device.deviceId === input.requestedDeviceId)) {
      return Object.freeze({ code: 'device_missing', message: '所选麦克风已被移除或拔出。请重新选择设备，或改为使用系统默认设备。' });
    }
    const selected = input.requestedDeviceId === null ? input.devices[0] : input.devices.find(device => device.deviceId === input.requestedDeviceId);
    if (selected && selected.label === '') return Object.freeze({ code: 'label_hidden', message: '设备名称不可见：系统尚未授予麦克风权限。授权后即可看到设备名称。' });
    if (input.sampleCount !== undefined && input.observedNonzero === false) {
      return Object.freeze({ code: 'no_signal', message: '已录到音频但电平全为零：麦克风可能静音、未连接输入源或被系统静音。' });
    }
    return Object.freeze({ code: 'ok', message: '' });
  }
}
