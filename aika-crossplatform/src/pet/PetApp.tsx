import { useEffect, useMemo, useState } from "react";
import { createPetViewModel, connectPetViewModel, type PetViewModel } from "./petPresentation";
import { AvatarPlaceholder } from "../components/AvatarPlaceholder";
import "./pet.css";

/**
 * 桌宠窗口的 React 入口（FE-20）。
 *
 * 只挂载在 label=pet 的 Tauri 窗口里：不建 KernelProvider、不碰 Runtime/存储/语音，
 * 展示态全部来自 Rust 中继的 pet.presentation.v1 帧。订阅失败/超时只表现为
 * 「没有内容」，绝不影响主窗。
 */

export function bridgeOf(): { invoke(command: string, args?: Record<string, unknown>): Promise<unknown>; listen(event: string, handler: (payload: unknown) => void): Promise<() => void> } {
  // 动态 import：浏览器 dev 里 PetApp 根本不会挂载，但静态分析也只看到 promise。
  return {
    invoke: async (command, args) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke(command, args);
    },
    listen: async (event, handler) => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen(event, (payload) => handler(payload));
    },
  };
}

const PET_CLOCK = { now: () => performance.now() };

export function PetApp() {
  const viewModel = useMemo(() => createPetViewModel(), []);
  const [view, setView] = useState<PetViewModel>(viewModel.snapshot());

  useEffect(() => {
    const unsubscribe = viewModel.subscribe(() => setView(viewModel.snapshot()));
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void connectPetViewModel(bridgeOf(), viewModel, PET_CLOCK).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    // 淡出推进；250ms 与 relay 节流同量级，足够顺滑。
    const advance = setInterval(() => {
      viewModel.advance(PET_CLOCK.now());
      setView(viewModel.snapshot());
    }, 250);
    return () => {
      disposed = true;
      clearInterval(advance);
      unsubscribe();
      unlisten?.();
    };
  }, [viewModel]);

  return <PetController view={view} />;
}

interface PetControllerProps {
  view: PetViewModel;
}

/**
 * 交互层：拖拽（drag region）、左键回主窗、右键菜单。
 * 菜单里的「隐藏」与主窗设置里的开关走同一命令；点击穿透打开后 pet 收不到
 * 任何点击，恢复入口在主窗（不允许依赖已点不到的 pet 菜单）。
 */
export function PetController({ view }: PetControllerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [clickThrough, setClickThrough] = useState(false);

  const invoke = (command: string, args?: Record<string, unknown>): void => {
    void bridgeOf().invoke(command, args).catch(() => undefined);
  };

  return (
    <div className="pet-root">
      <div className="pet-stage" data-tauri-drag-region>
        <div
          className="pet-hit"
          onClick={() => invoke("pet_window_focus_main")}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen((open) => !open);
          }}
        >
          <AvatarPlaceholder />
          {view.speaking && <span className="pet-speaking-dot" aria-label="说话中" />}
        </div>
        <Bubble view={view} />
        {menuOpen && (
          <div className="pet-menu">
            <button
              onClick={() => {
                const next = !clickThrough;
                setClickThrough(next);
                invoke("pet_window_set_click_through", { enabled: next });
                setMenuOpen(false);
              }}
            >
              {clickThrough ? "关闭点击穿透" : "开启点击穿透"}
            </button>
            <button onClick={() => { invoke("pet_window_hide"); setMenuOpen(false); }}>隐藏桌宠</button>
            <button onClick={() => { invoke("pet_window_focus_main"); setMenuOpen(false); }}>打开主窗</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ view }: { view: PetViewModel }) {
  return (
    <div className="pet-bubbles">
      {view.proactive && <div className="pet-bubble proactive">{view.proactive.text}</div>}
      {view.subtitle && <div className="pet-bubble subtitle">{view.subtitle}</div>}
    </div>
  );
}
