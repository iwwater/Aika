import os, shutil

def probe():
    print("=== conda 位置 ===")
    for p in [
        r"D:\ANACONDA\Scripts\conda.exe",
        r"D:\ANACONDA\condabin\conda.bat",
        r"D:\ANACONDA\_conda.exe",
        r"D:\ANACONDA\conda.exe",
    ]:
        print(f"  {p}: {os.path.exists(p)}")
    print("=== envs ===")
    envs = r"D:\ANACONDA\envs"
    if os.path.isdir(envs):
        print("  " + ", ".join(sorted(os.listdir(envs))))
    else:
        print("  N/A (no envs dir)")
    print("=== 磁盘 ===")
    for d in ["C:/", "D:/", "E:/"]:
        try:
            u = shutil.disk_usage(d)
            print(f"  {d} free={u.free/1e9:.1f}GB used={u.used/1e9:.1f}GB total={u.total/1e9:.1f}GB")
        except Exception as e:
            print(f"  {d} ERR {e}")
    print("=== demo audio ===")
    demo = r"E:\Work\AI CHAT\demo\aika-emotion-demo\audio"
    if os.path.isdir(demo):
        for root, dirs, files in os.walk(demo):
            dirs.sort()
            for f in sorted(files):
                rel = os.path.relpath(os.path.join(root, f), demo)
                print("  " + rel)
    else:
        print("  N/A")
    print("=== GPT-SoVITS 根目录 ===")
    g = r"E:\Work\Chat_model\GPT-SoVITS"
    if os.path.isdir(g):
        for name in sorted(os.listdir(g)):
            print("  " + name)

if __name__ == "__main__":
    probe()
