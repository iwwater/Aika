# 回来之后从这里开始

定位已于 2026-09-02 收窄为纯感情陪伴，完整方案见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 已完成（2026-09-02）

### 第 0 步：git ✅

`E:\Work\AI CHAT` 已初始化 git 仓库，首条提交 `chore: 现状快照，定位收窄为纯感情陪伴前`。

`.gitignore` 排除 `node_modules/`、`dist/`、`target/`、`.gradle/`、`.kotlin/`、
`local.properties`、`aika-crossplatform/output/`、声音工坊的 workspace/input/export、
`.playwright-cli/` 与 `.playwright-mcp/`。

**未完成的一半：`output/` 的 283 MB 素材没有进仓库，也还没有冷备份。**
在做冷备份或改走 Git LFS 之前，那批母稿、抠图和 runtime-presets 仍然只有一份。

### 第 1 步：移植 domain 层 ✅

| 从 | 到 |
| --- | --- |
| `domain/CompanionEngine.kt` | `src/domain/companion.ts` |
| `domain/CompanionPromptBuilder.kt` | `src/domain/prompt.ts` |
| `domain/ProactivePolicy.kt` | `src/domain/proactive.ts` |
| `domain/ProactivePolicyTest.kt` | `src/domain/proactive.test.ts` |
| `data/local/MemoryEntity.kt` | `src/domain/memory.ts` |
| （新增，多因子关系） | `src/domain/relationship.ts` + `relationship.test.ts` |

四处必改都已落地：

1. 教学残留整段移除，`prompt.test.ts` 断言提示词里不出现 JLPT、纠错、接触日语。
2. 关系阶段改为多因子：相识天数 0.45 + 连续互动天数 0.25 + 消息总数 0.30，
   阈值 0.3 / 0.7。任何单一因子拉满都到不了「亲近」，一天狂聊一百条仍是「刚开始熟悉」。
   **策略上没有衰减**：久不聊天不降级，也不产生任何「好久不见」类信号。
3. code-switch 规则已写进 system prompt。
4. 反模板句与 `proactiveInput` 的反负罪感一行逐字保留，有测试锁住。

关联改动：

- `sendChat` 返回 `{japaneseText, chineseTranslation}`；OpenAI Responses 走 json_schema、
  Gemini 走 responseMimeType，其余协议靠提示词约定。
  `parseCompanionReply` 容错：模型不按格式返回时整段当日语正文，不丢这一轮。
- `ChatMessage` 增加 `createdAt`（关系状态按日历天统计，必须持久化）、
  `japaneseText`、`chineseTranslation`。旧记录只有 HH:mm，迁移时压成同一天。
- 聊天气泡与语音字幕改为「日语主 + 中文次级」两层，不再靠换行猜。
- 右侧「相处记忆」占位改为真实的相处状态（相识天数 / 连续互动 / 消息数）。
- `src/domain/persona.ts` 已删除，人设并入 `character.ts` 的 `AIKA_PERSONA_PROMPT`。

### 界面赛博朋克化 ✅

按用户要求，`App.css` 从粉白暖调改为赛博朋克暗色霓虹，配色对齐角色设定
（青蓝主色 `#37e6ff`、紫色次色 `#9a6bff`、深冷底 `#05070e`）。
聊天页、实时语音页、设置弹窗三处统一；标题字体改为 Orbitron / Rajdhani；
全局加了低对比扫描线，并给 `prefers-reduced-motion` 关掉了动画。
左侧头像仍是 CSS 占位立绘，M4 接入 Live2D 后整块替换。

## 第 2 步：SQLite 替代 localStorage（约一天）← 下一步

`services/storage/appStorage.ts` 现在把消息和 API Key 一起塞在 localStorage 里。
对纯陪伴定位这是致命的——**记忆就是产品本身**。

- 引入 `tauri-plugin-sql`，建 `messages` / `memories` / `relationship` 三张表。
- `memories` 表结构已经在 `src/domain/memory.ts` 里定义好：
  `id / category / content / createdAt / updatedAt`，直接照着建表。
- `messages` 表要保留 `createdAt`、`japaneseText`、`chineseTranslation`，
  关系状态由 `deriveRelationshipSignals` 从 `createdAt` 现算，不另存冗余字段。
- API Key 单独走 Stronghold 或 Windows DPAPI，**不要和业务数据同表**。

验收：关掉应用重开，历史对话和记忆都在；记忆页能看到并删除单条记忆。

## 之后

3. 每轮对话后异步抽取候选记忆，用户在记忆页确认或删除；滚动会话摘要。
4. M2 主动消息与系统托盘：`proactive.ts` 的频率闸门已经就位，
   还缺多样化触发理由（未完话题、用户计划、时间语义、记忆日期）和托盘常驻。
5. M3 本地 Whisper + VAD 替换 Web Speech，修复过早断句与手动切语言。

## 暂时不要碰的东西

- `tools/live2d-pipeline/` —— M6，产品验证之后再做。素材全部保留，不要删。
- `app/`（Android 工程）—— 只读归档。移植逻辑时读它，但不要再往里写代码。
- 自训声线 —— M5。
- 自制 PSD 拆分与 Cubism 绑定 —— M6，且到时候优先考虑买授权模型。

## 提醒

- `output/` 还没有第二份。做冷备份或 LFS，二选一，别再拖。
- Live2D 走「买模型」而不是「造模型」，这个决定越早定越省事。
- M2（主动消息）刻意排在 M3（语音）前面：策略逻辑已经写完，几天就能跑起来，
  情感回报比压低语音延迟更大。
