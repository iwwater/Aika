import type { PlaybackEvent, TtsResult, TurnScope } from '../contracts/index.js';
import type { PlaybackDriver, PlaybackSample, PlaybackSession } from '../media/playback.js';
import { scopeEquals } from './view-state.js';
type Active = { scope: TurnScope; requestId: string; controller: AbortController; session?: PlaybackSession; terminal: boolean };
const playbackMessages={blocked:'声音播放被阻止，请重试。',silent:'没有取得可播放的语音，请重试。',failed:'这段语音暂时无法播放，请重试。'};
function playbackMessage(error:unknown):string {
  const message=error instanceof Error?error.message:typeof error==='string'?error:'';
  if(Object.values(playbackMessages).includes(message))return message;
  if(error instanceof Error&&error.name==='NotAllowedError')return playbackMessages.blocked;
  if(message==='Speech audio contains only silence')return playbackMessages.silent;
  return playbackMessages.failed;
}
/** Owns the renderer's physical output session. Request completion never substitutes for output completion. */
export class DesktopPlaybackController {
  private active: Active | undefined;
  constructor(private readonly driver: PlaybackDriver, private readonly accepts: (scope: TurnScope) => boolean, private readonly emit: (requestId: string, event: PlaybackEvent) => void) {}
  get busy(): boolean { return !!this.active && !this.active.terminal; }
  get scope(): TurnScope | null { return this.active?.scope ?? null; }
  async play(requestId: string, tts: TtsResult, bytes: Uint8Array): Promise<void> {
    // A duplicated transport packet must not stop or restart output already owned by this turn.
    if (this.active && scopeEquals(this.active.scope, tts.scope)) { bytes.fill(0); return; }
    if (!this.accepts(tts.scope)) { bytes.fill(0); throw new Error('拒绝已失效轮次的音频'); }
    this.stop();
    if (!this.accepts(tts.scope)) { bytes.fill(0); return; }
    const active: Active = { scope: tts.scope, requestId, controller: new AbortController(), terminal: false };
    this.active = active;
    const deliver = (sample: PlaybackSample) => {
      if (this.active !== active || active.terminal || active.controller.signal.aborted) return;
      if (sample.type === 'ended' || sample.type === 'stopped' || sample.type === 'error') active.terminal = true;
      this.emit(requestId, { ...sample, ...(sample.type==='error'?{message:playbackMessage(sample.message)}:{}), scope: active.scope } as PlaybackEvent);
    };
    try {
      const session = await this.driver.open(bytes, tts.audio.id, deliver, active.controller.signal);
      active.session = session; bytes.fill(0);
      if (active.controller.signal.aborted || this.active !== active || !this.accepts(active.scope) && !active.terminal) { session.stop(); return; }
      await session.done;
      if (!active.terminal) deliver({ type: 'error', message: '音频设备未报告播放完成', at: new Date().toISOString() });
    } catch (error) {
      if (!active.controller.signal.aborted) deliver({ type: 'error', message: playbackMessage(error), at: new Date().toISOString() });
    } finally {
      bytes.fill(0); active.session?.stop();
      if (this.active === active) this.active = undefined;
    }
  }
  stop(scope?: TurnScope | null): void {
    const active = this.active;
    if (!active || scope && !scopeEquals(active.scope, scope)) return;
    this.active = undefined; active.controller.abort(); active.session?.stop();
    if (!active.terminal) { active.terminal = true; this.emit(active.requestId, { scope: active.scope, type: 'stopped', at: new Date().toISOString() }); }
  }
}
