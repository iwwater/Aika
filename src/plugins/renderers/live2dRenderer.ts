import {
  PET_ACTION_ANIMATION_IDS,
  getPetRenderScale,
  isPetActionAnimationId,
} from '../../pet/animation';
import type { PetCatalogItem } from '../../pet/catalog';
import type { PetSettings } from '../../pet/settings';
import type {
  ActionRequest,
  PetRendererPlugin,
  RendererCapabilities,
  RendererMountContext,
} from '../types';
import { BubbleView } from './bubbleView';
import {
  LIVE2D_APPEARANCES,
  LIVE2D_CORE_SCRIPT,
  getLive2dAppearance,
  isLive2dAppearanceId,
  live2dManifestUrl,
  type Live2dAppearance,
  type Live2dAppearanceId,
} from './live2d/catalog';
import {
  parseLive2dManifest,
  playableActionIds,
  resolveLive2dAction,
  type Live2dManifestInfo,
  type ResolvedLive2dAction,
} from './live2d/manifest';
import { ensureLive2dCore } from './live2d/coreLoader';

type PixiModule = typeof import('pixi.js');
type EngineModule = typeof import('untitled-pixi-live2d-engine/cubism');
type PixiApplication = InstanceType<PixiModule['Application']>;
type Live2DModelInstance = ReturnType<EngineModule['Live2DModel']['fromSync']>;

interface EngineHandle {
  Application: PixiModule['Application'];
  Live2DModel: EngineModule['Live2DModel'];
  MotionPriority: EngineModule['MotionPriority'];
}

/**
 * Live2D renderer (MVP-11)。
 *
 * 三条来自 PET-07 实机核对的硬约束，直接决定这里的结构：
 *
 * 1. **未知 motion / 表情不抛错**——引擎静默受理然后什么都不播。所以动作是否可播
 *    必须在调用**之前**由 `manifest.ts` 对照模型清单判定，不能把异常当信号；
 *    引擎返回的 `false` 只作为二次确认，不作为唯一依据。
 * 2. 像素读回需要 `preserveDrawingBuffer`，否则采样到空帧并伪装成「模型没渲染」。
 * 3. Core 脚本必须在引擎模块求值前就位，见 `coreLoader.ts`。
 *
 * 换装按首版冻结的**整模型切换**实现：一套外观 = 一个 Cubism 模型。加载在提交前
 * 完成，失败保留旧外观；generation 防止迟到的加载覆盖当前选择。
 */
export class Live2dRendererPlugin implements PetRendererPlugin {
  readonly id = 'live2d';
  readonly displayName = 'Live2D renderer';

  /** 渲染框：和 sprite 一样按 renderScale 缩放，但 Live2D 是全身像，需要更高。 */
  private static readonly BOX = { width: 240, height: 300 } as const;
  /** 留一点边距，避免模型贴边被裁。 */
  private static readonly FIT = 0.98;

  private context: RendererMountContext | null = null;
  private settings: PetSettings | null = null;
  private root: HTMLDivElement | null = null;
  private hitTarget: HTMLDivElement | null = null;
  private readonly bubbleView = new BubbleView(this.id);

  private engine: EngineHandle | null = null;
  private app: PixiApplication | null = null;
  private model: Live2DModelInstance | null = null;
  private manifest: Live2dManifestInfo | null = null;
  private appearanceId: Live2dAppearanceId | null = null;
  private playable: string[] = [];

  private disposed = false;
  private visible = false;
  private loadingAppearanceId: Live2dAppearanceId | null = null;
  /** 每次换装自增；迟到的加载结果据此丢弃。 */
  private generation = 0;
  private lastError: string | null = null;
  /** 量到的模型尺寸，用来诊断缩放异常（不属于控制流）。 */
  private measured: { container: [number | null, number | null]; internal: [number | null, number | null] } = {
    container: [null, null],
    internal: [null, null],
  };

  private readonly counters = {
    switched: 0,
    failedSwitches: 0,
    discardedLoads: 0,
    played: 0,
    refused: 0,
    playbackFailures: 0,
    /** 旧舞台释放失败次数：与换装结果分开记账。 */
    stageReleaseFailures: 0,
  };
  private lastReleaseError: string | null = null;

  capabilities(): RendererCapabilities {
    // `actions` 是**已按当前模型清单校验**的可播清单；加载完成前为空，因为那时
    // 我们确实不知道哪些能播。
    return {
      actions: [...this.playable],
      bubble: true,
      costumes: true,
      hitAreas: true,
    };
  }

  async prepare(context: RendererMountContext): Promise<void> {
    if (this.disposed) throw new Error('live2d renderer has already been disposed');
    this.context = context;
    this.settings = context.settings;

    const root = document.createElement('div');
    root.className = 'pet-live2d';
    root.dataset.renderer = this.id;
    root.setAttribute('role', 'img');
    root.dataset.testid = 'pet-live2d';
    // Hidden until activate(): prepare must not produce visible output.
    root.hidden = true;

    const hitTarget = document.createElement('div');
    hitTarget.className = 'pet-hit-target';
    hitTarget.dataset.testid = 'pet-hit-target';
    hitTarget.appendChild(root);

    context.host.appendChild(this.bubbleView.node);
    context.host.appendChild(hitTarget);

    this.root = root;
    this.hitTarget = hitTarget;
    context.onHitTargetChange(hitTarget);
    this.bubbleView.applySettings(context.settings);
    this.resizeBox(context.settings);

    // 初始外观必须在 prepare 阶段就加载成功：加载不了就让宿主降级到 sprite，
    // 而不是端上一个空白框。舞台由 mountAppearance 一并建出来。
    await this.mountAppearance(resolveInitialAppearanceId(context.settings), true);
    this.refit();
  }

  activate(): void {
    if (this.disposed || !this.root) return;
    this.visible = true;
    this.root.hidden = false;
    this.syncTicker();
  }

  deactivate(): void {
    this.visible = false;
    if (this.root) this.root.hidden = true;
    this.app?.ticker.stop();
  }

  action(request: ActionRequest): boolean {
    if (this.disposed || !this.model) return false;
    if (!isPetActionAnimationId(request.animationId)) return false;
    const resolved = this.resolveAction(request.animationId);
    if (!resolved) {
      // 确定降级：清单里没有可播项，一个调用都不发给引擎。
      this.counters.refused += 1;
      return false;
    }
    void this.play(resolved);
    return true;
  }

  /**
   * 姿态：Live2D 只有「待机」一种，没有定向走路。
   *
   * `idle` 返回 true 是因为模型的 motion manager 自己会持续播 Idle；这里重复下发
   * 只会每 120ms 打断一次动画。方向类姿态明确返回 false——不假装 Live2D 会走路。
   */
  pose(animationId: string): boolean {
    if (this.disposed || !this.model) return false;
    if (animationId !== 'idle') return false;
    return this.resolveAction('idle') !== null;
  }

  bubble(text: string | null, ttlMs: number): void {
    if (this.disposed) return;
    this.bubbleView.show(text, ttlMs);
  }

  applySettings(settings: PetSettings, pet: PetCatalogItem): void {
    this.settings = settings;
    if (!this.root) return;
    this.resizeBox(settings);
    this.bubbleView.applySettings(settings);
    this.root.setAttribute('aria-label', `${pet.displayName} desktop pet`);
    this.root.dataset.reducedMotion = settings.reducedMotion ? 'true' : 'false';
    this.syncTicker();

    const next = settings.live2dAppearance;
    if (isLive2dAppearanceId(next) && next !== this.appearanceId) {
      // 失败保留旧外观：切换是「先加载验证再提交」，不是先改配置再祈祷。
      void this.mountAppearance(next, false);
    }
    this.refit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 让任何在途加载的结果失效，避免它之后又往已销毁的 stage 上挂东西。
    this.generation += 1;
    this.visible = false;
    this.context?.onHitTargetChange(null);
    this.model = null;
    this.manifest = null;
    this.playable = [];
    // 舞台整体销毁：模型、贴图、渲染循环与 GL 上下文一起回收。
    // 销毁失败**不能**拦住下面的 DOM 清理：真机实测过，destroy 一抛，整个
    // renderer 的节点就留在文档里，而宿主仍会把这次切换记成成功。
    try {
      this.app?.destroy(true, { children: true });
    } catch (error) {
      this.counters.stageReleaseFailures += 1;
      this.lastReleaseError = describeError(error);
    }
    this.app = null;
    this.engine = null;
    this.hitTarget?.remove();
    this.root?.remove();
    this.bubbleView.dispose();
    this.root = null;
    this.hitTarget = null;
    this.context = null;
  }

  // ---- diagnostics (used by the acceptance report and the tests) ------------

  getCounters(): Readonly<typeof this.counters> & { playable: readonly string[] } {
    return { ...this.counters, playable: [...this.playable] };
  }

  diagnostics(): unknown {
    return {
      ...this.counters,
      appearance: this.appearanceId,
      loadingAppearance: this.loadingAppearanceId,
      playable: [...this.playable],
      lastError: this.lastError,
      lastReleaseError: this.lastReleaseError,
      visible: this.visible,
      measured: this.measured,
      scale: this.model ? this.model.scale.x : null,
      display: this.model
        ? {
            onStage: this.model.parent === this.app?.stage,
            stageChildren: this.app?.stage.children.length ?? 0,
            position: [this.model.position.x, this.model.position.y],
            anchor: [this.model.anchor.x, this.model.anchor.y],
            visible: this.model.visible,
            alpha: this.model.alpha,
            bounds: [this.model.width, this.model.height],
          }
        : null,
      texturesDestroyed: this.model ? this.model.textures.map((texture) => texture.destroyed) : null,
      renderLoopRunning: this.app?.ticker.started ?? false,
      motionGroups: this.manifest ? Object.keys(this.manifest.motionGroups).sort() : [],
      expressions: this.manifest ? [...this.manifest.expressions] : [],
      hitAreas: this.manifest ? [...this.manifest.hitAreas] : [],
    };
  }

  getActiveAppearanceId(): string | null {
    return this.appearanceId;
  }

  isLoading(): boolean {
    return this.loadingAppearanceId !== null;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  // ---- internals -----------------------------------------------------------

  private currentAppearance(): Live2dAppearance | null {
    return getLive2dAppearance(this.appearanceId);
  }

  private resolveAction(animationId: string): ResolvedLive2dAction | null {
    const appearance = this.currentAppearance();
    if (!appearance) return null;
    return resolveLive2dAction(appearance.actions[animationId], this.manifest);
  }

  private async play(resolved: ResolvedLive2dAction): Promise<void> {
    const model = this.model;
    if (!model || this.disposed) return;
    try {
      const started = resolved.kind === 'motion'
        ? await model.motion(resolved.group, resolved.index, this.engine?.MotionPriority.NORMAL)
        : await model.expression(resolved.name);
      if (started) {
        this.counters.played += 1;
      } else {
        // 引擎自己说没播成：记账并如实保留，不当作已播放。
        this.counters.playbackFailures += 1;
      }
    } catch (error) {
      this.counters.playbackFailures += 1;
      this.lastError = describeError(error);
    }
  }

  private resizeBox(settings: PetSettings): void {
    const root = this.root;
    if (!root) return;
    const renderScale = getPetRenderScale(settings.scale);
    const width = Math.round(Live2dRendererPlugin.BOX.width * renderScale);
    const height = Math.round(Live2dRendererPlugin.BOX.height * renderScale);
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    if (this.app) this.app.renderer.resize(width, height);
  }

  private syncTicker(): void {
    const app = this.app;
    if (!app) return;
    // 减少动态时停掉渲染循环；这同时也是 AC-D 要求的「释放渲染循环」的同一条路径。
    if (this.visible && !this.settings?.reducedMotion) app.ticker.start();
    else app.ticker.stop();
  }

  /**
   * 释放一个已被替换掉的舞台（模型、贴图、渲染循环与 GL 上下文一起回收）。
   *
   * 两条实测约束：
   *
   * 1. **延后一拍执行**。销毁会改动 ticker 的监听链表，而换装发生在渲染回调链上；
   *    同一拍内改链表会让引擎抛 `reading 'next'`。推迟到下一个宏任务即可避开。
   * 2. **失败不影响换装结论**。提交已经完成，释放只是收尾；它出错既不该把这次换装
   *    记成失败，也不该覆盖 `lastError`。所以单独计数、单独记录。
   */
  private releaseStage(stage: PixiApplication | null): void {
    if (!stage) return;
    window.setTimeout(() => {
      try {
        stage.destroy(true, { children: true });
      } catch (error) {
        this.counters.stageReleaseFailures += 1;
        this.lastReleaseError = describeError(error);
      }
    }, 0);
  }

  /** 渲染框的当前像素尺寸（随 scale 变）。 */
  private boxSize(): { width: number; height: number } {
    const root = this.root;
    return {
      width: Number.parseInt(root?.style.width ?? '', 10) || Live2dRendererPlugin.BOX.width,
      height: Number.parseInt(root?.style.height ?? '', 10) || Live2dRendererPlugin.BOX.height,
    };
  }

  /**
   * 建一个**独立舞台**（Pixi Application + canvas）。
   *
   * 每次换装都用新舞台，而不是在旧舞台里换模型：见 `mountAppearance` 的说明。
   */
  private async createApp(): Promise<PixiApplication> {
    const engine = await this.loadEngine();
    const { width, height } = this.boxSize();
    const app = new engine.Application();
    await app.init({
      width,
      height,
      // 桌宠窗口是透明的：渲染器不许铺不透明底。
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: 'webgl',
      // 验收需要读回像素（MVP-07 AC-C 的教训：不开这个会采样到空帧）。
      preserveDrawingBuffer: true,
      // 每个舞台持有**自己的** ticker。用共享 ticker 的话，销毁旧舞台会把新舞台
      // 正在用的那个一起销毁（新舞台先建、旧舞台后销毁），典型症状是 ticker 链表
      // 被拆掉后的 "reading 'next'"。
      sharedTicker: false,
    });
    app.canvas.className = 'pet-live2d-canvas';
    app.canvas.setAttribute('aria-hidden', 'true');
    // 初始停止：可见性只由 activate/deactivate 决定，prepare 阶段不得产出画面。
    app.ticker.stop();
    return app;
  }

  private async loadEngine(): Promise<EngineHandle> {
    if (this.engine) return this.engine;
    // 顺序是硬要求：Core 必须在引擎模块求值前就位。
    await ensureLive2dCore(LIVE2D_CORE_SCRIPT);
    // Tauri 的 CSP 禁 eval：Pixi 默认用 new Function 生成 shader/UBO 同步代码，
    // 真机上 prepare 会因此失败、宿主降级回 sprite——浏览器预览没有 CSP，把它掩盖了。
    // 官方 polyfill 用免 eval 的代码路径替代（导入即生效的原型补丁），必须先于 pixi
    // 的首次渲染装上；走动态导入也是刻意的，避免把 pixi 拖进 sprite 路径的包。
    await import('pixi.js/unsafe-eval');
    const [pixi, engine] = await Promise.all([
      import('pixi.js'),
      // 只取 cubism 入口：裸入口还会去找已停止分发的 Cubism 2.1 运行时。
      import('untitled-pixi-live2d-engine/cubism'),
    ]);
    pixi.extensions.add(engine.Live2DPlugin);
    this.engine = {
      Application: pixi.Application,
      Live2DModel: engine.Live2DModel,
      MotionPriority: engine.MotionPriority,
    };
    return this.engine;
  }

  /**
   * 加载并**提交**一套外观。`throwOnFailure` 只给 prepare 用：初始外观加载不了
   * 就必须让宿主降级；运行期换装失败则保留旧外观并记账。
   */
  private async mountAppearance(id: Live2dAppearanceId, throwOnFailure: boolean): Promise<void> {
    const appearance = getLive2dAppearance(id);
    if (!appearance) {
      if (throwOnFailure) throw new Error(`unknown live2d appearance '${id}'`);
      this.counters.failedSwitches += 1;
      this.lastError = `unknown live2d appearance '${id}'`;
      return;
    }

    const generation = ++this.generation;
    this.loadingAppearanceId = appearance.id;
    this.root?.setAttribute('data-loading-appearance', appearance.id);

    /** 未提交的新舞台；提交后置空，避免失败分支误销毁已经在用的舞台。 */
    let stage: PixiApplication | null = null;
    try {
      const engine = await this.loadEngine();
      const modelUrl = live2dManifestUrl(appearance);

      // 每次换装都建一个**独立舞台**，而不是在旧舞台里换模型。
      //
      // 实机验证：这个引擎的贴图与渲染器共享，逐个 destroy 旧模型/旧贴图会把后续
      // 渲染一起弄坏——新模型位置尺寸都对、却一帧都画不出来，而且新模型的贴图会被
      // 报成已销毁。整体重建才能同时满足「释放旧贴图、模型、渲染循环」与「换装后
      // 仍然渲染」；代价是每次换装新建一个 WebGL 上下文，旧的在提交时被销毁。
      stage = await this.createApp();

      const [manifestRaw, model] = await Promise.all([
        // manifest 与模型并行取：前者决定动作能不能播，后者决定画面。
        fetch(modelUrl).then((response) => {
          if (!response.ok) throw new Error(`failed to load ${modelUrl}: ${response.status}`);
          return response.json() as Promise<unknown>;
        }),
        engine.Live2DModel.from(modelUrl, {
          autoUpdate: true,
          // 由**本舞台的** ticker 驱动更新，而不是引擎默认去全局命名空间找
          // `PIXI.Ticker.shared`：后者在打包后的 ESM 里不存在。这也让 deactivate
          // 能真正停下渲染循环。
          ticker: stage.ticker,
          autoHitTest: false,
          autoFocus: false,
        }),
      ]);
      const manifest = parseLive2dManifest(manifestRaw);

      if (this.disposed || generation !== this.generation) {
        // 旧 generation 加载成功也不得覆盖当前选择；新舞台连同模型一起释放。
        stage.destroy(true, { children: true });
        stage = null;
        this.counters.discardedLoads += 1;
        return;
      }

      const previousStage = this.app;
      const previousAppearance = this.appearanceId;

      stage.stage.addChild(model);
      this.app = stage;
      this.model = model;
      this.manifest = manifest;
      this.appearanceId = appearance.id;
      this.playable = playableActionIds(appearance.actions, manifest);
      this.lastError = null;
      // 初次挂载不算「换装」：换装是两套外观之间的动作，计数要能分辨这两件事。
      if (previousAppearance !== null) this.counters.switched += 1;

      // 交换画布：任一时刻只有一个 renderer 在输出，也只有一个 canvas。
      this.root?.replaceChildren(stage.canvas);
      this.syncTicker();
      this.refit();
      stage = null;

      // 提交已完成。旧舞台的释放是**最好努力**的收尾，不能影响这次换装的结论。
      this.releaseStage(previousStage);
    } catch (error) {
      stage?.destroy(true, { children: true });
      this.counters.failedSwitches += 1;
      this.lastError = describeError(error);
      if (throwOnFailure) throw error instanceof Error ? error : new Error(this.lastError);
    } finally {
      if (generation === this.generation) {
        this.loadingAppearanceId = null;
        this.root?.removeAttribute('data-loading-appearance');
      }
    }
  }

  private refit(): void {
    const model = this.model;
    const root = this.root;
    if (!model || !root) return;
    const appearance = this.currentAppearance();
    const boxWidth = Number.parseInt(root.style.width, 10) || Live2dRendererPlugin.BOX.width;
    const boxHeight = Number.parseInt(root.style.height, 10) || Live2dRendererPlugin.BOX.height;

    // 量测前先归一到 1：`Container.width` 已经把当前 scale 算进去了，直接拿它去算
    // 新 scale 是个反馈回路——上一轮的缩放会喂进下一轮，最终把模型放大到铺满整块
    // 画布（第一次跑这条路径时的症状：整帧不透明）。
    model.scale.set(1);
    const rawWidth = readDimension(model.width);
    const rawHeight = readDimension(model.height);
    const internalWidth = readDimension(model.internalModel?.width);
    const internalHeight = readDimension(model.internalModel?.height);
    this.measured = {
      container: [rawWidth, rawHeight],
      internal: [internalWidth, internalHeight],
    };

    // 用可绘制范围（而非模型的内部画布）贴合：内部画布含留白，按它缩放会明显偏小。
    const modelWidth = rawWidth ?? internalWidth;
    const modelHeight = rawHeight ?? internalHeight;
    const fit = Live2dRendererPlugin.FIT * (appearance?.fitScale ?? 1);

    if (modelWidth && modelHeight) {
      const scale = Math.min(boxWidth / modelWidth, boxHeight / modelHeight) * fit;
      model.scale.set(scale);
    } else {
      // 量不到尺寸就不要猜一个缩放：保持 1，画面可能偏大但不会静默变形。
      model.scale.set(1);
    }
    model.anchor.set(0.5, 0.5);
    model.position.set(boxWidth / 2, boxHeight / 2);
  }


}

/** 未知外观回退到目录第一项：坏配置不该让桌宠起不来。 */
function resolveInitialAppearanceId(settings: PetSettings): Live2dAppearanceId {
  return (getLive2dAppearance(settings.live2dAppearance) ?? LIVE2D_APPEARANCES[0]!).id;
}

function readDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 供宿主与测试使用：全部运行期动作 id。 */
export const LIVE2D_ACTION_IDS: readonly string[] = PET_ACTION_ANIMATION_IDS;
