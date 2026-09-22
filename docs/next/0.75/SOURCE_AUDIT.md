# 0.75 前端架构与入口核对

更新日期：2026-09-22。依据当前有未提交改动的工作树静态核对；实施前须重新固定基线。下述路径均指实际 Windows 实现。

目录：[入口](#1-实际入口与责任) · [问题](#2-发现与影响) · [保留](#3-需要保留的正确边界) · [替换](#4-迁移规则)

## 1. 实际入口与责任

| 入口/代码 | 当前职责 | 重构归属 |
| --- | --- | --- |
| [management/ui/app.mjs](../../../windows/code/desktop-pet/management/ui/app.mjs)、[views.mjs](../../../windows/code/desktop-pet/management/ui/views.mjs) | 10 个控制台 page，10 个记忆 section；全局状态、鉴权、请求、草稿、页面渲染集中 | N075-01/02 及各功能页 |
| [aika.html](../../../windows/code/desktop-pet/management/ui/aika.html)、[aika-view.mjs](../../../windows/code/desktop-pet/management/ui/aika-view.mjs) | 独立模型配置、profile 和 Timeline | N075-04/07/09；旧入口迁移 |
| [desktop/main.mjs](../../../windows/code/desktop-pet/desktop/main.mjs) | 聊天、右键、试麦、播放、工作卡片和 renderer 接线 | N075-03/05/06/13/15；按职责拆，保留轮次和渲染权威 |
| [pointer-router.ts](../../../windows/code/desktop-pet/desktop/pointer-router.ts) | 指针路由与右键入口清单 | N075-03；只改变经确认的菜单与目标映射 |
| [electron/main.mjs](../../../windows/code/desktop-pet/desktop/electron/main.mjs)、[preload.cjs](../../../windows/code/desktop-pet/desktop/electron/preload.cjs) | 本地窗口、可信桥、控制台启动、尺寸和穿透 | N075-01/03/06；保持命令白名单 |
| [server.ts](../../../windows/code/desktop-pet/management/server.ts) | 管理鉴权、静态文件白名单、API 分发 | 新构建资源/路由需适配；不绕过鉴权 |
| [next65-view.mjs](../../../windows/code/desktop-pet/management/ui/next65-view.mjs)、[next65-management.ts](../../../windows/code/desktop-pet/management/next65-management.ts) | 包/诊断呈现函数与管理服务类 | N075-11；有源码不代表主界面/生产宿主接通 |

## 2. 发现与影响

| ID / 优先级 | 可复核证据 | 用户影响与处理 |
| --- | --- | --- |
| FE75-01 / P1 | PANEL_ENTRIES 的 knowledge.target 为 `/knowledge-view.mjs`；main 的 console 分支直接打开该 target；server 将它当 JavaScript 资源提供 | 入口不会挂载知识库页面。N075-03/10 建立统一页面目标，不能链接脚本文件 |
| FE75-02 / P2 | 右键 `section=timeline/diagnostics/runtime`；app 仅接受 MEMORY_SECTIONS，其中没有这三个键 | 请求落回总览，入口名称与页面不一致。N075-02/03 建立旧地址映射并逐条验路由 |
| FE75-03 / P1 | app 的 refreshSnapshot 拒绝非单个 `companion`；状态也固定 companion | 不能承接 0.7 的角色实例体验。N075-07/08 以服务端作用域为准；不能只删除校验而不替换隔离保证 |
| FE75-04 / P1 | app 无 next65-view 导入，server 静态白名单无 next65-view；Next65Management 未在该 server options 中注册 | 不能把包管理函数称为已交付 UI。N075-11 先接真实宿主管理端口；loaded:false 常量不能展示成运行真相 |
| FE75-05 / P2 | app、独立 aika-view 都维护配置表单与请求；desktop/main 同时控制多类 UI 和播放/renderer | 重写易造成重复配置和生命周期回归。共享服务、页面独立状态、桌面适配分离；不强行合并 renderer 与控制台 |
| FE75-06 / P1（继承） | [此前架构核对](../ARCHITECTURE_REVIEW_20260922.md) 的连续性主链、后台提交、Binding 解析等缺口（AR-01～05） | UI 不得自行补一套推理/记忆链。由 0.7/原模块补业务权威，再经管理接口消费 |
| FE75-07 / P1 | [CharacterPackStore](../../windows/code/desktop-pet/memory/character-pack-store.ts)、[ContinuityMemoryStore](../../windows/code/desktop-pet/memory/continuity-memory-store.ts)、[ContinuityContextComposer](../../windows/code/desktop-pet/memory/continuity-context.ts) 均已实现并有测试（IMPLEMENTED）；但 [架构核对 AR-01](../ARCHITECTURE_REVIEW_20260922.md)：trial-backend 创建 ObservedTrialMemory 时仅传 knowledge，Composer 的生产消费在 app/core 检索未发现 | 正式 `DialoguePipeline` 的 foreground context 尚未完整消费这些来源。通过管理 API 保存的 Soul/关系不等于普通桌面对话会读到。N075-01 负责接线：只读适配层把 Composer 输出投影进现有 DialogueContext 组装，保持 ONE DialogueContext / ONE Dialogue LLM Call |
| FE75-08 / P1 | [tools/real-backend.mjs](../../windows/code/desktop-pet/tools/real-backend.mjs) 存在 `LLM → 每轮 Distill → direct SQL memory_records → direct memory_search → RuntimeTraceStore` 的实验链路 | 该文件是 **DEV / SMOKE / EFFECT VALIDATION ONLY**，不是 Production Truth。验证了自动 Distill / Trace 可行，但绕过部分正式生命周期（direct SQL 写入）。正式产品不得依赖这条 direct-SQL Memory 写入路径；其稳定事实提炼 Prompt/行为与 trace stage 语义可迁入正式 background lifecycle，direct INSERT 必须禁止 |
| FE75-09 / P1 | [Trace Store](../../windows/code/desktop-pet/core/trace-store.ts)、Trace API、Console Trace 展示均已实现（IMPLEMENTED / EXPOSED）；但生产 trace producer / DI 注入 PARTIAL——正式 Pipeline 各 stage 未完整产生真实记录 | N075-01 补生产接线：trace 必须来自真实 stage（admission/context/llm/assistant_persist/memory_enqueue/memory_plan/memory_commit/summary），后台阶段以同一 turnId 关联；默认不存完整私人正文 |
| FE75-10 / P1 | [next65-management.ts](../../windows/code/desktop-pet/management/next65-management.ts) 中存在 `loaded: false` 常量与默认 `new FlowRuntime([])` | Next65Management 当前不是正在运行的 PackageHost/FlowRuntime 的真实投影，只能作离线/metadata management。N075-01/R8 改为读取 live runtime 的 installed/enabled/loaded/active/ready/failed/pendingRestart/capabilities，禁止管理页自行推测 Runtime 状态 |
| FE75-11 / P1 | Companion Timeline 查询使用 `ORDER BY created_at ASC LIMIT ?`，限制 N 条时返回最早 N 条 | 语义错误：应为 `ORDER BY created_at DESC LIMIT N → application reverse → chronological output`（最近 N 条、按旧→新输出）。N075-01/R9 修复并加回归测试（100 条事件 limit=20 返回 81…100 而非 1…20）。Canon Timeline 暂不重构模型，文档口径：当前 Canon Timeline 是 canon facts 的主要投影，不宣称已实现复杂 temporal awareness |

这是源码路径审查，不是已经运行浏览器重现的验收报告；未改代码。当前工作树变化较多，以上结论应在 N075-00 固定提交后复查。

## 3. 需要保留的正确边界

- [api.mjs](../../../windows/code/desktop-pet/management/ui/api.mjs) 限制同源 `/api/`、Bearer 鉴权、禁止重定向、禁用缓存；重写不能把密钥写入 URL 或普通日志。
- app 已有鉴权 epoch、请求序号、角色结果校验、版本冲突及草稿保留机制。新状态层必须保持这些语义并扩展到配对/实例，不能单纯刷新覆盖编辑。
- 管理端是配置/记忆权威；前端仅持草稿和视图状态。保存成功不自动等于运行模型已切换。
- 试麦的可信 renderer 拥有音频设备；控制台不另起不受管理的采集会话。
- 皮肤注册与激活走后端；显示/尺寸走宿主桥；renderer 继续拥有表现。UI 重构不复制这些责任。

## 4. 迁移规则

N075-00 为每个旧 page/section、独立 HTML、右键项、弹窗、桌面控件登记新逻辑目标、API/Bridge、参考状态、替换状态和测试。旧 URL、书签、带 token 启动链接要有明确兼容处理；token 只消费一次，不传播到导航。

替换以单页为单位，允许短期切换回旧入口验证，但同一操作只能有一个后端权威。删除旧模块前搜索所有 import、静态文件表、shell 目标和测试消费者。现有工作树未提交修改必须保留，不能整目录覆盖。
