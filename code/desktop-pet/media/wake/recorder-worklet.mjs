// This distinct processor is opened only by explicit local wake enable, never PTT.
class WakeRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.block = new Float32Array(512); this.used = 0; this.closed = false; this.credits = 16;
    this.port.onmessage = e => { if(e.data?.ack===true)this.credits=Math.min(16,this.credits+1); if (e.data === 'close') { this.closed = true; this.block.fill(0); this.used = 0; } };
  }
  process(inputs) {
    if (this.closed) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      if (!Number.isFinite(sample)) { this.block.fill(0); this.closed = true; this.port.postMessage({ error: true }); return false; }
      this.block[this.used++] = Math.max(-1, Math.min(1, sample));
      if (this.used === 512) {
        if(this.credits<=0){this.block.fill(0);this.closed=true;this.port.postMessage({error:true});return false;}
        this.credits--;
        this.port.postMessage({ samples: this.block }, [this.block.buffer]);
        this.block = new Float32Array(512); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('pet-wake-recorder', WakeRecorder);
