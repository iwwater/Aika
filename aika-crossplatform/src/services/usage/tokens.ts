import { token } from "../../kernel";
import type { UsageLedgerRecorder } from "./contracts";

/**
 * 用量台账 recorder 的注册表 token（LLM-12）。
 *
 * 是可选能力：没装 usagePlugin 时 adapter/extractor 原样发请求，不记账。
 */
export const UsageLedgerToken = token<UsageLedgerRecorder>("llm.usageLedger");
