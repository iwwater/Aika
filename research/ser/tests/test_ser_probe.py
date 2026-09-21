# -*- coding: utf-8 -*-
"""SER-04 R1 回归：探针生产入口 main() 的失败隔离。

复核清单（OPTIMIZATION_REVIEW_20260921.md R1）关闭条件：
- 测试实际 main()（不是只测 run_batch(lambda)）；
- 第一条坏 / 后一条坏 / 模型抛错 / 音频缺失均记失败，后续正常样本照常处理；
- 18 次尝试、1 次失败 = 17 成功 / 1 失败；有失败入口非零退出；输出无伪有效预测；
- 固定 fixture 证明成功样本字段与顺序兼容。
全部用假模型与临时文件，不触真实模型/网络。
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ser_emotion2vec_probe as probe


class FakeModel:
    """按脚本逐次返回；脚本耗尽后重复最后一项。元素为 dict 返回值或 Exception。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def generate(self, **kw):
        i = len(self.calls)
        self.calls.append(kw)
        item = self.script[i] if i < len(self.script) else self.script[-1]
        if isinstance(item, Exception):
            raise item
        return item


GOOD = [{"labels": ["开心/happy", "中性/neutral", "<unk>"], "scores": [0.9, 0.1, 0.0]}]


def mk_samples(tmpdir, n, missing=()):
    samples = []
    for i in range(n):
        p = os.path.join(tmpdir, f"s{i}.wav")
        if i not in missing:
            with open(p, "wb") as f:
                f.write(b"RIFFdummy")
        samples.append({"kind": "合成A", "slug": f"slug{i}", "ja": f"ja{i}",
                        "zh": "中", "path": p})
    return samples


class ProbeMainTest(unittest.TestCase):
    def run_main(self, samples, script, model_name="fake/m"):
        model = FakeModel(script)
        out, err = io.StringIO(), io.StringIO()
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                probe.main(argv=["--model", model_name], samples=samples,
                           model=model, out_dir=td.name)
            except SystemExit as e:
                code = e.code
        outpath = os.path.join(td.name, f"emotion2vec_probe_{model_name.split('/')[-1]}.json")
        rows = None
        if os.path.exists(outpath):
            with open(outpath, encoding="utf-8") as f:
                rows = json.load(f)
        return code, rows, err.getvalue(), model

    def test_first_bad_parse_then_good_isolated(self):
        # 复现 R1 场景一：首条解析失败 → 记失败行，批次不中断，后条照常
        bad = [{"labels": ["happy"], "scores": []}]  # 数量不符 → ValueError
        code, rows, err, _ = self.run_main(mk_samples(self.tempdir(), 2), [bad, GOOD[0]])
        self.assertEqual(code, 1)
        self.assertEqual([r["slug"] for r in rows], ["slug0", "slug1"])
        self.assertEqual(rows[0]["status"], "failed")
        self.assertIsNone(rows[0]["pred_top"])
        self.assertIsNone(rows[0]["pred_labels"])
        self.assertIn("数量不符", rows[0]["error"])
        self.assertEqual(rows[1]["status"], "success")
        self.assertEqual(rows[1]["pred_top"], "happy")
        self.assertIn("[batch]", err)

    def test_no_carry_over_from_previous_success(self):
        # 复现 R1 场景二：前条成功 happy/0.9，后条坏 → 失败行绝不携带 happy
        good = {"labels": ["开心/happy"], "scores": [0.9]}
        bad = {"labels": ["happy"], "scores": []}
        _, rows, _, _ = self.run_main(mk_samples(self.tempdir(), 2), [good, bad])
        self.assertEqual(rows[0]["pred_top"], "happy")
        self.assertEqual(rows[1]["status"], "failed")
        self.assertIsNone(rows[1]["pred_top"])
        self.assertIsNone(rows[1]["pred_top_score"])

    def test_model_exception_continues(self):
        code, rows, err, _ = self.run_main(
            mk_samples(self.tempdir(), 2),
            [RuntimeError("boom"), GOOD[0]])
        self.assertEqual(code, 1)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertIn("boom", rows[0]["error"])
        self.assertEqual(rows[1]["status"], "success")
        self.assertIn("[batch]", err)

    def test_missing_audio_is_failed_not_skipped(self):
        # 复现 R1 场景三：缺失文件不再静默跳过（旧版输出空列表 + 退出码 0）
        samples = mk_samples(self.tempdir(), 2, missing=(0,))
        _, rows, err, model = self.run_main(samples, [GOOD[0]])
        self.assertEqual(len(rows), 2)          # 缺失样本也入输出（可追溯）
        self.assertEqual(rows[0]["status"], "failed")
        self.assertIn("音频缺失", rows[0]["error"])
        self.assertEqual(rows[1]["status"], "success")
        self.assertEqual(len(model.calls), 1)    # 缺失样本不调用模型；存在的样本照常
        self.assertEqual(model.calls[0]["input"], samples[1]["path"])
        self.assertIn("[batch]", err)

    def test_18_try_1_fail_semantics(self):
        script = [GOOD[0]] * 18
        script[5] = {"labels": ["happy"], "scores": []}
        code, rows, _, _ = self.run_main(mk_samples(self.tempdir(), 18), script)
        self.assertEqual(code, 1)
        self.assertEqual(len(rows), 18)                       # attempted=18 全部落盘
        self.assertEqual(sum(r["status"] == "success" for r in rows), 17)
        self.assertEqual(sum(r["status"] == "failed" for r in rows), 1)
        self.assertEqual([r["slug"] for r in rows], [f"slug{i}" for i in range(18)])

    def test_all_success_exit0_field_and_order_compat(self):
        samples = mk_samples(self.tempdir(), 3)
        code, rows, err, _ = self.run_main(samples, [GOOD[0]] * 3)
        self.assertEqual(code, 0)
        self.assertEqual([r["slug"] for r in rows], ["slug0", "slug1", "slug2"])
        base_keys = {"kind", "slug", "ja", "zh", "path", "elapsed_s",
                     "pred_labels", "pred_scores", "pred_top", "pred_top_score",
                     "status"}
        for r in rows:
            self.assertTrue(base_keys <= set(r), r)
            self.assertEqual(r["status"], "success")
            self.assertEqual(r["pred_top"], "happy")
            self.assertAlmostEqual(r["pred_top_score"], 0.9)
        # 原始 labels/scores 保留（ser_compare_base_large.py 兼容）
        self.assertEqual(rows[0]["pred_labels"], ["开心/happy", "中性/neutral", "<unk>"])

    def tempdir(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        return td.name


if __name__ == "__main__":
    unittest.main()
