/**
 * 绑定服务（RT-02-A/D）。
 *
 * 外部入口声明「我是 userId X」不算身份；身份由**绑定关系**给：
 * 本地可信界面发起一次性短期绑定码，外部入口在限期内用码+账户键认领。
 * 规则全部 fail-closed：
 *
 * - 绑定码一次性：用过即作废。
 * - 绑定码限期：过 TTL 即作废。
 * - 防暴力：一个码错 N 次即作废（即使没到 TTL）。
 * - 解除绑定立即失效：之后该账户查不到 principal，自然读不到任何个人数据。
 * - 绑定存储损坏按「没有任何绑定」处理——宁可拒绝，不可错认。
 */

import {
  canonicalAccountKey, type AccountKeyV1,
} from "../../domain/identity";
import type { AikaStorage } from "../storage/contracts";
import { SETTING_KEYS } from "../storage/contracts";

export const BINDINGS_STORAGE_KEY = "identity.bindings.v1";
export const BINDINGS_SCHEMA_VERSION = 1;
/** 绑定码默认有效期。 */
export const DEFAULT_BINDING_CODE_TTL_MS = 5 * 60_000;
/** 单个码允许的认领失败次数上限（防暴力）。 */
export const MAX_CLAIM_ATTEMPTS_PER_CODE = 5;

/** 一条已生效的绑定：账户键 → 授权主体。 */
export interface BindingRecordV1 {
  version: 1;
  principalId: string;
  account: AccountKeyV1;
  boundAt: number;
}

interface StoredBindings {
  schemaVersion: 1;
  bindings: BindingRecordV1[];
}

export interface BindingCode {
  code: string;
  expiresAt: number;
}

export type ClaimResult =
  | { ok: true; principalId: string }
  | { ok: false; reason: "expired" | "invalid-code" | "too-many-attempts" | "already-bound" | "invalid-account" };

export interface BindingServiceOptions {
  loadStorage: () => Promise<AikaStorage>;
  clock?: () => number;
  idFactory?: () => string;
  /** 绑定码有效期；默认 DEFAULT_BINDING_CODE_TTL_MS。 */
  ttlMs?: number;
}

interface PendingCode {
  code: string;
  expiresAt: number;
  failedAttempts: number;
}

export interface BindingService {
  /** 由本地可信界面调用：签发一个一次性绑定码。 */
  issueBindingCode(): Promise<BindingCode>;
  /** 由外部入口调用：用码认领账户键。码一次性、限期、限错误次数。 */
  claim(code: string, account: AccountKeyV1): Promise<ClaimResult>;
  /** 账户键 → 已绑定的 principalId；没绑定就是 null（fail-closed）。 */
  principalFor(account: AccountKeyV1): Promise<string | null>;
  /** 解除绑定：立即失效；之后同账户再认领需要新的码。 */
  unbind(account: AccountKeyV1): Promise<void>;
  /** 当前全部绑定（管理页展示用）。 */
  list(): Promise<readonly BindingRecordV1[]>;
}

export function createBindingService(options: BindingServiceOptions): BindingService {
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_BINDING_CODE_TTL_MS);
  const pending = new Map<string, PendingCode>();

  async function loadBindings(): Promise<BindingRecordV1[]> {
    try {
      const storage = await options.loadStorage();
      const raw = await storage.getSetting(SETTING_KEYS.identityBindings);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as StoredBindings;
      if (parsed && parsed.schemaVersion === BINDINGS_SCHEMA_VERSION && Array.isArray(parsed.bindings)) {
        return parsed.bindings.filter((record) => record && record.account && record.principalId);
      }
      return [];
    } catch {
      // 损坏/读不到按「没有任何绑定」处理：宁可拒绝，不可错认（RT-02 fail-closed）。
      return [];
    }
  }

  async function saveBindings(bindings: readonly BindingRecordV1[]): Promise<void> {
    const storage = await options.loadStorage();
    const config: StoredBindings = { schemaVersion: BINDINGS_SCHEMA_VERSION, bindings: [...bindings] };
    await storage.setSetting(SETTING_KEYS.identityBindings, JSON.stringify(config));
  }

  function normalizeAccountKey(account: AccountKeyV1): string {
    return canonicalAccountKey(account);
  }

  return {
    async issueBindingCode() {
      const code = idFactory().replace(/-/g, "").slice(0, 8).toUpperCase();
      pending.set(code, { code, expiresAt: clock() + ttlMs, failedAttempts: 0 });
      return { code, expiresAt: clock() + ttlMs };
    },

    async claim(code, account) {
      const trimmed = code.trim().toUpperCase();
      const record = pending.get(trimmed);
      if (!record) return { ok: false, reason: "invalid-code" };
      // 四元组缺一不可：缺字段的账户键不给绑。
      if (!account.platform?.trim() || !account.botAccount?.trim()
        || !account.tenant?.trim() || !account.sender?.trim()) {
        return { ok: false, reason: "invalid-account" };
      }
      if (clock() > record.expiresAt) {
        pending.delete(trimmed);
        return { ok: false, reason: "expired" };
      }

      const key = normalizeAccountKey(account);
      const existing = (await loadBindings()).find((binding) => normalizeAccountKey(binding.account) === key);
      if (existing) {
        // 同一账户重复绑定：拒绝且消耗一次尝试，防止拿新码顶掉旧主体。
        record.failedAttempts += 1;
        if (record.failedAttempts >= MAX_CLAIM_ATTEMPTS_PER_CODE) pending.delete(trimmed);
        return { ok: false, reason: "already-bound" };
      }

      // 码一次性：认领成功即作废；失败累积到上限也作废。
      pending.delete(trimmed);
      const principalId = `ext-${idFactory().replace(/-/g, "").slice(0, 12)}`;
      const bindings = await loadBindings();
      bindings.push({
        version: 1,
        principalId,
        account: { ...account },
        boundAt: clock(),
      });
      await saveBindings(bindings);
      return { ok: true, principalId };
    },

    async principalFor(account) {
      const key = normalizeAccountKey(account);
      const bindings = await loadBindings();
      return bindings.find((binding) => normalizeAccountKey(binding.account) === key)?.principalId ?? null;
    },

    async unbind(account) {
      const key = normalizeAccountKey(account);
      const bindings = await loadBindings();
      await saveBindings(bindings.filter((binding) => normalizeAccountKey(binding.account) !== key));
    },

    async list() {
      return loadBindings();
    },
  };
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `b-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
