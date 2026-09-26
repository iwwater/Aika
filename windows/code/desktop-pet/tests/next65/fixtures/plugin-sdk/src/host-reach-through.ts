/**
 * K65-01 01-C negative fixture: this file is NOT part of the fixture project's public surface.
 *
 * It exists to give the dependency-boundary check something real to refuse, and its three
 * reach-through targets are REAL FILES on disk (the compiled host runtime trees and another package's
 * private source), so a refusal here means "this import really addresses a private path outside the
 * package" and not merely "no such file".
 *
 * `tests/next65/dependencyBoundary.test.ts` runs the real `checkImportBoundary` against it and asserts
 * on that check's actual return payload — never on a grep of this source.
 *
 * It is excluded from the host tsconfig (`tests/next65/fixtures/**`).
 *
 * NOTE ON FORM: these are written as `export … from` re-exports and a dynamic `import()` rather than
 * as `import … from` bindings on purpose. `extractSpecifiers` in plugins/esm-graph.mjs currently
 * misses every `import … from '…'` form (see the report) — a reach-through written as a plain binding
 * would be invisible to the boundary check, and this file exists to be SEEN and refused, not to slip
 * past. Both forms below are ordinary ESM and both are real dependency edges.
 */

// @ts-expect-error 01-C: reaching the host's contracts barrel from a package is the violation under test.
export { CONTRACT_VERSION } from '../../../../../dist/contracts/index.js';
// @ts-expect-error 01-C: reaching the host's provider registry from a package is the violation under test.
export { ProviderRegistry } from '../../../../../dist/providers/slot-registry.js';
// @ts-expect-error 01-C: reaching another package's private store is the violation under test.
export { readHostSecret } from '../../other-package/src/private-store.js';

// A dynamic reach-through: the form a package uses when it wants the edge to survive bundling.
// @ts-expect-error 01-C: a lazy reach-through is still a reach-through.
export const lazyProviderSlot = await import('../../../../../dist/providers/slot-registry.js');

export const leaked = { leakedDynamically: Boolean(lazyProviderSlot) };
