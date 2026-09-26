#!/usr/bin/env node
/**
 * tools/sanitize-trace-storage.mjs
 * Idempotent sanitization and recovery tool for SQLite runtime_traces storage.
 *
 * Privacy guarantee: NEVER logs, dumps, or outputs plaintext user/reply bodies or stage details.
 * Reports only counts, timestamps, trace IDs, and verification statuses.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const TRACE_DIGEST_PATTERN = /^\[digest:[0-9a-f]{8} len:\d+\]$/;

export const SAFE_METRIC_KEYS = new Set([
  'memories', 'recent', 'inputTokenBudget', 'elapsedMs', 'count', 'tokens',
  'totalTokens', 'inputTokens', 'outputTokens', 'affectedCount', 'sequence',
  'completed', 'total', 'hasContinuity', 'retrievalInvalidated', 'ok',
  'emotion', 'route', 'request', 'status', 'name', 'label', 'code', 'error',
  'model', 'provider', 'outcomeStatus', 'requestId', 'stage',
]);

export function sanitizeTraceText(text) {
  if (!text) return '';
  const len = [...text].length;
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `[digest:${digest} len:${len}]`;
}

export function isSanitizedTraceText(text) {
  return typeof text === 'string' && TRACE_DIGEST_PATTERN.test(text);
}

export function ensureSanitizedTraceText(text) {
  if (!text) return '';
  if (isSanitizedTraceText(text)) return text;
  return sanitizeTraceText(text);
}

function sanitizeUnknownItem(item) {
  if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean') {
    return item;
  }
  if (typeof item === 'string') {
    return ensureSanitizedTraceText(item);
  }
  if (Array.isArray(item)) {
    return item.map(subItem => sanitizeUnknownItem(subItem));
  }
  if (typeof item === 'object') {
    return sanitizeStageDetails(item);
  }
  return undefined;
}

export function sanitizeStageDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      if (SAFE_METRIC_KEYS.has(key) && /^[a-zA-Z0-9_\-\.:]{1,64}$/.test(value)) {
        sanitized[key] = value;
      } else {
        sanitized[key] = ensureSanitizedTraceText(value);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (key === 'affectedIds') {
        sanitized[key] = value.filter(v => typeof v === 'string' && /^[a-zA-Z0-9_\-\.:]{1,64}$/.test(v));
      } else {
        sanitized[key] = value.map(v => sanitizeUnknownItem(v));
      }
      continue;
    }
    if (typeof value === 'object') {
      sanitized[key] = sanitizeStageDetails(value);
    }
  }
  return sanitized;
}

function valueNeedsSanitizing(v, k) {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') {
    return false;
  }
  if (typeof v === 'string') {
    const isSafe = k && SAFE_METRIC_KEYS.has(k) && /^[a-zA-Z0-9_\-\.:]{1,64}$/.test(v);
    return !isSafe && !isSanitizedTraceText(v);
  }
  if (Array.isArray(v)) {
    if (k === 'affectedIds') return false;
    return v.some(item => valueNeedsSanitizing(item));
  }
  if (typeof v === 'object') {
    return Object.entries(v).some(([subK, subV]) => valueNeedsSanitizing(subV, subK));
  }
  return false;
}

export function analyzeDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_traces'").get();
    if (!tableExists) {
      return { totalRows: 0, pendingUserText: 0, pendingReplyText: 0, pendingStages: 0, affectedRows: [] };
    }

    const rows = db.prepare("SELECT trace_id, created_at, user_text, reply_text, stages_json FROM runtime_traces ORDER BY created_at ASC").all();
    let pendingUserText = 0;
    let pendingReplyText = 0;
    let pendingStages = 0;
    const affectedRows = [];

    for (const r of rows) {
      const userNeedsSanitizing = !isSanitizedTraceText(r.user_text);
      const replyNeedsSanitizing = !isSanitizedTraceText(r.reply_text);
      let stagesNeedSanitizing = false;

      try {
        const stages = JSON.parse(r.stages_json);
        for (const s of stages) {
          if (!s.details) continue;
          if (valueNeedsSanitizing(s.details)) {
            stagesNeedSanitizing = true;
            break;
          }
        }
      } catch {}

      if (userNeedsSanitizing) pendingUserText++;
      if (replyNeedsSanitizing) pendingReplyText++;
      if (stagesNeedSanitizing) pendingStages++;

      if (userNeedsSanitizing || replyNeedsSanitizing || stagesNeedSanitizing) {
        affectedRows.push({
          traceId: r.trace_id,
          createdAt: r.created_at,
          userNeedsSanitizing,
          replyNeedsSanitizing,
          stagesNeedSanitizing,
        });
      }
    }

    return {
      totalRows: rows.length,
      pendingUserText,
      pendingReplyText,
      pendingStages,
      affectedRows,
    };
  } finally {
    db.close();
  }
}

export function applySanitization(dbPath, options = {}) {
  const analysis = analyzeDatabase(dbPath);
  if (analysis.affectedRows.length === 0) {
    return { modified: 0, backupPath: null, alreadyClean: true };
  }

  // Mandatory backup before any modification
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = options.backupPath || `${dbPath}.backup.${timestamp}`;
  copyFileSync(dbPath, backupPath);

  // Verify backup integrity
  const backupDb = new Database(backupPath, { readonly: true });
  const check = backupDb.pragma('quick_check');
  backupDb.close();
  if (check[0]?.quick_check !== 'ok') {
    throw new Error(`备份库完整性检查未通过: ${JSON.stringify(check)}`);
  }

  const db = new Database(dbPath);
  let modifiedCount = 0;

  try {
    const updateStmt = db.prepare(`
      UPDATE runtime_traces
      SET user_text = ?, reply_text = ?, stages_json = ?
      WHERE trace_id = ?
    `);

    const selectStmt = db.prepare('SELECT trace_id, user_text, reply_text, stages_json FROM runtime_traces');
    const rows = selectStmt.all();

    const runTransaction = db.transaction(() => {
      for (const r of rows) {
        const newUserText = ensureSanitizedTraceText(r.user_text);
        const newReplyText = ensureSanitizedTraceText(r.reply_text);

        let stagesChanged = false;
        let newStagesJson = r.stages_json;
        try {
          const stages = JSON.parse(r.stages_json);
          const sanitizedStages = stages.map(st => ({
            ...st,
            details: sanitizeStageDetails(st.details),
          }));
          const serialized = JSON.stringify(sanitizedStages);
          if (serialized !== r.stages_json) {
            newStagesJson = serialized;
            stagesChanged = true;
          }
        } catch {}

        if (newUserText !== r.user_text || newReplyText !== r.reply_text || stagesChanged) {
          updateStmt.run(newUserText, newReplyText, newStagesJson, r.trace_id);
          modifiedCount++;
        }
      }
    });

    runTransaction();

    const postCheck = db.pragma('quick_check');
    if (postCheck[0]?.quick_check !== 'ok') {
      throw new Error(`脱敏修改后完整性检查未通过: ${JSON.stringify(postCheck)}`);
    }

    return {
      modified: modifiedCount,
      backupPath,
      alreadyClean: false,
    };
  } finally {
    db.close();
  }
}

export function restoreDatabase(dbPath, backupPath) {
  if (!existsSync(backupPath)) {
    throw new Error(`备份文件不存在: ${backupPath}`);
  }
  const backupDb = new Database(backupPath, { readonly: true });
  const check = backupDb.pragma('quick_check');
  backupDb.close();
  if (check[0]?.quick_check !== 'ok') {
    throw new Error(`待恢复备份文件损坏: ${JSON.stringify(check)}`);
  }

  copyFileSync(backupPath, dbPath);
  return { restoredFrom: backupPath, success: true };
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  let dbPath = null;
  let mode = 'dry-run';
  let backupPath = null;
  let restorePath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      dbPath = resolve(args[++i]);
    } else if (args[i] === '--apply') {
      mode = 'apply';
    } else if (args[i] === '--verify') {
      mode = 'verify';
    } else if (args[i] === '--dry-run') {
      mode = 'dry-run';
    } else if (args[i] === '--restore' && args[i + 1]) {
      mode = 'restore';
      restorePath = resolve(args[++i]);
    } else if (args[i] === '--backup-path' && args[i + 1]) {
      backupPath = resolve(args[++i]);
    }
  }

  if (!dbPath) {
    console.error('用法: node sanitize-trace-storage.mjs --db <db-path> [--dry-run | --apply | --verify | --restore <backup-path>]');
    process.exit(1);
  }

  if (mode === 'restore') {
    const res = restoreDatabase(dbPath, restorePath);
    console.log(JSON.stringify({ mode: 'restore', ...res }, null, 2));
    process.exit(0);
  }

  if (mode === 'dry-run' || mode === 'verify') {
    const analysis = analyzeDatabase(dbPath);
    const result = {
      mode,
      dbPath,
      totalRows: analysis.totalRows,
      pendingUserText: analysis.pendingUserText,
      pendingReplyText: analysis.pendingReplyText,
      pendingStages: analysis.pendingStages,
      affectedCount: analysis.affectedRows.length,
      affectedTraceIds: analysis.affectedRows.map(r => r.traceId),
      isCompliant: analysis.affectedRows.length === 0,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(mode === 'verify' && !result.isCompliant ? 1 : 0);
  }

  if (mode === 'apply') {
    const res = applySanitization(dbPath, { backupPath });
    const postAnalysis = analyzeDatabase(dbPath);
    console.log(JSON.stringify({
      mode: 'apply',
      dbPath,
      modified: res.modified,
      backupPath: res.backupPath,
      alreadyClean: res.alreadyClean,
      postVerification: {
        totalRows: postAnalysis.totalRows,
        unSanitizedRemaining: postAnalysis.affectedRows.length,
        isCompliant: postAnalysis.affectedRows.length === 0,
      }
    }, null, 2));
  }
}
