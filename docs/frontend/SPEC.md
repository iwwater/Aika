# FE SPEC 执行索引

> 2026-09-14 最新桌宠需求：完整范围已扩为 **11份SPEC**。在原FE-18～22、27～30之外新增[FE-31](specs/FE-31.md)陪伴会话/点击对话与[FE-32](specs/FE-32.md)中英文读屏。FE-30必须最后验收新增J～N，旧九份通过不足以宣布完整交付。此要求用于worker核实当前实现并补齐，不把已有代码状态改写成完成。

需求见 [模块 PRD](PRD.md)，一次下发一份独立 SPEC。

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [FE-01](specs/FE-01.md) | Runtime 桥接与消息状态 | 已补证（2026-09-13 复核报告）：hook/presenter 143 测试全绿；页面视觉证据 NOT RUN |
| [FE-02](specs/FE-02.md) | 模式、场景与设置 | 已补证（2026-09-13 复核报告）：状态层 PASS；键盘/窄屏 AC-C 保留人工队列 |
| [FE-03](specs/FE-03.md) | 语音状态与字幕显示 | 已补证（2026-09-13 复核报告）：状态层 PASS；浏览器截图 NOT RUN |
| [FE-04](specs/FE-04.md) | 双语对照字幕去重 | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-05](specs/FE-05.md) | 失败轮重试（前置 CORE-08） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-06](specs/FE-06.md) | 撤回与重新生成（前置 FE-05） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-07](specs/FE-07.md) | 点击朗读 | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-08](specs/FE-08.md) | Rewind（回到这里） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-09](specs/FE-09.md) | 开发者模式入口与 Trace 查看页（F2/F4） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-10](specs/FE-10.md) | 能力调用视图与数据流图（F5/F6） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-11](specs/FE-11.md) | 长期记忆管理页（F7） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-12](specs/FE-12.md) | 存储浏览页与只读 SQL 控制台（F8） | REVIEWED_AUTO（2026-09-13 证据审阅：报告逐 AC 齐全，弱项见账本） |
| [FE-13](specs/FE-13.md) | 语音页露出识别语言并允许改掉 | REVIEWED_AUTO（2026-09-13：报告逐 AC 齐全，16 测试范围复跑全绿；无全量回归已记录） |
| [FE-23](specs/FE-23.md) | Live Inspector 外壳与实时订阅 | AUTO_PASS（2026-09-13）：A~C 全过，184 测试回归全绿；拖拽/窄窗目视留人工。见[验收报告](reports/FE-23_ACCEPTANCE.md) |
| [FE-24](specs/FE-24.md) | 泳道时间线、检查器与导出 | AUTO_PASS（2026-09-13）：A~D 全过，170 测试回归全绿；浮层目视留人工。见[验收报告](reports/FE-24_ACCEPTANCE.md) |
| [FE-25](specs/FE-25.md) | 上下文布局、记忆清单与实时数据流 | AUTO_PASS（2026-09-13）：A~D 全过，577 测试回归全绿；目视留人工。见[验收报告](reports/FE-25_ACCEPTANCE.md) |
| [FE-14](specs/FE-14.md) | 远程输出协议内核：OutboundChannel 与 schema v1（草案） | AUTO_PASS（2026-09-13）：A~G 全过（白名单投影/cursor 单调/重放去重/trace 四门/慢消费者限额/conformance 包+两处突变命中）；真实传输归 FE-15/16。见[验收报告](reports/FE-14_ACCEPTANCE.md) |
| [FE-17-pre](specs/FE-17.md) | 网关认证、暴露面与安全门禁（pre 步骤） | PARTIAL-pre（2026-09-13）：pre AUTO_PASS（凭证仓库/暴露策略/认证门负例全过，1244 全量全绿）；tauri/dev-relay NOT RUN；public BLOCKED。见[验收报告](reports/FE-17_ACCEPTANCE.md) |
| [FE-15](specs/FE-15.md) | Tauri HTTP传输与手机页迁移 | PARTIAL（2026-09-13）：FE-15-A 过（tauriTransport 桥 + FE-14 conformance fake invoke/listen 六用例）；B/C/D/E 需真实宿主 NOT RUN。见[验收报告](reports/FE-15_ACCEPTANCE.md) |
| [FE-16](specs/FE-16.md) | 浏览器 dev 宿主 transport 与 Node ws 中继 | PARTIAL（2026-09-14 同步索引）：本地 loopback 与 wsTransport 已实现，真实宿主装配接线与 relay 配对 NOT RUN。见[验收报告](reports/FE-16_ACCEPTANCE.md) |
| [FE-17](specs/FE-17.md) | 网关安全收口：分层开关、token 轮换与暴露面审计（草案） | READY；执行当前已审阅正文 |
| [FE-18](specs/FE-18.md) | 环境契约、生命周期、撤销与摘要 TTL | PASS（2026-09-14 模块内）：A~J 全过（43 测试：schema 防御/去重频控/TTL/generation 撤销/dispose 幂等），生产 monitor+fake source；真机传感器归 FE-19/21。见[验收报告](reports/FE-18_ACCEPTANCE.md) |
| [FE-19](specs/FE-19.md) | 前台应用、摘要授权、停止全部与可信 busy | PASS（2026-09-14 模块内）：A/E/H/I/J 全过（63 测试 + Rust 3），Rust hook 无标题采集、busy fail-closed；真机 <1s/20 次开关/锁屏 DPI **NOT RUN**。见[验收报告](reports/FE-19_ACCEPTANCE.md) |
| [FE-20](specs/FE-20.md) | 桌宠窗口、气泡与找回 | PASS（2026-09-14 逻辑轨）：F/G 全过（15 测试 + Rust 1），pet.presentation.v1 校验/淡出/竞态/权限校验；真实窗口行为（透明/拖拽/穿透/找回/DPI）**NOT RUN**。见[验收报告](reports/FE-20_ACCEPTANCE.md) |
| [FE-21](specs/FE-21.md) | 帧 diff、ROI、离线英文 OCR 与识别质量 | PASS（2026-09-14 算法与编排轨）：A~D/F~H 全过（68 测试 + Rust 5）；冻结集 120 张 P=100%/R=100%/热 P95=96ms；真机 3×10 分钟（WGC）**NOT RUN**。见[验收报告](reports/FE-21_ACCEPTANCE.md) |
| [FE-22](specs/FE-22.md) | 主动策略、授权门禁与原子发送预约 | PASS（2026-09-14 模块内）：A~J 可模块内验证项全过（325 回归含既有 proactive），共享预约/持久化对账/busy 未知不发送；真实游戏场景触发归 FE-30 **NOT RUN**。见[验收报告](reports/FE-22_ACCEPTANCE.md) |

已有适配不等于新 SPEC 全部验收通过；设备与后置范围保持原状态。FE-14…17 已合并全文审阅修订到正文（需求见 [模块 PRD](PRD.md) 对应章），按序一次只执行一份，按2026-09-13修订及GOAL_EXECUTION_PLAN下发。FE-18…22 的旧审阅结论不覆盖2026-09-14新增修订；本次按新PRD拆文档，实施依赖见下表，不强制五份串行。

## 2026-09-13 新增执行项

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [FE-23](specs/FE-23.md) | Live Inspector 外壳与实时订阅 | READY，仅本地实现 |
| [FE-24](specs/FE-24.md) | 泳道时间线、检查器与导出 | READY，仅本地实现 |
| [FE-25](specs/FE-25.md) | 上下文布局、记忆清单与实时数据流 | READY，仅本地实现 |
| [FE-26](specs/FE-26.md) | F9 Ops 成本页 | AUTO_PASS（2026-09-13）：A~D 自动 AC 全过（幂等/分页覆盖/时区日界线/未知语义/币种分离/错误率定义/最慢尝试完整计时），全量 1133 回归全绿；UI 目视与真实费用留人工。见[验收报告](reports/FE-26_ACCEPTANCE.md) |

当前执行按[安全计划](../GOAL_EXECUTION_PLAN.md)。早期无报告项状态为未核实/待补证，不认定未实现或通过；已有报告项仍待审阅。

## 2026-09-14 · 环境感知与 Live2D SPEC 拆分

需求来源：[专项 PRD](PRD_ENVIRONMENT_AND_LIVE2D.md)。本次完成规格拆分，不启动代码实现或真实采集；既有后置状态不自动改 READY。FE-27～30为新增 DRAFT，不宣称已审阅或实现。

| SPEC | 交付 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [FE-27](specs/FE-27.md) | 素材与运行时核实、manifest、表现契约 | 无环境链路依赖 | DRAFT |
| [FE-28](specs/FE-28.md) | 真实 Live2D 渲染、表情动作、失败回退 | FE-27；pet集成需FE-20 | DRAFT |
| [FE-29](specs/FE-29.md) | 实际播放能量、口型、打断与降级 | FE-27；真实pet口型需FE-20/28 | DRAFT |
| [FE-30](specs/FE-30.md) | 组合链路、权限、性能与设备验收 | FE-18～22、FE-27～29相关生产实现 | DRAFT |

环境线：FE-18→FE-19→FE-22，真实OCR场景需FE-21。FE-21算法前置FE-18，设置集成复用FE-19；算法测试可注入设置端口。窗口线FE-20独立；角色线FE-27→FE-28→FE-29。最后FE-30验组合，一次执行一份SPEC。

| PRD 需求 / 验收 | 归属 SPEC |
| --- | --- |
| SET-01～06 | FE-18生命周期、FE-19设置/授权、FE-20窗口开关、FE-21屏幕说明、FE-22最终门禁 |
| ENV-01～09 | FE-18事件/撤销/摘要；FE-19前台/标题边界；FE-21OCR/资源/质量 |
| PRO-01～07 | FE-22；busy观测归FE-19，摘要缓冲归FE-18 |
| PET-01～06 | FE-20 |
| L2D-01～03 | FE-27契约与授权、FE-28真实渲染 |
| L2D-04～06 | FE-29音频与旧会话；FE-28旧轮动作 |
| L2D-07～08 | FE-27加载生命周期、FE-28回退/渲染释放、FE-29音频订阅释放 |
| AC-01/02 | FE-18/19；组合FE-30-A/B/D |
| AC-03/04 | FE-21 |
| AC-05/06 | FE-18/19/21/22；组合FE-30-B/D/E/H |
| AC-07/08 | FE-20；组合FE-30-F/H |
| AC-09 | FE-28；组合FE-30-G |
| AC-10/11 | FE-28/29；组合FE-30-F/I |

各报告按对应SPEC输出到reports/，本次不创建未执行的验收报告。具体实现文件路径以aika-crossplatform为源码根，docs/为唯一文档根。

## 桌宠主动 / 安静陪伴追加范围

| SPEC | 交付 | 依赖与状态 |
| --- | --- | --- |
| [FE-31](specs/FE-31.md) | 开启陪伴统一入口、active/quiet、点击读屏、pet普通输入、暂停/结束 | PARTIAL（2026-09-14 生产逻辑轨）：A~F 全过（22+25+6 定向测试、Rust 31），并**首次把环境链路接进生产装配**；G 真机逐项演示 **NOT RUN**。见[验收报告](reports/FE-31_ACCEPTANCE.md) |
| [FE-32](specs/FE-32.md) | 主显示器前台可见中英文OCR、按需静止读屏、授权文字摘录上下文 | PARTIAL（2026-09-14）：C/D/E 过（投影出口/窗口回退/调度限流）；F 的双语离线加载已验（chi_sim 随包登记，生产路径实测中文/混排识别）；**A（冻结集 CER，缺真实素材）与 B（真机真实 Provider）NOT RUN**。见[验收报告](reports/FE-32_ACCEPTANCE.md) |

| [FE-33](specs/FE-33.md) | 环境链路真机装配验收（不含 Live2D） | READY，2026-09-14 新增；前置 FE-18～22/31/32 已实现且装配已接通，需真机 + 用户在场 + 一份 Provider 凭据。收口 FE-19/20/21/22/31/32 的设备遗留项；**不替代 FE-30** |

执行顺序补充：FE-32依赖基础OCR，FE-31逻辑可按端口独立做，真实会话等FE-32；FE-30完整验收在二者及渲染/口型后。**FE-33 插在 FE-30 之前**：它只验「新接上的生产装配在真机上是否真的通」，与角色线并行，不含 Live2D、不含 30 分钟组合负载。COMP-01～05归FE-31，COMP-02/06另归FE-32，COMP-07归FE-30-J～N。不要为遵守数字顺序先把FE-30标为完成。

worker交付规则：先检查已有实现和报告，对新增AC逐项列缺口，再补代码与定向测试；不得只改文档状态。未经过真实中英文读屏、pet点击对话、安静模式、真实音频/角色验证，不得宣称用户要求已实现或goal完成。

### 2026-09-14 执行后补记（本轮发现，影响所有环境线 SPEC 的结论口径）

FE-18～22 此前的 PASS **全部只是「模块内」**：生产装配里 `environmentPlugin` 从未被 `kernel.use()`，两个 source 没有任何调用方，busy 观测者没有提供方，FE-19 的环境上下文源也没进 `contextSourcesPlugin`，`ScreenState` 没有 `.manage()`。真机上一个传感器都不会启动、一条摘要都不会进请求。本轮在 FE-31 的文件范围内补齐了这条装配线（详见 [FE-31 验收报告](reports/FE-31_ACCEPTANCE.md)），但**新写的装配从未在真实 Tauri 进程里跑过**。另：本轮已恢复 `npm install` 并随包登记 `chi_sim.traineddata`（tessdata_fast 4.1.0，Apache-2.0，哈希见 THIRD_PARTY_NOTICES.md）；FE-21-F 的 120 张冻结集评估恢复可复现（P=1.00/R=1.00/热 P95=85ms），中文与混排识别在生产代码路径上验过一次。**仍缺 FE-32-A 要求的真实画面素材与人工转录**。
