import { MEMORY_POLICY_LIMITS, type MemoryDynamicsPolicy } from '../contracts/memory-dynamics.js';
import { DEFAULT_DYNAMICS, validateDynamics, type DynamicsParameters } from './dynamics.js';
import { MemoryRuleError } from './scope.js';

export function policyParameters(policy: MemoryDynamicsPolicy): DynamicsParameters {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new MemoryRuleError('invalid_policy');
  const keys = Object.keys(MEMORY_POLICY_LIMITS) as (keyof MemoryDynamicsPolicy)[];
  if (Object.keys(policy).length !== keys.length) throw new MemoryRuleError('invalid_policy');
  for (const key of keys) {
    const [min, max] = MEMORY_POLICY_LIMITS[key];
    if (!Number.isFinite(policy[key]) || policy[key] < min || policy[key] > max) throw new MemoryRuleError(`invalid_policy_${key}`);
  }
  const parameters: DynamicsParameters = { ...DEFAULT_DYNAMICS, activityHalfLifeDays: policy.baseHalfLifeDays,
    emotionHalfLifeDays: policy.emotionHalfLifeDays,
    weights: { baseline: policy.baselineWeight, activity: policy.activationWeight, importance: policy.importanceWeight, emotion: policy.emotionWeight } };
  validateDynamics(parameters); return parameters;
}
