// FIX61-11 wiring for FIX61-07: the desktop renderer's microphone test ("试麦").
//
// FIX61-07 §2 puts the mic test in the TRUSTED DESKTOP RENDERER, not the management console: there is no
// websocket/MCP channel, so letting the console page call getUserMedia would test the browser's device,
// not the pet's. This module is the renderer-side controller; it is deliberately free of DOM and of
// Electron so the same production object is unit-tested with an injected media/document boundary.
//
// Rules it keeps:
//  * Metadata first. `listDevices()` never requests permission and never lists a camera.
//  * Only an explicit `start()` requests the microphone, and only audio: `video` is never requested.
//  * A test is capped at five seconds and lives only in memory. The object URL it creates is REVOKED on
//    stop/close/failure — a leaked blob URL would keep the recording alive in the process.
//  * It is independent of the backend connection: a failed or not-yet-ready backend must not stop the
//    user from checking whether the device works.
//  * It never opens alongside a conversation capture ("不能同时打开会话采集"): the caller passes
//    `captureBusy`, and a busy conversation capture refuses to start a test rather than competing.
import { MicrophoneTestLease, TEST_RECORD_MAX_MS } from '../media/microphone-test.js';
import type { AudioInputDevice } from '../media/microphone-test.js';

export { TEST_RECORD_MAX_MS };

/** The renderer-side device object. Injectable so tests never touch a real device. */
export interface MicMedia {
  createMediaRecorder?(stream: MicStream): MicRecorderLike;
  createObjectURL?(blob: unknown): string;
  revokeObjectURL?(url: string): void;
}
export interface MicStream {
  getTracks(): readonly { stop(): void }[];
  getAudioTracks?(): readonly { stop(): void }[];
}
export interface MicRecorderLike {
  start(): void;
  stop(): void;
  ondataavailable: ((event: { data: unknown }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
}

export type MicTestState = 'idle' | 'listing' | 'recording' | 'ready' | 'failed';

export interface MicTestSnapshot {
  readonly state: MicTestState;
  readonly devices: readonly AudioInputDevice[];
  readonly deviceId: string | null;
  readonly level: { readonly rms: number; readonly peak: number } | null;
  readonly elapsedMs: number;
  readonly sampleRate: number | null;
  readonly channelCount: number | null;
  readonly label: string | null;
  readonly diagnosis: { readonly code: string; readonly message: string } | null;
  /** True while a bounded local recording is playable. The URL is never exposed to a caller. */
  readonly playable: boolean;
  readonly maxDurationMs: number;
}

export interface MicTestOptions {
  readonly media: MicMedia;
  readonly lease: MicrophoneTestLease;
  /**
   * The stream the lease opened for this lease id. Required for a recording or a level tap: the test must
   * attach to the ONE device the lease acquired rather than opening a second microphone.
   */
  readonly streamFor?: (leaseId: string) => MicStream | null;
  /** Read from the live renderer so a conversation capture and a test can never overlap. */
  readonly captureBusy?: () => boolean;
  /** Called with a copy of the snapshot on every change. Never with samples or a device path. */
  readonly onChange?: (snapshot: MicTestSnapshot) => void;
  /** Monotonic clock, injectable for tests. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * One level report stands for one analysis window of real PCM. It is a count of OBSERVATIONS, not of
 * samples: it only answers "did we ever receive audio", so the "all-zero PCM" diagnosis can be stated
 * without pretending to know how many samples the browser's own analyser window contained.
 */
const LEVEL_OBSERVATION = 1;

/**
 * One mic-test session for the desktop window. It owns exactly one lease, one recorder and one object
 * URL at a time; every path out of a session (stop, close, timeout, error) releases all three.
 */
export class MicTestController {
  #state: MicTestState = 'idle';
  #devices: readonly AudioInputDevice[] = Object.freeze([]);
  #deviceId: string | null = null;
  #level: { rms: number; peak: number } | null = null;
  #diagnosis: { code: string; message: string } | null = null;
  #leaseId: string | null = null;
  #levelSource: MicStream | null = null;
  #settings: { sampleRate: number | null; channelCount: number | null; label: string | null; deviceId: string | null } | null = null;
  #startedAt = 0;
  #sawNonzero = false;
  #levelWindows = 0;
  #objectUrl: string | null = null;
  #blob: unknown = null;
  #recorder: MicRecorderLike | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #chunks: unknown[] = [];
  #disposed = false;
  readonly #options: MicTestOptions;

  constructor(options: MicTestOptions) { this.#options = options; }

  snapshot(): MicTestSnapshot {
    return Object.freeze({
      state: this.#state,
      devices: this.#devices,
      deviceId: this.#deviceId,
      level: this.#level,
      elapsedMs: this.#startedAt ? Math.max(0, this.#now() - this.#startedAt) : 0,
      sampleRate: this.#settings?.sampleRate ?? null,
      channelCount: this.#settings?.channelCount ?? null,
      label: this.#settings?.label ?? null,
      diagnosis: this.#diagnosis,
      playable: this.#objectUrl !== null,
      maxDurationMs: TEST_RECORD_MAX_MS
    });
  }
  #now(): number { return this.#options.now ? this.#options.now() : Date.now(); }
  #emit(): MicTestSnapshot { const value = this.snapshot(); this.#options.onChange?.(value); return value; }

  get active(): boolean { return this.#state === 'recording'; }
  /** The playable URL is read only by the audio element, never handed to a caller or persisted. */
  get objectUrl(): string | null { return this.#objectUrl; }
  /**
   * The ONE stream this test opened, for a level tap. Null outside a test, so a stray tap cannot attach to
   * a released device.
   */
  get levelSource(): MicStream | null { return this.#state === 'recording' ? this.#levelSource : null; }

  /**
   * Metadata only. It never requests permission, so it is safe to call the moment the panel opens —
   * and it is why a device label can legitimately be empty until the user grants access.
   */
  async listDevices(): Promise<MicTestSnapshot> {
    if (this.#disposed) return this.snapshot();
    this.#state = 'listing'; this.#emit();
    try {
      const devices = await this.#options.lease.listDevices();
      this.#devices = Object.freeze(devices.map(device => Object.freeze({ deviceId: device.deviceId, label: device.label, kind: 'audioinput' as const })));
      // A stored choice that no longer exists is reported, never silently replaced by another device.
      this.#diagnosis = this.#options.lease.diagnose({ requestedDeviceId: this.#deviceId, devices: this.#devices });
      this.#state = 'idle';
    } catch (error) {
      this.#state = 'failed';
      this.#diagnosis = { code: 'list_failed', message: '无法读取麦克风列表：' + message(error) };
    }
    return this.#emit();
  }

  /** An explicit user action. Refuses while a conversation capture is using the device. */
  async start(deviceId: string | null = this.#deviceId): Promise<MicTestSnapshot> {
    if (this.#disposed) return this.snapshot();
    if (this.#options.captureBusy?.()) {
      this.#state = 'failed';
      this.#diagnosis = { code: 'capture_busy', message: '正在对话录音，无法同时试麦。请先结束这一轮对话。' };
      return this.#emit();
    }
    await this.#release();
    this.#deviceId = deviceId;
    this.#state = 'recording'; this.#level = null; this.#diagnosis = null; this.#sawNonzero = false; this.#levelWindows = 0;
    this.#startedAt = this.#now();
    try {
      const session = await this.#options.lease.start({ deviceId });
      this.#leaseId = session.leaseId;
      this.#settings = session.settings;
      // The recorder attaches to the SAME stream the lease opened. Acquiring a second microphone for one
      // test would open the device twice and could fail or fight over it; the lease is the only owner.
      const stream = this.#options.streamFor?.(session.leaseId) ?? null;
      if (stream) this.#startRecorder(stream);
      this.#levelSource = stream;
      // The lease owns the five-second cap; this timer is display-only and never outlives the lease.
      this.#timer = (this.#options.setTimer ?? setTimeout)(() => { void this.stop(); }, TEST_RECORD_MAX_MS);
    } catch (error) {
      const name = (error as { name?: string })?.name ?? '';
      this.#diagnosis = this.#options.lease.diagnose({ requestedDeviceId: deviceId, devices: this.#devices, error: { name } });
      if (this.#diagnosis.code === 'ok') this.#diagnosis = { code: 'start_failed', message: '无法打开麦克风：' + message(error) };
      await this.#release();
      this.#state = 'failed';
    }
    return this.#emit();
  }

  #startRecorder(stream: MicStream): void {
    const create = this.#options.media.createMediaRecorder;
    if (!create) return;
    try {
      const recorder = create(stream);
      recorder.ondataavailable = event => { if (event?.data) this.#chunks.push(event.data); };
      recorder.onerror = () => { this.#diagnosis = { code: 'record_failed', message: '本地录制失败；麦克风仍可用，请重试。' }; };
      recorder.onstop = () => this.#finishRecording();
      recorder.start();
      this.#recorder = recorder;
    } catch { this.#recorder = null; }
  }

  /**
   * Build the local playback URL and drop the chunks. A recorder that produced nothing leaves the entry
   * not playable — an empty playback control would look like a working recording.
   */
  #finishRecording(): void {
    const recorder = this.#recorder; this.#recorder = null;
    if (!recorder || !this.#chunks.length) { this.#chunks = []; return; }
    const createUrl = this.#options.media.createObjectURL;
    if (!createUrl) { this.#chunks = []; return; }
    try {
      // A recorder's chunks are opaque to this module: they are handed to the browser's own Blob
      // constructor and immediately dropped, so no sample copy is retained here.
      const blob = globalThis.Blob ? new Blob(this.#chunks as BlobPart[]) : this.#chunks;
      this.#blob = blob;
      this.#objectUrl = createUrl(blob);
    } catch { this.#objectUrl = null; this.#blob = null; }
    this.#chunks = [];
  }

  /** Called by the DOM layer with a real AudioContext-derived level. Validated by the lease. */
  reportLevel(level: { rms: number; peak: number }): void {
    if (!this.#leaseId || this.#state !== 'recording') return;
    try { this.#options.lease.validateLevel(level); } catch { return; }
    this.#options.lease.reportLevel(this.#leaseId, level);
    this.#levelWindows += LEVEL_OBSERVATION;
    if (level.peak > 0) this.#sawNonzero = true;
    this.#level = Object.freeze({ rms: level.rms, peak: level.peak });
    this.#emit();
  }

  /** Ends the test, releases the device and revokes the previous playback URL. */
  async stop(): Promise<MicTestSnapshot> {
    if (this.#timer !== null) { (this.#options.clearTimer ?? clearTimeout)(this.#timer); this.#timer = null; }
    const leaseId = this.#leaseId;
    this.#recorder?.stop();
    this.#finishRecording();
    // Diagnostics are computed BEFORE the lease is dropped, because the lease holds the observations.
    this.#diagnosis = this.#options.lease.diagnose({ requestedDeviceId: this.#deviceId, devices: this.#devices,
      observedNonzero: this.#sawNonzero, ...(this.#levelWindows ? { sampleCount: this.#levelWindows } : {}) });
    if (leaseId) await this.#options.lease.stop(leaseId).catch(() => {});
    this.#leaseId = null;
    this.#level = null;
    this.#levelSource = null;
    if (this.#state === 'recording') this.#state = this.#diagnosis.code === 'ok' ? 'ready' : 'failed';
    if (this.#diagnosis.code === 'ok') this.#diagnosis = null;
    return this.#emit();
  }

  /** Drops the recording and its object URL without releasing a lease that is already gone. */
  #discardRecording(): void {
    const revoke = this.#options.media.revokeObjectURL;
    if (this.#objectUrl && revoke) { try { revoke(this.#objectUrl); } catch { /* revocation never blocks a close */ } }
    this.#objectUrl = null; this.#blob = null; this.#chunks = [];
  }

  /** Closes the panel: every resource the test owns is released, and the recording is gone. */
  async close(): Promise<void> {
    if (this.#timer !== null) { (this.#options.clearTimer ?? clearTimeout)(this.#timer); this.#timer = null; }
    const leaseId = this.#leaseId;
    try { this.#recorder?.stop(); } catch { /* a failed stop must not block the rest of the cleanup */ }
    this.#recorder = null;
    if (leaseId) await this.#options.lease.stop(leaseId).catch(() => {});
    this.#leaseId = null; this.#level = null; this.#startedAt = 0; this.#levelSource = null;
    this.#discardRecording();
    this.#state = 'idle';
    this.#emit();
  }

  /** The state `start()` leaves behind before it opens: used by both stop() and the failure path. */
  async #release(): Promise<void> {
    const leaseId = this.#leaseId;
    try { this.#recorder?.stop(); } catch { /* best effort */ }
    this.#recorder = null;
    if (leaseId) await this.#options.lease.stop(leaseId).catch(() => {});
    this.#leaseId = null;
    this.#levelSource = null;
    this.#discardRecording();
  }

  /** After this, the controller performs no work: a late timer or device callback is inert. */
  async dispose(): Promise<void> { await this.close(); this.#disposed = true; }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
