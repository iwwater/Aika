import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import type { PresentationCatalog, PresentationPolicy, PresentationControls } from '../contracts/presentation-presets.js';
import { PRESENTATION_EMOTIONS, PRESENTATION_GESTURES } from '../contracts/presentation.js';
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const fail = (message: string): never => { throw new ManagementError('invalid_request', message); };
export function validatePresentationCatalog(value: unknown): PresentationCatalog {
  const c = value as PresentationCatalog;
  if (!c || c.schemaVersion !== 1 || !idPattern.test(c.modelId) || !/^[a-f0-9]{64}$/.test(c.modelFingerprint)
    || !Array.isArray(c.items) || !c.items.length || c.items.length > 200) fail('模型预设目录无效。');
  const ids = new Set<string>();
  for (const p of c.items) {
    if (!p || typeof p.id !== 'string' || !idPattern.test(p.id) || ids.has(p.id)
      || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 100
      || !['expression','pose','appearance','idle'].includes(p.category)
      || !['model-expression','model-motion','procedural'].includes(p.source)
      || !['automatic','manual','unavailable'].includes(p.availability)
      || typeof p.defaultEnabled !== 'boolean' || typeof p.previewable !== 'boolean'
      || (p.defaultEnabled && p.availability !== 'automatic')
      || (p.availability === 'automatic' && (p.category === 'appearance' || !p.previewable))
      || (p.emotions && (!Array.isArray(p.emotions) || p.emotions.some(x => !PRESENTATION_EMOTIONS.includes(x as never))))
      || (p.gestures && (!Array.isArray(p.gestures) || p.gestures.some(x => !PRESENTATION_GESTURES.includes(x as never))))) fail('模型预设条目无效。');
    ids.add(p.id);
  }
  return structuredClone(c);
}
export async function readPresentationCatalog(projectRoot: string): Promise<PresentationCatalog> {
  const base = resolve(projectRoot, 'code/desktop-pet/desktop/assets/local-model');
  const manifest = await readFile(resolve(base, 'pet.model3.json'));
  const catalog = validatePresentationCatalog(JSON.parse(await readFile(resolve(base, 'presets.json'), 'utf8')));
  const refs = JSON.parse(manifest.toString('utf8')).FileReferences;
  const paths = [...new Set(['pet.model3.json', refs.Moc, refs.Physics, ...refs.Expressions.map((x: { File: string }) => x.File), ...Object.values(refs.Motions as Record<string, { File: string }[]>).flat().map(x => x.File)].filter(Boolean))] as string[];
  const pieces: string[] = [];
  for (const path of paths.sort()) {
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid model reference');
    pieces.push(path + '\0' + createHash('sha256').update(await readFile(resolve(base, path))).digest('hex') + '\n');
  }
  if (createHash('sha256').update(pieces.join('')).digest('hex') !== catalog.modelFingerprint) throw new ManagementError('unavailable', '模型已变化，预设目录需要重新核对。');
  return catalog;
}
type Stored = { schemaVersion: 1; models: Record<string, PresentationPolicy> };
function parse(raw: string): Stored {
  const state = JSON.parse(raw) as Stored;
  if (!state || state.schemaVersion !== 1 || !state.models || typeof state.models !== 'object' || Array.isArray(state.models)) fail('已保存的表现设置无效。');
  for (const [key, value] of Object.entries(state.models)) {
    if (!idPattern.test(key) || value.modelId !== key || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.enabledIds) || value.enabledIds.some(x => typeof x !== 'string' || !idPattern.test(x))
      || new Set(value.enabledIds).size !== value.enabledIds.length) fail('已保存的表现设置无效。');
  }
  return state;
}
/** Dedicated user settings, never a chat or memory record. One backend owns writes. */
export class PresentationSettingsStore implements PresentationControls {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly file: string, readonly catalog: PresentationCatalog, private state: Stored,
    private readonly changed: (policy: PresentationPolicy) => void) {}
  static async open(file: string, catalog: PresentationCatalog, changed: (policy: PresentationPolicy) => void = () => {}) {
    let state: Stored;
    try { state = parse(await readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; state = { schemaVersion: 1, models: {} }; }
    const store = new PresentationSettingsStore(resolve(file), validatePresentationCatalog(catalog), state, changed);
    store.validEnabled(store.snapshot().enabledIds); return store;
  }
  snapshot(): PresentationPolicy {
    return structuredClone(this.state.models[this.catalog.modelId] ?? { modelId: this.catalog.modelId, revision: 0,
      enabledIds: this.catalog.items.filter(p => p.availability === 'automatic' && p.defaultEnabled).map(p => p.id) });
  }
  private validEnabled(value: unknown): string[] {
    const allowed = new Set(this.catalog.items.filter(p => p.availability === 'automatic').map(p => p.id));
    if (!Array.isArray(value) || value.length > allowed.size || value.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(value).size !== value.length) fail('只能更改当前模型已接入的自动表现。');
    return [...(value as string[])].sort();
  }
  save(modelId: string, expectedRevision: number, enabledIds: unknown): Promise<PresentationPolicy> {
    const run = this.queue.then(async () => {
      const current = this.snapshot();
      if (modelId !== this.catalog.modelId) fail('模型已变化，请刷新后再保存。');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) throw new ManagementError('version_conflict', '表现设置已更新，请刷新后重试。');
      const enabled = this.validEnabled(enabledIds);
      const policy = { modelId, revision: current.revision + 1, enabledIds: enabled };
      const next: Stored = { schemaVersion: 1, models: { ...this.state.models, [modelId]: policy } };
      await mkdir(dirname(this.file), { recursive: true }); const temporary = this.file + '.' + randomUUID() + '.next';
      try { await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      this.state = next; this.changed(this.snapshot()); return this.snapshot();
    });
    this.queue = run.catch(() => {}); return run;
  }
  allowedIntent() {
    const enabled = new Set(this.snapshot().enabledIds);
    const items = this.catalog.items.filter(p => p.availability === 'automatic' && enabled.has(p.id));
    return { emotions: [...new Set(['neutral', ...items.flatMap(p => p.emotions ?? [])])], gestures: [...new Set(items.flatMap(p => p.gestures ?? []))], presets: items.filter(p => p.category === "expression" || p.category === "pose").map(p => ({ id: p.id, label: p.label })) };
  }
  async drain() { await this.queue; }
}
