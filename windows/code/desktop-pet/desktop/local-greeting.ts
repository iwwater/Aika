export type LocalGreetingBand = 'morning' | 'day' | 'evening' | 'night';

export interface LocalGreetingDecision {
  readonly key: string;
  readonly band: LocalGreetingBand;
  readonly text: string;
  readonly occurredAt: number;
}

export interface LocalGreetingTick {
  readonly now?: number;
  readonly busy?: boolean;
  readonly visible?: boolean;
}

export interface LocalGreetingOptions {
  readonly now?: () => number;
  readonly idleAfterMs?: number;
  readonly cooldownMs?: number;
  readonly enabled?: boolean;
  readonly lastShownAt?: number | undefined;
}

const DEFAULT_IDLE_AFTER_MS = 45 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function localGreetingBand(date: Date): LocalGreetingBand {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 18) return 'day';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

function keyFor(date: Date, band: LocalGreetingBand): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}:${band}`;
}

function textFor(band: LocalGreetingBand): string {
  switch (band) {
    case 'morning': return '早上好，今天也慢慢来就好。';
    case 'day': return '忙了一阵的话，记得给自己留一点喘气的时间。';
    case 'evening': return '晚上好，今天辛苦啦。';
    case 'night': return '还没睡呀？如果累了，先去休息也没关系。';
  }
}

/** Renderer-local prompt policy. It never calls a provider, TTS, media device or memory port. */
export class LocalGreetingScheduler {
  private readonly now: () => number;
  private readonly idleAfterMs: number;
  private readonly cooldownMs: number;
  private enabled: boolean;
  private lastInteractionAt: number;
  private lastShownAt: number;
  private consumedKey: string | null = null;

  constructor(options: LocalGreetingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleAfterMs = Math.max(0, options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.enabled = options.enabled ?? true;
    this.lastShownAt = Number.isFinite(options.lastShownAt) ? options.lastShownAt! : -Infinity;
    this.lastInteractionAt = this.now();
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isEnabled(): boolean { return this.enabled; }
  restoreLastShownAt(at: number | null): void { if (Number.isFinite(at)) this.lastShownAt = Math.max(this.lastShownAt, at!); }

  markInteraction(at = this.now()): void { this.lastInteractionAt = at; }

  tick(options: LocalGreetingTick = {}): LocalGreetingDecision | null {
    const now = options.now ?? this.now();
    if (!this.enabled || options.visible === false || now - this.lastInteractionAt < this.idleAfterMs) return null;
    const date = new Date(now);
    const band = localGreetingBand(date);
    const key = keyFor(date, band);
    if (key === this.consumedKey) return null;
    // A due prompt is consumed even while the app is busy. That is deliberate: no stale prompt is
    // queued behind a reply, recording, playback or a newer user action.
    this.consumedKey = key;
    if (options.busy === true || now - this.lastShownAt < this.cooldownMs) return null;
    this.lastShownAt = now;
    return { key, band, text: textFor(band), occurredAt: now };
  }

  preview(options: { now?: number; busy?: boolean } = {}): LocalGreetingDecision | null {
    if (!this.enabled || options.busy === true) return null;
    const now = options.now ?? this.now();
    const date = new Date(now);
    const band = localGreetingBand(date);
    const key = keyFor(date, band);
    return { key, band, text: textFor(band), occurredAt: now };
  }
}
