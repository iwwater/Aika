# Desktop Pet Integration Contract v1（拟定）

> 2026-09-14 · SPEC 设计契约，尚未注册生产 token；PET-02 冻结并登记共享契约。
> 需求：[RPD](RPD_DESKTOP_PET_INTEGRATION.md)。类型为接口设计，具体源码由 SPEC 实现。

## 1. 归一化端口

```ts
type PetEvent = 'thinking' | 'tool-running' | 'reviewing'
  | 'success' | 'failure' | 'attention';
type Capability = 'native' | 'mapped' | 'unsupported' | 'unknown';
type PetResult = {
  outcome: 'accepted' | 'skipped' | 'failed' | 'unknown';
  code?: 'disabled' | 'offline' | 'unsupported' | 'invalid_input'
    | 'expired' | 'stale_turn' | 'overloaded' | 'timeout'
    | 'protocol_error' | 'http_error' | 'cancelled';
};
interface PetContext {
  commandId: string;
  runtimeTurnId?: string;
  expiresAt: number; // 由注入 Clock 产生，仅本地判断，不外发
}
interface PetStatus {
  provider: 'openpet' | 'nyadeskpet';
  connection: 'disabled' | 'connecting' | 'ready' | 'offline' | 'incompatible';
  runtimeVersion?: string; // 上游未提供时不伪造
  product?: { name?: string; version?: string; upstream?: string }; // 运行时真实身份（fork 增量）
  shutdown?: { endpoint: string; version: number; auth: string; available: boolean };
  petId?: string;
  checkedAt: number;
  stale: boolean;
  capabilities: Record<'say' | 'action' | 'emotion' | 'event'
    | 'interactionEvents' | 'audio' | 'lipSync', Capability>;
  actions: string[]; // Aiki 可用的语义名；供应商映射保留在 adapter/profile 内
}
interface DesktopPetAdapter {
  status(): Promise<PetStatus>;
  say(text: string, ctx: PetContext): Promise<PetResult>;
  action(name: string, ctx: PetContext): Promise<PetResult>;
  emotion(name: string, ctx: PetContext): Promise<PetResult>;
  event(type: PetEvent, message: string | undefined,
    ctx: PetContext): Promise<PetResult>;
  /** 可选：仅当运行时声明 shutdown.available 时实现；凭据必须由调用者提供。 */
  requestExit?(token: string, ctx: PetContext): Promise<PetResult>;
  dispose(): Promise<void>;
}
```

`product` 与 `shutdown` 是**可加性新增**（见 §7）：旧运行时没有这两个字段，行为与 v1 完全一致。

`DesktopPetService` 提供 enable/disable、status、四个业务方法与状态订阅；它分配 commandId、默认 deadline 和本地 generation，业务调用者不手造这些字段。Adapter 只接收归一化命令；ProcessManager 另由 Service 注入，不放进业务接口。

所有方法在可预期网络错误时返回结果；dispose 幂等，取消请求并释放定时器。未知编程异常在 Service 边界捕获为诊断，不传播到对话编排。

## 2. 输入、传输与结果

| 项目 | v1 规则 |
| --- | --- |
| endpoint | 默认 `http://127.0.0.1:17321`；只允许 http、127.0.0.1 或 ::1、合法端口、无凭证/路径/query/fragment；localhost 在配置边界归一化为 127.0.0.1 |
| 网络 | 原生宿主固定端点表；禁用环境代理与重定向；不提供任意 URL fetch/invoke。表内四控制端点对上游与 fork 一致；`shutdown` 是 §7 登记的 fork 增量，仅由受管退出路径使用 |
| 凭据 | 只有 `shutdown` 端点接受 `Authorization: Bearer <token>`；其它端点即使附带也一律忽略。凭据不写日志、不写入错误体、不出现在快照里 |
| 文本 | trim 后为空拒绝；最多 500 Unicode code points；更长按边界截断加省略号并记录截断计数；短状态最多 80 |
| 动作/情绪 | 只接受 profile 的语义白名单；不接收路径、脚本或命令行 |
| 超时 | 单请求 1500ms；默认本地 deadline 4000ms；TTL 按剩余时间限制到 500～10000ms，剩余不足 500ms 直接 expired |
| 响应 | 限制体积 256KiB、校验状态码和 schema；超限/非 JSON/字段非法=protocol_error；未知字段可忽略 |
| accepted | 上游成功响应且通过冻结 schema；仅证明请求受理 |
| unknown | POST 发送后超时/连接中断，无法证明是否已受理；不自动补发 |
| failed | 能确定未发出或上游明确拒绝；记录代码，不泄露原始响应正文 |
| skipped | 禁用、过期、旧轮、能力缺失、去重或队列拒绝；不发网络请求 |

`commandId` 不假定上游支持幂等键。成功响应是否含 `ok` 或快照，以 PET-01 锁定版本实证冻结；不得仅靠 HTTP 200 宣布 accepted。

上游TTL只向已支持的say/event发送；action只受本地发送deadline约束，不添加未经验证的ttlMs或取消字段。动画接收后的持续时间由第三方Runtime决定。

#### 实机核对后的冻结（2026-09-14，v0.1.6 实测；不改任何条款语义）

以下已在真机确认，作为 §2 的注脚（证据：[PET-01_PROTOCOL](reports/PET-01_PROTOCOL.md)、`reports/evidence/PET-01_probes/probes.txt`）：

| 项 | 实测事实 | 对应条款 |
| --- | --- | --- |
| 成功响应 | **没有 `ok` 字段**，返回的是完整快照（含 `port`、`activePet.id`、`apiListening`、`apiError`、`apiRestartRequired`、`bubbleText`、`lastAction`、`recentEvents`）；失败体是 `{"error":…,"ok":false}` 配 400/404 | 「不得仅靠 HTTP 200 宣布 accepted」→ 判定为「2xx + 合法 JSON 对象 = 受理」 |
| `400` | 表示**请求体不合法**（`animationId is required`、`invalid JSON: …`、`expected u64`、未知 event 变体），协议本身是通的 | 「404/协议变化标 incompatible」不变；`400` 归 `failed/invalid_input`，**不得**当作 incompatible |
| `404` | `{"error":"route not found","ok":false}` | 维持 incompatible |
| 版本与动作清单 | `status` **没有** `version`，也**没有** `actions`；无 capabilities 端点 | §3「能力=profile ∩ 已验证映射 ∩ 连接状态」不变；0.5 不做版本比对，profile 只能人工核对 |
| `animationId` | 上游**不校验**（`backflip` → 200 且回显 `lastAction`）；校验发生在上游前端白名单 | §2「动作/情绪只接受 profile 的语义白名单」不变，「不靠乱发动作猜能力」由此成为必需 |
| 进程行为 | **没有单实例机制**（重复启动会产生第二个可见角色窗口）；关主窗口**不退出**；**没有协议退出端点** | §6「先 probe 再 spawn」「托管启动本身成功不等于 ready」「不得虚构 HTTP shutdown」均由实机印证；「单实例转交」分支对 v0.1.6 不可达 |

## 3. 能力来源与兼容

能力=锁定的协议 profile ∩ 当前角色已验证映射 ∩ 当前连接状态。profile 保存 provider、release/commit、角色 id、有效动作及 emotion/event 映射；它是 Aiki 映射配置，不是新 Pet Package 格式。

OpenPet 没有在本次资料中核实到通用 capabilities 端点。PET-01 查明 status 是否包含版本/动作/角色字段：有则解析，无则由人工选择的兼容 profile 补充并标明来源；未知版本或角色不猜动作。识别不出 OpenPet 的响应→incompatible，不对占端口的任意服务发 POST。

运行期间每次健康检查检测角色变化，立即失效原动作映射并重新探测；变化检查间隙仍可能发生切换，上游拒绝时刷新一次状态，不自动重发原动作。profile 不能替代实机可见性验收。

## 4. 调度与轮次

这只是有界网络发送器，不做动画排程或 BehaviorFSM。

- 每个 Service 一条串行控制通道；最多 1 在途 + 16 待发。status 探测独立，最多 1 个。
- 同轮中间 event 合并为最新一个；同轮终态到达时移除待发的中间 event。满队列先丢最旧中间 event，否则新命令 skipped/overloaded。
- 同一 session/turn 的最终文本只发一次；只消费最终 replyText，不按 token 发气泡。最近 128 个 commandId 去重缓存，最长保留 60 秒。
- 每次发送前检查 enabled、generation、当前 runtimeTurnId、deadline、能力。取消/换轮清除旧轮待发任务并 abort 在途；已送达第三方的表现无法可靠撤回。
- 无 turnId 的用户手动演示只受 generation 与 deadline 控制；不附假 turnId。
- 最终回复以有序复合任务发送：最多一个表现动作（显式 action 优先于 emotion）→say；前项失败仍可展示文本，逐项保留结果。不再补 success event 覆盖文本。无回复文本的成功任务才发 success。
- 正常探测 10 秒；离线退避 2/4/8/16/30 秒（上限 30，可加≤20% jitter）；恢复只接收新事件，不重播积压内容。

## 5. 最小事件映射

以下为语义，不假定现有 RuntimeEvent 存在同名字段；PET-04 必须登记实际事件到本表的映射。

| Aiki 展示语义 | 输出 |
| --- | --- |
| 当前轮开始生成 | event(thinking, 固定短文案) |
| 实际工具开始 / 审阅开始 | event(tool-running / reviewing)，只在真实公开事件存在时接入 |
| 最终回复 | action 或 emotion（有映射时）+ say(replyText) |
| 无文本任务成功 / 失败 | event(success / failure)，不外发原始错误堆栈 |
| 需要用户操作 | event(attention)，固定短提示 |
| 取消、换轮、退出 | 本地撤销；不虚构 cancelled / idle 上游事件 |
| 已授权的主动回复 | 复用最终回复路径；接入层不自行感知或调用 Agent |

## 6. 配置与进程端口

```json
{
  "schemaVersion": 1,
  "enabled": false,
  "provider": "openpet",
  "endpoint": "http://127.0.0.1:17321",
  "mode": "attach",
  "executablePath": null,
  "startWithAiki": false,
  "stopOwnedOnExit": false,
  "autoRestart": false,
  "profileId": null
}
```

`ProcessPort` 为宿主注入的 spawn(executablePath)、isAlive(handle)、stop(handle)；使用实参数组、不经过 shell、不接受 Agent 文本作路径/参数；进程句柄只存在内存。浏览器宿主没有此能力，不注册对应 token。

先 probe 再 spawn；发现已有兼容实例则 attach，永不接管它。managed 启动本身成功不等于 ready：最多 15 秒就绪探测，间隔 500ms；并发启动合并。持有本次 spawn 的句柄、PID 与启动身份才可停止；不得按进程名批量 kill。遇单实例转交导致子进程退出，现存服务按 attach 处理。

默认不自动重启。显式启用后仅重启确定崩溃的自有进程，5 分钟最多 2 次；用户正常退出不重启，原因不明则转离线由用户重连。disable/退出撤销重启计划；stopOwnedOnExit=false 时保留自有进程并释放所有权，下次只 attach。

stopOwnedOnExit=true：优先使用已验证退出机制；没有协议退出端点时只对自有进程句柄执行宿主终止，并在设置明确“退出时终止由 Aiki 启动的桌宠”。不得虚构 HTTP shutdown；超时 3 秒记录失败，不能拖住 Aiki 退出。fork 实现声明协议退出时的具体顺序见 §7。

## 7. PetShell 增量登记（2026-09-15，MVP-08/MVP-09）

fork 出来的 pet-shell **复用同一套线协议**：四端点的方法、路径、请求字段、成功/失败语义与 v0.1.6 逐字一致，PET-01 的 fixture 继续有效。它另有两处**新增**，都必须按本节消费，不得外推到上游：

**7.1 真实身份（`/api/status` 新增字段）**

```json
"product": { "name": "PetShell", "version": "0.6.0", "upstream": "OpenPet v0.1.6 (GPL-3.0-or-later)" }
```

`upstream` 只作署名，**不参与任何判定**。`version` 是运行时自己的版本，与上游 `version` 字段不是同一回事——上游从不提供该字段（PET-01 已实证），因此：

- 版本判定取值口径为 `runtimeVersion ?? product.version`；两者都缺时**不做**版本判定。
- 这让「改了实现却沿用旧 profile」被正确挡住：PetShell 自报 `0.6.0`，profile 也必须锁 `0.6.0`，否则能力退回 `unknown`。
- `provider` 仍是 `openpet`：线协议未变，改 provider 会波及配置与 profile 校验，收益为零。

**7.2 协议退出（`POST /api/shutdown`）**

| 项 | 值 |
| --- | --- |
| 契约版本 | `1`（`shutdown.version`） |
| 鉴权 | `Authorization: Bearer <token>`；方案名必需 |
| 凭据来源 | 派生该进程时注入的环境变量 `PET_SHELL_EXIT_TOKEN`（≥16 字符） |
| 可用性 | `shutdown.available`；缺失或 `false` 一律视为不可用 |
| 成功 | `200 {"ok":true,"shuttingDown":true,"endpoint":"/api/shutdown"}` |
| 失败 | `401` 凭据缺失/错误；`403` 本实例未启用退出；`503` 已在退出中 |

调用规则（越权退出的代价远高于少用一次新能力）：

- **只有 owned 实例**才调用；attach 路径永不携带凭据、永不请求退出。
- 凭据由 Aiki 生成、只交给本次 spawn 的子进程，只存在内存，随所有权释放而丢弃；拿不到安全随机源时**放弃**该能力，不回退到可预测的随机数。
- 401/403/503 一律判 `failed`（不是 `incompatible`）：对面仍是兼容运行时，只是这次不许退出。任一步失败即**回退到进程句柄**，终止范围不扩大。
- 协议退出成功后仍释放进程句柄（原生侧句柄表不留死条目）。
- 端口被占时该实例不绑定端口，因此**没有**协议退出通道，只能由宿主句柄回收——这是有意的，不凭端口推断所有权。

## 8. PetShell → Aiki 反向点击通道（2026-09-16，MVP-12）

§7.2 是 Aiki → shell 的授权，本节是**方向相反**的一条：它只允许「被我们派生的那个实例」把点击事实报回来。

**8.1 注入项（成对）**

| 环境变量 | 值 |
| --- | --- |
| `PET_SHELL_CLICK_URL` | `http://127.0.0.1:<系统分配端口>/api/pet/click` |
| `PET_SHELL_CLICK_TOKEN` | 一次性凭据（128 位十六进制） |

- 与退出令牌同一套规矩：只交给**本次 spawn** 的子进程，只存在内存，随所有权释放立即作废（`pet_click_disarm`）；attach 路径永不携带。
- **成对注入**：缺任一个就两个都不注入——子进程据此稳定保持「通道关闭 = 零请求」，而不是拿半套凭据去猜目标。

**8.2 受理契约**

| 项 | 值 |
| --- | --- |
| 路由 | `POST /api/pet/click`；**只监听回环**，端口由系统分配 |
| 鉴权 | `Authorization: Bearer <token>`；方案名必需 |
| 契约版本 | 请求体 `schemaVersion` 必须为 `1` |
| 请求体 | `{"schemaVersion":1,"type":"click","eventId":"<唯一>","atMs":<毫秒>,"payload":{"button":"left"}}` |
| 成功 | `200 {"ok":true,"duplicate":false}`；重复投递同为 200 但 `duplicate:true` |
| 失败 | `401` 凭据缺失/错误；`403` 当前没有实例被武装；`400` 版本不符/形状非法；`404` 其他路由 |
| 去重 | 按 `eventId`，窗口 256 条；重复投递**不再触发消费者** |
| 消费者 | 事件 `pet://click` **只发给授权主窗**（与 `foreground`/`screen` 同一条规则），不做全 WebView 广播 |

**8.3 调用规则**

- 子进程只上报事实：**不生成对话轮、不直接播动作**；是否回应、如何回应由 Aiki 决定（MVP-12 明确不预定）。
- 队列只在子进程内存里：单在途 + 有界（16），满则丢最旧并计数；重启/重连/换实例**不回放**历史点击；连接失败/超时只重试一次且沿用同一 `eventId`；`401/403` 视为凭据失效并关闭通道。
- 点击判定在子进程窗口层：按下到抬起位移 ≥4px 判为拖动（不上报），400ms 冷却窗口把双击折叠成一次。
- `pet_click_arm` / `pet_click_disarm` / `pet_click_diagnostics` 三个命令中，**前两个只允许主窗调用**；诊断读数不含凭据与目标地址。
- 未启用该能力（没有凭据）时是**零请求**：不因为「装了这个功能」而产生任何外发。
