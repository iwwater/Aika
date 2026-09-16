import { createAsrSegmentReorderer } from "../domain/asrSegments";
import type { ResolvedOutputEngine, VoiceOutputConfig } from "../services/voice/outputEngine";
import type { VoiceOutputStatus } from "../services/voice/tokens";
import { locateSentence, type CaptionRange } from "../domain/captionHighlight";
import { NO_TRACE, type TraceRecorder } from "../services/trace/traceRecorder";
import { replyDisplayText, type CompanionReply } from "../domain/companion";
import { createSentenceEmitter, splitIntoSentences } from "../domain/sentences";
import type { PartialReply } from "../domain/streamingReply";
import { mergeFragment, shouldSubmit } from "../domain/turnEnd";
import {
  monotonicNow, utcNow,
  type SpeechFinalResult,
  type VoiceRuntimeEvent,
  type VoiceRuntimeEventName,
  type VoiceTelemetrySink,
  type VoiceTurnRequest,
} from "../domain/voiceRuntime";
import type {
  SpeechInputEngine,
  SpeechOutputEngine,
  VoiceCaption,
  VoiceInputLanguage,
  VoicePhase,
} from "../services/voice/contracts";
import {
  createInputEngine, DEFAULT_VOICE_BACKEND, type ResolvedInputEngine, type VoiceBackendConfig,
} from "../services/voice/inputEngine";
import { createMicActivityMonitor, type MicActivityMonitor } from "../services/voice/micActivity";
import { createSpeechQueue, type SpeechQueue, type SpeechQueueDrainResult } from "../services/voice/speechQueue";
import { webSpeechOutput } from "../services/voice/webSpeechOutput";
import { createVoiceDiagnostics, type VoiceDiagnostics } from "../services/voice/voiceDiagnostics";

/**
 * VoicePresenter：语音页的展示层编排，与 React 无关。
 *
 * 它自建（可注入的）STT/TTS 队列与打断链路，暴露不可变快照给 `useSyncExternalStore`。
 * 「用户重新开口 → Runtime cancel + TTS stop → 继续接收 STT」这条链路在这里编排：
 * presenter 只负责 abort 本轮 VoiceTurnRequest 与停播，Runtime 的 cancel 由会话层
 * 挂在同一个 AbortSignal 上触发——三模块完整联动仍属 INT-02，不在本阶段启动真实服务。
 *
 * 本文件不得 import React。
 */

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

/**
 * 供 hooks/ 复用：Hook 只允许 import presentation 与 domain 的类型，不 import services。
 * 这里把语音相关的服务类型转出去，避免 Hook 直接依赖实现模块。
 */
export type { VoiceBackendConfig } from "../services/voice/inputEngine";
export { DEFAULT_VOICE_BACKEND } from "../services/voice/inputEngine";
export type { VoiceInputLanguage, VoicePhase, VoiceCaption } from "../services/voice/contracts";

export interface VoiceViewModel {
  isOpen: boolean;
  phase: VoicePhase;
  /** 已经识别出来、但这一轮还没结束的内容。用户看得见，也能改主意。 */
  pending: string;
  interim: string;
  error: string;
  captions: readonly VoiceCaption[];
  speakingCaptionId: number | null;
  speakingRange: CaptionRange | null;
  /** 聊天页里正在被朗读的那条消息；没有在朗读时为 null。 */
  speakingMessageId: string | null;
  backendNote: string;
  /**
   * 这一段实际按哪个语言识别（FE-13）。
   *
   * 露出来不是为了让人挑语言，而是因为单语言引擎进错语言之后会自锁：英文引擎听
   * 日语只会吐罗马字，罗马字又再次被判成英文。用户看不见它就永远不知道该动什么。
   */
  language: VoiceInputLanguage;
  /** 用户显式指定过语言吗。指定过就不再跟着历史推导，直到退出语音页。 */
  languagePinned: boolean;
  /** 输出链路当前状态（TTS-04）：选了什么、实际走哪条、为什么；degraded 要当错误显示。 */
  outputStatus: VoiceOutputStatus;
}

export interface VoicePresenter {
  getSnapshot(): VoiceViewModel;
  subscribe(listener: () => void): () => void;
  /** 每轮渲染更新回调；不重启任何引擎。 */
  configure(config: {
    onTranscript?: VoiceTurnHandler;
    resolveLanguage?: () => VoiceInputLanguage;
    telemetry?: VoiceTelemetrySink;
  }): void;
  setBackend(config: VoiceBackendConfig): void;
  /**
   * 显式指定识别语言，并立刻重开识别让它生效（FE-13）。
   *
   * 这是自锁状态唯一的出口：判定拿不到「这是另一种语言」的证据时，只有人能告诉它。
   * 指定只在本次语音页有效，退出即失效——默认路径仍然是自动跟随。
   */
  setLanguage(next: VoiceInputLanguage): void;
  open(): Promise<void>;
  close(): void;
  interruptAndListen(reason?: "barge-in" | "button", audioStartAt?: number): void;
  /**
   * 朗读聊天页里的一条消息。
   *
   * 与语音会话共用同一个输出队列与引擎——机器只有一套嗓子。所以会话开着时不接这个
   * 请求（说话权归会话），同一条再点一次则是停止。
   */
  speakMessage(messageId: string, text: string): void;
  /** 停止朗读。不影响语音会话自己的播放。 */
  stopSpeaking(): void;
  /**
   * 插一句短话（MVP-15 B：点击桌宠的回应）。
   *
   * 与朗读消息遵循同一套说话权规则：语音会话开着时不抢、正在念时不叠话。
   * 它**不建轮、不进聊天记录、不写记忆、不碰字幕**——只经同一个队列开口，
   * 因为机器只有一套嗓子。返回 `false` = 这次没开口（调用方据此计数，不重试）。
   */
  speakAside(text: string): boolean;
  /** 输出链路当前是否正在出声（含插话）。点击回应据此不叠话。 */
  isSpeaking(): boolean;
  /**
   * 应用新的语音输出配置（TTS-04）：停旧队列、按新配置重建引擎与队列。
   * 不发任何网络请求；实际生效链路与原因经 outputStatus 可见。
   */
  applyVoiceOutput(config: VoiceOutputConfig): void;
  sendNow(): void;
  clearPending(): void;
  diagnostics(): VoiceDiagnostics;
  exportDiagnostics(): string;
  dispose(): void;
}

export interface VoiceTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VoicePresenterDeps {
  /** Trace 记录器；不传等于不记。 */
  trace?: TraceRecorder;
  createInputEngine?: (config: VoiceBackendConfig) => Promise<ResolvedInputEngine>;
  createQueue?: (engine: SpeechOutputEngine) => SpeechQueue;
  outputEngine?: SpeechOutputEngine;
  /** 按配置重建输出引擎（TTS-04）；不探测、不发网络请求。 */
  resolveOutput?: (config: VoiceOutputConfig) => ResolvedOutputEngine;
  /** 启动时持久化的输出配置：装配层在首次 resolve 前应用，避免覆盖丢失。 */
  initialOutputConfig?: VoiceOutputConfig;
  createMonitor?: () => MicActivityMonitor;
  diagnostics?: VoiceDiagnostics;
  timers?: VoiceTimers;
}

const DEFAULT_TIMERS: VoiceTimers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createVoicePresenter(deps: VoicePresenterDeps = {}): VoicePresenter {
  const resolveInput = deps.createInputEngine ?? createInputEngine;
  let output: SpeechOutputEngine = deps.outputEngine ?? webSpeechOutput;
  let queue: SpeechQueue = (deps.createQueue ?? ((engine) => createSpeechQueue(engine)))(output);
  /** 输出世代：每次切引擎 +1；旧队列经 stop（TTS-02 语义）后迟到回调不再生效。 */
  let outputGeneration = 0;
  let outputStatus: VoiceOutputStatus = {
    selected: "system", actual: "system",
    note: "系统语音合成：语速能调，音色取决于 Windows 里装了哪些语音包。",
    degraded: false,
  };
  const monitor: MicActivityMonitor = (deps.createMonitor ?? createMicActivityMonitor)();
  const diagnostics: VoiceDiagnostics = deps.diagnostics ?? createVoiceDiagnostics();
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const trace = deps.trace ?? NO_TRACE;

  let disposed = false;

  let isOpen = false;
  let phase: VoicePhase = "idle";
  let pending = "";
  let interim = "";
  let error = "";
  let captions: VoiceCaption[] = [];
  let speakingCaptionId: number | null = null;
  let speakingRange: CaptionRange | null = null;
  /** 聊天页朗读：正在念哪条消息、原文是什么、高亮找到哪儿了。 */
  let speakingMessageId: string | null = null;
  let bubbleText = "";
  let bubbleFrom = 0;
  let backendNote = "";

  let input: SpeechInputEngine | null = null;
  let active = false;
  let busy = false;
  /** 用户此刻正在出声。本地管线没有中间结果，全靠引擎的 onSpeechStart 告诉我们。 */
  let speaking = false;
  let started = false;
  let pendingText = "";
  let lastVoiceAt = 0;
  let tickHandle: unknown = null;
  let captionId = 0;
  /** 这一轮字幕的最新全文。高亮要按它算下标，state 在回调里读到的是旧的那份。 */
  let captionText = "";
  /** 高亮的搜索起点，只往前走。重复出现的同一句话才不会亮回上一处。 */
  let highlightFrom = 0;
  /** 这一轮的编号。打断之后模型还会把回复送回来，靠它认出那是上一轮的。 */
  let turn = 0;
  /** 识别片段在真正提交前先挂到候选回合，埋点因此能从 segment 回溯到 turn。 */
  let draftTurn: number | null = null;
  let segmentTurn = new Map<string, number>();
  /** 每次 start 注册一组新的事件回调；旧 Web Speech onend/结果不能重启或污染新组。 */
  let inputEpoch = 0;
  /** ASR 结果在途时不能把已经识别的前半句提前提交。 */
  let pendingAsr = new Set<string>();
  /** 引擎应按序发送，但 Hook 也保留最后一道乱序闸门。 */
  let asrReorderer = createAsrSegmentReorderer<SpeechFinalResult>(null);
  /** 打断连续本地管线时，旧 in-flight ASR 按音频时间丢弃，新语音保留。 */
  let acceptAudioFrom: number | null = null;
  let turnRequest: (VoiceTurnRequest & { controller: AbortController }) | null = null;
  let lifecycle = 0;

  let backend: VoiceBackendConfig = DEFAULT_VOICE_BACKEND;
  let onTranscript: VoiceTurnHandler = async () => null;
  let resolveLanguage: () => VoiceInputLanguage = () => "ja-JP";
  /** 这一段实际用的语言。只有 startRecognition 写它，界面据此显示。 */
  let language: VoiceInputLanguage = "ja-JP";
  /** 用户点过语言之后，推导就让位。退出语音页时清掉。 */
  let languagePinned = false;
  let telemetry: VoiceTelemetrySink = () => undefined;

  let cached: VoiceViewModel | null = null;
  let dirty = true;
  let listeners = new Set<() => void>();

  // 启动即应用持久化配置（不发请求）：否则设置保存后重启会被默认 system 覆盖。
  if (deps.initialOutputConfig && deps.resolveOutput) {
    applyVoiceOutput(deps.initialOutputConfig);
  }

  function commit(): void {
    if (disposed) return;
    dirty = true;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 订阅者异常隔离。
      }
    }
  }

  function setPhase(next: VoicePhase): void {
    if (phase === next) return;
    phase = next;
    commit();
  }

  function setPendingText(text: string): void {
    pendingText = text;
    pending = text;
    commit();
  }

  function setInterimText(text: string): void {
    interim = text;
    commit();
  }

  function setError(next: string): void {
    error = next;
    commit();
  }

  function setCaptions(next: VoiceCaption[]): void {
    captions = next;
    commit();
  }

  function setSpeakingCaptionId(next: number | null): void {
    speakingCaptionId = next;
    commit();
  }

  function setSpeakingRange(next: CaptionRange | null): void {
    speakingRange = next;
    commit();
  }

  function setOpen(next: boolean): void {
    isOpen = next;
    commit();
  }

  /** 麦克风是不是一直开着。两条链路的调度方式不一样。 */
  function continuous(): boolean {
    return input?.continuous === true;
  }

  function emit(
    name: VoiceRuntimeEventName,
    options: Omit<VoiceRuntimeEvent, "name" | "atMonotonicMs" | "recordedAtUtc"> & {
      atMonotonicMs?: number;
    } = {},
  ): void {
    const event: VoiceRuntimeEvent = {
      ...options,
      name,
      atMonotonicMs: options.atMonotonicMs ?? monotonicNow(),
      recordedAtUtc: utcNow(),
    };
    diagnostics.sink(event);
    telemetry(event);
  }

  function turnForSegment(segmentId: string): number {
    const known = segmentTurn.get(segmentId);
    if (known !== undefined) return known;
    const candidate = draftTurn ?? turn + 1;
    segmentTurn.set(segmentId, candidate);
    return candidate;
  }

  function markVoice(atMonotonicMs = monotonicNow()): void {
    lastVoiceAt = atMonotonicMs;
  }

  function startRecognition(): void {
    if (!input || !active || busy) return;
    // 麦克风一直开着的引擎不需要反复启动，重复 start 反而会把缓冲区清掉。
    if (input.continuous && started) return;
    if (!interim) setError("");
    const epoch = ++inputEpoch;

    // 单段引擎的新会话不会补回旧 epoch 丢弃的序号。新结果从自身序号开始，
    // 否则 stop 的迟到 final 会让后续输入永远等一个不存在的片段。
    // 连续 Whisper 仍必须保留跨片段的乱序等待。
    if (!input.continuous) asrReorderer.reset(null);

    try {
      started = true;
      const next = languagePinned ? language : resolveLanguage();
      if (next !== language) {
        language = next;
        commit();
      }
      input.start(next, {
        onStart: () => {
          if (epoch !== inputEpoch) return;
          setPhase(phase === "thinking" || phase === "speaking" ? phase : "listening");
        },
        onSpeechStart: (event) => {
          if (epoch !== inputEpoch) return;
          handleSpeechStart(event);
        },
        onInterim: (text, atMonotonicMs) => {
          if (epoch !== inputEpoch) return;
          setError("");
          markVoice(atMonotonicMs ?? monotonicNow());
          setInterimText(text);
        },
        onSegmentEnd: (event) => {
          if (epoch !== inputEpoch) return;
          pendingAsr.add(event.segmentId);
          speaking = false;
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
          if (epoch !== inputEpoch) return;
          pendingAsr.delete(result.segmentId);
          emit("asrFinal", {
            turnId: turnForSegment(result.segmentId),
            segmentId: result.segmentId,
            timeSource: result.timeSource,
            details: {
              sequence: result.sequence,
              textLength: result.text.length,
              accepted: acceptAudioFrom === null || result.audioEndAt >= acceptAudioFrom,
            },
          });
          if (result.text.trim()) {
            setInterimText("");
            setError("");
          } else if (interim) {
            setError("这段语音未能确认，暂时保留识别文字。请重说这一段。");
          }
          for (const ordered of asrReorderer.push(result)) {
            const minAudioTime = acceptAudioFrom;
            if (minAudioTime !== null && ordered.audioEndAt < minAudioTime) continue;
            if (minAudioTime !== null) acceptAudioFrom = null;
            if (ordered.text.trim()) setPendingText(mergeFragment(pendingText, ordered.text));
          }
        },
        onError: (code, detail) => {
          if (epoch !== inputEpoch) return;
          handleRecognitionError(code, detail);
        },
        onEnd: () => {
          if (epoch !== inputEpoch) return;
          started = false;
          // 只有每段结束就自己停的引擎需要重启；本地管线的麦克风不关。
          if (!input!.continuous && active && !busy) {
            timers.setTimeout(startRecognition, 200);
          }
        },
      });
    } catch (startError) {
      started = false;
      if (epoch !== inputEpoch) return;
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
  function handleSpeechStart(event?: { audioStartAt: number; segmentId?: string }): void {
    const audioStartAt = event?.audioStartAt ?? monotonicNow();
    if (event?.segmentId) turnForSegment(event.segmentId);
    markVoice(audioStartAt);
    speaking = true;
    if (continuous() && (phase === "thinking" || phase === "speaking" || queue.isSpeaking())) {
      interruptAndListen("barge-in", audioStartAt);
      // interruptAndListen 清理旧轮状态；这次事件本身是新轮用户语音的开始。
      speaking = true;
      if (event?.segmentId) turnForSegment(event.segmentId);
    }
  }

  /** 一轮结束与否由 domain/turnEnd 判断，这里只按时问，不自己定规则。 */
  function tick(): void {
    if (!active || busy) return;
    if (interim) return;
    // 人还在出声就不要提交，哪怕文字部分暂时没有新内容进来。
    if (speaking) return;
    // VAD 已切段但 Whisper 还没返回时，不能把前一段误认为整轮已结束。
    if (pendingAsr.size > 0) return;
    const text = pendingText;
    if (!text.trim()) return;
    if (shouldSubmit(text, monotonicNow() - lastVoiceAt)) submitTurn();
  }

  function submitTurn(): void {
    const text = pendingText.trim();
    if (!text || busy || speaking || interim || pendingAsr.size > 0) return;

    const nextTurn = draftTurn ?? turn + 1;
    turn = Math.max(turn, nextTurn);
    draftTurn = null;
    const controller = new AbortController();
    const request: VoiceTurnRequest & { controller: AbortController } = {
      turnId: nextTurn,
      signal: controller.signal,
      controller,
      // 没有外部播放进度回采时，中断不能猜用户听到了多少；完整 drained
      // 的结果由 onPlaybackComplete 单独传给会话层。
      getPlaybackStatus: () => "unknown",
    };
    turnRequest = request;
    const current = () => turn === nextTurn && !controller.signal.aborted;

    setPendingText("");
    setInterimText("");
    busy = true;
    setPhase("thinking");
    clearHighlight();
    emit("turnCommitted", {
      turnId: nextTurn,
      details: { textLength: text.length },
    });
    // 麦克风一直开着的链路不停收音：这样她说话时用户开口才有东西可听。
    if (!continuous()) {
      // Web Speech 的 stop/onend 可能把旧 final 迟到送回来；提交后这一组
      // 结果不属于下一轮，先换 epoch 再停引擎。
      inputEpoch += 1;
      input?.stop();
      started = false;
    }
    appendCaption("user", text);

    // 边收边念：句子一确定就入队，不等整段文本生成完。
    const emitter = createSentenceEmitter();
    let caption: number | null = null;

    queue.begin({
      turnId: nextTurn,
      onStart: () => {
        if (!current()) return;
        setPhase("speaking");
        setSpeakingCaptionId(caption);
        emit("firstAudio", {
          turnId: nextTurn,
          details: { source: "engine-onStart" },
        });
      },
      // 念到哪一句就把字幕亮到哪一句。找不到就不亮，宁可没有高亮也不能亮错位置。
      onSentence: (_index, sentence) => {
        if (!current()) return;
        const range = locateSentence(captionText, sentence, highlightFrom);
        if (range) highlightFrom = range.end;
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

    void onTranscript(text, (partial) => {
      if (!current()) return;
      // mood 在 JSON 最前面，通常比第一句正文先到——第一句因此就能用上这轮的语气。
      queue.setMood(partial.mood);
      if (!partial.japaneseText) return;
      if (!firstTextReported) {
        firstTextReported = true;
        emit("firstText", { turnId: nextTurn });
      }
      caption = upsertAssistantCaption(caption, partial.japaneseText, partial.chineseTranslation);
      queue.enqueue(emitter.push(partial.japaneseText, false));
    }, request).then((reply) => {
      if (!current()) return;

      const spoken = reply ? replyDisplayText(reply) : "";
      if (!reply || !spoken) {
        queue.stop();
        busy = false;
        setPhase("error");
        setError("模型没有返回回复，请退出语音后查看聊天页里的具体错误。");
        return;
      }

      replyAccepted = true;
      if (!firstTextReported && spoken) {
        firstTextReported = true;
        emit("firstText", { turnId: nextTurn });
      }
      queue.setMood(reply.mood);
      caption = upsertAssistantCaption(caption, spoken, reply.chineseTranslation);
      queue.enqueue(emitter.push(spoken, true));
      queue.end();
    }).catch((caught) => {
      if (!current()) return;
      queue.stop();
      busy = false;
      setPhase("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (!replyAccepted && turnRequest?.turnId === nextTurn) turnRequest = null;
    });
  }

  function finishSpeaking(result: SpeechQueueDrainResult): void {
    monitor.stop();
    const request = turnRequest;
    // 只有会话轮才有 Runtime 的轮次 uuid。聊天页点朗读（FE-07）不属于任何一轮，
    // 那时 runtimeTurnId 是 undefined——不记，而不是编一个 id 把它挂上去。
    if (request?.runtimeTurnId) {
      trace.record(request.runtimeTurnId, {
        kind: "tts",
        sentences: result.sentenceCount,
        played: result.played,
        errorCount: result.errorCount,
      });
    }
    if (request && !request.signal.aborted) {
      if (result.played) {
        request.onPlaybackComplete?.();
      } else {
        request.onPlaybackFailed?.(`所有语音句子都播放失败（${result.errorCount}/${result.sentenceCount}）`);
      }
    }
    turnRequest = null;
    clearHighlight();
    setSpeakingCaptionId(null);
    busy = false;
    markVoice();
    if (!active) return;
    if (!result.played) {
      setPhase("error");
      setError("语音播放失败，但文字回复仍已保留；可以重试或切换输出设备。");
      return;
    }
    setPhase("listening");
    startRecognition();
  }

  /**
   * 播放期间保持监听。
   * 本地管线的麦克风本来就没关，VAD 就是打断信号，不需要另开一路能量监听。
   */
  async function watchForBargeIn(): Promise<void> {
    if (continuous()) return;
    try {
      await monitor.start(({ atMonotonicMs }) => {
        if (active) interruptAndListen("barge-in", atMonotonicMs);
      });
    } catch {
      // 没有麦克风权限或音频接口时，打断按钮仍然可用。
    }
  }

  /** 一轮说完、被打断或退出时都要清掉，否则上一轮的高亮会留在屏幕上。 */
  function clearHighlight(): void {
    captionText = "";
    highlightFrom = 0;
    setSpeakingRange(null);
  }

  /** 聊天页朗读的状态清理。语音会话的字幕状态不在这里动。 */
  function clearBubblePlayback(): void {
    speakingMessageId = null;
    bubbleText = "";
    bubbleFrom = 0;
    setSpeakingRange(null);
  }

  function speakMessage(messageId: string, text: string): void {
    if (disposed) return;
    // 会话开着时说话权归会话：这里入队会 begin 掉正在播的那一轮，
    // 让那一轮的交付回执永远等不到，只能靠超时兜底。
    if (isOpen) return;
    // 同一条再点一次，用户的意思只可能是「别念了」，不是重头再念一遍。
    if (speakingMessageId === messageId) {
      stopSpeaking();
      return;
    }
    const sentences = splitIntoSentences(text ?? "");
    if (!sentences.length) return;

    bubbleText = text;
    bubbleFrom = 0;
    speakingMessageId = messageId;
    setSpeakingRange(null);
    queue.speak(sentences, {
      // 念到哪句就亮到哪句；找不到范围就不亮，宁可没有高亮也不能亮错位置。
      onSentence: (_index, sentence) => {
        if (speakingMessageId !== messageId) return;
        const range = locateSentence(bubbleText, sentence, bubbleFrom);
        if (range) bubbleFrom = range.end;
        setSpeakingRange(range);
      },
      onDrained: () => {
        if (speakingMessageId === messageId) clearBubblePlayback();
      },
      // 单句失败不打断整段：队列会继续念下一句，但得让用户看见。
      onError: (message) => {
        if (speakingMessageId === messageId) setError(`语音播放失败：${message}`);
      },
    });
  }

  function applyVoiceOutput(config: VoiceOutputConfig): void {
    if (disposed) return;
    // 切引擎先停旧队列：旧回调被 TTS-02 的 stop 语义挡住，不会覆盖新轮；
    // 点朗读的高亮状态随之清空，新队列只服务之后的轮次。
    queue.stop();
    clearBubblePlayback();
    outputGeneration += 1;
    const resolved = deps.resolveOutput?.(config)
      ?? { engine: output, actual: "system" as const, note: "系统语音合成：语速能调，音色取决于 Windows 里装了哪些语音包。", degraded: false };
    output = resolved.engine;
    queue = (deps.createQueue ?? ((engine) => createSpeechQueue(engine)))(output);
    outputStatus = {
      selected: config.output,
      actual: resolved.actual,
      note: resolved.note,
      degraded: resolved.degraded,
    };
    commit();
  }

  function stopSpeaking(): void {
    if (!speakingMessageId) return;
    queue.stop();
    clearBubblePlayback();
  }

  /**
   * 插一句短话：只开口，不认领字幕、不设 speakingMessageId。
   *
   * 三条拒绝理由各自对应一个已存在的边界，不是新造规则：
   * 已 dispose、语音会话占着说话权、队列正在出声（不叠话）。
   */
  function speakAside(text: string): boolean {
    if (disposed) return false;
    if (isOpen) return false;
    if (queue.isSpeaking()) return false;
    const sentences = splitIntoSentences(text ?? "");
    if (!sentences.length) return false;
    queue.speak(sentences);
    return true;
  }

  function isSpeaking(): boolean {
    return queue.isSpeaking();
  }

  function appendCaption(speaker: VoiceCaption["speaker"], text: string, translation?: string): number {
    captionId += 1;
    const caption: VoiceCaption = { id: captionId, speaker, text, translation };
    setCaptions([...captions, caption].slice(-10));
    return caption.id;
  }

  /** 流式字幕：第一段到了才建卡片，之后原地长出来，不要每次都新加一条。 */
  function upsertAssistantCaption(id: number | null, text: string, translation?: string): number {
    captionText = text;
    if (id === null) return appendCaption("assistant", text, translation);
    setCaptions(captions.map((caption) => (
      caption.id === id ? { ...caption, text, translation: translation || caption.translation } : caption
    )));
    return id;
  }

  function handleRecognitionError(code: string, detail?: string): void {
    if (code === "aborted" || code === "no-speech") return;
    speaking = false;
    // 单段转写失败不该让整个语音页停摆，下一段还会继续。
    if (code === "transcription-failed") {
      setError(detail ? `${recognitionErrors[code]}（${detail}）` : recognitionErrors[code]);
      return;
    }
    pendingAsr.clear();
    busy = false;
    setPhase("error");
    setError(recognitionErrors[code] ?? detail ?? `语音识别错误：${code}`);
  }

  function releaseEngines(): void {
    lifecycle += 1;
    active = false;
    inputEpoch += 1;
    turnRequest?.controller.abort();
    turnRequest = null;
    pendingAsr.clear();
    asrReorderer.reset(null);
    draftTurn = null;
    segmentTurn.clear();
    if (tickHandle !== null) timers.clearInterval(tickHandle);
    tickHandle = null;
    input?.abort();
    input?.dispose();
    input = null;
    queue.stop();
    void monitor.dispose();
  }

  async function open(): Promise<void> {
    const session = ++lifecycle;
    active = false;
    turnRequest?.controller.abort();
    turnRequest = null;
    pendingAsr.clear();
    asrReorderer.reset(0);
    draftTurn = null;
    segmentTurn.clear();
    acceptAudioFrom = null;
    inputEpoch += 1;
    setOpen(true);
    setPendingText("");
    setInterimText("");
    setError("");
    setCaptions([]);
    setSpeakingCaptionId(null);
    clearHighlight();
    setPhase("idle");

    // 每次进语音页都重新选一次链路：本地服务可能刚开起来，也可能刚关掉。
    input?.dispose();
    input = null;
    started = false;
    const resolved = await resolveInput(backend);
    if (session !== lifecycle || disposed) {
      void resolved.engine.dispose();
      return;
    }
    input = resolved.engine;
    backendNote = resolved.note;
    commit();
    if (resolved.degraded) setError(resolved.note);

    if (!resolved.engine.isAvailable()) {
      setPhase("error");
      setError("当前 WebView 没有提供可用的语音输入接口。");
      return;
    }

    try {
      await resolved.engine.requestPermission();
      if (session !== lifecycle || disposed) {
        void resolved.engine.dispose();
        return;
      }
      active = true;
      busy = false;
      speaking = false;
      markVoice();
      if (tickHandle !== null) timers.clearInterval(tickHandle);
      tickHandle = timers.setInterval(tick, TURN_TICK_MS);
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
  function interruptAndListen(reason: "barge-in" | "button" = "button", audioStartAt?: number): void {
    const wasSpeaking = phase === "speaking" || queue.isSpeaking();
    const interruptedTurnId = turnRequest?.turnId;
    emit("interruptDetected", {
      turnId: interruptedTurnId,
      details: { reason },
    });
    turnRequest?.controller.abort();
    turnRequest = null;
    turn += 1;
    queue.stop();
    monitor.stop();
    setSpeakingCaptionId(null);
    clearHighlight();
    busy = false;
    active = true;
    speaking = false;
    pendingAsr.clear();
    asrReorderer.reset(null);
    acceptAudioFrom = audioStartAt ?? monotonicNow();
    setPendingText("");
    setInterimText("");
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
    inputEpoch += 1;
    input?.abort();
    started = false;
    timers.setTimeout(startRecognition, 160);
  }

  /** 不等尾静音，现在就发。缓冲区里的内容用户已经看见了，他说发就发。 */
  function sendNow(): void {
    if (phase === "speaking") {
      interruptAndListen("button");
      return;
    }
    submitTurn();
  }

  /** 识别错了就清掉，不要逼用户把错的那句发出去。 */
  function clearPending(): void {
    setPendingText("");
    setInterimText("");
    markVoice();
  }

  /**
   * 用户点了语言（FE-13）。
   *
   * 立刻重开识别，不等下一段自然结束：用户点它的时候正卡在错的语言上，
   * 让他再说一句废话去触发切换没有道理。
   */
  function setLanguage(next: VoiceInputLanguage): void {
    languagePinned = true;
    if (next === language && started) return;
    language = next;
    setError("");
    commit();
    if (!active || !input) return;
    // 麦克风一直开着的链路自己判语言，重开只会白丢掉缓冲区里的音频。
    if (continuous()) return;
    inputEpoch += 1;
    input.abort();
    started = false;
    timers.setTimeout(startRecognition, 160);
  }

  function close(): void {
    const wasSpeaking = phase === "speaking" || queue.isSpeaking();
    const interruptedTurnId = turnRequest?.turnId;
    lifecycle += 1;
    turnRequest?.controller.abort();
    turnRequest = null;
    turn += 1;
    inputEpoch += 1;
    active = false;
    busy = false;
    speaking = false;
    started = false;
    pendingAsr.clear();
    asrReorderer.reset(null);
    draftTurn = null;
    segmentTurn.clear();
    acceptAudioFrom = null;
    if (tickHandle !== null) timers.clearInterval(tickHandle);
    tickHandle = null;
    input?.abort();
    input?.dispose();
    input = null;
    queue.stop();
    if (wasSpeaking) {
      emit("playbackStopped", {
        turnId: interruptedTurnId,
        details: { reason: "close", status: "stopRequested", precision: "proxy" },
      });
    }
    monitor.stop();
    void monitor.dispose();
    setPendingText("");
    setInterimText("");
    setSpeakingCaptionId(null);
    clearHighlight();
    setPhase("idle");
    // 指定只在本次语音页有效：下次进来仍然自动跟随，不把一次临时纠正变成永久设置。
    languagePinned = false;
    setOpen(false);
  }

  function getSnapshot(): VoiceViewModel {
    if (!cached || dirty) {
      cached = Object.freeze({
        isOpen,
        phase,
        pending,
        interim,
        error,
        captions,
        speakingCaptionId,
        speakingRange,
        speakingMessageId,
        backendNote,
        language,
        languagePinned,
        outputStatus,
      });
      dirty = false;
    }
    return cached;
  }

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure(config) {
      if (config.onTranscript) onTranscript = config.onTranscript;
      if (config.resolveLanguage) resolveLanguage = config.resolveLanguage;
      if (config.telemetry) telemetry = config.telemetry;
    },
    setBackend(config) {
      backend = config;
    },
    setLanguage,
    open,
    close,
    speakMessage,
    stopSpeaking,
    speakAside,
    isSpeaking,
    applyVoiceOutput,
    interruptAndListen,
    sendNow,
    clearPending,
    diagnostics: () => diagnostics,
    exportDiagnostics: () => diagnostics.exportJson(),
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseEngines();
      listeners = new Set();
    },
  };
}
