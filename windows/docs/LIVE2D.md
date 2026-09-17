# 接入自己的 Live2D / Bring your own Live2D

[项目首页](../README.md) · [English](#english)

## 支持范围

项目通过 Cubism Web 渲染管线接入 **Cubism 的 `.model3.json` / `.moc3` 模型**。可以适配不同角色，而不是只能使用演示中的一个角色。具体兼容性取决于模型导出版本、你安装的 Cubism SDK、纹理规格以及本地适配结果。

当前不是任意模型拖入即用，也不提供已验证的 Cubism 2 `.model.json` / `.moc` 兼容路径。角色人格切换与 Live2D 资源热切换不是同一件事；后者不要按已经实现的能力理解。

**仓库不包含现用第三方 Live2D 模型。** 不附其网格、纹理、物理、表情、动作、可编辑工程、截图或录屏。也不附 Cubism SDK；请从 [Live2D 官方下载页](https://www.live2d.com/en/sdk/download/web/) 获取并遵守其条款。

## 本地接入步骤

| 步骤 | 需要做的事 |
| --- | --- |
| 1. 准备资源 | 取得允许你使用的模型包；保持 `.model3.json` 引用的目录和文件名正确。不要把个人下载的模型加入公开仓库。 |
| 2. 准备 SDK | 按 [安装说明](SETUP.md) 配置 Cubism Framework、Core 与 WebGL shaders。模型和 SDK 分别遵守各自授权。 |
| 3. 设置加载路径 | 自备资源放在 `desktop/assets/local-model/`，入口为 `pet.model3.json`；其他位置需同时适配 `assetBase` 和静态资源服务。 |
| 4. 映射参数 | 对照实际模型的参数 ID 和取值范围，接入眼睛、嘴、头部、身体和视线。移除模型没有的参数引用。 |
| 5. 建立预设 | 为这个模型重新编写表现目录，关联它自己的 expression / motion；启用哪些自动表情由管理设置控制。 |
| 6. 对齐资源版本 | 模型、预设和后端登记必须对应；按源码的指纹逻辑更新绑定，不能关闭校验来掩盖错误。 |
| 7. 本地验收 | 构建前端，先检查静态中性姿态，再检查口型、眨眼、转头、动作叠加和回中。 |

从 `code/desktop-pet/` 运行 `node tools/configure-model.mjs` 可依据已经放入的真实模型文件生成禁用的预设目录及资源指纹；它拒绝覆盖已有目录。之后仍需自行填写模型映射、预设并验证。

公开包中的占位配置只用于说明结构，不包含原模型的预设资产，也不代表有可显示的角色。

## 为什么不只是换文件

旧角色可能使用自定义头部参数，另一角色则使用 `ParamAngleX`、`ParamAngleY`、`ParamAngleZ`。发布包把头部与嘴形名称集中在 `desktop/config/parameter-map.json`；嘴型、表情开关和动作曲线仍需逐项核对。新模型缺少某个参数时，应调整映射与动作范围，而不是强行写入同名值。

本项目源码中的渲染适配器仍保留部分历史命名和模型假设。接入新角色时，重点核对：

- `FileReferences` 中的 Moc、Textures、Physics、Expressions 和 Motions；当前管线对物理和 Idle 动作有约定，缺失时需要适配加载代码。
- 口型对应的开口参数、默认闭口值和播放结束归零行为。
- 头部/身体/眼球参数的名称、最大幅度与每帧叠加顺序。
- 预设目录的模型 ID、版本指纹、expression 名称及可自动启用的项目。
- 特定角色专用的外观开关。不要把旧角色的隐藏部件或水印控制照搬到新模型。
- 画布裁切、全身/半身构图、透明混合与纹理尺寸。

至少检查：连续说话后正确闭口、按键打断立即停止口型、思考/工作状态结束回到中性、不同表情不互相残留、缺失参数有明确错误而不是静默失败。新模型必须单独验证，旧模型通过不等于新模型通过。

## DeepSeek 大肥鱼设计稿

[项目设计稿目录](../assets/original-design/README.md) 包含静态整稿、透明立绘、头像与基础分层 PSD。它们可作为后续美术制作的输入，但**不包含已完成绑定的 Live2D 模型**。

仍需补齐遮挡区域、制作网格和变形器、绑定参数、导出运行模型并检查连续动作。不能把静态眨眼/张嘴图层预览称作已完成的 Live2D 动画。

## 代码入口

- [`desktop/cubism-renderer.mjs`](../code/desktop-pet/desktop/cubism-renderer.mjs)：资源读取、模型绑定、参数与口型。
- [`desktop/interaction-motion.mjs`](../code/desktop-pet/desktop/interaction-motion.mjs)：交互动作与平滑过渡。
- [`contracts/presentation.ts`](../code/desktop-pet/contracts/presentation.ts)：表现意图和统一语义。
- [`desktop/presentation-preview.mjs`](../code/desktop-pet/desktop/presentation-preview.mjs)：预设预览。

<a id="english"></a>

## English

The renderer integrates **Cubism `.model3.json` / `.moc3` models**. Different characters can be adapted locally, subject to export-version compatibility, the installed SDK, texture requirements and parameter mappings. This is not a universal drag-and-drop importer. Cubism 2 exports and dynamic switching between arbitrary model packages are not claimed as validated features.

The existing third-party character and all its textures, expressions, motions, editable files, screenshots and recordings are excluded. The Cubism SDK is also excluded; obtain it from the [official download page](https://www.live2d.com/en/sdk/download/web/) under its own terms.

1. Obtain an authorized model package and preserve all referenced paths locally.
2. Install the Framework, Core and WebGL shaders following [Setup](SETUP.md).
3. Adapt `assetBase`, the entry model file and static-resource serving.
4. Map the model's actual eye, mouth, head, body and gaze parameters and ranges.
5. Create a model-specific presentation catalog using that model's expressions and motions.
6. Keep model identity/fingerprint and backend registration consistent; do not bypass validation.
7. Build and validate neutral state, lip sync, blinking, head motion, transitions, interruption and return to idle.

With your actual model under `desktop/assets/local-model/` and its entry named `pet.model3.json`, run `node tools/configure-model.mjs` from `code/desktop-pet/` to create a disabled catalog with its resource fingerprint. Existing catalogs are preserved. Local mapping and preset work is still required.

Some historical model assumptions remain in the adapter. In particular, inspect required physics and Idle motion files, custom parameter names, appearance switches, framing and texture sizes. Do not copy character-specific visibility or watermark controls into another model. A successful test on one character does not validate another.

The [DeepSeek whale-girl artwork](../assets/original-design/README.md#english) is a concept and layer-preparation package. It is **not a rigged Live2D model**. Occlusion completion, meshes, deformers, parameter rigging, export and continuous-motion checks remain necessary. The code links above identify the adaptation points.
