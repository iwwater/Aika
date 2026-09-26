# SER SPEC 执行索引

需求见 [模块 PRD](PRD.md)。一次执行一份 SPEC；本次优化的顺序和边界见 [优化入口](../VOICE_RESEARCH_OPTIMIZATION.md)。

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [SER-01](SPEC_SER-01.md) | 语音情感识别研究立项 | 历史研究提案，保持原文状态 |
| [SER-02](SPEC_SER-02.md) | embedding/UMAP 与英文 baseline | 已有实验产物；指标与结论复核由 SER-03 承接，不据此标记完整验收通过 |
| [SER-03](specs/SER-03.md) | 计分修复、历史证据重算与结论校正 | REVIEWED_PASS（2026-09-21）：R2/R4补修经独立定向复跑确认 |
| [SER-04](specs/SER-04.md) | 公共逻辑、环境与产物边界整理 | REVIEWED_PASS（2026-09-21）：R1/R3补修经独立定向复跑确认；新环境复建NOT RUN |
| [SER-05](specs/SER-05.md) | 演示服务输入边界与响应性 | 已实施；报告记录自动验证通过，符号链接越界NOT RUN |
| [SER-06](specs/SER-06.md) | 数据契约、标签映射与无泄漏评测协议 | PASS（2026-09-22）：29项定向/计分测试通过（1项普通symlink权限skip、junction实测补证）；RAVDESS 1,440条审计通过，speaker 5折零泄漏；见[报告](reports/SER-06_ACCEPTANCE.md) |
| [SER-07](specs/SER-07.md) | eGeMAPS 88维可解释基线与特征组消融 | PASS（2026-09-22）：1,440条特征完整；speaker 5折下Linear SVM UAR=0.5171、macro-F1=0.5107；见[报告](reports/SER-07_ACCEPTANCE.md) |
| [SER-08](specs/SER-08.md) | Frozen emotion2vec embedding、linear/MLP probe与eGeMAPS融合 | PASS（2026-09-22）：1,440条1024维embedding完整；linear probe UAR=0.9204、macro-F1=0.9195；见[报告](reports/SER-08_ACCEPTANCE.md) |
| [SER-09](specs/SER-09.md) | Frozen linear probe概率校准、coverage-risk与uncertain拒识 | PASS（2026-09-22）：NLL 0.3227→0.3054；训练折选阈值在测试集coverage=82.45%、accepted risk=2.53%；见[报告](reports/SER-09_ACCEPTANCE.md) |
| [SER-10](specs/SER-10.md) | 噪声、增益、短时窗、拒识与延迟压力测试 | PASS（2026-09-22；真实麦克风项BLOCKED）：9,984次推理零失败；确认噪声、低音量、短片段风险；见[报告](reports/SER-10_ACCEPTANCE.md) |

审阅证据见[2026-09-21复核清单](reports/OPTIMIZATION_REVIEW_20260921.md)。剩余条件项不阻塞代码优化收口；下一步见[2026-09-22任务单](../DAILY_TASKS_2026-09-22.md)。

后续研究质量路线见 [SER V2 路线图](ROADMAP_V2.md)。当前方向暂停 TTS M1 重训，SER 按 SER-06 → 07 → 08 → 09 → 10 → 11 推进；一次只执行一份 SPEC。

合批后的当前 checkout 排除了 SER-06～10 的生成 manifest、split 与多数运行产物；历史报告结论与新工作区复跑状态的区别见[证据核对](reports/SER_V2_MERGE_AUDIT_20260926.md)。
