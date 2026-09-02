# Aika

Aika 是一个仅供个人侧载使用的 Android 日语陪伴应用。当前版本包含本地聊天、双语气泡、长期记忆、多供应商 API 切换、加密 API Key 设置、主动消息调度和 Live2D/实时语音接口骨架。

## 本地构建

要求：

- JDK 17 或更高版本
- Android SDK Platform 37
- Android SDK Build Tools 36.0.0

构建 Debug APK：

```powershell
.\gradlew.bat :app:assembleDebug
```

运行单元测试：

```powershell
.\gradlew.bat :app:testDebugUnitTest
```

生成的 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## 当前限制

- 已支持 OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic Messages 和 Gemini generateContent。预设包括 OpenAI、千问、Claude、Gemini，也可填写自定义 Base URL 与模型名。
- 每个已保存密钥的供应商都提供“测试”按钮，会实际发起一次极短请求并显示连接成功或 HTTP 错误。
- 未填写当前供应商的 Key 时使用明确标记的本地演示回复；已配置供应商发生网络或鉴权错误时会在聊天页显示错误，不再静默伪装成在线回复。
- Live2D 目前显示占位区域，等待用户提供模型文件后接入 Cubism SDK。
- 麦克风按钮目前仅保留交互入口，Realtime WebRTC 将在下一里程碑实现。
