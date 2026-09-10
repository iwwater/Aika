import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 和 Rust 侧 HTTP 服务之间的桥。
 *
 * 手机的每一次请求都由 Rust 转成一个事件送到这里，桌面端跑完再把结果交回去
 * （`src-tauri/src/remote.rs`）。这样业务逻辑只有一份，都在桌面端：
 * 提示词、模型调用、落库、记忆抽取，Rust 一件都不重复实现。
 *
 * CORE-02 之前，这里靠 `inTauri()` 在三个函数里各判一次「有没有 Rust 侧」。
 * 现在改为：**没有这项能力的宿主根本不注册 RemoteHostToken**，消费方按
 * optional + tryResolve 降级。缺失是常态，不是异常。
 */

export interface RemoteInfo {
  port: number;
  /** 手机上直接打开的地址，token 带在查询串里。 */
  url: string;
  /** 局域网地址。拿不到时是 127.0.0.1，那种情况下手机连不上。 */
  host: string;
}

export interface RemoteRequest {
  id: string;
  /** "messages" 取最近的对话，"send" 发一轮。 */
  kind: string;
  body: string;
}

export interface RemoteHost {
  start(port: number, token: string): Promise<RemoteInfo>;
  stop(): Promise<void>;
  status(): Promise<RemoteInfo | null>;
  /** 把这次请求的结果交回 Rust。晚了也要交：找不到 id 时那边会安静丢掉。 */
  respond(id: string, payload: unknown): Promise<void>;
  /**
   * 开始接手机的请求。
   *
   * handler 抛错时回一条带 error 的 JSON，而不是干脆不回——
   * 不回的话手机要一直等到 Rust 那边的三分钟超时才知道出事了。
   */
  listen(handler: (request: RemoteRequest) => Promise<unknown>): Promise<UnlistenFn>;
}

export function createTauriRemoteHost(): RemoteHost {
  const respond = async (id: string, payload: unknown): Promise<void> => {
    await invoke("remote_respond", { answer: { id, payload: JSON.stringify(payload) } });
  };

  return {
    start: (port, token) => invoke<RemoteInfo>("remote_start", { port, token }),
    stop: async () => {
      await invoke("remote_stop");
    },
    async status() {
      try {
        return await invoke<RemoteInfo | null>("remote_status");
      } catch {
        return null;
      }
    },
    respond,
    listen(handler) {
      return listen<RemoteRequest>("remote://request", (event) => {
        void (async () => {
          try {
            await respond(event.payload.id, await handler(event.payload));
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            await respond(event.payload.id, { error: detail }).catch(() => undefined);
          }
        })();
      });
    },
  };
}

/**
 * 过渡转发。useRemoteAccess 还在用这些具名导出，CORE-06 删除本段。
 * 未安装即「这个宿主没有远程能力」——如实返回，不假装。
 */
let installed: RemoteHost | null = null;

export function installRemoteHost(host: RemoteHost): void {
  installed = host;
}

/** 测试用：把过渡槽恢复到未安装状态。 */
export function resetInstalledRemoteHost(): void {
  installed = null;
}

/** 浏览器开发模式下没有 Rust 侧，手机端整块功能不可用——如实返回，不假装。 */
export function remoteAvailable(): boolean {
  return installed !== null;
}

export async function startRemote(port: number, token: string): Promise<RemoteInfo> {
  if (!installed) throw new Error("remote host is not available on this platform");
  return installed.start(port, token);
}

export async function stopRemote(): Promise<void> {
  await installed?.stop();
}

export async function remoteStatus(): Promise<RemoteInfo | null> {
  return (await installed?.status()) ?? null;
}

export async function respondRemote(id: string, payload: unknown): Promise<void> {
  await installed?.respond(id, payload);
}

export function listenRemoteRequests(
  handler: (request: RemoteRequest) => Promise<unknown>,
): Promise<UnlistenFn> {
  if (!installed) return Promise.resolve(() => undefined);
  return installed.listen(handler);
}
