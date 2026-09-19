# NEXT-00 验收报告 · 上游引入与 Windows 基线

- 执行：goal worker（2026-09-19）。SPEC：[NEXT-00](../specs/NEXT-00.md)。需求：N06-R01。
- 状态：**AUTO_PASS**（自动 AC 全过；版本人工验收在 NEXT-09）。
- 基线：文档种子 `75df0a4520917a5b59c688f1a0a41f3343218a1c`；候选提交：`565cd80`（导入合并）。
- 证据目录：`reports/evidence/`（共 5 个日志片段，约 15KB，无敏感信息）。

## 1. 实际范围

完成：上游引用获取与 SHA 固定、orphan 分支保留双方历史的导入合并、Windows 基线安装/静态检查/测试/构建/UI 冒烟、SOURCE_MAP 十域映射、独立数据目录改动点定位、LLM/ASR/TTS 环境盘点。
未做（按 SPEC 边界）：不开发 Aika 功能、不改 Legacy、不装系统驱动、不修无关上游问题、不合并旧 master、不推送远端。

## 2. 命令与退出码（cwd `windows/code/desktop-pet/`，另注明者除外）

| 命令 | cwd | 退出码 | 证据 |
| --- | --- | --- | --- |
| `git clone https://github.com/phoiex/AAAAGENT.git AAAAGENT-Upstream` | `F:/AIVoice/` | 0 | 副本 HEAD `ba79db152c14d4a0d4b3488cfd11be7abbfecc23` |
| `git remote add aaaagent-upstream …/AAAAGENT-Upstream && git fetch` | `F:/AIVoice/Aika-Next` | 0 | 新增 `aaaagent-upstream/main`（事先核实无同名 remote） |
| `git merge --allow-unrelated-histories --no-commit ba79db1…` | `F:/AIVoice/Aika-Next` | 0 | 自动合并、零冲突、880 文件；`git rev-parse HEAD^1 HEAD^2` = 种子+上游 |
| `npm ci` | desktop-pet | 0 | 90 packages |
| `npm run check` | desktop-pet | 0 | tsc --noEmit 无输出 |
| `npm run test:windows` | desktop-pet | 0 | 22/22 pass（evidence `next00-test-windows-tail.log`） |
| `npm run test:release` | desktop-pet | 0 | 138/138 pass（evidence `next00-test-release-tail.log`；管道退出码失真后二次复跑确认） |
| `npm run build:windows` | desktop-pet | 首跑 **1** → 补用户自备资产后 **0** | 失败原始输出 evidence `next00-build-fail-original.log`（esbuild 8 errors，缺 Cubism Framework/模型） |
| `npm run test:windows:ui` | desktop-pet | 0 | `WINDOWS_SMOKE_OK`（evidence `next00-smoke-final.log`） |
| `node tools/dev-desktop.mjs --smoke-test`（缺模型对照） | desktop-pet | 0（失败退出码不可靠，已记怪癖） | `model-error`/`模型文件加载失败：pet.model3.json`（evidence `next00-smoke-degraded.log`） |
| `node tools/configure-model.mjs` | desktop-pet | 0 | 生成指纹目录，`presets.json` modelFingerprint `bcd3101b…` |

教训记录：曾用 `npm run … | tail` 导致退出码取到 tail 的 0（`build:windows`/`test:release`/首次冒烟），已全部重跑并以重定向方式复核真实退出码；报告内所有退出码均来自真实复跑。

## 3. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 00-A | **PASS** | 上游 SHA `ba79db1`、种子 `75df0a4`、Legacy `30269c6`、来源 URL、双父提交 `565cd80`、LICENSE（上游根 + third-party/ + Cubism/Natori 许可保留说明）见 [BASELINE](../BASELINE.md) §1；`git log --graph` 可追溯上游父历史 |
| 00-B | **PASS** | 测试（22+138 全绿）、静态检查（tsc 0）、构建（build:windows 0）均在正确目录实跑退出 0；唯一失败（首跑 build:windows，缺用户自备资产）以 FAIL 原样保存并单列最小处置（补官方 SDK/模型，非代码修复，未冒充原版通过） |
| 00-C | **PASS** | `test:windows:ui` 自动启动→渲染就绪→文本往返→自动退出，exit 0，无用户操作；缺模型时显式 `model-error` 降级（evidence 齐全）；无麦克风要求；冒烟失败退出码怪癖如实记录（SOURCE_MAP §4.1）并列为 NEXT-08 双判据要求 |
| 00-D | **PASS** | [SOURCE_MAP](../SOURCE_MAP.md) 覆盖 Windows 入口、contracts、Dialogue、Memory、Context、Provider、Voice、存储、Management、Work route 十域；每项区分已核实符号与设计接口，KEEP/EXTEND/PORT/IGNORE、扩展点、测试、缺口齐备；缺口全部归属后续 SPEC（NEXT-01/02/03/05/06/07/08） |
| 00-E | **PASS** | 文档种子 16 文件仍在；Legacy HEAD 未变（只读）；`git ls-files` 敏感扫描无密钥/用户数据；仅构建 Windows 树，无 macOS 产物混入（BASELINE §2/§7） |
| 00-F | **PASS** | 盘点完成并如实标注（SOURCE_MAP §3）：LLM 无已验证凭据（fixture 可先行）；ASR 真实回放 **BLOCKED**（E: 盘不存在，旧 whisper 工具链不可用；可继续：fixture harness、官方 whisper.cpp 重装路径已记录）；TTS 可解码音频路径 **BLOCKED 待 NEXT-06 择路**（上游仅付费云 TTS；免费候选 Windows SAPI/sherpa-onnx 未验证）；不虚构准确率/延迟承诺 |

## 4. 共享契约影响

未改任何共享接口。SOURCE_MAP 已把 CONTRACTS.md 设计接口与上游符号对齐：`TurnScope{characterId,sessionId,turnId,generation}` 比设计多 `characterId`；取消/隔离语义由上游 `generation`+`sameScope`/`StaleTurnError` 承担。NEXT-01 冻结映射时须以本文件为准，不得假称设计接口为上游符号。

## 5. 已知限制与待办

1. 冒烟失败路径 exit 0 怪癖 → NEXT-08 自动宿主验证用「`WINDOWS_SMOKE_OK` 文本+退出码」双判据。
2. `npm start`（trial-launcher）需 trial 配置+激活+指纹，未跑（属正式配置流，NEXT-02 覆盖配置方案后再验）。
3. macOS 树 `code/` 未构建未测试（0.6 不需要；不混用）。
4. ASR/TTS/LLM 真实凭据或免费路径在 NEXT-01/03/06 按 BLOCKED 处置推进；必需真实门槛最终缺失则相应 SPEC 不得 AUTO_PASS。
5. 用户自备资产（Cubism SDK 5-r.5、Natori 示例模型）仅存本机 gitignored 路径，来源与许可记录于 BASELINE §5，分发另行核查。

## 6. 待人工项

无（本 SPEC 全自动验收；设备、听感、UI 实用集中于 NEXT-09）。
