/**
 * K65-01 (01-A): package-root confinement and reparse-point refusal.
 *
 * CONTRACTS.md §1: "路径不得越过包根；首版拒绝符号链接/junction 等重解析项". The check has to be real
 * Windows behaviour, not a POSIX-shaped approximation: on Windows a directory junction is created
 * without elevation and is reported by `lstat` as a symbolic link while `realpath` silently follows it
 * out of the package. Both signals are therefore consulted for every path component, and the walk
 * starts at the package root so that an escape through an intermediate directory is caught too.
 *
 * Nothing in this module reads a package entry. It is metadata/filesystem inspection only.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep, win32 } from 'node:path';
import type { PluginIssue } from '../contracts/plugin.js';

/** The root of an imported directory package is identified by its manifest, not by a naming convention. */
export const PACKAGE_ROOT_MARKER = 'manifest.json';

/** Reserved Windows device names; a package file with one of these is unreadable on the target platform. */
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export interface PathRejection {
  readonly path: string;
  readonly detail: string;
}

export type PathNormalization = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly rejection: PathRejection };

/**
 * Normalises a manifest-declared POSIX-relative path. Refuses everything that could address something
 * outside the package root, plus the Windows-specific shapes that make the same string mean a
 * different file than it looks like.
 */
export function normalizePackageRelativePath(value: unknown, field = 'path'): PathNormalization {
  if (typeof value !== 'string') return refuse(value, field, `expected a string path, received ${typeof value}`);
  if (!value.length) return refuse(value, field, 'path is empty');
  if (value.length > 512) return refuse(value, field, 'path exceeds 512 characters');
  if (value.includes('\0')) return refuse(value, field, 'path contains a NUL byte');
  if (isAbsolute(value) || win32.isAbsolute(value)) return refuse(value, field, 'path is absolute');
  if (/^[A-Za-z]:/.test(value)) return refuse(value, field, 'path carries a drive letter');
  if (value.startsWith('\\') || value.startsWith('//')) return refuse(value, field, 'path is a UNC or root-relative path');
  if (value.includes('\\')) return refuse(value, field, 'path must use POSIX separators; a backslash is refused so that it cannot mean a separator on one platform and a filename character on another');
  const segments = value.split('/');
  if (segments.some(segment => segment === '..')) return refuse(value, field, 'path escapes the package root with ".."');
  if (segments.some(segment => segment === '')) return refuse(value, field, 'path contains an empty segment');
  if (segments.some(segment => segment === '.')) return refuse(value, field, 'path contains a "." segment');
  for (const segment of segments) {
    if (segment.endsWith('.') || segment.endsWith(' ')) return refuse(value, field, `segment ${JSON.stringify(segment)} ends with a dot or space, which Windows silently strips`);
    const stem = segment.split('.')[0]?.toLowerCase() ?? '';
    if (RESERVED_DEVICE_NAMES.has(stem)) return refuse(value, field, `segment ${JSON.stringify(segment)} is a reserved Windows device name`);
    if (/[\u0000-\u001f<>:"|?*]/.test(segment)) return refuse(value, field, `segment ${JSON.stringify(segment)} contains a character Windows forbids in a filename`);
  }
  return { ok: true, path: segments.join('/') };
}

const refuse = (value: unknown, field: string, detail: string): PathNormalization =>
  ({ ok: false, rejection: { path: field, detail: `${detail} (value: ${JSON.stringify(value)})` } });

/**
 * Resolves a manifest-declared relative path against a package root, refusing anything that leaves it.
 * The caller is responsible for having normalised the value; this function re-checks rather than trusting.
 */
export function resolveInsidePackage(root: string, relativePath: string): string {
  const normalized = normalizePackageRelativePath(relativePath);
  if (!normalized.ok) throw new Error(`Unsafe package path ${JSON.stringify(relativePath)}: ${normalized.rejection.detail}`);
  const rootDirectory = resolve(root);
  const target = resolve(rootDirectory, normalized.path);
  const prefix = rootDirectory.endsWith(sep) ? rootDirectory : rootDirectory + sep;
  if (!target.startsWith(prefix)) throw new Error(`Unsafe package path ${JSON.stringify(relativePath)}: resolves outside ${rootDirectory}`);
  return target;
}

/**
 * Every path component from the package root down to `relativePath` that is a reparse point.
 *
 * Both detection channels are used on purpose:
 *   * `lstat().isSymbolicLink()` is what Node reports for a Windows directory junction as well as for a
 *     symlink, and it is the only channel that sees the link itself rather than its target;
 *   * `realpath()` differing from the lexical path catches a reparse point created by a mechanism Node
 *     does not model as a link (mount point, some filter drivers) and catches an escape that a dangling
 *     link would otherwise hide.
 *
 * An empty result means the whole chain is an ordinary directory/file chain. A missing component is
 * reported as a rejection by `findPackagePathIssues`, not here.
 */
export function detectReparsePoints(root: string, relativePath: string): readonly string[] {
  const normalized = normalizePackageRelativePath(relativePath);
  if (!normalized.ok) return [];
  const rootDirectory = resolve(root);
  const segments = normalized.path.split('/');
  const found: string[] = [];
  let current = rootDirectory;
  const candidates = [rootDirectory, ...segments.map(segment => (current = resolve(current, segment)))];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let stats;
    try { stats = lstatSync(candidate); }
    catch { continue; }
    if (stats.isSymbolicLink()) { found.push(candidate); continue; }
    try {
      if (resolve(realpathSync(candidate)) !== resolve(candidate)) found.push(candidate);
    } catch { /* an unresolvable realpath is reported by the caller as a missing file */ }
  }
  return found;
}

/**
 * The 01-A filesystem check for one declared file. `requireFile` distinguishes a manifest entry, which
 * must exist, from a resource reference, which may legitimately point at a not-yet-installed engine.
 */
export function findPackagePathIssues(root: string, relativePath: string, options: { readonly requireFile?: boolean; readonly field?: string } = {}): readonly PluginIssue[] {
  const field = options.field ?? relativePath;
  const normalized = normalizePackageRelativePath(relativePath, field);
  if (!normalized.ok) {
    return [{ category: 'entry_out_of_bounds', path: field, detail: normalized.rejection.detail }];
  }
  const reparse = detectReparsePoints(root, normalized.path);
  if (reparse.length) {
    return [{
      category: 'reparse_point_rejected',
      path: field,
      detail: `reparse point in the package path chain: ${reparse.map(entry => entry.slice(resolve(root).length + 1) || '.').join(', ')}`,
    }];
  }
  if (options.requireFile) {
    const target = resolveInsidePackage(root, normalized.path);
    if (!existsSync(target)) return [{ category: 'manifest_invalid', path: field, detail: `declared file ${normalized.path} does not exist in the package` }];
    let stats;
    try { stats = lstatSync(target); } catch { return [{ category: 'manifest_invalid', path: field, detail: `declared file ${normalized.path} is unreadable` }]; }
    if (!stats.isFile()) return [{ category: 'manifest_invalid', path: field, detail: `declared file ${normalized.path} is not a regular file` }];
  }
  return [];
}
