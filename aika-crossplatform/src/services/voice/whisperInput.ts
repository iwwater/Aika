import { createVadSegmenter, DEFAULT_VAD_SETTINGS, type VadSegmenterSettings } from "../../domain/vadSegmenter";
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

  function ensure() {
    if (!capture) capture = createAudioCapture();
    if (!vad) vad = createSileroVad();
    if (!client) client = createWhisperClient(options.endpoint);
  }

  async function transcribe(from: number, to: number, events: SpeechInputEvents) {
    try {
      const samples = capture?.read(from, to) ?? new Float32Array(0);
      const text = (await client?.transcribe(samples)) ?? "";
      // 空串也要报：上层据此把「用户正在说」的状态放下来。
      events.onFinal?.(text);
    } catch (error) {
      events.onError?.("transcription-failed", error instanceof Error ? error.message : String(error));
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
      running = true;
      segmenter.reset();
      vad?.reset();

      void capture!.start({
        onFrame: (frame, frameStart, frameEnd) => {
          if (!running) return;
          void vad!.probability(frame)
            .then((probability) => {
              if (!running) return;
              for (const event of segmenter.push(probability, frameStart, frameEnd)) {
                if (event.type === "speech-start") {
                  events.onSpeechStart?.();
                  continue;
                }
                void transcribe(event.startSample, event.endSample, events);
              }
            })
            .catch((error) => {
              events.onError?.("vad-failed", error instanceof Error ? error.message : String(error));
            });
        },
      })
        .then(() => events.onStart?.())
        .catch((error) => {
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
    },

    abort() {
      running = false;
      capture?.stop();
      segmenter.reset();
      vad?.reset();
    },

    dispose() {
      running = false;
      void capture?.dispose();
      void vad?.dispose();
      capture = null;
      vad = null;
      client = null;
    },
  };
}
