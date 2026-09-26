// FIX61-05: model-pack (skin) registry contract, shared by the store, the management route and the
// renderer session. A skin is appearance only. It never changes characterId, identity, voice,
// knowledge library or memory; 0.7 Character Pack binds a character to a skin separately, so a
// skinId is deliberately not a characterId.
import type { PresentationCatalog } from './presentation-presets.js';

/** The four procedural parameter names every supported rig must provide, under the pack's own names. */
export interface SkinParameterMap {
  readonly headYaw: string;
  readonly headPitch: string;
  readonly headRoll: string;
  readonly mouthForm: string;
  /** Optional, pack-specific fixed switches. Validated against the real model range by the renderer. */
  readonly parameterOverrides?: Readonly<Record<string, number>>;
}

export interface SkinCapabilities {
  readonly textures: number;
  readonly expressions: number;
  readonly motions: number;
  /** 'authored' means the pack shipped a reviewed catalog; 'generated-disabled' means nothing auto-plays. */
  readonly presets: 'authored' | 'generated-disabled';
  readonly automaticPresets: number;
  /** Cubism model version actually declared by the .moc3 header. 3, 4 or 5 only. */
  readonly mocVersion: number;
}

export interface SkinDescriptor {
  readonly skinId: string;
  readonly label: string;
  readonly origin: 'builtin' | 'imported';
  readonly modelEntry: string;
  /** Legacy binding over model3/moc/physics/expressions/motions, compatible with the renderer check. */
  readonly modelFingerprint: string;
  /** Every referenced file including textures, pose, display info and user data. */
  readonly assetFingerprint: string;
  readonly parameters: SkinParameterMap;
  readonly capabilities: SkinCapabilities;
  readonly importedAt: string;
  readonly bytes: number;
}

export interface SkinState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly activeSkinId: string;
  readonly skins: readonly SkinDescriptor[];
}

/** One pack manifest as published to the renderer. Read-only data; the renderer never resolves a path. */
export interface SkinManifest {
  readonly schemaVersion: 1;
  readonly skinId: string;
  readonly label: string;
  readonly modelEntry: string;
  readonly modelFingerprint: string;
  readonly assetFingerprint: string;
  readonly parameters: SkinParameterMap;
  readonly catalog: PresentationCatalog;
  readonly capabilities: SkinCapabilities;
  readonly revision: number;
}

/** A registry route is either a real registered file or a synthesized manifest body. */
export type SkinRoute = string | { readonly body: string; readonly type: string };

export interface SkinImportInput {
  readonly skinId?: string;
  readonly label?: string;
  /** Entry model3 file inside the pack. Defaults to pet.model3.json. */
  readonly entry?: string;
  /** An authored catalog supplied by the importer; when absent the pack's own presets.json is used. */
  readonly presets?: unknown;
}

export interface SkinManagement {
  readonly kind: 'skins';
  list(): readonly SkinDescriptor[];
  state(): SkinState;
  active(): SkinDescriptor;
  import(source: string, input: SkinImportInput): Promise<SkinState>;
  activate(expectedRevision: number, skinId: string): Promise<SkinState>;
  remove(expectedRevision: number, skinId: string): Promise<SkinState>;
  /** Registry-resolved assets for one skin. Unknown ids and unsafe paths resolve to nothing. */
  routes(skinId: string): ReadonlyMap<string, SkinRoute>;
}
