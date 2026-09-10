import { token } from "../../kernel";
import type { ContextSource } from "./contextAssembler";

/** 上下文来源集合。缺任何一个来源都不该让回复失败，降级由 Assembler 负责。 */
export const ContextSourcesToken = token<readonly ContextSource[]>("llm.contextSources");
