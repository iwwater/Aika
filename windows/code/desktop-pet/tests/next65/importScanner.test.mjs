/**
 * K65-01 · 01-C scanner regression: `extractSpecifiers` must see EVERY static import form.
 *
 * This file is the guard for a real hole: `plugins/esm-graph.mjs` used to return `[]` for every
 * `import … from '…'` statement, which made `checkImportBoundary` blind to the most common import
 * syntax — a package could reach into a host-private path with a plain binding and PASS. The
 * `import` branch fell through to the generic identifier path (`index += 6`) without ever consuming
 * the specifier, so only `export … from`, dynamic `import()` and `require()` were ever recorded.
 *
 * `.mjs`, so `npm run test:next65` runs it straight from `tests/next65/` without a compile step.
 * The assertions are on the scanner's RETURN VALUE — never a grep of a source string — and the
 * negative cases are what keep the positives from being satisfied by a scanner that simply emits
 * every quoted string it meets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpecifiers } from '../../plugins/esm-graph.mjs';

/** Walks up to the package root so the suite works from both tests/next65/ and dist/tests/next65/. */
const packageRoot = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolvePath(directory, 'package.json'))) return directory + '/';
    directory = dirname(directory);
  }
  throw new Error('could not locate the desktop-pet package root from ' + import.meta.url);
})();

test('01-C scanner: every static import form yields its module specifier', () => {
  // The forms the hole covered: with or without a trailing semicolon, because a statement end is
  // exactly where a naive clause walk gives up.
  const forms = [
    ["import 'x';", 'x'],
    ["import 'x'", 'x'],
    ["import a from 'x';", 'x'],
    ["import a from 'x'", 'x'],
    ["import * as a from 'x';", 'x'],
    ["import * as a from 'x'", 'x'],
    ["import {a} from 'x';", 'x'],
    ["import {a} from 'x'", 'x'],
    ["import {a as b} from 'x';", 'x'],
    ["import a, {b} from 'x';", 'x'],
    ["import a, * as b from 'x';", 'x'],
    ["import {\n  a,\n  b as c,\n} from 'x';", 'x'],
    ["import type { T } from 'x';", 'x'],
  ];
  for (const [source, expected] of forms) {
    assert.deepEqual(extractSpecifiers(source), [expected],
      `${JSON.stringify(source)} must yield ${JSON.stringify(expected)}, got ${JSON.stringify(extractSpecifiers(source))}`);
  }
});

test('01-C scanner: the forms that already worked are not regressed', () => {
  assert.deepEqual(extractSpecifiers("export {a} from 'x';"), ['x']);
  assert.deepEqual(extractSpecifiers("export * from 'x';"), ['x']);
  assert.deepEqual(extractSpecifiers("export * as ns from 'x';"), ['x']);
  assert.deepEqual(extractSpecifiers("const m = await import('x');"), ['x']);
  assert.deepEqual(extractSpecifiers("const m = import('x')"), ['x']);
  assert.deepEqual(extractSpecifiers("const m = require('x');"), ['x']);
  // Several edges in one file, in source order: the scanner must not stop at the first.
  assert.deepEqual(extractSpecifiers("import a from './a.js';\nexport { b } from './b.js';\nawait import('./c.js');"),
    ['./a.js', './b.js', './c.js']);
});

test('01-C scanner: a specifier inside a comment, string or regex is NOT extracted', () => {
  // The discipline the existing fixtures depend on; these ALL used to pass and must keep passing.
  for (const source of [
    "// import a from 'x'",
    "/* import a from 'x' */",
    'const s = "import a from \'x\'";',
    'const s = \'import {a} from "x"\';',
    "const re = /import a from 'x'/;",
    'const o = { note: `import a from \'x\'` };',
  ]) {
    assert.deepEqual(extractSpecifiers(source), [], `${JSON.stringify(source)} must yield nothing`);
  }
});

test('01-C scanner: an identifier that merely starts with "import" is not a dependency', () => {
  // `import.meta`, object keys and longer identifiers must not be mistaken for an import statement.
  for (const [source, expected] of [
    ['const u = import.meta.url;', []],
    ['const o = { import: 1 };', []],
    ['const importee = 5;', []],
    ['function importer() {}', []],
    ['const n = important + 1;', []],
    ['const m = await import(dynamicPath);', []],
    ['exports.from = 1;', []],
    ["const m = await import('./real.js');", ['./real.js']],
  ]) {
    assert.deepEqual(extractSpecifiers(source), expected, JSON.stringify(source));
  }
});

test('01-C scanner: the real host sources yield their real relative edges', () => {
  // Behavioral, over production files: the compiled boundary check is what 01-C runs, and it only
  // imports through plain `import … from`, so a scanner blind to that form finds nothing here.
  const boundary = packageRoot + 'dist/plugins/boundary.js';
  assert.equal(existsSync(boundary), true, `build first: ${boundary} is missing`);
  const specifiers = extractSpecifiers(readFileSync(boundary, 'utf8'));
  for (const expected of ['./esm-graph.mjs', './paths.js']) {
    assert.ok(specifiers.includes(expected),
      `the compiled boundary check really imports ${expected}; got ${JSON.stringify(specifiers)}`);
  }
});
