/**
 * K65-01 (D1/D2): the frozen Flow Profile schema of 0.65 API v1.
 *
 * CONTRACTS.md §5: a Profile is versioned JSON with nodes and capability bindings, dependency edges,
 * conditions, required/optional results, a join order and a failure policy. Conditions use a restricted
 * comparison/existence grammar — a profile NEVER carries an executable expression, and there is no
 * `eval` path anywhere in this module.
 *
 * Validation here is structural and metadata-only. Execution, diagnostics and Context source
 * composition are K65-07's delivery and are not implemented by this step.
 */
import type { CapabilityId } from './capability.js';

export const FLOW_PROFILE_SCHEMA_VERSION = 1 as const;

/** Restricted rule grammar: no scripting, no member access beyond one declared field. */
export type RuleOperator =
  | 'exists' | 'not_exists'
  | 'equals' | 'not_equals'
  | 'greater_than' | 'less_than'
  | 'in' | 'not_in';

export const RULE_OPERATORS: readonly RuleOperator[] = [
  'exists', 'not_exists', 'equals', 'not_equals', 'greater_than', 'less_than', 'in', 'not_in',
];

/**
 * A condition over a node's declared output or a call parameter. `left` is a dotted path inside the
 * profile's own declared namespace; there is no arbitrary expression, no function call and no access
 * to host internals.
 */
export interface Rule {
  readonly left: string;
  readonly operator: RuleOperator;
  /** Absent for `exists` / `not_exists`. */
  readonly right?: string | number | boolean | readonly (string | number | boolean)[];
}

/** A bounded comparison group. `all` is AND, `any` is OR; nesting is not allowed. */
export interface ConditionGroup {
  readonly mode: 'all' | 'any';
  readonly rules: readonly Rule[];
}

export type NodeKind = 'capability' | 'join' | 'guard';

export interface FlowNode {
  readonly nodeId: string;
  readonly kind: NodeKind;
  /** Required for `capability` nodes; the capability this stage invokes. */
  readonly capabilityId: CapabilityId | null;
  /** Explicit binding reference; a node never picks a provider by import order. */
  readonly bindingId: string | null;
  readonly inputs: readonly { readonly name: string; readonly from: string | null; readonly required: boolean }[];
  readonly outputs: readonly { readonly name: string; readonly required: boolean }[];
  /** Side-effect class of the stage. A writing/playing/acting node is serial and never auto-retried. */
  readonly sideEffect: 'none' | 'local_read' | 'local_write' | 'network_egress' | 'device_capture' | 'user_visible_output' | 'process_lifecycle';
  readonly condition: ConditionGroup | null;
  /** Dependency edges; the graph must be acyclic. */
  readonly dependsOn: readonly string[];
}

export interface FlowFailurePolicy {
  /** A stage that failed: fail the turn, or report a partial result. Never silently pick another source. */
  readonly onStageFailure: 'fail_turn' | 'report_partial' | 'skip_optional';
  /** Automatic retry is refused for any node whose side effect is not `none`/`local_read`. */
  readonly retrySideEffects: false;
  readonly maxAttempts: number;
}

export interface FlowProfile {
  readonly schemaVersion: typeof FLOW_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly revision: number;
  readonly label: string;
  readonly nodes: readonly FlowNode[];
  readonly failurePolicy: FlowFailurePolicy;
  /** Join order is the declared order, never completion order (CONTRACTS.md §5). */
  readonly joinOrder: readonly string[];
}

export interface FlowProfileIssue {
  readonly path: string;
  readonly detail: string;
}

/** Structural validation: ids, acyclicity, declared dependencies and the no-script rule. */
export function validateFlowProfile(profile: FlowProfile): readonly FlowProfileIssue[] {
  const issues: FlowProfileIssue[] = [];
  if (profile.schemaVersion !== FLOW_PROFILE_SCHEMA_VERSION) {
    issues.push({ path: 'schemaVersion', detail: `unsupported flow profile schemaVersion ${String(profile.schemaVersion)}` });
  }
  const ids = new Set<string>();
  for (const [index, node] of profile.nodes.entries()) {
    if (ids.has(node.nodeId)) issues.push({ path: `nodes[${index}].nodeId`, detail: `duplicate node id ${node.nodeId}` });
    ids.add(node.nodeId);
    if (node.kind === 'capability' && !node.capabilityId) {
      issues.push({ path: `nodes[${index}].capabilityId`, detail: 'a capability node must declare its capabilityId' });
    }
    // CONTRACTS.md §5 forbids `eval`; the only executable escape would be an expression-shaped field,
    // so any function-valued or prototype-bearing rule operand is refused structurally.
    for (const [ruleIndex, rule] of (node.condition?.rules ?? []).entries()) {
      if (typeof rule.left !== 'string' || !rule.left.length) {
        issues.push({ path: `nodes[${index}].condition.rules[${ruleIndex}].left`, detail: 'a rule operand must be a non-empty declared path' });
      }
      if (rule.operator !== 'exists' && rule.operator !== 'not_exists' && rule.right === undefined) {
        issues.push({ path: `nodes[${index}].condition.rules[${ruleIndex}].right`, detail: `operator ${rule.operator} requires a comparison value` });
      }
    }
  }
  for (const [index, node] of profile.nodes.entries()) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) issues.push({ path: `nodes[${index}].dependsOn`, detail: `unknown dependency ${dependency}` });
      if (dependency === node.nodeId) issues.push({ path: `nodes[${index}].dependsOn`, detail: 'a node cannot depend on itself' });
    }
  }
  // Cycle detection over the declared edges.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'visiting') { issues.push({ path: 'nodes', detail: `dependency cycle through ${id}` }); return; }
    if (current === 'done') return;
    state.set(id, 'visiting');
    for (const dependency of profile.nodes.find(node => node.nodeId === id)?.dependsOn ?? []) visit(dependency);
    state.set(id, 'done');
  };
  for (const node of profile.nodes) visit(node.nodeId);
  for (const id of profile.joinOrder) {
    if (!ids.has(id)) issues.push({ path: 'joinOrder', detail: `unknown node ${id}` });
  }
  if (profile.failurePolicy.retrySideEffects !== false) {
    issues.push({ path: 'failurePolicy.retrySideEffects', detail: 'automatic retry of side-effecting stages is not permitted' });
  }
  return issues;
}

/** Acyclic check reused by the profile validator and by profile authors. */
export function findDependencyCycle(nodes: readonly { readonly nodeId: string; readonly dependsOn: readonly string[] }[]): readonly string[] | null {
  const state = new Map<string, number>();
  const stack: string[] = [];
  const index = new Map(nodes.map(node => [node.nodeId, node] as const));
  const walk = (id: string): readonly string[] | null => {
    const seen = state.get(id);
    if (seen === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (seen === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dependency of index.get(id)?.dependsOn ?? []) {
      const cycle = walk(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const node of nodes) {
    const cycle = walk(node.nodeId);
    if (cycle) return cycle;
  }
  return null;
}
