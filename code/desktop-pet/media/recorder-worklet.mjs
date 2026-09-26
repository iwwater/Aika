// Loaded as a same-origin module. No Blob URL or inline script policy exception is needed.
class PetRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.captureLevels=options?.processorOptions?.captureLevels===true;
    this.levelEvery=Math.max(1,Math.round((typeof sampleRate==='number'?sampleRate:48000)/20));
    this.levelCount=0;this.levelSquares=0;this.levelPeak=0;this.levelValid=true;
    this.parts = []; this.length = 0; this.done = false; this.started = false;
    this.nonzeroObserved = false; this.leadingZeroSampleCount = 0;
    this.port.onmessage = event => {
      if (event.data === 'finish' && !this.done) {
        this.flush(); this.done = true; this.port.postMessage({ finished: true, nonzeroObserved: this.nonzeroObserved, leadingZeroSampleCount: this.leadingZeroSampleCount });
      }
    };
  }
  flush() {
    if (!this.length) return;
    const data = new Float32Array(this.length);
    let at = 0;
    for (const part of this.parts) { data.set(part, at); at += part.length; }
    this.parts = []; this.length = 0;
    this.port.postMessage({ samples: data }, [data.buffer]);
  }
  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    if (channels?.length && channels[0].length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      const initial=!this.started;
      // Inspect only the mono PCM already being recorded. Exact nonzero is a signal
      // diagnostic, not voice detection; never gate readiness or discard any sample.
      if (!this.started || (!this.nonzeroObserved && this.leadingZeroSampleCount !== null)) {
        const notice = {};
        if (!this.started) { this.started = true; notice.started = true; notice.sampleCount = mono.length; }
        if (!this.nonzeroObserved && this.leadingZeroSampleCount !== null) {
          let prefix = 0;
          while (prefix < mono.length && mono[prefix] === 0) prefix++;
          this.leadingZeroSampleCount += prefix;
          if (prefix < mono.length) {
            if (Number.isFinite(mono[prefix])) { this.nonzeroObserved = true; notice.firstNonzero = true; }
            else this.leadingZeroSampleCount = null; // Invalid PCM cannot establish a zero prefix or signal arrival.
          }
        }
        if (notice.started || notice.firstNonzero) this.port.postMessage({ ...notice, leadingZeroSampleCount: this.leadingZeroSampleCount });
      }
      // Optional local envelope of the SAME mono samples. No analyser, audio copy or capture gate.
      if(this.captureLevels){
        for(const sample of mono){
          if(!Number.isFinite(sample)){this.levelValid=false;continue;}
          const value=Math.max(-1,Math.min(1,sample));this.levelSquares+=value*value;this.levelPeak=Math.max(this.levelPeak,Math.abs(value));
        }
        this.levelCount+=mono.length;
        if(initial||this.levelCount>=this.levelEvery){
          if(this.levelValid)this.port.postMessage({level:{rms:Math.min(this.levelPeak,Math.sqrt(this.levelSquares/this.levelCount)),peak:this.levelPeak}});
          this.levelCount=0;this.levelSquares=0;this.levelPeak=0;this.levelValid=true;
        }
      }
      this.parts.push(mono); this.length += mono.length;
      if (this.length >= 2048) this.flush();
    }
    return true;
  }
}
registerProcessor('pet-recorder', PetRecorder);
