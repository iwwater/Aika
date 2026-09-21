# -*- coding: utf-8 -*-
"""
SER 情绪识别服务（成品 demo 后端）。

封装 emotion2vec+ large（零样本语音情绪识别，纯声学、不看词义），
对任意输入音频输出 9 类情绪分数，供前端单页 demo 调用。

技术要点（均已在 M0 实验中验证，勿重复踩坑）：
- 模型：`iic/emotion2vec_plus_large`（300M / 42526h，权重已缓存 E 盘）。
- 调用：必须 `model.generate(input=..., granularity="utterance", extract_embedding=False)`
  （用 `model()` 会把参数 dict 误当 source → 报 dict.unsqueeze 错误）。
- 标签：large 返回「中文/英文」格式（如「生气/angry」），须归一化成纯英文。
- 音频：soundfile 读 bytes → 立体声转单声道 → 48k 等重采样到 16kHz。
- 缓存/日志：MODELSCOPE_CACHE 指向 E 盘；走 ser_log 落 JSONL，出问题可回溯。

启动：python ser_server.py [--port 8787]
"""
import os, sys, io, json, time, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ser_common import (DEMO_AUDIO_DIR, SER_ROOT, parse_emotion2vec_result,
                        setup_environment)
from ser_log import setup_logger  # noqa: E402  (含环境初始化 + JSONL 日志)

setup_environment()

log, _logpath = setup_logger("ser_server", "server")

# ---- 路径常量（由 ser_common 推导；保留既有目录布局）----
SER_DIR = SER_ROOT
FRONTEND_DIR = os.path.join(os.path.dirname(SER_ROOT), "..", "demo", "ser-demo")
FRONTEND_DIR = os.path.abspath(FRONTEND_DIR)

MODEL_ID = "iic/emotion2vec_plus_large"

# ---- 情绪标签元数据（9 类，label 为归一化后的英文主键）----
EMOTIONS = [
    {"label": "angry",     "ja": "怒り",   "zh": "生气", "color": "#e05a4e"},
    {"label": "disgusted", "ja": "嫌悪",   "zh": "厌恶", "color": "#8a9a5b"},
    {"label": "fearful",   "ja": "恐怖",   "zh": "恐惧", "color": "#7b5ea7"},
    {"label": "happy",     "ja": "喜び",   "zh": "开心", "color": "#f0ad4e"},
    {"label": "neutral",   "ja": "平静",   "zh": "中立", "color": "#8a94a6"},
    {"label": "other",     "ja": "その他", "zh": "其他", "color": "#9aa0aa"},
    {"label": "sad",       "ja": "悲しみ", "zh": "难过", "color": "#4f93d6"},
    {"label": "surprised", "ja": "驚き",   "zh": "吃惊", "color": "#3fa89b"},
    {"label": "unknown",   "ja": "不明",   "zh": "未知", "color": "#6b7280"},
]
_EMOTION_BY_LABEL = {e["label"]: e for e in EMOTIONS}

# ---- 6 mood 元数据（用户自建情绪集，含 M0 研究得出的 emotion2vec 参考预测）----
MOODS = [
    {"slug": "yasashii",  "ja": "優しい", "zh": "温柔", "color": "#e8799e", "ref_pred": "happy",
     "note": "large 修正为「开心」"},
    {"slug": "anshin",    "ja": "安心",   "zh": "安心", "color": "#4f93d6", "ref_pred": "surprised",
     "note": "偏向平静/惊喜"},
    {"slug": "shinmitsu", "ja": "親密",   "zh": "亲密", "color": "#a97bd4", "ref_pred": "surprised",
     "note": "三来源最稳定的情绪"},
    {"slug": "hiniku",    "ja": "皮肉",   "zh": "嘲讽", "color": "#e08b45", "ref_pred": "surprised",
     "note": "反讽难判，SER 公认难点"},
    {"slug": "dokuzetsu", "ja": "毒舌",   "zh": "毒舌", "color": "#d9534f", "ref_pred": "angry",
     "note": "真人段修正为「生气」"},
    {"slug": "kongan",    "ja": "懇願",   "zh": "恳求", "color": "#3fa89b", "ref_pred": "fearful",
     "note": "跨语言稳定映射"},
]
_MOOD_BY_SLUG = {m["slug"]: m for m in MOODS}

# ---- 模型单例（懒加载 + 线程安全）----
_model = None
_model_lock = threading.Lock()
_infer_lock = threading.Lock()


def get_model():
    """懒加载 emotion2vec+ large，多线程安全。"""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from funasr import AutoModel
                log.info("加载 emotion2vec+ 模型", extra={"model": MODEL_ID})
                _model = AutoModel(model=MODEL_ID)
                log.info("模型加载完成", extra={"model": MODEL_ID})
    return _model


def decode_audio(raw: bytes):
    """任意格式音频 bytes → 16kHz 单声道 float32 numpy。返回 (y16, orig_sr, dur_s)。"""
    import numpy as np
    import soundfile as sf
    y, sr = sf.read(io.BytesIO(raw), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)  # 立体声 → 单声道
    if sr != 16000:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=16000).astype(np.float32)
    return y, int(sr), round(len(y) / 16000.0, 2)


def predict_core(y16):
    """对 16kHz 单声道 numpy 推理，返回排序后的情绪结果 dict。"""
    model = get_model()
    with _infer_lock:
        res = model.generate(input=y16, granularity="utterance", extract_embedding=False)

    # SER-04：标签解析统一走 ser_common（复合标签归一化 / <unk>→unknown / 异常显式报错）
    pred_map = parse_emotion2vec_result(res)
    pairs = sorted(pred_map.items(), key=lambda x: -x[1])
    return pairs


def make_result(pairs, elapsed_s, dur_s, src_label):
    """把排序后的 (label, score) 打包成前端友好的 JSON。"""
    scores = []
    for label, score in pairs:
        meta = _EMOTION_BY_LABEL.get(label, {"label": label, "ja": label, "zh": label, "color": "#888"})
        scores.append({"label": label, "ja": meta["ja"], "zh": meta["zh"],
                       "color": meta["color"], "score": round(score, 4)})
    top = scores[0] if scores else None
    return {
        "top": top["label"] if top else None,
        "top_ja": top["ja"] if top else None,
        "top_zh": top["zh"] if top else None,
        "scores": scores,
        "elapsed_s": round(elapsed_s, 3),
        "duration_s": dur_s,
        "model": MODEL_ID.split("/")[-1],
        "src": src_label,
    }


# ===================== FastAPI =====================
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Aika SER 情绪识别服务", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class PathRequest(BaseModel):
    path: str  # 相对 DEMO_AUDIO_DIR 的路径，如 "ref/mood01.wav"


class PathDenied(Exception):
    """请求路径越界/非法（对应 HTTP 400）。"""


class PathNotFound(Exception):
    """路径合法但文件不存在（对应 HTTP 404）。"""


def resolve_demo_audio(rel_path: str) -> str:
    """校验并解析 demo 音频相对路径（SER-05）。

    规则：把允许根目录与候选路径都解析为规范路径（realpath，解析符号链接），
    再按**路径组件**判断包含关系——拒绝绝对路径、越界父目录、同前缀兄弟目录
    （如 audio_backup）及指向根目录之外的链接。先校验，后打开文件。
    """
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise PathDenied("空路径")
    if os.path.isabs(rel_path) or (os.name == "nt" and rel_path.startswith(("\\\\", "//"))):
        raise PathDenied("非法路径：拒绝绝对路径")
    root = os.path.realpath(DEMO_AUDIO_DIR)
    candidate = os.path.realpath(os.path.join(DEMO_AUDIO_DIR, rel_path))
    try:
        rel = os.path.relpath(candidate, root)
    except ValueError:  # Windows 跨盘符等
        raise PathDenied("非法路径")
    if rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel):
        raise PathDenied("非法路径：越出允许目录")
    return candidate


def _denied_to_http(e: Exception) -> HTTPException:
    if isinstance(e, PathDenied):
        return HTTPException(400, str(e))
    if isinstance(e, PathNotFound):
        return HTTPException(404, str(e))
    return HTTPException(500, "内部错误")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_ID.split("/")[-1],
        "loaded": _model is not None,
        "emotions": len(EMOTIONS),
        "moods": len(MOODS),
    }


@app.get("/meta")
def meta():
    """返回情绪标签元数据 + 6 mood 元数据 + 可选 demo 音频清单。"""
    demos = []
    for grp, grp_name in [("ref", "真人参考"), ("A", "自训 aika 声线"), ("C", "底模 zero-shot")]:
        for i in range(1, 7):
            slug = MOODS[i - 1]["slug"]
            m = _MOOD_BY_SLUG[slug]
            demos.append({
                "path": f"{grp}/mood{i:02d}.wav",
                "group": grp, "group_name": grp_name,
                "slug": slug, "ja": m["ja"], "zh": m["zh"], "color": m["color"],
                "ref_pred": m["ref_pred"],
            })
    return {"emotions": EMOTIONS, "moods": MOODS, "demos": demos}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    """上传音频文件 → 情绪识别。

    SER-05：解码与同步推理经线程池执行（fastapi 的 run_in_threadpool），
    不阻塞事件循环；/health 在推理进行期间仍可响应。推理串行由 _infer_lock 保证。
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "空文件")

    t0 = time.time()
    try:
        dur_s, pairs, elapsed_s = await run_in_threadpool(_decode_and_predict, raw)
    except DecodeError as e:
        log.exception("音频解码失败", extra={"audio": file.filename})
        raise HTTPException(400, f"无法解码音频（支持 wav/mp3/flac/ogg）：{e}")
    except Exception:
        log.exception("推理失败", extra={"audio": file.filename})
        raise HTTPException(500, "推理失败，详见服务日志")

    result = make_result(pairs, elapsed_s, dur_s, file.filename)
    log.info("预测完成", extra={
        "audio": file.filename, "model": MODEL_ID,
        "params": {"top": result["top"], "dur_s": dur_s, "elapsed_s": result["elapsed_s"]}})
    return result


class DecodeError(Exception):
    pass


def _decode_and_predict(raw: bytes):
    """解码 + 推理（线程池内执行）。返回 (dur_s, pairs, elapsed_s)。"""
    try:
        y16, orig_sr, dur_s = decode_audio(raw)
    except Exception as e:
        raise DecodeError(str(e))
    t0 = time.time()
    pairs = predict_core(y16)
    return dur_s, pairs, time.time() - t0


@app.post("/predict/path")
def predict_path(req: PathRequest):
    """对 demo 音频（DEMO_AUDIO_DIR 下相对路径）做情绪识别。

    SER-05：路径用 resolve_demo_audio 校验（规范路径 + 组件级包含），
    先校验再打开；本路由为同步 def，FastAPI 自动放入线程池，不阻塞事件循环。
    """
    try:
        full = resolve_demo_audio(req.path)
    except (PathDenied, PathNotFound) as e:
        raise _denied_to_http(e)
    if not os.path.isfile(full):  # realpath 后的二次确认（校验与打开之间无自定义判断逻辑）
        raise HTTPException(404, f"音频不存在: {req.path}")

    with open(full, "rb") as f:
        raw = f.read()
    try:
        y16, orig_sr, dur_s = decode_audio(raw)
    except Exception as e:
        log.exception("音频解码失败", extra={"audio": req.path})
        raise HTTPException(400, f"解码失败：{e}")

    t0 = time.time()
    try:
        pairs = predict_core(y16)
    except Exception:
        log.exception("推理失败", extra={"audio": req.path})
        raise HTTPException(500, "推理失败，详见服务日志")

    result = make_result(pairs, time.time() - t0, dur_s, req.path)
    log.info("预测完成(demo)", extra={
        "audio": req.path, "model": MODEL_ID,
        "params": {"top": result["top"], "dur_s": dur_s, "elapsed_s": result["elapsed_s"]}})
    return result


# ---- 静态资源：demo 音频 + 前端 ----
app.mount("/audio", StaticFiles(directory=DEMO_AUDIO_DIR), name="audio")


@app.get("/")
def index():
    fp = os.path.join(FRONTEND_DIR, "index.html")
    if not os.path.isfile(fp):
        return JSONResponse({"error": "前端 index.html 缺失"}, status_code=500)
    return FileResponse(fp)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    import uvicorn
    log.info("服务启动", extra={"params": {"host": args.host, "port": args.port}})
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
