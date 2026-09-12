# INT-01 验收报告 · 文本与接口（自动消费者列）

- 性质：**部分验收报告**（2026-09-13，goal worker）。只覆盖[执行计划](../../GOAL_EXECUTION_PLAN.md) Wave 2 授权的「可自动消费者检查」；按 [SPEC](../SPEC.md) 2026-09-13 冻结的逐项 AC 分列，**部分通过不标整项 PASS**。
- 基线 commit：`c0e7d17`。当前裁决：legacy 已删除，不测试恢复 legacy；只验唯一 Runtime、旧设置无害、双 id、兜底、Remote 路由。

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/app/composition.test.ts src/domain/remote.test.ts src/services/storage/storageCompatibility.test.ts src/services/storage/storage.conformance.test.ts src/services/runtime/companionRuntime.test.ts src/hooks/useCompanionSession.integration.test.ts` | 6 文件 / 109 passed | 0 |

## 逐项 AC（按证据列分记）

| AC | 自动契约列 | 真实宿主列 |
| --- | --- | --- |
| INT-01-A 生产链路/三模式/流式/取消迟到/持久化/装配兜底 | **PASS**：`useCompanionSession.integration`（流式、取消旧轮、错误可见）、`companionRuntime`（迟到结算不清新轮）、`composition`（兜底 Presenter、装配失败不白屏） | 浏览器页面证据 **NOT RUN**（人工队列） |
| INT-01-B 双 id/旧库字段兼容/legacy 设置忽略 | **PASS**：`storageCompatibility`（旧消息缺 S1 字段可读写）、`composition.test.ts` :189（残留 `core.orchestrator=legacy` 被当未知设置忽略、启动不报错、值保留）、`companionRuntime` runtimeTurnId 取消归属 | Tauri 真实旧库副本 **NOT RUN**（INT-01-D 一并） |
| INT-01-C Remote 共用同 Runtime/不重复维护 | **PASS（旧版基线）**：`remote.test.ts`（手机字段投影、坏输入拒绝、端口校验、token）、`companionRuntime` :616（重复回执只启动一次后台维护） | identity/scope 隔离增量待 RT-02 后追加；真实手机 **NOT RUN** |
| INT-01-D Tauri 启动重开/plugin-sql 生产 SQL/生产 DEV 开关 | 不适用自动 | **NOT RUN**：真实桌面与生产构建，node:sqlite 不可替代（INT-01-D 整列留槽位） |
| INT-01-E F1 六项交互 | 组件/状态层证据见各 FE 报告（REVIEWED_AUTO） | 浏览器操作与真机音频 **NOT RUN**（人工队列） |
| INT-01-F 真实 Provider 样本与 usage 可见 | fixture 列 **PASS**：`providerClient`/`companionRuntime` usage 事件与 reportedTotal（LLM-10 证据） | 真实 Provider **NOT RUN**；3 轮不等于质量通过 |

## 结论

- **INT-01 当前状态：PARTIAL**。自动消费者契约列全部通过（109 测试 exit 0）；浏览器页面、Tauri/plugin-sql、真实手机、真实 Provider 四列 NOT RUN，构成人工/真实设备验收队列（见执行计划人工补验清单）。
- 未做任何真实外发、真实宿主启动或生产构建；无范围外改动。
