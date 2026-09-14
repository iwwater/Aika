# 第三方组件与资料

## Silero VAD

`aika-crossplatform/public/models/silero_vad.onnx` 用于本地语音活动检测。

- 上游：https://github.com/snakers4/silero-vad
- 上游许可：https://github.com/snakers4/silero-vad/blob/master/LICENSE
- 许可文本：[licenses/silero-vad-MIT.txt](licenses/silero-vad-MIT.txt)

## Tesseract 语言数据（tessdata_fast）

`aika-crossplatform/public/tessdata/` 与 `aika-crossplatform/src/services/environment/fixtures/` 下的
`*.traineddata` 用于本地离线 OCR（FE-21 词表识别、FE-32 中英文读屏），随包分发、运行时不外联。

- 上游：https://github.com/tesseract-ocr/tessdata_fast
- 版本：tag `4.1.0`
- 上游许可：Apache License 2.0
- 许可文本：[licenses/tessdata-Apache-2.0.txt](licenses/tessdata-Apache-2.0.txt)

| 文件 | 字节 | sha256 |
| --- | --- | --- |
| `eng.traineddata` | 4113088 | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |
| `chi_sim.traineddata` | 2469156 | `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730` |

两处目录放的是同一份文件（`public/` 供打包，`fixtures/` 供测试）；哈希由
`src/services/environment/ocrText.test.ts` 逐文件核对，资源被换掉或损坏会直接测试失败。

## 依赖

JavaScript、Rust 和 Android 依赖分别由 package-lock.json、Cargo.lock 和 Gradle 配置记录，各自适用上游许可。构建产物不随本仓库发布；分发应用时需核对所打包依赖的许可和声明。

## 论文

论文正文不随公开仓库分发。索引和下载脚本仅指向原始发布渠道；使用或再次分发资料时，应遵守各论文及数据集的许可。本地校验清单用于核对历史下载，并非新的分发授权。

## 项目许可

本说明不为 Aika 自有代码指定整体开源许可证，也不改变第三方许可。
