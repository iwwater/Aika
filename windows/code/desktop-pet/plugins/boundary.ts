/**
 * K65-01 (01-C): the dependency-boundary check.
 *
 * CONTRACTS.md §1: "宿主和普通包不静态/传递导入可选包私有实现" and AGENTS.md §3 "包间不得引用私有路径".
 * A capability package may import (a) files inside its own package root, (b) the published SDK, and
 * (c) package dependencies it DECLARED in its manifest. Anything else — the host's `contracts/`,
 * `providers/`, `app/` trees included — is a boundary violation, reported with the offending
 * specifier and the file that carries it.
 *
 * The check is transitive on purpose: importing a small "helper" that itself reaches into the host
 * would otherwise pass. The graph walk is `esm-graph.mjs`, shared with the 01-B load proof so the two
 * can never disagree about what a module depends on.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// The shared graph walker is plain .mjs so that the third-party fixture project can use the same
// implementation without a compiler; it is copied verbatim into the emitted SDK artifact.
import { extractSpecifiers, isExternalSpecifier, isInside, walkModuleGraph } from './esm-graph.mjs';
import { resolveInsidePackage } from './paths.js';
import type { PluginIssue } from '../contracts/plugin.js';

export interface ImportBoundaryRequest {
  /** Absolute path of the package root whose own files are always importable. */
  readonly packageRoot: string;
  /** Package-relative entries to walk. */
  readonly entries: readonly string[];
  /** Absolute directories outside the package that are legitimately importable (the emitted SDK). */
  readonly allowedRoots?: readonly string[];
  /** Bare specifiers the package may use; a bare specifier absent from this list is undeclared. */
  readonly allowedPackages?: readonly string[];
  /** Absolute directories that must never be reached: host private trees and other packages' internals. */
  readonly privateRoots?: readonly string[];
}

export interface BoundarySpecifierRecord {
  readonly from: string;
  readonly specifier: string;
  readonly resolved: string | null;
  readonly allowed: boolean;
}

export interface ImportBoundaryResult {
  readonly ok: boolean;
  readonly issues: readonly PluginIssue[];
  /** Every file actually reached, absolute. */
  readonly files: readonly string[];
  readonly specifiers: readonly BoundarySpecifierRecord[];
}

/**
 * Walks every entry's transitive relative imports and decides whether the package stays inside its
 * own boundary. Reads files; imports none. 01-C's "可编译" half is a separate real compiler run and
 * is deliberately not asserted here — a boundary check that also claimed compilation would be
 * evidence for neither.
 */
export function checkImportBoundary(request: ImportBoundaryRequest): ImportBoundaryResult {
  const packageRoot = resolve(request.packageRoot);
  const allowedRoots = (request.allowedRoots ?? []).map(entry => resolve(entry));
  const privateRoots = (request.privateRoots ?? []).map(entry => resolve(entry));
  const allowedPackages = new Set(request.allowedPackages ?? []);
  const issues: PluginIssue[] = [];
  const records: BoundarySpecifierRecord[] = [];
  const files = new Set<string>();

  for (const entry of request.entries) {
    let entryPath: string;
    try { entryPath = resolveInsidePackage(packageRoot, entry); }
    catch (error) { issues.push({ category: 'entry_out_of_bounds', path: entry, detail: (error as Error).message }); continue; }

    let graph;
    try { graph = walkModuleGraph(entryPath); }
    catch (error) { issues.push({ category: 'boundary_violation', path: entry, detail: (error as Error).message }); continue; }

    for (const file of graph.files) files.add(file.path);
    for (const unresolved of graph.unresolved) {
      const relative = unresolved.specifier || '<self>';
      issues.push({
        category: 'boundary_violation',
        path: relativePath(packageRoot, unresolved.from),
        detail: `specifier ${JSON.stringify(relative)} does not resolve (${unresolved.reason}); a package must ship the compiled files it imports`,
      });
      records.push({ from: unresolved.from, specifier: relative, resolved: null, allowed: false });
    }

    for (const file of graph.files) {
      let source;
      try { source = readFileSync(file.path, 'utf8'); } catch { source = ''; }
      // A runtime-provided `require` is the one shape that can address a host path the walker cannot
      // see statically. Refused outright rather than guessed at.
      if (/\bcreateRequire\s*\(/.test(source)) {
        issues.push({
          category: 'boundary_violation',
          path: relativePath(packageRoot, file.path),
          detail: 'createRequire() provides a host module loader to the package; a package may only use its own files, the SDK and its declared dependencies',
        });
      }
      for (const specifier of extractSpecifiers(source)) {
        const record = classify(packageRoot, allowedRoots, privateRoots, allowedPackages, file.path, specifier);
        records.push(record);
        if (!record.allowed) issues.push(violation(packageRoot, record));
      }
    }
  }
  return { ok: issues.length === 0, issues, files: [...files].sort(), specifiers: records };
}

function classify(
  packageRoot: string,
  allowedRoots: readonly string[],
  privateRoots: readonly string[],
  allowedPackages: ReadonlySet<string>,
  from: string,
  specifier: string,
): BoundarySpecifierRecord {
  if (isExternalSpecifier(specifier)) {
    // A bare specifier is a package dependency: legal only when the manifest declared it.
    if (specifier.startsWith('node:')) return { from, specifier, resolved: null, allowed: true };
    return { from, specifier, resolved: null, allowed: allowedPackages.has(specifier) };
  }
  const base = specifier.startsWith('.') ? resolve(dirname(from), specifier) : resolve(specifier);
  const resolved = resolveCandidate(base);
  if (!resolved) return { from, specifier, resolved: null, allowed: false };
  if (privateRoots.some(root => isInside(resolved, root))) return { from, specifier, resolved, allowed: false };
  if (isInside(resolved, packageRoot)) return { from, specifier, resolved, allowed: true };
  if (allowedRoots.some(root => isInside(resolved, root))) return { from, specifier, resolved, allowed: true };
  return { from, specifier, resolved, allowed: false };
}

function violation(packageRoot: string, record: BoundarySpecifierRecord): PluginIssue {
  const from = relativePath(packageRoot, record.from);
  if (record.resolved === null && !record.specifier.startsWith('.')) {
    return {
      category: 'boundary_violation', path: from,
      detail: `bare specifier ${JSON.stringify(record.specifier)} is not a declared package dependency; undeclared dependencies are refused rather than resolved`,
    };
  }
  if (record.resolved === null) {
    return { category: 'boundary_violation', path: from, detail: `specifier ${JSON.stringify(record.specifier)} does not resolve to a file` };
  }
  return {
    category: 'boundary_violation', path: from,
    detail: `specifier ${JSON.stringify(record.specifier)} resolves to ${record.resolved}, which is outside the package root, the allowed SDK roots and every declared dependency; importing a host or other-package private path is refused`,
  };
}

const relativePath = (root: string, absolute: string): string => {
  const normalizedRoot = resolve(root);
  const normalized = resolve(absolute);
  return isInside(normalized, normalizedRoot) ? normalized.slice(normalizedRoot.length + 1).split('\\').join('/') : normalized;
};

function resolveCandidate(base: string): string | null {
  for (const guess of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`,
    resolve(base, 'index.mjs'), resolve(base, 'index.js'), resolve(base, 'index.cjs')]) {
    try { if (statSync(guess).isFile()) return guess; } catch { /* not this one */ }
  }
  return null;
}
