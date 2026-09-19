import type { PlaybackEvent, TurnScope } from '../contracts/index.js';
import { assertScope } from './scope.js';

export type TimingStage = 'capture_stop' | 'asr' | 'perception' | 'asr_perception' | 'retrieval' | 'dialogue' | 'tts' | 'playback_prepare';
export interface StageTiming { stage: TimingStage; startedAt: string; endedAt: string; durationMs: number }
/** One journal per turn; overlapping spans remain overlapping, never added to manufacture a latency. */
export class TurnTiming {
  private readonly spans: StageTiming[] = [];
  private firstOutput: Extract<PlaybackEvent, { type: 'started' }> | undefined;
  constructor(readonly scope: TurnScope, readonly inputEndedAt: string, private readonly monotonic = () => performance.now(), private readonly wall = () => new Date().toISOString()) {
    if (!Number.isFinite(Date.parse(inputEndedAt))) throw new Error('Invalid input end time');
  }
  async measure<T>(stage: TimingStage, operation: () => Promise<T>): Promise<T> {
    const start = this.monotonic(), startedAt = this.wall();
    try { return await operation(); }
    finally { this.spans.push({ stage, startedAt, endedAt: this.wall(), durationMs: this.monotonic() - start }); }
  }
  playback(event: PlaybackEvent): void {
    assertScope(this.scope, event.scope);
    if (event.type === 'started' && !this.firstOutput) this.firstOutput = event;
  }
  report() {
    const duration = this.firstOutput ? Date.parse(this.firstOutput.at) - Date.parse(this.inputEndedAt) : null;
    return { scope: this.scope, inputEndedAt: this.inputEndedAt, firstOutputAt: this.firstOutput?.at ?? null,
      endToOutputMs: duration !== null && Number.isFinite(duration) && duration >= 0 ? duration : null,
      timingBasis: this.firstOutput?.timingBasis ?? 'unverified', physicalAudibilityVerified: false,
      spans: this.spans.map(span => ({ ...span })),
      limitation: 'Stage durations use a monotonic clock. Cross-process ISO times require aligned clocks; physical sound needs device/listening evidence.' };
  }
}
