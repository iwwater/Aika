import { token } from "../../kernel";

/**
 * 桌宠接入归一化契约（`desktopPet.integration.v1`）。
 *
 * 与 `docs/frontend/DESKTOP_PET_CONTRACT.md` 一一对应：Aiki 只认识这里的语义，
 * 供应商协议（OpenPet 的 `animationId`、NyaDeskPet 的 `live2d` 指令）留在各自
 * adapter 里。升级供应商版本最多改 adapter 与 profile，不动业务调用方。
 *
 * 这里的类型是**可选新增**：不装桌宠时 `DesktopPetServiceToken` 根本不注册，
 * 消费方 `tryResolve` 拿 null 就隐藏入口（与 Remote / 麦克风同一套约定）。
 */

/** Aiki 对外表达的展示语义。上游没有同名概念时由 profile 映射。 */
export type PetEvent =
  | "thinking"
  | "tool-running"
  | "reviewing"
  | "success"
  | "failure"
  | "attention";

export const PET_EVENTS: readonly PetEvent[] = [
  "thinking", "tool-running", "reviewing", "success", "failure", "attention",
];

export function isPetEvent(value: unknown): value is PetEvent {
  return typeof value === "string" && (PET_EVENTS as readonly string[]).includes(value);
}

/**
 * 能力值。
 *
 * `native` = 上游原生支持且已实证；`mapped` = 经锁定的 profile 映射后的等价表达；
 * `unsupported` = 协议确认没有这个能力；`unknown` = 没验证过，**不等于没有**。
 * 断线时快照可保留，但必须配 `stale`——把缓存当当前可用是这里最危险的误用。
 */
export type Capability = "native" | "mapped" | "unsupported" | "unknown";

export type PetCapabilityName =
  | "say" | "action" | "emotion" | "event"
  | "interactionEvents" | "audio" | "lipSync";

export const PET_CAPABILITY_NAMES: readonly PetCapabilityName[] = [
  "say", "action", "emotion", "event", "interactionEvents", "audio", "lipSync",
];

export type PetCapabilityMap = Record<PetCapabilityName, Capability>;

export type PetResultOutcome = "accepted" | "skipped" | "failed" | "unknown";

/** 结果代码。`accepted` 只表示请求被受理，不表示动画已播放。 */
export type PetResultCode =
  | "disabled" | "offline" | "unsupported" | "invalid_input"
  | "expired" | "stale_turn" | "overloaded" | "timeout"
  | "protocol_error" | "http_error" | "cancelled";

export interface PetResult {
  outcome: PetResultOutcome;
  code?: PetResultCode;
}

export const PET_ACCEPTED: PetResult = { outcome: "accepted" };

export function skipped(code: PetResultCode): PetResult {
  return { outcome: "skipped", code };
}

export function failed(code: PetResultCode): PetResult {
  return { outcome: "failed", code };
}

export function unknownResult(code: PetResultCode): PetResult {
  return { outcome: "unknown", code };
}

/**
 * 一次发送的本地上下文。
 *
 * `commandId` / `expiresAt` 由 Service 分配，业务调用者不手造——所以对外的
 * 业务方法只接受 `PetCallOptions`，不会看到这个类型。
 */
export interface PetContext {
  commandId: string;
  runtimeTurnId?: string;
  /** 由注入 Clock 产生，仅本地判断，**不外发**给供应商。 */
  expiresAt: number;
  /**
   * 展示存活时长（ms），**也不外发**给供应商做气泡 TTL——供应商有它自己的
   * 默认值（OpenPet 的事件气泡是 4 秒），我们只在本地决定「我们让它停多久」。
   *
   * 和 `expiresAt` 分开是因为两者管的不是一件事：`expiresAt` 说「这条命令还值
   * 不值得发出去」，`ttlMs` 说「气泡该显示多久」。早期版本把两者合成一个数，
   * 结果是一整句话的气泡只存在 4 秒：用户还没读完就消失了，反馈读起来就是
   * 「她好像没回应」。真机核对正是撞在这里。
   */
  ttlMs?: number;
}

export type PetProviderId = "openpet" | "nyadeskpet";

export type PetConnection = "disabled" | "connecting" | "ready" | "offline" | "incompatible";

export interface PetStatus {
  provider: PetProviderId;
  connection: PetConnection;
  /** 上游没提供版本时不伪造。 */
  runtimeVersion?: string;
  petId?: string;
  checkedAt: number;
  stale: boolean;
  capabilities: PetCapabilityMap;
  /** Aiki 可用的语义名；供应商映射保留在 adapter/profile 内。 */
  actions: string[];
}

/** adapter 的构造参数已经注入传输；这里只暴露归一化命令。 */
export interface DesktopPetAdapter {
  status(): Promise<PetStatus>;
  say(text: string, context: PetContext): Promise<PetResult>;
  action(name: string, context: PetContext): Promise<PetResult>;
  emotion(name: string, context: PetContext): Promise<PetResult>;
  event(type: PetEvent, message: string | undefined, context: PetContext): Promise<PetResult>;
  dispose(): Promise<void>;
}

/** 业务调用者能提供的东西：只有轮次与更紧的本地期限。 */
export interface PetCallOptions {
  runtimeTurnId?: string;
  /** 更紧的本地期限（ms）；不会突破默认上限。只管「还值不值得发」。 */
  deadlineMs?: number;
  /** 展示存活时长（ms）；不传则退回发送期限的收口值（旧行为）。 */
  ttlMs?: number;
}

export interface DesktopPetSnapshot {
  enabled: boolean;
  connection: PetConnection;
  stale: boolean;
  actions: string[];
  capabilities: PetCapabilityMap;
  checkedAt: number;
  /** 当前配置代次；配置/角色/启用状态变化即自增。 */
  generation: number;
}

export interface PetDiagnostics {
  sent: number;
  accepted: number;
  skipped: number;
  failed: number;
  unknown: number;
  truncatedTexts: number;
  invalidInputs: number;
  staleDropped: number;
  probes: number;
  probeFailures: number;
  lastErrorCode: PetResultCode | null;
  lastCheckedAt: number;
}

export interface PetDiagnosticEvent {
  type: "probe" | "command" | "rejected" | "error";
  /** 只带代码与计数，不带气泡正文、密钥或本机全路径。 */
  code?: PetResultCode | "probe_failed" | "role_changed";
  outcome?: PetResultOutcome;
}

/**
 * 桌宠运行程序控制端口（PET-05 实现、Service 注入）。
 *
 * 只描述「进程是不是活的、归不归自己」；动画排程不在这里，也不该在这里。
 */
export interface DesktopPetProcessPort {
  state(): { mode: PetProcessMode; owned: boolean; alive: boolean };
  /** attach 只探测；managed 在必要时启动。实现方负责并发合并与就绪探测。 */
  ensureReady(): Promise<void>;
  /**
   * 取消未完成的启动与重启计划（disable 时调用）。
   *
   * 可选：它**不**终止已经在运行的进程——那是 `dispose` 与 `stopOwnedOnExit` 的事。
   */
  cancelPending?(): void;
  /** 幂等；只处理本次由 Aiki 启动且配置允许终止的进程。 */
  dispose(): Promise<void>;
}

export type PetProcessMode = "attach" | "managed";

export interface PetConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: PetProviderId;
  endpoint: string;
  mode: PetProcessMode;
  executablePath: string | null;
  startWithAiki: boolean;
  stopOwnedOnExit: boolean;
  autoRestart: boolean;
  profileId: string | null;
}

export interface PetConfigInput {
  enabled?: boolean;
  provider?: PetProviderId;
  endpoint?: string;
  mode?: PetProcessMode;
  executablePath?: string | null;
  startWithAiki?: boolean;
  stopOwnedOnExit?: boolean;
  autoRestart?: boolean;
  profileId?: string | null;
}

export const DEFAULT_PET_ENDPOINT = "http://127.0.0.1:17321";

export const PET_CONFIG_DEFAULTS: PetConfig = {
  schemaVersion: 1,
  enabled: false,
  provider: "openpet",
  endpoint: DEFAULT_PET_ENDPOINT,
  mode: "attach",
  executablePath: null,
  startWithAiki: false,
  stopOwnedOnExit: false,
  autoRestart: false,
  profileId: null,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 归一化配置。
 *
 * 非法 endpoint **显式抛错**，不静默退回默认值：把 `http://10.0.0.5:17321` 悄悄
 * 改成 `127.0.0.1` 会让用户以为设置生效了，而实际上他写的地址被丢掉了。
 * 首次配置默认 `enabled=false`；旧 `pet.enabled` 不会自动转换成托管启动授权。
 */
export function normalizePetConfig(raw: unknown): PetConfig {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const provider = input.provider === "nyadeskpet" ? "nyadeskpet" : "openpet";
  const endpointRaw = typeof input.endpoint === "string" ? input.endpoint : DEFAULT_PET_ENDPOINT;
  const endpoint = normalizeLoopbackEndpoint(endpointRaw);
  if (!endpoint) throw new Error(`桌宠地址非法（只允许本机 http 端点）：${endpointRaw}`);
  const mode = input.mode === "managed" ? "managed" : "attach";
  const executablePath = typeof input.executablePath === "string" && input.executablePath.trim()
    ? input.executablePath.trim()
    : null;
  return {
    schemaVersion: 1,
    enabled: asBoolean(input.enabled, false),
    provider,
    endpoint: endpoint.endpoint,
    mode,
    executablePath,
    startWithAiki: asBoolean(input.startWithAiki, false),
    stopOwnedOnExit: asBoolean(input.stopOwnedOnExit, false),
    autoRestart: asBoolean(input.autoRestart, false),
    profileId: typeof input.profileId === "string" && input.profileId.trim() ? input.profileId.trim() : null,
  };
}

/** 单请求上限（传输层强制）。 */
export const PET_REQUEST_TIMEOUT_MS = 1_500;
/** 默认本地期限：过了它就不再发送，避免「一句三秒前的回复」此刻才冒出来。 */
export const PET_DEFAULT_DEADLINE_MS = 4_000;
/** 剩余寿命下限：不足这个数直接判 expired，不做一次无意义的抢救发送。 */
export const PET_MIN_TTL_MS = 500;
export const PET_MAX_TTL_MS = 10_000;
/** 气泡正文上限（Unicode code points）。 */
export const PET_MAX_TEXT_POINTS = 500;
/** 短状态（thinking 等）上限。 */
export const PET_MAX_STATUS_POINTS = 80;

/** 正常探测间隔；离线退避序列，上限 30s。 */
export const PET_PROBE_INTERVAL_MS = 10_000;
export const PET_OFFLINE_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface PetProbePolicy {
  intervalMs: number;
  backoffMs: readonly number[];
}

export const DEFAULT_PET_PROBE_POLICY: PetProbePolicy = {
  intervalMs: PET_PROBE_INTERVAL_MS,
  backoffMs: PET_OFFLINE_BACKOFF_MS,
};

export interface TextProjection {
  text: string;
  truncated: boolean;
  /** 被截掉的 code point 数（含被省略号替代的那个）。 */
  removed: number;
}

/**
 * 文本归一化：trim → 空则判无效 → 超长按 code point 边界截断加省略号。
 *
 * 用 `Array.from` 而不是 `slice`：后者会从中间劈开代理对，把 emoji 变成乱码，
 * 而「中文/日文/emoji 都不该被截坏」正是这条规则存在的理由。
 */
export function projectPetText(raw: unknown, limit: number = PET_MAX_TEXT_POINTS): TextProjection {
  if (typeof raw !== "string") return { text: "", truncated: false, removed: 0 };
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", truncated: false, removed: 0 };
  const points = Array.from(trimmed);
  if (points.length <= limit) return { text: trimmed, truncated: false, removed: 0 };
  const keep = Math.max(1, limit - 1);
  return {
    text: `${points.slice(0, keep).join("")}…`,
    truncated: true,
    removed: points.length - keep,
  };
}

export interface LoopbackEndpoint {
  /** 归一化后的 `http://host:port`（末尾无斜杠）。 */
  endpoint: string;
  host: "127.0.0.1" | "[::1]";
  port: number;
}

/**
 * 只接受本机 HTTP 端点。
 *
 * 拒绝的东西同为安全边界：https、凭证、路径、query、fragment、非 loopback 主机。
 * `localhost` 在配置边界统一归一化为 `127.0.0.1`——避免同一台机器被解析成
 * IPv6 后与 Rust 侧白名单不一致。
 */
export function normalizeLoopbackEndpoint(raw: unknown): LoopbackEndpoint | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const hostname = url.hostname.toLowerCase();
  let host: LoopbackEndpoint["host"];
  if (hostname === "127.0.0.1" || hostname === "localhost") host = "127.0.0.1";
  else if (hostname === "[::1]" || hostname === "::1") host = "[::1]";
  else return null;
  return { endpoint: `http://${host}:${port}`, host, port };
}

/**
 * 桌宠接入服务。
 *
 * 它是有界的「有界网络发送器 + 状态订阅」，不是动画排程器，也不是第二套对话
 * 编排：轮次顺序、取消、终态只由 `CompanionRuntime` 决定，这里只消费最终结果。
 */
export interface DesktopPetService {
  enable(): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): boolean;
  /** 读快照，不发网络请求。 */
  snapshot(): DesktopPetSnapshot;
  /** 主动探测一次（「测试连接」）；同一时刻最多 1 个在途探测。 */
  status(): Promise<PetStatus>;

  say(text: string, options?: PetCallOptions): Promise<PetResult>;
  action(name: string, options?: PetCallOptions): Promise<PetResult>;
  emotion(name: string, options?: PetCallOptions): Promise<PetResult>;
  event(type: PetEvent, message: string | undefined, options?: PetCallOptions): Promise<PetResult>;

  subscribe(listener: (snapshot: DesktopPetSnapshot) => void): () => void;
  diagnostics(): PetDiagnostics;

  /** 换 profile（角色/版本变化）：失效旧映射并重新探测。 */
  setProfile(profile: PetProfileLike | null): void;
  /**
   * 当前 profile 的只读副本。
   *
   * 展示桥接需要它来判断「这个 mood/动作到底有没有已验证映射」——没有就不发
   * 那条表现命令，而不是发出去再被能力门禁拒掉（那会白占一个待发槽）。
   */
  profileSnapshot(): PetProfileLike | null;
  /** 换配置：endpoint/provider/mode 变化即递增 generation。 */
  setConfig(config: PetConfigInput): Promise<void>;
  config(): PetConfig;
  dispose(): Promise<void>;
}

/**
 * 结构上与 `profile.ts` 的 `PetProfileV1` 一致。
 *
 * 单独写一次是为了让 `contracts.ts` 不 import `profile.ts`（profile 反过来要
 * 认识 `PetEvent` 等类型），避免循环依赖。
 */
export interface PetProfileLike {
  schemaVersion: 1;
  provider: PetProviderId;
  release: string;
  petId: string;
  source: "upstream" | "manual";
  actions: Record<string, string>;
  emotions: Record<string, string>;
  events: Partial<Record<PetEvent, string>>;
}

/**
 * 桌宠服务 token。
 *
 * **能力缺失即不注册**：浏览器宿主、未启用桌宠的桌面宿主都不提供它，
 * 消费方 `optional` 声明 + `tryResolve`，拿到 null 就隐藏入口。
 */
export const DesktopPetServiceToken = token<DesktopPetService>("desktopPet.service");
