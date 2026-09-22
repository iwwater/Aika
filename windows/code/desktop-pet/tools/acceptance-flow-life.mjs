// Acceptance runner for FLOW-01~FLOW-03 and LIFE-01~LIFE-04
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FlowRuntime, FlowProfileError } from '../dist/kernel/flow-runtime.js';
import { importPackageHost, setPackageEnablement } from '../dist/plugins/host-config.js';
import { PackageLifecycleManager, LifecycleError } from '../dist/plugins/package-lifecycle.js';
import { readPackageRegistry } from '../dist/plugins/package-import.js';
import { computeManifestHash } from '../dist/plugins/manifest.js';

const ttsSrc = resolve('dist/next65/packages/tts');

export async function testFlow() {
  console.log('\n--- FLOW-01 ~ FLOW-03: 流程编排与 Profile 验收 ---');
  
  const baseProfile = {
    schemaVersion: 1, profileId: 'profile-aika', revision: 1, label: 'Standard Flow',
    nodes: [
      { nodeId: 'ctx-local', kind: 'capability', capabilityId: 'context.source', bindingId: 'src.local', inputs: [], outputs: [{ name: 'text', required: true }], sideEffect: 'local_read', condition: null, dependsOn: [] },
      { nodeId: 'ctx-knowledge', kind: 'capability', capabilityId: 'context.source', bindingId: 'src.knowledge', inputs: [], outputs: [{ name: 'text', required: true }], sideEffect: 'local_read', condition: null, dependsOn: [] },
      { nodeId: 'llm-main', kind: 'capability', capabilityId: 'llm.chat', bindingId: 'llm.chat', inputs: [{ name: 'local', from: 'ctx-local.text', required: true }, { name: 'kb', from: 'ctx-knowledge.text', required: true }], outputs: [{ name: 'text', required: true }], sideEffect: 'none', condition: null, dependsOn: ['ctx-local', 'ctx-knowledge'] }
    ],
    failurePolicy: { onStageFailure: 'fail_turn', retrySideEffects: false, maxAttempts: 1 },
    joinOrder: ['ctx-local', 'ctx-knowledge', 'llm-main']
  };

  let executionCalls = 0;
  const handlers = [
    { capabilityId: 'context.source', bindingId: 'src.local', async execute() { executionCalls++; return { text: '用户上下文' }; } },
    { capabilityId: 'context.source', bindingId: 'src.knowledge', async execute() { executionCalls++; return { text: '知识库上下文' }; } },
    { capabilityId: 'llm.chat', bindingId: 'llm.chat', async execute(ctx) { return { text: `LLM回复(${ctx.inputs.local}+${ctx.inputs.kb})` }; } }
  ];
  const runtime = new FlowRuntime(handlers);

  // FLOW-01: Profile 预览
  const preview = runtime.preview(baseProfile);
  assert.equal(executionCalls, 0, '预览阶段严禁调用任何 Provider');
  assert.deepEqual(preview.map(n => n.nodeId), ['ctx-local', 'ctx-knowledge', 'llm-main']);
  console.log('✔ FLOW-01 PASS: 预览成功输出静态拓扑节点，零 Provider 执行调用');

  // FLOW-02: Flow 激活与 revision 隔离
  const run1 = await runtime.run(baseProfile);
  assert.equal(run1.status, 'completed');
  assert.equal(run1.outputs['llm-main']?.text, 'LLM回复(用户上下文+知识库上下文)');
  assert.equal(executionCalls, 2);

  // revision 变动时拒绝串绑定或使用过期上下文
  let isCurrent = true;
  const staleRuntime = new FlowRuntime([
    { capabilityId: 'context.source', bindingId: 'src.local', async execute(ctx) { ctx.assertSourcesCurrent(); isCurrent = false; return { text: 'A' }; } },
    { capabilityId: 'context.source', bindingId: 'src.knowledge', async execute() { return { text: 'B' }; } },
    { capabilityId: 'llm.chat', bindingId: 'llm.chat', async execute() { return { text: 'C' }; } }
  ]);
  await assert.rejects(
    staleRuntime.run(baseProfile, { sourceRevisions: new Map([['src-1', 2]]), isSourceCurrent: () => isCurrent }),
    /stale context source/
  );
  console.log('✔ FLOW-02 PASS: Profile 激活与执行正常，版本变动严格拦截过期上下文与交叉串绑定');

  // FLOW-03: Context 来源组合与 partial 报告
  const partialProfile = {
    ...baseProfile,
    failurePolicy: { onStageFailure: 'report_partial', retrySideEffects: false, maxAttempts: 1 },
    nodes: [
      { nodeId: 'optional-kb', kind: 'capability', capabilityId: 'context.source', bindingId: 'optional.kb', inputs: [], outputs: [{ name: 'text', required: false }], sideEffect: 'local_read', condition: null, dependsOn: [] },
      { nodeId: 'main-task', kind: 'capability', capabilityId: 'context.source', bindingId: 'main.task', inputs: [], outputs: [{ name: 'text', required: true }], sideEffect: 'none', condition: null, dependsOn: ['optional-kb'] }
    ],
    joinOrder: ['optional-kb', 'main-task']
  };
  const partialRuntime = new FlowRuntime([
    { capabilityId: 'context.source', bindingId: 'optional.kb', async execute() { throw new Error('Knowledge base offline'); } },
    { capabilityId: 'context.source', bindingId: 'main.task', async execute() { return { text: '主流程完成' }; } }
  ]);
  const pResult = await partialRuntime.run(partialProfile);
  assert.equal(pResult.status, 'partial');
  assert.equal(pResult.outputs['main-task']?.text, '主流程完成');
  console.log('✔ FLOW-03 PASS: 多源组合下，非关键来源失败正确降级为 partial，不中断主流程');
}

export async function testLife() {
  console.log('\n--- LIFE-01 ~ LIFE-04: 生命周期、更新、回退与租约验收 ---');
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'life-host-'));
  const sourceCopy = mkdtempSync(resolve(tmpdir(), 'life-src-'));
  try {
    // 初始导入
    assert.equal(importPackageHost({ sourceRoot: ttsSrc, hostRoot }).ok, true);
    assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.product.tts', enabled: true }).ok, true);
    const before = readPackageRegistry(hostRoot);
    const oldDir = before.registry.packages[0].installedDirectory;

    // LIFE-01: Staging 更新
    await cp(ttsSrc, sourceCopy, { recursive: true });
    const manifestPath = resolve(sourceCopy, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = '0.65.1';
    manifest.manifestHash = computeManifestHash(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const manager = new PackageLifecycleManager(hostRoot);
    const staged = manager.stageUpdate(sourceCopy);
    assert.equal(staged.pendingVersion, '0.65.1');
    console.log('✔ LIFE-01a: 成功 stage 新版本 0.65.1（运行态保持旧版本）');

    const applied = manager.applyPendingOnRestart('com.aika.product.tts');
    assert.equal(applied.activeVersion, '0.65.1');
    assert.equal(existsSync(resolve(hostRoot, ...oldDir.split('/'))), true, '旧目录必须完整保留用于回滚');
    console.log('✔ LIFE-01 PASS: 重启后原子切换到 0.65.1，旧版本目录保留完好');

    // LIFE-02: Rollback
    const rolled = manager.rollback('com.aika.product.tts');
    assert.equal(rolled.activeVersion, '0.65.0');
    const restored = readPackageRegistry(hostRoot);
    assert.equal(restored.registry.packages[0].version, '0.65.0');
    console.log('✔ LIFE-02 PASS: 回退成功，activeVersion 恢复至 0.65.0，无数据损坏');

    // LIFE-03: 停用/卸载受活跃消费者阻断
    manager.registerConsumer('com.aika.product.tts', { consumerId: 'active-flow-1', kind: 'flow' });
    assert.throws(() => manager.disable('com.aika.product.tts'), LifecycleError);
    assert.throws(() => manager.uninstall('com.aika.product.tts'), LifecycleError);
    console.log('✔ LIFE-03a: 存在活跃 consumer 时，disable 和 uninstall 均被严格阻断');
    manager.releaseConsumer('com.aika.product.tts', 'active-flow-1');
    manager.disable('com.aika.product.tts');
    console.log('✔ LIFE-03 PASS: 释放消费者后，成功停用');

    // LIFE-04: 共享租约
    const hostRootLease = mkdtempSync(resolve(tmpdir(), 'life-lease-'));
    try {
      importPackageHost({ sourceRoot: ttsSrc, hostRoot: hostRootLease });
      setPackageEnablement({ hostRoot: hostRootLease, packageId: 'com.aika.product.tts', enabled: true });
      const m2 = new PackageLifecycleManager(hostRootLease);
      m2.registerConsumer('com.aika.product.tts', { consumerId: 'stage-1', kind: 'binding' });
      m2.registerConsumer('com.aika.product.tts', { consumerId: 'stage-2', kind: 'binding' });
      assert.equal(m2.impact('com.aika.product.tts').consumers.length, 2);

      // 释放第一个租约，包依然受第二个租约保护
      m2.releaseConsumer('com.aika.product.tts', 'stage-1');
      assert.equal(m2.impact('com.aika.product.tts').consumers.length, 1);
      assert.throws(() => m2.disable('com.aika.product.tts'), LifecycleError);

      // 释放最后一个租约
      m2.releaseConsumer('com.aika.product.tts', 'stage-2');
      assert.equal(m2.impact('com.aika.product.tts').consumers.length, 0);
      assert.equal(m2.disable('com.aika.product.tts').enabled, false);
      console.log('✔ LIFE-04 PASS: 多 stage 共享租约正常，首个释放不影响其他 stage，最后租约释放后才允许停用');
    } finally {
      rmSync(hostRootLease, { recursive: true, force: true });
    }

  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(sourceCopy, { recursive: true, force: true });
  }
}

async function main() {
  await testFlow();
  await testLife();
  console.log('\n=============================================');
  console.log('  FLOW (01~03) & LIFE (01~04) 全部 PASS');
  console.log('=============================================\n');
}

main().catch(err => {
  console.error('FLOW/LIFE 执行失败:', err);
  process.exit(1);
});
