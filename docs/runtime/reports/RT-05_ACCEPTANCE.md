# RT-05 · 持久 Scheduler — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；真实宿主长期运行 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/runtime/persistentScheduler.ts`（新增） | 触发三类建模：`time`（一次性）/`interval`（周期，支持 localHour/localMinute+IANA tz）/`event`（executionKey 触发）；任务字段（id/owner/scope/trigger/timeZone/nextRunAt/misfirePolicy/enabled/attempts/executionKey/state）；misfire 默认 `skip`（错过标 missed 不补发）；幂等触发键（同 executionKey 只执行一次，重复 notify 去重，已消费键再次入队拒绝）；到期执行**先重新校验权限**（`authorize` 钩子，fail-closed）再经同一持久提交边界认领；非幂等副作用 unknown → 标 unknown 不自动重放；可确认失败重试至多 3 次（指数退避）；容量 200 上限；暂停/恢复/取消；KV 持久化（重启不重放已消费任务、损坏按空调度器 fail-closed）；无时区数据 → `unsupported-timezone`，不硬编码本地时区 |
| `aika-crossplatform/src/services/runtime/persistentScheduler.test.ts`（新增） | fake clock 驱动 8 用例：到期一次/幂等键/重启不重放/missed/暂停恢复取消/权限重查/事件去重/unknown 不重放/重试上限/坏时区 |
| `docs/modules/CONTRACTS.md` | 登记 RT-05 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/runtime/persistentScheduler.test.ts` | 0 | 8 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 116 文件 1301 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **RT-05-A**：fake clock 覆盖——重启（rebuild 同库新实例）、重复事件（notifyEvent 二次 deduped）、时区边界（坏时区 `unsupported-timezone`；DST 不存在时刻由 `nextDailyOccurrence` 逐日扫描+skip 语义承载）、暂停（到期不执行）/恢复/取消。
- **RT-05-B**：重启不重放已消费任务（consumedKeys 持久化，rebuild 后 tick 零触发）；到期执行前 `authorize` 重查——未授权 → `cancelled` 零触发；unknown 副作用 → `unknown` 不自动重放。
- **RT-05-C**：任务状态如实持久（pending/missed/unknown 均可见）；单宿主语义——宿主离线任务保持原状态不假装执行，文档与字段不包含任何「24 小时可用」承诺。
- **RT-05-D**：到期执行强制过 `authorize`（RT-03 口径）——定时任务无法绕过审批；被取消的 Agent 不会被 Scheduler 自动恢复（Scheduler 只消费授权通过的 pending 任务，无任何恢复语义）。

## 未执行 / 待人工

- 真实宿主长期运行（跨天 cron、真实 DST 跳变实测）NOT RUN——需要真实宿主长跑环境；DST 语义以 `nextDailyOccurrence` 逐日扫描实现并留 skip 记录。
- 通知投递（Scheduler fire → GW-01 outbox）的实际接线归宿主组合根（端口已按 `fire` 回调抽象）。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工。
