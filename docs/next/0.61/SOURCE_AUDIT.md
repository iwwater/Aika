# 0.61 源码核对与修复定位

日期：2026-09-20；审阅基线：`5f838c2f29d8d0b60c4c3a8b78a025ee55b6dac5`。
仅静态源码核对，未复现用户设备问题、未运行生产测试。开始时已有用户修改 `docs/next/TODO.md`，保留其内容；本文件区分已证实现状和待测推断。

目录：[修正](#1-todo-描述修正) · [定位](#2-修复入口) · [设计风险](#3-尚需执行验证) · [依据](#4-相关依据)

## 1. TODO 描述修正

| 原描述 | 当前核对结果 |
| --- | --- |
| 启动固定 15 秒 | BackendConnection 默认 60000ms；仍是 ready 绝对倒计时，没有进度续期 |
| 无 AudioWorklet chunk 能力 | recorder-worklet 已按 2048 sample flush；缺的是消费 chunk 的 ASR/bridge/会话链路 |
| 所有 DB 写入都令前台 context 失效 | assertContextCurrent 区分 foreground；检查来源、prompt、policy 和 pending holds，不能简单删校验 |
| Aika 配置存储/适配器通过就等于桌面已接入 | trial-backend 仍实例化旧 Provider；生产挂接和输入装配需要集成测试证明 |
| 模型列表可达就可以绿灯 | 只能证明对应 API 可访问，不证明模型权限、语音能力、推理成功 |
| 冻结前缀保证 100% 缓存命中 | 只能保证本地请求稳定，供应商缓存策略/过期/路由不由客户端保证 |

## 2. 修复入口

下列路径相对 `windows/code/desktop-pet/`；使用符号定位，行号随 0.6 开发变化不作修改锚点。

| 范围 | 已查看代码与符号 | 修复方式 |
| --- | --- | --- |
| 配置 | management/settings.ts validateManagedSettings/effectiveTrialConfiguration；app/trial-config.ts validateTrialConfiguration | 解耦型号/价格 catalog 与协议能力，七槽统一配置迁移 |
| 生产模型 | app/trial-backend.ts StrictTrialMemoryProvider 与各 Provider 构造；providers/text-protocol.ts textJsonProtocol；providers/qwen-asr.ts QwenAsrProvider | 组合根按 slot 实例化，严格记忆解析不变，去掉下层残留型号锁 |
| 预算 | app/trial-authorizer.ts TrialAuthorizer.authorize；providers/transport.ts CallAuthorizer | unlimited 独立于额度台账，保留非计费授权/取消/配置校验 |
| Aika API | management/aika-profile.ts AikaProfileStore；management/aika-routes.ts aikaManagement/aikaRoute；management/server.ts | 补 GET providers、await route 和 runtime 挂接，端到端验证 |
| 配置 UI | management/ui/aika-view.mjs refresh/boot | JSON 输入改表单、发现与槽位选择 |
| 启动 | desktop/electron/transport.mjs BackendConnection；app/trial-launcher.ts verifyTrialRuntime；app/backend-session.ts ready 消息 | 进度事件/停滞监视/串行关闭与重试 |
| 点击 | desktop/main.mjs character.onpointerup；desktop/electron/main.mjs shell IPC | 按钮分流、独立功能面板，保留拖动 |
| 模型 | desktop/cubism-renderer.mjs load/loadRig 与静态 preset/map；tools/configure-model.mjs；desktop/electron/assets.mjs | 注册模型包，实例配置加载和安全资源映射 |
| 麦克风 | media/browser-capture.ts BrowserCaptureDriver；desktop/electron/main.mjs mediaAllowed | deviceId 接入、离线试麦租约、真实设备能力 |
| chunk | media/recorder-worklet.mjs flush；media/capture.ts TurnCapture；providers/qwen-asr.ts | 复用 chunk，新增有界桥接和流式识别 |
| 本地 ASR | package.json；已安装 sherpa-onnx-node/streaming-asr.js OnlineRecognizer/OnlineStream | 利用在线接口，真实模型验证另列门槛 |
| Context | memory/sqlite-port.ts createContext；memory/sqlite-lifecycle-port.ts foregroundContext；memory/sqlite-lifecycle-state.ts trackContext/assertContextCurrent；core/dialogue-pipeline.ts run | 加知识库与冻结快照适配，撤销与来源校验贯穿 |
| 测试入口 | tools/run-tests.mjs | npm test 只覆盖 memory/providers，不等于全工程回归 |

## 3. 尚需执行验证

启动慢是否由 hash 引发、当前机器为何语音不可用、模型切换 GPU 资源清理、在线 ASR 中文准确率/延迟均未实测。SPEC 要求复现/基线，不把 TODO 中的推断写成已定位唯一根因。

0.61 工作量主要在 FIX61-01 的全槽生产适配、FIX61-06 的知识作用域、FIX61-08 的实时音频链、FIX61-09 的隐私一致性。仅修改 UI、延长 timeout 或移除 validation 无法满足版本交付。

## 4. 相关依据

模型发现以 [OpenAI Models API](https://platform.openai.com/docs/api-reference/models) 和 [Gemini models.list](https://ai.google.dev/api/models) 为协议参考（2026-09-20 查阅）；第三方 compatible 端点可能不支持列表，手填必须保留。

流式接口以本项目已安装的 sherpa-onnx-node 1.13.8 源码为当前依据；项目示例入口见 [官方 Node addon examples](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md)。本次未下载/安装新模型，未声称原 Whisper CLI 可真流式。

[版本 RPD](RPD.md) · [执行索引](SPEC.md) · [0.6 测试规则](../0.6/TESTING.md)。
