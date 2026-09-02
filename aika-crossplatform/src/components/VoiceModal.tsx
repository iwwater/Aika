import { useEffect, useRef } from "react";
import { LoaderCircle, Mic, X } from "lucide-react";
import type { VoiceCaption, VoiceInputLanguage, VoicePhase } from "../services/voice/contracts";

interface VoiceModalProps {
  phase: VoicePhase;
  interim: string;
  error: string;
  captions: VoiceCaption[];
  speakingCaptionId: number | null;
  language: VoiceInputLanguage;
  onLanguageChange(language: VoiceInputLanguage): void;
  onInterrupt(): void;
  onClose(): void;
}

export function VoiceModal(props: VoiceModalProps) {
  const subtitleEndRef = useRef<HTMLDivElement>(null);
  const title = props.phase === "listening" ? "我在听…"
    : props.phase === "thinking" ? "正在想…"
      : props.phase === "speaking" ? "正在说话"
        : props.phase === "error" ? "语音暂时不可用"
          : "准备开始";

  useEffect(() => {
    subtitleEndRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.captions, props.interim, props.error]);

  return (
    <div className="voice-backdrop">
      <section className={`voice-modal phase-${props.phase}`} role="dialog" aria-modal="true" aria-label="实时语音对话">
        <button className="voice-close icon-button" onClick={props.onClose} title="退出语音"><X size={22} /></button>
        <div className="voice-avatar-wrap">
          <div className="voice-wave wave-one" /><div className="voice-wave wave-two" /><div className="voice-wave wave-three" />
          <div className="voice-avatar">愛</div>
        </div>
        <p className="voice-kicker">REALTIME TALK</p>
        <div className="voice-language" aria-label="语音输入语言">
          <button className={props.language === "ja-JP" ? "active" : ""} onClick={() => props.onLanguageChange("ja-JP")}>日语</button>
          <button className={props.language === "zh-CN" ? "active" : ""} onClick={() => props.onLanguageChange("zh-CN")}>中文</button>
        </div>
        <h2>{title}</h2>
        <div className="voice-subtitles" aria-live="polite" aria-label="实时对话字幕">
          {!props.captions.length && !props.interim && !props.error && (
            <div className="voice-subtitle-empty">直接说话，识别和回复会显示在这里</div>
          )}
          {props.captions.map((caption) => (
            <div
              key={caption.id}
              className={`voice-caption ${caption.speaker} ${props.speakingCaptionId === caption.id ? "speaking" : ""}`}
            >
              <span>{caption.speaker === "user" ? "你" : "愛花"}</span>
              <p>{caption.text}</p>
            </div>
          ))}
          {props.interim && (
            <div className="voice-caption user interim"><span>你 · 识别中</span><p>{props.interim}</p></div>
          )}
          {props.error && <div className="voice-caption-error">{props.error}</div>}
          <div ref={subtitleEndRef} />
        </div>
        <button className={`voice-main-button ${props.phase}`} onClick={props.onInterrupt} disabled={props.phase === "thinking"}>
          {props.phase === "thinking" ? <LoaderCircle size={27} className="spin" /> : <Mic size={27} />}
        </button>
        <p className="voice-hint">{props.phase === "speaking" ? "点击麦克风可以打断她" : props.phase === "error" ? "可退出后继续使用文字聊天" : "对话结束后会自动继续聆听"}</p>
        <p className="voice-privacy">当前使用临时系统语音适配器；本地 Whisper 和个性化声线将通过同一接口接入。</p>
      </section>
    </div>
  );
}
