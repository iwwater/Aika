/**
 * K65-01 (01-A) fixture builder: writes four REAL directory packages under
 * tests/next65/fixtures/packages/. Every manifest.json hash is computed by the production
 * `contentHash` / `computeManifestHash`, so the committed fixtures are what the host validator
 * accepts, not what a hand-written JSON editor guessed.
 *
 * Excluded from the host compile on purpose (tsconfig excludes tests/next65/fixtures/**), so the
 * package entries are authored as .mjs and never pull fixture code into the host build.
 *
 * Run: node tools/build... no — run directly: `node tests/next65/fixtures/packages/make-fixtures.mjs`
 * (requires `npm run build` first, because it imports the compiled dist/plugins/manifest.js).
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeManifestHash, contentHash } from '../../../../dist/plugins/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));

const capability = (overrides) => ({
  adapterVersion: '1.0.0',
  contractVersion: '1.0.0',
  auth: 'none',
  sideEffect: 'none',
  execution: ['unary'],
  ...overrides,
});

const text = (name, description, required = true) => ({ name, type: 'string', required, description });

const PACKAGES = [
  {
    dir: 'normal',
    manifest: {
      packageId: 'com.aika.fixture.normal',
      version: '1.0.0',
      label: '普通包',
      plugins: [{
        pluginId: 'normal.plugin',
        entry: 'entry.mjs',
        label: '普通能力插件',
        capabilities: [capability({
          capabilityId: 'presentation.render',
          category: 'presentation',
          adapterId: 'normal.adapter',
          parameters: ['presetId', 'maxFps'],
          inputs: [text('presetId', '要渲染的展示载荷')],
          outputs: [text('rendered', '渲染结果描述')],
        })],
      }],
      permissions: [],
    },
    files: {
      'entry.mjs': 'export const activation = { pluginId: "normal.plugin" };\n',
      'README.md': '# 普通包\n\nK65-01 01-A 合法普通包 fixture。\n',
    },
  },
  {
    dir: 'tts',
    manifest: {
      packageId: 'com.aika.fixture.tts',
      version: '1.2.3',
      label: 'TTS 包',
      plugins: [{
        pluginId: 'tts.plugin',
        entry: 'entry.mjs',
        label: 'TTS 合成插件',
        capabilities: [capability({
          capabilityId: 'tts.synthesize',
          category: 'output',
          adapterId: 'tts.local',
          parameters: ['voiceId', 'streaming'],
          execution: ['unary', 'streaming'],
          inputs: [text('voiceId', '音色标识')],
          outputs: [{ name: 'audio', type: 'bytes', required: true, description: '合成音频字节' }],
          sideEffect: 'none',
        })],
      }],
      permissions: [{ id: 'speaker', scope: 'tts:playback', reason: '播放合成语音', promptsUser: true }],
    },
    files: {
      'entry.mjs': 'export const activation = { pluginId: "tts.plugin" };\n',
      'voices/default.json': '{ "voice": "aika-default" }\n',
      'README.md': '# TTS 包\n\nK65-01 01-A 合法 TTS 包 fixture。\n',
    },
  },
  {
    dir: 'stt',
    manifest: {
      packageId: 'com.aika.fixture.stt',
      version: '0.9.0',
      label: 'STT 包',
      plugins: [{
        pluginId: 'stt.plugin',
        entry: 'entry.mjs',
        label: 'STT 转写插件',
        capabilities: [capability({
          capabilityId: 'stt.transcribe',
          category: 'input',
          adapterId: 'stt.local',
          parameters: ['language', 'streaming'],
          execution: ['streaming'],
          inputs: [{ name: 'audio', type: 'bytes', required: true, description: '输入音频字节' }],
          outputs: [text('transcript', '转写文本')],
          sideEffect: 'device_capture',
        })],
      }],
      permissions: [{ id: 'microphone', scope: 'stt:capture', reason: '采集麦克风音频用于转写', promptsUser: true }],
    },
    files: {
      'entry.mjs': 'export const activation = { pluginId: "stt.plugin" };\n',
      'README.md': '# STT 包\n\nK65-01 01-A 合法 STT 包 fixture。\n',
    },
  },
  {
    dir: 'test-harness',
    manifest: {
      packageId: 'com.aika.fixture.test',
      version: '2.0.0',
      label: '测试包',
      plugins: [{
        pluginId: 'test.harness',
        entry: 'entry.mjs',
        label: '测试探针插件',
        capabilities: [capability({
          capabilityId: 'background.lifecycle',
          category: 'background_lifecycle',
          adapterId: 'test.adapter',
          parameters: ['pollIntervalMs'],
          inputs: [text('pollIntervalMs', '探针间隔')],
          outputs: [text('status', '探针状态')],
          sideEffect: 'local_read',
        })],
      }],
      // 权重是引用，不是包内容：external:true 是 01-D 的同一条规则在 manifest 侧的形态。
      resources: [{
        id: 'probe-weight',
        kind: 'model',
        reference: 'external://models/probe.bin',
        required: false,
        readiness: null,
        external: true,
      }],
      permissions: [],
    },
    files: {
      'entry.mjs': 'export const activation = { pluginId: "test.harness" };\n',
      'data/probe.json': '{ "interval": "60s" }\n',
      'README.md': '# 测试包\n\nK65-01 01-A 合法测试包 fixture。\n',
    },
  },
];

const ROLE = (path) => {
  if (path === 'entry.mjs') return 'entry';
  if (path.endsWith('.md')) return 'documentation';
  if (path.startsWith('data/')) return 'data';
  return 'asset';
};

for (const pkg of PACKAGES) {
  const root = resolve(here, pkg.dir);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const files = [];
  for (const [relative, body] of Object.entries(pkg.files)) {
    const target = resolve(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, 'utf8');
  }
  for (const relative of Object.keys(pkg.files)) {
    const body = pkg.files[relative];
    files.push({
      path: relative,
      bytes: Buffer.byteLength(body, 'utf8'),
      hash: contentHash(body),
      role: ROLE(relative),
      executable: false,
    });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : 1));
  const manifest = {
    schemaVersion: 1,
    formatVersion: 1,
    hostApiRange: '>=1.0.0 <2.0.0',
    dependencies: [],
    optionalDependencies: [],
    resources: [],
    platform: { platform: ['any'], arch: ['any'], runtimeVersion: '22.0.0', features: [] },
    ...pkg.manifest,
    files,
    manifestHash: 'sha256-' + '0'.repeat(64),
  };
  manifest.manifestHash = computeManifestHash(manifest);
  writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`${pkg.dir}: ${files.length} files, manifestHash ${manifest.manifestHash.slice(0, 20)}…`);
}
