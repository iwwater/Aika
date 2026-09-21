# -*- coding: utf-8 -*-
"""
SER 实验统一日志基础设施（见 docs/ser/SPEC_SER-02.md 第 1 节）。

用法（每个实验脚本开头）：
    from ser_log import setup_logger
    log, logpath = setup_logger("exp1", "embedding_umap")
    log.info("模型加载完成", extra={"model": "iic/emotion2vec_plus_large"})
    log.info("处理音频", extra={"audio": path, "slug": "yasashii",
                               "kind": "ref(真人)", "elapsed_s": 0.21})

规范要点：
- 同时输出 console（人类可读）+ JSONL 文件（结构化，一行一事件，落 output/logs/）。
- 日志文件按「实验名_时间戳.jsonl」命名，只追加不删除（历史运行全留痕）。
- 任何异常必须 log.exception()（自动带 traceback），禁止静默 except。
"""
import logging, json, os, sys, traceback
from datetime import datetime

# ---- 环境补丁（SER-04：集中到 ser_common.setup_environment）----
# ser venv 是用 GPTSoVits 的 conda python 创建的，标准库 C 扩展 _lzma 依赖 base conda 的
# liblzma.dll；缓存重定向也统一在此处理。显式环境变量优先（setdefault），不回退 C 盘。
try:
    from ser_common import setup_environment
    setup_environment()
except ImportError:
    # ser_common 不可用时退回内联 DLL 补丁，保持本模块独立可用
    if os.path.isdir(r"D:\ANACONDA\Library\bin"):
        os.add_dll_directory(r"D:\ANACONDA\Library\bin")

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output", "logs")


class JsonlHandler(logging.Handler):
    """把日志写成 JSONL，一行一个结构化事件，方便 grep / 回溯。"""

    def __init__(self, path):
        super().__init__()
        self.path = path

    def emit(self, record):
        try:
            entry = {
                "ts": datetime.now().isoformat(timespec="milliseconds"),
                "level": record.levelname,
                "event": record.getMessage(),
            }
            for k in ("audio", "model", "slug", "kind", "elapsed_s", "params"):
                v = getattr(record, k, None)
                if v is not None:
                    entry[k] = v
            if record.exc_info:
                entry["traceback"] = "".join(
                    traceback.format_exception(*record.exc_info)
                )
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            # 日志本身绝不能拖垮实验，但证据静默丢失必须可见（SER-04 R3）。
            # 只写 stderr，不递归调用本 handler；stderr 也不可用时才放弃。
            try:
                sys.stderr.write(
                    f"[ser_log] JSONL 日志写失败 path={self.path!r} "
                    f"reason={e!r} event={record.getMessage()!r}"
                    f"（该条证据仅存控制台输出）\n")
                sys.stderr.flush()
            except Exception:
                pass


def setup_logger(name, experiment):
    """返回 (logger, logpath)。experiment 用作日志文件前缀。"""
    os.makedirs(LOG_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    logpath = os.path.join(LOG_DIR, f"{experiment}_{ts}.jsonl")

    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.propagate = False

    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%H:%M:%S"))
    logger.addHandler(ch)
    logger.addHandler(JsonlHandler(logpath))

    logger.info(f"实验 {experiment} 启动，日志文件: {logpath}")
    return logger, logpath
