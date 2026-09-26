/**
 * core/download-directory-source.ts
 *
 * N082-04: Download directory file source adapter.
 * Watches the authorized downloads folder for newly created, stable documents.
 * Excludes pre-existing files, temporary downloads (.tmp, .crdownload, .part),
 * and enforces strict realpath containment.
 */

import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat, realpath } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import type { SourceGrant } from '../contracts/companion-mode.js';

export interface DownloadFileCandidate {
  readonly opaqueFileRef: string;
  readonly observedAt: string;
  readonly displayName: string;
  readonly extension: string;
  readonly size: number;
}

export interface DownloadDirectorySourceOptions {
  readonly fileStableIntervalMs?: number; // Default 1,000ms
  readonly maxFileBytes?: number;         // Default 20 MiB
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

const TEMPORARY_EXTENSIONS = new Set([
  '.tmp', '.crdownload', '.part', '.downloading', '.partial',
]);

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.pdf', '.docx',
]);

export class DownloadDirectorySource {
  private readonly fileStableIntervalMs: number;
  private readonly maxFileBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;
  private watcher: FSWatcher | null = null;
  private baseline = new Set<string>();
  private closed = false;

  constructor(options: DownloadDirectorySourceOptions = {}) {
    this.fileStableIntervalMs = options.fileStableIntervalMs ?? 1_000;
    this.maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024; // 20 MiB
    this.sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(
    grant: SourceGrant,
    onCandidate: (candidate: DownloadFileCandidate) => void,
  ): Promise<{ close: () => Promise<void> }> {
    const root = grant.scope.canonicalRoot;
    if (!root) throw new Error('directory_required');

    const canonicalRoot = await realpath(resolve(root)).catch(() => {
      throw new Error('directory_unavailable');
    });

    this.closed = false;
    this.baseline.clear();

    // 1. Snapshot pre-existing files to strictly avoid retroactive ingestion
    try {
      const initialEntries = await readdir(canonicalRoot, { withFileTypes: true });
      for (const entry of initialEntries) {
        if (entry.isFile()) this.baseline.add(entry.name.toLowerCase());
      }
    } catch {
      throw new Error('directory_unavailable');
    }

    // 2. Watch directory
    try {
      this.watcher = watch(canonicalRoot, { persistent: false }, (eventType, filename) => {
        if (this.closed || !filename) return;
        const name = String(filename);
        const lower = name.toLowerCase();

        // Baseline exclusion
        if (this.baseline.has(lower)) return;

        // Temporary extension filter
        const ext = extname(lower);
        if (TEMPORARY_EXTENSIONS.has(ext)) return;
        if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(ext)) return;

        void this.#handleNewFile(canonicalRoot, name, onCandidate);
      });
    } catch {
      throw new Error('directory_unavailable');
    }

    return {
      close: async () => {
        this.closed = true;
        if (this.watcher) {
          this.watcher.close();
          this.watcher = null;
        }
        this.baseline.clear();
      },
    };
  }

  async #handleNewFile(
    canonicalRoot: string,
    filename: string,
    onCandidate: (candidate: DownloadFileCandidate) => void,
  ): Promise<void> {
    const fullPath = join(canonicalRoot, filename);

    // Verify containment
    const real = await realpath(fullPath).catch(() => null);
    if (!real) return;
    if (!this.#isInside(real, canonicalRoot)) return;

    // Stability verification (ensure file is not still being downloaded / written)
    const firstStat = await stat(real).catch(() => null);
    if (!firstStat || !firstStat.isFile()) return;
    if (firstStat.size > this.maxFileBytes) return;

    await this.sleep(this.fileStableIntervalMs);
    if (this.closed) return;

    const secondStat = await stat(real).catch(() => null);
    if (!secondStat || !secondStat.isFile()) return;
    if (secondStat.size !== firstStat.size || secondStat.mtimeMs !== firstStat.mtimeMs) {
      // Still writing or changed during stability window
      return;
    }

    this.baseline.add(filename.toLowerCase());
    onCandidate({
      opaqueFileRef: filename,
      observedAt: this.now(),
      displayName: filename,
      extension: extname(filename).toLowerCase(),
      size: secondStat.size,
    });
  }

  #isInside(targetPath: string, rootPath: string): boolean {
    const target = targetPath.toLowerCase().replaceAll('/', '\\');
    const root = rootPath.toLowerCase().replaceAll('/', '\\');
    return target === root || target.startsWith(root.endsWith('\\') ? root : root + '\\');
  }
}
