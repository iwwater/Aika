# INT-01 验收报告 · 文本与接口（自动消费者列）

> 最新增量：2026-09-27 隔离 Tauri 宿主补验见文末。INT-01-D 当前 **PASS（隔离宿主）**；INT-01 整体仍 **PARTIAL**。下文较早日期的 NOT RUN 是当时的历史状态，不代表最新结论。

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

## 补记：生产 DEV 开关（2026-09-16，构建级证据）

INT-01-D 三子项中的「生产 DEV 开关」已有可复现证据；其余两子项（Tauri 启动重开、plugin-sql 生产 SQL）**仍为 NOT RUN**，因此该 AC 不上调整列结论。

```text
cd aika-crossplatform
npm run build                        退出码 0；产物 dist/assets/index-6kdOB5CA.js（588.81 kB），built in 5.54s
```

产物核对（`dist/assets/*.js` 共 4 个资源全扫）：

| 检查 | 结果 |
| --- | --- |
| 产物中残留的 `import.meta.env` 引用 | **0**（已被 Vite 静态替换） |
| `defaultTraceSettings()` 的编译形态 | `function nj(){let t=!1;try{t=!1}catch{t=!1}return{enabled:t,includeText:!1}}`，即 `enabled = false` |

结论：**生产构建下 Trace 默认关**——`services/trace/traceSettings.ts:28` 依赖的 `import.meta.env.DEV` 在构建期被替换为 `false`，与[规划文档 §7 问题 2](../../PLAN_DEV_DEBUG_WORKBENCH.md)的取舍一致；`includeText` 与构建无关，恒为 `false`。

边界（不外推）：本节是**构建产物级**证据，不替代真实桌面宿主启动的目视验收，也不构成 INT-01-D 其余子项的证据；本轮未做真实外发，未启动真实宿主。

## 补记：合批分支 Tauri 主线构建（2026-09-27）

用户确认下一交付主线为 Tauri Windows 后，在 `codex/aika-local-cloud-merge` 的 `8317093` 源码基线运行 `npm run build`（`aika-crossplatform/`）：`prebuild` 同步 2 个本地 ORT 运行时文件，`tsc && vite build` **退出码 0**，2075 个模块转换完成，主 JS 产物 `index-CkcHJqwf.js` 602.58 kB。Vite 报告混合静态/动态 import 与超过 500 kB 的 chunk 警告，没有构建失败。

首次在受限工作区执行时，`prebuild` 复制 ORT wasm 到 `public/ort/` 返回 `EPERM`（退出码 1）；允许工作区写入后，原命令重试成功。该首次失败是构建环境写权限，不计为源码通过证据。生成的 `public/ort/` 和 `dist/` 均不纳入提交。

| INT-01-D 子项 | 当前结果 |
| --- | --- |
| 当前分支前端生产构建 | **PASS**：`npm run build` 退出码 0；与 2026-09-16 的历史产物区分。 |
| 真实 Tauri 启动与重开 | **NOT RUN**：本轮未生成当前分支的原生可执行文件，也未启动桌面宿主。 |
| plugin-sql 生产库建表、插入、删除与错误 UI | **NOT RUN**：浏览器 localStorage 和 node:sqlite 证据不能替代真实 Tauri plugin-sql。 |

INT-01-D 仍为 **PARTIAL**，INT-01 整体状态不变。下次宿主核验应在隔离测试数据根进行，记录可执行文件基线、数据库位置、窗口/错误 UI 与重开结果；不读取或改写日用数据。

## 补记：当前分支原生宿主与隔离库（2026-09-27）

同一 `8317093` 源码基线，先在 `aika-crossplatform/src-tauri/` 执行 `cargo build --release --offline --features custom-protocol`，**退出码 0**（2m09s），得到 28,143,104 字节的 Release 可执行文件。编译有 2 条既有 Rust 警告和 linker 信息，均未导致失败。为避免正式 identifier `com.aika.companion` 触及日用数据，未启动这份正式配置的可执行文件。

随后只覆盖构建环境中的 `TAURI_CONFIG={"identifier":"com.aika.companion.mergesmoke"}`，以相同源码、`custom-protocol` 和能力配置重新离线编译，**退出码 0**（41.39s）。隔离版可执行文件 SHA-256：`06E376D744DEC16A7227B69A52E222210B0AF78E30CAF9841A413FE38152EA5E`；identifier 变更只用于使 plugin-sql 落在独立数据目录，此文件不是发布产物。

| INT-01-D 子项 | 当前证据和结论 |
| --- | --- |
| 真实 Tauri 启动与重开 | **PASS（隔离配置）**：启动前隔离目录不存在；首次进程 PID 17840，主窗 handle 1444830、标题 `愛花 Aika`、`Responding=True`。`PrintWindow(PW_RENDERFULLCONTENT=2)` 只抓测试窗口，确认聊天、角色和侧栏完整渲染。结束指定 PID 后重开为 PID 3648，主窗 handle 984862、`Responding=True`，再次抓图确认非空白页。 |
| plugin-sql 生产路径建库建表 | **PASS（隔离配置）**：首次启动生成 `%APPDATA%/com.aika.companion.mergesmoke/aika.db`；只读查询 `sqlite_master` 见 `messages`、`settings`、`memories`、`summaries`、`memories_v2`、`knowledge_documents` 等表。重开后表仍在，`messages=0`、`settings=1`。生产前端调用 `createSqliteStorage()`，未注入测试 executor。 |
| 消息插入/删除与错误 UI | **NOT RUN**：没有在窗口执行消息增删，也未注入 SQL 故障；上述建库和只读查询不代替这两项。正式 identifier 的日用库亦未启动或读取。 |

该轮隔离进程已结束；新建的 `com.aika.companion.mergesmoke` 目录经路径核对后删除。两张窗口截图保存在本任务本地可视化目录，未加入 Git。当时 **INT-01-D 为 PARTIAL**；以下补记继续核验真实宿主写入路径。

## 补记：知识索引原子写入修复与宿主复验（2026-09-27）

隔离版原生宿主经 WebView2 CDP 操作设置页。修复前，在 Wiki 表单保存一条知识时，页面显示 `database is locked`，`knowledge_documents/chunks` 均为 0。原因是知识索引把 `BEGIN IMMEDIATE`、DML、`COMMIT` 分别送给 plugin-sql；插件从连接池取连接，各调用不保证落在同一连接。故改为 Tauri 原生 `knowledge_sql_batch`，固定操作当前应用配置目录的 `aika.db`，用同一 `sqlx` 连接开启事务并提交整批语句；失败时事务回滚。`SqlExecutor.executeBatch?` 是向后兼容的可选增量，调用方只有知识索引；测试 executor 保留旧路径。FTS 重建改为事务内单条 `INSERT … SELECT`。

| 验证命令/操作 | 结果 | 退出码 |
| --- | --- | --- |
| `npx tsc --noEmit`（`aika-crossplatform/`） | 类型检查通过 | 0 |
| `npx vitest run src/services/knowledge/knowledgeIndex.test.ts src/services/storage/sqliteStorage.test.ts` | 2 文件、14 测试通过；新增用例确认导入/删除各发一批且不向池化执行器发 `BEGIN` | 0 |
| `npm run build`（`aika-crossplatform/`） | 2075 模块、产物生成；仅已有分包体积/混合 import 警告 | 0 |
| `TAURI_CONFIG` 仅覆盖 identifier 为 `com.aika.companion.mergesmoke`，`cargo build --release --offline --features custom-protocol` | 当前修复的隔离宿主编译通过；既有 3 条 Rust 警告 | 0 |
| WebView2 设置页 Wiki 表单保存、删除 | 独立库文档/切块行数 `0/0 → 1/1 → 0/0`，条目显示后消失，页面 alert 数 0 | PASS |
| 原生命令故障注入：同一批对 `settings.key` 重复插入 | 第二条报 `UNIQUE`；失败后查询为 0 行，后续单批插入成功，清理后又为 0 行；无残留锁 | PASS |

定时任务面板还经同一隔离宿主完成创建和取消，持久化状态从 `pending` 到 `cancelled`，页面无 alert。以上是实际 Tauri + plugin-sql/原生 SQLite 路径的证据。**INT-01-D 仍为 PARTIAL**：这轮验证的是 Wiki 与任务数据，聊天消息的 UI 插入/删除和专门的聊天错误 UI 仍 **NOT RUN**。INT-01 其余真实 Provider、Remote、旧库副本等列也未因此升级。正式 `com.aika.companion` 数据目录未访问。

复验结束后停止指定隔离进程，并核对绝对路径后删除 `com.aika.companion.mergesmoke` 的 AppData 与本次 WebView2 测试 profile；构建产物及临时脚本均位于 Git 忽略的 `target/`，未纳入提交。

## 补记：INT-01-D 与相邻页面项的真实宿主补验（2026-09-27）

基线 `6c2918f`。复用本分支已编译的隔离 identifier 可执行文件，SHA-256 `EC891D0B693F18BCE2D98A3186D24B182917134A02313724D51091BDBA14EB16`。通过 WebView2 CDP 操作真实 Tauri 窗口，后端只指向 `127.0.0.1:18765` 的固定回环假 Provider，Key 为仅存于隔离目录的 dummy 值；它验证生产 UI→Runtime→Provider adapter→plugin-sql 编排，**不能证明真实 Provider 质量**。调试脚本位于 Git 忽略的 `src-tauri/target/`，每项退出码均为 0；第一次试跑因脚本路径未正确引用而未启动假 Provider，连接失败是测试环境问题，修正后用界面「重试」恢复，并验证失败提示可见。

| 检查 | 实际证据 | 结论 |
| --- | --- | --- |
| 消息写入与撤回 | 成功回合写入用户/助手 2 行；故障回合出现 `is_error=1` 助手行；分别点击「撤回」后按轮删除，行数最终为 0。 | **PASS（隔离宿主）** |
| 存储错误 UI 与失败不丢数据 | 对隔离库短时 `BEGIN EXCLUSIVE`，在 UI 点击撤回；页面 `role=alert` 显示 `database is locked`，消息仍在页面且库内保持 2 行。解除锁后再次撤回，库内为 0 行。 | **PASS（隔离宿主）** |
| 旧库副本 | 预置仅有旧版 `messages` 字段和 `core.orchestrator=legacy` 的合成旧库；宿主启动后自动补 `runtime_turn_id`、`completion_status`、`conversation_id`，旧行新字段均为 NULL，旧设置值保留，旧消息在窗口可见且无存储错误。重开进程后旧行及新写入的消息继续可见。 | **PASS（合成旧 schema）**；真实用户历史库未取用 |
| F1 浏览器交互 | 回环流式回复的正文与译文各显示一次；「重新生成」后同轮仍各一行；失败回合 `503` 显示错误，恢复假 Provider 后点「重试」得到成功回合；「回到这里」确认后只保留锚点之前消息；撤回已在上一行验证。朗读按钮已显示。 | **PARTIAL**：朗读实际发声与真人听感未测，按既定语音后置范围保留 |
| 启动/重开与生产 DEV 开关 | 首次及旧库重开均 `Responding=True`、窗口非空；生产 DEV 开关构建证据见上文。 | **PASS** |

因此 INT-01-D 的真实 Tauri 启动重开、plugin-sql 建表与消息增删、存储错误 UI、生产 DEV 开关四项已有本分支证据，列状态升为 **PASS（隔离宿主）**。INT-01-A 只补到假 Provider 的一条实际 UI/存储链，三模式与取消/迟到页面仍未补齐；INT-01-B 旧库证据是合成 schema；INT-01-C 真实手机、INT-01-F 真实 Provider 仍 **NOT RUN**。INT-01 整体保持 **PARTIAL**。隔离进程、假 Provider、测试 AppData 与 WebView2 profile 已停止并删除；只有不含日用数据的窗口截图留在本任务本地可视化目录，未进 Git。
