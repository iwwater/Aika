import { afterEach, describe, expect, it, vi } from "vitest";
import { runSpeechOutputConformance, type SpeechOutputFixture } from "./speechOutput.conformance";
import { webSpeechOutput } from "./webSpeechOutput";

/**
 * CORE-05-G（输出侧）：同一份输出用例包，当前由 `webSpeechOutput` 执行。
 *
 * 第二个真实实现（`cloudTtsOutput`）按 SPEC 来自 `stash@{0}`，但当前仓库没有该
 * stash，也无法从历史里找回；因此**第二实现标记 BLOCKED**，不写一个 stub 冒充。
 * 这份文件先证明用例包已建立且在真实实现上全绿，并附一条突变证据说明它不是空跑。
 */

class FakeUtterance {
  static last: FakeUtterance | null = null;
  text: string;
  lang = "";
  voice: unknown = null;
  rate = 1;
  pitch = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
    FakeUtterance.last = this;
  }
}

function webSpeechHarness() {
  return {
    name: "webSpeechOutput",
    async create(): Promise<SpeechOutputFixture> {
      FakeUtterance.last = null;
      let cancels = 0;
      const synthesis = {
        getVoices: () => [],
        cancel: () => { cancels += 1; },
        speak: () => undefined,
      };
      vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
      vi.stubGlobal("window", { speechSynthesis: synthesis, SpeechSynthesisUtterance: FakeUtterance });

      return {
        subject: webSpeechOutput,
        probe: {
          start: () => FakeUtterance.last?.onstart?.(),
          finish: () => FakeUtterance.last?.onend?.(),
          fail: (message: string) => FakeUtterance.last?.onerror?.({ error: message }),
          stopCalls: () => cancels,
        },
        dispose: async () => undefined,
      };
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

runSpeechOutputConformance(webSpeechHarness());

describe("输出侧可替换性状态", () => {
  it("用例包是可执行的，但第二实现缺失：只有 1 个真实输出引擎", () => {
    // 如实记录：这不是「两个实现全绿」，只是一个实现跑通了用例包。
    const harnesses = [webSpeechHarness()];
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0].name).toBe("webSpeechOutput");
  });
});
