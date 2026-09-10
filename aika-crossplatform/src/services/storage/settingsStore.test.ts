import { describe, expect, it, vi } from "vitest";
import { SETTING_KEYS } from "./contracts";
import { createSettingsStore } from "./settingsStore";

/**
 * 设置读写。
 *
 * 重点不是「能存能取」，而是**坏值不会被固化**：读到坏 JSON 回落默认值，
 * 并且绝不把修好的值写回去。写回去等于把一次偶然的坏数据变成正常数据，
 * 下次再也发现不了。
 */

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const setSetting = vi.fn(async (key: string, value: string) => void values.set(key, value));
  return {
    values,
    setSetting,
    storage: {
      getSetting: async (key: string) => values.get(key) ?? null,
      setSetting,
    },
  };
}

describe("SettingsStore", () => {
  it("原始值读写往返；没写过的键返回 null", async () => {
    const { storage } = fakeStorage();
    const settings = createSettingsStore(storage);

    expect(await settings.getRaw("never")).toBeNull();
    await settings.setRaw("k", "v");
    expect(await settings.getRaw("k")).toBe("v");
  });

  it("SETTING_KEYS 的每个键都能读写往返", async () => {
    const { storage } = fakeStorage();
    const settings = createSettingsStore(storage);

    for (const key of Object.values(SETTING_KEYS)) {
      await settings.setRaw(key, `值-${key}`);
      expect(await settings.getRaw(key)).toBe(`值-${key}`);
    }
  });

  it("坏 JSON 回落默认值，且不写回坏值", async () => {
    const { storage, setSetting } = fakeStorage({ broken: "{不是 json" });
    const fallback = { mode: "daily" };
    const settings = createSettingsStore(storage);

    expect(await settings.getJson("broken", fallback)).toBe(fallback);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("结构对不上也算坏值：normalize 抛错同样回落，同样不写回", async () => {
    const { storage, setSetting } = fakeStorage({ mode: '{"unexpected":true}' });
    const fallback = { mode: "daily" };
    const settings = createSettingsStore(storage);

    const value = await settings.getJson("mode", fallback, (raw) => {
      const parsed = raw as { mode?: unknown };
      if (typeof parsed.mode !== "string") throw new Error("unknown mode");
      return { mode: parsed.mode };
    });

    expect(value).toBe(fallback);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("回落时记一笔诊断，但不影响返回值", async () => {
    const { storage } = fakeStorage({ broken: "{不是 json" });
    const onFallback = vi.fn();
    const settings = createSettingsStore(storage, { onFallback });

    await settings.getJson("broken", { ok: true });

    expect(onFallback).toHaveBeenCalledWith("broken", "invalid json");
  });

  it("合法 JSON 正常解析并可回写", async () => {
    const { storage } = fakeStorage();
    const settings = createSettingsStore(storage);

    await settings.setJson("mode", { mode: "scenario", topic: "点咖啡" });

    expect(await settings.getJson("mode", { mode: "daily" })).toEqual({
      mode: "scenario",
      topic: "点咖啡",
    });
  });

  it("布尔只认 true/false 两个字面量，其余回落并记一笔", async () => {
    const { storage } = fakeStorage({ yes: "true", no: "false", junk: "1" });
    const onFallback = vi.fn();
    const settings = createSettingsStore(storage, { onFallback });

    expect(await settings.getBoolean("yes", false)).toBe(true);
    expect(await settings.getBoolean("no", true)).toBe(false);
    expect(await settings.getBoolean("junk", true)).toBe(true);
    expect(await settings.getBoolean("missing", false)).toBe(false);
    expect(onFallback).toHaveBeenCalledWith("junk", "not a boolean");
  });

  it("字符串缺失或空串都回落默认值", async () => {
    const { storage } = fakeStorage({ empty: "" });
    const settings = createSettingsStore(storage);

    expect(await settings.getString("empty", "默认")).toBe("默认");
    expect(await settings.getString("missing", "默认")).toBe("默认");
  });

  it("写入失败向上传播：模式保存不能乐观确认", async () => {
    const values = new Map<string, string>();
    const settings = createSettingsStore({
      getSetting: async (key) => values.get(key) ?? null,
      setSetting: async () => {
        throw new Error("quota exceeded");
      },
    });

    await expect(settings.setRaw("k", "v")).rejects.toThrow("quota exceeded");
  });
});
