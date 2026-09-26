# UI 重构工程映射

日期：2026-09-25；静态核对，不代表接口全部生产验收通过。源码相对根为 windows/code/desktop-pet/。实施前 UIR-00 重新核对工作树，禁止覆盖并行修改。

## 1. 现有事实和缺口

| 领域 | 现有源码/接口 | 本专项动作 |
| --- | --- | --- |
| UI 壳 | management/ui/app.mjs、routes.mjs、views.mjs、dom.mjs；现有 17 个 CONSOLE_PAGES，模块分组与本次六入口不同 | 重组导航并保留旧 page/section 映射；勿只改菜单不改路由 |
| Knowledge | modern-knowledge-view.mjs 请求 /api/knowledge，主体是资料库/文档；knowledge-routes.ts | 移到 Knowledge/参考资料，Wiki 另消费既有连续性/角色 read model |
| Wiki | continuity-routes.ts；POST /api/continuity/snapshot 与 record/promote/correct/forget；memory/character-pack-store.ts | read model 汇聚，真实区分 active/candidate/Canon/外部资料；Tags/Analysis 缺字段不编造 |
| 配置/模型 | server.ts：GET /api/snapshot、PUT /api/settings、POST /api/settings/rollback；aika-routes.ts 与 model-discovery.ts；ManagedSettings.providers 是旧槽位权威 | 角色绑定需核对实际 ProviderRuntime 支持；发现草稿不是绑定保存；补角色作用域适配与兼容默认 |
| Persona | server.ts：GET/PUT /api/prompt；已有版本冲突与正文编辑 | 移入角色页并核实真实角色与正式 Context 生效，不能覆盖 Canon |
| 外观 | skin-routes.ts、ui/skin-view.mjs、presentation-view.mjs | 复用导入/预览/激活与动作白名单；明确角色绑定范围，不重写渲染器 |
| Playground | app/trial-backend.ts → BackendSession → NextTurnPort/DialoguePipeline；管理 API 当前未证明有可直接复用的聊天提交端口 | 新管理 facade 接唯一 Turn authority，所需 session/提交/取消/查询协议见 UIR-04；禁止 UI 直连 Provider |
| Trace | server.ts：GET /api/traces、GET /api/traces/:id/content；GET /api/records、GET /api/context；tests/management/context-inspector.test.ts | 实际请求与当前试算分栏，记录/维护关联缺口补生产元数据，不重放生成历史 |
| Timeline/感知 | GET /api/unified-timeline；perception-routes.ts、proactive-invitation-routes.ts；modern-timeline-view.mjs | 详情归 Developer；授权/暂停/删除保留 Settings；不提前实现 0.81 |
| Plugins | server.ts：GET /api/next65/packages、GET /api/next65/truth、/api/next65/profiles 与 activate；next65-management.ts 含包管理方法 | 方法存在不等于 HTTP 可调用，补导入/启停/配置必需管理暴露；绑定 live host |
| 设置/旧业务 | health-routes.ts、project-routes.ts、task-routes.ts、work-protocol-routes.ts、wechat-routes.ts、wake-routes.ts、memory-import-routes.ts | 次级迁移保留能力/权限，不能删掉不在六入口名字里的业务 |
| 构建/测试 | package.json：build/check/build:desktop/test:next075/test:next079/test:next08/audit:console；tests/management 与 tests/next08 | 用真实脚本，新增 tests/ui-rework/ 定向用例；不虚构已存在 test:ui-rework |

不存在独立 provider-routes.ts/character-routes.ts/next65-routes.ts，不得按假文件名派任务；实际 provider 与包路由部分集中在 server.ts。本次检索确认 routes.mjs 仍存在默认身份回退，UIR-01 必须核对来源，修复配对丢失风险并适配消费者。

## 2. 旧入口 → 新位置

| 旧 page/section | 新目的地 |
| --- | --- |
| overview | Dashboard |
| models | Characters/当前角色/模型；全局来源管理链接 Settings/来源 |
| voice | Characters/语音；全局设备链接 Settings/设备 |
| skins、presentation | Characters/外观及已有表现设置 |
| characters | Characters |
| knowledge | Knowledge/参考资料（旧链接保持原语义）；新 Knowledge 默认 Wiki |
| memory/records（聊天记录） | Developer/LLM Chat Trace |
| memory/records（长期事实）、dynamics、fragments | Knowledge 对应数据域；无同义新 UI 时保留次级兼容工具 |
| memory/prompt | Characters/Persona |
| memory/context | Playground/检索试算 |
| memory/import | Knowledge/导入 |
| memory/emotion | Characters/高级表现 |
| timeline、section=timeline | Developer/Timeline Companion；关闭 Developer 时提示启用，不泄漏内容 |
| events、section=diagnostics | Developer/Runtime 或 LLM Trace，保留查询条件 |
| health、section=runtime | Settings/诊断；Dashboard 显示摘要 |
| packages | Plugins；Flow 为其高级入口 |
| perception、proactive | Settings/隐私与陪伴 |
| projects、tasks | Settings/工作与集成；Work 确认卡保留直接深链 |
| wechat | Settings/集成 |

实现可用新的 canonical page ID，但映射必须是纯路由适配；不修改数据所有者。角色/user/instance、查询、source/turn ID、后退/刷新应保留，token 从 URL 清理且不落普通本地偏好存储。

## 3. 当前并行修改

检查时 app.mjs、views.mjs、dom.mjs、tools/serve-management.mjs 有其他未提交变动，另有 diagnose-browser/test-snap 工具；必须重新检查实际差异并在当前文件上最小补丁。serve-management/preview 工具可用于开发，不能替代 app/trial-backend.ts 正式组合根证据。

[0.75 契约](../0.75/CONTRACTS.md) 中部分状态是历史快照，真实完成度以对应源码和最新报告为准。不能借本次 UI 规格把 0.8/0.81/0.85 未交付能力写成 ready。
