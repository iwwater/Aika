import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ManagementError,
  type CharacterPreset,
  type CharacterPresetSaveInput,
  type ManagementMemoryPort,
} from '../contracts/management.js';
import type { ManagementSettingsStore } from './settings-store.js';
import type { SkinManagement } from '../contracts/skin.js';
import type { TrialConfiguration } from '../app/trial-config.js';

export interface CharacterPresetStoreOptions {
  filePath?: string | undefined;
  memory: ManagementMemoryPort;
  settings: ManagementSettingsStore;
  skins?: SkinManagement | undefined;
  base?: TrialConfiguration | undefined;
}

export class CharacterPresetStore {
  private presets = new Map<string, CharacterPreset>();

  constructor(private readonly options: CharacterPresetStoreOptions) {}

  static async open(options: CharacterPresetStoreOptions): Promise<CharacterPresetStore> {
    const store = new CharacterPresetStore(options);
    if (options.filePath) {
      try {
        const raw = await readFile(options.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            store.presets.set(k, v as CharacterPreset);
          }
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') console.warn('Could not read presets file:', err);
      }
    }
    // Initialize default for companion if not already present
    if (!store.presets.has('companion')) {
      await store.initCompanionPreset();
    }
    return store;
  }

  private async initCompanionPreset(): Promise<void> {
    const snap = this.options.settings.snapshot();
    let promptText = '青梅竹马伴侣设定。';
    let promptRev = 1;
    try {
      const p = await this.options.memory.prompt('companion');
      if (p?.text) {
        promptText = p.text;
        promptRev = p.revision || 1;
      }
    } catch {}

    const activeSkin = this.options.skins?.active?.()?.skinId || 'default-skin';

    const dialogueModel = snap.effective.providers.dialogue?.model || 'deepseek-chat';
    const dialogueProvider = snap.effective.providers.dialogue?.provider || 'deepseek';
    const dialogueCred = snap.effective.providers.dialogue?.credentialRef || 'credential-ref-1';

    const ttsVoice = snap.effective.providers.tts?.voice || 'Cherry';
    const ttsModel = snap.effective.providers.tts?.model || 'qwen-tts';
    const ttsProvider = snap.effective.providers.tts?.provider || 'dashscope';
    const ttsCred = snap.effective.providers.tts?.credentialRef || 'credential-ref-1';

    const preset: CharacterPreset = {
      characterId: 'companion',
      presetId: 'companion-default',
      revision: 1,
      savedRevision: 1,
      effectiveRevision: 1,
      appearance: {
        type: 'live2d',
        resourceId: activeSkin,
        label: '默认桌宠形象',
      },
      persona: {
        text: promptText,
        revision: promptRev,
      },
      bindings: {
        dialogue: {
          provider: dialogueProvider,
          model: dialogueModel,
          credentialRef: dialogueCred,
          temperature: 0.7,
        },
        tts: {
          provider: ttsProvider,
          model: ttsModel,
          voice: ttsVoice,
          credentialRef: ttsCred,
        },
      },
    };

    this.presets.set('companion', preset);
  }

  async getPreset(characterId: string): Promise<CharacterPreset> {
    const preset = this.presets.get(characterId);
    if (!preset) {
      if (characterId === 'companion') {
        await this.initCompanionPreset();
        return this.presets.get('companion')!;
      }
      // Return fresh default preset for custom character role
      const newPreset: CharacterPreset = {
        characterId,
        presetId: `${characterId}-preset`,
        revision: 1,
        savedRevision: 1,
        effectiveRevision: 1,
        appearance: {
          type: 'live2d',
          resourceId: 'default-skin',
          label: `${characterId} 外观`,
        },
        persona: {
          text: `这是角色 ${characterId} 的独立设定。`,
          revision: 1,
        },
        bindings: {
          dialogue: {
            provider: 'deepseek',
            model: 'deepseek-chat',
            credentialRef: 'default-credential',
            temperature: 0.7,
          },
        },
      };
      this.presets.set(characterId, newPreset);
      return newPreset;
    }
    return preset;
  }

  async savePreset(input: CharacterPresetSaveInput): Promise<CharacterPreset> {
    const current = await this.getPreset(input.characterId);
    if (input.expectedRevision !== current.revision) {
      throw new ManagementError('version_conflict', '角色预设已被更新，请刷新后再保存。');
    }

    const nextRevision = current.revision + 1;
    const nextPreset: CharacterPreset = {
      ...current,
      presetId: input.presetId || current.presetId,
      revision: nextRevision,
      savedRevision: nextRevision,
      effectiveRevision: current.effectiveRevision,
      appearance: input.appearance ? { ...current.appearance, ...input.appearance } : current.appearance,
      persona: input.persona ? { text: input.persona.text, revision: current.persona.revision + 1 } : current.persona,
      bindings: {
        dialogue: input.bindings?.dialogue ? { ...current.bindings.dialogue, ...input.bindings.dialogue } as any : current.bindings.dialogue,
        asr: input.bindings?.asr ? { ...current.bindings.asr, ...input.bindings.asr } as any : current.bindings.asr,
        tts: input.bindings?.tts ? { ...current.bindings.tts, ...input.bindings.tts } as any : current.bindings.tts,
      },
    };

    // If persona text changed, apply to memory store
    if (input.persona?.text && input.persona.text !== current.persona.text) {
      try {
        await this.options.memory.savePrompt({
          characterId: input.characterId,
          expectedRevision: current.persona.revision,
          text: input.persona.text,
          operationId: `preset-save-${Date.now()}`,
        });
      } catch (err) {
        console.warn('Failed to update persona prompt in memory store:', err);
      }
    }

    // If appearance changed, apply to skin store if available
    if (input.appearance?.resourceId && input.appearance.resourceId !== current.appearance.resourceId) {
      try {
        if (this.options.skins) {
          const skinState = this.options.skins.state();
          await this.options.skins.activate(skinState.revision, input.appearance.resourceId);
        }
      } catch (err) {
        console.warn('Failed to activate skin in skin store:', err);
      }
    }

    this.presets.set(input.characterId, nextPreset);

    // Save to disk if filePath configured
    if (this.options.filePath) {
      try {
        await mkdir(dirname(this.options.filePath), { recursive: true });
        const obj = Object.fromEntries(this.presets.entries());
        await writeFile(this.options.filePath, JSON.stringify(obj, null, 2), 'utf8');
      } catch (err) {
        console.warn('Failed to write presets file:', err);
      }
    }

    return nextPreset;
  }
}
