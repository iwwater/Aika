import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** The same bounded NDJSON protocol as the Swift shell, using a separate system Node. */
export class BackendConnection {
  generation = 0;
  state = 'disconnected';
  child = null;
  constructor({ onState, onMessage, timeoutMs = 15000, limit = 64 * 1024 * 1024 }) {
    Object.assign(this, { onState, onMessage, timeoutMs, limit });
  }
  start(executable, args, env = process.env) {
    this.close();
    const generation = ++this.generation;
    this.state = 'connecting';
    this.onState({ generation, state: this.state, canRetry: true });
    let child;
    try { child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { this.fail(generation, 'failed', 'launch'); return; }
    this.child = child;
    const decoder = new StringDecoder('utf8');
    let pending = '', bytes = 0;
    this.deadline = setTimeout(() => this.fail(generation, 'failed', 'ready-timeout'), this.timeoutMs);
    child.on('error', () => this.fail(generation, 'failed', 'launch'));
    child.on('exit', () => this.fail(generation, 'disconnected', 'exit'));
    child.stdin.on('error', () => this.fail(generation, 'disconnected', 'write'));
    // Backend diagnostics are already redacted; stdout is reserved for protocol data.
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.stdout.on('data', chunk => {
      if (!this.live(generation)) return;
      bytes += chunk.length;
      if (bytes > this.limit) { this.fail(generation, 'failed', 'message-too-large'); return; }
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        bytes = Buffer.byteLength(pending, 'utf8');
        let message;
        try { message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error(); }
        catch { this.fail(generation, 'failed', 'invalid-message'); return; }
        if (message.channel === 'backend_ready') {
          if (this.state !== 'connecting') continue;
          clearTimeout(this.deadline); this.state = 'ready';
        } else if (this.state !== 'ready') continue;
        this.onMessage(message, generation);
        if (!this.live(generation)) return;
      }
    });
  }
  live(generation) { return generation === this.generation && ['ready', 'connecting'].includes(this.state); }
  send(message, generation) {
    if (generation !== this.generation || this.state !== 'ready' || !this.child) return false;
    let line;
    try { line = JSON.stringify(message) + '\n'; } catch { return false; }
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > this.limit) {
      this.fail(generation, 'failed', 'write-overflow'); return false;
    }
    this.child.stdin.write(line); return true;
  }
  fail(generation, state, reason) {
    if (!this.live(generation)) return;
    this.close(); this.state = state;
    this.onState({ generation, state, reason, canRetry: true });
  }
  close() {
    clearTimeout(this.deadline); this.state = 'disconnected';
    const child = this.child; this.child = null;
    if (!child) return;
    // EOF lets the backend flush SQLite and remove its own lock on Windows.
    child.stdin.end();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
    timer.unref(); child.once('exit', () => clearTimeout(timer));
  }
}
