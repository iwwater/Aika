# -*- coding: utf-8 -*-
"""SER-04 R3 定向测试：JSONL 日志写失败必须向 stderr 告警，不再静默。

关闭条件（OPTIMIZATION_REVIEW_20260921.md R3）：
- 正常写入保持 JSONL 格式；
- 打开失败、写入失败：无异常外抛、stderr 非空且原因可定位；
- 不递归调用同一坏日志 handler，不拖垮实验。
只用内存/临时文件。
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ser_log


class JsonlLogTest(unittest.TestCase):
    def setUp(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.tmp = td.name
        # 日志目录重定向到临时目录，测试不污染 output/logs
        patcher = mock.patch.object(ser_log, "LOG_DIR", os.path.join(self.tmp, "logs"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _new_logger(self):
        out, err = io.StringIO(), io.StringIO()
        name = f"t_{id(self)}"
        log, logpath = ser_log.setup_logger(name, "r3_test")
        # setup_logger 的控制台 handler 持有创建时的 stdout，重定向后需替换
        log.handlers[0].stream = out
        self.addCleanup(lambda: log.handlers.clear())
        return log, logpath, out, err

    def test_normal_write_jsonl_format(self):
        log, logpath, out, err = self._new_logger()
        log.info("处理音频", extra={"audio": "a.wav", "slug": "yasashii",
                                    "elapsed_s": 0.21})
        with open(logpath, encoding="utf-8") as f:
            lines = [json.loads(l) for l in f if l.strip()]
        self.assertEqual(len(lines), 2)  # 启动行 + 本条
        entry = lines[-1]
        self.assertEqual(entry["event"], "处理音频")
        self.assertEqual(entry["level"], "INFO")
        self.assertEqual(entry["audio"], "a.wav")
        self.assertEqual(entry["slug"], "yasashii")
        self.assertEqual(entry["elapsed_s"], 0.21)
        self.assertIn("ts", entry)

    def test_open_failure_warns_stderr_no_raise(self):
        log, logpath, out, err = self._new_logger()
        bad_dir = os.path.join(self.tmp, "not_a_file")
        os.makedirs(bad_dir)  # 对目录 open(a) 必然失败
        bad = ser_log.JsonlHandler(bad_dir)
        log.addHandler(bad)
        with contextlib.redirect_stderr(err):
            log.info("证据条目")
        self.assertIn("JSONL 日志写失败", err.getvalue())
        self.assertIn(repr(bad_dir), err.getvalue())   # path 以 repr 形式打印
        self.assertIn("证据条目", err.getvalue())      # 事件内容可定位
        self.assertIn("PermissionError", err.getvalue())

    def test_write_failure_warns_stderr_no_raise(self):
        log, logpath, out, err = self._new_logger()
        with mock.patch.object(ser_log.json, "dumps",
                               side_effect=RuntimeError("dump boom")):
            with contextlib.redirect_stderr(err):
                log.info("写入会炸的一条")
        self.assertIn("JSONL 日志写失败", err.getvalue())
        self.assertIn("dump boom", err.getvalue())
        self.assertIn("写入会炸的一条", err.getvalue())

    def test_experiment_not_killed_by_log_failure(self):
        # 日志坏掉后业务日志调用继续正常返回（console 通道不受影响）
        log, logpath, out, err = self._new_logger()
        bad_dir = os.path.join(self.tmp, "not_a_file2")
        os.makedirs(bad_dir)
        log.addHandler(ser_log.JsonlHandler(bad_dir))
        for i in range(3):
            with contextlib.redirect_stderr(err):
                log.info(f"业务事件 {i}")  # 连续失败也不抛、不中断
        self.assertIn("业务事件 0", out.getvalue())
        self.assertIn("业务事件 2", out.getvalue())
        self.assertEqual(err.getvalue().count("JSONL 日志写失败"), 3)


if __name__ == "__main__":
    unittest.main()
