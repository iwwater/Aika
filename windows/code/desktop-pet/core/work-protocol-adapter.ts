/**
 * core/work-protocol-adapter.ts
 *
 * 08-05: Work Execution & Protocol Adapters (ACP & MCP).
 * Implements idempotent work dispatching, target revision invalidation,
 * uncertain result handling (no blind re-dispatch), and domain-isolated work receipts.
 */

import { createHash } from 'node:crypto';
import type {
  WorkRequest,
  WorkReceipt,
  CompanionEventEnvelope,
} from '../contracts/perception.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CompanionEventHub } from './companion-event-hub.js';
import { StdioJsonRpcProcess, type StdioJsonRpcConfig } from './stdio-json-rpc.js';
import type { SqliteWorkProtocolJournal } from './work-protocol-journal.js';

export interface AcpServerCapabilities {
  readonly protocolVersion: number;
  readonly agents?: readonly string[] | undefined;
  readonly streaming?: boolean | undefined;
}

export interface McpServerCapabilities {
  readonly protocolVersion: string;
  readonly tools?: boolean | undefined;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly requiredGrant?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly handler?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> | unknown;
}

export interface McpStdioConfig extends StdioJsonRpcConfig {
  /** The wire client negotiates modern 2026 metadata with legacy 2025-11-25 fallback. */
  readonly trustedToolPolicies?: Readonly<Record<string, { readonly readOnly: boolean; readonly requiredGrant?: string }>>;
}

export interface AcpTaskResult {
  readonly summary: string;
  readonly remoteTaskId?: string;
}

export type AcpTaskExecutor = (request: WorkRequest, signal?: AbortSignal) => Promise<string | AcpTaskResult>;
export type AcpTaskCanceller = (remoteTaskId: string) => Promise<boolean>;

export const SUPPORTED_ACP_VERSIONS = Object.freeze([1]);
export const SUPPORTED_MCP_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25']);

/**
 * Agent Client Protocol (ACP) Adapter.
 */
export class AcpProtocolAdapter {
  private connected = false;
  private activeProcesses = new Map<string, StdioJsonRpcProcess>();

  constructor(
    private readonly capabilities: AcpServerCapabilities = { protocolVersion: 1 },
    private readonly taskExecutor?: AcpTaskExecutor,
    private readonly taskCanceller?: AcpTaskCanceller,
    private readonly stdio?: StdioJsonRpcConfig,
  ) {}

  async connect(): Promise<void> {
    if (!SUPPORTED_ACP_VERSIONS.includes(this.capabilities.protocolVersion)) {
      throw new Error(`unsupported_protocol_version: ACP version ${this.capabilities.protocolVersion} is not supported`);
    }
    if (!this.taskExecutor && !this.stdio) throw new Error('transport_unavailable: ACP transport is not configured');
    this.connected = true;
  }

  async dispatchTask(request: WorkRequest, signal?: AbortSignal): Promise<WorkReceipt> {
    if (!this.connected) {
      await this.connect();
    }

    if (signal?.aborted) {
      return {
        operationId: request.operationId,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
        error: { code: 'cancelled', message: 'Task dispatch was aborted before invocation', retryable: false },
      };
    }

    try {
      const result = this.taskExecutor
        ? await this.taskExecutor(request, signal)
        : await this.dispatchStdioTask(request, signal);
      const summary = typeof result === 'string' ? result : result.summary;
      return {
        operationId: request.operationId,
        status: 'succeeded',
        updatedAt: new Date().toISOString(),
        ...(typeof result === 'string' || !result.remoteTaskId ? {} : { remoteTaskId: result.remoteTaskId }),
        summary,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        return {
          operationId: request.operationId,
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
          error: { code: 'cancelled', message: 'Task cancelled by user', retryable: false },
        };
      }
      throw err;
    }
  }

  async cancelTask(remoteTaskId: string): Promise<boolean> {
    if (!this.taskCanceller) return false;
    return this.taskCanceller(remoteTaskId);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.activeProcesses.values()].map(process => process.close()));
    this.activeProcesses.clear();
    this.connected = false;
  }

  private async dispatchStdioTask(request: WorkRequest, signal?: AbortSignal): Promise<AcpTaskResult> {
    if (!this.stdio) throw new Error('transport_unavailable: ACP stdio transport is not configured');
    const rpc = new StdioJsonRpcProcess(this.stdio);
    let sessionId: string | undefined;
    const operationId = request.operationId;
    this.activeProcesses.set(operationId, rpc);
    const stopPermissionRequests = rpc.onRequest(message => {
      // No permission UI/bridge is wired yet. Fail closed by denying every agent request.
      if (message.method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
      throw Object.assign(new Error(`Unsupported ACP client request: ${String(message.method)}`), { code: -32601 });
    });
    let abortListener: (() => void) | undefined;
    try {
      const requestOptions = { ...(signal ? { signal } : {}), ...(this.stdio.requestTimeoutMs ? { timeoutMs: this.stdio.requestTimeoutMs } : {}) };
      const initialized = await rpc.request<Record<string, unknown>>('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'aika-next', title: 'Aika', version: '0.8' },
      }, requestOptions);
      if (initialized.protocolVersion !== 1) {
        throw new Error(`unsupported_protocol_version: ACP agent selected ${String(initialized.protocolVersion)}`);
      }
      const cwd = request.target.directory ?? this.stdio.cwd ?? process.cwd();
      if (!cwd || !cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd)) throw new Error('ACP cwd must be absolute');
      const created = await rpc.request<Record<string, unknown>>('session/new', { cwd, mcpServers: [] }, requestOptions);
      if (typeof created.sessionId !== 'string' || !created.sessionId) throw new Error('ACP session/new returned no sessionId');
      sessionId = created.sessionId;
      let summary = '';
      rpc.onNotification(message => {
        if (message.method !== 'session/update' || !message.params || typeof message.params !== 'object') return;
        const update = (message.params as Record<string, unknown>).update;
        if (!update || typeof update !== 'object') return;
        const body = update as Record<string, unknown>;
        const content = body.content;
        if (body.sessionUpdate === 'agent_message_chunk' && content && typeof content === 'object' &&
          (content as Record<string, unknown>).type === 'text' && typeof (content as Record<string, unknown>).text === 'string') {
          summary = `${summary}${(content as Record<string, unknown>).text as string}`.slice(-32_000);
        }
      });
      let cancelRequested = false;
      let cancelTimer: NodeJS.Timeout | undefined;
      const promptPromise = rpc.request<Record<string, unknown>>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: request.instruction }],
      }, this.stdio.requestTimeoutMs ? { timeoutMs: this.stdio.requestTimeoutMs } : {});
      const cancelled = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        abortListener = () => {
          if (cancelRequested) return;
          cancelRequested = true;
          try { rpc.notify('session/cancel', { sessionId }); }
          catch (error) { reject(Object.assign(new Error(`cancel_unconfirmed:${String(error)}`), { code: 'ECANCEL_UNCONFIRMED' })); return; }
          cancelTimer = setTimeout(() => reject(Object.assign(new Error('cancel_unconfirmed: ACP agent did not acknowledge cancellation'), { code: 'ECANCEL_UNCONFIRMED' })), 5_000);
          cancelTimer.unref();
          void promptPromise.then(result => {
            if (result.stopReason === 'cancelled') reject(Object.assign(new Error('Task cancelled by user'), { name: 'AbortError', code: 'ABORT_ERR' }));
            else reject(Object.assign(new Error('cancel_unconfirmed: ACP agent completed without acknowledging cancellation'), { code: 'ECANCEL_UNCONFIRMED' }));
          }, error => reject(Object.assign(new Error(`cancel_unconfirmed:${error instanceof Error ? error.message : String(error)}`), { code: 'ECANCEL_UNCONFIRMED' })));
        };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      });
      const result = signal ? await Promise.race([promptPromise, cancelled]) : await promptPromise;
      if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(String(result.stopReason))) {
        throw new Error(`invalid_acp_stop_reason:${String(result.stopReason)}`);
      }
      if (result.stopReason === 'cancelled') throw Object.assign(new Error('Task cancelled by user'), { name: 'AbortError', code: 'ABORT_ERR' });
      return { summary: summary.trim() || `ACP task finished (${String(result.stopReason)})`, remoteTaskId: sessionId };
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      stopPermissionRequests();
      this.activeProcesses.delete(operationId);
      await rpc.close();
    }
  }
}

/**
 * Model Context Protocol (MCP) Tool Adapter.
 */
export class McpToolProtocolAdapter {
  private connected = false;
  private readonly toolRegistry = new Map<string, McpToolDefinition>();
  private stdioProcess: StdioJsonRpcProcess | undefined;
  private negotiatedVersion: string | undefined;
  private serverCapabilities: Record<string, unknown> = {};

  constructor(
    private readonly capabilities: McpServerCapabilities = { protocolVersion: '2026-07-28', tools: true },
    tools: readonly McpToolDefinition[] = [],
    private readonly stdio?: McpStdioConfig,
  ) {
    for (const tool of tools) {
      this.toolRegistry.set(tool.name, tool);
    }
  }

  async connect(): Promise<void> {
    if (!SUPPORTED_MCP_VERSIONS.includes(this.capabilities.protocolVersion)) {
      throw new Error(`unsupported_protocol_version: MCP version ${this.capabilities.protocolVersion} is not supported`);
    }
    if (this.connected) return;
    if (this.stdio) {
      try {
        await this.connectStdio();
        await this.discoverTools();
      } catch (error) {
        await this.close();
        throw error;
      }
    }
    this.connected = true;
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    if (!this.connected) {
      await this.connect();
    }
    // Return policy-enriched metadata. Remote annotations never grant read-only access.
    return Array.from(this.toolRegistry.values()).map(t => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      requiredGrant: t.requiredGrant,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>, grants: readonly string[], signal?: AbortSignal): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const tool = this.toolRegistry.get(name);
    if (!tool) {
      throw new Error(`tool_not_found: Tool ${name} is not available`);
    }
    if (!tool.handler && !this.stdioProcess) throw new Error(`tool_unavailable: Tool '${name}' has no configured executor`);
    if (signal?.aborted) throw Object.assign(new Error('Tool call was aborted'), { name: 'AbortError' });

    // Permission enforcement
    if (!tool.readOnly) {
      const required = tool.requiredGrant ?? 'write';
      if (!grants.includes(required)) {
        throw new Error(`permission_denied: Tool '${name}' requires '${required}' permission grant`);
      }
    }

    if (tool.handler) return await tool.handler(args, signal);
    const rpc = this.stdioProcess!;
    const params: Record<string, unknown> = { name, arguments: args };
    if (this.negotiatedVersion === '2026-07-28') params._meta = this.modernMeta();
    const result = await rpc.request<Record<string, unknown>>('tools/call', params, {
      ...(this.stdio?.requestTimeoutMs ? { timeoutMs: this.stdio.requestTimeoutMs } : {}),
      ...(signal ? { signal, onAbort: (requestId: number) => rpc.notify('notifications/cancelled', { requestId, reason: 'user_cancelled' }) } : {}),
    });
    this.assertModernResult(result, 'tools/call');
    if (result.isError === true) {
      const content = Array.isArray(result.content) ? result.content : [];
      const detail = content.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .filter(item => item.type === 'text' && typeof item.text === 'string')
        .map(item => item.text as string).join('\n').slice(0, 4_000);
      throw Object.assign(new Error(detail || `MCP tool '${name}' reported an execution error`), { code: 'MCP_TOOL_ERROR' });
    }
    return result;
  }

  async close(): Promise<void> {
    const process = this.stdioProcess;
    this.stdioProcess = undefined;
    this.connected = false;
    this.negotiatedVersion = undefined;
    if (process) await process.close();
  }

  private modernMeta(): Record<string, unknown> {
    return {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'aika-next', version: '0.8' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
  }

  private async connectStdio(): Promise<void> {
    const rpc = new StdioJsonRpcProcess(this.stdio!);
    this.stdioProcess = rpc;
    try {
      let discovery: Record<string, unknown> | undefined;
      try {
        discovery = await rpc.request<Record<string, unknown>>('server/discover', { _meta: this.modernMeta() }, {
          timeoutMs: Math.min(this.stdio!.requestTimeoutMs ?? 5_000, 5_000),
        });
      } catch (error) {
        const rpcError = error as { code?: unknown; data?: unknown };
        const supported = rpcError.data && typeof rpcError.data === 'object'
          ? (rpcError.data as Record<string, unknown>).supported
          : undefined;
        if (rpcError.code === -32022 && Array.isArray(supported)) {
          if (!supported.includes('2026-07-28')) throw new Error(`unsupported_protocol_version: MCP server supports ${supported.join(', ')}`);
          discovery = { resultType: 'complete', supportedVersions: supported };
        }
        // All non-modern errors and probe timeouts identify a legacy implementation on stdio.
      }
      if (discovery) {
        this.assertModernResult(discovery, 'server/discover');
        const versions = discovery.supportedVersions;
        if (!Array.isArray(versions) || !versions.includes('2026-07-28')) {
          throw new Error(`unsupported_protocol_version: MCP server did not advertise 2026-07-28 (${Array.isArray(versions) ? versions.join(', ') : 'invalid discovery response'})`);
        }
        this.negotiatedVersion = '2026-07-28';
        this.serverCapabilities = discovery.capabilities && typeof discovery.capabilities === 'object'
          ? discovery.capabilities as Record<string, unknown> : {};
      } else {
        const initialized = await rpc.request<Record<string, unknown>>('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'aika-next', version: '0.8' },
        }, { ...(this.stdio!.requestTimeoutMs ? { timeoutMs: this.stdio!.requestTimeoutMs } : {}) });
        if (initialized.protocolVersion !== '2025-11-25') {
          throw new Error(`unsupported_protocol_version: MCP server selected ${String(initialized.protocolVersion)}`);
        }
        this.negotiatedVersion = '2025-11-25';
        this.serverCapabilities = initialized.capabilities && typeof initialized.capabilities === 'object'
          ? initialized.capabilities as Record<string, unknown> : {};
        rpc.notify('notifications/initialized');
      }
    } catch (error) {
      this.stdioProcess = undefined;
      await rpc.close();
      throw error;
    }
  }

  private async discoverTools(): Promise<void> {
    const rpc = this.stdioProcess;
    if (!rpc) return;
    if (!this.serverCapabilities.tools) throw new Error('mcp_tools_capability_missing');
    let cursor: string | undefined;
    const names = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const params: Record<string, unknown> = { ...(cursor ? { cursor } : {}) };
      if (this.negotiatedVersion === '2026-07-28') params._meta = this.modernMeta();
      const response = await rpc.request<Record<string, unknown>>('tools/list', params,
        this.stdio?.requestTimeoutMs ? { timeoutMs: this.stdio.requestTimeoutMs } : {});
      this.assertModernResult(response, 'tools/list');
      if (!Array.isArray(response.tools)) throw new Error('invalid_mcp_tools_list_response');
      for (const item of response.tools) {
        if (!item || typeof item !== 'object') throw new Error('invalid_mcp_tool_definition');
        const remote = item as Record<string, unknown>;
        if (typeof remote.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(remote.name) || names.has(remote.name) ||
          remote.description !== undefined && typeof remote.description !== 'string' || !remote.inputSchema || typeof remote.inputSchema !== 'object' || Array.isArray(remote.inputSchema)) {
          throw new Error('invalid_mcp_tool_definition');
        }
        names.add(remote.name);
        const trusted = this.stdio?.trustedToolPolicies?.[remote.name];
        this.toolRegistry.set(remote.name, {
          name: remote.name,
          description: typeof remote.description === 'string' ? remote.description : '',
          readOnly: trusted?.readOnly === true,
          ...(trusted?.requiredGrant ? { requiredGrant: trusted.requiredGrant } : {}),
          inputSchema: remote.inputSchema as Record<string, unknown>,
        });
      }
      if (typeof response.nextCursor !== 'string' || !response.nextCursor) return;
      if (response.nextCursor === cursor) throw new Error('mcp_tools_list_cursor_did_not_advance');
      cursor = response.nextCursor;
    }
    throw new Error('mcp_tools_list_page_limit_exceeded');
  }

  private assertModernResult(result: Record<string, unknown>, method: string): void {
    if (this.negotiatedVersion !== '2026-07-28') return;
    const type = result.resultType;
    if (type !== 'complete') throw new Error(`unsupported_mcp_result_type:${method}:${String(type ?? 'missing')}`);
  }
}

/**
 * Work Dispatch Manager.
 * Orchestrates work requests across ACP, MCP, and native harness protocols.
 * Ensures idempotent dispatch, target revision invalidation, and timeout protection.
 */
export class WorkDispatchManager {
  private readonly requests = new Map<string, WorkRequest>();
  private readonly inFlight = new Map<string, Promise<WorkReceipt>>();
  private readonly receipts = new Map<string, WorkReceipt>();
  private readonly dispatchCounts = new Map<string, number>();
  private readonly operationControllers = new Map<string, AbortController>();
  private recovery: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventHub: CompanionEventHub,
    private readonly acpAdapter: AcpProtocolAdapter,
    private readonly mcpAdapter: McpToolProtocolAdapter,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly cancelTimeoutMs = 5_000,
    private readonly journal?: SqliteWorkProtocolJournal,
  ) {
    if (!journal) return;
    journal.recoverInFlight(this.clock());
    const entries = journal.entries();
    for (const entry of entries) {
      this.requests.set(entry.request.operationId, entry.request);
      if (entry.receipt) this.receipts.set(entry.request.operationId, entry.receipt);
    }
    // Stable event IDs let the timeline deduplicate recovery after a crash between publish and ack.
    this.recovery = this.flushPendingEvents();
    void this.recovery.catch(() => {});
  }

  get hasInFlightDispatches(): boolean { return this.inFlight.size > 0; }

  /** Await startup outbox replay and retry any projection that failed earlier in this process. */
  async ready(): Promise<void> {
    try { await this.recovery; } catch { /* The current retry below decides whether the outbox is still blocked. */ }
    await this.flushPendingEvents();
  }

  prepareRequest(request: Omit<WorkRequest, 'requestedAt' | 'revision'>, pairing?: PairingScope): WorkRequest {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(request.operationId)) throw new Error('invalid_operation_id');
    if (this.requests.has(request.operationId)) throw new Error('operation_id_conflict');
    const fullRequest: WorkRequest = {
      ...request,
      revision: 1,
      requestedAt: this.clock(),
    };
    if (this.journal) {
      if (!pairing) throw new Error('pairing_required_for_durable_work');
      this.journal.prepare(fullRequest, pairing);
    }
    this.requests.set(request.operationId, fullRequest);
    return fullRequest;
  }

  reviseRequest(operationId: string, expectedRevision: number,
    updates: Partial<Omit<WorkRequest, 'operationId' | 'revision' | 'requestedAt'>>, pairing?: PairingScope): WorkRequest {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid_request_revision');
    if (this.journal) {
      if (!pairing) throw new Error('pairing_required_for_durable_work');
      this.journal.assertPairing(operationId, pairing);
      this.journal.assertRevision(operationId, expectedRevision);
    }
    if (this.inFlight.has(operationId) || this.receipts.has(operationId)) {
      throw new Error('invalid_revision: cannot revise an operation that is already dispatched or settled');
    }

    const existing = this.requests.get(operationId);
    if (!existing) {
      throw new Error(`request_not_found: operation ${operationId} does not exist`);
    }
    if (existing.revision !== expectedRevision) throw new Error('request_revision_conflict');
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('request_revision_exhausted');

    const revised: WorkRequest = {
      ...existing,
      ...updates,
      operationId, // keep stable ID
      revision: expectedRevision + 1,
      requestedAt: this.clock(),
    };
    this.journal?.revise(revised, expectedRevision);
    this.requests.set(operationId, revised);
    return revised;
  }

  getRequest(operationId: string, pairing?: PairingScope): WorkRequest | null {
    if (this.journal) {
      if (!pairing) throw new Error('pairing_required_for_durable_work');
      this.journal.assertPairing(operationId, pairing);
    }
    return this.requests.get(operationId) ?? null;
  }

  /** Forget persisted task content without clearing the at-most-once execution tombstone. */
  forgetRequest(operationId: string, pairing: PairingScope): void {
    if (!this.journal) throw new Error('durable_work_journal_required');
    this.journal.forget(operationId, pairing);
    const entry = this.journal.entries().find(value => value.request.operationId === operationId);
    if (!entry?.forgotten) throw new Error('operation_forget_failed');
    this.requests.set(operationId, entry.request);
    if (entry.receipt) this.receipts.set(operationId, entry.receipt);
  }

  async dispatch(operationId: string, pairing: PairingScope, expectedRevision: number, signal?: AbortSignal): Promise<WorkReceipt> {
    // Pairing ownership applies to receipt reads and in-flight idempotency too.
    // Do not leak a settled receipt or promise before checking its durable owner.
    this.journal?.assertPairing(operationId, pairing);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid_request_revision');
    this.journal?.assertRevision(operationId, expectedRevision);
    await this.ready();
    this.journal?.assertRevision(operationId, expectedRevision);
    const request = this.requests.get(operationId);
    if (!request) throw new Error(`request_not_found: operation ${operationId} has not been prepared`);
    if (request.revision !== expectedRevision) throw new Error('request_revision_conflict');
    // 1. Idempotency check: if settled, return settled receipt immediately
    const settled = this.receipts.get(operationId);
    if (settled) {
      return settled;
    }

    // 2. In-flight check: if already executing, return identical promise (dispatch only once!)
    const active = this.inFlight.get(operationId);
    if (active) {
      return active;
    }

    if (this.journal && !this.journal.beginDispatch(operationId, pairing, expectedRevision)) {
      const durable = this.journal.entries().find(entry => entry.request.operationId === operationId);
      if (durable?.receipt) {
        this.receipts.set(operationId, durable.receipt);
        return durable.receipt;
      }
      throw new Error('operation_already_attempted: dispatch is never retried automatically');
    }

    // Track dispatch call count
    const count = (this.dispatchCounts.get(operationId) ?? 0) + 1;
    this.dispatchCounts.set(operationId, count);
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    this.operationControllers.set(operationId, controller);

    const dispatchPromise = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) {
          const cancelled = this.cancelledReceipt(operationId);
          return await this.settle(operationId, cancelled, pairing);
        }

        let receipt: WorkReceipt;

        if (request.protocol === 'acp') {
          receipt = await this.acpAdapter.dispatchTask(request, controller.signal);
        } else if (request.protocol === 'mcp') {
          if (!request.toolCall) throw new Error('mcp_tool_call_required');
          const result = await this.mcpAdapter.callTool(
            request.toolCall.name,
            { ...request.toolCall.arguments },
            request.permissionGrant,
            controller.signal,
          );
          receipt = {
            operationId,
            status: 'succeeded',
            updatedAt: this.clock(),
            summary: typeof result === 'string' ? result : JSON.stringify(result),
          };
        } else {
          throw new Error('executor_unavailable: Internal harness executor is not configured');
        }

        const alreadySettled = this.receipts.get(operationId);
        if (alreadySettled) return alreadySettled;
        return await this.settle(operationId, receipt, pairing);
      } catch (err: any) {
        const isTimeout = err?.message?.includes('timeout') || err?.name === 'TimeoutError';
        const isNetworkDrop = err?.message?.includes('disconnect') || err?.message?.includes('network');
        const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';

        let failureReceipt: WorkReceipt;
        if (isTimeout || isNetworkDrop) {
          // UNCERTAIN status: remote execution may or may not have happened. NEVER blindly retry!
          failureReceipt = {
            operationId,
            status: 'uncertain',
            updatedAt: this.clock(),
            error: {
              code: 'remote_uncertain',
              message: `Task execution timed out or disconnected (${err.message}); manual confirmation required`,
              retryable: false, // strictly non-retryable without human audit
            },
          };
        } else if (isAbort) {
          failureReceipt = this.cancelledReceipt(operationId);
        } else if (controller.signal.aborted) {
          // The executor failed after cancellation was requested but did not
          // confirm that the remote side effect stopped.
          failureReceipt = {
            operationId,
            status: 'uncertain',
            updatedAt: this.clock(),
            error: {
              code: 'cancel_unconfirmed',
              message: `Cancellation was requested but the executor did not confirm a terminal state (${err?.message ?? 'unknown error'}).`,
              retryable: false,
            },
          };
        } else {
          failureReceipt = {
            operationId,
            status: 'failed',
            updatedAt: this.clock(),
            error: {
              code: 'execution_failed',
              message: err?.message ?? 'Unknown execution failure',
              retryable: false,
            },
          };
        }

        const alreadySettled = this.receipts.get(operationId);
        if (alreadySettled) return alreadySettled;
        return await this.settle(operationId, failureReceipt, pairing);
      } finally {
        signal?.removeEventListener('abort', relayAbort);
        this.inFlight.delete(operationId);
        this.operationControllers.delete(operationId);
      }
    });

    this.inFlight.set(operationId, dispatchPromise);
    return dispatchPromise;
  }

  async cancel(operationId: string, pairing: PairingScope, expectedRevision: number): Promise<WorkReceipt> {
    this.journal?.assertPairing(operationId, pairing);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid_request_revision');
    this.journal?.assertRevision(operationId, expectedRevision);
    const request = this.requests.get(operationId);
    if (!request) throw new Error(`request_not_found: operation ${operationId} has not been prepared`);
    if (request.revision !== expectedRevision) throw new Error('request_revision_conflict');
    const existing = this.receipts.get(operationId);
    if (existing && ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(existing.status)) {
      return existing;
    }

    const inFlight = this.inFlight.get(operationId);
    if (!inFlight) {
      const cancelled = this.cancelledReceipt(operationId);
      return this.settle(operationId, cancelled, pairing);
    }

    this.operationControllers.get(operationId)?.abort();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<WorkReceipt>(resolve => {
      timer = setTimeout(() => {
        const uncertain: WorkReceipt = {
          operationId,
          status: 'uncertain',
          updatedAt: this.clock(),
          error: { code: 'cancel_unconfirmed', message: 'The executor did not confirm cancellation before the timeout.', retryable: false },
        };
        void this.settle(operationId, uncertain, pairing).then(resolve, () => resolve(uncertain));
      }, this.cancelTimeoutMs);
    });
    try { return await Promise.race([inFlight, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  getReceipt(operationId: string, pairing?: PairingScope): WorkReceipt | null {
    if (this.journal) {
      if (!pairing) throw new Error('pairing_required_for_durable_work');
      this.journal.assertPairing(operationId, pairing);
    }
    return this.receipts.get(operationId) ?? null;
  }

  getDispatchCount(operationId: string): number {
    return this.dispatchCounts.get(operationId) ?? 0;
  }

  private async publishWorkEvent(pairing: PairingScope, receipt: WorkReceipt): Promise<boolean> {
    const nowIso = this.clock();
    const request = this.requests.get(receipt.operationId);
    const forgotten = this.journal?.isForgotten(receipt.operationId) ?? false;
    const envelope: CompanionEventEnvelope = {
      schemaVersion: 1,
      eventId: `work-evt-${createHash('sha256').update(JSON.stringify([receipt.operationId, receipt.status, receipt.updatedAt])).digest('hex')}`,
      domain: 'work', // Strictly isolated in 'work' domain!
      type: this.eventType(receipt),
      pairing,
      sourceRef: {
        id: receipt.operationId,
        version: 1,
      },
      // Receipt time is immutable; replay after a crash must produce a byte-stable timeline row.
      occurredAt: receipt.updatedAt,
      receivedAt: nowIso,
      payload: {
        ...receipt,
        ...(request ? {
          executorId: forgotten ? 'forgotten' : request.executorId,
          taskId: forgotten ? 'forgotten' : receipt.remoteTaskId ?? request.operationId,
          title: forgotten ? '已遗忘的工作任务' : request.target.title,
          instruction: forgotten ? '' : request.instruction,
          ...(request.toolCall ? { toolName: request.toolCall.name } : {}),
          ...(receipt.summary ? { resultSummary: receipt.summary } : {}),
        } : {}),
      },
      summary: `Work receipt ${receipt.operationId} [${receipt.status}]`,
    };

    try {
      await this.eventHub.publishEnvelopeAndWait(envelope);
      return true;
    } catch {
      return false;
    }
  }

  private eventType(receipt: WorkReceipt): string {
    return receipt.status === 'succeeded' ? 'work.task.completed'
      : receipt.status === 'cancelled' ? 'work.task.cancelled' : 'work.task.failed';
  }

  private cancelledReceipt(operationId: string): WorkReceipt {
    return {
      operationId,
      status: 'cancelled',
      updatedAt: this.clock(),
      error: { code: 'cancelled', message: 'Operation was cancelled before completion.', retryable: false },
    };
  }

  private async settle(operationId: string, receipt: WorkReceipt, pairing: PairingScope): Promise<WorkReceipt> {
    const settled = this.receipts.get(operationId);
    if (settled) return settled;
    const durable = this.journal?.settle(receipt) ?? receipt;
    this.receipts.set(operationId, durable);
    const published = await this.publishWorkEvent(pairing, durable);
    if (published) this.journal?.markEventPublished(operationId);
    return durable;
  }

  private async flushPendingEvents(): Promise<void> {
    if (!this.journal) return;
    for (const entry of this.journal.entries()) {
      if (!entry.receipt || entry.eventPublished || !entry.pairing) continue;
      if (await this.publishWorkEvent(entry.pairing, entry.receipt)) {
        this.journal.markEventPublished(entry.request.operationId);
      } else {
        throw new Error('work_event_projection_pending');
      }
    }
  }
}
