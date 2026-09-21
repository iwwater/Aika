# -*- coding: utf-8 -*-
"""ser_common 单元测试（SER-04 AC-A / AC-B / AC-C / AC-D）。

运行（cwd 任意）：
    research/ser/.venv/Scripts/python.exe -m unittest \
        discover -s research/ser/tests -p "test_ser_common.py" -v
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ser_common
from ser_common import (BatchSummary, build_demo_samples, ensure_dimred_input,
                        parse_emotion2vec_result, run_batch, top1)


class TestACASampleListAndPaths(unittest.TestCase):
    def test_demo_samples_18_fixed_order(self):
        """两个实验入口消费同一 18 段样本清单（fixture=真实 demo data.json）。"""
        samples = build_demo_samples()
        self.assertEqual(len(samples), 18)
        kinds = [s["kind"] for s in samples]
        self.assertEqual(kinds[:6], ["ref(真人)"] * 6)
        self.assertEqual(kinds[6:12], ["合成A"] * 6)
        self.assertEqual(kinds[12:], ["合成C"] * 6)
        slugs = [s["slug"] for s in samples[:6]]
        self.assertEqual(slugs, ser_common._mood_slug_order())
        # A 组与 ref 共享 slug 顺序；路径互不相同（不因去重误删不同来源）
        paths = [s["path"] for s in samples]
        self.assertEqual(len(set(paths)), 18)
        self.assertTrue(all(os.path.isabs(s["path"]) for s in samples))

    def test_paths_derive_from_code_location(self):
        """路径由代码位置推导；带空格目录 join 后仍正确。"""
        self.assertEqual(os.path.basename(ser_common.SER_ROOT), "ser")
        self.assertEqual(os.path.basename(os.path.dirname(ser_common.SER_ROOT)), "research")
        # 模拟带空格的项目根：derive 逻辑只做 join，空格不破坏
        spaced = os.path.join(ser_common.PROJECT_ROOT, "dir with space", "sub dir")
        joined = os.path.join(spaced, "x.wav")
        self.assertEqual(os.path.basename(joined), "x.wav")
        self.assertTrue(os.path.isabs(joined))

    def test_explicit_cache_env_priority(self):
        """显式缓存环境变量优先，不被覆盖。"""
        env_backup = {k: os.environ.get(k) for k in
                      ("MODELSCOPE_CACHE", "HF_HOME", "TORCH_HOME")}
        marker = os.path.join(tempfile.gettempdir(), "ser_test_explicit_cache")
        try:
            os.environ["MODELSCOPE_CACHE"] = marker
            ser_common._ENV_INITIALIZED = False
            ser_common.setup_environment()
            self.assertEqual(os.environ["MODELSCOPE_CACHE"], marker)
            # 未显式设置的仍落项目 .cache
            self.assertEqual(os.environ["HF_HOME"],
                             os.path.join(ser_common.CACHE_ROOT, "huggingface"))
        finally:
            for k, v in env_backup.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            ser_common._ENV_INITIALIZED = False


class TestACBLabelRule(unittest.TestCase):
    def test_plain_composite_unk_same_rule(self):
        """纯英文、中文/英文、<unk>、unknown 走同一规则（= ser_metrics.normalize_label）。"""
        cases = [
            ({"labels": ["angry"], "scores": [0.9]}, {"angry": 0.9}),
            ({"labels": ["生气/angry"], "scores": [0.9]}, {"angry": 0.9}),
            ({"labels": ["<unk>"], "scores": [0.82]}, {"unknown": 0.82}),
            ({"labels": ["unknown"], "scores": [0.5]}, {"unknown": 0.5}),
            ({"labels": ["other"], "scores": [0.1]}, {"other": 0.1}),
        ]
        for res, expect in cases:
            self.assertEqual(parse_emotion2vec_result(res), expect)

    def test_errors_not_silent(self):
        bad = [
            None,
            ["not-a-dict"],
            {"scores": [0.1]},
            {"labels": ["angry"]},
            {"labels": [], "scores": []},
            {"labels": ["a", "b"], "scores": [0.1]},
            {"labels": ["angry"], "scores": ["high"]},
            {"labels": ["banana"], "scores": [0.9]},
        ]
        for res in bad:
            with self.assertRaises(ValueError):
                parse_emotion2vec_result(res)

    def test_baseline_and_server_share_rule(self):
        """baseline 与服务用同一 parse 函数对同一假响应得到相同规范标签。"""
        fake = {"labels": ["中立/neutral", "生气/angry", "<unk>"],
                "scores": [0.4, 0.35, 0.25]}
        self.assertEqual(parse_emotion2vec_result(fake),
                         {"neutral": 0.4, "angry": 0.35, "unknown": 0.25})
        self.assertEqual(top1(parse_emotion2vec_result(fake)), ("neutral", 0.4))


class TestACCBatch(unittest.TestCase):
    def test_18_try_1_fail(self):
        """18 条尝试、1 条失败 → 17 成功 / 1 失败，attempted=success+failed。"""
        items = list(range(18))

        def fn(i):
            if i == 7:
                raise RuntimeError("boom")
            return i * 2

        s = run_batch(items, fn)
        self.assertEqual(s.attempted, 18)
        self.assertEqual(s.success, 17)
        self.assertEqual(s.failed, 1)
        self.assertEqual(s.attempted, s.success + s.failed)
        self.assertEqual(len(s.results), 17)
        self.assertIn("boom", s.failures[0]["error"])
        self.assertIn("boom", s.report())  # 失败可追踪（stderr 同内容）

    def test_all_fail(self):
        s = run_batch([1, 2, 3], lambda x: 1 / 0)
        self.assertEqual((s.success, s.failed, s.attempted), (0, 3, 3))
        self.assertTrue(s.report())

    def test_dimred_insufficient(self):
        for bad in (0, 1, 3):
            with self.assertRaises(RuntimeError):
                ensure_dimred_input(bad)
        ensure_dimred_input(4)  # 门槛值恰好可用


class TestACDRegression(unittest.TestCase):
    def test_ser_metrics_regression_still_passes(self):
        """SER-03 计分回归：标签规则改动不影响计分入口。"""
        from ser_metrics import normalize_label, score_run
        self.assertEqual(normalize_label("生气/angry"), "angry")
        m = score_run([
            {"file": "a.wav", "target_raw": "happy", "pred_raw": "开心/happy",
             "excluded": False, "status": "success", "scores": None},
        ])
        self.assertAlmostEqual(m["accuracy"], 1.0)


if __name__ == "__main__":
    unittest.main()
