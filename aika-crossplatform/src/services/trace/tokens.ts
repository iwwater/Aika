import { token } from "../../kernel";
import type { TraceRecorder } from "./traceRecorder";
import type { TraceSink } from "./contracts";
import type { TraceSettingsService } from "./traceSettings";

/**
 * Trace 能力的两个 token。
 *
 * 按 CORE-02-D 的规则定义在它们描述的接口旁边，不进任何中央清单。
 *
 * 能力缺失即不注册：生产构建默认关掉 Trace 时，宿主根本不 provide 这两个 token，
 * 消费方在 `optional` 里声明并 `tryResolve`，拿到 null 就退回 `NO_TRACE`。
 */
export const TraceSinkToken = token<TraceSink>("llm.traceSink");
export const TraceRecorderToken = token<TraceRecorder>("llm.traceRecorder");
export const TraceSettingsToken = token<TraceSettingsService>("llm.traceSettings");
