/**
 * core/clipboard-text-source.ts
 *
 * N082-03: Clipboard text source adapter.
 * Observes Windows clipboard text changes without reading images or HTML.
 * Ensures sequence verification before and after read, with strict size capping.
 */

import type { SourceGrant } from '../contracts/companion-mode.js';

export interface ClipboardTextResult {
  readonly text: string;
  readonly byteLength: number;
}

export interface ClipboardTextSourceOptions {
  readonly maxTextBytes?: number; // Default 1 MiB (1,048,576 bytes)
  readonly readClipboardText: (sequence: number) => Promise<ClipboardTextResult | null>;
  readonly currentSequence: () => number;
  readonly now?: () => string;
}

export class ClipboardTextSource {
  private readonly maxTextBytes: number;
  private readonly readClipboardText: (sequence: number) => Promise<ClipboardTextResult | null>;
  private readonly currentSequence: () => number;
  private readonly now: () => string;
  private closed = false;
  private lastConsumedSequence = -1;
  private readonly consumed = new Set<number>();

  constructor(options: ClipboardTextSourceOptions) {
    this.maxTextBytes = options.maxTextBytes ?? 1_048_576; // 1 MiB default
    this.readClipboardText = options.readClipboardText;
    this.currentSequence = options.currentSequence;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(
    _grant: SourceGrant,
    _onCandidate?: (candidate: { sequence: number; observedAt: string }) => void,
  ): Promise<{ close: () => Promise<void> }> {
    this.closed = false;
    // Discard pre-existing clipboard content at enablement
    this.lastConsumedSequence = this.currentSequence();
    this.consumed.add(this.lastConsumedSequence);

    return {
      close: async () => {
        this.closed = true;
        this.consumed.clear();
      },
    };
  }

  /** Read current clipboard text if the sequence has not moved and has not been consumed. */
  async readTextIfCurrent(sequence: number): Promise<ClipboardTextResult | null> {
    if (this.closed) return null;
    if (this.consumed.has(sequence)) return null;

    // Sequence verification before read
    const seqBefore = this.currentSequence();
    if (seqBefore !== sequence) return null;

    const res = await this.readClipboardText(sequence);
    if (!res || !res.text || res.text.trim().length === 0) {
      this.consumed.add(sequence);
      return null;
    }

    // Sequence verification after read
    const seqAfter = this.currentSequence();
    if (seqAfter !== sequence) return null;

    this.consumed.add(sequence);
    this.lastConsumedSequence = sequence;

    // Strict byte cap: truncate or reject oversized text
    const textBytes = Buffer.byteLength(res.text, 'utf8');
    if (textBytes > this.maxTextBytes) {
      // Return capped text
      const buf = Buffer.from(res.text, 'utf8').subarray(0, this.maxTextBytes);
      return {
        text: buf.toString('utf8'),
        byteLength: this.maxTextBytes,
      };
    }

    return {
      text: res.text,
      byteLength: textBytes,
    };
  }
}
