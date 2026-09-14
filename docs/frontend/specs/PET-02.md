# PET-02 · 接入契约、Service 与能力模型

状态：DRAFT / 实现 NOT RUN。需求 DPI-02；依据 [契约](../DESKTOP_PET_CONTRACT.md)。前置 PET-01 资料结论；逻辑测试可注入 profile 与 fake adapter。

## 文件与边界

源码相对 `aika-crossplatform/`：新增 `src/services/desktopPet/contracts.ts`、`desktopPetService.ts`、`profile.ts` 及同目录定向测试。token 与接口同处；共享接口登记在 `docs/modules/CONTRACTS.md`，标 `desktopPet.integration.v1` 可选新增、无现有字段破坏。消费者为桌面宿主、展示桥接与设置页。

只实现归一化接口、Service 生命周期、状态订阅、profile 校验和结果归一化。HTTP 属 PET-03，事件映射和有限发送器属 PET-04，进程控制属 PET-05。不要中央 token 表或通用插件市场。

## 实现要求

1. 落实契约里的 PetStatus/PetResult/Context；注入 Clock、Adapter、诊断和可选进程端口，不 import React/window/Tauri。
2. enable/disable/dispose 幂等，配置切换递增 generation；禁用立即拒绝新命令，关闭订阅、探测与旧任务。
3. 校验 endpoint、文本及语义白名单，统一截断规则和错误结果。能力区分 native/mapped/unsupported/unknown，连接状态与能力分离。
4. profile 绑定供应商版本和角色；不匹配则动作能力降为 unknown/unsupported，不保留错误角色映射。say 仅在协议已兼容时可用。
5. 冻结当前 SPEC 的契约版本。新接口可选，未安装桌宠或宿主不支持不阻塞内核启动。

## 验收与定向测试

| AC | 输入/预期 |
| --- | --- |
| PET-02-A | fake adapter 验 status/say/action/emotion/event 的稳定结果；不把 accepted 写成 played |
| PET-02-B | localhost 归一化；IPv6 loopback 合法；LAN/公网/URL 凭证/路径/重定向配置拒绝；空文本与 Unicode 截断正确 |
| PET-02-C | 断线 stale、角色切换、未知版本、无 capability 字段均不宣称能力存在 |
| PET-02-D | 连续 enable/disable/dispose 20 次无重复订阅/定时器；旧 generation 完成不更新新状态 |
| PET-02-E | adapter 抛异常不影响 fake CompanionRuntime 正常提交；无第二对话编排入口 |
| PET-02-F | 可选新增接口登记完整；宿主能力缺失的消费者测试通过 |

报告 `reports/PET-02_ACCEPTANCE.md`。只跑此目录与受影响架构契约测试；不需要真实 LLM、桌宠或音频设备。
