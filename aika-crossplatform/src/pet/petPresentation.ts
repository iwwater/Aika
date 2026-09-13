import type { Timers } from "../services/time/tokens";

/**
 * pet 展示协议 `pet.presentation.v1`（FE-20 2026-09-14 修订）。
 *
 * 单向：主窗聚合已授权展示字段 → Rust 定向中继 → pet 渲染。字段是白名单投影，
 * 不携带密钥、记忆候选或传感器原文；字幕/气泡 2000 字符上限（超长截断只影响展示，
 * 不改对话存储）。
 *
 * 合并规则（FE-20-F）：pet 先订阅再请求快照；帧按 epoch + 递增 seq 合并——
 * 旧 epoch / 旧 seq / 迟到快照不覆盖新增量；runtimeTurnId 标识轮次，取消当轮
 * 由主窗下发 speaking=false + runtimeTurnId=null 表达，旧轮事件不回写。
 */

export const PET_PRESENTATION_SCHEMA = "pet.presentation.v1" as const;
export const PET_PRESENTATION_EVENT = "pet://presentation";
export const PET_SNAPSHOT_REQUEST_EVENT = "pet://snapshot-request";

/** 字幕在播放结束后 3000ms 淡出；主动气泡显示 8000ms（SPEC 冻结值）。 */
export const SUBTITLE_FADE_MS = 3000;
export const PROACTIVE_BUBBLE_MS = 8000;
export const PRESENTATION_TEXT_LIMIT = 2000;

export interface PetProactiveContent {
  text: string;
  sentAtMs: number;
}

export interface PetPresentationData {
  /** 当前说话轮次；无轮次（普通朗读/空闲）为 null，不伪造。 */
  runtimeTurnId: string | null;
  speaking: boolean;
  mood: string;
  currentSubtitle: string | null;
  lastProactive: PetProactiveContent | null;
}

export interface PetPresentationFrameV1 extends PetPresentationData {
  schemaVersion: typeof PET_PRESENTATION_SCHEMA;
  epoch: string;
  seq: number;
  /**
   * 快照帧（pet 请求快照的应答）：允许跨 epoch 重同步（主窗重启后 pet 据此
   * 重置基线）。增量帧不带该字段——旧 epoch 的增量一律拒绝。
   */
  snapshot?: boolean;
}

export interface PetRelaySnapshot {
  epoch: string;
  data: PetPresentationData;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  return value.length > PRESENTATION_TEXT_LIMIT ? `${value.slice(0, PRESENTATION_TEXT_LIMIT)}…` : value;
}

/** 生产校验：形状不符返回 null（pet 端拒绝渲染，而不是崩或显示垃圾）。 */
export function validatePetPresentationFrame(raw: unknown): PetPresentationFrameV1 | null {
  if (raw === null || typeof raw !== "object") return null;
  const frame = raw as Record<string, unknown>;
  if (frame.schemaVersion !== PET_PRESENTATION_SCHEMA) return null;
  if (typeof frame.epoch !== "string" || frame.epoch.length === 0 || frame.epoch.length > 128) return null;
  if (typeof frame.seq !== "number" || !Number.isFinite(frame.seq) || frame.seq < 0) return null;
  const runtimeTurnId = frame.runtimeTurnId === null || frame.runtimeTurnId === undefined
    ? null
    : typeof frame.runtimeTurnId === "string" && frame.runtimeTurnId.length <= 128
      ? frame.runtimeTurnId
      : null;
  if (frame.snapshot !== undefined && typeof frame.snapshot !== "boolean") return null;
  if (typeof frame.speaking !== "boolean") return null;
  if (typeof frame.mood !== "string" || frame.mood.length > 32) return null;
  const currentSubtitle = boundedText(frame.currentSubtitle);
  let lastProactive: PetProactiveContent | null = null;
  if (frame.lastProactive !== null && frame.lastProactive !== undefined) {
    if (frame.lastProactive === null || typeof frame.lastProactive !== "object") return null;
    const proactive = frame.lastProactive as Record<string, unknown>;
    const text = boundedText(proactive.text);
    if (text === null) return null;
    if (typeof proactive.sentAtMs !== "number" || !Number.isFinite(proactive.sentAtMs)) return null;
    lastProactive = { text, sentAtMs: proactive.sentAtMs };
  }
  return {
    schemaVersion: PET_PRESENTATION_SCHEMA,
    epoch: frame.epoch,
    seq: frame.seq,
    runtimeTurnId,
    speaking: frame.speaking,
    mood: frame.mood,
    currentSubtitle,
    lastProactive,
    ...(frame.snapshot === true ? { snapshot: true } : {}),
  };
}

export interface PetViewModel {
  mood: string;
  /** 当前可见的说话字幕（含淡出窗口内的）；无则 null。 */
  subtitle: string | null;
  /** 当前可见的主动气泡；无则 null。 */
  proactive: PetProactiveContent | null;
  speaking: boolean;
  runtimeTurnId: string | null;
}

/**
 * pet 侧视图模型：协议校验 + epoch/seq 合并 + 淡出窗口。
 *
 * `advance(now)` 由渲染循环（或测试的假时钟）驱动；不自带定时器——
 * 窗口销毁不需要清理任何隐藏循环。
 */
export function createPetViewModel() {
  let latest: PetPresentationFrameV1 | null = null;
  // 淡出基准（调用方时钟的单调值，不跨窗相减墙钟）：
  // - 字幕：说话期间持续刷新；说话结束起算 3000ms。
  // - 气泡：新条（text/sentAtMs 变化）起算 8000ms；无关帧不重置。
  let subtitleActiveAt = -1;
  let proactiveReceivedAt = -1;
  const listeners = new Set<() => void>();
  let view: PetViewModel = { mood: "neutral", subtitle: null, proactive: null, speaking: false, runtimeTurnId: null };

  function rebuild(now: number): void {
    if (!latest) {
      view = { mood: "neutral", subtitle: null, proactive: null, speaking: false, runtimeTurnId: null };
      return;
    }
    const subtitleVisible = latest.currentSubtitle !== null
      && (latest.speaking || now - subtitleActiveAt < SUBTITLE_FADE_MS);
    const proactiveVisible = latest.lastProactive !== null
      && now - proactiveReceivedAt < PROACTIVE_BUBBLE_MS;
    view = {
      mood: latest.mood,
      subtitle: subtitleVisible ? latest.currentSubtitle : null,
      proactive: proactiveVisible ? latest.lastProactive : null,
      speaking: latest.speaking,
      runtimeTurnId: latest.runtimeTurnId,
    };
  }

  function commit(now: number): void {
    rebuild(now);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 渲染订阅异常不影响状态。
      }
    }
  }

  return {
    /**
     * 应用一帧；旧 epoch / 旧 seq 返回 false（零状态变化）。
     * epoch 变化只在快照帧上接受（主窗重启后的重同步），增量帧一律拒绝。
     */
    apply(frame: PetPresentationFrameV1, now: number): boolean {
      if (latest) {
        if (frame.epoch !== latest.epoch) {
          if (!frame.snapshot) return false;
        } else if (frame.seq <= latest.seq) {
          return false;
        }
      }
      const previous = latest;
      latest = frame;
      if (previous && frame.epoch !== previous.epoch) {
        // 重同步：淡出基准随新会话重置。
        subtitleActiveAt = now;
        proactiveReceivedAt = now;
      }
      if (frame.currentSubtitle !== null
        && (frame.currentSubtitle !== (previous?.currentSubtitle ?? null) || frame.speaking)) {
        // 新字幕取消旧淡出计时；说话期间基准持续刷新。
        subtitleActiveAt = now;
      }
      const nextProactive = frame.lastProactive;
      if (nextProactive && (previous?.lastProactive?.text !== nextProactive.text
        || previous?.lastProactive?.sentAtMs !== nextProactive.sentAtMs)) {
        proactiveReceivedAt = now;
      }
      commit(now);
      return true;
    },

    /** 推进淡出判定；内容没到边界时不产生新快照对象。 */
    advance(now: number): void {
      const before = view;
      rebuild(now);
      if (view !== before) {
        for (const listener of [...listeners]) listener();
      }
    },

    snapshot(): PetViewModel {
      return view;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * pet 页的接入器：订阅 Rust 中继事件 + 就绪时请求一次快照。
 * bridge 形状同 foregroundSource 的 EnvironmentBridge。
 */
export interface PetWindowBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

export function connectPetViewModel(
  bridge: PetWindowBridge,
  viewModel: ReturnType<typeof createPetViewModel>,
  clock: { now(): number },
): Promise<() => void> {
  return bridge.listen(PET_PRESENTATION_EVENT, (payload) => {
    const frame = validatePetPresentationFrame(payload);
    if (frame) viewModel.apply(frame, clock.now());
  }).then(async (unlisten) => {
    try {
      await bridge.invoke("pet_window_request_snapshot", {});
    } catch {
      // 快照请求失败不致命：下一帧增量照常。
    }
    return unlisten;
  });
}

/** 主窗 relay 用的定时器端口形状（与 companionPresenter 的 IntervalPort 对齐）。 */
export type PetTimers = Pick<Timers, "setTimeout" | "clearTimeout">;
