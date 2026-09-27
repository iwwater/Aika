# INT-03 验收 · 发布门禁

> 最新增量：2026-09-27 当前合批分支的双安装包及隔离安装/卸载已补验，见文末。以下 2026-09-15 的 NSIS BLOCKED、安装 NOT RUN 是当时状态；当前发布结论仍为 **BLOCKED**，不能从安装成功推断可公开发布。

- 模块 / 小阶段：集成 / INT-03（[integration/SPEC.md](../SPEC.md) 第 9 行）
- 基线 commit：`4cfe493`
- 执行日期：2026-09-15
- 被测构建：前端 `dist`（`npm run build` 17:2x）+ `src-tauri/target/release/aika-crossplatform.exe` 27.4 MB（17:31 重新构建）
- 总状态：**部分 PASS** —— 代码与构建门禁全绿、release 启动/重开回归通过、MSI 打包产物产出；**NSIS 打包 BLOCKED（工具链下载超时）**、**安装/卸载回归 NOT RUN（需在你机器上做系统级安装）**。**不宣布发布就绪**。

> 口径：本报告只记本次实际执行的命令与退出码。逻辑测试不等于 UI 可用，也不等于真机安装可用；做不到的项如实记 NOT RUN / BLOCKED。

## 1. 门禁逐项结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试 | `npx vitest run`（aika-crossplatform/） | ✅ **exit 0**；153 文件通过 / 4 skipped（4 项均为需真实凭证的 real 用例：llm01 / llm05 / llm12 / crossSession.real）；**1659 项通过 / 0 失败** |
| 类型检查 | `npx tsc --noEmit` | ✅ exit 0 |
| 前端构建 | `npm run build` | ✅ exit 0；`✓ built in 6.16s` |
| 原生测试 | `cargo test --offline --lib` | ✅ **41 passed / 0 failed** |
| 桌面构建（release） | `cargo build --release --offline --features custom-protocol` | ✅ exit 0（2m13s）；产物 27.4 MB |
| 桌面打包（tauri build） | `npx tauri build` | ⚠️ **部分**：release 重建 ✅（1m57s）、**MSI ✅**（`bundle/msi/Aika_0.3.0_x64_en-US.msi`，15.8 MB @17:31:19）；**NSIS ❌ `Error failed to bundle project: timeout: global`**（工具链获取超时，见 §3） |
| 启动回归 | `Start-Process`（**不重定向 stdout**，见 FE-33 记录） | ✅ 进程存活、`MainWindowHandle` 非空、标题 `愛花 Aika`、92 MB、`Responding=True` |
| 重开回归（渲染+历史加载） | `PrintWindow`（`PW_RENDERFULLCONTENT`，不抢前台） | ✅ 窗口自身像素完整渲染：角色区、对话区（含 17:03 真实 proactive 轮与其译文）、侧栏（DeepSeek `deepseek-flash`、相处状态、长期记忆、快速开始）——**历史从库加载成功**，非空白页 |
| 安装/卸载回归 | Windows 安装器安装 → 启动 → 卸载 | **NOT RUN**：属系统级安装，未获授权在用户机器执行；MSI 产物已就绪，可随时补 |
| 打包资源（离线 OCR） | 检查 `dist/tessdata/` | ✅ 前端构建产物含 `eng.traineddata` + `chi_sim.traineddata`（FE-33 D 项前置，前次报告已登记哈希） |

## 2. 启动回归的取证方式（可复现）

```powershell
Start-Process "src-tauri/target/release/aika-crossplatform.exe" -PassThru   # 不要重定向 stdout
# 20s 后：Get-Process -Id <pid> → MainWindowHandle / MainWindowTitle / Responding
# 窗口像素：PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2) → 存 PNG
```

- **为什么不用屏幕截图**：会连带拍到用户当前桌面内容。`PrintWindow` 抓的是窗口自身，与遮挡无关，也避免采集私人画面。
- **为什么不重定向 stdout**：release 版 `windows_subsystem="windows"` 无控制台，重定向会导致进程提前退出（FE-33 已记录该测试方法陷阱）。

## 3. NSIS 打包失败（如实记录，未定性为产品缺陷）

- 命令输出：`Info Patching … with bundle type information: nsis` → `Error failed to bundle project: timeout: global`。
- 判断：`timeout: global` 是打包器**获取外部工具链**时的超时，属环境/网络条件，不是应用代码问题；同一次运行里 MSI（`light.exe`，工具链已在本地）**成功**。
- 证据边界：本次**没有**试图绕过或镜像工具链；NSIS 安装包仍停留在旧产物（`nsis/Aika_0.3.0_x64-setup.exe` 9 MB @2026-09-10），**旧包不代表本次构建**。
- 补齐条件：允许联网获取 NSIS 工具链，或预置离线工具链后重跑 `npx tauri build`。

## 4. 与 DEFERRED 项的关系

- **INT-02（语音联动）DEFERRED**：本次门禁**不**因缺少真人语音验收而记通过，也**不**把语音项写成通过；发布判定保持「未达发布就绪」。
- 真实 Provider 质量按各 LLM 原 AC 另验（MVP-06-F 已于 09-15 补跑，LLM-05 门槛 10/10 PASS）；本门禁只覆盖「能不能构建、能不能起」。

## 5. 结论与下一步

- 代码门禁（测试/类型/构建/原生）**全绿**；release 应用**确实能启动、能渲染、能读到历史**。
- 距「发布就绪」还差：**NSIS 打包**（环境）→ **安装/卸载回归**（需授权）→ 以及非本门禁项（FE-33 真机逐 AC、MVP-03-B 真人点验、Voice 闭环）。
- **不宣布发布就绪**；README/SPEC 索引里的发布状态不得据此提升。

## 6. 当前合批分支补验（2026-09-27）

基线 `07dc3a0`（`codex/aika-local-cloud-merge`）；正式构建不覆盖 `identifier=com.aika.companion`，只生成产物，不安装它。安装测试另以 Git 忽略的临时 Tauri 配置把 `productName` 改为 `Aika Acceptance`、`identifier` 改为 `com.aika.companion.acceptance`，明确 `nsis.installMode=currentUser`；业务源码与能力声明相同，故能验证安装和宿主行为，但该隔离包装不等于正式发布包。

| 门禁 | 实际命令或操作 | 结果 |
| --- | --- | --- |
| 前端全量测试 | `npm test` | **PASS，退出码 0**；158 文件通过、4 文件条件跳过；1718 项通过、4 项因真实凭证条件跳过 |
| 原生库测试 | `cargo test --offline --lib` | **PASS，退出码 0**；48/48 |
| 当前分支构建与双打包 | `npx tauri build --ci` | **PASS，退出码 0**；内含 `npm run build`（tsc、Vite 2075 模块）及 Release Rust 编译，MSI、NSIS 均新产出；Vite 分包警告和 3 条既有 Rust 警告不影响退出码 |
| NSIS 工具链补验 | 本地缓存 `makensis` v3.11；当前构建实际调用 `makensis` 成功 | **PASS**：原报告的 `timeout: global` 本次未复现；不能倒推出当时超时的确切根因 |
| 离线 OCR 资源 | `dist/tessdata/` | `eng.traineddata` 与 `chi_sim.traineddata` 均存在 |
| 独立包装与安装 | `npx tauri build --ci --bundles nsis --config <Git 忽略的测试配置>`；独立包 `/S /NS /D=<本任务隔离目录>` | **PASS，退出码均为 0**；安装目录原先不存在，安装后有应用 EXE 和 `uninstall.exe`，HKCU 出现 `Aika Acceptance` 注册项。`/NS` 特意不创建快捷方式，因此普通安装模式下的快捷方式创建未在此轮覆盖 |
| 已安装宿主启动、重开 | 启动安装目录内 EXE；用 WebView2 CDP 检查真实页面 | **PASS**：两次进程 `Responding=True`、主窗 handle 非零；页面 `.app-shell=1`、聊天行 1、存储警报 0；独立 `%APPDATA%/com.aika.companion.acceptance/aika.db` 创建 |
| 卸载及残留 | 退出指定测试进程，运行该安装目录的 `uninstall.exe /S` | **PASS，退出码 0**；安装目录与 HKCU 注册项消失、测试快捷方式不存在；隔离 AppData 中 4096 字节数据库仍在，说明该次卸载保留用户数据。核对路径后仅手动删除本次测试 AppData 与 WebView2 profile |
| 签名与发布准入 | `Get-AuthenticodeSignature`、[合批准入记录](../MERGE_ADMISSION_20260926.md) | 正式 MSI 和 NSIS 均 `NotSigned`；Aika 自有代码/素材的许可证覆盖范围仍待权利人确认，公开发布准入 **BLOCKED** |

本次正式产物 SHA-256：

| 产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `Aika_0.3.0_x64_en-US.msi` | 16,629,760 | `65180C22FE873BE035B1E58A6E6BF70F83A6285B88CE555A23DBE111F8A3140F` |
| `Aika_0.3.0_x64-setup.exe` | 13,290,393 | `ED4320861A9BBE39B21970449F4714C085F92A8BE180CE05D255022508A9A13F` |
| 隔离安装用 `Aika Acceptance_0.3.0_x64-setup.exe` | 13,289,503 | `76FA3DA1CF7FF8FE28D36E9AEC958DDB3B5343AF5E927657735F0FE8B6E98EEC` |

**当前结论：INT-03 工程构建、NSIS 与隔离安装/卸载列 PASS；发布准入仍 BLOCKED。** INT-01 仍有真实 Provider、手机和部分页面/音频列未验，INT-02 继续 DEFERRED；旧 Handoff 偶发退出按下方独立观察记录判定，不能由一次启动或安装通过宣称修复。截图仅留在本任务本地可视化目录，未进 Git。

### INT-03-STABILITY 独立观察

历史证据 [2026-09-17 宿主观察日志](evidence/HANDOFF_20260917_host_observation.jsonl) 已连续记录进程存活 7201.86 秒（约 2 小时），但仅观察进程，原触发条件、正常使用和窗口状态没有完整证据，当时也未判 PASS。本次当前分支使用隔离 identifier 的 Release EXE，PID `12916`，自 2026-09-27 02:37:23 UTC 至 02:42:43 UTC 观察 320.5 秒，进程持续存活、`Responding=True`，WebView2 调试端点仍有 `http://tauri.localhost/` 页面；随后由执行者主动停止进程并清理隔离数据。没有自行退出事件，因而没有可采集的异常退出码或崩溃日志。本次也未覆盖原先的主动桌宠触发条件，故状态为 **OPEN / 本观察窗未复现**，不能据此认定偶发退出已修复。生产源码、共享接口未改动。
