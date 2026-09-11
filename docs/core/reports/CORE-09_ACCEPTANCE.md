# CORE-09 装配拓扑可读 — 验收报告

日期：2026-09-12
范围：`PluginRecord` 带出三份声明。不画图、不加界面。

## 需求

规划文档 F6 的第一张图要求「从注册表的 requires/provides 生成，图不会与代码漂移」。`describe()` 原来只能还原「谁提供了什么」（`services[].providedBy`），**读不到「谁需要什么」**——`requires`/`optional` 登记后就丢了。SPEC 见 [CORE-09](../specs/CORE-09_TOPOLOGY_READABLE.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/kernel/diagnostics.ts` | `PluginRecord` 新增 `requires` / `optional` / `provides`，都是 **token key 字符串数组**。 |
| `src/kernel/kernel.ts` | 在 `use()` 登记时就把三份声明记下来，而不是激活后——`pending` / `failed` / `skipped` 的插件也要出现在图里，「谁没装上」恰恰是最需要看见的。 |
| `src/kernel/kernel.test.ts` | 既有「describe 在每个状态下都可用」的断言补上三个空数组；新增 CORE-09 describe，3 条。 |

两个刻意的决定：

- **只给 key 字符串，不给 token 实例**。拿到实例就等于能绕过注册表直接 resolve，那是 CORE-01 明确堵住的路。
- **空数组而不是 undefined**。画图的一方不该到处写 `?? []`。

## 测试证据

```
npx vitest run src/kernel   → 退出码 0，Tests 77 passed（新增 3）
npx vitest run src          → Test Files 71 passed | 1 skipped (72)，Tests 852 passed | 1 skipped (853)
npx tsc --noEmit            → 退出码 0
```

突变验证：把 `requires` 改成恒空数组 → 1 failed（「三份声明按 token key 出现在快照里」）。已还原，`grep -rn MUTANT src/` 无命中。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| CORE-09-A 三份声明按 key 出现；未声明是空数组 | PASS | 「三份声明按 token key 出现在快照里；没声明的是空数组」 |
| CORE-09-B 启动失败时同样可读 | PASS | 既有「describe 在每个状态下都可用」用例现在同时断言 `rolledBack` 与 `failed` 两个插件都带着三份声明 |
| CORE-09-C 与 `services.providedBy` 对得上 | PASS | 「provides 与 services 的 providedBy 对得上」：遍历声明的每个 key 去 services 里找，`providedBy` 必须是它自己 |
| CORE-09-D 不泄漏实现 | PASS | 「只有字符串：记录里没有 token 实例也没有 factory」 |

## 共享接口影响

- `PluginRecord` 新增三个**必填**字段（诊断输出，不是插件契约）。任何直接对 `describe().plugins` 做深相等断言的测试需要补上这三个字段——仓库内只有一处，已更新。
- 插件契约 `AikaPlugin` 未改；激活顺序、预检逻辑未改。
- 按「v1 之后的追加」记入 [共享契约](../../modules/CONTRACTS.md)。

## 待后续

- 画图：FE 侧的 F6（下一份 SPEC）。
- NOT RUN：无。本 SPEC 全部行为都可在内核单测里验完，不涉及平台能力。
