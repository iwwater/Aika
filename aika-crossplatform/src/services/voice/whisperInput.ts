import { createVadSegmenter, DEFAULT_VAD_SETTINGS, type VadSegmenterSettings } from "../../domain/vadSegmenter";
import { createAsrSegmentReorderer } from "../../domain/asrSegments";
import {
  type SpeechFinalResult,
  type SpeechSegmentTiming,
  type SpeechStartEvent,
} from "../../domain/voiceRuntime";
import { createAudioCapture, type AudioCapture } from "./audioCapture";
import type { SpeechInputEngine, SpeechInputEvents, VoiceInputLanguage } from "./contracts";
import { createSileroVad, type VoiceActivityModel } from "./sileroVad";
import { createWhisperClient, type WhisperClient } from "./whisperClient";

/**
 * 本地语音识别引擎：麦克风 → Silero VAD → whisper.cpp。
 *
 * 它实现的是和 Web Speech 同一个 `SpeechInputEngine` 契约，所以上层
 * （回合边界、缓冲区、打断）一行都不用改——这正是当初把契约抽出来的收益。
 *
 * 和 Web Speech 的三个实质区别：
 *
 * 1. **不需要语言码。** `start()` 收到的 language 被忽略，一律交给 Whisper 自己判。
 *    这是 FIELD_TEST_NOTES 那条 P0 的正解。
 * 2. **有回补。** 音频留在环形缓冲里，段首往前多取一段，开口的第一个音节不会丢。
 * 3. **段与段之间不重启。** Web Speech 每段结束都要重新 start()，中间有空窗；
 *    这里麦克风一直开着，VAD 自己切段。
 */

export interface WhisperInputOptions {
  /** 本地服务地址。用函数取，设置页改完立刻生效，不用重建引擎。 */
  endpoint: () => string;
  vad?: Partial<VadSegmenterSettings>;
}

export function createWhisperInputEngine(options: WhisperInputOptions): SpeechInputEngine {
  const settings: VadSegmenterSettings = { ...DEFAULT_VAD_SETTINGS, ...options.vad };
  let capture: AudioCapture | null = null;
  let vad: VoiceActivityModel | null = null;
  let client: WhisperClient | null = null;
  const segmenter = createVadSegmenter(settings);
  let running = false;
  let generation = 0;
  let nextSequence = 0;
  let currentSegment: SpeechStartEvent | null = null;
  let vadChain: Promise<void> = Promise.resolve();
  const reorderer = createAsrSegmentReorderer<SpeechFinalResult & { errorMessage?: string }>();

  function ensure() {
    if (!capture) capture = createAudioCapture();
    if (!vad) vad = createSileroVad();
    if (!client) client = createWhisperClient(options.endpoint);
  }

  async function transcribe(
    timing: SpeechSegmentTiming,
    from: number,
    to: number,
    events: SpeechInputEvents,
    runGeneration: number,
  ) {
    let text = "";
    let errorMessage: string | undefined;
    try {
      const samples = capture?.read(from, to) ?? new Float32Array(0);
      text = (await client?.transcribe(samples)) ?? "";
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    // abort/dispose 后，旧的网络结果不能污染新一轮；正常 stop() 不增加 generation，
    // 因此已经在途的音频仍会按顺序交给上层。
    if (runGeneration !== generation) return;

    for (const result of reorderer.push({ ...timing, text, errorMessage })) {
      if (result.errorMessage) events.onError?.("transcription-failed", result.errorMessage);
      // 空串也要报：上层据此把「用户正在说」的状态放下来。
      events.onFinal?.({
        segmentId: result.segmentId,
        sequence: result.sequence,
        audioStartAt: result.audioStartAt,
        audioEndAt: result.audioEndAt,
        timeSource: result.timeSource,
        text: result.text,
      });
    }
  }

  return {
    id: "local-whisper",
    kind: "whisper-local",
    // 麦克风全程开着，切段交给 VAD。
    continuous: true,

    isAvailable() {
      return createAudioCapture().isAvailable();
    },

    async requestPermission() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    },

    // language 是故意不用的：本地管线的意义就是不要求用户先声明说哪种语言。
    start(_language: VoiceInputLanguage, events: SpeechInputEvents) {
      ensure();
      if (running) return;
      const runGeneration = ++generation;
      running = true;
      segmenter.reset();
      vad?.reset();
      reorderer.reset(0);
      nextSequence = 0;
      currentSegment = null;
      vadChain = Promise.resolve();

      void capture!.start({
        onFrame: (frame, frameStart, frameEnd) => {
          if (!running || runGeneration !== generation) return;
          // Silero 推理本身是异步的；按帧串行消费，避免概率返回乱序导致
          // segmenter 看到倒退的 frameStart，进而错误切段。
          vadChain = vadChain
            .then(async () => {
              if (!running || runGeneration !== generation) return;
              const probability = await vad!.probability(frame);
              if (!running || runGeneration !== generation) return;
              for (const event of segmenter.push(probability, frameStart, frameEnd)) {
                if (event.type === "speech-start") {
                  const start: SpeechStartEvent = {
                    segmentId: `whisper-${nextSequence}`,
                    sequence: nextSequence,
                    audioStartAt: capture!.timeAtSample(event.startSample),
                    timeSource: "audio",
                  };
                  nextSequence += 1;
                  currentSegment = start;
                  events.onSpeechStart?.(start);
                  continue;
                }
                const start = currentSegment ?? {
                  segmentId: `whisper-${nextSequence}`,
                  sequence: nextSequence++,
                  audioStartAt: capture!.timeAtSample(event.startSample),
                  timeSource: "audio" as const,
                };
                const timing: SpeechSegmentTiming = {
                  ...start,
                  // 只用最后有声采样的时间计算尾静音，不能用含 tailMs 的 endSample。
                  audioEndAt: capture!.timeAtSample(event.lastVoiceSample),
                };
                currentSegment = null;
                events.onSegmentEnd?.(timing);
                void transcribe(timing, event.startSample, event.endSample, events, runGeneration);
              }
            })
            .catch((error) => {
              if (running && runGeneration === generation) {
                events.onError?.("vad-failed", error instanceof Error ? error.message : String(error));
              }
            });
        },
      })
        .then(() => {
          if (running && runGeneration === generation) events.onStart?.();
        })
        .catch((error) => {
          if (runGeneration !== generation) return;
          running = false;
          events.onError?.("audio-capture", error instanceof Error ? error.message : String(error));
        });
    },

    /**
     * 停止收音。
     * 已经在路上的转写不取消——那一段用户是真说过的，结果该交给上层，
     * 由上层的轮次编号决定还要不要它。
     */
    stop() {
      running = false;
      capture?.stop();
      segmenter.reset();
      currentSegment = null;
    },

    abort() {
      running = false;
      generation += 1;
      capture?.stop();
      segmenter.reset();
      vad?.reset();
      reorderer.reset(null);
      currentSegment = null;
    },

    dispose() {
      running = false;
      generation += 1;
      void capture?.dispose();
      void vad?.dispose();
      capture = null;
      vad = null;
      client = null;
      reorderer.reset(null);
      currentSegment = null;
    },
  };
}
