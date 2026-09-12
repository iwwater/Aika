import { describe, expect, it } from "vitest";
import { LOCAL_PRINCIPAL_ID } from "../../domain/identity";
import { createMemorySource } from "./memorySource";

/** RT-02-D：个人记忆的读取授权门。 */
describe("memorySource 的 principal 授权门（RT-02-D）", () => {
  it("外部/未知 principal 一个片段都不给；legacy 与本地主体照常", async () => {
    // 用最小假仓储验证授权门本身，不走真实检索。
    const hits = [{
      record: { id: "m1", type: "偏好" as const, content: "喜欢傍晚散步", status: "confirmed" as const, createdAt: 1, updatedAt: 1, confidence: 1, sourceKind: "messages" as const, sourceMessageIds: [] },
      score: 1,
      temporalStatus: "current" as const,
    }];
    const repository = {
      retrieve: async () => hits,
    } as never;
    const source = createMemorySource(repository);

    const load = (principalId?: string) =>
      source.load({ query: "散步", now: 0, signal: new AbortController().signal, scope: { principalId } });

    // legacy 本地链路（未声明 principal）与显式本地主体：可读。
    expect((await load(undefined)).length).toBe(1);
    expect((await load(LOCAL_PRINCIPAL_ID)).length).toBe(1);

    // 绑定的外部主体：这≠本地用户的个人数据授权。未绑定的外部与 unknown 同拒。
    expect(await load("ext-abc")).toEqual([]);
    expect(await load("unknown")).toEqual([]);
    expect(await load("")).toEqual([]);
  });
});
