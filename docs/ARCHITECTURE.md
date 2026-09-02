# Aika 技术架构

## 原则

- 首版是单用户、无服务器、侧载 APK。
- 聊天、记忆和设置全部保存在设备本地。
- API Key 由用户填写，使用 Android Keystore 加密；密钥不进入源码、构建配置或日志。
- AI、实时语音和 Live2D 都通过接口隔离，后续可以替换实现而不改 UI。
- 模型接入采用类似 CC Switch 的本地供应商配置：协议、Base URL、模型与加密密钥分离，并可一键切换活动配置。

## 模块边界

- `ui`：Compose 页面与 ViewModel，只消费仓库和领域接口。
- `data`：Room、DataStore、Keystore 以及聊天和记忆仓库。
- `domain`：陪伴提示上下文、多协议请求编解码、主动消息策略、语言识别、Realtime 与 Live2D 契约。
- `work`：使用 WorkManager 在本地生成主动消息。

## 数据流

1. 用户输入中文或日语。
2. `ChatRepository` 先保存用户消息，再组合带角色的最近对话、长期记忆、关系阶段与日本当前时间。
3. `MultiProviderCompanionEngine` 读取活动供应商和对应密钥，按配置选择 Responses、OpenAI Chat、Anthropic 或 Gemini 协议。
4. 回复以日语正文和中文翻译分别保存，UI 默认显示日语并按需展开中文。
5. 主动消息 Worker 使用同一个上下文和引擎，成功生成后写入 Room 并弹本地通知。

## 供应商配置

- DataStore：保存非敏感的供应商名称、协议、Base URL、模型和活动项。
- Android Keystore：每个供应商使用独立的加密密钥槽，编辑配置时留空不会覆盖旧密钥。
- 内置协议：OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic Messages、Gemini generateContent。
- 请求失败：已配置的在线供应商会明确报错；仅在没有活动密钥时进入本地演示模式。

## 安全边界

纯本地版无法像服务端一样完全隐藏第三方 API Key。实现通过 Keystore 降低普通备份和静态提取风险，但不声称能抵抗 Root、调试注入或运行时内存提取。因此 APK 只能个人使用，模型项目必须配置用量上限。
