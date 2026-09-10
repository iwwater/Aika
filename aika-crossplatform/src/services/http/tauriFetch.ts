import { fetch as pluginFetch } from "@tauri-apps/plugin-http";
import type { HttpFetch } from "./tokens";

/**
 * 桌面请求出口。
 *
 * 走 http 插件：它从 Rust 侧发请求，不受 WebView 的同源策略约束。
 * 本地 Whisper 服务尤其需要这一点——`http://127.0.0.1:8080` 对应用页面来说是
 * 跨源的，指望对方一定配好 CORS 头是不牢靠的。
 */
export function createTauriFetch(): HttpFetch {
  return (input, init) => pluginFetch(input, init);
}
