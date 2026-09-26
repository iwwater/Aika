import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CharacterPackStore } from '../memory/character-pack-store.js';
import type { CompanionEventHub } from '../core/companion-event-hub.js';
import { AcpProtocolAdapter, McpToolProtocolAdapter, WorkDispatchManager } from '../core/work-protocol-adapter.js';
import { SqliteWorkProtocolJournal } from '../core/work-protocol-journal.js';
import { isPrivateFileSync, restrictPrivatePathSync } from '../core/platform-files.js';
import type { WorkProtocol, WorkRequest } from '../contracts/perception.js';
import type { WorkProtocolManagement, WorkProtocolProfile, WorkProtocolProfileView, WorkProtocolProfiles,
  WorkProtocolProfilesView, WorkProtocolRecord, WorkProtocolTool } from '../contracts/work-protocol.js';

interface ProfileFile { version: 1; profiles: WorkProtocolProfiles }
interface Adapters { acp: AcpProtocolAdapter; mcp: McpToolProtocolAdapter }
const invalid = (): never => { throw new ManagementError('invalid_request', '工作协议配置或请求无效。'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const text = (value: unknown, max: number): string => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : invalid();
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
};
const samePairing = (a: PairingScope, b: PairingScope): boolean => a.userId === b.userId && a.characterId === b.characterId && a.characterInstanceId === b.characterInstanceId;

function parseProfile(value: unknown, kind: 'acp' | 'mcp', previous?: WorkProtocolProfile): WorkProtocolProfile {
  const raw = object(value);
  exactKeys(raw, ['executorId', 'label', 'command', 'args', 'cwd', 'env', 'requestTimeoutMs', 'maxMessageBytes', ...(kind === 'mcp' ? ['trustedToolPolicies'] : [])]);
  const executorId = text(raw.executorId, 128), label = text(raw.label, 120), command = text(raw.command, 2048);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(executorId) || !label.trim() || !command.trim() || !isAbsolute(command)) invalid();
  const rawArgs = raw.args;
  if (!Array.isArray(rawArgs) || rawArgs.length > 128) invalid();
  const args = (rawArgs as unknown[]).map((arg: unknown) => text(arg, 4096));
  const cwd = raw.cwd === undefined || raw.cwd === '' ? undefined : text(raw.cwd, 2048);
  if (cwd !== undefined && !isAbsolute(cwd)) invalid();
  const envRaw = raw.env === undefined && previous?.executorId === executorId ? previous.env ?? {} : object(raw.env ?? {});
  if (Object.keys(envRaw).length > 64) invalid();
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(envRaw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) invalid();
    env[key] = text(item, 8192);
  }
  const requestTimeoutMs = raw.requestTimeoutMs === undefined ? 30_000 : raw.requestTimeoutMs;
  const maxMessageBytes = raw.maxMessageBytes === undefined ? 8 * 1024 * 1024 : raw.maxMessageBytes;
  if (typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 600_000 ||
      typeof maxMessageBytes !== 'number' || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1024 || maxMessageBytes > 32 * 1024 * 1024) invalid();
  let trustedToolPolicies: WorkProtocolProfile['trustedToolPolicies'];
  if (kind === 'mcp') {
    const policies = object(raw.trustedToolPolicies ?? {});
    if (Object.keys(policies).length > 256) invalid();
    const parsed: Record<string, { readOnly: boolean; requiredGrant?: string }> = {};
    for (const [name, policyValue] of Object.entries(policies)) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) invalid();
      const policy = object(policyValue); exactKeys(policy, ['readOnly', 'requiredGrant']);
      const readOnly = policy.readOnly;
      if (typeof readOnly !== 'boolean') invalid();
      const requiredGrant = policy.requiredGrant === undefined ? undefined : text(policy.requiredGrant, 128);
      if (requiredGrant !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(requiredGrant)) invalid();
      parsed[name] = { readOnly: readOnly as boolean, ...(requiredGrant ? { requiredGrant } : {}) };
    }
    trustedToolPolicies = parsed;
  } else if (raw.trustedToolPolicies !== undefined) invalid();
  return Object.freeze({ executorId, label, command, args: Object.freeze(args), ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length ? { env: Object.freeze(env) } : {}), requestTimeoutMs: requestTimeoutMs as number, maxMessageBytes: maxMessageBytes as number,
    ...(trustedToolPolicies ? { trustedToolPolicies: Object.freeze(trustedToolPolicies) } : {}) });
}

function parseProfiles(value: unknown, revision: number, previous?: WorkProtocolProfiles): WorkProtocolProfiles {
  const raw = object(value); exactKeys(raw, ['acp', 'mcp']);
  return Object.freeze({ revision,
    ...(raw.acp === undefined || raw.acp === null ? {} : { acp: parseProfile(raw.acp, 'acp', previous?.acp) }),
    ...(raw.mcp === undefined || raw.mcp === null ? {} : { mcp: parseProfile(raw.mcp, 'mcp', previous?.mcp) }),
  });
}

function viewProfile(profile: WorkProtocolProfile | undefined): WorkProtocolProfileView | undefined {
  if (!profile) return undefined;
  const { env, ...publicProfile } = profile;
  return Object.freeze({ ...publicProfile, environmentKeys: Object.freeze(Object.keys(env ?? {})) });
}

function stdio(profile: WorkProtocolProfile | undefined) {
  return profile ? { command: profile.command, args: profile.args, ...(profile.cwd ? { cwd: profile.cwd } : {}),
    ...(profile.env ? { env: profile.env } : {}), ...(profile.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: profile.requestTimeoutMs }),
    ...(profile.maxMessageBytes === undefined ? {} : { maxMessageBytes: profile.maxMessageBytes }) } : undefined;
}

function profileState(raw: unknown): WorkProtocolProfiles {
  const file = object(raw);
  exactKeys(file, ['version', 'profiles']);
  if (file.version !== 1 || !Number.isSafeInteger((file.profiles as Record<string, unknown> | undefined)?.revision) ||
      Number((file.profiles as Record<string, unknown>).revision) < 0) throw new Error('work_protocol_profile_unavailable');
  const value = file.profiles as Record<string, unknown>;
  exactKeys(value, ['revision', 'acp', 'mcp']);
  return parseProfiles({ ...(value.acp === undefined ? {} : { acp: value.acp }), ...(value.mcp === undefined ? {} : { mcp: value.mcp }) }, value.revision as number);
}

/** Runtime owner for explicit ACP/MCP work, private durable journal, and same-pairing forget propagation. */
export class WorkProtocolRuntime implements WorkProtocolManagement {
  private profiles: WorkProtocolProfiles;
  private manager: WorkDispatchManager;
  private adapters: Adapters;
  private reconfiguring = false;
  private toolDiscovery = false;

  private constructor(private readonly profileFile: string, private readonly journal: SqliteWorkProtocolJournal,
    private readonly eventHub: CompanionEventHub, private readonly pairing: PairingScope,
    private readonly characterPacks: CharacterPackStore, profiles: WorkProtocolProfiles) {
    this.profiles = profiles;
    // Persisted tombstones are applied before the manager can replay a pending outbox event.
    this.restoreForgetRevocations();
    ({ adapters: this.adapters, manager: this.manager } = this.createManager(profiles));
  }

  static async open(input: { profileFile: string; journalFile: string; eventHub: CompanionEventHub;
    pairing: PairingScope; characterPacks: CharacterPackStore }): Promise<WorkProtocolRuntime> {
    let profiles: WorkProtocolProfiles = Object.freeze({ revision: 0 });
    try {
      const info = await lstat(input.profileFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 || !isPrivateFileSync(input.profileFile)) throw new Error('work_protocol_profile_unavailable');
      profiles = profileState(JSON.parse(await readFile(input.profileFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const journal = new SqliteWorkProtocolJournal(input.journalFile);
    let runtime: WorkProtocolRuntime | undefined;
    try {
      runtime = new WorkProtocolRuntime(input.profileFile, journal, input.eventHub, input.pairing, input.characterPacks, profiles);
      await runtime.manager.ready();
      return runtime;
    } catch (error) { if (runtime) await runtime.close(); else journal.close(); throw error; }
  }

  snapshot() {
    const requests: WorkProtocolRecord[] = this.journal.entries().filter(entry => entry.pairing && samePairing(entry.pairing, this.pairing))
      .map(({ request, receipt, dispatchStarted, eventPublished, forgotten }) => ({ request, ...(receipt ? { receipt } : {}), dispatchStarted, eventPublished, forgotten }));
    return { profiles: Object.freeze({ revision: this.profiles.revision, ...(viewProfile(this.profiles.acp) ? { acp: viewProfile(this.profiles.acp)! } : {}),
      ...(viewProfile(this.profiles.mcp) ? { mcp: viewProfile(this.profiles.mcp)! } : {}) }), requests: Object.freeze(requests) };
  }

  async saveProfiles(expectedRevision: number, value: unknown): Promise<WorkProtocolProfilesView> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.profiles.revision) throw new ManagementError('version_conflict', '工作协议配置已更新，请刷新后重试。');
    if (this.reconfiguring || this.toolDiscovery || this.manager.hasInFlightDispatches) throw new ManagementError('unavailable', '协议任务正在运行，暂时不能重配执行器。');
    const next = parseProfiles(value, expectedRevision + 1, this.profiles);
    this.reconfiguring = true;
    try {
      await mkdir(dirname(this.profileFile), { recursive: true });
      const temporary = `${this.profileFile}.${randomUUID()}.next`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, profiles: next } satisfies ProfileFile) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.profileFile);
        if (process.platform === 'win32') restrictPrivatePathSync(this.profileFile);
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      await Promise.allSettled([this.adapters.acp.close(), this.adapters.mcp.close()]);
      this.profiles = next;
      ({ adapters: this.adapters, manager: this.manager } = this.createManager(next));
      await this.manager.ready();
      return this.publicProfiles();
    } finally { this.reconfiguring = false; }
  }

  async listTools(): Promise<readonly WorkProtocolTool[]> {
    this.assertAvailable();
    if (!this.profiles.mcp) throw new ManagementError('unavailable', '尚未配置 MCP 工具服务。');
    this.toolDiscovery = true;
    try { return await this.adapters.mcp.listTools() as readonly WorkProtocolTool[]; }
    catch { throw new ManagementError('unavailable', 'MCP 服务连接或工具发现失败；没有执行工具调用。'); }
    finally { this.toolDiscovery = false; }
  }

  prepare(input: Omit<WorkRequest, 'operationId' | 'revision' | 'requestedAt' | 'executorRevision'>): WorkRequest {
    this.assertAvailable();
    if (input.protocol !== 'acp' && input.protocol !== 'mcp') invalid();
    this.assertExecutor(input.protocol, input.executorId);
    if (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 20_000 || input.instruction.includes('\0') ||
        !input.target || typeof input.target.title !== 'string' || !input.target.title.trim() || input.target.title.length > 500) invalid();
    if (input.target.directory !== undefined && (!isAbsolute(input.target.directory) || input.target.directory.includes('\0'))) invalid();
    if (input.protocol === 'mcp' && !input.toolCall || input.protocol === 'acp' && input.toolCall) invalid();
    if (input.toolCall) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.toolCall.name)) invalid();
      try { if (Buffer.byteLength(JSON.stringify(input.toolCall.arguments), 'utf8') > 64 * 1024) invalid(); }
      catch { invalid(); }
    }
    if (!Array.isArray(input.permissionGrant) || input.permissionGrant.length > 100 || input.permissionGrant.some(grant => !/^[A-Za-z0-9_.:-]{1,128}$/.test(grant))) invalid();
    const request = { ...input, operationId: randomUUID(), executorRevision: this.profiles.revision } as Omit<WorkRequest, 'revision' | 'requestedAt'>;
    return this.manager.prepareRequest(request, this.pairing);
  }

  revise(operationId: string, expectedRevision: number,
    updates: Partial<Omit<WorkRequest, 'operationId' | 'revision' | 'requestedAt'>>): WorkRequest {
    this.assertAvailable();
    this.assertNotForgotten(operationId);
    const current = this.manager.getRequest(operationId, this.pairing);
    if (!current) throw new ManagementError('not_found', '工作请求不存在。');
    const nextProtocol = updates.protocol ?? current.protocol;
    const nextExecutor = updates.executorId ?? current.executorId;
    if (nextProtocol !== 'acp' && nextProtocol !== 'mcp') invalid();
    this.assertExecutor(nextProtocol, nextExecutor);
    return this.manager.reviseRequest(operationId, expectedRevision, { ...updates, executorRevision: this.profiles.revision }, this.pairing);
  }

  async confirm(operationId: string, expectedRevision: number) {
    this.assertAvailable();
    this.assertNotForgotten(operationId);
    const request = this.manager.getRequest(operationId, this.pairing);
    if (!request) throw new ManagementError('not_found', '工作请求不存在。');
    if (request.protocol !== 'acp' && request.protocol !== 'mcp') invalid();
    this.assertExecutor(request.protocol, request.executorId, request.executorRevision);
    return this.manager.dispatch(operationId, this.pairing, expectedRevision);
  }

  cancel(operationId: string, expectedRevision: number) {
    this.assertAvailable();
    return this.manager.cancel(operationId, this.pairing, expectedRevision);
  }

  forget(operationId: string): void {
    this.assertAvailable();
    this.manager.forgetRequest(operationId, this.pairing);
    this.characterPacks.revokeSource(this.pairing.characterId, operationId, '用户请求遗忘工程任务');
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.adapters.acp.close(), this.adapters.mcp.close()]);
    this.journal.close();
  }

  private restoreForgetRevocations(): void {
    for (const entry of this.journal.entries()) if (entry.forgotten && entry.pairing && samePairing(entry.pairing, this.pairing)) {
      this.characterPacks.revokeSource(this.pairing.characterId, entry.request.operationId, '用户请求遗忘工程任务');
    }
  }

  private publicProfiles(): WorkProtocolProfilesView {
    return Object.freeze({ revision: this.profiles.revision,
      ...(viewProfile(this.profiles.acp) ? { acp: viewProfile(this.profiles.acp)! } : {}),
      ...(viewProfile(this.profiles.mcp) ? { mcp: viewProfile(this.profiles.mcp)! } : {}) });
  }

  private assertAvailable(): void {
    if (this.reconfiguring) throw new ManagementError('unavailable', '工作协议执行器正在更新，请稍后重试。');
  }

  private assertNotForgotten(operationId: string): void {
    if (this.journal.isForgotten(operationId)) throw new ManagementError('version_conflict', '这项请求已经遗忘，不能再次执行或修改。');
  }

  private assertExecutor(protocol: WorkProtocol, executorId: string, expectedRevision?: number): void {
    if (expectedRevision !== undefined && expectedRevision !== this.profiles.revision) throw new ManagementError('version_conflict', '执行器配置已变化，请重新准备并核对这项任务。');
    const profile = protocol === 'acp' ? this.profiles.acp : protocol === 'mcp' ? this.profiles.mcp : undefined;
    if (!profile || profile.executorId !== executorId) throw new ManagementError('unavailable', '请求所选执行器未配置或已更新。');
  }

  private createManager(profiles: WorkProtocolProfiles): { adapters: Adapters; manager: WorkDispatchManager } {
    const acp = new AcpProtocolAdapter(undefined, undefined, undefined, stdio(profiles.acp));
    const mcpConfig = stdio(profiles.mcp);
    const policies = profiles.mcp?.trustedToolPolicies;
    const mcp = new McpToolProtocolAdapter(undefined, [], mcpConfig ? { ...mcpConfig, ...(policies ? { trustedToolPolicies: policies } : {}) } : undefined);
    return { adapters: { acp, mcp }, manager: new WorkDispatchManager(this.eventHub, acp, mcp, undefined, 5_000, this.journal) };
  }
}
