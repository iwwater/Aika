# Aiki Desktop Pet Integration — RPD

> **2026-09-15 当前口径**：下文 v0.2 保留为 0.5 接入基线，原“实现 NOT RUN”是起草时状态；当前结果以 [PET 索引](SPEC_DESKTOP_PET.md)及 [0.5 收口索引](../integration/SPEC_MVP_0.5.md)为准。0.6 路线由 [Pet Shell RPD v1.2](../RPD_MVP_0.6.md)及 [SPEC 草案](../integration/SPEC_MVP_0.6.md)覆盖；NyaDeskPet 不作为当前可派发路线。0.5 仍集成原版 Runtime；0.6 规划也不恢复 Aika 主应用内自研窗口。本次仅修改文档。

> Version: 0.2 · 2026-09-14 · Windows First
> 决策：集成现成 Runtime；文档已重写，代码与实机验收 NOT RUN。
> 产品称 Aiki；现有仓库名 Aika、代码标识 aika 均不重命名。

## 1. 产品定位

Aiki 通过独立桌宠程序展示对话、情绪与任务进度。Aiki 0.5 首选 OpenPet Sidecar + localhost HTTP；0.6 按表现力需求决定继续 OpenPet，或接入 NyaDeskPet Live2D 前端。

本文件取代用户提供的《Aiki Desktop Pet Runtime — RPD v0.1》。不再立项 WindowManager、Renderer、BehaviorFSM、HitTest、动画调度器、气泡组件、角色资源管理器、桌宠托盘或 Cubism 集成。已有实现的迁移按 PET-06 处理；废弃设计不等于本轮删除代码。

Aiki 现有主应用可继续使用 React/Tauri；禁止把“取消自研桌宠”误解为重写 Aiki 主应用或对话 Runtime。

## 2. 目标、版本与边界

| 版本 | 必须交付 | 明确边界 |
| --- | --- | --- |
| 0.5 | OpenPet status / say / action / event；emotion 语义映射；能力检测；连接设置；Sidecar 生命周期；故障隔离 | 单个 Runtime、单个活动角色；先外部安装与手动启动，不 Fork、不合并源码 |
| 0.6 | 继续 OpenPet，或执行 NyaDeskPet 条件接入与 Live2D 验收 | 只有启用 Live2D 路线才执行 PET-08；不预先实现第二套适配器 |
| 后续 | 更多 Runtime adapter、经过验证的双向事件、音频口型 | 独立立项，不扩写 0.5 的渲染或插件系统 |

0.5 完成表示 Aiki→桌宠表现闭环成立。它不表示旧 FE-31 的桌宠输入框、点击读屏菜单、双向交互或 Live2D 口型已经完成；这些产品诉求保留为独立待办，不能伪造 OpenPet 能力补齐。

## 3. 核心用户场景

1. 用户安装并启动 OpenPet，在 Aiki 开启桌宠集成并测试连接，看到真实连接状态与演示气泡。
2. Aiki 开始处理当前轮，桌宠收到短暂 thinking 状态；最终回复生成后展示一次气泡和适配的情绪动作。
3. 已有主动陪伴策略产生获授权的“欢迎回来”回复，接入层展示动作与气泡。接入层不新增感知源、主动策略或 LLM 调用。
4. 用户关闭桌宠或 Runtime 崩溃，Aiki 文字聊天与语音继续；界面标离线并允许重连。
5. 用户选择随 Aiki 启动桌宠后，Aiki 启动已配置的运行程序；退出时仅按配置处理本次由自己启动的进程。

## 4. 架构与责任

```text
Aiki Voice / Agent / Memory / Emotion / Perception
                    │ 已有公开展示事件
             DesktopPetService
       ┌────────────┼──────────────┐
   Event Mapping  Capabilities  Process Manager
                    │
             DesktopPetAdapter
                    │
      0.5 OpenPetAdapter ──HTTP──> OpenPet 进程
      0.6 NyaDeskPetAdapter（条件）<──WS── NyaDeskPet 前端
```

| 所有者 | 责任 |
| --- | --- |
| Aiki 业务模块 | 对话轮次、取消、情绪推断、TTS、记忆、感知权限、主动陪伴策略 |
| DesktopPetService | 启停接入、有限发送缓冲、过期/旧轮丢弃、状态、错误隔离 |
| Adapter | 归一化接口与供应商协议转换；只使用已验证能力 |
| Process Manager | attach / managed 两种模式、就绪探测、进程所有权；不管理动画 |
| 第三方 Runtime | 窗口、拖动、置顶、托盘、角色加载、Idle、动作播放、气泡及自身设置 |

遵循唯一 CompanionRuntime、构造参数注入、平台判断限于宿主装配的现有共享契约。HTTP 走 Aiki 原生宿主传输端口，避免把 WebView CORS 成功作为架构前提。浏览器宿主可用 fake 做模块调试，不隐式添加远程代理。

## 5. 外部项目核实与选择

2026-09-14 读取官方资料；以下为资料核实，不是本机运行结果。

| 项目 | 资料支持的结论 | 尚需实机确认 |
| --- | --- | --- |
| OpenPet | Sprite；HTTP 默认 127.0.0.1:17321；Windows 是作者主要人工验证平台；GPL-3.0-or-later | 锁定 Release 的字段、当前角色动作、就绪特征、退出方式、Aiki→可见表现 |
| NyaDeskPet | Live2D；前后端 WebSocket 分离；MIT；提供 Windows 开发和构建流程 | 外接 Aiki 后禁用内置 Agent 的配置路径、前端独立运行、重连、音频及模型资源许可 |

依据：[OpenPet README](https://github.com/X-T-E-R/OpenPet)、[NyaDeskPet README](https://github.com/gameswu/NyaDeskPet)。

OpenPet 发布页本次显示 v0.1.6，并提供 `OpenPet_0.1.6_x64-setup.exe`。这是安装器；Process Manager 启动的是安装后的实际运行程序。PET-01 固定选用版本、资产 URL、哈希与对应 commit；不以可变 latest 作为兼容性承诺。[Release](https://github.com/X-T-E-R/OpenPet/releases/tag/v0.1.6)

0.5 采用用户单独安装上游软件的交付方式。源码许可证、二进制再分发、角色图片及模型授权分别登记；独立进程通信不等于自动消除发行义务。将来捆绑分发时单独完成材料核查，不把本文件当法律结论。

## 6. 功能需求与验收归属

| ID | 需求 | SPEC |
| --- | --- | --- |
| DPI-01 | 固定可运行的 Windows OpenPet 版本与协议证据 | PET-01 |
| DPI-02 | 稳定接口、可选能力、结构化结果和无侵入降级 | PET-02 |
| DPI-03 | 实现四个 HTTP 控制端点；请求有界；字段与上游一致 | PET-03 |
| DPI-04 | emotion / Agent 事件映射；白名单、轮次隔离、去重 | PET-04 |
| DPI-05 | 外部附着与受管启动；不误杀用户进程、不无限重启 | PET-05 |
| DPI-06 | 生产装配、设置、诊断；新模式关闭旧自研 pet 启动链 | PET-06 |
| DPI-07 | 真正的 Windows Aiki→OpenPet 动作与气泡、离线恢复验收 | PET-07 |
| DPI-08 | 可选 NyaDeskPet 服务端接入、Live2D 与切换验证 | PET-08 |

## 7. 表现能力与降级

`emotion` 是 Aiki 的语义能力，不假设 OpenPet 有 `/api/emotion`。0.5 通过“语义情绪→当前角色已验证 animationId”映射表达；映射缺失则只保留文本，并记录 unsupported。`happy`、`wave` 等业务名不是供应商动作 ID。

能力值统一为 native / mapped / unsupported / unknown。断线时能力快照可保留，但必须标 stale，禁止将缓存当当前可用。未发现动作列表时使用与版本、角色绑定的已验证配置；不通过乱发动作来猜能力。

OpenPet 的 companion event 是 Aiki 发给桌宠的进度输入，不等于桌宠点击事件回调。0.5 不承诺点击上报、MotionFinished、音频输入或口型。现有 TTS 仍由 Aiki 播放。

## 8. 生命周期、可靠性与隐私

- 初始 `enabled=false`；启用后默认 attach。managed 必须显式选择并配置可执行文件。不存在自动下载、静默安装或自动更新。
- 默认仅访问 loopback，地址、端口是配置；拒绝重定向与非本机地址。不因现有 Gateway 支持公网而开放桌宠 API。
- 桌宠请求不阻塞 submit、TTS 或存储。单请求默认 1500ms 超时；GET 探测可退避重试，POST 不自动重试，避免重复气泡与动作。
- 仅发送用户可见的最终文本、允许的动作和短状态。默认日志不记气泡正文，不发送内部推理、密钥、完整记忆、截图或 OCR 原文。
- 取消/换轮/禁用会撤销本地未发指令；已被 Runtime 接收的命令无法保证撤回。say/event 可用短 TTL 限制残留；action 没有已核实的 TTL/取消字段，播放终止由上游控制。HTTP 成功表示接受请求，不表示动画播放完成。
- Runtime 关闭不取消 Aiki 业务轮；Aiki 退出也不误杀 attach 的用户进程。

具体数值与可测试语义见 [接入契约](DESKTOP_PET_CONTRACT.md)。

## 9. 性能与完成定义

0.5 自有接入层目标：单目标最多 1 个在途控制请求、最多 16 个待发命令；健康检查正常每 10 秒一次；待机无高频轮询。假时钟验证边界，实机记录事件入队→HTTP 受理→可见表现三个时间点。目标本机 HTTP 受理 P95≤300ms、气泡可见 P95≤1000ms，测至少 30 次；目标未达需记录实测与原因。

第三方 Runtime 的 CPU/RAM/FPS/冷启动是测量项，不继承旧 RPD 的自研优化承诺。PET-07 分别测 Aiki 与 OpenPet 的 10 分钟待机和 30 次交互；发生不可接受问题先配置、换版本或换适配器，不在本项目重写渲染器。

0.5 完成需 PET-01～07 的适用 AC 全部有证据，含真实 Windows 链路。纯 mock 通过只代表模块通过；本次交付只完成文档，不标任何实现 AC PASS。

## 10. 旧计划迁移

| 旧项 | 新裁决 |
| --- | --- |
| 用户粘贴的 Runtime v0.1 全部章节 | 整体由本 RPD 替代，原始附件作为历史输入 |
| FE-20 自研窗口、气泡与中继 | 对新桌宠路线 SUPERSEDED；PET-05/06 负责集成与旧路径停用 |
| FE-27/28 自有 manifest / renderer | 对新桌宠路线 SUPERSEDED；素材继续由上游管理，Live2D 归 PET-08 |
| FE-29 自研口型 | 对新桌宠路线 SUPERSEDED；0.5 无口型，未来复用第三方能力 |
| FE-30、FE-33 的旧桌宠组合项 | 不作 0.5 门禁；PET-07 替代桌宠表现验收，原环境/权限/读屏证据仍有效 |
| FE-18/19/21/22/32 感知与策略 | 保持原责任、权限与验收，不因本方案变更而删除或自动启用 |
| FE-31 陪伴会话 | 业务控制保留；桌宠菜单与输入依赖未满足，主窗保持入口，单列差距 |

具体派发见 [SPEC 索引](SPEC_DESKTOP_PET.md)。这次范围调整不授权卸载第三方程序、删除未提交实现或改动其他模块。
