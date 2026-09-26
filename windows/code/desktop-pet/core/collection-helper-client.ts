/**
 * core/collection-helper-client.ts
 *
 * N081-03: backend-side client for the controlled Windows collection helper.
 *
 * The helper is the ONLY process that observes global keyboard input and clipboard changes.
 * This client:
 *  - spawns it in the signed-in interactive session,
 *  - speaks versioned, length-capped NDJSON over its stdin/stdout,
 *  - refuses to start when the built binary is missing or its manifest disagrees (source reports
 *    `unavailable`; the product keeps running),
 *  - never accepts keystroke data: an upstream message carrying key fields is rejected outright
 *    rather than stored or logged.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export interface CollectionHelperManifest {
  readonly schemaVersion: 1;
  readonly binary: string;
  readonly platform: 'win32';
  readonly builtFrom: string;
  readonly protocolSchemaVersion: 1;
  readonly maxLineLength: number;
  readonly maxStagedBytes: number;
}

export interface CollectionHelperPaths {
  readonly binaryPath: string;
  readonly manifestPath: string;
  readonly stagingRoot: string;
}

/** Fields that must never appear in an upstream helper message. */
const FORBIDDEN_UPSTREAM_KEYS = Object.freeze([
  'keycode', 'key_code', 'scancode', 'scan_code', 'character', 'characters', 'composition',
  'keys', 'keysequence', 'key_sequence', 'inputtext', 'input_text', 'text', 'rawinput', 'raw_input',
]);

export class CollectionHelperError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CollectionHelperError';
  }
}

export interface HelperEvent {
  readonly op: string;
  readonly kind: string;
  readonly requestId: string;
  readonly grantRevision: number;
  readonly payload: Record<string, unknown>;
}

export interface CollectionHelperClientOptions {
  readonly paths: CollectionHelperPaths;
  readonly instanceId: string;
  readonly onEvent: (event: HelperEvent) => void;
  readonly onExit?: (code: number | null) => void;
  readonly spawnProcess?: typeof spawn;
}

/**
 * Resolves the helper artifact and validates its manifest against this build.
 * A mismatch is a refusal, not a downgrade: a helper from another revision could emit a shape
 * this backend does not understand.
 */
export function loadCollectionHelperManifest(paths: CollectionHelperPaths): CollectionHelperManifest | null {
  if (!existsSync(paths.binaryPath) || !existsSync(paths.manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as CollectionHelperManifest;
    if (manifest.schemaVersion !== 1 || manifest.protocolSchemaVersion !== 1) return null;
    if (manifest.platform !== 'win32') return null;
    if (manifest.maxLineLength !== 65536) return null;
    return manifest;
  } catch { return null; }
}

export class CollectionHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, { resolve: (event: HelperEvent) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = '';
  private stopping = false;
  private readonly maxLineLength: number;

  constructor(private readonly options: CollectionHelperClientOptions) {
    this.maxLineLength = loadCollectionHelperManifest(options.paths)?.maxLineLength ?? 65536;
  }

  get running(): boolean { return this.child !== null && !this.stopping; }

  /** Start the helper. Throws a typed error when the artifact or platform is unavailable. */
  start(): void {
    if (this.running) return;
    if (process.platform !== 'win32') throw new CollectionHelperError('helper_unavailable', 'The collection helper is Windows-only.');
    const manifest = loadCollectionHelperManifest(this.options.paths);
    if (!manifest) throw new CollectionHelperError('helper_unavailable', 'The collection helper binary or manifest is missing or mismatched.');

    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(this.options.paths.binaryPath, ['--instance-id', this.options.instanceId], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The helper must never inherit a shell or an environment that could redirect its output.
      shell: false,
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    // stderr carries only refusal diagnostics; it is deliberately not copied into application logs.
    child.stderr.on('data', () => { /* helper diagnostics stay out of application logs */ });
    child.on('error', () => { this.#failAll(new CollectionHelperError('helper_spawn_failed', 'The collection helper could not be started.')); });
    child.on('exit', code => {
      this.child = null;
      this.#failAll(new CollectionHelperError('helper_exited', 'The collection helper stopped unexpectedly.'));
      this.options.onExit?.(code);
    });

    this.child = child;
  }

  #onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // A message beyond the agreed cap is refused instead of buffered without bound.
    if (this.stdoutBuffer.length > this.maxLineLength * 4) {
      this.stdoutBuffer = '';
      this.options.onEvent({ op: 'error', kind: 'keyboard', requestId: '', grantRevision: 0, payload: { code: 'upstream_overflow' } });
      return;
    }
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleUpstreamLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  /**
   * Parse one upstream NDJSON line.
   *
   * Public so the guard can be proven without an OS transport. It is the second line of defence
   * after the helper's own aggregation: even a compromised helper cannot get key/text data through.
   */
  handleUpstreamLine(line: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch {
      this.options.onEvent({ op: 'error', kind: 'keyboard', requestId: '', grantRevision: 0, payload: { code: 'malformed_upstream' } });
      return;
    }

    // Reject any upstream message that carries key/text fields. This is the second line of defence
    // after the helper's own aggregation: even a compromised helper cannot get正文 into the store.
    const serializedKeys = Object.keys(message).map(key => key.toLowerCase());
    for (const key of serializedKeys) {
      if (FORBIDDEN_UPSTREAM_KEYS.includes(key)) {
        this.options.onEvent({ op: 'error', kind: 'keyboard', requestId: '', grantRevision: 0, payload: { code: 'forbidden_upstream_field' } });
        return;
      }
    }
    const payload = message.payload;
    if (payload && typeof payload === 'object') {
      for (const key of Object.keys(payload as Record<string, unknown>)) {
        if (FORBIDDEN_UPSTREAM_KEYS.includes(key.toLowerCase())) {
          this.options.onEvent({ op: 'error', kind: 'keyboard', requestId: '', grantRevision: 0, payload: { code: 'forbidden_upstream_field' } });
          return;
        }
      }
    }

    const event: HelperEvent = {
      op: String(message.op ?? ''),
      kind: String(message.kind ?? ''),
      requestId: String(message.requestId ?? ''),
      grantRevision: Number(message.grantRevision ?? 0),
      payload: (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
    };

    const waiting = this.pending.get(event.requestId);
    if (waiting && (event.op === 'started' || event.op === 'stopped' || event.op === 'error' || event.op === 'staged_image')) {
      this.pending.delete(event.requestId);
      waiting.resolve(event);
      return;
    }
    this.options.onEvent(event);
  }

  #write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child) throw new CollectionHelperError('helper_unavailable', 'The collection helper is not running.');
    const line = JSON.stringify({ schemaVersion: 1, instanceId: this.options.instanceId, ...message });
    if (line.length > this.maxLineLength) throw new CollectionHelperError('control_too_long', 'The control message exceeds the agreed length cap.');
    child.stdin.write(line + '\n');
  }

  /** Send a control message and wait for its correlated reply. */
  #request(message: Record<string, unknown>, timeoutMs = 5_000): Promise<HelperEvent> {
    const requestId = randomUUID();
    this.#write({ ...message, requestId });
    return new Promise<HelperEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CollectionHelperError('helper_timeout', 'The collection helper did not answer in time.'));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: event => { clearTimeout(timer); resolve(event); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async startKeyboard(input: {
    readonly grantId: string; readonly grantRevision: number;
    readonly policy: { readonly keyboardBucketMs: number; readonly keyboardQuietMs: number; readonly afkMs: number };
  }): Promise<void> {
    const event = await this.#request({
      grantId: input.grantId, grantRevision: input.grantRevision, kind: 'keyboard', op: 'start',
      keyboardBucketMs: input.policy.keyboardBucketMs, keyboardQuietMs: input.policy.keyboardQuietMs, afkMs: input.policy.afkMs,
    });
    if (event.op !== 'started') throw new CollectionHelperError(String(event.payload.code ?? 'keyboard_unavailable'), 'Keyboard activity could not be observed.');
  }

  async stopKeyboard(input: { readonly grantId: string; readonly grantRevision: number }): Promise<void> {
    if (!this.running) return;
    await this.#request({ grantId: input.grantId, grantRevision: input.grantRevision, kind: 'keyboard', op: 'stop' }).catch(() => undefined);
  }

  async startClipboard(input: { readonly grantId: string; readonly grantRevision: number }): Promise<void> {
    const event = await this.#request({
      grantId: input.grantId, grantRevision: input.grantRevision, kind: 'clipboard_image', op: 'start',
      stagingRoot: this.options.paths.stagingRoot,
    });
    if (event.op !== 'started') throw new CollectionHelperError(String(event.payload.code ?? 'clipboard_unavailable'), 'Clipboard changes could not be observed.');
  }

  async stopClipboard(input: { readonly grantId: string; readonly grantRevision: number }): Promise<void> {
    if (!this.running) return;
    await this.#request({ grantId: input.grantId, grantRevision: input.grantRevision, kind: 'clipboard_image', op: 'stop' }).catch(() => undefined);
  }

  /**
   * Ask the helper to stage the current clipboard image and return the one-shot staged asset id.
   * Bytes never travel over NDJSON; the caller reads and deletes the staging file.
   */
  async readClipboardImage(input: { readonly grantId: string; readonly grantRevision: number; readonly sequence: number }):
  Promise<{ stagedAssetId: string; mimeType: string; byteLength: number } | null> {
    const event = await this.#request({
      grantId: input.grantId, grantRevision: input.grantRevision, kind: 'clipboard_image',
      op: 'read_clipboard_image', sequence: input.sequence,
    });
    if (event.op === 'staged_image') {
      return {
        stagedAssetId: String(event.payload.stagedAssetId ?? ''),
        mimeType: String(event.payload.mimeType ?? ''),
        byteLength: Number(event.payload.byteLength ?? 0),
      };
    }
    return null;
  }

  /**
   * Read one staged asset exactly once and delete it. The helper can never name an arbitrary path:
   * the id must resolve inside this profile's staging root.
   */
  consumeStagedAsset(stagedAssetId: string): { bytes: Uint8Array; mimeType: string } | null {
    const root = resolve(this.options.paths.stagingRoot);
    const target = resolve(root, stagedAssetId);
    // Path confinement: reject traversal and any absolute id outside the staging root.
    if (!target.toLowerCase().startsWith(root.toLowerCase())) return null;
    if (!existsSync(target)) return null;
    try {
      const bytes = readFileSync(target);
      unlinkSync(target);
      return { bytes, mimeType: 'image/bmp' };
    } catch { return null; }
  }

  /** Remove every staged file for this instance. Called on lock, pause, revoke and shutdown. */
  clearStaging(): void {
    const directory = join(this.options.paths.stagingRoot, this.options.instanceId);
    if (!existsSync(directory)) return;
    try {
      for (const name of readdirSync(directory)) {
        try { unlinkSync(join(directory, name)); } catch { /* staged cleanup */ }
      }
    } catch { /* staging root may already be gone */ }
  }

  /** Stop the helper and release its listeners. Idempotent. */
  async close(): Promise<void> {
    if (!this.child) { this.stopping = false; return; }
    this.stopping = true;
    const child = this.child;
    try {
      const line = JSON.stringify({ schemaVersion: 1, instanceId: this.options.instanceId, requestId: randomUUID(), grantId: '', grantRevision: 0, kind: 'keyboard', op: 'close' });
      child.stdin.write(line + '\n');
    } catch { /* the child may already be gone */ }
    await new Promise<void>(resolveClose => {
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already exited */ } resolveClose(); }, 2_000);
      child.once('exit', () => { clearTimeout(timer); resolveClose(); });
    });
    this.child = null;
    this.stopping = false;
    this.pending.clear();
    this.clearStaging();
  }

  #failAll(error: Error): void {
    for (const [, waiting] of this.pending) waiting.reject(error);
    this.pending.clear();
  }
}

/**
 * Default artifact locations for the checked-in build output.
 *
 * `packageRoot` is the desktop-pet package directory that owns `dist/` — NOT the workspace root.
 * Passing the workspace root would look for `windows/dist/collection/...`, while the build writes to
 * `windows/code/desktop-pet/dist/collection/...`, and the helper would silently report unavailable.
 * `resolveHelperPackageRoot` exists so callers holding a workspace root get the right directory.
 */
export function collectionHelperPaths(packageRoot: string): CollectionHelperPaths {
  const directory = resolve(packageRoot, 'dist/collection');
  return {
    binaryPath: join(directory, 'aika-collection-helper.exe'),
    manifestPath: join(directory, 'helper-build.json'),
    stagingRoot: resolve(packageRoot, '.local/data/collection-staging'),
  };
}

/**
 * Resolve the desktop-pet package root from a workspace root.
 *
 * The trial configuration's `projectRoot` is the workspace (`windows/`), whose `dist/` is not the
 * backend's build output. The artifacts live beside this module's compiled form, so that location is
 * authoritative; a workspace root is accepted only when it already contains the package.
 */
export function resolveHelperPackageRoot(projectRoot: string): string {
  const candidates = [
    // The compiled module's own package root (dist/core -> package).
    resolve(fileURLToPath(new URL('..', import.meta.url)), '..'),
    resolve(projectRoot, 'code/desktop-pet'),
    resolve(projectRoot),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dist/collection/helper-build.json'))) return candidate;
  }
  // No manifest anywhere: return the package root so the caller's own "unavailable" path is used.
  return candidates[0]!;
}

/** Age-based staging sweep used at startup; a crashed helper can leave files behind. */
export function sweepStaleStaging(stagingRoot: string, olderThanMs = 3_600_000, now = Date.now()): number {
  if (!existsSync(stagingRoot)) return 0;
  let removed = 0;
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, name.name);
      if (name.isDirectory()) { walk(full); continue; }
      try {
        if (now - statSync(full).mtimeMs > olderThanMs) { unlinkSync(full); removed++; }
      } catch { /* staged cleanup is best effort */ }
    }
  };
  try { walk(stagingRoot); } catch { /* staging root may be unreadable */ }
  return removed;
}
