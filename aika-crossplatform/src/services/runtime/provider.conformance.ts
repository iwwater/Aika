import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeProvider, RuntimeGenerateInput, ProviderStreamEvent } from "./companionRuntime";

export interface ProviderHarness {
  name: string;
  create(scenario: "stream" | "error" | "hanging"): {
    subject: RuntimeProvider;
    input: RuntimeGenerateInput;
    requests(): number;
    aborted(): boolean;
    dispose(): void;
  };
}

export function runProviderConformance(harness: ProviderHarness) {
  describe(`RuntimeProvider contract: ${harness.name}`, () => {
    let fixture: ReturnType<ProviderHarness["create"]>;
    afterEach(() => fixture?.dispose());
    it("按顺序交付累计增量与唯一终包", async () => {
      fixture = harness.create("stream");
      const events: ProviderStreamEvent[] = [];
      for await (const event of fixture.subject.generate(fixture.input)) events.push(event);
      const deltas = events.filter((event) => event.type === "delta").map((event) => event.text);
      expect(deltas[0]).toBe("こん");
      expect(deltas[deltas.length - 1]).toBe("こんにちは");
      expect(deltas.every((text, i) => i === 0 || text.startsWith(deltas[i - 1]))).toBe(true);
      expect(events.filter((event) => event.type === "reply")).toHaveLength(1);
      expect(events[events.length - 1]).toMatchObject({ type: "reply", reply: { schemaVersion: 1, replyText: "こんにちは", translation: "你好" } });
      expect(fixture.requests()).toBe(1);
    });
    it("网络失败统一错误码且无伪造终包", async () => {
      fixture = harness.create("error");
      const events: ProviderStreamEvent[] = [];
      for await (const event of fixture.subject.generate(fixture.input)) events.push(event);
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "PROVIDER_FAILED", retryable: true })]);
    });
    it("在途取消唤醒迭代器并中止底层请求", async () => {
      fixture = harness.create("hanging");
      const controller = new AbortController();
      const iterator = fixture.subject.generate({ ...fixture.input, signal: controller.signal })[Symbol.asyncIterator]();
      const next = iterator.next();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(fixture.requests()).toBe(1);
      controller.abort();
      await expect(next).resolves.toMatchObject({ done: true });
      expect(fixture.aborted()).toBe(true);
    });
    it("预先取消不发请求", async () => {
      fixture = harness.create("stream");
      const controller = new AbortController();
      controller.abort();
      const events = [];
      for await (const event of fixture.subject.generate({ ...fixture.input, signal: controller.signal })) events.push(event);
      expect(events).toEqual([]);
      expect(fixture.requests()).toBe(0);
    });
    it("消费者提前 return 取消底层流", async () => {
      fixture = harness.create("stream");
      for await (const event of fixture.subject.generate(fixture.input)) {
        expect(event.type).toBe("delta");
        break;
      }
      expect(fixture.aborted()).toBe(true);
    });
  });
}
