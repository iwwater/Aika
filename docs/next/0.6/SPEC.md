# Aika Next 0.6 SPEC 索引

全部状态初始化为 NOT RUN；当前交付只有文档。

| SPEC | 内容 | 前置 | 状态 |
| --- | --- | --- | --- |
| [NEXT-00](specs/NEXT-00.md) | 上游引入、Windows 基线、源码映射 | 无 | AUTO_PASS（2026-09-19） |
| [NEXT-01](specs/NEXT-01.md) | 测试语料与契约 harness | 00 | AUTO_PASS（2026-09-19） |
| [NEXT-02](specs/NEXT-02.md) | Aika 静态身份与配置 | 01 | AUTO_PASS（2026-09-19） |
| [NEXT-03](specs/NEXT-03.md) | Provider 适配 | 01、02 | AUTO_PASS（2026-09-19；真实回放 BLOCKED 已登记） |
| [NEXT-04](specs/NEXT-04.md) | 文字主链与 Memory 兼容 | 03 | AUTO_PASS（2026-09-20） |
| [NEXT-05](specs/NEXT-05.md) | 最小 Chat Timeline | 04 | NOT RUN |
| [NEXT-06](specs/NEXT-06.md) | 基础语音与自动回放 | 04、05 | NOT RUN |
| [NEXT-07](specs/NEXT-07.md) | 最小 UI 与状态接线 | 02～06 | NOT RUN |
| [NEXT-08](specs/NEXT-08.md) | 自动集成、回归与构建 | 00～07 | NOT RUN |
| [NEXT-09](specs/NEXT-09.md) | 版本末尾人工验收 | 08 AUTO_PASS | NOT RUN |

顺序执行即可，不要求并行 agent。每次只给 worker 当前 SPEC；可以读未来接口，不提前实现未来版本。SPEC 通用约束见 [CONTRACTS](CONTRACTS.md) 与 [TESTING](TESTING.md)。
