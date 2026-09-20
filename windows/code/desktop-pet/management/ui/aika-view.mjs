// Aika console view: a thin shell over the /api/aika/* routes. All validation and state
// transitions live in the backend; this file only fetches, renders and posts forms.
// Served at /aika-view.mjs (static map in the management server); opened with the same
// #token=… fragment as the rest of the console.
import { ApiError, ManagementClient } from './api.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let client;
let revision = 0;
let cursor = null;

async function refresh() {
  const data = await client.request('/api/aika/profile');
  revision = data.revision;
  $('aika-display-name').value = data.profile.displayName;
  $('aika-system-prompt').value = data.profile.systemPrompt;
  $('aika-providers').value = JSON.stringify(data.providers ?? [], null, 2);
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
  try { await action(); $('aika-error').textContent = ''; }
  catch (error) { $('aika-error').textContent = error instanceof ApiError ? error.message : String(error); }
}

async function boot() {
  let token = '';
  try { token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('pet-management-session-v1') || ''; } catch { /* storage unavailable */ }
  client = new ManagementClient(token);
  await failSafe(async () => { await refresh(); await loadTimeline(); });
  $('aika-save').addEventListener('click', () => failSafe(async () => {
    const profile = { schemaVersion: 1, id: 'aika', displayName: $('aika-display-name').value, systemPrompt: $('aika-system-prompt').value };
    let providers = [];
    try { providers = JSON.parse($('aika-providers').value || '[]'); } catch { throw new ApiError('供应商配置不是合法 JSON。'); }
    const data = await client.request('/api/aika/profile', { method: 'PUT', body: { expectedRevision: revision, profile, providers } });
    revision = data.revision;
    await refresh();
  }));
  $('aika-refresh-timeline').addEventListener('click', () => failSafe(async () => { cursor = null; await loadTimeline(); }));
  $('aika-more').addEventListener('click', () => failSafe(loadTimeline));
  $('aika-session').addEventListener('change', () => failSafe(async () => { cursor = null; await loadTimeline(); }));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void boot(); });
else void boot();
