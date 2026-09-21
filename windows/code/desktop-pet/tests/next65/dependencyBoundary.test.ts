/**
 * K65-01 · 01-C: an independent capability-package fixture project compiles against the SDK ALONE,
 * and a fixture that reaches into host or other-package private paths is REFUSED by the real
 * dependency-boundary check.
 *
 * Both halves are behavioral, never source-string:
 *   * "compiles alone" is a real `tsc -p <fixture>/tsconfig.json` child process whose exit code is
 *     asserted, plus an assertion that the fixture tsconfig does not extend the host one;
 *   * "refused" is the real `checkImportBoundary` return payload — `ok: false`, the violating
 *     specifiers classified `allowed: false`, the reached-but-private files named, and the
 *     `createRequire` escape reported — compared against the compliant entry, which passes.
 *
 * NOTE ON FORM: the negative fixtures use `export … from` re-exports and a dynamic `import()` because
 * `extractSpecifiers` in plugins/esm-graph.mjs does not currently see `import … from '…'` bindings
 * (see the 01-C report). Reach-throughs written as plain bindings would be invisible to the check;
 * these are written so the check must SEE them, which is what makes the refusal meaningful.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

/** Reads tsconfig.json/package.json: both carry `//` comments, which JSON.parse rejects. */
function readCommentedJson<T>(path: string): T {
  const stripped = readFileSync(path, 'utf8')
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*)/g, (match, comment) => (comment ? '' : match));
  return JSON.parse(stripped) as T;
}

/** The fixture project's own build: its own tsconfig, the emitted SDK as its only non-local root. */
function compileFixtureProject(): { status: number; stdout: string; stderr: string } {
  const spawned = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', resolve(fixtureRoot, 'tsconfig.json')],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (spawned.error) assert.fail(`could not start tsc: ${String(spawned.error)}`);
  return { status: spawned.status ?? -1, stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
}

/** The real boundary check, pointed at the fixture with the host trees declared private. */
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

const relative = (absolute: string): string => absolute.slice(repositoryRoot.length + 1).split('\\').join('/');

test('01-C: the fixture project compiles on its own against the SDK, exit code 0', () => {
  const compiled = compileFixtureProject();
  assert.equal(compiled.status, 0, `the independent fixture project must compile: ${compiled.stdout}${compiled.stderr}`);

  // "Independent" is a property of the project, so assert it rather than assume it.
  const tsconfig = readCommentedJson<{ extends?: string; compilerOptions: { paths?: Record<string, string[]> } }>(resolve(fixtureRoot, 'tsconfig.json'));
  assert.equal(tsconfig.extends, undefined, 'the fixture tsconfig must NOT extend the host tsconfig');
  assert.deepEqual(Object.keys(tsconfig.compilerOptions.paths ?? {}), ['aika-plugin-sdk', 'aika-plugin-sdk/*']);
  assert.equal(readCommentedJson<{ dependencies?: unknown }>(resolve(fixtureRoot, 'package.json')).dependencies, undefined,
    'the fixture declares no runtime dependencies of its own: only the SDK');
});

test('01-C: the compliant entry passes the real boundary check with every specifier allowed', () => {
  const result = checkEntries(['src/sdk-bridge.mjs']);
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.deepEqual(result.issues, []);
  assert.ok(result.specifiers.length > 0, 'the compliant entry really has edges, so the check had work to do');
  for (const specifier of result.specifiers) {
    assert.equal(specifier.allowed, true, `${specifier.specifier} must be allowed: ${JSON.stringify(specifier)}`);
  }
  // Both legal kinds of edge are present AND classified: an intra-package file, and the declared SDK.
  assert.deepEqual(result.specifiers.map(specifier => specifier.specifier), ['./local/helper.mjs', 'aika-plugin-sdk']);
  assert.equal(result.specifiers[0]!.resolved, resolve(fixtureRoot, 'src/local/helper.mjs'));
  // SDK-only: nothing the compliant entry reaches may live outside the SDK or the package itself.
  for (const file of result.files) {
    assert.ok(relative(file).includes('next65-sdk') || relative(file).includes('fixtures/plugin-sdk'),
      `the compliant entry reached ${file}, which is neither the SDK nor its own package`);
  }
});

test('01-C: the fixture project is the SDK-only project it claims — its own tsconfig excludes the reach-through', () => {
  // `src/index.ts` is the project's SDK-consumer; the boundary check must find no private edge in it
  // either, and the project's tsc run must not include the negative fixture.
  const indexResult = checkEntries(['src/index.ts']);
  assert.equal(indexResult.ok, true, JSON.stringify(indexResult.issues, null, 2));
  const tsconfig = readCommentedJson<{ exclude?: string[] }>(resolve(fixtureRoot, 'tsconfig.json'));
  assert.ok((tsconfig.exclude ?? []).includes('src/host-reach-through.ts'),
    'the negative fixture must be outside the project build that 01-C claims succeeds');
});

test('01-C: the reach-through fixture is refused — payload carries every private specifier', () => {
  const result = checkEntries(['src/host-reach-through.ts']);
  assert.equal(result.ok, false, 'a package reaching host or other-package private paths must be refused');
  assert.ok(result.issues.length >= 4, `expected at least four refusals, got ${result.issues.length}: ${JSON.stringify(result.issues)}`);

  const categories = [...new Set(result.issues.map(issue => issue.category))];
  assert.deepEqual(categories, ['boundary_violation'], JSON.stringify(result.issues, null, 2));

  const refused = result.specifiers.filter(specifier => specifier.allowed === false);
  const refusedSpecifiers = refused.map(specifier => specifier.specifier);
  assert.ok(refusedSpecifiers.includes('../../../../../dist/contracts/index.js'), `host contracts barrel refused; got ${JSON.stringify(refusedSpecifiers)}`);
  assert.ok(refusedSpecifiers.includes('../../../../../dist/providers/slot-registry.js'), `host provider registry refused; got ${JSON.stringify(refusedSpecifiers)}`);
  assert.ok(refusedSpecifiers.includes('../../other-package/src/private-store.js'), `other-package private store refused; got ${JSON.stringify(refusedSpecifiers)}`);

  // The refusal must name the resolved REAL file, not just the specifier text. Paths are normalised
  // to forward slashes because the host resolves them with Windows separators.
  for (const specifier of refused) {
    assert.ok(specifier.resolved, `every refusal must resolve to a real file: ${JSON.stringify(specifier)}`);
  }
  const resolvedRefusals = refused.map(specifier => relative(specifier.resolved!));
  const resolvedHost = resolvedRefusals.filter(path => /^dist\/(contracts|providers)\//.test(path));
  assert.ok(resolvedHost.length >= 2, `the host private trees are named by their resolved paths: ${JSON.stringify(resolvedRefusals)}`);
  assert.ok(resolvedRefusals.some(path => path.startsWith('tests/next65/fixtures/other-package/')),
    `the other-package private path is named by its resolved path: ${JSON.stringify(resolvedRefusals)}`);

  // And the check really walked into them: the reached file set contains host and other-package files.
  const reached = result.files.map(relative);
  assert.ok(reached.some(file => file.startsWith('dist/contracts/')), `host contracts entered the graph: ${JSON.stringify(reached)}`);
  assert.ok(reached.some(file => file.startsWith('dist/providers/')), `host providers entered the graph: ${JSON.stringify(reached)}`);
  assert.ok(reached.some(file => file.startsWith('tests/next65/fixtures/other-package/')), `other package entered the graph: ${JSON.stringify(reached)}`);

  // The refusal message says WHY, for at least the three reach-throughs the fixture is about.
  const details = result.issues.map(issue => issue.detail);
  assert.ok(details.some(detail => detail.includes('importing a host or other-package private path is refused')), JSON.stringify(details));
  assert.ok(result.issues.some(issue => issue.path === 'src/host-reach-through.ts'), 'the violating file is named package-relative');
});

test('01-C: the check is transitive — a private file reached THROUGH another private file is reported', () => {
  const result = checkEntries(['src/host-reach-through.ts']);
  const reached = result.files.map(relative);
  assert.ok(reached.includes('tests/next65/fixtures/other-package/src/private-keys.js'),
    `the second-hop private module must be walked: ${JSON.stringify(reached)}`);
  assert.ok(result.issues.some(issue => issue.detail.includes('private-keys.js')),
    'the second hop is itself reported, not silently absorbed');
});

test('01-C: createRequire is refused outright — a runtime host loader is not a dependency', () => {
  const result = checkEntries(['src/require-escape.mjs']);
  assert.equal(result.ok, false, JSON.stringify(result.issues, null, 2));
  const escape = result.issues.find(issue => issue.detail.includes('createRequire()'));
  assert.ok(escape, `createRequire must be reported: ${JSON.stringify(result.issues)}`);
  assert.equal(escape!.category, 'boundary_violation');
  assert.equal(escape!.path, 'src/require-escape.mjs');
  assert.match(escape!.detail, /provides a host module loader to the package/);
});

test('01-C: an undeclared bare dependency is refused too, not silently resolved', () => {
  // A fourth kind of escape, checked behaviorally with the real classifier.
  const declared = checkEntries(['src/sdk-bridge.mjs']);
  const bare = checkImportBoundary({
    packageRoot: fixtureRoot,
    entries: ['src/sdk-bridge.mjs'],
    allowedRoots: [sdkRoot],
    privateRoots: [otherPackageRoot],
    allowedPackages: [], // the SDK is deliberately NOT declared here
  });
  assert.equal(declared.ok, true, 'the compliant entry passes when the SDK IS declared');
  assert.equal(bare.ok, false, 'the same entry is refused when its SDK dependency is not declared');
  const undeclared = bare.issues.filter(issue => issue.detail.includes('is not a declared package dependency'));
  assert.equal(undeclared.length, 1, JSON.stringify(bare.issues, null, 2));
  assert.equal(undeclared[0]!.path, 'src/sdk-bridge.mjs');
  assert.match(undeclared[0]!.detail, /"aika-plugin-sdk"/);
  // The intra-package edge is unaffected: declared-ness applies to bare specifiers only.
  assert.equal(bare.specifiers.find(specifier => specifier.specifier === './local/helper.mjs')!.allowed, true);
});
