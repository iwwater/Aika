# LLM-11 验收报告 · 上下文装配快照

- 执行：goal worker（2026-09-13）。SPEC：[LLM-11](../specs/LLM-11_CONTEXT_SNAPSHOT.md)。基线 commit：`377d913`。
- 状态：**AUTO_PASS（待人工验收）**——A/B/C/D 可自动 AC 全过。

## 改动文件

| 生产 | 测试 |
| --- | --- |
| `domain/trace.ts`：新增 `context_snapshot` 事件（字段冻结：budget 五元/requiredBlocks/history 五计数/summary 三态/sections+snippets 逐字段/counts.truncated）；`redactTraceEvent` 增加该 kind 分支（includeText=false → snippet.content 一律 null，受控 source 保留） | `contextAssembler.diagnostics.test.ts` 6 例、companionRuntime.test +3 例 |
| `domain/context.ts`：`ContextAssemblyResult` 增加可选 `diagnostics` | — |
| `services/context/contextAssembler.ts`：`AssembleInput.includeDiagnostics?`；装配期（裁剪时）采集诊断——保留与裁掉的块都可见、history 四计数、summary 三态、requiredBlocks 逐项、截断上限（50/section、24KB） | — |
| `services/runtime/companionRuntime.ts`：`includeDiagnostics: trace.enabled()` 传入装配；成功装配后 record `context_snapshot`（record 内部再次复核开关） | — |
| 消费者：`domain/pluginGraph.ts`（FLOW_ORDER + summarizeStep）、`domain/traceView.ts`、`pages/TracePage.tsx`（KIND_LABELS + summarize） | `pluginGraph.test.ts` 穷举用例同步 |

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/services/context/contextAssembler.diagnostics.test.ts` | 6 passed | 0 |
| `npx vitest run src/services/context src/services/runtime/companionRuntime.test.ts src/domain src/services/trace` | 37 文件 / 516 passed | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| LLM-11-A 每成功装配轮恰好一条；保留与裁掉的 fixture 块逐字段匹配 | `成功装配轮恰好一条快照，字段齐全`（sink 实测 1 条）；`装配诊断：保留与裁掉的块都有诊断`（kept/reason/ordinal/id/category/precision 逐字段）；事件序列测试更新为六事件（快照紧跟 context_assemble） | PASS | production+fixture |
| LLM-11-B includeText=false 正文与敏感元信息经唯一脱敏点；无原始 prompt/key | redactTraceEvent 是全仓唯一脱敏调用点（record/订阅/导出共用）；`content 全部置 null，正文与 canary 不外泄`（canary-SECRET 实测）；source 为受控来源名保留 | PASS | production+fixture |
| LLM-11-C Trace 关不构造正文快照；sink 故障不阻断回复 | `includeDiagnostics 缺省：不构造诊断`；runtime 以 `trace.enabled()` 决定是否采集 + record 内复核（关→开/开→关竞态由每次调用取 isEnabled 保证）；`Trace 关闭：不产生快照`；sink 异常在 recorder try 内（LLM-06 既有证据） | PASS | production+fixture |
| LLM-11-D 旧事件回放与 kind 穷举消费者兼容；取消/装配失败不伪造快照 | pluginGraph FLOW_ORDER/traceView/TracePage 穷举更新并通过（旧事件无快照字段不受影响）；快照只在成功装配后 record，取消/装配失败路径不产生（无 turn 的 assemble 异常走 fail()，不调用 emitTrace） | PASS | production+fixture |

## 实现中做的判断

1. **诊断在装配时采集**：trimToBudget 循环内逐 snippet 记录 kept/reason，不从最终 context 反推。
2. **截断如实记录**：单 section 50 条、总 24KB 上限，超出 `counts.truncated=true` 且只保留前缀清单——不把截断清单叫全量。
3. **估算标 estimated**：budget.available = max(0, inputLimit−outputReserve−safetyReserve)，注释明确不是平台真实预算；ordinal 只是诊断序号。
4. **元信息脱敏边界**：content 由开关控制；source 在装配侧即使用受控来源名（来源 id / section 名），不复制自由路径到其他字段；不承诺识别任意未知秘密（canary 测试证明的是开关语义，不是全量密钥扫描）。
5. **budget/Provider 行为不变**：includeDiagnostics 关闭时 trimToBudget 行为与旧版完全一致（参数缺省跳过构造）；开启时只加记录，不改裁剪决策。

## 共享接口 / 消费者

- `TraceEventKind` 新增 `context_snapshot`（协议追加，schemaVersion 仍为 1；旧事件回放不受影响）。`ContextAssemblyResult`/`AssembleInput` 均为可选字段追加（向后兼容）。
- 受影响消费者：traceView/pluginGraph/TracePage（已更新）、FE-23~25（时间线/浮层/上下文视图将消费此事件）、存储侧无 schema 变更（JSON 序列化自描述）。
- CONTRACTS 登记：新增字段随本报告记录版本；如后续 FE-23/24 消费需跨模块端口，另行登记。

## 未测/人工项

- 真实 Tauri/SQLite 落盘下的快照事件持久化：INT-01。
- UI 视觉（TracePage 新摘要行渲染）：人工/浏览器。
