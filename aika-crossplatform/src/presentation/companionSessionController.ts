import type { Clock } from "../services/time/tokens";
import { SETTING_KEYS } from "../services/storage/contracts";
import type { SchedulerQuota } from "../services/environment/captureScheduler";
import type { ScreenContextSource } from "../services/environment/screenContextSource";
import {
  AUTO_MIN_DIFF_RATIO,
  AUTO_STABLE_MS,
  autoCandidates,
  createTextFingerprintMemory,
  diffRatio,
  excerptText,
  type ScreenExcerpt,
  type ScreenReadStatus,
} from "../services/environment/screenContextProjection";
import {
  createIntentDedupe,
  type CompanionIntentV1,
} from "./companionIntent";

/**
 * 桌宠陪伴会话控制器（FE-31）。
 *
 * 它**协调**已有的传感器、屏幕上下文源与既有发送路径，不自建 OCR 循环、
 * 不自建第二个 Runtime，也不自建第二套主动额度。整个产品仍然只有一套
 * CompanionRuntime：本控制器只是它的一个**受控入口**，不新增生成通道。
 *
 * 三态：
 * - `off`：默认。什么都不采集。
 * - `active`：画面文本有意义变化 → 本地 OCR → 候选筛选 → 统一主动频控 → 发送。
 * - `quiet`：本地短时上下文照常更新，但**所有非用户触发的消息一律不发**。
 *   门禁执行在「要发的那一刻」，不是靠断开 OCR 订阅——时间 tick 也不能说话。
 *
 * 代数（generation）是撤销的唯一依据：暂停/结束/关闭桌宠都前移它，
 * 在途采集、在途识别与迟到候选全部作废。结束陪伴**不取消主窗已有的用户对话
 * 或 TTS**——那是用户自己的轮次，与陪伴会话无关。
 */

export type CompanionMode = "off" | "active" | "quiet";

export type CompanionReadState =
  | "off"
  | "starting"
  | "reading"
  | "paused"
  /** 采集被拒或未授权。 */
  | "denied"
  /** 启动失败，资源已清理。 */
  | "failed";

/** 「看屏幕聊聊」提交的固定用户文本。它代表的是**用户这个动作**，
 * 不是 OCR 内容——摘录永远走 environment 来源，不拼进用户亲口文本。 */
export const SCREEN_TALK_TEXT = "看看我屏幕上现在这些，随便聊聊";

export interface CompanionSessionView {
  mode: CompanionMode;
  readState: CompanionReadState;
  /** 当前会话代数；每次启动/暂停/结束递增。 */
  generation: number;
  /** 有一轮由本会话发起的用户请求在途。 */
  sending: boolean;
  /** 上一次读屏的结果状态（界面据此显示「未读到屏幕」等）。 */
  lastReadStatus: ScreenReadStatus | null;
  /** 面向用户的状态文案；没有要说的就是 null（不留旧文案）。 */
  notice: string | null;
  error: string | null;
  quota: SchedulerQuota | null;
}

export interface CompanionSensorPort {
  /** 启用/停用本会话取得的屏幕采集租约。 */
  setScreenEnabled(enabled: boolean): Promise<void>;
}

export interface CompanionSettingsPort {
  getString(key: string): Promise<string | null>;
  setString(key: string, value: string): Promise<void>;
  getBoolean(key: string, fallback: boolean): Promise<boolean>;
  setBoolean(key: string, value: boolean): Promise<void>;
}

/**
 * 可选窗口视图端口。
 *
 * MVP-03 之后主窗不再拥有任何桌宠窗口，所以生产装配**不传**它：会话控制不该
 * 因为某个窗口不存在而失败。保留端口是为了让「打开/收起视图」这类宿主能力仍可
 * 注入——测试用它断言生命周期，将来的宿主若再引入自己的窗口也可以复用。
 */
export interface CompanionViewPort {
  open(): Promise<void>;
  close(): Promise<void>;
  focusMain(): Promise<void>;
}

export interface CompanionSessionDeps {
  screenContext: ScreenContextSource;
  sensors: CompanionSensorPort;
  settings: CompanionSettingsPort | null;
  view?: CompanionViewPort;
  /**
   * 主窗既有用户发送路径。会话里的用户动作（看屏幕聊聊、等价于用户输入的
   * 桌宠点击）在**可信主窗**被映射成用户触发的 submit；resolve false =
   * 没发出去（busy/未连接），调用方显示状态。
   */
  submitUser(input: { text: string; trigger: "pet_talk" | "pet_screen_talk" }): Promise<boolean>;
  /**
   * 统一自动发送预约（既有共享预约，不是第二套额度）。
   * 安静模式与用户优先的门禁在调用它**之前**执行。
   */
  submitProactive(input: { candidates: readonly ScreenExcerpt[] }): Promise<boolean>;
  /** 与 monitor / screenContext 同源的单调时钟。 */
  clock: Clock;
}

export interface CompanionSessionController {
  /** 读回持久化的模式与同意状态；不自动开始采集（应用启动本身不采集）。 */
  start(): Promise<void>;
  getSnapshot(): CompanionSessionView;
  subscribe(listener: () => void): () => void;
  /** 是否已经完成过一次范围确认。 */
  hasConsent(): boolean;
  /**
   * 开启陪伴。首次必须带 `consent: true`（一次确认，不要求再逐个找开关）；
   * 已授权后不带 consent 也能启动。启动失败清理资源并把状态标成失败。
   */
  enable(mode: "active" | "quiet", options?: { consent?: boolean }): Promise<boolean>;
  /** 在 active / quiet 之间切换；不重启采集。 */
  setMode(mode: "active" | "quiet"): Promise<void>;
  /** 暂停读屏：停采集、清空屏幕上下文与候选，可选视图保留、普通聊天可用。 */
  pause(): Promise<void>;
  /** 结束陪伴：撤销代数、停自己的采集、清缓存并关闭可选视图。 */
  end(): Promise<void>;
  /** 处理一条受控意图（`companion.intent.v1`）。返回是否被接受。 */
  handleIntent(intent: CompanionIntentV1, sessionEpoch: string): Promise<boolean>;
  /** 画面变化通知（自动路径入口）。 */
  onScreenChanged(): Promise<void>;
  /** 全局「停止全部感知」：把本会话读屏标为暂停（不冒充仍在运行）。 */
  markStoppedExternally(): void;
  dispose(): void;
}

function parseMode(raw: string | null): CompanionMode {
  return raw === "active" || raw === "quiet" ? raw : "off";
}

export function createCompanionSessionController(
  deps: CompanionSessionDeps,
): CompanionSessionController {
  const dedupe = createIntentDedupe();
  const fingerprints = createTextFingerprintMemory();

  let mode: CompanionMode = "off";
  let readState: CompanionReadState = "off";
  let generation = 0;
  let consent = false;
  let sending = false;
  let lastReadStatus: ScreenReadStatus | null = null;
  let notice: string | null = null;
  let error: string | null = null;
  let disposed = false;
  let started = false;
  /** 自动路径的稳定性观察：同一屏内容要稳定 ≥3 秒才算候选。 */
  let pendingAuto: { text: string; firstSeenAt: number } | null = null;
  /** 上一次真的处理过的文本：新内容要与它差异 ≥20%。 */
  let lastProcessedText = "";

  const listeners = new Set<() => void>();
  let view: CompanionSessionView = snapshotOf();

  function snapshotOf(): CompanionSessionView {
    return {
      mode,
      readState,
      generation,
      sending,
      lastReadStatus,
      notice,
      error,
      quota: readState === "reading" ? deps.screenContext.quota() : null,
    };
  }

  function commit(): void {
    view = snapshotOf();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 界面订阅者异常不影响状态机。
      }
    }
  }

  function detailOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  /** 撤销当前会话：代数前移 → 在途采集/识别/候选全部作废。 */
  function revoke(): void {
    generation += 1;
    deps.screenContext.revoke(generation);
    pendingAuto = null;
    lastProcessedText = "";
    fingerprints.clear();
  }

  async function persistMode(next: CompanionMode): Promise<void> {
    try {
      await deps.settings?.setString(SETTING_KEYS.companionMode, next);
    } catch (caught) {
      error = `设置保存失败：${detailOf(caught)}`;
    }
  }

  const controller: CompanionSessionController = {
    async start(): Promise<void> {
      if (started || disposed) return;
      started = true;
      // 读取失败按「没授权、关着」处理（fail-closed）。
      try {
        consent = deps.settings ? await deps.settings.getBoolean(SETTING_KEYS.companionConsent, false) : false;
      } catch {
        consent = false;
      }
      let saved: CompanionMode = "off";
      try {
        saved = parseMode(deps.settings ? await deps.settings.getString(SETTING_KEYS.companionMode) : null);
      } catch {
        saved = "off";
      }
      // **应用启动本身不自动采集**：只把上次的选择读回来显示，不启动传感器。
      mode = consent ? saved : "off";
      readState = "off";
      commit();
    },

    getSnapshot(): CompanionSessionView {
      return view;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    hasConsent(): boolean {
      return consent;
    },

    async enable(next: "active" | "quiet", options?: { consent?: boolean }): Promise<boolean> {
      if (disposed) return false;
      if (!consent && options?.consent !== true) {
        // 没有一次确认就不启动：这不是错误状态，是「还没同意」。
        notice = "开启陪伴前需要先确认采集范围与外发边界。";
        readState = "denied";
        commit();
        return false;
      }
      error = null;
      notice = null;
      readState = "starting";
      generation += 1;
      commit();

      if (options?.consent === true && !consent) {
        try {
          await deps.settings?.setBoolean(SETTING_KEYS.companionConsent, true);
          consent = true;
        } catch (caught) {
          // 同意没落库就不开采集（与 FE-19 的「没有落库的同意不开采集」一致）。
          error = `设置保存失败：${detailOf(caught)}`;
          readState = "failed";
          commit();
          return false;
        }
      }

      try {
        await deps.sensors.setScreenEnabled(true);
      } catch (caught) {
        // 部分启动失败：清理资源（撤销代数 + 停采集），状态显示失败。
        error = detailOf(caught);
        readState = /denied|permission/i.test(error) ? "denied" : "failed";
        revoke();
        try {
          await deps.sensors.setScreenEnabled(false);
        } catch {
          // 清理失败不掩盖「没开起来」这个事实。
        }
        mode = "off";
        commit();
        return false;
      }

      mode = next;
      readState = "reading";
      await persistMode(next);
      try {
        await deps.view?.open();
      } catch (caught) {
        // 窗口没开起来不等于会话失败，但也**不能**冒充陪伴已就绪。
        error = detailOf(caught);
      }
      commit();
      return true;
    },

    async setMode(next: "active" | "quiet"): Promise<void> {
      if (disposed || mode === "off") return;
      mode = next;
      // 切到 quiet 只改门禁，不停采集：本地短时上下文照常更新。
      pendingAuto = null;
      await persistMode(next);
      commit();
    },

    async pause(): Promise<void> {
      if (disposed || mode === "off") return;
      // 先撤销再停采集：撤销后迟到的识别结果不可能被当成有效上下文。
      revoke();
      deps.screenContext.clear();
      readState = "paused";
      notice = null;
      lastReadStatus = null;
      commit();
      try {
        await deps.sensors.setScreenEnabled(false);
      } catch (caught) {
        error = detailOf(caught);
        commit();
      }
    },

    async end(): Promise<void> {
      if (disposed) return;
      revoke();
      deps.screenContext.clear();
      dedupe.clear();
      mode = "off";
      readState = "off";
      notice = null;
      lastReadStatus = null;
      commit();
      // 只停自己取得的租约；主窗已有的用户对话与 TTS 一概不碰。
      try {
        await deps.sensors.setScreenEnabled(false);
      } catch (caught) {
        error = detailOf(caught);
      }
      await persistMode("off");
      try {
        await deps.view?.close();
      } catch (caught) {
        error = detailOf(caught);
      }
      commit();
    },

    async handleIntent(intent: CompanionIntentV1, currentSessionEpoch: string): Promise<boolean> {
      if (disposed) return false;
      // 1. epoch：调用方这一次会话的代数必须是当前的；旧 epoch 丢弃。
      if (intent.sessionEpoch !== currentSessionEpoch) return false;
      // 2. requestId 去重：重放与双击只算一次。
      const now = deps.clock.now();
      if (dedupe.isDuplicate(intent.requestId, now)) return false;
      dedupe.remember(intent.requestId, now);

      switch (intent.kind) {
        case "open_main":
          await deps.view?.focusMain();
          return true;
        case "pause_reading":
          await controller.pause();
          return true;
        case "end_session":
          await controller.end();
          return true;
        case "talk":
        case "screen_talk":
          break;
      }

      if (sending) {
        // 上一轮还在途：显示状态而不是静默丢弃，也不擅自取消已有轮次。
        notice = "上一句还在发送中，等它结束再发。";
        commit();
        return false;
      }

      // 用户优先：未提交的自动候选立刻撤销，不积压。
      pendingAuto = null;

      let text = intent.text ?? "";
      if (intent.kind === "screen_talk") {
        text = SCREEN_TALK_TEXT;
        // 手动读屏不受主动开关与主动额度限制，但仍受采集授权、并发与滚动总额约束。
        const result = await deps.screenContext.readOnce({
          reason: "manual",
          sessionGeneration: generation,
        });
        lastReadStatus = result.readStatus;
        notice = noticeFor(result.readStatus, result.retryAtMonotonicMs, deps.clock.now());
        commit();
        if (readState === "paused") {
          // 暂停期间的「看屏幕聊聊」是一次明确授权的一次性采集：完成即释放。
          deps.screenContext.clear();
        }
      }

      sending = true;
      commit();
      try {
        const ok = await deps.submitUser({
          text,
          trigger: intent.kind === "screen_talk" ? "pet_screen_talk" : "pet_talk",
        });
        if (!ok) notice = "现在发不出去（正忙或未连接），稍后再试。";
        return ok;
      } catch (caught) {
        error = detailOf(caught);
        return false;
      } finally {
        sending = false;
        commit();
      }
    },

    async onScreenChanged(): Promise<void> {
      if (disposed || mode === "off" || readState !== "reading") return;

      const sessionGeneration = generation;
      const result = await deps.screenContext.readOnce({ reason: "change", sessionGeneration });
      if (sessionGeneration !== generation) return; // 采集期间被撤销：结果作废。
      lastReadStatus = result.readStatus;
      if (result.readStatus !== "ok") {
        commit();
        return;
      }

      const text = excerptText(result);
      const now = deps.clock.now();

      // 与上次已处理文本差异不足 20% → 还是同一屏，不重复请求。
      if (lastProcessedText && diffRatio(lastProcessedText, text) < AUTO_MIN_DIFF_RATIO) {
        commit();
        return;
      }
      if (fingerprints.seen(text)) {
        commit();
        return;
      }

      // 稳定性：同一屏内容要连续观察到 ≥3 秒才算候选（闪一下不算）。
      if (!pendingAuto || diffRatio(pendingAuto.text, text) >= AUTO_MIN_DIFF_RATIO) {
        pendingAuto = { text, firstSeenAt: now };
        commit();
        return;
      }
      if (now - pendingAuto.firstSeenAt < AUTO_STABLE_MS) {
        commit();
        return;
      }

      const candidates = autoCandidates(result);
      if (candidates.length === 0) {
        pendingAuto = null;
        commit();
        return;
      }

      // 安静模式门禁在**预约处**执行：不是靠断开订阅，时间 tick 也过不去。
      if (mode !== "active") {
        pendingAuto = null;
        lastProcessedText = text;
        fingerprints.remember(text);
        commit();
        return;
      }
      // 用户优先：同刻有用户轮在途就撤销候选。
      if (sending) {
        pendingAuto = null;
        commit();
        return;
      }

      pendingAuto = null;
      lastProcessedText = text;
      fingerprints.remember(text);
      commit();
      const submitted = await deps.submitProactive({ candidates });
      if (submitted && sessionGeneration === generation) commit();
    },

    markStoppedExternally(): void {
      if (disposed || mode === "off") return;
      revoke();
      deps.screenContext.clear();
      readState = "paused";
      commit();
    },

    dispose(): void {
      disposed = true;
      revoke();
      listeners.clear();
    },
  };

  return controller;
}

/** 读屏结果 → 用户可见文案。没有要说的返回 null（不留旧文案）。 */
function noticeFor(status: ScreenReadStatus, retryAt: number | null, now: number): string | null {
  switch (status) {
    case "ok":
      return null;
    case "low_confidence":
      return "屏幕上的字看得不太清，下面的说法可能不准。";
    case "empty":
      return "这一屏没读到文字（不代表画面上没有东西）。";
    case "timeout":
      return "这次没读完屏幕，先不看了。";
    case "unavailable":
      return "现在读不到屏幕（没有可读的前台窗口）。";
    case "self_obscured":
      return "我自己的窗口挡住了要读的区域，挪开一点再试。";
    case "unauthorized":
      return "还没打开屏幕感知，先在设置里开启。";
    case "rate_limited": {
      const seconds = retryAt === null ? null : Math.max(1, Math.ceil((retryAt - now) / 1000));
      return seconds === null ? "读屏次数到上限了，稍后再试。" : `读屏次数到上限了，${seconds} 秒后可以再看。`;
    }
    case "superseded":
    case "cancelled":
      return null;
  }
}
