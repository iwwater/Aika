import {
  assertLoopbackBase,
  PetHttpFailure,
  type PetHttpFailureKind,
  type PetHttpPort,
  type PetHttpRequest,
  type PetHttpResponse,
} from "./openPetProtocol";

/**
 * 原生宿主传输（PET-03）。
 *
 * 与 `outbound/tauriTransport.ts` 同一个套路：`invoke` 由宿主装配层注入，本模块
 * **不 import `@tauri-apps`**——因为「平台差异只出现在宿主目录」这条门禁，
 * 靠的正是把平台细节挤出业务模块。
 *
 * Rust 侧再次校验 loopback 与固定端点：前端的归一化是可用性，主进程的校验
 * 才是安全边界（WebView 被注入也拿不到请求任意 URL 的能力）。
 */

export type PetInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const FAILURE_KINDS: readonly PetHttpFailureKind[] = [
  "timeout", "connection", "aborted", "too_large", "blocked",
];

function isFailureKind(value: unknown): value is PetHttpFailureKind {
  return typeof value === "string" && (FAILURE_KINDS as readonly string[]).includes(value);
}

/**
 * 把命令层的失败翻译回端口语义。
 *
 * 认不出来的失败一律记为 `connection`：它是唯一「确定没送到」的分类，
 * 宁可多判一次失败，也不把可能已送达的请求当超时后重发。
 */
function toFailure(error: unknown): PetHttpFailure {
  if (error instanceof PetHttpFailure) return error;
  if (isFailureKind(error)) return new PetHttpFailure(error);
  if (typeof error === "object" && error !== null) {
    const kind = (error as { kind?: unknown }).kind;
    if (isFailureKind(kind)) return new PetHttpFailure(kind);
  }
  return new PetHttpFailure("connection");
}

export function createTauriPetHttpPort(invoke: PetInvoke): PetHttpPort {
  return {
    async send(request: PetHttpRequest): Promise<PetHttpResponse> {
      // 取消信号在 TS 侧生效：Rust 请求有自己的 1500ms 硬超时，不会悬挂。
      if (request.signal?.aborted) throw new PetHttpFailure("aborted");
      let base: string;
      try {
        base = assertLoopbackBase(request.base);
      } catch {
        // 端口语义上这是「被拦住了」，不是编程异常：调用方据此判 failed/unsupported。
        throw new PetHttpFailure("blocked");
      }
      let raw: unknown;
      try {
        raw = await invoke("desktop_pet_http_request", {
          base,
          endpoint: request.endpoint,
          body: request.body ?? null,
          timeoutMs: request.timeoutMs,
          // 凭据原样转交；Rust 侧只对 shutdown 端点使用它。
          bearerToken: request.bearerToken ?? null,
        });
      } catch (error) {
        throw toFailure(error);
      }
      if (request.signal?.aborted) throw new PetHttpFailure("aborted");
      const parsed = raw as { status?: unknown; body?: unknown } | null;
      const status = parsed?.status;
      if (typeof status !== "number" || !Number.isInteger(status)) {
        throw new PetHttpFailure("connection");
      }
      return {
        status,
        bodyText: typeof parsed?.body === "string" ? parsed.body : "",
      };
    },
  };
}
