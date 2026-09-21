# -*- coding: utf-8 -*-
"""SER-03 R2/R4 定向测试：生产落盘证据保留与指标呈现。

关闭条件（OPTIMIZATION_REVIEW_20260921.md R2/R4）：
- 临时目录中连续两次生产落盘，第一次文件哈希不变；预置旧 metrics/confusion 亦不变；
- --max 产物与完整批次分离；
- 新产物可离线复算（samples.jsonl → score_run 与 metrics.json 一致）；
- 同名 run 目录冲突明确拒绝（exit 4），不静默覆盖；
- 缺类 / 无成功样本 / 合法零分 / 正常四类 fixture 覆盖生产汇总路径；
  JSON 保留 null，控制台 N/A 与 0 分区分。
禁止用真实模型重跑：全部假模型 + 假 load_16k + 临时目录。
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ser_log
import ser_ravdess_baseline as srb
from ser_metrics import score_run

# 9 类 emotion2vec 标签（复合形式，走生产归一化）
PRED_HAPPY = (["生气/angry", "开心/happy"], [0.1, 0.9])
PRED_SAD = (["开心/happy", "悲伤/sad"], [0.1, 0.9])


class FakeModel:
    """按脚本逐次返回；脚本耗尽后重复最后一项。元素为 (labels, scores) 或 Exception。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def generate(self, **kw):
        i = min(self.calls, len(self.script) - 1)
        self.calls += 1
        item = self.script[i]
        if isinstance(item, Exception):
            raise item
        labels, scores = item
        return [{"labels": labels, "scores": scores}]


def mk_wavs(tmpdir, emotions):
    """按 RAVDESS 7-part 命名造空 wav（内容永不读取：load_16k 被替换）。"""
    code = {"neutral": "01", "calm": "02", "happy": "03", "sad": "04",
            "angry": "05", "fearful": "06", "disgust": "07", "surprised": "08"}
    paths = []
    for k in emotions:
        p = os.path.join(tmpdir, f"03-01-{code[k]}-01-01-01-01.wav")
        with open(p, "wb") as f:
            f.write(b"RIFFdummy")
        paths.append(p)
    return paths


ALL_EMOTIONS = ["neutral", "calm", "happy", "sad", "angry", "fearful",
                "disgust", "surprised"]  # 7 计分类 + calm 剔除类，UAR 可计算


class BaselineRunTest(unittest.TestCase):
    def setUp(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.tmp = td.name
        self.data_dir = os.path.join(self.tmp, "data")
        self.out_root = os.path.join(self.tmp, "runs")
        self.log_dir = os.path.join(self.tmp, "logs")
        os.makedirs(self.data_dir)
        # 日志目录重定向（setup_logger 读 ser_log.LOG_DIR 全局）
        patcher = mock.patch.object(ser_log, "LOG_DIR", self.log_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        # 不读真实音频
        patcher2 = mock.patch.object(srb, "load_16k",
                                     lambda p: __import__("numpy").zeros(1600, "float32"))
        patcher2.start()
        self.addCleanup(patcher2.stop)

    def run_main(self, argv=None, model=None, run_id=None):
        argv = (argv or ["--model", "fake/model"])
        model = model or FakeModel([PRED_HAPPY])
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                srb.main(argv=argv, model=model, data_dir=self.data_dir,
                         out_root=self.out_root, run_id=run_id)
            except SystemExit as e:
                code = e.code
        return code, out.getvalue(), err.getvalue()

    def hashes(self, run_dir):
        out = {}
        for f in sorted(os.listdir(run_dir)):
            with open(os.path.join(run_dir, f), "rb") as fh:
                out[f] = hashlib.sha256(fh.read()).hexdigest()
        return out

    # ---- R2 ----

    def test_two_runs_first_evidence_untouched(self):
        mk_wavs(self.data_dir, ["happy", "sad", "calm", "neutral"])
        code1, _, _ = self.run_main(run_id="r1")
        self.assertEqual(code1, 0)
        h1 = self.hashes(os.path.join(self.out_root, "r1"))
        code2, _, _ = self.run_main(run_id="r2")
        self.assertEqual(code2, 0)
        self.assertEqual(self.hashes(os.path.join(self.out_root, "r1")), h1,
                         "第二次运行改动/覆盖了第一次的证据")
        self.assertEqual(set(os.listdir(self.out_root)), {"r1", "r2"})
        # 新产物不含模型名后缀旧路径：根目录不再出现平面 metrics_*.json
        self.assertEqual([f for f in os.listdir(self.out_root) if f.startswith("metrics_")], [])

    def test_collision_explicitly_refused(self):
        mk_wavs(self.data_dir, ["happy", "sad"])
        pre = os.path.join(self.out_root, "r1")
        os.makedirs(pre)
        with open(os.path.join(pre, "metrics.json"), "w") as f:
            f.write("KEEP")
        code, _, err = self.run_main(run_id="r1")
        self.assertEqual(code, 4)
        self.assertIn("拒绝覆盖", err)
        self.assertEqual(open(os.path.join(pre, "metrics.json")).read(), "KEEP")

    def test_max_run_separated_from_full(self):
        mk_wavs(self.data_dir, ["happy", "sad", "calm", "neutral"])
        code, _, _ = self.run_main(argv=["--model", "fake/model", "--max", "2"])
        self.assertEqual(code, 0)
        names = os.listdir(self.out_root)
        self.assertEqual(len(names), 1)
        self.assertTrue(names[0].endswith("_max2"), names)
        samples = open(os.path.join(self.out_root, names[0], "samples.jsonl"),
                       encoding="utf-8").read().splitlines()
        self.assertEqual(len(samples), 2)

    def test_new_artifacts_offline_recomputable(self):
        mk_wavs(self.data_dir, ["happy", "sad", "calm", "neutral"])
        self.run_main(run_id="r1")
        rd = os.path.join(self.out_root, "r1")
        records = [json.loads(l)
                   for l in open(os.path.join(rd, "samples.jsonl"), encoding="utf-8")
                   if l.strip()]
        recomputed = score_run(records)
        metrics = json.load(open(os.path.join(rd, "metrics.json"), encoding="utf-8"))
        self.assertEqual(recomputed["accuracy"], metrics["accuracy"])
        self.assertEqual(recomputed["uar"], metrics["uar"])
        self.assertEqual(recomputed["confusion"], metrics["confusion"])
        self.assertEqual(recomputed["n_scored"], metrics["n_scored"])

    def test_provenance_records_run(self):
        mk_wavs(self.data_dir, ["happy", "sad"])
        self.run_main(argv=["--model", "fake/model"], run_id="r1")
        prov = json.load(open(os.path.join(self.out_root, "r1", "provenance.json"),
                              encoding="utf-8"))
        self.assertEqual(prov["rule_version"], "ser-metrics/2")
        self.assertEqual(prov["model"], "fake/model")
        self.assertEqual(prov["params"]["max"], 0)
        self.assertTrue(prov["log"].endswith(".jsonl"))
        self.assertTrue(os.path.exists(prov["log"]))
        for name in prov["outputs"]:
            self.assertTrue(os.path.exists(os.path.join(self.out_root, "r1", name)), name)

    # ---- R4（生产汇总路径）----

    def test_missing_class_uar_is_na_not_zero(self):
        mk_wavs(self.data_dir, ["happy", "happy"])  # 目标只有 happy → 6 类缺失
        code, out, err = self.run_main(run_id="r1")
        self.assertEqual(code, 0)
        metrics = json.load(open(os.path.join(self.out_root, "r1", "metrics.json"),
                                 encoding="utf-8"))
        self.assertIsNone(metrics["uar"])                      # JSON 保留 null
        self.assertIn("N/A", out)                              # 控制台不显示 0
        self.assertNotIn("UAR(7类) 0.", out)
        self.assertIn("计分类别缺失", err)                      # 原因可定位

    def test_legit_zero_still_shows_zero(self):
        mk_wavs(self.data_dir, ["happy", "happy"])             # 目标全 happy
        code, out, err = self.run_main(
            model=FakeModel([PRED_SAD]), run_id="r1")          # 全预测错 → accuracy 0
        self.assertEqual(code, 0)
        metrics = json.load(open(os.path.join(self.out_root, "r1", "metrics.json"),
                                 encoding="utf-8"))
        self.assertEqual(metrics["accuracy"], 0.0)
        self.assertIn("准确率 0.0000", out)                     # 合法 0 分如实显示
        self.assertNotIn("准确率 N/A", out)
        # UAR 因缺类不可计算的告警是正确行为，但不得把 accuracy 说成不可计算
        self.assertIn("计分类别缺失", err)

    def test_no_success_sample_is_na(self):
        mk_wavs(self.data_dir, ["happy", "sad"])
        # 首次调用留给探针成功，之后全部抛错 → n_scored=0
        code, out, err = self.run_main(
            model=FakeModel([PRED_HAPPY, RuntimeError("boom")]), run_id="r1")
        self.assertEqual(code, 1)
        metrics = json.load(open(os.path.join(self.out_root, "r1", "metrics.json"),
                                 encoding="utf-8"))
        self.assertIsNone(metrics["accuracy"])
        self.assertIsNone(metrics["uar"])
        self.assertIn("N/A", out)
        self.assertIn("无计分样本", err)

    def test_normal_run_shows_numbers(self):
        mk_wavs(self.data_dir, ALL_EMOTIONS)
        code, out, _ = self.run_main(run_id="r1")
        self.assertEqual(code, 0)
        self.assertNotIn("N/A", out)
        self.assertRegex(out, r"准确率 0\.\d{4} \| UAR\(7类\) 0\.\d{4}")

    # ---- 呈现函数单测 ----

    def test_format_metric_distinguishes_none_and_zero(self):
        self.assertEqual(srb.format_metric(None), "N/A（不可计算）")
        self.assertEqual(srb.format_metric(0.0), "0.0000")
        self.assertEqual(srb.format_metric(0.923363), "0.9234")


if __name__ == "__main__":
    unittest.main()
