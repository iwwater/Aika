import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../domain/conversation";
import type { ReplyEnvelopeV1 } from "../../domain/companion";
import { DEFAULT_MODE_CONFIG } from "../../domain/soul";
import { LOCAL_CONVERSATION_SCOPE, type ConversationScopeV1 } from "../../domain/identity";
import type { AikaStorage } from "../storage/contracts";
import { openMemorySqlite } from "../storage/nodeSqlite.harness";
import { createSqliteStorage } from "../storage/sqliteStorage";
import { createScopedRuntimeStorage } from "./scopedStorage";
import {
  createCompanionRuntime, MAX_WAITING_TURNS,
  type CompanionRuntime, type RuntimeGenerateInput, type RuntimeProvider,
} from "./companionRuntime";

/**
 * RT-02-B/C/E：真实生产 Runtime + 真实 SQLite 存储的两主体 scope 隔离。
 * 不用 fake router：隔离由 production 的 scoped storage 视图 + Runtime 的
 * 单生成槽排队保证，测试只替换 Provider（外部依赖）。
 */

const SCOPE_A: ConversationScopeV1 = { conversationId: "conv-A", principalId: "ext-A" };
const SCOPE_B: ConversationScopeV1 = { conversationId: "conv-B", principalId: "ext-B" };

function envelope(replyText: string): ReplyEnvelopeV1 {
  return {
    schemaVersion: 1,
    mood: "neutral",
    replyText,
    translation: replyText,
    memoryCandidates: [],
    actions: [],
  };
}

function userMessage(text: string, createdAt = Date.now()): ChatMessage {
  return {
    id: `msg-${text}-${createdAt}`,
    role: "user",
    content: text,
    createdAt,
    time: "12:00",
  };
}

interface Seen {
  query: string;
  history: string[];
  summary: string | null;
}

/** 每一轮都挂在门闩上：测试用 release() 精确放行一轮。 */
function makeGatedProvider(onSeen: (input: RuntimeGenerateInput) => void): {
  provider: RuntimeProvider;
  release(): void;
} {
  const waiters: Array<() => void> = [];
  return {
    provider: {
      async *generate(input) {
        onSeen(input);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
        yield { type: "reply" as const, reply: envelope(`回复-${input.context.query}`) };
      },
    },
    release: () => {
      waiters.shift()?.();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function makeFixture(): Promise<{
  runtime: CompanionRuntime;
  seen: Seen[];
  release(): void;
  storage: AikaStorage;
  dispose(): Promise<void>;
}> {
  const { executor } = openMemorySqlite();
  const storage = await createSqliteStorage(executor);
  const seen: Seen[] = [];
  const { provider, release } = makeGatedProvider((input) => {
    seen.push({
      query: input.context.query,
      history: input.context.recentConversation.map((turn) => turn.text),
      summary: input.context.summary,
    });
  });
  const runtime = createCompanionRuntime({
    provider,
    storage,
    createScopeView: (scope) => createScopedRuntimeStorage(storage, scope),
  });
  return {
    runtime,
    seen,
    release,
    storage,
    dispose: async () => runtime.dispose(),
  };
}

beforeEach(() => {
  process.env.TZ = "UTC";
});

describe("RT-02 身份绑定与会话隔离（生产 Runtime + SQLite）", () => {
  it("历史零串线：conv-B 的轮看不到 conv-A 刚说过的话（RT-02-B/E）", async () => {
    const fixture = await makeFixture();
    try {
      const a = fixture.runtime.submit({ text: "A的秘密", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_A });
      await flush();
      fixture.release();
      await a.done;

      const b = fixture.runtime.submit({ text: "B的问题", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_B });
      await flush();
      fixture.release();
      await b.done;

      const bRun = fixture.seen[fixture.seen.length - 1];
      expect(bRun.query).toBe("B的问题");
      expect(bRun.history).not.toContain("A的秘密");
      expect(bRun.history).not.toContain("回复-A的秘密");

      const a2 = fixture.runtime.submit({ text: "A追问", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_A });
      await flush();
      fixture.release();
      await a2.done;
      const aRun = fixture.seen[fixture.seen.length - 1];
      expect(aRun.history).toContain("A的秘密");
      expect(aRun.history).not.toContain("B的问题");
    } finally {
      await fixture.dispose();
    }
  });

  it("摘要零串线：scope 之外保存的摘要不进上下文（RT-02-B/E）", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.storage.saveSummary({
        content: "conv-A 的摘要：用户喜欢傍晚散步",
        coversUntil: Date.now(),
        createdAt: Date.now(),
        conversationId: "conv-A",
      });

      const b = fixture.runtime.submit({ text: "B想知道点什么", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_B });
      await flush();
      fixture.release();
      await b.done;
      expect(fixture.seen[fixture.seen.length - 1].summary).toBeNull();

      const a = fixture.runtime.submit({ text: "A继续聊", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_A });
      await flush();
      fixture.release();
      await a.done;
      expect(fixture.seen[fixture.seen.length - 1].summary).toContain("conv-A 的摘要");
    } finally {
      await fixture.dispose();
    }
  });

  it("跨会话不取消别人的轮：A 在跑时 B 提交，两轮都完整结束且存储各归各（RT-02-C/E）", async () => {
    const fixture = await makeFixture();
    try {
      const a = fixture.runtime.submit({ text: "A1", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_A });
      await flush();
      const b = fixture.runtime.submit({ text: "B1", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_B });
      await flush();

      // A 在跑（还没放行），B 排队：B 的提交不能取消 A。
      expect(fixture.seen.length).toBe(1);

      fixture.release();
      expect((await a.done).state).toBe("completed");
      // B 由 A 的结算拉起开跑：先 flush 让它走到门闩，再放行。
      await flush();
      fixture.release();
      expect((await b.done).state).toBe("completed");

      const aMessages = await fixture.storage.listMessages(50, { conversationId: "conv-A" });
      const bMessages = await fixture.storage.listMessages(50, { conversationId: "conv-B" });
      expect(aMessages.some((m) => m.content.includes("A1"))).toBe(true);
      expect(bMessages.some((m) => m.content.includes("B1"))).toBe(true);
      expect(aMessages.some((m) => m.content.includes("B1"))).toBe(false);
      expect(bMessages.some((m) => m.content.includes("A1"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it("同 conversation 保持旧语义：新提交取消旧轮（RT-02-C）", async () => {
    const fixture = await makeFixture();
    try {
      const first = fixture.runtime.submit({ text: "A-旧", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_A });
      await flush();
      const second = fixture.runtime.submit({ text: "A-新", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_A });

      expect((await first.done).state).toBe("cancelled");

      // 先放行旧轮那个悬挂的 Provider 等待（它已被取消），再放行新轮。
      fixture.release();
      await flush();
      fixture.release();
      expect((await second.done).state).toBe("completed");

      // 旧轮的正文不落库为完整历史；新轮完整落库。
      const aMessages = await fixture.storage.listMessages(50, { conversationId: "conv-A" });
      expect(aMessages.some((m) => m.content === "A-新")).toBe(true);
      expect(aMessages.some((m) => m.content === "A-旧")).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("cancel 校验归属：带别的 conversation 的取消请求是 no-op（RT-02-C/E）", async () => {
    const fixture = await makeFixture();
    try {
      const a = fixture.runtime.submit({ text: "A-不该被取消", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_A });
      await flush();
      fixture.runtime.cancel(a.turnId, { conversationId: "conv-B" });
      fixture.release();
      expect((await a.done).state).toBe("completed");

      const b = fixture.runtime.submit({ text: "B-要取消", source: "text", mode: DEFAULT_MODE_CONFIG, conversation: SCOPE_B });
      await flush();
      fixture.runtime.cancel(b.turnId, { conversationId: "conv-B" });
      expect((await b.done).state).toBe("cancelled");
    } finally {
      await fixture.dispose();
    }
  });

  it("旧数据归属 legacy 本地：只有 local scope 读得到，外部主体读不到（RT-02-D/E）", async () => {
    const fixture = await makeFixture();
    try {
      // 直接写入旧式消息（无 conversationId 字段 = 旧版本数据）。
      await fixture.storage.appendMessage(userMessage("旧本地历史"));

      const localMessages = await fixture.storage.listMessages(50, { conversationId: LOCAL_CONVERSATION_SCOPE.conversationId });
      expect(localMessages.some((m) => m.content === "旧本地历史")).toBe(true);

      const extMessages = await fixture.storage.listMessages(50, { conversationId: "conv-A" });
      expect(extMessages.some((m) => m.content === "旧本地历史")).toBe(false);

      // 新写入带 conversationId 的消息不影响 legacy 归属判断。
      await fixture.storage.appendMessage({ ...userMessage("新外部消息"), conversationId: "conv-A" });
      const localAfter = await fixture.storage.listMessages(50, { conversationId: LOCAL_CONVERSATION_SCOPE.conversationId });
      expect(localAfter.some((m) => m.content === "新外部消息")).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it("关系信号（时间戳）也按 scope 隔离（RT-02-E）", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.storage.appendMessage({ ...userMessage("A的时间线"), conversationId: "conv-A", createdAt: Date.UTC(2026, 0, 5) });
      expect(await fixture.storage.listMessageTimestamps({ conversationId: "conv-B" })).toEqual([]);
      expect(await fixture.storage.listMessageTimestamps({ conversationId: "conv-A" })).toEqual([Date.UTC(2026, 0, 5)]);
    } finally {
      await fixture.dispose();
    }
  });

  it(`有界队列：超过 1 运行 + ${MAX_WAITING_TURNS} 等待显式失败（SESSION_QUEUE_FULL），已排队的轮一个不少（RT-02-C）`, async () => {
    const fixture = await makeFixture();
    try {
      const handles: { done: Promise<{ state: string; errorCode?: string }> }[] = [];
      const conversationIds = ["conv-A", "conv-B", "conv-C", "conv-D", "conv-E", "conv-F", "conv-G", "conv-H", "conv-I", "conv-J"];
      for (const conversationId of conversationIds) {
        const handle = fixture.runtime.submit({
          text: `msg-${conversationId}`,
          source: "text",
          mode: DEFAULT_MODE_CONFIG,
          conversation: { conversationId, principalId: `ext-${conversationId}` },
        });
        handles.push(handle);
      }

      // 第 11 个会话：1 运行 + 8 等待已满 → 显式失败。
      const overflow = fixture.runtime.submit({
        text: "overflow",
        source: "text",
        mode: DEFAULT_MODE_CONFIG,
        conversation: { conversationId: "conv-K", principalId: "ext-K" },
      });
      const overflowSettlement = await overflow.done;
      expect(overflowSettlement.state).toBe("failed");
      expect(overflowSettlement.errorCode).toBe("SESSION_QUEUE_FULL");

      // 逐轮放行：前 9 个会话（1 运行 + 8 等待）全部完成。
      for (let index = 0; index < 9; index += 1) {
        await flush();
        fixture.release();
      }
      const results = await Promise.all(handles.map((handle) => handle.done));
      expect(results.filter((result) => result.state === "completed")).toHaveLength(9);
    } finally {
      await fixture.dispose();
    }
  });
});
