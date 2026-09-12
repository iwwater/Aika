import { token } from "../../kernel";
import type { UsageLedgerRecorder, UsageLedgerStore } from "./contracts";

/**
 * 用量台账 recorder 的注册表 token（LLM-12）。
 *
 * 是可选能力：没装 usagePlugin 时 adapter/extractor 原样发请求，不记账。
 */
export const UsageLedgerToken = token<UsageLedgerRecorder>("llm.usageLedger");
/**
 * 台账的只读查询端口（FE-26 成本页经 OpsPresenter 消费）。与 recorder 一起由
 * usagePlugin 提供；不装插件就不注册，页面负责显示「没有采集」。
 */
export const UsageLedgerStoreToken = token<UsageLedgerStore>("llm.usageLedgerStore");
