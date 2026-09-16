# MVP-09 · Aiki 兼容联调（DRAFT）

依据：[RPD](../../RPD_MVP_0.6.md) MVP-R09、[统一规则](../SPEC_MVP_0.6.md)。AC 全部 NOT RUN。前置：MVP-08/10。

范围：shell HTTP/能力及身份信息；必要时修改 Aika `aika-crossplatform/src/services/desktopPet/` 的 adapter/profile/fixtures/ProcessManager 及对应宿主进程端口。实施前列明实际文件。任何新增公共契约同步 `docs/frontend/DESKTOP_PET_CONTRACT.md`；不重写 Agent、Memory、OCR 或旧桌宠。

| AC | 验收与证据 |
| --- | --- |
| A | `/api/status`、`/api/say`、`/api/action`、`/api/event` 与 PET-01 原契约兼容，成功/错误/未知动作/TTL 含义不漂移。新身份和版本如实返回；所需 Aika 识别增量显式列出 |
| B | 能力/profile 绑定实际版本与角色；切换角色或 renderer 后旧映射失效，unknown/unsupported 不伪装 native；禁止发送猜测的动作 ID |
| C | 保持 1500ms 请求上限、单在途/有界队列、POST 不自动重试及取消/换轮清除未发命令；断连不拖住业务轮、TTS 或存储；已接收动作不承诺撤回 |
| D | 如消费协议退出，只对身份验证通过的 owned 实例发起；attach、身份不符、凭据失效均不得退出。新能力缺失时沿用已有受管进程策略，不能扩大终止范围 |
| E | fake 端口验兼容与失败边界；真实 Aiki→shell sprite 按 PET-07 适用 AC 分项复验。记录入队、HTTP accepted、屏幕可见三层证据，accepted 不等于播放完成 |
| F | `recentEvents`、`bubbleText`、`lastAction` 分别验证，不因查询错误通道判失败。共享契约/fixtures 双仓同步，原版 OpenPet 的现有接入回归不被新身份破坏 |

报告：`docs/integration/reports/MVP-09_ACCEPTANCE.md`。本阶段验证 sprite；Live2D 同链路证据在 MVP-11/13 补齐。不继承旧 PET-07 未测项为 PASS。
