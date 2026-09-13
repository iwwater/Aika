/**
 * ACP 客户端（AGT-02）——协议映射与进程配置校验，进程实例由端口注入。
 *
 * ACP 是**通信协议，不是沙箱**：本模块不宣称限制 adapter 自有工具；
 * 真实只读也需要独立验证写能力已禁用（AGT-02-D 在真实轨 BLOCKED）。
 *
 * 协议面（按官方方法名映射）：
 * - initialize 协商版本/capability 之后才 session/new；
 * - session/prompt 以 stopReason 结束 Run，不销毁 Session；
 * - request_permission 必须响应**原 JSON-RPC id** 与**有效 optionId**；
 *   拒绝用协议支持的拒绝选项，不编造 approve 方法。
 *
 * 进程约束：可执行文件白名单、参数数组（禁止 shell 字符串拼接）、
 * cwd 规范化、环境最小化；stdout 是协议流，stderr 只进日志。
 */

import { checkPathBoundary } from "../../domain/permission";

/** 本适配器实现的 ACP 协议版本。 */
export const ACP_PROTOCOL_VERSION = 1;
/** 单条消息字节上限：超过直接终态，不试图解析。 */
export const ACP_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface AcpProcessConfig {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface AcpProcess {
  readonly config: AcpProcessConfig;
  writeStdin(line: string): void;
  onStdout(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export type ProcessFactory = (config: AcpProcessConfig) => AcpProcess;

/** 环境最小化白名单。 */
const ALLOWED_ENV_KEYS = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"];

export interface ProcessConfigValidation {
  ok: boolean;
  reason?: "executable-not-allowed" | "args-not-array" | "cwd-invalid" | "env-not-minimal";
  config?: AcpProcessConfig;
}

/** 进程配置校验（AGT-02-C）：白名单、参数数组、cwd 规范化、环境最小化。 */
export function validateProcessConfig(
  config: AcpProcessConfig,
  allowedExecutables: readonly string[],
): ProcessConfigValidation {
  if (!allowedExecutables.includes(config.executable) || /\s/.test(config.executable)) {
    // 含空白的可执行名是 shell 拼接的信号：必须走参数数组。
    return { ok: false, reason: "executable-not-allowed" };
  }
  if (!Array.isArray(config.args)) {
    return { ok: false, reason: "args-not-array" };
  }
  const cwd = checkPathBoundary(config.cwd, ".");
  if (!cwd.ok) return { ok: false, reason: "cwd-invalid" };
  for (const key of Object.keys(config.env)) {
    if (!ALLOWED_ENV_KEYS.includes(key)) return { ok: false, reason: "env-not-minimal" };
  }
  return { ok: true, config };
}

/** capability 协商：未实现的能力（fs/terminal）不宣告（AGT-02-C）。 */
export const ADVERTISED_CAPABILITIES = ["prompt"] as const;

export interface AcpInboundMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: Record<string, unknown>;
  malformed?: boolean;
}

/** 分包/错 JSON/超大消息：从 stdout 字节流还原结构化帧。 */
export function parseAcpStream(buffer: string, maxBytes = ACP_MAX_MESSAGE_BYTES): {
  messages: AcpInboundMessage[];
  rest: string;
  error?: "malformed" | "oversized";
} {
  const messages: AcpInboundMessage[] = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline < 0) break;
    const line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > maxBytes) {
      return { messages, rest, error: "oversized" };
    }
    try {
      messages.push(JSON.parse(line) as AcpInboundMessage);
    } catch {
      return { messages, rest, error: "malformed" };
    }
  }
  return { messages, rest };
}

/** request_permission 的合法响应：原 id + 有效 optionId（拒绝也是协议选项之一）。 */
export function buildPermissionResponse(
  request: { id: number | string; params?: { options?: Array<{ optionId: string; kind: string }>; } },
  chosenOptionId: string,
): string | null {
  const options = request.params?.options ?? [];
  const valid = options.some((option) => option.optionId === chosenOptionId);
  if (!valid) return null;
  return JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { optionId: chosenOptionId } }) + "\n";
}

/** 从 permission 请求的选项里挑协议拒绝项（没有就拒绝整个请求，不编造）。 */
export function denyOptionId(request: { params?: { options?: Array<{ optionId: string; kind: string }> } }): string | null {
  const options = request.params?.options ?? [];
  const deny = options.find((option) => option.kind === "reject" || option.kind === "deny" || option.kind === "cancel");
  return deny?.optionId ?? null;
}

/** 已初始化会话上的一次 prompt 生命周期。 */
export interface AcpPromptHandle {
  sessionId: string;
  acpSessionId: string;
  write(line: string): void;
  /** 协议侧取消（session/cancel）。 */
  cancel(): void;
}
