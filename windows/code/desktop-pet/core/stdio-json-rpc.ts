import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface StdioJsonRpcConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Only these explicitly configured variables are added to a small OS runtime allowlist. */
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxMessageBytes?: number;
}

export interface JsonRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
}

type RpcMessage = Record<string, unknown> & { jsonrpc: '2.0' };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type ServerRequestHandler = (message: RpcMessage) => unknown | Promise<unknown>;

function protocolError(message: string): Error { return Object.assign(new Error(message), { code: 'EPROTO' }); }

function childEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME'];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('invalid_stdio_environment');
    }
    result[key] = value;
  }
  return result;
}

/** Minimal JSON-RPC 2.0 client over the standard newline-delimited stdio binding. */
export class StdioJsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<(message: RpcMessage) => void>();
  private readonly requestHandlers = new Set<ServerRequestHandler>();
  private readonly maxMessageBytes: number;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private closed = false;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(private readonly config: StdioJsonRpcConfig) {
    if (typeof config.command !== 'string' || !config.command.trim() || config.command.includes('\0') || !isAbsolute(config.command)) {
      throw new Error('stdio_command_must_be_absolute');
    }
    if ((config.args ?? []).some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid_stdio_arguments');
    if (config.cwd !== undefined && !isAbsolute(config.cwd)) throw new Error('stdio_cwd_must_be_absolute');
    const timeout = config.requestTimeoutMs ?? 30_000;
    this.maxMessageBytes = config.maxMessageBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10 * 60_000 ||
      !Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1024 || this.maxMessageBytes > 32 * 1024 * 1024) {
      throw new Error('invalid_stdio_limits');
    }
    this.child = spawn(config.command, [...(config.args ?? [])], {
      cwd: config.cwd,
      env: childEnvironment(config.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.child.stdout.on('data', chunk => this.onStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.child.stderr.on('data', chunk => {
      const next = Buffer.concat([this.stderrTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      this.stderrTail = next.subarray(Math.max(0, next.length - 16_384));
    });
    this.child.on('error', error => this.failAll(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      this.failAll(Object.assign(new Error(`stdio_process_exited:${code ?? signal ?? 'unknown'}`), { code: 'ECONNRESET' }));
      this.resolveExit();
    });
  }

  onNotification(handler: (message: RpcMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(handler: ServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal; onAbort?: (id: number) => void } = {}): Promise<T> {
    if (this.closed || this.child.stdin.destroyed) throw Object.assign(new Error('stdio_process_closed'), { code: 'ECONNRESET' });
    if (options.signal?.aborted) throw Object.assign(new Error('operation_aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) throw new Error('invalid_request_timeout');
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(Object.assign(new Error(`jsonrpc_timeout:${method}`), { name: 'TimeoutError', code: 'ETIMEDOUT' }));
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        try { options.onAbort?.(id); } catch { /* Cancellation is best effort; the caller records an uncertain result. */ }
        reject(Object.assign(new Error(`jsonrpc_aborted:${method}`), {
          name: options.onAbort ? 'CancellationUnconfirmedError' : 'AbortError',
          code: options.onAbort ? 'ECANCEL_UNCONFIRMED' : 'ABORT_ERR',
        }));
      };
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, timer });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    if (!this.pending.has(id)) return promise as Promise<T>;
    try {
      this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error instanceof Error ? error : new Error(String(error))); }
    }
    return promise as Promise<T>;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed) throw Object.assign(new Error('stdio_process_closed'), { code: 'ECONNRESET' });
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async close(graceMs = 750): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(Object.assign(new Error('stdio_process_closed'), { code: 'ECONNRESET' }));
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); timer.unref(); });
    await Promise.race([this.exitPromise, grace]);
    if (timer) clearTimeout(timer);
    if (!this.child.killed && this.child.exitCode === null) this.child.kill();
    await Promise.race([this.exitPromise, new Promise<void>(resolve => { const t = setTimeout(resolve, 1_000); t.unref(); })]);
  }

  private write(message: RpcMessage): void {
    const line = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
    if (line.length > this.maxMessageBytes) throw protocolError('jsonrpc_message_too_large');
    if (!this.child.stdin.write(line)) {
      // stdin backpressure is handled by Node's pipe buffer; the write itself is still accepted.
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxMessageBytes && !this.buffer.includes(0x0a)) {
      this.failAll(protocolError('jsonrpc_message_too_large'));
      this.child.kill();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxMessageBytes) {
        this.failAll(protocolError('jsonrpc_message_too_large'));
        this.child.kill();
        return;
      }
      const line = this.buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.failAll(protocolError('invalid_jsonrpc_json')); this.child.kill(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || (message as Record<string, unknown>).jsonrpc !== '2.0') {
        this.failAll(protocolError('invalid_jsonrpc_envelope')); this.child.kill(); return;
      }
      this.route(message as RpcMessage);
    }
    if (this.buffer.length > this.maxMessageBytes) {
      this.failAll(protocolError('jsonrpc_message_too_large'));
      this.child.kill();
    }
  }

  private route(message: RpcMessage): void {
    if (typeof message.method === 'string' && Object.hasOwn(message, 'id')) {
      if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
        this.failAll(protocolError('invalid_server_request_id'));
        this.child.kill();
        return;
      }
      void (async () => {
        try {
          const handler = [...this.requestHandlers].at(-1);
          if (!handler) throw Object.assign(new Error('Method not found'), { code: -32601 });
          const result = await handler(message);
          this.write({ jsonrpc: '2.0', id: message.id, result });
        } catch (error) {
          const err = error as { code?: unknown; message?: unknown };
          this.write({ jsonrpc: '2.0', id: message.id, error: {
            code: typeof err?.code === 'number' ? err.code : -32603,
            message: typeof err?.message === 'string' ? err.message : 'Internal error',
          } });
        }
      })();
      return;
    }
    if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) {
      for (const handler of this.notificationHandlers) {
        try { handler(message); } catch { /* A notification observer cannot break protocol framing. */ }
      }
      return;
    }
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
      this.failAll(protocolError('unexpected_jsonrpc_message'));
      this.child.kill();
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error && typeof message.error === 'object') {
      const remote = message.error as Record<string, unknown>;
      const error: JsonRpcError = Object.assign(new Error(typeof remote.message === 'string' ? remote.message : 'Remote JSON-RPC error'), {
        ...(typeof remote.code === 'number' ? { code: remote.code } : {}),
        ...(Object.hasOwn(remote, 'data') ? { data: remote.data } : {}),
      });
      pending.reject(error);
    } else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(protocolError('jsonrpc_response_missing_result'));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
