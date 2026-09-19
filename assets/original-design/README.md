# DeepSeek 大肥鱼 / Whale-girl design resources

[项目首页](../../README.md) · [English](#english) · [Live2D 接入](../../docs/LIVE2D.md)

这里保存项目制作的鲸鱼娘女仆同人设计稿与基础资源。制作过程包括 AI 辅助绘制、人工选择和本地图像处理。角色参考来源与许可见下方说明。

<img src="whale-transparent.png" width="280" alt="鲸鱼娘女仆透明设计稿，未完成 Live2D 绑定" />

## 包含的资源

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| [whale-design.png](whale-design.png) | 937 × 1678 白底全身设计稿 | 项目选定的造型基准 |
| [whale-transparent.png](whale-transparent.png) | 1117 × 1858 透明整稿 | 原始可见像素抠图，边缘留白 |
| [whale-avatar.png](whale-avatar.png) | 512 × 512 头像 | 从设计稿裁切，适合作为本地头像素材 |
| [whale-layers.psd](whale-layers.psd) | 44 层基础拆分 PSD | 36 个可见部件、8 个补绘部件；身体遮挡补全仍不完整 |
| [assets.json](assets.json) | 文件大小和 SHA-256 | 发布副本校验清单，无私有制作路径 |

当前提供静态整稿和分层资源。后续需完成网格、变形器、参数绑定、物理、表情和连续动作检查，再导出 `.moc3` 和 `.model3.json` 运行模型。

公开副本移除了设计稿 PNG 的非像素 provenance 元数据容器；像素与原设计一致，AI 辅助制作事实保留在本说明中。其他 PNG 不含文本/EXIF 元数据，PSD 仅有工具版本资源和命名图层；不附源参考图、私有生成记录、制作日志或现用第三方 Live2D 的任何资产。

## 来源与权利说明

历史参考入口为 [fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon)。该仓库署名上善无形（OC「溟月」）、ZipZipPipe 和 QYQCAMIAO，并标示 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)；它同时说明原图具体作者未确认。

本目录收录后续生成和拆层的设计稿。使用与再分发时请遵守相关署名、非商业使用和相同方式共享条款；原图作者及衍生作品的具体授权范围仍需向来源方核实。

项目原创内容适用[非商业使用及署名许可](../../LICENSE)，角色素材遵循各自上游条款。现用第三方 Live2D 模型依作者要求仅供本地使用。

<a id="english"></a>

## English

This directory contains project-produced whale-girl maid fan artwork, created through AI-assisted drawing, human visual selection and local image processing. Character references and licensing are listed below.

Included: a full-body concept image, transparent artwork, a 512-pixel avatar, a 44-layer PSD and a checksum manifest. The PSD contains 36 visible components and eight supplemental layers; body occlusions are incomplete. Next steps are meshing, deformers, parameter rigging, physics and continuous-motion checks before exporting a runtime model.

Non-pixel provenance-container metadata was removed from the release copy of the concept PNG without changing pixels. AI-assisted production is explicitly disclosed here. Private generation logs, original reference images and the existing third-party Live2D assets are not included.

The historical reference repository is [fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon). It credits 上善无形, ZipZipPipe and QYQCAMIAO, states [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), and also acknowledges uncertainty about the exact original image author.

This directory contains subsequent generated and separated artwork. Follow the applicable attribution, noncommercial and share-alike terms when using or redistributing it. Confirm the original author and the specific scope of derivative permission with the source.

Original project material follows the [Noncommercial and Attribution License](../../LICENSE); character artwork follows its upstream terms. The third-party Live2D character used locally remains subject to its author's redistribution restriction.
