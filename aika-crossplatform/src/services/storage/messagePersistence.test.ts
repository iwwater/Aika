import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../domain/conversation";
import { createSerializedMessagePersister } from "./messagePersistence";

function message(content: string, createdAt: number): ChatMessage {
  return { id: "same-id", role: "assistant", content, createdAt, time: "00:00" };
}

describe("createSerializedMessagePersister", () => {
  it("异步更新按同一 ID 排队，complete/interrupted 不会倒序覆盖且时间戳只计一次", async () => {
    const writes: string[] = [];
    const timestamps: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let call = 0;
    const storage = {
      appendMessage: async (item: ChatMessage) => {
        call += 1;
        if (call === 1) await firstGate;
        writes.push(item.content);
      },
    };
    const persister = createSerializedMessagePersister(
      () => storage,
      new Set<string>(),
      (createdAt) => timestamps.push(createdAt),
    );

    const first = persister(message("complete", 1));
    const second = persister({ ...message("interrupted", 1), completion: "interrupted" });
    await Promise.resolve();
    expect(writes).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(writes).toEqual(["complete", "interrupted"]);
    expect(timestamps).toEqual([1]);
  });
});
