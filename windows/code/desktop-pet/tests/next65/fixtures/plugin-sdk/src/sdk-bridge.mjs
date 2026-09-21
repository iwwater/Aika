/**
 * K65-01 01-C: the compliant entry the boundary check is pointed at for its POSITIVE case.
 *
 * Two legal edges and nothing else: one relative edge INSIDE the package (a package may import its
 * own files) and one bare `aika-plugin-sdk` edge (the published SDK, declared as a dependency).
 * Both forms are the ones the shared scanner actually sees — see `src/index.ts`'s note on why the
 * plain `import … from` form is not used here.
 *
 * `.mjs`, so `include: ["src/**\/*.ts"]` leaves it out of the fixture project's own tsc run; the
 * boundary check is what consumes it.
 */
export { FIXTURE_NOTE, packageLocalNote } from './local/helper.mjs';
export { CAPABILITY_CONTRACT_VERSION, PLUGIN_API_VERSION } from 'aika-plugin-sdk';
