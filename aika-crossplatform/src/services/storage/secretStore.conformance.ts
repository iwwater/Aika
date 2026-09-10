import { describe, expect, it } from "vitest";
import type { SecretStore } from "./secretStore";
import type { PortHarness } from "./storage.conformance";

/**
 * SecretStore 的端口一致性用例包。
 *
 * CORE-02 之前这个端口只有「一个实现两条路」——分叉写在对象内部，谁都替换不了
 * 它，也没法各自验证。拆成两个实现之后，这份用例包才有两个被测对象。
 *
 * `secure()` 不是能力而是**自述**：桌面实现说 true，明文回退说 false，两者都
 * 正确。所以它由 harness 声明期望值，而不是在用例里写死。
 *
 * 契约未定义的部分这里不断言，免得把某个实现的偶然行为固化成契约：
 * - `set(name, "")` 的语义（删除还是存空串）未定义。
 * - 并发写同一个 name 的最终值未定义。
 */

export interface SecretHarness extends PortHarness<SecretStore> {
  /** 这个实现是否声称密钥落在加密保险库里。 */
  expectedSecure: boolean;
}

export function runSecretStoreConformance(harness: SecretHarness): void {
  describe(`SecretStore 契约 · ${harness.name}`, () => {
    async function withStore<T>(run: (store: SecretStore) => Promise<T>): Promise<T> {
      const { subject, dispose } = await harness.create();
      try {
        return await run(subject);
      } finally {
        await dispose();
      }
    }

    it("secure() 如实自述，且不抛错", async () => {
      await withStore(async (store) => {
        expect(await store.secure()).toBe(harness.expectedSecure);
      });
    });

    it("没存过的名字返回 null，不是 undefined 也不是空串", async () => {
      await withStore(async (store) => {
        expect(await store.get("never.stored")).toBeNull();
      });
    });

    it("存了就读得到，覆盖写取最后一次", async () => {
      await withStore(async (store) => {
        await store.set("provider.openai.apiKey", "sk-1");
        expect(await store.get("provider.openai.apiKey")).toBe("sk-1");

        await store.set("provider.openai.apiKey", "sk-2");
        expect(await store.get("provider.openai.apiKey")).toBe("sk-2");
      });
    });

    it("不同名字互不干扰：切供应商不会互相覆盖", async () => {
      await withStore(async (store) => {
        await store.set("provider.openai.apiKey", "sk-openai");
        await store.set("provider.anthropic.apiKey", "sk-anthropic");

        expect(await store.get("provider.openai.apiKey")).toBe("sk-openai");
        expect(await store.get("provider.anthropic.apiKey")).toBe("sk-anthropic");
      });
    });

    it("删掉之后读不到，且不影响别的名字", async () => {
      await withStore(async (store) => {
        await store.set("a", "1");
        await store.set("b", "2");

        await store.remove("a");

        expect(await store.get("a")).toBeNull();
        expect(await store.get("b")).toBe("2");
      });
    });

    it("删一个不存在的名字不抛错", async () => {
      await withStore(async (store) => {
        await expect(store.remove("never.stored")).resolves.toBeUndefined();
      });
    });
  });
}
