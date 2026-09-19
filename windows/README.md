# AAAAGENT Windows 0.1.1


**自助配置：** 编译后运行 `npm run configure-local`（Windows 用 `npm.cmd`），即可填写 DeepSeek/百炼 Key、选择已适配模型、上传自己的参考音频。使用前需在百炼开通对应模型并配置 Key。Harness 与 Codex 必须另装、启动并完成登录或配置，缺失时不能向其转发任务。详见[安装与配置](docs/SETUP.md)。

Windows 桌宠开发与本地运行入口。

- [安装、配置和任务派发](README-WINDOWS.md)
- [本机验证记录](WINDOWS-VALIDATION.md#2026-09-17-windows-reproduction)
- [0.1.1 修复内容](CHANGELOG-WINDOWS.md)

首次离线预览可双击 `Start-Windows.cmd`；配置真实服务后，在 `code/desktop-pet` 执行 `npm.cmd start`。

Windows 0.1.1 已实测 Codex app-server 和 DeepSeek Harness 的任务确认、发送与完成回执。模型、Cubism SDK 和服务凭据需自行配置。Mac 版本的代码与说明不受本次更新影响。

本项目原创内容禁止商用；使用须署名 AAAAGENT、原作者及[项目来源](https://github.com/phoiex/AAAAGENT)。完整条款见 [LICENSE](../LICENSE)。

新增 **记忆 → 导入旧聊天**，操作、模型费用与数据边界见[记忆说明](docs/MEMORY.md#导入旧聊天)。此功能的合成回归与真实 Windows 使用体验分开验证。
