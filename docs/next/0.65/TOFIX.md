# 0.65 TOFIX 台账

日期：2026-09-22  
来源：用户人工验收反馈（Electron preview 窗口）

| ID | 问题 | 复现 | 原因判断 | 修复状态 | 验证 |
| --- | --- | --- | --- | --- | --- |
| K65-TOFIX-001 | 功能面板除“聊天”和“鼠标穿透”外，点击其它入口没有可见反应 | 右键打开功能面板，点击配置、知识库、记忆、Timeline、日志、模块状态等 | preview 下 shell 会返回 `managementResult: ok=false`，但这些入口没有绑定失败反馈；用户看到的是静默失败 | **已修复**：统一走 `requestManagement`，失败写入功能面板提示并弹出 toast | 自动接线通过；真实管理台成功路径仍待 user-trial |
| K65-TOFIX-002 | 开启“鼠标穿透”后无法恢复交互 | 功能面板 → 鼠标穿透；随后点击桌宠或尝试关闭 | `setIgnoreMouseEvents` 会让窗口退出命中测试，右键不会稳定进入 Electron；仅靠窗口消息钩子无法覆盖所有窗口管理器 | **已修复**：穿透开启时启动 Windows 低级鼠标钩子，按桌宠窗口范围过滤右键；命中后取消 ignore、显示并聚焦窗口，并将右键恢复为功能面板事件；`Ctrl+Shift+M` 保留为兜底 | PowerShell 低级钩子已用合成右键验证输出；Windows smoke 通过；真实桌面失焦/右键仍需用户确认 |
| K65-TOFIX-003 | 左键轻点角色被识别为拖拽或看起来没有反应 | 角色上快速轻点，观察窗口位置和角色反馈 | 拖拽 slop 只有 3px，且按累计相邻位移判断；Windows 指针抖动会越过阈值；已加载的 `TapBody` 动作此前从未播放，且直接轻点受自动动作开关影响 | **已修复**：8px 欧氏阈值，按按下点判断；轻点优先播放模型 `TapBody`，并独立于 `proc-head/proc-body` 自动动作策略 | pointer-router 11/11 通过；Windows smoke 通过；需真实鼠标确认动作可见性 |
| K65-TOFIX-004 | preview 中管理入口提示与功能面板状态不一致 | 点击顶部“控制台”和功能面板中的管理入口 | 顶部入口有 `management-notice`，功能面板只有未消费结果的异步回调 | **已修复**：顶部和功能面板共用结果处理；成功关闭面板，失败显示明确原因 | 自动接线通过；真实管理台成功路径仍待 user-trial |
| K65-TOFIX-005 | 没有可见的桌宠大小调整入口 | 聊天面板只有全身/半身，原边角手柄不可见且难以发现 | 原实现只有隐藏透明拖拽手柄，没有面板内的可发现控件 | **已修复**：聊天面板新增 220~720px 大小滑块，实时发送 `resize_model` 更新，松手提交并沿用原有 `windows-display.json` 持久化；方向键和透明手柄仍兼容 | check/build、next65 全量通过；需人工拖动和重启确认视觉及持久化 |

## 处理规则

- 修复先补最小回归，再跑 `check`、相关 unit/UI 测试和 Windows smoke。
- preview 的“控制台不可用”仍是预期环境限制，但必须显式反馈，不能静默无效。
- 鼠标穿透必须保留可发现的全局恢复方式；恢复后窗口要重新接受鼠标事件并给出状态提示。
- 左键轻点、拖拽、右键功能面板三种手势不能互相吞掉；右键不得移动窗口，左键轻点不得打开聊天。

## 2026-09-22 修复证据

- `npm run check`：通过。
- `node --test dist/tests/next61/fix61-04.pointer.test.js`：11/11 通过。
- `npm run test:next65`：140/140 通过；新增大小控件与右键恢复桥接面测试。
- Windows 低级右键钩子脚本以合成右键事件验证输出 `R <screenX> <screenY>`；窗口范围内按下/抬起由钩子消费，范围外继续放行。
- `npm run test:windows:ui` 的 smoke 额外开启/关闭了一次 click-through，确认钩子启动不会产生 Electron 未处理异常。
- `npm run test:windows:ui`：`WINDOWS_SMOKE_OK`，退出码 0。
- `npm run test:next61`：140/150；剩余 10 项为既有 Live2D 资源缺失、许可证模型差异和 Windows Chromium GPU/缓存 ACL 环境失败，不是本次 TOFIX 的新增失败。
- Computer Use 首轮连接连续返回 `Transport closed`；二次重试后传输恢复但原生应用清单为空（`apps: []`，仅暴露 Chrome 标签页），未伪造点击证据；真实失焦恢复、右键恢复和物理轻点仍需在 Electron 窗口可见后或用户人工验收时补记。
