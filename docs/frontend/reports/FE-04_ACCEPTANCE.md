# FE-04 双语对照字幕去重 — 验收报告

日期：2026-09-12
范围：`aika-crossplatform` domain 判定 + 桌面气泡与手机终端两个消费者；不涉及 Provider 协议、提示词、存储接口与解析器容错路径。

## 需求

气泡里正文与中文小字显示同一句话两遍（[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) §0.1）。本 SPEC 只修复展示侧的同句判定，见 [FE-04](../specs/FE-04.md)。

## 查证结论（与规划文档不同，据此收窄范围）

| 规划文档 §0.1 的说法 | 查证结果 |
| --- | --- |
| 「渲染处 `App.tsx` 无条件渲染 `message.chineseTranslation`」 | **不准确**。`App.tsx:235`（改前）是 `showTranslation && message.chineseTranslation`，受用户开关控制。缺的只是「与正文是同一句就不显示」这一层，结论成立但措辞需更正。 |
| 「提示词强化：明确 replyText 必须是日语，两者不得相同」 | **不采纳**。`prompt.ts:71` 本来就写着「整句本来就是中文时，两个字段写成一样即可」，模型返回两句相同中文是**遵守**提示词；`CODE_SWITCH_RULE`（prompt.ts:25-31）又刻意规定日/中/英无主次、不设默认语言。按规划文档改会推翻角色设定。`prompt.ts` 本次未改动。 |
| 「判定放 domain 层（如 `presentationMessage()`）」 | 函数名不存在，是拟新增。实际落在 `domain/conversation.ts` 的 `displayTranslation()`，与 ChatMessage 同文件。 |
| 「按语言判定：正文本身已是中文时不渲染」 | **不采纳**。`detectLanguage` 把纯汉字的日语（「大丈夫」「了解」）判成 zh，按语言去字幕会把真正需要翻译的那几句一起去掉。改为只比较「是不是同一句」，并有专门用例守住。 |

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `aika-crossplatform/src/domain/conversation.ts` | 新增 `displayTranslation(message)`：返回次级字幕的显示值，空串表示不显示第二层。空翻译、与正文同句两种情况返回空串。私有 `sentenceKey()` 做比较键（去空白/标点/符号 + 转小写），因此仅差句末标点或英文大小写仍算同一句。 |
| `aika-crossplatform/src/components/MessageTranslation.tsx` | 新增。气泡次级字幕组件，只转发 `displayTranslation` 的结果与 `visible` 开关，无自有判断逻辑（与 `MessageSticker` 同一写法）。 |
| `aika-crossplatform/src/App.tsx` | 气泡内 3 行内联条件渲染替换为 `<MessageTranslation message visible />`；仅此一处与一行 import。 |
| `aika-crossplatform/src/domain/remote.ts` | `toRemoteMessages` 改走同一判定：同句时不再下发 `translation` 字段，手机端同步修好。 |
| `aika-crossplatform/src/domain/conversation.test.ts` | 新增 `displayTranslation` describe，6 条用例。 |
| `aika-crossplatform/src/domain/remote.test.ts` | 新增 1 条用例：同句时 payload 不带 `translation`。 |
| `docs/frontend/specs/FE-04.md`、`docs/frontend/SPEC.md` | 新增 SPEC 与索引一行。 |

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/domain/conversation.test.ts src/domain/remote.test.ts
```

退出码 0。结果：Test Files 2 passed (2)，Tests 24 passed (24)。

突变验证（确认新用例不是空跑）：把 `displayTranslation` 的判定改成恒返回 `translation` 后重跑同一命令 → Tests 4 failed | 20 passed，失败项正是「翻译和正文是同一句时不显示第二层」「只差空白、标点或大小写仍算同一句」「失败气泡的正文在 content 里，同样参与判定」「翻译和正文是同一句时不带这个字段」。随后已还原，`grep MUTANT` 无命中。

附加门禁（App.tsx 与新组件为 .tsx，需确认可编译）：

```
npx tsc --noEmit                               → 退出码 0
npx vitest run src/kernel/architecture.test.ts → Tests 28 passed (28)
```

> 说明：`tsc --noEmit` 属 AGENTS.md 所列「不默认执行」项，本次为验证新增 JSX 组件与 App.tsx 接线能通过类型检查而定向执行一次，未执行 `npm run build`、全仓 `npm test` 或 Tauri 打包。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-04-A 同句（含仅差空白/标点/英文大小写）时判定返回空串，界面不渲染次级字幕 | PASS | `conversation.test.ts`「翻译和正文是同一句时不显示第二层」「只差空白、标点或大小写仍算同一句」；界面侧 `MessageTranslation` 对空串返回 `null` |
| FE-04-B 确实是另一句时照常显示；纯汉字日语不被按语言误杀 | PASS | 「翻译是另一句时照常显示」「纯汉字的日语不按语言误杀字幕」（`大丈夫`→`没事的`、`了解`→`知道了`） |
| FE-04-C 手机终端走同一判定；空翻译等既有行为不变 | PASS | `remote.test.ts` 新增用例 + 既有 4 条用例全绿（含「没有翻译时不带这个字段」「失败的那一条照发」） |

## 共享接口影响

- 无跨模块接口变更：未新增/修改 kernel token、Tauri 命令、存储契约、`ReplyEnvelopeV1`、提示词。
- `displayTranslation` 是 domain 内新增导出，消费者两个：`components/MessageTranslation.tsx`、`domain/remote.ts`。

## 待联调项与未覆盖范围

- NOT RUN：真实模型对话下的目视确认。本仓库无 DOM 测试环境（devDependencies 无 testing-library），界面接线以「组件无自有分支、只转发 domain 判定」为可审阅依据；能否在真机上看到修复需一次真实对话。mock 不冒充真实模型回复质量。
- 未做（不在本 SPEC）：规划文档 M0 的另一半「error 气泡重试按钮」。查证发现它不是规划文档所称的「小改」——`services/storage/contracts.ts` 只有 `deleteMemory`，**没有任何删除消息的接口**，而失败气泡已被 `companionPresenter` 持久化（`finish()` 里 `await persist(failure)`）。重试要么留下一条永久的失败消息，要么需要新增 storage 端口 + conformance 用例 + sqlite/localStorage 两个适配器实现，属独立 SPEC。
- 同理后置：撤回、重新生成、Rewind（均依赖上述删除/截断语义）。
