# -*- coding: utf-8 -*-
"""本机校验：提取 index.html 的 <script> 并检查语法 + 音频路径是否都存在。"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(HERE, "index.html")
NODE = r"C:\Users\BAi\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

html = open(HTML, encoding="utf-8").read()
m = re.search(r"<script>(.*?)</script>", html, re.S)
js = m.group(1)
tmp = os.path.join(HERE, "_check.js")
open(tmp, "w", encoding="utf-8").write(js)

print("script chars:", len(js))
print("declared items:", js.count("{combo:"))

r = subprocess.run([NODE, "--check", tmp], capture_output=True, text=True)
print("node --check:", "OK" if r.returncode == 0 else "FAIL")
if r.returncode != 0:
    print(r.stderr[:800])
os.remove(tmp)

# 音频路径存在性
missing = []
for path in re.findall(r'src:"(audio/[^"]+)"', js):
    if not os.path.exists(os.path.join(HERE, path)):
        missing.append(path)
print("audio refs:", len(re.findall(r'src:"(audio/[^"]+)"', js)), "missing:", missing or "none")

# 标签配对粗查
for tag in ["html", "head", "body", "script", "style"]:
    o = len(re.findall(rf"<{tag}[\s>]", html))
    c = len(re.findall(rf"</{tag}>", html))
    print(f"  <{tag}> {o} open / {c} close")
