import type { Clock } from "../time/tokens";

/**
 * 离线英文 OCR（FE-21）。
 *
 * tesseract.js（WASM）**懒加载**：只在屏幕感知开启后的首次识别时创建 worker；
 * eng traineddata 与 wasm 全部走本地文件，不运行时外联（安装包离线归 FE-30 验证）。
 *
 * 资源口径（2026-09-14 修订冻结）：离线资源加载超时 15000ms、单次识别超时 5000ms；
 * 超时终止并清理 worker，本次无事件，不无限重试——用户再次启用可重新初始化
 * （`reset()`）。
 */

export const OCR_LOAD_TIMEOUT_MS = 15_000;
export const OCR_RECOGNIZE_TIMEOUT_MS = 5_000;

export interface OcrWordConfidence {
  word: string;
  /** 0..1 归一化后。 */
  confidence: number;
}

export interface OcrResult {
  text: string;
  words: readonly OcrWordConfidence[];
}

export interface OcrTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OcrEngineOptions {
  /** traineddata 所在目录（node/测试：本地路径；Tauri：resource 目录）。 */
  langPath: string;
  /** tesseract.js-core wasm 与 worker 脚本所在目录；缺省用包内默认。 */
  corePath?: string;
  loadTimeoutMs?: number;
  recognizeTimeoutMs?: number;
  clock?: Clock;
  timers?: OcrTimers;
}

export type OcrEngineState = "uninitialized" | "loading" | "ready" | "failed" | "disposed";

export interface OcrEngine {
  /** 单次识别；失败/超时返回 null（本次无事件）。 */
  recognize(pngBase64: string): Promise<OcrResult | null>;
  /** 终止并清理 worker；之后可重新初始化（幂等）。 */
  dispose(): Promise<void>;
  /** dispose 后允许再次使用（重新建 worker）。 */
  reset(): void;
  state(): OcrEngineState;
}

type TesseractWorker = {
  recognize: (image: unknown, options?: unknown, output?: unknown) => Promise<{ data: unknown }>;
  terminate: () => Promise<unknown>;
};

interface TesseractWord {
  text?: unknown;
  confidence?: unknown;
}

/** 从 tesseract blocks 树里收集词级置信度；结构变化时安全降级为空表。 */
function collectWords(data: unknown): OcrWordConfidence[] {
  const words: OcrWordConfidence[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.words)) {
      for (const word of record.words as TesseractWord[]) {
        if (!word || typeof word !== "object") continue;
        if (typeof word.text === "string" && typeof word.confidence === "number" && Number.isFinite(word.confidence)) {
          const clean = word.text.trim().toLowerCase();
          if (clean) words.push({ word: clean, confidence: Math.max(0, Math.min(1, word.confidence / 100)) });
        }
      }
    }
    for (const key of ["blocks", "paragraphs", "lines"]) {
      const list = record[key];
      if (Array.isArray(list)) for (const child of list) visit(child);
    }
  };
  visit(data);
  return words;
}

const systemTimers: OcrTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as never),
};

export function createOcrEngine(options: OcrEngineOptions): OcrEngine {
  const loadTimeoutMs = options.loadTimeoutMs ?? OCR_LOAD_TIMEOUT_MS;
  const recognizeTimeoutMs = options.recognizeTimeoutMs ?? OCR_RECOGNIZE_TIMEOUT_MS;
  const timers = options.timers ?? systemTimers;

  let engineState: OcrEngineState = "uninitialized";
  let worker: TesseractWorker | null = null;
  let initializing: Promise<TesseractWorker | null> | null = null;

  async function ensureWorker(): Promise<TesseractWorker | null> {
    if (worker) return worker;
    if (initializing) return initializing;
    engineState = "loading";
    let timer: unknown = null;
    const attempt = (async () => {
      const { createWorker } = await import("tesseract.js");
      return createWorker("eng", 1, {
        langPath: options.langPath,
        gzip: false,
        ...(options.corePath ? { corePath: options.corePath } : {}),
      }) as Promise<TesseractWorker>;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error("ocr load timeout")), loadTimeoutMs);
    });
    timeout.catch(() => undefined); // 输赢已定时另一侧的拒绝不再是 unhandled。
    initializing = Promise.race([attempt, timeout])
      .then((created) => {
        worker = created;
        engineState = "ready";
        return created;
      })
      .catch(() => {
        engineState = "failed";
        return null;
      })
      .finally(() => {
        if (timer !== null) timers.clearTimeout(timer);
        initializing = null;
      }) as Promise<TesseractWorker | null>;
    return initializing;
  }

  return {
    async recognize(pngBase64: string): Promise<OcrResult | null> {
      if (engineState === "disposed" || engineState === "failed") return null;
      const active = await ensureWorker();
      if (!active) return null;
      let timer: unknown = null;
      try {
        // tesseract.js 在 node 下把裸 base64 当文件路径：统一包成 data URL。
        const input = pngBase64.startsWith("data:") ? pngBase64 : `data:image/png;base64,${pngBase64}`;
        const result = await new Promise<{ data: unknown }>((resolve, reject) => {
          timer = timers.setTimeout(() => reject(new Error("ocr recognize timeout")), recognizeTimeoutMs);
          active.recognize(input, {}, { blocks: true, text: true }).then(resolve, reject);
        });
        const data = result.data as { text?: unknown };
        return {
          text: typeof data?.text === "string" ? data.text : "",
          words: collectWords(result.data),
        };
      } catch {
        // 识别超时/失败：终止并清理 worker，本次无事件；reset 后可重建。
        engineState = "failed";
        worker = null;
        void active.terminate().catch(() => undefined);
        return null;
      } finally {
        if (timer !== null) timers.clearTimeout(timer);
      }
    },

    async dispose(): Promise<void> {
      const active = worker;
      worker = null;
      initializing = null;
      if (engineState !== "disposed") engineState = "disposed";
      if (active) {
        try {
          await active.terminate();
        } catch {
          // 终止失败不抛：worker 已从本引擎剥离。
        }
      }
    },

    reset(): void {
      if (engineState === "disposed") return;
      engineState = "uninitialized";
      worker = null;
      initializing = null;
    },

    state(): OcrEngineState {
      return engineState;
    },
  };
}
