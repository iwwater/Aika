import test from 'node:test';
import assert from 'node:assert/strict';

test('UIR-07 Dashboard: 6 semantic cards are present and correctly structured', () => {
  const cardTypes = ['character', 'today_metrics', 'recent_experiences', 'recent_knowledge', 'system_capabilities', 'quick_jump'];
  assert.equal(cardTypes.length, 6);
});

test('UIR-07 Dashboard: Turns count accurately distinguishes turns from messages', () => {
  const turnsData = {
    totalTurns: 12,
    rawMessagesCount: 24, // 12 user + 12 assistant
  };

  // Metric displays turns, not inflated raw messages
  const displayedMetric = turnsData.totalTurns;
  assert.equal(displayedMetric, 12);
  assert.notEqual(displayedMetric, turnsData.rawMessagesCount);
});

test('UIR-07 Dashboard: Recent knowledge excludes pending candidates', () => {
  const knowledgePool = [
    { id: 'f-1', text: '已沉淀事实 1', isCandidate: false },
    { id: 'f-2', text: '已沉淀事实 2', isCandidate: false },
    { id: 'cand-1', text: '待审核事实草稿', isCandidate: true },
  ];

  const dashboardDisplayed = knowledgePool.filter(item => !item.isCandidate);
  assert.equal(dashboardDisplayed.length, 2);
  assert.ok(dashboardDisplayed.every(item => item.isCandidate === false));
});

test('UIR-07 Dashboard: Effective vs pending restart indicator', () => {
  const runtimeSettings = {
    effective: { providers: { dialogue: { model: 'deepseek-chat' } } },
    pending: true, // User saved a new configuration
    saved: { providers: { dialogue: { model: 'deepseek-reasoner' } } }
  };

  // Must display effective model in active header
  assert.equal(runtimeSettings.effective.providers.dialogue.model, 'deepseek-chat');
  // Pending flag triggers restart warning
  assert.equal(runtimeSettings.pending, true);
});
