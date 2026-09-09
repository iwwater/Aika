import { describe, expect, it, vi } from "vitest";
import { createLocalStorage } from "./localStorageStorage";

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}

describe("browser storage compatibility", () => {
  it("旧 localStorage 消息没有 S1 字段时仍可读写", async () => {
    installLocalStorage();
    const storage = createLocalStorage();
    await storage.appendMessage({
      id: "legacy",
      role: "assistant",
      content: "旧浏览器消息",
      createdAt: 1,
      time: "00:00",
    });

    const messages = await storage.listMessages(20);
    expect(messages).toEqual([expect.objectContaining({ id: "legacy", content: "旧浏览器消息" })]);
    expect(messages[0].turnId).toBeUndefined();
    expect(messages[0].completion).toBeUndefined();
    expect(messages[0].playbackStatus).toBeUndefined();
  });
});
