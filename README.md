# 愛花 · Aika

一个面向个人使用的语音对话伙伴，基于 **React、TypeScript 和 Tauri**。当前以 Windows 桌面端为主，支持日语、中文和英语聊天、连续语音、长期记忆及局域网手机访问。

> 项目仍在开发中。普通口语陪练 V1 已有开发计划，尚未实现；情绪修正与人格研究是后续独立支线。

## 当前能力

- **多模型聊天**：OpenAI Responses、OpenAI 兼容、Anthropic、Gemini 协议及自定义接口。
- **实时语音**：流式分句朗读、字幕高亮、回合等待和打断；支持本地 Whisper 或系统语音识别。
- **对话记忆**：本地聊天记录、长期记忆、滚动摘要与可关闭的自动抽取。
- **桌面与手机**：Windows 系统托盘、可选主动消息，手机通过局域网连接运行中的电脑。
- **角色表现**：受控语气标签、可配置表情包；Live2D 和自训练声线尚未完成。

实现不等于所有设备都已验证。具体边界见 [跨平台项目说明](aika-crossplatform/README.md) 与 [实机测试记录](aika-crossplatform/docs/FIELD_TEST_NOTES.md)。

## 快速开始

安装 Node.js 22 LTS（或满足 Vite 7 要求的版本），然后：

```sh
git clone https://github.com/iwwater/Aika.git
cd Aika/aika-crossplatform
npm ci
npm run dev
```

在设置中配置模型供应商、Base URL、模型和自己的 API Key。浏览器开发模式可检查界面与文字聊天，语音能力取决于浏览器及系统支持。

```sh
npm test
npm run build
```

Windows 桌面开发还需要 Rust、Microsoft C++ Build Tools 和 WebView2，详见 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)：

```sh
npm run tauri dev
npm run tauri build
```

本地 Whisper 需要另外启动服务。大型语音模型需要另行下载。

## 从哪里看

| 入口 | 内容 |
| --- | --- |
| [文档导航](docs/README.md) | 产品、开发、研究与旧原型文档 |
| [口语陪练 V1 计划](aika-crossplatform/docs/ORAL_PRACTICE_V1_PLAN.md) | 当前优先方向：普通、自然的口语搭子，仅计划 |
| [下一步](aika-crossplatform/docs/NEXT_STEPS.md) | 当前任务和历史验收记录 |
| [情绪修正研究计划](aika-crossplatform/docs/AFFECT_IMPLEMENTATION_PLAN.md) | 候选论文问题、实验基线与开发顺序 |
| [论文索引](aika-crossplatform/docs/research/affect/README.md) | 12 篇论文的来源、阅读优先级和本地下载方式 |

## 仓库结构

```text
aika-crossplatform/     当前 React / Tauri 主项目
  src/                 界面、领域逻辑和服务
  src-tauri/           桌面能力、存储保险库和手机访问
  tools/               角色、Live2D 和声音工具
  docs/                产品计划、交接与研究资料索引
app/                   早期原生 Android 原型
docs/                  总导航和早期原型文档
gradle/                Android 原型构建工具
```

保留旧原型的目录与构建路径，避免整理文档时破坏原有工程。其构建方法见 [Android 原型说明](docs/ANDROID_PROTOTYPE.md)。

## 数据与使用边界

聊天使用你配置的模型服务；发送消息、摘要和自动记忆抽取可能产生费用。聊天记录保存在本机，不代表模型请求不会发送内容给供应商。Windows 桌面端通过 DPAPI 保存密钥，浏览器开发模式的密钥保存不提供同等保护。

本仓库不包含私人聊天数据库、API Key、语音训练输入、大型角色素材或论文 PDF 原件。论文可从原始发布站点下载；本地下载目录由 Git 忽略。

## 许可

项目当前未指定整体开源许可证。公开可见不代表授予额外使用许可。第三方组件与资料各自遵循原许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
