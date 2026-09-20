import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ManagementError, type ManagedSettings, type SettingsSnapshot } from '../contracts/management.js';
import type { TrialConfiguration } from '../app/trial-config.js';
import { defaultManagedSettings, validateManagedSettings } from './settings.js';
import { credentialRegistry } from './credentials.js';
import type { RegisteredVoiceStore } from '../providers/registered-voices.js';

interface Revision { revision: number; savedAt: string; settings: ManagedSettings }
interface SettingsFile { version: 1; current: Revision; history: Revision[] }
/** One live backend owns writes. Saving never mutates its effective configuration. */
export class ManagementSettingsStore {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly file: string, private readonly base: TrialConfiguration, private state: SettingsFile,
    readonly effective: ManagedSettings, readonly effectiveRevision: number, readonly registeredVoices?: RegisteredVoiceStore,
    private readonly credentials = credentialRegistry(base), private readonly draftOnly = false) {}
  static async open(file: string, base: TrialConfiguration, voices?: RegisteredVoiceStore, options: {credentials?:ReturnType<typeof credentialRegistry>;draftOnly?:boolean} = {}): Promise<ManagementSettingsStore> {
    const credentials=options.credentials??credentialRegistry(base),draftOnly=options.draftOnly??false;
    let state: SettingsFile;
    try {
      state = JSON.parse(await readFile(file, 'utf8')) as SettingsFile;
      if (state.version !== 1 || !state.current || !Number.isSafeInteger(state.current.revision) || state.current.revision < 1 || !Array.isArray(state.history)) throw new Error('Invalid settings history');
      state.current.settings = validateManagedSettings(state.current.settings, base, voices, false, credentials, draftOnly);
      if (state.history.length > 10 || state.history.some(item => !Number.isSafeInteger(item.revision) || item.revision < 0 || item.revision >= state.current.revision)) throw new Error('Invalid settings revision');
      for (const item of state.history) item.settings = validateManagedSettings(item.settings, base, voices, true, credentials, draftOnly);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { version: 1, current: { revision: 0, savedAt: new Date().toISOString(), settings: defaultManagedSettings(base, credentials) }, history: [] };
    }
    return new ManagementSettingsStore(file, base, state, structuredClone(state.current.settings), state.current.revision, voices, credentials, draftOnly);
  }
  snapshot(): SettingsSnapshot {
    return { revision: this.state.current.revision, effectiveRevision: this.effectiveRevision, savedAt: this.state.current.revision ? this.state.current.savedAt : null,
      pending: JSON.stringify(this.state.current.settings) !== JSON.stringify(this.effective), applyOn: 'restart',
      effective: structuredClone(this.effective), saved: structuredClone(this.state.current.settings), history: this.state.history.map(({ revision, savedAt }) => ({ revision, savedAt })) };
  }
  save(expectedRevision: number, settings: unknown): Promise<SettingsSnapshot> { return this.commit(expectedRevision, () => validateManagedSettings(settings, this.base, this.registeredVoices, false, this.credentials, this.draftOnly)); }
  rollback(expectedRevision: number, targetRevision: number): Promise<SettingsSnapshot> {
    return this.commit(expectedRevision, () => { const target = this.state.history.find(item => item.revision === targetRevision); if (!target) throw new ManagementError('not_found', '没有这个可回滚配置版本。'); return validateManagedSettings(target.settings, this.base, this.registeredVoices, false, this.credentials, this.draftOnly); });
  }
  private commit(expected: number, getSettings: () => ManagedSettings): Promise<SettingsSnapshot> {
    const run = this.tail.then(async () => {
      if (!Number.isSafeInteger(expected) || expected !== this.state.current.revision) throw new ManagementError('version_conflict', '配置已被更新，请刷新后再保存。');
      const next: SettingsFile = { version: 1, current: { revision: expected + 1, savedAt: new Date().toISOString(), settings: getSettings() }, history: [...this.state.history, this.state.current].slice(-10) };
      await mkdir(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${randomUUID()}.next`;
      try { await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      this.state = next; return this.snapshot();
    });
    this.tail = run.catch(() => {}); return run;
  }
  async drain(): Promise<void> { await this.tail; }
  /** FIX61-10: a test or a closing runtime releases its tail here; a live server keeps writing. */
  close(): Promise<void> { return this.drain(); }
}
