import { deepseekFlashModel, TEXT_SLOTS } from './text-protocol.js';
import type { TrialConfiguration, TrialModel } from '../app/trial-config.js';
import type { ProviderAdapterInfo, ProviderSelection, ProviderSlot } from '../contracts/management.js';
import type { RegisteredVoice } from './registered-voices.js';
import { MINIMAX_TTS_MODEL, MINIMAX_TTS_ENDPOINT } from './minimax-tts.js';

type Selection = Omit<ProviderSelection, 'credentialRef'>;
/** Every reviewed preset rides the OpenAI-compatible wire (Bearer auth, model in body); Gemini is the alternative. */
const WIRE = 'openai-compatible' as const;
type Choice = NonNullable<ProviderAdapterInfo['choices']>[number];
const chatEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const ttsEndpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const slots: readonly ProviderSlot[] = ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];
const identities: Record<ProviderSlot, [string, string]> = {
  asr: ['qwen-asr','语音转写'],
  dialogue: ['qwen-dialogue', '对话'], memory_turn: ['strict-deepseek', '严格记忆'],
  summary: ['qwen-summary', '摘要'], perception: ['qwen-visual-emotion', '视频情绪'],
  tts: ['qwen-tts-instruct', '情绪语音'], admission: ['semantic-admission', '语义准入'],
};

// Reviewed 2026-09-10, Beijing tariffs. CNY / million tokens equals micros / token.
// Sources and limitations: .local/runtime-console-01/REVIEW.md.
// These are complete model selections, not labels to overlay on another model's prices.
function chat(adapterId: string, flash: boolean): Selection {
  return { adapterId, protocol: WIRE, provider: 'dashscope', endpoint: chatEndpoint,
    model: flash ? 'qwen-flash-2025-07-28' : 'qwen-plus-2025-12-01',
    inputTokenLimit: 32_768, outputTokenLimit: 32_768,
    inputMicrosPerToken: flash ? 0.15 : 0.8, outputMicrosPerToken: flash ? 1.5 : 2,
    reservationMicros: flash ? 60_000 : 100_000 };
}
function omni(plus: boolean, visual = false): Selection {
  return { adapterId: visual ? identities.perception[0] : 'qwen-perception', protocol: WIRE, provider: 'dashscope', endpoint: chatEndpoint,
    model: `qwen3.5-omni-${plus ? 'plus' : 'flash'}-2026-03-15`,
    inputTokenLimit: 196_608, outputTokenLimit: 65_536,
    // Separate visual-only rates; historical combined input retains its audio upper rate.
    inputMicrosPerToken: visual ? (plus ? 7 : 2.2) : (plus ? 53 : 18), outputMicrosPerToken: plus ? 40 : 13.3,
    reservationMicros: visual ? Math.ceil(196_608 * (plus ? 7 : 2.2) + 65_536 * (plus ? 40 : 13.3)) : (plus ? 13_100_000 : 4_500_000) };
}
function speech(model: string): Selection {
  return { adapterId: identities.tts[0], protocol: WIRE, provider: 'dashscope', endpoint: ttsEndpoint, model,
    inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
    characterMicros: 80, reservationMicros: 100_000, voice: 'Cherry', language: 'Chinese' };
}
function voices(): NonNullable<Choice['voices']> {
  return [{ id: 'Cherry', label: '芊悦' }, { id: 'Serena', label: '苏瑶' }, { id: 'Seren', label: '小婉' }];
}

/** Explicit projection: never serialize credentialFile or other private config fields. */
function baseline(slot: ProviderSlot, model: TrialModel): Selection {
  return { adapterId: identities[slot][0], protocol: model.protocol ?? WIRE, provider: model.provider, endpoint: model.endpoint, model: model.model,
    inputTokenLimit: model.inputTokenLimit, outputTokenLimit: model.outputTokenLimit,
    inputMicrosPerToken: model.inputMicrosPerToken, outputMicrosPerToken: model.outputMicrosPerToken,
    reservationMicros: model.reservationMicros,
    ...(model.audioMicrosPerSecond === undefined ? {} : {audioMicrosPerSecond:model.audioMicrosPerSecond}),
    ...(model.characterMicros === undefined ? {} : { characterMicros: model.characterMicros }),
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
    ...(slot === 'tts' ? { voice: 'Cherry', language: 'Chinese' } : {}) };
}

/** Metadata only. The caller supplies the registered baseline; no file, key, device or network access. */
export function managementAdapterCatalog(base: TrialConfiguration, registeredVoices: readonly RegisteredVoice[] = []): ProviderAdapterInfo[] {
  const catalog: ProviderAdapterInfo[] = slots.filter(slot=>base.models[slot]).map(slot => {
    const model=base.models[slot]!;
    const deepseek = TEXT_SLOTS.includes(slot as never) && model.provider === 'deepseek';
    const [id, label] = slot === 'perception' && !base.models.asr ? ['qwen-perception', '历史联合感知'] : deepseek ? [`deepseek-${slot}`, `${identities[slot][1]} · DeepSeek 4.1 Flash`] : identities[slot];
    const original = deepseek ? { ...baseline(slot, deepseekFlashModel(model.credentialFile)), adapterId: id } : { ...baseline(slot, model), adapterId: id };
    const choices: Choice[] = [{ label: `${original.model}（已登记基线）`, configuration: original,
      ...(slot === 'tts' ? { voices: voices() } : {}) }];
    const reviewed = deepseek ? [] : slot === 'tts'
      ? [speech('qwen3-tts-instruct-flash-2026-01-26'), speech('qwen3-tts-instruct-flash')]
      : slot === 'perception' ? [omni(false, !!base.models.asr), omni(true, !!base.models.asr)]
      : slot === 'memory_turn' || slot === 'asr' ? [] : [chat(id, false), chat(id, true)];
    for (const configuration of reviewed) {
      if (choices.some(choice => choice.configuration.model === configuration.model)) continue;
      choices.push({ label: configuration.model === 'qwen3-tts-instruct-flash'
        ? `${configuration.model}（同系列滚动别名）` : configuration.model, configuration,
      ...(slot === 'tts' ? { voices: voices() } : {}) });
    }
    const specific = deepseek ? `DeepSeek 4.1 Flash，官网当前调用ID deepseek-flash；${slot === 'dialogue' ? '对话由本地规则按问题选择思考或非思考，保持JSON协议' : '非思考JSON协议'}。峰值未命中输入2元/百万、输出8元/百万保守估算，缓存与闲时折扣可能降低实际账单。输入登记32768、输出393216，单次预留3.211264元；沿原累计账，不自动回退千问文本。官方：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/` : slot === 'perception'
      ? '仅使用本轮摄像头画面判断情绪；语音由独立转写服务处理。沿用原累计总账保守预留。'
      : slot === 'tts'
        ? '仅已接入的指令型系列及预置音色；滚动别名当前对应 2026-01-26，同系列不代表跨系列切换。不支持声音复刻。按实际提交字符预留费用，计入原累计总账。'
        : slot === 'memory_turn'
          ? '保留严格语义记忆与 high 配置。官网当前说明 Pro 在 2026-09-14 后继续提供服务。现费率使用峰值未命中上界。'
          : '已接入非思考 JSON 对话协议；北京输入不超过 128K 的价格档。配置输入上限 32768，保留模型完整输出上限，预留不代表实际扣费。';
    return { id, label, slots: [slot], provider: original.provider,
      endpoints: [...new Set(choices.map(choice => choice.configuration.endpoint))],
      modelHint: original.model, models: choices.map(choice => choice.configuration.model), choices,
      capabilities: { instructions: slot === 'tts', cloning: false, voice: slot === 'tts',
        language: slot === 'tts', temperature: slot === 'dialogue' },
      status: 'available', note: `官方资料核对：${deepseek || slot === 'memory_turn' ? '2026-09-12' : '2026-09-10'}。${specific} 适配器已接入；账户可用性、音质与真实耗时未在本包调用验证。` };
  });
  const qwenAudio: Selection = { adapterId: 'qwen-audio-tts', protocol: WIRE, provider: 'dashscope',
    model: 'qwen-audio-3.0-tts-flash',
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
    characterMicros: 100, reservationMicros: 400_000, voice: 'longanfengyue' };
  const qwenAudioPlus: Selection = { ...qwenAudio, model: 'qwen-audio-3.0-tts-plus',
    characterMicros: 140, voice: 'longanlingxin' };
  catalog.push({ id: qwenAudio.adapterId, label: 'QwenAudio 情绪语音', slots: ['tts'], provider: 'dashscope',
    endpoints: [qwenAudio.endpoint], modelHint: qwenAudio.model, models: [qwenAudio.model, qwenAudioPlus.model],
    choices: [{ label: 'QwenAudio 3.0 Flash（系统音色）', configuration: qwenAudio,
      voices: [{ id: 'longanfengyue', label: '龙安风悦' }, { id: 'longanlingxi', label: '龙安灵希' }] },
    { label: 'QwenAudio 3.0 Plus（旗舰系统音色）', configuration: qwenAudioPlus,
      voices: [{ id: 'longanlingxin', label: '龙安灵心' }] }],
    capabilities: { instructions: true, cloning: false, voice: true, language: false, temperature: false },
    status: 'available',
    note: '官方资料核对：2026-09-11。系统音色支持中文和英文；Flash与Plus音色不能混用。此接入不提供语言参数、流式播放或声音复刻。北京每万计费字符Flash 1元、Plus 1.4元，每段保守预留0.40元，按实际计费字符结算。Plus样音已在本地修复文件头并通过播放格式检查；未做新旧音色试听比较，旗舰为官方定位。' });
  const audio = catalog[catalog.length - 1]!;
  for (const choice of audio.choices!) {
    const compatible = registeredVoices.filter(voice => voice.provider === choice.configuration.provider
      && voice.endpoint === choice.configuration.endpoint && voice.targetModel === choice.configuration.model);
    choice.voices = [...(choice.voices ?? []), ...compatible.map(voice => ({ id: voice.voiceId, label: voice.label }))];
  }
  if (registeredVoices.some(voice => voice.endpoint === qwenAudio.endpoint && [qwenAudio.model, qwenAudioPlus.model].includes(voice.targetModel))) {
    audio.capabilities.cloning = true;
    audio.note = '已登记的克隆音色与具体模型、服务地址和凭据绑定；保存选择时会核对，不支持任意输入音色ID。系统与克隆音色均可选择。北京每万计费字符Flash 1元、Plus 1.4元，每段预留0.40元，沿原账本按实际用量结算。完整WAV后播放；克隆相似度和听感需实际试听判断。';
  }
  const minimaxChoices: Choice[] = [];
  // Local registrations are exact reviewed pairings, not a claim that the supplier forbids cross-model reuse.
  // I appends the selected voice only after its first formal synthesis succeeds.
  for (const [model, label, characterMicros] of [[MINIMAX_TTS_MODEL, 'MiniMax Turbo', 200], ['MiniMax/speech-2.8-hd', 'MiniMax HD', 350]] as const) {
    const compatible = registeredVoices.filter(voice => voice.provider === 'dashscope' && voice.endpoint === MINIMAX_TTS_ENDPOINT && voice.targetModel === model);
    // FIX61-10: this hosted adapter is only usable with a registered (cloned) voice — its own note says
    // the selection exists only after the clone is completed. A model with no registered voice must not
    // appear, so the `minimaxChoices.length` guard below keeps the whole adapter away until one exists.
    if (!compatible.length) continue;
    const configuration: Selection = { adapterId: 'minimax-tts', protocol: WIRE, provider: 'dashscope', endpoint: MINIMAX_TTS_ENDPOINT,
      model, inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
      characterMicros, reservationMicros: 2400 * characterMicros, ...(compatible[0]?{voice:compatible[0].voiceId}:{}) };
    minimaxChoices.push({ label, configuration, voices: compatible.map(voice => ({ id: voice.voiceId, label: voice.label })) });
  }
  // FIX61-01: capability-only adapters. They declare a protocol and the capabilities the production
  // composition root actually implements; they carry no model white-list and no reviewed tariff, so any
  // registered model on that protocol is accepted. Prices for a custom model stay user-supplied and
  // unknown costs are reported as unknown rather than as zero.
  catalog.push({ id: 'openai-compatible-text', label: '自定义文本（OpenAI 兼容）', slots: ['dialogue', 'memory_turn', 'summary', 'admission'],
    provider: 'dashscope', endpoints: [], modelHint: '', models: [], open: true,
    capabilities: { instructions: false, cloning: false, voice: false, language: false, temperature: true },
    status: 'available',
    note: '按 OpenAI 兼容协议接入任意自填模型：模型名、服务地址、用量上界与费用口径均由配置决定，本适配器不按型号白名单拦截。记忆槽仍使用严格语义解析、来源校验和原子提交，只替换模型调用。' });
  catalog.push({ id: 'openai-compatible-perception', label: '自定义图像感知（OpenAI 兼容）', slots: ['perception'],
    provider: 'dashscope', endpoints: [], modelHint: '', models: [], open: true,
    capabilities: { instructions: false, cloning: false, voice: false, language: false, temperature: false },
    status: 'available',
    note: '按 OpenAI 兼容协议接入自填的多模态模型，用于本轮画面判断；音频转写仍由独立 ASR 槽处理。' });
  catalog.push({ id: 'openai-compatible-asr', label: '自定义语音转写（OpenAI 兼容）', slots: ['asr'],
    provider: 'dashscope', endpoints: [], modelHint: '', models: [], open: true,
    capabilities: { instructions: false, cloning: false, voice: false, language: false, temperature: false },
    status: 'available',
    note: '按 OpenAI 兼容的音频输入协议接入自填转写模型；需要填写每音频秒费率。本适配器为整段批处理，实时逐块转写由本地流式识别路径提供。' });
  catalog.push({ id: 'openai-compatible-tts', label: '自定义语音合成（OpenAI 兼容）', slots: ['tts'],
    provider: 'dashscope', endpoints: [], modelHint: '', models: [], open: true,
    capabilities: { instructions: true, cloning: false, voice: true, language: true, temperature: false },
    status: 'available',
    note: '按 OpenAI 兼容的语音合成协议接入自填模型；音色 ID 与每计费字符费率由配置决定。需要所选服务真实支持该音色。' });
  catalog.push({ id: 'gemini-text', label: '自定义文本（Gemini）', slots: ['dialogue', 'memory_turn', 'summary', 'admission', 'perception'],
    provider: 'gemini', endpoints: [], modelHint: '', models: [], open: true,
    capabilities: { instructions: false, cloning: false, voice: false, language: false, temperature: true },
    status: 'available',
    note: '按 Gemini generateContent 协议接入自填模型：模型名进入请求 URL，密钥使用 x-goog-api-key。本版本 Gemini 协议不提供音频转写与语音合成。' });
  if (minimaxChoices.length) {
    catalog.push({ id: 'minimax-tts', label: 'MiniMax 语音（百炼托管）', slots: ['tts'], provider: 'dashscope',
      endpoints: [MINIMAX_TTS_ENDPOINT], modelHint: minimaxChoices[0]!.configuration.model,
      models: minimaxChoices.map(choice => choice.configuration.model), choices: minimaxChoices,
      capabilities: { instructions: false, cloning: true, voice: true, language: false, temperature: false }, status: 'available',
      note: '使用已登记的音色，按实际合成字符计费，Turbo每万字符2元，HD每万字符3.5元。不指定情绪参数，由模型根据文本生成语气；完整生成后播放。需要在百炼开通所选模型；保存Key不代表已开通。预设可先查看，完成音色复刻与首次正式启用后才可选择对应已登记音色。' });
  }
  return catalog;
}
