import test from 'node:test';
import assert from 'node:assert/strict';
import { characterPrompt, DEFAULT_CHARACTER_PROMPTS } from '../../companion/prompts.js';
import { COMPANION_INTRODUCTION } from '../../companion/introduction.js';

test('A09: only a close companion persona, without a predefined romance or invented childhood evidence', () => {
  assert.deepEqual(Object.keys(DEFAULT_CHARACTER_PROMPTS), ['companion']);
  const prompt = characterPrompt('companion', DEFAULT_CHARACTER_PROMPTS);
  for (const rule of ['青梅竹马', '不预设恋爱关系', '不编造具体共同童年', '不在日常回复中重演', '不是现实往事的证据', '不需要逐条审批', '没有已完成的写入结果']) assert.ok(prompt.includes(rule), rule);
  assert.ok(!prompt.includes(COMPANION_INTRODUCTION.text));
  assert.equal(characterPrompt('companion', {companion:'可编辑的新Prompt'}), '可编辑的新Prompt');
  for (const id of ['friend','sweetheart','other','companion_2','COMPANION','']) assert.throws(() => characterPrompt(id, DEFAULT_CHARACTER_PROMPTS), /unknown_character/);
});
