import { useEffect, useRef, useState } from "react";
import type { CaptionRange } from "../domain/captionHighlight";
import { locateSentence } from "../domain/captionHighlight";
import { replyDisplayText, type CompanionReply } from "../domain/companion";
import { createAsrSegmentReorderer } from "../domain/asrSegments";
import { createSentenceEmitter } from "../domain/sentences";
import type { PartialReply } from "../domain/streamingReply";
import { mergeFragment, shouldSubmit } from "../domain/turnEnd";
import {
  monotonicNow,
  utcNow,
  type SpeechFinalResult,
  type VoiceRuntimeEvent,
  type VoiceRuntimeEventName,
  type VoiceTelemetrySink,
  type VoiceTurnRequest,
} from "../domain/voiceRuntime";
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
import { createSpeechQueue, type SpeechQueueDrainResult } from "../services/voice/speechQueue";
import { webSpeechOutput } from "../services/voice/webSpeechOutput";
import { createVoiceDiagnostics, type VoiceDiagnostics } from "../services/voice/voiceDiagnostics";

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
  request: VoiceTurnRequest,
) => Promise<CompanionReply | null>;

export function useVoiceConversation(
  onTranscript: VoiceTurnHandler,
  /** 下一轮该用哪个识别语言。只有 Web Speech 会用到；本地 Whisper 自己判。 */
  resolveLanguage: () => VoiceInputLanguage = () => "ja-JP",
  backend: VoiceBackendConfig = DEFAULT_VOICE_BACKEND,
  telemetry: VoiceTelemetrySink = () => undefined,
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
  /** 识别片段在真正提交前先挂到候选回合，埋点因此能从 segment 回溯到 turn。 */
  const draftTurnRef = useRef<number | null>(null);
  const segmentTurnRef = useRef(new Map<string, number>());
  /** 每次 start 注册一组新的事件回调；旧 Web Speech onend/结果不能重启或污染新组。 */
  const inputEpochRef = useRef(0);
  /** ASR 结果在途时不能把已经识别的前半句提前提交。 */
  const pendingAsrRef = useRef(new Set<string>());
  /** 引擎应按序发送，但 Hook 也保留最后一道乱序闸门。 */
  const asrReordererRef = useRef(createAsrSegmentReorderer<SpeechFinalResult>(null));
  /** 打断连续本地管线时，旧 in-flight ASR 按音频时间丢弃，新语音保留。 */
  const acceptAudioFromRef = useRef<number | null>(null);
  const turnRequestRef = useRef<(VoiceTurnRequest & { controller: AbortController }) | null>(null);
  const lifecycleRef = useRef(0);
  /** 默认也收集本地诊断；调用方传入的 sink 只是额外出口。 */
  const diagnosticsRef = useRef<VoiceDiagnostics | null>(null);
  if (!diagnosticsRef.current) diagnosticsRef.current = createVoiceDiagnostics();
  const resolveLanguageRef = useRef(resolveLanguage);
  resolveLanguageRef.current = resolveLanguage;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;
  /** 回调跑在旧闭包里，读 state 会读到注册时那一份，所以阶段也走 ref。 */
  const phaseRef = useRef<VoicePhase>("idle");
  phaseRef.current = phase;

  if (!queueRef.current) queueRef.current = createSpeechQueue(webSpeechOutput);
  if (!monitorRef.current) monitorRef.current = createMicActivityMonitor();

  /** 麦克风是不是一直开着。两条链路的调度方式不一样。 */
  function continuous() {
    return inputRef.current?.continuous === true;
  }

  function emit(
    name: VoiceRuntimeEventName,
    options: Omit<VoiceRuntimeEvent, "name" | "atMonotonicMs" | "recordedAtUtc"> & {
      atMonotonicMs?: number;
    } = {},
  ) {
    const event: VoiceRuntimeEvent = {
      ...options,
      name,
      atMonotonicMs: options.atMonotonicMs ?? monotonicNow(),
      recordedAtUtc: utcNow(),
    };
    diagnosticsRef.current?.sink(event);
    telemetryRef.current(event);
  }

  function turnForSegment(segmentId: string): number {
    const known = segmentTurnRef.current.get(segmentId);
    if (known !== undefined) return known;
    const candidate = draftTurnRef.current ?? turnRef.current + 1;
    segmentTurnRef.current.set(segmentId, candidate);
    return candidate;
  }

  function markVoice(atMonotonicMs = monotonicNow()) {
    lastVoiceAtRef.current = atMonotonicMs;
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
    const inputEpoch = ++inputEpochRef.current;

    try {
      startedRef.current = true;
      input.start(resolveLanguageRef.current(), {
        onStart: () => {
          if (inputEpoch !== inputEpochRef.current) return;
          setPhase((current) => (current === "thinking" || current === "speaking" ? current : "listening"));
        },
        onSpeechStart: (event) => {
          if (inputEpoch !== inputEpochRef.current) return;
          handleSpeechStart(event);
        },
        onInterim: (text, atMonotonicMs) => {
          if (inputEpoch !== inputEpochRef.current) return;
          markVoice(atMonotonicMs ?? monotonicNow());
          setInterim(text);
        },
        onSegmentEnd: (event) => {
          if (inputEpoch !== inputEpochRef.current) return;
          pendingAsrRef.current.add(event.segmentId);
          speakingRef.current = false;
          // 这里是用户最后有声采样的时间，而不是 ASR 返回时间。
          markVoice(event.audioEndAt);
          emit("speechEnd", {
            turnId: turnForSegment(event.segmentId),
            atMonotonicMs: event.audioEndAt,
            segmentId: event.segmentId,
            timeSource: event.timeSource,
            details: { sequence: event.sequence },
          });
        },
        onFinal: (result) => {
          if (inputEpoch !== inputEpochRef.current) return;
          pendingAsrRef.current.delete(result.segmentId);
          emit("asrFinal", {
            turnId: turnForSegment(result.segmentId),
            segmentId: result.segmentId,
            timeSource: result.timeSource,
            details: {
              sequence: result.sequence,
              textLength: result.text.length,
              accepted: acceptAudioFromRef.current === null
                || result.audioEndAt >= acceptAudioFromRef.current,
            },
          });
          setInterim("");
          for (const ordered of asrReordererRef.current.push(result)) {
            const minAudioTime = acceptAudioFromRef.current;
            if (minAudioTime !== null && ordered.audioEndAt < minAudioTime) continue;
            if (minAudioTime !== null) acceptAudioFromRef.current = null;
            if (ordered.text.trim()) setPendingText(mergeFragment(pendingRef.current, ordered.text));
          }
        },
        onError: (code, detail) => {
          if (inputEpoch !== inputEpochRef.current) return;
          handleRecognitionError(code, detail);
        },
        onEnd: () => {
          if (inputEpoch !== inputEpochRef.current) return;
          startedRef.current = false;
          // 只有每段结束就自己停的引擎需要重启；本地管线的麦克风不关。
          if (!input.continuous && activeRef.current && !busyRef.current) {
            window.setTimeout(startRecognition, 200);
          }
        },
      });
    } catch (startError) {
      startedRef.current = false;
      if (inputEpoch !== inputEpochRef.current) return;
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
  function handleSpeechStart(event?: { audioStartAt: number; segmentId?: string }) {
    const audioStartAt = event?.audioStartAt ?? monotonicNow();
    if (event?.segmentId) turnForSegment(event.segmentId);
    markVoice(audioStartAt);
    speakingRef.current = true;
    if (continuous() && (
      phaseRef.current === "thinking"
      || phaseRef.current === "speaking"
      || queueRef.current?.isSpeaking()
    )) {
      interruptAndListen("barge-in", audioStartAt);
      // interruptAndListen 清理旧轮状态；这次事件本身是新轮用户语音的开始。
      speakingRef.current = true;
      if (event?.segmentId) turnForSegment(event.segmentId);
    }
  }

  /** 一轮结束与否由 domain/turnEnd 判断，这里只按时问，不自己定规则。 */
  function tick() {
    if (!activeRef.current || busyRef.current) return;
    // 人还在出声就不要提交，哪怕文字部分暂时没有新内容进来。
    if (speakingRef.current) return;
    // VAD 已切段但 Whisper 还没返回时，不能把前一段误认为整轮已结束。
    if (pendingAsrRef.current.size > 0) return;
    const text = pendingRef.current;
    if (!text.trim()) return;
    if (shouldSubmit(text, monotonicNow() - lastVoiceAtRef.current)) submitTurn();
  }

  function submitTurn() {
    const text = pendingRef.current.trim();
    if (!text || busyRef.current || speakingRef.current || pendingAsrRef.current.size > 0) return;

    const turn = draftTurnRef.current ?? turnRef.current + 1;
    turnRef.current = Math.max(turnRef.current, turn);
    draftTurnRef.current = null;
    const controller = new AbortController();
    const request: VoiceTurnRequest & { controller: AbortController } = {
      turnId: turn,
      signal: controller.signal,
      controller,
      // 没有外部播放进度回采时，中断不能猜用户听到了多少；完整 drained
      // 的结果由 onPlaybackComplete 单独传给会话层。
      getPlaybackStatus: () => "unknown",
    };
    turnRequestRef.current = request;
    const current = () => turnRef.current === turn && !controller.signal.aborted;

    setPendingText("");
    setInterim("");
    busyRef.current = true;
    setPhase("thinking");
    clearHighlight();
    emit("turnCommitted", {
      turnId: turn,
      details: { textLength: text.length },
    });
    // 麦克风一直开着的链路不停收音：这样她说话时用户开口才有东西可听。
    if (!continuous()) {
      // Web Speech 的 stop/onend 可能把旧 final 迟到送回来；提交后这一组
      // 结果不属于下一轮，先换 epoch 再停引擎。
      inputEpochRef.current += 1;
      inputRef.current?.stop();
      startedRef.current = false;
    }
    appendCaption("user", text);

    // 边收边念：句子一确定就入队，不等整段文本生成完。
    const emitter = createSentenceEmitter();
    let captionId: number | null = null;

    queueRef.current?.begin({
      turnId: turn,
      onStart: () => {
        if (!current()) return;
        setPhase("speaking");
        setSpeakingCaptionId(captionId);
        emit("firstAudio", {
          turnId: turn,
          details: { source: "engine-onStart" },
        });
      },
      // 念到哪一句就把字幕亮到哪一句。找不到就不亮，宁可没有高亮也不能亮错位置。
      onSentence: (_index, sentence) => {
        if (!current()) return;
        const range = locateSentence(captionTextRef.current, sentence, highlightFromRef.current);
        if (range) highlightFromRef.current = range.end;
        setSpeakingRange(range);
      },
      onDrained: (result) => {
        if (current()) finishSpeaking(result);
      },
      // 单句合成失败不打断这一轮：队列会继续念下一句，但必须让用户看见。
      onError: (message) => {
        if (current()) setError(`语音播放失败：${message}`);
      },
    });
    // Web Speech 在提交后会暂时停止识别；监听必须从 thinking 阶段就启动，
    // 否则用户在模型生成期间开口无法打断。
    if (!continuous()) void watchForBargeIn();

    let firstTextReported = false;
    let replyAccepted = false;

    void onTranscriptRef.current(text, (partial) => {
      if (!current()) return;
      // mood 在 JSON 最前面，通常比第一句正文先到——第一句因此就能用上这轮的语气。
      queueRef.current?.setMood(partial.mood);
      if (!partial.japaneseText) return;
      if (!firstTextReported) {
        firstTextReported = true;
        emit("firstText", { turnId: turn });
      }
      captionId = upsertAssistantCaption(captionId, partial.japaneseText, partial.chineseTranslation);
      queueRef.current?.enqueue(emitter.push(partial.japaneseText, false));
    }, request).then((reply) => {
      if (!current()) return;

      const spoken = reply ? replyDisplayText(reply) : "";
      if (!reply || !spoken) {
        queueRef.current?.stop();
        busyRef.current = false;
        setPhase("error");
        setError("模型没有返回回复，请退出语音后查看聊天页里的具体错误。");
        return;
      }

      replyAccepted = true;
      if (!firstTextReported && spoken) {
        firstTextReported = true;
        emit("firstText", { turnId: turn });
      }
      queueRef.current?.setMood(reply.mood);
      captionId = upsertAssistantCaption(captionId, spoken, reply.chineseTranslation);
      queueRef.current?.enqueue(emitter.push(spoken, true));
      queueRef.current?.end();
    }).catch((error) => {
      if (!current()) return;
      queueRef.current?.stop();
      busyRef.current = false;
      setPhase("error");
      setError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!replyAccepted && turnRequestRef.current?.turnId === turn) turnRequestRef.current = null;
    });
  }

  function finishSpeaking(result: SpeechQueueDrainResult) {
    monitorRef.current?.stop();
    const request = turnRequestRef.current;
    if (request && !request.signal.aborted) {
      if (result.played) {
        request.onPlaybackComplete?.();
      } else {
        request.onPlaybackFailed?.(`所有语音句子都播放失败（${result.errorCount}/${result.sentenceCount}）`);
      }
    }
    turnRequestRef.current = null;
    clearHighlight();
    setSpeakingCaptionId(null);
    busyRef.current = false;
    markVoice();
    if (!activeRef.current) return;
    if (!result.played) {
      setPhase("error");
      setError("语音播放失败，但文字回复仍已保留；可以重试或切换输出设备。" );
      return;
    }
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
      await monitorRef.current?.start(({ atMonotonicMs }) => {
        if (activeRef.current) interruptAndListen("barge-in", atMonotonicMs);
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
    pendingAsrRef.current.clear();
    busyRef.current = false;
    setPhase("error");
    setError(recognitionErrors[code] ?? detail ?? `语音识别错误：${code}`);
  }

  useEffect(() => () => {
    lifecycleRef.current += 1;
    activeRef.current = false;
    inputEpochRef.current += 1;
    turnRequestRef.current?.controller.abort();
    turnRequestRef.current = null;
    pendingAsrRef.current.clear();
    asrReordererRef.current.reset(null);
    draftTurnRef.current = null;
    segmentTurnRef.current.clear();
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    inputRef.current?.abort();
    inputRef.current?.dispose();
    queueRef.current?.stop();
    void monitorRef.current?.dispose();
  }, []);

  async function open() {
    const lifecycle = ++lifecycleRef.current;
    activeRef.current = false;
    turnRequestRef.current?.controller.abort();
    turnRequestRef.current = null;
    pendingAsrRef.current.clear();
    asrReordererRef.current.reset(0);
    draftTurnRef.current = null;
    segmentTurnRef.current.clear();
    acceptAudioFromRef.current = null;
    inputEpochRef.current += 1;
    setIsOpen(true);
    setPendingText("");
    setInterim("");
    setError("");
    setCaptions([]);
    setSpeakingCaptionId(null);
    clearHighlight();
    setPhase("idle");

    // 每次进语音页都重新选一次链路：本地服务可能刚开起来，也可能刚关掉。
    void inputRef.current?.dispose();
    inputRef.current = null;
    startedRef.current = false;
    const resolved = await createInputEngine(backendRef.current);
    if (lifecycle !== lifecycleRef.current) {
      void resolved.engine.dispose();
      return;
    }
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
      if (lifecycle !== lifecycleRef.current) {
        void resolved.engine.dispose();
        return;
      }
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
   * 轮次一换，还在路上的流式回调和模型回复都会被忽略；已经显示的片段若落库，
   * 会标成 interrupted，不会被上下文当作完整回复，也不会触发记忆抽取。
   */
  function interruptAndListen(
    reason: "barge-in" | "button" = "button",
    audioStartAt?: number,
  ) {
    const wasSpeaking = phaseRef.current === "speaking" || queueRef.current?.isSpeaking() === true;
    const interruptedTurnId = turnRequestRef.current?.turnId;
    emit("interruptDetected", {
      turnId: interruptedTurnId,
      details: { reason },
    });
    turnRequestRef.current?.controller.abort();
    turnRequestRef.current = null;
    turnRef.current += 1;
    queueRef.current?.stop();
    monitorRef.current?.stop();
    setSpeakingCaptionId(null);
    clearHighlight();
    busyRef.current = false;
    activeRef.current = true;
    speakingRef.current = false;
    pendingAsrRef.current.clear();
    asrReordererRef.current.reset(null);
    acceptAudioFromRef.current = audioStartAt ?? monotonicNow();
    setPendingText("");
    setInterim("");
    markVoice();
    setPhase("listening");
    if (wasSpeaking) {
      // queue.stop() 只代表向 TTS 发出了停止请求，没有声学回采证据，
      // 所以单独记录为代理事件，不能拿它计算真实 stop latency。
      emit("playbackStopped", {
        turnId: interruptedTurnId,
        details: { reason, status: "stopRequested", precision: "proxy" },
      });
    }

    // 麦克风一直开着的链路不要 abort：那会连同已经录下来的、
    // 用户正在说的这句一起丢掉，而它恰恰是我们要听的内容。
    if (continuous()) return;
    inputEpochRef.current += 1;
    inputRef.current?.abort();
    startedRef.current = false;
    window.setTimeout(startRecognition, 160);
  }

  /** 不等尾静音，现在就发。缓冲区里的内容用户已经看见了，他说发就发。 */
  function sendNow() {
    if (phase === "speaking") {
      interruptAndListen("button");
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
    const wasSpeaking = phaseRef.current === "speaking" || queueRef.current?.isSpeaking() === true;
    const interruptedTurnId = turnRequestRef.current?.turnId;
    lifecycleRef.current += 1;
    turnRequestRef.current?.controller.abort();
    turnRequestRef.current = null;
    turnRef.current += 1;
    inputEpochRef.current += 1;
    activeRef.current = false;
    busyRef.current = false;
    speakingRef.current = false;
    startedRef.current = false;
    pendingAsrRef.current.clear();
    asrReordererRef.current.reset(null);
    draftTurnRef.current = null;
    segmentTurnRef.current.clear();
    acceptAudioFromRef.current = null;
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    inputRef.current?.abort();
    void inputRef.current?.dispose();
    inputRef.current = null;
    queueRef.current?.stop();
    if (wasSpeaking) {
      emit("playbackStopped", {
        turnId: interruptedTurnId,
        details: { reason: "close", status: "stopRequested", precision: "proxy" },
      });
    }
    monitorRef.current?.stop();
    void monitorRef.current?.dispose();
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
    diagnostics: diagnosticsRef.current,
    exportDiagnostics: () => diagnosticsRef.current?.exportJson() ?? "{}",
  };
}
