/**
 * 权限策略（RT-03）。
 *
 * read/write/execute/external 分项：默认只自动放行 workspace 内的 read；
 * write/execute/external 一律要走审批；支付/账户/危险动作默认拒绝。
 * **没有 approve-all，桌面也不因 origin=desktop 自动全权限**——桌面动作与
 * 外部动作走同一张策略表。
 */

import type { PermissionCategory } from "../../domain/permission";
import { PERMISSION_POLICY_VERSION } from "../../domain/permission";

export type PolicyDecision = "allow" | "require-approval" | "deny";

export interface PolicyInput {
  category: PermissionCategory;
  /** 动作 kind；危险动作（支付/账户/删除全部…）按名单显式拒绝。 */
  kind: string;
  /** 提交请求的主体；unknown 一律拒绝（由 runtime 兜底，这里再挡一层）。 */
  principalId?: string;
}

export interface PermissionPolicy {
  readonly version: number;
  decide(input: PolicyInput): PolicyDecision;
  /**
   * 谁能批准：本地主体总是可以；绑定的外部主体只能批自己会话的请求；
   * **群聊不能批准高权限动作**（write/execute/external）。
   */
  canApprove(input: { category: PermissionCategory; approverPrincipalId: string; requestPrincipalId: string; isGroupConversation: boolean }): boolean;
}

export const DEFAULT_POLICY_VERSION = PERMISSION_POLICY_VERSION;

/** 默认拒绝的动作名单（按 kind 前缀匹配；区分大小写）。 */
const ALWAYS_DENY_KINDS = ["payment", "billing", "account.delete", "credential", "danger."];

export function createDefaultPolicy(): PermissionPolicy {
  return {
    version: DEFAULT_POLICY_VERSION,

    decide(input) {
      if (!input.principalId?.trim() || input.principalId === "unknown") return "deny";
      if (ALWAYS_DENY_KINDS.some((prefix) => input.kind === prefix || input.kind.startsWith(prefix))) {
        return "deny";
      }
      switch (input.category) {
        case "read":
          return "allow";
        case "write":
        case "execute":
        case "external":
          return "require-approval";
        default:
          return "deny";
      }
    },

    canApprove(input) {
      if (input.isGroupConversation) {
        // 群聊里任何人（包括本地主体）都不能批准高权限动作。
        return input.category === "read";
      }
      // 本地主体可以批；外部主体只能批自己名下的请求。
      if (input.approverPrincipalId === "local") return true;
      return input.approverPrincipalId === input.requestPrincipalId;
    },
  };
}

/**
 * 无策略能力的兜底（RT-03-C）：**拒绝执行而非 fail-open**。
 * runtime 拿不到策略服务时装配这个实例，decide 恒为 deny。
 */
export function createDenyAllPolicy(): PermissionPolicy {
  return {
    version: DEFAULT_POLICY_VERSION,
    decide: () => "deny",
    canApprove: () => false,
  };
}
