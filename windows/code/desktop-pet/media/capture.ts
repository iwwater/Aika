import type { CapturePort, CapturedInput, MediaStorePort, TurnScope } from '../contracts/index.js';
import { abortable, abortError, assertScope, checkAbort } from './scope.js';

export interface CapturedBytes { audio: Uint8Array; images: readonly { bytes: Uint8Array; mimeType: string }[]; captureStoppedAt: string }
export interface CaptureSession {
  /** Must synchronously stop device tracks before awaiting encoding/drain. */
  finish(): Promise<CapturedBytes>;
  stop(): void;
}
export interface CaptureDriver { open(signal: AbortSignal): Promise<CaptureSession> }
type Active = { scope: TurnScope; controller: AbortController; session?: CaptureSession; detach: () => void; finishing: boolean };

/** Constructing this port does not acquire devices. Only the voice command may call start. */
export class TurnCapture implements CapturePort {
  private active: Active | undefined;
  constructor(private readonly driver: CaptureDriver, private readonly store: MediaStorePort, private readonly now = () => new Date().toISOString()) {}
  async start(scope: TurnScope, signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    const cleanup = this.active ? this.stop(this.active.scope) : Promise.resolve();
    const controller = new AbortController();
    const cancel = () => { void this.stop(scope); };
    const active: Active = { scope: Object.freeze({ ...scope }), controller, detach: () => signal.removeEventListener('abort', cancel), finishing: false };
    this.active = active;
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await cleanup; checkAbort(controller.signal);
      const pending = this.driver.open(controller.signal).then(session => {
        if (controller.signal.aborted || this.active !== active) { session.stop(); throw abortError(); }
        active.session = session;
      });
      await abortable(pending, controller.signal);
    } catch (error) {
      if (this.active === active) await this.stop(scope);
      throw error;
    }
  }
  async finish(scope: TurnScope): Promise<CapturedInput> {
    const active = this.active;
    if (!active?.session || active.finishing) throw new Error('No ready voice capture');
    assertScope(active.scope, scope); active.finishing = true;
    const inputEndedAt = this.now();
    try {
      const captured = await abortable(active.session.finish(), active.controller.signal);
      checkAbort(active.controller.signal);
      const audio = await this.store.put(scope, captured.audio, 'audio/wav');
      checkAbort(active.controller.signal);
      const images = [];
      for (const image of captured.images) {
        images.push(await this.store.put(scope, image.bytes, image.mimeType));
        checkAbort(active.controller.signal);
      }
      return { scope: active.scope, audio, images, inputEndedAt, captureStoppedAt: captured.captureStoppedAt };
    } catch (error) { await this.store.releaseScope(scope); throw error; }
    finally {
      active.session.stop(); active.detach();
      if (this.active === active) this.active = undefined;
    }
  }
  async stop(scope: TurnScope): Promise<void> {
    const active = this.active;
    if (active) {
      try { assertScope(active.scope, scope); } catch { return; }
      this.active = undefined; active.controller.abort(); active.session?.stop(); active.detach();
    }
    await this.store.releaseScope(scope);
  }
}
