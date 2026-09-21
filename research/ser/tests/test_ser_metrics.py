# -*- coding: utf-8 -*-
"""ser_metrics 单元测试（SER-03 AC-A / AC-B / AC-D）。

运行（cwd 任意）：
    research/ser/.venv/Scripts/python.exe -m unittest \
        discover -s research/ser/tests -p "test_ser_metrics.py" -v
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_metrics import (SCORE_CLASSES, ScoringError, normalize_label,
                         score_run)


def rec(file, target, pred, excluded=False, status="success", scores=None,
        target_raw=None, pred_raw=None):
    return {"file": file,
            "target_raw": target_raw if target_raw is not None else target,
            "pred_raw": pred_raw if pred_raw is not None else pred,
            "excluded": excluded, "status": status, "scores": scores}


class TestNormalizeLabel(unittest.TestCase):
    def test_compound_cn_en(self):
        self.assertEqual(normalize_label("生气/angry"), "angry")
        self.assertEqual(normalize_label("中立/neutral"), "neutral")
        self.assertEqual(normalize_label("厌恶/disgusted"), "disgusted")

    def test_unk_and_unknown(self):
        self.assertEqual(normalize_label("<unk>"), "unknown")
        self.assertEqual(normalize_label("unknown"), "unknown")

    def test_plain_labels(self):
        for c in SCORE_CLASSES:
            self.assertEqual(normalize_label(c), c)
        self.assertEqual(normalize_label("other"), "other")

    def test_illegal(self):
        for bad in ("banana", "", "  ", None, 123, "生气/", "/angry"):
            with self.assertRaises(ScoringError):
                normalize_label(bad)


class ACAbstract:  # AC-A：未知预测必须记错，两种未知来源都覆盖
    def _two_sample_metrics(self, bad_pred_raw):
        """target=fearful 两条：一条正确、一条未知预测 → recall/accuracy 都 = 0.5。"""
        records = [
            rec("a.wav", "fearful", "fearful"),
            rec("b.wav", "fearful", "fearful", pred_raw=bad_pred_raw),
        ]
        m = score_run(records)
        self.assertEqual(m["n_scored"], 2)
        self.assertAlmostEqual(m["accuracy"], 0.5)
        self.assertAlmostEqual(m["per_class_recall"]["fearful"], 0.5)
        return m

    def test_unknown_pred_counts_as_error(self):
        m = self._two_sample_metrics("<unk>")
        # 矩阵总数必须等于 n_scored（未知预测不消失）
        total = sum(sum(row.values()) for row in m["confusion"].values())
        self.assertEqual(total, 2)
        self.assertEqual(m["confusion"]["fearful"]["unknown"], 1)

    def test_other_pred_counts_as_error(self):
        m = self._two_sample_metrics("other")
        total = sum(sum(row.values()) for row in m["confusion"].values())
        self.assertEqual(total, 2)
        self.assertEqual(m["confusion"]["fearful"]["other"], 1)

    def test_composite_unk_normalized(self):
        # 复合格式里的 unknown 变体也覆盖
        m = self._two_sample_metrics("<unk>")
        m2 = score_run([
            rec("a.wav", "fearful", "fearful"),
            rec("b.wav", "fearful", "fearful", pred_raw="未知/<unk>"),
        ])
        self.assertAlmostEqual(m2["accuracy"], 0.5)
        self.assertAlmostEqual(m["accuracy"], m2["accuracy"])


class TestACBExclusionsAndErrors(unittest.TestCase):
    def test_calm_excluded_by_target_not_pred(self):
        """calm 按真实标签剔除；预测内容不影响剔除决定。"""
        records = [
            rec("c1.wav", "other", "happy", excluded=True, target_raw="other"),
            rec("c2.wav", "other", "other", excluded=True, target_raw="other"),
            rec("n1.wav", "neutral", "neutral"),
            rec("n2.wav", "neutral", "other"),  # 计分样本 pred=other 记错
        ]
        m = score_run(records)
        self.assertEqual(m["n_attempted"], 4)
        self.assertEqual(m["n_success"], 4)
        self.assertEqual(m["n_excluded"], 2)
        self.assertEqual(m["n_scored"], 2)
        self.assertAlmostEqual(m["accuracy"], 0.5)
        total = sum(sum(row.values()) for row in m["confusion"].values())
        self.assertEqual(total, 2)  # 剔除样本不进矩阵

    def test_compound_labels_everywhere(self):
        records = [
            rec("a.wav", "neutral", "neutral", pred_raw="中立/neutral"),
            rec("b.wav", "angry", "angry", target_raw="生气/angry"),
            # 补齐其余 5 类，才能对 UAR=1.0 断言（缺类时 UAR 正确为 None）
            rec("c.wav", "happy", "happy"), rec("d.wav", "sad", "sad"),
            rec("e.wav", "fearful", "fearful"), rec("f.wav", "disgusted", "disgusted"),
            rec("g.wav", "surprised", "surprised"),
        ]
        m = score_run(records)
        self.assertAlmostEqual(m["accuracy"], 1.0)
        self.assertAlmostEqual(m["uar"], 1.0)

    def test_missing_class_uar_null(self):
        """任一计分类无样本 → UAR=None 并列出缺失类，不悄悄六类平均。"""
        records = [rec("a.wav", "happy", "happy"), rec("b.wav", "sad", "sad")]
        m = score_run(records)
        self.assertIsNone(m["uar"])
        self.assertEqual(m["missing_classes"],
                         [c for c in SCORE_CLASSES if c not in ("happy", "sad")])
        self.assertAlmostEqual(m["accuracy"], 1.0)

    def test_failed_records_conservation(self):
        records = [
            rec("ok.wav", "happy", "happy"),
            rec("bad.wav", "happy", "happy", status="failed"),
        ]
        m = score_run(records)
        self.assertEqual(m["n_attempted"], 2)
        self.assertEqual(m["n_success"], 1)
        self.assertEqual(m["n_failed"], 1)
        self.assertEqual(m["n_scored"], 1)
        self.assertEqual(m["n_attempted"], m["n_success"] + m["n_failed"])
        self.assertEqual(m["n_success"], m["n_excluded"] + m["n_scored"])

    def test_duplicate_file_raises(self):
        records = [rec("a.wav", "happy", "happy"),
                   rec("a.wav", "happy", "sad")]
        with self.assertRaises(ScoringError):
            score_run(records)

    def test_illegal_label_raises_not_dropped(self):
        records = [rec("a.wav", "happy", "happy"),
                   rec("b.wav", "happy", "banana")]
        with self.assertRaises(ScoringError):
            score_run(records)

    def test_scored_target_must_be_score_class(self):
        records = [rec("a.wav", "other", "happy")]  # 漏标 excluded 的剔除类
        with self.assertRaises(ScoringError):
            score_run(records)

    def test_empty_run(self):
        m = score_run([])
        self.assertIsNone(m["accuracy"])
        self.assertIsNone(m["uar"])
        self.assertEqual(m["n_scored"], 0)


class TestACDRecompute(unittest.TestCase):
    """AC-D：指标必须能从逐样本证据离线再次算出，不能只测写死常数。"""

    RECORDS = [
        rec("f1.wav", "neutral", "neutral"),
        rec("f2.wav", "neutral", "happy", pred_raw="开心/happy"),
        rec("f3.wav", "angry", "angry"),
        rec("f4.wav", "angry", "unknown", pred_raw="<unk>"),
        rec("f5.wav", "other", "sad", excluded=True, target_raw="other"),
        rec("f6.wav", "other", "other", excluded=True, target_raw="other"),
        rec("f7.wav", "sad", "sad", status="failed"),
    ]

    def test_recompute_from_records_json_roundtrip(self):
        m1 = score_run(self.RECORDS)
        payload = {k: v for k, v in m1.items() if k != "records"}
        # 模拟落盘再读回：逐样本文件包含 status 字段，按落盘格式重演计分
        samples = [dict(file=r["file"],
                        target_raw=r["target_raw"],
                        pred_raw=r["pred_raw"],
                        excluded=r["excluded"],
                        status=r["status"],
                        scores=None)
                   for r in self.RECORDS]
        m2 = score_run(samples)
        for k in ("accuracy", "uar", "n_scored", "n_excluded", "n_matrix_total"):
            self.assertEqual(payload[k], m2[k], f"{k} 复算不一致")
        self.assertEqual(payload["confusion"], m2["confusion"])

    def test_load_metrics_with_records_roundtrip(self):
        from ser_metrics import load_metrics_with_records
        m1 = score_run(self.RECORDS)
        body, records = {k: v for k, v in m1.items() if k != "records"}, m1["records"]
        with tempfile.TemporaryDirectory() as td:
            mp = os.path.join(td, "metrics_test.json")
            sp = os.path.join(td, "samples_test.jsonl")
            with open(mp, "w", encoding="utf-8") as f:
                json.dump(body, f)
            # load_metrics_with_records 按 metrics_* → samples_* 约定找样本文件
            with open(sp, "w", encoding="utf-8") as f:
                # failed 记录也必须落盘才能复现 attempted 计数
                for r in self.RECORDS:
                    f.write(json.dumps({
                        "file": r["file"],
                        "target_raw": r["target_raw"],
                        "pred_raw": r["pred_raw"],
                        "excluded": r["excluded"],
                        "status": r["status"],
                        "scores": None,
                    }, ensure_ascii=False) + "\n")
            loaded, recomputed, _ = load_metrics_with_records(mp)
            self.assertEqual(loaded["accuracy"], recomputed["accuracy"])
            self.assertEqual(loaded["n_attempted"], recomputed["n_attempted"])
            self.assertEqual(loaded["confusion"], recomputed["confusion"])


if __name__ == "__main__":
    unittest.main()
