import {
  PET_ACTION_ANIMATION_IDS,
  PET_ATLAS,
  type PetAnimationId,
  getPetAnimation,
  getPetAnimationDurationMs,
  getPetFrameAtTime,
  getPetFrameOffset,
  getPetRenderScale,
  getPetSpriteSize,
  isPetActionAnimationId,
  isPetPoseAnimationId,
  type PetPoseAnimationId,
} from '../../pet/animation';
import { getPetSpritesheetUrl, type PetCatalogItem } from '../../pet/catalog';
import type { PetSettings } from '../../pet/settings';
import type {
  ActionRequest,
  PetRendererPlugin,
  RendererCapabilities,
  RendererMountContext,
} from '../types';
import { BubbleView } from './bubbleView';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Default renderer: the upstream spritesheet atlas, migrated from `PetSprite.tsx`.
 *
 * Owns its DOM (sprite + hit target + bubble) so that `prepare`, `activate`,
 * `deactivate` and `dispose` are real lifecycle steps rather than React re-renders.
 */
export class SpriteRendererPlugin implements PetRendererPlugin {
  readonly id = 'sprite';
  readonly displayName = 'Sprite renderer';

  private context: RendererMountContext | null = null;
  private pet: PetCatalogItem | null = null;
  private settings: PetSettings | null = null;
  private root: HTMLDivElement | null = null;
  private hitTarget: HTMLDivElement | null = null;
  private readonly bubbleView = new BubbleView(this.id);
  private spritesheet: HTMLImageElement | null = null;
  private frameId = 0;
  private running = false;
  private disposed = false;
  private currentPose: PetPoseAnimationId = 'idle';
  private actionId: PetAnimationId | null = null;
  private actionUntilMs = 0;
  private poseStartedAt = 0;
  private renderedFrames = 0;

  capabilities(): RendererCapabilities {
    return {
      actions: [...PET_ACTION_ANIMATION_IDS],
      bubble: true,
      costumes: false,
      hitAreas: true,
    };
  }

  async prepare(context: RendererMountContext): Promise<void> {
    if (this.disposed) throw new Error('sprite renderer has already been disposed');
    this.context = context;
    this.pet = context.pet;
    this.settings = context.settings;

    const root = document.createElement('div');
    root.className = 'pet-sprite';
    root.setAttribute('role', 'img');
    root.dataset.renderer = this.id;
    // Hidden until activate(): prepare must not produce visible output.
    root.hidden = true;

    const hitTarget = document.createElement('div');
    hitTarget.className = 'pet-hit-target';
    hitTarget.dataset.testid = 'pet-hit-target';
    hitTarget.appendChild(root);

    context.host.appendChild(this.bubbleView.node);
    context.host.appendChild(hitTarget);

    this.root = root;
    this.hitTarget = hitTarget;
    context.onHitTargetChange(hitTarget);

    await this.preloadSpritesheet(context.pet);
    this.applySettings(context.settings, context.pet);
  }

  activate(): void {
    if (this.disposed || !this.root) return;
    this.root.hidden = false;
    if (this.running) return;
    this.running = true;
    this.poseStartedAt = now();
    this.frameId = window.requestAnimationFrame(this.tick);
  }

  deactivate(): void {
    this.running = false;
    if (this.frameId !== 0) {
      window.cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
    if (this.root) this.root.hidden = true;
  }

  action(request: ActionRequest): boolean {
    if (this.disposed || !this.root) return false;
    // Runtime animation ids are validated here, not trusted from the transport.
    if (!isPetActionAnimationId(request.animationId)) return false;
    this.actionId = request.animationId;
    this.poseStartedAt = now();
    this.actionUntilMs = this.poseStartedAt + getPetAnimationDurationMs(getPetAnimation(request.animationId));
    this.render();
    return true;
  }

  pose(animationId: string): boolean {
    if (this.disposed || !this.root || !isPetPoseAnimationId(animationId)) return false;
    if (this.currentPose === animationId) return true;
    this.currentPose = animationId;
    this.poseStartedAt = now();
    if (this.actionId === null) this.render();
    return true;
  }

  bubble(text: string | null, ttlMs: number): void {
    if (this.disposed) return;
    this.bubbleView.show(text, ttlMs);
  }

  applySettings(settings: PetSettings, pet: PetCatalogItem): void {
    this.settings = settings;
    this.pet = pet;
    if (!this.root || !this.hitTarget) return;

    const size = getPetSpriteSize(settings.scale);
    this.root.style.width = `${size.width}px`;
    this.root.style.height = `${size.height}px`;
    this.root.setAttribute('aria-label', `${pet.displayName} desktop pet`);

    const url = getPetSpritesheetUrl(pet);
    const background = `url("${url}")`;
    if (this.root.style.backgroundImage !== background) {
      this.root.style.backgroundImage = background;
    }
    const renderScale = getPetRenderScale(settings.scale);
    this.root.style.backgroundSize = `${PET_ATLAS.width * renderScale}px ${
      PET_ATLAS.height * renderScale
    }px`;
    this.root.dataset.reducedMotion = settings.reducedMotion ? 'true' : 'false';

    this.bubbleView.applySettings(settings);
    this.render();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.deactivate();
    if (this.spritesheet) {
      this.spritesheet.src = '';
      this.spritesheet = null;
    }
    this.context?.onHitTargetChange(null);
    this.hitTarget?.remove();
    this.bubbleView.dispose();
    this.root = null;
    this.hitTarget = null;
    this.context = null;
  }

  /** Number of painted frames. Used by slot tests to prove the loop really stops. */
  getRenderedFrameCount(): number {
    return this.renderedFrames;
  }

  diagnostics(): unknown {
    return {
      renderedFrames: this.renderedFrames,
      running: this.running,
      animation: this.actionId ?? this.currentPose,
      pose: this.currentPose,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  private async preloadSpritesheet(pet: PetCatalogItem): Promise<void> {
    const url = getPetSpritesheetUrl(pet);
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`failed to load spritesheet: ${url}`));
    });
    image.src = url;
    try {
      await loaded;
    } catch (error) {
      image.src = '';
      throw new Error(describeError(error));
    }
    this.spritesheet = image;
  }

  private readonly tick = () => {
    if (!this.running) return;
    this.renderedFrames += 1;
    this.render();
    this.frameId = window.requestAnimationFrame(this.tick);
  };

  private render(): void {
    const root = this.root;
    const settings = this.settings;
    if (!root || !settings) return;

    if (this.actionId !== null && now() >= this.actionUntilMs) {
      this.actionId = null;
    }

    const animationId: PetAnimationId = settings.reducedMotion
      ? 'idle'
      : (this.actionId ?? this.currentPose);
    const animation = getPetAnimation(animationId);
    const frame = settings.reducedMotion ? 0 : getPetFrameAtTime(animation, now() - this.poseStartedAt);
    const offset = getPetFrameOffset(animation, frame, settings.scale);
    root.style.backgroundPosition = `${offset.x}px ${offset.y}px`;
    root.dataset.animation = animationId;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
