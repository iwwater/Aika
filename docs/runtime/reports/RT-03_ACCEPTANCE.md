# RT-03 · Permission Runtime 与审批状态机 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全部通过，待人工审阅；真实宿主执行入口 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/permission.ts`（新增） | `PermissionRequestV1`（绑定 principal/conversation/agentSession/workspace/policyVersion/expiresAt/单次 nonce）、`PermissionActionV1`（kind+category+相对目标+`paramsDigestOf` 参数摘要——FNV-1a，原始参数不进请求）、`PermissionRecordV1`（pending→approved/rejected/expired/cancelled + `execution{executionId,consumedAt,cancelRequested?}`）、`MAX_PERMISSION_TTL_MS=10min`（过期封顶，不给永久批准留门）、`checkPathBoundary`（`..` 逃逸/相邻前缀 C:\work vs C:\worker/Windows 大小写不敏感/UNC 共享名边界/换盘/正反斜杠混用；`realPathOf` 注入真实解析防 junction-reparse-TOCTOU，解析失败即拒绝并区分 `assumedLexical`） |
| `aika-crossplatform/src/services/permission/permissionStore.ts`（新增） | 持久存储：同步内存 Map（check-and-set 原子窗口）+ KV 整份 JSON 原子替换持久化（`permission.requests.v1`）；损坏按空库处理（丢 pending ≠ 自动批准）；`pruneDecided` 防无界增长 |
| `aika-crossplatform/src/services/permission/permissionPolicy.ts`（新增） | 默认策略：read 自动放行、write/execute/external 一律审批、payment/billing/account.delete/credential/danger.* 名单默认拒绝；unknown 主体拒绝；`canApprove`：群聊不能批高权限动作（write/execute/external 一律不可，含本地主体）、外部主体只能批自己名下的请求；`createDenyAllPolicy` 无策略能力时 fail-closed 兜底 |
| `aika-crossplatform/src/services/permission/permissionRuntime.ts`（新增） | `request`（unknown/策略拒绝/路径越界在建请求前拒绝；路径边界检查与 `assumedLexical` 审计）、`approve`/`reject`/`cancel`（pending 限定、过期自动转 expired、策略版本一致）、`requestCancelAfterApproval`（不回滚决定：未认领→标记 `cancelRequested` 使认领被拒；已认领→报告 `consumed-or-executing;cancel-requested-cannot-revert-side-effects`）、`authorizeExecution`（最终授权检查：approved/cancelRequested/execution 已认领/principal/agentSession/nonce/paramsDigest 逐一比对后**原子认领恰好一次**）、`audit`（只含 who/when/requestId/event/paramsDigest，无原始参数字段） |
| `aika-crossplatform/src/services/storage/contracts.ts` | `SETTING_KEYS.permissionRequests` |
| `docs/modules/CONTRACTS.md` | 登记「2026-09-13，RT-03 权限」追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/domain/permission.test.ts src/services/permission` | 0 | 2 文件 25 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 99 文件 1193 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

### RT-03-A：重放/跨用户/跨会话/过期/参数变化全部拒绝

- 重放：同一 requestId+nonce 第二次 `authorizeExecution` → `already-consumed`（认领恰好一次）。
- 跨用户：ext-B 批准 ext-A 的请求 → `approver-not-authorized`；以 ext-B 身份认领 → `principal-mismatch`。
- 跨会话：agentSessionId 不匹配 → `agent-session-mismatch`。
- 过期：pending 超时后 approve → `expired` 且状态转 expired；执行 → `not-approved:expired`。
- 参数变化：执行时实际参数摘要与请求不一致 → `params-changed`；一致才通过。
- nonce 错误 → `nonce-mismatch`。

### RT-03-B：approve/cancel 并发仅一个终态，重启不自动批准

- 先 cancel 后 approve → `not-pending:cancelled`；终态互斥（pending 限定 + 内存 Map 原子 check-and-set，check 与 set 之间无 await）。
- 批准后撤销不回滚决定：未认领 → `cancelRequested` 使执行被拒（`cancel-requested`）；已认领 → 报告 `cannot-revert-side-effects`（副作用不可追回的如实口径）。
- 重启：pending 持久化到 KV，新实例（同库）里 authorizeExecution → `not-approved:pending`——没有任何路径会自动批准。

### RT-03-C：无策略能力拒绝执行而非 fail-open；审计脱敏

- `createDenyAllPolicy` 装配下 read 请求也 `policy-denied`；approve 一律拒绝。
- 审计脱敏：持久化全文 dump 不含原始参数文本（`src/a.ts` 不出现），只有 `paramsDigest`；审计结构本身没有原始参数字段——脱敏是结构性的，不是过滤。

### RT-03-D：分项策略与 Windows 路径边界

- 分项：read 自动 / write、execute、external 审批（逐 category 断言）+ 危险动作名单拒绝 + unknown 主体拒绝。
- 路径边界（`permission.test.ts`）：`..` 逃逸、相邻前缀、换盘、大小写不敏感、正反斜杠混用、UNC 同共享过/跨共享拒、junction（realPathOf 解析后越界拒）、解析失败拒（不猜）、界内真实解析通过且不标 `assumedLexical`、空路径拒。
- 无 approve-all：TTL 封顶 10 分钟；桌面主体（local）的动作同样走策略表与审批。

## 共享接口影响与消费者

- 全部为新增模块，无既有生产消费者被改动（全量回归通过）；`SETTING_KEYS.permissionRequests` 新增键。消费者矩阵：RT-04（来源信任）、AGT-02（Agent 拒绝写负例）、GW 宿主执行入口（`authorizeExecution` 是唯一执行门）。

## 未执行 / 待人工

- 真实宿主执行入口（宿主进程真正按 claim 结果执行文件/进程/外部动作）未接线——AGT-02/GW 真实轨前置；`realPathOf` 在真实宿主应接 `fs.realpath`，本份用注入 fake 验证判定逻辑。
- 真实多进程并发（两个宿主进程共享同一 KV）超出单进程原子性保证范围——MVP 明确单宿主进程（RT-01 宿主边界）。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表发布可用。
