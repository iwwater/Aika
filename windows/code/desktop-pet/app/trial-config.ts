import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isQwenAudioTtsModel } from '../providers/qwen-audio-tts.js';
import { isAllowedEndpoint } from '../providers/slot-registry.js';
import { isProviderId } from '../contracts/management.js';

export const TRIAL_CONFIG_VERSION = 1;
export type TrialOperation = 'asr' | 'dialogue' | 'memory_turn' | 'summary' | 'perception' | 'tts' | 'admission';
export interface TrialModel {
  /** Free-form provider identity; presets stay 'dashscope'/'deepseek', custom endpoints may use any id. */
  readonly provider: string;
  /** The wire protocol the composition root actually instantiates for this model. */
  readonly protocol?: 'openai-compatible' | 'gemini';
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
  readonly desktopHost?: 'macos' | 'electron';
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
  if (c.desktopHost !== undefined && !['macos', 'electron'].includes(c.desktopHost)) fail('Unknown desktop host.');
  const required = ['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js',
    ...(c.desktopHost === 'electron' ? ['desktop/electron/main.mjs', 'desktop/electron/preload.cjs', 'desktop/electron/transport.mjs', 'desktop/electron/layout.mjs', 'desktop/electron/assets.mjs', 'tools/management-url.mjs'] : ['desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'])];
  if (!c.runtimeFiles || typeof c.runtimeFiles !== 'object' || Array.isArray(c.runtimeFiles)
    || required.some(path => !c.runtimeFiles[`code/desktop-pet/${path}`])) fail('试用构建版本尚未登记。');
  for (const [path, digest] of Object.entries(c.runtimeFiles)) {
    if (!path.startsWith('code/desktop-pet/') || path.includes('\\') || path.includes(':') || path.split('/').some(part => !part || part === '..' || part === '.')
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
    // Endpoint may be any HTTPS origin or an explicit loopback HTTP; the key never reaches a redirected
    // other host. This removes the per-supplier endpoint white-list so a custom endpoint is accepted.
    if (!isAllowedEndpoint(m.endpoint)) fail('模型服务地址必须是 HTTPS 或显式回环 HTTP，不能交给重定向后的其他主机。');
    // Memory no longer requires a specific vendor: the strict plan-parsing, source validation and commit
    // semantics are preserved in the strict memory provider; only the model-call adapter is swapped.
    // FIX61-01: no vendor or model-name white-list. Every slot accepts a custom model on an implemented
    // protocol; only the protocol capability, the endpoint origin, the credential binding and the usage
    // bounds are enforced. A price may be unknown, but it must never be silently treated as free.
    if (!isProviderId(m.provider)) fail('模型供应商标识无效。');
    if (m.protocol !== undefined && !['openai-compatible', 'gemini'].includes(m.protocol)) fail('模型协议未登记。');
    if (![m.inputMicrosPerToken, m.outputMicrosPerToken].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) fail('模型计费口径未配置。');
    // Audio slots need a real per-second rate; a text model cannot claim an audio slot without one.
    if (operation === 'asr' && !(typeof m.audioMicrosPerSecond === 'number' && Number.isFinite(m.audioMicrosPerSecond) && m.audioMicrosPerSecond >= 0)) fail('语音转写缺少音频时长费率。');
    if (operation !== 'tts' && operation !== 'asr') {
      if (!positive(m.inputTokenLimit) || !positive(m.outputTokenLimit)) fail('模型输入输出硬上限未登记。');
      const maximum = Math.ceil(m.inputTokenLimit * m.inputMicrosPerToken + m.outputTokenLimit * m.outputMicrosPerToken);
      if (!Number.isSafeInteger(maximum)) fail('费用估计数值无效。');
      if (!unlimited&&m.reservationMicros < maximum) fail('调用预留不足以覆盖登记的最坏费用。');
    }
    if (operation === 'tts' && !(typeof m.characterMicros === 'number' && Number.isFinite(m.characterMicros) && m.characterMicros > 0)) fail('语音计费口径未配置。');
    // FIX61-01: the MiniMax model/rate pairing and the memory thinking mode are capability parameters of
    // the selected adapter, not name-based admission gates; the adapter still validates its own wire.
    if (m.thinking !== undefined && operation !== 'memory_turn') fail('模型思考配置不受当前适配器支持。');
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
