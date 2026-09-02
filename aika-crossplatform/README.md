# 愛花 Aika

面向个人使用的语音优先对话伙伴。她说日语、中文和英语，用哪种取决于当下，不取决于设置项。当前以 Windows 桌面版为主，重点是一个固定角色的自然、低延迟、可打断交流；同一工程后续可生成 Android APK。

## 已有功能

- 日语、中文、英语的自然聊天：三种没有主次之分，不需要切换语言
- OpenAI Responses、OpenAI 兼容、Anthropic Messages、Google Gemini 四种协议
- OpenAI、通义千问、DeepSeek、Claude、Gemini 和自定义接口预设
- API 配置保存、连接测试和完整错误提示
- 连续语音模式：自动听写、停顿发送、日语朗读、自动继续聆听和语音打断
- 语音识别语言跟着你最近说的话自动走，没有手动切换按钮；朗读音色跟着她说的语言走
- 本地 SQLite 保存聊天记录、长期记忆与滚动会话摘要，无需自建服务器
- 长期记忆自动抽取，逐条可见、可保留、可删除
- 主动消息与系统托盘：她会在想起你时先开口，频率受限且可一键关闭
- 可替换的语音输入/输出接口，为本地 Whisper 和自训练声线预留稳定边界
- 角色包清单与声音工坊骨架，为个性化 Live2D、人格和语音预留位置

## 本地开发

```powershell
npm install
npm run dev
npm test
npm run tauri build
```

Windows 安装包生成在 `src-tauri/target/release/bundle/`。

## 架构与个性化

- [开发方案](docs/DEVELOPMENT_PLAN.md)：产品边界、架构和里程碑。
- [角色包规范](docs/CHARACTER_PACK.md)：人格、Live2D 与声线资源的组合格式。
- [角色视觉方向](tools/live2d-pipeline/character-brief.json)：未来赛博朋克 / 全息生命，界面与 Live2D 统一走这一套。
- [声音工坊方案](docs/VOICE_WORKSHOP.md)：自主训练声线的安全、易用工作流。
- [声音工坊工具包](tools/voice-workshop/README.md)：环境检查、数据目录和配置模板。
- [实机测试记录](docs/FIELD_TEST_NOTES.md)：当前问题、目标行为和修复优先级。

## 当前限制

- 当前语音识别使用 Windows Web Speech；日语识别可能经过微软在线服务。本地 Whisper 和 Live2D 尚未接入。
- 聊天与语音字幕是「原话 + 中文意思」两层结构；关系状态按「相识天数 + 连续互动天数 + 消息总数」多因子计算，且没有衰减。
- Web Speech 一次只能给一个语言码，**一句话里中日英混说仍然识别不准**；真正的自动识别要等本地 Whisper。
- 聊天记录、长期记忆和滚动摘要存在本机 SQLite；API Key 单独走 Windows DPAPI 加密保险库，两者不同表。
- 主动消息默认关闭，开启后每天最多 6 条、最小间隔 90 分钟、免打扰时段静默，可随时一键关掉。
- 自动记忆抽取每轮会额外发一次请求，会产生平台调用费用，可在设置页关闭。
- 使用模型平台 API 可能产生平台自身的调用费用，但应用不需要额外服务器。

实现状态和下一步见 [docs/HANDOFF.md](docs/HANDOFF.md)。
