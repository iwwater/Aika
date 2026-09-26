import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isQwenAudioTtsModel } from '../providers/qwen-audio-tts.js';

export const TRIAL_CONFIG_VERSION = 1;
export type TrialOperation = 'asr' | 'dialogue' | 'memory_turn' | 'summary' | 'perception' | 'tts' | 'admission';
export interface TrialModel {
  readonly provider: 'deepseek' | 'dashscope';
  readonly model: string;
  readonly endpoint: string;
  readonly credentialFile: string;
  readonly reservationMicros: number;
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly characterMicros?: number;
  readonly thinking?: 'high';
  readonly audioMicrosPerSecond?: number;
}
export interface TrialConfiguration {
  readonly version: 1;
  readonly product?: 'companion-v1';
  readonly phaseId: string;
  readonly purpose: 'smoke-text' | 'user-trial';
  readonly smokeInput?: string;
  readonly projectRoot: string;
  readonly sourceRevision: string;
  readonly runtimeFiles: Readonly<Record<string, string>>;
  readonly database: string;
  readonly budgetFile: string;
  readonly budgetBatchId: string;
  readonly budgetMode?: 'bounded' | 'unlimited';
  readonly limitMicros: 20_000_000 | 60_000_000 | null;
  readonly reviewedUnknownCosts?: readonly {
    readonly operationId: string; readonly model: string; readonly reservedMicros: number;
    readonly auditFile: string; readonly auditSha256: string;
  }[];
  readonly phaseLimitMicros: number;
  readonly maxCalls: number;
  readonly operationLimits: Readonly<Record<Exclude<TrialOperation, 'asr'>, number> & Partial<Record<'asr', number>>>;
  readonly models: Readonly<Record<Exclude<TrialOperation, 'asr'>, TrialModel> & Partial<Record<'asr', TrialModel>>>;
  readonly memory: { readonly mode: 'strict'; readonly scheduling: 'semantic-admission'; readonly timeoutMs: number };
}
export interface TrialActivation {
  readonly version: 1;
  readonly phaseId: string;
  readonly status: 'prepared' | 'active' | 'stopped';
  readonly configSha256: string;
}
export class TrialNotReadyError extends Error {
  override name = 'TrialNotReadyError';
}
const operations: readonly TrialOperation[] = ['dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];
const fail = (message: string): never => { throw new TrialNotReadyError(message); };
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const within = (parent: string, path: string): boolean => {
  const part = relative(resolve(parent), resolve(path));
  return part === '' || (!part.startsWith('..') && !isAbsolute(part));
};

/** Metadata validation only. This function never reads credentials, budgets, databases or devices. */
export function validateTrialConfiguration(value: unknown): TrialConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('试用配置尚未准备好。');
  const c = value as TrialConfiguration;
  if (c.product !== undefined && c.product !== 'companion-v1') fail('未知产品数据版本。');
  if (c.version !== 1 || !/^local-trial-[a-z0-9-]+$/.test(c.phaseId) || !/^[a-f0-9]{40}$/.test(c.sourceRevision)) fail('试用版本或阶段配置不完整。');
  for (const path of [c.projectRoot, c.database, c.budgetFile]) if (typeof path !== 'string' || !isAbsolute(path)) fail('试用文件位置尚未配置。');
  const expectedBudget = resolve(c.projectRoot, '.local/model-evaluation/budget.json');
  const unlimited=c.budgetMode==='unlimited';
  if (resolve(c.budgetFile) !== expectedBudget || !c.budgetBatchId || (unlimited ? c.limitMicros!==null||c.purpose!=='user-trial' : ![20_000_000,60_000_000].includes(c.limitMicros??-1)) || (c.budgetMode!==undefined&&!['bounded','unlimited'].includes(c.budgetMode))) fail('记账模式与共享账目配置不一致。');
  // Historical cost-review metadata is retained, but is not an unlimited-mode admission gate.
  if (c.reviewedUnknownCosts !== undefined && !unlimited) {
    if (!Array.isArray(c.reviewedUnknownCosts) || !c.reviewedUnknownCosts.length || (c.purpose !== 'user-trial' && c.reviewedUnknownCosts.length > c.maxCalls + 3)
      || new Set(c.reviewedUnknownCosts.map(r => r.operationId)).size !== c.reviewedUnknownCosts.length) fail('未知费用的保守预留复核不完整。');
    for (const review of c.reviewedUnknownCosts) {
      const old = review.operationId === 'W0-I:B-DANIA-MINIMAX-AUDITION-01:clone-demo' && review.model === 'MiniMax/speech-2.8-hd'
        && review.reservedMicros === 19_600 && review.auditFile === resolve(c.projectRoot, '.local/minimax-default-01/budget-bound/audit.json');
      const part = ['W0-I:B-XIAOLING-FORGETTING-01:asr:1','W0-I:B-XIAOLING-FORGETTING-01:asr:2'].indexOf(review.operationId) + 1;
      const asr = part > 0 && review.model === 'qwen3-asr-flash-2026-02-10' && review.reservedMicros === 36_960
        && review.auditFile === resolve(c.projectRoot, `.local/xiaoling-forgetting-01/budget-bound/part-${part}.json`);
      const prefix = `W0-I:${c.phaseId}:memory_turn:`;
      const id = typeof review.operationId === 'string' && review.operationId.startsWith(prefix) ? review.operationId.slice(prefix.length) : '';
      const memory = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
        && review.model === c.models?.memory_turn?.model && review.reservedMicros === c.models?.memory_turn?.reservationMicros
        && review.auditFile === resolve(c.projectRoot, `.local/model-evaluation/unknown-cost-reviews/${id}.json`);
      if ((!old && !asr && !memory) || !/^[a-f0-9]{64}$/.test(review.auditSha256)) fail('未知费用复核超出已登记的单笔边界。');
    }
  }
  if (!['smoke-text','user-trial'].includes(c.purpose)) fail('运行用途未登记。');
  // Historical experiment fields remain readable; daily use is governed solely by the shared budget.
  if (c.purpose !== 'user-trial') {
    if (c.limitMicros===null || !positive(c.phaseLimitMicros) || c.phaseLimitMicros > c.limitMicros || !positive(c.maxCalls)) fail('试用调用与费用范围尚未登记。');
    if (!c.operationLimits || Object.keys(c.operationLimits).sort().join(',') !== [...operations].sort().join(',')) fail('试用逐项调用上限未登记。');
    for (const n of Object.values(c.operationLimits)) if (!Number.isSafeInteger(n) || n < 0) fail('调用上限无效。');
    if (Object.values(c.operationLimits).reduce((a,b)=>a+b,0)>c.maxCalls) fail('逐项调用上限超过总次数。');
  }
  if (c.purpose === 'smoke-text' && c.operationLimits.perception !== 0) fail('无声文字阶段不能调用感知。');
  if (c.purpose === 'smoke-text' && (typeof c.smokeInput !== 'string' || !c.smokeInput.trim())) fail('无声文字阶段缺少固定的合成输入。');
  const required = ['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js',
    'desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'];
  if (!c.runtimeFiles || typeof c.runtimeFiles !== 'object' || Array.isArray(c.runtimeFiles)
    || required.some(path => !c.runtimeFiles[`code/desktop-pet/${path}`])) fail('试用构建版本尚未登记。');
  for (const [path, digest] of Object.entries(c.runtimeFiles)) {
    if (!path.startsWith('code/desktop-pet/') || path.split('/').some(part => part === '..' || part === '.')
      || !/^[a-f0-9]{64}$/.test(digest)) fail('试用构建指纹无效。');
  }
  if (!c.memory || c.memory.mode !== 'strict' || c.memory.scheduling !== 'semantic-admission' || !positive(c.memory.timeoutMs)) fail('严格记忆与语义准入尚未接通，不能回退旧维护器。');
  const configuredOperations = c.models?.asr ? [...operations, 'asr' as const] : operations;
  if (!c.models || Object.keys(c.models).sort().join(',') !== [...configuredOperations].sort().join(',')) fail('实际模型配置不完整。');
  for (const operation of configuredOperations) {
    const m = c.models[operation];
    if (!m) return fail('实际模型未配置。');
    if (typeof m.model !== 'string' || !m.model.trim() || !positive(m.reservationMicros) || (!unlimited&&m.reservationMicros > (c.purpose === 'user-trial' ? c.limitMicros! : c.phaseLimitMicros))) fail('实际模型或调用预留未配置。');
    if (typeof m.credentialFile !== 'string' || !isAbsolute(m.credentialFile) || within(c.projectRoot, m.credentialFile)) fail('凭据须使用项目外的受限文件。');
    const expected = m.provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions'
      : m.provider === 'dashscope' ? operation === 'tts' ? isQwenAudioTtsModel(m.model)
        ? 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
        : 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
        : 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' : null;
    if (!expected || m.endpoint !== expected) fail('模型服务地址不在已登记供应商范围。');
    if (operation === 'memory_turn' && m.provider !== 'deepseek') fail('试用严格语义记忆须明确配置DeepSeek，不回退旧维护器。');
    if (['asr', 'perception', 'tts'].includes(operation) && m.provider !== 'dashscope') fail('感知和语音需要已登记的DashScope配置。');
    if (['dialogue', 'summary', 'admission'].includes(operation) && m.provider === 'deepseek'
      && (m.model !== 'deepseek-flash' || m.inputMicrosPerToken !== 2 || m.outputMicrosPerToken !== 8
        || m.inputTokenLimit > 32768 || m.outputTokenLimit > 393216)) fail('DeepSeek文本需要当前登记的Flash型号和保守计费边界。');
    if (![m.inputMicrosPerToken, m.outputMicrosPerToken].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) fail('模型计费口径未配置。');
    if (operation === 'asr' && (m.model !== 'qwen3-asr-flash-2026-02-10' || m.audioMicrosPerSecond !== 220 || m.inputMicrosPerToken !== 0 || m.outputMicrosPerToken !== 0)) fail('语音转写型号与音频时长费率未登记。');
    if (operation !== 'tts' && operation !== 'asr') {
      if (!positive(m.inputTokenLimit) || !positive(m.outputTokenLimit)) fail('模型输入输出硬上限未登记。');
      const maximum = Math.ceil(m.inputTokenLimit * m.inputMicrosPerToken + m.outputTokenLimit * m.outputMicrosPerToken);
      if (!Number.isSafeInteger(maximum)) fail('费用估计数值无效。');
      if (!unlimited&&m.reservationMicros < maximum) fail('调用预留不足以覆盖登记的最坏费用。');
    }
    if (operation === 'tts' && !(typeof m.characterMicros === 'number' && Number.isFinite(m.characterMicros) && m.characterMicros > 0)) fail('语音计费口径未配置。');
    if (operation === 'tts' && m.model.startsWith('MiniMax/') && !((m.model === 'MiniMax/speech-2.8-turbo' && m.characterMicros === 200) || (m.model === 'MiniMax/speech-2.8-hd' && m.characterMicros === 350)))
      fail('MiniMax 仅登记 Turbo/HD 及各自字符费率。');
    if (m.thinking !== undefined && (operation !== 'memory_turn' || m.thinking !== 'high')) fail('模型思考配置不受当前适配器支持。');
  }
  return structuredClone(c);
}

/** An inactive phase is refused before any credential or user-data access. */
export async function readActiveTrialConfiguration(configFile: string, activationFile: string): Promise<TrialConfiguration> {
  let raw: string, activation: TrialActivation;
  try { raw = await readFile(configFile, 'utf8'); activation = JSON.parse(await readFile(activationFile, 'utf8')); }
  catch { return fail('试用配置尚未就绪，请等待集成后的可运行版本。'); }
  if (!activation || typeof activation !== 'object' || activation.version !== 1 || activation.status !== 'active') fail('试用真实模型尚未启用。');
  if (activation.configSha256 !== createHash('sha256').update(raw).digest('hex')) fail('试用配置已变化，需重新完成集成检查。');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail('试用配置文件无法读取。'); }
  const configuration = validateTrialConfiguration(parsed);
  if (activation.phaseId !== configuration.phaseId) fail('试用阶段与配置不匹配。');
  return configuration;
}
