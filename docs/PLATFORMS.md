# Mac / Windows 与问题反馈

[简体中文首页](../README.md) · [English](#english)

**macOS 是目前最完善的版本。Windows 版持续完善中；如遇问题，请及时在本仓库的 Issues 中反馈，我们会在对应 Issue 中跟进处理。**

## 选对源码目录

| 项目 | macOS | Windows |
| --- | --- | --- |
| 源码 | `code/desktop-pet/` | `windows/code/desktop-pet/` |
| 安装说明 | [Mac 安装与配置](SETUP.md) | [Windows 安装与配置](../windows/README-WINDOWS.md) |
| 桌面宿主 | Swift / AppKit / WebKit | Electron |
| 使用定位 | 当前功能最完整的主版本 | 源码移植版，可继续开发和反馈 |
| Codex 任务转交 | 按本机服务配置接入 | 通过 Windows Codex app-server 适配接入，详见 Windows 安装说明 |
| Live2D / SDK | 使用者本地自备并适配 | 使用者本地自备并适配 |
| 账号与运行数据 | 使用自己的配置与凭据 | 使用自己的配置与凭据；不能直接沿用 Mac 的绝对路径及激活指纹 |

不要把 `windows/` 内容覆盖到根目录，两个版本分别保留自己的依赖锁文件、构建和启动方式。仓库中的鲸鱼娘资源包含静态设计稿与基础分层，模型绑定仍在制作中。

## Windows 当前边界

Windows 包提供 Electron 宿主、窗口交互、本地预览、平台路径及权限适配。离线预览会回显输入；接入真实模型需要按安装说明配置服务。

移植作者随包提供了 [Windows 验证记录](../windows/WINDOWS-VALIDATION.md) 与 [离线压力测试记录](../windows/WINDOWS-STRESS-RESULTS.md)。麦克风、摄像头、云端 ASR/TTS、微信接收和唤醒效果请在自己的设备试用。

本次发布准备在 macOS / Node 24.19 环境隔离复核了 Windows 源码：后端编译通过，平台测试组 11/11、发布组 115/115、合成压力组 5/5 通过。测试中的 Windows 专属 ACL、跨盘等分支未在这台 Mac 上执行；Electron、设备与云服务另需在 Windows 上检查。

原较广测试库仍有 4 项已知失败，Mac 安装文档和 Windows 验证说明中都有记录。

## 怎样反馈问题

打开本仓库顶部的 **Issues → New issue**，使用问题反馈模板。请提供：

1. 系统及版本、CPU 架构、Node.js 版本。
2. 使用的是根目录 Mac 版还是 `windows/` 版，以及提交号。
3. 从启动到出错的具体操作、预期结果和实际结果。
4. 去除敏感信息的错误日志，必要时附截图。

语音问题请区分录音、转写、回复生成和播放；任务问题请说明执行者是 Harness 还是 Codex。请勿上传 API Key、登录二维码、账号会话、个人数据库、完整对话或无权转发的角色模型。我们会在对应 Issue 中核对复现并跟进处理。

<a id="english"></a>

## English

**macOS is currently the most complete version. Windows is still being improved. Please report problems through this repository's Issues, where we will follow up.**

Use the root `code/desktop-pet/` for macOS, or `windows/code/desktop-pet/` for the separate Electron Windows version. Follow [Mac setup](SETUP.md#english) or [Windows setup](../windows/README-WINDOWS.md). Do not overwrite one tree with the other or share their dependency/build directories.

The Windows port includes an Electron host and platform-specific path, permission and window handling. Its offline preview echoes input; configure a provider for model chat. Bring your own authorized Live2D rig, SDK, credentials and configuration. The supplied character artwork contains static images and layers, with rigging still in progress.

Windows Codex forwarding uses its app-server adapter; follow the Windows setup guide. Physical audio/video, cloud speech, WeChat delivery, wake accuracy and real Harness dispatch require separate validation. Mac paths and activation fingerprints cannot be reused unchanged on Windows.

The [Windows validation](../windows/WINDOWS-VALIDATION.md) and [stress-test notes](../windows/WINDOWS-STRESS-RESULTS.md) were supplied by the port's author. During release preparation, the Windows source was checked in isolation on macOS with Node 24.19: backend build passed, as did 11 platform-group tests, 115 release tests and five synthetic stress tests. Windows-only ACL and cross-drive branches were not exercised on this Mac. Electron, devices and cloud services were not started. Four known failures in the broader inherited test suite remain documented.

To report a problem, open **Issues → New issue** and include OS/CPU/Node versions, platform directory and commit, reproduction steps, expected/actual behavior and sanitized logs. For voice issues, distinguish capture, transcription, generation and playback. Never attach credentials, login QR codes, sessions, personal databases, private chats or non-redistributable model assets. We will investigate and follow up in the issue.
