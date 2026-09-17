/** Fixed raw-PCM window. Reads copy; overwrites/clear erase samples owned here. */
export class PcmRing {
  private readonly data: Float32Array;
  private next = 0;
  private count = 0;
  constructor(readonly capacity = 32000) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw Error('Invalid PCM capacity');
    this.data = new Float32Array(capacity);
  }
  push(samples: Float32Array): void {
    for (const sample of samples) { this.data[this.next] = sample; this.next = (this.next + 1) % this.capacity; this.count = Math.min(this.capacity, this.count + 1); }
  }
  takeCopy(): Float32Array {
    const out = new Float32Array(this.count), start = (this.next - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out[i] = this.data[(start + i) % this.capacity]!;
    return out;
  }
  clear(): void { this.data.fill(0); this.next = this.count = 0; }
  get length(): number { return this.count; }
}
