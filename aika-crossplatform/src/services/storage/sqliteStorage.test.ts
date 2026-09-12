import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../domain/conversation";

const sqliteMock = vi.hoisted(() => {
  const altered = new Set<string>();
  const rows = [{
    id: "old-1",
    role: "assistant",
    source: "text",
    content: "旧消息",
    japanese_text: "旧消息",
    chinese_translation: null,
    created_at: 1,
    is_error: 0,
    sticker: null,
    mood: null,
    turn_id: null,
    completion_status: null,
    playback_status: null,
  }];
  const execute = vi.fn(async (statement: string) => {
    if (statement.startsWith("ALTER TABLE")) {
      if (altered.has(statement)) throw new Error("duplicate column");
      altered.add(statement);
    }
  });
  const select = vi.fn(async (statement: string) => (
    statement.startsWith("SELECT * FROM messages") ? rows : []
  ));
  const load = vi.fn(async () => ({ execute, select }));
  return { execute, select, load };
});

vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: sqliteMock.load } }));

import { createSqliteStorage } from "./sqliteStorage";

describe("SQLite voice/message schema compatibility", () => {
  it("旧表可幂等加列，新消息写入 turn 与播放状态", async () => {
    const first = await createSqliteStorage();
    const second = await createSqliteStorage();

    const alterCalls = sqliteMock.execute.mock.calls.filter(([statement]) => statement.startsWith("ALTER TABLE"));
    // 8 条加列迁移 × 2 次开库；CORE-03 增加 runtime_turn_id 后由 10 变 12，
    // RT-02 增加 messages/summaries 的 conversation_id 后由 12 变 16。
    expect(alterCalls).toHaveLength(16);

    const old = await first.listMessages(20);
    expect(old[0]).toMatchObject({ id: "old-1", content: "旧消息" });
    expect(old[0].turnId).toBeUndefined();
    expect(old[0].completion).toBeUndefined();
    expect(old[0].playbackStatus).toBeUndefined();

    const message: ChatMessage = {
      id: "turn-1",
      role: "assistant",
      content: "回复",
      createdAt: 2,
      time: "00:00",
      source: "voice",
      turnId: 7,
      playbackStatus: "played",
    };
    await second.appendMessage(message);
    const insert = sqliteMock.execute.mock.calls[sqliteMock.execute.mock.calls.length - 1];
    expect(insert?.[0]).toContain("turn_id, completion_status, playback_status");
    const insertArguments = insert as unknown as [string, unknown[]];
    expect(insertArguments[1]).toEqual(expect.arrayContaining([7, "complete", "played"]));
  });
});
