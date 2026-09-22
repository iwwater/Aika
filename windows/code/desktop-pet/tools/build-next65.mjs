/** K65-03: build the portable kernel artifact and ordinary product package. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'dist/next65');
const normal = resolve(output, 'packages/normal');
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'kernel'), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['kernel/index.ts'], outfile: resolve(output, 'kernel/index.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node:*'], legalComments: 'inline',
});
await mkdir(normal, { recursive: true });
await cp(resolve(root, 'packages/normal/entry.mjs'), resolve(normal, 'entry.mjs'));
await cp(resolve(root, 'packages/normal/README.md'), resolve(normal, 'README.md'));

const hash = async path => `sha256-${createHash('sha256').update(await readFile(path)).digest('hex')}`;
const files = await Promise.all(['README.md', 'entry.mjs'].map(async path => ({
  path, bytes: (await readFile(resolve(normal, path))).byteLength, hash: await hash(resolve(normal, path)),
  role: path === 'entry.mjs' ? 'entry' : 'documentation', executable: false,
})));
const { computeManifestHash, validateManifestFile } = await import('../dist/plugins/manifest.js');
const manifest = {
  schemaVersion: 1, formatVersion: 1, hostApiRange: '>=1.0.0 <2.0.0', dependencies: [], optionalDependencies: [],
  resources: [], platform: { platform: ['any'], arch: ['any'], runtimeVersion: '22.0.0', features: [] },
  packageId: 'com.aika.product.normal', version: '0.65.0', label: 'Aika 普通包',
  plugins: [{ pluginId: 'normal.product', entry: 'entry.mjs', label: '普通文字对话', capabilities: [{
    adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'credentialRef', sideEffect: 'network_egress',
    execution: ['unary'], capabilityId: 'llm.chat', category: 'dialogue', adapterId: 'normal.llm',
    parameters: ['temperature', 'maxOutputTokens', 'contextWindow', 'structuredOutput', 'tools', 'thinking', 'language'],
    inputs: [{ name: 'text', type: 'string', required: true, description: '当前轮用户文本' }],
    outputs: [{ name: 'text', type: 'string', required: true, description: '模型回复文本' }],
  }], dependsOn: [], readinessProbe: null }], permissions: [], files,
};
manifest.manifestHash = computeManifestHash(manifest);
await writeFile(resolve(normal, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const checked = validateManifestFile(normal);
if (!checked.ok) throw new Error(`K65-03 ordinary package manifest failed: ${JSON.stringify(checked.issues)}`);

const compatibility = resolve(output, 'packages/compatibility');
await mkdir(compatibility, { recursive: true });
await cp(resolve(root, 'packages/compatibility/entry.mjs'), resolve(compatibility, 'entry.mjs'));
await cp(resolve(root, 'packages/compatibility/README.md'), resolve(compatibility, 'README.md'));
const compatibilityFiles = await Promise.all(['README.md', 'entry.mjs'].map(async path => ({
  path, bytes: (await readFile(resolve(compatibility, path))).byteLength, hash: await hash(resolve(compatibility, path)),
  role: path === 'entry.mjs' ? 'entry' : 'documentation', executable: false,
})));
const compatibilityManifest = {
  schemaVersion: 1, formatVersion: 1, hostApiRange: '>=1.0.0 <2.0.0', dependencies: [], optionalDependencies: [], resources: [],
  platform: { platform: ['any'], arch: ['any'], runtimeVersion: '22.0.0', features: [] },
  packageId: 'com.aika.product.compatibility', version: '0.65.0', label: 'Aika 长期能力兼容包',
  plugins: [{ pluginId: 'compatibility.product', entry: 'entry.mjs', label: '长期能力', capabilities: [
    { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'local_read', execution: ['unary'], capabilityId: 'context.source', category: 'context_source', adapterId: 'compatibility.memory', parameters: ['maxItems', 'budgetTokens', 'scope', 'dedupe', 'minScore'], inputs: [{ name: 'scope', type: 'scope', required: true, description: '会话范围' }], outputs: [{ name: 'context', type: 'object', required: true, description: '长期上下文引用' }] },
    { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'local_write', execution: ['unary'], capabilityId: 'background.lifecycle', category: 'background_lifecycle', adapterId: 'compatibility.lifecycle', parameters: ['pollIntervalMs', 'startPolicy', 'watchdogMs', 'idleStopMs'], inputs: [{ name: 'scope', type: 'scope', required: true, description: '后台范围' }], outputs: [{ name: 'status', type: 'object', required: true, description: '维护状态' }] },
  ], dependsOn: [], readinessProbe: null }], permissions: [], files: compatibilityFiles,
};
compatibilityManifest.manifestHash = computeManifestHash(compatibilityManifest);
await writeFile(resolve(compatibility, 'manifest.json'), `${JSON.stringify(compatibilityManifest, null, 2)}\n`, 'utf8');
const checkedCompatibility = validateManifestFile(compatibility);
if (!checkedCompatibility.ok) throw new Error(`K65-04 compatibility package manifest failed: ${JSON.stringify(checkedCompatibility.issues)}`);

const tts = resolve(output, 'packages/tts');
await mkdir(tts, { recursive: true });
await cp(resolve(root, 'packages/tts/entry.mjs'), resolve(tts, 'entry.mjs'));
await cp(resolve(root, 'packages/tts/README.md'), resolve(tts, 'README.md'));
const ttsFiles = await Promise.all(['README.md', 'entry.mjs'].map(async path => ({
  path, bytes: (await readFile(resolve(tts, path))).byteLength, hash: await hash(resolve(tts, path)),
  role: path === 'entry.mjs' ? 'entry' : 'documentation', executable: false,
})));
const ttsCapabilities = [
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'credentialRef', sideEffect: 'network_egress', execution: ['unary', 'streaming'], capabilityId: 'tts.synthesize', category: 'output', adapterId: 'tts.cloud', parameters: ['voiceId', 'sampleRate', 'encoding', 'speed', 'streaming', 'language'], inputs: [{ name: 'text', type: 'string', required: true, description: '要合成的文字' }, { name: 'voiceId', type: 'string', required: true, description: '当前来源音色' }], outputs: [{ name: 'audio', type: 'bytes', required: true, description: '规范化 WAV 音频' }] },
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'process_lifecycle', execution: ['unary'], capabilityId: 'tts.synthesize', category: 'output', adapterId: 'tts.sapi', parameters: ['voiceId', 'sampleRate', 'encoding', 'speed', 'language'], inputs: [{ name: 'text', type: 'string', required: true, description: '要合成的文字' }, { name: 'voiceId', type: 'string', required: false, description: '本机音色' }], outputs: [{ name: 'audio', type: 'bytes', required: true, description: '规范化 WAV 音频' }] },
];
const ttsManifest = {
  schemaVersion: 1, formatVersion: 1, hostApiRange: '>=1.0.0 <2.0.0', dependencies: [], optionalDependencies: [], resources: [],
  platform: { platform: ['any'], arch: ['any'], runtimeVersion: '22.0.0', features: [] },
  packageId: 'com.aika.product.tts', version: '0.65.0', label: 'Aika TTS 包',
  plugins: [{ pluginId: 'tts.product', entry: 'entry.mjs', label: '语音输出', capabilities: ttsCapabilities, dependsOn: [], readinessProbe: null }], permissions: [{ id: 'speaker', scope: 'tts:playback', reason: '播放合成语音', promptsUser: true }], files: ttsFiles,
};
ttsManifest.manifestHash = computeManifestHash(ttsManifest);
await writeFile(resolve(tts, 'manifest.json'), `${JSON.stringify(ttsManifest, null, 2)}\n`, 'utf8');
const checkedTts = validateManifestFile(tts);
if (!checkedTts.ok) throw new Error(`K65-05 TTS package manifest failed: ${JSON.stringify(checkedTts.issues)}`);

const stt = resolve(output, 'packages/stt');
await mkdir(stt, { recursive: true });
await cp(resolve(root, 'packages/stt/entry.mjs'), resolve(stt, 'entry.mjs'));
await cp(resolve(root, 'packages/stt/README.md'), resolve(stt, 'README.md'));
const sttFiles = await Promise.all(['README.md', 'entry.mjs'].map(async path => ({
  path, bytes: (await readFile(resolve(stt, path))).byteLength, hash: await hash(resolve(stt, path)),
  role: path === 'entry.mjs' ? 'entry' : 'documentation', executable: false,
})));
const sttCapabilities = [
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'credentialRef', sideEffect: 'network_egress', execution: ['unary'], capabilityId: 'stt.transcribe', category: 'input', adapterId: 'stt.cloud.batch', parameters: ['language', 'streaming', 'sampleRate', 'punctuation', 'modelType'], inputs: [{ name: 'audio', type: 'bytes', required: true, description: 'PCM WAV 音频' }], outputs: [{ name: 'transcript', type: 'string', required: true, description: '原始转写文本' }] },
  { adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'process_lifecycle', execution: ['streaming'], capabilityId: 'stt.transcribe', category: 'input', adapterId: 'stt.local.streaming', parameters: ['language', 'streaming', 'sampleRate', 'punctuation', 'modelType'], inputs: [{ name: 'audio', type: 'bytes', required: true, description: 'PCM16 音频帧' }], outputs: [{ name: 'transcript', type: 'string', required: true, description: 'partial/final 转写事件' }] },
];
const sttManifest = {
  schemaVersion: 1, formatVersion: 1, hostApiRange: '>=1.0.0 <2.0.0', dependencies: [], optionalDependencies: [], resources: [],
  platform: { platform: ['any'], arch: ['any'], runtimeVersion: '22.0.0', features: [] },
  packageId: 'com.aika.product.stt', version: '0.65.0', label: 'Aika STT 包',
  plugins: [{ pluginId: 'stt.product', entry: 'entry.mjs', label: '语音输入', capabilities: sttCapabilities, dependsOn: [], readinessProbe: null }], permissions: [{ id: 'microphone', scope: 'stt:capture', reason: '采集语音输入', promptsUser: true }], files: sttFiles,
};
sttManifest.manifestHash = computeManifestHash(sttManifest);
await writeFile(resolve(stt, 'manifest.json'), `${JSON.stringify(sttManifest, null, 2)}\n`, 'utf8');
const checkedStt = validateManifestFile(stt);
if (!checkedStt.ok) throw new Error(`K65-06 STT package manifest failed: ${JSON.stringify(checkedStt.issues)}`);

const testHarness = resolve(output, 'packages/test-harness');
await cp(resolve(root, 'tests/next65/fixtures/packages/test-harness'), testHarness, { recursive: true });
const checkedHarness = validateManifestFile(testHarness);
if (!checkedHarness.ok) throw new Error(`K65-10 test harness package manifest failed: ${JSON.stringify(checkedHarness.issues)}`);
console.log(JSON.stringify({ output, kernel: resolve(output, 'kernel/index.js'), normalPackage: normal, compatibilityPackage: compatibility, ttsPackage: tts, sttPackage: stt, testHarnessPackage: testHarness, manifestHash: manifest.manifestHash }));
