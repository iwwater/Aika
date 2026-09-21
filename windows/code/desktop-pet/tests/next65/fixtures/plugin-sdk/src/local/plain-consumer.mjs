/**
 * K65-01 01-C: the POSITIVE comparator for the plain-import negative fixture.
 *
 * `src/host-reach-through-plain.mjs` proves a plain `import … from` reach-through is refused. On its
 * own that could mean "the scanner now refuses anything written as a plain import". This file is the
 * control that rules that out: the SAME syntax, pointed at a file INSIDE the package, stays allowed.
 *
 * Syntax is therefore NOT the discriminator — the boundary is.
 *
 * `.mjs`, so `include: ["src/**\/*.ts"]` leaves it out of the fixture project's own tsc run.
 */
import { FIXTURE_NOTE } from './helper.mjs';

export const plainConsumerNote = FIXTURE_NOTE;
