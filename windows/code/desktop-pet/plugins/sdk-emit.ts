/**
 * K65-01 (D1, 01-C): publishes the minimal SDK artifact an independent package project compiles against.
 *
 * npm publication is explicitly not required (K65-01 §1). What is required is that a package project
 * can build against the SDK *on its own*, without the host's `tsconfig.json`, without the host's
 * `node_modules`, and without being able to reach any host private path. The emitted directory is that
 * artifact: the SDK's own `.ts` sources (copied, not re-exported through the host tree), a
 * self-contained `tsconfig.json`, a package descriptor and a declared public surface list.
 *
 * The fixture project under `tests/next65/fixtures/plugin-sdk/` compiles against exactly this output,
 * which is why 01-C's "independent fixture project compiles against the SDK only" is a real claim
 * about the artifact rather than about the host tree.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// Shared plain-.mjs graph walker; see plugins/boundary.ts for the same rationale.
import { extractSpecifiers, isExternalSpecifier, isInside } from './esm-graph.mjs';
import { PLUGIN_API_VERSION, MANIFEST_SCHEMA_VERSION, PLUGIN_SDK_SURFACE, type PluginIssue } from '../contracts/plugin.js';
import { CAPABILITY_CONTRACT_VERSION, REQUIRED_CAPABILITY_IDS } from '../contracts/capability.js';
import { PROVIDER_SOURCE_SCHEMA_VERSION } from '../contracts/provider-source.js';
import { FLOW_PROFILE_SCHEMA_VERSION } from '../contracts/flow-profile.js';

/**
 * The SDK modules, in dependency order: the four frozen contract modules, then the `plugins/` modules
 * that implement the validators, the packer and the boundary check `PLUGIN_SDK_SURFACE` declares.
 *
 * The emitted artifact keeps the `contracts/` and `plugins/` directory names instead of flattening
 * them: the copied sources import `../contracts/*.js` and `./*.js` relative to their own directory,
 * so preserving the layout is what keeps those specifiers resolvable inside the artifact without
 * rewriting a single import.
 */
export const SDK_MODULES: readonly string[] = [
  'contracts/capability.ts',
  'contracts/provider-source.ts',
  'contracts/plugin.ts',
  'contracts/flow-profile.ts',
  'plugins/paths.ts',
  'plugins/manifest.ts',
  'plugins/package-build.ts',
  'plugins/boundary.ts',
  'plugins/sdk-emit.ts',
];

/**
 * Runtime helpers the SDK build ships verbatim, because the host's build is TypeScript and a package
 * project must be able to load them without a compiler. The `.d.mts` rides along so TypeScript types
 * the `.mjs` import instead of falling back to `any`.
 */
export const SDK_RUNTIME_MODULES: readonly string[] = ['plugins/esm-graph.mjs', 'plugins/esm-graph.d.mts'];

export interface EmitSdkRequest {
  /** Host package root, i.e. the directory containing `contracts/` and `plugins/`. */
  readonly hostRoot: string;
  /** Directory the SDK is emitted into. Emptied first so a stale file cannot survive a rebuild. */
  readonly outputRoot: string;
}

export interface EmitSdkResult {
  readonly ok: boolean;
  readonly outputRoot: string;
  readonly files: readonly string[];
  readonly issues: readonly PluginIssue[];
  /** Every declaration in `PLUGIN_SDK_SURFACE` that the emitted sources actually declare. */
  readonly surface: readonly { readonly name: string; readonly declared: boolean; readonly file: string }[];
}

/**
 * The `plugins/` modules import `./esm-graph.mjs`, which the artifact ships under `runtime/`, so the
 * relative specifier they keep is not the one that resolves inside the artifact. Nothing else needs
 * rewriting: `../contracts/*.js` and the sibling `./paths.js` / `./manifest.js` edges survive because
 * the emitted tree keeps the same directory names.
 */
function sdkModuleSource(hostRoot: string, module: string): string {
  const source = readFileSync(resolve(hostRoot, module), 'utf8');
  return module.startsWith('plugins/')
    ? source.replace(/(['"])(?:\.\/|\.\.\/plugins\/)esm-graph\.mjs\1/g, '$1../runtime/esm-graph.mjs$1')
    : source;
}

/**
 * Writes the SDK artifact. The emitted SDK must be closed under its own imports, or a package project
 * would fail to compile for a reason that has nothing to do with the package; that closure is checked
 * below rather than assumed.
 */
export function emitSdkArtifact(request: EmitSdkRequest): EmitSdkResult {
  const hostRoot = resolve(request.hostRoot);
  const outputRoot = resolve(request.outputRoot);
  const issues: PluginIssue[] = [];
  const missing = SDK_MODULES.filter(module => !existsSync(resolve(hostRoot, module)));
  if (missing.length) {
    return { ok: false, outputRoot, files: [], issues: missing.map(module => ({ category: 'manifest_invalid', path: module, detail: `SDK module ${module} does not exist under ${hostRoot}` })), surface: [] };
  }
  const externalImports: { readonly file: string; readonly specifier: string }[] = [];
  for (const module of SDK_MODULES) {
    const source = sdkModuleSource(hostRoot, module);
    for (const specifier of extractSpecifiers(source)) {
      if (isExternalSpecifier(specifier)) continue;
      if (specifier === '../runtime/esm-graph.mjs') continue;
      const target = resolve(dirname(resolve(hostRoot, module)), specifier);
      if (target === resolve(hostRoot, 'plugins/esm-graph.mjs')) continue;
      const insideSdk = SDK_MODULES.some(candidate => resolve(hostRoot, candidate).replace(/\.ts$/, '.js') === target);
      if (!insideSdk) externalImports.push({ file: module, specifier });
    }
  }
  if (externalImports.length) {
    for (const entry of externalImports) {
      issues.push({
        category: 'boundary_violation',
        path: entry.file,
        detail: `the emitted SDK would import ${entry.specifier}, which is outside the SDK module set; a package project would then need a host private path to compile`,
      });
    }
    return { ok: false, outputRoot, files: [], issues, surface: [] };
  }

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(resolve(outputRoot, 'contracts'), { recursive: true });
  mkdirSync(resolve(outputRoot, 'plugins'), { recursive: true });
  const files: string[] = [];
  for (const module of SDK_MODULES) {
    const destination = resolve(outputRoot, module);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, sdkModuleSource(hostRoot, module), 'utf8');
    files.push(module);
  }
  mkdirSync(resolve(outputRoot, 'runtime'), { recursive: true });
  for (const module of SDK_RUNTIME_MODULES) {
    const destination = resolve(outputRoot, 'runtime', module.split('/').pop()!);
    cpSync(resolve(hostRoot, module), destination);
    files.push(`runtime/${module.split('/').pop()}`);
  }

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      declaration: true,
      outDir: 'dist',
      rootDir: '.',
      lib: ['ES2022', 'DOM'],
      skipLibCheck: true,
    },
    include: [...SDK_MODULES, 'runtime/**/*.mjs'],
    exclude: ['dist'],
  };
  writeFileSync(resolve(outputRoot, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n', 'utf8');
  files.push('tsconfig.json');

  const packageJson = {
    name: 'aika-plugin-sdk',
    version: PLUGIN_API_VERSION,
    private: true,
    type: 'module',
    description: 'Aika 0.65 plugin SDK v1: manifest, capability, multi-source and flow-profile contracts plus their validators.',
    exports: {
      '.': './index.ts',
      './capability': './contracts/capability.ts',
      './provider-source': './contracts/provider-source.ts',
      './flow-profile': './contracts/flow-profile.ts',
      './manifest': './plugins/manifest.ts',
      './package-build': './plugins/package-build.ts',
      './boundary': './plugins/boundary.ts',
      './paths': './plugins/paths.ts',
      './runtime/esm-graph': './runtime/esm-graph.mjs',
    },
    engines: { node: '>=22.12.0' },
  };
  writeFileSync(resolve(outputRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  files.push('package.json');

  const surface = PLUGIN_SDK_SURFACE.map(name => {
    for (const module of SDK_MODULES) {
      const source = readFileSync(resolve(hostRoot, module), 'utf8');
      const declared = new RegExp(`export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:interface|type|const|function|class|enum)\\s+${name}\\b`).test(source)
        || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source);
      if (declared) return { name, declared: true, file: module };
    }
    return { name, declared: false, file: '' };
  });
  for (const entry of surface) {
    if (!entry.declared) {
      issues.push({ category: 'manifest_invalid', path: entry.name, detail: `SDK surface entry ${entry.name} is listed in PLUGIN_SDK_SURFACE but declared by no emitted module` });
    }
  }

  const index = [
    `// Aika 0.65 plugin SDK v1 (API v${PLUGIN_API_VERSION}, manifest schema v${MANIFEST_SCHEMA_VERSION},`,
    `// capability contract v${CAPABILITY_CONTRACT_VERSION}, provider/source schema v${PROVIDER_SOURCE_SCHEMA_VERSION},`,
    `// flow profile schema v${FLOW_PROFILE_SCHEMA_VERSION}).`,
    `//`,
    `// This file is the whole SDK. It re-exports the frozen contract modules and the plugin modules that`,
    `// implement the validators, the packer and the boundary check: a package project that imports a`,
    `// host private path instead of this artifact is refused by the dependency-boundary check (K65-01 01-C).`,
    `export * from './contracts/capability.js';`,
    `export * from './contracts/provider-source.js';`,
    `export * from './contracts/plugin.js';`,
    `export * from './contracts/flow-profile.js';`,
    `export * from './plugins/paths.js';`,
    `export * from './plugins/manifest.js';`,
    `export * from './plugins/package-build.js';`,
    `export * from './plugins/boundary.js';`,
    `export * from './plugins/sdk-emit.js';`,
    ``,
    `/** Required capability ids by category; the minimum set every capability package's vocabulary must cover. */`,
    `export const SDK_REQUIRED_CAPABILITY_IDS = ${JSON.stringify(REQUIRED_CAPABILITY_IDS, null, 2)} as const;`,
    ``,
  ].join('\n');
  writeFileSync(resolve(outputRoot, 'index.ts'), index, 'utf8');
  files.push('index.ts');

  return { ok: issues.length === 0, outputRoot, files: files.sort(), issues, surface };
}

/** True when the emitted SDK directory is complete and self-contained enough to compile. */
export function sdkArtifactComplete(outputRoot: string): boolean {
  return ['index.ts', 'package.json', 'tsconfig.json', 'runtime/esm-graph.mjs', ...SDK_MODULES].every(file => existsSync(resolve(outputRoot, file)));
}

/** True when `path` is inside the emitted SDK; used by the fixture's boundary check as its allow-list. */
export function isSdkPath(path: string, outputRoot: string): boolean {
  return isInside(path, resolve(outputRoot));
}
