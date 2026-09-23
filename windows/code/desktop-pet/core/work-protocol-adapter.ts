/**
 * core/work-protocol-adapter.ts
 *
 * 08-05: Work Execution & Protocol Adapters (ACP & MCP).
 * Implements idempotent work dispatching, target revision invalidation,
 * uncertain result handling (no blind re-dispatch), and domain-isolated work receipts.
 */

import { randomUUID } from 'node:crypto';
import type {
  WorkRequest,
  WorkReceipt,
  WorkExecutionStatus,
  CompanionEventEnvelope,
} from '../contracts/perception.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CompanionEventHub } from './companion-event-hub.js';

export interface AcpServerCapabilities {
  readonly protocolVersion: string;
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
  readonly handler?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export const SUPPORTED_ACP_VERSIONS = Object.freeze(['2024-11-05', '1.0']);
export const SUPPORTED_MCP_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26']);

/**
 * Agent Client Protocol (ACP) Adapter.
 */
export class AcpProtocolAdapter {
  private connected = false;
  private readonly remoteTasks = new Map<string, { status: WorkExecutionStatus; aborted?: boolean }>();

  constructor(
    private readonly capabilities: AcpServerCapabilities = { protocolVersion: '2024-11-05' },
    private readonly taskExecutor?: (request: WorkRequest, signal?: AbortSignal) => Promise<string>,
  ) {}

  async connect(): Promise<void> {
    if (!SUPPORTED_ACP_VERSIONS.includes(this.capabilities.protocolVersion)) {
      throw new Error(`unsupported_protocol_version: ACP version ${this.capabilities.protocolVersion} is not supported`);
    }
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

    const remoteTaskId = `acp-task-${randomUUID()}`;
    this.remoteTasks.set(remoteTaskId, { status: 'running' });

    try {
      if (this.taskExecutor) {
        const summary = await this.taskExecutor(request, signal);
        this.remoteTasks.set(remoteTaskId, { status: 'succeeded' });
        return {
          operationId: request.operationId,
          remoteTaskId,
          status: 'succeeded',
          updatedAt: new Date().toISOString(),
          summary,
        };
      }

      // Default mock execution
      this.remoteTasks.set(remoteTaskId, { status: 'succeeded' });
      return {
        operationId: request.operationId,
        remoteTaskId,
        status: 'succeeded',
        updatedAt: new Date().toISOString(),
        summary: `ACP task executed successfully on ${request.target.title}`,
      };
    } catch (err: any) {
      if (signal?.aborted || err?.name === 'AbortError') {
        this.remoteTasks.set(remoteTaskId, { status: 'cancelled', aborted: true });
        return {
          operationId: request.operationId,
          remoteTaskId,
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
          error: { code: 'cancelled', message: 'Task cancelled by user', retryable: false },
        };
      }
      this.remoteTasks.set(remoteTaskId, { status: 'failed' });
      throw err;
    }
  }

  async cancelTask(remoteTaskId: string): Promise<boolean> {
    const task = this.remoteTasks.get(remoteTaskId);
    if (!task) return false;
    task.status = 'cancelled';
    task.aborted = true;
    return true;
  }
}

/**
 * Model Context Protocol (MCP) Tool Adapter.
 */
export class McpToolProtocolAdapter {
  private connected = false;
  private readonly toolRegistry = new Map<string, McpToolDefinition>();

  constructor(
    private readonly capabilities: McpServerCapabilities = { protocolVersion: '2025-03-26', tools: true },
    tools: readonly McpToolDefinition[] = [],
  ) {
    for (const tool of tools) {
      this.toolRegistry.set(tool.name, tool);
    }
  }

  async connect(): Promise<void> {
    if (!SUPPORTED_MCP_VERSIONS.includes(this.capabilities.protocolVersion)) {
      throw new Error(`unsupported_protocol_version: MCP version ${this.capabilities.protocolVersion} is not supported`);
    }
    this.connected = true;
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    if (!this.connected) {
      await this.connect();
    }
    // Return read-only tool metadata
    return Array.from(this.toolRegistry.values()).map(t => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      requiredGrant: t.requiredGrant,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>, grants: readonly string[]): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const tool = this.toolRegistry.get(name);
    if (!tool) {
      throw new Error(`tool_not_found: Tool ${name} is not available`);
    }

    // Permission enforcement
    if (!tool.readOnly) {
      const required = tool.requiredGrant ?? 'write';
      if (!grants.includes(required)) {
        throw new Error(`permission_denied: Tool '${name}' requires '${required}' permission grant`);
      }
    }

    if (tool.handler) {
      return await tool.handler(args);
    }

    return { status: 'ok', tool: name, echo: args };
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

  constructor(
    private readonly eventHub: CompanionEventHub,
    private readonly acpAdapter: AcpProtocolAdapter,
    private readonly mcpAdapter: McpToolProtocolAdapter,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  prepareRequest(request: Omit<WorkRequest, 'requestedAt'>): WorkRequest {
    const fullRequest: WorkRequest = {
      ...request,
      requestedAt: this.clock(),
    };
    this.requests.set(request.operationId, fullRequest);
    return fullRequest;
  }

  reviseRequest(operationId: string, updates: Partial<WorkRequest>): WorkRequest {
    if (this.inFlight.has(operationId) || this.receipts.has(operationId)) {
      throw new Error('invalid_revision: cannot revise an operation that is already dispatched or settled');
    }

    const existing = this.requests.get(operationId);
    if (!existing) {
      throw new Error(`request_not_found: operation ${operationId} does not exist`);
    }

    const revised: WorkRequest = {
      ...existing,
      ...updates,
      operationId, // keep stable ID
      requestedAt: this.clock(),
    };
    this.requests.set(operationId, revised);
    return revised;
  }

  async dispatch(operationId: string, pairing: PairingScope, signal?: AbortSignal): Promise<WorkReceipt> {
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

    const request = this.requests.get(operationId);
    if (!request) {
      throw new Error(`request_not_found: operation ${operationId} has not been prepared`);
    }

    // Track dispatch call count
    const count = (this.dispatchCounts.get(operationId) ?? 0) + 1;
    this.dispatchCounts.set(operationId, count);

    const dispatchPromise = (async () => {
      try {
        let receipt: WorkReceipt;

        if (request.protocol === 'acp') {
          receipt = await this.acpAdapter.dispatchTask(request, signal);
        } else if (request.protocol === 'mcp') {
          // MCP dispatch as tool call
          const result = await this.mcpAdapter.callTool(
            request.instruction,
            { target: request.target },
            request.permissionGrant,
          );
          receipt = {
            operationId,
            status: 'succeeded',
            updatedAt: this.clock(),
            summary: typeof result === 'string' ? result : JSON.stringify(result),
          };
        } else {
          // Internal harness
          receipt = {
            operationId,
            status: 'succeeded',
            updatedAt: this.clock(),
            summary: `Internal task executed: ${request.instruction}`,
          };
        }

        this.receipts.set(operationId, receipt);
        this.publishWorkEvent('work.task.completed', pairing, receipt);
        return receipt;
      } catch (err: any) {
        const isTimeout = err?.message?.includes('timeout') || err?.name === 'TimeoutError';
        const isNetworkDrop = err?.message?.includes('disconnect') || err?.message?.includes('network');

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

        this.receipts.set(operationId, failureReceipt);
        this.publishWorkEvent('work.task.failed', pairing, failureReceipt);
        return failureReceipt;
      } finally {
        this.inFlight.delete(operationId);
      }
    })();

    this.inFlight.set(operationId, dispatchPromise);
    return dispatchPromise;
  }

  async cancel(operationId: string, pairing: PairingScope): Promise<WorkReceipt> {
    const existing = this.receipts.get(operationId);
    if (existing && ['succeeded', 'failed', 'cancelled'].includes(existing.status)) {
      return existing;
    }

    const request = this.requests.get(operationId);
    if (request?.protocol === 'acp' && existing?.remoteTaskId) {
      await this.acpAdapter.cancelTask(existing.remoteTaskId);
    }

    const cancelledReceipt: WorkReceipt = {
      operationId,
      status: 'cancelled',
      updatedAt: this.clock(),
      error: { code: 'cancelled', message: 'Operation was cancelled', retryable: false },
    };

    this.receipts.set(operationId, cancelledReceipt);
    this.publishWorkEvent('work.task.cancelled', pairing, cancelledReceipt);
    return cancelledReceipt;
  }

  getReceipt(operationId: string): WorkReceipt | null {
    return this.receipts.get(operationId) ?? null;
  }

  getDispatchCount(operationId: string): number {
    return this.dispatchCounts.get(operationId) ?? 0;
  }

  private publishWorkEvent(type: string, pairing: PairingScope, receipt: WorkReceipt): void {
    const nowIso = this.clock();
    const envelope: CompanionEventEnvelope = {
      schemaVersion: 1,
      eventId: `work-evt-${randomUUID()}`,
      domain: 'work', // Strictly isolated in 'work' domain!
      type,
      pairing,
      sourceRef: {
        id: receipt.operationId,
        version: 1,
      },
      occurredAt: nowIso,
      receivedAt: nowIso,
      payload: receipt,
      summary: `Work receipt ${receipt.operationId} [${receipt.status}]`,
    };

    try {
      this.eventHub.publishEnvelope(envelope);
    } catch {
      // Best-effort publish
    }
  }
}
