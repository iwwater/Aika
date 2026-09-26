// FIX61-02: the discovery plane. This file caches what a models resource returned and which
// endpoint/protocol/credential it came from. It deliberately holds NO seven-slot binding: the single
// source of truth for "which model serves which slot" stays ManagedSettings.providers in
// management-settings.json. Nothing here is applied to the runtime.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import { isAllowedEndpoint } from '../providers/slot-registry.js';
import type { CapabilityEvidence, DiscoveryProtocol, DiscoveredModel } from './model-discovery.js';
// This store owns the discovery cache only. It never stores a slot -> model binding: that stays in
// ManagedSettings.providers (management-settings.json), the single source of truth for the seven slots.

export interface StoredDiscoveryObject {
  readonly value: string;
  readonly label: string;
  readonly evidence: CapabilityEvidence;
  readonly methods: readonly string[];
}
export interface StoredDiscoveryDraft {
  readonly version: 1;
  readonly revision: number;
  readonly protocol: DiscoveryProtocol;
  readonly endpoint: string;
  readonly modelsEndpoint: string | null;
  readonly credentialRef: string | null;
  readonly objects: readonly StoredDiscoveryObject[];
  readonly observedAt: string | null;
  readonly truncated: boolean;
}
export interface DiscoverySelection {
  protocol: DiscoveryProtocol;
  endpoint: string;
  modelsEndpoint?: string | null;
  credentialRef?: string | null;
}
export interface DiscoveryObservation extends DiscoverySelection {
  items: readonly DiscoveredModel[];
  checkedAt: string;
  truncated: boolean;
}

const PROTOCOLS: readonly DiscoveryProtocol[] = ['openai-compatible', 'gemini'];
const item = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Validates the discovery inputs; a raw key is refused because only a reference may be stored. */
export function validateSelection(value: unknown): DiscoverySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', '模型发现配置无效。');
  const raw = value as Record<string, unknown>;
  for (const forbidden of ['apiKey', 'api_key', 'key', 'credential', 'token']) {
    if (forbidden in raw) throw new ManagementError('invalid_request', '模型发现只接受本机凭据引用，不能提交密钥正文。');
  }
  if (!PROTOCOLS.includes(raw.protocol as DiscoveryProtocol)) throw new ManagementError('invalid_request', '协议未登记，本版本只支持 openai-compatible 与 gemini 的模型发现。');
  if (!isAllowedEndpoint(raw.endpoint)) throw new ManagementError('invalid_request', '服务地址必须是 HTTPS 或显式回环 HTTP，且不能交给重定向后的其他主机。');
  if (raw.modelsEndpoint !== undefined && raw.modelsEndpoint !== null && raw.modelsEndpoint !== '' && !isAllowedEndpoint(raw.modelsEndpoint)) {
    throw new ManagementError('invalid_request', '模型列表地址必须是 HTTPS 或显式回环 HTTP。');
  }
  if (raw.credentialRef !== undefined && raw.credentialRef !== null && raw.credentialRef !== '' && !item(raw.credentialRef, 200)) {
    throw new ManagementError('invalid_request', '凭据引用无效。');
  }
  return { protocol: raw.protocol as DiscoveryProtocol, endpoint: raw.endpoint as string,
    modelsEndpoint: raw.modelsEndpoint === undefined || raw.modelsEndpoint === null || raw.modelsEndpoint === '' ? null : raw.modelsEndpoint as string,
    credentialRef: raw.credentialRef === undefined || raw.credentialRef === null || raw.credentialRef === '' ? null : raw.credentialRef as string };
}

function objects(items: readonly DiscoveredModel[]): StoredDiscoveryObject[] {
  const seen = new Set<string>();
  const result: StoredDiscoveryObject[] = [];
  for (const entry of items) {
    if (!item(entry.id, 200) || seen.has(entry.id) || result.length >= 1000) continue;
    seen.add(entry.id);
    const methods = Array.isArray(entry.capabilities?.methods) ? entry.capabilities.methods.filter(method => item(method, 40)) : [];
    result.push({ value: entry.id, label: item(entry.label, 160) ? entry.label : entry.id,
      evidence: entry.capabilities?.evidence === 'declared' && methods.length ? 'declared' : 'unknown', methods: Object.freeze([...methods]) });
  }
  return result;
}

/** Re-reads a stored cache defensively; a hand-edited file can never inject markup or an unbounded list. */
function readObjects(value: readonly unknown[]): StoredDiscoveryObject[] {
  const result: StoredDiscoveryObject[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || result.length >= 1000) continue;
    const record = entry as Record<string, unknown>;
    if (!item(record.value, 200)) continue;
    const methods = Array.isArray(record.methods) ? record.methods.filter(method => item(method, 40)) : [];
    result.push({ value: record.value, label: item(record.label, 160) ? record.label : record.value,
      evidence: record.evidence === 'declared' && methods.length ? 'declared' : 'unknown', methods: Object.freeze([...methods]) });
  }
  return result;
}

function fresh(): StoredDiscoveryDraft {
  return { version: 1, revision: 0, protocol: 'openai-compatible', endpoint: '', modelsEndpoint: null, credentialRef: null, objects: [], observedAt: null, truncated: false };
}

/** Single-writer durable cache, shaped after ManagementSettingsStore (temp file + rename, revision checked on user writes). */
export class AikaDiscoveryDraftStore {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly file: string, private state: StoredDiscoveryDraft) {}
  static async open(file: string): Promise<AikaDiscoveryDraftStore> {
    let state = fresh();
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as StoredDiscoveryDraft;
      if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !PROTOCOLS.includes(raw.protocol) || !Array.isArray(raw.objects)) throw new Error('Invalid discovery cache');
      state = { ...fresh(), ...raw, objects: readObjects(raw.objects) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new AikaDiscoveryDraftStore(file, state);
  }
  /** Read-only snapshot of the cached source and list. */
  snapshot(): StoredDiscoveryDraft { return structuredClone(this.state); }
  revision(): number { return this.state.revision; }
  /** User-driven selection. A different endpoint invalidates the cached list: those ids came from somewhere else. */
  select(expectedRevision: number, selection: DiscoverySelection): Promise<StoredDiscoveryDraft> {
    return this.commit(() => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.state.revision) {
        throw new ManagementError('version_conflict', '模型发现配置已被更新，请刷新后再保存。');
      }
      const sameSource = selection.protocol === this.state.protocol && selection.endpoint === this.state.endpoint
        && (selection.modelsEndpoint ?? null) === this.state.modelsEndpoint;
      return { ...this.state, revision: this.state.revision + 1, protocol: selection.protocol, endpoint: selection.endpoint,
        modelsEndpoint: selection.modelsEndpoint ?? null, credentialRef: selection.credentialRef ?? this.state.credentialRef,
        objects: sameSource ? this.state.objects : [], observedAt: sameSource ? this.state.observedAt : null, truncated: sameSource ? this.state.truncated : false };
    });
  }
  /** Server-driven cache refresh. A failed discovery never calls this, so a failure cannot clear the list. */
  observe(observation: DiscoveryObservation): Promise<StoredDiscoveryDraft> {
    return this.commit(() => ({ version: 1, revision: this.state.revision + 1, protocol: observation.protocol, endpoint: observation.endpoint,
      modelsEndpoint: observation.modelsEndpoint ?? null, credentialRef: observation.credentialRef ?? this.state.credentialRef,
      objects: objects(observation.items), observedAt: observation.checkedAt, truncated: observation.truncated === true }));
  }
  private commit(next: () => StoredDiscoveryDraft): Promise<StoredDiscoveryDraft> {
    const run = this.tail.then(async () => {
      const value = next();
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.next`;
      try { await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      this.state = value;
      return structuredClone(value);
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async drain(): Promise<void> { await this.tail; }
}
