# 早期 Android 原型

根目录 `app/` 是早期原生 Android 日语陪伴应用，主要开发入口已转到 [跨平台工程](../aika-crossplatform/README.md)。此处保留原构建方式。

## 构建

要求 JDK 17 或更高版本、Android SDK Platform 37、Android SDK Build Tools 36.0.0。

在仓库根目录运行：

```powershell
.\gradlew.bat :app:assembleDebug
.\gradlew.bat :app:testDebugUnitTest
```

APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## 原型状态

包含本地聊天、双语气泡、长期记忆、多供应商 API 切换、加密密钥设置与主动消息调度。支持 OpenAI Responses、兼容 Chat Completions、Anthropic Messages 和 Gemini generateContent。

原型中的 Live2D 为占位，麦克风保留接口入口；这不代表当前跨平台工程的语音状态。早期设计见 [架构](ARCHITECTURE.md) 和 [实现状态](IMPLEMENTATION_STATUS.md)。
