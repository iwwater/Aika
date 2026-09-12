import type {
  RequestUsageSample, UsageLedgerPage, UsageLedgerQuery, UsagePurpose, UsageRecordV1,
} from "../../domain/usageLedger";
import type { ProviderConfig } from "../../domain/providers";

/**
 * 用量台账的存储端口（LLM-12）。SQLite 落盘与浏览器临时存储两个实现提供
 * **相同的读写语义**：按 id 幂等 upsert、固定顺序查询、cursor 分页、保留期截断。
 */
export interface UsageLedgerStore {
  /** 按 record.id 幂等写入：同 id 后写覆盖先写（终态覆盖开始登记）。 */
  upsert(record: UsageRecordV1): Promise<void>;
  query(query?: UsageLedgerQuery): Promise<UsageLedgerPage>;
}

/**
 * 请求 options 里与台账相关的切片。结构兼容 providerClient 的
 * ProviderRequestOptions（多余字段原样保留、原样返回），但 usage 服务不 import
 * HTTP 客户端模块——架构门禁规定 providerClient 的调用方只有 Runtime 适配器
 * 与记忆抽取。
 */
export interface UsageRequestOptions {
  onRequestUsage?: (sample: RequestUsageSample) => void;
  requestPurpose?: "foreground" | "maintenance" | "summary" | "proactive";
  requestTurnId?: string;
}

/** 包装一次请求时实际调用方要交代的东西——purpose 由调用方赋值，这里不猜。 */
export interface UsageObserveInput<T extends UsageRequestOptions = UsageRequestOptions> {
  config: ProviderConfig;
  purpose: UsagePurpose;
  turnId?: string;
  /** 调用方原本的 options；返回值带着台账接线并保留全部原有字段。 */
  options?: T;
}

/** recorder 的诊断：写失败与丢弃都是旁路化的，但必须数得出来，不能静默。 */
export interface UsageRecorderDiagnostics {
  /** 已登记的物理尝试数（含尚未等到终态的）。 */
  registered: number;
  /** 存储写入失败次数（不重试、不影响原请求）。 */
  writeFailures: number;
  /** 待写队列满时丢弃的记录数。 */
  dropped: number;
}

export interface UsageLedgerRecorder {
  /**
   * 包装调用方的请求 options：登记每次物理尝试的开始、终态按 attemptId 幂等
   * upsert。采集开关关闭时整个请求不产生任何记录；返回值（原 options 的全部
   * 字段 + 台账接线）直接传给 sendChat/streamChat/requestJson。
   */
  observe<T extends UsageRequestOptions = UsageRequestOptions>(input: UsageObserveInput<T>): T;
  diagnostics(): UsageRecorderDiagnostics;
}
