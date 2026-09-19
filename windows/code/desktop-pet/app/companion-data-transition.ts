import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { companionDatabaseFile, legacyTrialDatabaseFile, COMPANION_DATA_PROFILE } from './companion-data.js';
import type { TrialConfiguration } from './trial-config.js';

export interface LegacyDataTransition {
  kind: 'retire_legacy_trial_data';
  id: string;
  files: { database: string; wal: string | null; shm: string | null };
}
type Receipt = { signature: string; state: 'prepared' | 'retiring' | 'complete' };
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => { throw new Error('Legacy data transition requires the exact reviewed files and independent companion data location'); };
const absent = async (path: string) => { try { await lstat(path); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; } };
function validate(value: LegacyDataTransition): void {
  if (!value || value.kind !== 'retire_legacy_trial_data' || typeof value.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(value.id) || !value.files
    || Object.keys(value.files).sort().join(',') !== 'database,shm,wal' || !hash(value.files.database)
    || ![value.files.wal, value.files.shm].every(x => x === null || hash(x))) fail();
}
/** Exactly one destructive transition is supported; ordinary updates retain the existing database. */
export function validateCompanionTransition(current: TrialConfiguration, next: TrialConfiguration, transition: LegacyDataTransition): void {
  validate(transition);
  if (current.product !== undefined || current.database !== legacyTrialDatabaseFile(current.projectRoot)
    || next.projectRoot !== current.projectRoot || next.product !== COMPANION_DATA_PROFILE
    || next.database !== companionDatabaseFile(next.projectRoot)) fail();
}
async function regular(root: string, path: string): Promise<boolean> {
  if (!path.startsWith(resolve(root) + '/')) fail();
  for (let parent = path; parent !== resolve(root); parent = dirname(parent))
    if (!await absent(parent) && (await lstat(parent)).isSymbolicLink()) fail();
  if (await absent(path)) return false;
  if (!(await lstat(path)).isFile()) fail();
  return true;
}
function files(root: string, transition: LegacyDataTransition): [string, string | null][] {
  const database = legacyTrialDatabaseFile(root);
  return [[database + '-wal', transition.files.wal], [database + '-shm', transition.files.shm], [database, transition.files.database]];
}
export async function verifyLegacyData(root: string, transition: LegacyDataTransition, allowMissing = false): Promise<void> {
  validate(transition);
  for (const [path, expected] of files(root, transition)) {
    if (!await regular(root, path)) { if (expected !== null && !allowMissing) fail(); continue; }
    if (expected === null || digest(await readFile(path)) !== expected) fail();
  }
}
export async function assertNewCompanionDataAbsent(root: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) if (await regular(root, companionDatabaseFile(root) + suffix)) fail();
}
function receiptFile(root: string, transition: LegacyDataTransition) {
  return resolve(root, '.local/companion-step1-01/update', transition.id + '.json');
}
function signature(root: string, transition: LegacyDataTransition, nextHash: string) {
  validate(transition); if (!hash(nextHash)) fail();
  return digest(JSON.stringify({ root: resolve(root), id: transition.id, database: transition.files.database, wal: transition.files.wal, shm: transition.files.shm, nextHash }));
}
async function save(path: string, receipt: Receipt) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { if (!await absent(temporary)) await unlink(temporary); }
}
export async function readRetirementReceipt(root: string, transition: LegacyDataTransition, nextHash: string): Promise<Receipt> {
  const expected = signature(root, transition, nextHash), path = receiptFile(root, transition);
  if (!await regular(root, path)) fail();
  const receipt = JSON.parse(await readFile(path, 'utf8')) as Receipt;
  if (receipt.signature !== expected || !['prepared', 'retiring', 'complete'].includes(receipt.state)) fail();
  return receipt;
}
/** Prepare metadata only; never copies old conversations, weights, credentials or a database backup. */
export async function prepareRetirement(root: string, transition: LegacyDataTransition, nextHash: string): Promise<void> {
  const expected = signature(root, transition, nextHash), path = receiptFile(root, transition);
  await verifyLegacyData(root, transition);
  if (!await absent(path)) { const previous = await readRetirementReceipt(root, transition, nextHash); if (previous.state !== 'prepared') fail(); return; }
  // Inspect parent symlinks even while the final receipt does not yet exist.
  await regular(root, path); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ signature: expected, state: 'prepared' }) + '\n', { mode: 0o600, flag: 'wx' });
}
/** After fully verified code/config installation. On failure stay on new config PREPARED, never roll back to an empty old DB. */
export async function retireLegacyData(root: string, transition: LegacyDataTransition, nextHash: string, guard: () => Promise<void>): Promise<void> {
  const receipt = await readRetirementReceipt(root, transition, nextHash), path = receiptFile(root, transition);
  await guard();
  if (receipt.state === 'complete') {
    for (const [file] of files(root, transition)) if (!await absent(file)) fail();
    return;
  }
  await verifyLegacyData(root, transition, receipt.state === 'retiring');
  await save(path, { ...receipt, state: 'retiring' });
  for (const [file] of files(root, transition)) {
    await guard(); await verifyLegacyData(root, transition, true);
    if (!await absent(file)) await unlink(file);
  }
  await save(path, { ...receipt, state: 'complete' });
}
