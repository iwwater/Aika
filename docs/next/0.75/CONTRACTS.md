# 0.75 接口映射与补齐边界

状态：规划契约，非新增 API 已实现声明。更新日期：2026-09-22。

目录：[约定](#1-通用约定) · [现有接口](#2-现有接口与消费者) · [缺口](#3-待补接口按业务操作定义) · [桌面](#4-桌面与表现边界) · [验证](#5-接口验收)

## 1. 通用约定

下表“现有”仅指找到路由/代码；端口是否由正式启动装配、操作是否到真实运行时仍须逐步验证。`/*` 是接口族说明，不是通配路由。新增端点 URL、完整 DTO 和错误码在对应步骤冻结，本文不假装已注册。

前端统一通过管理 client 和受限 Desktop Bridge。HTTP 沿用本地会话鉴权；资源白名单与路由显式登记。不要强行把已有 GET 改成 POST 或全量重命名 API；先做兼容应用服务，必要增量才改服务端。

写操作按具体端口使用 expectedRevision/expectedVersion 和 operationId，不能声称所有旧接口已支持幂等。缺少冲突控制的端口逐项补契约。返回需区分已保存/待生效/待重启/执行失败；缺能力不能返回伪成功。

角色数据固定 userId、characterId、characterInstanceId 配对；涉及 Pack 再固定版本，涉及知识库再固定 libraryId。全局配置无需伪造配对。请求发起时捕获作用域、鉴权 epoch 和序号；离页取消订阅，迟到响应不覆盖新页。取消读取与取消后台操作分开，不能以 AbortController 假装撤回已提交写入。

## 2. 现有接口与消费者

代码根为 `windows/code/desktop-pet/`；精确路由以源文件为准。

| 功能 / 步骤 | 已定位接口或端口 | 当前限制 / 重构要求 |
| --- | --- | --- |
| 启动与控制台 / 01–02 | GET `/api/snapshot`；[ManagementClient](../../../windows/code/desktop-pet/management/ui/api.mjs)；`self-setup-routes.ts` 的 `/api/self-setup` 接口族 | 鉴权/慢启动/不兼容/断线分别处理；snapshot 的单角色限制需配合后端改 |
| API/模型 / 04 | PUT `/api/settings`、POST `/api/settings/rollback`；GET/POST `/api/aika/discovery`、PUT `/api/aika/discovery/source`；`self-setup-routes.ts` | 沿用修订控制；来源发现与真正 Binding 管理不是一回事，见第 3 节 |
| 语音设置 / 05 | `/api/self-setup/voice/sample`；`microphone-routes.ts`、`wake-routes.ts`；desktop mic-test controller | 试录本地设备归可信 renderer；样本音频走受控 client，离页释放 URL/音频资源 |
| 皮肤 / 06 | GET `/api/skins`、POST `/api/skins/import`、`/api/skins/:id/activate`、`/api/skins/:id/remove`、资源路径；`skin-routes.ts` | 实际方法、导入校验、回执以 route 为准；换肤不修改角色和记忆 |
| 基础角色 / 07 | GET/PUT `/api/aika/profile`；GET/PUT `/api/prompt` | profile/Prompt 不等于 Character Pack 生命周期；后者需正式管理端口 |
| 历史与纠正 / 08 | GET `/api/records`、POST `/api/records/edit`；`memory-dynamics-routes.ts` 的 `/api/memory/*` | 保留分页、revision、纠正影响和草稿冲突；不从界面直接更新 DB |
| 导入与队列 / 08 | `/api/memory-import`、`/start`、`/pause`、`/resume`；`/api/memory-pending`、`/retry`、`/cancel` | 恢复任务状态来自服务端；前端轮询取消不等于任务取消 |
| 连续性 / 08–09 | **POST** `/api/continuity/snapshot`、`/record`、`/promote`、`/correct`、`/forget`；[continuity-routes.ts](../../../windows/code/desktop-pet/management/continuity-routes.ts) | snapshot body 是 pairing + includeCandidates；写操作依具体端口带 operationId、targetId、expectedVersion 等；不冒充 Pack/Timeline API |
| Timeline / 09 | GET `/api/aika/timeline`，sessionId/limit/cursor | 既有聊天 Timeline 不等于 Canon/Companion 双时间线；新端口见第 3 节 |
| Context / 09 | GET `/api/context`；`/api/memory/preview`；既有 traces | 既有召回试算不等于完整连续性请求预算与来源解释，不能用前端估算填缺口 |
| 知识库 / 10 | `/api/knowledge`、`/libraries`、`/rename`、`/activate`、`/import`、`/documents`、`/documents/list`、`/documents/remove`、`/libraries/delete`；[knowledge-routes.ts](../../../windows/code/desktop-pet/management/knowledge-routes.ts) | 文档列表当前为 POST；具体 body/method 复用路由。按 libraryId 隔离，保留异步错误和并发修订 |
| 包与 Flow / 11 | [Next65Management](../../../windows/code/desktop-pet/management/next65-management.ts) 的 packages/importPackage/disable/stageUpdate/uninstall、profiles/validateProfile/previewProfile/saveProfile | 是内部类方法，未核实为可调用 HTTP；不能从浏览器 import Node 类，需生产宿主管理适配 |
| 健康/运行 / 12 | GET `/api/health`、`/api/health/:module`；snapshot/events 现有投影；`balances.ts` 与 server 中的余额路由 | 运行、已安装、配置可用分开；余额与健康未知不展示为零或正常；日志脱敏 |
| 项目/任务 / 13 | GET `/api/projects`、`/api/projects/:id`，POST `/api/projects/save`、`/api/projects/remove`；GET `/api/tasks`、`/api/tasks/targets`，POST `/api/tasks/prepare`、`/api/tasks/confirm`；desktop Work Bridge | 实施前冻结实际 route DTO；既有任务转发不等于 0.8 ACP/MCP 新业务 |
| 连接与附加设置 / 14 | `/api/wechat`、`/api/wake`、`/api/emotion`、`/api/presentation`；对应 route/view | 情绪、展示策略、微信连接保留现有服务权威；表现设置界面可重写，引擎不重写 |

## 3. 待补接口（按业务操作定义）

| 逻辑契约（建议，未落地） | 必需输入与返回语义 | 责任与前置 |
| --- | --- | --- |
| Provider 管理 | 来源列表/详情/健康；来源增改与密钥引用；模型发现；Binding 查询/修订；能力、adapter、source、model、binding ID 分离；返回保存和实际生效修订 | N075-04 对接 ProviderRuntime；先修复此前 Binding 解析缺口，不把 adapterId 当 bindingId |
| Character Pack 管理 | 来源快照、证据定位；提炼任务及取消语义；草稿/预览/验证；激活/升级/回退；操作 ID、目标实例、expectedRevision、Pack 版本和结果 | 0.7 业务 Store/Distiller，N075-07 补管理暴露；复用唯一存储，版本冲突拒绝覆盖 |
| 实例与配对列表 | 可用实例/当前配对及权限内数据；切换的实际生效点、活跃轮次影响 | 0.7 运行链与 N075-07；前端不能只改下拉框就声称角色已切换 |
| 双 Timeline/Character Wiki | 原作版本/截止点/事件顺序与现实时间分别分页；引用 source/evidence；配对、Pack、版本、cursor | 0.7 数据服务，N075-09 管理适配；不借 `/api/aika/timeline` 伪装双线 |
| 完整 Context 解释 | 实际请求来源、去重原因、纳入/排除、预算、截断、缓存/失效与对应轮次标识；秘密字段排除 | 0.7 Composer 与正式流水线，N075-09 投影；试算与实际轮次分别标记 |
| 宿主包/Flow 管理 | 真实 installed/enabled/loaded/ready/pendingRestart/failed；依赖与影响预览；配置修订；Flow 校验、预览、保存与激活状态 | N075-11；对接正在运行的宿主，不新建空 FlowRuntime 作为运行状态来源 |

以上每项在开 UI 前记录：生产提供者、调用者、输入/输出 DTO、鉴权、版本冲突、幂等/重试、分页/订阅、错误码、测试、启动装配证据。没有端口的操作保持不可用和明确原因，不写假数据替代验收。

## 6. Runtime Maturity Matrix

2026-09-22 新增。术语：`IMPLEMENTED` = Domain/Core 代码存在且有单测/验收证据；`WIRED` = 正式 Production Runtime 实际消费该能力；`EXPOSED` = Management API / Console 可真实读取或控制。基线为当前 `aika-next` 工作树（de95e1d）；N075-01 完成后须复核此表。

| Capability | IMPLEMENTED | WIRED | EXPOSED |
| --- | :-: | :-: | :-: |
| DialoguePipeline | ✅ | ✅ | — |
| Strict Memory Lifecycle（plan/validate/commitTurn） | ✅ | ✅ | ✅ |
| Knowledge Library | ✅ | ✅ | ✅ |
| Skin | ✅ | ✅ | ✅ |
| Character Pack | ✅ | 🟡 | 🟡 |
| Continuity Memory（ContinuityMemoryStore 存储/纠正/遗忘） | ✅ | 🟡 | ✅ |
| Continuity Context（Composer → 正式 Dialogue Context） | ✅ | ❌/🟡 | 🟡 |
| Canon Timeline | ✅ | 🟡 | 🟡 |
| Companion Timeline | ✅ | 🟡 | 🟡 |
| Runtime Trace | ✅ | 🟡 | ✅ |
| ProviderRuntime | ✅ | 🟡 | 🟡 |
| PackageHost | ✅ | 🟡 | 🟡 |
| FlowRuntime | ✅ | 🟡 | 🟡 |

说明（与 [SOURCE_AUDIT](SOURCE_AUDIT.md) FE75-06～FE75-11、[架构核对](../ARCHITECTURE_REVIEW_20260922.md) AR-01～05 对应）：

- `WIRED=🟡` 的各项均有生产打开/部分消费证据，但正式 Dialogue Context 或生产管线尚未完整消费；具体缺口见 SOURCE_AUDIT。
- `Continuity Context` 的 `❌/🟡`：正式 DialoguePipeline 的 foreground context 尚未完整消费 Composer 输出（AR-01），管理 snapshot API 只覆盖显式 continuity 请求。
- `Runtime Trace` 的 `WIRED=🟡`：Store/API/Console 已具备，但生产 trace producer 注入不完整（FE75-09）。
- `FlowRuntime` 的 `WIRED=🟡`：已实现并有测试，但 Next65Management 用 `new FlowRuntime([])` 离线实例做管理投影，不代表运行真相（FE75-10）。

## 7. Wiki 与 Context Inspector 契约

### 7.1 Wiki Contract（禁止新增第二套 Wiki 存储）

禁止新增：`wiki_entries`、`wiki_evidence`、第二个 wiki sqlite、第二套 correct/forget。定义：

- **Character Wiki** = CharacterPack / Canon Facts / Soul / Timeline / Evidence 的 **Read Model**（产品投影，不拥有数据）。
- **User Wiki** = ContinuityMemoryStore 中 `user_wiki` 层的 Read Model。
- **User Soul** = ContinuityMemoryStore 中 `user_soul` 层。
- **Relationship** = ContinuityMemoryStore 中 `relationship` 层。

即：**Wiki 是产品投影，不是新的 System of Record。** Knowledge Library ≠ User Wiki：Knowledge 继续作为用户主动导入的参考资料（独立后端），Wiki 是长期结构化认知投影。

### 7.2 Context Inspector Contract

Management 查询必须展示**本轮真正被 LLM 消费的 Context Snapshot**（issued/consumed snapshot），包括 selected/omitted、source type、source id、version、score、token cost、budget reason、dedupe reason、privacy exclusion、stale/invalidation state。不得在管理页重新执行一次 retrieval 然后声称"这是当时 LLM 看见的内容"。现有 Memory Lifecycle 已保存 Context identity/source/revision；Context Inspector 应读取该 issued/consumed snapshot，而不是重新查询近似结果。

**Acceptance**：Console 显示的 selected sources == 该 turn 真正发给 Dialogue LLM 的 sources。

### 7.3 Trace 语义契约

- Trace 来自真实 stage（admission / context / llm / assistant_persist / memory_enqueue / memory_plan / memory_commit / summary 等），不使用人工构造指标。
- Async Memory 语义：foreground turn terminal 不等待普通 distillation；后台阶段以同一 `turnId` 关联（traceId/turnId → foreground stages + background child/update stages）。
- Privacy：默认 Trace 只存 turnId、timings、tokens、selected source IDs、revisions、statuses、digest；完整 user/reply 正文仅 debug opt-in，默认不长期重复存第二份聊天正文库。

## 4. 桌面与表现边界

现有命令见 [main.mjs](../../../windows/code/desktop-pet/desktop/main.mjs)、[display-controls.mjs](../../../windows/code/desktop-pet/desktop/display-controls.mjs) 与 [mic-test-panel.mjs](../../../windows/code/desktop-pet/desktop/mic-test-panel.mjs)。

| 功能 | 现有消息 / 方向 | 重构保证 |
| --- | --- | --- |
| 打开控制台 | shell `open_management` + 本地 path → `managementResult` | 只允许同源登记目标；成功与失败回执可见，不能无限 loading |
| 鼠标穿透 | shell `set_click_through` | 以宿主实际状态/回执收敛；保留恢复路径，不能只有前端布尔翻转 |
| 模式/尺寸 | `set_display`、`resize_model` 的 begin/update/commit/cancel → displayConfig | UI 草稿与持久化分开；取消恢复，保存后重启仍一致 |
| 试麦 | `mic_test_request`、`mic_test_release`、`mic_test_preference` | 与正常采集互斥；退出、取消、设备丢失释放资源 |
| 对话/工作/播放 | 既有 bridge transport、scope/requestId、playback 回执与 Work 绑定 | 不增加第二个轮次或取消来源；页面重写不让旧事件污染当前会话 |

## 5. 接口验收

每步至少验证成功、缺能力、鉴权失效、离页迟到、作用域切换、写冲突和重试（按接口适用性）；真实服务启动到管理端口再到数据/运行时的集成证据不能用纯 mock 替代。UI 测试可用 fixture 稳定展示，但报告需与真实端口联调分开。真实模型/麦克风/扬声器未调用不得声称通过。
