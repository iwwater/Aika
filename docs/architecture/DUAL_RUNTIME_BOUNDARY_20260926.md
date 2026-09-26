# 合批后的双运行端边界 · 2026-09-26

状态：**边界已核对；下一交付主端待产品决定**。基线 `codex/aika-local-cloud-merge`，`4e723e3`。本记录是当前交付选择的依据，不创建跨端共享运行时，也不迁移用户数据。

| 维度 | Aika Tauri / React | Aika Next Windows Electron |
| --- | --- | --- |
| 入口与定位 | 根 [README](../../README.md) 将 `aika-crossplatform/` 记为 Windows 当前主工程；`src/main.tsx` 经 `createAikaKernel` 启动，浏览器 dev 与 Tauri 共用前端。 | [Next 说明](../../README-NEXT.md)原将 macOS 作为上游主要版本，Windows 位于 `windows/code/desktop-pet/`；Electron `desktop/electron/main.mjs` 启动独立后端和管理界面。两份说明描述的是合批前不同产品线，不能互相代替。 |
| 运行时与契约 | `src/app/composition.ts` 装配 `RuntimeToken`、Presenter、宿主与能力插件；业务按 `src/domain/` / `src/services/` 分层。 | `app/trial-backend.ts` 装配 `BackendSession`、管理 API、Collection 与 CompanionMode 运行时；契约在 `contracts/`，无直接调用 Tauri `RuntimeToken` 的生产接线。 |
| 持久化与凭据 | 正式桌面 `sqlite:aika.db`（Tauri identifier `com.aika.companion`）；浏览器 dev 使用 localStorage，密钥处理按宿主区分。 | Electron `userData` 独立在 `AikaNext` 命名空间；试用配置显式指定 database 和 projectRoot，部分功能另用 `.local/data`。不得将其视为 Tauri 的同一库或自动迁移来源。 |
| 本轮可核实能力 | 文本界面、设置与本地任务入口能在浏览器启动；插件/任务定向回归通过。真实 Tauri、通知和完整语音链未在本轮运行。 | 0.79/0.81/0.82 有各自定向代码与报告；0.79 发布准入、0.81 G4/G5 与试运行、0.82 CR-02/03 均未完成，不能按文件存在推断整版可交付。 |
| 当前准入 | 浏览器启动缺口已修；Tauri 产品安装/设备门槛依现有模块与集成报告复核。 | UI MVP 正式入口待修；0.79 旧库及 Electron UI 环境、0.81 设备与资源门槛、0.82 后置项各自独立记录。 |

## 执行决定

1. 两端保持各自组合根、数据根、版本状态和报告；本轮不搬运对话、记忆、角色、授权或任务记录，不把两端的 `Runtime`/`BackendSession` 直接接在一起。
2. 产品默认入口暂沿用根 README 的 Aika Tauri/React 口径。Next Windows Electron 继续作为独立交付线审阅，0.79/0.81 的准入和 UI 修复按该线现有 SPEC 执行；若用户决定改以 Next 为下一交付主端，只调整优先级，不更改本表事实。
3. 任何跨端共享需求先写清一个用户场景和字段级契约，再列来源数据、权限、撤销、冲突和回滚方案；只有获准的单一消费者接线可进入实施。不存在“合批 Git 后自动共享数据”的默认迁移。
4. 下一次合入 `master` 或 `aika-next` 需先通过[合批准入核对](../integration/MERGE_ADMISSION_20260926.md)，尤其是许可证覆盖范围；合入动作不代签任一版本验收。

## 待决定项

下一交付版本优先投入哪一端：Aika Tauri、Next Windows Electron，或两端分别维护。该选择只影响 P1 工作排序；两端现有数据与验收边界均保持独立。选定后把决定补在本节，旧报告不回填为 PASS。
