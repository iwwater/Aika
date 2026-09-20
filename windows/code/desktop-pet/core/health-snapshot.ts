// FIX61-07: evidence-based module health.
//
// The whole point of this module is that "the endpoint answered" is NOT "the module works". A light may
// only be green when the CURRENT configuration has actual operational evidence or an equivalent
// capability self-check. Reachability, a stored credential, or a past success are all weaker claims and
// are represented as such.
import type { ProviderSlot } from '../contracts/management.js';

export type HealthState = 'unknown' | 'checking' | 'ready' | 'degraded' | 'failed' | 'disabled';

/**
 * Three independent claims. They are deliberately not collapsed into one boolean:
 *  - configured:  a credential/endpoint/model binding exists for this slot.
 *  - reachable:   the endpoint answered a non-billable request (e.g. a model list).
 *  - operational: real work actually succeeded with this configuration, or an equivalent capability
 *                 self-check passed. ONLY this (or 'self_check') may justify a green light.
 */
export interface HealthEvidence {
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly operational: boolean;
  /** A local capability self-check (e.g. SQLite integrity, a reference file being decodable). */
  readonly selfCheck?: boolean;
}
export const HEALTH_GREEN_EVIDENCE: readonly (keyof HealthEvidence)[] = Object.freeze(['operational', 'selfCheck']);

export interface HealthObservation {
  readonly module: string;
  readonly evidence: HealthEvidence;
  readonly reasonCode: string | null;
  readonly repairAction: string | null;
}

export interface ModuleHealth extends HealthObservation {
  readonly state: HealthState;
  readonly checkedAt: string;
  readonly configRevision: number;
  readonly providerSlot?: ProviderSlot;
  readonly stale: boolean;
}

export interface HealthSnapshot {
  readonly configRevision: number;
  readonly observedAt: string;
  readonly modules: Readonly<Record<string, ModuleHealth>>;
}

/** How long a green light may be shown as current before it must be re-verified. */
export const HEALTH_STALENESS_MS = 30_000;
export const healthStalenessMs = (): number => HEALTH_STALENESS_MS;

/**
 * Failure reason codes that force a red light regardless of other evidence: these are states where the
 * configuration itself is unusable, not merely unverified.
 */
const FATAL_REASONS = new Set(['schema_mismatch', 'credential_unavailable', 'database_unavailable', 'engine_failed']);

const green = (evidence: HealthEvidence): boolean =>
  evidence.operational === true || evidence.selfCheck === true;

/** The honest reason for a non-green light when the caller did not name one. */
function defaultReason(state: HealthState, evidence: HealthEvidence): string {
  if (state === 'checking') return 'checking';
  if (!evidence.configured) return 'not_configured';
  if (!evidence.reachable) return 'endpoint_unreachable';
  return 'inference_unverified';
}
function defaultRepair(state: HealthState, evidence: HealthEvidence): string {
  if (state === 'checking') return '正在检查，请稍候。';
  if (!evidence.configured) return '请在配置页为此模块保存服务地址、模型与凭据。';
  if (!evidence.reachable) return '请检查服务地址、网络与该服务的可用性后重新检查。';
  return '端点可访问，但尚未确认该模型能完成实际推理；请发起一次真实请求。';
}

/**
 * In-process health registry. It records what actually happened; it never probes a paid endpoint on a
 * timer, and it never turns a light green on its own.
 */
export class ModuleHealthRegistry {
  #modules = new Map<string, ModuleHealth>();
  constructor(private configRevision: number, private readonly clock: () => number = () => Date.now()) {}

  /** A configuration change invalidates every previous observation: they belong to another revision. */
  reconfigure(configRevision: number): void {
    if (!Number.isSafeInteger(configRevision) || configRevision < 0) throw new Error('invalid_config_revision');
    this.configRevision = configRevision;
  }

  observe(module: string, observation: HealthObservation, at: number = this.clock()): ModuleHealth {
    if (!module.trim()) throw new Error('invalid_health_module');
    const evidence: HealthEvidence = Object.freeze({
      configured: observation.evidence.configured === true,
      reachable: observation.evidence.reachable === true,
      operational: observation.evidence.operational === true,
      ...(observation.evidence.selfCheck === undefined ? {} : { selfCheck: observation.evidence.selfCheck === true })
    });
    let state: HealthState;
    if (observation.reasonCode !== null && FATAL_REASONS.has(observation.reasonCode)) state = 'failed';
    else if (observation.reasonCode === 'disabled') state = 'disabled';
    else if (observation.reasonCode === 'checking') state = 'checking';
    else if (!evidence.configured) state = 'unknown';
    else if (green(evidence)) state = 'ready';
    // Configured but unverified (missing reachability, or reachable without operational proof): the light
    // is yellow. This is the case the original TODO complained about — a model list must not look green.
    else state = 'degraded';
    // A non-green light must always be explainable: if the caller supplied no reason, derive the honest
    // one from the evidence rather than showing a colour with no explanation behind it.
    const reasonCode = observation.reasonCode ?? (state === 'ready' ? null : defaultReason(state, evidence));
    const repairAction = observation.repairAction ?? (state === 'ready' ? null : defaultRepair(state, evidence));
    const health: ModuleHealth = Object.freeze({
      ...observation, evidence, state, reasonCode, repairAction, checkedAt: new Date(at).toISOString(), configRevision: this.configRevision, stale: false
    });
    this.#modules.set(module, health);
    return health;
  }

  /** Marks a module as actively being checked without inventing a result. */
  checking(module: string, reasonCode = 'checking'): ModuleHealth {
    const prior = this.#modules.get(module);
    return this.observe(module, {
      module, evidence: prior?.evidence ?? { configured: false, reachable: false, operational: false },
      reasonCode, repairAction: prior?.repairAction ?? null
    });
  }

  snapshot(at: number = this.clock()): HealthSnapshot {
    const modules: Record<string, ModuleHealth> = {};
    for (const [id, health] of this.#modules) {
      // A result from another config revision is not valid for this one; it is reported, but not as green.
      const foreignRevision = health.configRevision !== this.configRevision;
      const stale = foreignRevision || at - Date.parse(health.checkedAt) > HEALTH_STALENESS_MS;
      modules[id] = Object.freeze({
        ...health,
        stale,
        state: stale && health.state === 'ready' ? 'degraded' : health.state,
        reasonCode: stale && health.state === 'ready'
          ? (foreignRevision ? 'config_changed' : 'stale_check')
          : health.reasonCode
      });
    }
    return Object.freeze({ configRevision: this.configRevision, observedAt: new Date(at).toISOString(), modules: Object.freeze(modules) });
  }

  /** Repair entry point for a light: what the user can actually do about it. */
  repair(module: string): { reasonCode: string | null; repairAction: string | null } {
    const health = this.#modules.get(module);
    return { reasonCode: health?.reasonCode ?? null, repairAction: health?.repairAction ?? null };
  }
}

/** Maps an observed provider call result onto operational evidence without over-claiming. */
export function evidenceFromCall(result: { sent: boolean; success: boolean; cancelled?: boolean }): HealthEvidence {
  return {
    configured: true,
    // A request that was sent and answered proves reachability even when the model then failed.
    reachable: result.sent,
    operational: result.sent && result.success && !result.cancelled
  };
}
