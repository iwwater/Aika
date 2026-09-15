# FE-33 验收报告 · 环境链路真机装配验收（不含 Live2D）

- 模块 / 小阶段 / SPEC 版本：前端 / FE-33 / [specs/FE-33.md](../specs/FE-33.md)（2026-09-14 版）
- 基础 commit：`b29a6d0`
- 执行日期：2026-09-14
- **总状态：进行中（真机操作已开始，现场发现 3 个问题）** —— 构建准备与启动自检已完成；A~G 设备观测未完成。
  **2026-09-15 加注**：FE-33 **自身真机复验仍未跑**；同日 MVP-04-D 的真机补跑覆盖了「OCR → 真实 Provider → 桌宠」一段（属**上游 OpenPet 侧** device 证据，**不能替代**本报告对「新接生产装配在真机是否通」的逐 AC 复验）。另：**FE-33-F 与 BUG-01 已因 MVP-03 删除旧自研桌宠而条目失效**（缺陷记录亦已登记），只剩 BUG-02（可观测性）、BUG-03（聊天区滚动）待复验。release 产物就绪：`target/release/aika-crossplatform.exe` 27.4 MB @2026-09-15 17:14。
  **2026-09-14 16:48 现场登记 3 个问题**（桌宠显示不生效 / 环境感知是否生效不可判断 / 聊天区不能向下滚动），
  逐条见 [FE-33_DEFECTS](FE-33_DEFECTS.md)（**均为登记状态，缺真机证据，未定性**）。
  回填指南见 [FE-33_真机执行手册](FE-33_真机执行手册.md)。
- 真实依赖 / fake 依赖：本次为**真机轨**。构建产物（前端 dist + Tauri release exe）为生产构建；
  观测必须来自真实进程与真实窗口，**不得**把逻辑轨测试结果抄入本报告。

## 构建准备（已完成，可复现）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 前端重建 | `npm run build`（aika-crossplatform/） | ✅ exit 0；2057 模块；`dist/tessdata/` 含 `eng.traineddata`(4113088B) + `chi_sim.traineddata`(2469156B) |
| Tauri release | `cargo build --release --features custom-protocol`（src-tauri/） | ✅ CARGO_EXIT=0，4m24s；产物 26.7 MB |
| exe 路径 | `src-tauri/target/release/aika-crossplatform.exe` | 2026-09-14 16:39 |
| 启动自检 | `Start-Process`（不重定向 stdout） | ⚠️ 仅证明**进程存活**：稳定 ≥15s（34MB / 334 句柄），Application 日志无崩溃。**不能证明窗口渲染**——复核发现启动 Aika 前后 `msedgewebview2` 进程数均为 19（全部属 Office Copilot），即本沙箱里 Aika 的 WebView2 **根本没有拉起**。白屏与否只能由桌面目视确认 |

> 说明：release 版 `windows_subsystem="windows"` 无控制台，**重定向 stdout 会导致进程提前退出**，
> 这是测试方法问题而非应用缺陷；已在手册中标注。白屏与否仍需桌面目视确认。

## 现场发现（2026-09-14 16:48）与修复状态

| 编号 | 现象 | 影响 | 修复状态（2026-09-14 17:1x） |
| --- | --- | --- | --- |
| BUG-01 | 点「显示桌宠」不生效 | 阻塞 FE-33-F | 已修复：SVG 补固有尺寸 + pet 容器明确宽度 + 建窗/显示均回工作区 + 暴露 show/focus 错误 |
| BUG-02 | 环境感知是否生效不可判断 | 阻塞 FE-33-A/B/E | 已修复：设置页展示最近进程名 / 监听状态 / 一分钟信号计数（不含标题与 OCR 原文） |
| BUG-03 | 聊天区不能向下滚动 | 核心交互 | 已修复：Grid/Flex 补 `min-height:0`+`overflow:hidden` + 自动滚底（上滚不抢） |

逐条定位线索、待补证据、已排除的假设、**独立复验证据**与 3 个观察项见 **[FE-33_DEFECTS](FE-33_DEFECTS.md)**。
**已实测排除**「内核装配失败」这一共因：真实 `tauriHostPlugins()+capabilityPlugins()` 装配
`REPORT_OK=true`、21 插件全 activated、环境链路 7 个 token 全部注册（`src/app/hosts/hostAssembly.test.ts`）。

**独立复验结果（复核人重跑）**：`tsc --noEmit` exit 0；执行者 4 文件 **53/53 PASS**；
更宽范围 75 文件 **835 passed / 1 skipped / 0 failed**；`cargo test --lib` **31/31**；`git diff --check` exit 0。

**新构建就绪**：前端 17:16 + release exe **17:29**（26.6 MB）。
⚠️ **第一轮现象是在 16:39（修复前）那版构建上观测到的**，修复本身**尚无任何真机证据**——真机复验见 [速查卡](FE-33_速查卡.md) 第二轮节。
⚠️ 复验前必须**完全退出正在运行的 Aika**，否则 `cargo build` 会因 `LNK1104` 失败（已实测）。

## 顺带补的覆盖盲区

`composition.test.ts` 对 `tauriHostPlugins()` 只校验插件 id，从未真正装配。已新增
`src/app/hosts/hostAssembly.test.ts`（1 用例，通过）覆盖真实宿主插件集的启动与 token 注册；
**不覆盖** plugin-sql 真实行为（归 INT-01）。

## 真机配置（现场填写）

- Windows 版本：
- 显示器分辨率 / DPI 缩放：
- 构建号（exe 时间戳）：2026-09-14 16:39
- 独占全屏游戏场景：是 / 否

## 逐 AC 结果

| AC | 场景 | 门槛（摘自 SPEC） | 观测值 / 证据 | 结果 |
| --- | --- | --- | --- | --- |
| FE-33-A | 冷启动零采集 | 分组 `available=true`；两 source 初始「已关闭」；启动零采集；开关与库一致；不支持时显示权限/错误 | **现场存疑**：环境感知分组是否出现/状态文字未知 | 待补证（BUG-02） |
| FE-33-B | 前台应用感知 | 切换 <1s 且进程名正确；20 次开关无线程/句柄泄漏；锁屏 busy=`unknown` | **现场存疑**：开启后无法判断是否生效 | 待补证（BUG-02） |
| FE-33-C | 屏幕抓取 | `ok` 带进程名+客户区矩形（无标题）；pet/主窗回退最后有效外部窗口；遮挡返 `obscured` | 待现场观测 | NOT RUN |
| FE-33-D | 双语读屏性能 | 断网可用；热读屏 P95 ≤3000ms；固定词 ≤2000ms；≤20 段/2000 字符；限流显示下次时间 | 待现场观测 | NOT RUN |
| FE-33-E | 环境摘要出口 | 全关零环境内容；只开摘要仅应用名+时长；开摘录带来源+时间+「（未确认）」；关后立即为空；原图/原文不出现在日志/Trace/DB | 待现场观测（需真实 Provider） | NOT RUN |
| FE-33-F | 陪伴会话 | 各项与 FE-31 状态机一致；拖动不算点击；双击不发两轮；quiet 自动发送 0；暂停后普通聊天可用；结束不中断已有轮 | **2026-09-15 范围变更**：本项原以旧自研桌宠窗口为载体（点「显示桌宠」/拖动/双击/穿透），该实现已由 MVP-03 删除，条目失效需重新划范围；陪伴会话本身的主窗入口（主动/安静/暂停读屏/看屏幕聊聊/结束陪伴）改由 MVP-03-B 真人点验覆盖，外部桌宠表现归 PET-07/MVP-04-D | **条目失效（范围变更）** |
| FE-33-G | 撤销与资源释放 | 迟到结果不外发；停止全部感知显示「已暂停」；WGC/OCR worker/hook 线程释放 | 待现场观测 | NOT RUN |

## 收口的遗留项（本 SPEC 范围）

- FE-19 启动恢复与真机三项（切换延迟/20 次开关/锁屏 busy）
- FE-32-D 真机部分（pet 回退/遮挡拒绝）
- FE-32-F 性能项（真实窗口热读屏 P95）
- FE-32-C 真机出口复核
- FE-31-G 全部
- FE-31-E 锁屏项、FE-19 stopAll 真机

## 场景文本是实际模型输出还是 fixture


## 共享接口变化 / 受影响消费者 / 集成待测项

- `EnvironmentSourceView` 新增只读展示字段 `activity: string | null`；仅由 `App.tsx` 消费，未改变传感器、Monitor 或 LLM 上下文契约。
- 桌宠窗口命令签名与 `pet.presentation.v1` 未变化；聊天消息模型未变化。
- 修复后仍需在 Windows release 真机复验 BUG-01～03，逻辑测试不替代设备证据。


## DEFERRED 项目及原因（不计为通过）


## 执行者自测结论

生产代码定向修复已完成：

- BUG-01：角色 SVG 具备固有尺寸，桌宠容器不再收缩到 0；窗口创建/再次显示时自动回到当前工作区。
- BUG-02：设置页直接显示前台进程或屏幕信号活动证据，且不泄露标题/OCR 原文。
- BUG-03：修正 Grid/Flex 最小高度链，并实现尊重用户上滚的自动滚底。

自测：`npx tsc --noEmit` exit 0；前端定向测试 53/53 PASS；Rust 桌宠命令测试 1/1 PASS。当前结论为“代码修复通过，真机复验待执行”，FE-33 总状态不提升为 PASS。


## 原任务证据审阅结论

待审阅

## 下一小阶段

按 handoff（09-15 修订）：本份通过后**不再走角色线 FE-27→28→29**（该线已 SUPERSEDED，Live2D 归 PET-08 且为 DEFERRED）；下一份是 FE-30 收口（A～I + J～N），但需先完成 0.6 路线决策。
本份**不构成** FE-30 通过。
