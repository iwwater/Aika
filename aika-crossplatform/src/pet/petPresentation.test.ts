import { describe, expect, it } from "vitest";
import { createManualClock } from "../services/environment/fakeEnvironment";
import {
  PROACTIVE_BUBBLE_MS,
  SUBTITLE_FADE_MS,
  createPetViewModel,
  validatePetPresentationFrame,
} from "./petPresentation";

/**
 * FE-20-F：生产协议校验 + 假时钟合并/淡出语义。
 */

type FrameOverrides = Partial<Omit<import("./petPresentation").PetPresentationFrameV1, "schemaVersion">>;

function frame(overrides: FrameOverrides & { seq: number }): import("./petPresentation").PetPresentationFrameV1 {
  return {
    schemaVersion: "pet.presentation.v1" as const,
    epoch: "e1",
    runtimeTurnId: null,
    speaking: false,
    mood: "neutral",
    currentSubtitle: null,
    lastProactive: null,
    ...overrides,
  };
}

describe("pet.presentation.v1 校验（FE-20-F）", () => {
  it("合法帧通过；缺字段/坏版本/坏 seq 拒绝", () => {
    expect(validatePetPresentationFrame(frame({ seq: 1, speaking: true, currentSubtitle: "こんにちは" }))).toMatchObject({
      seq: 1,
      speaking: true,
      currentSubtitle: "こんにちは",
    });

    expect(validatePetPresentationFrame({ ...frame({ seq: 1 }), schemaVersion: "pet.presentation.v2" })).toBeNull();
    expect(validatePetPresentationFrame({ ...frame({ seq: 1 }), epoch: "" })).toBeNull();
    expect(validatePetPresentationFrame({ ...frame({ seq: -1 }) })).toBeNull();
    expect(validatePetPresentationFrame({ ...frame({ seq: 1 }), speaking: "yes" })).toBeNull();
    expect(validatePetPresentationFrame({ ...frame({ seq: 1 }), lastProactive: { text: "" } })).toBeNull();
    expect(validatePetPresentationFrame(null)).toBeNull();
  });

  it("超长字幕/气泡截断到 2000 字符（只影响展示）", () => {
    const long = "あ".repeat(2500);
    const validated = validatePetPresentationFrame({ ...frame({ seq: 1 }), currentSubtitle: long });
    expect(validated?.currentSubtitle).toHaveLength(2001); // 2000 + 省略号
  });
});

describe("pet 视图模型：epoch/seq 合并与旧数据不回退（FE-20-F）", () => {
  it("旧 seq / 旧 epoch / 迟到快照零覆盖", () => {
    const clock = createManualClock(0);
    const vm = createPetViewModel();
    expect(vm.apply(frame({ seq: 5, speaking: true, currentSubtitle: "new" }), clock.now())).toBe(true);
    expect(vm.apply(frame({ seq: 5, currentSubtitle: "dup" }), clock.now())).toBe(false);
    expect(vm.apply(frame({ seq: 4, currentSubtitle: "old" }), clock.now())).toBe(false);
    expect(vm.apply(frame({ seq: 6, epoch: "e0", currentSubtitle: "older-session" }), clock.now())).toBe(false);
    expect(vm.snapshot().subtitle).toBe("new");
  });

  it("快照请求（seq 更小）不覆盖新增量，但新会话 epoch 重置基线", () => {
    const clock = createManualClock(0);
    const vm = createPetViewModel();
    vm.apply(frame({ seq: 10, speaking: true, currentSubtitle: "live" }), clock.now());
    // 迟到的快照（seq 3）被拒。
    expect(vm.apply(frame({ seq: 3, currentSubtitle: "snapshot" }), clock.now())).toBe(false);
    // 宿主重启（epoch 变化）→ 只有快照帧允许重同步。
    expect(vm.apply(frame({ seq: 1, epoch: "e2", currentSubtitle: "increment" }), clock.now())).toBe(false);
    expect(vm.apply(frame({ seq: 1, epoch: "e2", currentSubtitle: "fresh-session", snapshot: true }), clock.now())).toBe(true);
    expect(vm.snapshot().subtitle).toBe("fresh-session");
  });
});

describe("pet 视图模型：淡出与气泡计时（FE-20-F，假时钟边界）", () => {
  it("字幕在说话期间可见；结束后 3000ms 淡出；新字幕取消旧淡出", () => {
    const clock = createManualClock(0);
    const vm = createPetViewModel();
    vm.apply(frame({ seq: 1, speaking: true, currentSubtitle: "一", runtimeTurnId: "t1" }), clock.now());
    expect(vm.snapshot().subtitle).toBe("一");

    // 说话中较长时间仍在（说话刷新基准）。
    clock.advance(10_000);
    vm.apply(frame({ seq: 2, speaking: true, currentSubtitle: "一", runtimeTurnId: "t1" }), clock.now());
    vm.advance(clock.now());
    expect(vm.snapshot().subtitle).toBe("一");

    // 说话结束：2999ms 可见，3000ms 消失。
    vm.apply(frame({ seq: 3, speaking: false, currentSubtitle: "一", runtimeTurnId: "t1" }), clock.now());
    clock.advance(SUBTITLE_FADE_MS - 1);
    vm.advance(clock.now());
    expect(vm.snapshot().subtitle).toBe("一");
    clock.advance(1);
    vm.advance(clock.now());
    expect(vm.snapshot().subtitle).toBeNull();

    // 新字幕（seq 更新）重新可见，不受旧计时影响。
    vm.apply(frame({ seq: 4, speaking: true, currentSubtitle: "二", runtimeTurnId: "t2" }), clock.now());
    expect(vm.snapshot().subtitle).toBe("二");
  });

  it("主动气泡 8000ms；更新替换旧条且不重置无关帧的计时", () => {
    const clock = createManualClock(0);
    const vm = createPetViewModel();
    vm.apply(frame({ seq: 1, lastProactive: { text: "hello", sentAtMs: 1 } }), clock.now());
    expect(vm.snapshot().proactive?.text).toBe("hello");

    clock.advance(PROACTIVE_BUBBLE_MS - 1);
    // 无关帧（仅 mood 变化）不重置气泡计时。
    vm.apply(frame({ seq: 2, mood: "happy", lastProactive: { text: "hello", sentAtMs: 1 } }), clock.now());
    vm.advance(clock.now());
    expect(vm.snapshot().proactive?.text).toBe("hello");

    clock.advance(1);
    vm.advance(clock.now());
    expect(vm.snapshot().proactive).toBeNull();

    // 新气泡替换。
    vm.apply(frame({ seq: 3, lastProactive: { text: "again", sentAtMs: 2 } }), clock.now());
    expect(vm.snapshot().proactive?.text).toBe("again");
  });

  it("取消当轮：speaking=false + runtimeTurnId=null 立即结束说话态，旧轮不回写", () => {
    const clock = createManualClock(0);
    const vm = createPetViewModel();
    vm.apply(frame({ seq: 1, speaking: true, currentSubtitle: "一", runtimeTurnId: "t1" }), clock.now());
    expect(vm.snapshot().speaking).toBe(true);

    vm.apply(frame({ seq: 2, speaking: false, currentSubtitle: "一", runtimeTurnId: null }), clock.now());
    expect(vm.snapshot().speaking).toBe(false);
    expect(vm.snapshot().runtimeTurnId).toBeNull();

    // 旧轮的迟到帧（seq 倒退）不回写。
    vm.apply(frame({ seq: 1, speaking: true, currentSubtitle: "一", runtimeTurnId: "t1" }), clock.now());
    expect(vm.snapshot().speaking).toBe(false);
  });
});

/** FE-20-B 静态约束：src/pet/ 不得 import services/runtime|storage|voice。 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("src/pet/ 静态边界", () => {
  it("pet 目录无 runtime/storage/voice import，也不建第二套 Runtime", () => {
    const dir = join(import.meta.dirname ?? ".", ".");
    const offenders: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!/\.tsx?$/.test(entry)) continue;
      const source = readFileSync(join(dir, entry), "utf8").replace(/\/\/[^\n]*/g, " ");
      if (/from\s+["'][^"']*services\/(runtime|storage|voice)/.test(source)) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });
});
