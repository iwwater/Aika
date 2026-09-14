import { describe, expect, it } from "vitest";
import { createFakeEnvironmentSource, createManualClock, fakeEventInput } from "./fakeEnvironment";
import { createEnvironmentMonitor } from "./monitor";
import {
  CONFIDENCE_WITHOUT_WORD_LEVEL,
  DEFAULT_KEYWORD_RULES,
  matchKeywords,
  normalizeWordConfidence,
} from "./keywordRules";
import {
  ENVIRONMENT_SCHEMA_VERSION,
  eventRuleId,
  normalizeEnvironmentEvent,
} from "../../domain/environment";

/**
 * MVP-04-A：明确规则 → 规范化 Observation。
 *
 * 全部走生产实现：词表匹配（`keywordRules`）、schema 规范化（`domain/environment`）、
 * 去重与拒绝（`monitor`）。不新造观察协议，也不在测试里重写一份规则。
 * 这里证明的是**观察层**；「观察变成一轮生成」在 MVP-04-C 的集成用例里。
 */

describe("MVP-04-A 规则命中 → 受控观察", () => {
  it("PENTAKILL / 胜利(defeat/victory) / build failed 这些明确规则都在词表里", () => {
    const ruleIds = new Set(DEFAULT_KEYWORD_RULES.map((rule) => rule.ruleId));
    for (const required of ["pentakill", "victory", "defeat", "failed", "error"]) {
      expect(ruleIds.has(required), required).toBe(true);
    }
  });

  it("常见画面文本都能命中对应规则（大小写与词边界无关匹配）", () => {
    for (const [text, ruleId] of [
      ["PENTAKILL!", "pentakill"],
      ["Victory", "victory"],
      ["DEFEAT", "defeat"],
      ["npm run build failed", "failed"],
      ["some error happened", "error"],
    ] as Array<[string, string]>) {
      const matches = matchKeywords(text, null);
      expect(matches.map((match) => match.ruleId), text).toContain(ruleId);
    }
  });

  it("没有词级证据时置信度是保守的 0.5，拿不到 0.8 那条线", () => {
    const withoutEvidence = matchKeywords("PENTAKILL", null);
    expect(withoutEvidence).toHaveLength(1);
    expect(withoutEvidence[0].confidence).toBe(CONFIDENCE_WITHOUT_WORD_LEVEL);
    // FE-22 的结算类阈值是 0.8：缺词级证据的命中过不了线，这是设计行为。
    expect(withoutEvidence[0].confidence).toBeLessThan(0.8);

    const withEvidence = matchKeywords("PENTAKILL", new Map([["pentakill", 0.93]]));
    expect(withEvidence[0].confidence).toBeCloseTo(0.93);
    expect(normalizeWordConfidence(88)).toBeCloseTo(0.88);
  });

  it("规范化后只留下受控字段：原文与标题进不来", () => {
    const result = normalizeEnvironmentEvent(
      {
        schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
        sourceId: "screen",
        eventId: "e1",
        hostEpoch: "epoch",
        timestamp: 1,
        timingPrecision: "measured",
        confidence: 0.93,
        payload: {
          kind: "screen_keyword",
          keyword: "failed",
          text: "SECRET-原文 build failed",
        },
      },
      { sourceId: "screen", receivedMonotonicMs: 42 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(eventRuleId(result.event.payload)).toBe("failed");
    // payload 只有 kind + 词表 ID 两个字段。
    expect(Object.keys(result.event.payload)).toEqual(["kind", "keyword"]);
    expect(JSON.stringify(result.event)).not.toContain("SECRET");
  });
});

describe("MVP-04-A 重复帧合并与拒绝边界（monitor 生产实现）", () => {
  async function runningMonitor(screen: ReturnType<typeof createFakeEnvironmentSource>, monitor: ReturnType<typeof createEnvironmentMonitor>) {
    const started = monitor.setSourceEnabled(screen.id, true);
    screen.resolveStart();
    await started;
  }

  it("同一屏同一规则的重复帧在去重窗口内只广播一次；窗口过后算新事件", async () => {
    const clock = createManualClock(0);
    const screen = createFakeEnvironmentSource({ id: "screen" });
    const monitor = createEnvironmentMonitor([screen], { clock, hostEpoch: "test-epoch" });
    const seen: string[] = [];
    monitor.subscribe((event) => seen.push(eventRuleId(event.payload) ?? "?"));
    await runningMonitor(screen, monitor);

    screen.emit(fakeEventInput({ payload: { kind: "game_event", event: "pentakill" }, sourceId: "screen" }));
    // 同一帧被识别两次（重复帧）：第二次被去重丢弃，不产生第二个观察。
    screen.emit(fakeEventInput({ payload: { kind: "game_event", event: "pentakill" }, sourceId: "screen" }));
    expect(seen).toEqual(["pentakill"]);
    expect(monitor.diagnostics().dedupeDropped).toBe(1);

    clock.advance(2100);
    screen.emit(fakeEventInput({ payload: { kind: "game_event", event: "pentakill" }, sourceId: "screen" }));
    expect(seen).toEqual(["pentakill", "pentakill"]);
  });

  it("置信度越界的观察在入口被拒；低置信度是合法事件但过不了策略阈值", async () => {
    const clock = createManualClock(0);
    const screen = createFakeEnvironmentSource({ id: "screen" });
    const monitor = createEnvironmentMonitor([screen], { clock, hostEpoch: "test-epoch" });
    const seen: unknown[] = [];
    monitor.subscribe((event) => seen.push(event));
    await runningMonitor(screen, monitor);

    // 1.4 不是「0..1 之外的近似」——拒绝，既不广播也不进 recent。
    screen.emit(fakeEventInput({
      payload: { kind: "screen_keyword", keyword: "error" },
      sourceId: "screen",
      confidence: 1.4,
    }));
    expect(seen).toEqual([]);
    expect(monitor.diagnostics().schemaRejected).toBe(1);
    expect(monitor.recent()).toEqual([]);

    // 0.4 是合法观察：观察层放行，由策略层决定「值不值得说」。
    screen.emit(fakeEventInput({
      payload: { kind: "screen_keyword", keyword: "error" },
      sourceId: "screen",
      confidence: 0.4,
    }));
    expect(seen).toHaveLength(1);
    expect(monitor.recent()[0]).toMatchObject({ ruleId: "error", confidence: 0.4 });
  });
});
