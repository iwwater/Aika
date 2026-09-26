// Aika console view: a thin shell over the /api/aika/* routes plus the model form. All validation and
// state transitions live in the backend; this file only fetches, renders and posts forms.
//
// FIX61-02 boundary: this page does NOT keep a second copy of "the current model". The seven slot bindings
// it edits are the ones in /api/settings (ManagementSettings.providers, held by ManagementSettingsStore),
// which is the single source of truth the production composition root reads. Model discovery only fills the
// picker; the chosen name is written into that same settings draft.
import { ApiError, ManagementClient } from './api.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLOTS = [['dialogue', '对话大模型'], ['memory_turn', '记忆维护'], ['summary', '摘要'], ['admission', '轮次判断'], ['perception', '视频情绪'], ['asr', '语音转写'], ['tts', '语音合成']];
const METHODS = { generateContent: '可生成内容', countTokens: '可计 token', embedContent: '仅向量化', embedText: '仅向量化' };

let client;
let revision = 0;
let cursor = null;
let settingsRevision = 0;
let settings = null;
let settingsBase = null;
let discovery = { protocol: 'openai-compatible', endpoint: '', modelsEndpoint: null, credentialRef: null, revision: 0, items: [], checkedAt: null, truncated: false, stale: true, note: '' };
let search = '';
// A monotonically increasing token marks the newest discovery request; a slower older answer is discarded.
let discoveryToken = 0;
let discoveryController = null;
let errorMessage = '';

function credentials() {
  const list = [...($('aika-credential')?.options ?? [])].map(option => option.value).filter(Boolean);
  return list;
}

async function refresh() {
  const data = await client.request('/api/aika/profile');
  revision = data.revision;
  $('aika-display-name').value = data.profile.displayName;
  $('aika-system-prompt').value = data.profile.systemPrompt;
  // The identity store keeps its legacy provider array; it is round-tripped so nothing is wiped.
  $('aika-profile-revision').textContent = `身份配置版本 ${revision}`;
  $('aika-providers').value = JSON.stringify(data.providers ?? [], null, 2);
}

async function loadSettings() {
  const snapshot = await client.request('/api/snapshot');
  // Only references and masked status reach the page; the snapshot never carries key material.
  const select = $('aika-credential');
  select.replaceChildren(...[
    (() => { const option = document.createElement('option'); option.value = ''; option.textContent = '请选择已保存的凭据'; return option; })(),
    ...(snapshot.credentials ?? []).map(credential => {
      const option = document.createElement('option');
      option.value = credential.id;
      option.textContent = `${credential.label}（${credential.status === 'configured' ? '已配置' : credential.status === 'missing' ? '未配置' : '不可用'}）`;
      option.disabled = credential.status !== 'configured';
      return option;
    })
  ]);
  settingsRevision = snapshot.settings.revision;
  settings = structuredClone(snapshot.settings.saved);
  settingsBase = structuredClone(snapshot.settings.saved);
  $('aika-settings-revision').textContent = `模型配置版本 ${snapshot.settings.revision}${snapshot.settings.pending ? '（重启后生效）' : ''}`;
}

async function loadDiscovery() {
  const page = await client.request('/api/aika/discovery');
  discovery = page;
  discoverySource();
  renderDiscovery();
}

function discoverySource() {
  $('aika-endpoint').value = discovery.endpoint ?? '';
  $('aika-models-endpoint').value = discovery.modelsEndpoint ?? '';
  $('aika-protocol').value = discovery.protocol ?? 'openai-compatible';
  if (discovery.credentialRef) $('aika-credential').value = discovery.credentialRef;
}

function renderSlots() {
  if (!settings) return;
  const container = $('aika-slots');
  container.replaceChildren(...SLOTS.filter(([slot]) => settings.providers[slot]).map(([slot, label]) => {
    const row = document.createElement('li');
    row.className = 'aika-slot';
    const name = document.createElement('label');
    name.htmlFor = `aika-model-${slot}`;
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `aika-model-${slot}`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = settings.providers[slot].model ?? '';
    input.addEventListener('input', () => { settings.providers[slot].model = input.value.trim(); });
    const endpoint = document.createElement('small');
    endpoint.textContent = settings.providers[slot].endpoint ?? '';
    row.append(name, input, endpoint);
    return row;
  }));
}

/** Ids and labels are data: they are written with textContent, never assembled into markup. */
function renderDiscovery() {
  const list = $('aika-discovery-list');
  const needle = search.trim().toLowerCase();
  const items = (discovery.items ?? []).filter(item => !needle || item.id.toLowerCase().includes(needle) || String(item.label).toLowerCase().includes(needle));
  list.replaceChildren(...items.map(item => {
    const row = document.createElement('li');
    row.dataset.model = item.id;
    const label = document.createElement('b');
    label.textContent = item.label === item.id ? item.id : `${item.label}（${item.id}）`;
    const methods = document.createElement('small');
    const declared = Array.isArray(item.capabilities?.methods) ? item.capabilities.methods : [];
    // The declared method id is shown as the supplier sent it; the gloss is only a reading aid.
    methods.textContent = declared.length
      ? declared.map(method => METHODS[method] ? `${method}（${METHODS[method]}）` : method).join('、')
      : '能力未声明（unknown）';
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', `把 ${item.id} 绑定到槽位`);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择要绑定的槽位';
    picker.append(placeholder, ...SLOTS.filter(([slot]) => settings?.providers[slot]).map(([slot, slotLabel]) => {
      const option = document.createElement('option');
      option.value = slot;
      option.textContent = slotLabel;
      return option;
    }));
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = '绑定';
    apply.disabled = false;
    apply.addEventListener('click', () => {
      const slot = picker.value;
      if (!slot) { showError('请先选择要绑定的槽位。'); return; }
      settings.providers[slot].model = item.id;
      // The endpoint travels with the model: a name from this list belongs to this source.
      if (discovery.endpoint) settings.providers[slot].endpoint = discovery.endpoint;
      if (discovery.protocol) settings.providers[slot].protocol = discovery.protocol;
      if (discovery.credentialRef) settings.providers[slot].credentialRef = discovery.credentialRef;
      renderSlots();
      showMessage(`已把 ${item.id} 填入“${SLOTS.find(([key]) => key === slot)[1]}”；保存并重启后生效。`);
    });
    row.append(label, methods, picker, apply);
    return row;
  }));
  $('aika-discovery-empty').textContent = (discovery.items ?? []).length === 0
    ? (discovery.stale ? '还没有获取过模型列表；可以直接填写型号名。' : '这个端点没有返回任何模型；可以直接填写型号名。')
    : items.length === 0 ? '当前搜索没有匹配的型号。' : '';
  $('aika-discovery-checked').textContent = discovery.checkedAt ? `获取时间 ${new Date(discovery.checkedAt).toLocaleString('zh-CN', { hour12: false })}${discovery.truncated ? '（仅显示部分结果）' : ''}` : '尚未获取';
  $('aika-discovery-note').textContent = discovery.note ?? '';
  $('aika-slots-revision').textContent = `待保存草稿基于版本 ${settingsRevision}`;
}

function showError(message) { errorMessage = message; $('aika-error').textContent = message; }
function showMessage(message) { errorMessage = ''; $('aika-error').textContent = ''; $('aika-message').textContent = message; }

/**
 * Reads the models resource through the backend. A newer request supersedes an older one: the older
 * response is dropped even if it arrives last, and its failure never overwrites the newer result.
 */
async function fetchModels() {
  const token = ++discoveryToken;
  discoveryController?.abort();
  const controller = new AbortController();
  discoveryController = controller;
  const source = {
    protocol: $('aika-protocol').value,
    endpoint: $('aika-endpoint').value.trim(),
    modelsEndpoint: $('aika-models-endpoint').value.trim() || null,
    credentialRef: $('aika-credential').value || null
  };
  // The in-flight isolation is the request token, not a disabled control: switching endpoint mid-flight
  // must stay possible, and the older answer is dropped by token when it arrives.
  $('aika-fetch-models').textContent = '获取中…';
  try {
    const page = await client.request('/api/aika/discovery', { method: 'POST', body: source, signal: controller.signal });
    if (token !== discoveryToken) return;
    discovery = page;
    renderDiscovery();
    showMessage(`已获取 ${(page.items ?? []).length} 个型号；列表不代表这些型号都能完成推理。`);
  } catch (error) {
    if (token !== discoveryToken || error.name === 'AbortError') return;
    // A failed discovery never clears the list or the selected model: manual entry must keep working.
    showError(error instanceof ApiError ? error.message : String(error));
    renderDiscovery();
  } finally {
    if (token === discoveryToken) { $('aika-fetch-models').textContent = '获取模型列表'; discoveryController = null; }
  }
}

async function saveModels() {
  if (!settings) return;
  const result = await client.request('/api/settings', { method: 'PUT', body: { expectedRevision: settingsRevision, settings: structuredClone(settings) } });
  settingsRevision = result.revision;
  settings = structuredClone(result.saved);
  settingsBase = structuredClone(result.saved);
  renderSlots();
  renderDiscovery();
  showMessage(result.pending ? `模型配置已保存为版本 ${result.revision}；重新启动桌宠后生效。` : '模型配置已保存。');
  $('aika-settings-revision').textContent = `模型配置版本 ${result.revision}${result.pending ? '（重启后生效）' : ''}`;
}

async function loadTimeline() {
  const sessionId = $('aika-session').value.trim() || 'default';
  const query = cursor
    ? `/api/aika/timeline?sessionId=${encodeURIComponent(sessionId)}&limit=20&cursor=${encodeURIComponent(cursor)}`
    : `/api/aika/timeline?sessionId=${encodeURIComponent(sessionId)}&limit=20`;
  const page = await client.request(query);
  const rows = page.items.map(item => {
    const label = item.kind === 'userMessage' ? '用户'
      : { completed: '助手', cancelled: '助手（已取消，仅部分）', failed: '助手（失败）' }[item.status ?? 'completed'];
    return `<li><b>${escape(label)}</b>：${item.text === undefined ? '（已清理）' : escape(item.text)}</li>`;
  }).join('');
  $('aika-timeline').innerHTML = rows || '<li>（暂无记录）</li>';
  cursor = page.nextCursor ?? null;
  $('aika-more').disabled = !cursor;
}

async function failSafe(action) {
  try { await action(); if (!errorMessage) $('aika-error').textContent = ''; }
  catch (error) { showError(error instanceof ApiError ? error.message : String(error)); }
}

/**
 * Wires every control before the first read completes. Binding handlers only after the initial load made a
 * click that landed during it silently do nothing, which is exactly the window a user hits on a slow backend.
 */
function bind() {
  $('aika-save').addEventListener('click', () => failSafe(async () => {
    const profile = { schemaVersion: 1, id: 'aika', displayName: $('aika-display-name').value, systemPrompt: $('aika-system-prompt').value };
    let providers = [];
    try { providers = JSON.parse($('aika-providers').value || '[]'); } catch { throw new ApiError('供应商配置不是合法 JSON。'); }
    const data = await client.request('/api/aika/profile', { method: 'PUT', body: { expectedRevision: revision, profile, providers } });
    revision = data.revision;
    await refresh();
    showMessage('身份配置已保存。');
  }));
  $('aika-fetch-models').addEventListener('click', () => failSafe(fetchModels));
  $('aika-save-models').addEventListener('click', () => failSafe(saveModels));
  $('aika-model-search').addEventListener('input', event => { search = event.target.value; renderDiscovery(); });
  $('aika-refresh-timeline').addEventListener('click', () => failSafe(async () => { cursor = null; await loadTimeline(); }));
  $('aika-more').addEventListener('click', () => failSafe(loadTimeline));
  $('aika-session').addEventListener('change', () => failSafe(async () => { cursor = null; await loadTimeline(); }));
}

async function boot() {
  let token = '';
  try { token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('pet-management-session-v1') || ''; } catch { /* storage unavailable */ }
  client = new ManagementClient(token);
  bind();
  await failSafe(async () => { await Promise.all([refresh(), loadSettings(), loadDiscovery()]); renderSlots(); await loadTimeline(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void boot(); });
else void boot();
