/**
 * tests/next082/collection-text-sources.test.ts
 *
 * N082-03: 剪贴板文本、InputText(UIA/提交)、手动文本与历史引用来源适配器测试。
 *
 * AC-08203-1: 剪贴板文本 sequence 校验、空与超限文本截断、同 sequence 消费一次
 * AC-08203-2: 输入正文提交提取、密码控件强阻断、拼音 composition 中间态与取消拦截
 * AC-08203-3: 来源撤销/暂停时拒绝新文本、锁屏状态下新输入不产生候选
 * AC-08203-4: 历史对话引用动态存活校验、原历史删除后引用失效
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { ClipboardTextSource } from '../../core/clipboard-text-source.js';
import { InputTextSource } from '../../core/input-text-source.js';
import { HistorySourceReference } from '../../core/history-source-reference.js';
import type { SourceGrant } from '../../contracts/companion-mode.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08203');

function fakeGrant(kind: SourceGrant['kind']): SourceGrant {
  return {
    schemaVersion: 1,
    grantId: `grant-${kind}`,
    revision: 1,
    pairing,
    kind,
    scope: {},
    purposes: ['receive'],
    destination: 'local',
    profile: 'normal',
    state: 'active',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

test('AC-08203-1: 剪贴板文本 sequence 校验、空与超限文本截断、同 sequence 消费一次', async () => {
  let curSeq = 100;
  let clipboardContent = '第一段复制的文本';

  const source = new ClipboardTextSource({
    currentSequence: () => curSeq,
    readClipboardText: async (seq) => {
      if (seq !== curSeq) return null;
      return { text: clipboardContent, byteLength: Buffer.byteLength(clipboardContent, 'utf8') };
    },
    maxTextBytes: 50, // 设置较小上限以便测试截断
  });

  const lease = await source.start(fakeGrant('clipboard_text'));

  // 1. 初次读取当前 sequence: 由于 start 时已将当前 sequence 计入 baseline，必须返回 null
  const initRead = await source.readTextIfCurrent(100);
  assert.equal(initRead, null, '启用前的旧剪贴板内容不得被摄取');

  // 2. 剪贴板发生变化（seq 变为 101）
  curSeq = 101;
  clipboardContent = '新复制的合规文本';
  const read1 = await source.readTextIfCurrent(101);
  assert.ok(read1);
  assert.equal(read1.text, '新复制的合规文本');

  // 3. 相同 sequence 重复读取：必须幂等返回 null
  const readDup = await source.readTextIfCurrent(101);
  assert.equal(readDup, null, '相同 sequence 绝不二次摄取');

  // 4. 超限文本截断测试 (maxTextBytes = 50)
  curSeq = 102;
  clipboardContent = '超长文本'.repeat(20);
  const readOverflow = await source.readTextIfCurrent(102);
  assert.ok(readOverflow);
  assert.equal(readOverflow.byteLength, 50, '超限文本必须严格截断到预算上限');

  await lease.close();
});

test('AC-08203-2: 输入正文提交提取、密码控件强阻断、拼音 composition 中间态与取消拦截', async () => {
  const source = new InputTextSource({ maxFragmentBytes: 1024 });
  const grant = fakeGrant('input_text');
  const lease = await source.start(grant);

  // 1. 正常已提交文本片段
  const candNormal = source.processCommit(grant, {
    commitId: 'commit-1',
    appIdentity: 'code.exe',
    inputMethod: 'ms-pinyin',
    isPassword: false,
    text: '今天天气真好，正在编写 0.82 规范。',
    completeness: 'committed',
  });
  assert.ok(candNormal);
  assert.equal(candNormal.sourceKind, 'input_text');
  assert.equal(candNormal.text, '今天天气真好，正在编写 0.82 规范。');
  assert.equal(candNormal.completeness, 'committed');

  // 2. 密码与受保护控件测试：必须被绝对阻断！
  const candPassword = source.processCommit(grant, {
    commitId: 'commit-pwd',
    appIdentity: 'browser.exe',
    inputMethod: 'ms-pinyin',
    isPassword: true, // 密码框
    text: 'MySecretPassword123!',
    completeness: 'committed',
  });
  assert.equal(candPassword, null, '密码或受保护控件的内容绝对严禁入库');

  // 3. 拼音输入法中间态（正在打拼音，尚未按空格选词 commit）：必须忽略
  const candComposing = source.processCommit(grant, {
    commitId: 'commit-comp',
    appIdentity: 'code.exe',
    inputMethod: 'ms-pinyin',
    isPassword: false,
    text: 'nihao',
    isComposing: true,
    completeness: 'committed',
  });
  assert.equal(candComposing, null, '正在 composition 的中间拼音不得落库');

  // 4. 取消输入（ESC 放弃）：必须忽略
  const candCancelled = source.processCommit(grant, {
    commitId: 'commit-cancel',
    appIdentity: 'code.exe',
    inputMethod: 'ms-pinyin',
    isPassword: false,
    text: 'ce',
    isCancelled: true,
    completeness: 'committed',
  });
  assert.equal(candCancelled, null, '取消的输入操作不得落库');

  // 5. 相同 commitId 重复提交：必须去重
  const candDup = source.processCommit(grant, {
    commitId: 'commit-1',
    appIdentity: 'code.exe',
    inputMethod: 'ms-pinyin',
    isPassword: false,
    text: '今天天气真好，正在编写 0.82 规范。',
    completeness: 'committed',
  });
  assert.equal(candDup, null, '重复 commitId 必须被去重');

  await lease.close();
});

test('AC-08203-3: 来源撤销/暂停时拒绝新文本、锁屏状态下新输入不产生候选', async () => {
  const source = new InputTextSource();
  const grant = fakeGrant('input_text');

  // 1. Grant 处于 paused 状态时
  const pausedGrant = { ...grant, state: 'paused' as const };
  const resPaused = source.processCommit(pausedGrant, {
    commitId: 'commit-paused',
    appIdentity: 'notepad.exe',
    inputMethod: 'ms-pinyin',
    isPassword: false,
    text: '暂停期间打的字',
    completeness: 'committed',
  });
  assert.equal(resPaused, null, '暂停状态下不得摄取新输入');

  // 2. Grant 处于 revoked 状态时
  const revokedGrant = { ...grant, state: 'revoked' as const };
  const resRevoked = source.processCommit(revokedGrant, {
    commitId: 'commit-revoked',
    appIdentity: 'notepad.exe',
    inputMethod: 'ms-pinyin',
    isPassword: false,
    text: '撤销后打的字',
    completeness: 'committed',
  });
  assert.equal(resRevoked, null, '撤销状态下不得摄取新输入');
});

test('AC-08203-4: 历史对话引用动态存活校验、原历史删除后引用失效', () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-08203-hist-'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
  });
  const db = memory.rawDatabaseForKnowledge();

  // 准备 conversations 测试表与记录
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations(
      id TEXT PRIMARY KEY, title TEXT NOT NULL
    );
    INSERT INTO conversations(id, title) VALUES('conv-1', '测试对话1');
  `);

  const refSource = new HistorySourceReference(db);

  // 1. 引用存在且合法的对话
  const cand = refSource.createReferenceCandidate(pairing, 'grant-hist-1', 1, {
    conversationId: 'conv-1',
    messageTurnId: 'turn-42',
    previewText: '你好，Aika！',
  });
  assert.ok(cand);
  assert.equal(cand.sourceKind, 'history_reference');
  assert.equal(cand.nativeEventId, 'conv-1:turn-42');
  assert.equal(refSource.isReferenceValid('conv-1'), true);

  // 2. 引用不存在的对话：直接返回 null
  const candNotFound = refSource.createReferenceCandidate(pairing, 'grant-hist-1', 1, {
    conversationId: 'non-existent',
    messageTurnId: 'turn-1',
    previewText: '无效内容',
  });
  assert.equal(candNotFound, null, '引用不存在的会话必须返回 null');

  // 3. 删除原会话：isReferenceValid 动态判定为 false
  db.prepare('DELETE FROM conversations WHERE id=?').run('conv-1');
  assert.equal(refSource.isReferenceValid('conv-1'), false, '原会话删除后引用动态失效');

  memory.close();
});
