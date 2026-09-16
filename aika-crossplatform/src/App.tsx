import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Bell, BellOff, Bot, Check, ChevronDown, KeyRound, Languages, LoaderCircle, MessageCircleMore,
  Monitor, Bug, Mic, PanelRightClose, PowerOff, RefreshCw, SendHorizontal, Settings2, Smartphone,
  Sparkles, Trash2, Volume2, X,
} from "lucide-react";
import "./App.css";
import { AvatarPlaceholder } from "./components/AvatarPlaceholder";
import { MessageActions } from "./components/MessageActions";
import { MessageBody } from "./components/MessageBody";
import { MessageSticker } from "./components/MessageSticker";
import { MessageTranslation } from "./components/MessageTranslation";
import { VoiceModal } from "./components/VoiceModal";
import type { VoiceOutput } from "./services/voice/outputEngine";
import { DevToolsPage } from "./pages/DevToolsPage";
import { LiveInspector } from "./components/LiveInspector";
import { DEFAULT_CHARACTER } from "./domain/character";
import { nextRecognitionLanguage, type RecognitionInput } from "./domain/language";
import { PROVIDER_PRESETS, validateProvider, type ProviderConfig } from "./domain/providers";
import { useCompanionSession } from "./hooks/useCompanionSession";
import { useEnvironment } from "./hooks/useEnvironment";
import { useCompanionControls } from "./hooks/useCompanionControls";
import { useKnowledgeWiki } from "./hooks/useKnowledgeWiki";
import { useDesktopPet } from "./hooks/useDesktopPet";
import { useDevTools } from "./hooks/useDevTools";
import { useRemoteAccess } from "./hooks/useRemoteAccess";
import { useVoiceConversation, type VoiceTurnHandler } from "./hooks/useVoiceConversation";
import { useService } from "./app/kernelContext";
import { ProviderModelsToken, ProviderProbeToken } from "./services/runtime/tokens";
import type { VoiceBackend } from "./services/voice/inputEngine";
import type { VoiceInputLanguage } from "./services/voice/contracts";

/** 语音页那个按钮的顺序：日语 → 中文 → 英语 → 日语。三种就够，不做下拉。 */
const NEXT_LANGUAGE: Record<VoiceInputLanguage, VoiceInputLanguage> = {
  "ja-JP": "zh-CN",
  "zh-CN": "en-US",
  "en-US": "ja-JP",
};
import { createWhisperClient } from "./services/voice/whisperClient";

const QUICK_STARTS = ["今天发生了一件小事…", "有点累，想随便聊聊", "刚才想到你说过的那件事"];

/** 环境源状态的用户可见文案（SET-04）：失败不得显示为已运行。 */
const ENVIRONMENT_STATE_LABELS: Record<string, string> = {
  off: "已关闭",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  denied: "权限被拒",
  error: "错误",
};

/** FE-31：陪伴读屏状态的用户可见文案。失败不得显示为运行中。 */
const COMPANION_READ_LABELS: Record<string, string> = {
  off: "未开启",
  starting: "启动中",
  reading: "正在读屏",
  paused: "已暂停读屏",
  denied: "未授权",
  failed: "启动失败",
};

/** SET-02：屏幕感知开启前要说明采集范围与本地处理方式。 */
const ENVIRONMENT_SOURCE_HINTS: Record<string, string> = {
  foreground: "识别当前正在使用的应用（仅进程名），只用于本地状态显示。",
  screen: "做变化检测仍会获取屏幕帧：仅在画面显著变化时，对主屏中央固定区域做本地英文识别（VICTORY/DEFEAT/PENTAKILL/Error/Failed）；画面不出本机、不落盘。",
};

function App() {
  const session = useCompanionSession();
  const devTools = useDevTools();
  const environment = useEnvironment();
  const controls = useCompanionControls();
  const desktopPet = useDesktopPet();
  const wiki = useKnowledgeWiki();
  const [showDevTools, setShowDevTools] = useState(false);
  // 连接自检是 Provider 侧能力，经注册表取；App 不再直接 import providerClient。
  const probeProvider = useService(ProviderProbeToken);
  // 模型列表拉取同为 Provider 侧能力，走端口。
  const fetchModels = useService(ProviderModelsToken);

  const [draftProvider, setDraftProvider] = useState<ProviderConfig>(PROVIDER_PRESETS[1]);
  const [input, setInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTranslation, setShowTranslation] = useState(true);
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "ok" | "error"; text: string }>({ kind: "idle", text: "" });
  const [models, setModels] = useState<string[]>([]);
  const [modelsStatus, setModelsStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [modelsNote, setModelsNote] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const settingsModalRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const keepMessagesAtBottomRef = useRef(true);
  const [whisperStatus, setWhisperStatus] = useState<"idle" | "checking" | "ok" | "down">("idle");
  const [whisperNote, setWhisperNote] = useState("");
  const [voiceApiKeyDraft, setVoiceApiKeyDraft] = useState("");
  const applyVoiceOutput = (overrides: Partial<import("./services/voice/outputEngine").VoiceOutputConfig>) => {
    const current = session.voiceOutput;
    const config = {
      output: (overrides.output ?? (current?.output as VoiceOutput | undefined) ?? "system") as VoiceOutput,
      baseUrl: overrides.baseUrl ?? current?.baseUrl ?? "",
      model: overrides.model ?? current?.model ?? "",
      voice: overrides.voice ?? current?.voice ?? "",
      speed: overrides.speed ?? current?.speed ?? 1,
      apiKey: overrides.apiKey ?? "",
    };
    void session.setVoiceOutput(config);
  };


  const { connected, sending, provider, messages, memories, relationship, proactive } = session;

  /**
   * 识别语言的推导依据（STT-04）。
   *
   * 不能直接拿 `messages` 算：那里面混着打字输入，而打一句中文就让下一句
   * 日语按中文听，是最常见的触发路径。这里只记“真的识别出来的那几句”，
   * 打字内容只在还没有任何语音历史时当起点用。
   */
  const spokenRef = useRef<RecognitionInput[]>([]);
  /** 上一次实际用过的识别语言：证据不足时保持它，而不是重新挑一个。 */
  const lastLanguageRef = useRef<VoiceInputLanguage>("ja-JP");

  const sendVoice = useCallback<VoiceTurnHandler>(
    (text, onPartial, request) => {
      spokenRef.current = [...spokenRef.current, { text, fromVoice: true }].slice(-4);
      return session.send(text, "voice", onPartial, request);
    },
    [session],
  );
  const resolveLanguage = useCallback(
    () => {
      const typed = messages
        .filter((message) => message.role === "user")
        .slice(-4)
        .map((message) => message.content);
      const next = nextRecognitionLanguage(spokenRef.current, typed, lastLanguageRef.current);
      lastLanguageRef.current = next;
      return next;
    },
    [messages],
  );
  const voice = useVoiceConversation(sendVoice, resolveLanguage, session.voiceBackend);
  // 手机端：它把「发一轮」交回这里跑，数据始终只有电脑上这一份。
  const remote = useRemoteAccess({
    messages,
    connected,
    send: (text) => session.send(text, "text"),
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!keepMessagesAtBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = messagesRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages]);

  async function handleCopyRemoteUrl() {
    if (!remote.info) return;
    try {
      await navigator.clipboard.writeText(remote.info.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板被拒时地址就在界面上，用户可以自己选中复制。
    }
  }

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
    setModels([]);
    setModelsStatus("idle");
    setModelsNote("");
    setShowSettings(true);
  }

  function choosePreset(id: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setDraftProvider({ ...preset, apiKey: preset.id === provider.id ? provider.apiKey : "" });
    setStatus({ kind: "idle", text: "" });
    // 地址和 Key 都会跟着变，旧列表不再可信。
    setModels([]);
    setModelsStatus("idle");
    setModelsNote("");
  }

  async function handleFetchModels() {
    if (!draftProvider.baseUrl.trim() || !draftProvider.apiKey.trim()) {
      setModelsStatus("error");
      setModelsNote("先填好 API 地址和 API Key 再获取模型列表");
      return;
    }
    setModelsStatus("loading");
    setModelsNote("正在获取…");
    try {
      const list = await fetchModels(draftProvider);
      setModels(list);
      if (list.length === 0) {
        setModelsStatus("error");
        setModelsNote("平台没有返回任何模型");
      } else {
        setModelsStatus("ok");
        setModelsNote(`获取到 ${list.length} 个模型，在下方选择或直接手动填写`);
      }
    } catch (error) {
      setModels([]);
      setModelsStatus("error");
      setModelsNote(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleTest() {
    const validation = validateProvider(draftProvider);
    if (validation) return setStatus({ kind: "error", text: validation });
    setStatus({ kind: "testing", text: "正在连接…" });
    try {
      setStatus({ kind: "ok", text: await probeProvider(draftProvider) });
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
          {devTools.devMode && showDevTools && <LiveInspector />}
          {devTools.devMode && (
            <button
              className={`icon-button ${showDevTools ? "active" : ""}`}
              title="调试工作台"
              onClick={() => setShowDevTools((value) => !value)}
            >
              <Bug size={18} />
            </button>
          )}
          <button className="icon-button" title="设置" onClick={openSettings}><Settings2 size={18} /></button>
          <button className="icon-button sidebar-toggle" title="切换侧栏" onClick={() => setShowSidebar((value) => !value)}><PanelRightClose size={18} /></button>
        </div>
      </header>

      {showDevTools && <DevToolsPage devTools={devTools} onClose={() => setShowDevTools(false)} />}

      <section
        className={`workspace ${showSidebar ? "" : "sidebar-hidden"}`}
        hidden={showDevTools}
      >
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

          <div
            ref={messagesRef}
            className="messages"
            aria-live="polite"
            onScroll={(event) => {
              const container = event.currentTarget;
              keepMessagesAtBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 48;
            }}
          >
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
                        <MessageBody
                          id={message.id}
                          text={message.japaneseText ?? message.content}
                          range={voice.speakingMessageId === message.id ? voice.speakingRange : null}
                        />
                        <MessageTranslation message={message} visible={showTranslation} />
                        <MessageSticker id={message.sticker} stickers={session.stickers} />
                        <MessageActions
                          message={message}
                          messages={messages}
                          sending={sending}
                          speaking={voice.speakingMessageId === message.id}
                          canSpeak={!voice.isOpen}
                          onSpeak={(id) => voice.speakMessage(id, message.japaneseText ?? message.content)}
                          onRetry={(id) => void session.retry(id)}
                          onRegenerate={(id) => void session.regenerate(id)}
                          onWithdraw={(id) => void session.withdraw(id)}
                          onRewind={(id) => void session.rewind(id)}
                        />
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
          language={voice.language}
          languagePinned={voice.languagePinned}
          onCycleLanguage={() => voice.setLanguage(NEXT_LANGUAGE[voice.language])}
          onInterrupt={voice.interruptAndListen}
          onSendNow={voice.sendNow}
          onClearPending={voice.clearPending}
          onClose={voice.close}
        />
      )}

      {showSettings && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowSettings(false)}>
          <section ref={settingsModalRef} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <nav className="settings-nav" aria-label="设置分类">
              {[
                ["settings-model", "模型与数据"],
                ["settings-response", "主动 / 被动"],
                ["settings-awareness", "环境感知"],
                ["settings-knowledge", "知识库"],
                ["settings-pet", "桌宠 / 陪伴"],
                ["settings-voice", "语音"],
                ["settings-remote", "手机连接"],
                ["settings-developer", "开发调试"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => settingsModalRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="settings-content">
            <div id="settings-model" className="modal-heading settings-anchor"><div><p className="eyebrow">Model Link</p><h2 id="settings-title">连接你的模型</h2></div><button className="icon-button" onClick={() => setShowSettings(false)}><X size={20} /></button></div>
            <p className="modal-intro">选择平台、填写 Key 并测试。请求由你的电脑直接发往模型平台，不经过额外服务器。</p>
            <label className="field-label">平台</label>
            <div className="select-wrap"><select value={draftProvider.id} onChange={(event) => choosePreset(event.target.value)}>{PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={17} /></div>
            <div className="form-grid">
              <label className="field wide"><span>API 地址</span><input value={draftProvider.baseUrl} onChange={(e) => setDraftProvider({ ...draftProvider, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
              <label className="field"><span>协议</span><select value={draftProvider.protocol} disabled={draftProvider.id !== "custom"} onChange={(e) => setDraftProvider({ ...draftProvider, protocol: e.target.value as ProviderConfig["protocol"] })}><option value="openai-responses">OpenAI Responses</option><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option></select></label>
              <label className="field"><span>模型名称</span>
                <input value={draftProvider.model} onChange={(e) => setDraftProvider({ ...draftProvider, model: e.target.value })} placeholder="模型 ID" />
                <div className="model-fetch-row">
                  <button type="button" className="model-fetch-button" onClick={handleFetchModels} disabled={modelsStatus === "loading"}>
                    {modelsStatus === "loading" ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
                    <span>{modelsStatus === "loading" ? "获取中…" : models.length > 0 ? "刷新模型列表" : "获取模型列表"}</span>
                  </button>
                  {modelsStatus !== "idle" && modelsStatus !== "loading" && (
                    <span className={`model-fetch-note ${modelsStatus}`}>{modelsNote}</span>
                  )}
                </div>
                {models.length > 0 && (
                  <div className="select-wrap model-select">
                    <select
                      value={models.includes(draftProvider.model) ? draftProvider.model : ""}
                      onChange={(e) => e.target.value && setDraftProvider({ ...draftProvider, model: e.target.value })}
                    >
                      <option value="">从列表选择模型…</option>
                      {models.map((model) => <option key={model} value={model}>{model}</option>)}
                    </select>
                    <ChevronDown size={17} />
                  </div>
                )}
              </label>
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
            <div id="settings-response" className="modal-heading settings-anchor"><div><p className="eyebrow">Response</p><h3>主动 / 被动响应</h3></div></div>
            <p className="modal-intro">被动响应始终用于你主动发起的文字或语音；主动响应由下方开关控制。主动模式每天最多 6 条，两条之间至少隔 90 分钟，免打扰时段完全静默。</p>
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
            <div className="toggle-row">
              <button className={`toggle ${session.petClickReactionEnabled ? "on" : ""}`} onClick={() => void session.setPetClickReactionEnabled(!session.petClickReactionEnabled)}>
                <Bell size={15} />
                <span>点击桌宠时应一声 · {session.petClickReactionEnabled ? "开" : "关"}</span>
              </button>
              <span className="toggle-hint">点了桌宠她会说一句短话（短语来自本地，不调模型、不花费用），不受「主动消息」总开关影响——主动消息关着她也应这一声。两次之间至少隔 30 秒，连点不会攒着一起说；她正在说话时不会叠话；免打扰时段内不出声。</span>
            </div>

            {environment.snapshot.available && (
              <>
                <div className="settings-divider" />
                <div id="settings-awareness" className="modal-heading settings-anchor"><div><p className="eyebrow">Awareness</p><h3>环境感知</h3></div></div>
                <p className="modal-intro">感知与「把摘要用于对话」是两层开关，互不牵连。摘要只包含应用名与持续时间，不包含窗口标题；屏幕画面不出本机。</p>
                {environment.snapshot.sources.map((source) => (
                  <div className="toggle-row" key={source.sourceId}>
                    <button
                      className={`toggle ${source.enabled ? "on" : ""}`}
                      onClick={() => void environment.presenter.setSourceEnabled(source.sourceId, !source.enabled)}
                    >
                      <Monitor size={15} />
                      <span>{source.label} · {ENVIRONMENT_STATE_LABELS[source.state] ?? source.state}</span>
                    </button>
                    <span className="toggle-hint">
                      {source.error ?? source.activity ?? ENVIRONMENT_SOURCE_HINTS[source.sourceId] ?? "本机环境传感器。"}
                    </span>
                  </div>
                ))}
                <div className="toggle-row">
                  <button
                    className={`toggle ${environment.snapshot.contextEnabled ? "on" : ""}`}
                    onClick={() => void environment.presenter.setContextEnabled(!environment.snapshot.contextEnabled)}
                  >
                    <MessageCircleMore size={15} />
                    <span>将环境摘要用于对话 · {environment.snapshot.contextEnabled ? "开" : "关"}</span>
                  </button>
                  <span className="toggle-hint">开启后，应用名与持续时长可能随当前 Provider 的请求一起发送。</span>
                </div>
                <div className="toggle-row">
                  <button
                    className={`toggle ${environment.snapshot.screenTextEnabled ? "on" : ""}`}
                    onClick={() => void environment.presenter.setScreenTextEnabled(!environment.snapshot.screenTextEnabled)}
                  >
                    <Monitor size={15} />
                    <span>允许屏幕文字用于对话 · {environment.snapshot.screenTextEnabled ? "开" : "关"}</span>
                  </button>
                  <span className="toggle-hint">
                    这一层放行的不是摘要，而是当前前台窗口上可见文字的摘录（最多 20 段、2000 字符），
                    随你这一轮对话发给当前设置的 Provider。摘录可能包含邮件、聊天、代码、账号等私人信息；
                    截图与完整识别原文只留在本机内存，不落库、不进 Trace，但已发出的摘录无法撤回，
                    模型也可能在回复里复述其中内容——不承诺脱敏能消除全部敏感信息。
                    关掉它之后，下一次请求装配立刻拿不到任何摘录；「暂停读屏」只停采集，这一层单独控制外发。
                  </span>
                </div>
                <div className="toggle-row">
                  <button
                    className={`toggle ${environment.snapshot.proactiveEnabled ? "on" : ""}`}
                    onClick={() => void environment.presenter.setProactiveEnabled(!environment.snapshot.proactiveEnabled)}
                  >
                    <Bell size={15} />
                    <span>允许环境主动搭话 · {environment.snapshot.proactiveEnabled ? "开" : "关"}</span>
                  </button>
                  <span className="toggle-hint">与全局「主动消息」开关叠加：两层都开、感知在跑且摘要授权开启时才会触发；勿扰时段与每日上限仍然生效。</span>
                </div>
                <div className="toggle-row">
                  <button
                    className="toggle"
                    onClick={() => void environment.presenter.stopAll()}
                    disabled={environment.snapshot.stopping}
                  >
                    <PowerOff size={15} />
                    <span>{environment.snapshot.stopping ? "正在停止…" : "停止全部感知"}</span>
                  </button>
                  <span className="toggle-hint">立即停止采集、清空环境缓存，并使在途结果失效。</span>
                </div>
                {environment.snapshot.error && (
                  <p className="modal-intro" style={{ color: "#e5484d" }}>{environment.snapshot.error}</p>
                )}
              </>
            )}

            {wiki.available && (
              <>
                <div className="settings-divider" />
                <div id="settings-knowledge" className="modal-heading settings-anchor"><div><p className="eyebrow">Knowledge</p><h3>知识库（Wiki）</h3></div></div>
                <p className="modal-intro">
                  你写进来的条目按角色保存（同名保存=编辑，版本递增），检索时按关系阶段与模式过滤。
                  是否随对话发给 Provider 由下面的开关单独控制——写条目本身不会打开任何外发。
                </p>
                <div className="toggle-row">
                  <button className={`toggle ${wiki.knowledgeOn ? "on" : ""}`} onClick={() => void wiki.toggle("knowledge", !wiki.knowledgeOn)}>
                    <MessageCircleMore size={15} />
                    <span>知识库检索 · {wiki.knowledgeOn ? "开" : "关"}</span>
                  </button>
                  <button className={`toggle ${wiki.memoryOn ? "on" : ""}`} onClick={() => void wiki.toggle("memory", !wiki.memoryOn)}>
                    <MessageCircleMore size={15} />
                    <span>长期记忆 · {wiki.memoryOn ? "开" : "关"}</span>
                  </button>
                  <span className="toggle-hint">
                    关闭长期记忆会同时停掉读取与写入（最近对话不受影响）；关闭知识库只是不检索，条目还在、也还能编辑。当前：{wiki.statusText || "正在读取条目…"}
                  </span>
                </div>
                {wiki.entries.length > 0 && (
                  <div className="memory-list">
                    {wiki.entries.map((entry) => (
                      <div key={entry.id} className="memory-item">
                        <span>{entry.type}</span>
                        <p><strong>{entry.sourcePath.replace(/^wiki:\/\//, "")}</strong> · v{entry.version} · {entry.chunks} 块</p>
                        <div className="memory-actions">
                          <button title="删除这条知识" onClick={() => void wiki.remove(entry.id)}><Trash2 size={13} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <label className="field"><span>标题</span>
                  <input value={wiki.draft.title} onChange={(event) => wiki.setDraft({ ...wiki.draft, title: event.target.value })} placeholder="例如：喜欢的乐队" />
                </label>
                <label className="field wide"><span>内容（Markdown）</span>
                  <textarea className="profile-textarea" rows={5} value={wiki.draft.markdown}
                    onChange={(event) => wiki.setDraft({ ...wiki.draft, markdown: event.target.value })}
                    placeholder={"## 事实\n- 喜欢深夜写代码"} />
                </label>
                <div className="toggle-row">
                  <button className="toggle" onClick={() => void wiki.save()} disabled={wiki.busy || !wiki.draft.title.trim() || !wiki.draft.markdown.trim()}>
                    <Check size={15} /><span>保存条目</span>
                  </button>
                  <span className="toggle-hint">保存走与文件导入同一条解析、切块与版本路径。</span>
                </div>
                {wiki.notice && <p className="modal-intro">{wiki.notice}</p>}
                {wiki.error && <p className="modal-intro" style={{ color: "#e5484d" }}>{wiki.error}</p>}
              </>
            )}

            {(desktopPet.available || controls.session) && (
              <>
                <div id="settings-pet" className="settings-divider" />
                <div className="modal-heading"><div><p className="eyebrow">External pet</p><h3>外部桌宠（OpenPet）</h3></div></div>
                <p className="modal-intro">
                  接入现成的 OpenPet 运行时：Aiki 只通过本机 HTTP 让它说话、做动作、显示进度，
                  窗口、拖动、置顶与角色资源都由它自己管。0.5 只访问本机回环地址，不使用任何代理转发。
                </p>
                {desktopPet.available ? (
                  <>
                    <div className="toggle-row">
                      <button
                        className={`toggle ${desktopPet.enabled ? "on" : ""}`}
                        onClick={() => void (desktopPet.enabled ? desktopPet.disable() : desktopPet.enable())}
                        disabled={desktopPet.busy}
                      >
                        <Sparkles size={15} />
                        <span>{desktopPet.enabled ? "已启用" : "启用桌宠集成"}</span>
                      </button>
                      <span className="toggle-hint">
                        状态：{desktopPet.connectionLabel}{desktopPet.stale ? "（快照已过期）" : ""}。
                        关闭时不会请求本机、也不会启动任何进程。
                      </span>
                    </div>
                    <div className="form-grid">
                      <label className="field"><span>连接地址</span>
                        <input
                          value={desktopPet.config.endpoint}
                          onChange={(e) => void desktopPet.saveConfig({ endpoint: e.target.value })}
                          placeholder="http://127.0.0.1:17321"
                        />
                      </label>
                      <label className="field"><span>连接方式</span>
                        <select
                          value={desktopPet.config.mode}
                          onChange={(e) => void desktopPet.saveConfig({ mode: e.target.value as "attach" | "managed" })}
                        >
                          <option value="attach">只连接已启动的桌宠</option>
                          <option value="managed">由 Aiki 启动（需填运行程序）</option>
                        </select>
                      </label>
                      {desktopPet.config.mode === "managed" && (
                        <label className="field wide"><span>运行程序（安装后的 exe，不是安装器）</span>
                          <input
                            value={desktopPet.config.executablePath ?? ""}
                            onChange={(e) => void desktopPet.saveConfig({ executablePath: e.target.value || null })}
                            placeholder="C:/Program Files/OpenPet/OpenPet.exe"
                          />
                        </label>
                      )}
                      <label className="field"><span>随 Aiki 启动</span>
                        <select
                          value={String(desktopPet.config.startWithAiki)}
                          onChange={(e) => void desktopPet.saveConfig({ startWithAiki: e.target.value === "true" })}
                        >
                          <option value="false">否</option>
                          <option value="true">是</option>
                        </select>
                      </label>
                      <label className="field"><span>退出 Aiki 时</span>
                        <select
                          value={String(desktopPet.config.stopOwnedOnExit)}
                          onChange={(e) => void desktopPet.saveConfig({ stopOwnedOnExit: e.target.value === "true" })}
                        >
                          <option value="false">保留桌宠（默认）</option>
                          <option value="true">终止由 Aiki 启动的桌宠</option>
                        </select>
                      </label>
                      <label className="field"><span>自动重启（高级，默认关）</span>
                        <select
                          value={String(desktopPet.config.autoRestart)}
                          onChange={(e) => void desktopPet.saveConfig({ autoRestart: e.target.value === "true" })}
                        >
                          <option value="false">关</option>
                          <option value="true">仅在确定崩溃时重启（5 分钟最多 2 次）</option>
                        </select>
                      </label>
                    </div>
                    <div className="toggle-row">
                      <button className="toggle" onClick={() => void desktopPet.testConnection()} disabled={desktopPet.busy || !desktopPet.enabled}>
                        <RefreshCw size={15} /><span>测试连接</span>
                      </button>
                      <button className="toggle" onClick={() => void desktopPet.demo("你好呀，我在这里。")} disabled={desktopPet.busy || !desktopPet.enabled}>
                        <Sparkles size={15} /><span>发送演示</span>
                      </button>
                      <span className="toggle-hint">测试连接会真的探测一次；未启用时不发请求。</span>
                    </div>
                    {desktopPet.actions.length > 0 && (
                      <p className="modal-intro">当前角色已验证的动作：{desktopPet.actions.join("、")}</p>
                    )}
                    <label className="field wide"><span>角色 profile（JSON；留空＝只发文字与事件，不做动作）</span>
                      <textarea
                        className="profile-textarea"
                        value={desktopPet.profileText}
                        onChange={(e) => desktopPet.setProfileText(e.target.value)}
                        rows={6}
                        placeholder='{"schemaVersion":1,"provider":"openpet","release":"v0.1.6","petId":"nia","source":"manual","actions":{"wave":"waving"},"emotions":{"happy":"jumping"},"events":{}}'
                      />
                    </label>
                    <div className="toggle-row">
                      <button className="toggle" onClick={() => void desktopPet.saveProfile()} disabled={desktopPet.busy}>
                        <Check size={15} /><span>保存 profile</span>
                      </button>
                      <span className="toggle-hint">
                        {desktopPet.profileError ?? "profile 绑定上游版本与角色；对不上时动作能力会降级，而不是拿旧映射乱发。"}
                      </span>
                    </div>
                    <p className="modal-intro">
                      <strong>当前桌宠不支持点击回传</strong>：陪伴会话、看屏幕聊聊、暂停/结束这些控制仍然只在主窗里，
                      这里如实标注差距，不假装已经双向。
                    </p>
                  </>
                ) : (
                  <p className="modal-intro">浏览器开发模式下没有外部桌宠集成，要在桌面应用里用。</p>
                )}
                {desktopPet.notice && <p className="modal-intro">{desktopPet.notice}</p>}
                {desktopPet.error && <div className="test-result error"><X size={17} /><span>{desktopPet.error}</span></div>}
                {controls.session && controls.sessionView && (
                  <>
                    <div className="modal-heading"><div><p className="eyebrow">Companion session</p><h3>陪伴</h3></div></div>
                    <p className="modal-intro">
                      开启陪伴后，她会读取<strong>主显示器上当前前台窗口</strong>里可见的文字（本地识别，截图不出本机），
                      并按你选的模式决定要不要主动搭话。在主窗可以随时看屏幕聊聊、暂停读屏或结束陪伴。
                      是否把读到的文字随对话发给 Provider，由上面「允许屏幕文字用于对话」单独控制——这一步不会被开启陪伴顺带打开。
                    </p>
                    <div className="toggle-row">
                      <button
                        className={`toggle ${controls.sessionView.mode === "active" ? "on" : ""}`}
                        onClick={() => void (controls.sessionView?.mode === "active"
                          ? controls.session?.setMode("quiet")
                          : controls.session?.enable("active", { consent: true }))}
                      >
                        <Sparkles size={15} />
                        <span>主动陪伴 · {controls.sessionView.mode === "active" ? "开" : "关"}</span>
                      </button>
                      <span className="toggle-hint">画面上的文字有明显变化时她可能主动说一句；仍受全局主动消息的每日上限、最小间隔与勿扰时段限制。</span>
                    </div>
                    <div className="toggle-row">
                      <button
                        className={`toggle ${controls.sessionView.mode === "quiet" ? "on" : ""}`}
                        onClick={() => void (controls.sessionView?.mode === "quiet"
                          ? controls.session?.end()
                          : controls.session?.enable("quiet", { consent: true }))}
                      >
                        <BellOff size={15} />
                        <span>安静陪伴 · {controls.sessionView.mode === "quiet" ? "开" : "关"}</span>
                      </button>
                      <span className="toggle-hint">照常读屏更新本地上下文，但绝不主动说话——只有你主动提问她才回。</span>
                    </div>
                    <div className="toggle-row">
                      <button
                        className="toggle"
                        onClick={() => void controls.session?.pause()}
                        disabled={controls.sessionView.mode === "off"}
                      >
                        <PowerOff size={15} />
                        <span>暂停读屏</span>
                      </button>
                      <span className="toggle-hint">
                        停止采集并清空已读到的屏幕内容，桌宠保留、普通聊天照常。
                        当前状态：{COMPANION_READ_LABELS[controls.sessionView.readState] ?? controls.sessionView.readState}
                        {controls.sessionView.quota ? `（本分钟已读屏 ${controls.sessionView.quota.used}/${controls.sessionView.quota.limit} 次）` : ""}
                      </span>
                    </div>
                    <div className="toggle-row">
                      <button className="toggle" onClick={() => void controls.screenTalk()}>看屏幕聊聊</button>
                      <button className="toggle" onClick={() => void controls.session?.end()}>结束陪伴</button>
                    </div>
                    {controls.sessionView.notice && <p className="modal-intro">{controls.sessionView.notice}</p>}
                    {controls.sessionView.error && (
                      <p className="modal-intro" style={{ color: "#e5484d" }}>{controls.sessionView.error}</p>
                    )}
                  </>
                )}
              </>
            )}

            <div className="settings-divider" />
            <div id="settings-voice" className="modal-heading settings-anchor"><div><p className="eyebrow">Listening</p><h3>语音识别</h3></div></div>
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

            <div className="settings-divider" />
            <div className="modal-heading"><div><p className="eyebrow">Speaking</p><h3>语音输出</h3></div></div>
            <p className="modal-intro">默认走系统合成。点名要云端却配置不全时，她会退回系统合成并把原因一直显示在这里——不会假装新音色已经生效。API Key 存在系统加密的密钥库里，不进设置导出。</p>
            {session.voiceOutput && (
              <div className="form-grid">
                <label className="field"><span>输出链路</span>
                  <select
                    value={session.voiceOutput.output}
                    onChange={(e) => applyVoiceOutput({ output: e.target.value as VoiceOutput })}
                  >
                    <option value="system">只用系统合成</option>
                    <option value="auto">自动：配好了就用云端</option>
                    <option value="cloud-tts">只用云端合成</option>
                  </select>
                </label>
                <label className="field"><span>API 地址</span>
                  <input
                    value={session.voiceOutput.baseUrl}
                    onChange={(e) => applyVoiceOutput({ baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label className="field"><span>模型</span>
                  <input
                    value={session.voiceOutput.model}
                    onChange={(e) => applyVoiceOutput({ model: e.target.value })}
                  />
                </label>
                <label className="field"><span>音色</span>
                  <input
                    value={session.voiceOutput.voice}
                    onChange={(e) => applyVoiceOutput({ voice: e.target.value })}
                  />
                </label>
                <label className="field"><span>语速</span>
                  <input
                    type="number" step="0.1" min="0.5" max="2"
                    value={session.voiceOutput.speed}
                    onChange={(e) => applyVoiceOutput({ speed: Number(e.target.value) || 1 })}
                  />
                </label>
                <label className="field"><span>API Key {session.voiceOutput.hasApiKey ? "（已保存，留空＝保持）" : ""}</span>
                  <input
                    type="password"
                    value={voiceApiKeyDraft}
                    onChange={(e) => setVoiceApiKeyDraft(e.target.value)}
                    placeholder={session.voiceOutput.hasApiKey ? "••••••••" : "sk-…"}
                  />
                </label>
                <div className="toggle-row">
                  <button className="toggle" onClick={() => { applyVoiceOutput({ apiKey: voiceApiKeyDraft }); setVoiceApiKeyDraft(""); }}>
                    <Volume2 size={15} /><span>保存 API Key</span>
                  </button>
                  {session.voiceOutput.hasApiKey && (
                    <button className="toggle" onClick={() => { void session.removeVoiceApiKey(); setVoiceApiKeyDraft(""); }}>
                      <span>删除已保存的 Key</span>
                    </button>
                  )}
                </div>
                {voice.outputStatus && (
                  <div className="toggle-row">
                    <span className={voice.outputStatus.degraded ? "toggle-hint" : "toggle-hint"}>
                      {voice.outputStatus.degraded ? "⚠ " : ""}{voice.outputStatus.note}
                      {voice.outputStatus.degraded ? "（当前实际用系统合成）" : ""}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="settings-divider" />
            <div id="settings-remote" className="modal-heading settings-anchor"><div><p className="eyebrow">Phone</p><h3>手机也能用</h3></div></div>
            <p className="modal-intro">手机上打开一个网页就能接着聊。它不是同步——记忆仍然只有这台电脑上的一份，手机只是一块远程屏幕。所以<strong>电脑不开机手机就用不了</strong>，主动消息也推不到手机，只有手机开着的时候才收得到。</p>
            {!remote.available ? (
              <p className="modal-intro">浏览器开发模式下没有这个功能，要在桌面应用里用。</p>
            ) : (
              <>
                <div className="form-grid">
                  <label className="field"><span>端口</span>
                    <input
                      value={remote.port}
                      onChange={(e) => remote.setPort(Number(e.target.value) || 0)}
                      disabled={Boolean(remote.info)}
                      inputMode="numeric"
                    />
                  </label>
                  <label className="field"><span>手机上打开这个地址</span>
                    <input value={remote.info?.url ?? "（还没开启）"} readOnly onFocus={(e) => e.target.select()} />
                  </label>
                </div>
                <div className="toggle-row">
                  <button
                    className={`toggle ${remote.info ? "on" : ""}`}
                    onClick={() => void (remote.info ? remote.stop() : remote.start(remote.port))}
                    disabled={remote.busy}
                  >
                    {remote.busy ? <LoaderCircle size={15} className="spin" /> : <Smartphone size={15} />}
                    <span>{remote.info ? "已开启" : "开启手机访问"}</span>
                  </button>
                  {remote.info && (
                    <>
                      <button className="toggle" onClick={handleCopyRemoteUrl} disabled={remote.busy}>
                        <Check size={15} /><span>{copied ? "已复制" : "复制地址"}</span>
                      </button>
                      <button className="toggle" onClick={() => void remote.rotateToken()} disabled={remote.busy}>
                        <RefreshCw size={15} /><span>换一把口令</span>
                      </button>
                    </>
                  )}
                  <span className="toggle-hint">
                    {remote.error
                      ? remote.error
                      : remote.info
                        ? remote.info.host === "127.0.0.1"
                          ? "拿不到局域网地址，手机可能连不上。检查一下电脑是不是连着 WiFi。"
                          : "地址里带着访问口令，等于钥匙——只发给自己的手机。出门用 Tailscale，不要做公网穿透。"
                        : "退出应用就会关掉，下次要用再开一次。不想让一个监听端口在你不知情时一直开着。"}
                  </span>
                </div>
              </>
            )}
            <div className="settings-divider" />
            <div id="settings-developer" className="modal-heading settings-anchor"><div><p className="eyebrow">Developer</p><h3>开发者模式</h3></div></div>
            <p className="modal-intro">打开之后标题栏会多一个入口，进去能看到每一轮对话在内部都发生了什么——组装了什么上下文、请求发给了谁、首 token 多久到、哪一步失败了。只写本机，不发往任何地方。</p>
            <div className="toggle-row">
              <button
                className={`toggle ${devTools.devMode ? "on" : ""}`}
                onClick={() => void devTools.setDevMode(!devTools.devMode)}
              >
                <Bug size={15} /><span>{devTools.devMode ? "已开启" : "开启开发者模式"}</span>
              </button>
              <span className="toggle-hint">
                {devTools.available
                  ? "Trace 的两个开关在工作台里面。"
                  : "当前装配没有 Trace 能力，工作台会显示未启用。"}
              </span>
            </div>

            <div className="modal-actions"><button className="secondary-button" onClick={handleTest} disabled={status.kind === "testing"}>测试连接</button><button className="primary-button" onClick={handleSave}>保存并使用</button></div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
