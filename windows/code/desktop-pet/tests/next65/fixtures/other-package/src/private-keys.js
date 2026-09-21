/**
 * K65-01 (01-C): another private module of another capability package.
 *
 * It is reached only TRANSITIVELY — `src/private-store.js` imports it — so the boundary check has to
 * walk past the first hop to see it. A check that only inspected the fixture's own specifiers would
 * never classify this file, which is exactly why 01-C asserts on the walked file set too.
 *
 * Excluded from the host compile (tsconfig excludes tests/next65/fixtures/**).
 */
export const STORE_DIALECT = 'sqlite';

export function openPrivateTable(name) {
  return `aika_private.${name}`;
}
