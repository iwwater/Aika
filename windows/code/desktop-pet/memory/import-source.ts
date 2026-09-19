import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import Database from 'better-sqlite3';
import type { MemoryImportSource } from '../contracts/memory-import.js';

const MAX_SOURCE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export type MemoryImportFailureCode =
  | 'invalid_state'
  | 'version_conflict'
  | 'source_changed'
  | 'source_unavailable'
  | 'unsupported_export'
  | 'ambiguous_project'
  | 'invalid_source_entry'
  | 'provider_failed'
  | 'provider_timeout'
  | 'commit_conflict'
  | 'interrupted'
  | 'budget_exceeded';

export class MemoryImportError extends Error {
  constructor(readonly code: MemoryImportFailureCode, readonly item = 'source') { super(code); }
}

export interface HistoricalMessage {
  readonly namespace: string;
  readonly itemId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: string;
}
export interface HistoricalSourceSnapshot {
  readonly fingerprint: string;
  readonly messages: readonly HistoricalMessage[];
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const iso = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};
const textFromContent = (value: unknown, included?: ReadonlySet<number>): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part,index) => {
    if(included&&!included.has(index))return '';
    const row = object(part);
    if (!row || !['input_text', 'output_text', 'text'].includes(String(row.type ?? ''))) return '';
    return typeof row.text === 'string' ? row.text : '';
  }).filter(Boolean).join('\n');
};

const INJECTED_MARKERS = [
  '<environment_context>', '<skills_instructions>', '<apps_instructions>', '<plugins_instructions>',
  '<permissions instructions>', '<collaboration_mode>', '<recommended_plugins>', '# AGENTS.md instructions',
  '<summary>', '<developer>', '<system>', '<app-context>', '<multi_agent_mode>', '<codex_delegation>',
];
/** Codex may append environment-owned context to a visible user item. It is never companion evidence. */
function visibleUserText(value: string): string {
  let end = value.length;
  for (const marker of INJECTED_MARKERS) {
    const index = value.indexOf(marker);
    if (index >= 0) end = Math.min(end, index);
  }
  return value.slice(0, end).trim();
}
function validText(value: string): boolean {
  return !!value && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_MESSAGE_BYTES;
}

interface ParsedRollout { readonly cwd: string; readonly messages: readonly HistoricalMessage[] }
function userContentIndexes(payload:Record<string,unknown>,event:Record<string,unknown>):ReadonlySet<number>|undefined {
  const candidates=[payload,object(payload.metadata),event,object(event.metadata)].filter((item):item is Record<string,unknown>=>!!item);
  for(const candidate of candidates){
    const passthrough=object(candidate.internal_chat_message_metadata_passthrough);
    const kinds=passthrough?.content_item_kinds;
    if(!Array.isArray(kinds))continue;
    const indexes=new Set<number>();
    kinds.forEach((kind,index)=>{if(kind==='user.text')indexes.add(index);});
    return indexes;
  }
  return undefined;
}
function parseResponseItem(event: Record<string, unknown>, threadId: string, line: number): HistoricalMessage | null {
  if (event.type !== 'response_item') return null;
  const payload = object(event.payload) ?? object(event.item) ?? object(event.response_item) ?? event;
  if (!payload || (payload.type !== undefined && payload.type !== 'message')) return null;
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const phase = payload.phase ?? event.phase ?? payload.channel ?? (payload.final === true ? 'final' : undefined);
  if (role === 'assistant' && !['final', 'final_answer', 'completed'].includes(String(phase ?? ''))) return null;
  const content=payload.content ?? payload.text ?? object(payload.message)?.content;
  const raw = textFromContent(content,role==='user'?userContentIndexes(payload,event):undefined);
  const text = role === 'user' ? visibleUserText(raw) : raw.trim();
  if (!text) return null;
  if (!validText(text)) throw new MemoryImportError('invalid_source_entry', `entry:${line}`);
  const createdAt = iso(event.timestamp ?? payload.timestamp ?? payload.createdAt ?? payload.created_at);
  if (!createdAt) throw new MemoryImportError('invalid_source_entry', `entry:${line}`);
  const explicitId = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : null;
  const itemId = explicitId ?? `line:${line}`;
  return { namespace: `codex:${threadId}`, itemId, role, text, createdAt };
}

function parseRollout(bytes: Uint8Array, threadId: string): ParsedRollout {
  const messages: HistoricalMessage[] = [];
  let sessionId: string | null = null, cwd: string | null = null;
  const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new MemoryImportError('invalid_source_entry', `entry:${index + 1}`); }
    const event = object(parsed);
    if (!event) throw new MemoryImportError('invalid_source_entry', `entry:${index + 1}`);
    if (event.type === 'session_meta') {
      const payload = object(event.payload) ?? event;
      sessionId = typeof payload.id === 'string' ? payload.id : null;
      cwd = typeof payload.cwd === 'string' ? payload.cwd : typeof object(payload.meta)?.cwd === 'string' ? object(payload.meta)!.cwd as string : null;
      continue;
    }
    // event_msg contains delivery/status echoes and is intentionally never a transcript source.
    const message = parseResponseItem(event, threadId, index + 1);
    if (message) messages.push(message);
  }
  if (sessionId !== threadId || !cwd) throw new MemoryImportError('invalid_source_entry', `session:${threadId}`);
  return { cwd, messages };
}

async function safeRegularFile(path: string, root?: string|readonly string[]): Promise<{ path: string; bytes: Uint8Array }> {
  if (!isAbsolute(path)) throw new MemoryImportError('source_unavailable');
  let canonical: string;
  try {
    const direct = await lstat(path);
    if (direct.isSymbolicLink()) throw new Error('symlink');
    canonical = await realpath(path);
    const stat = await lstat(canonical);
    if (!stat.isFile() || stat.size > MAX_SOURCE_FILE_BYTES || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe');
    if (root) {
      let contained=false;
      for(const candidate of typeof root==='string'?[root]:root){
        try{const canonicalRoot=await realpath(candidate),rel=relative(canonicalRoot,canonical);if(!rel.startsWith('..')&&!isAbsolute(rel)){contained=true;break;}}
        catch{/* an optional archive root may not exist */}
      }
      if(!contained)throw new Error('outside');
    }
    return { path: canonical, bytes: await readFile(canonical) };
  } catch { throw new MemoryImportError('source_unavailable'); }
}

async function codexSnapshot(source: MemoryImportSource, codexHome: string): Promise<HistoricalSourceSnapshot> {
  if (!isAbsolute(source.path) || !source.projectName.trim()) throw new MemoryImportError('ambiguous_project');
  let projectPath: string;
  try {
    const direct = await lstat(source.path);
    if (direct.isSymbolicLink() || !direct.isDirectory()) throw new Error('unsafe');
    projectPath = await realpath(source.path);
  } catch { throw new MemoryImportError('source_unavailable'); }
  const state = join(codexHome, 'state_5.sqlite');
  let db: Database.Database | undefined;
  try {
    db = new Database(state, { readonly: true, fileMustExist: true });
    const columns = new Set((db.pragma('table_info(threads)') as {name:string}[]).map(row => row.name));
    for (const required of ['id', 'cwd', 'rollout_path']) if (!columns.has(required)) throw new MemoryImportError('source_unavailable');
    const where = ['cwd IS NOT NULL', 'rollout_path IS NOT NULL'];
    if (columns.has('source')) where.push("source IN ('vscode','cli')");
    if (columns.has('thread_source')) where.push("(thread_source='user' OR thread_source IS NULL)");
    if (columns.has('agent_path')) where.push("(agent_path IS NULL OR agent_path='')");
    if (columns.has('agent_nickname')) where.push("(agent_nickname IS NULL OR agent_nickname='')");
    const rows = db.prepare(`SELECT id,cwd,rollout_path FROM threads WHERE ${where.join(' AND ')} ORDER BY id`).all() as {id:string;cwd:string;rollout_path:string}[];
    const selected: typeof rows = [];
    for (const row of rows) {
      if (!UUID.test(row.id) || typeof row.cwd !== 'string' || typeof row.rollout_path !== 'string') continue;
      try { if (await realpath(row.cwd) === projectPath) selected.push(row); } catch { /* stale registry row */ }
    }
    const inherited=new Map<string,HistoricalMessage>(),fingerprints: string[] = [];
    for (const row of selected) {
      const file = await safeRegularFile(row.rollout_path, [join(codexHome, 'sessions'),join(codexHome,'archived_sessions')]);
      const parsed = parseRollout(file.bytes, row.id);
      let rolloutCwd: string;
      try { rolloutCwd = await realpath(parsed.cwd); } catch { throw new MemoryImportError('invalid_source_entry', `session:${row.id}`); }
      if (rolloutCwd !== projectPath) throw new MemoryImportError('invalid_source_entry', `session:${row.id}`);
      for(const message of parsed.messages){
        const itemId=sha256(JSON.stringify([message.role,message.createdAt,message.text]));
        if(!inherited.has(itemId))inherited.set(itemId,{...message,namespace:'historical-message',itemId});
      }
      fingerprints.push(`${row.id}:${sha256(file.bytes)}`);
    }
    const messages=[...inherited.values()];
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.namespace.localeCompare(b.namespace) || a.itemId.localeCompare(b.itemId));
    return { fingerprint: sha256(JSON.stringify(fingerprints)), messages };
  } catch (error) {
    if (error instanceof MemoryImportError) throw error;
    throw new MemoryImportError('source_unavailable');
  } finally { db?.close(); }
}

function normalizeSpeaker(value: unknown): 'user' | 'assistant' | null {
  if (value === 'user' || value === '用户') return 'user';
  if (value === 'assistant' || value === 'ai' || value === 'AI' || value === '助手') return 'assistant';
  return null;
}
function parseExportEntry(value: unknown, item: string): HistoricalMessage {
  const row = object(value);
  const role = normalizeSpeaker(row?.speaker ?? row?.role), createdAt = iso(row?.timestamp ?? row?.createdAt ?? row?.date);
  const text = typeof row?.text === 'string' ? row.text.trim() : '';
  if (!role || !createdAt || !validText(text)) throw new MemoryImportError('invalid_source_entry', item);
  const itemId=sha256(JSON.stringify([role,createdAt,text]));
  return { namespace:'historical-message', itemId, role, text, createdAt };
}
async function textSnapshot(source: MemoryImportSource): Promise<HistoricalSourceSnapshot> {
  if (!source.projectName.trim()) throw new MemoryImportError('invalid_source_entry');
  const file = await safeRegularFile(source.path), fingerprint = sha256(file.bytes);
  const raw = Buffer.from(file.bytes).toString('utf8').trim();
  if (!raw) return { fingerprint, messages: [] };
  const messages: HistoricalMessage[] = [];
  if (raw.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new MemoryImportError('unsupported_export'); }
    if (!Array.isArray(parsed)) throw new MemoryImportError('unsupported_export');
    parsed.forEach((entry, index) => messages.push(parseExportEntry(entry,`entry:${index + 1}`)));
  } else {
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim(); if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new MemoryImportError('unsupported_export', `entry:${index + 1}`); }
      messages.push(parseExportEntry(parsed,`entry:${index + 1}`));
    }
  }
  const unique=new Map(messages.map(message=>[message.itemId,message]));
  const ordered=[...unique.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
  return { fingerprint, messages:ordered };
}

/** Reads only the explicit source and, for Codex, registry-selected rollout files for that exact cwd. */
export function discoverHistoricalSource(source: MemoryImportSource, codexHome: string): Promise<HistoricalSourceSnapshot> {
  if (source.kind === 'codex-project') return codexSnapshot(source, codexHome);
  if (source.kind === 'text-export') return textSnapshot(source);
  return Promise.reject(new MemoryImportError('unsupported_export'));
}
