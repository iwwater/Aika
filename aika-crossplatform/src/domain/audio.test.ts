import { describe, expect, it } from "vitest";
import {
  createSampleRing, downsample, durationMs, encodeWav, samplesFor, TARGET_SAMPLE_RATE,
} from "./audio";

function ramp(length: number, start = 0): Float32Array {
  return Float32Array.from({ length }, (_, index) => start + index);
}

describe("createSampleRing", () => {
  it("按绝对下标取回写进去的采样", () => {
    const ring = createSampleRing(10);
    ring.write(ramp(4));
    expect(Array.from(ring.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(ring.totalWritten()).toBe(4);
  });

  it("写满之后挤掉最旧的，绝对下标仍然对得上", () => {
    const ring = createSampleRing(4);
    ring.write(ramp(6));
    expect(ring.totalWritten()).toBe(6);
    expect(Array.from(ring.slice(2, 6))).toEqual([2, 3, 4, 5]);
  });

  it("要已经被挤掉的部分时只给还留着的，不抛错", () => {
    const ring = createSampleRing(4);
    ring.write(ramp(6));
    expect(Array.from(ring.slice(0, 6))).toEqual([2, 3, 4, 5]);
  });

  it("越过写入位置的部分裁掉", () => {
    const ring = createSampleRing(10);
    ring.write(ramp(3));
    expect(Array.from(ring.slice(1, 99))).toEqual([1, 2]);
  });

  it("空区间返回空数组", () => {
    const ring = createSampleRing(10);
    ring.write(ramp(3));
    expect(ring.slice(2, 2)).toHaveLength(0);
    expect(ring.slice(5, 3)).toHaveLength(0);
  });

  it("回补：开口之前的采样还拿得到", () => {
    // 这就是本地管线相对 Web Speech 的关键优势
    const ring = createSampleRing(TARGET_SAMPLE_RATE);
    ring.write(ramp(TARGET_SAMPLE_RATE / 2));
    const speechStart = ring.totalWritten();
    ring.write(ramp(1600, 1000));

    const withPreroll = ring.slice(speechStart - samplesFor(200), ring.totalWritten());
    expect(withPreroll.length).toBe(samplesFor(200) + 1600);
  });

  it("clear 之后从头开始", () => {
    const ring = createSampleRing(4);
    ring.write(ramp(3));
    ring.clear();
    expect(ring.totalWritten()).toBe(0);
    expect(ring.slice(0, 3)).toHaveLength(0);
  });
});

describe("downsample", () => {
  it("采样率相同就原样返回", () => {
    const samples = ramp(4);
    expect(downsample(samples, 16000, 16000)).toBe(samples);
  });

  it("48k 降到 16k 长度变三分之一", () => {
    expect(downsample(ramp(300), 48000, 16000)).toHaveLength(100);
  });

  it("线性插值取到中间值", () => {
    const out = downsample(Float32Array.from([0, 1, 2, 3]), 4, 2);
    expect(Array.from(out)).toEqual([0, 2]);
  });

  it("不做升采样", () => {
    expect(() => downsample(ramp(4), 16000, 48000)).toThrow("只做降采样");
  });

  it("空输入不炸", () => {
    expect(downsample(new Float32Array(0), 48000, 16000)).toHaveLength(0);
  });
});

describe("encodeWav", () => {
  it("写出合法的 16 bit 单声道 WAV 头", () => {
    const wav = encodeWav(Float32Array.from([0, 0.5, -0.5]), 16000);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => String.fromCharCode(...wav.slice(offset, offset + 4));

    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(ascii(36)).toBe("data");
    expect(view.getUint16(22, true)).toBe(1);      // 单声道
    expect(view.getUint32(24, true)).toBe(16000);  // 采样率
    expect(view.getUint16(34, true)).toBe(16);     // 位深
    expect(view.getUint32(40, true)).toBe(6);      // 三个采样共 6 字节
    expect(wav.length).toBe(44 + 6);
  });

  it("按满量程转成整数", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1]), 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32767);
  });

  it("削波要夹住：绕回去听上去是爆音", () => {
    const wav = encodeWav(Float32Array.from([2, -2]), 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });

  it("空采样也给出合法的头", () => {
    const wav = encodeWav(new Float32Array(0));
    expect(wav.length).toBe(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});

describe("时长换算", () => {
  it("采样数和毫秒互转", () => {
    expect(samplesFor(1000)).toBe(16000);
    expect(samplesFor(200)).toBe(3200);
    expect(durationMs(16000)).toBe(1000);
    expect(durationMs(8000)).toBe(500);
  });
});
