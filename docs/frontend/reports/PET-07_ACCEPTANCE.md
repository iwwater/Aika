# PET-07 验收报告 · Windows OpenPet 闭环（跨模块里程碑）

> 2026-09-14 立稿 / 2026-09-15 补强 · 需求 DPI-07 · [SPEC](../specs/PET-07.md) · 协议 [PET-01_PROTOCOL.md](PET-01_PROTOCOL.md)
>
> ## 结论：**Aiki 宿主侧闭环成立——PET-07-A/B PASS（device）**。含真机核对修出的三个缺陷。
> 其余 AC：**C/G/H/I NOT RUN**、**D/E/F/J 部分 PASS（F 含 BLOCKED 项）**。逐条见 §3。**不宣告本 SPEC 整体 PASS。**
>
> 本轮在本机装好并跑通了**原版 OpenPet v0.1.6**，把 SPEC 里所有「需要上游真实行为」的前置
> 一次性取证（§2），并在 **Aiki 桌面宿主**上跑通了真正的闭环：一轮真实对话 →
> 原生传输 → 桌宠先「让我想一下……」（`recentEvents` 取证）→ 回复气泡（用户目视确认）
> → 情绪动作（`lastAction=waving`，与 `gentle_smile → waving` 映射一致）。
>
> 真机核对的价值在本轮体现得很直接：模块级全绿的同时，链路**其实是断的**——
> 一个带下划线的 mood 名让整份 profile 静默失效（§2.3 缺陷 1）。修完才通。
> 仍未取证的是 **PET-07-C/G/H/I**，以及 D/E/F/J 中标注为部分的那些项，逐条见 §3。

## 1. 前置状态

| SPEC | 状态 |
| --- | --- |
| PET-01 | **A～E 全 PASS（device）**：实机装上原版、四端点、协议形状、可见性、进程行为全部取证 |
| PET-02 | A～F PASS（模块级，fake adapter） |
| PET-03 | A～E PASS + **实机复核追加**（含一处 `400` 判定缺陷的修正） |
| PET-04 | A～H PASS（fake Runtime/Adapter/Clock；H = 气泡存活时长与发送期限拆成两个字段） |
| PET-05 | A～G PASS（假进程端口 + 受控测试进程） |
| PET-06 | A～G PASS（生产装配 + 假外部端口） |

工程侧本轮复核：

```text
npx vitest run src/services/desktopPet src/app/hosts src/presentation/desktopPetPresenter.test.ts
→ Test Files 7 passed (7) / Tests 105 passed (105) / exit 0
cargo test --offline desktop_pet   （前一轮）→ 10 passed / 0 failed / exit 0
```

## 2. 本轮已取证（OpenPet 侧，device）

| 项 | 结果 |
| --- | --- |
| 安装与运行 | 官方 v0.1.6 NSIS 静默安装（按用户、无管理员），运行程序 `…\Local\OpenPet\openpet.exe`，`127.0.0.1:17321` 在监听 |
| 角色可见 + 中文无乱码 | 截图 `evidence/PET-01_pet_bubble.png`（气泡正文「爱花验收：气泡可见性 回来啦」渲染正确） |
| 气泡受理可核 | `POST /api/say` 后快照的 `bubbleText` / `lastAction` / `recentEvents` 都能读到；服务端把正文截到 512 字符 |
| 动作可见 | 精灵区域（144×156，5616 采样点）像素差：待机对照 **1645**；`jumping` **3147**、`waving` **2482**、`failed` **2221**、`running` **1901** ⇒ 明显高于待机；`waiting` **1754**、`review` **1715** 落在待机带内 ⇒ **未证明可见差异**（如实记录，不外推） |
| 未知动作 | `backflip` → **200**、`lastAction=backflip`，像素差 **1605**（低于待机对照 1645）⇒ **无可分辨效果**；`idle`（合法动画但不在动作白名单）同样 **1667** |
| 权威动作清单 | 锁定 commit 的 `src/pet/animation.ts`：`PET_ACTION_ANIMATION_IDS = waving, jumping, waiting, running, review, failed`（另有非动作的 `idle`/`running-left`/`running-right`）；图集 1536×1872、8×9、单格 192×208。窗口 340×296 与该文件的 `getPetSurfaceSize` 计算完全一致（144×156 精灵 + 140 气泡区） |
| 非法输入 | 空白 `animationId` → 400 `animationId is required`；未知 event 变体 → 400 并列出 6 值枚举；坏 JSON → 400；`ttlMs` 非 u64 → 400 |
| 端口被占 | 先用 python 占住 17321 再启动 OpenPet → 进程照常存活、**不抢占端口**、不崩溃，API 静默不可用 |
| 退出与单实例 | `CloseMainWindow()` 返回 True 但**进程不退出**（驻留托盘、端口继续监听）；强制结束 → 端口立即释放；**没有单实例机制**（第二个实例照常存活并显示自己的窗口）；**没有协议退出端点** |

### 2.1 可直接使用的 profile（`nia`，已按权威清单核对）

```json
{
  "schemaVersion": 1,
  "provider": "openpet",
  "release": "v0.1.6",
  "petId": "nia",
  "source": "manual",
  "actions": {
    "wave": "waving", "jump": "jumping", "wait": "waiting",
    "run": "running", "review": "review", "fail": "failed"
  },
  "emotions": {
    "neutral": "waiting", "gentle_smile": "waving", "happy": "jumping",
    "shy": "waiting", "surprised": "jumping", "thinking": "waiting", "concerned": "failed"
  },
  "events": {}
}
```

说明：`actions` 的**值**来自上游权威清单（因此一定存在于图集）；`emotions` 是 Aiki 的语义
到上游动画的人工映射，`waiting`/`review` 两项的可见差异尚未被证（见 §2）。`events` 留空
表示同名直传——上游的事件枚举与 `PetEvent` 逐字一致。**替换角色后必须重新核对**
（`petId` 不符时能力会自动降级，不会拿旧映射乱发）。

### 2.2 Aiki 宿主侧（本轮新增）

| 项 | 结果 |
| --- | --- |
| 宿主构建 | `npm run build`（vite，5.13s）+ `cargo build --offline --features custom-protocol`（1m27s）→ `src-tauri/target/debug/aika-crossplatform.exe`（内嵌前端资源，可独立运行） |
| 宿主运行与渲染 | 进程存活、主窗标题「愛花 Aika」、界面正常渲染（截图 `evidence/PET-07_aiki_host.png`） |
| **生产链路真的通了** | 用日志型替身占住 `127.0.0.1:17321` 后启动宿主，替身记录到：`GET /api/status` 于 `11:58:10.395` / `11:58:20.416` / `11:58:30.427` —— **间隔 10 秒**（与契约 §4「正常探测 10 秒」一致），且**只有这一个端点**、GET 无 body。该请求经 Rust 原生传输（`desktop_pet_http_request`）发出，**不经过 WebView，因此与浏览器 CORS 无关** |
| 装配语义 | 把 `enabled=true` + profile 预置进设置库（`%APPDATA%\com.aika.companion\aika.db`）后，宿主启动即**自动启用并周期探测**，全程无需点击；同时 `pet.windowEnabled=true` 时**没有出现自研桌宠窗口** → PET-06 的「表现出口只保留一个」在真机上成立 |

**仍未取证的最后一环：say/action 一侧。** 演示按钮与真实对话轮次都需要一次 UI 交互
（新库没有 Provider Key，无法产生真实轮次），而宿主窗口被其它程序盖住、`SetForegroundWindow`
被系统拒绝。我尝试过 GUI 自动化，但**第一次点击落到了别的窗口上**（这是我的失误），
随后加了 `WindowFromPoint` 的进程归属校验，确认 Aiki 当时不在目标位置，遂停止代点。
这一步留给用户点一次，或给一个可用 Key 走真实轮次。

### 2.3 真机核对撞出的两个缺陷（本轮修复）

**缺陷 1（真缺陷，严重）：一个带下划线的 mood 名会让整份 profile 静默失效。**

- 现象：宿主已启用集成、OpenPet 可达、用户真的发过一轮并拿到回复，但
  `/api/status` 里 `recentEvents=0`、`bubbleText=null`、`lastAction=null` —— **桌宠一条命令都没收到**。
- 根因：`SEMANTIC_NAME = /^[a-z][a-z0-9-]{0,47}$/` **不允许下划线**，而 Aiki 自己的
  `MOODS`（`src/domain/mood.ts`）里有 `gentle_smile`。profile 里写这个键 → `validatePetProfile`
  返回 null → 能力全部降为 `unknown` → 每一条命令都在 `prepare()` 被静默跳过。
- 为什么模块测试没抓到：PET-02 的用例用的 mood 是 `happy`，假 Runtime/假 adapter 也照我的
  假设构造，所以形状与词表的不一致完全没被覆盖。**只有真机跑一轮才会暴露。**
- 修复：`SEMANTIC_NAME` 允许下划线（仍拒绝斜杠、点、冒号、空白、大写），并新增 3 条回归：
  「七个 mood 名都能作为 emotions 的键」「仍拒绝路径/命令行形状的键」「一个坏键让整份 profile 失效」。

**缺陷 2（我引入的 UI 死路）：让位了却没告诉用户，也没有退出路径。**

- 现象：集成启用后自研桌宠窗口按设计让位，`显示桌宠` 点击无反应；而拒绝原因
  （`pet.error`）渲染在设置面板 800 行开外，按钮旁边什么都没有 → 读起来就是「按钮坏了」。
- 修复：设置区顶部改为醒目的红色横幅（说明让位是刻意的）+ 一键
  「关闭集成，恢复自研桌宠」；`显示桌宠` 在让位时禁用并给出内联说明；`pet.error` 就地渲染。

**缺陷 3（真缺陷，体验级）：把「发送期限」当成「气泡存活时长」，一整句话的气泡只活 4 秒。**

- 现象：修掉缺陷 1 之后链路通了，但回复气泡只存在 4 秒——用户还没读完就消失，
  读起来仍然是「她好像没回应」。
- 根因：`PetContext.expiresAt` 一个字段同时承担两件事。`prepare()` 把它收口在
  `PET_DEFAULT_DEADLINE_MS = 4000`（发送期限），适配器又把这个值当气泡 TTL 发给上游。
  于是「一句话该显示多久」被「发送等多久」锁死在 4 秒。
- 修复：拆成两个字段。`expiresAt` 只管「还值不值得发」；新增
  `PetCallOptions.ttlMs` / `PetContext.ttlMs` 表达「气泡显示多久」，由 presenter 按
  文本长度给值（4 秒起、每字 120ms、上限 `PET_MAX_TTL_MS = 10s`）。两者都是
  **可选新增**，不传即退回旧行为。
- 回归：PET-04-H 两条（`ttlForSpec` 的收口；真实事件序列里长文本的 `ttlMs` 大于默认值
  且 `expiresAt` 仍不超过默认值）。

三个缺陷修复后：桌宠相关 **113 项通过**（PET-02 26 / PET-03 22 / PET-04 19 /
PET-05 18 / 架构 28），`tsc` 无错误，宿主重建并重启，闭环重新取证通过。

## 3. 逐 AC

| AC | 结论 | 说明 |
| --- | --- | --- |
| PET-07-A | **PASS（device）** | 上游侧：OpenPet 外部安装、启动、角色可见、`127.0.0.1:17321` 可访问。Aiki 侧：宿主已构建并运行；**真实宿主传输成功且不依赖浏览器 CORS**——日志型替身记录到来自宿主进程的 `GET /api/status`，10 秒一次、仅此一端点（§2.2）。唯一未覆盖的是「对**真实** OpenPet 的 same-path 表现」，它在 PET-07-B 的点击里一并完成 |
| PET-07-B | **PASS（device，2026-09-15 补强）** | 真实 Aiki 轮次取证：`recentEvents` 出现 `{eventType:"thinking", bubbleText:"让我想一下……"}`（此前为空）；回复气泡由用户目视确认。2026-09-15 补上逐命令证据：`pet_command` 诊断显示真实 proactive 轮的 `event`/`emotion`/`say` **三条全部 `accepted`**（17:03:27/17:03:32；18:34 在 release 构建上复现 18:34:02/18:34:06），回复同时落库，且 18:34 那轮在 OpenPet 侧观测到 `lastAction=waving`——与 `gentle_smile → waving` 映射一致，**emotion 确实驱动了上游动作**。**Aiki 宿主侧闭环成立**（此前「say/emotion 未送达」的疑点已证为测量口径错误：`recentEvents` 只记录 `event` 调用，say 只看 `bubbleText`、action 只看 `lastAction`，见 [MVP-04 报告 §2 AC-D](MVP-04_ACCEPTANCE.md)） |
| PET-07-C | **NOT RUN** | 需要切换真实角色后再验证文本仍显示、能力更新、旧映射不再被当已验证 |
| PET-07-D | **部分 PASS** | TTL 语义在真机上暴露并修掉（缺陷 3：4 秒 → 按长度、上限 10 秒）；气泡按 TTL 消退有间接证据（TTL 到期后 `bubbleText` 读回为 null）。「已受理 action 的持续行为」仍无独立观测 |
| PET-07-E | **部分 PASS** | 桌宠挂载状态下多轮真实对话正常完成（用户消息 → 回复），未见桌宠阻塞对话；TTS 调度与桌宠错误的交互未单独观测 |
| PET-07-F | **部分 BLOCKED** | 上游侧事实已取：**没有单实例机制**（重复启动会产生第二个可见窗口）、关窗不退出、无协议退出端点。因此 Aiki 托管启动必须「先探测再启动」；但**用真实 exe 跑我们的 `ProcessManager` 未做**（需要 Aiki 宿主进程来调用原生命令） |
| PET-07-G | **NOT RUN** | `stopOwnedOnExit` 开/关、启动中退出对真实 exe 的行为未验；端口被占时上游不抢端口已验（§2） |
| PET-07-H | **NOT RUN** | 最小化/恢复主窗、重启 Aiki 后的设置恢复与「无旧自研 pet 窗口」需要跑宿主 |
| PET-07-I | **NOT RUN** | 30 次交互与 10 分钟待机的受理/可见 P95、CPU/RSS 口径**未测**；本报告不凭感受给结论 |
| PET-07-J | **部分 PASS** | 出站白名单与哨兵过滤已在 PET-04-G 覆盖；「安装器与 runtime 路径清楚」已由 PET-01-A 取证（安装器哈希 + 实际 exe 路径，且安装器/卸载器会被校验拒绝）。协议与素材权利记录完整（§PROTOCOL §1/§4） |

## 4. 剩余工作与执行清单（Aiki 侧）

上游侧已经就绪。Aiki 宿主侧已跑通「启动 → 真实对话 → 桌宠收到命令」这一条（PET-07-A/B，见 §3），
但下面第 5～7 步（managed 生命周期、退出行为、性能口径）仍需宿主操作；PET-07-C 需先切换真实角色：

```text
# 1) 构建并运行 Aiki 桌面宿主（PET-07 允许的必要宿主构建）
npm run build
npm run tauri build          # 或 npm run tauri dev

# 2) 在 Aiki 设置 →「桌宠 / 陪伴 → 外部桌宠（OpenPet）」里：
#    - 连接地址填 http://127.0.0.1:17321
#    - 连接方式选 attach（OpenPet 已在运行）
#    - 粘贴 §2.1 的 profile 并保存
#    - 点「启用桌宠集成」→「测试连接」应显示「已连接」
#    - 点「发送演示」应看到真实气泡（这一步即可覆盖 PET-07-A/B 的核心）

# 3) 触发一轮真实对话（文字即可），观察：
#    - thinking 短状态 → 最终气泡一次 + 一个动作
#    - 中途取消换轮后，旧轮不再冒出命令（PET-07-D）

# 4) 关掉 OpenPet（托盘退出）→ 确认 Aiki 聊天/语音继续、界面标离线并可重连（PET-07-E）
# 5) managed 模式：填 exe 路径 → 连点两次启用应只启动一次（PET-07-F）
# 6) 退出 Aiki：stopOwnedOnExit=关 → 桌宠保留；=开 → 只终止自有进程（PET-07-G）
# 7) 性能：30 次交互 + 10 分钟待机，分别记录 Aiki / OpenPet 的 CPU、RSS/工作集与冷启动（PET-07-I）
```

记录要求同 SPEC：健康与播放可见性**分开取证**，逐 AC 区分 `fixture / 真实 HTTP / device`。

## 5. 明确的未支持范围（不得被读成已完成）

- **Live2D**：PET-08 为条件路线，未启动。
- **点击回传 / 桌宠内输入框 / 桌宠菜单**：上游没有该能力（`/api/status` 的事件只出不进），
  已在 PET-06 设置页如实标注；这些诉求仍留在主窗（FE-31 差距）。
- **音频与口型**：0.5 不做，TTS 仍由 Aiki 播放。
- **双向事件**：0.5 只做 Aiki → 桌宠。

## 6. 诚实表述

- 0.5 桌宠集成的**模块级**证据齐备（PET-02～06），**上游侧**已用真机取证（PET-01 全 PASS）。
- **跨模块闭环已成立（2026-09-15 补强）**：Aiki 宿主侧的真实轮次已取证——`pet_command` 诊断显示
  真实 proactive 轮的 `event`/`emotion`/`say` **三条全部 `accepted`**（17:03:27 / 17:03:32，并于
  18:34 在 release 构建上复现），回复同时落库，OpenPet 侧观测到 `lastAction=waving`（与
  `gentle_smile → waving` 映射一致）。§3 的 **PET-07-A/B 即据此判 PASS（device）**。
- **不得被读成整体完成**：PET-07-C/G/H/I 仍 **NOT RUN**；D/E/F/J 为**部分 PASS**，其中 PET-07-F
  含 **BLOCKED** 项（用真实 exe 跑 `ProcessManager` 未做）。模块 PASS 与上游 PASS **未被继承**为
  这些 AC 的结论。
- **修订留痕**：本报告 09-14 版曾写「跨模块闭环未取证：Aiki 宿主侧一个 AC 都还没跑」。该表述在
  09-15 补强后**已作废**——此处保留说明是为了交代结论何时被改写，不表示现状。
- §4 的清单仍是补齐 C/G/H/I 与 D/E/F/J 各部分的路径；跑完后据此更新本报告即可闭项。
