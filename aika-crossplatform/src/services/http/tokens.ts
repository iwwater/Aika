import { token } from "../../kernel";

/**
 * 请求出口端口。
 *
 * 这里不 import @tauri-apps，好让只需要 token 的消费方不被平台实现拖进依赖图。
 * 桌面实现在 tauriFetch.ts。
 */
export type HttpFetch = (input: string, init: RequestInit) => Promise<Response>;

export const FetchToken = token<HttpFetch>("http.fetch");
