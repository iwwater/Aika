# PET-01 验收报告 · OpenPet 版本与协议基线

> 2026-09-14 · 需求 DPI-01 · [SPEC](../specs/PET-01.md) · 协议细节 [PET-01_PROTOCOL.md](PET-01_PROTOCOL.md)
>
> **本轮补跑实机：A～E 全部 PASS（device）。**
> 上一版报告（同日早些时候）记录 B/C/D 为 BLOCKED——那时本机没有 OpenPet。收到授权后
> 安装了官方 Release v0.1.6 并完成了实机核对；结论以本版为准，协议细节见 PROTOCOL。

## 1. 改动

| 文件 | 内容 |
| --- | --- |
| `docs/frontend/reports/PET-01_PROTOCOL.md` | **重写为实机核对版**：真实请求/响应、错误体原文、事件→动作映射、进程行为、可见性证据 |
| `docs/frontend/reports/PET-01_ACCEPTANCE.md` | 本文件（A～E 全 PASS） |
| `docs/frontend/reports/evidence/PET-01_pet_bubble.png` | **新增 device 截图**：角色可见 + 中文气泡无乱码（裁剪到桌宠窗口区域 + 90px 边距） |
| `aika-crossplatform/src/services/desktopPet/fixtures/openPetFixtures.ts` | 把实机响应固化为 fixture（真实 status 快照 + 4 条 400 错误体 + 404 错误体） |
| `aika-crossplatform/src/services/desktopPet/openPetProtocol.ts` | **缺陷修正**：`400` 从 `incompatible` 改为 `failed/invalid_input`（见 §4） |

未 Fork、未自编译上游、未改上游任何文件；未把安装器写成启动路径。

## 2. 环境与命令

```text
环境：Windows，用户目录安装（无管理员）
资产：OpenPet_0.1.6_x64-setup.exe  SHA256 FF6E8169…A6AC4D80  Authenticode=NotSigned
安装：OpenPet_0.1.6_x64-setup.exe /S  → exit 0
运行：C:\Users\ZYF\AppData\Local\OpenPet\openpet.exe  → 127.0.0.1:17321 LISTENING
```

协议探测（curl，12 条，全部记录请求/响应/状态码）：

```text
01-status         200   02-say 200            03-action 200        04-event 200
05-unknown-action 200   06-empty-action 400   07-bad-event 400     08-bad-json 400
09-unknown-route  404   10-bad-ttl 400        11-no-ttl 200        12-long-say 200
```

工程侧（本轮同时修了 §4 的缺陷）：

```text
npx vitest run src/services/desktopPet src/app/hosts src/presentation/desktopPetPresenter.test.ts
→ Test Files 7 passed (7) / Tests 105 passed (105) / exit 0
```

## 3. 逐 AC

| AC | 结论 | 证据 |
| --- | --- | --- |
| PET-01-A | **PASS（device）** | tag `v0.1.6` / commit `0675f49…` / 发布时间 `2026-05-06T13:24:47Z` / 资产 `OpenPet_0.1.6_x64-setup.exe` SHA256 `FF6E8169C7BDA992CF8AA0AA7799EBC3234DAABF5D3FD547141D281BA6AC4D80` 全部可追溯；**实际运行 exe = `…\Local\OpenPet\openpet.exe`**，安装器只用于一次性安装、未进入任何启动路径（`…-setup.exe` 与同目录 `uninstall.exe` 都会被 PET-05 的校验拒绝，已有单测）。附带事实：安装器 **未做 Authenticode 签名**，带 Tauri updater 的 minisig `.sig` |
| PET-01-B | **PASS（device）** | 原版程序在 Windows 正常显示角色（见截图）；四端点真实请求与 schema 全部记录：`/api/status` 响应形状（含 `port`、`activePet.id`、`apiListening`、`apiError`、`apiRestartRequired`、`bubbleText`、`lastAction`、`recentEvents`）、`say`/`action`/`event` 请求体、**成功响应里没有 `ok`**、错误体 `{"error":…,"ok":false}` + 400/404 |
| PET-01-C | **PASS（device）** | 截图 `evidence/PET-01_pet_bubble.png`：角色可见 + 中文气泡「爱花验收：气泡可见性 回来啦」**无乱码**；动作可见性用像素差量化：静息帧间差 **946–1289**，`jumping` 帧差 **2592–2797**（同区域 6225 采样点）；thinking 由事件映射 `thinking→waiting` 与 `recentEvents` 计数 1 佐证 |
| PET-01-D | **PASS（device）** | ① 未知动作 `backflip` → **200** 且 `lastAction=backflip`，但像素差 **1182–1581** 落在静息区间内 ⇒ **无可分辨的可见效果**；② 空白 `animationId` → 400 `animationId is required`；未知 event 变体 → 400 并在错误里列出 6 值枚举；坏 JSON → 400；`ttlMs` 传字符串 → 400 `expected u64`；未知路由 → 404 `route not found`；③ **端口冲突**：先用 python 占住 17321 再启动 OpenPet → 进程照常存活、**不抢占端口**、不崩溃，API 静默不可用；④ **正常退出 vs 崩溃**：`CloseMainWindow()` 返回 True 但**进程不退出**（驻留托盘、端口继续监听）；强制结束 → 进程消失、端口立即释放。另测出**没有单实例机制**（第二个实例照常存活）且**没有协议退出端点** |
| PET-01-E | **PASS（device）** | 已确认**没有 capabilities 端点、status 里也没有 `version`/`actions` 清单**，因此 profile 只能来自人工核对并标 `source:"manual"`，且 0.5 不做版本比对；软件许可（GPL-3.0-or-later）与素材许可（上游声明导入宠物与第三方美术可能另有权利人，须自行确认使用权）**分别登记**在 PROTOCOL §1/§4 |

## 4. 本轮发现并修复的缺陷（重要）

**`400` 曾被当作「协议不兼容」。** PET-03 原实现把 `400/404/405/415` 统一判为 `incompatible`。
实机证明 `400` 的含义是**请求体不合法**（`animationId is required`、`invalid JSON: …`、
`expected u64`），协议本身完全正常。原判定的后果很具体：一次空动作就会把整条链路标成
`incompatible`，此后**不再发送任何 POST**，而用户看到的是「端口上的服务不是 OpenPet」。

修正：`400 → failed/invalid_input`；`404/405/415/3xx → incompatible`（不可达路由/方法/媒体类型、
以及我们已禁用的重定向）。真实错误体已固化为 fixture，并新增回归用例。

## 5. 对下游 SPEC 的输入（已冻结）

1. 四端点 + 6 值事件枚举 + 请求字段 → 与 PET-03 现状一致，无需改动。
2. **成功响应无 `ok`、无 `version`、无 `actions`** → PET-02/PET-03 的「不要求 `ok`」「不做版本比对」
   「能力只能来自人工 profile」全部得到印证。
3. **上游不校验 `animationId`** → 「不靠乱发动作猜能力」是唯一可行做法，PET-03-D 的守门逻辑保留。
4. `400/404` 分类修正 → 已完成（§4）。
5. 事件会**顺带播放动作**（thinking→waiting 等硬编码映射）→ 一轮里 event 与 action 会叠加两次动作，
   属上游行为；已在 PROTOCOL §3 记录，不改 Aiki 侧逻辑。
6. **没有单实例、关窗不退出、没有协议退出端点** → PET-05 的「单实例转交」分支对 v0.1.6
   **不可达**（防御性代码，不得标为已验证）；托管启动必须**先探测再启动**，否则会多出一个可见的角色窗口；
   退出只能走宿主句柄终止。
7. 端口改配置需**重启 OpenPet** 才生效（`apiRestartRequired`）→ PET-06 设置页已按此提示。

## 6. 遗留项

| 项 | 归属 | 状态 |
| --- | --- | --- |
| 当前角色 `nia` 的完整 `animationId` 清单（profile 内容） | PET-07 / profile 制作 | **未取得**：上游不提供，需要人工比对精灵图集或逐个试播肉眼确认 |
| `ttlMs` 不传时的默认寿命数值 | PET-07 | 未取得（上游未公开） |
| Aiki 桌面宿主 → 原生传输 → OpenPet 的真实闭环 | PET-07 | 未跑（需要打包/运行 Aiki 宿主） |
| 上游窗口在 DPI/多显示器下的定位 | 上游行为 | 不测，Aiki 不接管窗口 |
