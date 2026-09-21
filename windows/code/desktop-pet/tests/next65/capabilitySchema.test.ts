/**
 * K65-01 · 01-E: the capability-declaration / multi-source schema cases of the acceptance line
 * "两个 adapter 提供同一能力合法；同 adapter 身份异内容拒绝；本地无 Key/无云费率可通过对应 schema，
 *  云端缺必需鉴权和不支持的参数被拒绝".
 *
 * Every case calls the REAL validators (`validateCapabilityDeclaration`, `validateSourceInstance`,
 * `validatePackageManifest`). No stub, no inline re-implementation of the rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_PARAMETER_TYPES, UNSUPPORTED_PARAMETER_EXAMPLES,
} from '../../contracts/capability.js';
import { PLUGIN_ERROR_CATEGORIES, type PluginErrorCategory, type PluginIssue } from '../../contracts/plugin.js';
import {
  providersByCapability, validateCapabilityDeclaration, validatePackageManifest, validateSourceInstance,
} from '../../plugins/manifest.js';

const categories = (issues: readonly PluginIssue[]): readonly PluginErrorCategory[] => issues.map(issue => issue.category);
function expectCategories(issues: readonly PluginIssue[], expected: readonly PluginErrorCategory[]): void {
  for (const category of [...expected, ...categories(issues)]) {
    assert.ok(PLUGIN_ERROR_CATEGORIES.includes(category), `${category} is not a frozen error category`);
  }
  assert.deepEqual([...new Set(categories(issues))].sort(), [...new Set(expected)].sort(), `issues: ${JSON.stringify(issues, null, 2)}`);
}
const onlyCategory = (issues: readonly PluginIssue[]): PluginErrorCategory => {
  expectCategories(issues, [issues[0]!.category]);
  return issues[0]!.category;
};

const field = (name: string, type: 'string' | 'bytes' = 'string', description = '字段') =>
  ({ name, type, required: true, description });

/** A complete, otherwise-legal `tts.synthesize` declaration; each case perturbs one thing. */
function ttsDeclaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilityId: 'tts.synthesize',
    category: 'output',
    adapterId: 'tts.local',
    adapterVersion: '1.0.0',
    contractVersion: '1.0.0',
    parameters: ['voiceId', 'sampleRate', 'encoding'],
    execution: ['unary'],
    inputs: [field('text')],
    outputs: [field('audio', 'bytes')],
    sideEffect: 'user_visible_output',
    auth: 'none',
    ...overrides,
  };
}

/** A complete, otherwise-legal managed-local source (no key, no cloud rate). */
function localSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceId: 'local-sapi',
    adapterId: 'fixture-sapi',
    adapterVersion: '1.0.0',
    deployment: 'managed-local',
    label: '本机合成',
    configRevision: 1,
    runtimeRef: 'resources/sapi-runtime.json',
    auth: { kind: 'none' },
    limits: { maxConcurrentCalls: 1, maxQueueDepth: 2, startupTimeoutMs: 60000, callTimeoutMs: 15000, maxMemoryMb: null, maxGpuDevices: null },
    enablement: 'enabled',
    parameters: { 'tts.synthesize': { voiceId: 'Microsoft Huihui Desktop' } },
    dataDestination: 'local-machine',
    ...overrides,
  };
}

/** A complete remote-api source. */
function cloudSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...localSource({ deployment: 'remote-api', sourceId: 'cloud-tts', runtimeRef: undefined }),
    endpoint: 'https://tts.example.com/v1/synthesize',
    auth: { kind: 'credentialRef', ref: 'cred-000000000001' },
    dataDestination: 'vendor-cloud',
    ...overrides,
  };
}

/** Two plugins, one capability, two different adapters: the 01-E legal half. */
function twoAdapterManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    formatVersion: 1,
    hostApiRange: '>=1.0.0 <2.0.0',
    packageId: 'com.aika.fixture.twoadapters',
    version: '1.0.0',
    label: '双适配器包',
    platform: { platform: ['any'], arch: ['any'], runtimeVersion: '22.0.0', features: [] },
    dependencies: [],
    optionalDependencies: [],
    resources: [],
    permissions: [],
    files: [
      { path: 'alpha.mjs', bytes: 10, hash: `sha256-${'0'.repeat(64)}`, role: 'entry', executable: false },
      { path: 'beta.mjs', bytes: 10, hash: `sha256-${'0'.repeat(64)}`, role: 'entry', executable: false },
    ],
    plugins: [
      { pluginId: 'alpha.plugin', entry: 'alpha.mjs', label: 'A', capabilities: [ttsDeclaration({ adapterId: 'tts.alpha' })] },
      { pluginId: 'beta.plugin', entry: 'beta.mjs', label: 'B', capabilities: [ttsDeclaration({ adapterId: 'tts.beta' })] },
    ],
  };
}

// --- 01-E legal: one capability, two adapters ------------------------------------------------------

test('01-E legal: two adapters providing the same capability pass the capability schema (no conflict)', () => {
  const issues = [
    ...validateCapabilityDeclaration(ttsDeclaration({ adapterId: 'tts.alpha' }), 'plugins[0].capabilities[0]'),
    ...validateCapabilityDeclaration(ttsDeclaration({ adapterId: 'tts.beta' }), 'plugins[1].capabilities[0]'),
  ];
  assert.deepEqual(issues, [], `two adapters for one capability must be legal: ${JSON.stringify(issues)}`);
});

test('01-E legal: the same capability from two adapters stays legal through validatePackageManifest', () => {
  const manifest = twoAdapterManifest();
  // Pure schema validation: no package root, so only the metadata half runs.
  const result = validatePackageManifest(manifest, { checkFiles: false });
  const conflicts = result.issues.filter(issue => issue.category === 'capability_conflict' || issue.category === 'identity_conflict');
  assert.deepEqual(conflicts, [], `two adapters for one capability is not a conflict: ${JSON.stringify(conflicts)}`);
  assert.equal(result.issues.some(issue => issue.path.startsWith('plugins[0].capabilities[0]')), false);
  assert.equal(result.issues.some(issue => issue.path.startsWith('plugins[1].capabilities[0]')), false);
  // And discovery really sees both, which is what "两个 adapter 提供同一能力" has to mean.
  const owners = providersByCapability(manifest).get('tts.synthesize');
  assert.deepEqual(owners, ['tts.alpha@1.0.0', 'tts.beta@1.0.0']);
});

// --- 01-E illegal: one adapter identity, two different contents -------------------------------------

test('01-E illegal: the same adapterId with different content is refused as capability_conflict', () => {
  const manifest = twoAdapterManifest();
  const capabilities = (manifest.plugins as { capabilities: Record<string, unknown>[] }[])[1]!.capabilities;
  capabilities[0] = ttsDeclaration({ adapterId: 'tts.alpha', adapterVersion: '1.0.0', parameters: ['voiceId'] });
  const result = validatePackageManifest(manifest, { checkFiles: false });
  const conflict = result.issues.filter(issue => issue.category === 'capability_conflict');
  assert.equal(conflict.length, 1, `exactly one capability_conflict: ${JSON.stringify(result.issues)}`);
  assert.equal(conflict[0]!.path, 'plugins[1].capabilities[0]');
  assert.match(conflict[0]!.detail, /adapter identity tts\.alpha@1\.0\.0 is declared twice with different content/);
});

test('01-E illegal: the same adapterId with IDENTICAL content is not a conflict (identity, not duplication)', () => {
  const manifest = twoAdapterManifest();
  (manifest.plugins as { capabilities: Record<string, unknown>[] }[])[1]!.capabilities[0] =
    structuredClone(ttsDeclaration({ adapterId: 'tts.alpha' }));
  const result = validatePackageManifest(manifest, { checkFiles: false });
  assert.deepEqual(result.issues.filter(issue => issue.category === 'capability_conflict'), []);
});

test('01-E illegal: a capability whose adapterId disagrees with the plugin is refused as identity_conflict', () => {
  const issues = validateCapabilityDeclaration(ttsDeclaration(), 'plugins[0].capabilities[0]', { declaredAdapterId: 'tts.other' });
  assert.equal(onlyCategory(issues), 'identity_conflict');
  assert.equal(issues[0]!.path, 'plugins[0].capabilities[0].adapterId');
});

// --- 01-E legal: a local source with no key and no cloud rate --------------------------------------

test('01-E legal: a managed-local source with auth none and no cost declaration passes the source schema', () => {
  const issues = validateSourceInstance(localSource());
  assert.deepEqual(issues, [], `a local engine must not be forced to carry a key or a tariff: ${JSON.stringify(issues)}`);
  // The relaxation is about the ABSENCE of cloud-shaped fields, so prove they are really absent.
  const source = localSource();
  assert.equal((source.auth as { kind: string }).kind, 'none');
  assert.equal('cost' in source, false);
  assert.equal('rate' in source, false);
  assert.equal('credentialRef' in source, false);
});

test('01-E legal: a local-service source with auth none and no cost declaration passes the source schema', () => {
  const issues = validateSourceInstance(localSource({ deployment: 'local-service', runtimeRef: undefined }));
  assert.deepEqual(issues, [], JSON.stringify(issues));
});

test('01-E legal: a capability declaring auth none (local, no key) passes the capability schema', () => {
  const issues = validateCapabilityDeclaration(ttsDeclaration({ auth: 'none' }), 'capabilities[0]');
  assert.deepEqual(issues, [], JSON.stringify(issues));
});

// --- 01-E illegal: a cloud source with no required auth --------------------------------------------

test('01-E illegal: a remote-api source with auth kind none is refused as auth_required_missing', () => {
  const issues = validateSourceInstance(cloudSource({ auth: { kind: 'none' } }));
  assert.equal(onlyCategory(issues), 'auth_required_missing');
  assert.equal(issues[0]!.path, 'source.auth');
  assert.match(issues[0]!.detail, /remote-api source requires auth\.kind "credentialRef"/);
});

test('01-E illegal: a remote-api source that declares credentialRef but no ref is refused as auth_required_missing', () => {
  const issues = validateSourceInstance(cloudSource({ auth: { kind: 'credentialRef' } }));
  assert.equal(onlyCategory(issues), 'auth_required_missing');
  assert.equal(issues[0]!.path, 'source.auth.ref');
});

test('01-E illegal: a remote-api source with no endpoint is refused as auth_required_missing', () => {
  const issues = validateSourceInstance(cloudSource({ endpoint: undefined }));
  assert.ok(categories(issues).includes('auth_required_missing'), JSON.stringify(issues));
  assert.ok(issues.some(issue => issue.path === 'source.endpoint'), JSON.stringify(issues));
});

test('01-E legal: a remote-api source WITH credentialRef and endpoint passes', () => {
  assert.deepEqual(validateSourceInstance(cloudSource()), [], 'a cloud source that declares its auth passes');
});

// --- 01-E illegal: an unsupported parameter ---------------------------------------------------------

test('01-E illegal: a parameter outside the required capability vocabulary is refused as unsupported_parameter', () => {
  const issues = validateCapabilityDeclaration(
    ttsDeclaration({ parameters: ['voiceId', 'frequency_penalty'] }),
    'capabilities[0]',
  );
  const parameter = issues.find(issue => issue.path === 'capabilities[0].parameters[1]');
  assert.ok(parameter, `the offending parameter must be named: ${JSON.stringify(issues)}`);
  assert.equal(parameter.category, 'unsupported_parameter');
  assert.match(parameter.detail, /frequency_penalty/);
  assert.match(parameter.detail, /tts\.synthesize/);
});

test('01-E illegal: the cloud-only voice identity example is refused as unsupported_parameter', () => {
  const issues = validateCapabilityDeclaration(
    ttsDeclaration({ parameters: ['voiceId', UNSUPPORTED_PARAMETER_EXAMPLES.foreignVoiceId] }),
    'capabilities[0]',
  );
  assert.equal(onlyCategory(issues), 'unsupported_parameter');
  assert.equal(issues[0]!.path, 'capabilities[0].parameters[1]');
});

test('01-E illegal: an unsupported parameter is refused through validatePackageManifest too', () => {
  const manifest = twoAdapterManifest();
  (manifest.plugins as { capabilities: Record<string, unknown>[] }[])[0]!.capabilities[0] =
    ttsDeclaration({ adapterId: 'tts.alpha', parameters: ['voiceId', 'frequency_penalty'] });
  const result = validatePackageManifest(manifest, { checkFiles: false });
  assert.equal(result.ok, false);
  assert.ok(categories(result.issues).includes('unsupported_parameter'), JSON.stringify(result.issues));
});

test('01-E legal: every parameter the vocabulary actually defines for tts.synthesize is accepted', () => {
  const issues = validateCapabilityDeclaration(
    ttsDeclaration({ parameters: Object.keys(CAPABILITY_PARAMETER_TYPES['tts.synthesize']), execution: ['unary', 'streaming'] }),
    'capabilities[0]',
  );
  assert.deepEqual(issues, [], JSON.stringify(issues));
});

// --- knownCapabilityIds (K65-00 D4: the namespace is open, but the check is explicit) ----------------

test('knownCapabilityIds: an extension id is accepted when the caller supplies no known-id set (open namespace)', () => {
  const issues = validateCapabilityDeclaration(
    ttsDeclaration({ capabilityId: 'vendor.extra.render', category: 'presentation' }),
    'capabilities[0]',
  );
  assert.deepEqual(issues, [], `D4 keeps the namespace open: ${JSON.stringify(issues)}`);
});

test('knownCapabilityIds: once the caller supplies a vocabulary, an id outside it is capability_unsupported', () => {
  const issues = validateCapabilityDeclaration(
    ttsDeclaration({ capabilityId: 'vendor.extra.render', category: 'presentation' }),
    'capabilities[0]',
    { knownCapabilityIds: ['tts.synthesize', 'audio.playback'] },
  );
  assert.equal(onlyCategory(issues), 'capability_unsupported');
  assert.equal(issues[0]!.path, 'capabilities[0].capabilityId');
  assert.match(issues[0]!.detail, /vendor\.extra\.render/);
});

test('knownCapabilityIds: an id inside the supplied vocabulary passes', () => {
  const issues = validateCapabilityDeclaration(ttsDeclaration(), 'capabilities[0]', { knownCapabilityIds: ['tts.synthesize'] });
  assert.deepEqual(issues, [], JSON.stringify(issues));
});
