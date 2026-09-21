/**
 * K65-01 01-C: the `createRequire` escape, as its own fixture file.
 *
 * A runtime-provided `require` can address a host path the static graph cannot follow, so the
 * boundary check refuses it outright. Authored as plain `.mjs` because it is a fixture, excluded from
 * both the host compile and the fixture project's `include: ["src/**\/*.ts"]`.
 *
 * `tests/next65/dependencyBoundary.test.ts` asserts the check's real rejection payload for this file.
 */
import { createRequire } from 'node:module';

// >>> THE ESCAPE UNDER TEST <<<
const require = createRequire(import.meta.url);

/** Reaches the host's compiled contracts barrel through the host's own module loader. */
export function readHostContractVersion() {
  return require('../../../../../dist/contracts/index.js').CONTRACT_VERSION;
}
