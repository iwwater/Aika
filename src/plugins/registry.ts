import type { PetBehaviorPlugin, PetMenuPlugin, PetRendererPlugin } from './types';

/**
 * Renderers are registered as factories, not instances.
 *
 * The host owns exactly one live renderer instance, and a single registry can back
 * more than one host (React StrictMode mounts effects twice in development). Handing
 * out a shared instance let a stale host dispose the live one, so instances are
 * created per host activation instead.
 */
export type RendererFactory = () => PetRendererPlugin;
/** Behaviors are stateful too (timers, motion), so they are created per host as well. */
export type BehaviorFactory = () => PetBehaviorPlugin;

/**
 * MVP-10 slot registry.
 *
 * In-process registration only: default implementations ship with the binary, and
 * there is deliberately no remote code loading, installer or marketplace here.
 */
export class PluginRegistry {
  private readonly rendererFactories = new Map<string, RendererFactory>();
  private readonly behaviorFactories = new Map<string, BehaviorFactory>();
  private readonly menus = new Map<string, PetMenuPlugin>();
  private preferredRendererId: string | null = null;

  registerRenderer(id: string, create: RendererFactory): void {
    this.rendererFactories.set(id, create);
    if (this.preferredRendererId === null) this.preferredRendererId = id;
  }

  getRendererFactory(id: string): RendererFactory | null {
    return this.rendererFactories.get(id) ?? null;
  }

  hasRenderer(id: string): boolean {
    return this.rendererFactories.has(id);
  }

  listRendererIds(): readonly string[] {
    return [...this.rendererFactories.keys()];
  }

  registerBehavior(id: string, create: BehaviorFactory): void {
    this.behaviorFactories.set(id, create);
  }

  getBehaviorFactory(id: string): BehaviorFactory | null {
    return this.behaviorFactories.get(id) ?? null;
  }

  listBehaviorIds(): readonly string[] {
    return [...this.behaviorFactories.keys()];
  }

  registerMenu(plugin: PetMenuPlugin): void {
    this.menus.set(plugin.id, plugin);
  }

  getMenu(id: string): PetMenuPlugin | null {
    return this.menus.get(id) ?? null;
  }

  listMenus(): readonly PetMenuPlugin[] {
    return [...this.menus.values()];
  }

  /** The renderer the window should try first. */
  preferredRenderer(): string | null {
    return this.preferredRendererId;
  }

  setPreferredRenderer(id: string): boolean {
    if (!this.rendererFactories.has(id)) return false;
    this.preferredRendererId = id;
    return true;
  }

  clear(): void {
    this.rendererFactories.clear();
    this.behaviorFactories.clear();
    this.menus.clear();
    this.preferredRendererId = null;
  }
}
