# 0.75 全量前端功能与入口映射总表

更新日期：2026-09-22；责任：N075-00。
本表记录系统当前存在的所有页面、子模块、右键条目、独立单页及桌面悬浮控件，为后续逐界面（N075-02～N075-15）重写提供功能全覆盖依据。任何入口均不得在未获确认前被静默遗弃。

## 1. 入口与功能总映射表

| 序号 | 旧入口标识 / 源码入口 | 当前呈现形态 | 核心业务功能 | 目标重构归属 | 对应 SPEC | 依赖 API / Bridge 契约 | 验收对应编号 |
|---|---|---|---|---|---|---|---|
| **1** | `app.mjs` `#page=overview` | 控制台一级页面 | 系统运行状态总览、实例摘要、快捷链接 | 控制台总览面板 | N075-12 | GET `/api/snapshot`, GET `/api/health` | AC-75-12-A |
| **2** | `app.mjs` `#page=memory` | 控制台一级页面（容器） | 记忆、对话、提示词与上下文入口 | 记忆与数据管理主页 | N075-08 | GET `/api/records`, `/api/memory/*` | AC-75-08-A |
| **3** | `app.mjs` `#page=projects` | 控制台一级页面 | 用户本地开发项目、工作区索引 | 项目工作区管理 | N075-13 | GET/POST `/api/projects/*` | AC-75-13-A |
| **4** | `app.mjs` `#page=tasks` | 控制台一级页面 | 任务转发、自动化执行与工单状态 | 任务调度中心 | N075-13 | GET/POST `/api/tasks/*` | AC-75-13-B |
| **5** | `app.mjs` `#page=wechat` | 控制台一级页面 | 微信公众号/企业微信扫码连接与状态 | 微信连接与通知管理 | N075-14 | GET/POST `/api/wechat/*` | AC-75-14-A |
| **6** | `app.mjs` `#page=models` | 控制台一级页面 | 多源模型绑定、API 凭据、参数调节 | API 与模型配置中心 | N075-04 | PUT `/api/settings`, `/api/aika/discovery` | AC-75-04-A |
| **7** | `app.mjs` `#page=presentation` | 控制台一级页面 | 表情动作反应策略、Live2D 动作映射 | 情绪与表现策略配置 | N075-14 | GET/POST `/api/presentation/*` | AC-75-14-B |
| **8** | `app.mjs` `#page=skins` | 控制台一级页面 | 皮肤目录、导入新皮肤、激活外观 | 外观与换肤管理 | N075-06 | GET/POST `/api/skins/*` | AC-75-06-A |
| **9** | `app.mjs` `#page=health` | 控制台一级页面 | 底座健康、各模块 (ASR/TTS/LLM) 就绪诊断 | 模块运行健康监控 | N075-12 | GET `/api/health/*` | AC-75-12-B |
| **10** | `app.mjs` `#page=events` | 控制台一级页面 | 系统事件日志、运行时诊断轨迹 | 运行日志与诊断流 | N075-12 | GET `/api/snapshot` (events) | AC-75-12-C |
| **11** | `views.mjs` `#section=dynamics` | 记忆子标签页 1 | 记忆动态演化总览、重要度统计 | 记忆演化总览 | N075-08 | GET `/api/memory/dynamics` | AC-75-08-B |
| **12** | `views.mjs` `#section=emotion` | 记忆子标签页 2 | 当前角色情绪状态值查看与微调 | 角色情绪状态面版 | N075-14 | GET/POST `/api/emotion/*` | AC-75-14-C |
| **13** | `views.mjs` `#section=import` | 记忆子标签页 3 | 导入外部聊天记录、进度控制 | 历史对话导入任务 | N075-08 | `/api/memory-import/*` | AC-75-08-C |
| **14** | `views.mjs` `#section=fragments` | 记忆子标签页 4 | 原始对话碎片、来源溯源查看 | 记忆来源碎片检索 | N075-08 | `/api/memory/fragments` | AC-75-08-D |
| **15** | `views.mjs` `#section=traces` | 记忆子标签页 5 | 对话决策过程追踪、真实召回项追踪 | 检索追踪与召回审计 | N075-09 | `/api/memory/traces` | AC-75-09-A |
| **16** | `views.mjs` `#section=policy` | 记忆子标签页 6 | 记忆留存策略与遗忘时间阈值设置 | 记忆留存策略设置 | N075-08 | `/api/memory/policy` | AC-75-08-E |
| **17** | `views.mjs` `#section=maintenance` | 记忆子标签页 7 | 手动触发遗忘、后台记忆合并维护 | 记忆维护与遗忘管理 | N075-08 | `/api/memory/maintenance` | AC-75-08-F |
| **18** | `views.mjs` `#section=records` | 记忆子标签页 8 | 结构化记忆记录列表、纠正与编辑 | 记忆记录纠正工作台 | N075-08 | GET/POST `/api/records/*` | AC-75-08-G |
| **19** | `views.mjs` `#section=prompt` | 记忆子标签页 9 | 角色基础 System Prompt 编辑与版本管理 | 基础 Prompt 管理器 | N075-07 | GET/PUT `/api/prompt` | AC-75-07-A |
| **20** | `views.mjs` `#section=context` | 记忆子标签页 10 | 给定输入时注入上下文的实时试算 | 上下文组装试算器 | N075-09 | GET `/api/context` | AC-75-09-B |
| **21** | `pointer-router.ts` `chat` | 桌宠右键条目 1 | 开启/关闭桌面聊天抽屉 | 聊天抽屉快捷触发 | N075-15 | Desktop Bridge: `open_chat` | AC-75-15-A |
| **22** | `pointer-router.ts` `skin` | 桌宠右键条目 2 | 唤出桌宠换肤轻量面板 | 桌面换肤浮层 | N075-06 | Desktop View: `skin` | AC-75-06-B |
| **23** | `pointer-router.ts` `knowledge` | 桌宠右键条目 3 | 打开知识库（原错链至脚本，FE75-01） | 知识库管理入口 | N075-10 | Console DeepLink: `#page=knowledge` | AC-75-10-A |
| **24** | `pointer-router.ts` `settings` | 桌宠右键条目 4 | 启动/打开主管理控制台 | 控制台主入口 | N075-02/03 | Desktop Shell: `open_management` | AC-75-03-A |
| **25** | `pointer-router.ts` `memory` | 桌宠右键条目 5 | 打开记忆纠正面板（`#section=records`） | 记忆管理快捷入口 | N075-08 | Console DeepLink: `#page=memory&section=records` | AC-75-08-H |
| **26** | `pointer-router.ts` `timeline` | 桌宠右键条目 6 | 打开时间线面板（原落空，FE75-02） | 双时间线管理入口 | N075-09 | Console DeepLink: `#page=timeline` | AC-75-09-C |
| **27** | `pointer-router.ts` `diagnostics` | 桌宠右键条目 7 | 打开诊断日志（原落空，FE75-02） | 日志诊断快捷入口 | N075-12 | Console DeepLink: `#page=events` | AC-75-12-D |
| **28** | `pointer-router.ts` `microphone` | 桌宠右键条目 8 | 打开桌面麦克风设备选择与试录面板 | 试麦与音频输入浮层 | N075-05 | Desktop View: `microphone` | AC-75-05-A |
| **29** | `pointer-router.ts` `status` | 桌宠右键条目 9 | 打开模块状态页（原落空，FE75-02） | 模块就绪监控入口 | N075-12 | Console DeepLink: `#page=health` | AC-75-12-E |
| **30** | `pointer-router.ts` `click_through` | 桌宠右键条目 10 | 切换鼠标穿透模式（快捷键 Ctrl+Shift+M） | 鼠标穿透开关 | N075-03 | Desktop Shell: `toggle_click_through` | AC-75-03-B |
| **31** | `aika.html` / `aika-view.mjs` | 独立控制台单页 | 独立模型端点、凭据选择、槽位绑定、Timeline | 整合至模型/角色/时间线页 | N075-04/07/09 | `/api/settings`, `/api/aika/*` | AC-75-04-B |
| **32** | `self-setup-view.mjs` | 控制台向导浮层 | 首次运行欢迎、基础模型与语音配置向导 | 首次配置与初始化向导 | N075-02 | `/api/self-setup/*` | AC-75-02-A |
| **33** | `balances-view.mjs` | 控制台配置模态 | 查看云端 API 额度与余额、配置扣费告警 | 余额与凭据额度查看 | N075-12 | GET `/api/balances` | AC-75-12-F |
| **34** | `next65-view.mjs` | 控制台未挂载视图 | 0.65 插件包生命周期与 Flow Profile 编排 | 插件包与 Flow 流程管理 | N075-11 | `/api/packages/*`, `/api/profiles/*` | AC-75-11-A |
| **35** | `knowledge-view.mjs` | 独立知识库视图 | 知识库列表、文档导入、切片查看与切换 | 知识库管理页面 | N075-10 | `/api/knowledge/*` | AC-75-10-B |
| **36** | `desktop/main.mjs` `#drawer` | 桌面浮动抽屉 | 用户文本输入、历史对话列表滚动展示、打断 | 桌面聊天抽屉 | N075-15 | Desktop Turn Bridge | AC-75-15-B |
| **37** | `desktop/main.mjs` `#toast` | 桌面浮动通知 | 快捷键提示、系统警告、穿透状态提示浮条 | 桌面 Toast 通知系统 | N075-15 | Desktop UI Events | AC-75-15-C |
| **38** | `desktop/work-card.mjs` | 桌面浮动卡片 | 自动化工作输入绑定、任务目标提交 | 桌面工作交互卡片 | N075-13 | Desktop Work Bridge | AC-75-13-C |
| **39** | `desktop/work-records.mjs` | 桌面展开面板 | 历史工作任务卡片记录与展开回顾 | 桌面工作记录面板 | N075-13 | Desktop Work Bridge | AC-75-13-D |
| **40** | `desktop/mic-test-panel.mjs` | 桌面模态浮层 | 选择输入麦克风、音量计、本地试录与回放 | 桌面可信试麦面板 | N075-05 | Desktop Mic Bridge | AC-75-05-B |
| **41** | `desktop/display-controls.mjs` | 桌面操作交互 | 模型缩放滑条、拖拽锚点、透明度与定位保存 | 桌面模型显示控制条 | N075-06 | Desktop Display Bridge | AC-75-06-C |

---

## 2. 遗留缺陷（FE75-01～FE75-06）覆盖对照

| 缺陷 ID | 现状说明 | 解决归属 | 预期消除方式 |
|---|---|---|---|
| **FE75-01** | 右键菜单 `knowledge.target` 为 `/knowledge-view.mjs` 脚本路径 | **N075-03 / N075-10** | 规范控制台路由为 `/#page=knowledge`，废弃直接跳转 JS 脚本 |
| **FE75-02** | 右键链接 `section=timeline/diagnostics/runtime` 在 `app.mjs` 中不存在对应 sub-section，全部降级回运行总览 | **N075-02 / N075-03** | 建立精准的一级 Page 路由（`#page=timeline`, `#page=events`, `#page=health`） |
| **FE75-03** | `app.mjs` 固化 `companion` 单角色检验，拒绝其他角色实例 | **N075-07 / N075-08** | 升级为基于 `userId` + `characterId` + `characterInstanceId` 的动态作用域 |
| **FE75-04** | `next65-view.mjs` 与 `Next65Management` 未实际挂载至管理控制台 | **N075-11** | 在主路由登记 `#page=packages`，接入生产宿主生命周期管理接口 |
| **FE75-05** | `app.mjs` 与 `aika-view.mjs` 存在两套重复的模型配置与表单提交逻辑 | **N075-04** | 统合为唯一的多源配置应用服务，废弃独立 `aika.html` 的重复表单 |
| **FE75-06** | 前端界面缺少 0.7 连续性双时间线、Character Pack 草稿持久化及来源引用的展示 | **N075-07 / N075-09** | 接入 0.7 的 `CharacterPackStore` 与 `ContinuityReadPort` 正式管理 API |
