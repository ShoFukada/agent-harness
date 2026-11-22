import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import client_leak  # noqa: E402

CLIENT_HTML = '<meta name="audience" content="client"><h1>ご報告</h1><p>%s</p>'
CLIENT_MD = "---\ntitle: ご報告\naudience: client\n---\n\n%s\n"


class ClientLeakTest(unittest.TestCase):
    def test_html_path_and_harness_words(self):
        found = client_leak.problems(CLIENT_HTML % "詳細は /Users/fukadasho/x.md にあり、サブエージェントが確かめました。")
        self.assertEqual(len(found), 2)
        self.assertIn("/Users/fukadasho", found[0])
        self.assertIn("サブエージェント", found[1])

    def test_markdown_frontmatter(self):
        found = client_leak.problems(CLIENT_MD % "操縦席で進めています。", markdown=True)
        self.assertEqual(found, ["エージェントの仕組みの語（操縦席）"])

    def test_not_client_is_ignored(self):
        self.assertEqual(client_leak.problems("<p>/Users/fukadasho と worker</p>"), [])
        self.assertEqual(client_leak.problems("---\naudience: internal\n---\nworker\n", markdown=True), [])

    def test_code_is_ignored(self):
        self.assertEqual(client_leak.problems(CLIENT_HTML % "手順: <code>cd /Users/you/app</code>"), [])
        self.assertEqual(client_leak.problems(CLIENT_MD % "```\ncd /Users/you/app\n```\n`worktree` を使う", markdown=True), [])

    def test_plain_japanese_and_product_names_are_not_flagged(self):
        self.assertEqual(client_leak.problems(CLIENT_HTML % "窓口は弊社の担当者です。作業者が対応します。"), [])
        self.assertEqual(client_leak.problems(CLIENT_HTML % "ご担当者様がお使いになる Claude Code・Codex と Cloudflare Workers の利用料"), [])

    def test_notice_names_rule(self):
        self.assertIn("要ることだけ", client_leak.notice("a.html", ["手元のパス（/Users/a）"]))

    def test_hook_returns_notice_for_markdown(self):
        import json
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "report.md")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(CLIENT_MD % "scratchpad に置いた案です。")
            hook = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifact-lint-hook.py")
            out = subprocess.run([sys.executable, hook], input=json.dumps({"tool_input": {"file_path": path}}),
                                 capture_output=True, text=True, timeout=10).stdout
        self.assertIn("scratchpad", json.loads(out)["hookSpecificOutput"]["additionalContext"])

    def test_codex_review_cases(self):
        meta = '<meta name="audience" content="client">'
        self.assertTrue(client_leak.problems(meta + '<a href="file:///Users/me/report.pdf">添付資料</a>'))
        self.assertTrue(client_leak.problems("---\naudience: client\n---\nagyで確認しました", True))
        self.assertEqual(client_leak.problems('<!-- <meta name="audience" content="client"> --><p>/Users/me</p>'), [])
        self.assertEqual(client_leak.problems("---\naudience: client\n---\n1. 手順\n   ```\n   cd /Users/me\n   ```\n", True), [])


if __name__ == "__main__":
    unittest.main()
