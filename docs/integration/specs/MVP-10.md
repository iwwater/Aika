# MVP-10 · 最小插件槽（DRAFT）

依据：[RPD](../../RPD_MVP_0.6.md) MVP-R10、[统一规则](../SPEC_MVP_0.6.md)。AC 全部 NOT RUN。前置：MVP-07 对应基线与剪枝通过；本份先于 MVP-08。

范围：shell 内 renderer/menu/behavior 接口、注册与生命周期、现有 sprite/菜单/待机实现迁移及定向测试。默认实现随程序打包；不做安装市场、远程代码加载或 Aika kernel 重构。

| AC | 验收与证据 |
| --- | --- |
| A | 三槽职责、输入/结果、能力声明、start/stop/dispose 和错误语义明确；HTTP 不依赖某一 renderer 实现 |
| B | 原有 sprite、菜单与待机成为默认实现；四端点及既有可见表现定向回归等价 |
| C | 任一时刻仅一个 renderer 输出；切换先准备新实例，提交后释放旧实例。失败保留可用旧实例；generation 拦截旧异步回调 |
| D | 可选插件缺失/失败有可见降级状态；renderer 不可用时尝试默认 sprite，均不可用则如实 unavailable，不虚报动作成功 |
| E | 重复启停/切换后订阅、定时器、事件监听及渲染资源计数恢复稳定；菜单/behavior 不绕过动作与轮次约束 |

报告：`docs/integration/reports/MVP-10_ACCEPTANCE.md`。记录迁移前后映射与实际源码路径；不把接口存在等同于 Live2D 已可用。
