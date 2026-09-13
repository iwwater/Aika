/**
 * 全仓唯一判断「我在哪个平台」的地方。
 *
 * 在这之前，同一个 `"__TAURI_INTERNALS__" in globalThis` 散在六处：存储、密钥、
 * 两份 http、remote 桥、还有 Hook 里的通知。每加一个平台差异就多一处，且没有
 * 任何机制保证它们判断一致。
 *
 * 现在它只出现在这一个函数里，并且**它返回插件，不返回能力**——上层拿到的是
 * 「装哪些插件」，永远不需要再问一次「我是不是在桌面上」。
 * 由 CORE-02-C 的静态扫描守住。
 */
export function isTauriHost(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

/**
 * 当前 Tauri 窗口 label；非 Tauri 宿主返回 null（FE-20 的 pet 窗口分流依据）。
 * 平台判断收在 detect.ts，主入口只问 label，不碰 internals。
 */
export function currentWindowLabel(): string | null {
  if (!isTauriHost()) return null;
  const metadata = (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: unknown } } } })
    .__TAURI_INTERNALS__?.metadata;
  const label = metadata?.currentWindow?.label;
  return typeof label === "string" ? label : null;
}
