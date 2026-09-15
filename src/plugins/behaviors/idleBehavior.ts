import {
  PET_IDLE_SELF_PLAY_ANIMATION_IDS,
  type PetAnimationId,
  type PetSurfaceInsets,
  type PetWindowSize,
  getPetSurfaceInsets,
  getPetSurfaceSize,
  isPetAnimationId,
} from '../../pet/animation';
import {
  type PetMotionState,
  type Rect,
  clampPetMotionToWorkArea,
  createInitialPetMotion,
  createRestingPetMotion,
  resolvePetMotion,
} from '../../pet/motion';
import type { PetSettings } from '../../pet/settings';
import type { BehaviorContext, PetBehaviorPlugin } from '../types';

const MOVE_TICK_MS = 120;
const RESTING_TICK_MS = 1400;
const WORK_AREA_REFRESH_MS = 4000;
const IDLE_SELF_PLAY_CHECK_MS = 1000;

/** Host window services the behavior needs. Injected so the policy stays testable. */
export interface DesktopEnvironment {
  readWorkArea: () => Promise<{ rect: Rect; scaleFactor: number }>;
  setWindowPosition: (x: number, y: number) => void;
  setWindowSize: (size: PetWindowSize) => void;
  isNativeWindowAvailable: () => boolean;
}

export interface IdleBehaviorOptions {
  readonly environment: DesktopEnvironment;
  /** Called after the window surface size changed so the host can relayout. */
  readonly onSurfaceChange?: (size: PetWindowSize, insets: PetSurfaceInsets) => void;
}

function pickIdleAction(settings: PetSettings): PetAnimationId {
  if (settings.idleAction === 'active-action') return settings.clickAction;
  if (settings.idleAction === 'random') {
    const index = Math.floor(Math.random() * PET_IDLE_SELF_PLAY_ANIMATION_IDS.length);
    return PET_IDLE_SELF_PLAY_ANIMATION_IDS[index] ?? 'waving';
  }
  return isPetAnimationId(settings.idleAction) ? settings.idleAction : 'waving';
}

/**
 * Default behavior: desktop motion plus idle self-play.
 *
 * Both paths route through `BehaviorContext.requestAction` / `requestPose`, so the
 * behavior can never bypass the renderer's action validation.
 */
export class IdleBehaviorPlugin implements PetBehaviorPlugin {
  readonly id = 'idle';
  readonly displayName = 'Idle & walking';

  private readonly environment: DesktopEnvironment;
  private readonly onSurfaceChange: (size: PetWindowSize, insets: PetSurfaceInsets) => void;
  private context: BehaviorContext | null = null;
  private motion: PetMotionState | null = null;
  private workArea: Rect | null = null;
  private surfaceSize: PetWindowSize | null = null;
  private surfaceInsets: PetSurfaceInsets = { left: 0, right: 0 };
  private moveTimer: number | null = null;
  private workAreaTimer: number | null = null;
  private idleTimer: number | null = null;
  private lastIdleActionAtMs = 0;
  private idleChecks = 0;

  constructor(options: IdleBehaviorOptions) {
    this.environment = options.environment;
    this.onSurfaceChange = options.onSurfaceChange ?? (() => {});
  }

  start(context: BehaviorContext): void {
    this.stop();
    this.context = context;
    void this.bootstrap();
  }

  stop(): void {
    if (this.moveTimer !== null) window.clearInterval(this.moveTimer);
    if (this.workAreaTimer !== null) window.clearInterval(this.workAreaTimer);
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.moveTimer = null;
    this.workAreaTimer = null;
    this.idleTimer = null;
  }

  async dispose(): Promise<void> {
    this.stop();
    this.context = null;
    this.motion = null;
    this.workArea = null;
    this.surfaceSize = null;
  }

  /** Test/diagnostic hook. */
  getIdleCheckCount(): number {
    return this.idleChecks;
  }

  /** Keep the motion model consistent when the OS moved the window (user drag). */
  syncWindowPosition(position: { x: number; y: number }, scaleFactor: number): void {
    const workArea = this.workArea;
    const surfaceSize = this.surfaceSize;
    if (!workArea || !surfaceSize) return;
    const safeScaleFactor = scaleFactor || 1;
    const current =
      this.motion ?? createRestingPetMotion(workArea, surfaceSize, this.surfaceInsets);
    this.motion = clampPetMotionToWorkArea(
      { ...current, x: position.x / safeScaleFactor, y: position.y / safeScaleFactor },
      workArea,
      surfaceSize,
      this.surfaceInsets,
    );
  }

  private async bootstrap(): Promise<void> {
    const context = this.context;
    if (!context) return;
    this.syncSurface(context.getSettings());

    const area = await this.environment.readWorkArea();
    if (this.context !== context) return; // stopped while reading

    this.workArea = area.rect;
    const surfaceSize = this.surfaceSize ?? { width: 0, height: 0 };
    const settings = context.getSettings();
    this.motion = settings.autonomousWalking
      ? createInitialPetMotion(area.rect, surfaceSize, this.surfaceInsets)
      : createRestingPetMotion(area.rect, surfaceSize, this.surfaceInsets);

    this.move();
    this.moveTimer = window.setInterval(
      () => this.move(),
      settings.autonomousWalking ? MOVE_TICK_MS : RESTING_TICK_MS,
    );
    this.workAreaTimer = window.setInterval(() => void this.refreshWorkArea(), WORK_AREA_REFRESH_MS);
    this.idleTimer = window.setInterval(() => this.checkIdle(), IDLE_SELF_PLAY_CHECK_MS);
  }

  private syncSurface(settings: PetSettings): void {
    const size = getPetSurfaceSize(settings.scale);
    const insets = getPetSurfaceInsets(settings.scale);
    const changed =
      this.surfaceSize === null ||
      this.surfaceSize.width !== size.width ||
      this.surfaceSize.height !== size.height;
    this.surfaceSize = size;
    this.surfaceInsets = insets;
    this.environment.setWindowSize(size);
    if (changed) this.onSurfaceChange(size, insets);
  }

  private async refreshWorkArea(): Promise<void> {
    const context = this.context;
    if (!context) return;
    this.syncSurface(context.getSettings());
    const area = await this.environment.readWorkArea();
    if (this.context !== context) return;
    this.workArea = area.rect;
    const surfaceSize = this.surfaceSize ?? { width: 0, height: 0 };
    this.motion = this.motion
      ? clampPetMotionToWorkArea(this.motion, area.rect, surfaceSize, this.surfaceInsets)
      : settingsWalking(context.getSettings())
        ? createInitialPetMotion(area.rect, surfaceSize, this.surfaceInsets)
        : createRestingPetMotion(area.rect, surfaceSize, this.surfaceInsets);
  }

  private move(): void {
    const context = this.context;
    const workArea = this.workArea;
    const surfaceSize = this.surfaceSize;
    if (!context || !workArea || !surfaceSize) return;

    const settings = context.getSettings();
    if (!this.motion) {
      this.motion = settings.autonomousWalking
        ? createInitialPetMotion(workArea, surfaceSize, this.surfaceInsets)
        : createRestingPetMotion(workArea, surfaceSize, this.surfaceInsets);
    }

    const next = resolvePetMotion({
      state: this.motion,
      workArea,
      surfaceSize,
      surfaceInsets: this.surfaceInsets,
      autonomousWalking: settings.autonomousWalking,
      reducedMotion: settings.reducedMotion,
      paused: context.isPaused(),
      speedPx: settings.walkingSpeedPx,
    });
    this.motion = next;

    // The pose only reaches the renderer; the renderer decides whether it can show it.
    if (!context.isActionActive()) context.requestPose(next.animation);

    if (this.environment.isNativeWindowAvailable()) {
      this.environment.setWindowPosition(Math.round(next.x), Math.round(next.y));
    }
  }

  private checkIdle(): void {
    const context = this.context;
    if (!context) return;
    this.idleChecks += 1;
    const settings = context.getSettings();
    if (!settings.idleSelfPlay || settings.reducedMotion) return;
    if (context.isPaused()) return;
    if (context.isActionActive()) return;

    const now = context.now();
    // Silence threshold first, then the repeat cadence: same order as the window did it.
    if (now - context.lastActivityAt() < settings.idleThresholdMs) return;
    if (now - this.lastIdleActionAtMs < settings.idleActionFrequencyMs) return;
    this.lastIdleActionAtMs = now;
    context.requestAction(pickIdleAction(settings), 'behavior');
  }
}

function settingsWalking(settings: PetSettings): boolean {
  return settings.autonomousWalking && !settings.reducedMotion;
}
