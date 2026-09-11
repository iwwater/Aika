import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpeechOutputEngine } from "./contracts";

/**
 * SpeechOutputEngine 共用用例包。
 *
 * 只断言契约层面可观测的行为：可用性、开始/结束回调、空文本不发声、错误上报、
 * stop 语义、以及可选的 prefetch 不改变播放行为。不断言音色挑选、分句策略或
 * 合成引擎是谁——那些是实现细节。
 *
 * 文件不带 `.test.`，由各实现的测试 import 后调用。
 *
 * **探针是异步的。** 系统合成的回调同步就到，云端合成要等一次网络往返再等
 * `audio.play()`。如果用例包写成同步，云端那一格就只能靠「在实现里插一个同步分支」
 * 过关——那等于让用例包迁就实现。所以探针方法一律可 await，系统合成那边返回 void
 * 也一样能 await。
 */

export interface SpeechOutputProbe {
  /** 让最近一次 speak 请求真的开始播放。 */
  start(): void | Promise<void>;
  /** 让最近一次 speak 请求正常结束。 */
  finish(): void | Promise<void>;
  /** 让最近一次 speak 请求失败，失败原因是 `message`。 */
  fail(message: string): void | Promise<void>;
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

    it("可用性是布尔值，且请求非空文本会开始并结束", async () => {
      expect(typeof fixture.subject.isAvailable()).toBe("boolean");

      const starts: number[] = [];
      const ends: number[] = [];
      fixture.subject.speak(
        { text: "おかえり。", language: "ja-JP" },
        { onStart: () => starts.push(1), onEnd: () => ends.push(1) },
      );
      expect(starts).toHaveLength(0);
      await fixture.probe.start();
      expect(starts).toHaveLength(1);
      await fixture.probe.finish();
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

    /**
     * 只要求「报一次，且说得出原因」，不要求消息逐字相同。
     *
     * 系统合成能拿到的只有 `event.error` 那一个词，原样透传就是全部信息；云端合成
     * 知道是哪个地址、对面回了什么状态码，把这些拼进消息里是**更有用**的行为。
     * 断言写成逐字相等的话，云端那一格只能靠把诊断信息删掉来过关——那是让用例包
     * 逼实现变差。所以这里断言的是次数与因果，不是措辞。
     */
    it("合成失败经 onError 上报一次，且消息里说得出原因", async () => {
      const errors: string[] = [];
      fixture.subject.speak({ text: "こんばんは。", language: "ja-JP" }, {
        onError: (message) => errors.push(message),
      });
      await fixture.probe.fail("synthesis-failed");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("synthesis-failed");
    });

    it("stop 透传到底层，且可重复调用", async () => {
      const before = fixture.probe.stopCalls();
      fixture.subject.speak({ text: "おやすみ。", language: "ja-JP" }, {});
      await fixture.probe.start();
      fixture.subject.stop();
      fixture.subject.stop();
      expect(fixture.probe.stopCalls()).toBeGreaterThanOrEqual(before + 1);
    });

    /**
     * `prefetch` 是可选能力（`engine.prefetch?.(…)`）。声明与否都合法，但两种情况
     * 下**播放行为必须一样**：预取过的句子照常只念一次，不会因为提前准备过就多出
     * 一次 onStart，也不会因为没实现预取就少念。
     */
    it("预取不改变播放行为：预取过的句子照常只念一次", async () => {
      const request = { text: "また明日。", language: "ja-JP" } as const;
      fixture.subject.prefetch?.(request);

      const starts: number[] = [];
      const ends: number[] = [];
      fixture.subject.speak(request, {
        onStart: () => starts.push(1),
        onEnd: () => ends.push(1),
      });
      await fixture.probe.start();
      await fixture.probe.finish();

      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
    });
  });
}
