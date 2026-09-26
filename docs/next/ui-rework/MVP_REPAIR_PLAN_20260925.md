# UI 重构 MVP 修复方案

日期：2026-09-25。状态：待实施；本文件是对当前工作树的静态复核和实施方案，不是新一轮验收报告。依据为 [UI 重构 PRD](RPD.md)、[工程映射](SOURCE_MAPPING.md) 和现有 Windows 代码。用户忘记附上的图一、图三不纳入需求或证据。

## 结论与当前证据

现有六入口外壳已经出现，但角色配置仍分散，Playground 的正式接线缺失，部分页面用演示数据或弹窗占位。[UIR-08 历史报告](reports/UIR-08.md)中的“全部 PASS”不能代表当前生产组合根已验收。保留该报告作为当时测试记录，以本方案的生产验证门槛重新判定。

| 优先级 | 复核发现 | 依据与判定 |
| --- | --- | --- |
| P0 | 正式 Playground 端口未装配。路由支持可选 `playground`，但正式管理启动没有传入；端口不存在时接口返回 unavailable。 | [正式管理启动](../../../windows/code/desktop-pet/management/bootstrap.ts)、[管理服务器](../../../windows/code/desktop-pet/management/server.ts)、[路由](../../../windows/code/desktop-pet/management/playground-routes.ts)。确认；预览脚本的 canned reply 和内存测试不算生产接线。 |
| P0 | 角色“预设”未成为一个角色作用域的配置。当前角色页拆成模型、Persona、外观、表现、语音、情感；模型编辑读取全局 `settings.providers`，皮肤接口只改变全局外观。 | [角色导航与渲染](../../../windows/code/desktop-pet/management/ui/app.mjs)、[模型表单](../../../windows/code/desktop-pet/management/ui/views.mjs)、[皮肤接口](../../../windows/code/desktop-pet/management/skin-routes.ts)。确认；[角色绑定测试](../../../windows/code/desktop-pet/tests/ui-rework/character-binding.test.ts)在测试内临时构造 `roleBindings`，没有验证生产保存/消费。 |
| P0 | Playground 取消使用前端自造的 `turn-${Date.now()}`；正式服务端轮次 ID 没有同步到该状态。成功回复缺失时还显示“已送达正式链路”，容易误报成功。 | [Playground 页面](../../../windows/code/desktop-pet/management/ui/playground-view.mjs)。确认代码路径；实际取消效果须在生产端口接入后验证。 |
| P0 | 用户报告“打开 Playground 后有一段时间别的都点不了”。静态检查不能确定原因。全页 `replaceChildren` 重建、恢复视图时对所有 `dialog` 调 `showModal()`、同步/请求期间的重渲染是待查路径；页面中的原生 `alert()` 本身会阻断交互。 | [应用渲染](../../../windows/code/desktop-pet/management/ui/app.mjs)、[视图恢复](../../../windows/code/desktop-pet/management/ui/dom.mjs)、[Playground 页面](../../../windows/code/desktop-pet/management/ui/playground-view.mjs)。**症状为用户报告，具体根因未确认**，不能只凭静态代码认定。 |
| P1 | Developer 的 Ingest Trace 使用固定 `mockBatches`；Knowledge “测试检索”和 Playground “TTS 试听”只是 `alert()`，Dashboard 还把有模型配置当作就绪。 | [Developer 页面](../../../windows/code/desktop-pet/management/ui/developer-view.mjs)、[旧知识页面](../../../windows/code/desktop-pet/management/ui/modern-knowledge-view.mjs)、[Playground 页面](../../../windows/code/desktop-pet/management/ui/playground-view.mjs)、[Dashboard](../../../windows/code/desktop-pet/management/ui/modern-overview.mjs)。确认。 |
| P1 | 旧信息架构仍露出大量次级页；路由和快照仍回退或限定 `companion` 单角色。主题、通知、搜索等顶栏控件没有对应行为。 | [导航/快照](../../../windows/code/desktop-pet/management/ui/app.mjs)、[路由](../../../windows/code/desktop-pet/management/ui/routes.mjs)。确认；保留旧深链兼容，不把高级入口放进 MVP 默认界面。 |

## MVP 目标界面

默认只保留六个一级入口：Dashboard、Knowledge、Characters、Playground、Plugins、Settings。Developer 仍为显式开启的调试入口；不展示伪造的 Trace。旧业务数据和旧深链保持可访问，但不占据默认导航，也不因收敛界面而删除后端能力。

| 页面 | MVP 首屏与可执行动作 | 延后或隐藏 |
| --- | --- | --- |
| Dashboard | 当前角色、真实连接状态、进入角色配置/Playground/Knowledge 的入口；没有可靠统计时显示“未提供” | 虚构在线、仅凭配置推断就绪、复杂分析卡 |
| Knowledge | 已沉淀 Wiki 的列表与详情；必要的来源/纠正/遗忘；现有参考资料从次级入口进入 | 导入工作台、假“测试检索”、原始 Trace |
| Characters | 一个“当前角色预设”页面，顺序为表现、Persona、模型绑定；保存状态与生效状态可见 | 独立的表情策略、情感面板、复杂 Pack/世界书编辑器 |
| Playground | 当前角色与实际绑定摘要、文本发送、实际回复/错误、取消、离开页面仍可导航 | 无正式端口时的假聊天，尚未接通的试听/试麦/检索试算 |
| Plugins | 已安装项、真实启停和状态；无对应能力时明确 unavailable | 市场、Flow 编排默认入口 |
| Settings | 全局来源/凭据、必要设备与隐私/采集控制、Developer 开关 | Work、微信、诊断大面板、未接通的主题/通知/全局搜索 |

### 角色预设的最小契约

“预设”应是当前角色的一份组合配置，而非三个导航页的视觉拼接。最小字段：`characterId`、`presetId`、`revision`、表现资源引用（Live2D 或 Sprite 及已支持的最小状态映射）、单段 Persona 引用/修订、`dialogue`/`asr`/`tts` 绑定引用（含所选模型；TTS 音色如能力支持）、保存与生效修订。页面展示这些字段的当前值及验证错误；切换角色时，预设及 Playground 使用同一角色作用域。

来源实例、模型档案和凭据仍由现有多源管理/凭据权威保存；预设只引用绑定，**不复制 API Key**。默认旧全局设置作为现有 `companion` 的迁移输入，升级后仍可恢复，不静默覆盖其他角色。角色预设应用到运行时须通过正式消费者读取；若某个绑定类型尚无正式角色作用域，先显示不可用并补最薄适配，不以测试内对象冒充保存成功。MVP 可只提供一个当前角色的编辑入口，但至少用两个角色作用域验证互不串值。

## 实施顺序与验收

| 顺序 | 修复工作 | 完成判据 |
| --- | --- | --- |
| 1 | 复现 Playground 卡顿：记录点击入口至可切换导航的耗时、请求时序、主线程长任务、`dialog[open]`/遮罩、事件命中目标；分别在慢请求、失败请求和正常请求下测试。修复确认的根因，避免全局弹窗或同步渲染锁住导航。 | 页面数据未加载时导航仍可立即切换；慢/失败请求不阻断其他入口；无意外模态层。交互目标为点击后 200 ms 内导航响应，记录实际测量环境和结果。 |
| 2 | 将 Playground facade 装入正式 `trial-backend`/管理启动链，只消费唯一 Turn 权威；服务端回传并追踪真实 `turnId`，按真实 ID 查询/取消。缺端口则显式 unavailable，不渲染成功话术。 | 在正式组合根发送一轮文本并查到同一轮的回复/Trace；在途取消确实取消该轮；重复提交、失败与离页均有正确状态。预览脚本/内存 fake 只能算组件测试。 |
| 3 | 建立角色预设聚合读写与正式生效路径，再把 Characters 压成一页的表现、Persona、模型绑定三个区块；全局来源/凭据转入 Settings。 | 保存后刷新、重启仍在；角色 A/B 切换互不覆盖；更改模型/Persona/外观后有效配置和下一轮实际消费者一致；旧 `companion` 配置升级可恢复。 |
| 4 | 收敛其余五页与导航：移除无行为控件；真实数据缺席显示空态或 unavailable；把旧业务只留在兼容深链/高级入口；Developer 不显示硬编码事件。 | 默认页面没有可点击却不工作的控件、演示业务数据或假 ready；旧链接仍能到达原业务且权限不放宽。隐私停用/撤销始终在普通 Settings 可达。 |
| 5 | 修正自动化与状态文档：增加正式管理组合根、双角色隔离、慢请求导航、取消、迁移保留的定向测试。对外报告明确区分正式/预览/fixture/未测。 | `check`、目标构建和相关回归通过；Playground 和角色预设有生产路径证据；UIR 旧 PASS 结论经本轮重新审定后才可恢复。 |

这轮只修 MVP 真实可用性和信息架构。UI 风格可以沿现有样式继续；不做新市场、复杂动作编辑、0.81 keyboard/截图采集实现或 0.85 Wiki 编纂，也不为未交付能力补一套演示后端。截图内容未提供，因此不推断“图三”具体控件。
