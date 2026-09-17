# 安装与配置 / Setup

[项目首页](../README.md) · [English](#english)

## 先知道这个包能直接做什么

这是源码交付，不是已经配置好账号和模型的安装器。

- **可以独立做：** 安装代码依赖、编译后端、运行不调用云模型的测试、检查缺少的本地资源。
- **需要自行配置：** 原生桌宠、完整管理页面、真实语音和模型调用、微信登录、Harness / Codex 转交。
- **没有附带：** Cubism SDK、可运行的 Live2D 模型、唤醒权重、供应商账号、注册音色、私人数据库或运行配置。

管理网页连接真实后端，不是可以单独双击打开的静态演示页。

## 1. 编译与检查

需要 Node.js **20.19 或更新版本**、npm；原生桌面目标为 macOS，需具备 Swift 编译环境和 Xcode Command Line Tools。发布检查脚本使用 Python 3。平台相关原生依赖的安装仍受 Node 版本和本机工具链影响。

从仓库根目录运行：

```sh
cd code/desktop-pet
npm ci
npm run build
npm run test:release
npm run doctor
```

`build` 编译后端和微信相关 bundle；不要求你已经下载 Cubism SDK。本次 `test:release` **115 项全部通过**。该验证组覆盖上下文连续性、记忆动态、独立 ASR、MiniMax、音色登记和微信对话等发布验证组，不代表真实麦克风、摄像头、手机显示或云服务体验验证。

较广的 `npm test` 仍保留在包中。本次打包验证为 **524 项中 520 项通过、4 项失败**；这 4 项在未脱敏源码的对照检查中也能复现，没有在发布包中偷偷删除或改成跳过：

| 已知失败 | 范围 |
| --- | --- |
| `manual assistant becomes labelled human evidence…` | 人工助手记录与来源保留的旧断言 |
| `real audio/image bytes and their IDs reach the perception boundary…` | 旧组合 Omni 适配器断言 |
| `single-modality Omni model and non-enum emotion…` | 旧组合 Omni 模型校验断言 |
| `Qwen summary keeps numeric wire…` | 旧 Qwen 摘要格式断言 |

这些是已知待处理项，不能据此声称整个测试库全通过。打包没有修复这些与脱敏无关的历史测试。

`doctor` 只检查本地文件。裸源码包中 SDK、模型、渲染产物和原生应用缺失是预期状态；它不会读取 API Key、启动服务或申请设备权限。

## 2. 准备 Live2D 与桌面资源

按 [Live2D 接入说明](LIVE2D.md) 准备你有权使用的模型。公开包不附任何现用角色的模型资源。

| 位置（相对 `code/desktop-pet/`） | 内容 |
| --- | --- |
| `desktop/vendor/cubism/Core/` | 自行从官方 SDK 获得的 Core 及相应类型声明 |
| `desktop/vendor/cubism/Framework/` | 与 Core 匹配的 Framework 源码及 shaders |
| `desktop/assets/local-model/pet.model3.json` | 你自己的模型入口文件 |
| `desktop/assets/local-model/` | 入口引用的网格、纹理、物理、表情和动作 |
| `desktop/assets/local-model/presets.json` | 这个模型自己的表现目录和资源指纹 |
| `desktop/config/parameter-map.json` | 头部与嘴型等参数映射，按模型核对 |

`config/presets.example.json` 只说明数据结构，不能直接充当已经适配完成的目录。模型 ID、指纹、参数和表情引用必须与实际模型一致。模型文件齐全后，可运行 `node tools/configure-model.mjs` 创建绑定真实资源指纹的禁用预设目录；工具不会覆盖已有目录。随后自行编辑参数映射、动作与表情，再逐项验证和启用。

资源就绪后，从 `code/desktop-pet/` 构建：

```sh
npm run build:desktop
npm run build:native
npm run doctor
```

此次干净副本的 Mac 原生编译与签名检查已通过，但没有启动桌宠；未配置真实 SDK、模型、音色和凭据，尚未完成从首次配置到完整运行的验收。

本地唤醒是额外可选能力，需要匹配的关键词检测权重。权重不在本包中，未准备时不要把唤醒开关当作可用状态。

## 3. 配置自己的服务

以 [`providers.example.json`](../code/desktop-pet/config/providers.example.json) 为结构参考，在仓库外创建你的 `config.local.json`。不要把真实凭据写进示例、README 或源码。

供应商凭据保存在**仓库外的独立文件**，通过 `credentialFile` 的绝对路径引用；仅允许文件所有者读写，例如对自己创建的密钥文件设置 `chmod 600`。不要在终端命令、公开截图或 shell 历史中粘贴密钥。

| 配置 | 说明 |
| --- | --- |
| 对话、识别与摘要 | 使用样例支持的文字模型与端点；模型名仍需与你的供应商账号一致 |
| 语音转写 | 使用独立 ASR 配置，不把图像理解模型作为默认转写入口 |
| 图像感知 | 配置视觉服务；只启用你确实需要的摄像头能力 |
| TTS | 使用 MiniMax Turbo 路径并提供自己有权使用的音色；不要复制别人的克隆 ID |
| 音色注册 | 按当前适配器提供真实的音色登记信息；占位 ID 或杜撰成功回执不代表音色可用 |
| 费用设置 | 样例中的单价与预约值是代码计账参数，不保证等于供应商当前账单；余额与本地估算不是同一数据 |

如果你的服务、音色或模型尚未开通，应先完成这些外部配置。配置检查失败时处理明确缺项，不要绕过校验来假装已经准备好。

MiniMax 样例走 **DashScope 的 `MiniMax/speech-2.8-turbo`** 适配路径，不是 MiniMax 直连 API 的等价配置。需要在对应服务中准备音色，并在外部配置填写 `voiceId` 和 `voiceRegistryFile`。后者是本项目格式的音色登记元数据，结构见 [`providers/registered-voices.ts`](../code/desktop-pet/providers/registered-voices.ts)：保存真实音色 ID、标签、服务端点、目标模型、凭据引用、参考音频 SHA-256 和时间，外层为 `version`、`revision`、`voices`。它不包含 API Key，也不等同于供应商注册成功证明。

登记结构样例见 [`voice-registry.example.json`](../code/desktop-pet/config/voice-registry.example.json)，其中占位值必须替换为已有成功注册的真实资料。可运行 `node tools/voice-reference.mjs /absolute/external/dashscope.key` 计算路径引用；该工具不读取密钥内容。

`credentialRef` 与真实密钥文件的绝对路径绑定，规则为 `dashscope-` 加该路径 SHA-256 的前 12 位。迁移电脑或变更密钥路径后，要依据自己的真实注册资料核对这项绑定。此发布包不附自动克隆工具，不会为你创建供应商音色，也不生成冒充成功的记录。

## 4. 首次配置与启动

完成编译、模型适配、凭据和音色准备后，从 `code/desktop-pet/` 运行：

```sh
node tools/configure-local.mjs /absolute/path/to/config.local.json --activate
node dist/app/trial-launcher.js
```

第一条命令建立新的本地配置，检查所需资源；它本身不调用云模型、不访问设备。`--activate` 表示你明确启用这份服务配置，之后启动应用并进行输入可能产生供应商费用。

如果首配时没有加 `--activate`，配置会保留为准备状态。之后运行 `node tools/configure-local.mjs --activate-existing`，可在重新核对资源指纹和凭据文件权限后启用它；该命令不会自动启动应用。

工具不会覆盖已有本地状态。再次配置时先阅读其提示，不要删除个人数据库来绕过配置冲突。运行数据在仓库根目录 `.local/` 下生成，包括后续的聊天、记忆、任务回执和连接状态。这个目录已经被忽略，仍应在发布前再次检查。

原生桌面、管理页面和服务连接需要一起完成真实运行验证；源码编译通过不等于它们已经在你的设备上工作。这里没有附赠已登录的微信 Bot、可直接使用的个人音色或远程服务器。

## 5. 微信与工作 Agent

使用自己的账号和服务完成管理页面中的连接配置。Harness 和 Codex 是独立安装/运行的程序，本项目是它们的连接入口，不包含它们的安装包、账号或订阅。

任务发送前核对完整卡片；支持语音确认不意味着任何一段模糊的录音都应视为授权。微信语音回复使用音频文件；不要把接口接受了原生语音消息等同于手机一定能显示语音条。

## 6. 提交 GitHub 前

从仓库根目录检查：

```sh
python3 tools/check-release.py
```

这个检查针对**干净发布目录**。如果已经在目录中装过依赖或启动过程序，应重新整理发布副本，不要上传 `node_modules`、构建产物、`.local`、个人模型、SDK、私有配置或数据库。检查包含结构和常见敏感模式，不代替素材权利核查，也不能证明任意未知形式的秘密都不存在。

本包不带旧仓库 `.git` 历史。请以此目录创建新仓库或首次提交，避免把原工程历史中的私人内容带上去。代码许可证与[角色素材授权范围](../assets/original-design/README.md) 分别处理。

<a id="english"></a>

## English

### What works without accounts

This source package supports dependency installation, backend compilation, the included offline test groups and local resource checks. A full desktop setup still needs your own licensed Cubism SDK/model, provider access, authorized voice configuration and optional wake weights. The management website belongs to the actual backend; it is not a standalone static demo.

Requirements: Node.js 20.19+, npm, and a compatible local toolchain. The native desktop target requires macOS and Swift/Xcode Command Line Tools. Python 3 is used for the release audit.

```sh
cd code/desktop-pet
npm ci
npm run build
npm run test:release
npm run doctor
```

The backend build does not require Cubism. `doctor` checks local files only; absent SDK/model/native files are expected in a clean source distribution. None of these steps authenticates WeChat or validates real devices or paid providers.

The broader `npm test` is retained: the packaging run reported **520 passes and four failures out of 524 tests**. The same four failures were reproduced in a targeted unmodified-source check: manual-assistant evidence retention, two legacy combined-Omni adapter assertions, and a legacy Qwen-summary assertion. They were not silently skipped or presented as passing. `test:release` is a separately named, narrower validation group: **all 115 tests passed**.

### Prepare the desktop

Place your separately obtained Cubism Core and Framework under `desktop/vendor/cubism/`. Configure your authorized model under `desktop/assets/local-model/`, with `pet.model3.json` and its referenced files. Create a matching `presets.json` using the schema example, and adapt `desktop/config/parameter-map.json`. Follow [Live2D integration](LIVE2D.md#english), then run `npm run build:desktop` and `npm run build:native`.

Once actual model files are present, `node tools/configure-model.mjs` creates a disabled catalog with a real resource fingerprint and refuses to overwrite an existing catalog. Adapt the mappings, actions and expressions before enabling them. The sample presets are not a functioning model binding. Optional wake detection needs separately configured compatible weights.

The clean-copy Mac native build and signing checks passed, without launching the pet. Full first-time setup and runtime acceptance were not performed with a real SDK, rig, registered voice or credentials.

### Configure and launch

Use `config/providers.example.json` as a structural reference for an external `config.local.json`. Supply credentials in separate files **outside the repository**, with owner-only permissions such as mode 0600. Do not paste keys into shell history or public files. The MiniMax path requires an authorized voice and genuine registration metadata; placeholders and fabricated receipts do not make a voice usable.

The example's accounting constants are implementation inputs, not a guarantee of current provider pricing. Provider balances and local usage estimates are separate concepts.

The sample MiniMax integration uses **DashScope's `MiniMax/speech-2.8-turbo` endpoint**, not the direct MiniMax API. Set your own `voiceId` and external `voiceRegistryFile`. The registry schema in [`providers/registered-voices.ts`](../code/desktop-pet/providers/registered-voices.ts) stores real voice metadata and a binding to the credential file. `credentialRef` is `dashscope-` plus the first 12 hex characters of the SHA-256 of that absolute path. Verify the binding when moving machines or credential files. This package does not clone a voice, provision an account, or fabricate provider-enrollment evidence.

The registry structure is illustrated in [`voice-registry.example.json`](../code/desktop-pet/config/voice-registry.example.json); use genuine enrollment data. `node tools/voice-reference.mjs /absolute/external/dashscope.key` computes the path reference without reading the key.

After resources, credentials and voice configuration are ready:

```sh
node tools/configure-local.mjs /absolute/path/to/config.local.json --activate
node dist/app/trial-launcher.js
```

If initially configured without `--activate`, run `node tools/configure-local.mjs --activate-existing` later. It rechecks unchanged runtime fingerprints and credential permissions before enabling the prepared state, without launching the app.

Configuration does not itself call a model or access devices. Explicit activation enables the supplied service configuration; subsequent user interaction can incur charges. Existing local state is not overwritten. Runtime state is created under the repository-root `.local/` directory and must not be published.

Use your own WeChat account and separately installed Harness/Codex services. No accounts, subscriptions, cloned voices or remote servers are included. WeChat voice replies use audio files; successful native-message submission alone does not establish phone visibility.

### Publish a clean copy

Run `python3 tools/check-release.py` from the repository root on the clean release copy. Exclude installed dependencies, build products, `.local`, private configuration, model/SDK assets and databases. The audit checks structure and known sensitive patterns; it is not a legal clearance or proof against every possible secret encoding.

No previous Git history is included. Initialize a fresh repository from this folder rather than copying the private project's `.git`. Handle software licensing and [artwork provenance](../assets/original-design/README.md#english) separately.
