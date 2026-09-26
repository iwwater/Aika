import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Startup lifecycle the shell renders. stdout stays protocol-only and never carries paths or credentials. */
export const STARTUP_PHASES = Object.freeze(['starting', 'verifying', 'initializing', 'ready']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const limit = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

/** The same bounded NDJSON protocol as the Swift shell, using a separate system Node. */
export class BackendConnection {
  generation = 0;
  state = 'disconnected';
  reason = '';
  child = null;
  closing = new Set();
  /** Per-generation startup windows. Real progress renews them; a repeated heartbeat does not. */
  startups = new Map();
  constructor({ onState, onMessage, timeoutMs = 60000, noProgressMs = 60000, maxStartupMs = 600000, shutdownTimeoutMs = 10000, limit: maxMessageBytes = 64 * 1024 * 1024 }) {
    Object.assign(this, { onState, onMessage });
    this.timeoutMs = limit(timeoutMs, 60000);
    this.noProgressMs = limit(noProgressMs, this.timeoutMs);
    this.maxStartupMs = limit(maxStartupMs, this.noProgressMs * 10);
    this.shutdownTimeoutMs = limit(shutdownTimeoutMs, 10000);
    this.limit = limit(maxMessageBytes, 64 * 1024 * 1024);
  }
  /** Serialized startup: the previous backend exits and releases its lock before the next one spawns. */
  start(executable, args, env = process.env) {
    const generation = ++this.generation;
    const previous = this.close();
    this.state = 'connecting'; this.reason = '';
    this.startups.set(generation, { timer: null, sequence: 0, completed: 0, total: null, answered: false, sawProgress: false });
    this.arm(generation);
    this.onState({ generation, state: 'connecting', canRetry: true });
    return this.launch(generation, previous, executable, args, env);
  }
  async launch(generation, previous, executable, args, env) {
    await previous;
    // A cancel, a newer retry or an earlier failure may have retired this generation while the
    // previous backend was still shutting down.
    if (generation !== this.generation || this.state !== 'connecting') return;
    let child;
    try { child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { this.fail(generation, 'failed', 'launch'); return; }
    this.child = child;
    this.arm(generation);
    const decoder = new StringDecoder('utf8');
    let pending = '', bytes = 0;
    child.on('error', () => this.fail(generation, 'failed', 'launch'));
    child.on('exit', (code, signal) => this.fail(generation, 'disconnected', 'exit', { code, signal }));
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
        if (message.channel === 'backend_startup') {
          this.progress(generation, message);
          if (!this.live(generation)) return;
        } else if (message.channel === 'backend_ready') {
          if (this.state !== 'connecting') continue;
          const record = this.startups.get(generation);
          this.clearWindows(generation); this.state = 'ready';
          this.onState({ generation, state: 'connecting', canRetry: true, phase: 'ready',
            sequence: record?.sequence ?? 0, completed: record?.completed ?? 0, elapsedMs: 0,
            ...(record?.total == null ? {} : { total: record.total }) });
        } else if (this.state !== 'ready') continue;
        // backend_ready reaches the renderer, which owns the final ready transition and bridge check.
        this.onMessage(message, generation);
        if (!this.live(generation)) return;
      }
    });
  }
  /** Only a higher sequence or completed count is progress; a repeated heartbeat only proves the process lives. */
  progress(generation, message) {
    const record = this.startups.get(generation);
    if (!record) return;
    if (message.phase === 'failed') { this.fail(generation, 'failed', typeof message.code === 'string' && message.code ? message.code : 'startup'); return; }
    const sequence = count(message.sequence), completed = count(message.completed);
    const phase = typeof message.phase === 'string' && STARTUP_PHASES.includes(message.phase) ? message.phase : null;
    if (sequence === null || completed === null || !phase) return;
    const total = count(message.total), elapsedMs = count(message.elapsedMs);
    // First contact proves the backend booted, so it earns a full no-progress window.
    if (!record.answered) { record.answered = true; if (total !== null) record.total = total; this.arm(generation); }
    // Identical records only prove the process lives; they never renew the window.
    if (sequence <= record.sequence && completed <= record.completed) return;
    record.sequence = Math.max(record.sequence, sequence);
    record.completed = Math.max(record.completed, completed);
    if (total !== null) record.total = total;
    record.sawProgress = true;
    this.arm(generation);
    this.onState({ generation, state: 'connecting', canRetry: true, phase, sequence, completed,
      ...(total === null ? {} : { total }), ...(elapsedMs === null ? {} : { elapsedMs }) });
  }
  /** Silence fails on startupMs; a backend that answered but stopped advancing fails on the stall window. */
  arm(generation) {
    const record = this.startups.get(generation);
    if (!record) return;
    clearTimeout(record.timer);
    const alive = record.sawProgress || record.answered;
    const wait = Math.min(alive ? this.noProgressMs : this.timeoutMs, this.maxStartupMs);
    record.timer = setTimeout(() => this.fail(generation, 'failed', alive ? 'stalled' : 'ready-timeout'), Math.max(1, wait));
  }
  clearWindows(generation) {
    const record = this.startups.get(generation);
    if (record) { clearTimeout(record.timer); this.startups.delete(generation); }
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
  /** EOF first so the backend flushes storage and removes its own lock; only then a hard kill. */
  async cancel() {
    if (!this.live(this.generation)) return;
    const generation = this.generation;
    await this.close();
    this.onState({ generation, state: 'disconnected', reason: 'cancelled', canRetry: true });
  }
  fail(generation, state, reason, detail = {}) {
    if (!this.live(generation)) return;
    this.clearWindows(generation);
    this.close(); this.state = state; this.reason = reason;
    this.onState({ generation, state, reason, canRetry: true,
      ...(Number.isSafeInteger(detail.code) ? { exitCode: detail.code } : {}), ...(detail.signal ? { signal: detail.signal } : {}) });
  }
  close() {
    for (const generation of [...this.startups.keys()]) this.clearWindows(generation);
    this.state = 'disconnected';
    const child = this.child; this.child = null;
    if (!child) return Promise.all(this.closing);
    // EOF lets the backend flush SQLite and remove its own lock on Windows.
    const done = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill('SIGKILL'), this.shutdownTimeoutMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', () => { clearTimeout(timer); resolve(); });
    });
    this.closing.add(done);
    void done.then(() => this.closing.delete(done));
    child.stdin.end();
    return Promise.all(this.closing);
  }
}
