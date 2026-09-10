import { token } from "../../kernel";
import type { RemoteHost } from "./bridge";

/**
 * 远程（手机端）宿主能力。
 *
 * 只有桌面宿主注册它。浏览器宿主**不注册**——消费方在 optional 里声明并
 * tryResolve，拿到 null 就隐藏入口。不注册一个「假装存在但会抛错」的实现。
 */
export const RemoteHostToken = token<RemoteHost>("remote.host");
