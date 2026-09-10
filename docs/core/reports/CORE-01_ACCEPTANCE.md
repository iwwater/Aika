# CORE-01 验收报告 · 内核与服务注册表

- 模块 / 小阶段 / SPEC 版本：CORE / CORE-01 / [specs/CORE-01_KERNEL_REGISTRY.md](../specs/CORE-01_KERNEL_REGISTRY.md)（commit `303f434` 版本）
- 基础 commit：`303f434`
- 改动文件：**只新增 `aika-crossplatform/src/kernel/`，现有文件零改动**

  | 生产 | 测试 |
  | --- | --- |
  | `token.ts` 35 · `errors.ts` 54 · `eventBus.ts` 54 · `diagnostics.ts` 71 · `registry.ts` 177 · `plugin.ts` 269 · `kernel.ts` 304 · `index.ts` 25 | `architecture.test.ts` 126 · `registry.test.ts` 171 · `plugin.test.ts` 185 · `kernel.test.ts` 511 |

- 状态：**PASS**
- 真实依赖 / fake 依赖：无外部依赖。内核不接触网络、存储、DOM、React、Tauri；测试用桩插件与注入时钟，被测的注册表/插件/内核全部走生产代码。
- 本模块测试名单与选择原因：`src/kernel/` 下四个文件即本次全部新增逻辑，一一对应四组 AC；不涉及任何其他模块，因此不跑全仓测试、不跑产品构建。

## 命令与退出码

| 命令 | 退出码 |
| --- | --- |
| `npx vitest run src/kernel` | 0（4 文件 / 52 测试全通过） |
| `npx tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --target ES2020 --lib ES2020 --module ESNext --moduleResolution bundler --skipLibCheck src/kernel/{token,errors,registry,eventBus,plugin,diagnostics,kernel,index}.ts` | 0 |

第二条是针对新增公共类型的定向编译 fixture，按 [测试规则](../../modules/TESTING.md) 第 4 条执行，不是全仓 `tsc`。**`--lib ES2020` 不含 DOM**：内核在没有 DOM 类型的前提下编译通过，这本身就是「不碰浏览器 API」的一份证据。

测试分布：`architecture.test.ts` 6 · `registry.test.ts` 12 · `plugin.test.ts` 13 · `kernel.test.ts` 21。

## 逐条 AC

| AC | 测试文件/场景 | 观测值 | 结果 |
| --- | --- | --- | --- |
| CORE-01-A 注册/解析 | `registry.test.ts`：惰性单例、工厂内依赖、重复注册、未注册、成环、工厂抛错不缓存、只读视图、状态门、tryResolve、entries | 工厂调用 1 次且两次 resolve 同一引用；`SERVICE_ALREADY_REGISTERED` 带 `providedBy`/`attemptedBy` 且原注册未被破坏；`SERVICE_NOT_REGISTERED`；`SERVICE_CYCLE` 的 `details.chain` = `["test.a","test.b","test.c","test.a"]`；`Object.keys(view)` = `["has","resolve","tryResolve"]`，运行期不存在 `register` | PASS |
| CORE-01-B 作用域注册器 | `plugin.test.ts`：作用域注册器 5 例；`kernel.test.ts`：registrar 逃逸、provides 违约 | 未声明 provide → `TOKEN_NOT_DECLARED` 且注册表里查无此 token；`resolve` 越出 requires / `tryResolve` 越出 optional → `DEPENDENCY_NOT_DECLARED`（且两者不互通）；revoke 后 provide/resolve/tryResolve 三个方法都抛 `REGISTRAR_REVOKED`；声明 provides 却没提供 → `PLUGIN_CONTRACT_VIOLATION` 并触发回滚 | PASS |
| CORE-01-C 内核零业务词汇 | `architecture.test.ts` 前四例 + 末例 | 8 个生产文件（剥注释后）无 react/react-dom/@tauri-apps/domain/services/presentation import，无 `window.`/`document.`/`localStorage`/`__TAURI_INTERNALS__`；13 个业务词全部零命中；除 `token.ts` 外无 `token<…>(…)` 调用；测试进程内 `typeof document === "undefined"` | PASS |
| CORE-01-D resolve 使用位置 | `architecture.test.ts`：白名单扫描 | 扫描 `src/**` 生产文件（排除 `src/kernel/**` 与测试），`registry.resolve(` 命中 0 处；白名单当前为空数组，扫描真实执行 | PASS |
| CORE-01-E 生命周期与失败态 | `kernel.test.ts`：生命周期 3 例 + 失败回滚 6 例 + 释放 5 例 | 拓扑顺序 `["provider","consumer"]`；缺硬依赖时 trace 为空（一个插件都没激活）、全部记 skipped；插件抛错后 trace = `first:activate, second:activate, second:cleanup, first:cleanup, first:deactivate`（失败者只跑清理不调 deactivate，已激活的逆序拆）；回滚中 `deactivate` 抛错进 `rollbackErrors` 且不阻断其余回滚；failed 后 `use`/`start`/`resolve` 全抛 `KERNEL_FAILED`；`dispose` 幂等（连调四次 trace 不重复）、failed 后可用、未 start 也可用 | PASS |
| CORE-01-F 诊断 | `kernel.test.ts`：事件与诊断 6 例 | 未 resolve 时 `describe().services` = `[{key,providedBy,instantiated:false}]`；`describe()` 在 created/ready/failed/disposed 下均可调用，failed 时给出 `{status:"failed", error:{code,message}}` 与被连累者的 `rolledBack`；成功事件序列 `service.registered → plugin.activated → kernel.ready → kernel.disposed`，失败时有 `plugin.failed`/`plugin.rolledBack`/`kernel.failed` 且无 `kernel.ready`；快照是拷贝，改它不影响内核 | PASS |

## 门禁的突变验证

静态扫描如果永远通过就等于没写。本次用临时探针文件实测四条门禁**会失败**，随后删除探针复跑全绿：

| 探针 | 触发的失败 |
| --- | --- |
| `src/kernel/__probe.ts` 内 `import { token }` + `token<string>("voice.runtime")` + `document.title` | 「不依赖 React、Tauri、DOM」1 项、「不出现业务词汇」3 项、「一个 token 实例都不创建」1 项 |
| `src/__probeResolve.ts` 内 `registry.resolve(...)` | 「registry.resolve 只允许出现在白名单文件里」1 项 |

删除探针后 `npx vitest run src/kernel` 退出码 0。探针未进入提交。

## 实现中做的判断（超出 SPEC 字面的部分）

1. **新增错误码 `PLUGIN_PROVIDER_CONFLICT`。** 两个插件都声明提供同一 token 时，在预检阶段失败，而不是等到第二个插件注册时才抛 `SERVICE_ALREADY_REGISTERED`。理由：预检失败时一个插件都没激活，现场是干净的。
2. **失败者不调 `deactivate`，但跑它已登记的清理。** `activate` 没跑完，`deactivate` 面对的是半个状态；而它可能已经 `onDispose` 登记了要收拾的东西。
3. **服务工厂抛错不写缓存。** 下次 resolve 会重试。缓存失败会让排错时看不到真实原因，代价是「至多执行一次」在失败路径上不成立——已在代码注释里写明。
4. **`KernelStartReport.activated` 在失败时为空数组。** 那些插件确实已被回滚，说它们「已激活」是不诚实的；启动到哪一步由 `describe().plugins` 的 `rolledBack` 状态体现。
5. **释放期异常走 `logger.error`，不新增事件类型。** `KernelEvent` 是封闭联合且只含生命周期事实，为异常再开一个事件会松动这条约束；测试用注入的捕获型 logger 断言。

以上均为增强或补空，未降低任何已约定 AC。

## 共享接口 / 集成

- 共享接口变化：**无**。本阶段没有任何生产代码使用内核，`docs/modules/CONTRACTS.md` 不需要改动——内核契约按计划在 CORE-06 一并写入。
- 受影响消费者：无。
- 集成待测项：无。未触发 [集成 SPEC](../../integration/SPEC.md) 的任何条件，未跑全仓测试、未跑 `npm run build`、未跑 Rust 测试或 Tauri 打包。

## 边界自查

按 SPEC「不做」逐条核对：

| 约束 | 实际 |
| --- | --- |
| 只新增 `src/kernel/**` | `git status` 唯一条目为 `?? aika-crossplatform/src/kernel/` |
| 不碰现有业务代码 | 现有文件 0 处改动 |
| 不接入 `useCompanionSession` | 未 import、未引用 |
| 不提前实现 Runtime/Memory/Voice 的 token | 内核 token 实例数 = 0，由 CORE-01-C 的扫描守住 |
| 不引新依赖 | `package.json` 未改动 |
| 不做多实例作用域 / 热插拔 / 沙箱 / 装饰器 DI | 未实现 |

## 其他

- 场景文本是实际模型输出还是 fixture：不适用。本阶段无模型调用、无提示词、无音频。
- DEFERRED 项目：无。
- 执行者自测结论：CORE-01 六条 AC 全部 PASS，静态门禁经突变验证确认有效。生产应用**完全没有使用内核**，这是本阶段的预期结束状态。
- 原任务证据审阅结论：待审阅。
- 下一小阶段：[CORE-02](../specs/CORE-02_HOST_COMPOSITION.md) 宿主插件与组合根。它会首次引入组合根这个 `resolve` 白名单文件，届时 CORE-01-D 的白名单从空数组变为一项。
