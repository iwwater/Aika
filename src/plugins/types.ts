import type { PetAnimationId } from '../pet/animation';
import type { PetCatalogItem } from '../pet/catalog';
import type { PetSettings } from '../pet/settings';

/**
 * MVP-10 plugin slots.
 *
 * Three slots exist and each has a default implementation that ships with the app:
 *   - renderer: turning the pet into pixels (sprite today, Live2D in MVP-11)
 *   - behavior: idle / action policy and desktop motion
 *   - menu:     the pet's right-click entries
 *
 * The HTTP contract is deliberately absent here: transports push events into the
 * window, the window forwards them to whichever renderer is active. No slot may
 * assume a specific renderer, and no renderer may reach into the transport.
 */

/** Where a render command came from, so runtime and local UI stay distinguishable. */
export type CommandSource = 'runtime' | 'local' | 'behavior';

/** Lifecycle state of a renderer instance. */
export type RendererStatus = 'idle' | 'preparing' | 'active' | 'failed' | 'disposed';

export interface RendererCapabilities {
  /** Animation ids this renderer can actually display. Never a guess. */
  readonly actions: readonly string[];
  readonly bubble: boolean;
  /** Costume / model switching (MVP-11). */
  readonly costumes: boolean;
  readonly hitAreas: boolean;
}

export interface RendererMountContext {
  /** Container owned by the window. The renderer owns its own children inside it. */
  readonly host: HTMLElement;
  readonly pet: PetCatalogItem;
  readonly settings: PetSettings;
  /**
   * 回环 API 基址（例如 `http://127.0.0.1:17321`）。
   *
   * Live2D 模型**不入包**（MVP-14）：模型文件由 shell 自己的回环 HTTP 从应用数据
   * 目录提供，渲染器按这个基址拼 URL。CSP 的 `connect-src` / `img-src` 本就放行
   * `http://127.0.0.1:*`，所以这条路径不需要放宽 CSP。
   */
  readonly apiBaseUrl: string;
  /** Called when the renderer's interactive region changes, for click-through handling. */
  readonly onHitTargetChange: (element: HTMLElement | null) => void;
  /** Called when the renderer fails after activation and the window should degrade. */
  readonly onRuntimeFailure: (reason: string) => void;
}

export interface ActionRequest {
  readonly animationId: string;
  readonly source: CommandSource;
}

export interface PetRendererPlugin {
  readonly id: string;
  readonly displayName: string;
  capabilities(): RendererCapabilities;
  /** Allocate resources. Must not take over visible output yet. */
  prepare(context: RendererMountContext): Promise<void>;
  /** Take over visible output. Only called after prepare() resolved. */
  activate(): void;
  /** Stop producing output but keep resources, so a losing instance can be torn down safely. */
  deactivate(): void;
  /**
   * Returns false when the request cannot be honoured. Implementations must not
   * silently pretend success: an unsupported animation is a false return.
   */
  action(request: ActionRequest): boolean;
  /**
   * Continuous pose (idle / walking). Distinct from `action` because a pose has no
   * duration and must not be reported as a completed action.
   */
  pose(animationId: string): boolean;
  bubble(text: string | null, ttlMs: number): void;
  applySettings(settings: PetSettings, pet: PetCatalogItem): void;
  /**
   * Optional read-only diagnostics: what this renderer currently believes about itself
   * (frame counts, active appearance, discard/failure counts). Surfaced by the host for
   * the acceptance report and device tests, and never used for control flow.
   */
  diagnostics?(): unknown;
  /** Release everything. Must be idempotent. */
  dispose(): Promise<void>;
}

export interface BehaviorContext {
  readonly getSettings: () => PetSettings;
  /** Drag, context menu, hover-pause or any other reason to hold still. */
  readonly isPaused: () => boolean;
  readonly isActionActive: () => boolean;
  /** Timestamp of the last user/agent interaction, for the idle threshold. */
  readonly lastActivityAt: () => number;
  readonly now: () => number;
  /** One-shot action. Goes through the same action constraint as runtime commands. */
  readonly requestAction: (animationId: PetAnimationId, source: CommandSource) => void;
  /** Continuous pose (idle / walking). Does not start an action timer. */
  readonly requestPose: (animationId: PetAnimationId) => void;
  readonly markActivity: () => void;
}

export interface PetBehaviorPlugin {
  readonly id: string;
  readonly displayName: string;
  start(context: BehaviorContext): void;
  stop(): void;
  /**
   * Optional host notification: the OS moved the window, so any motion model the
   * behavior keeps must follow. Behaviors that hold no geometry can omit it.
   */
  syncWindowPosition?(position: { x: number; y: number }, scaleFactor: number): void;
  dispose(): Promise<void>;
}

export interface MenuEntry {
  readonly id: string;
  readonly label: string;
  run(): void | Promise<void>;
}

/** 一种可选外观。菜单只负责列出来，不认识任何具体模型（MVP-11）。 */
export interface AppearanceOption {
  readonly id: string;
  readonly label: string;
}

export interface MenuContext {
  readonly settings: PetSettings;
  readonly language: 'en' | 'zh-CN';
  readonly openSettings: () => void | Promise<void>;
  readonly hidePet: () => void | Promise<void>;
  readonly playAction: (animationId: string) => void;
  readonly updateSettings: (next: PetSettings) => Promise<void>;
  /**
   * 当前 renderer 报出的外观选项；空或缺省表示「这个 renderer 没有换装能力」。
   *
   * 由宿主从槽位取，菜单不 import 任何 renderer：菜单加一条「换一套衣服」时
   * 不该知道衣服是什么。
   */
  readonly appearances?: readonly AppearanceOption[];
}

export interface PetMenuPlugin {
  readonly id: string;
  readonly displayName: string;
  entries(context: MenuContext): readonly MenuEntry[];
}

/** Visible degradation state surfaced by the window when a slot cannot serve. */
export type SlotStatus = 'ready' | 'degraded' | 'unavailable' | 'preparing';
