// Aika static identity and provider-config persistence for Aika Next.
// The prompt reaches the conversation only through the upstream system-context position: SqliteMemoryStore.setPrompt → store.prompt().
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ManagementError, type ProviderSlot } from '../contracts/management.js';
import { DEFAULT_CHARACTER_PROMPTS } from '../companion/prompts.js';
import { COMPANION_ID } from '../contracts/character.js';
import type { TurnScope } from '../contracts/index.js';
import type { SqliteMemoryStore } from '../memory/sqlite-store.js';

/** The seven configurable provider slots; mirrored from the management contract (kept local to avoid a settings.ts cycle). */
const PROVIDER_SLOTS: readonly ProviderSlot[] = ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];

export interface AikaProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly systemPrompt: string;
}

export interface AikaProviderConfig {
  readonly id: string;
  readonly protocol: 'openai-compatible' | 'gemini';
  /** Optional slot binding; when present the composition root routes the named slot through this provider. */
  readonly slot?: ProviderSlot;
  readonly endpoint: string;
  readonly model: string;
  /** Reference into the credential store; the secret itself never enters this JSON. */
  readonly credentialRef: string;
  readonly credentialConfigured: boolean;
}

export function defaultAikaProfile(): AikaProfile {
  return { schemaVersion: 1, id: 'aika', displayName: 'Aika', systemPrompt: DEFAULT_CHARACTER_PROMPTS.companion! };
}

function profileProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '配置不是对象';
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return `不支持的 schemaVersion ${String(raw.schemaVersion)}，本版本只接受 1`;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return 'id 不能为空';
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim()) return 'displayName 不能为空';
  if (typeof raw.systemPrompt !== 'string' || !raw.systemPrompt.trim()) return 'systemPrompt 不能为空';
  return null;
}

export function validateAikaProfile(value: unknown): AikaProfile {
  const problem = profileProblem(value);
  if (problem) throw new ManagementError('invalid_request', `Aika 身份配置无效：${problem}`);
  return Object.freeze(value as AikaProfile);
}

/** Startup-safe read: an invalid stored profile never breaks launch, it falls back to the default identity with an observable reason. */
export function fallbackAikaProfile(raw: unknown): { status: 'applied' | 'fallback'; profile: AikaProfile; error?: string } {
  const problem = profileProblem(raw);
  if (problem) return { status: 'fallback', profile: defaultAikaProfile(), error: problem };
  return { status: 'applied', profile: Object.freeze(raw as AikaProfile) };
}

/** Single sanctioned injection: the profile prompt becomes the character system prompt; assembly reads it exactly once per turn. */
export function applyAikaProfile(store: SqliteMemoryStore, profile: AikaProfile): void {
  const scope: TurnScope = { characterId: COMPANION_ID, sessionId: 'aika-profile', turnId: 'aika-profile', generation: 0 };
  if (store.promptSnapshot(scope).text !== profile.systemPrompt) store.setPrompt(scope, profile.systemPrompt);
}

function providerProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '供应商配置不是对象';
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return 'id 不能为空';
  if (raw.protocol !== 'openai-compatible' && raw.protocol !== 'gemini') return 'protocol 只接受 openai-compatible 或 gemini';
  if ('slot' in raw && raw.slot !== undefined && (typeof raw.slot !== 'string' || !PROVIDER_SLOTS.includes(raw.slot as ProviderSlot))) return 'slot 必须是七个供应商槽之一';
  if (typeof raw.endpoint !== 'string' || !/^https:\/\//.test(raw.endpoint)) return 'endpoint 必须是 https URL';
  if (typeof raw.model !== 'string' || !raw.model.trim()) return 'model 不能为空';
  if (typeof raw.credentialRef !== 'string' || !raw.credentialRef.trim()) return 'credentialRef 不能为空';
  if (typeof raw.credentialConfigured !== 'boolean') return 'credentialConfigured 必须是布尔值';
  if ('apiKey' in raw || 'api_key' in raw || 'key' in raw || 'credentialFile' in raw) return '供应商配置只能保存 credentialRef/credentialConfigured，不能保存凭据正文';
  return null;
}

export function validateAikaProviderConfigs(value: unknown): readonly AikaProviderConfig[] {
  if (!Array.isArray(value)) throw new ManagementError('invalid_request', '供应商配置必须是数组');
  return Object.freeze(value.map(item => {
    const problem = providerProblem(item);
    if (problem) throw new ManagementError('invalid_request', `Aika 供应商配置无效：${problem}`);
    return Object.freeze(item as AikaProviderConfig);
  }));
}

interface ProfileFile { version: 1; revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }

/** Durable single-writer store (temp file + rename + revision conflict), shaped after ManagementSettingsStore. */
export class AikaProfileStore {
  private constructor(readonly file: string, private state: ProfileFile | null) {}
  static async open(file: string): Promise<AikaProfileStore> {
    let state: ProfileFile | null = null;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as ProfileFile;
      if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0) throw new ManagementError('invalid_request', 'Aika 配置文件版本无效');
      state = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new AikaProfileStore(file, state);
  }
  revision(): number { return this.state?.revision ?? 0; }
  /** No held resources; kept for symmetry with the other stores. */
  close(): void {}
  /** Validates stored bytes on read; a foreign schemaVersion fails loudly here instead of at conversation time. */
  loadProfile(): AikaProfile {
    if (!this.state) return defaultAikaProfile();
    const problem = profileProblem(this.state.profile);
    if (problem) throw new ManagementError('invalid_request', `Aika 身份配置无效：${problem}`);
    return Object.freeze(this.state.profile);
  }
  providers(): readonly AikaProviderConfig[] {
    return this.state ? validateAikaProviderConfigs(this.state.providers) : [];
  }
  async save(expectedRevision: number, profile: unknown, providers: unknown): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision()) throw new ManagementError('version_conflict', `配置已被更新（期望修订 ${String(expectedRevision)}，当前 ${this.revision()}），请刷新后再保存。`);
    const validProfile = validateAikaProfile(profile);
    const validProviders = validateAikaProviderConfigs(providers);
    const next: ProfileFile = { version: 1, revision: expectedRevision + 1, profile: validProfile, providers: validProviders };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.next`;
    try {
      await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    this.state = next;
    return { revision: next.revision, profile: validProfile, providers: validProviders };
  }
}
