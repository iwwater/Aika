import { MemoryRuleError } from './scope.js';

export const DAY_MS = 86_400_000;
export interface DynamicsParameters {
  readonly activityHalfLifeDays: number;
  readonly importanceMultiplier: number;
  readonly emotionHalfLifeDays: number;
  readonly reinforcementRate: number;
  readonly weights: { readonly baseline: number; readonly activity: number; readonly importance: number; readonly emotion: number };
  readonly threshold: number;
  readonly maxMemories: number;
}
export const DEFAULT_DYNAMICS: Readonly<DynamicsParameters> = Object.freeze({
  activityHalfLifeDays: 30, importanceMultiplier: 2, emotionHalfLifeDays: 7, reinforcementRate: 0.2,
  weights: Object.freeze({ baseline: 0.55, activity: 0.25, importance: 0.15, emotion: 0.05 }),
  threshold: 0.35, maxMemories: 6,
});
export function unit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new MemoryRuleError(`invalid_${name}`);
  return value;
}
/** Mathematical domain validation. Public tuning bounds are enforced by the policy boundary. */
export function validateDynamics(parameters: DynamicsParameters): void {
  for (const key of ['activityHalfLifeDays', 'emotionHalfLifeDays'] as const) {
    if (!Number.isFinite(parameters[key]) || parameters[key] <= 0) throw new MemoryRuleError(`invalid_${key}`);
  }
  if (!Number.isFinite(parameters.importanceMultiplier) || parameters.importanceMultiplier < 0) throw new MemoryRuleError('invalid_importanceMultiplier');
  unit(parameters.reinforcementRate, 'reinforcementRate'); unit(parameters.threshold, 'threshold');
  const weights = Object.values(parameters.weights);
  weights.forEach(value => unit(value, 'weight'));
  if (weights.length !== 4 || Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 1e-12) throw new MemoryRuleError('invalid_weight_sum');
  if (!Number.isSafeInteger(parameters.maxMemories) || parameters.maxMemories < 1) throw new MemoryRuleError('invalid_maxMemories');
}
export function decay(value: number, elapsedMs: number, halfLifeDays: number): number {
  unit(value, 'anchor');
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new MemoryRuleError('invalid_elapsed_time');
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) throw new MemoryRuleError('invalid_half_life');
  return value * 2 ** (-elapsedMs / DAY_MS / halfLifeDays);
}
export function evolve(input: { activity: number; emotion: number; importance: number; stable: boolean; elapsedMs: number }, parameters: DynamicsParameters = DEFAULT_DYNAMICS): { activity: number; emotion: number; halfLifeDays: number } {
  validateDynamics(parameters); unit(input.importance, 'importance'); unit(input.activity, 'activity');
  const halfLifeDays = parameters.activityHalfLifeDays * (1 + parameters.importanceMultiplier * input.importance);
  const activity = decay(input.activity, input.elapsedMs, halfLifeDays);
  return { activity: input.stable ? 1 : activity, emotion: decay(input.emotion, input.elapsedMs, parameters.emotionHalfLifeDays), halfLifeDays };
}
export function reinforceActivity(activity: number, rate = DEFAULT_DYNAMICS.reinforcementRate): number {
  unit(activity, 'activity'); unit(rate, 'reinforcementRate');
  return activity + rate * (1 - activity);
}
export function priority(input: { cue: number; activity: number; importance: number; emotion: number }, parameters: DynamicsParameters = DEFAULT_DYNAMICS): number {
  validateDynamics(parameters);
  Object.entries(input).forEach(([key, value]) => unit(value, key));
  const w = parameters.weights;
  return input.cue * (w.baseline + w.activity * input.activity + w.importance * input.importance + w.emotion * input.emotion);
}
export function reinforcementDay(at: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) throw new MemoryRuleError('invalid_timestamp');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
