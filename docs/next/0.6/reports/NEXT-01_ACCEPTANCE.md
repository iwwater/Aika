# NEXT-01 验收报告 · 行为语料与契约测试基座

- 执行：goal worker（2026-09-19）。SPEC：[NEXT-01](../specs/NEXT-01.md)。需求：N06-R02。
- 状态：**AUTO_PASS**。
- 基线：upstream `ba79db1`（`565cd80` 导入）；本 SPEC 候选提交：见 git log（本报告同提交）。

## 1. 实际范围

新增：`tests/next/`（harness + 3 个契约测试文件，18 个用例）、`tools/run-tests.mjs` 的 `next`/`next-real` 组、`package.json` 的 `test:next`/`test:next:real` 脚本、[CORPUS_MANIFEST](../CORPUS_MANIFEST.md)、[CONTRACT_MAP](../CONTRACT_MAP.md)。
未做（按边界）：不实现 Provider/Timeline/新 Runtime；不复制旧测试目录；被测对象全部为上游生产代码。

## 2. 共享文件变化（AGENTS 规则 8 登记）

| 文件 | 原语义 | 新语义 | 受影响消费者 | 必跑用例 |
| --- | --- | --- | --- | --- |
| `tools/run-tests.mjs` | 组：default/windows/release，未知组 throw | 追加 `next`（编译后 dist/tests/next 的 .test.js，空集拒绝运行）与 `next-real`（PET_NEXT_REAL=1 门禁 + 用例数守卫，缺失 exit 2 显式 BLOCKED）；既有分支未动 | 上游 CI（windows.yml 用 windows/release 组） | `test:windows`、`test:release` 未重跑（分支纯追加）；以 `default` 组实跑回归：563/563 pass、exit 0 |
| `package.json` | — | 追加 `test:next`、`test:next:real` 两个脚本 | 无破坏（纯新增） | 本报告 §3 |

## 3. 命令与退出码（cwd `windows/code/desktop-pet/`，2026-09-19 实跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:next`（第 1 遍） | 0 | 18 tests / 18 pass / 0 fail / 0 skipped |
| `npm run test:next`（第 2 遍） | 0 | 18/18；剥离耗时后两遍 ✔/✖ 行逐行一致（diff 为空）→ AC 01-C |
| `npm run test:next:real`（无环境） | 2 | `NEXT-REAL BLOCKED: real-service replay requires PET_NEXT_REAL=1 …` |
| `PET_NEXT_REAL=1 npm run test:next:real` | 2 | `NEXT-REAL BLOCKED: no real replay cases are registered yet …` |
| `node tools/run-tests.mjs default` | 0 | 563/563（上游 memory+providers 全量，验证 runner 改动无回归） |
| `npm run build`（随 test:next 前置） | 0 | tsc 严格模式（noUncheckedIndexedAccess、exactOptionalPropertyTypes）通过 |

调试记录：4 个用例首版失败，均为**本 worker 对上游语义预期错误**（generation 双 bump、共享 recent 流、AbortError 传播、fake 上下文断言方式），已按实际行为修正并在 CONTRACT_MAP §2 登记差异；未修改任何上游生产代码。

## 4. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 01-A | **PASS** | [CORPUS_MANIFEST §1](../CORPUS_MANIFEST.md)：TESTING 最低矩阵 11 项逐行映射 caseId/来源/预期/真实或模拟/责任 SPEC；2 项显式缺口（N01-TL-CRUD→NEXT-05、N01-E2E-VOICE→NEXT-06/08）带 BLOCKED 标注，无空泛"以后补" |
| 01-B | **PASS** | 18 个用例全部直接作用于上游生产代码：`TurnController`/`sameScope`（scope、终态、取消、订阅清理=media release 必达、外来 scope 过滤）、`DialoguePipeline`（五种终态路径）、`SqliteMemoryStore/SqliteMemoryPort`（临时真实 SQLite）；现有行为全绿 |
| 01-C | **PASS** | 连续两遍 18/18 且输出一致；可控延迟用 deferred 注入，无真实 sleep、无联网断言；时间戳用注入时钟 |
| 01-D | **PASS** | fixture 入口（`test:next`）与真实回放入口（`test:next:real`）分离；后者双分支实测 exit 2 + 显式 BLOCKED，无凭据时不可能静默 PASS |
| 01-E | **PASS** | 所有拟用命令（§3）均实跑且能发现用例（18+563 条）；CORPUS_MANIFEST 仅含路径与 blob hash，无密钥/私人正文；SOURCE_MAP 复查无密钥 |

## 5. fixture 与真实证据类型

- 模拟：fake 端口记录（appended/released/replyCalls/contexts/callOrder）、可控延迟 gate、上游 byte-split SSE fixture（引用，未复制）。
- 真实：临时 SQLite 生产库（真 better-sqlite3 文件库）；真实服务回放（LLM/ASR/TTS）BLOCKED 状态与恢复步骤见 CORPUS_MANIFEST §4。

## 6. 共享契约影响

见 [CONTRACT_MAP](../CONTRACT_MAP.md)。要点：`Scope` 多 `characterId`；`clientRequestId` 上游为回显、幂等归 NEXT-04；流式 delta 属传输层；「会话隔离」语义收窄为轮次状态隔离（Memory recent 为共享流）；3 条上游行为差异实测记录，适配层不得静默偏离。

## 7. 已知限制与待办

1. `test:next` 每次前置全量 tsc build（约 40s），随上游模式；NEXT-08 收口时可评估增量。
2. `test:next:real` 当前无用例（登记为 NEXT-03/06 落地时补），入口与守卫已就位。
3. Timeline/Provider 的 RED 契约用例按 SPEC 归属在对应 SPEC 实施（本 SPEC 不提前实现）。
