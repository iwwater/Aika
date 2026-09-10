import type { ProviderConfig } from "../../domain/providers";
import type { Sticker } from "../../domain/stickers";

/**
 * 当前生效的 Provider 配置与表情包清单。
 *
 * Runtime 的 Provider 适配需要「这一轮用哪个模型、能挑哪些表情包」，但这两样
 * 都会被用户在设置里改。之前它们躺在 Hook 的 ref 里，Runtime 想用就必须认识
 * React——这正是要拆掉的耦合。
 *
 * 所以做成一个最小的可变持有者：谁改设置谁 `set`，Runtime 侧只 `get`。
 * CORE-04 之后由 Presenter 持有它，Hook 不再直接碰。
 */
export interface ProviderSettings {
  get(): ProviderConfig;
  set(config: ProviderConfig): void;
  getStickers(): readonly Sticker[];
  setStickers(stickers: readonly Sticker[]): void;
}

export function createProviderSettings(
  initial: ProviderConfig,
  initialStickers: readonly Sticker[] = [],
): ProviderSettings {
  let config = initial;
  let stickers = initialStickers;

  return {
    get: () => config,
    set: (next) => {
      config = next;
    },
    getStickers: () => stickers,
    setStickers: (next) => {
      stickers = next;
    },
  };
}
