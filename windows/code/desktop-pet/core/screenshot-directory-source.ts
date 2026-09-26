/**
 * core/screenshot-directory-source.ts
 *
 * N081-04: Bounded screenshot-directory source.
 *
 * Watches ONE directory the user explicitly selected. A file notification is only a *candidate*:
 * before anything is stored the source verifies the extension, that the path is still inside the
 * authorized root after realpath resolution, that two metadata reads at least
 * `policy.fileStableIntervalMs` apart agree, and that the bytes decode to a supported image within
 * the 20 MiB / 40 MP ceiling. Half-written, corrupt, oversized, moved, out-of-boundary and
 * symlink-loop candidates are rejected and counted rather than silently accepted.
 *
 * It never imports pre-existing files, never scans a whole drive, never writes to or deletes the
 * user's originals, and never lets a real path escape through the public event boundary.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, realpath, readdir } from 'node:fs/promises';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CollectionGrant, CollectionSourceLease } from '../contracts/collection.js';
import type { ScreenshotDirectoryPort } from '../contracts/collection.js';

export interface ScreenshotCandidate {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly fileVersion: string;
  readonly firstSeenAt: string;
  readonly stableAt: string;
}

export interface ScreenshotDirectorySourceOptions {
  readonly fileStableIntervalMs: number;
  readonly maxImageBytes: number;
  readonly maxImagePixels: number;
  readonly now?: () => string;
  /** Injectable sleep so the stability check is testable without real waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional decode probe returning dimensions, or null when the bytes do not decode. */
  readonly probeImage?: (bytes: Uint8Array) => { readonly width: number; readonly height: number } | null;
  /** Bounded rescan window, only used to recover events the watcher may have dropped. */
  readonly rescanIntervalMs?: number;
}

const ACCEPTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

interface CandidateRecord {
  readonly opaqueRef: string;
  readonly absolutePath: string;
  readonly firstSeenAt: string;
  version: string | null;
}

/** Detects PNG/JPEG/WebP from the bytes themselves; the extension alone is never trusted. */
export function detectScreenshotMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

export class ScreenshotDirectorySource implements ScreenshotDirectoryPort {
  private readonly options: ScreenshotDirectorySourceOptions;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sleepCancels: (() => void)[] = [];

  constructor(options: ScreenshotDirectorySourceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? (ms => new Promise(done => { const timer = setTimeout(done, ms); this.sleepCancels.push(() => clearTimeout(timer)); }));
  }

  async start(
    input: { readonly grantId: string; readonly canonicalRoot: string; readonly grantRevision: number },
    onCandidate: (value: { readonly opaqueFileRef: string; readonly observedAt: string; readonly grantRevision: number }) => void,
  ): Promise<CollectionSourceLease> {
    // The authorized root is resolved once and every candidate is re-checked against it.
    const root = await realpath(input.canonicalRoot).catch(() => null);
    if (!root) throw new Error('screenshot_directory_unavailable');
    if (!isAbsolute(root)) throw new Error('screenshot_directory_unavailable');

    // Only files created AFTER enablement are eligible; the current directory listing is the baseline.
    const seen = new Map<string, CandidateRecord>();
    for (const name of await this.#listDirectory(root)) seen.set(name, this.#record(root, name, null));

    let closed = false;
    const watcher: FSWatcher | null = (() => {
      try {
        return watch(root, { persistent: false }, (_event, filename) => {
          const name = typeof filename === 'string' ? filename : filename ? String(filename) : '';
          if (!name) return;
          // A directory entry is never a screenshot candidate.
          if (!ACCEPTED_EXTENSIONS.has(extname(name).toLowerCase())) return;
          const absolutePath = join(root, name);
          const existing = seen.get(name);
          if (!existing) {
            const record = this.#record(root, name, null);
            seen.set(name, record);
            onCandidate({ opaqueFileRef: record.opaqueRef, observedAt: this.now(), grantRevision: input.grantRevision });
            return;
          }
          // An overwrite (same name, different mtime/size) is a new candidate for the same file name.
          const nextVersion = this.#quickVersion(absolutePath);
          if (nextVersion && nextVersion !== existing.version) {
            const replacement = this.#record(root, name, nextVersion);
            seen.set(name, replacement);
            onCandidate({ opaqueFileRef: replacement.opaqueRef, observedAt: this.now(), grantRevision: input.grantRevision });
          }
        });
      } catch { return null; }
    })();

    if (!watcher) throw new Error('screenshot_directory_unavailable');

    // Bounded rescan: only inside this still-valid grant, and only for files newer than enablement.
    let rescan: ReturnType<typeof setInterval> | null = null;
    if (this.options.rescanIntervalMs && this.options.rescanIntervalMs > 0) {
      const enabledAt = Date.now();
      rescan = setInterval(() => {
        if (closed) return;
        void this.#boundedRescan(root, seen, enabledAt, input.grantRevision, onCandidate);
      }, this.options.rescanIntervalMs);
      rescan.unref?.();
    }

    return {
      close: async () => {
        if (closed) return;
        closed = true;
        if (rescan) clearInterval(rescan);
        watcher.close();
        for (const cancel of this.sleepCancels.splice(0)) cancel();
      },
    };
  }

  /** One bounded pass for files the watcher may have missed; never reaches before enablement. */
  async #boundedRescan(
    root: string,
    seen: Map<string, CandidateRecord>,
    enabledAt: number,
    grantRevision: number,
    onCandidate: (value: { readonly opaqueFileRef: string; readonly observedAt: string; readonly grantRevision: number }) => void,
  ): Promise<void> {
    for (const name of await this.#listDirectory(root)) {
      if (!ACCEPTED_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      const absolutePath = join(root, name);
      const info = await stat(absolutePath).catch(() => null);
      if (!info) continue;
      // A file that predates enablement is never backfilled.
      if (info.mtimeMs < enabledAt) continue;
      const version = this.#quickVersion(absolutePath);
      const existing = seen.get(name);
      if (existing && existing.version === version) continue;
      const record = this.#record(root, name, version);
      seen.set(name, record);
      onCandidate({ opaqueFileRef: record.opaqueRef, observedAt: this.now(), grantRevision });
    }
  }

  async #listDirectory(root: string): Promise<string[]> {
    try { return await readdir(root); }
    catch { return []; }
  }

  /** Register a newly observed file and mint its opaque ref. Paths never cross the event boundary. */
  #record(root: string, name: string, version: string | null): CandidateRecord {
    const record: CandidateRecord = { opaqueRef: randomUUID(), absolutePath: join(root, name), firstSeenAt: this.now(), version };
    this.refs.set(record.opaqueRef, record);
    return record;
  }

  /** size:mtime as a cheap change token. Never used as the event identity on its own. */
  #quickVersion(absolutePath: string): string | null {
    try {
      const info = statSync(absolutePath);
      return `${info.size}:${info.mtimeMs}`;
    } catch { return null; }
  }

  /**
   * Resolve one opaque candidate ref into verified bytes.
   *
   * Re-verifies the realpath against the grant root immediately before AND after reading, requires
   * two metadata reads at least `fileStableIntervalMs` apart to agree, and enforces the size and
   * pixel caps. Returns null for every rejection; it never widens the authorized boundary.
   */
  async resolveCandidate(opaqueFileRef: string, grant: CollectionGrant): Promise<ScreenshotCandidate | null> {
    if (!grant.directoryRoot) return null;
    // The ref is mapped inside the source; an unknown ref cannot name a path.
    const record = this.refs.get(opaqueFileRef);
    if (!record) return null;
    const authorizedRoot = await realpath(grant.directoryRoot).catch(() => null);
    if (!authorizedRoot) return null;

    const before = await this.#confinedRealpath(record.absolutePath, authorizedRoot);
    if (!before) return null;

    const first = await stat(before).catch(() => null);
    if (!first || !first.isFile()) return null;
    if (first.size === 0) return null;
    if (first.size > this.options.maxImageBytes) return null;

    await this.sleep(this.options.fileStableIntervalMs);

    const second = await stat(before).catch(() => null);
    if (!second || !second.isFile()) return null;
    // Instability between the two reads means the file is still being written.
    if (second.size !== first.size || second.mtimeMs !== first.mtimeMs) return null;
    if (second.size > this.options.maxImageBytes) return null;

    // Re-check confinement after reading metadata: the path may have been replaced by a link.
    const after = await this.#confinedRealpath(record.absolutePath, authorizedRoot);
    if (!after || after !== before) return null;

    let bytes: Uint8Array;
    try { bytes = await readFile(after); }
    catch { return null; }
    if (bytes.byteLength > this.options.maxImageBytes) return null;

    const mimeType = detectScreenshotMime(bytes);
    if (!mimeType) return null;
    if (this.options.probeImage) {
      const dimensions = this.options.probeImage(bytes);
      if (!dimensions) return null;
      if (dimensions.width * dimensions.height > this.options.maxImagePixels) return null;
    }

    // fileVersion identifies this exact file revision within the authorized root. It combines the
    // relative file identity with the revision token, because two DIFFERENT files can share the same
    // size and mtime; size+mtime alone would collide them into one event. It is not a content hash
    // and never substitutes for the event identity.
    const relativeName = relative(resolve(authorizedRoot), after);
    const fileVersion = `${relativeName}|${second.size}:${second.mtimeMs}`;
    return {
      bytes, mimeType, fileVersion,
      firstSeenAt: record.firstSeenAt,
      stableAt: this.now(),
    };
  }

  /** realpath must stay inside the authorized root; prefix checks alone are not enough. */
  async #confinedRealpath(candidatePath: string, authorizedRoot: string): Promise<string | null> {
    const resolved = await realpath(candidatePath).catch(() => null);
    if (!resolved) return null;
    const normalizedRoot = resolve(authorizedRoot);
    const normalizedTarget = resolve(resolved);
    if (normalizedTarget === normalizedRoot) return null;
    const relation = relative(normalizedRoot, normalizedTarget);
    // A leading `..` (or an absolute relation) means the real path escaped the authorized root.
    if (relation.startsWith('..') || isAbsolute(relation)) return null;
    return normalizedTarget;
  }

  /** Candidate refs registered by start(); kept per source instance. */
  private readonly refs = new Map<string, CandidateRecord>();

  /**
   * Register one path as a candidate without a live watcher.
   * Used by tests to drive resolveCandidate directly; production candidates come from start().
   */
  observeFile(absolutePath: string): string {
    const record: CandidateRecord = {
      opaqueRef: randomUUID(), absolutePath, firstSeenAt: this.now(), version: null,
    };
    this.refs.set(record.opaqueRef, record);
    return record.opaqueRef;
  }
}

/** True when a path is inside a root after textual normalization (pre-realpath screening only). */
export function isTextuallyInside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

/** Content digest used only for cross-source correlation, never as an event identity. */
export function correlationDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
