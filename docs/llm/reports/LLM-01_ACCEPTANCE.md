# LLM-01 验收报告：Soul、Mode 与输出协议

- 模块 / 小阶段 / SPEC 版本：LLM / LLM-01 / `docs/llm/SPEC.md`
- 基础分支：`master`（本轮未提交、未推送）
- 状态：工程契约自测通过；原任务审阅待定
- 真实依赖：无真实 Provider、无 STT/TTS、无设备；Provider/Storage 在测试中使用 fake
- 本轮范围：CharacterSoul/UserSoul 基础类型、三种 Mode、场景配置读写/退出、ReplyEnvelopeV1 归一化、流式旧协议适配

## 改动文件

生产代码：

- `aika-crossplatform/src/domain/soul.ts`
- `aika-crossplatform/src/domain/companion.ts`
- `aika-crossplatform/src/domain/streamingReply.ts`
- `aika-crossplatform/src/domain/prompt.ts`
- `aika-crossplatform/src/hooks/useCompanionSession.ts`
- `aika-crossplatform/src/services/storage/contracts.ts`

模块测试：

- `aika-crossplatform/src/domain/soul.test.ts`
- `aika-crossplatform/src/domain/companion.test.ts`
- `aika-crossplatform/src/domain/streamingReply.test.ts`
- `aika-crossplatform/src/domain/prompt.test.ts`
- `aika-crossplatform/src/services/providerClient.test.ts`
- `aika-crossplatform/src/hooks/useCompanionSession.integration.test.ts`

固定样本：`docs/llm/reports/evidence/LLM_01_FIXED_SCENARIOS.json`

## AC 证据

| AC | 生产行为与测试证据 | 命令 / 观测值 | 结果 |
| --- | --- | --- | --- |
| LLM-01-A | `soul.ts` 固定 `CharacterSoul` 身份；`normalizeModeConfig` 支持 `companion`、`oral_practice`、`scenario_practice`；`exitScenarioMode` 删除场景临时身份；session integration 通过 settings 写入、重载、退出验证 | `npx vitest run src/domain/soul.test.ts src/hooks/useCompanionSession.integration.test.ts`；包含模式重载与 `llm.mode` 断言 | PASS |
| LLM-01-B | `ReplyEnvelopeV1` 支持 canonical `replyText/translation/memoryCandidates/actions`，兼容 `reply_text`、旧 `japanese_text/chinese_translation`、`emotion/toolCalls`；流式解析在 JSON 闭合前交付正文，保留转义与 Unicode 处理 | 同一条定向 Vitest 命令；canonical partial、旧协议、Unicode 转义和完整回复解析均通过 | PASS |
| LLM-01-C | 未知 mood 归一为 `neutral`；未知 action 被过滤，仅保留当前已知 `sticker`；无可显示正文的 JSON 由 provider 显式失败；旧配置/坏配置回到 companion；已有错误后恢复测试通过 | 同一条定向 Vitest 命令；6 个测试文件共 85 个测试通过 | PASS |
| LLM-01-D | 已保存三模式各 10 个固定文本场景，共 30 个 canonical 输出样本，覆盖角色/边界冲突、中文求助、暂停纠正、退出场景和未知动作 | `node -e "...LLM_01_FIXED_SCENARIOS.json..."`；输出 `companion:10, oral_practice:10, scenario_practice:10, total:30` | 编排证据 PASS；真实模型质量 NOT RUN |

## 测试记录

实际执行命令：

```text
npx vitest run src/domain/soul.test.ts src/domain/companion.test.ts src/domain/streamingReply.test.ts src/domain/prompt.test.ts src/services/providerClient.test.ts src/hooks/useCompanionSession.integration.test.ts
```

结果：`6 passed (6)`，`85 passed (85)`，退出码 `0`。

固定样本结构校验命令：

```text
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('..\\docs\\modules\\llm\\reports\\evidence\\LLM_01_FIXED_SCENARIOS.json','utf8')); console.log(JSON.stringify({outputKind:p.outputKind,modes:Object.fromEntries(Object.entries(p.modes).map(([k,v])=>[k,v.length])),total:Object.values(p.modes).reduce((n,v)=>n+v.length,0)}));"
```

结果：`{"outputKind":"fixture","modes":{"companion":10,"oral_practice":10,"scenario_practice":10},"total":30`。

未执行全仓 `npm test`、全局 `tsc`、`npm run build`、Tauri 打包；按模块测试规则，这些属于集成/发布门禁，不是 LLM-01 默认门禁。

## LLM-01-D 的真实性边界

30 条样本的 `outputKind` 明确为 `fixture`，用于证明模式编排、退出边界和协议字段可被审阅，不能证明真实模型的自然度、角色一致性或教学质量。由于本轮不调用真实 Provider，LLM-01-D 的“实际模型输出质量”仍 NOT RUN，真人/真实服务审阅后置。

## 共享契约影响与集成待测项

- ReplyEnvelopeV1 的 canonical 字段为 `schemaVersion/mood/replyText/translation/memoryCandidates/actions`，旧字段只在 LLM 适配层兼容；前端/语音现有 `CompanionReply` 别名仍可读取。
- `SETTING_KEYS.mode = "llm.mode"` 使用现有 generic settings，不增加 SQLite 表迁移；FE-02 可消费 session 暴露的 `modeConfig/setModeConfig/setMode/exitScenario`。
- 需要在 INT-01 复测 Provider→Runtime→前端消费者的统一字段和模式设置；需要在 INT-02 复测语音链路；本轮没有修改 STT/TTS、页面或 Rust/Tauri。
- actions 当前只归一化已知 `sticker`，没有外部 Tool Runtime；未知动作不会执行。

## 明确后置项目

- 真实 Provider 输出与三模式各 10 轮质量：DEFERRED / NOT RUN。
- 真实麦克风、TTS 声学回采、耳机/外放、设备基线：不属于 LLM-01，按用户决定后置真人验收。
- UserSoul 自动画像写回、独立 CompanionRuntime、Context/Memory/RAG：分别留给 LLM-02～LLM-05，本轮没有提前实现。
- FE 模式按钮和页面设置：归 FE-02，不混入 LLM-01。

执行者自测结论：LLM-01 的生产协议、Soul/Mode 配置与旧协议适配已完成定向自测；LLM-01-D 仅完成可追溯 fixture 编排，真实模型质量不宣称通过。

原任务证据审阅结论：待审阅。

下一小阶段：等待审阅后再派发 LLM-02；本轮不自行提交/推送。
