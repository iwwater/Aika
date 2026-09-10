# LLM-01 验收报告：Soul、Mode 与输出协议

- 模块 / 小阶段 / SPEC 版本：LLM / LLM-01 / `docs/llm/SPEC.md`
- 基础分支：`master`（本轮未提交、未推送）
- 状态：工程契约定向复测通过；LLM-01-D 已完成真实 Qwen `streamChat` 样本执行，质量审阅待定
- 真实依赖：已使用 Aika 标准安全存储中的 Qwen Provider；无 STT/TTS、无设备；工程单测中的 Storage 仍使用 fake
- 本轮范围：审计并补齐 CharacterSoul/UserSoul 基础类型、三种 Mode、场景配置读写/退出、ReplyEnvelopeV1 归一化、流式旧协议适配的新增边界

## 改动文件

生产代码：

- `aika-crossplatform/src/domain/soul.ts`
- `aika-crossplatform/src/domain/companion.ts`
- `aika-crossplatform/src/domain/streamingReply.ts`
- `aika-crossplatform/src/services/providerClient.ts`
- `aika-crossplatform/src/domain/prompt.ts`
- `aika-crossplatform/src/hooks/useCompanionSession.ts`
- `aika-crossplatform/src/services/storage/contracts.ts`
- `aika-crossplatform/src/services/storage/localStorageStorage.ts`

本轮实际修复：

- 模式设置仅在 `setSetting` 成功后更新内存；保存失败保持原配置并暴露错误。
- canonical 字段在同轮同时出现新旧字段时优先；不完整 JSON 不再降级为普通正文。
- 增量 decoder 对非法/跨片 Unicode escape 不输出伪字符。
- 流式 decoder 只读顶层字段；旧字段先到时缓冲，canonical 后到不会造成正文回退；相同快照不重复下发。
- 模式保存失败后成功重试只清理对应模式保存错误。

模块测试：

- `aika-crossplatform/src/domain/soul.test.ts`
- `aika-crossplatform/src/domain/companion.test.ts`
- `aika-crossplatform/src/domain/streamingReply.test.ts`
- `aika-crossplatform/src/domain/prompt.test.ts`
- `aika-crossplatform/src/services/providerClient.test.ts`
- `aika-crossplatform/src/services/storage/storageCompatibility.test.ts`
- `aika-crossplatform/src/hooks/useCompanionSession.integration.test.ts`

固定样本：`docs/llm/reports/evidence/LLM_01_FIXED_SCENARIOS.json`

边界证据：`docs/llm/reports/evidence/LLM_01_BOUNDARY_CASES.json`

真实 Provider 证据：`docs/llm/reports/evidence/LLM_01_REAL_QWEN_SAMPLES.json`

## AC 证据

| AC | 生产行为与测试证据 | 命令 / 观测值 | 结果 |
| --- | --- | --- | --- |
| LLM-01-A | `soul.ts` 固定 `CharacterSoul` 身份；`normalizeModeConfig` 支持三模式；`exitScenarioMode` 删除场景临时身份且不改写输入；session integration 通过 settings 写入、重载、退出验证；保存失败时原配置与持久化值均保持不变 | 同一条定向 Vitest 命令；保存失败 fake storage、模式重载与 `llm.mode` 断言 | PASS |
| LLM-01-B | `ReplyEnvelopeV1` 支持 canonical `replyText/translation/memoryCandidates/actions`，兼容 `reply_text`、旧 `japanese_text/chinese_translation`、`emotion/toolCalls`；同轮 canonical 优先且不拼接；流式解析在 JSON 闭合前交付 canonical 正文，旧字段先到时缓冲，支持 JSON escape/Unicode surrogate 跨片与顶层字段选择 | 同一条定向 Vitest 命令；canonical 冲突、旧→新字段切换、嵌套字段、跨片 `\\u`/代理对、Provider 下游增量测试通过 | PASS |
| LLM-01-C | 未知/无效 mood 归一为 `neutral`；未知 action 被过滤，仅保留当前已知 `sticker`；`replyText/translation` canonical 非 string、不完整或无可显示正文的 JSON 由 provider 显式失败；memoryCandidates/actions 按各自归一化策略处理且不回退旧集合；旧配置/坏配置回到 companion；保存错误可见且下一轮逻辑不受污染；browser settings adapter 传播写入失败 | 同一条定向 Vitest 命令；7 个测试文件共 102 个测试通过 | PASS |
| LLM-01-D | 三模式各 10 个固定文本场景，共 30 次真实生产 `prompt → streamChat`；覆盖角色/边界冲突、中文求助、暂停纠正、退出场景和未知动作 | Qwen `qwen-plus` 工作空间端点；30/30 返回完整 `replyText/translation`，30/30 mood 合法，30/30 有流式增量；`companion-10` 在提供 `wink` 清单时返回 1 个白名单动作 | REAL RUN / REVIEW REQUIRED：协议与传输证据通过；角色自然度、边界表达和教学质量需审阅真实输出，暂不宣称 LLM-01 整体通过 |

## 测试记录

实际执行命令：

```text
npx vitest run src/domain/soul.test.ts src/domain/companion.test.ts src/domain/streamingReply.test.ts src/domain/prompt.test.ts src/services/providerClient.test.ts src/services/storage/storageCompatibility.test.ts src/hooks/useCompanionSession.integration.test.ts
```

结果：`7 passed (7)`，`102 passed (102)`，退出码 `0`。

固定样本结构校验命令：

```text
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('..\\docs\\llm\\reports\\evidence\\LLM_01_FIXED_SCENARIOS.json','utf8')); console.log(JSON.stringify({outputKind:p.outputKind,modes:Object.fromEntries(Object.entries(p.modes).map(([k,v])=>[k,v.length])),total:Object.values(p.modes).reduce((n,v)=>n+v.length,0)}));"
```

结果：`{"outputKind":"fixture","modes":{"companion":10,"oral_practice":10,"scenario_practice":10},"total":30`，退出码 `0`。

边界证据结构校验命令：

```text
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('..\\docs\\llm\\reports\\evidence\\LLM_01_BOUNDARY_CASES.json','utf8')); console.log(JSON.stringify({spec:p.spec,cases:p.cases.length,statuses:p.cases.map(x=>x.status)}));"
```

结果：`{"spec":"LLM-01","cases":11,"statuses":["pass","pass","pass","pass","pass","pass","pass","pass","pass","pass","pass"]}`，退出码 `0`。

真实 Provider 配置可用性检查（不读取或输出密钥）：

```text
Test-Path "$env:APPDATA\\com.aika.companion\\secrets.json"
```

结果：`True`，退出码 `0`。Provider 元数据写入 Aika `aika.db`，Key 仅以当前 Windows 账户 DPAPI 密文写入标准 `secrets.json`；本报告及证据不含明文 Key。

真实样本执行结果：

- Provider：`qwen` / `qwen-plus` / OpenAI-compatible 工作空间端点。
- 样本：`companion:10`、`oral_practice:10`、`scenario_practice:10`，共 `30` 条。
- 生产路径：使用实际 `buildInstructions`、`buildConversationInput` 和 `streamChat`，不调用 fixture 输出替代真实响应。
- 协议检查：`30/30` 有非空正文与翻译、`30/30` mood 在白名单内、`30/30` 至少收到一个流式正文增量、`0` 请求失败。
- 证据文件补充了每条的 fixture 输入引用/原文、实际 ModeConfig、`history: []`、允许动作 ID、生产代码版本和协议/质量 verdict；单条执行时间未在原始运行器中采集，明确记为 `unknown`，不反推。
- 证据文件只保存模型输出与结构化计数，不保存 API Key。

未执行全仓 `npm test`、全局 `tsc`、`npm run build`、Tauri 打包；按模块测试规则，这些属于集成/发布门禁，不是 LLM-01 默认门禁。

## LLM-01-D 的真实性边界

固定样本的 `outputKind` 仍明确为 `fixture`，它只用于定义输入与检查点，不能替代真实输出。真实输出已单独保存在 `LLM_01_REAL_QWEN_SAMPLES.json`，证明生产请求、流式增量和 ReplyEnvelopeV1 解析均实际跑通；它不自动证明自然度、角色一致性、边界表达或教学质量。

真实输出初审标出的明确质量失败：

- `companion-01` 声称“刚给自己倒咖啡”，`companion-03` 引入“泡茶/留座”，`companion-08` 声称“正在看窗帘”，均是无来源的当前身体/物理环境经历。
- `oral-02` 在纯文本输入下承诺根据“发音”纠正，并虚构拉袖子/递咖啡等当前行为。
- `scenario-03` 用户要求中文时 `replyText` 仍为日语，不能由中文 `translation` 替代。
- `oral-10` 使用“记下了”，会暗示画像已持久化，但本轮未执行 UserSoul 写入。

不应误判为失败的样本与后续验证：

- `companion-09` 的 `actionCount=0` 已满足未知动作不执行，不要求固定说“拒绝”。
- `oral-04`/`oral-07` 是无先前待解释句子的独立样本，追问不能按 fixture 的虚构上下文判失败。
- `scenario-04` 单句不能证明 `exitScenario` 已调用；需在同会话保存 `modeConfig`/`history`，执行退出后再跑普通聊天下一轮。

因此 LLM-01-D 当前结论是：真实生产样本已执行且协议门禁通过，但上述质量失败需 Prompt 修复后复测；不将 `30/30` 请求成功直接等同于质量通过。

## 流式字段选择策略

- 增量扫描只接受 JSON object 第一层字段，`memoryCandidates`/`actions` 内嵌套的 `replyText` 不会被误认。
- `replyText` 一旦出现即锁定；若 `japanese_text`/`reply_text` 先出现，则缓冲到完整 JSON 再决定是否使用。这保证 canonical 后到时不会让下游正文回退，但旧协议只有首句会延迟到对象闭合。
- canonical `replyText/translation` 存在但为 `null`、number 或其它非 string 时显式失败，不回退旧文本；mood 通过 `normalizeMood` 回退 `neutral`，memoryCandidates/actions 继续走各自的数组归一化与 action 白名单，不因无效值拼接旧字段。
- `streamChat` 对相同的正文/翻译/mood/闭合状态快照去重；Provider 下游收到的最后一个正文快照与最终落库正文一致。

## 共享契约影响与集成待测项

- ReplyEnvelopeV1 的 canonical 字段为 `schemaVersion/mood/replyText/translation/memoryCandidates/actions`，旧字段只在 LLM 适配层兼容；前端/语音现有 `CompanionReply` 别名仍可读取。
- `SETTING_KEYS.mode = "llm.mode"` 使用现有 generic settings，不增加 SQLite 表迁移；FE-02 可消费 session 暴露的 `modeConfig/setModeConfig/setMode/exitScenario`。
- 模式读写继续通过现有 `AikaStorage.getSetting/setSetting` 兼容 adapter；本轮只收紧保存确认语义，没有新增第二套 `ModeStore` 或共享表结构。
- `setSetting` 调用点已核查：启动迁移经 `load` 错误边界、主动消息在既有 `try/catch` 内；provider/voice/ordinary settings 的 Promise 拒绝在 SQLite 路径本来就可能发生，本 SPEC 未扩大为 UI 重做，只新增模式保存的定向错误/重试证据。
- 需要在 INT-01 复测 Provider→Runtime→前端消费者的统一字段和模式设置；需要在 INT-02 复测语音链路；本轮没有修改 STT/TTS、页面或 Rust/Tauri。
- actions 当前只归一化已知 `sticker`，没有外部 Tool Runtime；未知动作不会执行。

## 明确后置项目

- 真实 Provider 输出与三模式各 10 轮：已执行并保留真实证据；自然度、角色一致性、边界和教学质量仍待原任务审阅，不称为自动通过。
- 真实麦克风、TTS 声学回采、耳机/外放、设备基线：不属于 LLM-01，按用户决定后置真人验收。
- UserSoul 自动画像写回、独立 CompanionRuntime、Context/Memory/RAG：分别留给 LLM-02～LLM-05，本轮没有提前实现。
- FE 模式按钮和页面设置：归 FE-02，不混入 LLM-01。

执行者自测结论：LLM-01 的生产协议、Soul/Mode 配置与旧协议适配已完成定向复测；本轮补齐了保存失败不变性、canonical 优先、顶层字段选择、旧→新流式切换、代理对跨片和坏流终态边界。随后使用标准 DPAPI Provider 配置实际执行三模式各 10 条 Qwen `streamChat` 样本，30/30 完成协议级返回；真实模型质量仍不自动宣称通过。

原任务证据审阅结论：LLM-01-A/B/C 审阅通过；LLM-01-D 已从 BLOCKED 转为 REAL RUN / REVIEW REQUIRED，协议证据为 30/30，但质量检查点仍待审阅，因此 LLM-01 整体暂不宣布通过。真实模型质量审阅与真实麦克风/TTS/设备验收的 DEFERRED 状态相互独立。

下一小阶段：由原任务审阅真实 Qwen 输出证据并决定 LLM-01-D 质量结论；在审阅完成前不派发 LLM-02。本轮不自行提交/推送。
