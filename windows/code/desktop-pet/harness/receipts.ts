import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { constants, openSync, readSync, closeSync, mkdirSync, fstatSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import type { WorkConversationMessage } from '../contracts/desktop-work.js';
import type { WorkPlanFailureCode } from '../providers/work-plan.js';
import type { TurnScope } from '../contracts/index.js';
import type { ForwardRequest } from '../contracts/harness.js';
import { restrictPrivatePathSync } from '../core/platform-files.js';

export interface StoredForward extends ForwardRequest {
  /** Durable deduplication boundary for the irreversible App send, not an execution queue. */
  dispatchAttempted: boolean;
  ipcRequestId: string;
  harnessRequestId: string;
  /** Local reminder acknowledgement, bound to semantic receipt state; never execution status. */
  clearedUnknownReminder?: { at: string; state: string };
  usageComplete?: boolean;
  harnessEnded?: boolean;
}
export interface StoredWorkDraft {
  id: string; version: number; text: string; scope: TurnScope; createdAt: string;
  status: 'open' | 'prepared' | 'confirming' | 'confirmed' | 'dismissed';
  question?: string; operationId?: string;
  /** Safe stage/reason only, no provider body or private failure detail. */
  lastPlanningFailure?: { stage: 'plan' | 'target' | 'prepare' | 'unknown'; code?: WorkPlanFailureCode; at: string };
  /** Verbatim initial input, absent in legacy records; never replaced by planning/editing. */
  originalText?: string;
  conversation?: WorkConversationMessage[];
  everPrepared?: boolean;
}
function reminderState(row: ForwardRequest): string {
  return JSON.stringify([row.phase, row.nativeStatus ?? null, row.appTurnId ?? null, row.harnessSessionId ?? null, row.result ?? null]);
}
export function isUnknownReminderCleared(row: StoredForward): boolean {
  return row.phase === 'unknown' && !!row.confirmedAt && row.clearedUnknownReminder?.state === reminderState(row);
}
const invalid = (): never => { throw new ManagementError('invalid_request', '任务回执存储不可用。'); };
function validateTaskText(text: string): void {
  if (!text.trim()) throw new ManagementError('invalid_request', '没有听清任务内容，请再说一次。');
  if (text.length > 20000) throw new ManagementError('invalid_request', '任务内容过长，请分段说明。');
  if (text.includes('\0')) throw new ManagementError('invalid_request', '任务内容包含无法处理的字符，请重新说明。');
}
const APPLICATION_ID = 0x50544631; // PTF1: only forwarding confirmations and receipts.
export class ForwardReceipts {
  private db: Database.Database;
  constructor(filename: string) {
    if (!isAbsolute(filename) || basename(filename) !== 'harness-relay.sqlite') invalid();
    let fd: number | undefined, created = false;
    try {
      fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW); const header = Buffer.alloc(100);
      if (!fstatSync(fd).isFile()) invalid();
      const length = readSync(fd, header, 0, 100, 0);
      if (length !== 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header.readUInt32BE(68) !== APPLICATION_ID || ![1, 2].includes(header.readUInt32BE(60))) invalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      const newFile = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(newFile); created = true;
    } finally { if (fd !== undefined) closeSync(fd); }
    // Windows ignores POSIX creation modes. Restrict our new, still-empty file
    // before SQLite writes task text; existing user databases stay untouched.
    if (created && process.platform === 'win32') restrictPrivatePathSync(filename);
    this.db = new Database(filename, { fileMustExist: true });
    try { this.db.transaction(() => {
      const app = this.db.pragma('application_id', { simple: true });
      if (app !== 0 && app !== APPLICATION_ID) invalid();
      if (app === 0 && (this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { n: number }).n > 0) invalid();
      if (created) {
        this.db.pragma(`application_id=${APPLICATION_ID}`); this.db.pragma('user_version=1');
        this.db.exec('CREATE TABLE confirmations(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)');
      } else if (![1, 2].includes(Number(this.db.pragma('user_version', { simple: true }))) ||
        JSON.stringify((this.db.pragma('table_info(confirmations)') as { name: string }[]).map(column => column.name)) !== JSON.stringify(['id', 'created_at', 'payload'])) invalid();
      // Add only an isolated input draft table; existing confirmation payloads remain untouched.
      if (this.db.pragma('user_version', { simple: true }) === 1) {
        this.db.exec('CREATE TABLE work_drafts(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)');
        this.db.pragma('user_version=2');
      } else if (JSON.stringify((this.db.pragma('table_info(work_drafts)') as { name: string }[]).map(c => c.name)) !== JSON.stringify(['id', 'created_at', 'payload'])) invalid();
    }).immediate(); } catch (error) { this.db.close(); throw error; }
  }
  get(id: string): StoredForward {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ManagementError('invalid_request', '任务编号无效。');
    const row = this.db.prepare('SELECT payload FROM confirmations WHERE id=?').get(id) as { payload: string } | undefined;
    if (!row) throw new ManagementError('not_found', '没有找到这次转发请求。'); return JSON.parse(row.payload);
  }
  /** Recent history plus every confirmed unresolved record counted by pendingCount. */
  list(): StoredForward[] { return (this.db.prepare("SELECT payload FROM confirmations WHERE id IN (SELECT id FROM confirmations ORDER BY created_at DESC,id DESC LIMIT 50) OR (json_extract(payload,'$.confirmedAt') IS NOT NULL AND json_extract(payload,'$.phase') IN ('accepted','forwarding','unknown')) ORDER BY created_at DESC,id DESC").all() as { payload: string }[]).map(row => JSON.parse(row.payload)); }
  /** This database belongs to one channel. Query dispatch order, not later receipt updates or new drafts. */
  queryDispatched(all: boolean): StoredForward[] {
    const sql = "SELECT payload FROM confirmations WHERE json_extract(payload,'$.confirmedAt') IS NOT NULL ORDER BY json_extract(payload,'$.confirmedAt') DESC,created_at DESC,rowid DESC" + (all ? '' : ' LIMIT 1');
    return (this.db.prepare(sql).all() as {payload:string}[]).map(row => JSON.parse(row.payload));
  }
  observationPage(after?: { createdAt: string; id: string }, limit = 5): StoredForward[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) invalid();
    return (this.db.prepare("SELECT payload FROM confirmations WHERE (json_extract(payload,'$.appTurnId') IS NOT NULL OR (json_extract(payload,'$.executor')='harness' AND json_extract(payload,'$.harnessSessionId') IS NOT NULL)) AND json_extract(payload,'$.phase') IN ('accepted','forwarding','unknown') AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?")
      .all(after?.createdAt ?? null, after?.createdAt ?? '', after?.createdAt ?? '', after?.id ?? '', limit) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  pendingCount(): number {
    return this.list().filter(row => row.confirmedAt && ['accepted','forwarding','unknown'].includes(row.phase) && !isUnknownReminderCleared(row)).length;
  }
  /** Atomically acknowledge only exact versioned unknown receipts; execution/body are never changed. */
  clearUnknownReminders(records: readonly {id:string;expectedVersion:number}[], dismissDraft?:{id:string;expectedVersion:number}): number {
    return this.db.transaction(() => {
      const unique = new Set<string>();
      const rows = records.map(input => {
        if(unique.has(input.id)) throw new ManagementError('invalid_request','提醒编号重复。'); unique.add(input.id);
        const row=this.get(input.id);
        if(isUnknownReminderCleared(row))return undefined;
        if(row.version!==input.expectedVersion || row.phase!=='unknown' || !row.confirmedAt)
          throw new ManagementError('version_conflict','提醒状态已变化，请刷新后再清除。');
        return row;
      }).filter((row):row is StoredForward=>!!row);
      if(dismissDraft){
        const d=this.draft(dismissDraft.id);
        if(d.version!==dismissDraft.expectedVersion || d.status!=='open' || d.operationId || d.everPrepared)
          throw new ManagementError('version_conflict','草稿已变化，请重新核对。');
        this.mutateDraft(d.id,d.version,draft=>{draft.status='dismissed';});
      }
      for(const row of rows)this.mutate(row.id,r=>{r.clearedUnknownReminder={at:new Date().toISOString(),state:reminderState(r)};});
      return rows.length;
    }).immediate();
  }
  pendingUsage(): StoredForward[] { return (this.db.prepare("SELECT payload FROM confirmations WHERE json_extract(payload,'$.harnessSessionId') IS NOT NULL AND coalesce(json_extract(payload,'$.usageComplete'),0)=0 ORDER BY created_at").all() as { payload: string }[]).map(row => JSON.parse(row.payload)); }
  create(input: Pick<ForwardRequest, 'text' | 'target' | 'project' | 'executor' | 'plan'>): StoredForward {
    const row: StoredForward = { ...input, id: randomUUID(), version: 1, phase: 'awaiting_confirmation', createdAt: new Date().toISOString(), dispatchAttempted: false, ipcRequestId: randomUUID(), harnessRequestId: randomUUID() };
    this.db.prepare('INSERT INTO confirmations VALUES(?,?,?)').run(row.id, row.createdAt, JSON.stringify(row)); return row;
  }
  /** Replace only an unconfirmed draft+request in one SQLite transaction. Old confirmation becomes inert. */
  prepareDraft(id: string, expectedVersion: number, input: Pick<ForwardRequest,'text'|'target'|'project'|'executor'|'plan'>): StoredForward {
    return this.db.transaction(()=>{
      const draft=this.draft(id);
      if (draft.version!==expectedVersion || !['open','prepared'].includes(draft.status)) throw new ManagementError('version_conflict','工作卡已变化，请重新核对。');
      if (draft.operationId) {
        const previous=this.get(draft.operationId);
        if(previous.confirmedAt || previous.phase!=='awaiting_confirmation') throw new ManagementError('version_conflict','已确认的任务不能修改或重发。');
        this.mutate(previous.id,row=>{row.phase='unavailable';row.detail='这张未发送卡已被修改后的新卡替代。';});
      }
      const request=this.create(input);
      this.mutateDraft(id,expectedVersion,row=>{row.text=input.text;row.status='prepared';row.everPrepared=true;row.operationId=request.id;delete row.question;delete row.lastPlanningFailure;});
      return request;
    }).immediate();
  }
  /** User-requested replanning only: retain the old receipt, make its confirmation inert, and reopen the draft atomically. */
  reopenDraft(id: string, expectedVersion: number, text: string): StoredWorkDraft {
    validateTaskText(text);
    return this.db.transaction(() => {
      const draft = this.draft(id);
      if (draft.version !== expectedVersion || draft.status !== 'prepared' || !draft.operationId)
        throw new ManagementError('version_conflict', '工作卡已变化，请重新核对。');
      const previous = this.get(draft.operationId);
      if (previous.confirmedAt || previous.dispatchAttempted || previous.harnessSessionId || previous.appTurnId || previous.phase !== 'awaiting_confirmation')
        throw new ManagementError('version_conflict', '已确认或状态未知的任务不能重新整理发送。');
      this.mutate(previous.id, row => { row.phase = 'unavailable'; row.detail = '用户已选择重新整理；这张未发送卡保留为旧记录。'; });
      return this.mutateDraft(id, expectedVersion, row => {
        row.status = 'open'; row.everPrepared=true; row.text = text; delete row.operationId; delete row.question;
      });
    }).immediate();
  }
  mutate(id: string, update: (row: StoredForward) => void): StoredForward {
    return this.db.transaction(() => { const row = this.get(id); update(row); row.version++;
      this.db.prepare('UPDATE confirmations SET payload=? WHERE id=?').run(JSON.stringify(row), id); return row;
    }).immediate();
  }
  createDraft(scope: TurnScope, text: string, question?: string): StoredWorkDraft {
    validateTaskText(text);
    const row: StoredWorkDraft = { id: randomUUID(), version: 1, text, originalText: text, scope: { ...scope }, createdAt: new Date().toISOString(), status: 'open', everPrepared: false, ...(question ? { question, conversation: [{role:'assistant' as const,text:question,scope:{...scope}}] } : {}) };
    this.db.prepare('INSERT INTO work_drafts VALUES(?,?,?)').run(row.id, row.createdAt, JSON.stringify(row)); return row;
  }
  draft(id: string): StoredWorkDraft {
    const row = this.db.prepare('SELECT payload FROM work_drafts WHERE id=?').get(id) as { payload: string } | undefined;
    if (!row) throw new ManagementError('not_found', '工作草稿已不存在。'); return JSON.parse(row.payload);
  }
  draftForOperation(operationId: string): StoredWorkDraft | undefined {
    const rows = this.db.prepare("SELECT payload FROM work_drafts WHERE json_extract(payload,'$.operationId')=? LIMIT 2").all(operationId) as {payload:string}[];
    return rows.length === 1 ? JSON.parse(rows[0]!.payload) : undefined;
  }
  drafts(): StoredWorkDraft[] { return (this.db.prepare('SELECT payload FROM work_drafts ORDER BY created_at DESC,id DESC LIMIT 50').all() as { payload: string }[]).map(row => JSON.parse(row.payload)); }
  mutateDraft(id: string, expectedVersion: number, update: (row: StoredWorkDraft) => void): StoredWorkDraft {
    return this.db.transaction(() => { const row = this.draft(id);
      if (row.version !== expectedVersion) throw new ManagementError('version_conflict', '工作草稿已变化，请重新核对。');
      const original = row.originalText;
      update(row);
      if (row.originalText !== original) throw new ManagementError('invalid_request', '原始输入不能被规划或编辑覆盖。');
      row.version++;
      this.db.prepare('UPDATE work_drafts SET payload=? WHERE id=?').run(JSON.stringify(row), id); return row;
    }).immediate();
  }
  close() { if (this.db.open) this.db.close(); }
}

export function publicForward(row: StoredForward): ForwardRequest {
  const { dispatchAttempted: _dispatch, ipcRequestId: _ipc, harnessRequestId: _harness, usageComplete: _usage, harnessEnded: _ended, clearedUnknownReminder: _cleared, ...view } = row; return { ...view, ...(isUnknownReminderCleared(row)?{reminderCleared:true}:{}) };
}
