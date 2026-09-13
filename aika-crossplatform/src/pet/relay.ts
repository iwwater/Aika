import {
  PET_PRESENTATION_SCHEMA,
  PET_SNAPSHOT_REQUEST_EVENT,
  type PetPresentationData,
  type PetPresentationFrameV1,
  type PetRelaySnapshot,
  type PetTimers,
} from "./petPresentation";

/**
 * 主窗侧展示中继（FE-20）。
 *
 * 订阅主窗各 Presenter 的快照（经调用方注入的聚合函数），节流后经
 * `pet_window_broadcast` 定向转发给 pet 窗口。只投影已授权展示字段；
 * 普通朗读没有 runtimeTurnId 时留 null，不伪造（播放会话 ID 由 FE-29 追加）。
 *
 * pet 请求快照：收到 `pet://snapshot-request` 后立即广播一帧当前状态——
 * pet「先订阅再请求快照」，不依赖创建前已广播的事件。
 */

export const PET_BROADCAST_COMMAND = "pet_window_broadcast";

export interface PetRelayDeps {
  bridge: {
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
    listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
  };
  /** 主窗聚合快照：CompanionPresenter + VoicePresenter 等已授权字段的投影。 */
  aggregate(): PetPresentationData;
  /** 宿主 lifecycle epoch；重启后 pet 端按 epoch 重同步。 */
  epoch: string;
  /** 节流间隔（默认 250ms，够顺滑又不刷屏）。 */
  throttleMs?: number;
  /** 定时器注入；测试用假时钟驱动。 */
  timers: PetTimers;
  /**
   * 窗口是否开着。中继只在窗口存在时广播；关闭后 invoke 会失败，
   * 与其吞错不如不调（Rust 侧对不存在窗口的 emit 是无害的，但少一次 IPC）。
   */
  isWindowOpen(): boolean;
}

export interface PetRelay {
  /** 开始中继（订阅快照请求事件 + 启动节流循环）。幂等。 */
  start(): Promise<void>;
  /** 停止并解绑（窗口销毁时调用；不清除主窗任何对话状态）。 */
  stop(): Promise<void>;
  /** 立即把当前聚合状态推出去（设置变化时用）。 */
  broadcastNow(): Promise<void>;
  /** 已发出的帧序号（诊断用）。 */
  seq(): number;
}

export function createPetRelay(deps: PetRelayDeps): PetRelay {
  const throttleMs = deps.throttleMs ?? 250;
  let running = false;
  let unlisten: (() => void) | null = null;
  let timer: unknown = null;
  let dirty = false;
  let lastFrame: PetPresentationFrameV1 | null = null;
  let lastJson = "";
  let sequence = 0;

  function buildFrame(isSnapshot: boolean): PetPresentationFrameV1 {
    sequence += 1;
    return {
      schemaVersion: PET_PRESENTATION_SCHEMA,
      epoch: deps.epoch,
      seq: sequence,
      ...deps.aggregate(),
      ...(isSnapshot ? { snapshot: true } : {}),
    };
  }

  async function broadcast(isSnapshot = false): Promise<void> {
    const frame = buildFrame(isSnapshot);
    lastFrame = frame;
    try {
      await deps.bridge.invoke(PET_BROADCAST_COMMAND, { payload: frame });
    } catch {
      // 窗口正在销毁等瞬态失败：状态由 seq 保证，下个节流周期重发。
    }
  }

  function tick(): void {
    timer = null;
    if (!running) return;
    const json = JSON.stringify(deps.aggregate());
    if (dirty || json !== lastJson) {
      dirty = false;
      lastJson = json;
      void broadcast();
    }
    timer = deps.timers.setTimeout(tick, throttleMs);
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      unlisten = await deps.bridge.listen(PET_SNAPSHOT_REQUEST_EVENT, () => {
        // pet 就绪请求快照：无视节流立即响应，并标记为快照帧（允许跨 epoch 重同步）。
        void broadcast(true);
      });
      timer = deps.timers.setTimeout(tick, throttleMs);
    },

    async stop(): Promise<void> {
      running = false;
      unlisten?.();
      unlisten = null;
      if (timer !== null) {
        deps.timers.clearTimeout(timer);
        timer = null;
      }
      lastFrame = null;
    },

    async broadcastNow(): Promise<void> {
      await broadcast();
    },

    seq(): number {
      return lastFrame?.seq ?? 0;
    },
  };
}

/** 主窗聚合默认实现：从两个 Presenter 的快照投影白名单字段。 */
export function aggregatePresentation(
  companion: { getSnapshot(): { messages: readonly { role: string; mood?: string; source?: string; content: string; createdAt: number; error?: boolean }[] } },
  voice: { getSnapshot(): { speakingCaptionId: number | null; captions: readonly { id: number; speaker: string; text: string }[] } } | null,
): PetPresentationData {
  const messages = companion.getSnapshot().messages;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && !message.error);
  const mood = lastAssistant?.mood ?? "neutral";
  const lastProactiveMessage = [...messages].reverse().find((message) => message.source === "proactive" && !message.error);

  let speaking = false;
  let currentSubtitle: string | null = null;
  if (voice) {
    const voiceSnapshot = voice.getSnapshot();
    const caption = voiceSnapshot.captions.find(
      (item) => item.id === voiceSnapshot.speakingCaptionId && item.speaker === "assistant",
    );
    if (caption) {
      speaking = true;
      currentSubtitle = caption.text;
    }
  }

  return {
    // 普通朗读没有 runtimeTurnId：留 null，不拿语音回合号伪装（FE-29 定义播放会话）。
    runtimeTurnId: null,
    speaking,
    mood,
    currentSubtitle,
    lastProactive: lastProactiveMessage
      ? { text: lastProactiveMessage.content, sentAtMs: lastProactiveMessage.createdAt }
      : null,
  };
}

export type { PetRelaySnapshot };
