import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
/** Build fixed local routes from the trusted installed manifest. Never resolve a requested path. */
export async function presentationAssetRoutes(projectRoot: string): Promise<ReadonlyMap<string, string>> {
  const desktop = resolve(projectRoot, 'code/desktop-pet/desktop'), base = resolve(desktop, 'assets/local-model');
  const refs = JSON.parse(await readFile(resolve(base, 'pet.model3.json'), 'utf8')).FileReferences;
  const paths: string[] = ['pet.model3.json', 'presets.json', refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures,
    ...refs.Expressions.map((x: { File: string }) => x.File), ...Object.values(refs.Motions as Record<string, { File: string }[]>).flat().map(x => x.File)];
  const routes = new Map<string, string>();
  for (const path of new Set(paths.filter(Boolean))) {
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid installed model path');
    routes.set('/presentation-assets/' + path, resolve(base, path));
  }
  const shaderBase = resolve(desktop, 'vendor/cubism/Framework/Shaders/WebGL');
  for (const file of await readdir(shaderBase)) if (/^[a-zA-Z0-9_.-]+\.(frag|vert)$/.test(file)) routes.set('/presentation-shaders/' + file, resolve(shaderBase, file));
  routes.set('/presentation-runtime/core.js', resolve(desktop, 'vendor/cubism/Core/live2dcubismcore.min.js'));
  return routes;
}
