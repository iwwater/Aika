// UIR-02: Unified Character Preset View
// Combines Appearance, Persona, and Model/Voice Bindings into one cohesive Character Preset page.
// Strictly obeys:
// 1. One unified page (no disconnected tabs)
// 2. Clear sequence: Appearance -> Persona -> Model Bindings
// 3. Saved vs Effective revision visibility
// 4. Role-scoped isolation (Character A/B isolation)
// 5. Credential references only, never duplicating API Keys

import { el, button, field, notice, card, badge } from './dom.mjs';
import { createStatusBadge } from './envelope.mjs';

export function createCharacterPresetView(actions) {
  const { s, client } = actions;
  const container = el('div', { class: 'character-preset-container', style: 'display:flex; flex-direction:column; gap:20px;' });

  const currentChar = s.pairing?.characterId || s.character || 'companion';

  if (!s.characterPresetState || s.characterPresetState.characterId !== currentChar) {
    s.characterPresetState = {
      characterId: currentChar,
      preset: null,
      loaded: false,
      loading: false,
      saving: false,
      error: '',
      message: '',
      // Local draft fields
      draftPersona: '',
      draftSkinId: '',
      draftDialogueModel: '',
      draftDialogueProvider: '',
      draftDialogueTemp: 0.7,
      draftTtsVoice: '',
    };
  }
  const cps = s.characterPresetState;

  function loadPreset() {
    if (!client?.token || cps.loading) return;
    cps.loading = true;
    cps.error = '';

    client.request(`/api/characters/preset?characterId=${encodeURIComponent(currentChar)}`)
      .then(preset => {
        cps.preset = preset;
        cps.loaded = true;
        cps.draftPersona = preset.persona?.text || '';
        cps.draftSkinId = preset.appearance?.resourceId || '';
        cps.draftDialogueModel = preset.bindings?.dialogue?.model || '';
        cps.draftDialogueProvider = preset.bindings?.dialogue?.provider || '';
        cps.draftDialogueTemp = preset.bindings?.dialogue?.temperature ?? 0.7;
        cps.draftTtsVoice = preset.bindings?.tts?.voice || '';
        cps.loading = false;
        actions.render();
      })
      .catch(err => {
        cps.loaded = true;
        cps.loading = false;
        cps.error = '读取角色预设失败：' + (err.message || err);
        actions.render();
      });
  }

  if (!cps.loaded && !cps.loading && client?.token) {
    loadPreset();
  }

  // 1. Header Card: Role Scope, Preset ID, Revisions
  const p = cps.preset;
  const isPendingEffective = p && p.savedRevision > p.effectiveRevision;

  const headerCard = card('当前角色预设 · 作用域与版本状态',
    el('div', { style: 'display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;' },
      el('div', { style: 'display:flex; align-items:center; gap:16px;' },
        el('div', {},
          el('span', { class: 'subtle', style: 'font-size:12px;' }, '当前编辑角色: '),
          el('strong', { style: 'font-size:15px; color:#0f172a;' }, currentChar),
        ),
        el('div', {},
          el('span', { class: 'subtle', style: 'font-size:12px;' }, '预设标识 (Preset ID): '),
          el('code', { style: 'font-size:13px;' }, p?.presetId || `${currentChar}-default`),
        ),
      ),
      el('div', { style: 'display:flex; align-items:center; gap:10px;' },
        p ? createStatusBadge(isPendingEffective ? 'busy' : 'ready', isPendingEffective ? `已保存 v${p.savedRevision} (待重启生效)` : `生效中 v${p.effectiveRevision}`) : null,
        button('🔄 重新读取', () => loadPreset(), { class: 'subtle-btn', style: 'font-size:12px;' })
      )
    ),
    isPendingEffective ? el('div', {
      class: 'notice warning',
      style: 'margin-top:12px; padding:8px 12px; font-size:12px;'
    }, '⚠️ 预设配置已保存为新版本，当前桌宠进程仍在使用生效版本。重启桌宠后将自动切换为已保存版本。') : null,
    cps.error ? el('div', { class: 'notice error', style: 'margin-top:12px;' }, cps.error) : null,
    cps.message ? el('div', { class: 'notice success', style: 'margin-top:12px;' }, cps.message) : null,
  );

  // 2. Block 1: 表现资源引用 (Appearance & Presentation)
  const appearanceBlock = card('1. 表现资源引用 · 外观形象与动作映射',
    el('p', { class: 'subtle', style: 'margin-top:0; font-size:13px;' }, '配置当前角色的视觉呈现载体（Live2D 模型或 2D 精灵图），及其基础状态映射。'),
    el('div', { style: 'display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-top:12px;' },
      field('表现类型', 'preset-appearance-type', p?.appearance?.type || 'live2d', () => {}, { disabled: true, hint: '当前支持 Live2D 动态模型渲染' }),
      field('形象资源标识 (Skin Resource ID)', 'preset-skin-id', cps.draftSkinId, v => { cps.draftSkinId = v; }, {
        placeholder: '例如 default-skin 或自定义皮肤包 ID',
        hint: '对应已安装皮肤包或桌宠内置形象'
      }),
      field('外观显示标签', 'preset-appearance-label', p?.appearance?.label || '默认形象', () => {}, { disabled: true })
    )
  );

  // 3. Block 2: Persona 人设 (单段文本与修订)
  const personaBlock = card('2. Persona 人设设定 · 核心底色与性格',
    el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;' },
      el('p', { class: 'subtle', style: 'margin:0; font-size:13px;' }, '单段核心 Persona 设定。此内容直接参与对话生成上下文构建，决定角色的对话口吻与基本世界观。'),
      el('span', { class: 'badge muted' }, `Persona 修订: v${p?.persona?.revision || 1}`)
    ),
    field('角色设定 Prompt 正文', 'preset-persona-text', cps.draftPersona, v => { cps.draftPersona = v; }, {
      type: 'textarea',
      rows: '6',
      placeholder: '输入角色的性格底色、称谓习惯与核心陪伴口吻...',
      style: 'width:100%; font-family:inherit; font-size:13px; line-height:1.6;'
    })
  );

  // 4. Block 3: 模型与音色绑定 (Model & Voice Bindings)
  const bindingsBlock = card('3. 模型链路与音色绑定 · Dialogue / ASR / TTS',
    el('div', {
      class: 'notice info',
      style: 'margin-bottom:16px; padding:8px 12px; font-size:12px; border-radius:6px;'
    }, '🔒 安全铁律：模型端点与 API 凭据在【全局设置 ➔ 模型来源与凭据】中受控维护；本预设仅引用对应模型与音色配置，绝不复制或保存明文 Key。'),
    el('div', { style: 'display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px;' },
      // Dialogue Slot
      el('div', { style: 'border:1px solid #e2e8f0; border-radius:8px; padding:14px; background:#f8fafc;' },
        el('h4', { style: 'margin:0 0 8px 0; font-size:14px; color:#1e293b;' }, '💬 对话大模型 (Dialogue)'),
        field('服务提供商', 'preset-dialogue-provider', cps.draftDialogueProvider, v => { cps.draftDialogueProvider = v; }, {
          placeholder: '例如 deepseek 或 dashscope',
        }),
        field('模型型号 (Model)', 'preset-dialogue-model', cps.draftDialogueModel, v => { cps.draftDialogueModel = v; }, {
          placeholder: '例如 deepseek-chat, qwen-plus...',
        }),
        field('温度 (Temperature: 0.0 ~ 1.5)', 'preset-dialogue-temp', String(cps.draftDialogueTemp), v => { cps.draftDialogueTemp = parseFloat(v) || 0.7; }, {
          type: 'number',
          min: '0.0',
          max: '1.5',
          step: '0.1'
        })
      ),
      // TTS Slot
      el('div', { style: 'border:1px solid #e2e8f0; border-radius:8px; padding:14px; background:#f8fafc;' },
        el('h4', { style: 'margin:0 0 8px 0; font-size:14px; color:#1e293b;' }, '🔊 语音合成 (TTS 音色)'),
        field('合成音色 (Voice)', 'preset-tts-voice', cps.draftTtsVoice, v => { cps.draftTtsVoice = v; }, {
          placeholder: '例如 Cherry, 默认女声...',
          hint: '音色标识遵循选定 TTS 提供商的能力声明'
        }),
        field('TTS 供应商', 'preset-tts-provider', p?.bindings?.tts?.provider || 'dashscope', () => {}, { disabled: true }),
        field('TTS 模型', 'preset-tts-model', p?.bindings?.tts?.model || 'qwen-tts', () => {}, { disabled: true })
      ),
      // ASR Slot
      el('div', { style: 'border:1px solid #e2e8f0; border-radius:8px; padding:14px; background:#f8fafc;' },
        el('h4', { style: 'margin:0 0 8px 0; font-size:14px; color:#1e293b;' }, '🎤 语音转写 (ASR 链路)'),
        field('ASR 模型', 'preset-asr-model', p?.bindings?.asr?.model || 'qwen-asr (生产默认)', () => {}, { disabled: true, hint: '本地或流式转写链路' }),
        field('凭据引用', 'preset-asr-cred', p?.bindings?.asr?.credentialRef || '跟随全局凭据', () => {}, { disabled: true })
      )
    )
  );

  // 5. Actions Footer
  async function doSavePreset() {
    if (!p || cps.saving) return;
    cps.saving = true;
    cps.error = '';
    cps.message = '';
    actions.render();

    try {
      const updated = await client.request('/api/characters/preset', {
        method: 'PUT',
        body: {
          characterId: currentChar,
          presetId: p.presetId,
          expectedRevision: p.revision,
          appearance: {
            type: p.appearance?.type || 'live2d',
            resourceId: cps.draftSkinId.trim() || p.appearance?.resourceId || 'default-skin',
            label: p.appearance?.label || '默认形象',
          },
          persona: {
            text: cps.draftPersona.trim(),
          },
          bindings: {
            dialogue: {
              provider: cps.draftDialogueProvider.trim() || p.bindings?.dialogue?.provider || 'deepseek',
              model: cps.draftDialogueModel.trim() || p.bindings?.dialogue?.model || 'deepseek-chat',
              temperature: cps.draftDialogueTemp,
              credentialRef: p.bindings?.dialogue?.credentialRef || 'credential-ref-1',
            },
            tts: {
              voice: cps.draftTtsVoice.trim() || p.bindings?.tts?.voice || 'Cherry',
              provider: p.bindings?.tts?.provider || 'dashscope',
              model: p.bindings?.tts?.model || 'qwen-tts',
              credentialRef: p.bindings?.tts?.credentialRef || 'credential-ref-1',
            },
          },
        },
      });

      cps.preset = updated;
      cps.message = `角色预设已成功保存为 v${updated.savedRevision}！重启桌宠即可生效。`;
    } catch (err) {
      cps.error = '保存角色预设失败：' + (err.message || err);
    } finally {
      cps.saving = false;
      actions.render();
    }
  }

  const actionsBar = el('div', {
    style: 'display:flex; justify-content:flex-end; gap:12px; padding:16px 0; border-top:1px solid #e2e8f0; margin-top:8px;'
  },
    button(cps.saving ? '正在保存预设…' : '💾 保存角色预设', doSavePreset, {
      class: 'primary',
      style: 'padding:10px 20px; font-size:14px;',
      disabled: cps.saving || !cps.preset
    })
  );

  container.append(
    headerCard,
    appearanceBlock,
    personaBlock,
    bindingsBlock,
    actionsBar
  );

  return container;
}
