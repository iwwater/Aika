/**
 * ASR 片段的顺序闸门。
 *
 * 网络转写可以乱序完成，但只有音频序号连续时才向上层释放。`reset(null)`
 * 用于一次打断后：旧请求可能永远不会回来，下一次到达的序号应作为新的起点，
 * 而不是把新输入卡在旧序号上。
 */

export interface SequencedSegment {
  sequence: number;
}

export interface AsrSegmentReorderer<T extends SequencedSegment> {
  push(segment: T): T[];
  reset(nextSequence?: number | null): void;
}

export function createAsrSegmentReorderer<T extends SequencedSegment>(
  initialSequence: number | null = 0,
): AsrSegmentReorderer<T> {
  let nextSequence = initialSequence;
  const waiting = new Map<number, T>();

  function reset(next: number | null = 0) {
    nextSequence = next;
    waiting.clear();
  }

  return {
    push(segment) {
      if (nextSequence === null) nextSequence = segment.sequence;
      if (segment.sequence < nextSequence) return [];

      waiting.set(segment.sequence, segment);
      const ready: T[] = [];
      while (waiting.has(nextSequence)) {
        ready.push(waiting.get(nextSequence)!);
        waiting.delete(nextSequence);
        nextSequence += 1;
      }
      return ready;
    },
    reset,
};
}
