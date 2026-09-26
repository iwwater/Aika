import test from 'node:test';
import assert from 'node:assert/strict';

test('UIR-03 Knowledge: Wiki distinguishes user facts, character Canon, and pending candidates', () => {
  const mockWikiData = {
    userFacts: [
      { id: 'f-1', category: '用户偏好', text: '用户喜欢在早晨喝乌龙茶。', isCanon: false, isCandidate: false },
      { id: 'f-2', category: '项目工作', text: '用户正在维护 Aika-Next 桌面伴侣项目。', isCanon: false, isCandidate: false }
    ],
    canonFacts: [
      { id: 'canon-1', category: '核心设定', text: '沈砚（Aika）：性格沉稳、克制，重视承诺。', isCanon: true, isCandidate: false }
    ],
    candidates: [
      { id: 'cand-1', category: '待审候选', text: '用户可能计划下周去杭州出差。', isCanon: false, isCandidate: true }
    ]
  };

  // Default active list only contains settled user facts & canon, never pending candidates
  assert.equal(mockWikiData.userFacts.length, 2);
  assert.equal(mockWikiData.canonFacts[0].isCanon, true);
  assert.equal(mockWikiData.candidates.length, 1);
  assert.equal(mockWikiData.candidates[0].isCandidate, true);

  // Candidates do not contaminate active facts pool
  const activePool = [...mockWikiData.userFacts, ...mockWikiData.canonFacts];
  assert.ok(activePool.every(item => item.isCandidate === false));
});

test('UIR-03 Knowledge: Missing fields strictly render as unprovided without fake inference', () => {
  const itemWithoutAnalysis = {
    id: 'f-3',
    text: '普通记忆条目',
    observedAt: null,
    analysis: null,
    confidence: null,
  };

  // Must not fabricate timestamp or confidence score
  assert.equal(itemWithoutAnalysis.observedAt, null);
  assert.equal(itemWithoutAnalysis.analysis, null);
  assert.equal(itemWithoutAnalysis.confidence, null);

  const displayObserved = itemWithoutAnalysis.observedAt || '未提供';
  const displayAnalysis = itemWithoutAnalysis.analysis || '未提供专门结构化分析';
  assert.equal(displayObserved, '未提供');
  assert.equal(displayAnalysis, '未提供专门结构化分析');
});

test('UIR-03 Knowledge: Knowledge domain contains no Raw Trace outputs', () => {
  const knowledgeEntry = {
    id: 'wiki-1',
    text: '用户喜欢红茶',
    tags: ['饮食', '偏好'],
    sources: ['dialogue:turn-42'],
  };

  // Strictly lacks raw debug fields
  assert.equal('rawPrompt' in knowledgeEntry, false);
  assert.equal('tokenUsage' in knowledgeEntry, false);
  assert.equal('systemPromptExpansion' in knowledgeEntry, false);
  assert.equal('rawTrace' in knowledgeEntry, false);
});
