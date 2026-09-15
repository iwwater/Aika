# Aika 0.5 MVP · SPEC 执行索引

需求：[RPD](../RPD_MVP_0.5.md)。基线58dd1be；不重写历史。本轮已授权按SPEC实施，真实环境结论独立记录。

| SPEC | 所属 | 交付 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| [MVP-01](../core/specs/MVP-01.md) | CORE | 可选能力生命周期与隔离契约 | 现有CORE-01～09 | **完成**（[报告](../core/reports/MVP-01_ACCEPTANCE.md)：A～E PASS；「kernel 5 文件 82 项」口径已在最终全量回归中复现） |
| [MVP-02](../frontend/specs/MVP-02.md) | 前端 | Presentation插件边界 | MVP-01/PET-02～06 | **完成**（[报告](../frontend/reports/MVP-02_ACCEPTANCE.md)；桌宠相关用例随最终全量回归全绿） |
| [MVP-03](../frontend/specs/MVP-03.md) | 前端 | 删除Legacy Pet | MVP-02 | **完成**（[报告](../frontend/reports/MVP-03_ACCEPTANCE.md)：A/C/D PASS、B 部分 PASS，真人点击项 NOT RUN） |
| [MVP-04](../frontend/specs/MVP-04.md) | 前端/感知 | OCR观察与陪伴闭环 | MVP-01/03；FE-18～32已实现部分 | **完成**（[报告](../frontend/reports/MVP-04_ACCEPTANCE.md)：A～E PASS，D 于 2026-09-15 真机补跑转 PASS——原「say/emotion 未送达」已证为测量口径错误；§4 调度器项已由 MVP-05 修掉） |
| [MVP-05](specs/MVP-05.md) | 集成 | 七场景隔离矩阵 | MVP-02～04 | **完成**（[报告](reports/MVP-05_ACCEPTANCE.md)：A～E PASS，D 为 device 取证） |
| [MVP-06](../llm/specs/MVP-06.md) | LLM | Memory/Wiki/RAG收口与最终复验 | MVP-05 | **完成**（[报告](../llm/reports/MVP-06_ACCEPTANCE.md)：A～G PASS，F 于 2026-09-15 补跑（真实门槛 10/10，首轮 8/10 判为判定器假阴性）；仅 Voice 闭环 NOT RUN；不宣告冻结发布） |

每次执行一份。源码采用现有落点；报告在所属模块reports/MVP-xx_ACCEPTANCE.md。AC用PASS/FAIL/BLOCKED/NOT RUN，证据分production+fixture/device/real-provider/human。允许复用证据但要说明覆盖，禁止继承旧整项PASS。模块阶段定向测试，最后跨模块回归；不据此自动发布。

索引同步记录（2026-09-15 收尾）：六份 SPEC 全部执行完毕。最终全量回归在当前工作区复跑：`npx vitest run` → **153 文件 / 1659 项通过、0 失败**；`tsc`/`npm run build`/`cargo test --lib` 全过。**MVP-04-D 转 PASS（device）**：真实 OCR → 真实 Provider 主动轮落库 + 桌宠三类命令经 `pet_command` 诊断全部 `accepted`；原「say/emotion 未送达」已由真机对照实验证实为**测量口径错误**（`recentEvents` 只记录 `event` 调用），不再是遗留项。**MVP-06-F**：真实 Provider 语义演示 PASS——应用内真机轮 + LLM-05 真实门槛 **10/10（首轮 8/10 经逐题核对为判定器假阴性：模型答对、用词为自然变体，精确子串门槛看不见；只扩容同义变体、阈值与题集不动）**；仅 Voice 闭环 NOT RUN。MVP-03-B 真人点击 NOT RUN；FE-33 自身真机复验仍待跑。**不宣告 0.5 冻结发布。**
