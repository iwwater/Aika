/**
 * 把 VAD 逐帧给出的「像不像人声」概率，变成一段一段的语音。
 *
 * 这里切的是**语音段**，不是**对话回合**。两件事，两个时间尺度：
 *
 * - 语音段（这里，约 0.4 秒静音）：一口气说完了。切出来立刻送去识别，
 *   识别结果作为片段交给缓冲区。
 * - 对话回合（`domain/turnEnd.ts`，1.15～2.4 秒 + 语义判断）：这一轮说完了，
 *   可以发给模型了。
 *
 * 分开的好处是两边都能各做各的：识别可以在用户还在说的时候就开始跑，
 * 而回合边界仍然由语义决定。turnEnd 那套逻辑一行都不用改——
 * 换成 Whisper 之后，它收到的只是更准的片段。
 *
 * 纯逻辑，不碰 ONNX 也不碰麦克风：喂一串概率进去就能测。
 */

import { durationMs, samplesFor } from "./audio";

export interface VadSegmenterSettings {
  /** 高于这个概率才开始考虑「有人在说」。 */
  startProbability: number;
  /**
   * 低于这个概率才算静音。刻意比 startProbability 低——
   * 两个阈值之间是回滞区，否则概率在阈值附近抖动会把一句话切成碎片。
   */
  endProbability: number;
  /** 短于这个时长的声音不算开口：咳嗽、敲键盘、椅子响。 */
  minSpeechMs: number;
  /** 段末静音多久算这一口气说完。 */
  silenceMs: number;
  /**
   * 回补时长。VAD 判定开口时那个音节已经过去了，把开口前这一段也送去识别，
   * 第一个字才不会丢。这是本地管线相对 Web Speech 的关键优势。
   */
  prerollMs: number;
  /** 段末多留一点静音，免得最后一个辅音被切掉。 */
  tailMs: number;
  /** 再长也要切开，否则一直不停地说会让识别永远等不到结果。 */
  maxSegmentMs: number;
}

export const DEFAULT_VAD_SETTINGS: VadSegmenterSettings = {
  startProbability: 0.5,
  endProbability: 0.35,
  minSpeechMs: 120,
  silenceMs: 380,
  prerollMs: 220,
  tailMs: 120,
  maxSegmentMs: 15_000,
};

export type VadEvent =
  | { type: "speech-start"; startSample: number }
  | { type: "speech-end"; startSample: number; endSample: number };

export interface VadSegmenter {
  /** 喂一帧的概率和它在整条流里的绝对位置，拿回这一帧引发的事件。 */
  push(probability: number, frameStart: number, frameEnd: number): VadEvent[];
  isSpeaking(): boolean;
  reset(): void;
}

export function createVadSegmenter(
  settings: VadSegmenterSettings = DEFAULT_VAD_SETTINGS,
): VadSegmenter {
  let speaking = false;
  /** 连续超过起始阈值的第一帧位置；还没够 minSpeechMs 时它只是候选。 */
  let candidateStart: number | null = null;
  let speechStart = 0;
  let silenceStart: number | null = null;

  function segmentFrom(): number {
    return Math.max(0, speechStart - samplesFor(settings.prerollMs));
  }

  function reset() {
    speaking = false;
    candidateStart = null;
    silenceStart = null;
    speechStart = 0;
  }

  return {
    push(probability, frameStart, frameEnd) {
      const events: VadEvent[] = [];

      if (!speaking) {
        if (probability < settings.startProbability) {
          candidateStart = null;
          return events;
        }
        if (candidateStart === null) candidateStart = frameStart;
        if (durationMs(frameEnd - candidateStart) < settings.minSpeechMs) return events;

        speaking = true;
        speechStart = candidateStart;
        candidateStart = null;
        silenceStart = null;
        events.push({ type: "speech-start", startSample: segmentFrom() });
        return events;
      }

      if (probability >= settings.endProbability) {
        silenceStart = null;
      } else {
        if (silenceStart === null) silenceStart = frameStart;
        if (durationMs(frameEnd - silenceStart) >= settings.silenceMs) {
          events.push({
            type: "speech-end",
            startSample: segmentFrom(),
            endSample: silenceStart + samplesFor(settings.tailMs),
          });
          reset();
          return events;
        }
      }

      // 说得太久也要切：识别不能永远等不到一段完整的输入。
      if (durationMs(frameEnd - speechStart) >= settings.maxSegmentMs) {
        events.push({ type: "speech-end", startSample: segmentFrom(), endSample: frameEnd });
        reset();
      }
      return events;
    },

    isSpeaking() {
      return speaking;
    },

    reset,
  };
}
