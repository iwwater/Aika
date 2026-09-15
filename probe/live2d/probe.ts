/**
 * MVP-07 AC-C minimal sample.
 *
 * Verifies the candidate combination:
 *   Live2D Cubism Core (Web)  x  PixiJS v8  x  untitled-pixi-live2d-engine  x  Hiyori sample model
 *
 * Writes an objective report on `window.__probe`; nothing here is shipped with the app.
 */
import { Application, extensions } from "pixi.js";
// Cubism 3/4/5 only. The bare entry also expects the discontinued Cubism 2.1 runtime (live2d.min.js).
import { Live2DModel, Live2DPlugin } from "untitled-pixi-live2d-engine/cubism";

const MODEL_URL = "./assets/Hiyori/Hiyori.model3.json";

type ProbeReport = Record<string, unknown>;

const report: ProbeReport = {};
(window as unknown as { __probe: ProbeReport }).__probe = report;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function readCoreRuntime(): ProbeReport {
  const core = (window as unknown as { Live2DCubismCore?: Record<string, never> })
    .Live2DCubismCore;
  if (!core) return { present: false };

  const version = (core as unknown as { Version?: Record<string, () => number> }).Version;
  const info: ProbeReport = { present: true };
  if (!version) return { ...info, versionApiMissing: true };

  const attempt = (name: string) => {
    const call = version[name];
    if (typeof call !== "function") {
      info[name] = "not-exposed";
      return;
    }
    try {
      info[name] = call();
    } catch (error) {
      info[name] = `threw: ${describe(error)}`;
    }
  };

  attempt("csmGetVersion");
  attempt("csmGetLatestMocVersion");
  return info;
}

function sampleCanvas(canvas: HTMLCanvasElement): {
  report: ProbeReport;
  data: Uint8ClampedArray | null;
} {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext("2d");
  if (!context) return { report: { error: "no 2d context for pixel sampling" }, data: null };
  context.drawImage(canvas, 0, 0);

  const { data } = context.getImageData(0, 0, copy.width, copy.height);
  let opaquePixels = 0;
  let transparentPixels = 0;
  let minX = copy.width;
  let minY = copy.height;
  let maxX = -1;
  let maxY = -1;
  const colors = new Set<number>();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 16) {
      transparentPixels += 1;
      continue;
    }
    opaquePixels += 1;
    colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    const pixel = i / 4;
    const x = pixel % copy.width;
    const y = Math.floor(pixel / copy.width);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return {
    report: {
      canvas: `${copy.width}x${copy.height}`,
      opaquePixels,
      transparentPixels,
      distinctColors: colors.size,
      boundingBox: maxX < 0 ? null : { minX, minY, maxX, maxY },
    },
    data,
  };
}

/** Counts pixels that changed noticeably between two captured frames. */
function countChangedPixels(before: Uint8ClampedArray, after: Uint8ClampedArray): number {
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (
      Math.abs(before[i] - after[i]) > 8 ||
      Math.abs(before[i + 1] - after[i + 1]) > 8 ||
      Math.abs(before[i + 2] - after[i + 2]) > 8 ||
      Math.abs(before[i + 3] - after[i + 3]) > 8
    ) {
      changed += 1;
    }
  }
  return changed;
}

async function main() {
  report.userAgent = navigator.userAgent;
  report.devicePixelRatio = window.devicePixelRatio;
  report.webgl2 = (() => {
    try {
      const probe = document.createElement("canvas");
      return probe.getContext("webgl2") !== null;
    } catch (error) {
      return `threw: ${describe(error)}`;
    }
  })();
  report.core = readCoreRuntime();

  const definitions = await fetch(MODEL_URL).then((response) => response.json());
  report.model = {
    url: MODEL_URL,
    version: definitions.Version,
    motionGroups: Object.fromEntries(
      Object.entries(definitions.FileReferences?.Motions ?? {}).map(([group, list]) => [
        group,
        (list as unknown[]).length,
      ]),
    ),
    expressions: Object.keys(definitions.FileReferences?.Expressions ?? {}).length,
    hitAreas: (definitions.HitAreas ?? []).map((area: { Name?: string }) => area.Name),
    parameterGroups: definitions.Groups?.map((group: { Name: string }) => group.Name) ?? [],
  };

  extensions.add(Live2DPlugin);
  const app = new Application();
  await app.init({
    width: 400,
    height: 440,
    preference: "webgl",
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    // The Aiki pet window is transparent; the renderer must not paint an opaque backdrop.
    backgroundAlpha: 0,
    // Required so the probe can read the composited WebGL frame back through a 2D canvas.
    preserveDrawingBuffer: true,
  });
  document.getElementById("stage")!.appendChild(app.canvas);

  report.renderer = (() => {
    try {
      const renderer = app.renderer as unknown as {
        name?: string;
        type?: number;
        gl?: WebGL2RenderingContext;
      };
      return {
        name: renderer.name,
        type: renderer.type,
        glVersion: renderer.gl?.getParameter(renderer.gl.VERSION),
        glRenderer: renderer.gl?.getParameter(renderer.gl.RENDERER),
      };
    } catch (error) {
      return { error: describe(error) };
    }
  })();

  const loadStartedAt = performance.now();
  const model = await Live2DModel.from(MODEL_URL);
  report.loadMs = Math.round(performance.now() - loadStartedAt);
  report.modelSize = { width: model.width, height: model.height };

  app.stage.addChild(model);
  model.anchor.set(0.5);
  // Hiyori is ~1203x3778 px of model space; 0.1 keeps the whole figure inside a 400x440 canvas.
  model.scale.set(0.1);
  model.position.set(200, 230);

  await sleep(700);
  const before = sampleCanvas(app.canvas);
  report.frameBeforeMotion = before.report;

  model.motion("Idle", 0);
  await sleep(900);
  const during = sampleCanvas(app.canvas);
  report.frameDuringMotion = during.report;
  report.changedPixelsVsFirstFrame =
    before.data && during.data ? countChangedPixels(before.data, during.data) : null;

  report.motionDispatch = {
    known: (() => {
      try {
        model.motion("Idle", 1);
        return "ok";
      } catch (error) {
        return `threw: ${describe(error)}`;
      }
    })(),
    unknownGroup: (() => {
      try {
        model.motion("__no_such_group__", 0);
        return "ok";
      } catch (error) {
        return `threw: ${describe(error)}`;
      }
    })(),
    unknownIndex: (() => {
      try {
        model.motion("Idle", 999);
        return "ok";
      } catch (error) {
        return `threw: ${describe(error)}`;
      }
    })(),
  };

  report.expressionDispatch = (() => {
    try {
      model.expression("__no_such_expression__");
      return "ok";
    } catch (error) {
      return `threw: ${describe(error)}`;
    }
  })();

  report.hitTest = (() => {
    try {
      return model.hitTest(200, 250) ?? null;
    } catch (error) {
      return `threw: ${describe(error)}`;
    }
  })();

  (window as unknown as { __probeMotion: (g: string, i: number) => void }).__probeMotion = (
    group,
    index,
  ) => model.motion(group, index);

  report.done = true;
  render();
}

function render() {
  const log = document.getElementById("log");
  if (log) log.textContent = JSON.stringify(report, null, 2);
}

main().catch((error) => {
  report.fatal = error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.done = true;
  render();
});
