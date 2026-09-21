/**
 * K65-01 01-C: a compliant intra-package dependency edge.
 *
 * The shared scanner cannot resolve a relative specifier that points at a TypeScript source (its
 * candidate list is .mjs/.js/.cjs/.json/index.*), so a `.ts`-only fixture would give the boundary
 * check nothing but bare specifiers to classify — and "no violations" over an empty edge set would be
 * vacuous. This module supplies a real, resolvable, INSIDE-the-package relative edge for the positive
 * case. It is authored as `.mjs` because it is a fixture and is excluded from the host compile.
 */
export const FIXTURE_NOTE = 'a package may import its own files';

export function packageLocalNote() {
  return FIXTURE_NOTE;
}
