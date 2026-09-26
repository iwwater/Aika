/**
 * tests/next082/companion-mode-grants.test.ts
 *
 * N082-01: 模式运行时、来源授权状态机、会话生命周期与租约管理测试。
 *
 * AC-08201-1: 独立来源启停，单来源停止不影响其他租约与新数据；resume 真正重启且建立 lease
 * AC-08201-2: 模式切换、锁屏与挂起触发 generation 变更；旧代次回调失效
 * AC-08201-3: 重启保持暂停，控制请求按 operationId 幂等且防止冲突篡改
 * AC-08201-4: 撤销后允许重新授权，旧代次不可用
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { CompanionModeRuntime, CompanionModeError } from '../../core/companion-mode-runtime.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08201');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'aika-08201-'));
  const clock = new FakeClock(Date.parse('2026-09-26T10:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: clock.now,
  });
  const db = memory.rawDatabaseForKnowledge();
  const activeLeases = new Set<string>();

  const runtime = new CompanionModeRuntime({
    db,
    pairing,
    now: clock.now,
    onSourceSync: async (kind, active) => {
      if (active) activeLeases.add(kind);
      else activeLeases.delete(kind);
    },
  });

  return { root, clock, memory, db, runtime, activeLeases };
}

test('AC-08201-1: 独立来源启停，单来源停止不影响其他租约与新数据；resume 真正重启且建立 lease', async () => {
  const h = harness();
  try {
    // 初始状态：默认 passive 且 paused，无租约
    const initStatus = h.runtime.getStatus();
    assert.equal(initStatus.policy.mode, 'passive');
    assert.equal(initStatus.runState, 'paused');
    assert.equal(h.activeLeases.size, 0);

    // 激活 keyboard 与 clipboard_text 两个独立来源
    const exp = new Date(h.clock.at() + 3600_000).toISOString();
    const kb = await h.runtime.activateSource({
      kind: 'keyboard', expiresAt: exp, expectedRevision: 0,
      operationId: 'op-act-kb', userConfirmed: true,
    });
    const clipText = await h.runtime.activateSource({
      kind: 'clipboard_text', expiresAt: exp, expectedRevision: 0,
      operationId: 'op-act-clip', userConfirmed: true,
    });

    assert.equal(kb.state, 'active');
    assert.equal(clipText.state, 'active');

    // 调用 resume 启动运行：必须建立实际 lease
    await h.runtime.resume('op-resume-1');
    assert.equal(h.runtime.currentRunState, 'running');
    assert.equal(h.activeLeases.has('keyboard'), true);
    assert.equal(h.activeLeases.has('clipboard_text'), true);

    // P1-1 关键验收：停止 keyboard 来源，必须仅停止 keyboard，clipboard_text 租约保持存活！
    await h.runtime.transitionSource({
      kind: 'keyboard', action: 'stop', expectedRevision: kb.revision, operationId: 'op-stop-kb',
    });

    assert.equal(h.activeLeases.has('keyboard'), false, 'keyboard 租约必须已释放');
    assert.equal(h.activeLeases.has('clipboard_text'), true, 'clipboard_text 租约必须继续保持运行！');

    // 重新开启 keyboard（resume 状态）
    const kbResumed = await h.runtime.transitionSource({
      kind: 'keyboard', action: 'resume', expectedRevision: kb.revision + 1, operationId: 'op-res-kb',
    });
    assert.equal(kbResumed.state, 'active');
    assert.equal(h.activeLeases.has('keyboard'), true, '重新激活后 lease 必须恢复');
  } finally {
    h.memory.close();
  }
});

test('AC-08201-2: 模式切换、锁屏与挂起触发 generation 变更；旧代次回调失效', async () => {
  const h = harness();
  try {
    await h.runtime.resume('op-res');
    const gen1 = h.runtime.currentGeneration;

    // 1. 系统锁屏事件触发：runState 变为 paused，释放所有租约，generation 递增
    await h.runtime.onSessionLock();
    assert.equal(h.runtime.currentRunState, 'paused');
    assert.ok(h.runtime.currentGeneration > gen1);
    assert.equal(h.activeLeases.size, 0);

    // 2. 切模式测试：从 passive 切换到 active，再切回 passive
    const policy1 = h.runtime.getPolicy();
    await h.runtime.setPolicy({
      ...policy1,
      mode: 'active',
      expectedRevision: policy1.revision,
      operationId: 'op-mode-active',
    });
    assert.equal(h.runtime.getPolicy().mode, 'active');

    const gen2 = h.runtime.currentGeneration;
    const policy2 = h.runtime.getPolicy();
    // active -> passive 必须触发 generation 变更以取消未完成的主动屏幕观察
    await h.runtime.setPolicy({
      ...policy2,
      mode: 'passive',
      expectedRevision: policy2.revision,
      operationId: 'op-mode-passive',
    });
    assert.equal(h.runtime.getPolicy().mode, 'passive');
    assert.ok(h.runtime.currentGeneration > gen2);
  } finally {
    h.memory.close();
  }
});

test('AC-08201-3: 重启保持暂停，控制请求按 operationId 幂等且防止冲突篡改', async () => {
  const h = harness();
  try {
    const exp = new Date(h.clock.at() + 3600_000).toISOString();
    const grant = await h.runtime.activateSource({
      kind: 'download_directory', scope: { canonicalRoot: 'D:/Downloads' },
      expiresAt: exp, expectedRevision: 0, operationId: 'op-dl', userConfirmed: true,
    });

    // 1. 同一 operationId 相同请求体重放：返回原结果
    const replay = await h.runtime.activateSource({
      kind: 'download_directory', scope: { canonicalRoot: 'D:/Downloads' },
      expiresAt: exp, expectedRevision: 0, operationId: 'op-dl', userConfirmed: true,
    });
    assert.deepEqual(replay, grant);

    // 2. 同一 operationId 不同请求体（冲突篡改）：必须抛出 invalid_request 拒绝
    await assert.rejects(
      async () => h.runtime.activateSource({
        kind: 'download_directory', scope: { canonicalRoot: 'C:/Tampered' },
        expiresAt: exp, expectedRevision: 0, operationId: 'op-dl', userConfirmed: true,
      }),
      (err: unknown) => err instanceof CompanionModeError && err.code === 'invalid_request',
    );

    // 3. 模拟重启：重新实例化 Runtime，验证持久化数据
    const runtime2 = new CompanionModeRuntime({
      db: h.db,
      pairing,
      now: h.clock.now,
    });

    // 必须保持初始 paused 状态，旧 running 不得自启
    assert.equal(runtime2.currentRunState, 'paused');
    const dlGrantAfter = runtime2.getGrant('download_directory');
    assert.ok(dlGrantAfter);
    assert.equal(dlGrantAfter.state, 'active');
    assert.equal(dlGrantAfter.scope.canonicalRoot, 'D:/Downloads');
  } finally {
    h.memory.close();
  }
});

test('AC-08201-4: 撤销后允许重新授权，旧代次不可用', async () => {
  const h = harness();
  try {
    const exp = new Date(h.clock.at() + 3600_000).toISOString();
    const grant = await h.runtime.activateSource({
      kind: 'screenshot_directory', scope: { canonicalRoot: 'D:/Screenshots' },
      expiresAt: exp, expectedRevision: 0, operationId: 'op-shot-1', userConfirmed: true,
    });

    // 撤销该来源
    const revoked = await h.runtime.transitionSource({
      kind: 'screenshot_directory', action: 'revoke', expectedRevision: grant.revision, operationId: 'op-rev-shot',
    });
    assert.equal(revoked.state, 'revoked');

    // P1-4 关键验收：已撤销的来源必须允许再次调用 activateSource 重新启用！
    const reissued = await h.runtime.activateSource({
      kind: 'screenshot_directory', scope: { canonicalRoot: 'D:/NewScreenshots' },
      expiresAt: exp, expectedRevision: revoked.revision, operationId: 'op-reactivate-shot', userConfirmed: true,
    });

    assert.equal(reissued.state, 'active');
    assert.equal(reissued.revision, revoked.revision + 1);
    assert.equal(reissued.scope.canonicalRoot, 'D:/NewScreenshots');
  } finally {
    h.memory.close();
  }
});
