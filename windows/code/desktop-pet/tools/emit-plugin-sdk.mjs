// K65-01 (D1, 01-C): `npm run sdk:next65`. Emits dist/next65-sdk/ and refuses to exit 0 when the
// artifact is not complete, so 01-C's premise ("the fixture compiles against the emitted SDK alone")
// can never be silently built on a stale or partial artifact.
import { fileURLToPath } from 'node:url';
import { copyFileSync } from 'node:fs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
// `tsc` emits .ts -> .js only, so the shared plain-.mjs graph walker is copied beside its compiled
// TypeScript callers before either is loaded; without it dist/plugins/*.js cannot resolve it.
copyFileSync(packageRoot + 'plugins/esm-graph.mjs', packageRoot + 'dist/plugins/esm-graph.mjs');

const { emitSdkArtifact, sdkArtifactComplete } = await import('../dist/plugins/sdk-emit.js');

const result = emitSdkArtifact({ hostRoot: packageRoot, outputRoot: packageRoot + 'dist/next65-sdk' });
for (const issue of result.issues) console.error(`${issue.category} ${issue.path}: ${issue.detail}`);
const undeclared = result.surface.filter(entry => !entry.declared).map(entry => entry.name);
if (undeclared.length) console.error('undeclared SDK surface: ' + undeclared.join(', '));
if (!result.ok) {
  console.error(`sdk:next65 FAILED: ${result.issues.length} issue(s); dist/next65-sdk was not completed`);
  process.exit(1);
}
if (!sdkArtifactComplete(result.outputRoot)) {
  console.error('sdk:next65 FAILED: the emitted artifact is missing required files');
  process.exit(1);
}
console.log(`sdk:next65: ${result.files.length} files into ${result.outputRoot}`);
for (const file of result.files) console.log('  ' + file);
console.log(`sdk:next65: PLUGIN_SDK_SURFACE ${result.surface.length - undeclared.length}/${result.surface.length} declared`);
