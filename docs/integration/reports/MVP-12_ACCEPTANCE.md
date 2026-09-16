# MVP-12 验收报告 · 双向交互（点击 → Aika）

依据：[MVP-12 SPEC](../specs/MVP-12.md)（范围冻结：仅点击交互）、[共享契约 §8](../../frontend/DESKTOP_PET_CONTRACT.md)。
执行者：实施与验收同一轮（双仓）。日期：2026-09-16。

**结论：范围内 AC 全部 PASS；两项偏差与三项未闭合项见 §7。** 报告按 SPEC §5 要求把
fixture / 真实进程 / 真人操作三类证据**分列**，不互相代替。

基线：Aika `master @ e046bee`；pet-shell `aiki/0.6 @ 5a11cb5`；Windows 10 19045、WebView2、DPI 100%。

---

## 1. AC-A 通道与身份 — PASS

| 冻结项 | 实现 | 证据类型 | 结论 |
| --- | --- | --- | --- |
| 方向与回环 | pet-shell 只向 `127.0.0.1`/`localhost`/`::1` 投递，其余 host fail-closed；Aiki 端只绑 `127.0.0.1:0`（端口系统分配） | fixture + 真实进程 | PASS |
| 协议与路径 | `POST /api/pet/click`，`application/json` | 真实进程（见 §5） | PASS |
| 契约版本 | 请求体带 `schemaVersion:1`；Aiki 侧 `!= 1` 一律 `400`，不回退猜测 | fixture（真 socket） | PASS |
| 身份注入 | Aiki 派生时注入 `PET_SHELL_CLICK_URL` + `PET_SHELL_CLICK_TOKEN`（与 `PET_SHELL_EXIT_TOKEN` 同构、方向相反）；**成对注入，缺一不注入** | fixture + 真实进程 | PASS |
| 凭据边界 | attach 路径永不携带；凭据只在内存，不进日志/`/api/status`/诊断快照；诊断读数不含凭据与目标地址 | fixture + 真实进程（令牌泄漏扫描 0 命中，见 MVP-13 §AC-D） | PASS |
| 作用域 | **按注入时登记的实例身份校验**（per-instance 一次性凭据），不按来源 IP 放行：未武装一律 `403`，凭据不符 `401` | 真实进程（§5）+ fixture | PASS |
| 可追溯 | 事件带产生时间 `atMs`；实例身份由凭据承载（见 §7 偏差 1） | 真实进程 | PASS（带说明） |

## 2. AC-B 事件语义与可靠性 — PASS

| 冻结项 | 实现 | 证据 |
| --- | --- | --- |
| 事件形状 | `{schemaVersion,type:"click",eventId,atMs,payload:{button}}`，逐字段在真机接收端回读核对 | 真实进程 |
| 去重窗口 | Aiki 侧按 `eventId` 去重，窗口 256 条（有界 FIFO）；重复投递返回 `200 {"duplicate":true}` 且**不再触发消费者** | fixture（真 socket）+ 真实进程 |
| 重试 | 只对连接失败/超时重试一次，**沿用同一 `eventId`**；不为新事件复用旧 id | fixture |
| 背压 | 单在途 + 有界队列 16，满则丢最旧并计数，不阻塞点击判定 | fixture |
| 不自动重放 | 队列只在内存；重启/重连/换实例不回放历史点击 | fixture（结构保证） |
| 断连 | 失败只记账，不重试到成功、不弹窗 | fixture |
| 错误响应 | `401` 凭据不合法 / `403` 未武装 / `400` 版本或形状非法 / `404` 路由外 | 真实进程 + fixture |
| 超时 | 单请求上限 `CLICK_TIMEOUT_MS = 1500`，无更长回退 | 源码核对 + fixture |

## 3. AC-C 点击判定 — PASS

| 冻结项 | 实现 | 证据 |
| --- | --- | --- |
| hit area | 复用既有 click-through 判定（`RendererHost` 的 `onHitTargetChange` 注册的同一份命中元素）；不在命中区域内窗口不接收鼠标事件，因此不产生事件 | fixture + 真实进程（点中才上报） |
| 与拖动区分 | 位移 **≥4px** 判为拖动，不上报 | fixture（真机拖动实测见 MVP-13） |
| 与双击区分 | 冷却窗口 **400ms** 折叠为一次 | fixture + 真实进程（假接收端 4 次注入 → 恰好 3 条） |
| 按钮 | 仅左键；右键保留给上下文菜单，不上报 | fixture（源码常量） |
| 不派发业务轮 | shell 只上报事实，不生成对话轮、不播动作；Aiki 侧只发 `pet://click` 给授权主窗，消费者语义另立 SPEC | 双仓源码 + 真实进程 |
| 失败反馈 | 对用户不可见；仅诊断计数可见 | fixture |

## 4. AC-D 文件输入 — 不适用

按 SPEC §0 的范围冻结（仅点击交互），本能力未启用：**不写 PASS、不标 DEFERRED**，仅记录该决定。

## 5. AC-E 撤销与关闭 — PASS（一项未闭合，见 §7）

| 场景 | 证据 | 结论 |
| --- | --- | --- |
| 能力关闭（未注入凭据） | 未携带凭据时宠物**零请求**（真实进程：启动后未点击，接收端日志为空）；Aiki 侧未武装时外部投递一律 `403` | PASS |
| 退出 / 换实例：撤销迟到输入 | 真实进程：`pet_click_disarm` 后连点 3 次 → `unarmed:1`（首次被 403 拒，宠物随即关闭通道）、`accepted` 保持不变 | PASS |
| 换实例换凭据 | fixture：`arm` 两次，第一枚凭据立即失效；`disarm` 后连当前凭据一并作废 | PASS |
| 单实例转交后原实例不再上报 | — | **NOT RUN**（见 §7） |
| 关闭不影响四端点 | 全流程期间宠物 `/api/status`、`/api/say`、`/api/shutdown` 输出正常；`npm run build` 前端构建退出码 0 | PASS |

### 5.1 真实进程与真人操作证据（本轮实跑）

设备级操作序列（Aika release 构建 + 真实 pet-shell 子进程 + OS 层鼠标输入）：

```text
① Aiki 启动 → pet_click_diagnostics = {armed:false, 全 0}                  基线
② pet_click_arm → {url:"http://127.0.0.1:8208/api/pet/click",
                   token:"3f9d30e5cec0ff9eb977755f5caa0565"}                端口与凭据
③ 外部 POST（正确凭据）→ 200 {"duplicate":false,"ok":true}
   外部 POST（错误凭据）→ 401
   外部 POST（同一 eventId）→ 200 {"duplicate":true,"ok":true}
④ desktop_pet_process_spawn(path, clickUrl, clickToken) → {"pid":4376}
   宠物就绪：renderer=live2d、petVisible=true（**Aiki 注入的凭据随环境变量到达子进程**）
⑤ 真人操作：光标移到宠物窗口（L=2310 T=1088 340x296）中心 → OS 层左键按下/抬起
   → 诊断 accepted 1 → **2**，lastEventAtMs 刷新为 1789558420378               全链路闭环
⑥ pet_click_disarm → 再连点 3 次 → unarmed=1，accepted 仍为 2                 撤销生效
⑦ desktop_pet_process_stop({pid:4376}) → 进程消失、端口 17321 释放            句柄回收
```

第 ⑤ 步是本 SPEC 唯一能证明「两仓接得上」的一步：**真实鼠标点击 → 宠物判定为点击 →
POST 到 Aiki 注入给它的 URL → 接收端验凭据并受理 → 通知消费者恰好一次**。

## 6. 测试证据（命令与退出码）

```text
# pet-shell（产出侧）
cargo test --lib                      test result: ok. 20 passed; 0 failed
npx vitest run                        Test Files 4 passed (4)；Tests 39 passed (39)
npx tsc --noEmit                      退出码 0
# Aika（消费侧）
cargo test --lib                      test result: ok. 47 passed; 0 failed（+4）
npx vitest run src/services/desktopPet  Test Files 5 passed (5)；Tests 91 passed (91)（+5）
npx vitest run src                     Test Files 154 passed | 4 skipped；Tests 1682 passed | 4 skipped
npx tsc --noEmit                      退出码 0
npm run build                         退出码 0（前端产物 built in 6.02s）
npm run tauri build -- --no-bundle    退出码 0；release 产物 28,092,416 B @ 19:31:33
```

对接层由两侧共同覆盖：pet-shell 侧钉住事件形状/回环/401 关通道/重试沿用 id/丢最旧，
Aika 侧钉住凭据轮换与撤销、bearer 解析、去重有界窗口，以及**真 socket 上的 403/401/400/200 状态码**。

## 7. 偏差与未闭合项

**偏差 1（口径，需你确认）**：SPEC §1「可追溯」写「事件带实例身份」，但 §2 冻结的事件形状
里没有身份字段。当前实现把身份**放在凭据里**（每个实例一枚一次性凭据，接收端按「登记过的
那一枚」校验），事件体只有 `atMs`。若要在报文里加显式实例标识，属于冻结形状变更，需你先定。

**偏差 2（实现细节）**：SPEC §2 写 `eventId` 为 uuid；当前生成 `<毫秒>-<序号>`（进程内唯一、
不跨重启复用），满足「唯一 + 不复用旧 id」，但**不是 RFC 4122 UUID**。换个生成器即可对齐。

**未闭合 1**：AC-E「单实例转交后原实例不再上报」**NOT RUN**——需要 attach 转交场景，本轮未构造。

**未闭合 2**：真实进程中「Aiki 不在线」的断连分支只跑了 fixture（连接被拒只记账、不重试到成功）。

**未闭合 3**：双击折叠的 400ms 边界在真实两进程链路上未单独隔离（假接收端链路上已验证 4→3）。

## 8. 边界（不外推）

- 本报告只覆盖**点击**这一条交互；文件输入按 SPEC 明确不适用。
- 「点击到达 Aiki 之后做什么」不在本 SPEC 决定（SPEC §4）：当前消费者是「通知授权主窗 +
  诊断计数」，**没有**产品行为；任何「点击→打招呼/播动作/生成对话」都需另立 SPEC。
- 真人操作列只证明「一次真实点击走通全链路」，**不代表**长期稳定性、多显示器/高 DPI 下的
  命中一致性，或宿主偶发退出等既有敞口（见 MVP-13 报告）。
