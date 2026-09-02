import { FormEvent, useMemo, useRef, useState } from "react";
import {
  Bot, Check, ChevronDown, KeyRound, Languages, LoaderCircle, MessageCircleMore,
  Mic, PanelRightClose, Plus, SendHorizontal, Settings2, Sparkles, Volume2, X,
} from "lucide-react";
import "./App.css";
import { AvatarPlaceholder } from "./components/AvatarPlaceholder";
import { VoiceModal } from "./components/VoiceModal";
import { DEFAULT_CHARACTER } from "./domain/character";
import type { CompanionReply } from "./domain/companion";
import {
  buildCompanionContext, companionMessage, formatClockTime, userMessage,
  type ChatMessage,
} from "./domain/conversation";
import { buildConversationInput, buildInstructions } from "./domain/prompt";
import { PROVIDER_PRESETS, validateProvider, type ProviderConfig } from "./domain/providers";
import { useVoiceConversation } from "./hooks/useVoiceConversation";
import { sendChat, testProvider } from "./services/providerClient";
import { appStorage } from "./services/storage/appStorage";

function initialProvider(): ProviderConfig {
  return appStorage.loadProvider(PROVIDER_PRESETS[1]);
}

function welcomeMessage(): ChatMessage {
  const createdAt = Date.now();
  return {
    id: "welcome",
    role: "assistant",
    content: DEFAULT_CHARACTER.greeting,
    japaneseText: DEFAULT_CHARACTER.greeting,
    chineseTranslation: DEFAULT_CHARACTER.greetingTranslation,
    createdAt,
    time: formatClockTime(createdAt),
  };
}

function initialMessages(): ChatMessage[] {
  return appStorage.loadMessages() ?? [welcomeMessage()];
}

function App() {
  const [provider, setProvider] = useState<ProviderConfig>(initialProvider);
  const [draftProvider, setDraftProvider] = useState<ProviderConfig>(initialProvider);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTranslation, setShowTranslation] = useState(true);
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "ok" | "error"; text: string }>({ kind: "idle", text: "" });
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const connected = Boolean(provider.apiKey && provider.baseUrl && provider.model);
  const relationship = useMemo(() => buildCompanionContext(messages).relationship, [messages]);
  const voice = useVoiceConversation(sendMessage);

  function persistMessages(next: ChatMessage[]) {
    setMessages(next);
    appStorage.saveMessages(next);
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

  function handleSave() {
    const validation = validateProvider(draftProvider);
    if (validation) return setStatus({ kind: "error", text: validation });
    const preset = PROVIDER_PRESETS.find((item) => item.id === draftProvider.id);
    const next = {
      ...draftProvider,
      protocol: preset && preset.id !== "custom" ? preset.protocol : draftProvider.protocol,
      baseUrl: draftProvider.baseUrl.trim(),
      model: draftProvider.model.trim(),
    };
    setProvider(next);
    appStorage.saveProvider(next);
    setStatus({ kind: "ok", text: "配置已保存，现在可以直接聊天" });
    setTimeout(() => setShowSettings(false), 450);
  }

  async function sendMessage(content: string): Promise<CompanionReply | null> {
    if (!content || sending) return null;
    if (!connected) {
      setDraftProvider(provider);
      setShowSettings(true);
      setStatus({ kind: "error", text: "请先完成 API 配置" });
      return null;
    }

    const asked = userMessage(content);
    const pendingId = crypto.randomUUID();
    const next = [...messages, asked];
    setInput("");
    setSending(true);
    setMessages([...next, { id: pendingId, role: "assistant", content: "", createdAt: asked.createdAt, time: asked.time, pending: true }]);

    try {
      // 上下文不含刚发出的这一句：它作为“用户刚刚说”单独交给提示词。
      const context = buildCompanionContext(messages);
      const reply = await sendChat(
        provider,
        buildInstructions(context, DEFAULT_CHARACTER.systemPrompt),
        [{ role: "user", content: buildConversationInput(content, context) }],
      );
      persistMessages([...next, companionMessage(reply, Date.now(), pendingId)]);
      return reply;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failedAt = Date.now();
      persistMessages([...next, {
        id: pendingId, role: "assistant", content: `这次没有发出去：${detail}`,
        createdAt: failedAt, time: formatClockTime(failedAt), error: true,
      }]);
      return null;
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  async function handleSend(event?: FormEvent) {
    event?.preventDefault();
    await sendMessage(input.trim());
  }

  function openVoice() {
    if (!connected) {
      setDraftProvider(provider);
      setShowSettings(true);
      setStatus({ kind: "error", text: "请先完成 API 配置，再进入实时语音" });
      return;
    }
    void voice.open();
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand"><span className="brand-mark"><Sparkles size={17} /></span><span>{DEFAULT_CHARACTER.name}</span><span className="brand-subtitle">Aika</span></div>
        <div className="titlebar-actions">
          <button className="icon-button" title="设置" onClick={() => setShowSettings(true)}><Settings2 size={18} /></button>
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
            <div className="presence"><span /> 在线 · 想和你聊聊天</div>
          </div>
          <div className="scene-note"><Sparkles size={16} /><div><strong>个性化角色包</strong><span>后续可导入 Live2D 与自训练声线</span></div></div>
        </aside>

        <section className="chat-panel">
          <div className="chat-heading">
            <div><p className="eyebrow">日常会话</p><h1>和{DEFAULT_CHARACTER.name}聊天</h1></div>
            <button className={`translation-toggle ${showTranslation ? "active" : ""}`} onClick={() => setShowTranslation((v) => !v)}><Languages size={17} /> 中文字幕 <span>{showTranslation ? "开" : "关"}</span></button>
          </div>

          <div className="messages" aria-live="polite">
            <div className="day-divider"><span>今天</span></div>
            {messages.map((message) => (
              <article key={message.id} className={`message-row ${message.role} ${message.error ? "error" : ""}`}>
                {message.role === "assistant" && <div className="mini-avatar">{DEFAULT_CHARACTER.name.slice(0, 1)}</div>}
                <div className="message-wrap">
                  <div className="message-meta">{message.role === "assistant" ? DEFAULT_CHARACTER.name : "你"} · {message.time}</div>
                  <div className="message-bubble">
                    {message.pending ? <span className="typing"><i /><i /><i /></span> : (
                      <>
                        {(message.japaneseText ?? message.content).split("\n").map((line, index) => (
                          <span key={`${message.id}-${index}`}>{line}</span>
                        ))}
                        {showTranslation && message.chineseTranslation && (
                          <span className="translation">{message.chineseTranslation}</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>

          <form className="composer" onSubmit={handleSend}>
            <div className="composer-topline"><span>可以输入日语或中文</span><span className="shortcut">Enter 发送 · Shift+Enter 换行</span></div>
            <div className="composer-box">
              <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); handleSend(); }
              }} placeholder="今日はちょっと疲れた… 或者直接说中文" rows={2} />
              <button type="button" className="composer-icon voice-entry" title="进入实时语音" onClick={openVoice}><Mic size={19} /></button>
              <button type="submit" className="send-button" disabled={!input.trim() || sending}>{sending ? <LoaderCircle size={19} className="spin" /> : <SendHorizontal size={19} />}</button>
            </div>
          </form>
        </section>

        <aside className="right-sidebar">
          <section className="side-card provider-card">
            <div className="side-card-title"><span><Bot size={17} /> 当前模型</span><button onClick={() => setShowSettings(true)}>配置</button></div>
            <div className="provider-status"><div className="provider-logo">{provider.name.slice(0, 1)}</div><div><strong>{provider.name}</strong><span>{provider.model || "尚未配置模型"}</span></div><i className={connected ? "connected" : ""} /></div>
          </section>
          <section className="side-card">
            <div className="side-card-title"><span><MessageCircleMore size={17} /> 相处状态</span><button title="长期记忆将在下一版接入" disabled><Plus size={15} /></button></div>
            <div className="memory-list">
              <div className="memory-item"><span>01</span><p><strong>相识</strong>{relationship.daysKnown} 天</p></div>
              <div className="memory-item"><span>02</span><p><strong>连续互动</strong>{relationship.consecutiveActiveDays} 天</p></div>
              <div className="memory-item"><span>03</span><p><strong>聊过</strong>{relationship.totalMessageCount} 条消息</p></div>
              <div className="memory-item muted"><span>04</span><p><strong>长期记忆</strong>下一版接入，可见可删</p></div>
            </div>
          </section>
          <section className="side-card quick-card">
            <div className="side-card-title"><span><Sparkles size={17} /> 快速开始</span></div>
            {["今天发生了一件小事…", "有点累，想随便聊聊", "刚才想到你说过的那件事"].map((text) => <button key={text} onClick={() => { setInput(text); inputRef.current?.focus(); }}>{text}</button>)}
          </section>
          <button className="voice-coming" onClick={openVoice}><Volume2 size={17} /><span><strong>实时语音</strong>点击进入连续对话</span></button>
        </aside>
      </section>

      {voice.isOpen && (
        <VoiceModal
          phase={voice.phase}
          interim={voice.interim}
          error={voice.error}
          captions={voice.captions}
          speakingCaptionId={voice.speakingCaptionId}
          language={voice.language}
          onLanguageChange={voice.setLanguage}
          onInterrupt={voice.interruptAndListen}
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
            <div className="security-note"><KeyRound size={16} /><span>当前开发版会把配置保存在本机应用数据中；正式版将切换到加密保险库。</span></div>
            <div className="modal-actions"><button className="secondary-button" onClick={handleTest} disabled={status.kind === "testing"}>测试连接</button><button className="primary-button" onClick={handleSave}>保存并使用</button></div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
