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
- 当前 Web Speech 只是临时输入/输出适配器；本地 Whisper 和自训练 TTS 可直接替换适配器。
- 已建立角色包 v1 规范与声音工坊工具包骨架。
- 实时语音页已显示用户和愛花的连续字幕，但当前仍是单语字幕。
- 原生 Android 原型仍保留在上级工程中，没有删除或覆盖。

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

## 最新实机反馈

- P0：Web Speech 会在用户句中停顿时过早提交，造成抢话和发言被截断。
- P0：不应要求用户手动选择日语或中文；默认应自动理解日语、中文和中日混说。
- P1：愛花的回复必须同时显示日语原文和中文翻译，日语用于朗读，中文用于学习对照。

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
