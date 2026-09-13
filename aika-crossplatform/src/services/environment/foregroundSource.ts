import type { EnvironmentEventInput } from "../../domain/environment";
import {
  EnvironmentSourceError,
  type EnvironmentSource,
} from "./contracts";

/**
 * 前台进程 source（FE-19）。
 *
 * 桥形状同 `services/remote/bridge.ts` 的 invoke/listen 注入先例：TS 不直接 import
 * Tauri，宿主装配层把真正的桥接进来，测试用 fake bridge。
 *
 * 时序（2026-09-13 审阅）：先 listen 再 enable，最后 current 兜底——顺序反了会丢
 * 「enable 前后之间的切换」。epoch/seq 合并去重：Rust 重启后 seq 归零，用
 * `enableSeq`（每次 start 递增）+ seq 复合判重。
 */

export const FOREGROUND_SOURCE_ID = "foreground";
export const FOREGROUND_EVENT = "environment://foreground";

export interface EnvironmentBridge {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

interface RustForegroundPayload {
  process?: unknown;
  seq?: unknown;
  atMs?: unknown;
}

export interface ForegroundSourceOptions {
  hostEpoch: string;
  /** 事件源标识；测试可覆盖。 */
  sourceId?: string;
}

export function createForegroundSource(
  bridge: EnvironmentBridge,
  options: ForegroundSourceOptions,
): EnvironmentSource {
  const sourceId = options.sourceId ?? FOREGROUND_SOURCE_ID;
  return {
    id: sourceId,
    kind: "foreground",
    async start(emit, signal) {
      let unlisten: (() => void) | null = null;
      let lastSeq = -1;
      let lastEnableEpoch = -1;
      let enableEpoch = 0;

      const emitForeground = (process: string, seq: number, atMs: number, precision: "measured" | "estimated") => {
        const event: EnvironmentEventInput = {
          schemaVersion: "environment.v1",
          sourceId,
          eventId: `${sourceId}-${enableEpoch}-${seq}`,
          hostEpoch: options.hostEpoch,
          timestamp: atMs,
          timingPrecision: precision,
          confidence: 1,
          // 只有进程名。没有标题：这一层根本不读它（2026-09-14 修订）。
          payload: { kind: "foreground_changed", process },
        };
        emit(event);
      };

      const handlePayload = (raw: unknown) => {
        const payload = raw as RustForegroundPayload | null;
        if (!payload || typeof payload !== "object") return;
        const { process, seq, atMs } = payload;
        if (typeof process !== "string" || process.length === 0) return;
        if (typeof seq !== "number" || !Number.isFinite(seq)) return;
        if (typeof atMs !== "number" || !Number.isFinite(atMs)) return;
        // epoch/seq 去重：同一次 enable 内 seq 单调；跨 enable 允许 seq 重置。
        if (seq <= lastSeq && enableEpoch === lastEnableEpoch) return;
        lastSeq = seq;
        lastEnableEpoch = enableEpoch;
        emitForeground(process, seq, atMs, "measured");
      };

      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        // 停止先撤监听再 disable；disable 失败不掩盖「已停止」的事实，
        // 但错误要如实上抛（monitor 计 stop_failed）。
        unlisten?.();
        unlisten = null;
        await bridge.invoke("environment_foreground_enable", { enabled: false });
      };

      // 1. 先订阅。listen 失败同样映射为能力错误，不向 monitor 泄漏裸异常。
      try {
        unlisten = await bridge.listen(FOREGROUND_EVENT, (payload) => {
          if (!signal.aborted && !stopped) handlePayload(payload);
        });
      } catch (error) {
        stopped = true;
        const detail = error instanceof Error ? error.message : String(error);
        throw new EnvironmentSourceError("unavailable", detail);
      }

      // 2. 再 enable。abort 竞态：enable 前被停就立即善后并退出。
      if (signal.aborted || stopped) {
        unlisten();
        unlisten = null;
        return stop;
      }
      try {
        await bridge.invoke("environment_foreground_enable", { enabled: true });
      } catch (error) {
        unlisten();
        unlisten = null;
        stopped = true;
        // 探测命令失败 = 宿主没有该能力（非 Windows/旧包）；权限拒绝单独成码。
        const detail = error instanceof Error ? error.message : String(error);
        throw new EnvironmentSourceError(/denied|permission/i.test(detail) ? "denied" : "unavailable", detail);
      }
      enableEpoch += 1;

      // 3. current 兜底：hook 触发前的初始状态；迟到的真实事件不会回退更新
      //    （monitor 按 eventId/generation 处理，这里 seq=0 视作估计值）。
      try {
        const current = await bridge.invoke<RustForegroundPayload | null>("environment_foreground_current", {});
        if (!signal.aborted && !stopped && current && typeof current.process === "string" && current.process.length > 0) {
          emitForeground(current.process, 0, typeof current.atMs === "number" ? current.atMs : Date.now(), "estimated");
        }
      } catch {
        // current 拿不到不阻塞：下一个真实 hook 事件会补上。
      }

      return stop;
    },
  };
}
