# 回来之后从这里开始

定位已于 2026-09-02 收窄为纯感情陪伴，完整方案见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 已完成（2026-09-02）

### M0 第 0 步：git ✅

`E:\Work\AI CHAT` 已初始化 git 仓库，首条提交 `chore: 现状快照，定位收窄为纯感情陪伴前`。
`.gitignore` 排除依赖、构建产物、`aika-crossplatform/output/`、声音工坊本地数据和工具产物。

**未完成的一半：`output/` 的 283 MB 素材没有进仓库，也还没有冷备份。**
在做冷备份或改走 Git LFS 之前，那批母稿、抠图和 runtime-presets 仍然只有一份。

### M0 第 1 步：移植 domain 层 ✅

| 从 | 到 |
| --- | --- |
| `domain/CompanionEngine.kt` | `src/domain/companion.ts` |
| `domain/CompanionPromptBuilder.kt` | `src/domain/prompt.ts` |
| `domain/ProactivePolicy.kt` | `src/domain/proactive.ts` |
| `domain/ProactivePolicyTest.kt` | `src/domain/proactive.test.ts` |
| `data/local/MemoryEntity.kt` | `src/domain/memory.ts` |
| （新增，多因子关系） | `src/domain/relationship.ts` |
| （新增，滚动摘要） | `src/domain/summary.ts` |

四处必改都已落地并有测试锁住：教学残留整段移除；关系阶段改为
「相识天数 0.45 + 连续互动天数 0.25 + 消息总数 0.30」，阈值 0.3 / 0.7，
任何单一因子拉满都到不了「亲近」，且**策略上没有衰减**；双语规则写进 system prompt；
反模板句与 `proactiveInput` 的反负罪感一行逐字保留。

### M0 第 2 步：SQLite 与加密保险库 ✅

- `services/storage/sqliteStorage.ts` 走 `tauri-plugin-sql`，四张表：
  `messages` / `memories` / `summaries` / `settings`。
  **关系状态没有单独建表**：它由 `messages.created_at` 现算（`deriveRelationshipSignals`），
  不冗余存储，避免两份数据对不上。
- `services/storage/localStorageStorage.ts` 是浏览器回退，`npm run dev` 在普通浏览器里照样能跑。
- 首次启动会把 0.3 版留在 localStorage 的消息搬进 SQLite；旧记录只有 HH:mm，
  日期无法还原，统一压成「同一天、导入时刻」，关系状态不会凭空虚高。
- **API Key 走 Windows DPAPI**（`src-tauri/src/secret_store.rs`），密文绑定当前 Windows 账户，
  落在 `secrets.json`，不与业务数据同表；迁移成功后会删掉 localStorage 里的明文。
  浏览器开发模式下没有 DPAPI，退回明文并在设置页显示明确警告，不假装安全。

### M1 记忆与关系 ✅

- 每轮对话结束后异步抽取候选记忆（`services/memory/extractor.ts`），
  右侧「长期记忆」卡片可逐条保留或删除。
- **候选记忆立刻参与对话**，但标记为待确认。理由：要求先确认才生效的话，
  用户不打开记忆页就等于没有记忆，拿不到「她记得」这条验收。
- 抽取带去重（`isDuplicateMemory`），否则每轮都会堆出一条「喜欢咖啡」。
- 滚动摘要：近 16 轮保留原文，更早的累积到 40 条就压成一段记录跟着走。
- 自动记忆可在设置页一键关闭——它每轮会多发一次请求，会产生平台调用费用。

### M2 主动性与托盘 ✅

- 触发理由多样化（`chooseProactiveReason`）：未聊完的话题、用户提过的计划、
  时间语义（周五夜 / 深夜 / 周一早上 / 清晨）、记忆库中的日期，兜底是「一个小念头」。
  选理由时会避开上一次用过的角度——连着两条「现在是深夜」比没有主动消息更让人想关掉它。
- **久别只作为触发条件，不作为话题**：理由文本里明确写了「不要提起这段间隔」。
- 频率闸门沿用 Android 阈值：每天最多 6 条、最小间隔 90 分钟、免打扰时段静默，
  且冷却是按**最后一条消息**算的，不会在你刚聊完两分钟后蹦出来。
- 系统托盘常驻（`src-tauri/src/lib.rs`），关窗只收进托盘，真正退出走托盘菜单。
- 本地通知走 `tauri-plugin-notification`；设置页可一键完全关闭主动消息。

### 界面赛博朋克化 ✅

`App.css` 改为青蓝 `#37e6ff` / 紫 `#9a6bff` / 深冷底 `#05070e` 的暗色霓虹主题，
聊天页、实时语音页、设置弹窗统一。左侧占位立绘 `components/AvatarPlaceholder.tsx`
按 `character-brief.json` 的锁定方向绘制，M4 导入正式 Live2D 后整块删除。

## 下一步

### 需要你先拍板的

1. **`output/` 冷备份**，或者改走 Git LFS。二选一，别再拖。
2. **Live2D 模型来源**：买通用成品 / 委托画师按 brief 绑定 / 自制。见 DEVELOPMENT_PLAN M4。
3. 三个技术选型待定项（语音链路、记忆抽取用哪个模型、桌宠窗口形态）。
   记忆抽取那条现在是「用主模型」，接口 `MemoryExtractor` 已经留好，换本地小模型不用改主程序。

### 需要真机验证的

- **M1 验收**：跨重启、跨会话，她能在自然时机提起两周前说过的事，且不炫耀自己记得。
- **M2 验收**：连续七天真实使用，没有出现一条让人想关掉它的消息。
- 这两条都只能靠实际用，代码写完不等于通过。

### 接下来可以直接写的

- **M3 语音回合**：本地 Whisper + Silero VAD 替换 Web Speech。手动切语言的按钮已经删掉，
  但 Web Speech 给不了真正的中日混说识别，这条要靠 Whisper 才算真做完；还要修过早断句；
  回复分句流式合成、播放队列、用户开口打断。这是 FIELD_TEST_NOTES 里两个 P0 的正解。
- M4 桌宠窗口（等模型来源定了再动）。

## 暂时不要碰的东西

- `tools/live2d-pipeline/` —— M6，产品验证之后再做。素材全部保留，不要删。
- `app/`（Android 工程）—— 只读归档。移植逻辑时读它，但不要再往里写代码。
- 自训声线 —— M5。

## 验收命令

```powershell
npm test
npm run build
npm run tauri build
```

## 语言：中日英三种，不分方向（2026-09-03）

- **支持中文、日语、英语**，三种没有主次之分。
- 提示词不再是「默认某语言 + 满足条件才切换」的模式开关。她是一个多语者，
  哪个词先到嘴边用哪个，一句话里混着说也正常。
- 语音页的语言按钮已删除。识别语言由 `domain/language.ts` 按用户最近说的话推导，
  默认日语；朗读音色跟着她说的语言走，三种语言各挑一个女声。
- **这只是折中。** Web Speech 一次只能给一个语言码，一句话里的混说仍然识别不准，
  FIELD_TEST_NOTES 的那条 P0 要等 M3 的本地 Whisper 才算真正关掉。
- 气泡与字幕仍是「原话 + 中文意思」两层：那是显示层，不是她脑子里有几种语言。
