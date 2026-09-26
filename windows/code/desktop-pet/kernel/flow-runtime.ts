import { checkAbort } from '../media/scope.js';
import { validateFlowProfile, type ConditionGroup, type FlowNode, type FlowProfile, type Rule } from '../contracts/flow-profile.js';

export interface FlowStageContext {
  readonly profile: Readonly<FlowProfile>;
  readonly node: Readonly<FlowNode>;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly sourceRevisions: ReadonlyMap<string, number>;
  readonly assertSourcesCurrent: () => void;
}

export interface FlowStageHandler {
  readonly capabilityId: string;
  readonly bindingId: string;
  readonly execute: (context: FlowStageContext, signal: AbortSignal) => Promise<Readonly<Record<string, unknown>>>;
}

export interface FlowRunInput {
  readonly values?: Readonly<Record<string, unknown>>;
  readonly sourceRevisions?: ReadonlyMap<string, number>;
  readonly isSourceCurrent?: (sourceId: string, revision: number) => boolean;
  readonly signal?: AbortSignal;
}

export interface FlowDiagnostic {
  readonly nodeId: string;
  readonly status: 'started' | 'completed' | 'skipped' | 'failed';
  readonly detail?: string;
}

export interface FlowRunResult {
  readonly status: 'completed' | 'partial';
  readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly diagnostics: readonly FlowDiagnostic[];
}

export class FlowProfileError extends Error {
  constructor(readonly issues: readonly { readonly path: string; readonly detail: string }[]) {
    super(`Invalid flow profile: ${issues.map(issue => `${issue.path}: ${issue.detail}`).join('; ')}`);
    this.name = 'FlowProfileError';
  }
}

export class FlowExecutionError extends Error {
  constructor(readonly nodeId: string, message: string, readonly diagnostics: readonly FlowDiagnostic[]) {
    super(message); this.name = 'FlowExecutionError';
  }
}

/**
 * K65-07 executor. It only understands the public Flow Profile graph and a handler registry;
 * package IDs and private module paths never enter dispatch. Read-only stages may run together,
 * while every side-effecting stage is serialized in profile order.
 */
export class FlowRuntime {
  private readonly handlers = new Map<string, FlowStageHandler>();

  constructor(handlers: readonly FlowStageHandler[]) {
    for (const handler of handlers) {
      const key = handlerKey(handler.capabilityId, handler.bindingId);
      if (this.handlers.has(key)) throw new Error(`duplicate flow handler ${key}`);
      this.handlers.set(key, handler);
    }
  }

  validate(profile: FlowProfile): readonly { readonly path: string; readonly detail: string }[] {
    const issues = [...validateFlowProfile(profile)];
    const nodes = new Map(profile.nodes.map(node => [node.nodeId, node] as const));
    for (const [index, node] of profile.nodes.entries()) {
      const names = new Set<string>();
      for (const [outputIndex, output] of node.outputs.entries()) {
        if (names.has(output.name)) issues.push({ path: `nodes[${index}].outputs[${outputIndex}].name`, detail: `duplicate output ${output.name}` });
        names.add(output.name);
      }
      if (node.kind === 'capability') {
        if (!node.capabilityId) issues.push({ path: `nodes[${index}].capabilityId`, detail: 'capability node requires a capabilityId' });
        if (!node.bindingId) issues.push({ path: `nodes[${index}].bindingId`, detail: 'capability node requires an explicit bindingId' });
        if (node.capabilityId && node.bindingId && !this.handlers.has(handlerKey(node.capabilityId, node.bindingId))) {
          issues.push({ path: `nodes[${index}].bindingId`, detail: `no registered handler for ${node.capabilityId}/${node.bindingId}` });
        }
      }
      for (const [inputIndex, input] of node.inputs.entries()) {
        if (!input.from) continue;
        const match = /^([^\.]+)\.([^\.]+)$/.exec(input.from);
        const source = match ? nodes.get(match[1]!) : undefined;
        if (!source) issues.push({ path: `nodes[${index}].inputs[${inputIndex}].from`, detail: `unknown output source ${input.from}` });
        else if (!source.outputs.some(output => output.name === match![2])) issues.push({ path: `nodes[${index}].inputs[${inputIndex}].from`, detail: `output ${input.from} is not declared` });
      }
      for (const rule of node.condition?.rules ?? []) {
        if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(rule.left)) issues.push({ path: `nodes[${index}].condition`, detail: `rule path ${rule.left} is outside the declared namespace` });
      }
    }
    return issues;
  }

  preview(profile: FlowProfile): readonly { readonly nodeId: string; readonly capabilityId: string | null; readonly dependsOn: readonly string[] }[] {
    const issues = this.validate(profile); if (issues.length) throw new FlowProfileError(issues);
    return profile.nodes.map(node => ({ nodeId: node.nodeId, capabilityId: node.capabilityId, dependsOn: [...node.dependsOn] }));
  }

  async run(profileInput: FlowProfile, input: FlowRunInput = {}): Promise<FlowRunResult> {
    const issues = this.validate(profileInput); if (issues.length) throw new FlowProfileError(issues);
    const profile = deepFreeze(structuredClone(profileInput));
    const signal = input.signal ?? new AbortController().signal;
    const sourceRevisions = new Map(input.sourceRevisions ?? []);
    const diagnostics: FlowDiagnostic[] = [];
    const outputs = new Map<string, Readonly<Record<string, unknown>>>();
    const nodes = new Map(profile.nodes.map(node => [node.nodeId, node] as const));
    const pending = new Set(profile.nodes.map(node => node.nodeId));
    const failedNodes = new Set<string>();
    let partial = false;
    const assertSourcesCurrent = (): void => {
      for (const [sourceId, revision] of sourceRevisions) if (input.isSourceCurrent && !input.isSourceCurrent(sourceId, revision)) throw new Error(`stale context source ${sourceId}@${revision}`);
    };
    const executeOne = async (node: FlowNode): Promise<void> => {
      checkAbort(signal);
      assertSourcesCurrent();
      if (node.condition && !evaluateCondition(node.condition, { ...input.values, ...flattenOutputs(outputs) })) {
        diagnostics.push({ nodeId: node.nodeId, status: 'skipped', detail: 'condition=false' }); return;
      }
      const stageInputs = Object.fromEntries(node.inputs.map(item => [item.name, item.from ? resolvePath(outputs, item.from) : input.values?.[item.name]]));
      const missing = node.inputs
        .filter(item => item.required && (stageInputs[item.name] === undefined || stageInputs[item.name] === null))
        .map(item => item.name);
      const blockedBy = node.inputs
        .filter(item => item.required && item.from && failedNodes.has(item.from.split('.')[0]!))
        .map(item => item.from!);
      if (missing.length || blockedBy.length) {
        const detail = blockedBy.length
          ? `required input depends on failed stage: ${blockedBy.join(', ')}`
          : `required input is missing: ${missing.join(', ')}`;
        diagnostics.push({ nodeId: node.nodeId, status: 'failed', detail });
        throw new FlowExecutionError(node.nodeId, detail, diagnostics);
      }
      diagnostics.push({ nodeId: node.nodeId, status: 'started' });
      try {
        let result: Readonly<Record<string, unknown>> = {};
        if (node.kind === 'capability') {
          const handler = this.handlers.get(handlerKey(node.capabilityId!, node.bindingId!))!;
          result = await handler.execute({ profile, node, inputs: stageInputs, sourceRevisions, assertSourcesCurrent }, signal);
        }
        checkAbort(signal); assertSourcesCurrent();
        outputs.set(node.nodeId, Object.freeze({ ...result }));
        diagnostics.push({ nodeId: node.nodeId, status: 'completed' });
      } catch (error) {
        diagnostics.push({ nodeId: node.nodeId, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
        failedNodes.add(node.nodeId);
        const requiredDependent = profile.nodes.some(candidate => candidate.inputs.some(item => item.required && item.from?.startsWith(`${node.nodeId}.`)));
        if ((profile.failurePolicy.onStageFailure === 'skip_optional' || profile.failurePolicy.onStageFailure === 'report_partial') && !requiredDependent) { partial = true; return; }
        throw new FlowExecutionError(node.nodeId, error instanceof Error ? error.message : String(error), diagnostics);
      }
    };
    while (pending.size) {
      checkAbort(signal);
      const ready = profile.nodes.filter(node => pending.has(node.nodeId) && node.dependsOn.every(dependency => !pending.has(dependency)));
      if (!ready.length) throw new FlowExecutionError('graph', 'flow graph has no executable node', diagnostics);
      const readonlyReady = ready.filter(node => node.sideEffect === 'none' || node.sideEffect === 'local_read');
      const batch = readonlyReady.length ? readonlyReady : [ready[0]!];
      if (batch.length > 1) await Promise.all(batch.map(executeOne)); else await executeOne(batch[0]!);
      for (const node of batch) pending.delete(node.nodeId);
    }
    return { status: partial ? 'partial' : 'completed', outputs: Object.fromEntries(outputs), diagnostics };
  }
}

function handlerKey(capabilityId: string, bindingId: string): string { return `${capabilityId}::${bindingId}`; }
function resolvePath(outputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>, path: string): unknown { const match = /^([^\.]+)\.([^\.]+)$/.exec(path); return match ? outputs.get(match[1]!)?.[match[2]!] : undefined; }
function flattenOutputs(outputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>): Record<string, unknown> { return Object.fromEntries([...outputs].map(([id, value]) => [id, value])); }
function evaluateCondition(group: ConditionGroup, values: Readonly<Record<string, unknown>>): boolean {
  const results = group.rules.map(rule => compare(resolveRulePath(values, rule.left), rule));
  return group.mode === 'all' ? results.every(Boolean) : results.some(Boolean);
}
function resolveRulePath(values: Readonly<Record<string, unknown>>, path: string): unknown { return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, values); }
function compare(actual: unknown, rule: Rule): boolean {
  if (rule.operator === 'exists') return actual !== undefined && actual !== null;
  if (rule.operator === 'not_exists') return actual === undefined || actual === null;
  if (rule.operator === 'equals') return actual === rule.right;
  if (rule.operator === 'not_equals') return actual !== rule.right;
  if (rule.operator === 'greater_than') return typeof actual === 'number' && typeof rule.right === 'number' && actual > rule.right;
  if (rule.operator === 'less_than') return typeof actual === 'number' && typeof rule.right === 'number' && actual < rule.right;
  const values = Array.isArray(rule.right) ? rule.right : [];
  return rule.operator === 'in' ? values.includes(actual as never) : !values.includes(actual as never);
}
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
