import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpeechFinalResult } from "../../domain/voiceRuntime";
import type { SpeechInputEngine } from "./contracts";

/**
 * SpeechInputEngine 共用用例包。
 *
 * Web Speech 与本地 Whisper 是两个真实实现，装配期可替换。这份用例只断言**契约层面
 * 可观测的行为**：开始回调、最终片段的时间与文本、continuous 与停止语义、错误如何
 * 暴露、可选能力的声明是否属实。不断言各自的内部切段方式——那属于实现细节。
 *
 * 文件不带 `.test.`，不会被 vitest 直接收集；由各实现自己的测试 import 后调用，
 * 这样「谁在跑这份用例」在 import 图上看得见。
 */

export interface SpeechInputProbe {
  /** 产出一段带文本的最终片段；本地管线是异步链路，所以是 Promise。 */
  emitFinal(text: string): Promise<void>;
  /** 只有声明支持中间结果的实现才提供。 */
  emitInterim?(text: string): void;
  /** 让引擎进入错误路径；具体错误码由实现决定，只要求可识别、非空。 */
  emitError(code: string): Promise<void>;
  /** 停止被调用了几次（引擎应当把 stop 透传给底层）。 */
  stopCalls(): number;
}

export interface SpeechInputFixture {
  subject: SpeechInputEngine;
  probe: SpeechInputProbe;
  /** 推进异步链路（本地管线有 VAD → 转写两级异步）。 */
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SpeechInputHarness {
  name: string;
  /**
   * 这个实现明确不支持的能力。必须显式声明——用例包会验证它「确实不存在」，
   * 而不是允许悄悄跳过。声明了却其实支持，也算不一致。
   */
  unsupported?: readonly "interim"[];
  create(): Promise<SpeechInputFixture>;
}

export function runSpeechInputConformance(harness: SpeechInputHarness) {
  describe(`SpeechInputEngine contract: ${harness.name}`, () => {
    let fixture: SpeechInputFixture;
    beforeEach(async () => { fixture = await harness.create(); });
    afterEach(async () => { await fixture.dispose(); });

    it("start 后上报一次开始", async () => {
      const starts: number[] = [];
      fixture.subject.start("ja-JP", { onStart: () => starts.push(1) });
      await fixture.flush();
      expect(starts).toHaveLength(1);
    });

    it("最终片段带原文、稳定标识与单调时间，可回溯到同一段", async () => {
      const starts: Array<{ segmentId: string }> = [];
      const finals: SpeechFinalResult[] = [];
      fixture.subject.start("ja-JP", {
        onSpeechStart: (event) => starts.push({ segmentId: event.segmentId }),
        onFinal: (result) => finals.push(result),
      });
      await fixture.flush();

      await fixture.probe.emitFinal("おはよう。");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("おはよう。");
      expect(finals[0].segmentId).toBeTruthy();
      expect(typeof finals[0].sequence).toBe("number");
      expect(finals[0].audioEndAt).toBeGreaterThanOrEqual(finals[0].audioStartAt);
      if (starts.length) expect(starts[0].segmentId).toBe(finals[0].segmentId);
    });

    it("continuous 声明与停止语义一致：连续引擎不因 stop 报 onEnd", async () => {
      let ends = 0;
      fixture.subject.start("ja-JP", { onEnd: () => { ends += 1; } });
      await fixture.flush();

      fixture.subject.stop();
      if (fixture.subject.continuous) {
        // 麦克风一直开着的实现由上层显式停止，引擎不自己发 onEnd。
        expect(ends).toBe(0);
      } else {
        // 每段自停的实现必须在 stop 后收尾，否则上层会卡在「ASR 在途」。
        expect(ends).toBe(1);
      }
      expect(fixture.probe.stopCalls()).toBeGreaterThanOrEqual(1);
    });

    it("错误带可识别 code 上报，不静默吞掉", async () => {
      const codes: string[] = [];
      fixture.subject.start("ja-JP", { onError: (code) => codes.push(code) });
      await fixture.flush();

      await fixture.probe.emitError("network");
      expect(codes.length).toBeGreaterThan(0);
      expect(codes[0]).toBeTruthy();
    });

    it("abort 可重复调用且不产生新的开始回调", async () => {
      const starts: number[] = [];
      fixture.subject.start("ja-JP", { onStart: () => starts.push(1) });
      await fixture.flush();
      const before = starts.length;

      expect(() => { fixture.subject.abort(); fixture.subject.abort(); }).not.toThrow();
      await fixture.flush();
      expect(starts).toHaveLength(before);
    });

    it("dispose 幂等：重复调用不抛", async () => {
      fixture.subject.start("ja-JP", {});
      await fixture.flush();
      expect(() => {
        fixture.subject.dispose();
        fixture.subject.dispose();
      }).not.toThrow();
    });

    it("可选中间结果的声明与实际一致", async () => {
      if (harness.unsupported?.includes("interim")) {
        expect(fixture.probe.emitInterim).toBeUndefined();
        return;
      }
      expect(fixture.probe.emitInterim).toBeTypeOf("function");
      const interims: string[] = [];
      fixture.subject.start("ja-JP", { onInterim: (text) => interims.push(text) });
      await fixture.flush();
      fixture.probe.emitInterim!("こん");
      expect(interims).toEqual(["こん"]);
    });
  });
}
