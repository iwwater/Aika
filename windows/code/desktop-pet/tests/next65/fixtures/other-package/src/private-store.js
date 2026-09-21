/**
 * K65-01 (01-C): the third negative-fixture target, which `src/host-reach-through.ts` reaches for.
 *
 * This file is a plausible PRIVATE module of another capability package — not its public entry and
 * not something a sibling package is allowed to address. It must exist on disk because 01-C asserts a
 * BEHAVIORAL rejection: the boundary check has to resolve the specifier to a real file that really
 * lives under another package's root and then refuse it. Refusing a path that does not exist would
 * only prove "no such file", which 01-C is not claiming.
 *
 * Excluded from the host compile (tsconfig excludes tests/next65/fixtures/**).
 */
// Re-exported (not `import`ed) so the edge is visible to plugins/esm-graph.mjs — see the 01-C report.
export { STORE_DIALECT } from './private-keys.js';

/** The host Microsoft Store override table. A package reading it directly bypasses the host. */
const OVERRIDES = new Map([
  ['aika.default', 'Microsoft Huihui Desktop'],
  ['aika.local', 'Microsoft Kangkang Desktop'],
]);

export function readHostSecret(key) {
  return OVERRIDES.get(key) ?? null;
}

export const PRIVATE_STORE_VERSION = '1.0.0';
