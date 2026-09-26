/**
 * K65-01 01-C negative fixture: a reach-through written as a PLAIN `import … from` binding.
 *
 * This is the shape `src/host-reach-through.ts` had to avoid. That file is deliberately written as
 * `export … from` re-exports and a dynamic `import()` because `extractSpecifiers` used to return `[]`
 * for every `import … from '…'` form — a reach-through written as an ordinary binding slipped past
 * `checkImportBoundary` with `ok: true`, which made 01-C's refusal hollow.
 *
 * Every binding below is therefore the exact syntax the scanner used to be blind to, and each target
 * is a REAL file on disk (the compiled host runtime trees and another package's private source), so a
 * refusal here means "this import really addresses a private path outside the package" — not merely
 * "no such file".
 *
 * `.mjs` on purpose: the fixture project's tsconfig is `include: ["src/**\/*.ts"]`, so this file can
 * never join the build whose success is 01-C's positive claim. Like `host-reach-through.ts` it is
 * only ever fed to the boundary check.
 */
import { CONTRACT_VERSION } from '../../../../../dist/contracts/index.js';
import ProviderRegistry from '../../../../../dist/providers/slot-registry.js';
import * as privateStore from '../../other-package/src/private-store.js';
import { readHostSecret as alias } from '../../other-package/src/private-store.js';
import 'node:fs'; // a legal, allowed edge: proves the refusal below is about the others, not about `import` in general

export const plainReachThrough = {
  contractVersion: CONTRACT_VERSION,
  registry: Boolean(ProviderRegistry),
  dialect: privateStore.STORE_DIALECT,
  alias: typeof alias,
};
