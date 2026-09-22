import {WakeController} from './wake-controller.mjs';
import { COMPANION_LABEL, isProductCharacter } from '../contracts/character.ts';
import { CaptureFeedback } from './capture-feedback.mjs';
import { WorkRecords } from './work-records.mjs';
import { WorkCard } from './work-card.mjs';
import { installDisplayControls } from './display-controls.mjs';
import { toDeviceFailure, deviceFailureMessage } from '../media/capture-errors.ts';
import { PressToTalk, validVoiceKey } from './press-to-talk.ts';
import { DesktopChatLog } from './chat-log.ts';
import { DesktopViewState, DesktopConnectionState, scopeEquals } from './view-state.ts';
import { CharacterPointerRouter, PANEL_ENTRIES } from './pointer-router.ts';
import { JellyfishRenderer } from './cubism-renderer.mjs';
import { BrowserPlaybackDriver } from '../media/browser-playback.ts';
import { DesktopPlaybackController } from './playback-controller.ts';
import { BrowserCaptureDriver } from '../media/browser-capture.ts';
import { DESKTOP_BRIDGE_VERSION } from '../contracts/desktop-bridge.ts';
import { PcmFrameAggregator } from '../media/voice-input-session.ts';
import { installMicrophoneTest } from './mic-test-panel.mjs';
const $ = id => document.getElementById(id);
const native = (name, value) => window.desktopHost ? window.desktopHost.postMessage(name, value) : window.webkit?.messageHandlers[name]?.postMessage(value);
const report = value => native('diagnostic', value);
const connection = new DesktopConnectionState();
const send = (value, generation = connection.generation) => {
  if (connection.current(generation) && connection.connected) native('desktop', { generation, message: value });
};
const view = new DesktopViewState();
const workSpeechView=new DesktopViewState();
let workNotice=null,workSpeechBlocked=false,backendSessionId=null;
const spokenNotices=new Set();
const chat = new DesktopChatLog();
const captureFeedback=new CaptureFeedback($);let captureFeedbackToken;
let wakeFeedbackToken,wakeRequestId=null,wakeUI={phase:'off',enabled:false};
const wakeLabels={connecting:'连接中',waiting:'等待唤醒',listening:'正在听',submitting:'正在提交',replying:'等待唤醒'};
const wake=new WakeController({
 createCapture:async options=>{const module=await import('../media/wake/browser-capture.ts');return new module.BrowserWakeCapture({...options,workletModuleUrl:new URL('./wake-recorder-worklet.js',import.meta.url)});},send,
 onState:state=>{wakeUI=state;const label=wakeLabels[state.phase];if(state.enabled&&label){const mode={label,phase:state.phase,keepLabel:true};if(wakeFeedbackToken===undefined||!captureFeedback.active)wakeFeedbackToken=captureFeedback.start(mode);else captureFeedback.configure(wakeFeedbackToken,mode);}else{if(wakeFeedbackToken!==undefined)captureFeedback.stop(wakeFeedbackToken);wakeFeedbackToken=undefined;}Promise.resolve().then(()=>renderUI());},
 onLevel:level=>{if(wakeFeedbackToken!==undefined)captureFeedback.level(wakeFeedbackToken,level);},
 onWake:wakeHit=>command({type:'start_voice',wakeHit},{wakeInput:true}),
 onFinish:()=>command({type:'finish_voice'},{wakeInput:true}),
 onCancel:()=>{if(wakeRequestId){wakeRequestId=null;command({type:'cancel'},{wakeInput:true});}}
});
const records=new WorkRecords({get:$,action:a=>work.action(a),onClose:()=>markVisibleWork(),onSelect:id=>work.focusRecord(id)});
const work = new WorkCard({get:$,send,open:()=>panel(true),onState:s=>records.receive(s),onRecords:origin=>records.show(origin),onToggle:()=>{markVisibleWork();restoreSelectedSource();requestedSourceFocus=true;lastUI='';renderUI();}});
let companionRoute = null;
let inputScope = null, awaitingTranscript = false;
let lastInputRow = null, lastWorkOpen = false, preserveReading = false, requestedSourceFocus=false,lastSourceId=null;
const expandedInputs=new Set();
let textRequestId = null;
let inputFocusEpoch=0, interactionFocusEpoch=0, routeFocusEpoch=0;
let composing = false;
let presentationPolicy=null;
function applyPresentationPolicy(){
  if(!renderer?.ready)return;
  const policy=presentationPolicy??{modelId:'disconnected',revision:0,enabledIds:[]};
  const applied=renderer.setAutomaticPolicy(policy);
  if(presentationPolicy)report({type:'presentation-policy',modelId:policy.modelId,revision:policy.revision,enabledCount:policy.enabledIds.length,applied:applied===true});
}
let renderer, capturing, captureAllowed = false, voicePhase = 'idle';
const pcmFrames=new PcmFrameAggregator();
let voiceRequestId = null, invitationPending = false, voiceRequestAt = 0, inputEventTiming=null;
function timedVoiceInput(at,source,run){const previous=inputEventTiming;inputEventTiming={at,source};try{return run();}finally{inputEventTiming=previous;}}
let introduction = null, introductionEpoch = 0, introductionFramePending = false;
let panelOpen = false, panelEpoch = 0, panelAnimation, panelCloseTimer;
let lastUI = '';
let awaitingTextTurn = false;
let bindingKey = false;
let managementOpening = false, managementSource = 'top';

// RP75-07: Floating speech bubble & 40s thinking state machine
const THINKING_TIMEOUT_MS = 40000;
let bubbleTimer = null;
let thinkingTimeoutTimer = null;
let currentBubbleState = 'idle';

function showBubble(text, state = 'speaking', customDwellMs = null) {
  const bubble = $('speech-bubble');
  const bubbleText = $('speech-bubble-text');
  if (!bubble || !bubbleText) return;

  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  currentBubbleState = state;
  bubble.dataset.state = state;
  bubbleText.textContent = text;
  bubble.hidden = false;

  if (state === 'speaking') {
    const dwellMs = customDwellMs ?? Math.max(6000, Math.min(10000, text.length * 150 + 4500));
    bubbleTimer = setTimeout(() => {
      dismissBubble();
    }, dwellMs);
  } else if (state === 'error') {
    bubbleTimer = setTimeout(() => {
      dismissBubble();
    }, customDwellMs ?? 6000);
  }
}

function dismissBubble() {
  const bubble = $('speech-bubble');
  if (!bubble) return;
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubble.hidden = true;
  currentBubbleState = 'idle';
}

function startThinking() {
  clearTimeout(thinkingTimeoutTimer);
  showBubble('想一想… ✦', 'thinking');
  thinkingTimeoutTimer = setTimeout(() => {
    if (currentBubbleState === 'thinking') {
      showBubble('哎呀，想太久有点走神啦，请再问我一次吧～', 'error', 6000);
      view.error = '模型思考超时';
      renderUI();
    }
  }, THINKING_TIMEOUT_MS);
}

function stopThinking() {
  clearTimeout(thinkingTimeoutTimer);
  thinkingTimeoutTimer = null;
}
function requestManagement(path, source = 'top') {
  if (managementOpening) return;
  managementOpening = true;
  managementSource = source;
  if (source === 'top') {
    $('management').disabled = true; $('management').textContent = '打开中…';
    $('management-notice').hidden = true;
  } else {
    $('function-notice').textContent = '正在打开控制台…';
  }
  native('shell', { type:'open_management', ...(path ? { path } : {}) });
}
function managementResult(result) {
  if (!managementOpening || typeof result?.ok !== 'boolean') return;
  const source = managementSource;
  managementOpening = false;
  if (source === 'top') {
    $('management').disabled = false; $('management').textContent = '控制台';
    $('management-notice').hidden = result.ok;
    $('management-notice').textContent = result.ok ? '' : '暂时无法打开控制台，请确认桌宠服务已启动后重试。';
    if (!result.ok) showToast('控制台暂不可用，请启动真实桌宠服务后重试。');
  } else if (result.ok) {
    $('function-notice').textContent = '';
    functionPanel(false);
  } else {
    const message = '当前为离线预览，控制台暂不可用；请启动真实桌宠服务后重试。';
    $('function-notice').textContent = message;
    showToast(message);
  }
}
$('management').onclick = () => requestManagement('', 'top');
const display = installDisplayControls({ get: $, shell: value => native('shell', value), setFraming: mode => renderer?.setFraming(mode) });
const hold = new PressToTalk({
  start() {
    // A fresh physical hold supersedes pending generation, output or capture cleanup.
    if (!connection.connected) return false;
    command({ type: 'start_voice' }); return true;
  },
  finish() { command({ type: 'finish_voice' }); },
  cancel(early) {
    command({ type: 'cancel' });
    view.error = early ? '录音尚未开始，已取消，未发送。请按住直到提示正在听。' : '按键录音已取消，未发送。'; renderUI();
  }
});
function hotkeyConfig(value) {
  const code = value && typeof value === 'object' ? value.code ?? null : value;
  if (!hold.configure(code)) return;
  $('hotkey-value').textContent = code ? ({ ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→', Space:'空格', Enter:'回车' }[code] ?? code.replace(/^Key|^Digit/,'')) : '未绑定';
}
function hotkeyEvent(event) {
  const receivedAt=performance.now();
  if (event.type === 'cancel') { hold.cancel(); return; }
  if (bindingKey || composing) return;
  if (event.type === 'down') timedVoiceInput(receivedAt,'native-hotkey',()=>hold.down(event.code,event.repeat));
  else if (event.type === 'up') hold.up(event.code);
}
$('hotkey-bind').onclick = () => { hold.cancel(); bindingKey = true; $('hotkey-bind').textContent = '请按一个键…'; $('hotkey-bind').focus(); };
$('hotkey-bind').onkeydown = event => {
  if (!bindingKey) return;
  event.preventDefault(); event.stopPropagation?.();
  if (event.key === 'Escape') { bindingKey = false; $('hotkey-bind').textContent = '设置按键'; return; }
  if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey || !validVoiceKey(event.code)) return;
  bindingKey = false; $('hotkey-bind').textContent = '更换按键'; hotkeyConfig(event.code);
  native('shell', { type: 'set_hotkey', code: event.code });
};
$('hotkey-clear').onclick = () => { bindingKey = false; hotkeyConfig(null); $('hotkey-bind').textContent = '设置按键'; native('shell', { type: 'set_hotkey', code: null }); };

const reconnect = document.createElement('button'); reconnect.id = 'reconnect'; reconnect.type = 'button'; reconnect.textContent = '重新连接'; reconnect.hidden = true;
$('status').after(reconnect);
reconnect.onclick = () => { if (connection.canRetry && !connection.active) { reconnect.disabled = true; native('shell', { type: 'reconnect' }); } };
// FIX61-03: startup stays cancelable and its phase is visible while the backend is launching.
const startupCancel = document.createElement('button'); startupCancel.id = 'startup-cancel'; startupCancel.type = 'button'; startupCancel.textContent = '取消启动'; startupCancel.hidden = true;
reconnect.after(startupCancel);
startupCancel.onclick = () => { if (connection.state === 'connecting') { startupCancel.disabled = true; native('shell', { type: 'cancel_startup' }); } };
const PHASE_LABELS = { starting: '正在启动', verifying: '正在校验', initializing: '正在装配', ready: '即将就绪' };
const connectionText = () => {
  if (connection.state === 'connecting' && connection.phase) {
    const progress = connection.total !== null ? ` ${connection.completed}/${connection.total}` : '';
    const elapsed = connection.elapsedMs !== null ? ` · ${Math.round(connection.elapsedMs / 1000)} 秒` : '';
    return `${PHASE_LABELS[connection.phase] ?? '正在启动'}对话服务${progress}${elapsed}`;
  }
  if (connection.state === 'connecting') return '正在连接对话服务…';
  if (connection.state === 'disconnected') return '对话服务已断开';
  // Startup failures name their reason so a visible wait is distinguishable from a broken install.
  const startupReason = { ready_timeout: '对话服务启动超时', stalled: '对话服务启动停滞，无进展', launch: '对话服务无法启动', exit: '对话服务启动后退出' }[connection.reason];
  if (connection.state === 'failed') return startupReason ?? '对话服务连接失败';
  return undefined;
};
const features = { type: 'features', secureContext: isSecureContext, mediaDevices: !!navigator.mediaDevices?.getUserMedia, audioWorklet: typeof AudioWorkletNode !== 'undefined', userAgent: navigator.userAgent, origin: location.origin };
report(features);
function renderUI() {
  wake.observe({busy:!!capturing||voicePhase!=='idle'||awaitingTextTurn||awaitingTranscript||['listening','thinking','speaking'].includes(view.state)||workSpeechView.state==='speaking',playing:playback.busy});
  const uiKey = JSON.stringify([wakeUI.phase,wakeUI.detail,awaitingTextTurn, awaitingTranscript, work.expanded,work.state?.sourceInput?.draftId,workSpeechView.state, voicePhase, chat.revision, view.reply, view.error, view.state, view.characterId, view.invitation?.id, view.invitation?.text, connection.state, connection.reason, connection.canRetry, connection.phase, connection.sequence, connection.completed, connection.total, connection.elapsedMs, introduction?.id, introduction?.text]);
  if (uiKey === lastUI) return;
  lastUI = uiKey;
  const rows = chat.rows(view.characterId).map(row => {
    const item = document.createElement('div'); item.className = `chat-row ${row.kind}`;item.dataset.rowId=String(row.id);
    const label = document.createElement('span'); label.className = 'chat-label';
    label.textContent = row.kind === 'user' ? `${row.sourceLabel??'你'}${row.status === 'sending' ? ' · 发送中' : row.status === 'failed' ? ' · 未送达' : ''}` : COMPANION_LABEL;
    const text = document.createElement('div'); text.textContent = row.text;
    item.append(label, text);
    if(row.kind==='user'&&row.text.length>140){const expanded=expandedInputs.has(row.id);text.className=expanded?'input-original':'input-original input-original-preview';const more=document.createElement('button');more.type='button';more.className='input-full-toggle';more.textContent=expanded?'收起全文':'查看输入全文';more.setAttribute('aria-expanded',String(expanded));more.onclick=()=>{if(expanded)expandedInputs.delete(row.id);else expandedInputs.add(row.id);preserveReading=true;lastUI='';renderUI();};item.append(more);}
    return item;
  });
  if (introduction) {
    const opening = document.createElement('section'); opening.id = 'introduction'; opening.className = 'introduction';
    const label = document.createElement('span'); label.className = 'introduction-label'; label.textContent = '开场 · 虚构设定';
    const text = document.createElement('div'); text.textContent = introduction.text; opening.append(label, text); rows.unshift(opening);
  }
  const log = $('reply'),scroller=$('conversation'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 36;
  const oldScroll = scroller.scrollTop, latestInput = chat.rows(view.characterId).filter(row=>row.kind==='user').at(-1)?.id;
  const sourceId=work.state?.sourceInput?.draftId;
  const sourceFocus=requestedSourceFocus||work.expanded&&(!lastWorkOpen||sourceId!==lastSourceId);
  const focusInput=sourceFocus?chat.sourceRowId(view.characterId,sourceId)??latestInput:latestInput;
  const showInput = requestedSourceFocus||latestInput!==lastInputRow||work.expanded!==lastWorkOpen||work.expanded&&sourceId!==lastSourceId;lastSourceId=sourceId;requestedSourceFocus=false;
  lastInputRow=latestInput;lastWorkOpen=work.expanded;
  log.replaceChildren(...rows);
  const inputRow=showInput?rows.find(row=>row.dataset?.rowId===String(focusInput)):null;
  if(preserveReading){scroller.scrollTop=oldScroll;preserveReading=false;}
  else if(inputRow)scroller.scrollTop=Math.max(0,(scroller.scrollTop||0)+inputRow.getBoundingClientRect().top-scroller.getBoundingClientRect().top);
  else scroller.scrollTop=nearBottom?scroller.scrollHeight:oldScroll;
  $('status').textContent = connectionText() || view.error || (workSpeechView.state==='speaking'?'正在播报任务状态…':'') || (awaitingTranscript ? '正在转写…' : '') || (voicePhase === 'preparing' ? '正在准备麦克风…' : '') || ({ idle: wakeLabels[wakeUI.phase]||(wakeUI.phase==='error'?'唤醒已停止，请在网页重新开启':'我在这里'), listening: voicePhase === 'recording' ? '正在听你说 · 再点一次结束' : '正在准备麦克风…', thinking: '正在想怎么回应你…', speaking: '正在说话…', error: '这一轮没有完成' }[view.state]);
  const isThinking = connection.connected && !view.error && !awaitingTranscript && (awaitingTextTurn || view.state === 'thinking');
  $('thinking-indicator').hidden = !isThinking;
  if (isThinking && currentBubbleState !== 'thinking') {
    startThinking();
  } else if (!isThinking && currentBubbleState === 'thinking') {
    dismissBubble();
  }
  reconnect.hidden = connection.active || !connection.canRetry; reconnect.disabled = connection.active;
  // The cancel entry exists only while a startup is still in flight and not yet answered by the user.
  startupCancel.hidden = connection.state !== 'connecting' || startupCancel.disabled;
  if (connection.state !== 'connecting') startupCancel.disabled = false;
  $('invitation').disabled = !connection.connected;
  $('voice').textContent = voicePhase === 'preparing' ? '取消准备' : voicePhase === 'recording' ? '说完了' : '开始语音';
  $('stop').hidden = (view.state === 'idle' || view.state === 'error')&&!workNotice;
  $('voice').disabled = !connection.connected || (voicePhase === 'idle' && !['idle', 'error'].includes(view.state));
  $('send').disabled = !connection.connected || chat.pending(view.characterId);
  $('invitation').hidden = !view.invitation; $('invitation').textContent = view.invitation?.text ?? '';
  if (panelOpen) fitComposer();
  scheduleIntroductionAck();
}
// This presentation is never appended to chat or submitted as user/model text.
function scheduleIntroductionAck() {
  const current = introduction, epoch = introductionEpoch;
  if (!current || current.acknowledged || introductionFramePending || !connection.connected || !panelOpen || document.hidden) return;
  const visible = () => {
    if (epoch !== introductionEpoch || introduction !== current || !connection.current(current.generation) || !connection.connected || !panelOpen || document.hidden) return false;
    const node = $('introduction');
    if (!node || !node.getClientRects().length || $('drawer').hidden) return false;
    const rect = node.getBoundingClientRect(), clip = $('conversation').getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
  };
  introductionFramePending = true;
  requestAnimationFrame(() => {
    if (!visible()) { if (epoch === introductionEpoch) introductionFramePending = false; return; }
    // Give the visible content a paint opportunity before acknowledging it.
    requestAnimationFrame(() => {
      if (epoch === introductionEpoch) introductionFramePending = false;
      if (!visible() || current.acknowledged) return;
      send({ channel: 'command', command: { type: 'acknowledge_introduction', introductionId: current.id } }, current.generation);
      current.acknowledged = true;
    });
  });
}
$('conversation').addEventListener('scroll', scheduleIntroductionAck);
function panel(open) {
  if(open&&panelOpen&&!$('drawer').hidden){scheduleIntroductionAck();return;}
  const epoch = ++panelEpoch;
  panelAnimation?.cancel(); panelAnimation = null;
  clearTimeout(panelCloseTimer);
  if (!open) {
    records.close(false);document.activeElement?.blur?.();
    bindingKey = false; $('hotkey-bind').textContent = '设置按键';
  }
  const drawer = $('drawer');
  panelOpen = open; drawer.inert = !open; $('open').hidden = open;
  $('open').setAttribute('aria-expanded', String(open));
  const animate = drawer.animate && !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const finishClose = () => { if (!panelOpen && epoch === panelEpoch && !drawer.hidden) { clearTimeout(panelCloseTimer); drawer.hidden = true; native('shell', { type: 'panel', open: false }); } };
  if (open) { drawer.hidden = false; markVisibleWork(); native('shell', { type: 'panel', open: true }); }
  if (animate && !drawer.hidden) {
    panelAnimation = drawer.animate(open ? [{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}] : [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(6px)'}], {duration:open ? 200 : 180,easing:'cubic-bezier(.2,.7,.2,1)'});
    // Occluded WKWebViews can suspend animation frames. Closing must still end.
    if (!open) panelCloseTimer = setTimeout(finishClose, 180);
    panelAnimation.finished.then(() => { if (!open) finishClose(); }, () => {});
  } else if (!open) finishClose();
  introductionEpoch++; introductionFramePending = false;
  if (open) { requestAnimationFrame(() => {
    if (panelOpen && epoch === panelEpoch && !document.hidden && document.hasFocus?.() !== false&&!records.isOpen) { fitComposer(); $('text').focus({ preventScroll: true }); }
  }); scheduleIntroductionAck(); }
}
function fitComposer() {
  const input = $('text'); input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(24, input.scrollHeight || 24))}px`;
}
// FIX61-04: the function panel is its own view, separate from the chat drawer. It shares no state with
// the conversation, so opening it never clears a draft, an active turn or the reading position.
let toastTimer, lastReportedError = '', clickThrough = false;
function showToast(message) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => { toast.hidden = true; }, 260);
  }, 3000);
}
let functionPanelOpen = false;
// FIX61-11: both view entries are now backed by real production objects (the skin console page and the
// desktop mic-test controller), so the function panel offers them instead of rendering them disabled.
const FUNCTION_CAPABILITIES = { skin: true, microphone: true };
function functionPanel(open) {
  if (functionPanelOpen === open) return;
  functionPanelOpen = open;
  const panelView = $('function-panel');
  panelView.hidden = !open;
  panelView.inert = !open;
  if (open) {
    $('function-notice').textContent = '';
    $('function-entries').focus?.({ preventScroll: true });
  }
}
function openConsole(target) {
  // The console is a local page served by this same backend. Only a same-origin path is passed; the
  // shell resolves it against the management origin and refuses anything else.
  requestManagement(target, 'function');
}
function renderFunctionPanel() {
  const entries = $('function-entries');
  entries.replaceChildren(...PANEL_ENTRIES.map(entry => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `function-${entry.id}`;
    button.textContent = entry.label;
    const wired = entry.kind !== 'view' || FUNCTION_CAPABILITIES[entry.target];
    button.disabled = !wired;
    if (entry.note) button.title = wired ? entry.note : `${entry.note}（已在开发计划中，尚未接通）`;
    button.addEventListener('click', () => {
      if (entry.kind === 'shell' && entry.action === 'open_chat') { functionPanel(false); panel(true); return; }
      if (entry.kind === 'shell' && entry.action === 'toggle_click_through') {
        functionPanel(false);
        clickThrough = !clickThrough;
        native('shell', { type: 'set_click_through', enabled: clickThrough });
        return;
      }
      if (entry.kind === 'shell' && entry.action === 'open_management') { openConsole(''); return; }
      if (entry.kind === 'console') { openConsole(entry.target); return; }
      // FIX61-11: "外观 / 换肤" is a console page (the registry is backend-owned), "麦克风" is a desktop
      // view (FIX61-07 §2 requires the trusted renderer to own the device, not the console page).
      if (wired && entry.target === 'skin') { functionPanel(false); openConsole('/#page=skins'); return; }
      if (wired && entry.target === 'microphone') { functionPanel(false); micTestPanel(true); return; }
      // A view entry whose feature is not wired yet says so instead of doing nothing silently.
      if (!wired) { $('function-notice').textContent = `${entry.label}：${entry.note ?? ''}（尚未接通）`; return; }
    });
    return button;
  }));
}
const playback = new DesktopPlaybackController(new BrowserPlaybackDriver(), scope => view.accepts(scope)||workSpeechView.accepts(scope), (requestId, event) => {
  const workOutput=workSpeechView.accepts(event.scope);
  (workOutput?workSpeechView:view).receive({type:'playback',playback:event});
  if(workOutput&&event.type==='started'&&workNotice)workNotice.started=true;
  if(workOutput&&event.type==='ended'&&workNotice?.started&&workNotice.workBinding)work.presented(workNotice.workBinding);
  if(workOutput&&['ended','stopped','error'].includes(event.type)){workNotice=null;workSpeechView.reset();}
  renderUI();
  send({ channel: 'playback', requestId, event });
  if (['ended','stopped','error'].includes(event.type)) renderer?.reset();
  if (event.type === 'started' || ['ended','stopped','error'].includes(event.type)) report({ type: 'playback-state', event: event.type, timingBasis: event.timingBasis, model: renderer?.ready ? renderer.snapshot() : null });
});
function stopPlayback(scope) { playback.stop(scope); }
function restoreSelectedSource(){const source=work.state?.sourceInput;if(work.expanded&&source&&typeof source.draftId==='string'&&typeof source.text==='string'&&isProductCharacter(source.scope?.characterId)&&['original_input','legacy_saved_input'].includes(source.provenance))chat.restoreSource(source);}
function markVisibleWork(){if(!records.isOpen&&panelOpen&&!document.hidden&&!$('drawer').hidden&&work.expanded&&!$('work-card').hidden)work.presented();}
function displayedWorkBinding(){return work.inputBinding();}
function clearWorkSpeech(){const scope=workNotice?.scope;workNotice=null;workSpeechView.reset();if(scope)stopPlayback(scope);}
function stopCapture(scope) {
  if (!scope || capturing && scopeEquals(capturing.scope, scope)) voicePhase = 'idle';
  if (!capturing || scope && !scopeEquals(capturing.scope, scope)) return;
  const active = capturing; capturing = null; captureFeedback.stop(active.feedbackToken);active.controller.abort(); active.session?.stop();
  voiceFrames.reset();
  report({ type: 'capture-stopped' });
}
/**
 * FIX61-08 live audio: the backend asks for the frame it already captured for this input session, and
 * the renderer answers with exactly that PCM16 payload. Frames are keyed by index so a request for an
 * index this renderer never captured is refused rather than answered with the wrong audio.
 */
const voiceFrames={sessions:new Map(),reset(){this.sessions.clear();},
  add(sessionId,index,pcm){let frames=this.sessions.get(sessionId);if(!frames)this.sessions.set(sessionId,frames=new Map());
    frames.set(index,pcm);while(frames.size>240){const oldest=frames.keys().next().value;frames.delete(oldest);}},
  take(sessionId,index){const frames=this.sessions.get(sessionId);const pcm=frames?.get(index);if(pcm)frames.delete(index);return pcm;}};
function answerVoiceFrame(message,generation){
  const pcm=voiceFrames.take(message.inputSessionId,message.index);
  // While the user has not spoken yet the backend asks for a frame that does not exist. That is
  // normal: answer with an empty frame so the backend asks again instead of failing the capture.
  if(!pcm||pcm.length!==message.sampleCount*2){
    send({channel:'voice_chunk',requestId:message.requestId,inputSessionId:message.inputSessionId,generation:message.generation,
      index:message.index,sampleRate:message.sampleRate,sampleCount:0,pcm:''},generation);return;}
  send({channel:'voice_chunk',requestId:message.requestId,inputSessionId:message.inputSessionId,generation:message.generation,
    index:message.index,sampleRate:message.sampleRate,sampleCount:message.sampleCount,pcm:base64(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength))},generation);
}
function command(cmd,{wakeInput=false}={}) {
  const commandEnteredAt=performance.now();
  if (!connection.connected) return;
  if(!wakeInput&&['start_voice','click_invitation','submit_text','cancel'].includes(cmd.type)){wake.pause();wakeRequestId=null;}
  if(['start_voice','submit_text'].includes(cmd.type)){const binding=displayedWorkBinding();cmd={...cmd,...(binding?{workBinding:binding}:{})};}
  if(['start_voice','click_invitation'].includes(cmd.type))voiceRequestAt=inputEventTiming?.at??commandEnteredAt;

  if (cmd.type === 'finish_voice' && voicePhase !== 'recording') {
    command({ type: 'cancel' }); view.error = '录音尚未就绪，已取消；请等到提示正在听再结束。'; renderUI(); return;
  }
  if (cmd.type === 'click_invitation' && voicePhase !== 'idle') return;
  if(['start_voice','click_invitation'].includes(cmd.type))captureFeedbackToken=wakeInput?wakeFeedbackToken:captureFeedback.start();
  else if(['finish_voice','cancel','submit_text'].includes(cmd.type)&&!wakeInput)captureFeedback.stop();
  if(['cancel','start_voice','click_invitation'].includes(cmd.type))textRequestId=null;
  if(cmd.type==='submit_text'){textRequestId=crypto.randomUUID();cmd={...cmd,clientRequestId:textRequestId};}
  if (cmd.type === 'start_voice') { voiceRequestId = crypto.randomUUID();wakeRequestId=wakeInput?voiceRequestId:null; cmd = { ...cmd, clientRequestId: voiceRequestId }; invitationPending = false; }
  if (cmd.type === 'click_invitation') { voiceRequestId = null; invitationPending = true; }
  if (['cancel', 'submit_text'].includes(cmd.type)) { voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); }
  if (['start_voice', 'click_invitation'].includes(cmd.type)) { chat.failPending(view.characterId); chat.beginVoice(view.characterId, true); }
  if (cmd.type === 'submit_text' && !chat.submit(view.characterId, cmd.text)) return;
  if (cmd.type === 'cancel') { work.forgetBinding();chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId); }
  if (['cancel','submit_text'].includes(cmd.type)) hold.clear();
  if (['cancel','submit_text','start_voice','click_invitation'].includes(cmd.type)) {
    clearWorkSpeech();workSpeechBlocked=false;inputFocusEpoch++;inputScope=null;awaitingTranscript=false;work.input(!!cmd.workBinding); routeFocusEpoch=++interactionFocusEpoch; companionRoute=null; void stopPlayback(); stopCapture(); renderer?.reset();
  }
  captureAllowed = cmd.type === 'start_voice' || cmd.type === 'click_invitation';
  if (captureAllowed) { voicePhase = 'preparing'; }
  if (cmd.type === 'finish_voice') { awaitingTranscript=true;voicePhase = 'finishing'; captureAllowed = false; if (capturing) capturing.inputEndedAt = new Date().toISOString(); }
  if (['cancel', 'submit_text', 'start_voice', 'click_invitation'].includes(cmd.type)) awaitingTextTurn = cmd.type === 'submit_text';
  view.command(cmd);
  if (cmd.type === 'start_voice') renderer?.beginAttention();
  // Dispatch explicit voice authorization before rebuilding the chat DOM.
  if (cmd.type === 'start_voice') { send({ channel: 'command', command: cmd }); report({type:'capture-command-timing',source:inputEventTiming?.source??'command',handlerToCommandMs:Math.max(0,commandEnteredAt-voiceRequestAt),handlerToSendMs:Math.max(0,performance.now()-voiceRequestAt)});renderUI(); }
  else { renderUI(); send({ channel: 'command', command: cmd }); }

}
const bytesFromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function base64(bytes) { let text = ''; for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(text); }
function connectionChanged(value) {
  if (!connection.update(value)) return;
  wake.disconnect();wakeRequestId=null;
  captureFeedback.stop();
  awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
  presentationPolicy=null;applyPresentationPolicy();
  hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId);
  introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
  chat.setDraft(view.characterId, $('text').value); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId);
  void stopPlayback(); stopCapture(); renderer?.reset(); view.reset(); view.reply = ''; view.invitation = null;
  renderUI();
  if (!connection.active) panel(true);
}
async function receive(message, generation) {
  if (!connection.current(generation)) return;
  if (message.channel === 'backend_ready') {
    if (message.bridgeVersion !== DESKTOP_BRIDGE_VERSION || !isProductCharacter(message.characterId) || typeof message.sessionId !== 'string' || !message.sessionId) {
      connectionChanged({ generation, state: 'failed', reason: 'version' });
      native('shell', { type: 'disconnect', generation }); return;
    }
    if (!connection.ready(generation)) return;
    wake.disconnect();wakeRequestId=null;
    captureFeedback.stop();
    awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
    presentationPolicy=null;applyPresentationPolicy();
    introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
    void stopPlayback(); stopCapture(); renderer?.reset();
    backendSessionId=message.sessionId;view.setSession(message.characterId, message.sessionId);workSpeechView.setSession(message.characterId,message.sessionId);
    if (message.introduction && typeof message.introduction.id === 'string' && message.introduction.id && typeof message.introduction.text === 'string' && message.introduction.text.trim()) introduction = { ...message.introduction, generation, acknowledged: false };
    $('text').value = chat.draft(view.characterId); renderUI();
    report({ type: message.channel, characterId: message.characterId, bridgeVersion: DESKTOP_BRIDGE_VERSION }); return;
  }
  if(message.channel==='wake_control'){if(!connection.connected)return;wake.control(message);return;}
  if(message.channel==='wake_result'){if(!connection.connected)return;wake.result(message);return;}
  if(message.channel==='wake_error'){if(!connection.connected)return;wake.error(message);return;}
  if (message.channel === 'backend_closed') { connectionChanged({ generation, state: 'disconnected' }); return; }
  if (!connection.connected) return;
  if(message.channel==='work_state') { if(work.receive(message.state)){markVisibleWork();if(message.state.focus==='work')restoreSelectedSource();renderUI();} return; }
  if(message.channel==='work_speech'){
    const e=message.event;
    if(!e||!e.scope||e.scope.sessionId!==backendSessionId||!isProductCharacter(e.scope.characterId)||!Number.isSafeInteger(e.inputEpoch)||e.inputEpoch!==inputFocusEpoch||typeof e.noticeId!=='string')return;
    if(e.state==='end'){if(workNotice?.noticeId===e.noticeId&&scopeEquals(workNotice.scope,e.scope)){if(playback.busy&&scopeEquals(playback.scope,e.scope))workNotice.ending=true;else clearWorkSpeech();}return;}
    if(e.state!=='start'||spokenNotices.has(e.noticeId)||workSpeechBlocked||voicePhase!=='idle'||capturing||awaitingTextTurn||['thinking','speaking','listening'].includes(view.state))return;
    clearWorkSpeech();spokenNotices.add(e.noticeId);workNotice={noticeId:e.noticeId,scope:e.scope,ending:false,workBinding:e.workBinding?structuredClone(e.workBinding):undefined};workSpeechView.scope=e.scope;renderUI();return;
  }
  if(message.channel==='input_route') {
    if(!view.accepts(message.scope)||!['companion','work'].includes(message.route))return;
    chat.route(message.scope,message.route);
    if(message.route==='work'){companionRoute=null;awaitingTextTurn=false;if(routeFocusEpoch===interactionFocusEpoch)work.routedWork();markVisibleWork();restoreSelectedSource();view.reset();renderer?.reset();}
    else {companionRoute=message.scope;work.input();}
    renderUI(); return;
  }
  if(message.channel==='presentation_policy'){
    const p=message.policy;
    if(!p||typeof p.modelId!=='string'||!Number.isSafeInteger(p.revision)||p.revision<0||!Array.isArray(p.enabledIds)||p.enabledIds.some(id=>typeof id!=='string'))return;
    if(presentationPolicy?.modelId===p.modelId&&p.revision<=presentationPolicy.revision)return;
    presentationPolicy=structuredClone(p);applyPresentationPolicy();return;
  }
  if (message.channel === 'event') {
    const e = message.event;
    if(e.type==='turn'&&e.input.kind==='text'&&(!textRequestId||e.input.clientRequestId!==textRequestId))return;
    if(e.type==='reply'&&!scopeEquals(companionRoute,e.reply.scope))return;
    if (e.type === 'turn' && e.input.kind === 'voice' && !(invitationPending && !e.input.clientRequestId) && (!voiceRequestId || e.input.clientRequestId !== voiceRequestId)) return;
    // Work presentation may reset before a late ASR event; input identity is independent.
    const accepted = e.type==='transcript' ? scopeEquals(inputScope,e.scope) : view.receive(e);
    if(accepted&&e.type==='turn')inputScope=e.input.scope;
    if(accepted&&e.type==='transcript'&&!e.interim)awaitingTranscript=false;
    if(accepted&&e.type==='error'){captureFeedback.stop();inputScope=null;awaitingTranscript=false;}
    if (accepted && ['turn', 'error'].includes(e.type)) awaitingTextTurn = false;
    if (accepted && e.type === 'turn') { if (e.input.kind === 'text') chat.acknowledge(e.input.scope, true); else chat.bindVoice(e.input.scope); }
    if (accepted && e.type === 'transcript') { if (e.interim) chat.interim(e.scope, e.text); else chat.transcript(e.scope, e.text); }
    if (accepted && e.type === 'reply' && scopeEquals(companionRoute,e.reply.scope)) {
      stopThinking();
      showBubble(e.reply.text, 'speaking');
      chat.reply(e.reply.scope, e.reply.text);
    }
    if (accepted && e.type === 'error') {
      stopThinking();
      showBubble(e.message || '这一轮没有完成，请稍后再试～', 'error', 6000);
      hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId);
    }
    if (accepted && (e.type === 'error' || e.type === 'presentation' && e.presentation.state === 'error')) { captureFeedback.stop();void stopPlayback(); stopCapture(); renderer?.reset(); }
    if (accepted && e.type === 'turn') { if (playback.scope && !scopeEquals(playback.scope, e.input.scope)) void stopPlayback(); if (capturing && !scopeEquals(capturing.scope, e.input.scope)) stopCapture(); renderer?.reset({ preserveAttention: e.input.kind === 'voice' }); }
    if (accepted) renderUI(); return;
  }
  try {
    if (message.channel === 'stop' || message.channel === 'capture_stop') {
      if (message.channel === 'stop') await stopPlayback(message.scope); else stopCapture(message.scope);
      send({ channel: 'ack', requestId: message.requestId }, generation); return;
    }
    if (message.channel === 'play') {
      const isWorkSpeech=workNotice&&!workNotice.ending&&scopeEquals(workNotice.scope,message.tts.scope);
      if(!scopeEquals(companionRoute,message.tts.scope)&&!isWorkSpeech||isWorkSpeech&&workNotice.playRequestId&&workNotice.playRequestId!==message.requestId){message.audioBase64='';send({channel:'playback',requestId:message.requestId,event:{type:'stopped',scope:message.tts.scope,at:new Date().toISOString()}});return;}
      if(isWorkSpeech)workNotice.playRequestId=message.requestId;
      if(isWorkSpeech)workSpeechView.expression=message.tts.expression??workSpeechView.expression;
      const bytes = bytesFromBase64(message.audioBase64); message.audioBase64 = '';
      await playback.play(message.requestId, message.tts, bytes);
      return;
    }
    if (message.channel === 'voice_frame') { answerVoiceFrame(message, generation); return; }
    if (message.channel === 'capture_start') {
      if (!captureAllowed || !view.accepts(message.scope)) throw new Error('录音仅能由当前主动语音轮次打开');
      const fromWake=wakeRequestId!==null&&wakeRequestId===voiceRequestId;
      if(fromWake&&!wake.pendingCapture){if(capturing?.wake&&capturing.session&&scopeEquals(capturing.scope,message.scope)){send({channel:'ack',requestId:message.requestId},generation);return;}throw new Error('唤醒录音已取消');}
      stopCapture(); voicePhase = 'preparing';
      const active = { scope: message.scope, controller: new AbortController(),feedbackToken:captureFeedbackToken,wake:fromWake,frameIndex:0 }; capturing = active;
      pcmFrames.reset();voiceFrames.reset();
      const driver = new BrowserCaptureDriver({ workletModuleUrl: new URL('./recorder-worklet.js', import.meta.url), cameraWidth: 640, jpegQuality: .8, maxBufferedSamples: 12000000,
        // FIX61-10 (FIX61-07 07-C): the conversation records from the machine-local microphone choice,
        // the same device the mic test validated. null keeps the system default; an exact id that has
        // disappeared fails loudly through the existing device-failure plane instead of switching mics.
        deviceId: microphoneTest?.selectedDeviceId() ?? null,
        // Live leg: every 2048-sample flush is framed here and kept for the backend's frame requests.
        voiceSink:block=>{for(const frame of pcmFrames.push(block)){voiceFrames.add(message.scope.turnId,active.frameIndex++,frame);}},
        onVoiceSinkError:()=>{if(capturing===active)report({type:'voice-sink-error'});},
        onLevel:level=>{if(capturing===active&&!active.controller.signal.aborted)captureFeedback.level(active.feedbackToken,level);}, onDiagnostic: event => {
        if(capturing===active){if(event.phase==='stopped')captureFeedback.stop(active.feedbackToken);report({type:'capture-timing',...event,requestElapsedMs:Math.max(0,performance.now()-voiceRequestAt)});}
      } });
      const opening=active.wake?Promise.resolve(wake.takeCapture()):driver.open(active.controller.signal);renderUI();
      active.session = await opening;
      if (capturing !== active) { active.session.stop(); throw new Error('录音轮次已取消'); }
      voicePhase = 'recording'; hold.ready(); renderUI();
      send({ channel: 'ack', requestId: message.requestId }, generation);if(active.wake)wake.captureReady(); report({ type: 'capture-ready' }); return;
    }
    if (message.channel === 'capture_finish') {
      const active = capturing;
      if (!active?.session || !scopeEquals(active.scope, message.scope)) throw new Error('没有本轮已就绪的录音');
      if(!active.wake)captureFeedback.stop(active.feedbackToken);
      const inputEndedAt = active.inputEndedAt ?? new Date().toISOString();
      const value = await active.session.finish();
      try {
        if (capturing !== active) throw new Error('采集结果已失效');
        send({ channel: 'capture', requestId: message.requestId, result: { scope: active.scope, audio: { id: crypto.randomUUID(), mimeType: 'audio/wav', base64: base64(value.audio) }, images: value.images.map(i => ({ id: crypto.randomUUID(), mimeType: i.mimeType, base64: base64(i.bytes) })), inputEndedAt, captureStoppedAt: value.captureStoppedAt } }, generation);
        capturing = null; voicePhase = 'idle'; renderUI(); report({ type: 'capture-finished', inputEndedAt, captureStoppedAt: value.captureStoppedAt });
      } finally { value.audio.fill(0); value.images.forEach(i => i.bytes.fill(0)); }
    }
  } catch (error) {
    const failure = toDeviceFailure(error), text = deviceFailureMessage(failure), scope = message.scope ?? message.tts?.scope;
    if (connection.current(generation) && message.channel.startsWith('capture') && scope && view.accepts(scope)) {
      stopCapture(scope); captureAllowed = false; hold.clear(); voiceRequestId = null; invitationPending = false;
      inputScope=null;awaitingTranscript=false;chat.cancelVoice(view.characterId); view.receive({ type: 'error', scope, message: text }); renderUI();
    }
    send({ channel: 'rpc_error', requestId: message.requestId, ...(scope ? { scope } : {}), error: failure, message: text }, generation);
  }
}
// FIX61-11 / FIX61-07: the mic test lives in this trusted renderer, not in the console page — there is no
// websocket/MCP channel, so a console-side getUserMedia would test the browser's device instead of the
// pet's. It is independent of the backend connection, so a failed backend still lets the user check
// whether the microphone itself works. Installed before petBridge is published so the shell's data
// directory delivery can reach it.
const microphoneTest = installMicrophoneTest({
  get: $,
  shell: value => native('shell', value),
  busy: () => !!capturing || voicePhase !== 'idle'
});
function micTestPanel(open) { microphoneTest?.open(open); }
window.petBridge = { receive, connectionChanged, hotkeyConfig, hotkeyEvent, displayConfig: display.receive, managementResult,
  // FIX61-11: the shell owns the microphone preference file; it reports the stored device id here so the
  // renderer never needs a path (and never imports the Node-only preference store).
  microphonePreference: deviceId => microphoneTest?.setStoredDevice(deviceId),
  clickThroughChanged: ({ enabled }) => {
    clickThrough = enabled === true;
    showToast(clickThrough ? '已开启鼠标穿透（快捷键 Ctrl+Shift+M 关闭）' : '已关闭鼠标穿透模式');
  },
  rightClickRestore: ({ x, y }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const hit = document.elementFromPoint(x, y);
    if (hit?.closest?.('#character')) pointerRouter.contextMenu({ target: { id: 'character' } });
  } };
window.desktopHost?.subscribe((method, ...args) => window.petBridge[method]?.(...args));
$('function-close').onclick = () => functionPanel(false);
renderFunctionPanel();
$('speech-bubble')?.addEventListener('click', () => dismissBubble());
$('speech-bubble-close')?.addEventListener('click', e => { e.stopPropagation(); dismissBubble(); });
$('open').onclick = () => panel(true); $('close').onclick = () => panel(false); $('quit').onclick = () => { wake.disconnect();captureFeedback.stop();void stopPlayback(); stopCapture(); native('shell', { type: 'quit' }); };
$('text').oninput = () => { clearWorkSpeech();workSpeechBlocked=true;interactionFocusEpoch++; work.input(!!displayedWorkBinding()); chat.setDraft(view.characterId, $('text').value); fitComposer(); };
$('text').oncompositionstart = () => { composing = true; };
$('text').oncompositionend = () => { composing = false; };
$('text').onkeydown = event => {
  if (event.key !== 'Enter') return;
  if (composing || event.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
  if (!event.shiftKey) { event.preventDefault(); $('form').requestSubmit(); }
};
$('form').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim();
  if (composing || event.isComposing || !text || !connection.connected || chat.pending(view.characterId)) return;
  $('text').value = ''; command({ type: 'submit_text', text });
};
$('text').onfocus = () => report({ type: 'input-focus', active: document.activeElement === $('text') });
$('voice').onclick = () => timedVoiceInput(performance.now(),'voice-button',()=>command({ type: voicePhase !== 'idle' ? 'finish_voice' : 'start_voice' }));
$('stop').onclick = () => command({ type: 'cancel' });
$('invitation').onclick = () => { if (view.invitation) { const id = view.invitation.id; view.invitation = null; panel(true); command({ type: 'click_invitation', invitationId: id }); } };
// FIX61-04: left short tap strokes locally, left drag moves the window, right button opens the function
// panel. The routing decision lives in pointer-router.ts so the same production object is unit-tested.
// A stroke never sends a command, never writes Memory and never calls the model.
const pointerRouter = new CharacterPointerRouter({
  panel: open => functionPanel(open),
  panelOpen: () => functionPanelOpen,
  drag: (dx, dy) => native('shell', { type: 'drag', dx, dy }),
  stroke: at => {
    // Respect the display toggle and reduced-motion; a model without those parameters reports why.
    const plan = renderer?.stroke ? renderer.stroke(at) : null;
    if (plan && plan.applicable === false) report({ type: 'stroke-inert', reason: plan.reason });
  }
});
$('character').onpointerdown = e => { pointerRouter.pointerDown(e); e.currentTarget.setPointerCapture(e.pointerId); };
$('character').onpointermove = e => pointerRouter.pointerMove(e);
$('character').onpointercancel = $('character').onlostpointercapture = e => pointerRouter.pointerCancel(e);
$('character').onpointerup = e => pointerRouter.pointerUp(e);
$('character').oncontextmenu = e => { e.preventDefault(); pointerRouter.contextMenu(e); };
const editing = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || ['view-full', 'view-half', 'model-resize', 'model-size', 'management'].includes(target?.id);
document.addEventListener('keydown', e => {
  const receivedAt=performance.now();
  if(e.key==='Tab'&&records.isOpen){records.tab(e);return;}
  if(e.key==='Escape'&&records.isOpen){e.preventDefault();e.stopPropagation();records.close();return;}
  if (e.key === 'Escape' && display.cancel(e)) return;
  if (bindingKey || composing || e.isComposing || e.keyCode === 229) return;
  if (!editing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && timedVoiceInput(receivedAt,'keyboard',()=>hold.down(e.code,e.repeat))) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape') {
    // Topmost first: a test session is the most modal peer view, then the function panel, then the drawer.
    if (microphoneTest?.isOpen()) { e.preventDefault(); micTestPanel(false); return; }
    if (functionPanelOpen) { e.preventDefault(); functionPanel(false); return; }
    if (playback.busy || capturing || voicePhase !== 'idle' || view.scope) command({ type: 'cancel' }); else panel(false);
  }
}, true);
document.addEventListener('keyup', e => { if (hold.up(e.code)) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('focusin', e => { if (editing(e.target)) hold.cancel(); });
window.addEventListener('blur', () => { hold.cancel(); display.cancel(); pointerRouter.pointerCancel(); });
document.addEventListener('visibilitychange', () => { introductionEpoch++; introductionFramePending = false; if (document.hidden) { hold.cancel(); display.cancel(); pointerRouter.pointerCancel(); } else scheduleIntroductionAck(); });
window.addEventListener('pagehide', () => { display.cancel(); void microphoneTest?.close(); connectionChanged({ generation: connection.generation, state: 'disconnected' }); void stopPlayback(); stopCapture(); renderer?.dispose(); });
window.addEventListener('error', e => report({ type: 'script-error', message: e.message }));
window.addEventListener('unhandledrejection', e => report({ type: 'promise-error', message: String(e.reason) }));
renderUI(); native('shell', { type: 'ready' });
let frame = 0, lastRender = 0;
try {
  renderer = new JellyfishRenderer($('model'), report); await renderer.load(); applyPresentationPolicy(); renderer.setFraming(display.mode); $('loading').hidden = true;
  function animate(at) { requestAnimationFrame(animate); if (at - lastRender > 32) { if (view.expireInvitation(Date.now())) renderUI(); const shown=workSpeechView.state==='speaking'?workSpeechView:view;renderer.updateView(shown,voicePhase==='preparing'?'listening':shown.state,work.focused&&shown===view); lastRender = at; frame++; } }
  requestAnimationFrame(animate);
  // Bounded telemetry of model parameters only, never transcript/audio/frame contents.
  let lastTrace = 0;
  setInterval(() => { if (playback.busy && performance.now() - lastTrace > 700) { lastTrace = performance.now(); report({ type: 'speaking-parameters', ...renderer.snapshot() }); } }, 500);
} catch (error) { $('loading').textContent = '模型加载失败'; view.error = error.message; report({ type: 'model-error', message: error.message, stack: error.stack }); panel(true); renderUI(); }
