import { randomUUID } from 'node:crypto';
import type { MediaStorePort, PlaybackPort, TtsProvider, TurnScope } from '../contracts/index.js';
import type { WorkSpeechEvent, WorkInputBinding } from '../contracts/desktop-work.js';
import { sameScope } from './turn-controller.js';
export interface WorkStatusNotice {
  id: string;
  taskId?: string;
  kind: 'ready' | 'confirmed' | 'transferred' | 'completed' | 'failed' | 'approval' | 'unknown' | 'clarification' | 'arrangement' | 'cancelled' | 'local_control';
  spokenText?: string;
  workBinding?: WorkInputBinding;
  executor: 'codex' | 'harness';
}
const sentence = (notice: WorkStatusNotice): string => {
  const name = notice.executor === 'codex' ? 'Codex' : 'DeepSeek Harness';
  switch (notice.kind) {
    case 'local_control': case 'clarification': case 'arrangement': {const text=notice.spokenText?.trim();if(!text||text.length>1000||text.includes('\0'))throw Error('Invalid brief task speech');return text;}
    case 'cancelled': return '这张未发送的任务卡已取消。';
    case 'ready': return '任务已经整理好了，你可以确认一下。';
    case 'confirmed': return '收到你的确认了，我来安排这件事。';
    case 'transferred': return `已经交给${name}了，你也可以继续和我说话。`;
    case 'completed': return '这项任务有结果了，可以在任务面板查看。';
    case 'approval': return '这项任务需要你在原生界面确认一下工具权限。';
    case 'failed': return '这项任务没有顺利完成，详情在任务面板里。';
    case 'unknown': return '这项任务的状态暂时还没核实，可以查看任务面板。';
  }
};
interface Options {
  identity(): Pick<TurnScope, 'characterId' | 'sessionId'>;
  busy(): boolean;
  tts: TtsProvider; playback: PlaybackPort; media: MediaStorePort;
  emit(event: WorkSpeechEvent): void;
  now?: () => number;
}
/** One short live-state notice, separate from conversation generation/history and the work executor. */
export class WorkSpeech {
  private epoch = 0;
  private generation = 0;
  private closed = false;
  private readonly seen = new Set<string>();
  private pending: { notice: WorkStatusNotice; epoch: number; at: number } | undefined;
  private active: { scope: TurnScope; controller: AbortController; done: Promise<void>; noticeId: string; taskId: string; started: boolean; epoch: number } | undefined;
  constructor(private readonly options: Options) {}
  notify(notice: WorkStatusNotice): void {
    const key = `${notice.id}:${notice.kind}`;
    if (this.closed || this.seen.has(key)) return;
    this.seen.add(key); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    // Coalesce only the newest real event. Never build a spoken progress backlog.
    this.pending = { notice, epoch: this.epoch, at: this.now() };
    // A newer state of this task supersedes synthesis that has not reached the
    // speaker. In particular, never play "please confirm" after confirmation.
    const active = this.active;
    if (active && active.taskId === (notice.taskId??notice.id) && !active.started) {
      active.controller.abort();
      this.options.emit({ noticeId: active.noticeId, scope: active.scope, inputEpoch: active.epoch, state: 'end' });
      void this.options.playback.stop(active.scope).catch(() => {});
    }
    this.flush();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  onInput(): void {
    this.epoch++; this.pending = undefined;
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    this.options.emit({ noticeId: active.noticeId, scope: active.scope, inputEpoch: active.epoch, state: 'end' });
    void this.options.playback.stop(active.scope).catch(() => {});
  }
  flush(): void {
    if (this.closed || this.active || this.options.busy() || !this.pending) return;
    const queued = this.pending; this.pending = undefined;
    if (queued.epoch !== this.epoch || this.now() - queued.at > 15000) return;
    const scope = Object.freeze({ ...this.options.identity(), turnId: randomUUID(), generation: ++this.generation });
    const job = { scope, controller: new AbortController(), done: Promise.resolve(), noticeId: `${queued.notice.id}:${queued.notice.kind}`, taskId: queued.notice.taskId??queued.notice.id, started: false, epoch: queued.epoch };
    this.active = job;
    const current = () => {
      job.controller.signal.throwIfAborted();
      if (this.closed || this.active !== job || this.epoch !== job.epoch || this.options.busy()) throw new Error('Work speech was superseded');
    };
    job.done = (async () => {
      try {
        current();
        const text = sentence(queued.notice);
        this.options.emit({ noticeId: job.noticeId, scope, inputEpoch: job.epoch, state: 'start', text, ...(queued.notice.workBinding?{workBinding:queued.notice.workBinding}:{}) });
        const audio = await this.options.tts.synthesize({ scope, text, expression: { emotion: 'neutral', intensity: 0, gesture: null, delivery: '' } }, job.controller.signal);
        current(); if (!sameScope(scope, audio.scope)) throw new Error('Work speech scope mismatch');
        let started = false, ended = false;
        await this.options.playback.play(audio, event => {
          if (!sameScope(scope, event.scope) || job.controller.signal.aborted) return;
          if (event.type === 'started') { started = true; job.started = true; }
          if (event.type === 'ended') ended = true;
        }, job.controller.signal);
        current(); if (!started || !ended) throw new Error('Work speech output was not completed');
      } catch { /* The exact work record remains authoritative; never retry a failed/cancelled notice. */ }
      finally {
        await this.options.media.releaseScope(scope).catch(() => {});
        this.options.emit({ noticeId: job.noticeId, scope, inputEpoch: job.epoch, state: 'end' });
        if (this.active === job) this.active = undefined;
        this.flush();
      }
    })();
  }
  async drain(): Promise<void> {
    this.flush();
    while (this.active) await this.active.done;
  }
  async close(): Promise<void> {
    this.closed = true; this.onInput(); await this.active?.done;
  }
}
