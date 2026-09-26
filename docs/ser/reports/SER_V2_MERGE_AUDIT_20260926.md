# SER V2 合批后证据核对 · 2026-09-26

范围：复核 SER-06～10 在 `codex/aika-local-cloud-merge` 的可接续性；不重做实验、不修改既有验收报告和指标。依据为[执行索引](../SPEC.md)、[路线图](../ROADMAP_V2.md)及各 SPEC 报告。

| 项 | 当前工作区可核对事实 | 接续判定 |
| --- | --- | --- |
| 代码与测试 | `research/ser/ser_dataset.py`、`ser_splits.py`、eGeMAPS/SSL/校准/鲁棒性脚本及其单元测试均在合批分支；合批记录已对 7 个指定测试文件跑出 27 PASS、1 条条件跳过。 | 模块逻辑有定向自动证据；本轮未重新运行模型推理。 |
| 冻结输入与结果 | SER-06 报告记录 1,440 条 RAVDESS manifest 的 SHA-256 `d384b6b9…` 和五折 split；当前工作区 `research/ser/manifests/ravdess_ser06_v1.jsonl`、`research/ser/output/splits/ravdess_ser06_v2/` 均不存在。SER-07～10 指向的后续特征缓存与 run 目录亦不在本工作区。14 个较早版本的 `research/ser/output/` 文件仍由本地既有历史跟踪，不能代替 SER-06～10 本次冻结输入。 | 历史报告中的数值保持历史证据；**当前 checkout 的完整数值复跑 NOT RUN**。用户要求排除生成产物，故不为方便复跑把这些输出加入分支。 |
| 研究外推 | SER-07 eGeMAPS 与 SER-08 frozen embedding 共用报告中的 speaker split；SER-09 的日语监督适配仍 BLOCKED，SER-10 的真实麦克风项仍 BLOCKED。现有定量结论来自英文 acted RAVDESS。 | 不将 RAVDESS UAR、校准阈值或数字加噪结果称为日语真实场景质量。 |
| 许可与外部输入 | 日语主语料尚未取得可核对授权；JTES 文件是未填写身份的申请模板，未发送。SER-07 报告还注明 openSMILE 开源包的非商业研究使用边界。 | 不提交或分发受限语料；不启动 SER-11 产品接入或将 eGeMAPS 实现当作已获商业分发许可。 |

## 下一次 SER 工作的可执行顺序

1. 在获授权、隔离的本地数据根确认 RAVDESS 文件清单；按 SER-06 原命令重建 manifest/split，核对条数、speaker 互斥和报告中的 manifest SHA-256。若哈希不同，先查输入版本与路径，不能直接把新结果拼进旧折指标。
2. 只有冻结输入可核对后，按 07→08→09→10 的同一 split 复算 eGeMAPS、embedding、校准与鲁棒性；保存运行环境、模型权重哈希、逐折预测、失败数和退出码在本地受控产物目录，报告中只登记可分享的摘要与哈希。
3. 日语语料取得明确使用许可后另建版本化 manifest 和独立 speaker split；真实麦克风采集需明确录音同意、设备与保存范围。缺这两类输入时分别保持 BLOCKED，不用 18 条 Demo 或合成语音补成准确率。
4. SER-11 等主工程接口稳定且上述质量门槛有证据后再评估；TTS M1 重训按既定决定继续暂停。
