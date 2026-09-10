import { browserBackend, type KeyValueBackend } from "../memory/localMemoryStore";

/**
 * API Key 保险库。
 *
 * 桌面版走 Rust 侧的 Windows DPAPI（见 src-tauri/src/secret_store.rs），
 * 密文绑定当前 Windows 账户，和聊天记录、记忆分开存放。
 *
 * 浏览器里跑 `npm run dev` 时没有 DPAPI，退回明文 localStorage，
 * 并把 `secure` 置为 false——设置页据此显示明确警告，不假装安全。
 *
 * CORE-02 之前这里是一个对象内部做 `inTauri()` 分叉：那不是「两个实现」，
 * 是「一个实现两条路」，谁都替换不了它，也没法各自验证。现在拆成两个工厂，
 * 由宿主插件决定装哪个；平台判断只剩组合根一处。
 */

const INSECURE_KEY = "aika.insecure.secrets.v1";

export interface SecretStore {
  /** true 表示落在加密保险库里；false 表示当前是开发期明文回退。 */
  secure(): Promise<boolean>;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** 每个供应商一把 Key，切换平台不会互相覆盖。对齐 Android 的 SecretStore.providerKeyName。 */
export function providerKeyName(providerId: string): string {
  return `provider.${providerId}.apiKey`;
}

export interface TauriSecretPorts {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** 桌面实现：密钥进 DPAPI。invoke 注入是为了能在没有 Tauri 的环境里验证行为。 */
export function createDesktopSecretStore(ports: TauriSecretPorts): SecretStore {
  return {
    async secure() {
      try {
        return await ports.invoke<boolean>("secret_available");
      } catch {
        // 保险库探测失败就如实说不安全，不猜。
        return false;
      }
    },
    async get(name) {
      return (await ports.invoke<string | null>("secret_get", { name })) ?? null;
    },
    async set(name, value) {
      await ports.invoke("secret_set", { name, value });
    },
    async remove(name) {
      await ports.invoke("secret_delete", { name });
    },
  };
}

/** 开发期明文回退：`secure()` 永远 false，界面据此显示警告。 */
export function createInsecureSecretStore(
  backend: KeyValueBackend = browserBackend(),
): SecretStore {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(backend.get(INSECURE_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = (entries: Record<string, string>) => {
    backend.set(INSECURE_KEY, JSON.stringify(entries));
  };

  return {
    async secure() {
      return false;
    },
    async get(name) {
      return read()[name] ?? null;
    },
    async set(name, value) {
      const entries = read();
      if (value) entries[name] = value;
      else delete entries[name];
      write(entries);
    },
    async remove(name) {
      const entries = read();
      delete entries[name];
      write(entries);
    },
  };
}

/**
 * 过渡转发。
 *
 * Presenter / Hook 都已改走 `SecretStoreToken` 注入；**仍在用它的只剩
 * `useRemoteAccess`**（手机端访问口令的读写）。因此 CORE-06 没有删掉这一段——
 * 删除的前提是「全仓已无调用方」，而它还有。等 Remote 插件化之后一并处理。
 *
 * 默认值是明文实现，不再靠嗅探平台得来；组合根启动时把宿主提供的那个装上。
 */
let installed: SecretStore | null = null;

/** @deprecated 过渡用，改从注册表取 SecretStoreToken；CORE-06 删除。 */
export const secretStore: SecretStore = {
  secure: () => (installed ?? defaultStore()).secure(),
  get: (name) => (installed ?? defaultStore()).get(name),
  set: (name, value) => (installed ?? defaultStore()).set(name, value),
  remove: (name) => (installed ?? defaultStore()).remove(name),
};

let fallbackStore: SecretStore | null = null;
function defaultStore(): SecretStore {
  fallbackStore ??= createInsecureSecretStore();
  return fallbackStore;
}

export function installSecretStore(store: SecretStore): void {
  installed = store;
}

/** 测试用：把过渡槽恢复到未安装状态。 */
export function resetInstalledSecretStore(): void {
  installed = null;
  fallbackStore = null;
}
