/**
 * 音频的纯逻辑：环形缓冲、重采样、WAV 封装。
 *
 * 放在 domain 而不是 services，是因为这里没有一行浏览器 API——
 * 换成 Rust 侧采集也好，换成别的识别后端也好，这三件事的算法都不变，
 * 而且可以在没有麦克风的测试里跑。
 *
 * 采样率统一 16 kHz 单声道：Whisper 和 Silero VAD 都只吃这个。
 */

export const TARGET_SAMPLE_RATE = 16_000;

export interface SampleRing {
  /** 写入一段新采样，超出容量时丢掉最旧的。 */
  write(chunk: Float32Array): void;
  /** 从开始到现在一共写进来多少个采样。用它做绝对定位，不受丢弃影响。 */
  totalWritten(): number;
  /**
   * 按绝对下标取一段。
   * 越界的部分自动裁掉——已经被挤掉的采样拿不回来，但不该因此抛错。
   */
  slice(fromAbsolute: number, toAbsolute: number): Float32Array;
  clear(): void;
}

/**
 * 定长环形缓冲。
 *
 * 存在的理由是「回补」：VAD 判定用户开口时，那个音节其实已经过去了两三百毫秒。
 * 留一段回看窗口，就能把开口前的采样也一起送去识别，第一个字才不会丢。
 * 这是 Web Speech 做不到的事——它不把音频交给我们。
 */
export function createSampleRing(capacity: number): SampleRing {
  const buffer = new Float32Array(capacity);
  let written = 0;

  return {
    write(chunk) {
      for (let index = 0; index < chunk.length; index += 1) {
        buffer[(written + index) % capacity] = chunk[index];
      }
      written += chunk.length;
    },

    totalWritten() {
      return written;
    },

    slice(fromAbsolute, toAbsolute) {
      const oldest = Math.max(0, written - capacity);
      const from = Math.max(fromAbsolute, oldest);
      const to = Math.min(toAbsolute, written);
      if (to <= from) return new Float32Array(0);

      const out = new Float32Array(to - from);
      for (let index = 0; index < out.length; index += 1) {
        out[index] = buffer[(from + index) % capacity];
      }
      return out;
    },

    clear() {
      buffer.fill(0);
      written = 0;
    },
  };
}

/**
 * 线性插值重采样。
 *
 * 正常路径用不到它：`new AudioContext({ sampleRate: 16000 })` 让浏览器自己转，
 * 质量比这个好。这里是兜底——某些设备上指定采样率会被忽略，那时至少还能跑。
 */
export function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  if (toRate > fromRate) throw new Error("这个函数只做降采样");

  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return out;
}

const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * 封成 16 bit PCM 单声道 WAV。
 * whisper.cpp 的 /inference 收的是文件，最省事的通用格式就是它。
 */
export function encodeWav(samples: Float32Array, sampleRate: number = TARGET_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 每秒字节数
  view.setUint16(32, 2, true); // 每帧字节数
  view.setUint16(34, 16, true); // 位深
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let index = 0; index < samples.length; index += 1) {
    // 削波要夹住：超出 [-1, 1] 直接乘会绕回去，听上去是爆音。
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(WAV_HEADER_BYTES + index * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

/** 一段采样有多少毫秒。判定静音时长时用它，不要在调用处到处写除法。 */
export function durationMs(sampleCount: number, sampleRate: number = TARGET_SAMPLE_RATE): number {
  return (sampleCount / sampleRate) * 1000;
}

/** 多少毫秒是多少个采样。 */
export function samplesFor(milliseconds: number, sampleRate: number = TARGET_SAMPLE_RATE): number {
  return Math.round((milliseconds / 1000) * sampleRate);
}
