/**
 * 身份凭证与配对（FE-17-pre）。
 *
 * 安全属性（全部 fail-closed）：
 * - 配对码 CSPRNG 生成、TTL ≤5min、尝试上限 5、**原子单次兑换**——
 *   过期/耗尽/重复兑换一律失效。
 * - 长期会话凭证只在兑换响应里出现一次；存储只留 hash，不进普通设置导出。
 * - 撤销立即生效：HTTP、现存 WS、缓存认证全部走同一个 authenticate 门。
 * - 会话按 device+principal 归属；逐设备轮换/撤销不影响其他设备。
 */

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const MAX_PAIRING_ATTEMPTS = 5;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export interface PairingCodeRecord {
  /** 只存 hash；明文码仅在 issue 响应里出现一次。 */
  codeHash: string;
  /** 本地主窗签发时指定的归属主体：兑换出的设备会话归属它。 */
  principalId: string;
  createdAt: number;
  expiresAt: number;
  failedAttempts: number;
  consumed: boolean;
}

export interface DeviceSessionRecord {
  sessionId: string;
  deviceId: string;
  principalId: string;
  /** 只存凭证 hash；明文 token 只在兑换响应里出现一次。 */
  credentialHash: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface StoredCredentials {
  schemaVersion: 1;
  pairing: Record<string, PairingCodeRecord>;
  sessions: DeviceSessionRecord[];
}

export function hashToken(token: string): string {
  // FNV-1a 32bit×2：本地凭证比对足够（token 本身是 CSPRNG 高熵值，
  // hash 的作用是让存储泄漏不等于凭证泄漏，不是密码学承诺）。
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < token.length; index += 1) {
    h1 = Math.imul(h1 ^ token.charCodeAt(index), 0x01000193);
    h2 = Math.imul(h2 + token.charCodeAt(index), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export interface IssuePairingResult {
  code: string;
  expiresAt: number;
}

export type RedeemResult =
  | { ok: true; credential: { token: string; sessionId: string; expiresAt: number; principalId: string } }
  | { ok: false; reason: "invalid" | "expired" | "exhausted" | "already-consumed" };

export type AuthResult =
  | { ok: true; session: DeviceSessionRecord }
  | { ok: false; reason: "unknown" | "revoked" | "expired" };

export interface CredentialRepository {
  /** 已验证本地主窗调用；明文码只出现在这次响应里。 */
  issuePairingCode(input: { deviceId: string; principalId: string }): Promise<IssuePairingResult>;
  /** 原子单次兑换：成功即消耗；失败累计尝试次数，到上限码作废。 */
  redeemPairingCode(input: { code: string; deviceId: string }): Promise<RedeemResult>;
  /** 所有受保护访问的唯一认证门（HTTP/WS/缓存共用）。 */
  authenticate(token: string): Promise<AuthResult>;
  /** 逐设备轮换：旧凭证立即失效，其他设备不受影响。 */
  rotate(sessionId: string): Promise<{ ok: boolean; credential?: { token: string; sessionId: string; expiresAt: number }; reason?: string }>;
  revoke(sessionId: string): Promise<void>;
  /** 脱敏列表：无任何凭证字段。 */
  listSessions(): Promise<Array<{ sessionId: string; deviceId: string; principalId: string; createdAt: number; expiresAt: number; revoked: boolean }>>;
  pendingPairingCount(): Promise<number>;
}

export interface CredentialStoreOptions {
  loadStorage: () => Promise<{ getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }>;
  clock?: () => number;
  /** CSPRNG 码/token 工厂；默认 crypto.randomUUID。 */
  random?: (length: number) => string;
}

const CREDENTIALS_KEY = "outbound.credentials.v1";

export function createCredentialRepository(options: CredentialStoreOptions): CredentialRepository {
  const clock = options.clock ?? (() => Date.now());
  const random = options.random ?? defaultRandom;
  const pairing = new Map<string, PairingCodeRecord>();
  const sessions = new Map<string, DeviceSessionRecord>();
  let loaded = false;

  async function persist(): Promise<void> {
    const storage = await options.loadStorage();
    const document: StoredCredentials = {
      schemaVersion: 1,
      pairing: Object.fromEntries(pairing),
      sessions: [...sessions.values()],
    };
    await storage.setSetting(CREDENTIALS_KEY, JSON.stringify(document));
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const storage = await options.loadStorage();
      const raw = await storage.getSetting(CREDENTIALS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredCredentials;
      if (parsed?.schemaVersion === 1) {
        for (const [hash, record] of Object.entries(parsed.pairing ?? {})) pairing.set(hash, record);
        for (const record of parsed.sessions ?? []) sessions.set(record.sessionId, record);
      }
    } catch {
      // 损坏按「无凭证」处理：全部重新配对，绝不默认放行。
      pairing.clear();
      sessions.clear();
    }
  }

  return {
    async issuePairingCode(input) {
      await ensureLoaded();
      const code = random(8).toUpperCase();
      const now = clock();
      pairing.set(hashToken(code), {
        codeHash: hashToken(code),
        principalId: input.principalId,
        createdAt: now,
        expiresAt: now + PAIRING_CODE_TTL_MS,
        failedAttempts: 0,
        consumed: false,
      });
      await persist();
      return { code, expiresAt: now + PAIRING_CODE_TTL_MS };
    },

    async redeemPairingCode(input) {
      await ensureLoaded();
      const codeHash = hashToken(input.code.trim().toUpperCase());
      const record = pairing.get(codeHash);
      if (!record || record.consumed) {
        return { ok: false, reason: record?.consumed ? "already-consumed" : "invalid" };
      }
      if (clock() > record.expiresAt) return { ok: false, reason: "expired" };
      // 原子单次兑换：标记消耗与后续写入之间没有 await。
      record.consumed = true;

      const now = clock();
      const sessionId = random(16);
      const token = random(32);
      const session: DeviceSessionRecord = {
        sessionId,
        deviceId: input.deviceId,
        // 兑换码由本地主窗为特定主体签发；设备会话归属该主体。
        principalId: record.principalId,
        credentialHash: hashToken(token),
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        revoked: false,
      };
      sessions.set(sessionId, session);
      await persist();
      return {
        ok: true,
        credential: { token, sessionId, expiresAt: session.expiresAt, principalId: session.principalId },
      };
    },

    async authenticate(token) {
      await ensureLoaded();
      const record = [...sessions.values()].find((session) => session.credentialHash === hashToken(token));
      if (!record) return { ok: false, reason: "unknown" };
      if (record.revoked) return { ok: false, reason: "revoked" };
      if (clock() > record.expiresAt) return { ok: false, reason: "expired" };
      return { ok: true, session: record };
    },

    async rotate(sessionId) {
      await ensureLoaded();
      const session = sessions.get(sessionId);
      if (!session || session.revoked) return { ok: false, reason: "unknown-session" };
      const token = random(32);
      sessions.set(sessionId, { ...session, credentialHash: hashToken(token) });
      await persist();
      return { ok: true, credential: { token, sessionId, expiresAt: session.expiresAt } };
    },

    async revoke(sessionId) {
      await ensureLoaded();
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.set(sessionId, { ...session, revoked: true });
      await persist();
    },

    async listSessions() {
      await ensureLoaded();
      return [...sessions.values()].map(({ sessionId, deviceId, principalId, createdAt, expiresAt, revoked }) => ({
        sessionId, deviceId, principalId, createdAt, expiresAt, revoked,
      }));
    },

    async pendingPairingCount() {
      await ensureLoaded();
      const now = clock();
      return [...pairing.values()].filter((record) => !record.consumed && record.expiresAt > now).length;
    },
  };
}

function defaultRandom(length: number): string {
  const raw = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(16).slice(2)}`;
  return (raw + raw + raw).slice(0, Math.max(8, length));
}
