# ComfyUI → Live2D 工作流

## 目标

用本地 ComfyUI 辅助制作一个身份稳定、可拆分、可绑定的原创角色，再由 Live2D Cubism 完成真正的模型制作。ComfyUI 不直接承担最终分层质量、变形和绑定。

角色外貌与背景必须来自 [角色设定表](CHARACTER_BRIEF_TEMPLATE.md)。设定未锁定时，只能做技术测试，不生成正式角色。

## 本机现状（2026-09-01）

已恢复官方 ComfyUI core 到 `D:\Tools\ComfyUI\resources\ComfyUI`，实际模型、输入输出、用户配置和虚拟环境继续使用 `D:\Tools\ComfyUIWorkfiles`。2026-09-01 已用 `127.0.0.1:8188` 实际完成工作流执行和健康检查。

现有可用资源：

- RTX 5060，约 8 GB 显存。
- `Z-Image-Turbo-Art-bf16` 与 `z_image_turbo_bf16`：用于第一张主立绘探索。
- `Qwen-Image-Edit-2509` FP8：用于在参考图基础上保持人物一致性并修改表情、视角或局部。
- `Qwen-Edit-2509-Multiple-angles`、4/8 步 Lightning LoRA。
- `comfyui_layerstyle`、Impact Pack、KJNodes、ComfyUI Essentials 等辅助节点。
- SeedVR2 当前节点：`SeedVR2LoadDiTModel`、`SeedVR2LoadVAEModel`、`SeedVR2VideoUpscaler`。
- BRIA RMBG-1.4 已缓存到 `models\rmbg\RMBG-1.4\model.pth`，整人抠图无需再次下载。

当前没有找到：

- IPAdapter 节点及对应模型。
- ControlNet 模型。
- Qwen-Image-Layered 权重。
- 独立的角色 LoRA。

因此首版不把这些资源设为前置条件。Qwen-Image-Edit-2509 的官方模型说明强调了单图人物一致性和多图编辑能力，适合从一张已确认的主立绘派生表情。由于模型较大，8 GB 显存需要低显存/CPU 卸载，速度不会很快。

## 总流程

```text
用户填写并锁定人物设定
  → ComfyUI 生成候选主立绘
  → 选定唯一主参考图并冻结种子/提示词/工作流
  → Qwen Image Edit 派生表情与结构参考
  → 分割蒙版与补全隐藏区域
  → Photoshop 或 Clip Studio 人工整理素材分离 PSD
  → 生成 Cubism 导入 PSD
  → Cubism 网格、参数、物理和表情绑定
  → 导出 model3.json/moc3/纹理/动作
  → Aika 本地加载、口型与状态联调
```

不存在可靠的“一张图直接变成高质量 Live2D 模型”步骤。官方 Cubism 流程仍要求按眼睛、睫毛、脸、嘴、头发等部件进行素材分离；被头发和衣服遮住的皮肤与身体也必须补画。

## 阶段 A：人物设定锁定

1. 填写 `CHARACTER_BRIEF_TEMPLATE.md`。
2. 将设定转换为三类文本：固定身份描述、当前画面描述、禁止项。
3. 固定身份描述在所有 ComfyUI 工作流中保持不变。
4. 在用户明确确认前，不生成正式主立绘。

交付物：`character-brief.json`、参考图目录和提示词版本号。

## 阶段 B：主立绘探索

使用 Z-Image Turbo Art 生成 4～8 张低成本候选图，只改变种子，不同时改变大量设定。

主立绘要求：

- 正面或非常轻微的 3/4 角度。
- 半身或大腿以上，双肩和躯干完整。
- 双手不遮挡脸、胸口和头发。
- 嘴自然闭合，双眼正常睁开。
- 纯色或透明感背景，无前景遮挡。
- 发型能清楚区分前发、左右侧发和后发。
- 服装结构简单，第一版避免披风、复杂透纱和大量小饰品。

选定后同时冻结：原图、种子、分辨率、模型、采样参数、完整提示词和工作流 JSON。ComfyUI 官方支持将工作流保存在 JSON 中，也会把工作流信息写入生成图元数据。

## 阶段 C：一致性表情与结构参考

使用 Qwen-Image-Edit-2509，将主立绘作为第 1 张输入图。每次只改一个目标：

```text
保持人物身份、脸型、发型、服装、配色和画风完全一致。
只把表情改为认真倾听；保持正面角度、姿势和构图不变。
```

需要生成：

- 6 个表情参考，而不是 6 套重新设计的人物。
- 闭眼、半闭眼和眼睛睁开参考。
- 嘴闭合、轻微张开、较大张开和微笑参考。
- 轻微左右转头参考，仅用于绑定时理解体积。

Multiple-angles LoRA 只用于结构参考，不直接替换正面主立绘。每张结果都要与主图叠加检查眼距、脸宽、刘海轮廓、服装边缘和饰品位置；发生漂移就退回，不继续叠加编辑。

## 阶段 D：素材分离辅助

### ComfyUI 可以做

- 用 LayerStyle/分割节点生成头发、脸、衣服等大区域蒙版。
- 用 Qwen Image Edit 补全被刘海遮挡的额头、被头遮挡的后发、被衣服遮挡的身体等参考图。
- 为眼球、眼白、嘴腔和牙齿提供重绘参考。
- 输出透明 PNG 草稿供人工整理。

### ComfyUI 不能替代

- 精确到睫毛、上下眼皮、瞳孔、高光、唇线的最终拆件。
- 保证遮挡区域与原画笔触完全一致。
- 决定 Cubism 的变形器、参数和物理结构。
- 自动产出可直接发布的 `.model3.json`。

Qwen-Image-Layered 将来可作为可选辅助：它能把一张图拆成多个 RGBA 语义层并导出 PSD，但它不是按 Live2D 眼睛/嘴/头发绑定结构训练的，输出仍需人工二次拆分。当前本机未安装，不列入首版必需项。

## 阶段 E：PSD 分层规范

保留两份文件：

- `material-separation.psd`：保留文件夹、遮罩、线稿和补画层，方便返工。
- `cubism-import.psd`：每个可绑定部件合并成一个唯一命名的像素层。

建议首版控制在 80 个导入层以内，以适配 Cubism FREE 的 100 ArtMesh 限制。

```text
00_Guide
10_Head
  Face_Base
  Ear_L / Ear_R
  Nose
  Blush
20_Eye_L / 21_Eye_R
  Brow
  Upper_Lash
  Lower_Lash
  Eye_White
  Iris
  Pupil
  Highlight
  Eyelid_Close
30_Mouth
  Lip_Upper / Lip_Lower
  Mouth_Inside
  Teeth
  Tongue
40_Hair
  Bangs_01...
  Side_L / Side_R
  Back_Hair
  Loose_Strands
50_Body
  Neck
  Torso
  Arm_L / Arm_R
60_Clothes
70_Accessories
```

必须补画：刘海后面的完整额头、眼皮下的眼白、嘴唇后的嘴腔、下巴后的脖子、头发后的肩膀和服装，以及动作中会露出的边缘。

官方只保证 Photoshop 与 Clip Studio Paint 生成的 PSD 可正常导入。Live2D 的 Photoshop Material Separation Plugin 可以辅助切出、颜色填充和透明填充，但需要 Cubism PRO 或试用许可；没有插件时仍可手工完成。

## 阶段 F：首版 Cubism 绑定

首版只做半身模型，参数控制在 24 个左右：

- `ParamAngleX/Y/Z`：头部角度。
- `ParamBodyAngleX/Y/Z`：上身跟随。
- `ParamEyeLOpen/ROpen`：眨眼。
- `ParamEyeBallX/Y`：视线。
- `ParamBrowLY/RY`：眉毛情绪。
- `ParamMouthOpenY`：音量驱动口型。
- `ParamMouthForm`：嘴角形状。
- `ParamBreath`：呼吸。
- 左右侧发、后发和衣物轻微物理摆动。

首版不做摄像头面捕、全身行走或复杂手势。每个参数必须测试最小值、默认值和最大值，并测试组合后是否穿帮。

## 阶段 G：Aika 内联动

```text
idle      → 自然呼吸、眨眼、轻微视线移动
listening → 视线集中、轻微点头、attentive 表情
thinking  → thinking 表情、视线短暂偏移
speaking  → TTS 音量驱动 ParamMouthOpenY
happy     → happy 表情 + 一次短动作
concerned → concerned 表情 + 更慢的待机动作
```

模型回复应只输出受控情绪标签，不能让语言模型直接写任意 Cubism 参数。

## 目录交付

```text
character-art/
├─ brief/character-brief.json
├─ comfyui/
│  ├─ 01-master.workflow.json
│  ├─ 02-expression-edit.workflow.json
│  └─ prompts/
├─ reference/
│  ├─ master-front.png
│  ├─ expressions/
│  └─ structure/
├─ psd/
│  ├─ material-separation.psd
│  └─ cubism-import.psd
├─ cubism/source.cmo3
└─ runtime/
   ├─ character.model3.json
   ├─ character.moc3
   ├─ textures/
   ├─ expressions/
   ├─ motions/
   └─ character.physics3.json
```

## 当前本机接入（2026-09-01）

Aika 专用工作流已经生成并安装到：

```text
D:\Tools\ComfyUIWorkfiles\user\default\workflows\Aika_Live2D\
├─ Aika_01_Upscale_Front_Master_SeedVR2.json
├─ Aika_02_Expression_Reference_Qwen2509.json
├─ Aika_03_Base_Cutout_RemBgUltra.json
└─ Aika_04_Upscale_Single_Asset_SeedVR2.json
```

输入素材已安装到 `D:\Tools\ComfyUIWorkfiles\input\aika\`。当前已经完成：

- SeedVR2 3B FP8 将 512×1024 正面裁切放大到 2048×4096。
- 对 SeedVR 放大的鼻部和嘴下白色高光做固定坐标、无生成式局部回填；正式母稿为 `output/live2d/source/aika-front-master-4k.png`。
- RemBgUltra 生成透明底 `output/live2d/layers/00-character-cutout-rgba.png` 和人物白/背景黑的遮罩 `00-character-mask.png`，角落与人物中心 alpha 已验证。
- CLIPSeg 和 face parsing 结果已整理到 `output/live2d/layers/guides/`。它们只作人工选区参考；头发结果会混入衣袖，细眉和嘴线未成功识别。
- Qwen 的两张整脸微笑测试发生明显身份漂移和面部亮点复发，已移入 `output/live2d/rejected/expression-tests/`，正式表情改用原始分层加 Cubism 参数形变。
- 七个 `.exp3.json` 和四个 `.motion3.json` 参数模板位于 `output/live2d/runtime-presets/`，JSON 结构及曲线统计已校验。

放大结果默认只同步到候选目录，必须在 100% 缩放下验收后使用 `Sync-AikaUpscaledMaster.ps1 -Approve` 才能替换正式母稿。`Test-AikaComfySetup.ps1` 可检查服务、节点、工作流安装哈希和关键输出尺寸。

详细运行入口、同步脚本和限制见 [Aika ComfyUI 管线说明](../tools/live2d-pipeline/comfyui/README.md)。

## 成本与许可边界

- ComfyUI 与现有本地模型阶段不增加服务器费用。
- Cubism FREE 可用于基础模型，但当前限制包括 100 ArtMesh、30 个参数、50 个变形器和一张最高 2048 px 纹理。
- 自己开发和测试 SDK 不需要发布许可；如果未来公开发布支持用户导入任意 Live2D 模型的应用，可能属于“可扩展性应用”，必须重新核对并申请相应许可。

## 资料依据

- [ComfyUI 官方：工作流 JSON 与图片元数据](https://docs.comfy.org/get_started/first_generation)
- [Qwen Image Edit 2509：人物一致性与多图编辑](https://huggingface.co/Qwen/Qwen-Image-Edit-2509)
- [Qwen Image Layered：RGBA 多层分解](https://github.com/QwenLM/Qwen-Image-Layered)
- [Live2D 官方：素材分离](https://docs.live2d.com/cubism-editor-manual/divide-the-material/)
- [Live2D 官方：PSD 制作注意事项](https://docs.live2d.com/en/cubism-editor-manual/precautions-for-psd-data/)
- [Live2D 官方：FREE 与 PRO 限制](https://www.live2d.com/en/cubism/comparison/)
- [Live2D 官方：可扩展性应用许可](https://www.live2d.com/zh-CHS/sdk/license/expandable/)
