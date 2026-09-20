// FIX61-06: knowledge library page. A thin shell over /api/knowledge/*; validation and revision
// checks live in the backend. Served at /knowledge-view.mjs and mounted by the console navigation.
import { ApiError, ManagementClient } from './api.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let client;
let revision = 0;
let selected = null;

function render(state) {
  revision = state.revision;
  const active = state.activeLibraryId;
  $('kb-active').textContent = active === null
    ? '当前：无知识库（本轮对话不携带参考资料）'
    : '当前：' + (state.libraries.find(library => library.id === active)?.name ?? active);
  const rows = state.libraries.map(library => {
    const isActive = library.id === active;
    return '<li><label><input type="radio" name="kb-pick" value="' + escape(library.id) + '"' + (isActive ? ' checked' : '') + '> '
      + escape(library.name) + '</label> <small>' + library.documentCount + ' 个文档 · ' + Math.ceil(library.bytes / 1024) + ' KiB'
      + (isActive ? ' · 当前使用' : '') + '</small></li>';
  }).join('');
  $('kb-libraries').innerHTML = rows || '<li>（还没有知识库，先新建一个）</li>';
}

async function refresh() {
  render(await client.request('/api/knowledge'));
  if (selected) await loadDocuments();
}

async function loadDocuments() {
  const libraryId = selected ?? document.querySelector('input[name=kb-pick]:checked')?.value;
  if (!libraryId) { $('kb-documents').innerHTML = '<li>（先选择一个知识库）</li>'; return; }
  selected = libraryId;
  const documents = await client.request('/api/knowledge/documents/list', { method: 'POST', body: { libraryId } });
  $('kb-documents').innerHTML = documents.map(document =>
    '<li>' + escape(document.sourceName) + ' <small>' + document.bytes + ' 字节</small> '
    + '<button data-remove="' + escape(document.id) + '">删除</button></li>').join('') || '<li>（这个知识库还没有文档）</li>';
  $('kb-import').disabled = false;
}

async function failSafe(action) {
  try { await action(); $('kb-error').textContent = ''; }
  catch (error) { $('kb-error').textContent = error instanceof ApiError ? error.message : String(error); }
}

async function boot() {
  let token = '';
  try { token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('pet-management-session-v1') || ''; } catch { /* storage unavailable */ }
  client = new ManagementClient(token);
  await failSafe(refresh);

  $('kb-create').addEventListener('click', () => failSafe(async () => {
    const name = $('kb-name').value.trim();
    if (!name) throw new ApiError('请填写知识库名称。');
    render(await client.request('/api/knowledge/libraries', { method: 'POST', body: { name } }));
    $('kb-name').value = '';
  }));
  // Only locally chosen UTF-8 text files are read; nothing is fetched and nothing is executed.
  $('kb-files').addEventListener('change', () => failSafe(async () => {
    const picked = [...$('kb-files').files];
    if (!picked.length) return;
    const libraryId = selected ?? document.querySelector('input[name=kb-pick]:checked')?.value;
    if (!libraryId) throw new ApiError('请先选择要导入到哪个知识库。');
    const files = [];
    for (const file of picked) files.push({ sourceName: file.name, text: await file.text() });
    render(await client.request('/api/knowledge/import', { method: 'POST', body: { libraryId, files } }));
    selected = libraryId;
    await loadDocuments();
    $('kb-files').value = '';
  }));
  $('kb-activate').addEventListener('click', () => failSafe(async () => {
    const libraryId = document.querySelector('input[name=kb-pick]:checked')?.value ?? null;
    render(await client.request('/api/knowledge/activate', { method: 'POST', body: { expectedRevision: revision, libraryId } }));
  }));
  $('kb-none').addEventListener('click', () => failSafe(async () => {
    render(await client.request('/api/knowledge/activate', { method: 'POST', body: { expectedRevision: revision, libraryId: null } }));
  }));
  $('kb-delete').addEventListener('click', () => failSafe(async () => {
    const libraryId = document.querySelector('input[name=kb-pick]:checked')?.value;
    if (!libraryId) throw new ApiError('请先选择要删除的知识库。');
    render(await client.request('/api/knowledge/libraries/delete', { method: 'POST', body: { libraryId, expectedRevision: revision } }));
    selected = null;
    await loadDocuments();
  }));
  document.addEventListener('click', event => failSafe(async () => {
    const button = event.target.closest('[data-remove]');
    if (!button || !selected) return;
    render(await client.request('/api/knowledge/documents/remove', { method: 'POST', body: { libraryId: selected, documentId: button.dataset.remove, expectedRevision: revision } }));
    await loadDocuments();
  }));
  $('kb-libraries').addEventListener('change', () => failSafe(loadDocuments));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void boot(); });
else void boot();
