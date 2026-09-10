import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpeechOutputEngine } from "./contracts";

/**
 * SpeechOutputEngine 共用用例包。
 *
 * 只断言契约层面可观测的行为：可用性、开始/结束回调、空文本不发声、错误透传、
 * stop 语义。不断言音色挑选、分句策略或合成引擎是谁——那些是实现细节。
 *
 * 文件不带 `.test.`，由各实现的测试 import 后调用。
 */

export interface SpeechOutputProbe {
  /** 让最近一次 speak 请求真的开始播放。 */
  start(): void;
  /** 让最近一次 speak 请求正常结束。 */
  finish(): void;
  /** 让最近一次 speak 请求失败。 */
  fail(message: string): void;
  /** 底层 stop 被调用了几次。 */
  stopCalls(): number;
}

export interface SpeechOutputFixture {
  subject: SpeechOutputEngine;
  probe: SpeechOutputProbe;
  dispose(): Promise<void>;
}

export interface SpeechOutputHarness {
  name: string;
  create(): Promise<SpeechOutputFixture>;
}

export function runSpeechOutputConformance(harness: SpeechOutputHarness) {
  describe(`SpeechOutputEngine contract: ${harness.name}`, () => {
    let fixture: SpeechOutputFixture;
    beforeEach(async () => { fixture = await harness.create(); });
    afterEach(async () => { await fixture.dispose(); });

    it("可用性是布尔值，且请求非空文本会开始并结束", () => {
      expect(typeof fixture.subject.isAvailable()).toBe("boolean");

      const starts: number[] = [];
      const ends: number[] = [];
      fixture.subject.speak(
        { text: "おかえり。", language: "ja-JP" },
        { onStart: () => starts.push(1), onEnd: () => ends.push(1) },
      );
      expect(starts).toHaveLength(0);
      fixture.probe.start();
      expect(starts).toHaveLength(1);
      fixture.probe.finish();
      expect(ends).toHaveLength(1);
    });

    it("空白或纯记号文本不发声，直接结束", () => {
      for (const text of ["   ", "***", "\n"]) {
        const starts: number[] = [];
        const ends: number[] = [];
        fixture.subject.speak({ text, language: "ja-JP" }, {
          onStart: () => starts.push(1),
          onEnd: () => ends.push(1),
        });
        expect(starts).toHaveLength(0);
        expect(ends).toHaveLength(1);
      }
    });

    it("合成失败经 onError 上报，不静默", () => {
      const errors: string[] = [];
      fixture.subject.speak({ text: "こんばんは。", language: "ja-JP" }, {
        onError: (message) => errors.push(message),
      });
      fixture.probe.fail("synthesis-failed");
      expect(errors).toEqual(["synthesis-failed"]);
    });

    it("stop 透传到底层，且可重复调用", () => {
      const before = fixture.probe.stopCalls();
      fixture.subject.speak({ text: "おやすみ。", language: "ja-JP" }, {});
      fixture.subject.stop();
      fixture.subject.stop();
      expect(fixture.probe.stopCalls()).toBeGreaterThanOrEqual(before + 1);
    });
  });
}
