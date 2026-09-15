import type { PetCatalogItem } from '../pet/catalog';
import type { PetSettings } from '../pet/settings';
import type { PluginRegistry } from './registry';
import type {
  ActionRequest,
  PetRendererPlugin,
  RendererCapabilities,
  RendererMountContext,
  SlotStatus,
} from './types';

export interface RendererHostCounters {
  starts: number;
  switches: number;
  failedPreparations: number;
  failedSwitches: number;
  disposedInstances: number;
  /** Requests that reached an active renderer and were accepted. */
  actionsForwarded: number;
  /** Requests an active renderer saw but refused (unknown animation). */
  actionsRefused: number;
  /** Requests that had no active renderer at all: never reported as success. */
  actionsWithoutRenderer: number;
}

export interface RendererHostOptions {
  readonly registry: PluginRegistry;
  readonly context: RendererMountContext;
  /** Renderer used when the preferred one cannot start. */
  readonly fallbackRendererId: string;
}

type ActiveInstance = {
  readonly id: string;
  readonly plugin: PetRendererPlugin;
};

/**
 * Owns the single visible renderer.
 *
 * Contract:
 *   - at most one renderer produces output at any moment
 *   - switching prepares the new instance first, commits, then releases the old one
 *   - a failed switch keeps the previously working instance
 *   - every async continuation is discarded once its generation is stale
 */
export class RendererHost {
  private readonly registry: PluginRegistry;
  private readonly context: RendererMountContext;
  private readonly fallbackRendererId: string;
  private generation = 0;
  private active: ActiveInstance | null = null;
  private status: SlotStatus = 'unavailable';
  private lastError: string | null = null;
  private readonly counterState: RendererHostCounters = {
    starts: 0,
    switches: 0,
    failedPreparations: 0,
    failedSwitches: 0,
    disposedInstances: 0,
    actionsForwarded: 0,
    actionsRefused: 0,
    actionsWithoutRenderer: 0,
  };

  constructor(options: RendererHostOptions) {
    this.registry = options.registry;
    this.context = options.context;
    this.fallbackRendererId = options.fallbackRendererId;
  }

  getStatus(): SlotStatus {
    return this.status;
  }

  getActiveRendererId(): string | null {
    return this.active?.id ?? null;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getCounters(): Readonly<RendererHostCounters> {
    return { ...this.counterState };
  }

  getCapabilities(): RendererCapabilities | null {
    if (!this.active) return null;
    try {
      return this.active.plugin.capabilities();
    } catch (error) {
      this.recordFailure(error);
      return null;
    }
  }

  /**
   * Start with the preferred renderer, falling back to the default sprite when it
   * cannot be prepared. Never throws: an unusable slot is reported as `unavailable`.
   */
  async start(preferredRendererId?: string | null): Promise<SlotStatus> {
    this.counterState.starts += 1;
    const preferred = preferredRendererId ?? this.registry.preferredRenderer();
    const candidates = [preferred, this.fallbackRendererId].filter(
      (id, index, all): id is string => typeof id === 'string' && all.indexOf(id) === index,
    );

    for (const candidate of candidates) {
      const started = await this.tryActivate(candidate);
      if (started) {
        // Running something other than what was asked for is a visible degradation,
        // and the reason stays available for the window to surface.
        const degraded = Boolean(preferred) && candidate !== preferred;
        this.status = degraded ? 'degraded' : 'ready';
        if (!degraded) this.lastError = null;
        return this.status;
      }
    }

    this.status = 'unavailable';
    if (this.lastError === null) {
      this.lastError = 'no renderer could be prepared';
    }
    return this.status;
  }

  /**
   * Prepare the requested renderer and only commit when it is ready.
   * Returns false (and keeps the previous renderer) when preparation fails.
   */
  async switchTo(rendererId: string): Promise<boolean> {
    this.counterState.switches += 1;
    if (this.active?.id === rendererId) return true;

    const committed = await this.tryActivate(rendererId);
    if (committed) {
      this.lastError = null;
      return true;
    }

    this.counterState.failedSwitches += 1;
    // The previous instance was never deactivated on this path, so it keeps producing
    // output; the window only has to surface the degraded state.
    this.status = this.active ? 'degraded' : 'unavailable';
    return false;
  }

  action(request: ActionRequest): boolean {
    if (!this.active) {
      this.counterState.actionsWithoutRenderer += 1;
      return false;
    }
    let accepted = false;
    try {
      accepted = this.active.plugin.action(request);
    } catch (error) {
      this.recordFailure(error);
      accepted = false;
    }
    if (accepted) {
      this.counterState.actionsForwarded += 1;
    } else {
      this.counterState.actionsRefused += 1;
    }
    return accepted;
  }

  /** Renderer-specific diagnostics of the active instance; null when nothing is active. */
  getDiagnostics(): unknown {
    const active = this.active;
    if (!active) return null;
    try {
      return active.plugin.diagnostics?.() ?? null;
    } catch {
      return null;
    }
  }

  pose(animationId: string): boolean {
    if (!this.active) {
      this.counterState.actionsWithoutRenderer += 1;
      return false;
    }
    try {
      return this.active.plugin.pose(animationId);
    } catch (error) {
      this.recordFailure(error);
      return false;
    }
  }

  bubble(text: string | null, ttlMs: number): boolean {
    if (!this.active) return false;
    try {
      this.active.plugin.bubble(text, ttlMs);
      return true;
    } catch (error) {
      this.recordFailure(error);
      return false;
    }
  }

  applySettings(settings: PetSettings, pet: PetCatalogItem): void {
    if (!this.active) return;
    try {
      this.active.plugin.applySettings(settings, pet);
    } catch (error) {
      this.recordFailure(error);
    }
  }

  /** Release the active renderer and return the slot to its initial state. */
  async stop(): Promise<void> {
    this.generation += 1;
    const previous = this.active;
    this.active = null;
    this.status = 'unavailable';
    if (previous) {
      await this.disposeInstance(previous);
    }
  }

  private async tryActivate(rendererId: string): Promise<boolean> {
    const create = this.registry.getRendererFactory(rendererId);
    if (!create) {
      this.lastError = `renderer '${rendererId}' is not registered`;
      return false;
    }

    // A fresh instance per activation: two hosts must never share renderer state.
    let plugin: PetRendererPlugin;
    try {
      plugin = create();
    } catch (error) {
      this.counterState.failedPreparations += 1;
      this.recordFailure(error);
      return false;
    }

    this.generation += 1;
    const generation = this.generation;
    this.status = 'preparing';

    try {
      await plugin.prepare(this.context);
    } catch (error) {
      this.counterState.failedPreparations += 1;
      this.recordFailure(error);
      await this.disposeInstance({ id: rendererId, plugin });
      return false;
    }

    // A newer start/switch happened while this one was preparing: drop the instance.
    if (generation !== this.generation) {
      await this.disposeInstance({ id: rendererId, plugin });
      return false;
    }

    const previous = this.active;
    if (previous) previous.plugin.deactivate();

    this.active = { id: rendererId, plugin };
    try {
      plugin.activate();
    } catch (error) {
      this.active = previous;
      this.recordFailure(error);
      this.status = previous ? 'degraded' : 'unavailable';
      if (previous) previous.plugin.activate();
      await this.disposeInstance({ id: rendererId, plugin });
      return false;
    }

    // lastError is intentionally kept: a degraded host still owes the user the reason.
    this.status = 'ready';
    if (previous) await this.disposeInstance(previous);
    return true;
  }

  private async disposeInstance(instance: ActiveInstance): Promise<void> {
    try {
      instance.plugin.deactivate();
    } catch {
      // deactivate is best effort; dispose below still has to run.
    }
    try {
      await instance.plugin.dispose();
    } catch (error) {
      this.lastError = describeError(error);
    } finally {
      this.counterState.disposedInstances += 1;
    }
  }

  private recordFailure(error: unknown): void {
    this.lastError = describeError(error);
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
