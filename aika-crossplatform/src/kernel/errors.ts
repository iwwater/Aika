/**
 * 内核错误。
 *
 * 错误码是契约的一部分：调用方与测试按 code 分支，不靠 message 文本。
 * message 只给人看，可以随时改；code 改了就是破坏性变更。
 */

export type KernelErrorCode =
  // 注册表
  | "SERVICE_NOT_REGISTERED"
  | "SERVICE_ALREADY_REGISTERED"
  | "SERVICE_CYCLE"
  // 作用域注册器
  | "TOKEN_NOT_DECLARED"
  | "DEPENDENCY_NOT_DECLARED"
  | "REGISTRAR_REVOKED"
  // 插件图
  | "PLUGIN_DUPLICATE_ID"
  | "PLUGIN_DEPENDENCY_MISSING"
  | "PLUGIN_PROVIDER_CONFLICT"
  | "PLUGIN_GRAPH_CYCLE"
  | "PLUGIN_CONTRACT_VIOLATION"
  | "PLUGIN_ACTIVATION_FAILED"
  // 内核状态
  | "KERNEL_NOT_READY"
  | "KERNEL_FAILED"
  | "KERNEL_INVALID_STATE";

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  /** 结构化补充信息，例如成环时的完整链路。不放进 message 是为了方便断言。 */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: KernelErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

export function isKernelError(error: unknown, code?: KernelErrorCode): error is KernelError {
  if (!(error instanceof KernelError)) return false;
  return code === undefined || error.code === code;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 插件抛的可能是任意异常；不是 KernelError 时归到调用方给的兜底码。 */
export function codeOf(error: unknown, fallback: KernelErrorCode): KernelErrorCode {
  return error instanceof KernelError ? error.code : fallback;
}
