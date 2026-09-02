import type { SpeechInputEngine, SpeechInputEvents, VoiceInputLanguage } from "./contracts";

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

  return {
    id: "windows-web-speech",
    kind: "web-speech",

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
        if (interimText.trim()) events.onInterim?.(interimText.trim());
        if (finalText.trim()) events.onFinal?.(finalText.trim());
      };
      recognition.onerror = (event) => events.onError?.(event.error, event.message);
      recognition.onend = () => events.onEnd?.();
      recognition.start();
    },

    stop() {
      recognition?.stop();
    },

    abort() {
      recognition?.abort();
    },

    dispose() {
      recognition?.abort();
      recognition = null;
    },
  };
}
