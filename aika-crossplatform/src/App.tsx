import { FormEvent, useCallback, useRef, useState } from "react";
import {
  Bell, BellOff, Bot, Check, ChevronDown, KeyRound, Languages, LoaderCircle, MessageCircleMore,
  Mic, PanelRightClose, SendHorizontal, Settings2, Sparkles, Trash2, Volume2, X,
} from "lucide-react";
import "./App.css";
import { AvatarPlaceholder } from "./components/AvatarPlaceholder";
import { MessageSticker } from "./components/MessageSticker";
import { VoiceModal } from "./components/VoiceModal";
import { DEFAULT_CHARACTER } from "./domain/character";
import { preferredRecognitionLanguage } from "./domain/language";
import { PROVIDER_PRESETS, validateProvider, type ProviderConfig } from "./domain/providers";
import { useCompanionSession } from "./hooks/useCompanionSession";
import { useVoiceConversation, type VoiceTurnHandler } from "./hooks/useVoiceConversation";
import { testProvider } from "./services/providerClient";
import type { VoiceBackend } from "./services/voice/inputEngine";
import { createWhisperClient } from "./services/voice/whisperClient";

const QUICK_STARTS = ["今天发生了一件小事…", "有点累，想随便聊聊", "刚才想到你说过的那件事"];

function App() {
  const session = useCompanionSession();
  const [draftProvider, setDraftProvider] = useState<ProviderConfig>(PROVIDER_PRESETS[1]);
  const [input, setInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTranslation, setShowTranslation] = useState(true);
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "ok" | "error"; text: string }>({ kind: "idle", text: "" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [whisperStatus, setWhisperStatus] = useState<"idle" | "checking" | "ok" | "down">("idle");
  const [whisperNote, setWhisperNote] = useState("");

  const { connected, sending, provider, messages, memories, relationship, proactive } = session;

  const sendVoice = useCallback<VoiceTurnHandler>(
    (text, onPartial) => session.send(text, "voice", onPartial),
    [session],
  );
  // 识别语言跟着用户最近说的话走，不再让用户在「日语 / 中文」之间选。
  const resolveLanguage = useCallback(
    () => preferredRecognitionLanguage(
      messages.filter((message) => message.role === "user").slice(-4).map((message) => message.content),
    ),
    [messages],
  );
  const voice = useVoiceConversation(sendVoice, resolveLanguage, session.voiceBackend);

  async function handleProbeWhisper() {
    setWhisperStatus("checking");
    setWhisperNote("正在连接…");
    const alive = await createWhisperClient(() => session.voiceBackend.whisperEndpoint).probe();
    setWhisperStatus(alive ? "ok" : "down");
    setWhisperNote(alive
      ? "本地识别服务在线，进入语音就会用它。"
      : `连不上 ${session.voiceBackend.whisperEndpoint}。先启动 whisper-server，或把链路切到系统语音识别。`);
  }

  function openSettings() {
    setDraftProvider(provider);
    setStatus({ kind: "idle", text: "" });
    setShowSettings(true);
  }

  function choosePreset(id: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setDraftProvider({ ...preset, apiKey: preset.id === provider.id ? provider.apiKey : "" });
    setStatus({ kind: "idle", text: "" });
  }

  async function handleTest() {
    const validation = validateProvider(draftProvider);
    if (validation) return setStatus({ kind: "error", text: validation });
    setStatus({ kind: "testing", text: "正在连接…" });
    try {
      setStatus({ kind: "ok", text: await testProvider(draftProvider) });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleSave() {
    const validation = validateProvider(draftProvider);
    if (validation) return setStatus({ kind: "error", text: validation });
    const preset = PROVIDER_PRESETS.find((item) => item.id === draftProvider.id);
    await session.setProvider({
      ...draftProvider,
      protocol: preset && preset.id !== "custom" ? preset.protocol : draftProvider.protocol,
      baseUrl: draftProvider.baseUrl.trim(),
      model: draftProvider.model.trim(),
    });
    setStatus({ kind: "ok", text: "配置已保存，现在可以直接聊天" });
    setTimeout(() => setShowSettings(false), 450);
  }

  async function submit(content: string) {
    if (!content) return;
    if (!connected) {
      openSettings();
      setStatus({ kind: "error", text: "请先完成 API 配置" });
      return;
    }
    setInput("");
    await session.send(content);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function handleSend(event?: FormEvent) {
    event?.preventDefault();
    await submit(input.trim());
  }

  function openVoice() {
    if (!connected) {
      openSettings();
      setStatus({ kind: "error", text: "请先完成 API 配置，再进入实时语音" });
      return;
    }
    void voice.open();
  }

  const pendingMemories = memories.filter((memory) => memory.status === "pending");

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand"><span className="brand-mark"><Sparkles size={17} /></span><span>{DEFAULT_CHARACTER.name}</span><span className="brand-subtitle">Aika</span></div>
        <div className="titlebar-actions">
          <button className="icon-button" title="设置" onClick={openSettings}><Settings2 size={18} /></button>
          <button className="icon-button sidebar-toggle" title="切换侧栏" onClick={() => setShowSidebar((value) => !value)}><PanelRightClose size={18} /></button>
        </div>
      </header>

      <section className={`workspace ${showSidebar ? "" : "sidebar-hidden"}`}>
        <aside className="companion-panel">
          <div className="ambient ambient-one" /><div className="ambient ambient-two" />
          <div className="avatar-stage">
            <div className="avatar-halo" />
            <div className="avatar-portrait"><AvatarPlaceholder /><span className="avatar-spark avatar-spark-one">✦</span><span className="avatar-spark avatar-spark-two">✧</span></div>
            <div className="companion-name">{DEFAULT_CHARACTER.name} <span>{DEFAULT_CHARACTER.reading}</span></div>
            <p className="mood">“{DEFAULT_CHARACTER.moodLine}”</p>
            <div className="presence"><span /> {proactive.enabled ? "在线 · 想起你时会先开口" : "在线 · 想和你聊聊天"}</div>
          </div>
          <div className="scene-note"><Sparkles size={16} /><div><strong>个性化角色包</strong><span>后续可导入 Live2D 与自训练声线</span></div></div>
        </aside>

        <section className="chat-panel">
          <div className="chat-heading">
            <div><p className="eyebrow">日常会话</p><h1>和{DEFAULT_CHARACTER.name}聊天</h1></div>
            <button className={`translation-toggle ${showTranslation ? "active" : ""}`} onClick={() => setShowTranslation((v) => !v)}><Languages size={17} /> 中文字幕 <span>{showTranslation ? "开" : "关"}</span></button>
          </div>

          {session.storageError && (
            <div className="storage-error" role="alert">
              本地存储打不开，这次的对话和记忆不会被保存：{session.storageError}
            </div>
          )}

          <div className="messages" aria-live="polite">
            <div className="day-divider"><span>{session.ready ? "今天" : "正在打开记忆…"}</span></div>
            {messages.map((message) => (
              <article key={message.id} className={`message-row ${message.role} ${message.error ? "error" : ""}`}>
                {message.role === "assistant" && <div className="mini-avatar">{DEFAULT_CHARACTER.name.slice(0, 1)}</div>}
                <div className="message-wrap">
                  <div className="message-meta">
                    {message.role === "assistant" ? DEFAULT_CHARACTER.name : "你"} · {message.time}
                    {message.source === "proactive" && <span className="meta-tag">主动</span>}
                  </div>
                  <div className="message-bubble">
                    {/* 流式：字一开始长出来就不再显示三个点 */}
                    {message.pending && !message.content ? <span className="typing"><i /><i /><i /></span> : (
                      <>
                        {(message.japaneseText ?? message.content).split("\n").map((line, index) => (
                          <span key={`${message.id}-${index}`}>{line}</span>
                        ))}
                        {showTranslation && message.chineseTranslation && (
                          <span className="translation">{message.chineseTranslation}</span>
                        )}
                        <MessageSticker id={message.sticker} stickers={session.stickers} />
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>

          <form className="composer" onSubmit={handleSend}>
            <div className="composer-topline"><span>日语、中文、英语都可以</span><span className="shortcut">Enter 发送 · Shift+Enter 换行</span></div>
            <div className="composer-box">
              <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); handleSend(); }
              }} placeholder="今日はちょっと疲れた… / 今天有点累 / I had a long day" rows={2} />
              <button type="button" className="composer-icon voice-entry" title="进入实时语音" onClick={openVoice}><Mic size={19} /></button>
              <button type="submit" className="send-button" disabled={!input.trim() || sending}>{sending ? <LoaderCircle size={19} className="spin" /> : <SendHorizontal size={19} />}</button>
            </div>
          </form>
        </section>

        <aside className="right-sidebar">
          <section className="side-card provider-card">
            <div className="side-card-title"><span><Bot size={17} /> 当前模型</span><button onClick={openSettings}>配置</button></div>
            <div className="provider-status"><div className="provider-logo">{provider.name.slice(0, 1)}</div><div><strong>{provider.name}</strong><span>{provider.model || "尚未配置模型"}</span></div><i className={connected ? "connected" : ""} /></div>
          </section>

          <section className="side-card">
            <div className="side-card-title"><span><Sparkles size={17} /> 相处状态</span></div>
            <div className="memory-list">
              <div className="memory-item"><span>01</span><p><strong>相识</strong>{relationship.daysKnown} 天</p></div>
              <div className="memory-item"><span>02</span><p><strong>连续互动</strong>{relationship.consecutiveActiveDays} 天</p></div>
              <div className="memory-item"><span>03</span><p><strong>聊过</strong>{relationship.totalMessageCount} 条消息</p></div>
            </div>
          </section>

          <section className="side-card">
            <div className="side-card-title">
              <span><MessageCircleMore size={17} /> 长期记忆</span>
              {pendingMemories.length > 0 && <span className="pill">{pendingMemories.length} 条待确认</span>}
            </div>
            <div className="memory-list">
              {memories.length === 0 && (
                <div className="memory-item muted"><span>—</span><p><strong>还没有记忆</strong>聊过之后会自动记下，你可以随时删</p></div>
              )}
              {[...memories].reverse().slice(0, 12).map((memory) => (
                <div key={memory.id} className={`memory-item editable ${memory.status}`}>
                  <span>{memory.category}</span>
                  <p>{memory.content}</p>
                  <div className="memory-actions">
                    {memory.status === "pending" && (
                      <button title="保留这条记忆" onClick={() => void session.confirmMemory(memory.id)}><Check size={13} /></button>
                    )}
                    <button title="删除这条记忆" onClick={() => void session.deleteMemory(memory.id)}><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="side-card quick-card">
            <div className="side-card-title"><span><Sparkles size={17} /> 快速开始</span></div>
            {QUICK_STARTS.map((text) => <button key={text} onClick={() => { setInput(text); inputRef.current?.focus(); }}>{text}</button>)}
          </section>

          <button className="voice-coming" onClick={openVoice}><Volume2 size={17} /><span><strong>实时语音</strong>点击进入连续对话</span></button>
        </aside>
      </section>

      {voice.isOpen && (
        <VoiceModal
          phase={voice.phase}
          pending={voice.pending}
          interim={voice.interim}
          error={voice.error}
          captions={voice.captions}
          speakingCaptionId={voice.speakingCaptionId}
          speakingRange={voice.speakingRange}
          backendNote={voice.backendNote}
          onInterrupt={voice.interruptAndListen}
          onSendNow={voice.sendNow}
          onClearPending={voice.clearPending}
          onClose={voice.close}
        />
      )}

      {showSettings && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowSettings(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-heading"><div><p className="eyebrow">Model Link</p><h2 id="settings-title">连接你的模型</h2></div><button className="icon-button" onClick={() => setShowSettings(false)}><X size={20} /></button></div>
            <p className="modal-intro">选择平台、填写 Key 并测试。请求由你的电脑直接发往模型平台，不经过额外服务器。</p>
            <label className="field-label">平台</label>
            <div className="select-wrap"><select value={draftProvider.id} onChange={(event) => choosePreset(event.target.value)}>{PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={17} /></div>
            <div className="form-grid">
              <label className="field wide"><span>API 地址</span><input value={draftProvider.baseUrl} onChange={(e) => setDraftProvider({ ...draftProvider, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
              <label className="field"><span>协议</span><select value={draftProvider.protocol} disabled={draftProvider.id !== "custom"} onChange={(e) => setDraftProvider({ ...draftProvider, protocol: e.target.value as ProviderConfig["protocol"] })}><option value="openai-responses">OpenAI Responses</option><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option></select></label>
              <label className="field"><span>模型名称</span><input value={draftProvider.model} onChange={(e) => setDraftProvider({ ...draftProvider, model: e.target.value })} placeholder="模型 ID" /></label>
              <label className="field wide"><span>API Key</span><div className="key-input"><KeyRound size={17} /><input type="password" value={draftProvider.apiKey} onChange={(e) => setDraftProvider({ ...draftProvider, apiKey: e.target.value })} placeholder="sk-…" /></div></label>
            </div>
            {status.text && <div className={`test-result ${status.kind}`}>{status.kind === "testing" ? <LoaderCircle size={17} className="spin" /> : status.kind === "ok" ? <Check size={17} /> : <X size={17} />}<span>{status.text}</span></div>}
            <div className="security-note">
              <KeyRound size={16} />
              <span>{session.keyIsSecure
                ? "API Key 存在 Windows DPAPI 加密的保险库里，与聊天记录分开；聊天与记忆存在本机 SQLite。"
                : "当前是浏览器开发模式：API Key 以明文存在 localStorage，聊天记录也没有落库。正式桌面版会走加密保险库和 SQLite。"}</span>
            </div>

            <div className="settings-divider" />
            <div className="modal-heading"><div><p className="eyebrow">Presence</p><h3>主动消息</h3></div></div>
            <p className="modal-intro">她会在想起你的时候先开口。每天最多 6 条，两条之间至少隔 90 分钟，免打扰时段完全静默。</p>
            <div className="toggle-row">
              <button className={`toggle ${proactive.enabled ? "on" : ""}`} onClick={() => void session.setProactive({ ...proactive, enabled: !proactive.enabled })}>
                {proactive.enabled ? <Bell size={15} /> : <BellOff size={15} />}
                <span>{proactive.enabled ? "已开启" : "已关闭"}</span>
              </button>
              <span className="toggle-hint">随时可以一键关掉，关掉之后不会有任何提醒或补发。</span>
            </div>
            <div className="form-grid">
              <label className="field"><span>免打扰开始</span><select value={proactive.quietStartHour} onChange={(e) => void session.setProactive({ ...proactive, quietStartHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label>
              <label className="field"><span>免打扰结束</span><select value={proactive.quietEndHour} onChange={(e) => void session.setProactive({ ...proactive, quietEndHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label>
            </div>
            <div className="toggle-row">
              <button className={`toggle ${session.memoryExtractionEnabled ? "on" : ""}`} onClick={() => void session.setMemoryExtractionEnabled(!session.memoryExtractionEnabled)}>
                <MessageCircleMore size={15} />
                <span>自动记忆 · {session.memoryExtractionEnabled ? "开" : "关"}</span>
              </button>
              <span className="toggle-hint">开启后每轮对话结束会额外发一次抽取请求，会产生平台调用费用。</span>
            </div>

            <div className="settings-divider" />
            <div className="modal-heading"><div><p className="eyebrow">Listening</p><h3>语音识别</h3></div></div>
            <p className="modal-intro">本地识别不需要你在说话前选语言，日语、中文、英语都自动认。它要一个本地 whisper.cpp 服务；没开的时候退回系统语音识别，那条链路一次只能认一种语言。</p>
            <div className="form-grid">
              <label className="field"><span>识别链路</span>
                <select
                  value={session.voiceBackend.backend}
                  onChange={(e) => void session.setVoiceBackend({ ...session.voiceBackend, backend: e.target.value as VoiceBackend })}
                >
                  <option value="auto">自动：本地服务开着就用它</option>
                  <option value="whisper-local">只用本地 Whisper</option>
                  <option value="web-speech">只用系统语音识别</option>
                </select>
              </label>
              <label className="field"><span>本地服务地址</span>
                <input
                  value={session.voiceBackend.whisperEndpoint}
                  onChange={(e) => void session.setVoiceBackend({ ...session.voiceBackend, whisperEndpoint: e.target.value })}
                  placeholder="http://127.0.0.1:8080"
                />
              </label>
            </div>
            <div className="toggle-row">
              <button className="toggle" onClick={handleProbeWhisper} disabled={whisperStatus === "checking"}>
                {whisperStatus === "checking" ? <LoaderCircle size={15} className="spin" /> : <Volume2 size={15} />}
                <span>检测本地服务</span>
              </button>
              <span className="toggle-hint">{whisperNote || "启动 whisper-server 之后点这里确认它活着。"}</span>
            </div>

            <div className="modal-actions"><button className="secondary-button" onClick={handleTest} disabled={status.kind === "testing"}>测试连接</button><button className="primary-button" onClick={handleSave}>保存并使用</button></div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
