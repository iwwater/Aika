/**
 * F9 Ops 成本页的 Presenter（FE-26）。
 *
 * 与工作台其它 Presenter 同一套路：与 React 无关，页面只订阅快照、派发命令；
 * 取数是「打开时读 + 手动刷新 + 显式翻页」——台账是查询型数据，不为调试页做推送。
 *
 * 两件事必须如实：
 * 1. **覆盖范围**。翻页只取了部分数据时，汇总只代表已取回的部分，页面必须说清楚。
 * 2. **未知不是 0**。没采集的用途、没价目的记录、只有 total 的记录，都按未知展示，
 *    绝不用估算补齐金额。
 */

import {
  summarizeUsage, validatePriceEntry,
  type PriceEntryV1, type PricingConfigV1, type UsageStatsSummary,
} from "../domain/usageStats";
import { PRICING_SCHEMA_VERSION } from "../domain/usageStats";
import type { UsageRecordV1 } from "../domain/usageLedger";
import type { AikaStorage } from "../services/storage/contracts";
import { SETTING_KEYS } from "../services/storage/contracts";
import type { UsageLedgerStore } from "../services/usage/contracts";

export interface OpsViewModel {
  /** 没装 usagePlugin（无台账 store）时为 false：页面据此显示「没有采集」。 */
  available: boolean;
  loading: boolean;
  /** 采集开关当前状态；null = 装配里没有 Trace 开关可读。 */
  captureEnabled: boolean | null;
  timeZone: string;
  stats: UsageStatsSummary | null;
  /** 覆盖范围说明：翻页取到哪、还有没有更多、采集是否关闭。 */
  coverageNote: string;
  prices: readonly PriceEntryV1[];
  priceError: string;
  error: string;
  hasMore: boolean;
  /** 最后一页查询是否报了截断（台账保留期可能裁掉更早的记录）。 */
  truncated: boolean;
  loadedPages: number;
  loadedRecords: number;
}

export interface OpsPresenter {
  getSnapshot(): OpsViewModel;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  setTimeZone(timeZone: string): void;
  /** 校验并保存一条价目；非法输入返回 false 并把原因放进 priceError。 */
  savePrice(entry: PriceEntryV1): Promise<boolean>;
  removePrice(id: string): Promise<void>;
  dispose(): void;
}

export interface OpsPresenterDeps {
  /** 台账只读端口；没装 usagePlugin 时为 null。 */
  store: UsageLedgerStore | null;
  loadStorage: () => Promise<AikaStorage>;
  /** 采集开关（与 Trace enabled 同源）；装配里没有时省略。 */
  isCaptureEnabled?: () => boolean;
  /** 单页条数（台账默认 200）。 */
  pageSize?: number;
  clock?: () => number;
}

const DEFAULT_PAGE_SIZE = 200;

export function createOpsPresenter(deps: OpsPresenterDeps): OpsPresenter {
  const pageSize = Math.max(1, deps.pageSize ?? DEFAULT_PAGE_SIZE);
  const clock = deps.clock ?? (() => Date.now());

  const listeners = new Set<() => void>();
  let disposed = false;
  let started = false;

  let loading = false;
  let error = "";
  let priceError = "";
  let timeZone = "UTC";
  let prices: PriceEntryV1[] = [];
  let records: UsageRecordV1[] = [];
  let cursor: string | null = null;
  let truncated = false;
  let loadedPages = 0;
  let cached: OpsViewModel | null = null;

  function captureEnabled(): boolean | null {
    return deps.isCaptureEnabled ? deps.isCaptureEnabled() : null;
  }

  function coverageNote(): string {
    const parts: string[] = [];
    if (loadedPages === 0) {
      parts.push("尚未载入任何台账记录");
    } else {
      parts.push(`已载入 ${loadedPages} 页 / ${records.length} 条`);
      if (cursor) parts.push("还有更多未取回，以下汇总只覆盖已载入部分");
    }
    if (truncated) parts.push("台账按保留期截断过，更早的记录已不在");
    const capture = captureEnabled();
    if (capture === false) parts.push("采集当前关闭：新请求不会记账");
    if (capture === null) parts.push("装配里没有采集开关可读");
    return parts.join("；");
  }

  function stats(): UsageStatsSummary {
    return summarizeUsage(records, { prices, timeZone });
  }

  function commit(): void {
    cached = null;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 一个订阅者抛错不影响其它订阅者。
      }
    }
  }

  async function loadPrices(): Promise<void> {
    let storage: AikaStorage;
    try {
      storage = await deps.loadStorage();
    } catch (storageError) {
      priceError = storageError instanceof Error ? storageError.message : String(storageError);
      return;
    }
    try {
      const raw = await storage.getSetting(SETTING_KEYS.usagePrices);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PricingConfigV1;
      if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.prices)) {
        prices = parsed.prices.filter((entry) => validatePriceEntry(entry) === null);
      } else {
        priceError = "价目配置无法识别，已按空价目处理（金额会显示未知）";
      }
    } catch {
      priceError = "价目配置损坏，已按空价目处理（金额会显示未知）";
    }
  }

  async function persistPrices(): Promise<void> {
    const storage = await deps.loadStorage();
    const config: PricingConfigV1 = { schemaVersion: PRICING_SCHEMA_VERSION, savedAt: clock(), prices };
    await storage.setSetting(SETTING_KEYS.usagePrices, JSON.stringify(config));
  }

  async function queryPage(next: boolean): Promise<void> {
    const store = deps.store;
    if (!store || loading) return;
    loading = true;
    commit();
    try {
      const page = await store.query({
        limit: pageSize,
        ...(next && cursor ? { cursor } : {}),
      });
      records = next ? [...records, ...page.records] : page.records;
      cursor = page.nextCursor;
      truncated = truncated || page.truncated;
      loadedPages += 1;
      error = "";
    } catch (queryError) {
      error = queryError instanceof Error ? queryError.message : String(queryError);
    } finally {
      loading = false;
      commit();
    }
  }

  return {
    getSnapshot(): OpsViewModel {
      if (cached) return cached;
      cached = {
        available: Boolean(deps.store),
        loading,
        captureEnabled: captureEnabled(),
        timeZone,
        stats: deps.store ? stats() : null,
        coverageNote: coverageNote(),
        prices,
        priceError,
        error,
        hasMore: Boolean(cursor),
        truncated,
        loadedPages,
        loadedRecords: records.length,
      };
      return cached;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start() {
      if (started || disposed) return;
      started = true;
      await loadPrices();
      await queryPage(false);
    },

    async refresh() {
      if (!started) {
        await this.start();
        return;
      }
      // 重翻第一页：截断标志以最新一轮查询为准，不带历史包袱。
      truncated = false;
      cursor = null;
      loadedPages = 0;
      records = [];
      await queryPage(false);
    },

    async loadMore() {
      await queryPage(true);
    },

    setTimeZone(next) {
      if (next === timeZone) return;
      timeZone = next;
      commit();
    },

    async savePrice(entry) {
      priceError = "";
      const invalid = validatePriceEntry(entry);
      if (invalid) {
        priceError = invalid;
        commit();
        return false;
      }
      const id = entry.id.trim() || `price-${clock().toString(36)}-${prices.length + 1}`;
      const normalized: PriceEntryV1 = { ...entry, id };
      const existing = prices.findIndex((item) => item.id === id);
      if (existing >= 0) prices[existing] = normalized;
      else prices = [...prices, normalized];
      try {
        await persistPrices();
        commit();
        return true;
      } catch (saveFailure) {
        // 保存失败回滚内存态：界面显示的价目必须与库里的一致。
        if (existing >= 0) prices[existing] = entry;
        else prices = prices.filter((item) => item.id !== id);
        priceError = `价目保存失败：${saveFailure instanceof Error ? saveFailure.message : String(saveFailure)}`;
        commit();
        return false;
      }
    },

    async removePrice(id) {
      const previous = prices;
      prices = prices.filter((item) => item.id !== id);
      if (prices.length === previous.length) return;
      try {
        await persistPrices();
        commit();
      } catch (removeFailure) {
        prices = previous;
        priceError = `价目删除失败：${removeFailure instanceof Error ? removeFailure.message : String(removeFailure)}`;
        commit();
      }
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
