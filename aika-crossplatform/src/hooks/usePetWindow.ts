import { useEffect, useMemo, useRef, useState } from "react";
import { useService } from "../app/kernelContext";
import { isTauriHost } from "../app/hosts/detect";
import { HostLifecycleToken } from "../services/runtime/tokens";
import { SettingsToken } from "../services/storage/tokens";
import { createSystemTimers } from "../services/time/systemTime";
import { SETTING_KEYS } from "../services/storage/contracts";
import { CompanionPresenterToken } from "../presentation/tokens";
import { VoicePresenterToken } from "../presentation/tokens";
import { createPetWindowManager, type PetWindowManager } from "../pet/manager";
import { aggregatePresentation } from "../pet/relay";

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
}

export function usePetWindow(): PetWindowState {
  const companion = useService(CompanionPresenterToken);
  const voice = useService(VoicePresenterToken);
  const lifecycle = useService(HostLifecycleToken);
  const settings = useService(SettingsToken);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

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
      aggregate: () => aggregatePresentation(companion, voice),
      epoch: lifecycle.epoch(),
      timers: createSystemTimers(),
    });
  }, [companion, voice, lifecycle]);

  useEffect(() => {
    if (!manager || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      // 启动恢复：读取失败按关闭处理，不自动打开桌宠。
      let enabled = false;
      try {
        enabled = await settings.getBoolean(SETTING_KEYS.petWindowEnabled, false);
      } catch {
        enabled = false;
      }
      if (enabled) {
        try {
          await manager.open();
          setOpen(true);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
  }, [manager, settings]);

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
    openPet: () => run(async (mgr) => {
      await mgr.open();
      setOpen(true);
      await settings.setBoolean(SETTING_KEYS.petWindowEnabled, true);
    }),
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
  };
}
