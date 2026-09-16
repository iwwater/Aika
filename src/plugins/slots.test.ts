import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, FALLBACK_SNAPSHOT, type PetSettings } from '../pet/settings';
import { IdleBehaviorPlugin } from './behaviors/idleBehavior';
import { DefaultMenuPlugin } from './menus/defaultMenu';
import { PluginRegistry } from './registry';
import { RendererHost } from './rendererHost';
import { SpriteRendererPlugin } from './renderers/spriteRenderer';
import type {
  ActionRequest,
  BehaviorContext,
  PetRendererPlugin,
  RendererCapabilities,
  RendererMountContext,
} from './types';

/** Scriptable renderer so slot semantics can be driven without real pixels. */
class FakeRenderer implements PetRendererPlugin {
  readonly displayName: string;
  readonly prepareCalls: string[] = [];
  activateCalls = 0;
  deactivateCalls = 0;
  disposeCalls = 0;
  acceptedActions: string[] = [];
  poses: string[] = [];

  constructor(
    readonly id: string,
    private readonly behaviour: {
      prepare?: () => Promise<void>;
      capabilities?: RendererCapabilities;
      acceptAction?: (request: ActionRequest) => boolean;
    } = {},
  ) {
    this.displayName = id;
  }

  capabilities(): RendererCapabilities {
    return (
      this.behaviour.capabilities ?? {
        actions: ['waving'],
        bubble: true,
        costumes: false,
        hitAreas: false,
      }
    );
  }

  async prepare(): Promise<void> {
    this.prepareCalls.push(this.id);
    if (this.behaviour.prepare) await this.behaviour.prepare();
  }

  activate(): void {
    this.activateCalls += 1;
  }

  deactivate(): void {
    this.deactivateCalls += 1;
  }

  action(request: ActionRequest): boolean {
    const accepted = this.behaviour.acceptAction ? this.behaviour.acceptAction(request) : true;
    if (accepted) this.acceptedActions.push(request.animationId);
    return accepted;
  }

  pose(animationId: string): boolean {
    this.poses.push(animationId);
    return true;
  }

  bubble(): void {}

  applySettings(): void {}

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

/**
 * Renderer that owns a real element and follows the hit-target contract, so the
 * window-level consequences of a slot switch can be asserted without pixels.
 */
class HitTargetRenderer implements PetRendererPlugin {
  readonly displayName: string;
  disposeCalls = 0;
  private context: RendererMountContext | null = null;

  constructor(
    readonly id: string,
    private readonly element: HTMLElement,
  ) {
    this.displayName = id;
  }

  capabilities(): RendererCapabilities {
    return { actions: ['waving'], bubble: true, costumes: false, hitAreas: false };
  }

  async prepare(context: RendererMountContext): Promise<void> {
    this.context = context;
    context.onHitTargetChange(this.element);
  }

  activate(): void {}

  deactivate(): void {}

  action(): boolean {
    return false;
  }

  pose(): boolean {
    return false;
  }

  bubble(): void {}

  applySettings(): void {}

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    // 与两个真实渲染器一致：dispose 会把「自己的」命中元素置空。
    this.context?.onHitTargetChange(null);
    this.context = null;
  }
}

function mountContext(): RendererMountContext {
  return {
    host: document.createElement('div'),
    pet: FALLBACK_SNAPSHOT.activePet,
    settings: DEFAULT_SETTINGS,
    apiBaseUrl: 'http://127.0.0.1:17321',
    onHitTargetChange: () => {},
    onRuntimeFailure: () => {},
  };
}

function hostWith(registry: PluginRegistry, fallbackRendererId = 'sprite'): RendererHost {
  return new RendererHost({ registry, context: mountContext(), fallbackRendererId });
}

function settingsWith(overrides: Partial<PetSettings> = {}): PetSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Registry whose renderers are single instances, so tests can inspect them. */
function registryOf(renderers: FakeRenderer[]): PluginRegistry {
  const registry = new PluginRegistry();
  for (const renderer of renderers) registry.registerRenderer(renderer.id, () => renderer);
  return registry;
}

describe('PluginRegistry', () => {
  it('registers renderer factories and exposes a preferred renderer', () => {
    const registry = new PluginRegistry();
    const sprite = new FakeRenderer('sprite');
    const live2d = new FakeRenderer('live2d');

    registry.registerRenderer('sprite', () => sprite);
    registry.registerRenderer('live2d', () => live2d);
    registry.registerMenu(new DefaultMenuPlugin());

    expect(registry.hasRenderer('sprite')).toBe(true);
    expect(registry.listRendererIds()).toEqual(['sprite', 'live2d']);
    expect(registry.getRendererFactory('sprite')?.()).toBe(sprite);
    expect(registry.preferredRenderer()).toBe('sprite');
    expect(registry.setPreferredRenderer('live2d')).toBe(true);
    expect(registry.preferredRenderer()).toBe('live2d');
    expect(registry.setPreferredRenderer('missing')).toBe(false);
  });

  it('gives each host its own renderer instance so a stale host cannot dispose the live one', async () => {
    const registry = new PluginRegistry();
    let created = 0;
    registry.registerRenderer('sprite', () => {
      created += 1;
      return new FakeRenderer('sprite');
    });

    const hostA = hostWith(registry);
    const hostB = hostWith(registry);
    await hostA.start('sprite');
    await hostB.start('sprite');

    expect(created).toBe(2);
    await hostA.stop();
    // Tearing down host A must leave host B running.
    expect(hostB.getStatus()).toBe('ready');
    expect(hostB.getActiveRendererId()).toBe('sprite');
    await hostB.stop();
  });
});

describe('RendererHost lifecycle', () => {
  it('starts the preferred renderer and reports ready', async () => {
    const sprite = new FakeRenderer('sprite');
    const host = hostWith(registryOf([sprite]));

    await expect(host.start('sprite')).resolves.toBe('ready');
    expect(host.getActiveRendererId()).toBe('sprite');
    expect(sprite.prepareCalls).toEqual(['sprite']);
    expect(sprite.activateCalls).toBe(1);
    expect(host.getCounters().starts).toBe(1);
  });

  it('falls back to the default sprite and reports degraded when the preferred renderer fails', async () => {
    const sprite = new FakeRenderer('sprite');
    const live2d = new FakeRenderer('live2d', {
      prepare: () => Promise.reject(new Error('model missing')),
    });
    const host = hostWith(registryOf([sprite, live2d]));

    await expect(host.start('live2d')).resolves.toBe('degraded');
    expect(host.getActiveRendererId()).toBe('sprite');
    // Degraded must still explain itself.
    expect(host.getLastError()).toContain('model missing');
    expect(host.getCounters().failedPreparations).toBe(1);
  });

  it('reports unavailable when no renderer can be prepared', async () => {
    const sprite = new FakeRenderer('sprite', {
      prepare: () => Promise.reject(new Error('sheet 404')),
    });
    const host = hostWith(registryOf([sprite]));

    await expect(host.start('sprite')).resolves.toBe('unavailable');
    expect(host.getActiveRendererId()).toBeNull();
    expect(host.getLastError()).toContain('sheet 404');
  });

  it('never reports an action as accepted when no renderer is active', async () => {
    const host = hostWith(new PluginRegistry());

    expect(host.action({ animationId: 'waving', source: 'runtime' })).toBe(false);
    expect(host.pose('idle')).toBe(false);
    expect(host.bubble('hi', 1000)).toBe(false);
    expect(host.getCounters().actionsWithoutRenderer).toBe(2);
    expect(host.getCounters().actionsForwarded).toBe(0);
  });

  it('forwards runtime actions to the active renderer and counts refusals separately', async () => {
    const sprite = new FakeRenderer('sprite', {
      acceptAction: (request) => request.animationId === 'waving',
    });
    const host = hostWith(registryOf([sprite]));
    await host.start('sprite');

    expect(host.action({ animationId: 'waving', source: 'runtime' })).toBe(true);
    expect(host.action({ animationId: 'backflip', source: 'runtime' })).toBe(false);
    expect(host.getCounters().actionsForwarded).toBe(1);
    expect(host.getCounters().actionsRefused).toBe(1);
  });

  it('keeps the working renderer when a switch fails, and only commits a switch that prepares', async () => {
    const sprite = new FakeRenderer('sprite');
    const live2d = new FakeRenderer('live2d', {
      prepare: () => Promise.reject(new Error('cubism core blocked by CSP')),
    });
    const three = new FakeRenderer('three');
    const host = hostWith(registryOf([sprite, live2d, three]));
    await host.start('sprite');

    await expect(host.switchTo('live2d')).resolves.toBe(false);
    expect(host.getActiveRendererId()).toBe('sprite');
    expect(host.getStatus()).toBe('degraded');
    expect(sprite.disposeCalls).toBe(0);
    expect(host.getCounters().failedSwitches).toBe(1);

    await expect(host.switchTo('three')).resolves.toBe(true);
    expect(host.getActiveRendererId()).toBe('three');
    expect(host.getStatus()).toBe('ready');
    // Single output: the previous instance is released exactly once.
    expect(sprite.disposeCalls).toBe(1);
  });

  it('discards a slow preparation that a newer start has already superseded', async () => {
    const slowPrepareControl: { release: (() => void) | null } = { release: null };
    const slow = new FakeRenderer('live2d', {
      prepare: () =>
        new Promise<void>((resolve) => {
          slowPrepareControl.release = resolve;
        }),
    });
    const sprite = new FakeRenderer('sprite');
    const host = hostWith(registryOf([slow, sprite]));

    const slowStart = host.start('live2d');
    const spriteStart = host.start('sprite');

    await spriteStart;
    expect(host.getActiveRendererId()).toBe('sprite');

    slowPrepareControl.release?.();
    await slowStart;

    expect(host.getActiveRendererId()).toBe('sprite');
    // The superseded instance is torn down instead of silently staying alive.
    expect(slow.disposeCalls).toBe(1);
    expect(slow.activateCalls).toBe(0);
  });

  it('returns to a clean state after repeated start/stop cycles', async () => {
    const sprite = new FakeRenderer('sprite');
    const host = hostWith(registryOf([sprite]));

    for (let cycle = 0; cycle < 4; cycle += 1) await host.start('sprite');
    expect(sprite.disposeCalls).toBe(3);
    expect(host.getActiveRendererId()).toBe('sprite');

    await host.stop();
    await host.stop();
    expect(host.getActiveRendererId()).toBeNull();
    expect(host.getStatus()).toBe('unavailable');
    expect(sprite.disposeCalls).toBe(4);
    // deactivate runs on every hand-over plus inside dispose, so it can only be >=.
    expect(sprite.deactivateCalls).toBeGreaterThanOrEqual(sprite.disposeCalls);
    expect(host.getCapabilities()).toBeNull();
  });

  it("keeps the incoming renderer's hit target when the superseded renderer is disposed", async () => {
    // 真机缺陷回归：启动时先挂 sprite，真设置到达后切到 live2d；旧实例的 dispose
    // 发生在新实例 prepare 之后。旧实现让旧实例直接清空共享槽位，于是窗口永久失去
    // 命中元素 → 整窗鼠标穿透 → 拖不动、点不动、右键菜单不出来。单测原先看不见。
    const events: Array<HTMLElement | null> = [];
    const context: RendererMountContext = {
      host: document.createElement('div'),
      pet: FALLBACK_SNAPSHOT.activePet,
      settings: DEFAULT_SETTINGS,
      apiBaseUrl: 'http://127.0.0.1:17321',
      onHitTargetChange: (element) => events.push(element),
      onRuntimeFailure: () => {},
    };
    const spriteElement = document.createElement('div');
    const live2dElement = document.createElement('div');
    const sprite = new HitTargetRenderer('sprite', spriteElement);
    const live2d = new HitTargetRenderer('live2d', live2dElement);
    const registry = new PluginRegistry();
    registry.registerRenderer('sprite', () => sprite);
    registry.registerRenderer('live2d', () => live2d);

    const host = new RendererHost({ registry, context, fallbackRendererId: 'sprite' });
    await host.start('sprite');
    expect(events[events.length - 1]).toBe(spriteElement);

    await host.switchTo('live2d');

    expect(host.getActiveRendererId()).toBe('live2d');
    // 当前交互区域必须是新实例的元素。
    expect(events[events.length - 1]).toBe(live2dElement);
    // 被替换的实例确实释放了，但它没能把交互区域清空。
    expect(sprite.disposeCalls).toBe(1);
    expect(events).not.toContain(null);

    // 槽位整体停掉时，交互区域才允许回到「没有」。
    await host.stop();
    expect(events[events.length - 1]).toBeNull();
  });
});

describe('SpriteRendererPlugin', () => {
  class AutoLoadImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = 'async';
    private value = '';
    get src(): string {
      return this.value;
    }
    set src(next: string) {
      this.value = next;
      if (next.length > 0) queueMicrotask(() => this.onload?.());
    }
  }

  beforeEach(() => {
    vi.stubGlobal('Image', AutoLoadImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes over the DOM only after activate and releases it on dispose', async () => {
    const plugin = new SpriteRendererPlugin();
    const context = mountContext();

    await plugin.prepare(context);
    const sprite = context.host.querySelector('.pet-sprite') as HTMLElement;
    expect(sprite).not.toBeNull();
    // prepare() must not produce visible output.
    expect(sprite.hidden).toBe(true);

    plugin.activate();
    expect(sprite.hidden).toBe(false);
    expect(plugin.isRunning()).toBe(true);

    plugin.deactivate();
    expect(plugin.isRunning()).toBe(false);
    expect(sprite.hidden).toBe(true);

    await plugin.dispose();
    expect(context.host.childElementCount).toBe(0);
    // dispose is idempotent
    await plugin.dispose();
    expect(context.host.childElementCount).toBe(0);
  });

  it('refuses unknown actions and poses instead of pretending they played', async () => {
    const plugin = new SpriteRendererPlugin();
    await plugin.prepare(mountContext());

    expect(plugin.capabilities().actions).toContain('waving');
    expect(plugin.action({ animationId: 'waving', source: 'runtime' })).toBe(true);
    expect(plugin.action({ animationId: 'not-a-real-action', source: 'runtime' })).toBe(false);
    expect(plugin.action({ animationId: '', source: 'runtime' })).toBe(false);

    expect(plugin.pose('idle')).toBe(true);
    expect(plugin.pose('running-left')).toBe(true);
    expect(plugin.pose('waving')).toBe(false);

    await plugin.dispose();
  });

  it('rejects prepare when the spritesheet cannot be loaded', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = 'async';
      private value = '';
      get src(): string {
        return this.value;
      }
      set src(next: string) {
        this.value = next;
        // Only the error path fires: the failure must reach prepare(), not be swallowed.
        if (next.length > 0) queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', BrokenImage);

    const plugin = new SpriteRendererPlugin();
    await expect(plugin.prepare(mountContext())).rejects.toThrow(/failed to load spritesheet/);
  });

  it('drives the bubble from the renderer and clears it after the ttl', async () => {
    vi.useFakeTimers();
    try {
      const plugin = new SpriteRendererPlugin();
      const context = mountContext();
      await plugin.prepare(context);
      plugin.activate();

      const bubble = context.host.querySelector('.pet-bubble') as HTMLElement;
      plugin.bubble('hello', 1000);
      expect(bubble.hidden).toBe(false);
      expect(bubble.textContent).toBe('hello');

      vi.advanceTimersByTime(1200);
      expect(bubble.hidden).toBe(true);

      await plugin.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IdleBehaviorPlugin', () => {
  function behaviorContext(overrides: Partial<BehaviorContext> = {}): {
    context: BehaviorContext;
    actions: Array<{ id: string; source: string }>;
    poses: string[];
    clock: { now: number; lastActivity: number };
  } {
    const actions: Array<{ id: string; source: string }> = [];
    const poses: string[] = [];
    // A controllable clock keeps the silence threshold deterministic.
    const clock = { now: 1_000_000, lastActivity: 1_000_000 };
    const context: BehaviorContext = {
      getSettings: () => settingsWith(),
      isPaused: () => false,
      isActionActive: () => false,
      lastActivityAt: () => clock.lastActivity,
      now: () => clock.now,
      requestAction: (animationId, source) => actions.push({ id: animationId, source }),
      requestPose: (animationId) => poses.push(animationId),
      markActivity: () => {},
      ...overrides,
    };
    return { context, actions, poses, clock };
  }

  function buildBehavior() {
    return new IdleBehaviorPlugin({
      environment: {
        readWorkArea: async () => ({
          rect: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1,
        }),
        setWindowPosition: () => {},
        setWindowSize: () => {},
        isNativeWindowAvailable: () => false,
      },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes idle self-play through the action channel instead of touching the renderer', async () => {
    const behavior = buildBehavior();
    const { context, actions } = behaviorContext({
      getSettings: () =>
        settingsWith({ idleSelfPlay: true, idleThresholdMs: 0, idleActionFrequencyMs: 0 }),
    });

    behavior.start(context);
    await vi.advanceTimersByTimeAsync(1200);

    expect(behavior.getIdleCheckCount()).toBeGreaterThan(0);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((entry) => entry.source === 'behavior')).toBe(true);

    await behavior.dispose();
  });

  it('stays quiet while paused, during an action, or before the silence threshold', async () => {
    const behavior = buildBehavior();
    const { context, actions, clock } = behaviorContext({
      getSettings: () =>
        settingsWith({ idleSelfPlay: true, idleThresholdMs: 60_000, idleActionFrequencyMs: 0 }),
    });

    behavior.start(context);
    clock.now += 2500;
    await vi.advanceTimersByTimeAsync(2500);
    expect(behavior.getIdleCheckCount()).toBeGreaterThan(0);
    expect(actions).toHaveLength(0);

    await behavior.dispose();
  });

  it('leaves no timers behind after repeated start/stop', async () => {
    const behavior = buildBehavior();
    const { context, actions, clock } = behaviorContext({
      getSettings: () =>
        settingsWith({ idleSelfPlay: true, idleThresholdMs: 0, idleActionFrequencyMs: 0 }),
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      behavior.start(context);
      clock.now += 1100;
      await vi.advanceTimersByTimeAsync(1100);
      behavior.stop();
    }
    const afterStop = actions.length;
    clock.now += 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(actions).toHaveLength(afterStop);

    await behavior.dispose();
  });
});

describe('DefaultMenuPlugin', () => {
  it('builds entries from the supplied context without mutating the pet directly', async () => {
    const menu = new DefaultMenuPlugin();
    const invoked: string[] = [];
    let settings = settingsWith({ autonomousWalking: false });

    const entries = menu.entries({
      settings,
      language: 'en',
      openSettings: () => {
        invoked.push('open-settings');
      },
      hidePet: () => {
        invoked.push('hide-pet');
      },
      playAction: (animationId) => {
        invoked.push(`action:${animationId}`);
      },
      updateSettings: async (next) => {
        settings = next;
        invoked.push(`walking:${next.autonomousWalking}`);
      },
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'open-settings',
      'wave',
      'toggle-walking',
      'hide-pet',
    ]);
    expect(entries[2]?.label).toBe('Let me roam');

    for (const entry of entries) await entry.run();
    expect(invoked).toEqual(['open-settings', 'action:waving', 'walking:true', 'hide-pet']);
  });

  it('localises entries and reflects the current walking state', () => {
    const menu = new DefaultMenuPlugin();
    const entries = menu.entries({
      settings: settingsWith({ autonomousWalking: true }),
      language: 'zh-CN',
      openSettings: () => {},
      hidePet: () => {},
      playAction: () => {},
      updateSettings: async () => {},
    });

    expect(entries[0]?.label).toBe('打开设置');
    expect(entries[2]?.label).toBe('暂停移动');
  });
});
