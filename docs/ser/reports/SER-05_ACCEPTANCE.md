# SER-05 验收报告 · 演示服务输入边界与响应性

日期：2026-09-21。规格：[SER-05](../specs/SER-05.md)。前置：SER-04（共享解析/路径入口已收敛）。
环境：Windows，Python 3.11（`C:/Users/BAi/AppData/Local/Programs/Python/Python311/python.exe`）。
**无真实模型、无 GPU、无网络**：服务端引擎为可注入 fake，浏览器端为真实 uvicorn + 真实 Playwright/Chromium。

> 结果区分：本报告中的「情绪结果」全部来自 fake 引擎的固定响应（中立/开心/未知），
> **不代表真实声学表现**；SER-05 只验证输入边界、渲染安全与响应性。

## 执行命令与退出码

| 命令 | cwd | 退出码 |
| --- | --- | --- |
| `-m unittest discover -s research/ser/tests -p "test_*.py"` | `E:/Work/AI CHAT` | 0（Ran 37 tests，OK，skipped=1） |
| `-m pytest -q tests/test_ser_server.py tests/test_ser_common.py tests/test_ser_metrics.py` | `E:/Work/AI CHAT/research/ser` | 0（36 passed, 1 skipped） |
| `python -u ser_server_browser_check.py`（真实服务 + Playwright） | `E:/Work/AI CHAT/research/ser` | 0（11/11 PASS） |

测试文件：`research/ser/tests/test_ser_server.py`（13 例：AC-A 7 / AC-C 1 / AC-D 5）、
`research/ser/ser_server_browser_check.py`（AC-B 7 断言 + AC-E 4 断言）。
浏览器截图证据：`docs/ser/reports/evidence/ser05/`（`e1_result.png`、`b1_injected_src.png`、
`b2_injected_upload_error.png`、`b3_injected_meta.png`、`b4_injected_error.png`、`e2_upload_error.png`）。

## 逐 AC 结论

### AC-A · PASS

`resolve_demo_audio()` 改为「realpath 规范路径 + 路径组件级包含判断」，先校验再打开。
临时目录 fixture 覆盖（`tests/test_ser_server.py::TestACAPathValidation`）：

| 用例 | 输入 | 断言 |
| --- | --- | --- |
| `test_valid_audio_ok` | `ref/mood01.wav` | 200，`top=neutral`，模型调用 1 次（目录内相对路径继续可用） |
| `test_missing_404` | `ref/not_here.wav` | 404，模型调用 0 |
| `test_parent_escape_400_and_not_read` | `ref/../../secret.wav` | 400，模型调用 0（越界文件是**合法 wav**，若被读取即会调用模型，可检出） |
| `test_absolute_path_400` | 绝对路径字符串 | 400，模型调用 0 |
| `test_same_prefix_sibling_dir_400` | `../audio_backup/x.wav` | 400，模型调用 0 ← 原字符串前缀判断会误放行 |
| `test_link_outside_root` | 根内符号链接 → 根外 | **NOT RUN**（见下） |
| `test_empty_path_400` | `"   "` | 400 |

- **NOT RUN**：`test_link_outside_root` 在本机 skip —— Windows 无特权创建的符号链接
  「创建成功但不可解析」（`islink=False`/`isfile=False`），无法构成有效 fixture。
  判定：`os.path.islink(link) and os.path.isfile(link)` 不成立即 skip，不伪装成通过。
  代码路径仍实现了 realpath 解析 + 组件包含判断（与越界父目录同一判据）。
- UNC 前缀（`\\` / `//`）在 `resolve_demo_audio` 中显式拒绝（Windows 分支）。

### AC-B · PASS

浏览器侧 7 条断言全绿。注入载荷统一为 `<img src=x onerror="window.__pwned=1">`，
每条均断言：页面**不产生** `<img>` 元素、`window.__pwned` 未被置位、被注入字段**以字面文本**显示。

| 通道 | 注入点 | 结果 |
| --- | --- | --- |
| B1 上传成功响应 `src` | `/predict` 200 JSON 的 `src` | `来源：<img src=x onerror="window.__pwned=1"> · 音频 0.3s …`；`imgs=0 pwned=False`；历史条目同样字面显示 |
| B2 上传错误响应 `detail` | `/predict` 400 的 `detail` | `识别失败：<img src=x onerror="window.__pwned=1">`；`imgs=0 pwned=False` |
| B3 demo 分支 `src` 的拼接来源 | `/meta` 的 `demos[].group_name` | `来源：安心（安心）· <img …> · 音频 4.46s`；`imgs=0 pwned=False` |
| B4 demo 错误分支 | `/predict/path` 400 的 `detail` | `imgs=0 pwned=False` |
| B1 历史分支 | `#hist li:first-child .h-src` | 字面文本，`hist imgs=0` |

**实现要点（也是本次修正的两处脚本缺陷）**：

1. demo 分支的前端会用 `/meta` 的 `zh/ja/group_name` 覆写 `r.src`
   （`index.html` L347），所以直接给 `/predict/path` 注入 `src` **不会进入 DOM**。
   最初脚本据此断言「src 以字面文本显示」必然失败——那是**断言找错了通道**，不是产品缺陷。
   改为注入 `/meta` 后，同一渲染点被真正覆盖（B3）。
2. Playwright 的 `route.fetch()` 重发请求会**丢掉 multipart 文件体**，服务端收到空文件 → 400「空文件」。
   因此上传分支的注入直接构造响应（`fake_result()`），不回源——AC-B 考察的是前端渲染与转义，与后端无关。

前端改动：`demo/ser-demo/index.html` 新增 `esc()` / `safeColor()`，
`renderDemos` / `renderMoods` / `renderResult` / `renderHist` 及三个错误分支的全部动态插值
（文件名、src、错误 detail、group、ja/zh、颜色）一律转义；颜色只接受 hex 字面量。

### AC-C · PASS

- `test_serial_inference_and_health_available`：两个请求经生产 `_infer_lock` 串行，
  `FakeSlowModel` 用 `threading.Event` 屏障挂起（`in_flight.wait()` 确认已进入挂起态，不靠 sleep 推断）；
  挂起期间 `/health` 返回 200 且 `loaded=true`；`release.set()` 释放后第二个请求进入时第一个已出锁 →
  `overlap_detected=False`（推理不重叠）。
- 实现方式：`/predict` 为 async 路由，解码 + 同步推理经 `fastapi.concurrency.run_in_threadpool`
  执行（未另建队列框架）；`/predict/path` 为同步 `def`，FastAPI 自动放入线程池。
  `/health` / `/meta` 不取推理锁。

### AC-D · PASS

- `test_upload_ok_fields`：成功响应字段 `top/top_ja/top_zh/scores/elapsed_s/duration_s/model/src` 齐备，
  `src=upload.wav`，`top=neutral`（复合标签 `中立/neutral` 经 SER-04 规则归一化）。
- `test_upload_corrupt_400`（不可解码）、`test_upload_empty_400`（空文件）、
  `test_inference_failure_500`（推理失败）状态码与既有消费者一致。
- `test_unknown_top_normalized`：`<unk>` → `unknown`；路径校验先于推理（不存在文件 404 且不触模型）。
- 标签解析复用 `ser_common.parse_emotion2vec_result`（SER-04 唯一规则来源），服务内未保留第二套解析。

### AC-E · PASS

真实浏览器（Playwright + Chromium headless）完成，全部经页面点击/文件选择，未直接调用 `renderResult`：

```
[PASS] AC-E 选择样本并渲染结果  | 😐 平静 中立 置信 60.0%
[PASS] AC-E 历史列表渲染  | 1 条
[PASS] AC-E 上传坏音频显示错误恢复  | ⚠️ 识别失败：无法解码音频（支持 wav/mp3/flac/ogg）…
[PASS] AC-E 错误后恢复正常识别  | 😐 平静 中立 置信 60.0%
```

服务真实启动（uvicorn，端口 8797），模型为 fake；音频经真实路由、真实解码与响应组装。
坏音频用例中服务端按设计 `log.exception` 落了一条 JSONL（含完整堆栈），属预期行为，非失败。

## 变更清单

| 文件 | 改动 |
| --- | --- |
| `research/ser/ser_server.py` | 新增 `PathDenied`/`PathNotFound`/`resolve_demo_audio()`/`_denied_to_http()`/`DecodeError`/`_decode_and_predict()`；`/predict` 改 async + `run_in_threadpool`；`/predict/path` 改走 `resolve_demo_audio` + 打开前二次 `isfile`；`predict_core` 委托 `ser_common.parse_emotion2vec_result` |
| `demo/ser-demo/index.html` | 新增 `esc()`/`safeColor()`；全部动态插值转义（含三个错误分支与历史列表）；颜色 hex 校验 |
| `research/ser/tests/test_ser_server.py` | 新增（13 例） |
| `research/ser/ser_server_browser_check.py` | 新增（AC-B/AC-E 浏览器验证，11 断言） |

## 接口影响

- 路由 `/health`、`/meta`、`/predict`、`/predict/path`、`/audio`、`/` 与 `--host/--port` 全部保留；
  成功响应 schema 与错误 `detail` 形状未变（SPEC 禁止暗改）。
- **有意收紧**：绝对路径、越界父目录、同前缀兄弟目录、UNC 前缀、空路径由「可能被放行」变为 400。
  此前依赖这些输入的行为视为无效请求，不升级主工程协议。

## 未运行项

- 符号链接越界（AC-A `test_link_outside_root`）：平台限制，skip（NOT RUN）。
- 真实模型推理 / 真实 GPU 延迟：不在 SER-05 范围（SPEC 明确不承诺实时性能阈值）。
- 真实麦克风录音路径：需用户授权与设备，浏览器验证用上传/样本路径替代。
- 未执行 `git add/commit`（规格未要求）。
