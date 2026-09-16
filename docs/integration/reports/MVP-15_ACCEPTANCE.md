# MVP-15 验收报告 · 点击的 Aika 侧语义（选项 B）

依据：[MVP-15 SPEC](../specs/MVP-15_CLICK_CONSUMER.md)（2026-09-16 用户选 **B：受限轻量回应**）、[MVP-12](MVP-12_ACCEPTANCE.md)、[共享契约 §8](../../frontend/DESKTOP_PET_CONTRACT.md)。
日期：2026-09-16。执行者：实施与验收同轮。

**结论：B 的六个不变量全部实测通过；真实应用端到端已验到「她确实说了池子里的那一句」。**
仍未闭合的一项：**音频由人耳确认**（本轮把合成调用拦下来取证，没有真的出声）。

## 1. 交付

| 文件 | 内容 |
| --- | --- |
| `src/services/desktopPet/clickReaction.ts` | 策略模块：短语池、`CLICK_REACTION_MIN_INTERVAL_MS = 30_000`、不排队、不打断、不冒错、五类抑制计数 |
| `src/services/desktopPet/clickReaction.test.ts` | 11 项定向测试 |
| `src/app/plugins/petClickReactionPlugin.ts` | 接线插件：`clickSource` → 终审 → 出声；经 token 提供 `ClickReaction`（诊断可读） |
| `src/app/plugins/petClickReactionPlugin.test.ts` | 8 项接线测试（真实内核 + 假 Presenter / 假点击源） |
| `src/presentation/companionPresenter.ts` | 新增 `canSpeakAside()`：复用**同一份** canSend 输入与纯函数，不建轮、不写库、不计数 |
| `src/presentation/voicePresenter.ts` | 新增 `speakAside(text)` / `isSpeaking()`：复用**同一个**队列，不设 `speakingMessageId`、不碰字幕 |
| `src/app/hosts/index.ts`、`src/app/composition.ts` | `listen("pet://click")` 端口（`@tauri-apps` 仍只在 hosts 内 import）+ 组合根注入的「启动后解析器」 |

## 2. 六个不变量逐条验收

| 不变量 | 怎么验的 | 结果 |
| --- | --- | --- |
| 1 **零新外发**（不调 provider） | 短语来自本地池；`speak` 走既有输出引擎，不经过 Runtime | PASS（代码层：模块不 import provider/Runtime；测试：不出声路径不触发任何发送） |
| 2 **频控与上限显式可测** | `CLICK_REACTION_MIN_INTERVAL_MS = 30_000` 是导出常数；单测覆盖 29 999 ms 抑制 / 30 000 ms 放行 | PASS（单测 + 真实应用，见 §3） |
| 3 **状态优先、抑制可计数带原因** | 五类原因 `disabled / cooldown / gate / speaking / unavailable` 逐类计数；终审（勿扰/上限/最小间隔）由 `canSpeakAside()` 给结论 | PASS（单测 + 接线测试 + 真实应用：默认设置下点击被 `gate` 挡下） |
| 4 **关掉即零成本** | `isEnabled()===false` 时**不读时钟、不查终审、不构造短语、不出声**；shell 侧未注入凭据＝零请求 | PASS（单测断言 `gate` 调用次数为 0） |
| 5 **不打架** | Aika **不**用 `action/emotion` 回令宠物——shell 本地 `clickAction` 已经播动作 | PASS（代码层：模块不引用宠物服务） |
| 6 **可观测** | 收到/回应/按原因抑制 都从诊断读；服务经 `PetClickReactionToken` 可解析 | PASS（接线测试「服务经 token 可解析、诊断读得到」） |

## 3. 真实应用端到端（本轮实跑）

现场：Aika release 构建（含新前端）+ Rust 接收端 `pet_click_arm` 武装 + CDP 把
`window.speechSynthesis.speak` 换成记录器（**只记录不发声**，避免在用户工作时突然出声）。

```text
① pet_click_arm → url=http://127.0.0.1:12370/api/pet/click（一次性凭据）
② POST 点击（正确凭据）→ 200；接收端诊断 accepted=1
③ speak 捕获 = ["嗯？"]            ← 池子里的第一句，经 VoicePresenter.speakAside → 既有队列 → 合成调用
④ 30 s 内再 POST 一次 → 200；接收端 accepted=2
   speak 捕获仍为 ["嗯？"]          ← **受理了但没出声**：冷却把第二次挡下
⑤ 默认设置（proactive.enabled=false）下重复 ①② → speak 捕获 = []   ← 终审在说话前一刻拦下
```

第 ⑤ 条是刻意的：**点击回应并入「主动说话」这一个开关**（`proactive.enabled`，默认关）。
也就是说**默认安装下点了桌宠不会出声**——这是设计结果，不是缺陷；但它是个产品口径问题，见 §5。

## 4. 测试证据（命令与退出码）

```text
cd aika-crossplatform
npx vitest run src/services/desktopPet/clickReaction.test.ts    Test Files 1 passed；Tests 11 passed；退出码 0
npx vitest run src/app/plugins/petClickReactionPlugin.test.ts   Test Files 1 passed；Tests 8 passed；退出码 0
npx vitest run src                                              Test Files 156 passed | 4 skipped (160)；
                                                                Tests 1701 passed | 4 skipped (1705)；退出码 0
npx tsc --noEmit                                                退出码 0（无 error TS）
npm run tauri build -- --no-bundle                              退出码 0（95 s，含新前端）
```

## 5. 未闭合与需要拍板

| 项 | 状态 |
| --- | --- |
| **人耳确认**（真的出声） | **NOT RUN**：本轮为不影响用户工作，把合成调用拦下取证，**没有真的播放**。四条链路证据（受理 → 出声调用 → 冷却 → 终审）都已成立，差的只是「有没有声音」。 |
| **默认不出声**（`proactive.enabled` 默认 false） | **已解决（2026-09-16 用户选 (b)）**：新增**独立开关** `pet.clickReaction`，**默认开**（设置键 `SETTING_KEYS.petClickReaction`；UI 在「主动 / 被动响应」里，标签「点击桌宠时应一声」）。两层语义现在是：`主动消息` 关 = 她不**主动**开口，但点了她仍会应一声；`点击回应` 关 = 点了也不出声。两者叠加判定（勿扰时段/每日上限/最小间隔仍生效）。**快照开关已验证**（接线测试：关掉即沉默、打开即恢复）。 |
| 短语池内容/语气 | 现为 5 句「确认收到」型短句（不含需要上下文才成立的措辞，单测锁定）。要更丰富就得调模型，那超出选项 B 的授权。 |
| 冷却时长 30 s | 与 SPEC 一致；要更长/更短改一个常数即可（验收表会同步）。 |

## 6. 边界（不外推）

- 本报告只覆盖**点击这一条交互**与**选项 B**；C（点击开一轮对话）/D（在场信号）未采用、未实施。
- 未做：多显示器/高 DPI 下的点击一致性（属 MVP-13 真机矩阵）、点击的音效/触觉反馈（shell 侧表现层）。
- v1（点击只作为可观测事实）的结论不因本报告改变：诊断计数仍是权威事实来源。
