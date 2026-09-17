import type { MediaAsset, MediaStorePort, TurnScope } from '../contracts/index.js';
import { scopeKey } from './scope.js';

/** Process-local bytes. The integration bridge must transfer bytes, never forward this URI. */
export class MemoryMediaStore implements MediaStorePort {
  private readonly entries = new Map<string, { scope: string; asset: MediaAsset; bytes: Uint8Array }>();
  async put(scope: TurnScope, bytes: Uint8Array, mimeType: string): Promise<MediaAsset> {
    if (!bytes.byteLength || !mimeType) throw new Error('Empty media');
    const id = globalThis.crypto.randomUUID();
    const asset = Object.freeze({ id, uri: `pet-media:${id}`, mimeType, temporary: true as const });
    this.entries.set(id, { scope: scopeKey(scope), asset, bytes: bytes.slice() });
    return asset;
  }
  async read(scope: TurnScope, asset: MediaAsset): Promise<Uint8Array> {
    const entry = this.entries.get(asset.id);
    if (!entry || entry.scope !== scopeKey(scope) || entry.asset.uri !== asset.uri || entry.asset.mimeType !== asset.mimeType) {
      throw new Error('Media unavailable for this turn');
    }
    return entry.bytes.slice();
  }
  async releaseScope(scope: TurnScope): Promise<void> {
    for (const [id, entry] of this.entries) if (entry.scope === scopeKey(scope)) {
      entry.bytes.fill(0);
      this.entries.delete(id);
    }
  }
  get count(): number { return this.entries.size; }
}
