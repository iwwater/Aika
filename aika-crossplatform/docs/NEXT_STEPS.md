# 回来之后从这里开始

定位已于 2026-09-02 收窄为纯感情陪伴，完整方案见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。
下面是 M0 的可执行清单，按顺序做，每步都能独立验收。

## 第 0 步：git（5 分钟，今天就该做）

整个 `E:\Work\AI CHAT` 目前没有版本控制。`output/` 有 283 MB 二进制素材和六个被否的版本，
全靠文件名管理，一次脚本跑错就是几个月的美术工作。

```powershell
cd "E:\Work\AI CHAT"
git init
git add -A
git commit -m "chore: 现状快照，定位收窄为纯感情陪伴前"
```

`.gitignore` 至少要包含：

```gitignore
node_modules/
dist/
build/
target/
.gradle/
.kotlin/
local.properties
aika-crossplatform/.playwright-cli/
aika-crossplatform/output/
aika-crossplatform/src-tauri/target/
aika-crossplatform/tools/voice-workshop/workspace/
aika-crossplatform/tools/voice-workshop/input/
aika-crossplatform/tools/voice-workshop/export/
```

`output/` 要不要进仓库自己定：走 Git LFS 可以留历史，进 ignore 则要另外做一次冷备份。
**两者都比现在的「什么都没有」好。**

验收：`git status` 干净，`git log` 有一条提交。

## 第 1 步：移植 domain 层（约半天）

桌面版 `domain/persona.ts` 是 Android 版的退化版本——没有记忆注入、没有关系阶段、
没有结构化输出、没有反模板句规则。**要做的是直译，不是重写。**

| 从 | 到 |
| --- | --- |
| `app/src/main/java/com/aika/companion/domain/CompanionEngine.kt` | `src/domain/companion.ts` |
| `.../domain/CompanionPromptBuilder.kt` | `src/domain/prompt.ts` |
| `.../domain/ProactivePolicy.kt` | `src/domain/proactive.ts` |
| `app/src/test/.../ProactivePolicyTest.kt` | `src/domain/proactive.test.ts` |

移植时必改的四处：

1. **删掉教学残留**。`CompanionPromptBuilder` 里这两句整段移除：
   - 「对话目标是自然相处，同时让用户在真实语境里接触日语，不是上课，也不受 JLPT 等级限制。」
   - 「如果用户明确询问日语表达，可以自然解释；否则不要主动纠错。」
2. **关系阶段改多因子**。现在是 `totalMessageCount < 20 / < 100` 两个阈值，
   改成结合「相识天数 + 连续互动天数 + 消息总数」。消息条数不等于亲密度。
3. **加 code-switch 规则**。写进 system prompt：
   > 默认自然日语。当用户明显情绪低落、在说重要的事、或直接用中文倾诉时，
   > 可以自然地混入中文或整句用中文回应，像真正的双语伴侣那样。
4. **反负罪感规则逐字保留**。`proactiveInput` 里「不要说『系统提醒』『学习任务』，
   不要索取回复，也不要制造负罪感」——这是整个原型里最该保住的一行。

同时要改的关联文件：

- `src/domain/conversation.ts`：`ChatMessage` 增加 `japaneseText` / `chineseTranslation`，
  后续再加情绪标签供 Live2D 表情使用。
- `src/services/providerClient.ts`：`sendChat` 现在返回裸字符串，改为解析结构化 JSON 并容错。
- `src/App.tsx`：字幕改为「日语主 + 中文次级」两层结构，不再靠 `showTranslation` 猜。
- 移植完成后删除 `src/domain/persona.ts`。

验收：`npm test` 通过；聊天页能稳定拿到日语原文和中文翻译两个字段。

## 第 2 步：SQLite 替代 localStorage（约一天）

`services/storage/appStorage.ts` 现在把消息和 API Key 一起塞在 localStorage 里。
对纯陪伴定位这是致命的——**记忆就是产品本身**。

- 引入 `tauri-plugin-sql`，建 `messages` / `memories` / `relationship` 三张表。
- `memories` 表参考 Android 的 `MemoryEntity`：`id / category / content / createdAt / updatedAt`。
- API Key 单独走 Stronghold 或 Windows DPAPI，**不要和业务数据同表**。

验收：关掉应用重开，历史对话和记忆都在；记忆页能看到并删除单条记忆。

## 暂时不要碰的东西

- `tools/live2d-pipeline/` —— M6，产品验证之后再做。素材全部保留，不要删。
- `app/`（Android 工程）—— 只读归档。移植逻辑时读它，但不要再往里写代码。
- 自训声线 —— M5。
- 自制 PSD 拆分与 Cubism 绑定 —— M6，且到时候优先考虑买授权模型。

## 提醒

- Live2D 走「买模型」而不是「造模型」，这个决定越早定越省事。
- M2（主动消息）刻意排在 M3（语音）前面：策略逻辑已经写完，几天就能跑起来，
  情感回报比压低语音延迟更大。
