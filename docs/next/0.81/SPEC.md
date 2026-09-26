# Aika Next 0.81 执行 SPEC · 基础情报采集试运行

状态：**IMPLEMENTED（N081-00～06 已实现且有自动证据；03 含真实 native 键盘、04 含真实文件 watcher）；G1～G5 实机与 N081-07 试运行 NOT_RUN，故 0.81 尚未完成、不可宣布 ACCEPTED**。日期：2026-09-25。需求权威为 [0.81 RPD](RPD.md)，目标接口见 [Collection 契约](CONTRACTS.md)，测试参数见 [双配置](TEST_PROFILES.md)。Windows 目标为 `windows/code/desktop-pet/`；已有 0.8 单帧感知和三域 Timeline 不等于本版已接线。

G1～G5 与试运行的执行顺序见 [两阶段验收计划](ACCEPTANCE_PLAN.md)：先由 Agent 独立留证，通过后再做人工实机验收；该计划不改变本页当前状态。

## 执行顺序

| SPEC | 负责边界和产物 | 前置 | 关联合格证据 |
| --- | --- | --- | --- |
| [N081-00](specs/N081-00.md) | 生产基线、来源/授权/样本/投影契约和正常/快速配置冻结 | 0.8 直接依赖核对 | 81-A～G 的测试矩阵及性能预设 |
| [N081-01](specs/N081-01.md) | 来源授权、配对、暂停/撤销、锁屏与包资源生命周期 | 00 | 81-A、81-E |
| [N081-02](specs/N081-02.md) | 本地 Collection 样本库、资产、TTL/容量、删除与恢复 | 00、01 | 81-D、81-E、81-F |
| [N081-03](specs/N081-03.md) | Windows keyboard 活动聚合与 AFK 边界 | 01、02 | 81-B |
| [N081-04](specs/N081-04.md) | 指定目录新截图的稳定读取与源身份 | 01、02 | 81-C 文件部分 |
| [N081-05](specs/N081-05.md) | 剪贴板图片订阅、来源不确定性、双通道去重 | 01、02、04 | 81-C 其余部分 |
| [N081-06](specs/N081-06.md) | 正式组合根、鉴权管理 API、Settings/回看、collection 投影与 G1～G5 实机冒烟 | 01～05；UI 修复以实际可用入口为前置 | 81-A～F、G1～G5 |
| [N081-07](specs/N081-07.md) | 有界自然使用试运行、质量/资源报告与版本收口 | 06 放行且用户在产品中启用 | 81-G、版本验收 |

| 已完成 | 证据 |
| --- | --- |
| N081-00 契约/配置层 | [reports/N081-00.md](reports/N081-00.md)：`contracts/collection.ts`、`EventDomain` 扩 `collection`、`npm run test:next081` 5/5 pass、`dev:next081:smoke` 隔离根 |
| N081-01 授权组件层 | [reports/N081-01.md](reports/N081-01.md)：`core/collection-grants.ts` 状态机 + `assertActive` 代次复检 + lease/宿主释放绑定，6/6 pass |
| N081-02 存储组件层 | [reports/N081-02.md](reports/N081-02.md)：`memory/collection-store.ts` 增量表 + 受管资产 + TTL/容量 + tombstone + 崩溃恢复，6/6 pass |
| N081-03 键盘来源 | [reports/N081-03.md](reports/N081-03.md)：`desktop/collection/collection-helper.cpp` 真实 Raw Input 聚合 + `build:collection` 产物；实机注入 24 次按键得到无键码桶，5/5 pass |
| N081-04 截图目录来源 | [reports/N081-04.md](reports/N081-04.md)：`core/screenshot-directory-source.ts` realpath 双重边界 + 稳定判定 + 有界补扫；真实 `fs.watch` 验证基线排除，5/5 pass |
| N081-05 剪贴板来源与去重 | [reports/N081-05.md](reports/N081-05.md)：`core/clipboard-image-source.ts` sequence 复验 + 有界重试 + 一对一精确关联；`service.correlateImage` 可重算，6/6 pass |
| N081-06 管理面与组合根 | [reports/N081-06.md](reports/N081-06.md)：`management/collection-routes.ts` + `collection-management.ts` + `app/trial-backend.ts` 正式装配 + 控制台页；G1/G2/G3 三大来源（键盘、目录、剪贴板）实机完整通过，6/6 pass |
| N081-07 试运行工具 | [reports/N081-07.md](reports/N081-07.md)：`tools/next081-trial-report.mjs` 只读聚合日报 + 隐私守卫；5/5 pass。**试运行本身 NOT_RUN** |
| 性能实测工具 | `npm run measure:next081`（`tools/measure-next081-resources.mjs` + `desktop/collection/perf-probe.cpp`）：真实进程实测并自证探针存活；首轮结果见 [N081-00 §6.1](reports/N081-00.md) |

### 仍未完成（阻塞 0.81 完成）

| 项 | 状态 | 阻塞原因 |
| --- | --- | --- |
| G1 基础运行 | **实机 PASS（2026-09-25）** | 真实 Electron + `trial-backend` 启动、Live2D 加载、管理 API 200；见 [N081-06 §8.2](reports/N081-06.md) |
| G2 来源权限 | **实机 PASS** | 默认三来源 `disabled`、无确认激活 HTTP 403、带确认 200、helper 仅在授权后出现 |
| G3 可回放存储 | **三大来源实机 PASS** | 键盘（20 组按键 → accepted=1, 40 次计数, 无键码）、目录（真实 PNG 写入 → accepted=1, 重写 dup=1, 原图保留）、剪贴板（WinForms 复制 → BMP 入库 accepted=1）；样本删除后 404 |
| G4 最小入口 | NOT_RUN | 需人工在真实界面点通；API 观测不能替代用户体感 |
| G5 实机第三方冒烟 | NOT_RUN | 真实第三方截图工具（微信/QQ/Snipping Tool）/ 真实系统锁屏（Win+L）需人工触发一次 |
| 性能通过线 | 未写入（模板已就位） | N081-00 §6.1 已有首轮受控实测（含双来源并发）；[perf-thresholds.template.json](perf-thresholds.template.json) 五行仍为 `null` |
| 并发首次键盘写入停顿 | **已关闭（测量方法问题）** | N081-00 §6.2：定位为 `Promise.all` 中首次 await 吸收对方同步批次时长；排除首样本后并发 p95 键盘 9.18 ms / 图片 13.37 ms、零停顿 |
| 文字聊天首字延迟（采集开启时） | NOT_RUN | 需真实模型凭据与人工对话 |
| N081-07 三日自然使用（≥3 日、累计 8 小时）与人工标注（≥20 图片、≥10 keyboard 片段） | NOT_RUN | 依赖 G4/G5 与用户在产品中实际启用来源 |

以上任一未完成前，不得宣布 0.81 完成、不得标 `ACCEPTED`，也不得标"可开始正常试运行"或"限定双源试采"。

00 → 01 → 02；03、04 在共同前置满足后可各自实施；05 需 04 的双通道身份规则；06 做真实接线，07 才能开始三日自然使用评估。某来源先通过时可在 06 的正式管理控制下做**限定来源的受控试采**，如实标记其余来源未就绪；不能以此代替完整 G5 或宣布 0.81 完成。keyboard 与截图目录达到 G1～G4 并各有真实冒烟，可开始双源限定试采；剪贴板图片最终仍是本版必需项。G1～G5 全部通过后可开始正常配置的长期试运行，不等待 OCR/VLM、0.85 或整版 0.8 发布。

## 共用执行规则

1. 正式采集默认关闭。只有用户在产品中选择来源和目录、看见本地留存范围并启用后才开始；自动测试须隔离数据根并显式提供测试授权。`smoke` 配置不能绕过授权、鉴权、配对、路径边界或删除语义。每份 N081 SPEC 的“接口与范围”是该步必须交付的边界；[共用契约](CONTRACTS.md)不是替代各步验收。
2. 可复用 0.65 的资源释放、事件与包接口以及 0.8 的管理基础设施；新增持续采集授权与 0.8 的 `CaptureGrant`/临时 `Observation` 并存，不把 2 分钟 Observation TTL 扩到 7 天。
3. Collection 是持久来源权威。高频按键通知只在 adapter 内聚合，不传键码、字符或逐键序列；图片留在受管本地资产。Timeline、Dashboard 只读投影，不能另存不受撤销控制的正文。采集不调用模型、不自动邀请或晋升 Memory。
4. 新 schema/API 先写兼容与直接消费者测试，再做最小生产实现。测试中的 fake clock、fixture 图片可隔离外部输入，**被测授权、存储、投影和正式组合根不得用 fake 代替**。独立脚本采到图片仅证明 adapter，不证明 0.81 放行。
5. 每步报告放 `reports/N081-XX.md`（实施时创建），记录源码修订、配置档、测试命令/退出码、fixture/正式进程/实机区别、未运行项及下步。状态为 NOT_STARTED、IN_PROGRESS、AUTO_PASS、BLOCKED、NOT_RUN 等实际证据，不因文件存在或测试绿灯代签真实采集。

## 两套配置与测试节奏

采用 [正常 `normal` 与快速 `smoke`](TEST_PROFILES.md)。自动测试优先 fake clock 跳过 TTL/AFK 等等待；需要真实 watcher/键盘/剪贴板时显式启动隔离的 `smoke` 实例。试运行 N081-07 使用 `normal`；不得把 `smoke` 的短留存和紧容量当产品默认，也不得自动从 smoke 改成 normal 后继续复用同一授权或数据根。

实施时在 `package.json` 增加实际可运行的 0.81 定向测试入口并在报告中给出命令；已落地 `test:next081`（`tools/run-tests.mjs next081`，目录为空时 exit 2）、`dev:next081:smoke`（`tools/run-next081-smoke.mjs`，准备独立测试根且默认零授权）、`build:collection`（构建受控 helper，缺失时来源报 unavailable）、`report:next081`（只读聚合日报）、`measure:next081`（资源与写入时延实测）、`check:next081:pin`（判定实机 G1～G5 的环境前置）。`build:windows` 已纳入 `build:collection`。现有 `npm run check`、`npm run build`、`npm run build:desktop` 用于对应变更的类型与构建验证，自动运行和 Electron/实机结果分列。

## 放行与完成判定

| 阶段 | 可宣布的状态 | 不能推论 |
| --- | --- | --- |
| 00～05 定向自动通过 | 来源模块具备可接线实现 | 用户实机可采、G1～G5 已过 |
| 06 正式进程和实机 G1～G5 通过 | 可以在用户主动启用后开始正常试运行 | 三日价值/资源结论、0.81 ACCEPTED |
| 07 完成 3 使用日/累计 8 小时、20 图片/10 活动片段标注和问题报告，自动门槛仍通过 | AUTO_PASS / READY_FOR_ACCEPTANCE，按证据决定 | 用户已验收；用户确认前不得写 ACCEPTED |

安全硬门槛：零越权、零 keyboard 正文落盘、删除不复活、资源有界、原图不被清理。质量与性能阈值在 00 开发前冻结，不得测试后改线；未达到时修复或记录 BLOCKED。现有 0.79/0.8 未过的独立门槛保持原状态，0.81 的局部通过不替其验收。
