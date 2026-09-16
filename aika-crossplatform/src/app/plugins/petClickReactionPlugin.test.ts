import { describe, expect, it } from "vitest";
import { createKernel } from "../../kernel";
import { CompanionPresenterToken, VoicePresenterToken } from "../../presentation/tokens";
import { createFakeClock } from "../../services/desktopPet/fakeDesktopPet";
import {
  CLICK_REACTION_MIN_INTERVAL_MS,
  CLICK_REACTION_PHRASES,
  type ClickReaction,
} from "../../services/desktopPet/clickReaction";
import { ClockToken } from "../../services/time/tokens";
import {
  PetClickReactionToken,
  petClickReactionPlugin,
  type PetClickEvent,
  type PetClickSource,
} from "./petClickReactionPlugin";

/**
 * 接线层测试（MVP-15 B）：点击事实 → 说话权 → 终审 → 出声。
 *
 * 这里用**真实内核**跑插件激活，只把两个 Presenter 与点击源换成假的——
 * 要证明的正是「谁被调用、谁有最终否决权」，不是文档里写了什么。
 */

const CLICK: PetClickEvent = {
  schemaVersion: 1,
  type: "click",
  eventId: "e2e-1",
  atMs: 1_700_000_000_000,
  payload: { button: "left" },
};

function fakeClickSource() {
  let handler: ((event: PetClickEvent) => void) | null = null;
  let disposals = 0;
  const source: PetClickSource = {
    subscribe(next) {
      handler = next;
      return () => {
        disposals += 1;
        handler = null;
      };
    },
  };
  return {
    source,
    emit(event: PetClickEvent = CLICK) {
      handler?.(event);
    },
    disposals: () => disposals,
    subscribed: () => handler !== null,
  };
}

async function start(options: {
  gate?: boolean;
  speaking?: boolean;
  speakAside?: (text: string) => boolean;
  withoutVoice?: boolean;
}) {
  const clicks = fakeClickSource();
  const spoken: string[] = [];
  const clock = createFakeClock(0);
  let openRefusals = 0;

  const voice = {
    speakAside(text: string) {
      if (options.speakAside) return options.speakAside(text);
      if (options.speaking) {
        openRefusals += 1;
        return false;
      }
      spoken.push(text);
      return true;
    },
    isSpeaking: () => options.speaking ?? false,
  };
  const companion = { canSpeakAside: async () => options.gate ?? true };

  const kernel = createKernel();
  kernel.use({
    id: "fake.clock",
    version: "1.0.0",
    provides: [ClockToken],
    activate: (context) => context.registrar.provide(ClockToken, () => clock),
  });
  kernel.use({
    id: "fake.companion",
    version: "1.0.0",
    provides: [CompanionPresenterToken],
    activate: (context) =>
      context.registrar.provide(CompanionPresenterToken, () => companion as never),
  });
  if (!options.withoutVoice) {
    kernel.use({
      id: "fake.voice",
      version: "1.0.0",
      provides: [VoicePresenterToken],
      activate: (context) => context.registrar.provide(VoicePresenterToken, () => voice as never),
    });
  }
  kernel.use(
    petClickReactionPlugin({
      clickSource: clicks.source,
      // 与组合根同形：解析发生在点击时（那时内核已 ready，Presenter 工厂才是合法的）。
      resolve: (serviceToken) => kernel.registry.tryResolve(serviceToken),
    }),
  );

  const report = await kernel.start();
  expect(report.ok).toBe(true);

  const reaction = kernel.registry.resolve(PetClickReactionToken);
  // 事件是异步处理器：等一拍再断言。
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { kernel, clicks, spoken, clock, reaction, flush, openRefusals: () => openRefusals };
}

describe("点击回应接线（MVP-15 B）", () => {
  it("一次点击 → 说出池子里的一句", async () => {
    const { clicks, spoken, reaction, flush } = await start({});

    clicks.emit();
    await flush();

    expect(spoken).toEqual([CLICK_REACTION_PHRASES[0]]);
    expect(reaction.diagnostics()).toMatchObject({ received: 1, responded: 1 });
  });

  it("冷却内的连点只响一次（不排队），被抑制的原因可读", async () => {
    const { clicks, spoken, clock, reaction, flush } = await start({});

    clicks.emit();
    await flush();
    for (let index = 0; index < 3; index += 1) {
      clock.advance(1_000);
      clicks.emit();
      await flush();
    }

    expect(spoken).toHaveLength(1);
    expect(reaction.diagnostics().suppressed.cooldown).toBe(3);
  });

  it("终审说不就不能说：点击被 gate 挡下，一次都没出声", async () => {
    const { clicks, spoken, reaction, flush } = await start({ gate: false });

    clicks.emit();
    await flush();

    expect(spoken).toEqual([]);
    expect(reaction.diagnostics().suppressed.gate).toBe(1);
  });

  it("她正在说话时不叠话（由说话权一侧拒绝，模块记 speaking）", async () => {
    const { clicks, spoken, reaction, flush } = await start({ speaking: true });

    clicks.emit();
    await flush();

    expect(spoken).toEqual([]);
    expect(reaction.diagnostics().suppressed.speaking).toBe(1);
  });

  it("宿主没有语音链路时插件照样激活，点击只记账不出声", async () => {
    const { clicks, spoken, reaction, flush } = await start({ withoutVoice: true });

    clicks.emit();
    await flush();

    expect(spoken).toEqual([]);
    const diagnostics = reaction.diagnostics();
    expect(diagnostics.received).toBe(1);
    expect(diagnostics.suppressed.unavailable).toBe(1);
  });

  it("用户开关（presenter 快照）关掉时不出声，记 disabled", async () => {
    const clicks = fakeClickSource();
    const spoken: string[] = [];
    const clock = createFakeClock(0);
    let clickReactionEnabled = false; // 模拟用户在设置里把它关了

    const kernel = createKernel();
    kernel.use({
      id: "fake.clock",
      version: "1.0.0",
      provides: [ClockToken],
      activate: (context) => context.registrar.provide(ClockToken, () => clock),
    });
    kernel.use({
      id: "fake.companion",
      version: "1.0.0",
      provides: [CompanionPresenterToken],
      activate: (context) =>
        context.registrar.provide(CompanionPresenterToken, () =>
          ({
            getSnapshot: () => ({ petClickReactionEnabled: clickReactionEnabled }),
            canSpeakAside: async () => true,
          }) as never,
        ),
    });
    kernel.use({
      id: "fake.voice",
      version: "1.0.0",
      provides: [VoicePresenterToken],
      activate: (context) =>
        context.registrar.provide(VoicePresenterToken, () =>
          ({ speakAside: (text: string) => { spoken.push(text); return true; }, isSpeaking: () => false }) as never,
        ),
    });
    kernel.use(petClickReactionPlugin({
      clickSource: clicks.source,
      resolve: (serviceToken) => kernel.registry.tryResolve(serviceToken),
    }));
    const report = await kernel.start();
    expect(report.ok).toBe(true);
    const reaction = kernel.registry.resolve(PetClickReactionToken);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    clicks.emit();
    await flush();
    expect(spoken).toEqual([]);
    expect(reaction.diagnostics().suppressed.disabled).toBe(1);

    // 用户把它打开：同一份快照读数变了，下一次点击照常出声。
    clickReactionEnabled = true;
    clicks.emit();
    await flush();
    expect(spoken).toEqual([CLICK_REACTION_PHRASES[0]]);
  });

  it("兑现最小间隔（5s）：冷却一过第二次点击照常回应", async () => {
    const { clicks, spoken, clock, flush } = await start({});

    clicks.emit();
    await flush();
    clock.advance(CLICK_REACTION_MIN_INTERVAL_MS);
    clicks.emit();
    await flush();

    expect(spoken).toEqual([CLICK_REACTION_PHRASES[0], CLICK_REACTION_PHRASES[1]]);
  });

  it("插件拆掉后事件不再灌进死服务（退订被调用）", async () => {
    const { kernel, clicks } = await start({});
    expect(clicks.subscribed()).toBe(true);

    await kernel.dispose?.();
    expect(clicks.disposals()).toBe(1);
    expect(clicks.subscribed()).toBe(false);
  });

  it("服务经 token 可解析，诊断读得到（供 FE-09/诊断页取数）", async () => {
    const { reaction } = await start({});
    const resolved: ClickReaction = reaction;
    expect(resolved.diagnostics().received).toBe(0);
  });
});
