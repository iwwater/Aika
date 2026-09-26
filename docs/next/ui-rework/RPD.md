# UI 重构 PRD · 六入口控制台

状态：MVP_REPAIR_REQUIRED（现有实施需修复并重验；原始需求保留）  
日期：2026-09-25；文档版本：1.0；专项标识：UIR。沿仓库命名惯例文件为 RPD.md，内容即本次 PRD。

2026-09-25 复核：用户要求先收敛为最简单的 MVP，角色表现、Persona 与模型绑定应成为同一角色预设，并修复 Playground 导航卡顿。具体范围、源码证据与重验门槛见 [MVP 修复方案](MVP_REPAIR_PLAN_20260925.md)；本文件较宽的首版功能描述不自动进入当前 MVP。

来源：[UI重构讨论](chatgpt-conversation://6ab5cfec-86e0-83e8-b865-5ee336b9b2bb)，已完整读取 8 轮讨论。按用户最后的明确要求，Knowledge 不含 Raw Trace；Chat 记录进入 Trace，Playground 承担调试聊天，Timeline 与 Companion 合并为开发者详情。

**本专项现在优先开工，不等待 0.81、0.85 或旧 0.75 逐页审批。用户本轮明确授权 UI 风格自行设计，后面再修，因此本专项免除旧文档中的参考图、逐页方案确认和逐页人工批准前置；不免除功能、权限、数据和真实接线验证。** 仅对本专项生效，不修改历史验收状态，不扩大为全量后端重构。执行见 [SPEC](SPEC.md)，工程映射见 [SOURCE_MAPPING](SOURCE_MAPPING.md)。

## 1. 目标与范围

将工程功能列表重组为可用产品控制台：用户先看到统计与常用入口，在角色页配置人格、外观和模型链路，在 Knowledge 阅读已经沉淀的知识，在 Playground 调试交互；开发细节进入可隐藏的 Developer 区。

现有 Windows 原生 ESM/DOM UI 与管理 API 继续使用，不引入新框架作为前置。首版采用简洁侧栏、内容卡片/列表、详情面板及统一表单状态，可自行选色排版。桌宠渲染、语音引擎、Memory 生命周期、模型注册中心与外部 Work 执行权威保持原归属。

## 2. 信息架构

| 一级入口 | 首版内容 | 不放入此处 |
| --- | --- | --- |
| Dashboard | 当前角色/模型/语音、今日统计、最近经历摘要、最近知识、能力状态、快捷入口；最多六类卡片 | 原始请求、日志、虚构关系等级或假在线状态 |
| Knowledge | Wiki 列表/搜索/类型与标签筛选；详情含正文、Analysis、时间、Metadata、Sources；次级“参考资料”保留文档库管理 | Trace、Prompt、原始模型输出、Chunk/Embedding 管理 |
| Characters | 基础信息、Live2D/Sprite、单段 Persona、LLM/STT/TTS 绑定、角色能力允许范围 | 新世界书编辑器、自动人格提炼、可视化动作编辑器 |
| Playground | 显式发送调试文本、取消；有效配置与本次 Context/Trace 跳转；能力支持时 STT 试麦、TTS 试听、检索试算 | 第二套 Runtime、后台自动发送、把试算说成历史实况 |
| Plugins | 已安装包、导入、启停、配置/依赖/状态；已有 Flow 放 Advanced | 插件市场、任意代码沙箱、新通用编排平台 |
| Settings | 全局来源/凭证管理、默认设备、隐私/采集、数据管理、快捷键/日志/更新能力、Developer Mode；已有集成与 Work 次级入口 | 与角色页竞争的另一套角色模型保存权威 |
| Developer（默认隐藏） | LLM/Chat Trace、Knowledge Ingest Trace、Timeline/Companion Trace、Runtime Logs | 必须靠它才能停止采集或删除用户数据 |

Developer 是附加调试区，不是第七个默认一级导航。关闭模式时不渲染、不预取调试正文；直接访问旧 Trace 深链显示启用提示并保留目标，不能无声启用。Developer Mode 只是显示偏好，不是后端鉴权。

Dashboard 最近经历仅显示获准、有效的少量摘要；普通用户可打开简明来源详情。完整时间线调试进入 Developer。采集开关、授权、暂停、撤销、数据回看/删除始终可在 Settings 访问；0.81 到来后复用这些入口。

## 3. 必需产品需求

| ID | 需求与边界 | 实施步骤 |
| --- | --- | --- |
| UIR-R01 | 六入口导航、Developer 默认隐藏、旧深链兼容、配对和 token 安全、统一状态组件 | UIR-01 |
| UIR-R02 | Dashboard 真实统计与常用入口；缺能力/未检测/过期与零条数据区别显示，明确时区和统计范围 | UIR-07 |
| UIR-R03 | Knowledge 默认 Wiki，用户知识/角色知识/外部参考资料明确分域；Sources 有效性可查 | UIR-03 |
| UIR-R04 | Wiki 时间、Tags、Metadata、Analysis 可展示；缺字段显示未提供，推断标明依据，不现编置信度或生成分析 | UIR-03 |
| UIR-R05 | 单段 Persona 可保存并作用于后续正常轮次；既有 Character Pack/Canon 保留，世界书 UI 延后 | UIR-02 |
| UIR-R06 | 角色可选择 Live2D/Sprite、导入/预览资源、保存已有状态映射；无后端支持须补最小正式接线 | UIR-02 |
| UIR-R07 | 每角色配置 LLM/STT/TTS 的来源、端点/凭证引用、模型和音色；获取模型/音色与测试能力按 adapter 声明呈现 | UIR-02 |
| UIR-R08 | Playground 文本发送/取消走同一正式 Turn 权威，模式与持久化效果明确；试麦/试听/检索测试不隐式修改角色 | UIR-04 |
| UIR-R09 | Trace 可查看实际请求/回复、时间、模型、成本、整理候选及最终入库关联；未留存内容标 unavailable | UIR-05 |
| UIR-R10 | Plugins 真实导入/启停/配置与生命周期状态；缺 HTTP 暴露时补宿主管理 adapter，不新建假宿主 | UIR-06 |
| UIR-R11 | Settings 与角色设置分工明确；隐私和数据控制不藏进 Developer；未实现更新/路径迁移只读说明 | UIR-06 |
| UIR-R12 | 保存冲突保留草稿、异步请求隔离、键盘可达、中文 IME 不误发、错误恢复、旧业务不丢失 | UIR-01～08 |

## 4. 核心用户流程

1. **配置角色**：选择当前角色 → 外观/Persona → 选择或新建来源 → 获取模型 → 选择型号/音色 → 保存 → 显示 saved/effective 修订与生效条件 → Playground 验证。模型列表获取成功不等于推理或语音能力验证成功。
2. **查知识**：Knowledge 搜索/筛选 → Wiki 正文与 Analysis → 查看有效 Sources → 纠正/遗忘。用户知识走现有维护端口，角色 Canon 只读；参考资料仍按文档库权限管理，不能一键当作用户亲身事实。
3. **调试对话**：Playground 明示当前角色、运行实例及“真实会话，会写入历史并可能产生待审候选” → 用户发送 → 同一 Turn 提交/取消 → 可跳关联 Trace。首版不承诺无痕沙箱；不增加默认自动晋升，不为了测试静默切换全局来源。桌宠忙时复用现有仲裁并显示冲突。
4. **调试沉淀**：启用 Developer → 按会话/轮次看请求和回复 → 跟踪真实维护批次 → 候选/接受/拒绝/最终记录引用 → 跳 Knowledge 条目。历史没记录批次时如实缺失，不能根据时间相近伪造因果链。
5. **管理感知**：Settings 隐私/采集 → 来源状态与授权 → 预览、暂停、撤销、删除。Timeline/Companion Trace 用于诊断；未交付的 0.81 来源显示未安装/未实现，不给可误操作的开关。

## 5. 关键架构消歧

| 原讨论说法 | 工程决策 |
| --- | --- |
| Knowledge 就是知识库 | 产品入口改为已沉淀 Wiki；现有 Knowledge Library 仍是外部文档来源，次级保留，不能换标题就冒充 Wiki |
| 角色绑定 key | 角色绑定 SourceInstance/ModelProfile/Binding，key 保存在现有凭证权威；表单可设置秘密但不回显，不复制到每角色 JSON、URL 或 Trace |
| 所有配置统一 Schema | 统一表单信封/版本/校验/状态，内部保持 Character、Source、Binding、Plugin 各自 owner；不合并为大配置数据库 |
| Persona 暂时一串文字 | 首版只提供单段编辑体验，复用现有 Prompt/角色权威并明确覆盖顺序；不删除 0.7 的角色知识与旧 Pack |
| 开启角色 Companion 就授权感知 | 角色开关仅为能力允许范围；实际使用还要求已装载能力与有效用户采集授权，开关不能自动签发 grant |
| 全部状态用 Connected/Error | 统一显示组件但保留 installed/enabled/loaded/ready/pendingRestart/unknown/failed 区别，不能折叠成误导的绿色 |
| Playground 随便调模型 | 首版用当前有效绑定；修改配置按角色正式保存及生效规则。临时覆盖是后续能力，不制造第二套当前模型 |
| 原始 Trace 为了调试都存下来 | 只展示已经按策略获准保存的实际内容和引用；不新增无限正文日志，秘密必须脱敏，遗忘传播有效 |

引用 [ADR-001](../../architecture/adr/ADR-001-single-runtime.md)、[ADR-002](../../architecture/adr/ADR-002-plugin-boundary.md)、[ADR-003](../../architecture/adr/ADR-003-memory-authority.md)、[Provider](../../architecture/contracts/provider.md)、[Desktop Bridge](../../architecture/contracts/desktop-bridge.md)、[Management API](../../architecture/contracts/management-api.md)。必要公共契约增量与直接消费者同一步交付。

## 6. 配置所有权与失败行为

全局 Settings 持有共享来源、凭证、设备默认值；Characters 持有该角色的选择/覆盖及能力许可。优先级为显式角色绑定 > 已声明的全局默认；无有效绑定则 unavailable，不静默换供应商。升级时将原全局槽位作为兼容默认，保留用户原值；只有用户保存角色配置才创建显式覆盖。

所有读取携带真实配对/运行实例，未知身份先等待或报错，不能用硬编码 companion/default-user 查询私人信息。写入带 expectedRevision 和幂等 operationId（适用时），跨多个 owner 的保存显示各分区结果；部分失败不得显示整页保存成功。active 配置变更不混入已开始轮次，重启生效就明确 pendingRestart。

网络失败保留草稿；切页/切角色使迟到响应失效；删除/撤销后当前详情和缓存同步清理。API 错误说明下一步，不显示假示例填空。不支持模型发现的 adapter 允许手填，不假设所有 Provider 都是 /v1/models；音色 ID 必须属于所选来源。

## 7. MVP 与后续

MVP 必须交付六入口、真实 Wiki 阅读、角色 Persona/外观/模型链配置、正式 Playground 文本链、Trace 分区、包管理与隐私入口。核心能力缺管理接口时由对应 SPEC 补最小接口，不以 disabled 按钮宣布完成。

后续：新的世界书编辑器、自动人格提炼、复杂知识图谱/向量管理、音色训练、全新 STT/TTS 引擎、Playground 无痕隔离沙箱、插件市场、全局路径迁移/更新器。已有高级功能保留兼容入口，不删除数据；尚未实现的可选能力显示具体缺失原因。

本专项优先于 0.81 的可见 UI 接入；0.81 后续把采集状态与控制接 Settings、诊断接 Developer，0.85 补 Wiki 质量而不重新造 Knowledge 页面。

## 8. 完成定义

- 每项 UIR-R 映射到实现、定向测试及真实接口证据，未运行项标 NOT RUN。
- 六入口能完成上述流程；桌宠基础交互、旧资料/角色/配置/Work 与深链不回归。
- 真实正式后端启动的浏览器/Electron 验收通过；fixture 不能代替实际配置生效和设备证据。
- 风格无需预审或逐页批准；交付可运行版本和页面截图后可集中修改。没有用户确认不把版本状态写为 ACCEPTED。
- 本次交付为 PRD/SPEC 文档，不宣称 UI 已实现；立即执行入口为 UIR-00。
