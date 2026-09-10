import { describe, expect, it } from "vitest";
import { runSecretStoreConformance } from "./secretStore.conformance";
import {
  createDesktopSecretStore, createInsecureSecretStore, type TauriSecretPorts,
} from "./secretStore";

/**
 * 两个 SecretStore 实现跑同一份用例包。
 *
 * 桌面实现的 invoke 是注入的，所以它的**生产代码**能在没有 Tauri 的环境里跑完
 * 整条契约；这里的假 invoke 只替代 Rust 侧的 DPAPI 存取，不替代被测逻辑。
 */

function memoryBackend() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value),
  };
}

/** 假 DPAPI：只做存取，行为对齐 src-tauri/src/secret_store.rs 的契约。 */
function fakeVault(available = true): TauriSecretPorts {
  const entries = new Map<string, string>();
  return {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const name = String(args?.name ?? "");
      switch (command) {
        case "secret_available":
          return available as T;
        case "secret_get":
          return (entries.get(name) ?? null) as T;
        case "secret_set":
          entries.set(name, String(args?.value ?? ""));
          return undefined as T;
        case "secret_delete":
          entries.delete(name);
          return undefined as T;
        default:
          throw new Error(`unexpected command ${command}`);
      }
    },
  };
}

runSecretStoreConformance({
  name: "insecureSecretStore",
  expectedSecure: false,
  async create() {
    return { subject: createInsecureSecretStore(memoryBackend()), async dispose() {} };
  },
});

runSecretStoreConformance({
  name: "desktopSecretStore(fake vault)",
  expectedSecure: true,
  async create() {
    return { subject: createDesktopSecretStore(fakeVault()), async dispose() {} };
  },
});

describe("SecretStore 实现特有行为", () => {
  it("保险库探测失败时如实说不安全，不猜也不抛", async () => {
    const store = createDesktopSecretStore({
      invoke: async () => {
        throw new Error("no vault");
      },
    });

    expect(await store.secure()).toBe(false);
  });

  it("保险库存在但被禁用时 secure() 为 false", async () => {
    expect(await createDesktopSecretStore(fakeVault(false)).secure()).toBe(false);
  });
});
