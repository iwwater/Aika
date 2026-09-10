import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
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
  // CORE-05-F：内核不认识插件，组合根是唯一允许 import 插件的地方。
  /from\s+["'][^"']*\/app\//,
  /from\s+["']\.\.\/(domain|services|presentation|hooks|components|app)/,
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
  "app/kernelContext.tsx",
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

/** CORE-03-G：按 AST 限定 Provider 调用位置，注释或字符串不会影响结果。 */
function providerViolations(source: string): string[] {
  const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["streamChat", "sendChat"]);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (names.has(item.propertyName?.text ?? item.name.text)) names.add(item.name.text);
      }
    }
  }
  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && names.has(node.expression.getText(ast))) {
      let parent: ts.Node | undefined = node.parent;
      let legacy = false;
      // 主动消息的 Provider 只允许在 services ? kernel : legacy 的 false 分支。
      if (parent && ts.isAwaitExpression(parent)) parent = parent.parent;
      if (parent && ts.isConditionalExpression(parent)
        && parent.condition.getText(ast) === "services"
        && parent.whenFalse.getText(ast).includes(node.getText(ast))) legacy = true;
      for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
        if (ts.isVariableDeclaration(cursor) && cursor.name.getText(ast) === "sendViaLegacy") legacy = true;
        // CORE-04 后 legacy 编排是 Presenter 里的函数声明，同样属于隔离分支。
        if (ts.isFunctionDeclaration(cursor) && cursor.name?.getText(ast) === "sendViaLegacy") legacy = true;
      }
      if (!legacy) violations.push(node.expression.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return violations;
}

describe("CORE-03 kernel 编排门禁", () => {
  it("Provider 调用只有显式隔离的 legacy 分支", () => {
    // CORE-04 后编排搬进 Presenter：hooks 里不该再出现 Provider 调用，扫描面随之
    // 收缩到「Hook 适配器 + Presenter」两处。
    const scanned = [
      ...walk(join(SRC_DIR, "hooks")).filter((file) => !isTest(file)),
      ...walk(join(SRC_DIR, "presentation")).filter((file) => !isTest(file)),
    ];
    for (const file of scanned) {
      expect(providerViolations(readFileSync(file, "utf8")), relative(SRC_DIR, file)).toEqual([]);
    }
    const presenter = readFileSync(join(SRC_DIR, "presentation/companionPresenter.ts"), "utf8");
    const turn = presenter.slice(presenter.indexOf("async function sendTurn"), presenter.indexOf("async function send("));
    expect(turn).not.toMatch(/\bbusy\b|requestSeq|activeRequest/);
    expect(turn).toContain("services.runtime.submit(");
    // CORE-06：只有一条编排路径——没有 legacy 分支，也没有第二个 Provider 出口。
    expect(presenter).not.toMatch(/sendViaLegacy|sendViaKernel|providerClient|streamChat|sendChat/);
  });

  it("突变：新增直连、别名调用或移走主动开关都会被识别", () => {
    expect(providerViolations("const sendViaKernel = () => streamChat();")).toEqual(["streamChat"]);
    expect(providerViolations('import { sendChat as chat } from "../services/providerClient"; chat();')).toEqual(["chat"]);
    expect(providerViolations("const proactive = async () => await sendChat();")).toEqual(["sendChat"]);
    expect(providerViolations("const proactive = async () => services ? await kernel() : await sendChat();")).toEqual([]);
  });
});

describe("CORE-04 展示层门禁", () => {
  /** Hook 只允许 import token/类型，不得依赖 services 实现模块。 */
  const ADAPTER_HOOKS = [
    "hooks/useCompanionSession.ts",
    "hooks/useVoiceConversation.ts",
    "hooks/usePresenterSnapshot.ts",
  ];
  const SERVICES_IMPORT = /from\s+["'][^"']*\/services\//;
  const REACT_IMPORT = /from\s+["']react["']/;

  function countSourceLines(source: string): number {
    const all = source.split(/\r?\n/);
    return all.filter((line, index) => index < all.length - 1 || line.trim() !== "").length;
  }

  it("Hook 适配器不 import services 实现模块", () => {
    const offenders: string[] = [];
    for (const rel of ADAPTER_HOOKS) {
      if (SERVICES_IMPORT.test(readFileSync(join(SRC_DIR, rel), "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("useCompanionSession 不超过 150 行", () => {
    expect(countSourceLines(readFileSync(join(SRC_DIR, "hooks/useCompanionSession.ts"), "utf8")))
      .toBeLessThanOrEqual(150);
  });

  it("Presenter 不 import React：它要能在无 DOM 的 node 环境跑完一轮", () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC_DIR, "presentation")).filter((file) => !isTest(file))) {
      if (REACT_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it("Presenters 由注册表提供：presentation token 只在展示层定义", () => {
    const tokens = readFileSync(join(SRC_DIR, "presentation/tokens.ts"), "utf8");
    expect(tokens).toContain("presentation.companion");
    expect(tokens).toContain("presentation.voice");
  });

  it("突变：三条扫描都能真正报错，不是空跑", () => {
    // services 依赖：适配器放行 presentation/domain，检出 services；仍依赖 services
    // 的 useRemoteAccess（归 CORE-05）说明扫描面确实非空。
    expect(SERVICES_IMPORT.test('import { useService } from "../app/kernelContext";')).toBe(false);
    expect(SERVICES_IMPORT.test('import { x } from "../services/storage";')).toBe(true);
    expect(SERVICES_IMPORT.test(readFileSync(join(SRC_DIR, "hooks/useRemoteAccess.ts"), "utf8"))).toBe(true);

    // React 依赖：Presenter 不得出现，Hook 绑定层允许。
    expect(REACT_IMPORT.test('import React from "react";')).toBe(true);
    expect(REACT_IMPORT.test('import { token } from "../kernel";')).toBe(false);

    // 行数：151 行必须判超，150 行放行。
    expect(countSourceLines(Array.from({ length: 151 }, () => "x").join("\n"))).toBe(151);
    expect(countSourceLines(Array.from({ length: 150 }, () => "x").join("\n"))).toBe(150);
  });
});

describe("CORE-05 插件隔离与扩展点", () => {
  const PLUGINS_DIR = join(SRC_DIR, "app/plugins");
  const PLUGIN_IMPORT = /from\s+["']\.\/[^"']*Plugin["']/;

  it("插件之间不直接 import 对方模块（index 只做聚合，不是插件）", () => {
    const offenders: string[] = [];
    for (const file of walk(PLUGINS_DIR)) {
      if (isTest(file) || basename(file) === "index.ts") continue;
      if (PLUGIN_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it("内核不 import 任何插件或组合根", () => {
    const offenders = kernelSources
      .filter((file) => /\/app\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });

  it("App.tsx 不感知插件：新增能力不需要改界面", () => {
    const app = readFileSync(join(SRC_DIR, "App.tsx"), "utf8");
    // 允许 import `app/kernelContext`（useService 取依赖），但不许 import 任何插件。
    expect(app).not.toMatch(/app\/plugins/);
  });

  it("突变：插件互相 import 会被识别", () => {
    expect(PLUGIN_IMPORT.test('import { voicePlugin } from "./voicePlugin";')).toBe(true);
    expect(PLUGIN_IMPORT.test('import { SpeechEnginesToken } from "../../services/voice/tokens";')).toBe(false);
  });

  it("示例插件只在插件索引里加一行注册", () => {
    const index = readFileSync(join(PLUGINS_DIR, "index.ts"), "utf8");
    expect(index).toContain("sampleCapabilityPlugin");
    // 能力本身定义在它自己的文件里；索引只负责把它暴露出来。
    const sample = readFileSync(join(PLUGINS_DIR, "sampleCapabilityPlugin.ts"), "utf8");
    expect(sample).toContain("sample.capability");
    expect(sample).toContain("SampleCapabilityToken");
  });
});

describe("CORE-06 单一编排与契约冻结", () => {
  const LEGACY_MARKERS = /sendViaLegacy|activeRuntimeServices|normalizeOrchestrator|core\.orchestrator/;

  it("生产代码里没有编排开关与 legacy 编排残留", () => {
    const offenders: string[] = [];
    for (const file of productionSources) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, "/");
      if (LEGACY_MARKERS.test(read(file))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("providerClient 的调用方只剩 Runtime 适配器与记忆抽取", () => {
    const offenders: string[] = [];
    for (const file of productionSources) {
      const source = readFileSync(file, "utf8");
      if (!/from\s+["'][^"']*providerClient["']/.test(source)) continue;
      const rel = relative(SRC_DIR, file).replace(/\\/g, "/");
      if (rel === "services/runtime/providerAdapter.ts" || rel === "services/memory/extractor.ts") continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("内核与 Presenter 的测试不依赖 hookHarness 或 React 替身", () => {
    const harnessPattern = /hookHarness|vi\.mock\(\s*["']react/;
    const offenders: string[] = [];
    const dirs = [join(SRC_DIR, "kernel"), join(SRC_DIR, "presentation")];
    for (const file of dirs.flatMap((dir) => walk(dir)).filter(isTest)) {
      // 门禁自身会包含上面的字面量，跳过它。
      if (basename(file) === "architecture.test.ts") continue;
      if (harnessPattern.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it("hookHarness 仍被 Hook 适配器测试使用（按 SPEC 保留，不静默删除）", () => {
    // 删除清单的前提是「Presenter 测试不再需要」；Hook 适配器测试仍 import 它。
    const adapter = readFileSync(join(SRC_DIR, "hooks/useCompanionSession.integration.test.ts"), "utf8");
    expect(/from\s+["']\.\/hookHarness["']/.test(adapter)).toBe(true);
  });

  it("旧设置项常量已删除，旧库里的值不会被代码读到", () => {
    // 只看代码（剥掉注释）：`core.orchestrator` 这个键名允许作为历史说明留在注释里。
    expect(read(join(SRC_DIR, "services/storage/contracts.ts"))).not.toContain("core.orchestrator");
  });

  it("突变：残留 legacy 标记会被识别", () => {
    expect(LEGACY_MARKERS.test("const key = 'core.orchestrator';")).toBe(true);
    expect(LEGACY_MARKERS.test("function sendViaLegacy() {}")).toBe(true);
    expect(LEGACY_MARKERS.test("services.runtime.submit(request);")).toBe(false);
  });
});

/** CORE-02-D：token 分散所有权，不存在汇总桶。 */
const BUCKET_NAMES = /\b(CoreTokens|HostCapabilities|AppServices|ServiceTokens|AllTokens|CoreRegistry)\b/;
const TOKEN_REEXPORT = /export\s*(?:type\s*)?\{[^}]*\}\s*from\s*["']([^"']*\/tokens)["']/g;

/** 一个文件从哪些模块目录 re-export 了 token。 */
function tokenSourceDirs(source: string): Set<string> {
  const dirs = new Set<string>();
  for (const match of source.matchAll(TOKEN_REEXPORT)) {
    dirs.add(match[1].replace(/\/tokens$/, ""));
  }
  return dirs;
}

describe("CORE-02-D 无中央 token 清单", () => {
  it("不存在能力总表或 token 汇总桶", () => {
    const offenders = productionSources
      .filter((file) => BUCKET_NAMES.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });

  it("没有文件跨两个以上模块目录汇总导出 token", () => {
    const offenders: string[] = [];
    for (const file of productionSources) {
      if (tokenSourceDirs(readFileSync(file, "utf8")).size >= 2) offenders.push(relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it("突变：桶文件与跨模块汇总会被识别", () => {
    expect(BUCKET_NAMES.test("export interface CoreTokens extends Record<string, unknown> {}")).toBe(true);
    const bucket = [
      'export { RuntimeToken } from "../../services/runtime/tokens";',
      'export { StorageToken } from "../../services/storage/tokens";',
    ].join("\n");
    expect(tokenSourceDirs(bucket).size).toBe(2);
  });
});
