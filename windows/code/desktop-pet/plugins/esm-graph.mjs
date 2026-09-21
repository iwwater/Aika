// K65-01: the one implementation of "what does this ESM file actually depend on".
//
// Two callers need it and they must not drift apart:
//   * `plugins/import-boundary.ts` (01-C) — the dependency-boundary check that refuses a fixture
//     reaching into host or other-package private paths.
//   * `tests/next65/fixtureBoundary.test.mjs` — the proof that a *loading* entry executes while a
//     *validated* entry never does (01-B).
//
// TESTING.md forbids source-string assertions as proof that a module was not loaded. So the graph is
// built by parsing (dynamic `import()` can never be observed by a static regex over `export` lines)
// and the load proof is a real child process whose entry module touches a heartbeat file at top
// level. Plain `.mjs` on purpose: the third-party fixture project must be compilable without the
// host's TypeScript setup (K65-00 D1 "不复用宿主 tsconfig"), so nothing here may need a compiler.

import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

/**
 * Thrown when a specifier cannot be parsed at all; callers turn this into a boundary violation.
 */
export class DependencyParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DependencyParseError';
  }
}

/** Enum-like dependency kinds, exported so a consumer can label a specifier without re-deriving it. */
export const SPECIFIER_KINDS = /** @type {const} */ ({
  relative: 'relative',
  absolute: 'absolute',
  builtin: 'builtin',
  bare: 'bare',
});

const SKIPPED_PREFIX = ['node:', 'data:', 'http:', 'https:', 'bun:', 'deno:'];

/**
 * Extracts every static and dynamic module specifier from ESM/JS source.
 *
 * Deliberately a scanner rather than a full parser: it must accept the same files Node accepts, must
 * not pull a compiler into a package that is supposed to be dependency-free, and must not be fooled
 * by specifiers inside comments or string literals. Template literals without substitutions are
 * included because `await import(`./x.js`)` is legal and would otherwise escape the check.
 */
export function extractSpecifiers(source) {
  const specifiers = [];
  const length = source.length;
  let index = 0;
  // Tracks whether the previous significant token permits a regex literal here. A `/` after a value
  // (identifier, `)`, `]`) is division; after an operator or `(` it starts a regex.
  let previousSignificant = '';
  const pushToken = (token) => { previousSignificant = token; };

  const readString = (start, quote) => {
    let cursor = start + 1;
    let out = '';
    while (cursor < length) {
      const char = source[cursor];
      if (char === '\\') { out += source.slice(cursor, cursor + 2); cursor += 2; continue; }
      if (char === quote) return { value: out, end: cursor + 1 };
      if (char === '\n' && quote !== '`') return null;
      out += char;
      cursor += 1;
    }
    return null;
  };

  /**
   * Reads the module specifier of a STATIC import: `import 'x'`, `import a from 'x'`,
   * `import * as a from 'x'`, `import {a, b as c} from 'x'`, `import a, {b} from 'x'`,
   * `import a, * as b from 'x'` and the TypeScript `import type … from 'x'` shape, with or without a
   * terminating semicolon and with the clause spread over several lines.
   *
   * `start` sits just past the `import` keyword. The clause is walked rather than pattern-matched so a
   * brace group or a string inside it cannot terminate the scan early; a `from` found at clause level
   * (never inside braces or a literal) is the one that introduces the specifier. Returns null for
   * anything that is not a static import — notably `import.meta` and `import(...)` — so the caller can
   * fall back to those paths.
   */
  const readImportSpecifier = (start) => {
    let cursor = start;
    // Whitespace AND comments: `import /* c */ 'x'` is legal and the comment must not be read as code.
    const skipSpace = () => {
      while (cursor < length) {
        const current = source[cursor];
        if (/\s/.test(current)) { cursor += 1; continue; }
        if (current === '/' && source[cursor + 1] === '/') {
          while (cursor < length && source[cursor] !== '\n') cursor += 1;
          continue;
        }
        if (current === '/' && source[cursor + 1] === '*') {
          const end = source.indexOf('*/', cursor + 2);
          cursor = end === -1 ? length : end + 2;
          continue;
        }
        return;
      }
    };
    skipSpace();
    // `import 'x'`: the bare side-effect form carries no binding clause at all. Only single and double
    // quotes here — a static IMPORT clause takes a string literal, never a template literal, so
    // `obj.import\`tpl\`` cannot be misread as a specifier. Dynamic `import(\`x\`)` stays supported.
    const direct = source[cursor];
    if (direct === '"' || direct === "'") {
      const literal = readString(cursor, direct);
      return literal ? { value: literal.value, end: literal.end } : null;
    }
    while (cursor < length) {
      const current = source[cursor];
      if (current === '"' || current === "'" || current === '`') {
        const literal = readString(cursor, current);
        if (!literal) return null;
        cursor = literal.end;
        continue;
      }
      if (current === '{') {
        // Skip the named-binding group atomically: it may hold nested braces, `as` aliases and
        // string-literal keys, none of which may be read as the end of the clause.
        let depth = 0;
        while (cursor < length) {
          const inner = source[cursor];
          if (inner === '"' || inner === "'" || inner === '`') {
            const literal = readString(cursor, inner);
            if (!literal) return null;
            cursor = literal.end;
            continue;
          }
          if (inner === '{') depth += 1;
          else if (inner === '}') {
            depth -= 1;
            cursor += 1;
            if (depth === 0) break;
            continue;
          }
          cursor += 1;
        }
        continue;
      }
      if (/[A-Za-z0-9_$]/.test(current)) {
        const wordStart = cursor;
        while (cursor < length && /[A-Za-z0-9_$]/.test(source[cursor])) cursor += 1;
        if (source.slice(wordStart, cursor) === 'from') {
          skipSpace();
          const quote = source[cursor];
          if (quote !== '"' && quote !== "'") return null;
          const literal = readString(cursor, quote);
          return literal ? { value: literal.value, end: literal.end } : null;
        }
        continue;
      }
      // A closing brace/paren, a statement end or an assignment means this was never a static import
      // (an `import` object key, for example); stop instead of scanning on into unrelated code.
      if (current === '}' || current === ')' || current === ';' || current === '=') return null;
      cursor += 1;
    }
    return null;
  };

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') { while (index < length && source[index] !== '\n') index += 1; continue; }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (char === '/' && previousSignificant !== 'value' && previousSignificant !== ')' && previousSignificant !== ']') {
      // A regex literal: skip to the unescaped closing slash so its body cannot be misread as code.
      let cursor = index + 1;
      let inClass = false;
      while (cursor < length) {
        const current = source[cursor];
        if (current === '\\') { cursor += 2; continue; }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        else if (current === '\n') break;
        cursor += 1;
      }
      index = cursor + 1;
      pushToken('value');
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const literal = readString(index, char);
      if (!literal) { index += 1; continue; }
      index = literal.end;
      pushToken('value');
      continue;
    }
    if (char === 'i' && /^import\b/.test(source.slice(index, index + 8))) {
      const staticImport = readImportSpecifier(index + 6);
      // A static import always ends in its own specifier, so consuming it here also skips the rest of
      // the statement. This branch must come first: without it the scanner fell through to the generic
      // identifier path at `index += 6`, read `import` as an ordinary token and every `import … from`
      // binding became invisible to both the graph walk and the boundary check.
      if (staticImport) {
        specifiers.push(staticImport.value);
        index = staticImport.end;
        pushToken('value');
        continue;
      }
      const cursor = index + 6;
      const after = source.slice(cursor).match(/^\s*[.(]/);
      if (!after) { index += 6; pushToken('import'); continue; }
      if (after[0].trim() === '(') {
        let dynamic = cursor + after[0].length;
        // `import()` takes exactly one argument, but an intermediary, a spread helper or a nested call
        // is legal too; step through them rather than assuming the string sits directly after the paren.
        while (dynamic < length) {
          const head = source[dynamic];
          if (/\s/.test(head)) { dynamic += 1; continue; }
          if (head === '"' || head === "'" || head === '`') {
            const literal = readString(dynamic, head);
            if (literal) specifiers.push(literal.value);
            break;
          }
          if (head === ',' || head === ')') break;
          // Anything else is a parenthesised expression wrapping the real argument: re-enter and try
          // again one character in, so `import((0, sevaluer)('x'))`-shaped obfuscation still lands.
          dynamic += 1;
        }
        index = cursor;
        continue;
      }
      // `.` is `import.meta`; `(` handled above.
      if (after[0].trim() === '.') { index += 6; pushToken('import'); continue; }
    }
    if (char === 'e' && /^export\b/.test(source.slice(index, index + 7))) {
      const rest = source.slice(index + 6).match(/^\s*(?:\*(?:\s*as\s+[\w$]+)?\s*from\s*|\{[^}]*\}\s*from\s*)/);
      if (rest) {
        const cursor = index + 6 + rest[0].length;
        const quote = source[cursor];
        if (quote === '"' || quote === "'") {
          const literal = readString(cursor, quote);
          if (literal) { specifiers.push(literal.value); index = literal.end; pushToken('value'); continue; }
        }
      }
      index += 7;
      pushToken('export');
      continue;
    }
    if (char === 'r' && /^require\s*\(/.test(source.slice(index, index + 9))) {
      // `createRequire(...)` results are not tracked: a runtime-provided require is a host escape and
      // is reported as a boundary violation by `checkImportBoundary` for a package entry.
      const cursor = source.indexOf('(', index);
      const quote = source[cursor + 1];
      if (quote === '"' || quote === "'") {
        const literal = readString(cursor + 1, quote);
        if (literal) { specifiers.push(literal.value); index = literal.end; pushToken('value'); continue; }
      }
    }
    if (/[A-Za-z0-9_$]/.test(char)) {
      let cursor = index;
      while (cursor < length && /[A-Za-z0-9_$.]/.test(source[cursor])) cursor += 1;
      index = cursor;
      pushToken('value');
      continue;
    }
    if (!/\s/.test(char)) pushToken(char === ')' ? ')' : char === ']' ? ']' : char);
    index += 1;
  }
  return specifiers;
}

/** True for a specifier the boundary check must ignore because it is not a filesystem module. */
export function isExternalSpecifier(specifier) {
  if (SKIPPED_PREFIX.some(prefix => specifier.startsWith(prefix))) return true;
  // A bare specifier is a package dependency, which the manifest declares; only relative/absolute
  // specifiers can escape a package root.
  return !specifier.startsWith('.') && !isAbsolute(specifier);
}

/**
 * Walks the relative-import graph reachable from `entry`. Returns the visited absolute files, the
 * relative edges that could not be resolved, and each file's raw specifiers so callers can render a
 * precise violation instead of "something was wrong somewhere".
 */
export function walkModuleGraph(entryPath, options = {}) {
  const maxFiles = options.maxFiles ?? 512;
  const visited = new Set();
  const unresolved = [];
  const files = [];
  const queue = [resolve(entryPath)];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    if (visited.size >= maxFiles) { unresolved.push({ from: current, specifier: '', reason: `module graph exceeds ${maxFiles} files` }); break; }
    visited.add(current);
    let source;
    try { source = readFileSync(current, 'utf8'); }
    catch (error) { unresolved.push({ from: current, specifier: '', reason: `unreadable: ${error.code ?? error.message}` }); continue; }
    let specifiers;
    try { specifiers = extractSpecifiers(source); }
    catch (error) { throw new DependencyParseError(`cannot parse ${current}: ${error.message}`); }
    files.push({ path: current, specifiers });
    for (const specifier of specifiers) {
      if (isExternalSpecifier(specifier)) continue;
      const base = specifier.startsWith('.') ? resolve(dirname(current), specifier) : specifier;
      const candidate = resolveFileCandidate(base);
      if (!candidate) { unresolved.push({ from: current, specifier, reason: 'no such file' }); continue; }
      queue.push(candidate);
    }
  }
  return { entry: resolve(entryPath), files, unresolved };
}

/** Node's resolution order for a relative specifier: exact, then the extension guesses, then a directory index. */
function resolveFileCandidate(base) {
  const guesses = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`,
    resolve(base, 'index.mjs'), resolve(base, 'index.js'), resolve(base, 'index.cjs')];
  for (const guess of guesses) {
    try { if (statSync(guess).isFile()) return guess; }
    catch { /* not this one */ }
  }
  return null;
}

/** True when `child` is `parent` itself or lives underneath it, comparing on separator boundaries. */
export function isInside(child, parent) {
  const from = resolve(parent);
  const to = resolve(child);
  if (from === to) return true;
  return to.startsWith(from.endsWith(sep) ? from : from + sep);
}
