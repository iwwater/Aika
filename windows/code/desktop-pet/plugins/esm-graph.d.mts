// K65-01: the type surface of `esm-graph.mjs`.
//
// The walker is plain `.mjs` on purpose — the emitted SDK and the third-party fixture project must be
// able to load it without a compiler — so TypeScript needs this sibling declaration to type the
// `./esm-graph.mjs` import instead of silently falling back to `any` (or to the ambient
// `declare module '*.mjs'` in tests/desktop/desktop-modules.d.ts, which is a test tree the SDK
// artifact cannot see). It is copied into the emitted SDK next to the `.mjs` so a package project
// compiling against the artifact alone resolves it without any extra compiler flag.
//
// The signatures mirror the implementation exactly; `esm-graph.mjs` stays the only implementation.

/** Enum-like dependency kinds, exported so a consumer can label a specifier without re-deriving it. */
export const SPECIFIER_KINDS: {
  readonly relative: 'relative';
  readonly absolute: 'absolute';
  readonly builtin: 'builtin';
  readonly bare: 'bare';
};

/** Thrown when a specifier cannot be parsed at all; callers turn this into a boundary violation. */
export class DependencyParseError extends Error {
  constructor(message: string);
}

/** Extracts every static and dynamic module specifier from ESM/JS source. */
export function extractSpecifiers(source: string): string[];

/** True for a specifier the boundary check must ignore because it is not a filesystem module. */
export function isExternalSpecifier(specifier: string): boolean;

/** True when `child` is `parent` itself or lives underneath it, comparing on separator boundaries. */
export function isInside(child: string, parent: string): boolean;

/**
 * Walks the relative-import graph reachable from `entry`. Returns the visited absolute files, the
 * relative edges that could not be resolved, and each file's raw specifiers so callers can render a
 * precise violation instead of "something was wrong somewhere".
 */
export function walkModuleGraph(entryPath: string, options?: { readonly maxFiles?: number }): {
  readonly entry: string;
  readonly files: readonly { readonly path: string; readonly specifiers: readonly string[] }[];
  readonly unresolved: readonly { readonly from: string; readonly specifier: string; readonly reason: string }[];
};
