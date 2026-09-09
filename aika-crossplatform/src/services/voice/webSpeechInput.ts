import type { SpeechInputEngine, SpeechInputEvents, VoiceInputLanguage } from "./contracts";
import { monotonicNow, type SpeechSegmentTiming, type SpeechStartEvent } from "../../domain/voiceRuntime";

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => RecognitionLike;

function getConstructor(): RecognitionConstructor | undefined {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export function createWebSpeechInputEngine(): SpeechInputEngine {
  let recognition: RecognitionLike | null = null;
  let sequence = 0;
  let currentSegment: SpeechStartEvent | null = null;

  function beginSegment(atMonotonicMs: number): SpeechStartEvent {
    const started: SpeechStartEvent = {
      segmentId: `web-speech-${sequence}`,
      sequence,
      audioStartAt: atMonotonicMs,
      timeSource: "estimated",
    };
    sequence += 1;
    currentSegment = started;
    return started;
  }

  function finishSegment(events: SpeechInputEvents, text: string) {
    const endAt = monotonicNow();
    const started = currentSegment ?? beginSegment(endAt);
    const timing: SpeechSegmentTiming = { ...started, audioEndAt: endAt };
    events.onSegmentEnd?.(timing);
    events.onFinal?.({ ...timing, text });
    currentSegment = null;
  }

  return {
    id: "windows-web-speech",
    kind: "web-speech",
    // 每识别出一段就 onend，必须由上层重新 start()。
    continuous: false,

    isAvailable() {
      return Boolean(getConstructor());
    },

    async requestPermission() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    },

    start(language: VoiceInputLanguage, events: SpeechInputEvents) {
      const Constructor = getConstructor();
      if (!Constructor) throw new Error("当前 WebView 没有提供语音识别接口");
      if (!recognition) {
        recognition = new Constructor();
        recognition.continuous = false;
        recognition.interimResults = true;
      }
      currentSegment = null;
      recognition.lang = language;
      recognition.onstart = () => events.onStart?.();
      recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) finalText += result[0].transcript;
          else interimText += result[0].transcript;
        }
        if (interimText.trim()) {
          // 中间结果就是这个引擎的「有人在说」信号。
          const at = monotonicNow();
          const segment = currentSegment ?? beginSegment(at);
          events.onSpeechStart?.(segment);
          events.onInterim?.(interimText.trim(), at);
        }
        const hasFinal = Array.from({ length: event.results.length - event.resultIndex })
          .some((_, index) => event.results[event.resultIndex + index]?.isFinal);
        if (hasFinal) finishSegment(events, finalText.trim());
      };
      recognition.onerror = (event) => events.onError?.(event.error, event.message);
      recognition.onend = () => {
        // 某些 Web Speech 实现只给 onend、不再给最后一个 final；仍然要释放
        // 「ASR 在途」状态，但时间精度明确是估算。
        if (currentSegment) finishSegment(events, "");
        events.onEnd?.();
      };
      recognition.start();
    },

    stop() {
      recognition?.stop();
    },

    abort() {
      recognition?.abort();
      currentSegment = null;
    },

    dispose() {
      recognition?.abort();
      recognition = null;
      currentSegment = null;
    },
  };
}
