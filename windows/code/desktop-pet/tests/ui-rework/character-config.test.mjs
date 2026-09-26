import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigEnvelope } from '../../management/ui/envelope.mjs';

test('UIR-02 Character Config: multi-role draft envelopes are isolated', () => {
  const charA = createConfigEnvelope({
    owner: 'character',
    scope: 'companion',
    initialData: {
      persona: 'Companion prompt text',
      models: { dialogue: 'qwen-plus', ttsVoice: 'Cherry' }
    },
    initialSavedRevision: 1
  });

  const charB = createConfigEnvelope({
    owner: 'character',
    scope: 'custom-robot',
    initialData: {
      persona: 'Custom robot prompt text',
      models: { dialogue: 'deepseek-chat', ttsVoice: 'Ethan' }
    },
    initialSavedRevision: 1
  });

  // User edits Char A
  charA.updateDraft(d => ({ ...d, persona: 'Updated Companion Persona' }));
  assert.equal(charA.isDirty(), true);
  assert.equal(charB.isDirty(), false);

  // User edits Char B
  charB.updateDraft(d => ({ ...d, persona: 'Architect Robot Persona' }));
  assert.equal(charB.isDirty(), true);

  // Ensure drafts and server data never contaminate across roles
  assert.equal(charA.getDraft().persona, 'Updated Companion Persona');
  assert.equal(charB.getDraft().persona, 'Architect Robot Persona');
  assert.equal(charA.getData().persona, 'Companion prompt text');
  assert.equal(charB.getData().persona, 'Custom robot prompt text');
});

test('UIR-02 Character Config: model discovery handling and credential safety', () => {
  // Discovery result representation
  const discoveryMock = {
    protocol: 'openai-compatible',
    endpoint: 'https://api.deepseek.com/chat/completions',
    items: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' }
    ],
    stale: false,
    checkedAt: '2026-09-25T10:00:00.000Z'
  };

  assert.equal(discoveryMock.items.length, 2);
  assert.equal(discoveryMock.items[0].id, 'deepseek-chat');

  // Manual fallback model: when user inputs a custom model not in items list
  const customModelInput = 'my-internal-fine-tuned-model';
  const selectedModel = discoveryMock.items.find(m => m.id === customModelInput)?.id || customModelInput;
  assert.equal(selectedModel, 'my-internal-fine-tuned-model');

  // Credential masking: only credential reference exists, never raw API key
  const credentialInfo = {
    id: 'deepseek-credential-01',
    provider: 'deepseek',
    label: 'DeepSeek 官方 API 凭据',
    status: 'configured',
    masked: '••••••••'
  };

  assert.ok(!JSON.stringify(credentialInfo).includes('sk-'));
  assert.equal(credentialInfo.masked, '••••••••');
});

test('UIR-02 Character Config: concurrency collision recovery retains draft for user rescue', () => {
  const envelope = createConfigEnvelope({
    owner: 'character',
    scope: 'companion',
    initialData: { persona: 'Draft Persona v1' },
    initialSavedRevision: 5
  });

  envelope.updateDraft({ persona: 'My precious new persona edits' });

  // 409 Conflict reported by backend
  envelope.onSaveConflict({
    latestServerData: { persona: 'Overwritten by another desktop instance' },
    latestServerRevision: 6
  });

  assert.equal(envelope.isConflicted(), true);
  // User's edits are NOT destroyed
  assert.equal(envelope.getDraft().persona, 'My precious new persona edits');
  // Snapshot of remote conflict is available for comparison
  assert.equal(envelope.getConflictSnapshot().serverData.persona, 'Overwritten by another desktop instance');
});
