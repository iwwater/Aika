/**
 * 身份与会话契约（RT-01）。
 *
 * 分别冻结 identity / conversation / thread / runtimeTurn / agentSession /
 * deviceSession 六个概念——它们经常被混成一个「会话」，混起来之后权限就没法
 * 表达了（RT-02/RT-03 要靠这些边界）。全部带 version 字段：外部入口进来的是
 * 版本化协议，不是裸字符串。
 *
 * RT-01 只冻结形状与语义边界；实际隔离由 RT-02 完成，权限由 RT-03 完成。
 * 在那之前，这些类型的存在**不**声称系统已经多会话安全。
 */

import { SOURCE_ENVELOPE_SCHEMA_VERSION } from "./sourceEnvelope";

/** identity：可被授权的实体。 */
export type PrincipalKind = "user" | "agent" | "service";

export interface PrincipalIdentityV1 {
  version: 1;
  principalId: string;
  kind: PrincipalKind;
  displayName?: string;
}

/**
 * 账户键（RT-02）：外部入口的唯一身份定位。
 * 四元组缺一不可——只有 platform+sender 会把同一平台的不同机器人/租户混成一人；
 * 外部声明「我是 userId X」不构成身份，身份由绑定关系给（RT-02-A）。
 */
export interface AccountKeyV1 {
  version: 1;
  platform: string;
  botAccount: string;
  tenant: string;
  sender: string;
}

/**
 * 会话 scope（RT-02）：一轮/一段历史的隔离边界。
 * conversation 之外还有 chat/thread：同账户的群聊与私聊是不同 scope，
 * 不共享历史与敏感记忆。
 */
export interface ConversationScopeV1 {
  conversationId: string;
  principalId: string;
  threadId?: string;
}

/** 本地桌面的固定标识（RT-01 桌面适配与 RT-02 legacy 归属共用）。 */
export const LOCAL_CONVERSATION_ID = "local";
export const LOCAL_PRINCIPAL_ID = "local";

/** 本地桌面 scope：旧数据全部映射到这里，可回退（RT-02-D）。 */
export const LOCAL_CONVERSATION_SCOPE: ConversationScopeV1 = {
  conversationId: LOCAL_CONVERSATION_ID,
  principalId: LOCAL_PRINCIPAL_ID,
};

/**
 * scope 的规范键：存储列/去重键/排序键都用它，绝不用调用方拼的裸字符串——
 * 拼接口径不一就是在造跨 tenant 混键。
 */
export function canonicalScopeKey(scope: Pick<ConversationScopeV1, "conversationId" | "threadId">): string {
  return scope.threadId ? `${scope.conversationId}#${scope.threadId}` : scope.conversationId;
}

/** 账户键的规范形式：绑定关系的查找键。 */
export function canonicalAccountKey(account: Pick<AccountKeyV1, "platform" | "botAccount" | "tenant" | "sender">): string {
  return [account.platform, account.botAccount, account.tenant, account.sender].map((part) => encodeURIComponent(part)).join(":");
}

/** conversation：一段连续对话的归属单位（账本、权限、历史都以它为界）。 */
export interface ConversationV1 {
  version: 1;
  conversationId: string;
  principalId: string;
  createdAt: number;
}

/** thread：conversation 内的串行线程。本地桌面默认单线程。 */
export interface ThreadRefV1 {
  conversationId: string;
  threadId: string;
}

/**
 * runtimeTurn：CompanionRuntime 里的一轮（既有 turnId，uuid）。
 * 它是编排层概念：一轮 = 一次 submit 到一次结算，与 conversation/thread 是
 * 包含关系而不是同一物。
 */
export interface RuntimeTurnRefV1 {
  conversationId: string;
  threadId: string;
  runtimeTurnId: string;
}

/** agentSession：Agent 会话引用（AGT-01 落地前的形状冻结）。 */
export interface AgentSessionRefV1 {
  version: 1;
  sessionId: string;
  principalId: string;
  conversationId: string;
}

/** deviceSession：一台设备上的一份宿主实例。hostEpoch 区分重启。 */
export interface DeviceSessionV1 {
  version: 1;
  deviceId: string;
  /** 宿主 epoch：每次宿主进程启动生成的新值；同 epoch = 同一次存活期。 */
  hostEpoch: string;
  startedAt: number;
}

/** 本协议冻结的版本号。外部字段扩展先加 version，不改旧字段含义。 */
export const IDENTITY_CONTRACT_SCHEMA_VERSION = 1;

/**
 * 宿主能力矩阵：这台机器这次存活期能做什么。
 * 由内核 describe() 的插件清单投影而来——矩阵是**观测结果**，
 * 不是愿望清单；没装的能力如实为 false。
 */
export interface HostCapabilityMatrixV1 {
  version: 1;
  hostEpoch: string;
  protocolVersions: {
    /** 信封协议（sourceEnvelope）。 */
    sourceEnvelope: number;
    /** 身份/会话契约（本文件）。 */
    identityContract: number;
  };
  capabilities: {
    storage: boolean;
    memory: boolean;
    knowledge: boolean;
    runtime: boolean;
    trace: boolean;
    usageLedger: boolean;
    remote: boolean;
  };
  generatedAt: number;
}

/** 内核 describe() 的最小投影输入（避免 domain 依赖 kernel）。 */
export interface PluginCapabilityReport {
  id: string;
  provides: readonly string[];
}

export function buildCapabilityMatrix(
  hostEpoch: string,
  plugins: readonly PluginCapabilityReport[],
  now: number,
): HostCapabilityMatrixV1 {
  const provided = new Set<string>();
  for (const plugin of plugins) {
    for (const token of plugin.provides) provided.add(token);
  }
  return {
    version: 1,
    hostEpoch,
    protocolVersions: {
      sourceEnvelope: SOURCE_ENVELOPE_SCHEMA_VERSION,
      identityContract: IDENTITY_CONTRACT_SCHEMA_VERSION,
    },
    capabilities: {
      storage: provided.has("host.storage") || provided.has("core.storage"),
      memory: provided.has("llm.memory") || provided.has("llm.memoryAccess"),
      knowledge: provided.has("llm.knowledge") || provided.has("llm.contextSources"),
      runtime: provided.has("llm.runtime"),
      trace: provided.has("llm.traceRecorder"),
      usageLedger: provided.has("llm.usageLedger"),
      remote: provided.has("host.remote"),
    },
    generatedAt: now,
  };
}
