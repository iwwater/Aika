# AAAAGENT Windows 0.1.1

Windows 桌宠开发与本地运行入口。

- [安装、配置和任务派发](README-WINDOWS.md)
- [本机验证记录](WINDOWS-VALIDATION.md#2026-09-17-windows-reproduction)
- [0.1.1 修复内容](CHANGELOG-WINDOWS.md)

首次离线预览可双击 `Start-Windows.cmd`；配置真实服务后，在 `code/desktop-pet` 执行 `npm.cmd start`。

Windows 0.1.1 已实测 Codex app-server 和 DeepSeek Harness 的任务确认、发送与完成回执。模型、Cubism SDK 和服务凭据需自行配置。Mac 版本的代码与说明不受本次更新影响。

本项目原创内容禁止商用；使用须署名 AAAAGENT、原作者及[项目来源](https://github.com/phoiex/AAAAGENT)。完整条款见 [LICENSE](../LICENSE)。

新增 **记忆 → 导入旧聊天**，操作、模型费用与数据边界见[记忆说明](docs/MEMORY.md#导入旧聊天)。此功能的合成回归与真实 Windows 使用体验分开验证。
