import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CodexAppConnection, CodexAppError, type CodexAppReceipt } from './codex-app.js';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
type Launcher = (executable: string, home: string) => ChildProcessWithoutNullStreams;
const launch: Launcher = (executable, home) => spawn(executable, ['app-server', '--stdio'], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: home },
});

/** Official newline-delimited app-server RPC; no private Mac IPC or ASAR hashes. */
export class CodexWindowsConnection extends CodexAppConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private closing = false;
  constructor(private readonly home: string, private readonly executable?: string, private readonly requestTimeoutMs = 60000, private readonly launcher: Launcher = launch) {
    super(home);
  }
  private async binary(): Promise<string> {
    const explicit = this.executable ?? process.env.PET_CODEX_EXECUTABLE;
    if (explicit) {
      if (!isAbsolute(explicit)) throw new CodexAppError('unavailable');
      await access(explicit); return explicit;
    }
    const root = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
    const candidates: { path: string; changed: number }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, 'codex.exe');
      try { const info = await stat(path); if (info.isFile()) candidates.push({ path, changed: info.mtimeMs }); } catch {}
    }
    const installed = candidates.sort((a, b) => b.changed - a.changed)[0];
    if (installed) return installed.path;
    for (const directory of (process.env.PATH ?? '').split(';').filter(Boolean)) {
      const path = join(directory, 'codex.exe');
      try { if ((await stat(path)).isFile()) return path; } catch {}
    }
    throw new CodexAppError('unavailable');
  }
  private fail() {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new CodexAppError('unavailable')); }
    this.pending.clear(); this.child = undefined; this.starting = undefined;
  }
  private write(value: object) {
    if (!this.child || !this.child.stdin.writable) throw new CodexAppError('unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private rpc(method: string, params: object): Promise<any> {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexAppError('unavailable', undefined, 'timeout')); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private async start(): Promise<void> {
    if (this.closing) throw new CodexAppError('unavailable');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const executable = await this.binary();
      const child = this.launcher(executable, this.home);
      this.child = child;
      // Never forward auth/plugin diagnostics or unrelated thread content to the pet log.
      child.stderr.resume();
      const failed = () => { if (this.child === child) this.fail(); };
      child.on('error', failed); child.on('exit', failed);
      child.stdin.on('error', failed);
      const decoder = new StringDecoder('utf8'); let buffer = '';
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { child.kill(); this.fail(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message; try { message = JSON.parse(line); } catch { child.kill(); this.fail(); return; }
          if (message.method && message.id !== undefined) {
            // An external client must not silently approve tools or answer user questions.
            if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method))
              this.write({ id: message.id, result: { decision: 'decline' } });
            else this.write({ id: message.id, error: { code: -32601, message: 'Continue this request in Codex; the companion has no approval UI.' } });
            continue;
          }
          const waiter = this.pending.get(String(message.id));
          if (!waiter) continue;
          this.pending.delete(String(message.id)); clearTimeout(waiter.timer);
          message.error ? waiter.reject(new CodexAppError('unavailable')) : waiter.resolve(message.result);
        }
      });
      await this.rpc('initialize', { clientInfo: { name: 'aaaagent_windows', title: 'AAAAGENT Windows', version: '0.1.1' } });
      this.write({ method: 'initialized' });
    })();
    try { await this.starting; } catch (error) { this.child?.kill(); this.fail(); throw error; }
  }
  async compatible(): Promise<boolean> {
    try { await this.start(); const auth = await this.rpc('account/read', { refreshToken: false }); return !!auth?.account; }
    catch { return false; }
  }
  override async discover(threadId: string): Promise<{ available: boolean }> {
    if (!uuid(threadId)) throw new CodexAppError('invalid_target');
    await this.start();
    const result = await this.rpc('thread/read', { threadId, includeTurns: false });
    return { available: result?.thread?.id === threadId && result.thread.status?.type !== 'active' };
  }
  override async ensureAvailable(threadId: string) { return this.discover(threadId); }
  override async send(threadId: string, text: string, requestId: string) {
    if (!uuid(threadId) || !uuid(requestId) || !text.trim() || text.length > 32768 || text.includes('\0')) throw new CodexAppError('invalid_target');
    await this.start();
    const resumed = await this.rpc('thread/resume', { threadId });
    if (resumed?.thread?.id !== threadId || resumed.thread.status?.type === 'active') throw new CodexAppError('unavailable');
    // Forwarding receipts persist dispatchAttempted before this single write.
    // A lost response remains unknown and is never automatically retried.
    try {
      const result = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      if (!uuid(result?.turn?.id ?? '')) throw new CodexAppError('unknown_delivery');
      return { threadId, requestId, turnId: result.turn.id as string };
    } catch { throw new CodexAppError('unknown_delivery'); }
  }
  override async receipt(threadId: string, turnId: string): Promise<CodexAppReceipt> {
    if (!uuid(threadId) || !uuid(turnId)) throw new CodexAppError('invalid_target');
    const unknown: CodexAppReceipt = { threadId, turnId, status: 'unknown' };
    try {
      await this.start();
      const result = await this.rpc('thread/read', { threadId, includeTurns: true });
      if (result?.thread?.id !== threadId) return unknown;
      const turn = result.thread.turns?.find((item: any) => item.id === turnId);
      if (turn?.status === 'completed') {
        const reply = (turn.items ?? []).filter((item: any) => item.type === 'agentMessage' && typeof item.text === 'string').map((item: any) => item.text).join('\n').slice(0, 4000);
        return { threadId, turnId, status: 'completed', reply };
      }
      return ['failed', 'interrupted'].includes(turn?.status) ? { ...unknown, reason: 'interrupted' } : unknown;
    } catch { return unknown; }
  }
  async close(): Promise<void> {
    this.closing = true;
    const child = this.child; if (!child) return;
    await new Promise<void>(done => {
      const timer = setTimeout(() => { child.kill(); done(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); done(); }); child.stdin.end();
    });
    this.fail();
  }
}
