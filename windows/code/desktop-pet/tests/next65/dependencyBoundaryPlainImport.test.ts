/**
 * K65-01 · 01-C: the hole is CLOSED — a reach-through written as a PLAIN `import … from` binding is
 * REJECTED by the real `checkImportBoundary`.
 *
 * Why this file exists. `tests/next65/dependencyBoundary.test.ts` deliberately writes its negative
 * reach-throughs as `export … from` re-exports and a dynamic `import()`, with a NOTE ON FORM saying
 * that plain `import … from` bindings "would be invisible to the check". That note was a live bug:
 * `extractSpecifiers` returned `[]` for every `import … from '…'` form, so 01-C's refusal passed on
 * the reach-through shapes it could see while the most common import syntax walked straight through.
 *
 * This test is the proof that is no longer true. It feeds real `checkImportBoundary` a fixture written
 * entirely in the offending syntax (`src/host-reach-through-plain.mjs`) and asserts on the RETURNED
 * PAYLOAD — never a grep of the fixture source. Its assertions are additive: nothing in
 * dependencyBoundary.test.ts is weakened or changed.
 *
 * The discriminator is deliberately narrow. `import 'node:fs'` in the same fixture is legal and stays
 * ALLOWED, so `ok: false` here cannot be explained by "the scanner now rejects everything"; and the
 * reached set includes the second hop, so it cannot be explained by only looking at the entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImportBoundary } from '../../plugins/boundary.js';
import type { ImportBoundaryResult } from '../../plugins/boundary.js';

let testDirectory = dirname(fileURLToPath(import.meta.url));
if (basename(testDirectory) === 'next65' && basename(dirname(dirname(testDirectory))) === 'dist') {
  testDirectory = resolve(dirname(dirname(testDirectory)), '..', 'tests', 'next65');
}
const repositoryRoot = resolve(testDirectory, '..', '..');
const fixtureRoot = resolve(testDirectory, 'fixtures', 'plugin-sdk');
const sdkRoot = resolve(repositoryRoot, 'dist', 'next65-sdk');
const otherPackageRoot = resolve(testDirectory, 'fixtures', 'other-package');

const relative = (absolute: string): string => absolute.slice(repositoryRoot.length + 1).split('\\').join('/');

/** The real boundary check, pointed at the plain-import fixture with the host trees declared private. */
function checkEntries(entries: readonly string[]): ImportBoundaryResult {
  return checkImportBoundary({
    packageRoot: fixtureRoot,
    entries,
    allowedRoots: [sdkRoot],
    allowedPackages: ['aika-plugin-sdk'],
    privateRoots: [resolve(repositoryRoot, 'dist'), resolve(repositoryRoot, 'contracts'),
      resolve(repositoryRoot, 'providers'), resolve(repositoryRoot, 'app'),
      resolve(repositoryRoot, 'plugins'), otherPackageRoot],
  });
}

test('01-C: a PLAIN import…from reach-through is refused — the scanner hole is closed', () => {
  const entry = 'src/host-reach-through-plain.mjs';
  assert.equal(existsSync(resolve(fixtureRoot, entry)), true, 'the plain-import negative fixture must exist');

  // The fixture really is written in the syntax that used to slip through, and ONLY in that syntax
  // (plus one legal node: edge). This is a fixture self-description, not the claim being proven.
  // Comments are stripped first: the fixture's own header discusses the other forms by name.
  const source = readFileSync(resolve(fixtureRoot, entry), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.match(source, /^import .* from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/dist\/contracts\/index\.js';$/m);
  assert.match(source, /^import \{[^}]*\} from '\.\.\/\.\.\/other-package\/src\/private-store\.js';$/m);
  // …and carries no re-export or dynamic-import edge, so the refusal cannot be credited to a form the
  // scanner already handled. (A plain value `export const` is fine and is not a re-export.)
  assert.doesNotMatch(source, /^export .*\bfrom\b/m, 'no export…from re-export may be relied on here');
  assert.doesNotMatch(source, /\bimport\s*\(/, 'no dynamic import() may be relied on here');

  const result = checkEntries([entry]);

  // THE CLAIM: a plain binding into a host-private path no longer passes.
  assert.equal(result.ok, false,
    `a plain import…from reach-through must be refused; got ok:true with issues ${JSON.stringify(result.issues)}`);
  assert.ok(result.issues.length > 0, 'the refusal must be reported, not just returned as ok:false');

  const categories = [...new Set(result.issues.map(issue => issue.category))];
  assert.deepEqual(categories, ['boundary_violation'], JSON.stringify(result.issues, null, 2));

  // Each of the four reach-through bindings is SEEN and REFUSED, by specifier text.
  const refused = result.specifiers.filter(specifier => specifier.allowed === false).map(specifier => specifier.specifier);
  assert.ok(refused.includes('../../../../../dist/contracts/index.js'), `host contracts barrel refused; got ${JSON.stringify(refused)}`);
  assert.ok(refused.includes('../../../../../dist/providers/slot-registry.js'), `host provider registry refused; got ${JSON.stringify(refused)}`);
  assert.ok(refused.includes('../../other-package/src/private-store.js'), `other-package private store refused; got ${JSON.stringify(refused)}`);

  // …and resolved to the REAL file it addresses, which is what distinguishes "private path" from
  // "no such file".
  for (const specifier of result.specifiers.filter(candidate => !candidate.allowed)) {
    assert.ok(specifier.resolved, `every refusal must resolve to a real file: ${JSON.stringify(specifier)}`);
  }

  const details = result.issues.map(issue => issue.detail);
  assert.ok(details.some(detail => detail.includes('importing a host or other-package private path is refused')),
    JSON.stringify(details));
  assert.ok(result.issues.some(issue => issue.path === entry), 'the violating file is named package-relative');
});

test('01-C: the refusal is NOT a blanket rejection of every `import` — the legal node: edge still passes', () => {
  // Without this, `ok: false` above could mean "the scanner now rejects everything". It does not:
  // `import 'node:fs'` sits in the same fixture and is classified allowed.
  const result = checkEntries(['src/host-reach-through-plain.mjs']);
  const builtin = result.specifiers.find(specifier => specifier.specifier === 'node:fs');
  assert.ok(builtin, `the fixture's node:fs edge must be seen: ${JSON.stringify(result.specifiers.map(s => s.specifier))}`);
  assert.equal(builtin!.allowed, true, 'a builtin specifier is not a filesystem module and stays allowed');
});

test('01-C: the plain-import refusal is transitive — the walk enters the private trees', () => {
  const result = checkEntries(['src/host-reach-through-plain.mjs']);
  const reached = result.files.map(candidate => relative(candidate));
  assert.ok(reached.some(file => file.startsWith('dist/contracts/')), `host contracts entered the graph: ${JSON.stringify(reached)}`);
  assert.ok(reached.some(file => file.startsWith('dist/providers/')), `host providers entered the graph: ${JSON.stringify(reached)}`);
  assert.ok(reached.some(file => file.startsWith('tests/next65/fixtures/other-package/')),
    `other package entered the graph: ${JSON.stringify(reached)}`);
  // The second hop is itself reported rather than silently absorbed.
  assert.ok(reached.includes('tests/next65/fixtures/other-package/src/private-keys.js'),
    `the second-hop private module must be walked: ${JSON.stringify(reached)}`);
  assert.ok(result.issues.some(issue => issue.detail.includes('private-keys.js')), 'the second hop is itself reported');
});

test('01-C: a PLAIN import inside the package is still allowed — the compliant shape did not regress', () => {
  // Scoped comparator: same check, same private roots, but a fixture whose plain bindings stay HOME.
  // Together with the refusal above it isolates the boundary as the discriminator, not the syntax.
  const homeOnly = checkImportBoundary({
    packageRoot: fixtureRoot,
    entries: ['src/local/plain-consumer.mjs'],
    allowedRoots: [sdkRoot],
    allowedPackages: ['aika-plugin-sdk'],
    privateRoots: [resolve(repositoryRoot, 'dist'), otherPackageRoot],
  });
  assert.equal(homeOnly.ok, true, `an intra-package plain import must stay allowed: ${JSON.stringify(homeOnly.issues)}`);
  assert.deepEqual(homeOnly.specifiers.map(specifier => specifier.specifier), ['./helper.mjs']);
  for (const specifier of homeOnly.specifiers) assert.equal(specifier.allowed, true, JSON.stringify(specifier));
});
