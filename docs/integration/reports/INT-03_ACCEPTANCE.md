# INT-03 验收 · 发布门禁

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
