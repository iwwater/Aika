import {
  PET_REQUEST_TIMEOUT_MS,
  normalizeLoopbackEndpoint,
  type PetProductInfo,
  type PetResultCode,
  type PetShutdownCapability,
} from "./contracts";

/**
 * OpenPet 协议层（PET-03）。
 *
 * 上游事实来自 PET-01 的文档/源码核对与 **v0.1.6 实机复核**
 * （见 `docs/frontend/reports/PET-01_PROTOCOL.md`）：
 *
 * - 只有四个控制端点，**没有 capabilities 端点**；
 * - `/api/event` 的 `type` 是封闭的 6 值枚举，与 Aiki 的 `PetEvent` **逐字一致**；
 * - `/api/action` **没有** `ttlMs`、也没有取消字段；`animationId` 只要求非空，
 *   上游**不校验它是否属于当前角色**（实机用 `backflip` 得到 200）；
 * - 成功响应体是**完整快照**（含 `port`、`activePet.id`、`apiListening`、
 *   `apiError`、`bubbleText`、`lastAction`、`recentEvents` 等），**没有 `ok` 字段**；
 * - 失败响应体是 `{"error": "...", "ok": false}` 配 400/404；
 * - `ttlMs` 是 `u64`；`/api/say` 在服务端把正文截到 512 字符。
 *
 * 「成功没有 `ok`」决定了下面的判定规则：**不能要求响应含 `ok`**，也不能仅凭
 * HTTP 200 宣布受理。我们采用「2xx + 合法 JSON 对象 = 受理；显式 `ok: false`
 * = 拒绝」，并额外要求端点路径来自固定表——页面永远拿不到「请求任意 URL」的能力。
 */

export type PetEndpointKey = "status" | "say" | "action" | "event" | "shutdown";

export const OPENPET_ENDPOINTS: Readonly<Record<PetEndpointKey, { method: "GET" | "POST"; path: string }>> = {
  status: { method: "GET", path: "/api/status" },
  say: { method: "POST", path: "/api/say" },
  action: { method: "POST", path: "/api/action" },
  event: { method: "POST", path: "/api/event" },
  // PetShell 增量：上游 OpenPet v0.1.6 没有这个端点（PET-01 §5 已实证）。
  shutdown: { method: "POST", path: "/api/shutdown" },
};

/** 响应体上限 256KiB；超限一律协议错误，不截断后当成功。 */
export const OPENPET_MAX_RESPONSE_BYTES = 256 * 1024;

export type PetHttpFailureKind = "timeout" | "connection" | "aborted" | "too_large" | "blocked";

/**
 * 传输层失败。
 *
 * `connection` 与 `timeout` 被刻意分开：连接失败意味着请求**确定没送到**，
 * 可以判 `failed`；超时意味着可能已经送到，只能判 `unknown`——这正是契约里
 * 「POST 不自动重试」的理由。
 */
export class PetHttpFailure extends Error {
  constructor(readonly kind: PetHttpFailureKind) {
    super(kind);
    this.name = "PetHttpFailure";
  }
}

export interface PetHttpRequest {
  method: "GET" | "POST";
  /** 归一化后的 `http://host:port`；由 adapter 提供，不接受用户文本直接拼 URL。 */
  base: string;
  /** 端点 key 而不是路径：路径在主进程侧由固定表解析。 */
  endpoint: PetEndpointKey;
  body?: string;
  timeoutMs: number;
  /**
   * 本地取消信号（dispose/换轮）。
   *
   * 注意它的能力边界：它保证**我们不再使用**这次结果，不保证请求没到达上游。
   * 原生实现另有 1500ms 硬超时，所以取消不会留下悬挂连接。
   */
  signal?: AbortSignal;
  /**
   * 受管退出凭据。**只在 `shutdown` 端点生效**：原生侧对其它端点忽略它，所以
   * 页面拿不到「往任意路由附带令牌」的能力。
   */
  bearerToken?: string;
}

export interface PetHttpResponse {
  status: number;
  bodyText: string;
}

/**
 * 原生宿主传输端口。
 *
 * 生产实现走 Tauri 命令（`desktop_pet_http.rs`：固定端点、禁用代理与重定向、
 * 字节上限、超时）。测试只替换这个端口。
 */
export interface PetHttpPort {
  send(request: PetHttpRequest): Promise<PetHttpResponse>;
}

export interface OpenPetStatusSnapshot {
  port?: number;
  petId?: string;
  /** 上游未提供时**不伪造**。 */
  runtimeVersion?: string;
  /** 运行时自报的真实身份；旧运行时没有这个字段。 */
  product?: PetProductInfo;
  /** 协议退出能力；缺字段一律按「不可用」处理。 */
  shutdown?: PetShutdownCapability;
  /** 上游若提供动作清单则解析；没有就交给人工 profile。 */
  actions?: string[];
}

/** 读数：`product` 整体缺失或三个字段都读不到时返回 undefined，不编造。 */
function readProduct(source: Record<string, unknown>): PetProductInfo | undefined {
  const raw = source.product;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const name = readString(record, "name");
  const version = readString(record, "version");
  const upstream = readString(record, "upstream");
  if (name === undefined && version === undefined && upstream === undefined) return undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
  };
}

/**
 * 读数：`available` 缺失即视为**不可用**。
 *
 * 这是 fail-closed 的一侧：越权退出的代价远高于「少用一次新能力」，所以只有对面
 * 明确写 `available: true` 才认。
 */
function readShutdown(source: Record<string, unknown>): PetShutdownCapability | undefined {
  const capabilities = source.capabilities;
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
    return undefined;
  }
  const raw = (capabilities as Record<string, unknown>).shutdown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const endpoint = readString(record, "endpoint");
  const version = readPositiveInt(record, "version");
  const auth = readString(record, "auth");
  if (endpoint === undefined || version === undefined || auth === undefined) return undefined;
  return { endpoint, version, auth, available: record.available === true };
}

export type OpenPetVerdict =
  | { kind: "accepted"; snapshot: OpenPetStatusSnapshot | null }
  | { kind: "rejected"; status: number; code: PetResultCode }
  | { kind: "incompatible"; status: number }
  | { kind: "protocol_error" };

/** base 必须先通过 loopback 校验；非法直接抛错，不静默退回默认地址。 */
export function assertLoopbackBase(raw: string): string {
  const normalized = normalizeLoopbackEndpoint(raw);
  if (!normalized) throw new Error(`桌宠地址非法（只允许本机 http 端点）：${raw}`);
  return normalized.endpoint;
}

export function buildRequest(
  base: string,
  endpoint: PetEndpointKey,
  payload?: Record<string, unknown>,
): PetHttpRequest {
  const spec = OPENPET_ENDPOINTS[endpoint];
  const request: PetHttpRequest = {
    method: spec.method,
    base,
    endpoint,
    timeoutMs: PET_REQUEST_TIMEOUT_MS,
  };
  if (spec.method === "POST") request.body = JSON.stringify(payload ?? {});
  return request;
}

export function buildSayRequest(base: string, text: string, ttlMs?: number): PetHttpRequest {
  const payload: Record<string, unknown> = { text };
  // TTL 只在有值时才带：上游「不传就用自己的默认」，凭空塞一个值反而是我们的猜测。
  if (ttlMs !== undefined) payload.ttlMs = ttlMs;
  return buildRequest(base, "say", payload);
}

export function buildActionRequest(base: string, animationId: string): PetHttpRequest {
  // 动作**不带 ttlMs**：上游 action 没有这个字段，塞进去属于未经验证的字段。
  return buildRequest(base, "action", { animationId });
}

export function buildEventRequest(
  base: string,
  type: string,
  message?: string,
  ttlMs?: number,
): PetHttpRequest {
  const payload: Record<string, unknown> = { type };
  if (message !== undefined) payload.message = message;
  if (ttlMs !== undefined) payload.ttlMs = ttlMs;
  return buildRequest(base, "event", payload);
}

/**
 * 协议退出请求。
 *
 * 凭据是调用者给的**自己派发时用的那一份**；没有凭据就不该走到这里——`available`
 * 为假时调用方必须直接沿用进程句柄策略。
 */
export function buildShutdownRequest(base: string, token: string): PetHttpRequest {
  return {
    method: "POST",
    base,
    endpoint: "shutdown",
    body: JSON.stringify({}),
    timeoutMs: PET_REQUEST_TIMEOUT_MS,
    bearerToken: token,
  };
}

function isJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length ? items.map((item) => item.trim()) : undefined;
}

/**
 * 从 status 快照里取可确认字段。
 *
 * 上游 status 结构未完全公开，因此**只按位置读取已知字段**（`port`、`activePet.id`），
 * 其它一律留空——不猜字段名，也不把没读到当成「不存在」。若上游某天提供了
 * `version`/`actions`，按同名读取；读不到就由人工 profile 补充并标明来源。
 */
export function readStatusSnapshot(payload: Record<string, unknown>): OpenPetStatusSnapshot {
  const snapshot: OpenPetStatusSnapshot = {};
  const port = readPositiveInt(payload, "port");
  if (port !== undefined) snapshot.port = port;

  const activePet = payload.activePet;
  const activePetId = typeof activePet === "object" && activePet !== null && !Array.isArray(activePet)
    ? readString(activePet as Record<string, unknown>, "id")
    : undefined;
  const petId = activePetId ?? readString(payload, "petId");
  if (petId !== undefined) snapshot.petId = petId;

  const version = readString(payload, "version") ?? readString(payload, "runtimeVersion");
  if (version !== undefined) snapshot.runtimeVersion = version;

  const actions = readStringArray(payload, "actions");
  if (actions !== undefined) snapshot.actions = actions;

  const product = readProduct(payload);
  if (product !== undefined) snapshot.product = product;

  const shutdown = readShutdown(payload);
  if (shutdown !== undefined) snapshot.shutdown = shutdown;

  return snapshot;
}

function classifyNonOkStatus(status: number): OpenPetVerdict {
  // 3xx：我们禁用了重定向，收到就说明对面不是我们要的那个运行时。
  if (status >= 300 && status < 400) return { kind: "incompatible", status };
  // 404/405/415 = 路由、方法或媒体类型对不上 → 协议变了，之后不再发 POST。
  if (status === 404 || status === 405 || status === 415) {
    return { kind: "incompatible", status };
  }
  // 400 = 我们发错了请求体（实机实测：空 animationId、坏 JSON、ttlMs 类型不对）。
  // 协议是通的，所以判 failed/invalid_input，而不是 incompatible。
  if (status === 400) return { kind: "rejected", status, code: "invalid_input" };
  // 401/403 只可能来自退出端点：凭据没给对，或本实例没启用退出。
  // **不判 incompatible**——对面仍是兼容的运行时，只是这次不许我们退出；
  // 调用方必须据此回退到进程句柄，而不是从此停止发送。
  if (status === 401) return { kind: "rejected", status, code: "invalid_input" };
  if (status === 403) return { kind: "rejected", status, code: "unsupported" };
  return { kind: "rejected", status, code: "http_error" };
}

/**
 * 判定一次响应。
 *
 * 关键取舍：2xx 但响应体不是合法 JSON 对象时判 `protocol_error`（而不是 accepted）。
 * 调用方对 POST 的处理是把它当 `unknown`——对面答了话，但内容无法证明请求被受理。
 *
 * **stub 修正**：其余判定已在 PET-07 一侧的实机核对中逐条复核（见
 * `docs/frontend/reports/PET-01_PROTOCOL.md` §2.3 与 `PET-03_ACCEPTANCE.md` 的追加节）：
 * 上游用 `400` 表达「请求体不合法」（`animationId is required` / `invalid JSON: …`
 * / `invalid type: string "abc", expected u64`），用 `404` 表达「路由不存在」。
 * 因此 400 **不能**当作「协议不兼容」——那会让一次空动作把整条链路标成不兼容，
 * 从此不再发送。
 */
export function parseOpenPetResponse(status: number, bodyText: string): OpenPetVerdict {
  if (status < 200 || status >= 300) return classifyNonOkStatus(status);

  const payload = isJsonObject(bodyText);
  if (!payload) return { kind: "protocol_error" };
  // 上游虽未定义错误体，但若它明确说 ok=false，我们没有理由当成功。
  if (payload.ok === false) return { kind: "rejected", status, code: "protocol_error" };

  return { kind: "accepted", snapshot: readStatusSnapshot(payload) };
}

/** 把「成功响应」映射成对 POST 有意义的结果语义。 */
export function toPostResult(verdict: OpenPetVerdict): { outcome: "accepted" | "failed" | "unknown"; code?: PetResultCode } {
  switch (verdict.kind) {
    case "accepted":
      return { outcome: "accepted" };
    case "rejected":
      return { outcome: "failed", code: verdict.code };
    case "incompatible":
      // 端点不认：这不是「这次失败」，是「这条协议在这台机器上不成立」。
      return { outcome: "failed", code: "unsupported" };
    case "protocol_error":
      return { outcome: "unknown", code: "protocol_error" };
  }
}
