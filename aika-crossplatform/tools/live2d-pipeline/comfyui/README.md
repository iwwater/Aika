# Aika ComfyUI → Live2D 管线

这套管线只使用本机已有模型和节点，不覆盖原有 ComfyUI 工作流，不调用付费云服务。

## 已生成的工作流

1. `Aika_01_Upscale_Front_Master_SeedVR2.json`
   - 读取已经批准的 512×1024 正面裁切，不再在放大工作流里重复裁三视图。
   - 使用当前节点 `SeedVR2LoadDiTModel`、`SeedVR2LoadVAEModel`、`SeedVR2VideoUpscaler`。
   - 针对约 8 GB 显存设置：3B FP8、16 blocks swap、batch 1、VAE tile 512、overlap 64、短边 2048、最长边 4096。
2. `Aika_02_Expression_Reference_Qwen2509.json`
   - 基于 Comfy-Org 官方 Qwen Image Edit 2509 工作流。
   - 绑定本机已有 Qwen Edit 2509、Qwen 2.5 VL、Qwen VAE 和 Lightning 4-step LoRA。
   - 每次只改变一个表情、眼睛状态或口型；提示词位于 `presets/expression-presets.json`。
3. `Aika_03_Base_Cutout_RemBgUltra.json`
   - 从批准的 2048×4096 母稿生成整个人物 RGBA 抠图和“人物白、背景黑”的遮罩。
   - `InvertMask` 只连接 RGBA alpha 分支，已修复旧工作流透明通道方向相反的问题。
   - BRIA RMBG-1.4 权重已经缓存并校验。
4. `Aika_04_Upscale_Single_Asset_SeedVR2.json`
   - 无裁剪地放大单张表情、口型参考、遮罩源或人工修正后的图层。
5. `Aika_05_SeeThrough_Decompose_8GB.json`
   - 使用 ComfyUI-See-through 将批准的正面母稿拆成语义透明层、深度顺序和 PSD。
   - 针对 RTX 5060 8 GB 预设为 NF4 模型、`cache_tag_embeds=true`、`group_offload=true`、分层分辨率 1024、深度分辨率 720。
   - 首次执行会从 Hugging Face 自动下载 LayerDiff 3D 与 Marigold NF4 模型；这是本地推理，不产生云 API 费用，但会占用磁盘和下载时间。

## 当前母版

- 三视图母版：`output/character-concepts/aika-holographic-turnaround-v1-rebuild.png`
- 正面裁切母版：`output/live2d/source/aika-front-master-v1.png`
- 目标高分母版：`output/live2d/source/aika-front-master-4k.png`
- 整人透明底：`output/live2d/layers/00-character-cutout-rgba.png`
- 人物前景遮罩：`output/live2d/layers/00-character-mask.png`
- 自动分割辅助：`output/live2d/layers/guides/`（只能辅助描边，不能当作最终 Cubism 图层）
- Cubism 参数预设：`output/live2d/runtime-presets/`

后续不得使用 v2–v6 角色稿作为身份参考。

当前 4K 母稿保留 SeedVR 的头发、服装与眼睛细化，只对鼻部和嘴下被放大的白色高光做了局部、无生成式色彩回填。原始白点版保存在 `output/live2d/rejected/source-tests/`，不会再作为正式输入。

## 执行顺序

在 PowerShell 中，从项目根目录执行：

```powershell
& '.\tools\live2d-pipeline\comfyui\scripts\Build-AikaComfyWorkflows.ps1'
& '.\tools\live2d-pipeline\comfyui\scripts\Install-AikaComfyWorkflows.ps1'
```

启动 ComfyUI 后：

1. 打开 `Aika_Live2D/Aika_01_Upscale_Front_Master_SeedVR2.json` 并运行。
2. 将结果先同步为候选图，不覆盖正式母稿：

```powershell
& '.\tools\live2d-pipeline\comfyui\scripts\Sync-AikaUpscaledMaster.ps1'
```

3. 如果候选图只出现同一位置的鼻部/嘴下亮点，可执行固定坐标的无生成式清理；默认仍只生成候选：

```powershell
& '.\tools\live2d-pipeline\comfyui\scripts\Invoke-AikaFaceCleanup.ps1' -SourcePath '<待清理的 2048x4096 PNG>'
```

4. 在 100% 缩放下确认脸型、双眼、眼镜、嘴和皮肤均无漂移后，才显式批准：

```powershell
& '.\tools\live2d-pipeline\comfyui\scripts\Sync-AikaUpscaledMaster.ps1' -UpscaledPath '<已验收 PNG>' -Approve
```

5. 打开 `Aika_03_Base_Cutout_RemBgUltra.json` 重新生成整人透明底和遮罩。
6. 打开 `Aika_05_SeeThrough_Decompose_8GB.json` 生成语义层与 PSD 草稿；第一次运行保持 NF4、1024/720 和 group offload 设置。
7. Qwen 表情工作流目前只保留作结构实验。已经测试的整脸微笑图发生身份漂移，已移入 `output/live2d/rejected/expression-tests/`，不进入正式分层。
8. 根据 SeeThrough 输出和 `presets/live2d-parts-manifest.json` 在 Photoshop 或 Clip Studio Paint 中整理 PSD/PSB，并补画被遮挡区域。
9. 导入 Cubism 后绑定 `output/live2d/runtime-presets/` 中的表情和动作模板。

可随时运行健康检查：

```powershell
& '.\tools\live2d-pipeline\comfyui\scripts\Test-AikaComfySetup.ps1'
```

## 重要边界

- ComfyUI 负责高分辨率化、抠图、表情/口型参考和补画辅助。
- 生成式模型无法可靠输出像素完全对齐、遮挡关系正确的 Live2D 成品 PSD。
- 眼睛、嘴、前后头发、眼镜、衣装、手臂和身体必须人工检查并按清单分层。
- “动作”不是让 ComfyUI 生成视频，而是在 Cubism 中用参数、关键帧和物理演算制作。
- 任何改变脸型、眼镜、发型轮廓、服装或身体比例的表情结果都必须废弃。
- 自动 face parsing 只能可靠得到头发、脸部皮肤、眼镜和少量眼睛区域；当前画风的细眉与嘴线检测为空，因此这些结果放在 `layers/guides/`，不得声称是可直接绑定的 PSD。
- SeeThrough 虽然能输出语义层和 PSD，但仍不是 Cubism 成品：眼睫毛、眼皮、嘴腔、被遮挡皮肤、发束边缘及衣装接缝必须逐层验收和补画。

## 参考

- [ComfyUI Workflow JSON 规范](https://docs.comfy.org/specs/workflow_json)
- [Comfy-Org 官方 Qwen Image Edit 2509 工作流](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_edit_2509.json)
