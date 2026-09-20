# 0.65 多源 Provider 架构与执行契约 v0.1

日期：2026-09-21；状态：新增执行设计，未实现/未测试。适用于 LLM、TTS、STT 及未来 OCR/VLM 等能力。K65-01 提供类型与校验，[K65-02A](specs/K65-02A.md) 实现来源注册、解析和实例生命周期；03/05/06 接入真实业务，07/09 接入流程和 UI。本文与 CONTRACTS 共同约束后续步骤。

## 1. 五层分离

| 层 | 表达什么 | 身份与范围 |
| --- | --- | --- |
| Capability | 要完成什么，例如 llm.chat、tts.synthesize、stt.transcribe | capabilityId + contractVersion；同一能力可有多个提供者 |
| Provider Adapter | 如何调用某种协议或本地引擎 | adapterId + packageId/pluginId + adapterVersion；不同适配器独立扩展 |
| Source Instance | 具体连接或运行哪一个服务/引擎实例 | sourceId + configRevision；端点/认证或本地运行资源与生命周期 |
| Model Profile | 在该来源上使用哪个模型、音色与参数 | modelProfileId + revision + sourceId；不以显示模型名作全局 ID |
| Binding | 哪个槽/阶段选择哪个模型配置 | bindingId + revision → modelProfileId；可含角色/流程/用途范围 |

同一个 OpenAI-compatible adapter 可以有多个端点实例，也可以同时连接云端和本机自部署服务。同一个本地引擎适配器可以登记多个模型配置；不同本地引擎使用不同 adapter。不能把“local”设计成唯一 Provider，也不能为每个端点复制一份插件代码。

示意（命名为设计示例，不表示具体服务已经验证）：

```text
普通包 LLM 阶段 ── binding.chat ── modelProfile ── source.cloudA ── adapter.openaiCompatible
长期摘要阶段     ── binding.summary ── modelProfile ── source.localB ── 同协议适配器
TTS 输出阶段     ── binding.speech ── voiceProfile ── source.localC ── adapter.localEngineC
                                                           └─ 也可显式选择 cloudTtsA
```

Provider 是能力的具体提供者，不是全局“当前模型”。一个 Profile 的不同阶段可以选不同来源，同时保存多组配置；单个阶段单次调用只选择一个来源。默认不并发竞速、不投票、不混合两家输出、不自动负载均衡。

## 2. 部署方式与进程所有权

部署方式和协议是正交字段；不能按模型名或 URL 外观推断协议能力、本地性或可信度。

| deployment | 配置 | 生命周期 |
| --- | --- | --- |
| remote-api | 明确端点、协议 adapter、可选鉴权引用、声明的数据去向 | 宿主仅持有客户端，不启动远端服务 |
| local-service | 用户已部署的本机或显式配置内网服务，协议和健康入口独立声明 | 用户拥有进程；插件断开只关闭自己的连接，不能停止用户服务 |
| managed-local | 由受信任适配器启动的本地 worker/子进程/引擎，模型/运行资源引用 | 宿主或包拥有进程和资源租约，按需启动，停止/取消/退出可回收 |

首版 local-service 默认支持显式 loopback；内网服务必须用户配置地址与数据去向策略，不通过 localhost 标签假称离线。纯本机模式拒绝远端目的地，外部本地代理是否转发须如实声明未知，不声称已审计其内部行为。

managed-local 的启动命令和参数 schema 来自受信任 adapter，配置只填资源引用和允许字段，不执行任意拼接 shell。不同 Python/native 环境可用独立工作进程隔离，不把所有引擎依赖放进内核/普通包。模型权重、GPU runtime 与 adapter 代码分开登记；不自动下载或安装。

## 3. 来源与模型配置

SourceInstance 保存 sourceId、adapterId、deployment、configRevision、endpoint 或 runtimeRef、auth（none/credentialRef）、资源/连接上限、显式启用状态与诊断。无鉴权本地服务允许 auth=none；需鉴权时必须引用已有 SecretStore，导出不含密钥。

ModelProfile 保存 modelProfileId、revision、sourceId、能力类型、原生 model/voice 标识、经 adapter 验证的参数、资源引用及能力覆盖。相同模型名出现在不同来源时仍独立。TTS voiceId/modelId 归当前来源；不能把云端音色 ID 直接转给本地引擎。模型列表发现、音色枚举和加载都是不同操作；发现失败仍可手填有效 ID，最终以实际调用证据判定可用。

共同字段包括输入/输出形式、语言、流式/批式、取消能力和限额；LLM 的 context/structuredOutput/tools 与 TTS 的采样率/编码/音色等分别按能力 schema 表达，不能用一个万能参数对象绕过校验。有效能力为 adapter 能力与所选模型能力的交集；unknown 不等于支持，必需特性缺失时拒绝绑定。供应商专有参数只由对应 adapter 处理，不原样发给其他来源。

费用可为已知、unknown 或本地未估算；不强制本地资源有云端费率/Key，不把本地运行描述为零资源成本。已有 bounded/unlimited 规则继续明确适用范围；网络计费约束和本地内存/并发限制分别校验。

## 4. 注册、加载与资源隔离

同 capabilityId 多提供者合法；禁止的是重复 adapterId/pluginId 的冲突注册或同实例身份异内容覆盖。查找能力若存在多个候选且无明确 binding，返回需选择，不取最后注册者。

来源配置可以先保存为未就绪，但被活动流程选中时必须检查包启用、版本、资源与声明能力。检查与列表不加载所有引擎；实际调用只加载所选 adapter/来源必要依赖。包入口加载不等于包内所有来源实例初始化。

调用解析得到不可变 ResolvedBinding：capability、package/adapter version、sourceId/configRevision、modelProfileId/revision、binding revision、有效参数和必要凭据引用。连接可以按来源/鉴权修订复用；模型实例按来源、模型/设备配置等共同标识复用，不能只以 model 名作为缓存键。

同实例并发首次加载 single-flight；不同来源或模型不能串资源、凭据、队列和健康状态。每来源声明有界并发/队列/启动超时；GPU/内存不足可见失败或等待，不能静默换模型。宿主管理的共享进程由最后租约释放；用户拥有的 local-service 永不被宿主 kill。

包卸载/更新检查所有来源实例和绑定引用，不只检查一个“当前模型”。只换同 adapter 的端点/模型配置不需要重装代码包；需要重新加载本地模型时先排空/取消旧租约并显示真实状态。

## 5. 切换与失败

每轮固定所用 binding/model/source revisions；多个阶段可以不同来源，但同一次调用和语音流不能中途拼接另一来源输出。保存新配置从下一轮生效；撤销权限/来源访问立即阻止后续输出。取消后迟到 token/audio 不能交付。

首版固定来源策略，自动 fallback 默认关闭且本轮不交付通用 fallback 路由器。错误显示具体来源及阶段，允许用户显式选择其他来源后发起新调用；取消、鉴权失败、参数错误不能触发隐式换源。本地失败不静默上传云端，云端失败不擅自加载未选本地大模型。

已输出 token、已播放音频或已执行副作用时失败，报告部分完成，禁止以自动重试整阶段掩盖。若未来添加 fallback，必须另写 SPEC，限定候选顺序、重试条件、费用/数据去向和提交边界，不能用本稿预授权外发。

## 6. 包体形态

LLM/TTS/STT 是用户功能，不等于把该功能的所有来源实现塞在同一物理包。可拆为轻量功能协调/输出包 + adapter 包：普通包组合至少一个轻量可用 LLM adapter；TTS 组合公共输出接线与用户选定的一个合成 adapter；STT 同理。来源实例是配置，不要求每实例一份代码包。

已有多个轻量协议适配可共用代码包；专用本地引擎/native/GPU 依赖必须随独立可选 adapter 包，仅选云端时不能强装本地引擎。普通/TTS/STT 的单包更新验收，对组合包表达为只更新对应选定 adapter 与必要元数据，其他宿主/产品产物不变。

新增 adapter 通过公开契约注册同能力，不修改宿主 Provider 枚举或核心厂商分支。支持什么协议由已实现的 adapter 及真实证据决定，不能因为能保存 URL 就声称兼容任意云端/本地产品。

## 7. 首版交付与证据

0.65 必需：多来源保存/同时使用、按阶段显式绑定、来源级健康与资源隔离、云端与本地路径的真实验证，不要求一次实现所有引擎。00 在实际环境固定具体选型和资源：

- LLM：现有已支持云端协议保留；至少一个本地服务适配真实回放；同协议两个端点和同源多个模型有契约覆盖；第二种本地 adapter 通过独立可控插件验证可扩展性，不冒称第二种真实引擎已验收。
- TTS：至少一个既有云端 adapter 与一个本地 adapter 真实生成音频。本地候选可复用已存在的 SAPI 路径，具体资源以 00 为准；新增其他本地引擎通过独立包接入。
- STT：保留已交付云端 batch 与本地 streaming adapter，分别声明能力，不能用 batch 冒充 streaming；真实本地门槛沿用原 SPEC。
- OCR/VLM：继承同一多源契约，实际功能和真实选型仍属于后续版本。

验证矩阵：同 adapter 两来源、同来源两模型、不同 adapter 同能力、不同阶段不同来源、云端无本地依赖、本地无云端 Key、受控本地进程与外部服务各自生命周期。合同测试、协议 stub、真实服务结果分别报告；真实资源缺失为 BLOCKED，不自动安装或调用新付费服务。
