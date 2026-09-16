/**
 * 反向点击通道的**判定层**（MVP-12）。
 *
 * 这里只有一件事：这一次抬起算不算「要上报的点击」。
 *
 * - 拖动已经被窗口层挡掉——位移达到 4px 就置 `suppressClickRef`，走的是移动窗口那条路；
 * - 双击要**折叠成一次**，所以需要一个冷却窗口，免得给对面派发两次；
 * - 上报本身交给宿主进程：凭据不进渲染进程，传输、队列、重试与计数都在
 *   `src-tauri/src/pet_click.rs`。
 */

/** 冷却窗口：窗口内的第二次抬起折叠为同一次点击。 */
export const CLICK_REPORT_COOLDOWN_MS = 400;

export interface ClickReportGate {
  /** 这次抬起是否应该上报一次点击。 */
  shouldReport(): boolean;
  reset(): void;
}

/**
 * 冷却闸门。
 *
 * `last` 初值为 `-Infinity`：**第一次抬起必定上报**，不做「需要预热」这种反直觉的事。
 * 边界取闭区间（`now - last >= cooldownMs` 才放行），与 SPEC 冻结的「400ms 窗口内折叠」一致。
 */
export function createClickReportGate(
  now: () => number = () => Date.now(),
  cooldownMs: number = CLICK_REPORT_COOLDOWN_MS,
): ClickReportGate {
  let last = Number.NEGATIVE_INFINITY;
  return {
    shouldReport(): boolean {
      const at = now();
      if (at - last < cooldownMs) return false;
      last = at;
      return true;
    },
    reset(): void {
      last = Number.NEGATIVE_INFINITY;
    },
  };
}
