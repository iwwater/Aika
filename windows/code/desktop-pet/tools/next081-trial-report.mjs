#!/usr/bin/env node
/**
 * tools/next081-trial-report.mjs
 *
 * N081-07: 正常配置试运行日报与版本收口。
 *
 * 严格边界（SPEC 要求）：
 *  - 只通过 N081-06 的鉴权 `GET /api/collection/status` 与时间范围分页查询读取**聚合计数**。
 *  - 人工标注走 `POST /api/collection/samples/:id/feedback`；漏采走独立
 *    `POST /api/collection/feedback/missing`，绝不造一个假样本 ID。
 *  - **不直接扫用户截图目录、不解析 SQLite、不绕过授权**。
 *  - 日报只引用聚合计数、脱敏 sampleId 与来源状态；不附用户图片或键盘正文。
 *  - 发现的契约缺口回到负责的 N081-01～06 修复并重验，不在本脚本里私造兼容接口。
 *
 * 用法：
 *   node tools/next081-trial-report.mjs --days 1
 *   node tools/next081-trial-report.mjs --days 3 --out reports/trial-day-3.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managementUrl } from './management-url.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { days: 1, out: '', config: '' };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--days') options.days = Number(argv[++index]);
    else if (value === '--out') options.out = argv[++index];
    else if (value === '--config') options.config = argv[++index];
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write([
    'N081-07 collection trial report',
    '',
    '  node tools/next081-trial-report.mjs [--days N] [--out file.json] [--config config.json]',
    '',
    'Reads only aggregate counts through the authenticated local management API.',
    'It never scans a screenshot directory, never opens SQLite and never prints user content.',
    '',
  ].join('\n'));
  process.exit(0);
}

if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 30) {
  process.stderr.write('--days must be an integer between 1 and 30.\n');
  process.exit(2);
}

const configFile = options.config || resolve(root, '..', '.local/model-evaluation/trial/user-trial/config.json');
if (!existsSync(configFile)) {
  console.error(`NOT_RUN: no running product configuration at ${configFile}.`);
  console.error('Start the configured Windows product first; this script only reads a live instance.');
  process.exit(3);
}

let url;
try { url = await managementUrl(configFile); }
catch (error) {
  console.error(`NOT_RUN: ${error instanceof Error ? error.message : 'management backend unavailable'}`);
  process.exit(3);
}

const parsed = new URL(url);
const headers = { authorization: 'Bearer ' + parsed.hash.slice(7) };
const api = async path => {
  const response = await fetch(parsed.origin + path, { headers, redirect: 'error' });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
};

const to = new Date();
const from = new Date(to.getTime() - options.days * 86_400_000);

// 1. Aggregate status: per-source counters, managed bytes, queue depth, policy identity.
const status = await api('/api/collection/status');

// 2. Bounded sample listing inside the trial window, paged to completion.
const items = [];
let cursor = null;
let totalMatching = 0;
for (let page = 0; page < 40; page++) {
  const query = new URLSearchParams({
    from: from.toISOString(), to: to.toISOString(), limit: '100',
    ...(cursor ? { cursor } : {}),
  });
  const result = await api(`/api/collection/samples?${query.toString()}`);
  items.push(...(result.items ?? []));
  totalMatching = result.totalMatching ?? items.length;
  cursor = result.nextCursor;
  if (!cursor) break;
}

// Per-day aggregation of counts only. No sample content, no image bytes, no keyboard text.
const byDay = new Map();
const byKind = new Map();
for (const item of items) {
  const day = String(item.receivedAt ?? '').slice(0, 10) || 'unknown';
  const dayBucket = byDay.get(day) ?? { day, keyboard: 0, image: 0, expiredOrInvalid: 0 };
  if (item.state !== 'active') dayBucket.expiredOrInvalid++;
  else if (item.sampleKind === 'keyboard_activity') dayBucket.keyboard++;
  else dayBucket.image++;
  byDay.set(day, dayBucket);

  const kindBucket = byKind.get(item.sourceKind) ?? { sourceKind: item.sourceKind, count: 0, distinctAssets: new Set() };
  kindBucket.count++;
  if (item.sampleKind === 'image' && item.assetId) kindBucket.distinctAssets.add(item.assetId);
  byKind.set(item.sourceKind, kindBucket);
}

/**
 * Trial-day accounting. A day counts only when the instance profile is `normal`; a smoke run is a
 * controlled test and is reported separately, never folded into natural-use coverage.
 */
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  window: { from: from.toISOString(), to: to.toISOString(), days: options.days },
  profile: status.profile,
  naturalUseEligible: status.profile === 'normal',
  instanceId: String(status.instanceId ?? '').slice(0, 8) + '…',
  pairing: {
    // Pairing identity is echoed in short form only; it is not user content.
    characterId: status.pairing?.characterId ?? null,
    instance: String(status.pairing?.characterInstanceId ?? '').slice(0, 8) + '…',
  },
  policy: { version: status.policyVersion, retentionMs: status.policy?.sampleRetentionMs ?? null,
    managedByteLimit: status.policy?.managedByteLimit ?? null },
  totals: {
    matching: totalMatching, listed: items.length,
    managedBytes: status.managedBytes, queueItems: status.queueItems, queueBytes: status.queueBytes,
    collectionRevision: status.collectionRevision,
  },
  sources: (status.sources ?? []).map(source => ({
    kind: source.kind, state: source.state, revision: source.revision,
    accepted: source.accepted, duplicates: source.duplicates, rejected: source.rejected, dropped: source.dropped,
    // The authorized path is operator-visible in the console; the report only records that one exists.
    hasAuthorizedDirectory: typeof source.directoryDisplayPath === 'string' && source.directoryDisplayPath.length > 0,
    grantExpiresAt: source.grantExpiresAt, lastAcceptedAt: source.lastAcceptedAt,
    lastErrorCode: source.lastErrorCode,
  })),
  byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  byKind: [...byKind.values()].map(entry => ({
    sourceKind: entry.sourceKind, count: entry.count, distinctAssets: entry.distinctAssets.size,
  })),
};

const serialized = JSON.stringify(report, null, 2) + '\n';

// A privacy guard: the report must not contain a filesystem path or image payload.
for (const forbidden of ['\\\\', 'file://', 'data:image', 'base64,']) {
  if (serialized.includes(forbidden)) {
    console.error(`Refusing to write: the report contains '${forbidden}', which is not aggregate data.`);
    process.exit(4);
  }
}

if (options.out) {
  await writeFile(resolve(root, options.out), serialized);
  process.stdout.write(`Report written: ${resolve(root, options.out)}\n`);
} else {
  process.stdout.write(serialized);
}

// A smoke run cannot satisfy the natural-use requirement; say so rather than implying coverage.
if (!report.naturalUseEligible) {
  process.stderr.write('NOTE: this instance is running the smoke profile; its samples are controlled test data and do not count toward natural-use coverage.\n');
}
