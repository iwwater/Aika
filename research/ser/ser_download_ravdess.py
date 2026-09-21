# -*- coding: utf-8 -*-
"""
下载 RAVDESS speech 子集（1440 段）到本地 E 盘，绕开 hf_hub 的 hf_xet 下载 bug。

背景：本机 hf_hub 用 hf_xet 库下载 xet 存储文件会得到 0 字节（bug），
     但 requests 直接下载 xet-bridge CDN 完全正常（已验证 200 + RIFF header）。
     故此处用 requests 直连下载 MahiA/RAVDESS 的 speech wav（文件名保留 7-part 命名）。

文件命名：03-01-XX-YY-... 中第 2 段=声道(01=speech)、第 3 段=情绪(01-08)。
只下载 speech（第 2 段=01）。

用法：
    python ser_download_ravdess.py              # 下载全部 1440 段（断点续传）
    python ser_download_ravdess.py --max 20     # 只下前 20 段(调试)
"""
import os, sys, time, argparse, re
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ser_common import RAVDESS_DATA_DIR, setup_environment
from ser_log import setup_logger

setup_environment()

DATA_DIR = RAVDESS_DATA_DIR
REPO = "MahiA/RAVDESS"
BASE_URL = f"https://huggingface.co/datasets/{REPO}/resolve/main/"
SPEECH_RE = re.compile(r"^audios/03-01-")  # 第 2 段=01 → speech


def download_one(path, log):
    """下载单个文件，返回 (path, ok, size, err)。断点：已存在且 RIFF 则跳过。"""
    local = os.path.join(DATA_DIR, os.path.basename(path))
    if os.path.exists(local) and os.path.getsize(local) > 44:
        with open(local, "rb") as f:
            if f.read(4) == b"RIFF":
                return (path, True, os.path.getsize(local), "cached")

    import requests
    url = BASE_URL + path
    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=60)
            if r.status_code == 200 and r.content[:4] == b"RIFF" and len(r.content) > 44:
                with open(local, "wb") as f:
                    f.write(r.content)
                return (path, True, len(r.content), None)
            last_err = f"status={r.status_code} len={len(r.content)}"
        except Exception as e:
            last_err = repr(e)[:120]
        time.sleep(1.5 * (attempt + 1))
    return (path, False, 0, last_err)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=0, help="限制数量(调试)")
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    log, logpath = setup_logger("ravdess_download", "download_ravdess")
    os.makedirs(DATA_DIR, exist_ok=True)

    from huggingface_hub import HfApi
    api = HfApi()
    log.info("获取 RAVDESS 文件列表", extra={"params": {"repo": REPO}})
    all_files = [f for f in api.list_repo_files(REPO, repo_type="dataset")]
    speech = [f for f in all_files if SPEECH_RE.match(f)]
    log.info(f"speech 文件数 {len(speech)}", extra={"params": {"n": len(speech)}})

    targets = speech[:args.max] if args.max else speech

    ok, fail = 0, 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        futs = {ex.submit(download_one, p, log): p for p in targets}
        for i, fut in enumerate(as_completed(futs), 1):
            path, good, size, err = fut.result()
            if good:
                ok += 1
            else:
                fail += 1
                log.error(f"下载失败 {path}", extra={
                    "audio": path, "params": {"err": err}})
            if i % 200 == 0:
                log.info(f"进度 {i}/{len(targets)}", extra={
                    "params": {"done": i, "ok": ok, "fail": fail}})

    log.info("下载完成", extra={
        "params": {"ok": ok, "fail": fail,
                   "elapsed_s": round(time.time() - t0, 1)}})
    print(f"\n下载完成：成功 {ok} / 失败 {fail}，存 {DATA_DIR}\n")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
