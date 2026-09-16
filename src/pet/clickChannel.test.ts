import { describe, expect, it } from 'vitest';
import { CLICK_REPORT_COOLDOWN_MS, createClickReportGate } from './clickChannel';

describe('点击上报闸门（MVP-12）', () => {
  it('第一次抬起即上报', () => {
    const gate = createClickReportGate(() => 1_000);
    expect(gate.shouldReport()).toBe(true);
  });

  it('冷却窗口内的第二次抬起被折叠', () => {
    let now = 1_000;
    const gate = createClickReportGate(() => now);

    expect(gate.shouldReport()).toBe(true);
    // 双击的另一半：不产生第二个事件。
    now += CLICK_REPORT_COOLDOWN_MS - 1;
    expect(gate.shouldReport()).toBe(false);
    // 冷却边界（含）之后恢复放行。
    now += 1;
    expect(gate.shouldReport()).toBe(true);
  });

  it('reset 之后重新放行', () => {
    let now = 5_000;
    const gate = createClickReportGate(() => now);

    expect(gate.shouldReport()).toBe(true);
    now += 10;
    expect(gate.shouldReport()).toBe(false);
    gate.reset();
    expect(gate.shouldReport()).toBe(true);
  });

  it('默认窗口是 SPEC 冻结的 400ms，且可注入', () => {
    expect(CLICK_REPORT_COOLDOWN_MS).toBe(400);

    let now = 0;
    const gate = createClickReportGate(() => now, 1_000);
    expect(gate.shouldReport()).toBe(true);
    now += 500;
    expect(gate.shouldReport()).toBe(false);
    now += 500;
    expect(gate.shouldReport()).toBe(true);
  });

  it('时间不前进时不会因为比较而误放行', () => {
    const gate = createClickReportGate(() => 2_000);
    expect(gate.shouldReport()).toBe(true);
    expect(gate.shouldReport()).toBe(false);
  });
});
