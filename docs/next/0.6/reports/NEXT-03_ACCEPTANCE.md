# NEXT-03 验收报告 · 多 Provider 适配

- 执行：goal worker（2026-09-19）。SPEC：[NEXT-03](../specs/NEXT-03.md)。需求：N06-R04。
- 状态：**AUTO_PASS**（真实回放项按 03-F 明确 BLOCKED，见 §5）。
- 基线：`61f4fa1`（NEXT-02 后）。

## 1. 实际范围

新增 `providers/aika-dialogue.ts`：`OpenAiCompatibleDialogueProvider`（SSE chat/completions，DeepSeek=同协议不同 endpoint/model 配置）、`GeminiDialogueProvider`（generateContent）、`createAikaDialogueProvider` 协议选择工厂。
上游 `providers/transport.ts` 一次向后兼容扩展（见 §2）。未改 DialoguePipeline/Memory/Voice；无重试逻辑。
新契约用例 13 个（两协议 × 6 场景 + 工厂映射），tests/next 合计 41 个。

## 2. 共享文件变化（AGENTS 规则 8 登记）

| 文件 | 原语义 | 新语义 | 兼容方式 | 必跑用例 |
| --- | --- | --- | --- | --- |
| `providers/transport.ts` `request()` | 固定 `Authorization: Bearer` 头；body 恒注入顶层 `model` | 追加第 8 个可选参数 `opts?: { headers?; omitModel? }`：`headers` 整体替换默认头（Gemini 用 `x-goog-api-key`）；`omitModel` 抑制 body.model（Gemini 的 model 在 URL） | 纯增量尾参，不传即原行为；既有调用点零修改；diagnostic trace 依旧不含头/URL/凭据 | `default` 组 563/563（含 adapters.test 等 transport 重度用例）实跑 exit 0 |

## 3. 命令与退出码（cwd `windows/code/desktop-pet/`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit`（实现前） | 1 | **RED**：`Cannot find module '../../providers/aika-dialogue.js'` |
| `npm run test:next`（实现后第 1 遍） | 0 | 41 tests / 41 pass |
| `npm run test:next`（第 2 遍） | 0 | 41/41；剥离耗时后两遍逐行一致 |
| `node tools/run-tests.mjs default` | 0 | 563/563（上游回归，覆盖 transport 改动） |

调试记录：in-flight abort 用例首版在 Gemini 路径挂起——`response.json()` 在假 Response 上不受 abort 中断（真实 undici 因连接销毁而 reject）。fixture 改为 abort 时对流显式 error（贴近真实断连语义）；生产实现未因此改动。

## 4. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 03-A | **PASS** | 同一契约套件参数化跑两协议（happy/broken/empty/malformed/hanging/pre-aborted）。openai：断言 URL=config.endpoint、body.model=config.model、system 消息=profile prompt、历史消息在请求中；gemini：断言 URL 含 `models/<model>:generateContent`、body 无 model 字段、systemInstruction 正确 |
| 03-B | **PASS** | SSE/JSON body 按字节逐块 enqueue（多字节 UTF-8 与 CRLF 跨块切割），重组文本与原文逐字相等（含日文+emoji），`finish_reason==='stop'`/`finishReason==='STOP'` 唯一终态；缺失/非正常终止（length、MAX_TOKENS）一律拒绝 |
| 03-C | **PASS** | AbortSignal 传播：在途 abort 后 reply 拒绝、authorize 恰好 1 次、settle 记录 `cancelled`；预取消则 0 请求、authorizer 不被咨询；无重试循环（broken 场景 calls===1）；迟到数据在拒绝后无外部效果 |
| 03-D | **PASS** | 两协议都实现上游 `DialogueProvider` 端口，工厂仅按 `protocol` 映射（未知协议抛错）；DialoguePipeline 零改动、无 Provider 分支（NEXT-01 契约用例继续全绿） |
| 03-E | **PASS** | fixture 断言必要头（Bearer / x-goog-api-key）使用明显的假 Key（`test-only-key`）；所有错误消息断言不含 Key；transport 诊断 trace 本就不含头/URL/凭据 |
| 03-F | **BLOCKED**（明确登记，不冒称） | 本机无已验证凭据：上游凭据体系（EndpointConfig+CallAuthorizer+ManagedCredentialStore）就绪，Legacy `aika-crossplatform/.env` 存在但未读、有效性未证实；不得未经用户授权调用付费 API。fixture 层两协议事实单列于本报告；真实固定样本回放留待用户提供授权凭据后执行（NEXT-08 收口复核） |

## 5. 真实回放 BLOCKED 处置

- 需要用户动作：提供一条已授权凭据（DeepSeek 或 DashScope 或 Gemini API Key）并明确允许计费调用，或指定用旧 `.env` 中的既有 Key。
- 恢复步骤：NEXT-03 补录 `test:next:real` 固定样本（正常问答+多轮各≥1，登记 CORPUS_MANIFEST），经 `npm run test:next:real`（PET_NEXT_REAL=1 门禁）执行；缺失不影响 03-A~03-E 已证事实，但按 RPD 不得据此宣称全模型实测。

## 6. 已知限制与待办

1. Gemini 走非流式 `:generateContent`（transport 的 URL 策略禁止 query，`?alt=sse` 不可用）；SSE 分片重组契约由 OpenAI-compatible 路径 + Gemini JSON body 字节切割共同覆盖。若未来需要 Gemini SSE，需上游扩展 URL 策略——已在此记录，不擅自放宽。
2. 表达式（emotion/delivery）当前为中性常量：上游角色表现协议绑定其自有模型 JSON 约定，Aika 文本对话 0.6 不依赖表情；接 Live2D 表现属后续版本。
3. 连续同角色消息在 Gemini 侧合并为同一 content（协议惯例），OpenAI 侧保持原序列。
