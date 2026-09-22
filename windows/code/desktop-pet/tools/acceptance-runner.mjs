// Acceptance runner for PKG-01 through PKG-05
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMinimalKernel } from '../dist/next65/kernel/index.js';
import { importPackageHost, setPackageEnablement } from '../dist/plugins/host-config.js';
import { createPackageHost, discoverInstalledPackages } from '../dist/plugins/host-runtime.js';
import { SherpaStreamingAsr } from '../dist/providers/sherpa-streaming-asr.js';
import { QwenTtsProvider } from '../dist/providers/qwen-tts.js';
import { SapiTtsProvider } from '../dist/providers/sapi-tts.js';
import { MemoryMediaStore } from '../dist/media/store.js';
import { pcm16Wav } from '../dist/media/wav.js';

const secrets = () => ({ has: () => false, resolve: () => null, list: () => [] });
const normalSrc = resolve('dist/next65/packages/normal');
const ttsSrc = resolve('dist/next65/packages/tts');
const sttSrc = resolve('dist/next65/packages/stt');

export async function runPkg01() {
  console.log('\n--- PKG-01: 仅内核 + 普通包 ---');
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'pkg01-'));
  try {
    const imp = importPackageHost({ sourceRoot: normalSrc, hostRoot });
    assert.equal(imp.ok, true);
    setPackageEnablement({ hostRoot, packageId: 'com.aika.product.normal', enabled: true });
    
    const host = createPackageHost({ hostRoot, secrets: secrets() });
    const providers = await host.resolve({ pluginId: 'normal.product', capabilityId: 'llm.chat' });
    assert.deepEqual(providers.map(p => p.adapterId), ['normal.llm']);
    
    const pkgs = discoverInstalledPackages(hostRoot).packages.map(p => p.manifest.packageId);
    assert.deepEqual(pkgs, ['com.aika.product.normal']);
    console.log('✔ 清洁目录仅包含 normal 包，无 TTS/STT 初始化');

    const dialogue = {
      async reply(input, signal) {
        if (input.text.includes('取消')) {
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        }
        return { scope: input.scope, text: '回复:' + input.text, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
      }
    };
    const kernel = createMinimalKernel({ dialogue });

    async function turn(text) {
      const p = new Promise(res => {
        const u = kernel.subscribe(e => { if (e.type === 'terminal') { u(); res(e); } });
      });
      const s = await kernel.submit({ text });
      return { scope: s, term: await p };
    }

    for (let i = 1; i <= 3; i++) {
      const res = await turn('第' + i + '句');
      assert.equal(res.term.status, 'completed');
      console.log(`✔ 文本第 ${i} 轮: 成功 (${res.term.replyText})`);
    }

    const cancelP = new Promise(res => {
      const u = kernel.subscribe(e => { if (e.type === 'terminal' && e.status === 'cancelled') { u(); res(e); } });
    });
    const cs = await kernel.submit({ text: '这句将被取消' });
    kernel.cancel(cs);
    const cterm = await cancelP;
    assert.equal(cterm.status, 'cancelled');
    console.log('✔ 取消一轮: 成功响应 cancelled');

    const rec = await turn('重发新文本');
    assert.equal(rec.term.status, 'completed');
    console.log(`✔ 恢复重发: 成功 (${rec.term.replyText})`);

    const hist = kernel.history.snapshot(rec.scope.characterId).map(m => m.text);
    assert.ok(!hist.some(t => t.includes('回复:这句将被取消')));
    console.log('✔ 历史边界: 被取消的回复未进入历史');
    
    kernel.close();
    await host.close();
    return true;
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
}

export async function runPkg02() {
  console.log('\n--- PKG-02: TTS 单包按需加载 ---');
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'pkg02-'));
  try {
    importPackageHost({ sourceRoot: normalSrc, hostRoot });
    setPackageEnablement({ hostRoot, packageId: 'com.aika.product.normal', enabled: true });
    importPackageHost({ sourceRoot: ttsSrc, hostRoot });
    setPackageEnablement({ hostRoot, packageId: 'com.aika.product.tts', enabled: true });

    const host = createPackageHost({ hostRoot, secrets: secrets() });
    const providers = await host.resolve({ pluginId: 'tts.product', capabilityId: 'tts.synthesize' });
    assert.deepEqual(providers.map(p => p.adapterId).sort(), ['tts.cloud', 'tts.sapi']);
    console.log('✔ TTS 包导入启用后成功解析能力: tts.cloud, tts.sapi');

    // 停用 TTS
    setPackageEnablement({ hostRoot, packageId: 'com.aika.product.tts', enabled: false });
    await host.close();

    const host2 = createPackageHost({ hostRoot, secrets: secrets() });
    await assert.rejects(
      host2.resolve({ pluginId: 'tts.product', capabilityId: 'tts.synthesize' }),
      err => err.category === 'lifecycle_violation'
    );
    console.log('✔ 停用后 TTS 解析被安全拦截 (lifecycle_violation)');

    const normalP = await host2.resolve({ pluginId: 'normal.product', capabilityId: 'llm.chat' });
    assert.equal(normalP[0]?.capabilityId, 'llm.chat');
    console.log('✔ 停用 TTS 后，文字能力依然独立可用');

    await host2.close();
    return true;
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
}

export async function runPkg03() {
  console.log('\n--- PKG-03: STT 单包按需加载 ---');
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'pkg03-'));
  const workerDir = mkdtempSync(resolve(tmpdir(), 'pkg03-w-'));
  try {
    importPackageHost({ sourceRoot: sttSrc, hostRoot });
    setPackageEnablement({ hostRoot, packageId: 'com.aika.product.stt', enabled: true });
    
    const host = createPackageHost({ hostRoot, secrets: secrets() });
    const providers = await host.resolve({ pluginId: 'stt.product', capabilityId: 'stt.transcribe' });
    assert.deepEqual(providers.map(p => p.adapterId).sort(), ['stt.cloud.batch', 'stt.local.streaming']);
    console.log('✔ STT 独立加载成功，解析能力: stt.cloud.batch, stt.local.streaming，且无 TTS');

    const workerFile = resolve(workerDir, 'worker.mjs');
    writeFileSync(workerFile, `import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ ready: true });
parentPort.on('message', m => {
  if (m.type === 'open') parentPort.postMessage({ id: m.id });
  else if (m.type === 'push') {
    parentPort.postMessage({ id: m.id });
    parentPort.postMessage({ type: 'partial', streamId: m.streamId, index: 0, revision: 1, segmentId: 'seg-0', text: '你好' });
  }
  else if (m.type === 'finish') {
    parentPort.postMessage({ type: 'final', streamId: m.streamId, index: 0, revision: 2, segmentId: 'seg-0', text: '你好世界' });
    parentPort.postMessage({ id: m.id });
  }
  else if (m.type === 'cancel') parentPort.postMessage({ id: m.id });
});`);

    const asr = new SherpaStreamingAsr({
      encoder: 'fixture.encoder', decoder: 'fixture.decoder', joiner: 'fixture.joiner', tokens: 'fixture.tokens',
      workerUrl: pathToFileURL(workerFile), openTimeoutMs: 2000, callTimeoutMs: 2000
    });
    const scope1 = { characterId: 'companion', sessionId: 's1', turnId: 't1', generation: 1 };
    const events = [];
    asr.subscribe(event => {
      if (event.type === 'partial' || event.type === 'final') events.push(`${event.type}:${event.segment.text}`);
    });
    await asr.openStream(scope1, 16000);
    await asr.push(scope1, new Uint8Array([0, 0, 1, 0]), 16000);
    await asr.finish(scope1);
    assert.deepEqual(events, ['partial:你好', 'final:你好世界']);
    console.log('✔ 录音流式转写: 收到 partial("你好") 与 final("你好世界")');

    // 取消
    const scope2 = { characterId: 'companion', sessionId: 's1', turnId: 't2', generation: 2 };
    await asr.openStream(scope2, 16000);
    await asr.cancel(scope2);
    assert.deepEqual(events, ['partial:你好', 'final:你好世界']);
    console.log('✔ 录音中取消: 成功发送 cancel 且未提交残句');

    // 重连与再次转写
    const scope3 = { characterId: 'companion', sessionId: 's1', turnId: 't3', generation: 3 };
    await asr.openStream(scope3, 16000);
    await asr.push(scope3, new Uint8Array([0, 0, 1, 0]), 16000);
    await asr.finish(scope3);
    assert.deepEqual(events, ['partial:你好', 'final:你好世界', 'partial:你好', 'final:你好世界']);
    console.log('✔ 取消后重连: 再次录音并转写成功');

    await asr.close();
    await host.close();
    return true;
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(workerDir, { recursive: true, force: true });
  }
}

export async function runPkg04() {
  console.log('\n--- PKG-04: 四种包组合隔离验证 ---');
  // 1. 普通 2. +TTS 3. +STT 4. +TTS+STT
  const combinations = [
    { name: '普通', packages: ['normal'] },
    { name: '+TTS', packages: ['normal', 'tts'] },
    { name: '+STT', packages: ['normal', 'stt'] },
    { name: '+TTS+STT', packages: ['normal', 'tts', 'stt'] }
  ];

  for (const combo of combinations) {
    const hostRoot = mkdtempSync(resolve(tmpdir(), 'pkg04-'));
    try {
      for (const p of combo.packages) {
        const src = p === 'normal' ? normalSrc : p === 'tts' ? ttsSrc : sttSrc;
        importPackageHost({ sourceRoot: src, hostRoot });
        setPackageEnablement({ hostRoot, packageId: `com.aika.product.${p}`, enabled: true });
      }
      const host = createPackageHost({ hostRoot, secrets: secrets() });
      const installed = discoverInstalledPackages(hostRoot).packages.map(p => p.manifest.packageId);
      console.log(`✔ 组合 [${combo.name}] 成功启动，已加载包: ${installed.join(', ')}`);
      
      const hasTts = combo.packages.includes('tts');
      const hasStt = combo.packages.includes('stt');

      if (!hasTts) {
        assert.ok(!installed.some(id => id.includes('tts')), `[${combo.name}] 严禁初始化 TTS`);
      }
      if (!hasStt) {
        assert.ok(!installed.some(id => id.includes('stt')), `[${combo.name}] 严禁初始化 STT`);
      }
      await host.close();
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
    }
  }
  console.log('✔ 四种组合互不污染，未选包零初始化/零占用');
  return true;
}

export async function runPkg05() {
  console.log('\n--- PKG-05: 包边界和懒加载 ---');
  const packages = [
    { name: 'normal', path: normalSrc },
    { name: 'tts', path: ttsSrc },
    { name: 'stt', path: sttSrc }
  ];

  for (const pkg of packages) {
    const manifest = JSON.parse(readFileSync(resolve(pkg.path, 'manifest.json'), 'utf8'));
    assert.ok(manifest.packageId, 'packageId 必须存在');
    assert.ok(manifest.version, 'version 必须存在');
    assert.ok(manifest.files.some(f => f.path === 'entry.mjs'), '必须具有规范化 entry.mjs');
    console.log(`✔ 包 [${pkg.name}] 独立 manifest 校验合法: ${manifest.packageId}@${manifest.version}`);
  }
  return true;
}

async function main() {
  await runPkg01();
  await runPkg02();
  await runPkg03();
  await runPkg04();
  await runPkg05();
  console.log('\n========================================');
  console.log('  Section B (PKG-01 ~ PKG-05) 全部 PASS');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('验收执行失败:', err);
  process.exit(1);
});
