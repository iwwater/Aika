import {createEmotionView} from './emotion-view.mjs';
import {createSelfSetupView} from './self-setup-view.mjs';
import {createBalancesView} from './balances-view.mjs';
import {createMemoryImportView} from './memory-import-view.mjs';
import {createWakeView} from './wake-view.mjs';
import {createPendingMemoryView} from './pending-memory-view.mjs';
import {ManagementClient,query,clone,rebase} from './api.mjs';
import {el,button,badge,notice,card,field,time,captureView,restoreView} from './dom.mjs';
import {overviewView,memoryView,modelsView,eventsView,MEMORY_SECTIONS} from './views.mjs';
import {createMemoryDynamicsView} from './memory-dynamics-view.mjs';
import {createTasksView} from './tasks-view.mjs';
import {createWeChatView} from './wechat-view.mjs';
import {createProjectsView} from './projects-view.mjs';
import {createPresentationView} from './presentation-view.mjs';
import {createSkinView} from './skin-view.mjs';
import {createHealthView} from './health-view.mjs';
import {ICONS, svgIcon} from './icons.mjs';
import {createModernOverview} from './modern-overview.mjs';
import {createModernKnowledgeView} from './modern-knowledge-view.mjs';
import {createWikiView} from './wiki-view.mjs';
import {createPlaygroundView} from './playground-view.mjs';
import {createCharacterPresetView} from './character-preset-view.mjs';
import {createPluginsView} from './plugins-view.mjs';
import {createDeveloperView} from './developer-view.mjs';
import {createModernTimelineView} from './modern-timeline-view.mjs';
import {createProactiveView} from './proactive-view.mjs';
import {createPerceptionView} from './perception-view.mjs';
import {createCollectionView} from './collection-view.mjs';
import {parseConsoleRoute, resolveCanonicalRoute, PRIMARY_PAGES, DEVELOPER_PAGE} from './routes.mjs';
import {createEpochGuard, createStatusBadge, LIFECYCLE_STATUSES} from './envelope.mjs';

const sessionKey='pet-management-session-v1';
const devModeStorageKey = 'aika_developer_mode';

export function getDeveloperMode() {
  try {
    return localStorage.getItem(devModeStorageKey) === 'true';
  } catch {
    return false;
  }
}

export function setDeveloperMode(enabled) {
  try {
    localStorage.setItem(devModeStorageKey, String(enabled));
  } catch {}
  if (!enabled) {
    invalidateTraceBodies();
  }
  render();
}

const epochGuard = createEpochGuard();

export const PRIMARY_NAV = Object.freeze([
  { id: 'dashboard', label: '运行总览', icon: ICONS.ops, page: 'dashboard', defaultSection: null },
  { id: 'knowledge', label: '知识与 Wiki', icon: ICONS.extensions, page: 'knowledge', defaultSection: 'wiki' },
  { id: 'characters', label: '角色配置', icon: ICONS.character, page: 'characters', defaultSection: 'preset' },
  { id: 'playground', label: 'Playground', icon: ICONS.config, page: 'playground', defaultSection: 'chat' },
  { id: 'plugins', label: '插件扩展', icon: ICONS.work, page: 'plugins', defaultSection: 'list' },
  { id: 'settings', label: '全局设置', icon: ICONS.connect, page: 'settings', defaultSection: 'sources' },
]);

export const DEV_NAV_ITEM = Object.freeze({
  id: 'developer',
  label: '开发者 Trace',
  icon: ICONS.ops,
  page: 'developer',
  defaultSection: 'llm',
});

export const SUBTABS_BY_CANONICAL_PAGE = Object.freeze({
  dashboard: [],
  knowledge: [
    { id: 'wiki', label: 'Wiki 知识沉淀', section: 'wiki' },
    { id: 'facts', label: '连续性记忆事实', section: 'facts' },
    { id: 'reference', label: '参考资料库', section: 'reference' },
    { id: 'import', label: '资料与记忆导入', section: 'import' },
  ],
  characters: [
    { id: 'preset', label: '角色预设 (表现/人设/模型)', section: 'preset' },
  ],
  playground: [
    { id: 'chat', label: '正式调试对话', section: 'chat' },
    { id: 'context', label: '检索与上下文试算', section: 'context' },
  ],
  plugins: [
    { id: 'list', label: '已安装插件包', section: 'list' },
    { id: 'flow', label: 'Flow 编排', section: 'flow' },
  ],
  settings: [
    { id: 'sources', label: '模型来源与凭据', section: 'sources' },
    { id: 'privacy', label: '隐私与授权感知', section: 'privacy' },
    { id: 'collection', label: '本地采集与留存', section: 'collection' },
    { id: 'work', label: '工作协议与任务', section: 'work' },
    { id: 'integrations', label: '外部集成 (微信)', section: 'integrations' },
    { id: 'diagnostics', label: '系统诊断与模块监控', section: 'diagnostics' },
    { id: 'developer_mode', label: '开发者选项', section: 'developer_mode' },
  ],
  developer: [
    { id: 'llm', label: 'LLM 对话 Trace', section: 'llm' },
    { id: 'timeline', label: '时间线与伴随详情', section: 'timeline' },
    { id: 'logs', label: '运行记录与诊断日志', section: 'logs' },
  ],
});

// Top-level module and page definitions
export const MODULES = Object.freeze([
  { id: 'ops', label: '运行', icon: ICONS.ops, defaultPage: 'overview' },
  { id: 'character', label: '角色', icon: ICONS.character, defaultPage: 'memory' },
  { id: 'config', label: '配置', icon: ICONS.config, defaultPage: 'models' },
  { id: 'connect', label: '连接', icon: ICONS.connect, defaultPage: 'wechat' },
  { id: 'extensions', label: '扩展', icon: ICONS.extensions, defaultPage: 'knowledge' },
  { id: 'work', label: '工作', icon: ICONS.work, defaultPage: 'projects' },
]);

export const SUBTABS_BY_MODULE = Object.freeze({
  ops: [
    { id: 'overview', label: '总览', page: 'overview' },
    { id: 'health', label: '模块状态', page: 'health' },
    { id: 'events', label: 'Trace', page: 'events' },
  ],
  character: [
    { id: 'characters', label: '角色与 Pack', page: 'characters' },
    { id: 'memory', label: '记忆', page: 'memory' },
    { id: 'timeline', label: '时间线', page: 'timeline' },
    { id: 'presentation', label: '表情与动作', page: 'presentation' },
  ],
  config: [
    { id: 'models', label: 'API 与模型', page: 'models' },
    { id: 'voice', label: '语音与设备', page: 'voice' },
    { id: 'perception', label: '授权感知', page: 'perception' },
    // N081-06: 本地采集是普通用户可达的隐私入口，不放在 Developer 分区。
    { id: 'collection', label: '本地采集', page: 'collection' },
    { id: 'skins', label: '外观 / 换肤', page: 'skins' },
  ],
  connect: [
    { id: 'wechat', label: '微信连接', page: 'wechat' },
  ],
  extensions: [
    { id: 'proactive', label: '主动陪伴', page: 'proactive' },
    { id: 'knowledge', label: '知识库', page: 'knowledge' },
    { id: 'packages', label: '插件包与 Flow', page: 'packages' },
  ],
  work: [
    { id: 'projects', label: '项目索引', page: 'projects' },
    { id: 'tasks', label: '任务调度', page: 'tasks' },
  ],
});

export const PAGE_LABELS = {
  overview: '运行总览',
  memory: '记忆与对话',
  projects: '项目索引',
  tasks: '任务转发',
  wechat: '微信连接',
  models: '模型与声音',
  presentation: '表情与动作',
  skins: '外观 / 换肤',
  health: '模块状态',
  events: '运行记录',
  proactive: '主动陪伴策略',
  perception: '授权感知',
  collection: '本地采集'
};
const PAGES = Object.keys(PAGE_LABELS);

export const PAGE_TITLES = {
  overview: '运行 / 总览',
  health: '运行 / 模块状态',
  events: '运行 / Trace 调用链追踪',
  characters: '角色 / 角色与 Pack 管理',
  memory: '角色 / 记忆记录与维护',
  timeline: '角色 / 双时间线 (Canon vs Companion)',
  presentation: '角色 / 表情与动作策略',
  models: '配置 / API 与模型绑定',
  voice: '配置 / 语音与设备设置',
  skins: '配置 / 外观与换肤',
  wechat: '连接 / 微信连接与通知',
  knowledge: '扩展 / 知识库与文档管理',
  proactive: '扩展 / 主动陪伴策略',
  perception: '配置 / 授权感知',
  collection: '配置 / 本地采集与留存',
  packages: '扩展 / 插件包与 Flow 流程',
  projects: '工作 / 项目工作区索引',
  tasks: '工作 / 任务调度中心',
};

export const PAGE_DESCS = {
  overview: '系统运行状态与关键指标概览，帮助你快速掌握 Aika-Next 的当前情况。',
  health: '底层模块就绪状况与设备通信诊断。',
  events: '追踪和分析每一次对话请求的完整调用链，帮助你定位问题与优化性能。',
  characters: '管理角色底色、导入资料快照、提炼草稿与版本升级。',
  memory: '管理角色的记忆记录，支持检索、筛选与维护，让每一次相遇都有迹可循。',
  timeline: '查看原作叙事时间线与当前陪伴经历时间线。',
  presentation: '配置 Live2D 动作反应、表情映射与视觉表现策略。',
  models: '管理模型供应商端点、API 凭据引用与多源槽位绑定。',
  voice: '设置麦克风输入、试音回放与本地语音唤醒配置。',
  skins: '浏览、导入与激活桌宠外观皮肤，调整窗口尺寸与缩放。',
  wechat: '配置微信连接与消息通知通道。',
  knowledge: '管理和组织你的知识库，支持多源数据与文本切片。',
  proactive: '配置主动邀请开关、免打扰时间与共享频率上限。',
  perception: '仅在你明确选择来源并确认后，临时分析单帧画面；截图不进入聊天历史。',
  collection: '按来源显式启用的本地采集试运行：键盘只记活动区间，图片留在本机受管目录，可随时暂停、删除与撤销。',
  packages: '管理 0.65 插件包状态与编排流程。',
  projects: '本地工作项目索引与代码目录映射。',
  tasks: '自动化任务转发、执行队列与状态监控。',
};

function findModuleForPage(page) {
  for (const [modId, tabs] of Object.entries(SUBTABS_BY_MODULE)) {
    if (tabs.some(t => t.page === page)) return modId;
  }
  return 'ops';
}

const SECTIONS = MEMORY_SECTIONS.map(([key]) => key);

let storedSessionToken = '';
try {
  storedSessionToken = sessionStorage.getItem(sessionKey) || '';
} catch {}

const parsedRoute = parseConsoleRoute(location.hash, storedSessionToken);
let token = parsedRoute.token;
if (token) {
  try { sessionStorage.setItem(sessionKey, token); } catch {}
}

let route = { page: parsedRoute.page, section: parsedRoute.section };

if (location.hash) {
  history.replaceState(null, '', location.pathname + location.search);
}

const app = document.getElementById('app');
const client = new ManagementClient(token);

const s = {
  page: route.page,
  canonicalPage: parsedRoute.canonicalPage || 'dashboard',
  canonicalSection: parsedRoute.canonicalSection || null,
  activeModule: findModuleForPage(route.page),
  setupMode: null,
  providerSlot: null,
  connection: 'locked',
  error: '',
  message: '',
  snapshot: null,
  character: parsedRoute.pairing.characterId || 'companion',
  pairing: parsedRoute.pairing,
  section: route.section ?? 'dynamics',
  kind: 'memory',
  query: '',
  recordState: 'active',
  offset: 0,
  pageData: null,
  selected: null,
  prompt: null,
  context: null,
  contextQuery: '',
  drafts: new Map(),
  prompts: new Map(),
  pending: new Set(),
  settingsDraft: null,
  settingsBase: null,
  settingsRevision: null,
  settingsConflict: false,
  settingsLatest: null,
  eventModule: '',
  eventKind: '',
  // Trace正文默认保持摘要；只有用户逐条查看时才按本机 History 读取。
  traceContent: new Map(),
  auto: false,
};

const presentation = createPresentationView(client, render);
const skin = createSkinView(client, render, () => ({ page: s.page, connection: s.connection, instanceId: s.snapshot?.runtime.instanceId, authEpoch }));
const health = createHealthView(client, render, () => ({ page: s.page, connection: s.connection, instanceId: s.snapshot?.runtime.instanceId, authEpoch }));
const pendingMemory = createPendingMemoryView(client, render, () => s);

function invalidateTraceBodies() { s.traceContent.clear(); }

window.addEventListener('pagehide', () => {
  balances.deactivate();
  selfSetup.dispose();
  emotion.dispose();
  proactive.dispose();
  perception.dispose();
  collection.dispose();
  memoryImport.dispose();
  presentation.dispose();
  memoryDynamics.dispose();
  projects.dispose();
  tasks.dispose();
  skin.dispose();
  health.dispose();
});

let authEpoch = 0, snapshotSequence = 0;
const reads = new Map();
const id = () => crypto.randomUUID();
const recordKey = r => r.characterId + '/' + r.kind + '/' + r.id;
const currentDraft = () => s.selected && s.drafts.get(recordKey(s.selected));

function invalidateRead(kind) {
  reads.set(kind, (reads.get(kind) || 0) + 1);
  s.pending.delete(kind);
}

const memoryDynamics = createMemoryDynamicsView(client, render, () => ({
  connection: s.connection,
  character: s.character,
  instanceId: s.snapshot?.runtime.instanceId,
  authEpoch,
  snapshot: s.snapshot,
  onError: error,
  onMemoryForgotten: invalidateTraceBodies,
  openRecord: r => { s.section = 'records'; s.kind = r.kind; s.query = ''; s.offset = 0; selectRecord(r); loadRecords(); },
  showSection: section => { s.section = section; render(); },
  openSection: section => { s.section = section; render(); loadMemorySection(); },
  openMaintenanceSettings: () => { s.providerSlot = 'memory_turn'; selectPage('models'); },
  openEvents: () => selectPage('events'),
}));

const projects = createProjectsView(client, render, () => ({ connection: s.connection, instanceId: s.snapshot?.runtime.instanceId, authEpoch, onError: error }));
const tasks = createTasksView(client, render, () => ({ connection: s.connection, instanceId: s.snapshot?.runtime.instanceId, authEpoch, onError: error }));
const wechat = createWeChatView(client, render, () => ({ page: s.page, connection: s.connection, instanceId: s.snapshot?.runtime.instanceId, authEpoch, onError: error }));
const wake = createWakeView(client, render, () => ({ page: s.page, connection: s.connection, instanceId: s.snapshot?.runtime.instanceId, authEpoch, onError: error }));
const memoryImport = createMemoryImportView(client, render, () => ({ page: s.page, section: s.section, connection: s.connection, instanceId: s.snapshot?.runtime.instanceId, authEpoch, onError: error }));
const balances = createBalancesView(client, render, () => s);
const selfSetup = createSelfSetupView(client, render, () => ({ page: s.page, connection: s.connection, authEpoch, onError: error, onMode: mode => { s.setupMode = mode; if (mode === 'first-run') s.connection = 'online'; } }));
const emotion = createEmotionView(client, render, () => ({ page: s.page, section: s.section, connection: s.connection, character: s.character, instanceId: s.snapshot?.runtime.instanceId, authEpoch, onError: error }));
const proactive = createProactiveView(client, render, () => ({ page: s.page, pairing: s.pairing, connection: s.connection }));
const perception = createPerceptionView(client, render, () => ({ page: s.page, connection: s.connection }));
const collection = createCollectionView(client, render, () => ({ page: s.page, connection: s.connection }));

const actions = {
  client,
  emotion, selfSetup, balances, wake, memoryImport, memoryDynamics,
  s, render, currentDraft, selectPage, selectModule, selectCanonicalPage,
  getDeveloperMode, setDeveloperMode, epochGuard, error,
  loadRecords, loadPrompt, loadContext,
  selectRecord, saveRecord, forgetRecord, savePrompt, saveSettings, rollbackSettings, refreshSnapshot,
  editSetting, reviewSettings, reviewPrompt, reviewRecord,
};

function error(e) {
  if (e.name === 'AbortError') return;
  if (e.status === 401 || e.status === 403) {
    s.connection = 'locked';
    s.error = '本机会话已失效，请从本机管理入口重新打开，或重新连接。未保存编辑仍保留。';
  } else {
    s.error = e.message;
    if (!e.status || e.status >= 500) s.connection = 'offline';
  }
  render();
}

async function write(key, fn, role = null) {
  const auth = authEpoch;
  if (s.pending.has(key)) return;
  s.pending.add(key);
  s.error = '';
  s.message = '';
  render();
  try {
    await fn();
  } catch (e) {
    if (auth === authEpoch && (!role || role === s.character)) error(e);
  } finally {
    s.pending.delete(key);
    render();
  }
}

async function read(kind, url, accept) {
  const seq = (reads.get(kind) || 0) + 1;
  reads.set(kind, seq);
  const auth = authEpoch;
  s.pending.add(kind);
  render();
  try {
    const data = await client.request(url);
    if (reads.get(kind) !== seq || auth !== authEpoch) return;
    if (data.characterId !== s.character) throw Error('服务返回的角色与本次查询不一致，内容未显示。');
    accept(data);
  } catch (e) {
    if (reads.get(kind) === seq && auth === authEpoch) error(e);
  } finally {
    if (reads.get(kind) === seq) {
      s.pending.delete(kind);
      render();
    }
  }
}

async function refreshSnapshot() {
  if (!client.token) return;
  const seq = ++snapshotSequence, auth = authEpoch;
  s.pending.add('snapshot');
  render();
  try {
    const setup = await selfSetup.refresh();
    if (seq !== snapshotSequence || auth !== authEpoch) return;
    if (setup?.mode === 'first-run') {
      s.connection = 'online';
      s.error = '';
      return;
    }
    const snap = await client.request('/api/snapshot');
    if (seq !== snapshotSequence || auth !== authEpoch) return;
    if (snap.apiVersion !== 1 || snap.runtime?.online !== true) throw Error('当前服务不支持这版管理界面。');
    if (snap.runtime.characterId !== 'companion' || !Array.isArray(snap.characters) || snap.characters.length !== 1 || snap.characters[0].id !== 'companion') {
      throw Error('当前服务与单角色版本不匹配，请从新版管理入口重新打开。');
    }
    if (s.snapshot && s.snapshot.runtime.instanceId !== snap.runtime.instanceId) {
      s.message = '连接已更新。未保存编辑已保留，请读取最新内容并核对。';
      for (const d of s.drafts.values()) d.conflict = true;
      for (const d of s.prompts.values()) d.conflict = true;
      if (s.settingsDraft) s.settingsConflict = true;
    }
    s.snapshot = snap;
    s.connection = 'online';
    s.error = '';
    if (!s.settingsDraft) {
      s.settingsDraft = clone(snap.settings.saved);
      s.settingsBase = clone(snap.settings.saved);
      s.settingsRevision = snap.settings.revision;
    } else if (s.settingsRevision !== snap.settings.revision) {
      s.settingsConflict = true;
    }
    s.settingsLatest = snap.settings;
    if (s.page === 'memory') loadMemorySection();
    if (s.page === 'projects') projects.refresh();
    if (s.page === 'tasks') tasks.refresh();
    if (s.page === 'wechat') wechat.refresh();
    if (s.page === 'proactive') proactive.refresh();
    if (s.page === 'perception') perception.refresh();
    if (s.page === 'collection') collection.refresh();
  } catch (e) {
    console.error('REFRESH_SNAPSHOT_ERROR:', e);
    if (seq === snapshotSequence && auth === authEpoch) error(e);
  } finally {
    if (seq === snapshotSequence) {
      s.pending.delete('snapshot');
      render();
    }
  }
}

function selectModule(moduleId) {
  const mod = MODULES.find(m => m.id === moduleId);
  if (!mod) return;
  s.activeModule = moduleId;
  selectPage(mod.defaultPage);
}

function selectPage(page) {
  if (page !== 'overview') balances.deactivate();
  if (page !== 'presentation') presentation.deactivate();
  if (page !== 'skins') skin.dispose();
  if (page !== 'health') health.dispose();
  if (page !== 'perception') void perception.leave();
  if (page !== 'collection') void collection.leave();
  s.page = page;
  s.activeModule = findModuleForPage(page);
  s.error = '';
  s.message = '';
  render();
  if (page === 'tasks') tasks.refresh();
  if (page === 'projects') projects.refresh();
  if (page === 'proactive') proactive.refresh();
  if (page === 'perception') perception.refresh();
  if (page === 'collection') collection.refresh();
  if (page === 'memory') {
    loadMemorySection();
    pendingMemory.load();
  }
}

export function selectCanonicalPage(page, section = null) {
  epochGuard.next();
  if (page !== 'dashboard') balances.deactivate();
  if (page !== 'characters' || section !== 'presentation') presentation.deactivate();
  if (page !== 'characters' || section !== 'appearance') skin.dispose();
  if (page !== 'settings' || section !== 'diagnostics') health.dispose();
  if (page !== 'settings' || section !== 'privacy') void perception.leave();
  // N081-06: 本地采集位于配置分区，离开该分区即释放缩略图。
  if (page !== 'settings' || section !== 'collection') void collection.leave();

  s.canonicalPage = page;
  const tabs = SUBTABS_BY_CANONICAL_PAGE[page] || [];
  s.canonicalSection = section || (tabs[0]?.section ?? null);

  // Sync backward compatibility fields
  s.page = page === 'dashboard' ? 'overview' : (page === 'developer' ? 'events' : page);
  s.section = s.canonicalSection;

  s.error = '';
  s.message = '';

  const canonicalParams = new URLSearchParams();
  if (s.canonicalPage !== 'dashboard') canonicalParams.set('page', s.canonicalPage);
  if (s.canonicalSection) canonicalParams.set('section', s.canonicalSection);
  if (s.pairing?.characterId && s.pairing.characterId !== 'companion') canonicalParams.set('character', s.pairing.characterId);
  const targetHash = canonicalParams.toString() ? `#${canonicalParams.toString()}` : '';
  history.replaceState(null, '', location.pathname + location.search + targetHash);

  render();

  if (page === 'settings' && s.canonicalSection === 'work') { tasks.refresh(); projects.refresh(); }
  if (page === 'settings' && s.canonicalSection === 'privacy') proactive.refresh();
  if (page === 'characters' && s.canonicalSection === 'persona') loadPrompt();
  if (page === 'characters' && s.canonicalSection === 'appearance') skin.sync();
  if (page === 'characters' && s.canonicalSection === 'presentation') presentation.activate();
  if (page === 'characters' && s.canonicalSection === 'emotion') emotion.refresh();
  if (page === 'knowledge' && s.canonicalSection === 'import') memoryImport.refresh();
}

function loadMemorySection() {
  if (!client.token) return;
  if (s.section === 'records') loadRecords();
  else if (s.section === 'prompt') loadPrompt();
  else if (s.section === 'context') loadContext();
  else if (s.section === 'emotion') emotion.refresh();
  else if (s.section === 'import') memoryImport.refresh();
  else memoryDynamics.load(s.section);
}

function loadRecords() {
  const q = { characterId: s.character, kind: s.kind, query: s.query, offset: s.offset, limit: 25, state: s.recordState };
  return read('records', query('/api/records', q), data => {
    if (data.records.some(r => r.characterId !== s.character)) throw Error('查询结果包含其他角色，已拒绝显示。');
    s.pageData = data;
    if (s.selected) {
      const latest = data.records.find(r => r.id === s.selected.id && r.kind === s.selected.kind);
      const draft = currentDraft();
      if (latest && draft) {
        draft.latest = latest;
        if (latest.version !== draft.version) draft.conflict = true;
      }
      if (latest) s.selected = latest;
    }
  });
}

function loadPrompt() {
  return read('prompt', query('/api/prompt', { characterId: s.character }), data => {
    s.prompt = data;
    let d = s.prompts.get(data.characterId);
    if (!d) {
      d = { text: data.text, original: data.text, version: data.revision, operationId: id(), conflict: false };
      s.prompts.set(data.characterId, d);
    } else if (d.version !== data.revision) {
      d.conflict = true;
    }
    d.latest = data;
  });
}

function loadContext() {
  return read('context', query('/api/context', { characterId: s.character, query: s.contextQuery }), data => {
    if ([...data.recent, ...data.summaries, ...data.memories].some(r => r.characterId !== s.character)) {
      throw Error('上下文包含其他角色，已拒绝显示。');
    }
    s.context = data;
  });
}

function selectRecord(record) {
  s.selected = record;
  const key = recordKey(record);
  let d = s.drafts.get(key);
  if (!d) {
    d = { text: record.text, reason: '', version: record.version, original: record.text, operationId: id(), conflict: false };
    s.drafts.set(key, d);
  }
  d.latest = record;
  if (d.version !== record.version) d.conflict = true;
  render();
}

function reviewRecord() {
  const d = currentDraft();
  if (!d?.latest || !d.latest.editable) return;
  d.version = d.latest.version;
  d.original = d.latest.text;
  d.conflict = false;
  d.operationId = id();
  render();
}

function saveRecord() {
  const record = s.selected, d = currentDraft();
  if (!record || !d || d.conflict || !record.editable || s.connection !== 'online') return;
  const role = record.characterId, key = 'edit/' + recordKey(record), text = d.text, operationId = d.operationId, auth = authEpoch;
  invalidateRead('records');
  return write(key, async () => {
    try {
      const result = await client.request('/api/records/edit', {
        method: 'POST',
        body: { characterId: role, id: record.id, expectedVersion: d.version, operationId, text, reason: d.reason },
      });
      if (result.status !== 'applied' || result.characterId !== role || result.operationId !== operationId || result.record.characterId !== role) {
        throw Error('保存回执不匹配，请读取最新记录核对。');
      }
      d.version = result.record.version;
      d.latest = result.record;
      d.original = text;
      d.conflict = false;
      d.operationId = id();
      if (auth === authEpoch && role === s.character) {
        if (s.selected && recordKey(s.selected) === recordKey(record)) s.selected = result.record;
        s.message = `记录已更新；${result.invalidatedIds.length} 条关联检索或上下文记录已失效。`;
        await loadRecords();
      }
    } catch (e) {
      if (e.status === 409) {
        d.conflict = true;
        if (role === s.character) {
          s.message = '记录已在其他位置变化。草稿已保留，请读取最新列表，找到同一记录后对比。';
          await loadRecords();
        }
      } else throw e;
    }
  }, role);
}

function forgetRecord() {
  const record = s.selected, d = currentDraft();
  if (!record || !d || d.conflict || s.connection !== 'online') return;
  const role = record.characterId, key = 'forget/' + recordKey(record), operationId = id(), auth = authEpoch;
  const reason = (d.reason && d.reason.trim()) || '用户在长期记忆详情界面要求删除/遗忘此记忆';
  invalidateRead('records');
  return write(key, async () => {
    try {
      const result = await client.request('/api/memory/forget', {
        method: 'POST',
        body: { characterId: role, id: record.id, expectedVersion: d.version, operationId, reason },
      });
      s.selected = null;
      s.confirmForget = null;
      s.message = `记忆已遗忘；服务报告 ${result.affectedIds?.length || 1} 条记录受影响。`;
      await loadRecords();
    } catch (e) {
      if (e.status === 409) {
        d.conflict = true;
        s.message = '记录已在其他位置变化，请读取最新列表后核对。';
        await loadRecords();
      } else {
        s.error = e.message || '遗忘操作失败，请重试。';
        s.confirmForget = null;
        render();
      }
    }
  }, role);
}

function reviewPrompt() {
  const d = s.prompts.get(s.character);
  if (!d?.latest) return;
  d.version = d.latest.revision;
  d.original = d.latest.text;
  d.conflict = false;
  d.operationId = id();
  render();
}

function savePrompt() {
  const role = s.character, d = s.prompts.get(role);
  if (!d || d.conflict || s.connection !== 'online') return;
  const text = d.text, operationId = d.operationId, auth = authEpoch;
  invalidateRead('prompt');
  return write('prompt-save/' + role, async () => {
    try {
      const result = await client.request('/api/prompt', {
        method: 'PUT',
        body: { characterId: role, expectedRevision: d.version, text, operationId },
      });
      if (result.characterId !== role) throw Error('角色设定保存回执不匹配。');
      d.version = result.revision;
      d.original = text;
      d.latest = result;
      d.operationId = id();
      d.conflict = false;
      if (auth === authEpoch && role === s.character) {
        s.prompt = result;
        s.message = '角色设定已更新；后续上下文使用新版本。';
      }
    } catch (e) {
      if (e.status === 409) {
        d.conflict = true;
        if (role === s.character) {
          s.message = '角色设定发生版本冲突，草稿已保留。';
          await loadPrompt();
        }
      } else throw e;
    }
  }, role);
}

function editSetting(path, value) {
  let target = s.settingsDraft;
  for (const key of path.slice(0, -1)) target = target[key];
  if (value === undefined) delete target[path.at(-1)];
  else target[path.at(-1)] = value;
}

function reviewSettings() {
  if (!s.settingsLatest) return;
  s.settingsDraft = rebase(s.settingsBase, s.settingsDraft, s.settingsLatest.saved);
  s.settingsBase = clone(s.settingsLatest.saved);
  s.settingsRevision = s.settingsLatest.revision;
  s.settingsConflict = false;
  render();
}

function acceptSettings(settings) {
  s.snapshot.settings = settings;
  s.settingsLatest = settings;
  s.settingsDraft = clone(settings.saved);
  s.settingsBase = clone(settings.saved);
  s.settingsRevision = settings.revision;
  s.settingsConflict = false;
  s.message = settings.pending
    ? `配置已保存为版本 ${settings.revision}，当前仍运行版本 ${settings.effectiveRevision}。重新启动桌宠后生效。`
    : `配置已保存，当前有效版本 ${settings.effectiveRevision}。`;
}

function saveSettings() {
  if (s.settingsConflict || s.connection !== 'online' || !selfSetup.validBindings(s.settingsDraft)) return;
  return write('settings', async () => {
    try {
      acceptSettings(await client.request('/api/settings', {
        method: 'PUT',
        body: { expectedRevision: s.settingsRevision, settings: clone(s.settingsDraft) },
      }));
    } catch (e) {
      if (e.status === 409) {
        s.settingsConflict = true;
        s.message = '配置已在其他位置更新。草稿已保留，请核对差异后再保存。';
        await refreshSnapshot();
      } else throw e;
    }
  });
}

function rollbackSettings(targetRevision) {
  if (s.connection !== 'online' || s.settingsConflict) return;
  return write('settings', async () => {
    try {
      acceptSettings(await client.request('/api/settings/rollback', {
        method: 'POST',
        body: { expectedRevision: s.settingsRevision, targetRevision },
      }));
    } catch (e) {
      if (e.status === 409) {
        s.settingsConflict = true;
        s.message = '回滚前配置已变化，本次没有覆盖新版本。';
        await refreshSnapshot();
      } else throw e;
    }
  });
}

function connect(value) {
  client.token = value.trim();
  try { sessionStorage.setItem(sessionKey, client.token); } catch {}
  invalidateTraceBodies();
  authEpoch++;
  s.error = '';
  refreshSnapshot();
}

function render() {
  captureView(app);
  emotion.sync();
  selfSetup.sync();

  if (selfSetup.isComposing()) return;
  if (s.setupMode === 'first-run' && s.connection !== 'locked') {
    app.replaceChildren(
      el(
        'main',
        { class: 'main-canvas setup-first-run' },
        el(
          'header',
          { class: 'page-header' },
          el('h1', { class: 'page-title' }, '准备你的桌宠'),
          el('p', { class: 'page-desc' }, '先完成配置，再启动陪伴。'),
        ),
        selfSetup.view(),
      ),
    );
    restoreView(app, 'first-run');
    return;
  }

  balances.sync();
  pendingMemory.sync();
  memoryImport.sync();
  wake.sync();
  memoryDynamics.sync();
  projects.sync();
  tasks.sync();
  wechat.sync();
  skin.sync();
  health.sync();

  if (s.page !== 'presentation' || s.connection !== 'online') presentation.deactivate();

  // 1. Top Navbar
  const currentMod = findModuleForPage(s.page);
  const navbarBrand = el(
    'div',
    { class: 'navbar-brand-group' },
    svgIcon(ICONS.logo, 'brand-logo-svg'),
    el(
      'div',
      { class: 'brand-titles' },
      el('span', { class: 'brand-name' }, 'Aika-Next'),
      el('span', { class: 'brand-sub' }, 'AI 工作伙伴'),
    ),
  );

  // 1. Top Navbar: Modern 6-entry primary navigation + conditional Developer Mode tab
  const devModeActive = getDeveloperMode();
  const navItems = [...PRIMARY_NAV];
  if (devModeActive) {
    navItems.push(DEV_NAV_ITEM);
  }

  const navModules = el(
    'nav',
    { class: 'navbar-nav', role: 'tablist', 'aria-label': '模块导航' },
    navItems.map(item =>
      el(
        'button',
        {
          type: 'button',
          class: `nav-module-btn ${item.page === s.canonicalPage ? 'is-active' : ''} ${item.id === 'developer' ? 'dev-mode-tab' : ''}`,
          onClick: () => selectCanonicalPage(item.page, item.defaultSection),
        },
        svgIcon(item.icon, 'module-icon'),
        el('span', {}, item.label),
        item.id === 'developer' ? el('span', { class: 'dev-badge', style: 'font-size:10px; padding:1px 5px; border-radius:3px; background:#475569; color:#f8fafc; margin-left:4px; vertical-align:middle;' }, 'DEV') : null
      ),
    ),
  );

  const navbarUtils = el(
    'div',
    { class: 'navbar-utils' },
    el(
      'div',
      { class: 'scope-pill' },
      el('span', {}, `作用域: ${s.pairing?.characterId === 'companion' ? '本机' : s.pairing?.characterId || '本机'}`),
    ),
    el(
      'div',
      { class: 'avatar-badge-wrap', title: 'Aika 在线' },
      el('img', {
        src: './assets/aika-avatar.png',
        class: 'user-avatar-img',
        alt: 'User',
        onError: e => {
          e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><rect width="34" height="34" rx="17" fill="%23e0e7ff"/><text x="50%" y="54%" font-size="16" text-anchor="middle" dominant-baseline="middle" fill="%234f46e5">A</text></svg>';
        },
      }),
      el('span', { class: 'avatar-online-dot' }),
    ),
  );

  const navbar = el('header', { class: 'app-navbar' }, navbarBrand, navModules, navbarUtils);

  // 2. Sub-Header Bar
  const subtabs = SUBTABS_BY_CANONICAL_PAGE[s.canonicalPage] || [];
  const subnav = subtabs.length > 0 ? el(
    'div',
    { class: 'sub-nav-tabs', role: 'tablist', 'aria-label': '子页面导航' },
    subtabs.map(tab =>
      el(
        'button',
        {
          type: 'button',
          class: `sub-nav-tab ${(tab.section === s.canonicalSection || (!s.canonicalSection && tab === subtabs[0])) ? 'is-active' : ''}`,
          onClick: () => selectCanonicalPage(s.canonicalPage, tab.section),
        },
        tab.label,
      ),
    ),
  ) : el('div', { class: 'sub-nav-tabs-empty', style: 'display:none;' });

  const submeta = el(
    'div',
    { class: 'sub-nav-meta' },
    el(
      'span',
      {},
      `最后更新时间：${s.snapshot ? time(s.snapshot.runtime.observedAt) : time(Date.now())}`,
    ),
    button(
      '刷新',
      refreshSnapshot,
      {
        class: 'refresh-btn',
        id: 'refresh',
        disabled: !client.token || s.pending.has('snapshot'),
      },
    ),
  );

  const subHeader = el('nav', { class: 'sub-header-bar' }, subnav, submeta);

  // 3. Main Content Area
  const sidebarNav = el(
    'nav',
    { class: 'nav sidebar-nav-compat', role: 'tablist', 'aria-label': '控制台页面', style: 'display:none;' },
    PAGES.map(key =>
      button(PAGE_LABELS[key], () => selectPage(key), {
        role: 'tab',
        'aria-selected': s.page === key,
        id: 'nav-' + key,
      }),
    ),
  );

  const canonicalTitles = {
    dashboard: '运行总览 · Dashboard',
    knowledge: '知识与 Wiki · Knowledge',
    characters: '角色配置与链路 · Characters',
    playground: '正式调试 · Playground',
    plugins: '插件与扩展 · Plugins',
    settings: '系统设置 · Settings',
    developer: '开发者调试 · Developer Mode',
  };
  const canonicalDescs = {
    dashboard: '系统运行状态与关键指标概览，提供快捷入口与数据一览。',
    knowledge: '已沉淀知识 Wiki、连续性记忆事实与参考资料管理。',
    characters: '管理角色底色、人设 Persona、外观与音色模型链路。',
    playground: '进行正式轮次交互测试，验证有效模型绑定与上下文。',
    plugins: '管理本地插件包启停状态、依赖与高级编排。',
    settings: '全局模型来源凭据、默认设备、隐私陪伴授权与系统诊断。',
    developer: '调用链追踪 (LLM Trace)、原始时间线与底层诊断日志。',
  };

  const currentTabLabel = subtabs.find(t => t.section === s.canonicalSection)?.label;
  const pageHeader = el(
    'header',
    { class: 'page-header topbar' },
    el('p', { class: 'page-eyebrow' }, canonicalTitles[s.canonicalPage] || s.canonicalPage),
    el('h1', { class: 'page-title' }, currentTabLabel || canonicalTitles[s.canonicalPage] || s.canonicalPage),
    el('p', { class: 'page-desc' }, canonicalDescs[s.canonicalPage] || ''),
  );

  const main = el(
    'main',
    { class: 'main-canvas' },
    pageHeader,
    s.error && notice(s.error, 'error'),
    s.message && notice(s.message, 'success'),
  );

  if (s.connection === 'locked') {
    const form = el(
      'form',
      {
        class: 'card login',
        onSubmit: e => {
          e.preventDefault();
          connect(e.target.elements.session.value);
        },
      },
      el('h2', {}, '连接本机管理会话'),
      el('p', { class: 'subtle' }, '请从桌宠的本机管理入口打开此页。会话失效后重新打开即可；如需手动连接，可粘贴该入口提供的会话口令。'),
      field('本机会话口令', 'session', '', () => {}, { type: 'password', required: true, autocomplete: 'off' }),
      el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary' }, '连接')),
    );
    main.append(form);
  } else if (s.snapshot) {
    if (s.connection !== 'online') {
      main.append(notice('以下保留上次快照及本页草稿，暂时无法确认实时状态；保存已停用。', 'warning'));
    }

    // 门禁检查：如果当前访问 developer 但开发者模式未开启
    if (s.canonicalPage === 'developer' && !getDeveloperMode()) {
      main.append(
        el('div', { class: 'card dev-mode-gate', style: 'max-width: 680px; margin: 40px auto; padding: 32px; border-radius: 12px; border: 1px solid var(--border-color, #e2e8f0); background: var(--surface, #ffffff); box-shadow: 0 4px 12px rgba(0,0,0,0.05);' },
          el('h2', { style: 'margin-top: 0; color: #1e293b; display: flex; align-items: center; gap: 8px;' }, '🛠️ 开发者模式尚未启用'),
          el('p', { class: 'subtle', style: 'line-height: 1.6; margin: 16px 0;' },
            '当前请求的目标页面属于底层调试区（含 LLM Trace 调用链、记忆整理元数据、原始时间线或运行时日志）。为了保护数据隐私并消除无谓的网络与内存开销，这些内容仅在显式开启开发者模式时加载。'
          ),
          el('p', { class: 'subtle', style: 'line-height: 1.6; margin-bottom: 24px;' },
            '开发者模式偏好仅存储于本机浏览器，不影响后端权限，未开启时绝不预取敏感调用链。'
          ),
          el('div', { class: 'actions', style: 'display: flex; gap: 12px;' },
            button('🚀 立即在此开启开发者模式', () => {
              setDeveloperMode(true);
            }, { class: 'primary' }),
            button('返回运行总览 (Dashboard)', () => {
              selectCanonicalPage('dashboard');
            }, { class: 'secondary' })
          )
        )
      );
    } else if (s.canonicalPage === 'dashboard') {
      main.append(createModernOverview(actions));
    } else if (s.canonicalPage === 'knowledge') {
      if (s.canonicalSection === 'reference') {
        main.append(createModernKnowledgeView(actions));
      } else if (s.canonicalSection === 'facts' || s.canonicalSection === 'dynamics' || s.canonicalSection === 'fragments') {
        main.append(el('div', { class: 'page-content' }, memoryDynamics.view()));
      } else if (s.canonicalSection === 'import') {
        main.append(el('div', { class: 'page-content' }, memoryImport.view()));
      } else {
        main.append(el('div', { class: 'page-content' }, createWikiView(actions)));
      }
    } else if (s.canonicalPage === 'characters') {
      if (s.canonicalSection === 'models') {
        main.append(el('div', { class: 'page-content' }, modelsView(actions)));
      } else if (s.canonicalSection === 'persona') {
        s.section = 'prompt';
        main.append(el('div', { class: 'page-content' }, memoryView(actions)));
      } else if (s.canonicalSection === 'appearance') {
        if (s.connection === 'online') main.append(el('div', { class: 'page-content' }, skin.view()));
      } else if (s.canonicalSection === 'presentation') {
        if (s.connection === 'online') main.append(el('div', { class: 'page-content' }, presentation.view()));
      } else if (s.canonicalSection === 'emotion') {
        main.append(el('div', { class: 'page-content' }, emotion.view()));
      } else {
        main.append(el('div', { class: 'page-content' }, createCharacterPresetView(actions)));
      }
    } else if (s.canonicalPage === 'playground') {
      if (s.canonicalSection === 'context') {
        s.section = 'context';
        main.append(el('div', { class: 'page-content' }, memoryView(actions)));
      } else {
        main.append(el('div', { class: 'page-content' }, createPlaygroundView(actions)));
      }
    } else if (s.canonicalPage === 'plugins') {
      main.append(el('div', { class: 'page-content' }, createPluginsView(actions)));
    } else if (s.canonicalPage === 'settings') {
      if (s.canonicalSection === 'developer_mode') {
        const isDev = getDeveloperMode();
        main.append(el('div', { class: 'page-content' },
          card('开发者模式设置',
            el('p', { class: 'subtle' }, '控制控制台是否显示底层调用链 (LLM Trace)、原始时间线 (Timeline) 和日志诊断。'),
            el('div', { style: 'margin: 20px 0; display: flex; align-items: center; gap: 16px;' },
              el('span', { style: 'font-weight: 500;' }, '当前开发者模式状态：'),
              createStatusBadge(isDev ? 'ready' : 'disabled', isDev ? '已开启' : '已关闭'),
              button(isDev ? '关闭开发者模式' : '开启开发者模式', () => {
                setDeveloperMode(!isDev);
              }, { class: isDev ? 'secondary' : 'primary' })
            ),
            el('small', { class: 'subtle' }, '开启后将在主导航栏展现【开发者 Trace】入口；关闭时立即释放 Trace 轮询并清空内存缓存。')
          )
        ));
      } else if (s.canonicalSection === 'privacy') {
        main.append(proactive.view());
        if (s.connection === 'online') main.append(perception.view());
        if (s.connection === 'online') main.append(collection.view());
      } else if (s.canonicalSection === 'work') {
        main.append(el('div', { class: 'page-content' }, tasks.view()));
        main.append(el('div', { class: 'page-content' }, projects.view()));
      } else if (s.canonicalSection === 'integrations') {
        main.append(el('div', { class: 'page-content' }, wechat.view()));
      } else if (s.canonicalSection === 'diagnostics') {
        if (s.connection === 'online') main.append(el('div', { class: 'page-content' }, health.view()));
      } else {
        main.append(el('div', { class: 'page-content' }, modelsView(actions)));
      }
    } else if (s.canonicalPage === 'developer') {
      main.append(el('div', { class: 'page-content' }, createDeveloperView(actions)));
    } else {
      main.append(el('div', { class: 'card empty' }, `页面 "${s.canonicalPage}" 正在准备中...`));
    }
  } else if (s.connection !== 'locked') {
    main.append(notice('正在读取运行状态…'));
  }

  // 4. Footer
  const footer = el(
    'footer',
    { class: 'app-footer' },
    el('span', {}, 'Aika-Next v0.8.0 | Be with you, always.'),
    el('span', {}, '与你在一起，就是最好的未来。 ♡'),
  );

  app.replaceChildren(el('div', { class: 'app-shell' }, navbar, subHeader, sidebarNav, main, footer));
  restoreView(app, s.page + '/' + (s.page === 'memory' ? s.section : ''));
  tasks.afterRender();
  pendingMemory.afterRender();
}

window.selectCanonicalPage = selectCanonicalPage;
window.selectPage = selectPage;

window.addEventListener('hashchange', () => {
  const p = parseConsoleRoute(location.hash, storedSessionToken);
  if (p.canonicalPage) {
    selectCanonicalPage(p.canonicalPage, p.canonicalSection);
  } else if (p.page) {
    selectPage(p.page);
  }
});

render();
if (token) refreshSnapshot();
