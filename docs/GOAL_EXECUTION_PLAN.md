# 可持续安全执行计划

> 2026-09-14 桌宠策略覆盖：如后续任务涉及桌宠，只按 [Integration RPD](frontend/RPD_DESKTOP_PET_INTEGRATION.md) 与 [PET SPEC](frontend/SPEC_DESKTOP_PET.md) 派发。停止旧自研桌宠窗口/renderer/口型路线；其他业务与历史证据保留。本次规格拆分本身不自动恢复后台执行。

日期：2026-09-13。只授权实现与自动验证，不授权发布、外部发送、消费新服务、读取私人资料或解除用户后置项。新 SPEC 的 READY 仅表示可以按此范围执行。

## 状态与继续规则

每条 AC 分开记录：PASS / FAIL / BLOCKED / NOT RUN / DEFERRED，另设“证据类型”production+fixture / real-service / browser / device / human。仅用户明确后置才用 DEFERRED。

- AUTO_PASS：当前 SPEC 所有可自动 AC 已通过，改动与消费者审查完成，无已知相关回归；仍为待人工验收，不覆盖真实/人工 AC。
- PARTIAL：安全可独立部分完成，仍有自动 AC 阻塞。不能标整份 AUTO_PASS。
- BLOCKED：明确缺前置、环境或权限；写原因、受阻 AC、解除条件及可继续的无关节点。
- NOT RUN：未执行，不等于失败也不等于环境阻塞。
- REVIEWED_AUTO：已审阅既有代码和证据，可作为本地开发前置；不能代表用户批准。

能跳过的是受阻步骤，不能跳过的是依赖的行为保证。没有真机但模块逻辑可测，做完逻辑再转人工队列；协议、安全负例或生产测试失败，必须定向修复，修不了阻塞其依赖，继续无关 SPEC。连续两种有依据的修复仍失败或同一步约30分钟无新证据，落盘诊断并转无依赖任务；这只是任务调度阈值，不是通过条件。新证据出现才重试，禁止无限轮询。

安全拒绝路径未通过，不能启动依赖的真实网络监听或Agent写执行；允许使用显式端口 fake 开发独立消费者，但只能给该消费者自己的模块结论。人工最终签字缺失不会阻塞普通界面或纯逻辑下一项。

## 执行顺序（一次一个 SPEC）

| 波次 | 顺序 | 出口 / 阻塞分流 |
| --- | --- | --- |
| 0 | 读 AGENTS、git status/diff；登记原有脏文件；复核云TTS 3红及当前测试修复 | 只定向测 speechOutput 契约；不撤销现有更改、不预判生产缺陷 |
| 1 | CORE-01→09；LLM-01→03、06→10；STT-01/02/04；TTS-01/02；FE-01→13 | 审查生产实现与逐AC证据，缺早期报告则据实补；不是重做全部模块。按文件依赖定向测，旧报告不能无条件继承 |
| 2 | INT-01 可自动消费者检查 | legacy仅验证已移除与旧设置兼容；真实Tauri/plugin-sql/手机/模型留各自槽位；文本核心FAIL阻塞其消费者 |
| 3 | LLM-04→LLM-05；TTS-04；LLM-11→FE-23→FE-24→FE-25；LLM-12→FE-26 | 某条RAG真实质量阻塞时可转TTS/Inspector；不改质量阈值 |
| 4 | RT-01→RT-02→RT-03→RT-04；GW-01→GW-02→GW-03 | Telegram实际发信/付费另需已有授权，无则完成fixture继续 |
| 5 | FE-14→FE-17-pre；FE-15→FE-17-host/tauri→GW-04；FE-16→FE-17-host/dev-relay独立分支 | FE-17可拆内部A/B步骤但不另造编号；对外监听前通过安全负例；FE-16真实loopback不可用则BLOCKED该AC，保留Tauri独立分支 |
| 6 | AGT-01→AGT-02→AGT-03→AGT-04→AGT-05 | 两适配器可独立推进；真实凭证不可用不阻塞协议fixture；未证实工具隔离不能实际写执行 |
| 7 | INT-04 fixture集成；具备授权才真实集成；RT-05→RT-06；GW-05→GW-06 | 一个适配器跑通不代表两个完成；完成通知不是任意外发授权 |
| 8 | 汇总改动与里程碑相关回归；发布前另安排 INT-03 | 可跑本轮相关全量test/build一次；cargo/tauri构建只在实际桌面里程碑，安装/发布仍需范围授权 |

FE-18～22保留后置，当前仅修订文档，不自动开传感器/桌宠；Live2D/Stage3/云Relay/评测入口/六项工作台backlog不进入本轮自动队列。TTS-05是有编号的条件验收项，不因已有SPEC而自动使用真实服务。

## 每份 SPEC 的工作循环

1. 读模块PRD/SPEC/CONTRACTS和生产代码，列修改文件及依赖；确认编号无冲突。
2. 既有工作先审阅diff、报告、测试覆盖与生产接线。只补未证实或失效证据；不能复制旧测试计数当新结果。
3. 实现最小闭环，默认关闭新外部能力；数据库测试用临时目录与fixture，不迁移/清空用户真实库。需要变更公共接口时同步契约及受影响测试。
4. 在 aika-crossplatform 运行已存在的定向测试命令，例如 npm test -- <实际测试文件>；不盲目虚构文件。记录起止时间、HEAD及dirty范围、命令、退出码、逐AC位置。超时也留状态，不把空输出当成功。
5. 检查diff无范围外改动、密钥/语料/日志污染；更新原模块report与索引，更新 docs/GOAL_RUN_LEDGER.md。
6. 符合AUTO_PASS才消费相应自动前置；否则明确PARTIAL/BLOCKED和依赖闭包，继续下一个可执行节点。

突变验证若既有SPEC要求，只在隔离副本或可精确恢复的本次文件运行，finally恢复并核对哈希。禁止在混有他人未提交改动的文件上批量还原。不能靠改断言、扩大sleep、skip用例、弱化AC过关；测试夹具问题可修，但需证明原因并保留原契约断言。

## 人工补验清单

INT-01：Tauri启动、plugin-sql实际SQL、Remote同Runtime、生产DEV默认值、F1六项交互；LLM：01/02真实质量、03自然度、05真实问答、其余Provider usage；语音：STT-03/TTS-03/INT-02及TTS-05；Inspector：浮层拖拽与聊天并行；v0.5：配对撤权、真实渠道、两个ACP权限拒绝与取消、INT-04；发布：INT-03完整门禁。每项均需在报告写可复现步骤与预期结果。

## 全文审阅后的执行细化

已全文审阅的SPEC表示设计已检查，不是生产实现REVIEWED_AUTO；波次1的生产证据审查仍需执行。参考[审阅清单](REVIEW_V0.5_AND_BACKLOG.md)。新增LLM-12在LLM-04/10后、FE-26前；与Inspector无依赖。

在实现前将每条混合AC拆记录为local-auto、real-service、browser/device、human，不改原要求。纯验收SPEC（TTS-05、INT-04真实轨、INT-03发布轨）缺真实证据时只能写准备完成/PARTIAL/NOT RUN，不能因为“没有可自动项”而空集AUTO_PASS。跨模块安全性质需要生产核心+fake外部边界，而不是全链fake。

FE-17报告分别记录pre、tauri、dev-relay、public。Tauri链只消费pre+tauri门禁；Node或public阻塞不阻塞GW-04的本地Tauri链。测试进程只绑定loopback、使用临时数据的负例是已授权自动验证，不受“真实对外监听需安全通过”条款形成自我阻塞；用户LAN/public实际暴露仍须安全门禁。

AGT-05现在包含桌面任务入口、显式远程任务命令与PC同一任务记录；没有入口接线不能直接在测试里new manager宣称产品链路完成。AGT-01会话与Run分离，结束一轮prompt不销毁多轮Session。RT-02需验证Runtime真实scope隔离，不只是Gateway按会话过滤。
