/**
 * 暴露面纯策略与认证端口（FE-17-pre）。
 *
 * 分层 loopback(default)/lan/public；**所有层的私有数据都需认证**。
 * publicTlsAck 只记录意图——没有真实 TLS 入口与后端不可直连证据，
 * public 永远打不开（无法验证保持 BLOCKED）。LAN 明文如实披露，
 * 不显示为端到端加密。
 */

export type ExposureLayer = "loopback" | "lan" | "public";

export interface ExposureConfig {
  layer: ExposureLayer;
  /** LAN 需用户显式启用（默认 loopback）。 */
  lanExplicitlyEnabled?: boolean;
  /** publicTlsAck 只记录意图，不构成开启 public 的证据。 */
  publicTlsAck?: boolean;
}

export interface ExposureDecision {
  layer: ExposureLayer;
  /** 私有数据需要认证——任何层都成立。 */
  privateDataRequiresAuth: true;
  /** 允许监听非 loopback 接口。 */
  allowLanBind: boolean;
  /** public 在证据齐备前恒为 false。 */
  publicAllowed: false | "blocked-no-tls-evidence";
  /** LAN 明文如实披露文案。 */
  disclosure: string;
}

export function effectiveExposure(config: ExposureConfig): ExposureDecision {
  if (config.layer === "public") {
    // TLS ack 不是证据：没有真实 TLS 入口验证，public 保持关闭。
    return {
      layer: "public",
      privateDataRequiresAuth: true,
      allowLanBind: false,
      publicAllowed: "blocked-no-tls-evidence",
      disclosure: "public 层需要真实 TLS 入口与后端不可直连证据；当前仅有 ack 记录，不会开放",
    };
  }
  if (config.layer === "lan") {
    if (!config.lanExplicitlyEnabled) {
      return {
        layer: "loopback",
        privateDataRequiresAuth: true,
        allowLanBind: false,
        publicAllowed: false,
        disclosure: "LAN 需显式启用；当前回落 loopback",
      };
    }
    return {
      layer: "lan",
      privateDataRequiresAuth: true,
      allowLanBind: true,
      publicAllowed: false,
      disclosure: "LAN 为明文传输，非端到端加密；所有私有数据仍需认证",
    };
  }
  return {
    layer: "loopback",
    privateDataRequiresAuth: true,
    allowLanBind: false,
    publicAllowed: false,
    disclosure: "仅本机回环可访问",
  };
}

/** 网关路由白名单：SQL/存储浏览/秘密读写/opener 永不进入网关。 */
const PRIVATE_ROUTE_PATTERNS = [/^\/api\/v1\/events/, /^\/api\/v1\/commands/];
const PUBLIC_ROUTE_PATTERNS = [/^\/$/, /^\/pairing\/redeem$/];
const FORBIDDEN_ROUTE_PATTERNS = [
  /^\/api\/v1\/sql/, /^\/api\/v1\/storage/, /^\/api\/v1\/secrets/, /^\/api\/v1\/opener/, /^\/api\/v1\/settings/,
];

export interface RouteVerdict {
  allowed: boolean;
  requiresAuth: boolean;
  reason?: RouteReason;
}

export function checkRoute(path: string): RouteVerdict {
  if (FORBIDDEN_ROUTE_PATTERNS.some((pattern) => pattern.test(path))) {
    return { allowed: false, requiresAuth: false, reason: "forbidden-route" };
  }
  if (PUBLIC_ROUTE_PATTERNS.some((pattern) => pattern.test(path))) {
    return { allowed: true, requiresAuth: false };
  }
  if (PRIVATE_ROUTE_PATTERNS.some((pattern) => pattern.test(path))) {
    return { allowed: true, requiresAuth: true };
  }
  return { allowed: false, requiresAuth: true, reason: "unknown-route" };
}

export type RouteReason = "forbidden-route" | "unknown-route" | "auth-required";

export interface RequestAuthInput {
  method: string;
  path: string;
  origin: string | null;
  /** Bearer token（推荐）。 */
  authorization?: string;
  /** cookie 认证必须配 CSRF 头。 */
  cookieToken?: string;
  csrfHeader?: string;
  expectedCsrf?: string;
  allowedOrigins: readonly string[];
  authenticate: (token: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type RequestAuthVerdict =
  | { ok: true }
  | { ok: false; reason: "bad-origin" | "forbidden-route" | "unknown-route" | "missing-credentials" | "invalid-credentials" | "csrf-missing" | "csrf-mismatch" };

/** 请求级认证门：Origin fail-closed、路由白名单、Bearer/cookie+CSRF。 */
export async function authenticateRequest(input: RequestAuthInput): Promise<RequestAuthVerdict> {
  const route = checkRoute(input.path);
  if (!route.allowed) return { ok: false, reason: (route.reason ?? "unknown-route") as "forbidden-route" | "unknown-route" };
  if (!route.requiresAuth) return { ok: true };

  // Origin：有 Origin 头就必须在白名单内；无 Origin（同源/非浏览器）放行给宿主判断。
  if (input.origin !== null && !input.allowedOrigins.includes(input.origin)) {
    return { ok: false, reason: "bad-origin" };
  }

  const bearer = input.authorization?.startsWith("Bearer ") ? input.authorization.slice(7) : undefined;
  if (bearer) {
    const verdict = await input.authenticate(bearer);
    return verdict.ok ? { ok: true } : { ok: false, reason: "invalid-credentials" };
  }
  if (input.cookieToken) {
    // cookie 认证必须配 CSRF：双重提交比对。
    if (!input.csrfHeader) return { ok: false, reason: "csrf-missing" };
    if (input.expectedCsrf === undefined || input.csrfHeader !== input.expectedCsrf) {
      return { ok: false, reason: "csrf-mismatch" };
    }
    const verdict = await input.authenticate(input.cookieToken);
    return verdict.ok ? { ok: true } : { ok: false, reason: "invalid-credentials" };
  }
  return { ok: false, reason: "missing-credentials" };
}
