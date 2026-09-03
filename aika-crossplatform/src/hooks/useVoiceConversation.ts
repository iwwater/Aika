import { useEffect, useRef, useState } from "react";
import type { CaptionRange } from "../domain/captionHighlight";
import { locateSentence } from "../domain/captionHighlight";
import { replyDisplayText, type CompanionReply } from "../domain/companion";
import { createSentenceEmitter } from "../domain/sentences";
import type { PartialReply } from "../domain/streamingReply";
import { mergeFragment, shouldSubmit } from "../domain/turnEnd";
import type {
  SpeechInputEngine,
  VoiceCaption,
  VoiceInputLanguage,
  VoicePhase,
} from "../services/voice/contracts";
import {
  createInputEngine, DEFAULT_VOICE_BACKEND, type VoiceBackendConfig,
} from "../services/voice/inputEngine";
import { createMicActivityMonitor } from "../services/voice/micActivity";
import { createSpeechQueue } from "../services/voice/speechQueue";
import { webSpeechOutput } from "../services/voice/webSpeechOutput";

export type { VoicePhase } from "../services/voice/contracts";

/** 回合判定的轮询间隔。判定规则在 domain/turnEnd.ts，这里只负责按时问一次。 */
const TURN_TICK_MS = 120;

const recognitionErrors: Record<string, string> = {
  "not-allowed": "麦克风权限被拒绝，请在 Windows 隐私设置中允许桌面应用使用麦克风。",
  "audio-capture": "没有检测到可用的麦克风。",
  network: "语音识别服务暂时无法连接。",
  "language-not-supported": "当前系统语音识别不支持所选语言。",
  "transcription-failed": "本地语音识别没有返回结果。",
  "vad-failed": "语音活动检测出错，请退出语音后重试。",
};

export type VoiceTurnHandler = (
  text: string,
  onPartial: (partial: PartialReply) => void,
) => Promise<CompanionReply | null>;

export function useVoiceConversation(
  onTranscript: VoiceTurnHandler,
  /** 下一轮该用哪个识别语言。只有 Web Speech 会用到；本地 Whisper 自己判。 */
  resolveLanguage: () => VoiceInputLanguage = () => "ja-JP",
  backend: VoiceBackendConfig = DEFAULT_VOICE_BACKEND,
) {
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  /** 已经识别出来、但这一轮还没结束的内容。用户看得见，也能改主意。 */
  const [pending, setPending] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [speakingCaptionId, setSpeakingCaptionId] = useState<number | null>(null);
  /** 正在念的那一句在字幕里的位置。念到哪儿就亮到哪儿，不整条一起亮。 */
  const [speakingRange, setSpeakingRange] = useState<CaptionRange | null>(null);
  /** 这一轮实际走的是哪条识别链路。要让用户看得见，退回系统识别不能是隐形的。 */
  const [backendNote, setBackendNote] = useState("");

  const inputRef = useRef<SpeechInputEngine | null>(null);
  const queueRef = useRef<ReturnType<typeof createSpeechQueue> | null>(null);
  const monitorRef = useRef<ReturnType<typeof createMicActivityMonitor> | null>(null);
  const activeRef = useRef(false);
  const busyRef = useRef(false);
  /** 用户此刻正在出声。本地管线没有中间结果，全靠引擎的 onSpeechStart 告诉我们。 */
  const speakingRef = useRef(false);
  const startedRef = useRef(false);
  const pendingRef = useRef("");
  const lastVoiceAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const captionIdRef = useRef(0);
  /** 这一轮字幕的最新全文。高亮要按它算下标，state 在回调里读到的是旧的那份。 */
  const captionTextRef = useRef("");
  /** 高亮的搜索起点，只往前走。重复出现的同一句话才不会亮回上一处。 */
  const highlightFromRef = useRef(0);
  /** 这一轮的编号。打断之后模型还会把回复送回来，靠它认出那是上一轮的。 */
  const turnRef = useRef(0);
  const resolveLanguageRef = useRef(resolveLanguage);
  resolveLanguageRef.current = resolveLanguage;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  /** 回调跑在旧闭包里，读 state 会读到注册时那一份，所以阶段也走 ref。 */
  const phaseRef = useRef<VoicePhase>("idle");
  phaseRef.current = phase;

  if (!queueRef.current) queueRef.current = createSpeechQueue(webSpeechOutput);
  if (!monitorRef.current) monitorRef.current = createMicActivityMonitor();

  /** 麦克风是不是一直开着。两条链路的调度方式不一样。 */
  function continuous() {
    return inputRef.current?.continuous === true;
  }

  function markVoice() {
    lastVoiceAtRef.current = Date.now();
  }

  function setPendingText(text: string) {
    pendingRef.current = text;
    setPending(text);
  }

  function startRecognition() {
    const input = inputRef.current;
    if (!input || !activeRef.current || busyRef.current) return;
    // 麦克风一直开着的引擎不需要反复启动，重复 start 反而会把缓冲区清掉。
    if (input.continuous && startedRef.current) return;
    setError("");

    try {
      startedRef.current = true;
      input.start(resolveLanguageRef.current(), {
        onStart: () => setPhase((current) => (current === "thinking" || current === "speaking" ? current : "listening")),
        onSpeechStart: handleSpeechStart,
        onInterim: (text) => {
          markVoice();
          setInterim(text);
        },
        onFinal: (text) => {
          speakingRef.current = false;
          markVoice();
          setInterim("");
          if (text.trim()) setPendingText(mergeFragment(pendingRef.current, text));
        },
        onError: handleRecognitionError,
        onEnd: () => {
          startedRef.current = false;
          // 只有每段结束就自己停的引擎需要重启；本地管线的麦克风不关。
          if (!input.continuous && activeRef.current && !busyRef.current) {
            window.setTimeout(startRecognition, 200);
          }
        },
      });
    } catch (startError) {
      startedRef.current = false;
      if (!(startError instanceof DOMException && startError.name === "InvalidStateError")) {
        setPhase("error");
        setError(startError instanceof Error ? startError.message : String(startError));
      }
    }
  }

  /**
   * 用户开口了。
   *
   * 麦克风一直开着的链路，这就是打断信号本身——而且比能量监听好：
   * 音频还留在环形缓冲里，被打断时说的第一个字不会丢。
   */
  function handleSpeechStart() {
    markVoice();
    speakingRef.current = true;
    if (continuous() && (phaseRef.current === "speaking" || queueRef.current?.isSpeaking())) {
      interruptAndListen();
    }
  }

  /** 一轮结束与否由 domain/turnEnd 判断，这里只按时问，不自己定规则。 */
  function tick() {
    if (!activeRef.current || busyRef.current) return;
    // 人还在出声就不要提交，哪怕文字部分暂时没有新内容进来。
    if (speakingRef.current) return;
    const text = pendingRef.current;
    if (!text.trim()) return;
    if (shouldSubmit(text, Date.now() - lastVoiceAtRef.current)) submitTurn();
  }

  function submitTurn() {
    const text = pendingRef.current.trim();
    if (!text || busyRef.current) return;

    turnRef.current += 1;
    const turn = turnRef.current;
    const current = () => turnRef.current === turn;

    setPendingText("");
    setInterim("");
    busyRef.current = true;
    setPhase("thinking");
    clearHighlight();
    // 麦克风一直开着的链路不停收音：这样她说话时用户开口才有东西可听。
    if (!continuous()) {
      inputRef.current?.stop();
      startedRef.current = false;
    }
    appendCaption("user", text);

    // 边收边念：句子一确定就入队，不等整段文本生成完。
    const emitter = createSentenceEmitter();
    let captionId: number | null = null;

    queueRef.current?.begin({
      onStart: () => {
        if (!current()) return;
        setPhase("speaking");
        setSpeakingCaptionId(captionId);
        void watchForBargeIn();
      },
      // 念到哪一句就把字幕亮到哪一句。找不到就不亮，宁可没有高亮也不能亮错位置。
      onSentence: (_index, sentence) => {
        if (!current()) return;
        const range = locateSentence(captionTextRef.current, sentence, highlightFromRef.current);
        if (range) highlightFromRef.current = range.end;
        setSpeakingRange(range);
      },
      onDrained: () => {
        if (current()) finishSpeaking();
      },
      // 单句合成失败不打断这一轮：队列会继续念下一句。
      onError: () => undefined,
    });

    void onTranscriptRef.current(text, (partial) => {
      if (!current()) return;
      // mood 在 JSON 最前面，通常比第一句正文先到——第一句因此就能用上这轮的语气。
      queueRef.current?.setMood(partial.mood);
      if (!partial.japaneseText) return;
      captionId = upsertAssistantCaption(captionId, partial.japaneseText, partial.chineseTranslation);
      queueRef.current?.enqueue(emitter.push(partial.japaneseText, false));
    }).then((reply) => {
      if (!current()) return;

      const spoken = reply ? replyDisplayText(reply) : "";
      if (!reply || !spoken) {
        queueRef.current?.stop();
        busyRef.current = false;
        setPhase("error");
        setError("模型没有返回回复，请退出语音后查看聊天页里的具体错误。");
        return;
      }

      queueRef.current?.setMood(reply.mood);
      captionId = upsertAssistantCaption(captionId, spoken, reply.chineseTranslation);
      queueRef.current?.enqueue(emitter.push(spoken, true));
      queueRef.current?.end();
    });
  }

  function finishSpeaking() {
    monitorRef.current?.stop();
    clearHighlight();
    setSpeakingCaptionId(null);
    busyRef.current = false;
    markVoice();
    if (!activeRef.current) return;
    setPhase("listening");
    startRecognition();
  }

  /**
   * 播放期间保持监听。
   * 本地管线的麦克风本来就没关，VAD 就是打断信号，不需要另开一路能量监听。
   */
  async function watchForBargeIn() {
    if (continuous()) return;
    try {
      await monitorRef.current?.start(() => {
        if (activeRef.current) interruptAndListen();
      });
    } catch {
      // 没有麦克风权限或音频接口时，打断按钮仍然可用。
    }
  }

  /** 一轮说完、被打断或退出时都要清掉，否则上一轮的高亮会留在屏幕上。 */
  function clearHighlight() {
    captionTextRef.current = "";
    highlightFromRef.current = 0;
    setSpeakingRange(null);
  }

  function appendCaption(speaker: VoiceCaption["speaker"], text: string, translation?: string) {
    captionIdRef.current += 1;
    const caption: VoiceCaption = { id: captionIdRef.current, speaker, text, translation };
    setCaptions((current) => [...current, caption].slice(-10));
    return caption.id;
  }

  /** 流式字幕：第一段到了才建卡片，之后原地长出来，不要每次都新加一条。 */
  function upsertAssistantCaption(id: number | null, text: string, translation?: string): number {
    captionTextRef.current = text;
    if (id === null) return appendCaption("assistant", text, translation);
    setCaptions((current) => current.map((caption) => (
      caption.id === id ? { ...caption, text, translation: translation || caption.translation } : caption
    )));
    return id;
  }

  function handleRecognitionError(code: string, detail?: string) {
    if (code === "aborted" || code === "no-speech") return;
    speakingRef.current = false;
    // 单段转写失败不该让整个语音页停摆，下一段还会继续。
    if (code === "transcription-failed") {
      setError(detail ? `${recognitionErrors[code]}（${detail}）` : recognitionErrors[code]);
      return;
    }
    busyRef.current = false;
    setPhase("error");
    setError(recognitionErrors[code] ?? detail ?? `语音识别错误：${code}`);
  }

  useEffect(() => () => {
    activeRef.current = false;
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    inputRef.current?.abort();
    inputRef.current?.dispose();
    queueRef.current?.stop();
    void monitorRef.current?.dispose();
  }, []);

  async function open() {
    setIsOpen(true);
    setPendingText("");
    setInterim("");
    setError("");
    setCaptions([]);
    setSpeakingCaptionId(null);
    clearHighlight();
    setPhase("idle");

    // 每次进语音页都重新选一次链路：本地服务可能刚开起来，也可能刚关掉。
    inputRef.current?.dispose();
    startedRef.current = false;
    const resolved = await createInputEngine(backendRef.current);
    inputRef.current = resolved.engine;
    setBackendNote(resolved.note);
    if (resolved.degraded) setError(resolved.note);

    if (!resolved.engine.isAvailable()) {
      setPhase("error");
      setError("当前 WebView 没有提供可用的语音输入接口。");
      return;
    }

    try {
      await resolved.engine.requestPermission();
      activeRef.current = true;
      busyRef.current = false;
      speakingRef.current = false;
      markVoice();
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      tickRef.current = window.setInterval(tick, TURN_TICK_MS);
      startRecognition();
    } catch (permissionError) {
      setPhase("error");
      setError(permissionError instanceof Error ? `无法使用麦克风：${permissionError.message}` : "无法使用麦克风");
    }
  }

  /**
   * 她还在说话时用户开口（或点了麦克风）：停下，把这一轮交回去。
   * 轮次一换，还在路上的流式回调和模型回复都会被忽略——但那条消息仍然落库，
   * 打断的是嘴，不是记忆。
   */
  function interruptAndListen() {
    turnRef.current += 1;
    queueRef.current?.stop();
    monitorRef.current?.stop();
    setSpeakingCaptionId(null);
    clearHighlight();
    busyRef.current = false;
    activeRef.current = true;
    setPendingText("");
    setInterim("");
    markVoice();
    setPhase("listening");

    // 麦克风一直开着的链路不要 abort：那会连同已经录下来的、
    // 用户正在说的这句一起丢掉，而它恰恰是我们要听的内容。
    if (continuous()) return;
    inputRef.current?.abort();
    startedRef.current = false;
    window.setTimeout(startRecognition, 160);
  }

  /** 不等尾静音，现在就发。缓冲区里的内容用户已经看见了，他说发就发。 */
  function sendNow() {
    if (phase === "speaking") {
      interruptAndListen();
      return;
    }
    submitTurn();
  }

  /** 识别错了就清掉，不要逼用户把错的那句发出去。 */
  function clearPending() {
    setPendingText("");
    setInterim("");
    markVoice();
  }

  function close() {
    turnRef.current += 1;
    activeRef.current = false;
    busyRef.current = false;
    speakingRef.current = false;
    startedRef.current = false;
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    inputRef.current?.abort();
    queueRef.current?.stop();
    monitorRef.current?.stop();
    setPendingText("");
    setInterim("");
    setSpeakingCaptionId(null);
    clearHighlight();
    setPhase("idle");
    setIsOpen(false);
  }

  return {
    isOpen, phase, pending, interim, error, captions, speakingCaptionId, speakingRange, backendNote,
    open, close, interruptAndListen, sendNow, clearPending,
  };
}
