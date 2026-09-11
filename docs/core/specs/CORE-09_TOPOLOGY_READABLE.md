# CORE-09 · 装配拓扑可读

状态：已自测。A–D 四条 AC 全 PASS；突变命中。证据见 [验收报告](../reports/CORE-09_ACCEPTANCE.md)。前置：CORE-07 已通过。

## 为什么需要它

规划文档 F6 要画两张图，其中第一张是 plugin 依赖拓扑，且明确要求**从注册表的 `requires`/`provides` 生成**——「图不会与代码漂移」是它唯一的价值，手画一张迟早和实际装配不一致。

现状：`kernel.describe()` 给出 `plugins`（id / version / status / error）与 `services`（token key / providedBy / instantiated）。`providedBy` 已经能还原「谁提供了什么」，但**没有任何地方能读到「谁需要什么」**——`requires` / `optional` 只在插件对象里，登记后就丢了。

## 目标与边界

- 输入：既有 `AikaPlugin` 声明与 `KernelSnapshot`。
- 输出：`PluginRecord` 上把三份声明（requires / optional / provides）以 token key 的形式带出来。
- 不做：**不画图、不加界面**（那是 FE 侧）；不改插件契约本身；不改激活顺序与预检逻辑；不暴露 token 实例或 factory（只给 key 字符串）。

## 设计

```ts
export interface PluginRecord {
  id: string;
  version: string;
  status: PluginStatus;
  error?: { code: string; message: string };
  /** 声明的依赖，token key。登记时记下，与激活成功与否无关。 */
  requires: readonly string[];
  optional: readonly string[];
  provides: readonly string[];
}
```

- 只给 **key 字符串**，不给 token 实例：拿到 token 实例就等于绕过注册表直接 resolve，那是 CORE-01 明确堵住的路。
- 在**登记**时记录而不是激活后：`pending` / `failed` / `skipped` 的插件也要能出现在图里——「谁没装上」恰恰是最需要看见的。

| AC | 模块内验收 |
| --- | --- |
| CORE-09-A | 三份声明按 token key 出现在 `describe().plugins` 里；没声明的是空数组而不是 undefined |
| CORE-09-B | 启动失败时同样可读（沿用 `describe()` 在任何状态都可用的硬要求）：失败与被回滚的插件也带着声明 |
| CORE-09-C | 与 `services` 的 `providedBy` 对得上：某插件声明 provides 的每个 key，激活成功后都能在 services 里找到同名条目且 providedBy 是它 |
| CORE-09-D | 不泄漏实现：记录里只有字符串，没有 token 实例、没有 factory |

证据：`src/kernel/kernel.test.ts` / `plugin.test.ts` 的定向运行。

## 模块内执行与交付

1. 只改内核记录与诊断类型，不碰装配顺序。
2. 按「v1 之后的追加」记录在 [共享契约](../../modules/CONTRACTS.md)。
3. 交付 `../reports/CORE-09_ACCEPTANCE.md`。
