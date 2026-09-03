# 实现状态

## 定位变更（2026-09-02）

产品定位已从「日语陪练 + 陪伴」收窄为**纯感情陪伴**。教学、纠错、复盘、进度统计
全部移出范围；记忆连续性、主动性、存在感成为仅有的三根支柱。

受影响的既有结论：

- FIELD_TEST_NOTES 的 P1「日中对照字幕」保留，但理由从「学习对照」改为「让情感落地」。
- FIELD_TEST_NOTES 的两个 P0（过早断句、手动切语言）不变，仍是语音回合的验收线。
- Live2D 优先级上升（存在感即价值），但自制角色优先级下降（改为购买或授权模型）。
- Android 原型的 domain 层价值上升：CompanionPromptBuilder、ProactivePolicy、
  MemoryEntity 正是新定位需要的部分，桌面版应直译移植。

完整方案见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)，可执行清单见 [NEXT_STEPS.md](NEXT_STEPS.md)。

## 当前基线

- 技术栈：Tauri 2、React 19、TypeScript、Vite、Rust。
- 产品范围已收敛为单用户、单角色、Windows 优先的语音伴侣。
- 角色资料、会话类型、应用存储、语音输入与语音输出已有独立边界。
- 语音输入有两个适配器：本地 Whisper（Silero VAD + whisper.cpp）和 Web Speech 退路；自训练 TTS 可同样替换输出适配器。
- 已建立角色包 v1 规范与声音工坊工具包骨架。
- 原生 Android 原型仍保留在上级工程中，没有删除或覆盖。

## 进度（2026-09-02）

- **git 已初始化**（第 0 步完成）。`output/` 走 ignore，尚未做冷备份，是当前最大的单点风险。
- **Android domain 层已移植**（第 1 步完成）：`domain/` 下新增 companion、prompt、
  proactive、memory、relationship 五个模块与配套测试；教学残留整段移除；
  关系阶段改为多因子且无衰减；code-switch 与反负罪感规则均有测试锁住。
- **结构化双语输出已接通**：`sendChat` 返回 `{japaneseText, chineseTranslation}`，
  聊天气泡与实时语音字幕都是「日语主 + 中文次级」两层，不再靠换行猜。
- **界面已赛博朋克化**：App.css 改为青蓝/紫霓虹暗色主题，配色对齐角色设定。
  左侧占位立绘换成 `components/AvatarPlaceholder.tsx`，按 character-brief 的锁定方向绘制
  （渐变发、圆框眼镜、蓝青瞳、黑白赛博服装、全息扫描层，面部不叠加光点）。
  这是矢量占位，不是美术定稿，M4 导入正式模型后整块删除。
- **SQLite 已替代 localStorage**（M0 第 2 步完成）：`messages` / `memories` / `summaries` / `settings`
  四张表走 `tauri-plugin-sql`；浏览器里退回 localStorage 实现，界面不需要知道自己在哪个上面跑。
  关系状态由 `messages.created_at` 现算，不单独建表。
- **API Key 已迁到 Windows DPAPI**：`src-tauri/src/secret_store.rs`，密文绑定当前 Windows 账户，
  与业务数据分开存放；迁移成功后删除 localStorage 里的明文。M0 至此全部完成。
- **M1 完成**：每轮对话后异步抽取候选记忆（可在设置页关闭），记忆卡片可逐条保留或删除；
  滚动摘要近 16 轮留原文、更早的累积到 40 条压成一段。候选记忆立刻生效但标记待确认。
- **M2 完成**：多样化触发理由（未完话题 / 用户计划 / 时间语义 / 记忆日期 / 小念头），
  避开上次用过的角度；久别只作触发不作话题；系统托盘常驻、关窗收进托盘、本地通知、一键关闭。

- **M3 回合边界完成**（2026-09-03）：M3 拆成「回合怎么走」和「识别用什么引擎」两半，
  先做了前者——换 Whisper 之后这套逻辑一行不用改，而 P0 的抢话今天就能停。
  `domain/turnEnd.ts` 把识别结果攒进缓冲区，尾静音够长且语义像收尾才提交
  （基准 1.35 秒 / 收尾 1.15 秒 / 犹豫 2.4 秒 / 兜底 4 秒），缓冲区对用户可见并可清掉；
  `domain/sentences.ts` 与 `services/voice/speechQueue.ts` 让回复按句播放并**逐句选音色**；
  `services/voice/micActivity.ts` 在播放期间监听用户开口并立刻打断。
  判定全是纯函数，20 轮验收写成了单元测试。

- **M3 流式输出完成**（2026-09-03）：四种协议的 SSE 都接了。难点是回复是结构化 JSON，
  流式时到手的是没闭合的 `{"japanese_text":"おかえ`，所以 `domain/streamingReply.ts`
  是个增量解析器，在 `JSON.parse` 能跑通之前就把正文取出来。中转站不支持流式时安静退回。
- **M3 本地识别链路完成**（2026-09-03）：麦克风 → Silero VAD → whisper.cpp。
  查证结论是这台机器没有 cmake 也没有 CUDA toolkit，所以不把 whisper-rs 编进工程，
  改成浏览器持有麦克风 + whisper.cpp 独立服务（官方预编译包带 cuBLAS，装驱动就能用 GPU）。
  `domain/audio.ts` 的环形缓冲让打断不丢字，`domain/vadSegmenter.ts` 带回滞区防止碎句，
  `whisperClient.ts` 挡掉 whisper 对静音的固定幻听。
  **代码这一侧完成并有测试，缺的是把 whisper-server 跑起来**，步骤见 NEXT_STEPS。
- **逐句字幕高亮完成**（2026-09-03）：`domain/captionHighlight.ts` 把正在念的那一句定位回字幕原文。
  送去合成的句子被 `sentences.ts` 清洗过，所以两边归一化（忽略空白与 Markdown 记号）后再找，
  下标再映射回原文；找不到就不亮，亮错位置比不亮更糟。FIELD_TEST_NOTES 修复顺序第 4 条
  至此只剩 Live2D 口型。
- **表情包机制完成**（2026-09-03）：`domain/stickers.ts` + `public/stickers/manifest.json`。
  她只能从清单里挑，不生成图；OpenAI 协议下 `sticker` 是 enum（带空串表示不发），
  编不出清单外的名字，其余协议由 `resolveSticker` 挡掉。**清单为空时整套机制隐身**，
  提示词与结构化输出都不出现这个字段。落库加了 `messages.sticker` 一列。
  **缺的是素材**：图片丢进 `public/stickers/`，跑 `npm run stickers:scan`，再给每张写一句使用场景。
- **提问规则**（2026-09-03）：`domain/prompt.ts` 新增 `QUESTION_RULES`，
  要求提问挂在具体的东西上、点名禁掉万能问句、先说自己再问对方。反模板句五条逐字保留。

M1、M2 和 M3 的验收都只能靠真实使用：M1 要「跨重启跨会话在自然时机提起两周前的事」，
M2 要「连续七天没有一条让人想关掉它的消息」，M3 要「20 轮不因一次停顿拆成两次请求」
以及回声抑制在真机上够不够。代码写完不等于通过。

可执行清单见 [NEXT_STEPS.md](NEXT_STEPS.md)。M3 的代码全部完成，
下一步是把 whisper-server 跑起来做真机验收，然后是表情包（等素材）和 M4。

## Live2D 最新状态

- 人物视觉方向和第一版三视图已锁定为当前技术母版；它仍需完成专业 PSD 拆分与 Cubism 绑定，不等于最终发布美术。
- 已确认的视觉方向：蓝色/青蓝色头发、正常二次元人物比例、保留眼镜、未来赛博朋克风格中的“全息生命”路线。
- 已确认人物的核心性格是温柔；Live2D 动作应以柔和眼神、自然眨眼、轻微点头和克制流畅的小幅动作表现。
- 参考图中的蓝青渐变大眼、两侧编发与饰结、头顶小型装饰仍只作为候选辨识点，尚未锁定。
- 当前用于原型的人物外观为正常二次元比例、圆框眼镜、青蓝长发到紫色发尾、单侧白色过膝丝袜、黑白赛博服装和克制的全息装饰；核心性格为温柔。
- 当前结构化草稿位于 `tools/live2d-pipeline/character-brief.json`，用户参考图已本地归档，仅作造型语言参考，不得直接复刻。
- GPT 已生成初版全息生命角色三视图，保存在 `output/character-concepts/aika-holographic-turnaround-v1.png`；当前是待评审概念母稿，不等于正式美术定稿。
- v2 修订稿位于 `output/character-concepts/aika-holographic-turnaround-v2-gradient-hair.png`，首次加入了天蓝到冰蓝、淡紫发梢光的渐变。
- 发尾紫色加强后的 v3 版本为 `output/character-concepts/aika-holographic-turnaround-v3-purple-tips.png`，下方约 20% 至 25% 采用清晰可见的冷调薰衣草紫渐变。
- v4 连续性修正版位于 `output/character-concepts/aika-holographic-turnaround-v4-continuity-fix.png`：恢复了背面角色左腿的单侧白色过膝丝袜，但面部白点未完全清除。
- 复查发现 v4 鼻部仍残留白点；v5 位于 `output/character-concepts/aika-holographic-turnaround-v5-clean-face.png`，但后续检查确认仍未完全清除。
- 用户再次发现 v5 正面鼻部仍有白色高光；v6 位于 `output/character-concepts/aika-holographic-turnaround-v6-no-nose-highlight.png`，但已停止作为后续编辑源。
- 用户认为 v2 至 v6 在连续编辑中出现明显品质与身份漂移，已全部停止作为后续编辑源。
- 当前重新以初版 `aika-holographic-turnaround-v1.png` 为唯一母版，生成 `output/character-concepts/aika-holographic-turnaround-v1-rebuild.png`；只加入紫色发尾、面部白点清理和背面单侧丝袜修正。后续不得从 v2 至 v6 继续迭代。
- 已从 v1-rebuild 固定裁出 512×1024 正面母稿：`output/live2d/source/aika-front-master-v1.png`。
- 已恢复官方 ComfyUI core 到 `D:\Tools\ComfyUI\resources\ComfyUI`，工作区继续使用 `D:\Tools\ComfyUIWorkfiles`；RTX 5060 8 GB 已实际执行 SeedVR2 与 RemBgUltra。
- 已生成并安装四个 Aika 专用 ComfyUI 工作流到 `D:\Tools\ComfyUIWorkfiles\user\default\workflows\Aika_Live2D`：正面母稿 4K 放大、Qwen 2509 表情/口型参考、RemBgUltra 整人抠图、单素材 4K 放大。
- SeedVR 工作流已改为当前 `SeedVR2LoadDiTModel` / `SeedVR2LoadVAEModel` / `SeedVR2VideoUpscaler` 节点；RemBg 工作流增加 `InvertMask` alpha 分支，人物遮罩保持“人物白、背景黑”。
- SeedVR2 3B FP8 已生成 2048×4096 母稿。其鼻部和嘴下新增白色高光已通过 ComfyUI 固定坐标、无生成式局部回填清除；正式文件为 `output/live2d/source/aika-front-master-4k.png`，原始白点版保存在 `output/live2d/rejected/source-tests/`。
- 已从清理后的母稿重新生成透明底 `output/live2d/layers/00-character-cutout-rgba.png` 与前景遮罩 `00-character-mask.png`；四角 alpha 为 0，人物中心为 255。
- 自动分割中可用的头发、脸部皮肤、眼镜和少量眼睛区域已整理到 `output/live2d/layers/guides/face-selected/`。CLIPSeg 头发结果包含衣袖误选；眉毛和嘴线检测为空，因此全部只作为辅助 guide，不声称是可绑定图层。
- 两次 Qwen 整脸微笑测试都造成身份漂移或面部亮点复发，已放入 `output/live2d/rejected/expression-tests/`。正式表情路线改为同一套原始五官图层加 Cubism 参数形变。
- 已生成七个表情模板和四个动作模板到 `output/live2d/runtime-presets/`；说话动作不写 `ParamMouthOpenY`，避免和实时 TTS 口型冲突。
- `Sync-AikaUpscaledMaster.ps1` 默认只保存候选，显式 `-Approve` 才能覆盖正式母稿；`Invoke-AikaFaceCleanup.ps1` 可复现白点清理；`Test-AikaComfySetup.ps1` 已通过服务、节点、安装哈希和 4K 输出检查。
- 已安装 `jtydhr88/ComfyUI-See-through`（commit `98d754bf04f668647919ab750eccb0e0640faa81`）及 bitsandbytes 0.50.2；七个 SeeThrough 节点均已加载。官方示例位于 ComfyUI 的 `SeeThrough/`，Aika 专用 8GB/NF4 工作流为 `Aika_Live2D/Aika_05_SeeThrough_Decompose_8GB.json`。
- Live2D 表情和动作分工已明确：ComfyUI 生成高分母稿、抠图和表情/口型参考；PSD 分层与遮挡补画需要人工验收；动作由 Cubism 参数、关键帧与物理演算制作。
- 未经确认生成的概念图已移出正式文档，保留在 `output/drafts/`，不会接入应用。
- 已完成本机 ComfyUI 资源审计和 ComfyUI → PSD → Cubism 工作流设计。
- 下一步不再生成整脸表情图，而是用批准的 4K 母稿建立 `material-separation.psd`：手工拆分并补画眼睛、眉毛、嘴腔、前后发、眼镜、身体与衣装遮挡区域；之后导入 Cubism 绑定现有表情/动作参数模板。

## 语言：中日英三种，不分方向（2026-09-03）

- 提示词不再写「默认某语言，满足条件才切换」。她是一个多语者，不是几个模式。
- **支持中文、日语、英语**，三种没有主次之分（2026-09-03 从中日两种扩到三种）。
- 语音页的语言按钮已删除。识别语言跟着用户最近说的话走
  （`domain/language.ts`，起点是 Android `LanguageDetector`），默认日语。
- 朗读音色跟着她说的语言走，三种语言各挑一个女声，换语言不会换成另一个人。
- 本地识别链路已接通（2026-09-03），送给 Whisper 的 language 固定是 auto。
  但 **Whisper 的语言检测是整段的**，一句话里中英混说时多半会统一按主语言转写——
  比 Web Speech「一次只能给一个语言码」强得多，但不是完美的混说识别。
- 没起 whisper-server 时退回 Web Speech，并且会在语音页上写明，不悄悄降级。
- 气泡与字幕仍是「原话 + 中文意思」两层——那是显示层，不是她脑子里有几种语言。

## 最新实机反馈

- P0（已实现修复，待真机验收）：Web Speech 会在用户句中停顿时过早提交，造成抢话和发言被截断。
- P0（本地识别已接通，待接服务端验收）：不应要求用户手动选择语言。
- P1：愛花的回复必须同时显示日语原文和中文翻译——已完成，日语用于朗读，中文让情感落地（不是学习对照）。

详细现象、目标行为和验收标准见 [FIELD_TEST_NOTES.md](FIELD_TEST_NOTES.md)。

## API 数据流

`App.tsx` 只编排页面状态。角色资料位于 `domain/character.ts`，统一会话位于 `domain/conversation.ts`，持久化位于 `services/storage/`，语音引擎契约和当前适配器位于 `services/voice/`。`services/providerClient.ts` 负责把统一聊天记录转换为四种模型协议。

## 建议顺序

已按纯感情陪伴定位重排，与 DEVELOPMENT_PLAN 的里程碑一致：

1. git 初始化，output/ 排除或走 LFS。
2. 移植 Android domain 层（人设、关系阶段、主动策略、结构化双语输出），删除教学残留。
3. SQLite 替代 localStorage；记忆自动抽取、滚动会话摘要、多因子关系状态。
4. 主动消息与系统托盘：多样化触发理由，可一键关闭。
5. 本地 Whisper + VAD 替换 Web Speech，修复过早断句与手动切语言。
6. 分句流式合成、播放队列与用户开口打断。
7. 导入合法授权的 Live2D 模型，做透明置顶桌宠窗口。
8. 用 Stronghold 或 Windows DPAPI 加密 API Key。
9. 声音工坊自训声线，替换 TTS 适配器。

自制角色的 PSD 拆分与 Cubism 绑定推迟到产品验证之后（M6），素材全部保留。

完整里程碑见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 验收命令

```powershell
npm test
npm run build
npm run tauri build
```
