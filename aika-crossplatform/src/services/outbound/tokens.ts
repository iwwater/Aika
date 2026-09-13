import { token } from "../../kernel";
import type { OutboundGateway } from "./outboundGateway";
import type { OutboundTransport } from "./contracts";

/**
 * Outbound 侧的服务标识。
 *
 * 分开成独立文件是为了让**宿主插件**（`app/hosts/plugins.ts`）能只依赖 token
 * 与类型，不必把 Gateway 的实现、Runtime 适配、模式归一化一起拖进宿主层。
 * 宿主只负责「这台机器有没有传输」，不负责「传输怎么用」。
 */

/** 远程出站网关（FE-14）。 */
export const OutboundGatewayToken = token<OutboundGateway>("outbound.gateway");

/**
 * 出站传输（FE-15 Tauri / FE-16 dev-relay）。
 *
 * **只有具备远程能力的宿主装它**：桌面宿主装 Tauri 传输，浏览器 dev 在
 * relay 可用时装 WS 传输。没有这个 token 时 outbound 插件照常注册网关
 * （本地投影可测），消费方 tryResolve 拿到 null 即按「无远程」降级。
 */
export const OutboundTransportToken = token<OutboundTransport>("outbound.transport");
