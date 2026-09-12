# v0.5 与未完成计划审阅

2026-09-13。本次为文档/接口设计审阅，查阅索引、SPEC、报告与相关源码/工作区diff；未重新运行全仓测试，未完成全部业务实现逐行审计，未追认历史自测。

| 严重性 | 发现与处理 | 执行影响 |
| --- | --- | --- |
| P0 | FE-14原样外发ReplyEnvelope含memoryCandidates、Trace可能含正文；改为外发白名单投影与逐主体授权 | 不能把本地脱敏开关当对外共享许可 |
| P0 | FE-17 TLS ack不能证明TLS；长效token不是一次性配对码 | 安全前置改为可信入口/逐设备会话，公网保持条件阻塞 |
| P0 | v0.5把Permission放在Agent之后风险过高；ACP不保证自有工具受控 | RT-03前置；AGT-02/03要求真实拒绝写负例 |
| P1 | Live Inspector FE-14～16与AikaLink撞号 | 改LLM-11+FE-23～25；F9为FE-26 |
| P1 | LLM-04报告实为模型列表 | 原报告迁至LEGACY_MODEL_LIST_ACCEPTANCE，旧路径保留指针；新后台维护报告另用明确名称 |
| P1 | CORE-03～05集成登记仍要求legacy回退，与CORE-06冲突 | 历史登记保留，当前只验唯一Runtime与旧键兼容 |
| P1 | 先query再订阅丢事件；相邻时间差不能当真实阶段耗时 | FE-23订阅缓冲合并；FE-24配对计时；Trace去重包含turnId |
| P1 | context最终结果无法还原trimmed内容；type不含key仍可能在正文泄密 | LLM-11裁剪前诊断+单点脱敏/内容闸门 |
| P1 | LLM-10索引全真实NOT RUN与DeepSeek报告冲突 | 仅DeepSeek已有样本，另外三协议仍fixture，不能推及质量 |
| P1 | SPEC_STATUS_REPORT称3红必为生产缺陷，但工作区已有测试异步等待修复 | 保留原报告历史；下个worker定向复核，不预判修复成功 |
| P2 | STT/TTS-01/02、FE-01～03缺正式记录 | 统一为状态未核实/待补证，不能因索引缺报告认定未实现 |
| P2 | F9缺价目/usage覆盖，取消未知且estimatedPrompt不完整 | 分开reported/estimated/unknown，未知不算0或账单 |
| P2 | FE-20 fake invoke无法证明真窗口拖拽/穿透，FE-22纯策略缺持续时间输入 | 分开自动/人工；补显式聚合输入与并发闸门要求 |

## 全部未完成项处置

| 条目 | 处理 |
| --- | --- |
| INT-01 | 第一轮自动审查后优先跑可自动部分；桌面/SQL/真实模型/手机分列 |
| INT-02、STT-03、TTS-03 | 保持DEFERRED；不减少20轮/10次打断等原AC |
| INT-03 | 发布前完整门禁，不因曾build成功而PASS |
| LLM-04/05 | 原范围继续，04复用已有writeback避免双worker；RAG不升向量库 |
| CORE-01～09、LLM-01～03/06～10、FE-04～13、STT-04 | 保持待审阅，下一worker做自动审阅及定向修复，人工仍待办 |
| STT/TTS早期、FE-01～03 | 补逐AC真实证据，无法追溯保留NOT RUN |
| TTS无编号两项 | TTS-04设置与错误传播；TTS-05真实试听条件执行 |
| FE-14～17 | 修订安全边界后纳入v0.5 Device前置，禁止草案旧条款直接外露 |
| FE-18～22 | 已有SPEC保留；本次未解除后置，修正文档不自动采集 |
| F9 | FE-26，读真实一轮报告后实现 |
| Live Inspector | LLM-11、FE-23/24/25四份新增SPEC |
| 评测harness入口 | 保持F9+ backlog，不制造现阶段需求细节 |
| 六项backlog | 编辑后重发/对话导出/配额提醒/错误文案统一/设置搜索/标题栏换模型保留backlog；与Trace JSONL导出区分 |
| 总PRD §3.2 | Whisper实机、延迟、Memory/User Soul质量、口语练习、Live2D持续缺口，不被v0.5替代 |
| Stage3与云Relay | 未立项/后置，不自动执行 |
| v0.5新增 | runtime/gateway/agents索引逐份对应；原生Android、Push、Discovery仅后续槽位 |

## 本轮验证与局限

只做文档链接、编号、依赖和改动范围检查；工程命令留执行worker。当前已有 speechOutput.conformance.test.ts、frontend PRD/SPEC、图文件及未跟踪文件，均属于既有工作区基线；本次不修改业务源码、不删除这些文件、不做Git提交。

文档检查：扫描当前非archive文档662处相对链接，发现并修复CORE-04历史报告到integration的相对路径。新增25份SPEC；未运行工程测试（本次仅文档改动）。图表HTML在工作期间出现额外工作区变化，非本任务编辑，保留不处理。

## 全文阅读与重点审阅收口（第二轮）

范围：已全文读取待执行/早期缺验收SPEC：LLM-04/05/11，STT-01～03，TTS-01～05，FE-01～03/14～26，RT-01～06，GW-01～06，AGT-01～05，INT-01～04（前三项在integration/SPEC.md）；新增并审阅LLM-12。没有将已交付待审阅的全部生产代码做逐行审计。用户随后要求节约限额，只保留关键位置的深入审阅，故不继续扩大全仓实现检查。

| 关键问题 | 处理结果 |
| --- | --- |
| FE-14～17正文与尾部修订相反 | 已重写合并为单一正文，冻结可信主体、白名单投影、会话过滤与认证前置 |
| Gateway过滤不能解决Runtime全局历史/新轮取消旧轮 | RT-02明确scope贯穿历史、摘要、画像、取消及生产Runtime测试 |
| F9只有总token无法计算输入输出费用 | 新增LLM-12物理请求用量记录；FE-26新增硬前置及金额例子 |
| LLM-05没有Mode/角色/阶段输入，Context源可能覆盖Memory | 补本轮scope透传、唯一装配提供者、授权元数据去重/更新语义 |
| LLM-04队列崩溃、关闭/重开可能复活候选 | 补来源快照、原子幂等提交、epoch与来源删除规则 |
| Agent会话与单轮终态混淆，没有产品任务入口 | AGT-01拆Session/Run；AGT-05补TaskCommand、桌面任务页、远程命令和PC记录 |
| Telegram语音文件不能直接调用麦克风STT | GW-03补解码/重采样/文件转写端口及真实固定音频验证 |
| Trace订阅、设置关闭和历史显示缺可用契约 | FE-23补设置订阅、共同脱敏、事件ID、异步异常、字节上限与查询失败行为 |
| 环境生命周期、Win32消息循环、OCR置信度、pet权限 | 补异步start/stop、消息循环、0..1归一及生产算法fixture；保持后置 |
| 真实验收可能被“空自动AC集合”放行 | TTS-05/INT-04/执行计划明确禁止空集AUTO_PASS；混合AC逐证据轨记录 |
| FE-17/GW-04等待Node/public造成无关阻塞 | pre/tauri/dev-relay/public分轨，Tauri链仅消费自身门禁 |

源码核对重点：services/runtime/companionRuntime.ts（全局历史与取消）、services/context/contextAssembler.ts（source输入/裁剪）、services/memory/writeback.ts（内存队列）、domain/trace.ts（总token）、services/trace/contracts.ts及traceSettings.ts、app/plugins/voicePlugin.ts、voice/contracts.ts/whisperClient.ts、storage/secretStore.ts、app/plugins/memoryPlugin.ts、src-tauri/src/remote.rs。仅核对设计依赖和关键行为，不据此宣称这些实现已验收通过。

本轮仅修改文档，未运行工程测试、真实设备/服务，没有修改业务源码、提交或推送。执行提示词及顺序已同步；剩余重点是worker实现时定向验证这些AC，而非继续扩张设计审阅。