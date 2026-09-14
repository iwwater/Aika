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

/** 行级识别结果（FE-32）：全文读屏按阅读顺序保留行与行置信度。 */
export interface OcrLine {
  text: string;
  /** 0..1 归一化后。 */
  confidence: number;
}

export interface OcrResult {
  text: string;
  words: readonly OcrWordConfidence[];
  /**
   * 行级结果。FE-21 的词表轨不消费它（旧调用方不受影响）；FE-32 的全文读屏
   * 按它投影摘录。引擎结构变化时安全降级为空数组，不编造行。
   */
  lines?: readonly OcrLine[];
}

export interface OcrTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OcrEngineOptions {
  /** traineddata 所在目录（node/测试：本地路径；Tauri：resource 目录）。 */
  langPath: string;
  /**
   * tesseract 语言串（FE-32）。默认 `eng`（FE-21 词表轨口径不变）；
   * 中英文读屏用 `eng+chi_sim`，对应 traineddata 必须**离线**在 langPath 下，
   * 缺资源时 worker 创建失败 → state=failed → 本次无结果，不运行时外联补包。
   */
  languages?: string;
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

/**
 * 从 tesseract 结果里按阅读顺序收集行（FE-32）。
 *
 * 与 `collectWords` 同一个坑：扁平 `lines` 与 `blocks → paragraphs → lines`
 * 指向同一批行，全收会把每行数三遍——真实 `eng+chi_sim` 识别结果实测就是 3 倍。
 * 行被复读会白白吃掉 20 段 / 2000 字符的摘录预算，还会让模型看到重复内容。
 */
export function collectLines(data: unknown): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const node of descendToLines(data)) {
    if (!node || typeof node !== "object") continue;
    const line = node as Record<string, unknown>;
    const text = typeof line.text === "string" ? line.text.trim() : "";
    const confidence = typeof line.confidence === "number" && Number.isFinite(line.confidence)
      ? Math.max(0, Math.min(1, line.confidence / 100))
      : 0;
    if (text) lines.push({ text, confidence });
  }
  return lines;
}

/**
 * 从 tesseract 结果里收集词级置信度。
 *
 * **注意结构冗余**：`data` 同时给了扁平的 `words` 与嵌套的
 * `blocks → paragraphs → lines → words`，两者指向同一批词。全都收会把每个词
 * 数三遍，所以优先用最外层的扁平数组，没有再逐层下降。
 * 结构变化时安全降级为空表，不猜、不编。
 */
function collectWords(data: unknown): OcrWordConfidence[] {
  const words: OcrWordConfidence[] = [];
  const push = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const word = node as TesseractWord;
    if (typeof word.text !== "string" || typeof word.confidence !== "number" || !Number.isFinite(word.confidence)) return;
    const clean = word.text.trim().toLowerCase();
    if (clean) words.push({ word: clean, confidence: Math.max(0, Math.min(1, word.confidence / 100)) });
  };

  const flat = flatArray(data, "words");
  if (flat) {
    for (const node of flat) push(node);
    return words;
  }
  for (const line of descendToLines(data)) {
    const lineWords = flatArray(line, "words");
    if (lineWords) for (const node of lineWords) push(node);
  }
  return words;
}

/** 取 `node[key]` 这个数组；不是数组就返回 null。 */
function flatArray(node: unknown, key: string): readonly unknown[] | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

/**
 * 没有扁平 `lines` 时，按 blocks → paragraphs → lines 逐层找行。
 * 每层只取一条路径，避免同一批行被重复收集。
 */
function descendToLines(data: unknown): readonly unknown[] {
  const direct = flatArray(data, "lines");
  if (direct) return direct;
  const lines: unknown[] = [];
  for (const block of flatArray(data, "blocks") ?? []) {
    const paragraphs = flatArray(block, "paragraphs");
    if (paragraphs) {
      for (const paragraph of paragraphs) {
        for (const line of flatArray(paragraph, "lines") ?? []) lines.push(line);
      }
      continue;
    }
    for (const line of flatArray(block, "lines") ?? []) lines.push(line);
  }
  return lines;
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
      return createWorker(options.languages ?? "eng", 1, {
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
          lines: collectLines(result.data),
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
