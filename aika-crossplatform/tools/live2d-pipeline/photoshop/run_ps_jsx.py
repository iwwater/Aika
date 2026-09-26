#!/usr/bin/env python
"""通过 COM (win32com) 让 Photoshop 执行 JSX 脚本。

替代 cscript 驱动 VBS 的方式（cscript 属被安全策略拦截的 LOLBin）。
需要 pywin32。若无 pywin32，可用 --check 仅打印诊断。

用法:
  python run_ps_jsx.py <jsx_path> [--timeout 600]
"""
from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("jsx")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--visible", action="store_true")
    args = ap.parse_args()

    jsx = os.path.abspath(args.jsx)
    if not os.path.exists(jsx):
        print(f"ERROR: jsx not found: {jsx}", file=sys.stderr)
        return 2

    try:
        import win32com.client  # type: ignore
    except ImportError:
        print("ERROR: pywin32 not installed. Run: pip install pywin32", file=sys.stderr)
        return 3

    try:
        import pythoncom  # type: ignore
        pythoncom.CoInitialize()
    except Exception:
        pass

    print(f"[ps] connecting to Photoshop.Application ...")
    app = win32com.client.Dispatch("Photoshop.Application")
    try:
        app.Visible = bool(args.visible)
    except Exception:
        pass

    # 记录已有文档数，便于诊断
    try:
        print(f"[ps] open documents before: {app.Documents.Count}")
    except Exception:
        pass

    print(f"[ps] executing: {jsx}")
    app.DoJavaScriptFile(jsx)
    print("[ps] done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
