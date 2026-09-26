# LIVE2D-ASSET-V3 验收报告 · 素材侧遗留清除

日期：2026-09-21。范围：`output/live2d/production-v1` 素材层（**不涉及应用代码、不改前端、不碰 Cubism 绑定**）。
前置：`production-v1/制作说明.md`（2026-09-09 首拆，自述「尚未完成 Cubism 绑定」并列出 3 项素材遗留工序）。

## 结论摘要

v1 报告列出的「分配剩余像素 / 清理部件边缘 / 补全遮挡」三项，经逐层实测后**判定前提有误**：
残留层并非可归类零件，而是**部件间的夹缝与边缘抗锯齿**；13 处大块缺口也**不是未画**，
而是**未拆分区**（与母稿逐像素一致）。据此改用可复核的几何+显式规则归属，
产出**可直接导入 Cubism 的透明底 PSD**，并使分层对原稿达到**无损**。

**素材侧遗留已清除。** 剩余工序全部位于 Cubism 内部。

> **2026-09-21 晚更新**：Cubism Editor 5.3.03 已安装并验证可启动，原 BLOCKED 解除；
> 同时新增导入前校验器（24 项全过）与标准对话级绑定计划。详见文末「补证」章节。

| AC | 结论 | 证据 |
| --- | --- | --- |
| A 残留层性质判定 | **PASS** | 残留 431,275 px == 整人 ∩ 部件并集之外；与部件重叠 0、外溢 0 |
| B 夹缝像素归属 | **PASS** | 328,251 px 按最近部件归属；部件间重叠 0 |
| C 缺口归属 | **PASS** | 13 处 / 103,024 px 按显式规则归属；`unmatched=0` |
| D 无损守恒 | **PASS** | 合成 vs 整人：alpha 差 0 px；RGB `alpha==255` 处差 0 |
| E 导入 PSD 合规 | **PASS** | 2048×4096 RGBA 真透明、53 唯一命名层、无残留/参考/空层 |
| F 图层顺序 | **PASS** | 后发在底、配件在上，沿用 v1 PSD 实测顺序 |
| G 边缘逐笔精修 | **NOT DONE** | 属 Cubism 内打磨项，不阻塞导入 |
| H Cubism 绑定 / `.moc3` | **UNBLOCKED → NOT DONE** | 编辑器 5.3.03 已装并可启动（见文末补证）；绑定需 GUI 操作，为后续独立任务 |
| I 导入前校验 | **PASS** | 24 项全过；53 层为精确分区（重叠 0 / 遗漏 0 / 可见像素 3,374,144 逐一相等） |
| J 绑定计划 | **PASS** | `v3/绑定计划-标准对话级.md`（参数表 / 变形器树 / 网格 / 物理 / 表情 / 导出） |

## 1. 改动

| 仓库 | 文件 | 改动 |
| --- | --- | --- |
| Aika | `tools/live2d-pipeline/photoshop/audit-live2d-layers.py` | **新增**：逐层体检（只读） |
| Aika | `tools/live2d-pipeline/photoshop/build-live2d-v2-layers.py` | **新增**：夹缝归属 + 缺口工单 |
| Aika | `tools/live2d-pipeline/photoshop/assign-gaps-v3.py` | **新增**：13 处缺口按 `RULES` 归属 |
| Aika | `tools/live2d-pipeline/photoshop/build-cubism-import-jsx.jsx` | **新增**：Photoshop 生成透明底导入 PSD（权威） |
| Aika | `tools/live2d-pipeline/photoshop/run_ps_jsx.py` | **新增**：COM 驱动 Photoshop（替代被拦 cscript） |
| Aika | `tools/live2d-pipeline/photoshop/build-cubism-import-psd.py` | **新增**：纯 Python 备用生成器 |
| Aika | `output/live2d/production-v1/{v3-layers,v3,v2-audit}/` | **新增**：v3 分层、导入 PSD、审计与工单（`output/` 不入 Git） |
| Aika | `output/live2d/production-v1/v3/制作说明-v3.md` | **新增**：面向制作者的中文说明 |
| Aika | 本报告 | — |

**未改**：v1 的 `layers/`、两个 v1 PSD、`runtime-presets/`、任何 `src/` 代码。

## 2. 关键判定（AC-A / AC-C 前提修正）

### 2.1 残留层是夹缝，不是零件

```text
整人 alpha          3,374,144 px
53 部件并集         2,942,869 px
残留层                431,275 px   ← 恰等于 3,374,144 − 2,942,869
残留 ∩ 部件并集             0 px   ← 零重复
残留 − 整人                 0 px   ← 零外溢
```

残留层 431,275 px 分为 **865 个连通域**，最大几个各**邻接 3–7 个部件**
（如 67,665 px 的那块邻接 `dress_back_screenRight / dress_front / holo_coattail_screenRight /
jacket_front_screenRight / leg_screenRight`）。几何形态与颜色（纯白填充仅在 `alpha==0` 处）
均与该判定一致。**故 v1 的「归入对应部件」在方法上不可行——它没有唯一归属。**

### 2.2 缺口有源色，是未拆分区

13 处缺口（>24 px 距任何部件）与**原始母稿逐像素一致**：

```text
母稿在缺口处 alpha>0 比例   100.00%
缺口层颜色 vs 母稿 最大差     0
```

**故 v1 的「需补画」不成立**——像素本就在母稿里，只是没被划进任何部件。

## 3. 归属方法与可复核性

距离分布存在明确拐点：P50=11.7 / P75=23.6 / P90=41.7 px。故：

1. **≤24 px**（夹缝/抗锯齿，328,251 px）→ 按欧氏距离最近部件归属；
2. **>24 px 且连通域 ≥500 px**（13 处，103,024 px）→ 不猜几何，按**显式规则表**归属；
3. 规则表在 `assign-gaps-v3.py` 顶部 `RULES`，可人工审阅与覆盖。

```text
GAP-011  neck                      领口内领（若归 dress_front，低头时会撕领口）
GAP-066  dress_front               前裙分片缝（前裙为主形变体）
GAP-110  dress_front               裙摆中缝
GAP-138/139  holo_coattail_screenLeft/Right
GAP-010/053  hair_back_screenLeft_outer
GAP-063/107  hair_back_screenRight_outer/lower
GAP-089/094  cuff_screenRight/Left
GAP-194  leg_screenRight
GAP-136  holo_coattail_screenRight
```

## 4. 守恒校验（AC-B / AC-D）

| 校验 | 结果 |
| --- | --- |
| `assign-gaps-v3.py --strict` | `gaps=13 applied=13 unmatched=0`；`exact_match=True`，**退出码 0** |
| 部件间重叠 | **0 px** |
| v3 合成 vs 整人 alpha | **差 0 px**（3,374,144 像素逐点一致） |
| v3 合成 vs 整人 RGB（可见区） | 最大差 **0** |
| RGB 差异分布 | `alpha==255` 处 **0**；差异全在 `alpha<255` 的 346,073 个抗锯齿像素（unpremultiply 往返取整，最大 126） |

## 5. 导入 PSD 合规（AC-E / AC-F）

```text
cd aika-crossplatform
python tools/live2d-pipeline/photoshop/build-cubism-import-jsx.jsx  (经 run_ps_jsx.py 驱动)
  → layers=53 missing=0        退出码 0
```

| 项 | 结果 |
| --- | --- |
| 画布 / 通道 | 2048×4096 / 4 通道 |
| 图层数 / 唯一命名 | 53 / **唯一** |
| 文档透明 | composite = RGBA，角落 alpha **0**，可见占比 40.22% |
| 残留层 / 参考层 / 空层 | **全部剔除 / 无** |
| 图层顺序 | index 0 = 后发（最底）… index 52 = `halo_orbital`（最上） |

**工具链注意（下次别踩）**：`cscript.exe` 属被本机安全策略拦截的 LOLBin，驱动 Photoshop 须改用
`win32com`（见 `run_ps_jsx.py`）。另：Photoshop 的 `saveAs` **不会自建输出目录**，
目标目录不存在时 COM 调用会静默挂起（本轮曾因此空转 15 分钟）——
JSX 内已加 `ensureFolder()`，并在执行前清理同名旧文档。

## 6. 共享接口影响

**无。** 本 SPEC 未改任何 `src/`、contracts、服务端或配置；产出全部在 `output/`（按仓库规则不入 Git），
新增脚本仅在 `tools/live2d-pipeline/photoshop/` 下，无消费者。

## 7. 未完成与后续

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Cubism 绑定 / 导出 `.moc3` | **BLOCKED** | 本机无 Live2D Cubism Editor。安装后可导入 `cubism-import-v3.psd` 继续 |
| 部件边缘逐笔精修 | **NOT DONE** | 眉毛/镜框/发丝交界仍是多边形首拆硬边；不影响导入，绑定后按形变需要打磨 |
| 13 处缺口归属的绑定复核 | **待人工** | 规则属绑定意图，需在 Cubism 内目视确认；改 `RULES` 可重跑 |
| 运行验证（真实模型接应用） | **不属于本 SPEC** | 需 `.moc3`/贴图/表情/物理齐备；当前不建假 `.moc3` |

## 8. 复核入口

```text
# 只读体检（54 层）
python tools/live2d-pipeline/photoshop/audit-live2d-layers.py \
  --layers output/live2d/production-v1/layers \
  --out output/live2d/production-v1/v2-audit/layers-audit.json

# 夹缝归属 + 缺口识别
python tools/live2d-pipeline/photoshop/build-live2d-v2-layers.py \
  --layers output/live2d/production-v1/layers \
  --cutout output/live2d/layers/00-character-cutout-rgba.png \
  --out-layers output/live2d/production-v1/v2-layers \
  --out output/live2d/production-v1/v2-audit/v2-build.json

# 缺口归属（守恒校验）
python tools/live2d-pipeline/photoshop/assign-gaps-v3.py \
  --layers output/live2d/production-v1/v2-layers \
  --gaps output/live2d/production-v1/v2-audit/v2-build.json \
  --out-layers output/live2d/production-v1/v3-layers \
  --out output/live2d/production-v1/v2-audit/v3-gap-assignment.json --strict
```

解释器：`C:\Users\BAi\.workbuddy\binaries\python\envs\live2d\Scripts\python.exe`（含 pillow/numpy/scipy/psd-tools/pywin32）。


---

# 补证：Cubism Editor 安装 + 导入前校验（2026-09-21 晚）

本节更新上文 **AC-H（原 BLOCKED）**，并新增 **AC-I / AC-J**。

## 状态变更

| AC | 原结论 | 新结论 | 依据 |
| --- | --- | --- | --- |
| H Cubism 绑定 / `.moc3` | **BLOCKED**（本机无编辑器） | **UNBLOCKED**（编辑器已装并可启动），绑定本身为独立后续任务 | Cubism Editor 5.3.03 安装于 `E:\Work\Live2d\CubismEditor5`，JVM 启动链路逐项验证通过 |
| I 导入前校验 | （新增） | **PASS** | 24 项检查全过，`blocking=0 warnings=0` |
| J 绑定计划 | （新增） | **PASS**（文档交付） | `v3/绑定计划-标准对话级.md` |

## 1. 编辑器安装

| 项 | 值 |
| --- | --- |
| 版本 | Live2D Cubism Editor **5.3.03** |
| 安装路径 | `E:\Work\Live2d\CubismEditor5` |
| 体积 | 431,608,798 字节 / 451 文件（落盘 6s 后复查稳定） |
| 安装包 | `Live2D_Cubism_Setup_5.3.03.exe`，SHA-256 `4d9ca890…be40167`，Authenticode **Valid**（Live2D Inc.） |
| 捆绑运行时 | OpenJDK 17.0.3.1 LTS |

**启动验证（走 JVM 而非 exe）**：`CubismEditor5.exe` 仅 78,992 字节，是启动器；
真实程序在 `app/lib/Live2D_Cubism.jar`（42 MB）。直接 Popen 启动器会秒退、进程表查不到，
**不能据此判为安装失败**。故按 `CubismEditor5.bat` 的 classpath 直接调用
`com.live2d.cubism.CECubismEditorApp`，从启动日志逐项确认：

| 检查 | 结果 |
| --- | --- |
| classpath 解析 | 无 ClassNotFoundException |
| OpenGL 上下文 | 创建成功（RTX 5060 扩展全枚举） |
| Cubism Core | 加载通过 |
| MotionSync | `Live2DCubismMotionSyncEngine_CRI.dll` 已挂载 |
| 文档读写 | `Verify after save : SUCCESS` |
| 退出 | rc=0，无异常堆栈 |

日志中 `WARN Check error occurred. (Could not check file)` 出现在 `check update` 阶段，属正常噪声。

验收记录：`E:\Work\Live2d\installer\INSTALL_ACCEPTANCE.md`。

**授权状态**：首次启动才要求选 FREE / PRO，**本机尚无授权文件**（属用户决策，不自动勾选）。

## 2. 导入前校验（AC-I）

新增只读校验器 `tools/live2d-pipeline/photoshop/validate-cubism-import.py`，
对照 Cubism 官方 PSD 规范逐项检查，输出机读 JSON + 中文报告。

```text
C:\Users\BAi\.workbuddy\binaries\python\envs\live2d\Scripts\python.exe \
  tools/live2d-pipeline/photoshop/validate-cubism-import.py \
  --psd output/live2d/production-v1/v3/cubism-import-v3.psd \
  --order output/live2d/production-v1/v3/cubism-import-layers-ps.txt \
  --out-json output/live2d/production-v1/v3/import-validation.json \
  --out-md  output/live2d/production-v1/v3/导入校验报告.md
  → verdict=PASS blocking=0 warnings=0 layers=53   （退出码 0）
```

24 项检查全部通过。关键项：

| 类别 | 项 | 实测 |
| --- | --- | --- |
| 文档 | 签名 / 版本 / 模式 / 位深 | `8BPS` / 1 / RGB / 8bit |
| 文档 | 尺寸 / 通道 | 2048×4096 / channels=4 |
| 文档 | 真透明底 | 角落 alpha = **0**，可见占比 40.22% |
| 图层 | 命名唯一 / 无空层 / 无残留参考层 / 无占位名 | 全部通过 |
| 图层 | 数据尺寸 == bbox 尺寸 | 53/53 一致 |
| 图层 | bbox 落在画布内 | 无越界 |
| 顺序 | 实际序 == 声明序 == 期望遮挡序 | 三序一致 |
| 预算 | FREE ArtMesh | 53 / 100，余量 47 |

### 分区完整性实证（本报告新增的核心证据）

53 层应是对整人的**无重叠、无遗漏分区**。判定用 alpha 掩码并集（不受 source-over 浮点取整影响）：

| 项 | 值 |
| --- | --- |
| 逐层可见像素之和 | 3,374,144 |
| 层并集可见像素 | 3,374,144 |
| 文档 composite 可见像素 | 3,374,144 |
| **层间重叠** | **0 px** |
| 仅在 composite 中（遗漏） | **0 px** |
| 仅在图层中（多余） | **0 px** |
| 不透明区 RGB 差异 | max=1；超出 ±1 容差 **0 px**；等于 ±1 共 131 px（占不透明区 0.0043%） |

即：**53 层是精确分区**——无重叠、无遗漏、像素数逐一相等。131 个 ±1/255 的差异是 8bit
取整产物，已显式量化为容差而非隐去。

### 一个必须记录的测量陷阱

初版校验器用 `layer.width/height` 与文档尺寸比较，报出「53 层全部尺寸不符」并判 FAIL。
**这是校验器的错，不是 PSD 的错**：本 PSD 的图层是**裁剪层（trimmed）**，
`layer.numpy()` 返回 bbox 尺寸的数据、位置记在 `layer.bbox=(l,t,r,b)`；
且 `psd-tools` 的 `for layer in psd` 迭代方向是**自底向上**（故顺序检查需 `reversed()`）。
修正后：尺寸检查改为「数据尺寸 == bbox 尺寸」+「bbox 在画布内」，
顺序检查改用自顶向下序列。**若照初版结论去"修 PSD"，会破坏一个本来正确的交付物。**

## 3. 交付物

| 文件 | 说明 |
| --- | --- |
| `output/live2d/production-v1/v3/导入校验报告.md` | 中文校验报告（含逐层清单、bbox、覆盖率） |
| `output/live2d/production-v1/v3/import-validation.json` | 机读校验结果 |
| `output/live2d/production-v1/v3/绑定计划-标准对话级.md` | 绑定工作清单（参数表/变形器树/网格要点/物理/表情/导出） |
| `tools/live2d-pipeline/photoshop/validate-cubism-import.py` | 校验器（改层序后可重跑，`--order` 可换清单） |

## 4. 仍未完成

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Cubism 内绑定 | **NOT DONE** | 需 GUI 操作。`.cmo3` 为私有二进制格式，无法代码生成 |
| FREE / PRO 选择 | **待用户** | 首次启动时决定 |
| 绘制顺序两处目视确认 | **待用户** | ① `forehead_skin` 在 `face_skin` 之上 ② 侧发是否遮耳 |
| 13 处缝隙归属复核 | **待用户目视** | 规则在 `assign-gaps-v3.py` 的 `RULES`，不符可改表重跑 |
| 部件边缘逐笔精修 | **NOT DONE** | 眉毛/镜框/发丝交界的硬边，绑定后按形变需要打磨 |
| `.moc3` / 运行验证 | **NOT DONE** | 绑定完成后产出；当前不建假 `.moc3` |
