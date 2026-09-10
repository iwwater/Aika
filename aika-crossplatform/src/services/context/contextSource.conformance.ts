import { describe, expect, it } from "vitest";
import type { ContextSource, ContextSourceInput } from "./contextAssembler";
import type { ContextAssemblyResult } from "../../domain/context";

export interface ContextSourceHarness {
  name: string;
  create(scenario: "ok" | "error" | "timeout"): {
    subject: ContextSource;
    input: ContextSourceInput;
    assemble(): Promise<ContextAssemblyResult>;
    fireTimeout(): void;
    resolveLate(): void;
  };
}
export function runContextSourceConformance(harness: ContextSourceHarness) {
  describe(`ContextSource contract: ${harness.name}`, () => {
    it("来源返回可展示的结构片段，进入指定上下文区", async () => {
      const fixture = harness.create("ok");
      const snippets = await fixture.subject.load(fixture.input);
      expect(snippets).toHaveLength(1);
      expect(snippets[0]).toMatchObject({ content: "喜欢咖啡", source: "memory", precision: "confirmed" });
      const assembled = await fixture.assemble();
      expect(assembled.context.memories[0].content).toBe("喜欢咖啡");
      expect(assembled.droppedSources).toEqual([]);
    });
    it("来源抛错降级为空片段并记录 error，错误不进入正文", async () => {
      const fixture = harness.create("error");
      await expect(fixture.subject.load(fixture.input)).rejects.toThrow("fixture failure");
      const assembled = await fixture.assemble();
      expect(assembled.context.memories).toEqual([]);
      expect(assembled.droppedSources).toEqual([expect.objectContaining({ source: fixture.subject.id, reason: "error" })]);
      expect(JSON.stringify(assembled.context)).not.toContain("fixture failure");
    });
    it("超时降级并丢弃迟到片段，语义不因来源实现改变", async () => {
      const fixture = harness.create("timeout");
      const pending = fixture.assemble();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      fixture.fireTimeout();
      const assembled = await pending;
      expect(assembled.context.memories).toEqual([]);
      expect(assembled.droppedSources).toEqual([expect.objectContaining({ source: fixture.subject.id, reason: "timeout" })]);
      fixture.resolveLate();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(assembled.context.memories).toEqual([]);
    });
  });
}
