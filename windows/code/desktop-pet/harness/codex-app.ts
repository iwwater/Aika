import {openLocalUrl} from '../core/open-url.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, relative, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';

const APP_MEMBERS = {
  '.vite/build/main-DaMR-wdT.js': '0765260be74e8843630d5a92e30bca574783892688e67180c119a5c58679bb61',
  '.vite/build/desktop-open-path-queue-BtqbTQxD.js': '88355493af5f82dc9e049731e68c3fe0844b80a6692c6ec892ed77ce5a23827d',
  '.vite/build/src-CCXHtyvY.js': 'a42da38cbb14b28399f1d54fcf453bffc5e9802663e7e098f187c8378f4c7a40',
  'webview/assets/app-initial-4d7ea7f81c2d.js': '5dcf4a29db25b086f9bd11d053eec60cf0c50bfd988494969cec452e03f19245',
};
/** Fail closed when the private App protocol changes. Does not launch or patch the App. */
export async function verifyCodexAppBuild(archive = '/Applications/ChatGPT.app/Contents/Resources/app.asar'): Promise<boolean> {
  let file;
  try {
    file = await open(archive, 'r'); const header = Buffer.alloc(16);
    if ((await file.read(header, 0, 16, 0)).bytesRead !== 16) return false;
    const headerSize = header.readUInt32LE(4), jsonSize = header.readUInt32LE(12);
    if (jsonSize > 16 * 1024 * 1024 || headerSize < jsonSize) return false;
    const raw = Buffer.alloc(jsonSize); if ((await file.read(raw, 0, jsonSize, 16)).bytesRead !== jsonSize) return false;
    const tree = JSON.parse(raw.toString('utf8'));
    for (const [path, hash] of Object.entries(APP_MEMBERS)) {
      let entry = tree; for (const part of path.split('/')) entry = entry.files[part];
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024 || !/^\d+$/.test(entry.offset)) return false;
      const bytes = Buffer.alloc(entry.size);
      if ((await file.read(bytes, 0, bytes.length, 8 + headerSize + Number(entry.offset))).bytesRead !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== hash) return false;
    }
    return true;
  } catch { return false; } finally { await file?.close(); }
}

export class CodexAppError extends Error {
  constructor(readonly code: 'unavailable' | 'incompatible' | 'unknown_delivery' | 'invalid_target',
    readonly phase?: 'compatibility' | 'socket' | 'initialize' | 'owner_discovery' | 'send',
    readonly reason?: 'timeout' | 'connection_closed' | 'protocol_rejected') { super(code); }
}
const taskId = (value: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);

/** One connection, one confirmed send. Never reconnect or repeat a write automatically. */
class IpcSession {
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = Buffer.alloc(0);
  private clientId: string | undefined;
  constructor(private socket: Socket, private timeoutMs: number) {
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE();
        if (!size || size > 8 * 1024 * 1024) { this.close(); return; }
        if (this.buffer.length < size + 4) return;
        const bytes = this.buffer.subarray(4, size + 4); this.buffer = this.buffer.subarray(size + 4);
        let message: any; try { message = JSON.parse(bytes.toString('utf8')); } catch { this.close(); return; }
        if (message.type !== 'response') continue;
        const waiter = this.pending.get(message.requestId); if (!waiter) continue;
        clearTimeout(waiter.timer); this.pending.delete(message.requestId); waiter.resolve(message);
      }
    });
    socket.on('error', () => this.fail()); socket.on('close', () => this.fail());
  }
  private fail() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CodexAppError('unavailable', undefined, 'connection_closed')); } this.pending.clear(); }
  close() { this.fail(); this.socket.destroy(); }
  async request(method: string, version: number, params: object, targetClientId?: string, requestId: string = randomUUID()): Promise<any> {
    const message = { type: 'request', requestId, method, version, params, timeoutMs: this.timeoutMs,
      ...(this.clientId ? { sourceClientId: this.clientId } : {}), ...(targetClientId ? { targetClientId } : {}) };
    const bytes = Buffer.from(JSON.stringify(message)); const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new CodexAppError('unavailable', undefined, 'timeout')); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.socket.write(frame); } catch { this.fail(); }
    });
  }
  async initialize() {
    const response = await this.request('initialize', 0, { clientType: 'desktop-pet-harness-relay' });
    if (response.resultType !== 'success' || typeof response.result?.clientId !== 'string') throw new CodexAppError('incompatible');
    this.clientId = response.result.clientId;
  }
}

export interface CodexAppTarget { threadId: string; hostId: 'local'; title: string; projectPath: string }
export interface CodexAppReceipt { threadId: string; turnId: string; status: 'completed' | 'unknown'; reason?: 'interrupted' | 'continued_elsewhere'; reply?: string; durationMs?: number }
export class CodexAppConnection {
  constructor(private readonly codexHome: string, private readonly compatibility = verifyCodexAppBuild, private readonly timeoutMs = 5000,
    private readonly openTask: (id: string) => Promise<void> = async id => { await openLocalUrl('codex://threads/' + id); }) {}
  private database() { return new Database(join(this.codexHome, 'state_5.sqlite'), { readonly: true, fileMustExist: true }); }
  list(query = '', limit = 200): CodexAppTarget[] {
    if (query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new CodexAppError('invalid_target');
    let db;
    try {
      db = this.database();
      // Filter BEFORE LIMIT: internal spawn/guardian records are not App user tasks.
      const rows = db.prepare("SELECT id,name,title,cwd FROM threads WHERE archived=0 AND source IN ('vscode','cli') AND (thread_source='user' OR thread_source IS NULL) AND (agent_path IS NULL OR agent_path='') AND (agent_nickname IS NULL OR agent_nickname='') AND (?='' OR instr(lower(coalesce(name,'')),lower(?))>0 OR instr(lower(cwd),lower(?))>0 OR id=?) ORDER BY updated_at DESC,id LIMIT ?")
        .all(query, query, query, query, limit) as {id:string;name:string|null;title:string;cwd:string}[];
      return rows.filter(row=>taskId(row.id)).map(row=>({threadId:row.id,hostId:'local',projectPath:row.cwd,
        title:row.name?.trim() || (row.title.length<=120 && !row.title.includes('\n') ? row.title : '') || '未命名任务'}));
    } catch { throw new CodexAppError('unavailable'); } finally { db?.close(); }
  }
  /** Native reversible navigation, only for a verified user task and only before any send. */
  async ensureAvailable(threadId: string): Promise<{ available: boolean }> {
    if (!this.list(threadId).some(t=>t.threadId===threadId)) throw new CodexAppError('invalid_target');
    const initial=await this.discover(threadId).catch(error=>{if(error instanceof CodexAppError&&error.code==='unavailable')return {available:false};throw error;});
    if(initial.available)return {available:true};
    if (!await this.compatibility()) throw new CodexAppError('incompatible');
    await this.openTask(threadId);
    for (let attempt=0;attempt<4;attempt++) {
      await delay(300);
      try { if ((await this.discover(threadId)).available) return {available:true}; } catch {}
    }
    return {available:false};
  }
  private async session(): Promise<IpcSession> {
    if (!await this.compatibility()) throw new CodexAppError('incompatible', 'compatibility');
    const path = join(this.codexHome, 'ipc/ipc.sock'), uid = process.getuid?.();
    try { const parent = await lstat(dirname(path)), socket = await lstat(path);
      if (uid === undefined || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0 || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) throw new Error();
    } catch { throw new CodexAppError('unavailable', 'socket'); }
    const socket = connect(path); const session = new IpcSession(socket, this.timeoutMs);
    try { await session.initialize(); return session; } catch (error) { session.close(); throw new CodexAppError(error instanceof CodexAppError ? error.code : 'unavailable', 'initialize', error instanceof CodexAppError ? error.reason : undefined); }
  }
  async discover(threadId: string): Promise<{ available: boolean }> {
    if (!taskId(threadId)) throw new CodexAppError('invalid_target');
    const session = await this.session();
    try { const response = await session.request('thread-owner-discovery', 1, { hostId: 'local', conversationId: threadId });
      return { available: response.resultType === 'success' && typeof response.handledByClientId === 'string' && response.result?.supportsUntrustedAppInput === true };
    } catch (error) { throw new CodexAppError(error instanceof CodexAppError ? error.code : 'unavailable', 'owner_discovery', error instanceof CodexAppError ? error.reason : undefined); }
    finally { session.close(); }
  }
  async send(threadId: string, text: string, requestId: string): Promise<{ requestId: string; threadId: string; turnId: string }> {
    if (!taskId(threadId) || !taskId(requestId) || !text.trim() || text.length > 32768 || text.includes('\0')) throw new CodexAppError('invalid_target');
    const session = await this.session(); let writeAttempted = false;
    try {
      const owner = await session.request('thread-owner-discovery', 1, { hostId: 'local', conversationId: threadId });
      if (owner.resultType !== 'success' || typeof owner.handledByClientId !== 'string' || owner.result?.supportsUntrustedAppInput !== true) throw new CodexAppError('unavailable');
      writeAttempted = true;
      const response = await session.request('thread-follower-start-turn', 2, { conversationId: threadId, turnStart: {
        request: { threadId, input: [{ type: 'text', text, text_elements: [] }] }, context: { inheritThreadSettings: true },
      } }, owner.handledByClientId, requestId);
      const turnId = response.result?.result?.turn?.id;
      if (response.resultType !== 'success' || response.handledByClientId !== owner.handledByClientId || typeof turnId !== 'string' || !taskId(turnId)) throw new CodexAppError('unknown_delivery');
      return { requestId, threadId, turnId };
    } catch (error) { if (writeAttempted) throw new CodexAppError('unknown_delivery'); throw error; } finally { session.close(); }
  }
  async receipt(threadId: string, turnId: string): Promise<CodexAppReceipt> {
    if (!taskId(threadId) || !taskId(turnId)) throw new CodexAppError('invalid_target');
    const unknown: CodexAppReceipt = { threadId, turnId, status: 'unknown' }; let db;
    try {
      db = this.database(); const row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(threadId) as { rollout_path: string } | undefined;
      db.close(); db = undefined; if (!row) return unknown;
      const root = await realpath(join(this.codexHome, 'sessions')), path = await realpath(row.rollout_path), rel = relative(root, path);
      if (rel.startsWith('..') || isAbsolute(rel)) return unknown;
      const stat = await lstat(path); if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 128 * 1024 * 1024) return unknown;
      const input = createReadStream(path, { end: Math.max(0, stat.size - 1) }); const lines = createInterface({ input, crlfDelay: Infinity });
      let identity = false, started = false, interrupted = false, continuedElsewhere = false;
      try { for await (const line of lines) {
        if (line.length > 4 * 1024 * 1024) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'session_meta') { identity = event.payload?.id === threadId; if (!identity) return unknown; }
        if (identity && event.type === 'event_msg') {
          const payload = event.payload;
          if (payload?.type === 'task_started') {
            if (payload.turn_id === turnId) started = true;
            else if (started && typeof payload.turn_id === 'string' && taskId(payload.turn_id)) continuedElsewhere = true;
          }
          if (payload?.type === 'turn_aborted' && payload.turn_id === turnId) interrupted = true;
        }
        if (identity && event.type === 'event_msg' && event.payload?.type === 'task_complete' && event.payload.turn_id === turnId) {
          const message = event.payload.last_agent_message;
          return { threadId, turnId, status: 'completed', ...(typeof message === 'string' ? { reply: message.slice(0, 4000) } : {}),
            ...(typeof event.payload.duration_ms === 'number' ? { durationMs: event.payload.duration_ms } : {}) };
        }
      } } finally { lines.close(); input.destroy(); }
      // Read the whole snapshot before marking interruption: a late exact completion wins.
      return interrupted ? { ...unknown, reason: 'interrupted' }
        : continuedElsewhere ? { ...unknown, reason: 'continued_elsewhere' } : unknown;
    } catch { return unknown; } finally { db?.close(); }
  }
}
