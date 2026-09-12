# 真实一轮对话验证（DeepSeek）— 2026-09-12

范围：用**真实 Provider Key** 跑通整轮对话，点亮 [进度文档](../../WORKBENCH_PROGRESS.md) §3 第 2 条与第 5 条。
两条路径各跑了两轮：headless harness（node，生产 Runtime）与浏览器 dev（真实页面渲染）。

**这不是 INT-01**：仍然没有 Tauri、没有 `plugin-sql`、没有桌面真机。存储与 Trace 落盘用的是 node:sqlite 真实引擎（harness）或 localStorage 降级（浏览器）。

## 为什么做这一次

LLM-10 把四种协议的 usage 解析都写完了，但它自己的验收报告写着「那些数字来自 fixture，真实平台 NOT RUN」；FE-09 / FE-10 的 Trace 页、能力调用视图、一轮数据流三处此前只验到空态。这三件事一轮真实对话可以一次性了结，所以先做它。

## 环境与命令

Key 来源：`%APPDATA%\com.aika.companion\secrets.json` 的 DPAPI 密文（`crossSession.real.test.ts` 原有的解析路径），解出后只存在于 dev server 进程的环境变量与 node 测试进程内存中——不进浏览器、不进 localStorage、不落任何文件。

```
harness：一次性 vitest 文件 + 生产 createCompanionRuntime / createStreamChatProvider
         / createSqliteStorage / createSqliteTraceSink，跑完即删
浏览器：npm run dev（vite 7.3.6, :1420）+ Playwright
         Key 由临时 vite 代理在服务端注入，页面里填的 baseUrl 是 http://localhost:1420/llmproxy
Provider：DeepSeek，openai-compatible，deepseek-chat
```

临时 harness、临时代理、evidence 文件均已删除，`git status` 干净。

## 逐项结果

| 项 | 结果 | 证据 |
| --- | --- | --- |
| Runtime → Provider → 存储 → Trace 全链路 | PASS | 四轮 submit，两轮 `completed` 且 `persisted: true`；消息落库 2 条（user + assistant），`runtimeTurnId` 一致 |
| LLM-10 · `turn_end.tokens.reportedTotal` 来自真实平台 | **PASS（原 NOT RUN）** | 1069 / 1076 / 1090，三轮均非 null |
| LLM-09 · `reply` 事件与双语退化率 | PASS | 三轮 `translationDuplicatesReply` 全 false；正文/翻译字数 50+35、56+45、65+49 |
| FE-09 · Trace 页渲染真实轮次 | PASS（有缺陷，见下） | 刷新后 3 轮，逐轮 7 项指标 + 原始 JSONL 全部渲染 |
| FE-10 · 能力调用视图 | PASS | 六行全部给出真实判定：上下文检索 empty / 来源降级 ok / 表情包 empty / 双语回包 ok / 记忆抽取 absent / 语音播放 absent |
| FE-10 · 一轮数据流 | PASS | 事件按 `offsetMs` 排序渲染 |
| 浏览器 console | PASS | 一轮真实对话全程 0 error |
| 双语回复质量 | PASS（样本 3） | 日文正文 + 中文翻译，均非同句复读 |
| Tauri 真机 / `plugin-sql` | NOT RUN | 留 INT-01 |

一轮完整 trace（浏览器，`2ba6dd62`）：

```
turn_start(text) → context_assemble(370) → provider_request(deepseek-chat, 2109 chars)
→ provider_stream_meta(first=854ms, chunks=46) → reply(65+49, dup=false)
→ turn_end(completed, 1416ms, estimatedPrompt=390, reportedTotal=1090)
另有 memory_extract(cand=0, failed=false)
```

## 查到的问题

### 1. 工作台打开时不取数，必须手点刷新

刚跑完一轮进工作台，Trace 页显示「**0 轮**·还没有事件·Trace 已启用但这一次运行还没记录到轮次。说一句话再回来看」。点「刷新」后立刻出现 3 轮。

原因：`createDevToolsPresenter` 的 `start()` 是幂等的（「重复调用只装载一次」），而它在应用启动时就被调用过一次——那时确实没有事件。面板之后每次打开拿到的都是**启动那一刻的快照**。

后果不止是少一次刷新：空态文案在这种情况下是主动误导的——它让人以为「Trace 没记到」，而事实是「面板没去读」。刚说完话的人会去查 Trace 开关，而不是去点刷新。

与 [界面冒烟](UI_SMOKE_BROWSER.md) 查到的 `[hidden]` 缺陷同一类：不在任何一份 SPEC 的判定逻辑里，单测碰不到，只有真实数据才露出来。

### 2. 「首 token」量的不是首 token

一次真实调用的分解（包装 `fetch` 打时间戳）：

| 累计 | 增量 | 段 |
| --- | --- | --- |
| 15ms | 15ms | 上下文装配 + 用户消息落库 + 建请求 |
| 404ms | 389ms | 网络 + 平台响应头 |
| 406ms | 2ms | 首个 SSE 字节（role chunk，无内容） |
| 758ms | 352ms | 平台吐出第一个非空 `content` |
| 869ms | 111ms | 吃掉 JSON 信封前缀，出现第一个可见 delta |
| 1382ms | 513ms | 正文流完，`generated` |

首个 delta 的累计正文只有一个字 `こ`——`providerClient` 的 `emitPartial` 要解析出正文/翻译/mood 变化才回调，`{"mood":"gentle_smile","replyText":"` 这段前缀全程不计可见进度。

对照基线（curl 直连 `api.deepseek.com`，同一 Key）：

| prompt | TTFB |
| --- | --- |
| 2 字符 | 311ms / 338ms |
| 1831 字系统提示词 + 用户句 | 216ms / 275ms / 316ms |

两点结论：

- **不是 prompt 大小的锅**，也不是代理的锅（node 直连同样 853 / 1067ms）。
- 工作台的「首 token」= 首个**可见正文字符**，比平台首字节晚约 460ms。它不是错的（对「用户多久看到第一个字」这个问题它才是对的），但标签叫「首 token」会让人拿它跟平台 TTFB 比，那是两件事。

可省的那一段是最后的 111ms：`replyText` 现在不是 JSON 的第一个字段，把它提到最前面，第一个可见字就能提前约 100ms。**这是取舍不是结论**——`mood` 早到能让立绘先变表情。

### 3. `estimatedPrompt` 系统性低估约 2.5 倍

| 轮次 | estimatedPrompt | reportedTotal |
| --- | --- | --- |
| 2ba6dd62 | 390 | 1090 |
| harness #1 | 370 | 1069 |
| harness #2 | 370 | 1076 |

`reportedTotal` 含 completion（约 100），即真实 prompt ≈ 990 对估算 390。

原因：`turn_end.tokens.estimatedPrompt` 取的是 `turn.estimatedPromptTokens`，而它等于 `assembled.estimatedTokens`——**contextAssembler 的估算里不含 `providerAdapter` 拼的 1831 字系统指令**（人设 + 模式 + 表情包清单 + 检索段）。那段指令每轮都发，是固定开销，估算却看不见它。

两处后果：

- F9 成本页若拿 `estimatedPrompt` 当「平台没报 usage」时的兜底，会一路低估。
- `estimateTokens` 的注释写着「刻意高估，保证估算值不超预算时真实请求也不会超」——这个保证对**上下文预算**成立，对**整个请求**不成立。

### 4. 取消的轮次拿不到 usage

两轮 `cancelled` 的 `reportedTotal` 都是 null：

| 轮次 | 状态 | chunks | reportedTotal |
| --- | --- | --- | --- |
| 78f03ff1 | cancelled | 21 | null |
| 334c792d | cancelled | 0 | null |

LLM-10 说「取消与失败的轮次同样要能记账」，协议上成立（`usage` 是独立事件），但 DeepSeek 只在**末包**给 usage，取消发生在末包之前就一定拿不到。已经烧掉的 token 在成本页上会是「—」。

这不是 LLM-10 的实现缺陷，是**平台能力的边界**：要覆盖这部分，成本页得承认「取消轮次的花费只能估，不能报」，而估的那个数就是问题 3 里偏低 2.5 倍的 `estimatedPrompt`。两件事连在一起。

### 5. 语音：看到了，但没复现

trace 里有一轮 `source: "voice"`（`334c792d`，12:02:15）真的发到了平台（`provider_request`，估算 457 token）随后被 cancelled；语音模态在无人点击的情况下出现过两次，其中一次显示「识别中：我的心」——麦克风把环境音当成了输入。聊天记录里也多出两条没有人输入过的用户消息。

**两次受控复现都失败**：页面空载 45 秒不开；文字对话完成后 30 秒也不开。`setOpen(true)` 全仓只有 `voicePresenter.open()` 一个调用点，只能由 `openVoice()` 触发。

因此只记现象不下结论。最可能的解释是自动化误点了输入框旁的 Mic 按钮。**如果要追**，值得查的是「语音模态关闭后，攒下的识别文本是否仍会提交」——那一轮 voice 请求发出的时刻，模态已经不在页面上了。

### 6. 顺带

- `domain/trace.ts` 的 `TraceTokens` 注释仍写着「`reportedTotal` 目前一律 null：provider 侧还没把 usage 透出来」，LLM-10 之后已不成立。
- 浏览器 dev 模式下 API Key 明文存在 `localStorage` 的 `aika.insecure.secrets.v1`（应用自己有警告，桌面版走 DPAPI 不受影响）。
- 平台实际服务的模型是 `deepseek-flash`（SSE 响应体里的 `model` 字段），即使请求写的是 `deepseek-chat`。

## 未覆盖范围

- **Tauri 真机与 `plugin-sql` 仍是 NOT RUN**，留 INT-01。
- 样本量 3 轮、单一 Provider、单一协议（openai-compatible）。双语退化率 0/3 只能说「这三轮没退化」，不构成比率。
- 另外三种协议（openai-responses / anthropic / gemini）的 usage 解析仍只有 fixture 证据。
- 语音链路没有做真实验证，只有上面那一条观察。
