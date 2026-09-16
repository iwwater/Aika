import { token, type AikaPlugin, type ServiceToken } from "../../kernel";
import { CompanionPresenterToken, VoicePresenterToken } from "../../presentation/tokens";
import { createClickReaction, type ClickReaction } from "../../services/desktopPet/clickReaction";
import { ClockToken } from "../../services/time/tokens";
import { createSystemClock } from "../../services/time/systemTime";

/**
 * 点击回应插件（MVP-15 选项 B，2026-09-16 用户拍板）。
 *
 * 它把三件事接起来，自己**不做判断**：
 *
 * - **点击事实**（`clickSource`）：Rust 接收端受理后只发给授权主窗的事件。端口由宿主包，
 *   于是 `services/` 侧不接触 `@tauri-apps`（架构测试的边界）。
 * - **说话权**（VoicePresenter）：她说一句话的唯一出口。会话占着或正在念时由它拒绝。
 * - **终审**（CompanionPresenter.canSpeakAside）：勿扰时段 / 每日上限 / 最小间隔。
 *   判断留在 Presenter 里，这里只问结果——不复制一份。
 *
 * **为什么解析要延后到点击发生时**：Presenter 的工厂内部要走全局注册表，而内核在
 * `starting` 期间一律拒绝全局解析（实测报 `kernel is starting; call start() first`），
 * 所以 activate 里拿不到它们。`PluginContext.registrar` 在 activate 返回后又被 revoke，
 * 于是只剩一条路：由组合根注入一个**启动后的解析器**（组合根本来就是白名单里允许调用
 * `registry.resolve` 的地方），这里把它留到点击真的发生时再问。
 *
 * 三个依赖全是**软依赖**：宿主没装语音链路或展示层时，这个插件照样激活，只是每一次点击
 * 都会被记成 `unavailable`。不早退、不抛错、不阻断启动——点击是旁路，旁路不许把主干拉下水。
 */

/** 反向点击事件（与 `DESKTOP_PET_CONTRACT.md` §8 的报文一一对应）。 */
export interface PetClickEvent {
  schemaVersion: number;
  type: string;
  eventId: string;
  atMs: number;
  payload: { button: string };
}

/** 点击事实来源。宿主注入；实现负责订阅与退订，本层不知道事件从哪来。 */
export interface PetClickSource {
  subscribe(handler: (event: PetClickEvent) => void): () => void;
}

/**
 * 启动后的服务解析器。返回 null 表示没有这个能力（不是错误）。
 *
 * 由组合根注入，不在这里 import 内核实例——插件不认识组合根，这是它唯一的对外取用口。
 */
export type ServiceResolver = <T>(token: ServiceToken<T>) => T | null;

export const PetClickReactionToken = token<ClickReaction>("desktopPet.clickReaction");

export function petClickReactionPlugin(deps: {
  clickSource: PetClickSource;
  resolve?: ServiceResolver;
}): AikaPlugin {
  return {
    id: "desktopPet.clickReaction",
    version: "1.0.0",
    optional: [CompanionPresenterToken, VoicePresenterToken, ClockToken],
    provides: [PetClickReactionToken],
    activate(context) {
      const resolve: ServiceResolver = deps.resolve ?? (() => null);
      // 时钟走 registrar：activate 期间解析普通服务是合法的（只有 Presenter 的工厂
      // 要求内核已 ready）。注入的解析器只用于那两个必须延后的依赖。
      const clock = context.registrar.tryResolve(ClockToken) ?? createSystemClock();

      const reaction = createClickReaction({
        clock,
        // 每次点击现问一次：Presenter 是惰性构造的，问早了（启动期）会拿到 null。
        speak: (text) => resolve(VoicePresenterToken)?.speakAside(text) ?? false,
        isSpeaking: () => resolve(VoicePresenterToken)?.isSpeaking() ?? false,
        gate: async () => (await resolve(CompanionPresenterToken)?.canSpeakAside()) ?? false,
      });

      // 订阅在 dispose 时退订：插件拆掉后不该还有事件往一个死服务里灌。
      const unsubscribe = deps.clickSource.subscribe(() => {
        void reaction.handle();
      });
      context.onDispose(unsubscribe);

      context.registrar.provide(PetClickReactionToken, () => reaction);
    },
  };
}
