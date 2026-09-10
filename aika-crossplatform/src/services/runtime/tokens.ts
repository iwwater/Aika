import { token } from "../../kernel";
import type { CompanionRuntime, RuntimeProvider } from "./companionRuntime";
import type { ProviderSettings } from "./providerSettings";

/**
 * Runtime 相关的服务标识。
 *
 * 沿用 companionRuntime.ts 已有的 `CompanionRuntime` / `RuntimeProvider`，
 * 不重新造接口——LLM-02 已经把它们验收过了，这里只负责给它们配 token。
 */

export const RuntimeToken = token<CompanionRuntime>("llm.runtime");
export const ProviderToken = token<RuntimeProvider>("llm.provider");
export const ProviderSettingsToken = token<ProviderSettings>("llm.providerSettings");
