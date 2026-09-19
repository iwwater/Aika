# 提示词参考与致谢

[返回首页](../README.md) · [English](#english)

**更完善的官方角色提示词和拟人化优化策略仍在开发中。** 本页仅整理公开参考，不发布新的官方 Prompt，不修改当前默认提示词，也不覆盖用户保存的人设。下列方案尚未在 AAAAGENT 的 DeepSeek 对话链路中做效果对比。

## 按自己的需要调整

如果希望桌宠更符合自己的聊天习惯，可以从下列原始资料出发，按“中文日常聊天提示词”“角色卡与示例对话”“语音陪伴提示词”等关键词继续搜索。根据需要调整网页管理页 **记忆与对话 → 角色设定 Prompt** 中的内容。

建议先保留原来的提示词，再选择少量具体习惯或对话范例试聊。日常聊天、情绪回应和安排工作对表达方式的要求不同，别人的角色背景也未必适合自己。注意保留真实记忆与虚构设定的区别，不把示例中的往事当作自己和桌宠的共同经历。

## 原始来源

以下是阅读方向的概括，不是原文复制或效果排名。提示词范例、角色设计方法和完整虚拟主播项目分别标明，用户可按需选择。

| 项目 / 作者 | 类型与可参考内容 | 原始链接 |
| --- | --- | --- |
| **MaiBot／麦麦社区** | 中文聊天配置：将人格、聊天行为和回复风格分开描述，参考日常口语与参与话题的方式。 | [官方配置文档](https://docs.mai-mai.org/manual/configuration/bot-config) |
| **SillyTavern 团队与贡献者** | 角色设计方法：角色描述、开场白及对话范例，帮助表达稳定的口吻。 | [Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/) |
| **Open-LLM-VTuber 团队与贡献者** | 语音与 Live2D 虚拟伙伴项目：可阅读其角色配置与默认人设，了解具体性格如何写入提示词。 | [项目仓库](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) · [默认角色配置](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/config_templates/conf.default.yaml) |
| **Ikaros-521 / AI-Vtuber 及贡献者** | AI 虚拟主播项目：提供模型、语音与虚拟形象互动方向的参考，不是一份单独的“活人感”提示词。 | [AI-Vtuber 原始仓库](https://github.com/Ikaros-521/AI-Vtuber) |
| **Hume** | 语音提示词指南：面向说话而非文章组织回复，并结合实际提供的情绪线索回应。其服务能力不等于本项目能力。 | [Prompt Engineering for EVI](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting) |
| **ChatHaruhi 项目作者与贡献者** | 角色扮演研究与实现：用角色设定和相关对话材料维持角色表现，可研究示例组织方式。 | [项目仓库](https://github.com/LC1332/Chat-Haruhi-Suzumiya) |
| **itshen / Alice_methodology** | 作者的设计经验：讨论人格表达与专业工作反馈如何兼顾，作为思路参考。 | [活人感设计章节](https://github.com/itshen/Alice_methodology/blob/main/chapters/16-alive-agent.md) |

感谢以上作者和社区的公开分享。**AI-Vtuber 与 Open-LLM-VTuber 是两个不同项目，分别列出和署名。** 此处引用不表示原作者参与、背书或与 AAAAGENT 有合作关系，也不表示本项目已采用其代码、提示词或完整能力。

第三方资料、代码和素材保留各自的许可与署名要求；如需复制、修改或再分发，请查看原项目说明。本项目对原创内容的许可不替代第三方条款。

---

## English

[Home](../README.en.md) · [简体中文](#提示词参考与致谢)

**Improved official persona prompts and strategies for more natural conversation are still in development.** This page collects reading references only. It does not introduce a new official prompt, change the current default or overwrite saved personas. These approaches have not been compared for effectiveness in AAAAGENT's DeepSeek dialogue pipeline.

### Customize according to your needs

Explore the original resources below, or search for conversational persona prompts, character cards, example dialogue and voice companion prompting. You can edit your own prompt under **Memory and conversation → Character Prompt** in the web console.

Keep a copy of your previous prompt and try a few concrete speaking habits or example exchanges at a time. Casual conversation, emotional support and work requests need different responses. Another character's fictional history should not become a factual memory about you and your companion.

### Original sources and acknowledgements

These are reading suggestions, not copied prompts or a ranking of effectiveness.

| Project / author | What to explore | Original source |
| --- | --- | --- |
| **MaiBot community** | Chinese chat configuration separating personality, conversational behavior and speaking style. | [Official configuration guide](https://docs.mai-mai.org/manual/configuration/bot-config) |
| **SillyTavern team and contributors** | Character descriptions, greetings and example dialogue for expressing a consistent voice. | [Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/) |
| **Open-LLM-VTuber team and contributors** | Voice interaction with a Live2D companion, including concrete persona configuration examples. | [Repository](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) · [Default configuration](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/config_templates/conf.default.yaml) |
| **Ikaros-521 / AI-Vtuber and contributors** | A virtual streamer project combining models, speech and avatar interaction; broader project reference rather than a single persona prompt. | [AI-Vtuber repository](https://github.com/Ikaros-521/AI-Vtuber) |
| **Hume** | Spoken-response prompting and responding to available emotional cues. Hume's service capabilities are not claims about AAAAGENT. | [Prompt Engineering for EVI](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting) |
| **ChatHaruhi authors and contributors** | Role-playing research and implementation using character instructions and relevant example conversations. | [Repository](https://github.com/LC1332/Chat-Haruhi-Suzumiya) |
| **itshen / Alice_methodology** | The author's design discussion of personality expression alongside professional task responses. | [Design chapter](https://github.com/itshen/Alice_methodology/blob/main/chapters/16-alive-agent.md) |

Thank you to these authors and communities for sharing their work. **AI-Vtuber and Open-LLM-VTuber are separate projects and are credited separately.** Listing them does not imply endorsement, collaboration, or that AAAAGENT has integrated their code, prompts or complete capabilities.

Third-party materials retain their own licenses and attribution requirements. Check the original project before copying, modifying or redistributing its work; AAAAGENT's license for original material does not replace those terms.
