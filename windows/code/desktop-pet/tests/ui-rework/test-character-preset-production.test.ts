import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { CharacterPresetStore } from '../../management/character-preset-store.js';
import { join } from 'node:path';
import type { ManagementMemoryPort } from '../../contracts/management.js';

test('UIR-02 Character Preset: unified aggregate, persistence, dual-role isolation, revision tracking', async t => {
  const f = await fixture(t);
  const settingsFile = join(f.c.projectRoot, 'management-settings.json');
  const presetsFile = join(f.c.projectRoot, 'character-presets.json');
  const settings = await ManagementSettingsStore.open(settingsFile, f.c);

  let companionPrompt = '默认青梅竹马伴侣设定。';
  let companionPromptRev = 1;

  const mockMemory: any = {
    characters: () => [{ id: 'companion', label: '青梅竹马', revision: 1 }],
    prompt(characterId: string) {
      return {
        characterId,
        revision: companionPromptRev,
        text: companionPrompt,
      };
    },
    savePrompt(input: any) {
      if (input.characterId === 'companion') {
        companionPrompt = input.text;
        companionPromptRev++;
      }
      return {
        characterId: input.characterId,
        revision: companionPromptRev,
        text: input.text,
      };
    },
    list: async () => ({ total: 0, offset: 0, limit: 10, records: [] }),
    edit: async () => ({ record: {} as any }),
    context: async () => ({ scope: {} as any, prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
    maintenanceInput: async () => ({ operationId: 'op-1', characterId: 'companion', status: 'ready', queued: 0, running: 0, activeJobs: 0 }),
    forget: async () => ({ forgotten: true, id: 'id-1' }),
  };

  let activeSkin = 'default-skin';
  const mockSkins: any = {
    state: () => ({ revision: 1, activeSkinId: activeSkin, catalog: [], automaticPresets: 0 }),
    active: () => ({ id: activeSkin, label: 'Default', entry: 'pet.model3.json' }),
    activate: async (expectedRevision: number, skinId: string) => {
      activeSkin = skinId;
      return { revision: expectedRevision + 1, activeSkinId: skinId, catalog: [], automaticPresets: 0 };
    },
  };

  const store = await CharacterPresetStore.open({
    filePath: presetsFile,
    memory: mockMemory,
    settings,
    skins: mockSkins as any,
    base: f.c,
  });

  // 1. Companion Default Preset
  const companionPreset = await store.getPreset('companion');
  assert.equal(companionPreset.characterId, 'companion');
  assert.equal(companionPreset.presetId, 'companion-default');
  assert.equal(companionPreset.revision, 1);
  assert.equal(companionPreset.savedRevision, 1);
  assert.equal(companionPreset.effectiveRevision, 1);
  assert.equal(companionPreset.appearance.resourceId, 'default-skin');
  assert.equal(companionPreset.persona.text, '默认青梅竹马伴侣设定。');
  assert.ok(companionPreset.bindings.dialogue.model);
  assert.ok(companionPreset.bindings.tts?.voice);
  // Ensure no plaintext keys
  assert.ok(!companionPreset.bindings.dialogue.credentialRef.includes('sk-'));

  // 2. Dual-Role Isolation: Role B (custom-assistant)
  const roleBPreset = await store.getPreset('assistant-b');
  assert.equal(roleBPreset.characterId, 'assistant-b');
  assert.equal(roleBPreset.presetId, 'assistant-b-preset');
  assert.notEqual(roleBPreset.persona.text, companionPreset.persona.text);

  // 3. Save Companion Preset update
  const updatedCompanion = await store.savePreset({
    characterId: 'companion',
    expectedRevision: 1,
    appearance: {
      type: 'live2d',
      resourceId: 'summer-dress-v2',
      label: '夏日连衣裙',
    },
    persona: {
      text: '更新后的活泼青梅竹马。',
    },
    bindings: {
      dialogue: {
        model: 'deepseek-reasoner',
        temperature: 0.3,
      },
      tts: {
        voice: 'CustomSweetVoice',
      },
    },
  });

  assert.equal(updatedCompanion.revision, 2);
  assert.equal(updatedCompanion.savedRevision, 2);
  assert.equal(updatedCompanion.effectiveRevision, 1, 'Effective revision remains 1 until next restart');
  assert.equal(updatedCompanion.appearance.resourceId, 'summer-dress-v2');
  assert.equal(updatedCompanion.persona.text, '更新后的活泼青梅竹马。');
  assert.equal(updatedCompanion.bindings.dialogue.model, 'deepseek-reasoner');
  assert.equal(updatedCompanion.bindings.tts?.voice, 'CustomSweetVoice');

  // Verify memory and skin store side effects were dispatched
  assert.equal(companionPrompt, '更新后的活泼青梅竹马。');
  assert.equal(activeSkin, 'summer-dress-v2');

  // 4. Verify Role B was completely untouched by Companion save
  const roleBAfter = await store.getPreset('assistant-b');
  assert.equal(roleBAfter.revision, 1);
  assert.equal(roleBAfter.persona.text, '这是角色 assistant-b 的独立设定。');

  // 5. Stale expectedRevision throws version_conflict
  await assert.rejects(async () => {
    await store.savePreset({
      characterId: 'companion',
      expectedRevision: 1, // Current is 2!
      persona: { text: 'Stale update' },
    });
  }, { name: 'ManagementError' });

  // 6. Persistence across reopen
  const reopenedStore = await CharacterPresetStore.open({
    filePath: presetsFile,
    memory: mockMemory,
    settings,
    skins: mockSkins as any,
    base: f.c,
  });

  const persistedCompanion = await reopenedStore.getPreset('companion');
  assert.equal(persistedCompanion.revision, 2);
  assert.equal(persistedCompanion.appearance.resourceId, 'summer-dress-v2');
  assert.equal(persistedCompanion.persona.text, '更新后的活泼青梅竹马。');
});
