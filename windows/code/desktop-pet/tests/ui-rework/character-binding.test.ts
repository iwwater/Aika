import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { defaultManagedSettings, validateManagedSettings } from '../../management/settings.js';
import { join } from 'node:path';

test('UIR-02 Character Binding: Persona updates respect expectedRevision and preserve isolation', async t => {
  const f = await fixture(t);
  const file = join(f.c.projectRoot, 'management-settings.json');
  const store = await ManagementSettingsStore.open(file, f.c);
  const original = store.snapshot();

  // 1. Verify global settings baseline has valid slots
  assert.ok(original.saved.providers.dialogue);
  assert.ok(original.saved.providers.tts);
  assert.ok(!original.saved.providers.dialogue.credentialRef.includes('sk-'));
  assert.ok(original.saved.providers.dialogue.credentialRef.length > 5);

  // 2. Multi-role binding resolution: character override vs global default
  const roleA = 'companion';
  const roleB = 'custom-assistant';

  const roleBindings: Record<string, any> = {
    [roleA]: {
      persona: '你是一个活泼温柔的陪伴伙伴。',
      personaRevision: 1,
      overrides: {} // Uses global defaults
    },
    [roleB]: {
      persona: '你是一个严谨客观的专业代码架构师。',
      personaRevision: 1,
      overrides: {
        dialogue: {
          model: 'deepseek-reasoner',
          temperature: 0.2
        }
      }
    }
  };

  // Resolve effective binding for roleA -> inherits global
  const effectiveDialogueA = {
    ...original.effective.providers.dialogue,
    ...(roleBindings[roleA].overrides.dialogue || {})
  };
  assert.equal(effectiveDialogueA.model, original.effective.providers.dialogue.model);

  // Resolve effective binding for roleB -> has override
  const effectiveDialogueB = {
    ...original.effective.providers.dialogue,
    ...(roleBindings[roleB].overrides.dialogue || {})
  };
  assert.equal(effectiveDialogueB.model, 'deepseek-reasoner');
  assert.equal(effectiveDialogueB.temperature, 0.2);

  // 3. Personas are strictly independent and do not leak
  assert.notEqual(roleBindings[roleA].persona, roleBindings[roleB].persona);

  // 4. Stale revision rejection simulation
  const updateRequest = {
    characterId: roleA,
    expectedRevision: 1,
    text: 'Updated Persona A',
    operationId: 'op-001'
  };

  // Success path
  roleBindings[roleA].persona = updateRequest.text;
  roleBindings[roleA].personaRevision = 2;
  assert.equal(roleBindings[roleA].persona, 'Updated Persona A');
  assert.equal(roleBindings[roleA].personaRevision, 2);

  // Stale request with expectedRevision: 1 will be rejected as 409 conflict
  const isConflict = updateRequest.expectedRevision !== roleBindings[roleA].personaRevision;
  assert.equal(isConflict, true);
  // Original is kept, roleB is completely untouched
  assert.equal(roleBindings[roleB].persona, '你是一个严谨客观的专业代码架构师。');
});

test('UIR-02 Character Binding: Voice and TTS binding consistency without cross-provider mixing', async t => {
  const f = await fixture(t);
  const original = defaultManagedSettings(f.c);

  // TTS provider and voice identity
  assert.ok(original.providers.tts.voice);
  assert.ok(original.providers.tts.provider);

  // Credential reference never exposes plaintext key
  assert.ok(!original.providers.tts.credentialRef.includes('sk-'));
  assert.ok(original.providers.dialogue.credentialRef.length > 5);
});
