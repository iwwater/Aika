import { useEffect, useMemo, useRef, useState } from "react";
import { createPetViewModel, connectPetViewModel, type PetViewModel } from "./petPresentation";
import {
  PET_INTENT_COMMAND,
  PET_INTENT_SCHEMA,
  PET_INTENT_TEXT_LIMIT,
  type PetIntentKind,
} from "./petIntent";
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
 * 交互层：拖拽（drag region）、左键快捷操作、右键菜单、轻量输入（FE-31）。
 *
 * pet 能做的事只有 `pet.intent.v1` 里那 5 种；它不碰 Runtime、存储、语音，
 * 也拿不到任何屏幕文字。**拖动结束不算点击**——按下与抬起的位移超过阈值就
 * 当成拖窗，不展开快捷操作。
 */

/** 位移超过它就算拖动，不算点击。 */
const DRAG_SLOP_PX = 4;

export function PetController({ view }: PetControllerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const pressRef = useRef<{ x: number; y: number } | null>(null);

  const invoke = (command: string, args?: Record<string, unknown>): void => {
    void bridgeOf().invoke(command, args).catch(() => undefined);
  };

  /**
   * 提交一条受控意图。requestId 每次新生成：主窗按它去重，
   * 双击/重放最多只算一轮。epoch 原样带回主窗下发的值，没有就不发
   * （宁可不响应，也不伪造一个 epoch 去撞运气）。
   */
  const submitIntent = (kind: PetIntentKind, text?: string): void => {
    if (!view.petEpoch) return;
    invoke(PET_INTENT_COMMAND, {
      payload: {
        schemaVersion: PET_INTENT_SCHEMA,
        requestId: crypto.randomUUID(),
        petEpoch: view.petEpoch,
        kind,
        ...(kind === "talk" ? { text } : {}),
      },
    });
  };

  const companionReading = view.companion?.readState === "reading";

  return (
    <div className="pet-root">
      <div className="pet-stage" data-tauri-drag-region>
        <div
          className="pet-hit"
          onPointerDown={(event) => {
            pressRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={(event) => {
            const press = pressRef.current;
            pressRef.current = null;
            if (!press) return;
            const moved = Math.abs(event.clientX - press.x) > DRAG_SLOP_PX
              || Math.abs(event.clientY - press.y) > DRAG_SLOP_PX;
            // 拖动结束不算点击：只把窗口挪了个位置，不展开任何东西。
            if (moved) return;
            setActionsOpen((open) => !open);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen((open) => !open);
          }}
        >
          <AvatarPlaceholder />
          {view.speaking && <span className="pet-speaking-dot" aria-label="说话中" />}
        </div>
        {view.companion && view.companion.mode !== "off" && (
          <div className="pet-session-state">
            {view.companion.mode === "active" ? "主动陪伴" : "安静陪伴"}
            {companionReading ? " · 正在读屏" : view.companion.readState === "paused" ? " · 已暂停读屏" : ""}
          </div>
        )}
        {view.companion?.notice && <div className="pet-session-notice">{view.companion.notice}</div>}
        <Bubble view={view} />
        {actionsOpen && (
          <div className="pet-menu pet-actions">
            <button onClick={() => { submitIntent("screen_talk"); setActionsOpen(false); }}>看屏幕聊聊</button>
            <button onClick={() => { setInputOpen(true); setActionsOpen(false); }}>聊两句</button>
            <button onClick={() => { submitIntent("pause_reading"); setActionsOpen(false); }}>暂停读屏</button>
            <button onClick={() => { submitIntent("end_session"); setActionsOpen(false); }}>结束陪伴</button>
            <button onClick={() => { submitIntent("open_main"); setActionsOpen(false); }}>打开主窗口</button>
          </div>
        )}
        {inputOpen && (
          <form
            className="pet-input"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              submitIntent("talk", text.slice(0, PET_INTENT_TEXT_LIMIT));
              setDraft("");
              setInputOpen(false);
            }}
          >
            <input
              autoFocus
              value={draft}
              maxLength={PET_INTENT_TEXT_LIMIT}
              placeholder="说点什么…"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit">发送</button>
            <button type="button" onClick={() => { setDraft(""); setInputOpen(false); }}>取消</button>
          </form>
        )}
        {menuOpen && (
          <div className="pet-menu">
            <button
              onClick={() => {
                const next = !clickThroughRef.current;
                clickThroughRef.current = next;
                invoke("pet_window_set_click_through", { enabled: next });
                setMenuOpen(false);
              }}
            >
              切换点击穿透
            </button>
            <button onClick={() => { invoke("pet_window_hide"); setMenuOpen(false); }}>隐藏桌宠</button>
            <button onClick={() => { submitIntent("open_main"); setMenuOpen(false); }}>打开主窗</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 穿透开关只是一个本地切换标志；恢复入口始终在主窗（点不到 pet 时才用得上）。 */
const clickThroughRef = { current: false };

function Bubble({ view }: { view: PetViewModel }) {
  return (
    <div className="pet-bubbles">
      {view.proactive && <div className="pet-bubble proactive">{view.proactive.text}</div>}
      {view.subtitle && <div className="pet-bubble subtitle">{view.subtitle}</div>}
    </div>
  );
}
