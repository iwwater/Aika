/**
 * tests/next082/companion-mode-contracts.test.ts
 *
 * N082-00: 契约、策略与边界防护网测试。
 *
 * AC-08200-1: 模式策略校验，拒绝非法参数、非安全时间格式与错误 revision
 * AC-08200-2: 旧 keyboard 活动授权严禁获取正文或作为上下文授权
 * AC-08200-3: 持续感知授权 destination 必须为 local，目标与范围边界严格合法
 * AC-08200-4: 上下文使用授权 (ContextUseGrant) 与派生文本 (DerivedText) 校验闭环
 * AC-08200-5: 单帧 CaptureGrant 严禁伪造成持续感知或陪伴来源授权
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type CompanionModePolicy,
  type SourceGrant,
  type ContinuousPerceptionGrant,
  type ContextUseGrant,
  type DerivedText,
  CompanionContractError,
  validateCompanionModePolicy,
  validateSourceGrant,
  validateContinuousPerceptionGrant,
  validateContextUseGrant,
  validateDerivedText,
} from '../../contracts/companion-mode.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08200');

test('AC-08200-1: 模式策略校验，拒绝非法参数、非安全时间格式与错误 revision', () => {
  const validPolicy: CompanionModePolicy = {
    schemaVersion: 1,
    revision: 1,
    pairing,
    mode: 'passive',
    observationIntervalMs: 300_000,
    dailyLocalTime: '20:00',
    timezone: 'Asia/Shanghai',
    policyVersion: 1,
  };

  assert.doesNotThrow(() => validateCompanionModePolicy(validPolicy));

  // 1.1 非法模式
  assert.throws(
    // @ts-expect-error deliberate invalid mode
    () => validateCompanionModePolicy({ ...validPolicy, mode: 'unknown' }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'invalid_policy',
  );

  // 1.2 观察间隔过小 (< 1000ms)
  assert.throws(
    () => validateCompanionModePolicy({ ...validPolicy, observationIntervalMs: 500 }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'invalid_policy',
  );

  // 1.3 非法时间格式
  assert.throws(
    () => validateCompanionModePolicy({ ...validPolicy, dailyLocalTime: '8pm' }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'invalid_policy',
  );

  // 1.4 非法 revision
  assert.throws(
    () => validateCompanionModePolicy({ ...validPolicy, revision: 0 }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'invalid_policy',
  );
});

test('AC-08200-2: 旧 keyboard 活动授权严禁获取正文或作为上下文授权', () => {
  const validKbGrant: SourceGrant = {
    schemaVersion: 1,
    grantId: 'grant-kb-1',
    revision: 1,
    pairing,
    kind: 'keyboard',
    scope: {},
    purposes: ['receive'],
    destination: 'local',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    profile: 'normal',
    state: 'active',
  };

  assert.doesNotThrow(() => validateSourceGrant(validKbGrant));

  // 试图给旧 keyboard 增加 parse 目的（正文解析）
  assert.throws(
    () => validateSourceGrant({ ...validKbGrant, purposes: ['receive', 'parse'] }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'forbidden_grant_scope',
    '旧 keyboard 活动严禁承载 parse 目的',
  );

  // 试图给旧 keyboard 增加 context 目的（上下文生成）
  assert.throws(
    () => validateSourceGrant({ ...validKbGrant, purposes: ['receive', 'context'] }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'forbidden_grant_scope',
    '旧 keyboard 活动严禁承载 context 目的',
  );
});

test('AC-08200-3: 持续感知授权 destination 必须为 local，目标与范围边界严格合法', () => {
  const validContinuous: ContinuousPerceptionGrant = {
    schemaVersion: 1,
    grantId: 'grant-cont-1',
    revision: 1,
    pairing,
    targetId: 'screen-0',
    targetRevision: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    runtimeSessionId: 'sess-1',
    minPollIntervalMs: 5000,
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    destination: 'local',
    state: 'active',
  };

  assert.doesNotThrow(() => validateContinuousPerceptionGrant(validContinuous));

  // 试图伪造云端 destination
  assert.throws(
    // @ts-expect-error deliberate cloud destination test
    () => validateContinuousPerceptionGrant({ ...validContinuous, destination: 'cloud' }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'forbidden_destination',
    '持续感知授权目的地必须严格为 local',
  );

  // 缺少 targetId
  assert.throws(
    () => validateContinuousPerceptionGrant({ ...validContinuous, targetId: '' }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'target_required',
  );

  // 非法 bounds (宽高非正数)
  assert.throws(
    () => validateContinuousPerceptionGrant({ ...validContinuous, bounds: { x: 0, y: 0, width: 0, height: 1080 } }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'invalid_bounds',
  );
});

test('AC-08200-4: 上下文使用授权 (ContextUseGrant) 与派生文本 (DerivedText) 校验闭环', () => {
  const validContextGrant: ContextUseGrant = {
    schemaVersion: 1,
    grantId: 'grant-ctx-1',
    revision: 1,
    pairing,
    observationSourceScopes: ['screen-0'],
    modelBinding: 'qwen-local',
    destination: 'local',
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    state: 'active',
  };

  assert.doesNotThrow(() => validateContextUseGrant(validContextGrant));

  // 缺少 modelBinding
  assert.throws(
    () => validateContextUseGrant({ ...validContextGrant, modelBinding: '' }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'binding_required',
  );

  // 范围为空
  assert.throws(
    () => validateContextUseGrant({ ...validContextGrant, observationSourceScopes: [] }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'scopes_required',
  );

  const validDerived: DerivedText = {
    id: 'dt-1',
    revision: 1,
    parentRefs: [{ sourceId: 'src-1', version: 'v1' }],
    processorId: 'local-ocr-v1',
    processorVersion: '1.0.0',
    grantRevision: 1,
    processingKey: 'key-1',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: 'ok',
    textRef: 'text/dt-1.txt',
    warnings: [],
  };

  assert.doesNotThrow(() => validateDerivedText(validDerived));

  // 孤儿派生文本（无 parentRefs）
  assert.throws(
    () => validateDerivedText({ ...validDerived, parentRefs: [] }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'orphan_derived_text',
  );

  // 缺少 processingKey
  assert.throws(
    () => validateDerivedText({ ...validDerived, processingKey: '' }),
    (err: unknown) => err instanceof CompanionContractError && err.code === 'processing_key_required',
  );
});
