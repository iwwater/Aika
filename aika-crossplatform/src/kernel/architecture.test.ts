import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 边界门禁。
 *
 * 「内核不知道有哪些业务能力」「resolve 只出现在三个地方」这类约束写在文档里
 * 只是口号，得有一条会失败的测试才算数。这份测试直接读源码来判，不靠自觉，
 * 也不引 lint 插件。
 *
 * 扫描前先剥掉注释：解释「内核为什么不认识 runtime」的中文说明是有价值的，
 * 真正要禁的是代码依赖业务概念。
 */

const KERNEL_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = dirname(KERNEL_DIR);

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function read(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

const kernelSources = walk(KERNEL_DIR).filter((file) => !isTest(file));
const productionSources = walk(SRC_DIR).filter(
  (file) => !isTest(file) && !file.startsWith(KERNEL_DIR),
);

/** 出现在内核代码里就说明内核开始认识业务了。 */
const BUSINESS_WORDS = [
  "runtime", "memory", "voice", "storage", "remote", "sticker",
  "companion", "mood", "whisper", "speech", "soul", "asr", "tts",
];

const FORBIDDEN_IMPORTS = [
  /from\s+["']react/,
  /from\s+["']react-dom/,
  /from\s+["']@tauri-apps/,
  /from\s+["'][^"']*\/domain\//,
  /from\s+["'][^"']*\/services\//,
  /from\s+["'][^"']*\/presentation\//,
  /from\s+["']\.\.\/(domain|services|presentation|hooks|components)/,
];

const FORBIDDEN_GLOBALS = [
  /\bwindow\./,
  /\bdocument\./,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /__TAURI_INTERNALS__/,
];

/** CORE-01-D 的白名单：组合根、插件 activate、useService。 */
const RESOLVE_WHITELIST: string[] = [
  "app/composition.ts",
];

/** CORE-02-C：平台判断只允许出现在这个目录下。 */
const HOST_DIR = "app/hosts/";

describe("内核边界门禁", () => {
  it("扫描到了内核源码，门禁不是空跑", () => {
    expect(kernelSources.length).toBeGreaterThanOrEqual(6);
  });

  it("内核不依赖 React、Tauri、DOM 或任何业务目录", () => {
    const offenders: string[] = [];
    for (const file of kernelSources) {
      const source = read(file);
      for (const pattern of [...FORBIDDEN_IMPORTS, ...FORBIDDEN_GLOBALS]) {
        if (pattern.test(source)) offenders.push(`${relative(SRC_DIR, file)} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("内核代码里不出现任何业务词汇", () => {
    const offenders: string[] = [];
    for (const file of kernelSources) {
      const source = read(file).toLowerCase();
      for (const word of BUSINESS_WORDS) {
        if (new RegExp(`\\b${word}`).test(source)) {
          offenders.push(`${relative(SRC_DIR, file)} :: ${word}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("内核一个 token 实例都不创建：token() 只有定义，没有调用", () => {
    const offenders: string[] = [];
    for (const file of kernelSources) {
      if (file.endsWith(`${join("kernel", "token.ts")}`)) continue;
      if (/\btoken\s*<[^>]*>\s*\(/.test(read(file))) offenders.push(relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it("registry.resolve 只允许出现在白名单文件里", () => {
    const offenders: string[] = [];
    for (const file of productionSources) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, "/");
      if (RESOLVE_WHITELIST.includes(rel)) continue;
      if (/\bregistry\s*\.\s*(try)?[Rr]esolve\s*\(/.test(read(file))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("平台判断只出现在宿主目录里", () => {
    const offenders: string[] = [];
    for (const file of productionSources) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, "/");
      if (rel.startsWith(HOST_DIR)) continue;
      if (/__TAURI_INTERNALS__/.test(read(file))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("内核测试跑在没有 DOM 的 node 环境里", () => {
    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");
  });
});
