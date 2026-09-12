import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 单 Runtime 宿主边界（RT-01-B）。
 *
 * 外部入口（现在的桌面 UI，将来的 ACP/远程通道）只能通过**同一个** Runtime
 * facade（`RuntimeToken` → `CompanionRuntime`）提交、取消、拿事件；不允许任何
 * 入口绕过 facade 直接摸编排本体，也不允许 UI 与将来的 ACP 各持一份互相同步的
 * 状态。这条是门禁：谁 new 了第二个编排，测试当场红。
 */

const SRC_DIR = join(__dirname, "..");

/** 生产代码里允许 import RuntimeToken（facade 句柄）的白名单（POSIX 相对路径）。 */
const RUNTIME_TOKEN_WHITELIST = [
  "app/composition.ts",
  "app/plugins/runtimePlugin.ts",
  "app/plugins/presentationPlugin.ts",
  "services/runtime/tokens.ts",
];

/** 允许 import companionRuntime 本体（类型/实现）的白名单。 */
const COMPANION_RUNTIME_WHITELIST = [
  "services/runtime/companionRuntime.ts",
  "services/runtime/tokens.ts",
  "services/runtime/providerAdapter.ts",
  "services/runtime/provider.conformance.ts",
  "app/plugins/runtimePlugin.ts",
];

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

/** 去注释再匹配，避免这份文件自己（以及普通注释里的字面量）误伤。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const productionSources = walk(SRC_DIR).filter((file) => !isTest(file));
const relOf = (file: string) => relative(SRC_DIR, file).replace(/\\/g, "/");

describe("单 Runtime facade（RT-01-B）", () => {
  it("生产源码只在白名单位置使用 RuntimeToken", () => {
    const offenders = productionSources
      .filter((file) => !RUNTIME_TOKEN_WHITELIST.includes(relOf(file)))
      .filter((file) => {
        // runtime/tokens 里还有 ProviderSettings 等无关 token；门禁只认 facade 句柄本身。
        const source = stripComments(readFileSync(file, "utf8"));
        return /from\s+["'][^"']*runtime\/tokens["']/.test(source) && /\bRuntimeToken\b/.test(source);
      });
    expect(offenders.map(relOf)).toEqual([]);
  });

  it("生产源码只在白名单位置 import companionRuntime 本体", () => {
    const offenders = productionSources
      .filter((file) => !COMPANION_RUNTIME_WHITELIST.includes(relOf(file)))
      .filter((file) => /from\s+["'][^"']*companionRuntime["']/.test(stripComments(readFileSync(file, "utf8"))));
    expect(offenders.map(relOf)).toEqual([]);
  });
});
