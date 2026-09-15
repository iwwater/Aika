# MVP-04 验收 · OCR Observation 与陪伴

2026-09-14 立稿 / 2026-09-15 真机补跑。依据 [RPD](../../RPD_MVP_0.5.md) MVP-R04、[SPEC](../specs/MVP-04.md)。前置 MVP-01/03 已收口（见 [MVP-03 报告](MVP-03_ACCEPTANCE.md)）。

## 结论

| AC | 状态 | 一句话 |
| --- | --- | --- |
| A | **PASS** | 生产词表规则（含 PENTAKILL / victory / defeat / build failed）→ schema 规范化只留受控字段；重复帧合并与越界/低置信度拒绝都有用例 |
| B | **PASS**（观察路径） | OCR 未启用/暂停/锁屏后旧结果不进 Context 或 Agent；quiet 与 busy（含**新增的锁屏**）都不触发自动轮。FE-31 会话路径的 quiet/在途门禁仍未接线，见 §4 |
| C | **PASS** | 真规则 → 上下文源 → **生产 Runtime** → fake Provider → 桌宠表现端口：恰好一次生成、上下文含该观察、桌宠收到正文与情绪；环境层源码无桌宠 import |
| D | **PASS（device）** | 演示窗覆盖 ROI → 真实 OCR → 真实 Provider 轮落库（回复正确引用 pentakill 观察）；桌宠侧三类命令经 `pet_command` 诊断全部 `accepted`（17:03 轮）。原「say/emotion 未送达」经真机对照实验证实为**测量口径错误**（`recentEvents` 结构上不含 say/action），已更正。见 §2 AC-D |
| E | **PASS** | 观察层故障不进普通对话路径；屏幕文字未授权时一句原文都出不去（含锁屏这一新挡点） |

本轮**修掉一个真缺口（锁屏）**，并第一次把「观察 → 一轮生成 → 表现」这条链在**全生产实现**上端到端验证（AC-C）。

## 1. 本轮改动

| 位置 | 改动 | 为什么 |
| --- | --- | --- |
| `services/environment/busySource.ts` | 新增 `BUSY_REASON_LOCKED`、`BusyReading`、`readBusyObservation()` | 宿主本来就把「锁定」`session_locked` 与「全屏」`fullscreen` 分开报，但消费方只拿到一个布尔。把「刷新 + 时效 + 是否锁定」收口成一个读法，避免各处重写 |
| `presentation/environmentTrigger.ts` | 锁屏门禁：`session_locked` → 不发送 + **清空缓冲**；决策后的复核同样挡住锁屏 | 锁屏时用户不在桌面前；留着锁屏期间累计的「持续时长」会在解锁后补一轮 |
| `services/environment/contextSource.ts` | 屏幕文字摘录源新增可选 `isLocked`：锁屏时零摘录 | 摘录是**锁屏之前**那一眼的画面，TTL 最长 60 秒——不挡就会在用户离开桌子之后继续进模型 |
| `app/plugins/contextSourcesPlugin.ts` | 把 busy 观测注入摘录源（宿主没有该能力时不传） | 生产装配点；浏览器/测试装配行为不变 |
| 测试 | `environmentTrigger.test.ts` +2、`contextSource.test.ts` +2、`busySource.test.ts` +2、新增 `mvp04Observation.test.ts`（5）、新增 `app/mvp04ObservationTurn.test.ts`（4） | 见下逐 AC |

**语义边界（刻意保留，不是漏改）**：`busy=true + 全屏` 仍放行结算类候选（victory/defeat/pentakill）。这是 FE-22 冻结的产品决定——全屏=在玩游戏，结算类事件正是陪伴的触发点；锁屏是另一回事（用户不在）。代码里两条分支分开写、两条用例分别钉住。

## 2. 逐 AC 证据

### AC-A 明确规则 → 规范化 Observation；重复帧合并、低置信度拒绝 —— PASS

`src/services/environment/mvp04Observation.test.ts`（5 项，全生产实现）：

- 词表含 `pentakill` / `victory` / `defeat` / `failed` / `error`；`PENTAKILL!`、`Victory`、`DEFEAT`、`npm run build failed`、`some error happened` 都能命中对应规则（大小写与词边界无关）。
- 规范化结果 `payload` 只有 `kind` + 词表 ID 两个键，原文与标题进不来（`JSON.stringify(event)` 里搜不到哨兵串）。
- 重复帧合并：同一屏同一规则连发两次，去重窗口内只广播一次（`dedupeDropped=1`），窗口过后算新事件。
- 拒绝边界：`confidence=1.4` 在 schema 入口被拒（不广播、不进 recent、`schemaRejected=1`）；`0.4` 是合法观察，由策略层决定「值不值得说」。缺词级证据时置信度是保守的 `0.5`，过不了 FE-22 的 0.8 结算线——这是设计行为，用例显式钉住。

### AC-B OCR OFF / 暂停 / 锁定后旧结果不进 Context 或 Agent；quiet 与 busy 不触发自动轮 —— PASS（观察路径）

- **未启用/未运行**：`app/mvp04ObservationTurn.test.ts` 里 sensor 停在 `off` 时，事件进不了 monitor（`recent()` 为空）、零生成。
- **锁屏（本轮新修）**：`environmentTrigger.test.ts` 增两条——锁屏时连结算类候选也不发、`lastDecision.reason="session-locked"`、缓冲被清空且解锁后不补发；而 `fullscreen` 仍照常触发结算（两条用例把这对语义分开钉住）。`contextSource.test.ts` 增两条——锁屏时同一份仍在 TTL 内的摘录零产出、解锁后立刻恢复；不提供锁屏观测时行为与之前一致。`busySource.test.ts` 增两条——`readBusyObservation` 只报**确认过的**锁定（无观测者/查询失败/观测过期一律 `null+false`），耗时超过观测有效期的锁定不算数。
- **quiet**：FE-22 路径的勿扰时段与每日上限、最小间隔由 `canSend()` 终审（既有用例覆盖）；FE-31 会话的 `mode !== "active"` 门在控制器里（22 项用例覆盖）——但该路径仍未接线，见 §4。
- **busy unknown**：既有 `PRO-04` 用例（未知一律不发）继续通过。

### AC-C 生产规则 → 上下文源 → 生产 Runtime → fake Provider → 表现端口，恰好一次生成且含观察 —— PASS

`src/app/mvp04ObservationTurn.test.ts`（4 项）。除外部世界（传感器、LLM、桌宠进程）外全部生产实现：`monitor` / `environmentTrigger` / `ruleProactivePolicy` / `createEnvironmentContextSource` / `createScreenTextContextSource` / `CompanionRuntime` / `desktopPetPresenter` + 生产 `createDesktopPetService`（只换掉 adapter 与 Provider）。

- 同一屏重复帧 → **恰好一次生成**（Provider 只被调用一次）；组装出的上下文里带着这次的规则 ID `pentakill`；桌宠端口收到 `say(["五杀！这一局结束得漂亮。"])` 与 `emotion(["happy"])`（情绪来自 `happy → jumping` 的生产映射）。
- 屏幕文字授权开 → 摘录随上下文进入；关 → 同一轮仍在（观察是观察、原文是原文），但原文一句都不出。
- **OCR 不直接调用桌宠**：源码边界检查——`services/environment/*.ts`（非测试）里没有任何 import 指向 `desktopPet` 或 `presentation`。

### AC-D 实际非私人画面 → 真实 OCR → Agent → 外部桌宠演示 —— PASS（device，2026-09-15 补跑）

按 §5 runbook 在真机执行（用户授权）：

- **演示窗**：无边框置顶窗口精确覆盖主屏 ROI 横带（x 10–90%、y 40–60%），内容每 4s 在 PENTAKILL / VICTORY / ERROR / DEFEAT 间轮换——采集到的画面**只有演示内容**（截图取证 `%TEMP%\roi_demo.png`，未入本人私人画面）。
- **真实链路取证**：演示配置写入后启动 debug 宿主 → 真实 WGC 帧差触发 → 真实 OCR（tesseract，词级置信度）→ 词表命中 → 门禁 → **真实 DeepSeek 生成** → 回复落库：`messages` 表新增 `assistant | proactive | さっき画面に「pentakill」って一瞬出てた。……誰かがすごいことをやり遂げた瞬間って…`（00:08:46）——回复语义正确引用了这次观察。
- **桌宠侧**：OpenPet `/api/status` 收到该轮的 `thinking` 事件（`{"eventType":"thinking","bubbleText":"让我想一下……"}`，两次真实轮各一条）——OCR→触发→生成→桌宠通知链路为真。
- **~~未达成：say/emotion 未出现~~ —— 更正：这是测量口径错误，不是产品缺口（2026-09-15）**。原判据是「`recentEvents` 里只有 thinking、`lastAction` 停在 waiting」。真机对照实验推翻了它：
  - `POST /api/action`（`animationId=waving`）→ `lastAction` 变为 `waving`，**`recentEvents` 计数不变**；
  - `POST /api/say`（`ttlMs=3000`）→ `bubbleText` 出现该句，**`recentEvents` 计数不变**。
  - 即 `recentEvents` **只记录 `event` 类型调用**（thinking / success / failure），say 只体现在 `bubbleText`、action/emotion 只体现在 `lastAction`。用 `recentEvents` 判断 say/emotion 是否送达，本身就读了一个结构上不可能显示它们的通道。
  - 且那次回复的 `mood` 是 `thinking`，其 emotion 映射与 thinking 命令同为 `waiting` —— `lastAction=waiting` 也不能作为「emotion 未送达」的证据。
- **正确口径下的取证（2026-09-15 17:03，仍是真机、仍是 proactive 轮）**：新增的 `pet_command` 诊断（见下）逐命令落盘——`event`(thinking) `accepted` @17:03:27、`emotion` `accepted` @17:03:32、`say` `accepted` @17:03:32；同一轮回复落库（`messages`：`assistant | proactive | …pentakill…`）。**三类命令全部被上游受理**，OCR→Agent→桌宠链路完整。
- **第二条独立取证（2026-09-15 18:34，release 构建）**：时间驱动的 proactive 轮（mood `gentle_smile`，77 字正文）——`pet_command`：`event` `accepted` @18:34:02、`emotion` `accepted` @18:34:06、`say` `accepted` @18:34:06；轮次 `turn_end completed`（4214ms，firstToken 3554ms）。**上游侧状态同时可见结果**：OpenPet `/api/status` 的 `lastAction=waving`——正是 `gentle_smile → waving` 的映射，说明 emotion 命令**真的改变了桌宠动作**（17:03 那轮 mood 是 `thinking`、映射同为 `waiting`，所以读数上看不出差别，这也是当初误判的成因之一）。
- 为此补的可观测性（本轮新增，值得保留）：`trace` 新增 `pet_command` 事件（command/outcome/code，**永不带正文**），presenter `onDiagnostic` 接到 trace sink，Inspector 可查；这是「桌宠为什么没反应」从「靠目测」变成「看数据」的那一步。
- **开放问题**：宿主进程此前多次自行退出（3～24 分钟不等，stderr 无 panic、无崩溃转储；不排除窗口被手动关闭）。2026-09-15 17:02 启动的那次持续运行超过 15 分钟未见异常，仍未定论。

### AC-E 观察故障不阻断普通对话；OCR 原文无授权不外发/入长期记忆 —— PASS

- **观察故障不阻断**：`contextAssembler` 的源级降级与既有用例覆盖（源抛错 → 该源零 snippet、其余来源与生成照常）；本轮的集成用例里两条屏幕来源与普通对话共用同一 Runtime，未授权/锁屏只是「零摘录」，不产生错误。
- **原文不外发**：`contextSource.test.ts`（含本轮新增的锁屏条目）+ AC-C 的授权开关对照——只有 `environment.screenTextEnabled` 打开时才可能出现摘录，且摘录来自内存中的 `current()`，本模块不写日志、不写 Trace、不落库、不发原图（既有 SPEC 冻结边界，本轮未放宽）。
- **不入长期记忆**：观察事件与摘录都不经过记忆写入路径；记忆候选仍只由模型回复的 `memoryCandidates` + 既有确认规则产生（本轮的改动没有触碰记忆通道）。

## 3. 测试与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/services/environment src/presentation src/app src/domain src/kernel` | **81 files passed / 1 skipped；949 passed / 1 skipped；exit 0** |
| `npx vitest run src/app/mvp04ObservationTurn.test.ts` | 4 passed；exit 0 |
| `npx vitest run src/services/environment/mvp04Observation.test.ts src/services/environment/busySource.test.ts src/presentation/environmentTrigger.test.ts src/services/environment/contextSource.test.ts` | 32 passed；exit 0 |
| `npx tsc --noEmit` | exit 0 |

> 注：跑 `src/services/environment` 会执行 OCR 评估用例，它会**写回**
> `services/environment/fixtures/eval-results.json`（本机真实 OCR 时延与 `generatedAt`）。
> 因此工作区里这份文件的 diff 是测试产物、不是手工改动；接手时它已经是脏的
> （前一位执行者的运行留下的），当前值是本轮运行的结果（`hotOcrP95Ms` 124ms，门槛 2000ms）。
> 审阅时请按「可再生证据」看待，不要与源码改动混在一起。

## 4. 发现的既有缺陷与未接线处（本轮**未**修，逐个说明理由）

1. **FE-31 会话的自动路径仍然没有生产触发源**（MVP-03 已记录）：`CompanionSessionController.onScreenChanged` 只有测试调用者。本轮**没有**给它接线，理由是它会与已经工作的 FE-22 触发路径形成**两条并行自动轮**——同一屏变化可能各发一轮，正是 RPD 明确要避免的重复编排。**这是需要你决定的方向题**：要么给 `onScreenChanged` 接一个与众不同的触发源（例如只读屏不产语义事件时），要么把这条路径退役、把 FE-31 的「自动读屏」收敛到 FE-22 的观察触发上。我倾向后者，但它改的是产品行为，不在 MVP-04 授权范围内。
2. ~~**OCR 额度名义上共享、实际是两份**~~：**已修复（后续阶段）**——`app/hosts/index.ts` 装配处现在先建一份 `captureScheduler`，同时注入 `createScreenSource`（词表轨）与 `environmentHostPlugin`（注册 `CaptureSchedulerToken` 给全文轨），两轨真正共用 10 次/分钟；`environmentHostPlugin` 也接受 `options.scheduler` 注入同一实例。两条「共用」注释现在与实现一致。
3. **`ruleProactivePolicy` 里有一段等价分支**：`userBusy === false` 与 `busy=true` 对结算类候选返回完全相同的决定（第 69–74 行）。当前不是 bug（两条分支等价是刻意的「busy=true 仅允许结算类」），但读起来像漏了分支，建议合并并保留注释说明。
4. **`environmentTrigger` 的一条分支只对非前台事件有效**（`eventRuleId !== null` 与随后的比较对 `foreground_changed` 恒为假，靠 `isForeground` 兜底）：不影响行为，属可读性问题。

## 5. AC-D 的 runbook（条件具备，供下一步执行）

已核实具备的条件：本机装有原版 OpenPet（`%LOCALAPPDATA%\OpenPet\openpet.exe`，`127.0.0.1:17321`）、OCR 引擎与词表随包（`eng`/`chi_sim` 语言数据）、真实 Provider 可用（DeepSeek，本会话内实测有回复）。

需要执行的动作（按顺序）：

1. 写设置：`environment.screenEnabled=true`、`environment.contextEnabled=true`、`environment.proactiveEnabled=true`、`environment.foregroundEnabled=true`、`proactive={"enabled":true,...}`、`pet.desktopIntegration.v1.enabled=true`（当前已是 true）——直接写 `%APPDATA%\com.aika.companion\aika.db` 可免去逐项点击。
2. 启动 OpenPet，再启动 Aiki 宿主（debug + `custom-protocol`）。
3. **用任务相关演示窗口覆盖主屏中央 ROI**（例如最大化一个写着 `PENTAKILL` 的记事本）：ROI 是主屏中央固定区域，只有让演示窗口占满它，采集到的才**全是**演示内容，不碰用户私人画面。
4. 触发一次画面变化（例如在演示窗口里切一行字），等 10 秒周期内的采集 → 词表命中 → `game_event pentakill` → 触发一轮。
5. 核对：Aiki 出一轮带该观察的回复 + OpenPet 的 `/api/status` 里出现对应气泡/动作（沿用 PET-07 的取证手法）。

**本轮不做它的原因**：它需要短暂覆盖用户当前正在使用的屏幕中央，并把四个开关一起打开；用户正在本机工作，我没有在无人确认的情况下做这件事。上面第 3 步也是「不读私人画面」这条要求在本机的唯一可行做法——任何不覆盖 ROI 的演示都会连带读到用户正在看的内容。

## 6. 共享接口影响

- `ScreenTextContextSourceDeps.isLocked?`：**可选新增**，不传即旧行为（浏览器/测试装配不受影响）。消费方只有 `contextSourcesPlugin`。
- `busySource` 新增导出（`BUSY_REASON_LOCKED` / `BusyReading` / `readBusyObservation`）：纯新增，既有 `createBusyObserver` / `EnvironmentBusyObserverToken` 语义未动。
- `environmentTrigger` 的行为变化：新增「锁屏不发送」这一条红线，`snapshot().lastDecision.reason` 可能取到 `session-locked`（诊断可见）。`BUSY_MAX_AGE_MS` 等既有导出保持不变。
- 未改任何跨模块公共契约，`docs/modules/CONTRACTS.md` 无需登记。

## 7. 下一步

MVP-05（七场景隔离矩阵）依赖 MVP-02～04；本轮结论可直接用于它的「Pet ON / OCR OFF」「Pet OFF / OCR ON」两格。§4 的第 1 项需要你先定方向（补触发源还是退役该路径），否则 MVP-05 的隔离矩阵里「quiet 下不自动轮」这一格只能按 FE-22 路径记。
