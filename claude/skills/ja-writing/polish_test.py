#!/usr/bin/env python3
"""polish.py が、SKILL.md と yomiyasu の規則を渡し、失敗したときに壊れた出力を残さないことを保証する。

agy の実モデルは呼ばない。プロンプトの組み立て・出力の形・失敗時の振る舞いだけを対象にする。
"""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "bin"))
import agy_testing  # noqa: E402

# 仕上げ役の使い捨ての cwd は利用者の一時フォルダに作る。sandbox の中ではそこに書けないので、テストの一時領域に向ける
os.environ.setdefault("NEON_LAUNCH_TMP", tempfile.gettempdir())
_SPEC = importlib.util.spec_from_file_location("ja_polish", os.path.join(_HERE, "polish.py"))
polish = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(polish)


class Rules(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ja-polish-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(setattr, polish._REVIEW, "RULES_MD", polish._REVIEW.RULES_MD)

    def use(self, text):
        path = os.path.join(self.dir, "SKILL.md")
        with io.open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        polish._REVIEW.RULES_MD = path

    def test_prompt_carries_the_vocabulary_rules(self):
        prompt, problem = polish.build_prompt("本文")
        self.assertIsNone(problem)
        self.assertIn("文の組み立て方:", prompt)
        for word in ("正本", "按分", "ではなく"):
            self.assertIn(word, prompt)

    def test_rules_after_the_tone_table_reach_the_prompt(self):
        prompt, problem = polish.build_prompt("本文")
        self.assertIsNone(problem)
        self.assertIn("業務文書の語調", prompt)
        self.assertIn("英語で組み立てた文を訳した語を使わない", prompt)

    def test_prompt_carries_the_yomiyasu_principles(self):
        prompt, _ = polish.build_prompt("本文")
        self.assertIn("最優先ルール: 意味の保持", prompt)
        self.assertNotIn("### 太字とラベル", prompt)

    def test_doc_type_adds_its_reference(self):
        prompt, _ = polish.build_prompt("本文", doc_type="minutes")
        self.assertIn("文書の種類 minutes", prompt)

    def test_doc_type_marker_in_the_text_is_used(self):
        prompt, _ = polish.build_prompt("<!-- doc-type: proposal -->\n本文")
        self.assertIn("文書の種類 proposal", prompt)

    def test_client_audience_asks_for_the_business_register(self):
        prompt, _ = polish.build_prompt("ざっくり見積もりました。", "client")
        self.assertIn("顧客・社外の読み手に渡す業務文書です", prompt)
        self.assertIn("書き手と読み手", prompt)

    def test_marker_in_the_text_decides_the_audience(self):
        prompt, _ = polish.build_prompt("<!-- audience: internal -->\nざっくり見積もりました。")
        self.assertIn("元の語調を保ち", prompt)
        self.assertNotIn("yomiyasu: 書き手と読み手", prompt)

    def test_marker_in_a_code_example_does_not_make_the_text_client(self):
        prompt, _ = polish.build_prompt("# 手順書\n\n```html\n<!-- audience: client -->\n```\n\nざっくり書いた。")
        self.assertIn("読み手を本文から判断してください", prompt)
        self.assertNotIn("yomiyasu: 書き手と読み手", prompt)

    def test_frontmatter_after_the_first_block_is_not_a_marker(self):
        prompt, _ = polish.build_prompt("---\ntitle: 手順\n---\n\n例:\n\n---\naudience: client\n---\n\nざっくり。")
        self.assertNotIn("顧客・社外の読み手に渡す業務文書です", prompt)

    def test_meta_with_content_first_makes_the_text_client(self):
        prompt, _ = polish.build_prompt('<meta content="client" name="audience">\n<p>ざっくり。</p>')
        self.assertIn("顧客・社外の読み手に渡す業務文書です", prompt)

    def test_prompt_carries_the_text(self):
        self.assertIn("これが対象の本文", polish.build_prompt("これが対象の本文")[0])

    def test_missing_section_heading_is_reported(self):
        self.use("# 別の節\n文の組み立て方:\n- 一つ目\n")
        prompt, problem = polish.build_prompt("本文")
        self.assertIn("書き方の規則", problem)
        self.assertNotIn("文の組み立て方:", prompt)

    def test_missing_file_is_reported(self):
        polish._REVIEW.RULES_MD = os.path.join(self.dir, "nonexistent.md")
        prompt, problem = polish.build_prompt("本文")
        self.assertIn("読めない", problem)
        self.assertNotIn("文の組み立て方:", prompt)
        self.assertIn("本文", prompt)

    def test_missing_yomiyasu_is_reported(self):
        with mock.patch.dict(os.environ, {"JA_YOMIYASU_DIR": self.dir}):
            prompt, problem = polish.build_prompt("本文")
        self.assertIn("yomiyasu", problem)
        self.assertIn("文の組み立て方:", prompt)


class Wrapping(unittest.TestCase):
    """モデルが本文の周りに付けたものだけを外す。"""

    def test_whole_body_in_a_fence_is_unwrapped(self):
        self.assertEqual(polish.strip_wrapping("```markdown\n# 見出し\n本文\n```"), "# 見出し\n本文")

    def test_inner_code_block_is_kept(self):
        body = "説明の文。\n\n```python\nprint(1)\n```\n\n続きの文。"
        self.assertEqual(polish.strip_wrapping(body), body)

    def test_single_preamble_line_is_dropped(self):
        self.assertEqual(polish.strip_wrapping("以下が仕上げた本文です。\n\n一行目\n二行目"),
                         "一行目\n二行目")

    def test_preamble_is_kept_when_the_body_is_one_line(self):
        body = "こちらの案でよいでしょうか。\n\n一行目"
        self.assertEqual(polish.strip_wrapping(body), body)

    def test_heading_first_line_is_not_a_preamble(self):
        body = "# 以下の運用について\n\n一行目\n二行目"
        self.assertEqual(polish.strip_wrapping(body), body)

    def test_plain_body_is_untouched(self):
        body = "一行目の本文。\n二行目の本文。\n三行目の本文。"
        self.assertEqual(polish.strip_wrapping(body), body)


class Agy(unittest.TestCase):
    """agy の呼び出しを差し替えて、出力と終了コードだけを見る。"""

    class Completed(object):
        def __init__(self, returncode, stdout):
            self.returncode = returncode
            self.stdout = stdout

    def stub(self, result):
        shim = type("Shim", (), {"DEVNULL": -3, "PIPE": -1,
                                 "SubprocessError": subprocess.SubprocessError,
                                 "TimeoutExpired": subprocess.TimeoutExpired})()
        self.commands = []

        def run(command, **kwargs):
            if command[0] != "agy":  # agy_launch が一時フォルダを getconf で引く呼び出しは本物に通す
                return subprocess.run(command, **kwargs)
            self.commands.append((command, kwargs, sorted(os.listdir(kwargs["cwd"]))))
            if isinstance(result, Exception):
                raise result
            return result
        shim.run = run
        self.addCleanup(setattr, polish.agy_launch, "subprocess", polish.agy_launch.subprocess)
        polish.agy_launch.subprocess = shim

    def envelope(self, response, status="SUCCESS"):
        init = json.dumps({"event": "init", "init": {}})
        result = json.dumps({"event": "result", "result": {
            "conversation_id": "x", "status": status, "response": response}})
        return init + "\n" + result + "\n"

    def succeed(self, response):
        self.stub(self.Completed(0, self.envelope(response)))

    def run_main(self, argv, stdin=""):
        streams = sys.stdin, sys.stdout, sys.stderr
        sys.stdin = io.StringIO(stdin)
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        try:
            code = polish.main(argv)
            return code, sys.stdout.getvalue(), sys.stderr.getvalue()
        finally:
            sys.stdin, sys.stdout, sys.stderr = streams


class Output(Agy):
    def test_polished_body_goes_to_stdout(self):
        self.succeed("整えた本文")
        code, out, err = self.run_main([], stdin="元の本文")
        self.assertEqual((code, out, err), (0, "整えた本文\n", ""))

    def test_body_goes_over_stdin_not_argv(self):
        self.succeed("整えた本文")
        self.run_main([], stdin="stdin から来た本文カワセミ")
        command, kwargs, _ = self.commands[0]
        self.assertEqual(command[0], "agy")
        self.assertIn("gemini-4-neon-high", command)
        self.assertNotIn("-p", command)
        self.assertNotIn("カワセミ", " ".join(command))
        message = json.loads(kwargs["input"].strip())
        self.assertEqual(message["event"], "user")
        self.assertIn("カワセミ", message["message"]["content"][0]["text"])

    def test_agy_may_not_use_tools(self):
        self.succeed("整えた本文")
        self.run_main([], stdin="本文")
        command = self.commands[0][0]
        self.assertEqual(command[1:3], ["--sandbox", "--settings"])
        deny = json.loads(command[3])["permissions"]["deny"]
        for rule in ("command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "mcp(*)"):
            self.assertIn(rule, deny)

    def test_model_can_be_overridden(self):
        self.succeed("整えた本文")
        self.run_main(["--model", "gemini-4-neon-low"], stdin="本文")
        self.assertIn("gemini-4-neon-low", self.commands[0][0])

    def test_diff_shows_the_change(self):
        self.succeed("直した行\n")
        code, out, err = self.run_main(["--diff"], stdin="元の行\n")
        self.assertEqual(code, 0)
        self.assertIn("-元の行\n", out)
        self.assertIn("+直した行\n", out)

    def test_diff_of_an_unterminated_last_line_is_not_joined(self):
        self.succeed("直した行")
        code, out, err = self.run_main(["--diff"], stdin="元の行")
        self.assertEqual(code, 0)
        self.assertIn("-元の行\n", out)
        self.assertIn("+直した行\n", out)
        self.assertNotIn("\\ No newline", out)

    def test_diff_of_an_unchanged_body_is_empty(self):
        self.succeed("同じ行\n")
        code, out, err = self.run_main(["--diff"], stdin="同じ行\n")
        self.assertEqual((code, out), (0, ""))

    def test_runs_in_an_empty_throwaway_cwd(self):
        self.succeed("整えた本文")
        self.run_main([], stdin="本文")
        self.run_main([], stdin="別の本文")
        first, second = self.commands
        self.assertEqual((first[2], second[2]), ([], []))
        self.assertNotEqual(first[1]["cwd"], second[1]["cwd"])
        self.assertFalse(os.path.exists(first[1]["cwd"]))

    def test_missing_rules_are_announced_but_do_not_stop_the_run(self):
        self.addCleanup(setattr, polish._REVIEW, "RULES_MD", polish._REVIEW.RULES_MD)
        polish._REVIEW.RULES_MD = "/nonexistent/SKILL.md"
        self.succeed("整えた本文")
        code, out, err = self.run_main([], stdin="元の本文")
        self.assertEqual((code, out), (0, "整えた本文\n"))
        self.assertIn("規則を同梱できなかった", err)


class Failure(Agy):
    def assert_silent_failure(self):
        code, out, err = self.run_main([], stdin="元の本文")
        self.assertEqual((code, out), (1, ""))
        self.assertTrue(err)

    def test_missing_agy(self):
        self.stub(OSError("no such file"))
        self.assert_silent_failure()

    def test_timeout(self):
        self.stub(subprocess.TimeoutExpired("agy", 180))
        self.assert_silent_failure()

    def test_nonzero_exit(self):
        self.stub(self.Completed(1, self.envelope("整えた本文")))
        self.assert_silent_failure()

    def test_broken_json(self):
        self.stub(self.Completed(0, "agy: could not authenticate"))
        self.assert_silent_failure()

    def test_no_result_event(self):
        self.stub(self.Completed(0, json.dumps({"event": "init", "init": {}})))
        self.assert_silent_failure()

    def test_failed_status(self):
        self.stub(self.Completed(0, self.envelope("整えた本文", status="ERROR")))
        self.assert_silent_failure()

    def test_blank_response(self):
        self.stub(self.Completed(0, self.envelope("   \n")))
        self.assert_silent_failure()

    def test_empty_input_never_calls_agy(self):
        self.succeed("整えた本文")
        code, out, err = self.run_main([], stdin="   \n")
        self.assertEqual((code, out), (1, ""))
        self.assertEqual(self.commands, [])

    def test_oversized_input_never_calls_agy(self):
        self.succeed("整えた本文")
        code, out, err = self.run_main([], stdin="あ" * (polish.MAX_CHARS + 1))
        self.assertEqual((code, out), (1, ""))
        self.assertIn("長すぎる", err)
        self.assertEqual(self.commands, [])

    def test_unreadable_file(self):
        self.succeed("整えた本文")
        code, out, err = self.run_main(["/nonexistent/body.md"])
        self.assertEqual((code, out), (1, ""))
        self.assertEqual(self.commands, [])


class LaunchContext(Agy):
    """偽の agy で、仕上げ役が受け取る環境変数と指示文に、Claude Code から起動された文脈が無いことを見る。"""

    def test_polisher_gets_no_launcher_context(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        bindir = agy_testing.install(d, response="整えた本文")
        work = os.path.join(d, "work")
        os.mkdir(work)
        with mock.patch.dict(os.environ, agy_testing.polluted_env(bindir, NEON_LAUNCH_TMP=work)):
            for argv in ([], ["--audience", "client"], ["--doc-type", "proposal"]):
                code, out, _ = self.run_main(argv, stdin="元の本文")
                self.assertEqual((code, out), (0, "整えた本文\n"))
        calls = agy_testing.calls(bindir)
        self.assertEqual(len(calls), 3)
        for call in calls:
            self.assertEqual(agy_testing.leaks(call, [d, os.path.realpath(d)]), [])


if __name__ == "__main__":
    unittest.main()
