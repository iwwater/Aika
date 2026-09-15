import type { PetActionAnimationId } from './animation';
import { PET_CATALOG, type PetCatalogItem, type PetId } from './catalog';
import type { RecentCompanionEvent } from './events';

export type PetLanguage = 'en' | 'zh-CN';
export type PetRendererId = 'sprite' | 'live2d';
export const PET_RENDERER_IDS: readonly PetRendererId[] = ['sprite', 'live2d'];

export function isPetRendererId(value: unknown): value is PetRendererId {
  return typeof value === 'string' && (PET_RENDERER_IDS as readonly string[]).includes(value);
}

export type ClickActionMode = 'fixed' | 'random';
export type IdleActionId = 'random' | 'active-action' | PetActionAnimationId;
export type BubbleStyle = 'soft' | 'comic' | 'glass' | 'terminal';
export type PetStoragePreset = 'app-data' | 'codex-custom' | 'custom';

export type PetSettings = {
  language: PetLanguage;
  scale: number;
  reducedMotion: boolean;
  autonomousWalking: boolean;
  /** 首版换装是整模型切换，所以这一项就是「当前外观」。 */
  live2dAppearance: string;
  /** 表现出口；任一时刻只有一个 renderer 在输出。 */
  renderer: PetRendererId;
  hoverPause: boolean;
  activePetId: PetId;
  clickActionMode: ClickActionMode;
  clickAction: PetActionAnimationId;
  clickActionPool: PetActionAnimationId[];
  eventReactions: boolean;
  eventBubbles: boolean;
  eventBubbleTtlMs: number;
  bubbleStyle: BubbleStyle;
  bubbleFontFamily: string;
  bubbleFontSizePx: number;
  bubbleMaxWidthPx: number;
  idleSelfPlay: boolean;
  idleThresholdMs: number;
  idleActionFrequencyMs: number;
  idleAction: IdleActionId;
  walkingSpeedPx: number;
  petStoragePreset: PetStoragePreset;
  customPetStorageDir: string | null;
};

export type PetStorageSnapshot = {
  preset: PetStoragePreset;
  customDir: string | null;
  activeDir: string;
  appDataDir: string;
  codexDir: string;
};

/** Real identity of the sidecar. `upstream` is attribution, not a version to match. */
export type ProductInfo = {
  name: string;
  version: string;
  upstream: string;
};

export type ShutdownCapability = {
  endpoint: string;
  version: number;
  auth: string;
  available: boolean;
  reason: string | null;
};

export type IdentityCapabilities = {
  singleInstance: boolean;
  instanceOwner: boolean;
  shutdown: ShutdownCapability;
};

export type RuntimeSnapshot = {
  listenAddress: string;
  port: number;
  configuredListenAddress: string;
  configuredPort: number;
  apiBaseUrl: string;
  apiListening: boolean;
  apiError: string | null;
  apiRestartRequired: boolean;
  petVisible: boolean;
  product: ProductInfo;
  capabilities: IdentityCapabilities;
  settings: PetSettings;
  petStorage: PetStorageSnapshot;
  activePet: PetCatalogItem;
  petCatalog: PetCatalogItem[];
  lastAction: string | null;
  bubbleText: string | null;
  recentEvents: RecentCompanionEvent[];
  startedAtMs: number;
};

export type RuntimeApiConfig = {
  listenAddress: string;
  port: number;
};

export type ActionPayload = {
  animationId: string;
};

export type SayPayload = {
  text: string;
  ttlMs?: number | null;
};

export const DEFAULT_SETTINGS: PetSettings = {
  language: 'en',
  scale: 1,
  reducedMotion: false,
  autonomousWalking: false,
  live2dAppearance: 'hiyori',
  renderer: 'sprite',
  hoverPause: true,
  activePetId: 'nia',
  clickActionMode: 'random',
  clickAction: 'waving',
  clickActionPool: ['waving', 'jumping', 'waiting', 'running', 'review'],
  eventReactions: true,
  eventBubbles: true,
  eventBubbleTtlMs: 4000,
  bubbleStyle: 'soft',
  bubbleFontFamily: 'Aptos Display',
  bubbleFontSizePx: 14,
  bubbleMaxWidthPx: 292,
  idleSelfPlay: true,
  idleThresholdMs: 45000,
  idleActionFrequencyMs: 30000,
  idleAction: 'random',
  walkingSpeedPx: 8,
  petStoragePreset: 'codex-custom',
  customPetStorageDir: null,
};

export const FALLBACK_SNAPSHOT: RuntimeSnapshot = {
  listenAddress: '127.0.0.1',
  port: 17321,
  configuredListenAddress: '127.0.0.1',
  configuredPort: 17321,
  apiBaseUrl: 'http://127.0.0.1:17321',
  apiListening: false,
  apiError: 'Not connected to Tauri runtime',
  apiRestartRequired: false,
  petVisible: true,
  product: {
    name: 'PetShell',
    version: '0.6.0',
    upstream: 'OpenPet v0.1.6 (GPL-3.0-or-later)',
  },
  capabilities: {
    singleInstance: true,
    instanceOwner: true,
    shutdown: {
      endpoint: '/api/shutdown',
      version: 1,
      auth: 'bearer-token',
      available: false,
      reason: 'Not connected to the PetShell runtime',
    },
  },
  settings: DEFAULT_SETTINGS,
  petStorage: {
    preset: 'codex-custom',
    customDir: null,
    activeDir: '~/.codex/pets',
    appDataDir: 'OpenPet app data/pets',
    codexDir: '~/.codex/pets',
  },
  activePet: PET_CATALOG[0],
  petCatalog: [...PET_CATALOG],
  lastAction: null,
  bubbleText: null,
  recentEvents: [],
  startedAtMs: Date.now(),
};
