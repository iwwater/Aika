import { useEffect, useRef } from "react";
import { CornerDownLeft, Eraser, LoaderCircle, Mic, X } from "lucide-react";
import type { VoiceCaption, VoicePhase } from "../services/voice/contracts";

interface VoiceModalProps {
  phase: VoicePhase;
  /** 已经听到、但这一轮还没结束的内容。看得见才谈得上「取消误判」。 */
  pending: string;
  interim: string;
  error: string;
  captions: VoiceCaption[];
  speakingCaptionId: number | null;
  /** 这一轮实际走的识别链路。退回系统识别不能是隐形的。 */
  backendNote: string;
  onInterrupt(): void;
  onSendNow(): void;
  onClearPending(): void;
  onClose(): void;
}

export function VoiceModal(props: VoiceModalProps) {
  const subtitleEndRef = useRef<HTMLDivElement>(null);
  const title = props.phase === "listening" ? "我在听…"
    : props.phase === "thinking" ? "正在想…"
      : props.phase === "speaking" ? "正在说话"
        : props.phase === "error" ? "语音暂时不可用"
          : "准备开始";

  const waiting = Boolean(props.pending) && props.phase === "listening";

  useEffect(() => {
    subtitleEndRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.captions, props.pending, props.interim, props.error]);

  return (
    <div className="voice-backdrop">
      <section className={`voice-modal phase-${props.phase}`} role="dialog" aria-modal="true" aria-label="实时语音对话">
        <button className="voice-close icon-button" onClick={props.onClose} title="退出语音"><X size={22} /></button>
        <div className="voice-avatar-wrap">
          <div className="voice-wave wave-one" /><div className="voice-wave wave-two" /><div className="voice-wave wave-three" />
          <div className="voice-avatar">愛</div>
        </div>
        <p className="voice-kicker">REALTIME TALK</p>
        <h2>{title}</h2>
        <div className="voice-subtitles" aria-live="polite" aria-label="实时对话字幕">
          {!props.captions.length && !props.pending && !props.interim && !props.error && (
            <div className="voice-subtitle-empty">直接说话就行，日语、中文、英语，混着说也可以</div>
          )}
          {props.captions.map((caption) => (
            <div
              key={caption.id}
              className={`voice-caption ${caption.speaker} ${props.speakingCaptionId === caption.id ? "speaking" : ""}`}
            >
              <span>{caption.speaker === "user" ? "你" : "愛花"}</span>
              <p>{caption.text}</p>
              {caption.translation && <p className="voice-caption-translation">{caption.translation}</p>}
            </div>
          ))}
          {(props.pending || props.interim) && (
            <div className="voice-caption user interim">
              <span>你 · {props.interim ? "识别中" : "说完了就发"}</span>
              <p>{props.pending}{props.pending && props.interim ? " " : ""}{props.interim}</p>
            </div>
          )}
          {props.error && <div className="voice-caption-error">{props.error}</div>}
          <div ref={subtitleEndRef} />
        </div>

        {waiting && (
          <div className="voice-pending-actions">
            <button type="button" onClick={props.onSendNow}><CornerDownLeft size={13} />现在就发</button>
            <button type="button" className="ghost" onClick={props.onClearPending}><Eraser size={13} />听错了，清掉</button>
          </div>
        )}

        <button
          className={`voice-main-button ${props.phase}`}
          onClick={props.phase === "speaking" ? props.onInterrupt : props.onSendNow}
          disabled={props.phase === "thinking" || (props.phase === "listening" && !props.pending)}
          title={props.phase === "speaking" ? "打断她" : "现在就发出去"}
        >
          {props.phase === "thinking" ? <LoaderCircle size={27} className="spin" /> : <Mic size={27} />}
        </button>
        <p className="voice-hint">
          {props.phase === "speaking" ? "直接开口就能打断她，也可以点这里"
            : waiting ? "停顿一下没关系，说完她才会接话"
              : props.phase === "error" ? "可退出后继续使用文字聊天"
                : "对话结束后会自动继续聆听"}
        </p>
        <p className="voice-privacy">{props.backendNote || "正在选择识别链路…"}<br />个性化声线将通过同一接口接入。</p>
      </section>
    </div>
  );
}
