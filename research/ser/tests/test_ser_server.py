# -*- coding: utf-8 -*-
"""ser_server 单元测试（SER-05 AC-A / AC-C / AC-D）。

运行：
    research/ser/.venv/Scripts/python.exe -m unittest \
        discover -s research/ser/tests -p "test_ser_server.py" -v

约束（SPEC）：引擎为可注入 fake，真实路由/路径校验/音频预处理/响应组装走生产代码；
导入本模块/被测模块不加载真实模型、不起真实服务、不占 GPU。
"""
import io
import json
import math
import os
import struct
import sys
import tempfile
import threading
import time
import unittest
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ser_server  # noqa: E402  （导入即完成环境初始化；模型懒加载，不会加载真实权重）
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(ser_server.app)


def make_wav_bytes(sr=16000, secs=0.3, freq=440.0):
    """生成合法 16kHz 单声道 wav bytes（纯音）。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = b"".join(
            struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / sr)))
            for i in range(int(sr * secs)))
        w.writeframes(frames)
    return buf.getvalue()


class FakeModel:
    """可注入 fake 引擎：记录调用，返回固定 9 类响应。"""

    def __init__(self, labels=("中立/neutral", "生气/angry", "<unk>"),
                 scores=(0.4, 0.35, 0.25), fail=False):
        self.labels, self.scores, self.fail = labels, scores, fail
        self.calls = 0
        self.calls_lock = threading.Lock()

    def generate(self, **kwargs):
        with self.calls_lock:
            self.calls += 1
        if self.fail:
            raise RuntimeError("fake inference failure")
        return [{"labels": list(self.labels), "scores": [float(s) for s in self.scores]}]


class FakeSlowModel(FakeModel):
    """可控屏障的 fake：可验证推理不重叠、health 在推理期间可用。"""

    def __init__(self):
        super().__init__()
        self.active = 0
        self.active_lock = threading.Lock()
        self.in_flight = threading.Event()
        self.release = threading.Event()
        self.overlap_detected = False

    def generate(self, **kwargs):
        with self.active_lock:
            if self.active != 0:
                self.overlap_detected = True  # 有请求在别的请求仍持锁时进入
            self.active += 1
        with self.calls_lock:
            self.calls += 1
        try:
            self.in_flight.set()
            self.release.wait(timeout=10)  # 事件屏障挂起（不靠 sleep 推断）
            return super().generate(**kwargs)
        finally:
            with self.active_lock:
                self.active -= 1


def install(fake):
    ser_server._model = fake  # 可注入引擎（不触真实模型加载）


class SERServerTestBase(unittest.TestCase):
    def setUp(self):
        self._old_model = ser_server._model
        self._old_audio_dir = ser_server.DEMO_AUDIO_DIR
        self.fake = FakeModel()
        install(self.fake)
        self.tmp = tempfile.TemporaryDirectory()
        ser_server.DEMO_AUDIO_DIR = self.tmp.name  # 临时目录 fixture

    def tearDown(self):
        ser_server._model = self._old_model
        ser_server.DEMO_AUDIO_DIR = self._old_audio_dir
        self.tmp.cleanup()


class TestACAPathValidation(SERServerTestBase):
    def _write(self, rel, data):
        p = os.path.join(self.tmp.name, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_valid_audio_ok(self):
        self._write("ref/mood01.wav", make_wav_bytes())
        r = client.post("/predict/path", json={"path": "ref/mood01.wav"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["top"], "neutral")
        self.assertEqual(self.fake.calls, 1)

    def test_missing_404(self):
        r = client.post("/predict/path", json={"path": "ref/not_here.wav"})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.fake.calls, 0)

    def test_parent_escape_400_and_not_read(self):
        # 越界文件是合法 wav：若被读取+送模型，calls 会 >0（违规可检出）
        self._write("../secret.wav", make_wav_bytes())
        r = client.post("/predict/path", json={"path": "ref/../../secret.wav"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.fake.calls, 0)

    def test_absolute_path_400(self):
        p = self._write("abs.wav", make_wav_bytes())
        r = client.post("/predict/path", json={"path": p})  # 绝对路径直接拒绝
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.fake.calls, 0)

    def test_same_prefix_sibling_dir_400(self):
        """同前缀兄弟目录（audio vs audio_backup）不再被字符串前缀放行。"""
        self._write("../audio_backup/x.wav", make_wav_bytes())
        r = client.post("/predict/path", json={"path": "../audio_backup/x.wav"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.fake.calls, 0)

    def test_link_outside_root(self):
        """根内链接指向根外 → 400（realpath 解析 + 组件包含判断）。"""
        outside = self._write("../outside/x.wav", make_wav_bytes())
        link = os.path.join(self.tmp.name, "link_out.wav")
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            self.skipTest("平台不能创建符号链接（需管理员/开发者模式）→ NOT RUN")
        # Windows 无特权时 symlink 会"创建成功但不可解析"（islink=False）——同样视为不可用
        if not (os.path.islink(link) and os.path.isfile(link)):
            self.skipTest("平台创建的符号链接不可解析（islink/isfile=False）→ NOT RUN")
        r = client.post("/predict/path", json={"path": "link_out.wav"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.fake.calls, 0)

    def test_empty_path_400(self):
        r = client.post("/predict/path", json={"path": "   "})
        self.assertEqual(r.status_code, 400)


class TestACCConcurrency(unittest.TestCase):
    def setUp(self):
        self._old_model = ser_server._model
        self._old_audio_dir = ser_server.DEMO_AUDIO_DIR
        self.fake = FakeSlowModel()
        install(self.fake)
        self.tmp = tempfile.TemporaryDirectory()
        ser_server.DEMO_AUDIO_DIR = self.tmp.name
        os.makedirs(os.path.join(self.tmp.name, "ref"), exist_ok=True)
        with open(os.path.join(self.tmp.name, "ref", "a.wav"), "wb") as f:
            f.write(make_wav_bytes())

    def tearDown(self):
        ser_server._model = self._old_model
        ser_server.DEMO_AUDIO_DIR = self._old_audio_dir
        self.tmp.cleanup()

    def test_serial_inference_and_health_available(self):
        results = {}

        def do_predict(key):
            c = TestClient(ser_server.app)
            results[key] = c.post("/predict/path", json={"path": "ref/a.wav"})

        t1 = threading.Thread(target=do_predict, args=("first",))
        t1.start()
        self.assertTrue(self.fake.in_flight.wait(timeout=10), "推理未进入挂起态")

        # 推理被屏障挂起期间，/health 仍能完成（不取推理锁）
        hc = TestClient(ser_server.app)
        t0 = time.time()
        r = hc.get("/health")
        health_ms = (time.time() - t0) * 1000
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["loaded"])
        self.assertLess(health_ms, 5000, "health 被推理阻塞")

        self.fake.release.set()  # 释放屏障收尾
        t1.join(timeout=15)
        self.assertEqual(results["first"].status_code, 200)

        # 第二个请求：进入时第一个必须已出锁（不重叠）
        do_predict("second")
        self.assertEqual(results["second"].status_code, 200)
        self.assertFalse(self.fake.overlap_detected, "检测到推理重叠")


class TestACDFakeModelRoutes(SERServerTestBase):
    def test_upload_ok_fields(self):
        r = client.post("/predict", files={"file": ("upload.wav", make_wav_bytes(), "audio/wav")})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        for k in ("top", "top_ja", "top_zh", "scores", "elapsed_s", "duration_s", "model", "src"):
            self.assertIn(k, body)
        self.assertEqual(body["src"], "upload.wav")
        self.assertEqual(body["top"], "neutral")  # 复合标签归一化（SER-04 规则）
        self.assertEqual(body["scores"][0]["label"], "neutral")

    def test_upload_corrupt_400(self):
        r = client.post("/predict", files={"file": ("bad.wav", b"\x00\x01not-a-wav", "audio/wav")})
        self.assertEqual(r.status_code, 400)

    def test_upload_empty_400(self):
        r = client.post("/predict", files={"file": ("empty.wav", b"", "audio/wav")})
        self.assertEqual(r.status_code, 400)

    def test_inference_failure_500(self):
        install(FakeModel(fail=True))
        r = client.post("/predict", files={"file": ("ok.wav", make_wav_bytes(), "audio/wav")})
        self.assertEqual(r.status_code, 500)

    def test_unknown_top_normalized(self):
        install(FakeModel(labels=("<unk>", "生气/angry"), scores=(0.9, 0.1)))
        r = client.post("/predict/path", json={"path": "no-such.wav"})  # 先确认路径层在前
        self.assertEqual(r.status_code, 404)  # 不存在文件不触模型（calls=0 由其他用例保证）
        self._write_rel()

    def _write_rel(self):
        p = os.path.join(self.tmp.name, "a.wav")
        with open(p, "wb") as f:
            f.write(make_wav_bytes())
        install(FakeModel(labels=("<unk>", "生气/angry"), scores=(0.9, 0.1)))
        r = client.post("/predict/path", json={"path": "a.wav"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["top"], "unknown")


if __name__ == "__main__":
    unittest.main()
