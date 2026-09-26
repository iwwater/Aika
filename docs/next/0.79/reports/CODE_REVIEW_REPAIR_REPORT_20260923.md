# Code Review 缺陷修复与回归验收报告 (2026-09-23)

针对 [CODE_REVIEW_DEVELOPMENT_PLAN_20260923.md](../../0.8/CODE_REVIEW_DEVELOPMENT_PLAN_20260923.md) 中指出的 5 项缺陷，已完成全量定向生产修复与定向测试回归。

## 一、 缺陷修复与代码变更总结

| 级别 | 问题发现 | 修复改动与实现 | 涉及文件 |
| :--- | :--- | :--- | :--- |
| **P0** | **Trace 脱敏数组对象穿透**<br>原 `sanitizeStageDetails` 遍历数组仅对字符串脱敏，对象/嵌套数组原样透出。 | 实现递归辅助函数 `sanitizeUnknownItem`，深度脱敏数组内嵌套对象、多维数组及结构体；同步升级存量分析与清洗工具 `sanitize-trace-storage.mjs` 中的递归脱敏与检测。 | [`core/trace-store.ts`](file:///F:/AIVoice/Aika-Next/windows/code/desktop-pet/core/trace-store.ts)<br>[`tools/sanitize-trace-storage.mjs`](file:///F:/AIVoice/Aika-Next/windows/code/desktop-pet/tools/sanitize-trace-storage.mjs) |
| **P0** | **遗忘流程规划异常兜底逃逸**<br>规划器报错/取消走 catch 兜底，将所有非 memory 来源全文注入 `retainSources`。 | 彻底移除 catch 兜底，规划异常或取消严格遵循**失败关闭（fail-closed）**直接抛出，由外层转化为 `ManagementError('unavailable', ...)` 返回 503，严禁生成伪造的 `applied` 及包含原文的 active fragment。 | [`app/management-forget.ts`](file:///F:/AIVoice/Aika-Next/windows/code/desktop-pet/app/management-forget.ts) |
| **P1** | **Windows ACL 弱缓存失效滞后**<br>以 `mtimeMs + size` 缓存权限，放宽 DACL 不改变时间与大小导致逃逸。 | 移除不安全的弱缓存 `aclVerifiedCache`，每次调用均直接同步调用 `windowsAcl(filename, 'check')` 执行系统级真实 DACL 核验。 | [`core/platform-files.ts`](file:///F:/AIVoice/Aika-Next/windows/code/desktop-pet/core/platform-files.ts) |
| **P1** | **连续性事实父事实有效性漏验**<br>`invalidContinuitySource` 仅递归检查 `status !== 'active'`，漏验有效期与证据资格。 | 引入统一时点 `now: string`，递归检查所有祖先事实的 `status === 'active'`、`evidence_eligible === 1`、`valid_from <= now` 及 `valid_to > now`；在读取快照与写入派生（`record`/`correct`）两端双向阻断失效来源。 | [`memory/continuity-memory-store.ts`](file:///F:/AIVoice/Aika-Next/windows/code/desktop-pet/memory/continuity-memory-store.ts) |
| **P2** | **Timeline 投影异常静默吞没**<br>`onConversationSaved` 中 `stageCompanionProjection` 异常被空 catch 吞掉。 | 捕获异常后记录结构化诊断 `companion_projection_error`（不含消息正文），并将条目暂存至重试队列 `pendingCompanionProjections`，在 `drainCompanionProjection` 中自动重试补全。 | [`app/trial-backend.ts`](file:///F:/AIVoice/Aika-Next/windows/code/desktop-pet/app/trial-backend.ts) |

---

## 二、 测试与验证证据

### 1. 编译构建
- **命令**：`npm run build`
- **结果**：退出码 0，TypeScript 增量构建与打包无错误。

### 2. 定向单元与集成测试（21/21 全部 PASS）
- **命令**：
  ```powershell
  node --test dist/tests/next079/trace-content.test.js tests/tools/sanitize-trace-storage.test.mjs tests/windows/platform.test.mjs dist/tests/memory/continuity-memory.test.js
  ```
- **退出码**：0
- **通过项**：
  - `P0 RV-01 sanitizeStageDetails recursively redacts nested objects and arrays in stage details` (**PASS**)
  - `sanitize-trace-storage: dry-run, apply with backup, idempotency, and full rollback` (**PASS**)
  - `P0 RV-02 single target source forget fails-closed when planner throws, never creating fallback retain fragments` (**PASS**)
  - `owned credentials work with Windows ACLs; a broad read grant is rejected without modifying contents` (**PASS**)
  - `private-file validation compares opened file identity without mixing Windows stat devices` (**PASS**)
  - `P1 RV-03 derived facts exclude expired or ineligible parent facts from snapshot and reject late mutations` (**PASS**)
  - 及其余关联的核心回归用例共 21 项全部绿灯。

---

## 三、 结论与后续

1. **安全与一致性闭环**：P0 / P1 安全门槛已完全解除，无未脱敏穿透、无伪造遗忘、无权限缓存逃逸、无失效父事实派生污染。
2. **0.79 准入与 0.8 启动状态**：
   - 审查中指出的 Windows 后端、数据链路与管理 API 问题均已修复并通过单元/契约测试；
   - 待待测环境修复 Chromium 用户缓存权限后，重新回归 2 个 Electron 端到端页面用例；
   - 可以正式进入 **0.8 执行阶段（08-00 基线与契约冻结）**。
