import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  LogicalPosition,
  LogicalSize,
  availableMonitors,
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  primaryMonitor,
} from '@tauri-apps/api/window';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type PetAnimationId,
  getPetAnimation,
  getPetAnimationDurationMs,
  isPetAnimationId,
  pickPetActionFromPool,
} from './pet/animation';
import { createClickReportGate, type ClickReportGate } from './pet/clickChannel';
import { type Rect, fallbackWorkArea } from './pet/motion';
import {
  type ActionPayload,
  FALLBACK_SNAPSHOT,
  type PetSettings,
  type RuntimeSnapshot,
  type SayPayload,
  isPetRendererId,
} from './pet/settings';
import { IdleBehaviorPlugin, type DesktopEnvironment } from './plugins/behaviors/idleBehavior';
import { DefaultMenuPlugin } from './plugins/menus/defaultMenu';
import { PluginRegistry } from './plugins/registry';
import { RendererHost } from './plugins/rendererHost';
import { Live2dRendererPlugin } from './plugins/renderers/live2dRenderer';
import { live2dAppearanceOptions } from './plugins/renderers/live2d/catalog';
import { SpriteRendererPlugin } from './plugins/renderers/spriteRenderer';
import type {
  MenuEntry,
  PetBehaviorPlugin,
  RendererMountContext,
  SlotStatus,
} from './plugins/types';

const DEFAULT_BUBBLE_TTL_MS = 4000;
const DRAG_START_DISTANCE_PX = 4;
const CURSOR_HIT_TEST_MS = 80;
const PET_HIT_TARGET_PADDING_PX = 4;
const CONTEXT_MENU_MARGIN_PX = 8;
const FALLBACK_RENDERER_ID = 'sprite';

type MonitorWorkArea = {
  rect: Rect;
  scaleFactor: number;
};

type DragState = {
  pointerId: number;
  startPointer: { x: number; y: number };
  latestPointer: { x: number; y: number };
  startWindow: { x: number; y: number };
  nativeDragging: boolean;
  started: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
};

function monitorWorkAreaToLogical(
  area: { position: { x: number; y: number }; size: { width: number; height: number } },
  scaleFactor: number,
): Rect {
  const safeScaleFactor = scaleFactor || 1;
  return {
    x: area.position.x / safeScaleFactor,
    y: area.position.y / safeScaleFactor,
    width: area.size.width / safeScaleFactor,
    height: area.size.height / safeScaleFactor,
  };
}

async function readWorkArea(): Promise<MonitorWorkArea> {
  try {
    const [current, primary, monitors] = await Promise.all([
      currentMonitor(),
      primaryMonitor(),
      availableMonitors(),
    ]);
    const monitor = current ?? primary ?? monitors[0];
    if (monitor?.workArea) {
      const scaleFactor = monitor.scaleFactor || 1;
      return {
        scaleFactor,
        rect: monitorWorkAreaToLogical(monitor.workArea, scaleFactor),
      };
    }
  } catch {
    // Browser preview and unsupported hosts fall back to screen bounds.
  }
  return { rect: fallbackWorkArea(), scaleFactor: 1 };
}

function hasTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function pickClickAction(settings: PetSettings): PetAnimationId {
  if (settings.clickActionMode === 'fixed') return settings.clickAction;
  return pickPetActionFromPool(settings.clickActionPool, settings.clickAction || 'waving');
}

function pointInElementRect(
  element: HTMLElement | null,
  point: { x: number; y: number },
  padding = 0,
): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return (
    point.x >= rect.left - padding &&
    point.x <= rect.right + padding &&
    point.y >= rect.top - padding &&
    point.y <= rect.bottom + padding
  );
}

/**
 * The window is now a transport + chrome shell:
 *   - it subscribes to runtime events and forwards them into the active renderer
 *   - the visible pet, the bubble and the idle policy all live behind plugin slots
 *   - the four HTTP endpoints are untouched and unaware of which renderer is running
 */
export function PetWindow() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(FALLBACK_SNAPSHOT);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [slotStatus, setSlotStatus] = useState<SlotStatus>('unavailable');
  const [slotMessage, setSlotMessage] = useState<string | null>(null);
  /**
   * 当前真正在输出的 renderer id。
   *
   * 单独存一份是因为 `slotStatus` 在 ready→ready 的切换里**不会变**，而菜单与
   * 能力相关的 UI 必须在 renderer 换人之后重建——只盯着 status 会留下过期入口。
   */
  const [slotRenderer, setSlotRenderer] = useState<string | null>(null);
  const [menuEntries, setMenuEntries] = useState<readonly MenuEntry[]>([]);

  const actionActiveUntilRef = useRef(0);
  const cursorEventsIgnoredRef = useRef<boolean | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const draggingRef = useRef(false);
  const hoveredRef = useRef(false);
  const suppressClickRef = useRef(false);
  /** 反向点击通道的冷却闸门（MVP-12）；懒初始化，避免每次渲染都新建一个。 */
  const clickReportGateRef = useRef<ClickReportGate | null>(null);
  if (clickReportGateRef.current === null) clickReportGateRef.current = createClickReportGate();
  const lastActivityRef = useRef(Date.now());
  const hostElementRef = useRef<HTMLDivElement | null>(null);
  const hitTargetRef = useRef<HTMLElement | null>(null);
  const detachHoverRef = useRef<(() => void) | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const registryRef = useRef<PluginRegistry | null>(null);
  const rendererHostRef = useRef<RendererHost | null>(null);
  const behaviorRef = useRef<PetBehaviorPlugin | null>(null);
  /** 最近一次**发起过**的切换目标，用来避免同一个失败目标被反复重试。 */
  const requestedRendererRef = useRef<string | null>(null);
  const snapshotRef = useRef(snapshot);

  snapshotRef.current = snapshot;

  const tauriAvailable = hasTauriRuntime();
  const settings = snapshot.settings;
  const language = settings.language === 'zh-CN' ? 'zh-CN' : 'en';

  const markActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  const setPetHovered = useCallback(
    (active: boolean, markAsActivity = false) => {
      if (hoveredRef.current === active) return;
      hoveredRef.current = active;
      if (active && markAsActivity) markActivity();
      setHovered(active);
    },
    [markActivity],
  );

  const behaviorPaused = useCallback(
    () =>
      draggingRef.current ||
      contextMenuRef.current !== null ||
      (snapshotRef.current.settings.hoverPause && hoveredRef.current),
    [],
  );

  const isActionActive = useCallback(() => Date.now() < actionActiveUntilRef.current, []);

  /** Single entry point for every action, local or from the runtime. */
  const dispatchAction = useCallback(
    (animationId: string, source: 'runtime' | 'local' | 'behavior'): boolean => {
      markActivity();
      const host = rendererHostRef.current;
      if (!host) return false;
      const accepted = host.action({ animationId, source });
      if (accepted && isPetAnimationId(animationId)) {
        const duration = getPetAnimationDurationMs(getPetAnimation(animationId));
        actionActiveUntilRef.current = Date.now() + duration;
      }
      return accepted;
    },
    [markActivity],
  );

  const applySettingsToRenderer = useCallback((next: PetSettings, nextSnapshot: RuntimeSnapshot) => {
    rendererHostRef.current?.applySettings(next, nextSnapshot.activePet);
  }, []);

  const updatePetSettings = useCallback(
    async (nextSettings: PetSettings) => {
      setSnapshot((current) => {
        const next = { ...current, settings: nextSettings };
        applySettingsToRenderer(nextSettings, next);
        return next;
      });
      if (!tauriAvailable) return;
      try {
        const next = await invoke<RuntimeSnapshot>('update_settings', { settings: nextSettings });
        setSnapshot(next);
        applySettingsToRenderer(next.settings, next);
      } catch {
        // The pet should remain usable even when previewed outside the Tauri runtime.
      }
    },
    [applySettingsToRenderer, tauriAvailable],
  );

  const openSettings = useCallback(async () => {
    setContextMenu(null);
    if (!tauriAvailable) return;
    await invoke('open_settings').catch(() => {});
  }, [tauriAvailable]);

  const hidePet = useCallback(async () => {
    setContextMenu(null);
    if (!tauriAvailable) return;
    await invoke('hide_pet').catch(() => {});
  }, [tauriAvailable]);

  // ---- plugin wiring -------------------------------------------------------

  const registry = useMemo(() => {
    if (registryRef.current) return registryRef.current;
    const next = new PluginRegistry();
    next.registerRenderer('sprite', () => new SpriteRendererPlugin());
    // Live2D 依赖（PixiJS + 显示库 + Cubism Core）只在真正选中时才加载，
    // 走 renderer 内部的动态 import，不进 sprite 路径的包。
    next.registerRenderer('live2d', () => new Live2dRendererPlugin());
    next.registerBehavior('idle', () => new IdleBehaviorPlugin({
      environment: {
        readWorkArea,
        setWindowPosition: (x, y) => {
          if (!tauriAvailable || draggingRef.current) return;
          void getCurrentWindow()
            .setPosition(new LogicalPosition(x, y))
            .catch(() => {});
        },
        setWindowSize: (size) => {
          if (!tauriAvailable) return;
          void getCurrentWindow()
            .setSize(new LogicalSize(size.width, size.height))
            .catch(() => {});
        },
        isNativeWindowAvailable: () => tauriAvailable,
      } satisfies DesktopEnvironment,
    }));
    next.registerMenu(new DefaultMenuPlugin());
    registryRef.current = next;
    return next;
  }, [tauriAvailable]);

  useEffect(() => {
    const hostElement = hostElementRef.current;
    if (!hostElement) return;

    // Each host owns a private container, and mounting atomically replaces whatever a
    // previous host left behind. Without this, React's double-mount leaves two
    // renderer instances in the document at the same time.
    const rendererContainer = document.createElement('div');
    rendererContainer.className = 'pet-renderer-container';
    rendererContainer.dataset.rendererHost = 'true';
    hostElement.replaceChildren(rendererContainer);

    const mountContext: RendererMountContext = {
      host: rendererContainer,
      pet: snapshotRef.current.activePet,
      settings: snapshotRef.current.settings,
      // 模型不入包（MVP-14），Live2D 渲染器靠这个基址从回环 API 取模型文件。
      apiBaseUrl: snapshotRef.current.apiBaseUrl,
      onHitTargetChange: (element) => {
        detachHoverRef.current?.();
        detachHoverRef.current = null;
        hitTargetRef.current = element;
        if (!element) return;
        // Hover feedback has to live on the renderer's own element, which appears
        // and disappears with the renderer instance.
        const enter = () => setPetHovered(true, true);
        const leave = () => setPetHovered(false);
        element.addEventListener('mouseenter', enter);
        element.addEventListener('mouseleave', leave);
        detachHoverRef.current = () => {
          element.removeEventListener('mouseenter', enter);
          element.removeEventListener('mouseleave', leave);
        };
      },
      onRuntimeFailure: (reason) => {
        setSlotMessage(reason);
        setSlotStatus('degraded');
      },
    };

    const host = new RendererHost({
      registry,
      context: mountContext,
      fallbackRendererId: FALLBACK_RENDERER_ID,
    });
    rendererHostRef.current = host;

    const createBehavior = registry.getBehaviorFactory('idle');
    const behavior = createBehavior ? createBehavior() : null;
    if (behavior) {
      behaviorRef.current = behavior;
      behavior.start({
        getSettings: () => snapshotRef.current.settings,
        isPaused: behaviorPaused,
        isActionActive,
        lastActivityAt: () => lastActivityRef.current,
        now: () => Date.now(),
        requestAction: (animationId, source) => {
          dispatchAction(animationId, source);
        },
        requestPose: (animationId) => {
          rendererHostRef.current?.pose(animationId);
        },
        markActivity,
      });
    }

    const preferred = snapshotRef.current.settings.renderer;
    let cancelled = false;
    void host.start(isPetRendererId(preferred) ? preferred : registry.preferredRenderer()).then(
      (status) => {
        setSlotRenderer(host.getActiveRendererId());
        if (cancelled) return;
        setSlotStatus(status);
        setSlotMessage(host.getLastError());
      },
    );

    return () => {
      cancelled = true;
      behaviorRef.current?.dispose();
      behaviorRef.current = null;
      rendererHostRef.current = null;
      detachHoverRef.current?.();
      detachHoverRef.current = null;
      void host.stop().then(() => rendererContainer.remove());
    };
  }, [behaviorPaused, dispatchAction, isActionActive, markActivity, registry, setPetHovered]);

  // Test/diagnostic hook used by the slot regression suite.
  useEffect(() => {
    (window as unknown as { __petSlots?: () => unknown }).__petSlots = () => ({
      status: rendererHostRef.current?.getStatus() ?? 'unavailable',
      activeRenderer: rendererHostRef.current?.getActiveRendererId() ?? null,
      capabilities: rendererHostRef.current?.getCapabilities() ?? null,
      counters: rendererHostRef.current?.getCounters() ?? null,
      lastError: rendererHostRef.current?.getLastError() ?? null,
      diagnostics: rendererHostRef.current?.getDiagnostics() ?? null,
    });
  }, []);

  useEffect(() => {
    const host = rendererHostRef.current;
    // 换装入口来自**当前 renderer 的能力声明**，不是菜单自己去猜。
    const supportsCostumes = host?.getCapabilities()?.costumes === true;
    setMenuEntries(
      registry.getMenu('default')?.entries({
        settings,
        language,
        openSettings,
        hidePet,
        playAction: (animationId) => {
          dispatchAction(animationId, 'local');
        },
        updateSettings: updatePetSettings,
        ...(supportsCostumes ? { appearances: live2dAppearanceOptions() } : {}),
      }) ?? [],
    );
  }, [
    dispatchAction,
    hidePet,
    language,
    openSettings,
    registry,
    settings,
    slotRenderer,
    slotStatus,
    updatePetSettings,
  ]);

  // 表现出口切换：设置变了就请宿主换 renderer；失败保留旧出口（宿主负责）。
  //
  // 判定以**宿主真实的活跃 renderer** 为准，不用「我上次设过什么」的记录：设置是
  // 异步到的（先渲染 fallback，再拿运行期快照），用一个本地 ref 记「已应用」会在
  // 快照先到时把自己锁死——那正是第一次跑这条路径时的症状：设置里写着 live2d，
  // 活跃的却一直是 sprite。
  useEffect(() => {
    const host = rendererHostRef.current;
    if (!host) return;
    const target = settings.renderer;
    const active = host.getActiveRendererId();
    if (active === target) {
      requestedRendererRef.current = target;
      return;
    }
    // 还没提交出第一个 renderer：等它落地，slotStatus 变化会再进来。
    if (active === null) return;
    // 同一个目标只尝试一次。失败由宿主如实标成 degraded，不在这里反复重试。
    if (requestedRendererRef.current === target) return;
    requestedRendererRef.current = target;
    void host.switchTo(target).then(() => {
      setSlotRenderer(host.getActiveRendererId());
      setSlotStatus(host.getStatus());
      setSlotMessage(host.getLastError());
    });
  }, [settings.renderer, slotStatus]);

  // ---- interaction ---------------------------------------------------------

  const handlePetClick = useCallback(() => {
    if (contextMenu) {
      setContextMenu(null);
      return;
    }
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const action = pickClickAction(settings);
    dispatchAction(isPetAnimationId(action) ? action : 'waving', 'local');
    // 反向通道（MVP-12）：只把这个事实报给派生我们的 Aiki，**不生成业务轮**——
    // 是否回应、怎么回应由 Aiki 决定。冷却窗口把双击折叠成一次；只有宿主拿到了
    // 凭据才有请求，attach 实例是零请求。失败只记账，不打扰点击。
    if (tauriAvailable && clickReportGateRef.current?.shouldReport()) {
      void invoke('report_pet_click').catch(() => {});
    }
  }, [contextMenu, dispatchAction, settings, tauriAvailable]);

  const handlePetKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      handlePetClick();
    },
    [handlePetClick],
  );

  const setDragActive = useCallback((active: boolean) => {
    draggingRef.current = active;
    setDragging(active);
  }, []);

  const moveManualDrag = useCallback(
    (state: DragState) => {
      const motion = behaviorRef.current;
      const scaleFactor = window.devicePixelRatio || 1;
      // Manual fallback while `startDragging` is unavailable; the behavior clamps it.
      const x = state.startWindow.x + (state.latestPointer.x - state.startPointer.x);
      const y = state.startWindow.y + (state.latestPointer.y - state.startPointer.y);
      motion?.syncWindowPosition?.({ x, y }, scaleFactor);
      if (tauriAvailable) {
        void getCurrentWindow()
          .setPosition(new LogicalPosition(Math.round(x), Math.round(y)))
          .catch(() => {});
      }
    },
    [tauriAvailable],
  );

  const finishDrag = useCallback(
    (pointerId?: number) => {
      const state = dragStateRef.current;
      if (!state || (pointerId !== undefined && state.pointerId !== pointerId)) return;
      state.nativeDragging = false;
      dragStateRef.current = null;
      setDragActive(false);
    },
    [setDragActive],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      markActivity();
      setContextMenu(null);
      dragStateRef.current = {
        pointerId: event.pointerId,
        startPointer: { x: event.screenX, y: event.screenY },
        latestPointer: { x: event.screenX, y: event.screenY },
        startWindow: { x: window.screenX, y: window.screenY },
        nativeDragging: false,
        started: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [markActivity],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      state.latestPointer = { x: event.screenX, y: event.screenY };
      const distance = Math.hypot(
        state.latestPointer.x - state.startPointer.x,
        state.latestPointer.y - state.startPointer.y,
      );
      if (!state.started && distance >= DRAG_START_DISTANCE_PX) {
        state.started = true;
        suppressClickRef.current = true;
        setDragActive(true);
        if (tauriAvailable) {
          state.nativeDragging = true;
          void getCurrentWindow()
            .startDragging()
            .catch(() => {
              if (dragStateRef.current !== state) return;
              state.nativeDragging = false;
              moveManualDrag(state);
            });
          return;
        }
      }
      if (state.nativeDragging) return;
      if (state.started) moveManualDrag(state);
    },
    [moveManualDrag, setDragActive, tauriAvailable],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (state?.pointerId === event.pointerId && state.started) event.preventDefault();
      finishDrag(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [finishDrag],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      finishDrag();
      dispatchAction('review', 'local');
      // 只取点击点：菜单真实高度随条目数变化（换装项就是动态加的），
      // 用常数估算会让末尾几条落到视口外、点不到。定位交给下面的实测收敛。
      setContextMenu({ x: event.clientX, y: event.clientY });
    },
    [dispatchAction, finishDrag],
  );

  /**
   * 按**实测**尺寸把菜单收进视口。
   *
   * 之前的写法用一个写死的 `CONTEXT_MENU_HEIGHT` 夹住 y，菜单一长（MVP-11 加了
   * 外观项）末尾条目就落到视口外：元素存在、可见、但点不到。
   */
  useLayoutEffect(() => {
    const element = contextMenuRef.current;
    if (!contextMenu || !element) return;
    const margin = CONTEXT_MENU_MARGIN_PX;
    const rect = element.getBoundingClientRect();
    let { x, y } = contextMenu;
    if (rect.right > window.innerWidth - margin) x -= rect.right - (window.innerWidth - margin);
    if (rect.bottom > window.innerHeight - margin) y -= rect.bottom - (window.innerHeight - margin);
    x = Math.max(margin, x);
    y = Math.max(margin, y);
    if (x !== contextMenu.x || y !== contextMenu.y) setContextMenu({ x, y });
  }, [contextMenu]);

  // ---- window plumbing -----------------------------------------------------

  useEffect(() => {
    if (!tauriAvailable) return;

    const appWindow = getCurrentWindow();
    let cancelled = false;

    const setIgnoreCursorEvents = async (ignore: boolean) => {
      if (cursorEventsIgnoredRef.current === ignore) return;
      cursorEventsIgnoredRef.current = ignore;
      await appWindow.setIgnoreCursorEvents(ignore).catch(() => {
        cursorEventsIgnoredRef.current = null;
      });
    };

    const syncCursorHitTarget = async () => {
      if (cancelled) return;
      if (draggingRef.current) {
        setPetHovered(true);
        await setIgnoreCursorEvents(false);
        return;
      }

      try {
        const [cursor, windowPosition, scaleFactor] = await Promise.all([
          cursorPosition(),
          appWindow.innerPosition(),
          appWindow.scaleFactor(),
        ]);
        if (cancelled) return;

        const safeScaleFactor = scaleFactor || window.devicePixelRatio || 1;
        const point = {
          x: (cursor.x - windowPosition.x) / safeScaleFactor,
          y: (cursor.y - windowPosition.y) / safeScaleFactor,
        };
        const overSprite = pointInElementRect(
          hitTargetRef.current,
          point,
          PET_HIT_TARGET_PADDING_PX,
        );
        const overContextMenu = pointInElementRect(contextMenuRef.current, point);

        setPetHovered(overSprite, overSprite);
        await setIgnoreCursorEvents(!(overSprite || overContextMenu));
      } catch {
        await setIgnoreCursorEvents(false);
      }
    };

    void syncCursorHitTarget();
    const timer = window.setInterval(() => void syncCursorHitTarget(), CURSOR_HIT_TEST_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      cursorEventsIgnoredRef.current = null;
      void appWindow.setIgnoreCursorEvents(false).catch(() => {});
    };
  }, [setPetHovered, tauriAvailable]);

  useEffect(() => {
    if (!tauriAvailable) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onMoved(({ payload }) => {
        if (cancelled) return;
        // Keep the behavior's motion model in step with the OS window position.
        void getCurrentWindow()
          .scaleFactor()
          .then((scaleFactor) => behaviorRef.current?.syncWindowPosition?.(payload, scaleFactor))
          .catch(() => {});
      })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tauriAvailable]);

  useEffect(() => {
    if (!tauriAvailable) return;

    let cancelled = false;
    void invoke<RuntimeSnapshot>('get_runtime_snapshot')
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        rendererHostRef.current?.applySettings(next.settings, next.activePet);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tauriAvailable]);

  useEffect(() => {
    if (!tauriAvailable) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<ActionPayload>('pet-action', (event) => {
        if (cancelled) return;
        // Unvalidated ids are dropped here; the renderer validates a second time.
        dispatchAction(event.payload.animationId, 'runtime');
      }),
      listen<SayPayload>('pet-say', (event) => {
        if (cancelled) return;
        markActivity();
        rendererHostRef.current?.bubble(
          event.payload.text,
          event.payload.ttlMs ?? DEFAULT_BUBBLE_TTL_MS,
        );
      }),
      listen<PetSettings>('pet-settings', (event) => {
        if (cancelled) return;
        setSnapshot((current) => ({ ...current, settings: event.payload }));
        rendererHostRef.current?.applySettings(event.payload, snapshotRef.current.activePet);
      }),
      listen<RuntimeSnapshot>('runtime-status', (event) => {
        if (cancelled) return;
        setSnapshot(event.payload);
        rendererHostRef.current?.applySettings(event.payload.settings, event.payload.activePet);
      }),
    ])
      .then((next) => unlisteners.push(...next))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [dispatchAction, markActivity, tauriAvailable]);

  useEffect(() => {
    if (!contextMenu) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [contextMenu]);

  useEffect(() => {
    // Surface resize on scale change; the behavior owns placement and timing.
    // Must stay behind the runtime guard: the window API throws outside Tauri.
    if (!tauriAvailable) return;
    const behavior = behaviorRef.current;
    if (!behavior) return;
    void getCurrentWindow()
      .scaleFactor()
      .then((scaleFactor) =>
        behavior.syncWindowPosition?.({ x: window.screenX, y: window.screenY }, scaleFactor),
      )
      .catch(() => {});
  }, [settings.scale, tauriAvailable]);

  return (
    <div
      className={`pet-window${dragging ? ' dragging' : ''}`}
      role="button"
      tabIndex={0}
      aria-label="PetShell desktop pet window"
      onClick={handlePetClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handlePetKeyDown}
      onLostPointerCapture={() => finishDrag()}
      onPointerCancel={() => finishDrag()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div
        ref={hostElementRef}
        className="pet-surface"
        data-testid="pet-surface"
        data-renderer={slotStatus === 'unavailable' ? 'none' : undefined}
      />
      {slotStatus === 'unavailable' && (
        <div className="pet-slot-notice" role="status">
          {language === 'zh-CN' ? '宠物渲染器不可用' : 'Pet renderer unavailable'}
        </div>
      )}
      {slotStatus === 'degraded' && (
        <div className="pet-slot-notice degraded" role="status" title={slotMessage ?? undefined}>
          {language === 'zh-CN' ? '已回退到默认外观' : 'Falling back to default renderer'}
        </div>
      )}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="pet-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label={language === 'zh-CN' ? '宠物操作' : 'Pet actions'}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menuEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              data-menu-entry={entry.id}
              onClick={() => {
                setContextMenu(null);
                void entry.run();
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
