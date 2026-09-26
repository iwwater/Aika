# RT-05 · 持久 Scheduler — 验收报告

## 2026-09-17 宿主接线及任务入口增量

状态：本次定向自动验证 PASS；完整浏览器应用入口 BLOCKED（既有内核错误）；Tauri 设备通知与长跑 NOT RUN。未构建、替换或重启当前 release，避免中断进行中的宿主观察。

改动：新增 `localTasks.ts`、`localTasksPlugin.ts`、`LocalTasksPanel.tsx`；默认能力装配注册服务，设置侧栏新增「定时任务」。支持显式创建一次本地提醒、正文跨重开恢复、任务状态/ID、暂停/恢复/取消；宿主每秒串行推进，dispose/pagehide 停止。到期核验本地主体、local:reminder scope 与已持久化的提醒时刻；不接 GW/outbox 或恢复 Agent。通知失败保留完成记录，明确显示“系统通知未发送”。

纠正原报告与实现的两处不一致：缺 authorize 过去仍执行，如今拒绝；过去执行后才落盘，如今先存 unknown 再 fire，异常/崩溃不重放。读取坏库或失败不再当空库覆盖。旧 schemaVersion=1 不变，新增正文键独立；接口登记见 CONTRACTS。旧两处副作用测试补显式授权，未缩减预期。

验证命令（cwd aika-crossplatform）：

- 初次 `npx.cmd vitest run src/services/runtime/persistentScheduler.test.ts src/services/runtime/localTasks.test.ts`：退出码 1，两处旧测试未提供授权器；补显式授权后退出码 0。
- 最终 `npx.cmd vitest run src/app/composition.test.ts src/services/runtime/localTasks.test.ts src/services/runtime/persistentScheduler.test.ts`：退出码 0，3 文件 / 24 项通过。
- `git diff --check`：退出码 0。
- Playwright CLI +真实 Edge 独立页面，加载生产组件及生产本地提醒服务；外部 notifier 返回 false、持久化用浏览器 localStorage：创建未来提醒 → 到期完成 → 刷新恢复，通知调用计数仍为 1。页面显示正文、完成状态、任务 ID、系统通知未发送。脚本退出码 0；生产定时器和 UI 均实际运行，不证明 Windows 通知送达。
- 完整浏览器主应用仍在启动时失败：`llm.contextSources` 声明却未提供 `knowledge.wiki`（PLUGIN_CONTRACT_VIOLATION）。该既有问题在本次接线前已出现；未扩展范围修复。主应用设置导航现场检查 BLOCKED，默认插件装配由 composition 定向测试验证。

逐 AC：A（恢复/暂停/恢复/取消）PASS；B（一次执行、到期授权、unknown 预存与异常不重放、坏库不覆盖）PASS；C（关闭不可执行、超过一分钟 missed、通知状态真实）PASS；D（只接受本地显式创建、无 Agent 恢复或外发入口）PASS，限本次一次本地提醒增量。既有 DST/跨天需求与真机长跑没有新增实测证据。

待设备验收：在新版宿主设置→定时任务创建一条两分钟后提醒，记录 ID/通知/状态；创建另一条未来提醒，退出后重开核对；已完成或取消任务不得重复通知；关闭超过到期一分钟应为 missed。Tauri 真机、过夜长跑、人工审阅均 NOT RUN；未宣称完整 RT-05 PASS，也未提交或 push 本次增量。

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

## 2026-09-26 · 浏览器任务入口修复补记

浏览器实际打开设置→定时任务后，每秒出现“任务调度失败”告警。临时诊断日志定位为 `localTasksPlugin` 将作用域注册器的 `ClockToken` 解析延迟到了 `activate()` 返回后的 tick；注册器按内核契约已撤销。修复为激活期间解析时钟服务，后续只调用其 `now()`。未改变调度持久格式、授权规则或通知语义；临时诊断日志已移除。

`src/app/composition.test.ts` 新增正式插件激活后再次 tick 的回归，连同 `src/services/runtime/localTasks.test.ts` 和插件测试共 3 文件 31/31 PASS、退出码 0；`npx tsc --noEmit` 退出码 0。Vite 页面经真实浏览器打开，设置内的定时任务面板可见，刷新后不再显示后台 tick 失败告警。浏览器表单的创建/取消交互本轮 **NOT RUN**（日期输入自动化未完成）；服务层创建/取消由既有定向测试覆盖。Tauri 真实通知与长跑仍 **NOT RUN**，不提升 RT-05 整体状态。
