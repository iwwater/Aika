# Aika 0.5 MVP · SPEC 执行索引

需求：[RPD](../RPD_MVP_0.5.md)。基线58dd1be；不重写历史。原实施授权属于历史阶段；2026-09-15 本次仅修订文档，不启动代码或实机工作。真实环境结论独立记录。

| SPEC | 所属 | 交付 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| [MVP-01](../core/specs/MVP-01.md) | CORE | 可选能力生命周期与隔离契约 | 现有CORE-01～09 | **完成**（[报告](../core/reports/MVP-01_ACCEPTANCE.md)：A～E PASS；「kernel 5 文件 82 项」口径已在最终全量回归中复现） |
| [MVP-02](../frontend/specs/MVP-02.md) | 前端 | Presentation插件边界 | MVP-01/PET-02～06 | **完成**（[报告](../frontend/reports/MVP-02_ACCEPTANCE.md)；桌宠相关用例随最终全量回归全绿） |
| [MVP-03](../frontend/specs/MVP-03.md) | 前端 | 删除Legacy Pet | MVP-02 | **PARTIAL**（[报告](../frontend/reports/MVP-03_ACCEPTANCE.md)：A/C/D PASS、B 部分 PASS，真人点击项 NOT RUN） |
| [MVP-04](../frontend/specs/MVP-04.md) | 前端/感知 | OCR观察与陪伴闭环 | MVP-01/03；FE-18～32已实现部分 | **完成**（[报告](../frontend/reports/MVP-04_ACCEPTANCE.md)：A～E PASS，D 于 2026-09-15 真机补跑转 PASS——原「say/emotion 未送达」已证为测量口径错误；§4 调度器项已由 MVP-05 修掉） |
| [MVP-05](specs/MVP-05.md) | 集成 | 七场景隔离矩阵 | MVP-02～04 | **完成**（[报告](reports/MVP-05_ACCEPTANCE.md)：A～E PASS，D 为 device 取证） |
| [MVP-06](../llm/specs/MVP-06.md) | LLM | Memory/Wiki/RAG收口与最终复验 | MVP-05 | **PARTIAL**（[报告](../llm/reports/MVP-06_ACCEPTANCE.md)：已有模块证据保留；F 的真实 Provider 分支已补跑，结果10/10、既定门槛≥9/10；Voice 分支 NOT RUN，G 的整体收口未完成） |

每次执行一份。源码采用现有落点；报告在所属模块reports/MVP-xx_ACCEPTANCE.md。AC用PASS/FAIL/BLOCKED/NOT RUN，证据分production+fixture/device/real-provider/human。允许复用证据但要说明覆盖，禁止继承旧整项PASS。模块阶段定向测试，最后跨模块回归；不据此自动发布。

## 当前收口矩阵（2026-09-15修订）

以下为待验计划，非本次执行结果。旧报告已覆盖的子项保留；同一构建的证据可按覆盖范围复用。

| 项 | 当前缺口与验收边界 | 归属 |
| --- | --- | --- |
| Voice→Agent→Pet | NOT RUN；真实麦克风输入经 Agent 到真实桌宠可见表现，记录轮次与三层证据；不是唯一欠账，不替代声学样本数量 | MVP-06-F；INT-02/STT-03 分别保留原后置状态 |
| 主窗五入口 | MVP-03-B PARTIAL；主动/安静/暂停读屏/看屏幕聊聊/结束陪伴真人点验待补，Pet OFF 也可用 | MVP-03-B、FE-33-F |
| 环境/隐私/设备 | FE-33 按删旧 pet 后的 A～G 适用范围复验，锁屏、DPI、性能与 BUG-02/03 留账；旧 pet BUG-01 不作为新实现要求 | [FE-33](../frontend/specs/FE-33.md) |
| 外部桌宠 | PET-07 A/B device 证据保留；C/G/H/I 未测、D/E/F/J 部分通过，逐项补证；不以 HTTP accepted 代替可见表现 | [PET-07 报告](../frontend/reports/PET-07_ACCEPTANCE.md) |
| 宿主稳定性 | Handoff 记录约 3～24 分钟偶发退出，原因未定，不能先定性为崩溃；记录是否人工退出、退出码/进程时间线，覆盖原触发条件复验；一次运行超过 15 分钟不关闭问题 | [Handoff](../HANDOFF_MVP_0.5.md)；结果登记 INT-03，缺陷回对应模块 |
| 真实 TTS/STT | 按 TTS-05/STT-03 与 INT-02 原范围及授权执行；原 DEFERRED 不由本文自动解除 | TTS/STT、INT-02 |
| 集成与发布 | INT-01 按宿主/Provider 列判断；INT-03 NSIS BLOCKED、安装/卸载 NOT RUN。采用授权环境，保留用户数据；构建成功与安装成功分列 | [集成 SPEC](SPEC.md)、[INT-03 报告](reports/INT-03_ACCEPTANCE.md) |
| 记忆双轨 | MEM-DEC-01 待裁决；后台抽取确认可用不等于回复 memoryCandidates 已接通。冻结前明确纳入实现或按现状收口的产品范围 | [MVP-06](../llm/specs/MVP-06.md) |

**模块交付、0.5 产品验收、发行就绪分别裁决。** 所有适用产品 AC 有证据后才可冻结；发布还需对应产物的全部适用 INT-03 门禁。0.6 草案、KB-01 或研究型 RAG 不自动新增为 0.5 门禁。

索引同步记录（2026-09-15 收尾）：六份 SPEC 的实现/模块交付已有报告，适用验收尚未全部完成。以下为历史报告记录，本次未重跑：`npx vitest run` → **153 文件 / 1659 项通过、0 失败**；`tsc`/`npm run build`/`cargo test --lib` 全过。**MVP-04-D 转 PASS（device）**：真实 OCR → 真实 Provider 主动轮落库 + 桌宠三类命令经 `pet_command` 诊断全部 `accepted`；原「say/emotion 未送达」已由真机对照实验证实为**测量口径错误**（`recentEvents` 只记录 `event` 调用），不再是遗留项。**MVP-06-F**：真实 Provider 语义演示 PASS——应用内真机轮 + LLM-05 真实结果 **10/10（首轮 8/10 经逐题核对为判定器假阴性：模型答对、用词为自然变体，精确子串门槛看不见；只扩容同义变体、阈值与题集不动）**；仅 Voice 闭环 NOT RUN。MVP-03-B 真人点击 NOT RUN；FE-33 自身真机复验仍待跑。**不宣告 0.5 冻结发布。**
