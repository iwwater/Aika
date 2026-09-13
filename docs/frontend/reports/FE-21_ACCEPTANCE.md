# FE-21 验收报告 · 帧 diff、固定 ROI、离线英文 OCR 与质量验证

日期：2026-09-14。状态：**PASS（算法与编排轨）**；真实屏幕质量与性能（FE-21-I）为 **NOT RUN**（设备轨，需用户开启屏幕感知开关并准备非敏感测试画面）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/screen.rs` | 新增：`environment_screen_supported/_enable/_capture_region`；WGC（windows-capture 1.5）500ms 采样 → 96×54 luma 灰度 → 归一平均绝对差 ≥0.03 → `environment://screen-change`（仅 emit_to main）；首帧建基线/分辨率重建/黑帧无效/触发后以当前帧重建基线（边缘触发）；`environment_capture_region` 相对 ROI（默认中央 80%×20%）→ PNG base64（黑帧/越界 None，关闭清空帧缓存）；diff 纯函数 5 个 Rust 固定矩阵测试 |
| `src-tauri/src/lib.rs`、`Cargo.toml` | 注册模块/命令；新增 `windows-capture 1.5`、`image 0.25`（png-only）依赖 |
| `src/services/environment/keywordRules.ts` | 新增：冻结英文词表（VICTORY/DEFEAT/PENTAKILL→game_event；Error/Failed→screen_keyword）、独立词边界大小写无关匹配、ruleId、`normalizeWordConfidence`（0..100→0..1）、无词级证据保守 0.5 |
| `src/services/environment/ocrText.ts` | 新增：tesseract.js 懒加载 worker（eng，本地 traineddata，不外联）；加载超时 15000ms/识别超时 5000ms（可注入 timers）；超时终止并清理 worker、本次无事件、不无限重试；`reset()` 重初始化 |
| `src/services/environment/screenSource.ts` | 新增：管线编排——变化节流 ≥2s、OCR 并发 1/pending≤1（忙时保留最新候选）、10 次/分钟单调滚动窗口、事件只携带 ruleId+归一置信度（OCR 原文不出模块）、停止先撤销 generation 再 dispose worker、enable 失败映射 denied/unavailable |
| `src/presentation/environmentPresenter.ts`、`src/services/storage/contracts.ts` | 泛化每源开关（foreground/screen 各自独立设置键 `environment.foregroundEnabled`/`environment.screenEnabled`）；stopAll 持久化全部关闭 |
| `src/app/hosts/plugins.ts` | tauri 宿主注册 screen source（Rust capture 桥 + OCR `langPath=/tessdata`） |
| `src/App.tsx` | 屏幕感知开关 + SET-02 说明文案（获取屏幕帧、固定区域、英文词表、本地处理） |
| `src/services/environment/fixtures/` | dev 30 张 + 冻结验收集 120 张（自制合成画面，PIL + Anonymous Pro/OFL 渲染，manifest 含来源与 sha256）；`eng.traineddata`（tessdata_fast，Apache-2.0）；`public/tessdata/`（webview 同源获取） |
| `scripts/generate-ocr-fixtures.py`、`scripts/fonts/` | 生成器（确定性、来源登记）；OFL 字体与许可文本 |
| `src/services/environment/ocrQuality.eval.test.ts` | 冻结集评估（生产 OCR + 生产规则） |

## 测试命令与退出码（`aika-crossplatform/` 目录）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/services/environment`（含冻结集评估 ocrQuality.eval.test.ts） | **68 passed（0 failed），退出码 0** |
| `npx tsc --noEmit` | 无错误 |
| `cargo check` / `cargo test screen` | 通过 / **5 passed（0 failed）** |

## 逐 AC 证据

| AC | 证据 | 状态 |
| --- | --- | --- |
| FE-21-A | `screenSource.test.ts`：变化+OCR 命中 → `game_event victory`（词级置信度 0.95）；变化未命中 → 零事件；OCR 失败 → 丢弃不崩溃；schemaVersion/timestamp 经 FE-18 monitor 规范化；近拼写负例（ERRORS/DEFEATED/PENTAKILLED 等）零误报（`keywordRules.test.ts`） | PASS |
| FE-21-B | 同文件：节流 ≥2s（窗口内重复变化跳过 OCR）、10 次/分钟滚动窗口、pending≤1（OCR 挂起期多次变化合并为最新一次，ocr.calls=2）、丢弃/命中计数经 monitor diagnostics；FE-18 monitor 去重复用 | PASS |
| FE-21-C | 默认关 = 无 enable 调用（presenter 默认关闭，`environmentScreenEnabled` 缺省 false）；开启路径经 Rust `environment_screen_enable`；事件 JSON 断言不含 Malicious/INJECTED/delete-everything 原文；原图只在内存 base64 → OCR → 丢弃；无任何文件写入/网络请求路径（tesseract 资源本地） | PASS |
| FE-21-D | 非 Tauri 宿主不装 environmentPlugin（hosts 层装配）；`environment_screen_supported` 探测命令存在；浏览器 dev 主窗零回归（全量 119+ 测试绿） | PASS |
| FE-21-F | **生产 diff**（Rust 固定矩阵）：0.03 边界（8/255 触发、7/255 不触发）、首帧只建基线、黑帧无效、分辨率重建基线、ROI clamp、luma 正确——`cargo test screen` 5/5。**生产 OCR 冻结集**：120 张（60 正例每词 12 + 60 负例三场景各 20）跑 `createOcrEngine`+`matchKeywords`——TP=60、FP=0、FN=0，**精确率 100%（≥95%）、召回率 100%（≥85%）、热 OCR P95=96ms（≤2000ms）**；逐词/逐场景见 `fixtures/eval-results.json`；分母为零记 0 不记 100%；dev 30 张用于调参未混入 | PASS |
| FE-21-G | 超时路径：ocrText 超时注入 timers + 并发/滚动窗口/关闭迟到零事件（screenSource 用例）；离线资源：manifest sha256 逐文件校验 + `eng.traineddata` 在位断言；评估在无网络依赖下完成（tesseract worker 本地加载） | PASS |
| FE-21-H | 恶意 OCR 文本（INJECTED INSTRUCTION / delete-everything）穿过生产规则与摘要出口：事件只有 ruleId+置信度，monitor.recent JSON 无原文；写 User Soul 路径不存在（FE-22 remember 仅标准摘要） | PASS |
| FE-21-I | **NOT RUN**：真机 3×10 分钟（LOL 结算/视频/IDE）与真实 WGC P95 需真实屏幕会话；固定图证据不冒充 WGC | NOT RUN |

## 共享接口影响

见 `docs/modules/CONTRACTS.md` 2026-09-14 FE-21 节。新增依赖：npm `tesseract.js@5`；Cargo `windows-capture 1.5`、`image 0.25`（png-only）。diff 阈值 0.03、ROI 中央 80%×20%、超时 15000/5000ms、限流 10/分钟为设计冻结值（开发集调参记录于生成器，变更需理由+冻结）。

## 待联调 / NOT RUN

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真机 3×10 分钟识别质量（命中/漏报/误报 + 热识别 P95） | **NOT RUN** | 需用户开启屏幕感知开关并准备非敏感画面（LOL 结算/视频/IDE）；样本不足不宣称真实识别质量 |
| 独占全屏 WGC 黑帧表现 | NOT RUN | 代码按无效帧丢弃处理；真机清单记录 |
| webview 内 tesseract.js worker/wasm 打包 | 部分 | node 侧生产 OCR 已验证；webview 打包（vite worker/wasm 资源）与安装包离线验证归 FE-30（`langPath=/tessdata` 已就位） |
| OCR 失败的界面状态呈现 | 部分 | source 状态机可见 running/error；OCR 层失败当前表现为无事件，细粒度诊断计数归 FE-30 组合验收补充 |
