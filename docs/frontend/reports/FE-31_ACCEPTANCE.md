# FE-31 验收报告 · 桌宠陪伴会话、主动读屏与点击对话

- 模块 / 小阶段 / SPEC 版本：前端 / FE-31 / [specs/FE-31.md](../specs/FE-31.md)（2026-09-14 版）
- 基础 commit：`a88180d`
- 执行日期：2026-09-14
- **总状态：PARTIAL** —— A～F 的生产逻辑轨 PASS；**G（真实设备逐项演示）NOT RUN**，真实回复 / 音频 / 角色表现归 FE-30。
- 真实依赖 / fake 依赖：Rust 窗口 label 校验为生产实现（`cargo test`）；TS 侧采集、OCR、pet 窗口、发送路径在控制器测试里全是 fake。**没有真机、没有真实 OCR、没有真实 Provider 回复。**

## 改动文件

相对 `aika-crossplatform/`：

| 文件 | 改动 |
| --- | --- |
| `src/presentation/companionSessionController.ts` | 新增。off/active/quiet 三态、generation 撤销、一次确认、意图路由、自动路径门禁（稳定 ≥3s / 差异 ≥20% / 置信度 ≥0.8 / 安静模式 / 用户优先） |
| `src/pet/petIntent.ts` | 新增。`pet.intent.v1` 协议、白名单校验、120s×256 的 requestId 去重 |
| `src/pet/intentBridge.ts` | 新增。主窗侧接收端：形状校验 + 丢弃计数，权限裁决全部交控制器 |
| `src/pet/petPresentation.ts` | 追加可选 `companion`（mode/readState/notice）与 `petEpoch`；旧帧零影响 |
| `src/pet/relay.ts` | `aggregatePresentation` 可选接收会话快照与 petEpoch；**只投影状态，不投影任何屏幕文字** |
| `src/pet/PetApp.tsx` | 快捷操作（看屏幕聊聊/聊两句/暂停读屏/结束陪伴/打开主窗口）、轻量输入、拖动阈值判定、会话状态行 |
| `src/pet/manager.ts` | 新增 `focusMain()` |
| `src/pet/pet.css` | 新增会话状态与输入框样式 |
| `src/presentation/companionPresenter.ts` | 新增 `sendEnvironmentProactive(buffer)`：走**既有**共享发送预约与同一套门禁 |
| `src/hooks/usePetWindow.ts` | 会话控制器与意图桥的持有者；pet 端口、传感器租约、发送路径接线 |
| `src/app/kernelContext.tsx` | 新增 `useOptionalService`（`tryResolve` 的 React 包装） |
| `src/App.tsx` | 设置页「陪伴」分组：主动/安静/暂停、读屏状态与本分钟配额 |
| `src/services/storage/contracts.ts` | 新增 `companionMode` / `companionConsent` 两个键（默认 off / false） |
| `src-tauri/src/petWindow.rs` | 新增 `pet_intent_submit`（**只允许 pet 调用**，8KB 上限）与 `PET_INTENT_EVENT` |
| `src-tauri/src/lib.rs` | 注册新命令 |
| **生产装配（见下）** | `src/app/hosts/index.ts`、`src/app/plugins/environmentHostPlugin.ts`、`src/app/plugins/contextSourcesPlugin.ts`、`src/services/environment/screenSource.ts`、`src/services/environment/contracts.ts`、`src/presentation/tokens.ts` |

## 顺带补上的装配断点（本轮最重要的修正）

进场时发现 FE-18～22 **整条链路从未接进生产装配**：

- `environmentPlugin` 只在它自己的测试里被 `kernel.use()`；
- `createForegroundSource` / `createScreenSource` 在 `src/` 里除测试外**没有任何调用方**；
- `EnvironmentBusyObserverToken` 从来没有提供方，`presentationPlugin` 的 `tryResolve` 永远得 null（busy 永远 unknown → FE-22 的主动路径永远不发）；
- `createEnvironmentContextSource`（FE-19）**没有注册进 `contextSourcesPlugin`**，环境摘要根本到不了请求装配；
- `ScreenState` 没有 `.manage()`（FE-32 报告已记）。

也就是说，FE-18～22 报告里的 PASS 全部是「模块内可用」，真机上**一个传感器都不会启动、一条摘要都不会进请求**。`docs/modules/CONTRACTS.md` 里「装配：`tauriHostPlugins` 注册 foreground source + environmentPlugin」与源码不符。

本轮按 FE-31 文件范围（`设置与插件装配按现有模块风格`）补上：

- `tauriHostPlugins` 构造 foreground + screen 两个 source 与共享 OCR 引擎，注册 `environmentPlugin`；
- 新增 `environmentHostPlugin` 提供 busy 观测者、**统一 capture/OCR 调度器**与 FE-32 的按需读屏上下文源；
- `screenSource` 增加可选 `scheduler`：词表轨与全文读屏共用同一份「10 次/分钟」，不传时行为与 FE-21 完全一致（旧用例未改）；
- `contextSourcesPlugin` 注册环境摘要源与屏幕文字摘录源（两者**分开授权**）。

装配不做平台预探测：命令在不支持的平台上失败 → source 把失败映射成 `unavailable`/`denied` → 设置页如实显示，比装配期猜一个 supported 布尔诚实。

## 测试命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/presentation/companionSessionController.test.ts` | 22/22，exit 0 |
| `npx vitest run src/pet` | 25/25（petIntent 7 + intentBridge 3 + 既有 15），exit 0 |
| `npx vitest run src/presentation/companionPresenter.environment.test.ts` | 6/6（新增 2），exit 0 |
| `npx vitest run src/presentation src/pet src/app` | 216/216，exit 0 |
| `npx vitest run`（全量，依赖恢复后） | **1533 passed / 4 skipped / 0 failed** |
| `cargo test`（`src-tauri/`） | 31/31，exit 0 |
| `npx tsc --noEmit` | **0 错误** |

## 逐 AC 结果

| AC | 门槛 | 证据 | 结果 |
| --- | --- | --- | --- |
| FE-31-A | 默认关闭；一次授权后可到 running；拒绝/部分失败清理资源并显示失败；不需要手工再开多个隐藏设置 | 4 条用例：默认 `mode=off` 且未确认时 `enable` 返回 false、零传感器调用、状态 `denied` 并给出「需要先确认范围」；一次 `consent:true` 后 `readState=reading`、`sensorCalls=[true]`、pet 打开、两个设置键落库；**应用启动本身不采集**（`start()` 只读回上次选择，`sensorCalls=[]`）；启动失败时 `sensorCalls=[true,false]`（有显式清理）、`mode` 回 off、状态 `denied` | **PASS（逻辑轨）** |
| FE-31-B | active 中非关键词中英文页面变化形成候选并在合法额度发送；静止不重复；quiet 中 OCR 仍更新但自动 submit 为 0 | 5 条用例：active 下稳定一屏 → 1 次预约；同屏再变化（差异 <20%）不重复；换一屏 → 第 2 次；稳定不足 3000ms 不发（2999ms 不发 / 3000ms 发）；低置信度段（0.4）零候选；quiet 下 `submitProactive` 为 0 但 capture 照常发生、`lastReadStatus=ok`；active→quiet 不重启采集（`sensorCalls` 仍是 `[true]`）。生产接线侧另有 2 条用例证明它走的是**既有**共享预约（`source=proactive`、写 `proactiveLast*` 键、与环境事件同刻至多一次提交） | **PASS（逻辑轨）** |
| FE-31-C | pet 点击 screen_talk 在静止画面触发新 OCR 并发一轮用户请求；主动关/quiet/额度耗尽仍可用；拖动/双击/重放不多发 | screen_talk 使 capture 次数 +1 并提交 `trigger=pet_screen_talk`；quiet 与 paused 下同样可用（2 次提交）；同一 requestId 重放只发一轮；发送中的重复点击返回 false 并给出「还在发送中」的可见状态（不静默丢弃）。**拖动不算点击**在 `PetApp.tsx` 用按下/抬起位移阈值实现，属 UI 行为，**没有自动测试**，归 G/FE-30 目视 | **PASS（逻辑轨）；拖动判定 NOT RUN** |
| FE-31-D | pet 普通输入可直接回复，无屏幕权限也能聊；screen_talk 失败提示「未读到屏幕」并允许无屏幕继续，不编造页面内容 | 采集未授权的 harness 下 `talk` 正常提交且 `capture.calls === 0`；OCR 返回 null 时 `lastReadStatus=timeout`、notice 为「这次没读完屏幕」，**仍然提交那一轮**，且提交内容只有固定的动作文本 `SCREEN_TALK_TEXT`，不含任何页面内容 | **PASS（逻辑轨）** |
| FE-31-E | 暂停/结束/锁屏发生在 capture、OCR、装配、预约阶段，迟到结果均不外发；单次读屏完成即清理；主窗已有用户轮不中断 | 暂停：`sensorCalls=[true,false]`、pet 不关闭、后续自动路径零提交、普通聊天仍可用；结束：generation 前移、停租约、关 pet、模式落库 off；**识别期间 end()**：迟到的 OCR 结果不形成候选（`proactive===0`）；全局「停止全部感知」→ `readState=paused` 且自动路径停止。「主窗已有用户轮不中断」由控制器不调用任何 cancel/stop 保证（与 FE-20 同一条红线），**没有针对它的新用例**；锁屏归 FE-19 busy 链路与 FE-30 真机 | **PASS（逻辑轨）；锁屏 NOT RUN** |
| FE-31-F | 真实 pet 恶意 intent、旧 epoch、自造 source/任意命令被拒；用户与自动同刻至多用户轮提交，取消候选不积压 | `validatePetIntent` 7 条用例：错 schema / 空或超长 requestId / 非法 kind（`run_shell`、`outbound_publish`）全部丢弃；talk 空文本或超 2000 字符被拒；非 talk 带文本被拒；**pet 塞进来的 systemPrompt / source / provider / toolCall / path 不出现在结果里**（断言结果只有 5 个键）。`intentBridge` 3 条用例证明形状不对的载荷到不了控制器。旧 petEpoch 被控制器丢弃。竞争：自动候选已稳定、用户轮在途时 `proactive===0` 且只有用户那一条被提交。Rust 侧 `assert_allowed_caller` 用例覆盖「主窗不能伪造 pet 意图」 | **PASS（逻辑轨 + Rust 单元）** |
| FE-31-G | 真实设备：主窗最小化下 active、quiet、点击读屏、普通输入、暂停与结束逐项演示；真实文本回复、音频与 Live2D 归 FE-30 | 没有真机演示，没有真实回复 | **NOT RUN** |

## 场景文本是实际模型输出还是 fixture

全部是 fake。本报告**没有任何真实模型输出、真实识别结果或真实设备观测**。

## 共享接口变化 / 受影响消费者

| 追加 | 兼容方式 | 受影响消费者 |
| --- | --- | --- |
| `pet.intent.v1`（requestId/petEpoch/kind/text，kind 仅 5 种） | 新协议；Rust 只校验来源与体积，形状白名单在主窗单点裁决（不两处复制） | pet 页、主窗 intentBridge、CompanionSessionController |
| Rust `pet_intent_submit` | 新命令，**只允许 pet 调用**（与 broadcast 的方向/权限正好相反） | pet 页 |
| `pet.presentation.v1` 追加可选 `companion` / `petEpoch` | **可选字段追加**，旧壳照常渲染；只投影状态，不投影屏幕文字 | pet 页、FE-28/29 |
| `CompanionSessionController`（off/active/quiet + generation） | 新模块。**不进注册表**：它要同时够到 pet 窗口管理器、屏幕上下文源与既有发送路径，与 `PetWindowManager` 同属主窗 Hook 拥有的会话对象 | `usePetWindow`、App 设置页 |
| `CompanionPresenter.sendEnvironmentProactive(buffer)` | 接口新增方法。走既有共享预约与同一份额度；**摘录不从这里进模型** | `usePetWindow`、（未来）FE-30 |
| `ScreenSourceDeps.scheduler?` | 可选注入；不传时行为与 FE-21 完全一致（旧用例零改动） | 宿主装配 |
| `CaptureSchedulerToken` / `ScreenContextSourceToken` | 新注册，缺能力即不注册 | `contextSourcesPlugin`、`usePetWindow` |
| `useOptionalService` | 新 Hook，`tryResolve` 的 React 包装；不新增第四个 resolve 入口 | `usePetWindow` |
| `SETTING_KEYS.companionMode` / `.companionConsent` | 新键，默认 off / false | 控制器、设置页 |

## DEFERRED 项目

无 DEFERRED。G 与上面标注的 NOT RUN 一律按未通过计。

## 执行者自测结论

A～F 的会话控制、门禁与撤销语义已经落地并被定向测试覆盖，并且**这一轮才第一次把环境链路真正接进生产装配**。但必须说清楚：

1. 没有任何一次真实读屏、真实回复或真实设备演示发生过，**FE-31 不构成「桌宠陪伴可用」的结论**；
2. 生产装配是新写的，**从未在真实 Tauri 进程里跑过一次**——`cargo check` 与 `tsc` 只能证明它编译得过；
3. ~~中文识别所需的 `chi_sim.traineddata` 不在仓库~~ —— 已随包登记，装配改为 `eng+chi_sim`，并在生产代码路径上验过一次真实中文识别（详见 [FE-32 报告](FE-32_ACCEPTANCE.md)「第二轮」）。真机上能不能读到，仍取决于第 2 条。

- 原任务证据审阅结论：待审阅
- 下一小阶段（09-15 修订）：**不再走角色线 FE-27→28→29**（该线已 SUPERSEDED，Live2D 归 PET-08 且为 DEFERRED）；本模块剩余为 **FE-31-G 真机逐项演示**，并入 FE-33 真机复验一并做。
