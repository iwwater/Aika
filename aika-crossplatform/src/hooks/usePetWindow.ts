import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useService, useOptionalService } from "../app/kernelContext";
import { isTauriHost } from "../app/hosts/detect";
import { HostLifecycleToken } from "../services/runtime/tokens";
import { SettingsToken } from "../services/storage/tokens";
import { createSystemTimers } from "../services/time/systemTime";
import { SETTING_KEYS } from "../services/storage/contracts";
import { CompanionPresenterToken } from "../presentation/tokens";
import { VoicePresenterToken } from "../presentation/tokens";
import { createPetWindowManager, type PetWindowManager } from "../pet/manager";
import { aggregatePresentation } from "../pet/relay";
import { createPetIntentBridge } from "../pet/intentBridge";
import { createDesktopPetSettings } from "../services/desktopPet/settings";
import { createSystemClock } from "../services/time/systemTime";
import {
  EnvironmentMonitorToken, ScreenContextSourceToken,
} from "../services/environment/contracts";
import { SCREEN_SOURCE_ID } from "../services/environment/screenSource";
import {
  createCompanionSessionController, type CompanionSessionController,
} from "../presentation/companionSessionController";

/**
 * 主窗侧的桌宠控制（FE-20）。
 *
 * 主窗保留全部恢复入口：找回桌宠、关闭穿透、关闭桌宠——不能依赖已无法点击的
 * pet 菜单。开关持久化在 petWindowEnabled；启动时读库自动恢复，读取失败按关。
 * 任何路径都不触碰 Runtime cancel / TTS stop（关闭桌宠不影响主窗对话）。
 */

export interface PetWindowState {
  /** 本宿主具备桌宠能力（Tauri 桌面）。 */
  available: boolean;
  open: boolean;
  busy: boolean;
  error: string | null;
  openPet(): Promise<void>;
  closePet(): Promise<void>;
  resetPosition(): Promise<void>;
  disableClickThrough(): Promise<void>;
  /**
   * 陪伴会话（FE-31）。宿主没有屏幕读取能力时为 null——那时「陪伴」无从谈起，
   * 界面隐藏该分组而不是给一个按下去必然失败的开关。
   */
  session: CompanionSessionController | null;
  sessionView: ReturnType<CompanionSessionController["getSnapshot"]> | null;
  /**
   * 外部桌宠集成已启用，自研窗口让位（PET-06）。
   *
   * 表现出口只能有一个：两个都开会让同一句话被两个窗口各说一遍。
   */
  legacyBlocked: boolean;
  /** 由主窗在外部桌宠开关变化时调用；置真时顺带关掉自研窗口。 */
  applyLegacyBlock(blocked: boolean): void;
}

export function usePetWindow(): PetWindowState {
  const companion = useService(CompanionPresenterToken);
  const voice = useService(VoicePresenterToken);
  const lifecycle = useService(HostLifecycleToken);
  const settings = useService(SettingsToken);

  const screenContext = useOptionalService(ScreenContextSourceToken);
  const monitor = useOptionalService(EnvironmentMonitorToken);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legacyBlocked, setLegacyBlocked] = useState(false);
  const startedRef = useRef(false);
  const desktopPetSettings = useMemo(() => createDesktopPetSettings(settings), [settings]);

  const manager = useMemo<PetWindowManager | null>(() => {
    if (!isTauriHost()) return null;
    return createPetWindowManager({
      bridge: {
        invoke: async (command, args) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke(command, args);
        },
        listen: async (event, handler) => {
          const { listen } = await import("@tauri-apps/api/event");
          return listen(event, (payload) => handler(payload));
        },
      },
      aggregate: () => aggregatePresentation(
        companion,
        voice,
        sessionRef.current,
        sessionRef.current ? `${lifecycle.epoch()}:${managerRef.current?.generation() ?? 0}` : null,
      ),
      epoch: lifecycle.epoch(),
      timers: createSystemTimers(),
    });
  }, [companion, voice, lifecycle]);
  const managerRef = useRef<PetWindowManager | null>(null);
  managerRef.current = manager;

  /**
   * 陪伴会话（FE-31）。
   *
   * 它与 `PetWindowManager` 同属「主窗 Hook 拥有的会话对象」：要同时够到 pet 窗口
   * 命令、屏幕上下文源与既有用户发送路径，而这三者只在这一层同时可见。
   * 缺屏幕读取能力就是 null——不造假实现。
   */
  const session = useMemo<CompanionSessionController | null>(() => {
    if (!manager || !screenContext || !monitor) return null;
    return createCompanionSessionController({
      screenContext,
      sensors: {
        async setScreenEnabled(enabled) {
          // 只操作自己这一条租约；同时落库开关，设置页与它说的是同一件事。
          await monitor.setSourceEnabled(SCREEN_SOURCE_ID, enabled);
          await settings.setBoolean(SETTING_KEYS.environmentScreenEnabled, enabled);
        },
      },
      settings: {
        getString: (key) => settings.getRaw(key),
        setString: (key, value) => settings.setRaw(key, value),
        getBoolean: (key, fallback) => settings.getBoolean(key, fallback),
        setBoolean: (key, value) => settings.setBoolean(key, value),
      },
      pet: {
        open: async () => {
          await manager.open();
          setOpen(true);
          await settings.setBoolean(SETTING_KEYS.petWindowEnabled, true);
        },
        close: async () => {
          await manager.close();
          setOpen(false);
          await settings.setBoolean(SETTING_KEYS.petWindowEnabled, false);
        },
        focusMain: () => manager.focusMain(),
      },
      // pet 的点击与输入映射成**既有**的用户发送路径，不是第二条通道。
      submitUser: async ({ text }) => (await companion.send(text, "text")) !== null,
      /**
       * 自动候选走**既有**共享主动预约（与时间驱动 tick、FE-22 环境触发器同一份
       * 额度与勿扰门禁）。
       *
       * 注意这里只传一个受控标识：屏幕文字摘录不从主动理由进模型，它由 FE-32 的
       * 上下文源在请求装配时按「允许屏幕文字用于对话」单独裁决——没授权就是零摘录。
       */
      submitProactive: () => companion.sendEnvironmentProactive(["screen-text"]),
      clock: createSystemClock(),
    });
  }, [manager, screenContext, monitor, settings, companion]);
  const sessionRef = useRef<CompanionSessionController | null>(null);
  sessionRef.current = session;

  const [sessionView, setSessionView] = useState<PetWindowState["sessionView"]>(null);
  useEffect(() => {
    if (!session) {
      setSessionView(null);
      return;
    }
    setSessionView(session.getSnapshot());
    return session.subscribe(() => setSessionView(session.getSnapshot()));
  }, [session]);

  useEffect(() => {
    if (!manager || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      // 启动恢复：读取失败按关闭处理，不自动打开桌宠。
      let enabled = false;
      try {
        // 首次启动（或旧库损坏后新建设置库）默认展示一次静态桌宠，确保入口可见。
        // 用户主动关闭会持久化 false，后续启动尊重该选择。
        enabled = await settings.getBoolean(SETTING_KEYS.petWindowEnabled, true);
      } catch {
        enabled = false;
      }
      // 外部桌宠集成开着就让位：两个表现出口同时开会让同一句话被说两遍。
      let desktopPetEnabled = false;
      try {
        desktopPetEnabled = await desktopPetSettings.isEnabled();
      } catch {
        desktopPetEnabled = false;
      }
      setLegacyBlocked(desktopPetEnabled);
      if (desktopPetEnabled) return;
      if (enabled) {
        try {
          await manager.open();
          setOpen(true);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
  }, [manager, settings, desktopPetSettings]);

  const applyLegacyBlock = useCallback((blocked: boolean) => {
    setLegacyBlocked(blocked);
    const mgr = managerRef.current;
    if (blocked && mgr?.isOpen()) {
      // 切到外部桌宠时立刻收起自研窗口；关窗不取消主窗对话、也不停 TTS。
      void mgr.close().then(() => setOpen(false)).catch(() => undefined);
    }
  }, []);

  // pet → 主窗的受控意图：Rust 校验窗口 label，这里再过形状白名单与会话裁决。
  useEffect(() => {
    if (!session || !manager) return;
    const bridge = createPetIntentBridge({
      bridge: {
        listen: async (event, handler) => {
          const { listen } = await import("@tauri-apps/api/event");
          return listen(event, (payload) => handler(payload));
        },
      },
      sink: session,
      currentPetEpoch: () => `${lifecycle.epoch()}:${manager.generation()}`,
    });
    void bridge.start();
    void session.start();
    return () => {
      bridge.stop();
    };
  }, [session, manager, lifecycle]);

  const run = async (action: (mgr: PetWindowManager) => Promise<void>): Promise<void> => {
    if (!manager) return;
    setBusy(true);
    try {
      await action(manager);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return {
    available: manager !== null,
    open,
    busy,
    error,
    legacyBlocked,
    applyLegacyBlock,
    openPet: () => {
      if (legacyBlocked) {
        setError("外部桌宠集成已启用：先关闭它，才能显示 Aiki 自研的桌宠窗口。");
        return Promise.resolve();
      }
      return run(async (mgr) => {
        await mgr.open();
        setOpen(true);
        await settings.setBoolean(SETTING_KEYS.petWindowEnabled, true);
      });
    },
    closePet: () => run(async (mgr) => {
      await mgr.close();
      setOpen(false);
      // 先关内存状态再持久化；写失败错误可见。
      try {
        await settings.setBoolean(SETTING_KEYS.petWindowEnabled, false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }),
    resetPosition: () => run((mgr) => mgr.resetPosition()),
    disableClickThrough: () => run((mgr) => mgr.setClickThrough(false)),
    session,
    sessionView,
  };
}
