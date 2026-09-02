import { useEffect, useRef, useState } from "react";
import { replyDisplayText, type CompanionReply } from "../domain/companion";
import type {
  SpeechInputEngine,
  VoiceCaption,
  VoiceInputLanguage,
  VoicePhase,
} from "../services/voice/contracts";
import { createWebSpeechInputEngine } from "../services/voice/webSpeechInput";
import { webSpeechOutput } from "../services/voice/webSpeechOutput";

export type { VoicePhase } from "../services/voice/contracts";

const recognitionErrors: Record<string, string> = {
  "not-allowed": "麦克风权限被拒绝，请在 Windows 隐私设置中允许桌面应用使用麦克风。",
  "audio-capture": "没有检测到可用的麦克风。",
  network: "语音识别服务暂时无法连接。",
  "language-not-supported": "当前系统语音识别不支持所选语言。",
};

export function useVoiceConversation(
  onTranscript: (text: string) => Promise<CompanionReply | null>,
  /** 下一轮该用哪个识别语言。由会话按用户最近说的话推导，用户不需要自己选。 */
  resolveLanguage: () => VoiceInputLanguage = () => "ja-JP",
) {
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [speakingCaptionId, setSpeakingCaptionId] = useState<number | null>(null);
  const inputRef = useRef<SpeechInputEngine | null>(null);
  const activeRef = useRef(false);
  const busyRef = useRef(false);
  const resolveLanguageRef = useRef(resolveLanguage);
  resolveLanguageRef.current = resolveLanguage;
  const captionIdRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  if (!inputRef.current) inputRef.current = createWebSpeechInputEngine();

  function startRecognition() {
    const input = inputRef.current;
    if (!input || !activeRef.current || busyRef.current) return;
    webSpeechOutput.stop();
    setError("");
    setInterim("");

    try {
      input.start(resolveLanguageRef.current(), {
        onStart: () => setPhase("listening"),
        onInterim: setInterim,
        onFinal: handleFinalTranscript,
        onError: handleRecognitionError,
        onEnd: () => {
          if (activeRef.current && !busyRef.current) window.setTimeout(startRecognition, 220);
        },
      });
    } catch (startError) {
      if (!(startError instanceof DOMException && startError.name === "InvalidStateError")) {
        setPhase("error");
        setError(startError instanceof Error ? startError.message : String(startError));
      }
    }
  }

  function handleFinalTranscript(completed: string) {
    setTranscript(completed);
    setInterim("");
    appendCaption("user", completed);
    busyRef.current = true;
    setPhase("thinking");
    inputRef.current?.stop();

    void onTranscriptRef.current(completed).then((reply) => {
      const spoken = reply ? replyDisplayText(reply) : "";
      if (reply && spoken) {
        const captionId = appendCaption("assistant", spoken, reply.chineseTranslation);
        speak(spoken, captionId);
      }
      else {
        busyRef.current = false;
        setPhase("error");
        setError("模型没有返回回复，请退出语音后查看聊天页里的具体错误。");
      }
    });
  }

  function appendCaption(speaker: VoiceCaption["speaker"], text: string, translation?: string) {
    captionIdRef.current += 1;
    const caption: VoiceCaption = { id: captionIdRef.current, speaker, text, translation };
    setCaptions((current) => [...current, caption].slice(-10));
    return caption.id;
  }

  function handleRecognitionError(code: string, detail?: string) {
    if (code === "aborted" || code === "no-speech") return;
    busyRef.current = false;
    setPhase("error");
    setError(recognitionErrors[code] ?? detail ?? `语音识别错误：${code}`);
  }

  function speak(text: string, captionId: number) {
    webSpeechOutput.speak(
      { text, language: "ja-JP", rate: 1.03, pitch: 1.08 },
      {
        onStart: () => {
          setSpeakingCaptionId(captionId);
          setPhase("speaking");
        },
        onEnd: () => {
          setSpeakingCaptionId(null);
          busyRef.current = false;
          if (activeRef.current) startRecognition();
        },
        onError: () => {
          setSpeakingCaptionId(null);
          busyRef.current = false;
          if (activeRef.current) startRecognition();
        },
      },
    );
  }

  useEffect(() => () => {
    activeRef.current = false;
    inputRef.current?.abort();
    inputRef.current?.dispose();
    webSpeechOutput.stop();
  }, []);

  async function open() {
    const input = inputRef.current;
    setIsOpen(true);
    setTranscript("");
    setInterim("");
    setError("");
    setCaptions([]);
    setSpeakingCaptionId(null);

    if (!input?.isAvailable()) {
      setPhase("error");
      setError("当前 WebView 没有提供语音识别接口，后续可直接替换为本地 Whisper 引擎。");
      return;
    }

    try {
      await input.requestPermission();
      activeRef.current = true;
      busyRef.current = false;
      startRecognition();
    } catch (permissionError) {
      setPhase("error");
      setError(permissionError instanceof Error ? `无法使用麦克风：${permissionError.message}` : "无法使用麦克风");
    }
  }

  function interruptAndListen() {
    webSpeechOutput.stop();
    setSpeakingCaptionId(null);
    busyRef.current = false;
    activeRef.current = true;
    inputRef.current?.abort();
    window.setTimeout(startRecognition, 180);
  }

  function close() {
    activeRef.current = false;
    busyRef.current = false;
    inputRef.current?.abort();
    webSpeechOutput.stop();
    setSpeakingCaptionId(null);
    setPhase("idle");
    setIsOpen(false);
  }

  return { isOpen, phase, transcript, interim, error, captions, speakingCaptionId, open, close, interruptAndListen };
}
