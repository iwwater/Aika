import Database from 'better-sqlite3';
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import type { PairingScope } from '../contracts/character-pack.js';
import type { WorkReceipt, WorkRequest } from '../contracts/perception.js';
import { isPrivateFileSync, restrictPrivatePathSync } from './platform-files.js';

const APPLICATION_ID = 0x50545731; // PTW1: isolated ACP/MCP work receipts.

export interface WorkProtocolJournalEntry {
  readonly request: WorkRequest;
  readonly pairing?: PairingScope;
  readonly dispatchStarted: boolean;
  readonly eventPublished: boolean;
  readonly forgotten: boolean;
  readonly receipt?: WorkReceipt;
}

function invalid(): never { throw new Error('work_protocol_journal_unavailable'); }
function samePairing(a: PairingScope, b: PairingScope): boolean {
  return a.userId === b.userId && a.characterId === b.characterId && a.characterInstanceId === b.characterInstanceId;
}
function validPairing(pairing: PairingScope): boolean {
  return [pairing.userId, pairing.characterId, pairing.characterInstanceId].every(value =>
    typeof value === 'string' && !!value.trim() && value.length <= 128 && !value.includes('\0'));
}
function validToolCall(call: WorkRequest['toolCall']): boolean {
  if (call === undefined) return true;
  if (!call || !/^[A-Za-z0-9_.-]{1,128}$/.test(call.name) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return false;
  try { const encoded = JSON.stringify(call.arguments); return typeof encoded === 'string' && Buffer.byteLength(encoded, 'utf8') <= 64 * 1024; }
  catch { return false; }
}
function validRequest(request: WorkRequest): boolean {
  return !!request && validToolCall(request.toolCall) && (request.protocol !== 'mcp' || request.toolCall !== undefined) &&
    /^[A-Za-z0-9:_-]{1,160}$/.test(request.operationId) &&
    Number.isSafeInteger(request.revision) && request.revision >= 1 &&
    ['acp', 'mcp', 'internal_harness'].includes(request.protocol) &&
    (request.executorRevision === undefined || Number.isSafeInteger(request.executorRevision) && request.executorRevision >= 0) &&
    typeof request.executorId === 'string' && !!request.executorId.trim() && request.executorId.length <= 128 &&
    !!request.target && typeof request.target.title === 'string' && request.target.title.length <= 500 &&
    typeof request.instruction === 'string' && !!request.instruction.trim() && request.instruction.length <= 20_000 &&
    !request.instruction.includes('\0') && Array.isArray(request.permissionGrant) && request.permissionGrant.length <= 100 &&
    request.permissionGrant.every(grant => typeof grant === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(grant)) &&
    typeof request.requestedAt === 'string' && Number.isFinite(Date.parse(request.requestedAt));
}

function forgottenRequest(request: WorkRequest): WorkRequest {
  const safeRequest: Record<string, unknown> = { ...request };
  if (request.protocol === 'mcp') safeRequest.toolCall = { name: 'forgotten', arguments: {} };
  else delete safeRequest.toolCall;
  return { ...safeRequest, executorId: 'forgotten', target: { title: '已遗忘的工作任务' },
    instruction: '已按要求遗忘。', permissionGrant: [] } as unknown as WorkRequest;
}

function forgottenReceipt(receipt: WorkReceipt): WorkReceipt {
  return { operationId: receipt.operationId, status: receipt.status, updatedAt: receipt.updatedAt,
    error: { code: 'forgotten', message: '任务内容已按要求遗忘。', retryable: false } };
}

/** Durable at-most-once boundary for ACP/MCP execution. An attempted operation is never reset. */
export class SqliteWorkProtocolJournal {
  private readonly db: Database.Database;

  constructor(filename: string) {
    if (!isAbsolute(filename) || basename(filename) !== 'work-protocol.sqlite') invalid();
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const header = Buffer.alloc(100);
      const info = fstatSync(fd);
      if (!info.isFile() || !isPrivateFileSync(filename, info) || readSync(fd, header, 0, 100, 0) !== 100 ||
        header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header.readUInt32BE(68) !== APPLICATION_ID ||
        ![1, 2, 3].includes(header.readUInt32BE(60))) invalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      const newFile = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(newFile);
      created = true;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (created && process.platform === 'win32') restrictPrivatePathSync(filename);
    this.db = new Database(filename, { fileMustExist: true });
    try {
      this.db.pragma('secure_delete=ON');
      this.db.transaction(() => {
        const app = Number(this.db.pragma('application_id', { simple: true }));
        const version = Number(this.db.pragma('user_version', { simple: true }));
        const tables = Number((this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n);
        if (created) {
          if (app !== 0 || version !== 0 || tables !== 0) invalid();
          this.db.pragma(`application_id=${APPLICATION_ID}`);
          this.db.pragma('user_version=3');
        this.db.exec(`CREATE TABLE protocol_operations(
            operation_id TEXT PRIMARY KEY,
            request_json TEXT NOT NULL,
            pairing_json TEXT,
            dispatch_started INTEGER NOT NULL CHECK(dispatch_started IN (0,1)),
            receipt_json TEXT,
            event_published INTEGER NOT NULL CHECK(event_published IN (0,1)),
            forgotten INTEGER NOT NULL DEFAULT 0 CHECK(forgotten IN (0,1))
          )`);
        } else {
          const columns = (this.db.pragma('table_info(protocol_operations)') as { name: string }[]).map(column => column.name);
          const legacyColumns = ['operation_id', 'request_json', 'pairing_json', 'dispatch_started', 'receipt_json', 'event_published'];
          if (app !== APPLICATION_ID || ![1, 2, 3].includes(version) || tables !== 1 ||
            JSON.stringify(columns) !== JSON.stringify(version === 3 ? [...legacyColumns, 'forgotten'] : legacyColumns)) invalid();
          if (version === 1) {
            const rows = this.db.prepare('SELECT operation_id,request_json FROM protocol_operations').all() as { operation_id: string; request_json: string }[];
            for (const row of rows) {
              let parsed: unknown;
              try { parsed = JSON.parse(row.request_json); } catch { invalid(); }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
              const prior = parsed as Record<string, unknown>;
              const request = { ...prior, revision: prior.revision ?? 1 } as unknown as WorkRequest;
              if (!validRequest(request) || request.operationId !== row.operation_id) invalid();
              this.db.prepare('UPDATE protocol_operations SET request_json=? WHERE operation_id=?')
                .run(JSON.stringify(request), row.operation_id);
            }
            this.db.pragma('user_version=2');
          }
          if (version < 3) {
            this.db.exec('ALTER TABLE protocol_operations ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0 CHECK(forgotten IN (0,1))');
            this.db.pragma('user_version=3');
          }
        }
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  entries(): WorkProtocolJournalEntry[] {
    const rows = this.db.prepare('SELECT operation_id,request_json,pairing_json,dispatch_started,receipt_json,event_published,forgotten FROM protocol_operations ORDER BY operation_id')
      .all() as { operation_id: string; request_json: string; pairing_json: string | null; dispatch_started: number; receipt_json: string | null; event_published: number; forgotten: number }[];
    return rows.map(row => {
      const request = JSON.parse(row.request_json) as WorkRequest;
      if (!validRequest(request) || request.operationId !== row.operation_id) invalid();
      const pairing = row.pairing_json ? JSON.parse(row.pairing_json) as PairingScope : undefined;
      if (pairing && !validPairing(pairing)) invalid();
      const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as WorkReceipt : undefined;
      if (receipt && (receipt.operationId !== request.operationId || !Number.isFinite(Date.parse(receipt.updatedAt)) ||
        !['prepared', 'dispatched', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'].includes(receipt.status))) invalid();
      return { request, ...(pairing ? { pairing } : {}), dispatchStarted: row.dispatch_started === 1,
        eventPublished: row.event_published === 1, forgotten: row.forgotten === 1, ...(receipt ? { receipt } : {}) };
    });
  }

  assertPairing(operationId: string, pairing: PairingScope): void {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(operationId) || !validPairing(pairing)) invalid();
    const row = this.db.prepare('SELECT pairing_json FROM protocol_operations WHERE operation_id=?')
      .get(operationId) as { pairing_json: string | null } | undefined;
    if (!row) throw new Error('request_not_found');
    if (!row.pairing_json || !samePairing(JSON.parse(row.pairing_json) as PairingScope, pairing)) {
      throw new Error('pairing_mismatch');
    }
  }

  assertRevision(operationId: string, expectedRevision: number): void {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid();
    const row = this.db.prepare('SELECT request_json FROM protocol_operations WHERE operation_id=?')
      .get(operationId) as { request_json: string } | undefined;
    if (!row) throw new Error('request_not_found');
    const request = JSON.parse(row.request_json) as WorkRequest;
    if (!validRequest(request) || request.operationId !== operationId) invalid();
    if (request.revision !== expectedRevision) throw new Error('request_revision_conflict');
  }

  isForgotten(operationId: string): boolean {
    const row = this.db.prepare('SELECT forgotten FROM protocol_operations WHERE operation_id=?').get(operationId) as { forgotten: number } | undefined;
    if (!row) throw new Error('request_not_found');
    return row.forgotten === 1;
  }

  /** Erase task bodies while retaining an opaque at-most-once tombstone and audit status. */
  forget(operationId: string, pairing: PairingScope): void {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(operationId) || !validPairing(pairing)) invalid();
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT request_json,pairing_json,receipt_json FROM protocol_operations WHERE operation_id=?')
        .get(operationId) as { request_json: string; pairing_json: string | null; receipt_json: string | null } | undefined;
      if (!row) throw new Error('request_not_found');
      if (!row.pairing_json || !samePairing(JSON.parse(row.pairing_json) as PairingScope, pairing)) throw new Error('pairing_mismatch');
      const request = JSON.parse(row.request_json) as WorkRequest;
      if (!validRequest(request) || request.operationId !== operationId) invalid();
      const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as WorkReceipt : undefined;
      this.db.prepare('UPDATE protocol_operations SET request_json=?,receipt_json=?,forgotten=1 WHERE operation_id=?')
        .run(JSON.stringify(forgottenRequest(request)), receipt ? JSON.stringify(forgottenReceipt(receipt)) : null, operationId);
    }).immediate();
  }

  prepare(request: WorkRequest, pairing: PairingScope): void {
    if (!validRequest(request) || !validPairing(pairing)) invalid();
    try {
      this.db.prepare('INSERT INTO protocol_operations(operation_id,request_json,pairing_json,dispatch_started,receipt_json,event_published) VALUES(?,?,?,0,NULL,0)')
        .run(request.operationId, JSON.stringify(request), JSON.stringify(pairing));
    } catch {
      throw new Error('operation_id_conflict');
    }
  }

  revise(request: WorkRequest, expectedRevision: number): void {
    if (!validRequest(request) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid();
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT request_json,dispatch_started,receipt_json,forgotten FROM protocol_operations WHERE operation_id=?')
        .get(request.operationId) as { request_json: string; dispatch_started: number; receipt_json: string | null; forgotten: number } | undefined;
      if (!row) throw new Error('request_not_found');
      const current = JSON.parse(row.request_json) as WorkRequest;
      if (!validRequest(current) || current.operationId !== request.operationId) invalid();
      if (current.revision !== expectedRevision || request.revision !== expectedRevision + 1) {
        throw new Error('request_revision_conflict');
      }
      if (row.dispatch_started === 1 || row.receipt_json) throw new Error('operation_not_revisable');
      if (row.forgotten === 1) throw new Error('operation_forgotten');
      this.db.prepare('UPDATE protocol_operations SET request_json=? WHERE operation_id=? AND dispatch_started=0 AND receipt_json IS NULL')
        .run(JSON.stringify(request), request.operationId);
    }).immediate();
  }

  /** Atomically marks the side-effect boundary before any remote process is started. */
  beginDispatch(operationId: string, pairing: PairingScope, expectedRevision: number): boolean {
    if (!validPairing(pairing)) invalid();
    return this.db.transaction(() => {
      if (!/^[A-Za-z0-9:_-]{1,160}$/.test(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid();
      const row = this.db.prepare('SELECT request_json,pairing_json,dispatch_started,receipt_json,forgotten FROM protocol_operations WHERE operation_id=?')
        .get(operationId) as { request_json: string; pairing_json: string | null; dispatch_started: number; receipt_json: string | null; forgotten: number } | undefined;
      if (!row) throw new Error('request_not_found');
      if (!row.pairing_json || !samePairing(JSON.parse(row.pairing_json) as PairingScope, pairing)) throw new Error('pairing_mismatch');
      const request = JSON.parse(row.request_json) as WorkRequest;
      if (!validRequest(request) || request.operationId !== operationId) invalid();
      if (request.revision !== expectedRevision) throw new Error('request_revision_conflict');
      if (row.forgotten === 1) throw new Error('operation_forgotten');
      if (row.receipt_json || row.dispatch_started === 1) return false;
      this.db.prepare('UPDATE protocol_operations SET dispatch_started=1 WHERE operation_id=? AND dispatch_started=0 AND receipt_json IS NULL')
        .run(operationId);
      return true;
    }).immediate();
  }

  settle(receipt: WorkReceipt): WorkReceipt {
    if (!receipt || !/^[A-Za-z0-9:_-]{1,160}$/.test(receipt.operationId) ||
      !Number.isFinite(Date.parse(receipt.updatedAt)) ||
      !['prepared', 'dispatched', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'].includes(receipt.status)) invalid();
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT receipt_json,forgotten FROM protocol_operations WHERE operation_id=?').get(receipt.operationId) as { receipt_json: string | null; forgotten: number } | undefined;
      if (!row) throw new Error('request_not_found');
      if (row.receipt_json) return JSON.parse(row.receipt_json) as WorkReceipt;
      const durableReceipt = row.forgotten === 1 ? forgottenReceipt(receipt) : receipt;
      this.db.prepare('UPDATE protocol_operations SET receipt_json=? WHERE operation_id=? AND receipt_json IS NULL')
        .run(JSON.stringify(durableReceipt), receipt.operationId);
      return durableReceipt;
    }).immediate();
  }

  markEventPublished(operationId: string): void {
    this.db.prepare('UPDATE protocol_operations SET event_published=1 WHERE operation_id=? AND receipt_json IS NOT NULL').run(operationId);
  }

  /** Any dispatch with no durable terminal receipt crossed the side-effect boundary and becomes uncertain. */
  recoverInFlight(now: string): WorkProtocolJournalEntry[] {
    if (!Number.isFinite(Date.parse(now))) invalid();
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT operation_id,request_json,pairing_json,dispatch_started FROM protocol_operations WHERE dispatch_started=1 AND receipt_json IS NULL')
        .all() as { operation_id: string; request_json: string; pairing_json: string | null; dispatch_started: number }[];
      const recovered: WorkProtocolJournalEntry[] = [];
      for (const row of rows) {
        if (!row.pairing_json) invalid();
        const request = JSON.parse(row.request_json) as WorkRequest;
        const pairing = JSON.parse(row.pairing_json) as PairingScope;
        if (!validRequest(request) || request.operationId !== row.operation_id || !validPairing(pairing)) invalid();
        const receipt: WorkReceipt = {
          operationId: request.operationId,
          status: 'uncertain',
          updatedAt: now,
          error: { code: 'process_restarted_after_dispatch', message: '进程在收到远端终态前退出；请先核对远端状态，系统不会自动重发。', retryable: false },
        };
        this.db.prepare('UPDATE protocol_operations SET receipt_json=? WHERE operation_id=? AND receipt_json IS NULL')
          .run(JSON.stringify(receipt), request.operationId);
        recovered.push({ request, pairing, dispatchStarted: true, eventPublished: false, forgotten: false, receipt });
      }
      return recovered;
    }).immediate();
  }

  close(): void { if (this.db.open) this.db.close(); }
}
