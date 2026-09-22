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
| FE75-06 / P1（继承） | [此前架构核对](../ARCHITECTURE_REVIEW_20260922.md) 的连续性主链、后台提交、Binding 解析等缺口 | UI 不得自行补一套推理/记忆链。由 0.7/原模块补业务权威，再经管理接口消费 |

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
