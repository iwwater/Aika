import { createSampleRing, downsample, TARGET_SAMPLE_RATE, type SampleRing } from "../../domain/audio";

/**
 * 麦克风采集。
 *
 * 和 `micActivity.ts` 的区别：那个只回答「有没有人在说」，音频听完就扔。
 * 这里把采样留在环形缓冲里，因为本地管线要靠它做两件 Web Speech 做不到的事：
 * 回补开口前的音节，以及把整段音频交给 Whisper。
 *
 * 采样率优先让浏览器直接给 16 kHz（`new AudioContext({ sampleRate })`），
 * 它的重采样比我们自己插值好。设备不认这个参数时才退回 `downsample`。
 */

/** 环形缓冲保留多久的音频。够长到容纳一整段发言，又不至于占太多内存。 */
const RING_SECONDS = 60;

/** 每次交给 VAD 的帧长。Silero v5 只吃 512 个采样。 */
export const VAD_FRAME_SAMPLES = 512;

export interface AudioCaptureEvents {
  /** 攒够一帧就回调一次，附带这一帧在整条流里的绝对位置。 */
  onFrame(frame: Float32Array, frameStart: number, frameEnd: number): void;
}

export interface AudioCapture {
  isAvailable(): boolean;
  start(events: AudioCaptureEvents): Promise<void>;
  stop(): void;
  dispose(): Promise<void>;
  /** 取一段已经录下来的音频。越界部分自动裁掉。 */
  read(fromSample: number, toSample: number): Float32Array;
  totalSamples(): number;
  /** 实际采样率。浏览器不认 16 kHz 时它不等于 TARGET_SAMPLE_RATE。 */
  sampleRate(): number;
}

/**
 * AudioWorklet 的代码走 Blob URL 注入。
 *
 * 用单独的文件会把它变成构建配置问题（Vite 需要额外插件才能产出可用的 worklet URL），
 * 而它本身只有几行：把每次拿到的输入原样转给主线程，重采样和分帧都在主线程做。
 */
const WORKLET_SOURCE = `
class AikaCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor("aika-capture", AikaCaptureProcessor);
`;

export function createAudioCapture(): AudioCapture {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let workletUrl: string | null = null;
  let ring: SampleRing = createSampleRing(TARGET_SAMPLE_RATE * RING_SECONDS);
  let pendingFrame: number[] = [];
  let running = false;
  let actualRate = TARGET_SAMPLE_RATE;

  function available() {
    return typeof AudioContext !== "undefined"
      && typeof AudioWorkletNode !== "undefined"
      && typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async function ensureGraph(events: AudioCaptureEvents) {
    if (node) return;

    stream = await navigator.mediaDevices.getUserMedia({
      // 回声抑制必须开：否则她的声音会被当成用户开口，她会自己打断自己。
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    actualRate = context.sampleRate;

    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    await context.audioWorklet.addModule(workletUrl);

    node = new AudioWorkletNode(context, "aika-capture");
    node.port.onmessage = (message) => {
      if (!running) return;
      const raw = message.data as Float32Array;
      const samples = actualRate === TARGET_SAMPLE_RATE
        ? raw
        : downsample(raw, actualRate, TARGET_SAMPLE_RATE);

      ring.write(samples);
      for (let index = 0; index < samples.length; index += 1) pendingFrame.push(samples[index]);

      while (pendingFrame.length >= VAD_FRAME_SAMPLES) {
        const frame = Float32Array.from(pendingFrame.splice(0, VAD_FRAME_SAMPLES));
        const frameEnd = ring.totalWritten() - pendingFrame.length;
        events.onFrame(frame, frameEnd - VAD_FRAME_SAMPLES, frameEnd);
      }
    };

    source = context.createMediaStreamSource(stream);
    source.connect(node);
    // 不接到 destination：接上去等于把麦克风直接放给音箱听。
  }

  return {
    isAvailable: available,

    async start(events) {
      if (!available()) throw new Error("当前环境没有可用的音频采集接口");
      await ensureGraph(events);
      await context?.resume();
      pendingFrame = [];
      running = true;
    },

    stop() {
      running = false;
      pendingFrame = [];
    },

    async dispose() {
      running = false;
      pendingFrame = [];
      node?.port.close();
      node?.disconnect();
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      if (workletUrl) URL.revokeObjectURL(workletUrl);
      await context?.close().catch(() => undefined);
      node = null;
      source = null;
      stream = null;
      context = null;
      workletUrl = null;
      ring = createSampleRing(TARGET_SAMPLE_RATE * RING_SECONDS);
    },

    read(fromSample, toSample) {
      return ring.slice(fromSample, toSample);
    },

    totalSamples() {
      return ring.totalWritten();
    },

    sampleRate() {
      return actualRate;
    },
  };
}
