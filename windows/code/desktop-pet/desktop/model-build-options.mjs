import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Keep a private rig's mapping alongside its ignored assets, leaving the shared default editable.
export const modelPlugins = [{ name: 'local-model-parameters', setup(build) {
  const path = fileURLToPath(new URL('./assets/local-model/parameter-map.json', import.meta.url));
  if (existsSync(path)) build.onResolve({ filter: /^\.\/config\/parameter-map\.json$/ }, () => ({ path }));
} }];
