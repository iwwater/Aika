/**
 * Permission 契约（RT-03）。
 *
 * 一条权限请求绑定：principal、conversation、agentSession、规范化 workspace、
 * 动作参数摘要、policy 版本、过期时刻、单次 nonce。unknown 一律默认拒绝。
 *
 * 决策与执行是两个终态：pending → approved/rejected/expired/cancelled 是**决定**；
 * approved 之后再以 executionId/consumedAt **原子认领**恰好一次。已经发生的
 * 副作用不能靠取消追回——报告里如实区分 consumed/executing/cancelRequested。
 */

/** 动作参数摘要（审计与执行前比对用）；原始参数绝不进请求与审计。 */
export function paramsDigestOf(params: unknown): string {
  const canonical = JSON.stringify(params, (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as object).sort().reduce<Record<string, unknown>>((acc, key2) => {
        acc[key2] = (value as Record<string, unknown>)[key2];
        return acc;
      }, {});
    }
    return value;
  });
  return digestOf(canonical);
}

function digestOf(text: string): string {
  // FNV-1a 32bit：本地摘要够了，这不是密码学原语——防的是「参数悄悄变了」。
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + `-${text.length}`;
}

export type PermissionCategory = "read" | "write" | "execute" | "external";

/** 审计与请求里携带的动作描述：只有 kind + 摘要 + 相对目标，绝无原始参数。 */
export interface PermissionActionV1 {
  version: 1;
  kind: string;
  category: PermissionCategory;
  /** workspace 内的相对目标路径；无路径动作为空。 */
  targetRel?: string;
  /** 参数摘要（paramsDigestOf）。 */
  paramsDigest: string;
}

export interface PermissionRequestV1 {
  schemaVersion: 1;
  requestId: string;
  /** 单次 nonce：认领执行时必须原样出现。 */
  nonce: string;
  principalId: string;
  conversationId: string;
  agentSessionId?: string;
  action: PermissionActionV1;
  /** 已规范化的 workspace 绝对路径；非路径动作省略。 */
  workspace?: string;
  policyVersion: number;
  createdAt: number;
  expiresAt: number;
}

export type PermissionState = "pending" | "approved" | "rejected" | "expired" | "cancelled";

/** 执行认领：executionId + consumedAt，恰好一次。 */
export interface PermissionExecutionV1 {
  executionId: string;
  consumedAt: number;
  /** 执行中收到撤销请求时如实标记：副作用不可追回，只能上报。 */
  cancelRequested?: boolean;
}

export interface PermissionRecordV1 {
  request: PermissionRequestV1;
  state: PermissionState;
  decidedAt?: number;
  decidedBy?: string;
  /** 批准后收到的撤销：不回滚决定，留给执行入口在认领/执行中重新检查。 */
  cancelRequested?: boolean;
  execution: PermissionExecutionV1 | null;
}

export const PERMISSION_SCHEMA_VERSION = 1;
export const PERMISSION_POLICY_VERSION = 1;

/** 请求的有效期上限（毫秒）：过期时刻由这里封顶，不给「永久批准」留门。 */
export const MAX_PERMISSION_TTL_MS = 10 * 60_000;

/** Windows 路径边界检查的结果：不确定时拒绝，并说明原因。 */
export interface PathBoundaryResult {
  ok: boolean;
  /** 规范化后的绝对路径（ok 时）。 */
  normalized?: string;
  /** workspace 内的相对目标（ok 时）。 */
  targetRel?: string;
  reason?: "empty" | "escape" | "unresolvable" | "outside" | "invalid";
  /** true = 只做了词法规范化，真实路径（junction/reparse/TOCTOU）未验证。 */
  assumedLexical?: boolean;
}

/**
 * 路径边界检查（RT-03-D）。
 *
 * 覆盖：`..` 逃逸、相邻前缀（C:\work vs C:\worker）、Windows 大小写不敏感、
 * UNC 共享名边界、正反斜杠混用。`realPathOf` 可注入真实解析（junction/reparse/
 * 符号链接/TOCTOU 的最后防线）：解析失败或解析后越界一律拒绝——
 * **无法保证时拒绝越界**，绝不因「只读」字样开放任意目录。
 */
export function checkPathBoundary(
  workspace: string,
  target: string,
  options: { realPathOf?: (absolute: string) => string | null; platform?: "win32" | "posix" } = {},
): PathBoundaryResult {
  const platform = options.platform ?? "win32";
  if (!workspace.trim() || !target.trim()) return { ok: false, reason: "empty" };

  // 归一化：统一反斜杠、去重；UNC 的前导双斜杠保留。
  const norm = (value: string): string => {
    const unc = /^\\\\/.test(value);
    let out = value.replace(/[/\\]+/g, "\\");
    if (out.length > 1 && out.endsWith("\\")) out = out.slice(0, -1);
    if (unc && !out.startsWith("\\\\")) out = "\\" + out;
    return out;
  };

  const workspaceNorm = norm(workspace);
  const isUnc = workspaceNorm.startsWith("\\\\") && workspaceNorm.length > 2;
  const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
  const driveOf = (value: string): string | null => {
    const match = WINDOWS_DRIVE.exec(value);
    return match ? value.slice(0, 2).toUpperCase() : null;
  };

  let absolute: string;
  if (/^[/\\]/.test(target) || WINDOWS_DRIVE.test(target) || /^\\\\/.test(target)) {
    absolute = norm(target);
  } else {
    absolute = `${workspaceNorm}\\${target.replace(/[/\\]+/g, "\\")}`;
  }

  if (!isUnc && platform === "win32") {
    const wsDrive = driveOf(workspaceNorm);
    const tDrive = driveOf(absolute);
    if (wsDrive && tDrive && wsDrive !== tDrive) return { ok: false, reason: "outside" };
  }
  if (isUnc) {
    const UNC_PREFIX = /^\\\\[^\\]+\\[^\\]+/;
    const wsShare = UNC_PREFIX.exec(workspaceNorm)?.[0]?.toUpperCase();
    const tShare = UNC_PREFIX.exec(absolute)?.[0]?.toUpperCase();
    if (!tShare || !wsShare || tShare !== wsShare) return { ok: false, reason: "outside" };
  }

  // 逐段折叠 . 与 ..；越过根或 workspace 之上由最终前缀比较拦截。
  const segments = absolute.split("\\").filter((segment) => segment !== "" && segment !== ".");
  const resolved: string[] = [];
  let escapedAboveRoot = false;
  for (const segment of segments) {
    if (segment === "..") {
      if (resolved.length === 0) {
        escapedAboveRoot = true;
        break;
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (escapedAboveRoot) return { ok: false, reason: "escape" };
  // UNC 的前导双斜杠被 split/filter 吃掉了，拼回前缀。
  const resolvedPath = (isUnc ? "\\\\" : "") + resolved.join("\\");

  // 前缀边界：整段比较（Windows 大小写不敏感），workspace 必须是目录前缀——
  // 相邻前缀（C:\work vs C:\worker）在这里被整段比较挡住。
  const wsUpper = workspaceNorm.toUpperCase();
  const targetUpper = resolvedPath.toUpperCase();
  const inside = targetUpper === wsUpper
    || (targetUpper.startsWith(wsUpper) && targetUpper[wsUpper.length] === "\\");
  if (!inside) return { ok: false, reason: "escape" };

  let assumedLexical: boolean | undefined;
  if (options.realPathOf) {
    const wsReal = options.realPathOf(workspaceNorm);
    const tReal = options.realPathOf(resolvedPath);
    if (wsReal === null || tReal === null) return { ok: false, reason: "unresolvable" };
    const wsRealUpper = wsReal.toUpperCase();
    const tRealUpper = tReal.toUpperCase();
    const realInside = tRealUpper === wsRealUpper || tRealUpper.startsWith(wsRealUpper + "\\");
    if (!realInside) return { ok: false, reason: "outside" };
  } else {
    assumedLexical = true;
  }

  const targetRel = targetUpper === wsUpper ? "." : resolvedPath.slice(workspaceNorm.length + 1);
  return { ok: true, normalized: resolvedPath, targetRel, assumedLexical };
}
