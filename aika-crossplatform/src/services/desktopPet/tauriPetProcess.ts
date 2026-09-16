import type { PetInvoke } from "./tauriPetHttp";
import type { PetProcessHandle, PetProcessPort, PetProcessSpawnOptions } from "./processManager";

/**
 * 原生进程端口（PET-06）。
 *
 * 与 HTTP 端口同一个套路：`invoke` 由宿主装配层注入，本模块不 import
 * `@tauri-apps`。句柄是 `{ pid }` 的**不透明凭据**——它只对 Rust 侧的句柄表
 * 有意义，Rust 用 `unknown_process` 拒绝对不属于本次启动的 PID 做任何操作。
 *
 * 注意：这里没有"按名字停止"的接口，也没有传参数的位置。**接口形状本身就是
 * 安全边界**，不靠调用方自觉。
 */

export interface TauriPetProcessPortOptions {
  invoke: PetInvoke;
  stopTimeoutMs?: number;
}

function readPid(raw: unknown): number {
  const pid = (raw as { pid?: unknown } | null)?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("desktop pet process: 宿主返回了非法 pid");
  }
  return pid;
}

export function createTauriPetProcessPort(options: TauriPetProcessPortOptions): PetProcessPort {
  const { invoke } = options;

  return {
    async spawn(
      executablePath: string,
      options?: PetProcessSpawnOptions,
    ): Promise<PetProcessHandle> {
      // 路径已经过 `validatePetExecutable`；Rust 侧会再校验一次。凭据只在这一次
      // 启动里注入具名环境变量——没有任意参数或任意 env 的位置。
      const raw = await invoke("desktop_pet_process_spawn", {
        path: executablePath,
        ...(options?.exitToken ? { exitToken: options.exitToken } : {}),
        // 点击通道成对注入：缺一个就不传，Rust 侧也按「半套凭据不注入」处理。
        ...(options?.clickUrl && options?.clickToken
          ? { clickUrl: options.clickUrl, clickToken: options.clickToken }
          : {}),
      });
      return { pid: readPid(raw) };
    },

    /**
     * 反向点击通道的武装与撤销（MVP-12）。
     *
     * 凭据由 Rust 侧生成并保管，这里只负责在派生前后各调一次、不带任何参数：
     * 于是渲染进程里根本没有「让 Aiki 接受任意点击」的位置，而且只有主窗调得动
     * 这两个命令。
     */
    async armClickChannel(): Promise<{ url: string; token: string } | null> {
      const raw = (await invoke("pet_click_arm")) as { url?: unknown; token?: unknown } | null;
      const url = typeof raw?.url === "string" ? raw.url : "";
      const token = typeof raw?.token === "string" ? raw.token : "";
      return url && token ? { url, token } : null;
    },

    async disarmClickChannel(): Promise<void> {
      await invoke("pet_click_disarm");
    },

    async isAlive(handle: PetProcessHandle): Promise<boolean> {
      const pid = (handle as { pid: number }).pid;
      const raw = await invoke("desktop_pet_process_alive", { pid });
      return raw === true;
    },

    async exitInfo(handle: PetProcessHandle): Promise<{ exited: boolean; code: number | null }> {
      const pid = (handle as { pid: number }).pid;
      const raw = await invoke("desktop_pet_process_exit_status", { pid }) as
        | { exited?: unknown; code?: unknown }
        | null;
      const exited = raw?.exited === true;
      const code = typeof raw?.code === "number" ? raw.code : null;
      return { exited, code };
    },

    async stop(handle: PetProcessHandle): Promise<void> {
      const pid = (handle as { pid: number }).pid;
      await invoke("desktop_pet_process_stop", {
        pid,
        ...(options.stopTimeoutMs !== undefined ? { timeoutMs: options.stopTimeoutMs } : {}),
      });
    },
  };
}
