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

    def test_waiting_state(self):
        # pasona 11/25 の直し「貴社のご回答待ちとか入れなくていいよ」
        found = client_leak.problems(CLIENT_HTML % "No.12 は貴社のご回答待ちです。No.14 は先方の確認待ち、No.15 はお返事待ちです。")
        self.assertEqual(found, ["進行の状態の語（お返事待ち・ご回答待ち・確認待ち）"])
        self.assertTrue(client_leak.problems(CLIENT_MD % "- 連絡待ち: 2件", markdown=True))
        self.assertTrue(client_leak.problems(CLIENT_HTML % "No.12 は「貴社のご回答待ち」です。"))

    def test_waiting_closings_and_screen_status_are_not_flagged(self):
        ok = ("ご確認をお待ちしております。ご回答をお待ちしています。お返事お待ちしております。"
              "申請は承認待ちの状態になります。状態が「回答待ち」の行を選びます。画面の「AI確認待ち」の欄に出ます。")
        self.assertEqual(client_leak.problems(CLIENT_HTML % ok), [])

    def test_maker_explanation(self):
        # pasona の比較版 HTML から 3 回外した前書き（c9e24ec・78dc291・7ee339c）と、u-48「今回の対応まとめ不要」
        found = client_leak.problems(CLIENT_HTML % "助言の中身と定型文は 11/21 修正版と同じです。" + "<h2>生成の記録</h2>")
        self.assertEqual(found, ["作り手の説明（修正版と同じ・生成の記録）"])
        self.assertEqual(client_leak.problems(CLIENT_HTML % "" + "<h3>今回の対応まとめ</h3>"), ["作り手の説明（今回の対応まとめ）"])
        self.assertEqual(client_leak.problems(CLIENT_MD % "## 今回の変更点\n\n本文", markdown=True), ["作り手の説明（今回の変更点）"])

    def test_maker_words_in_body_and_incident_headings_are_not_flagged(self):
        self.assertEqual(client_leak.problems(CLIENT_HTML % "今回の対応により、通知の遅れは解消しました。" + "<h2>対応内容</h2>"), [])
        self.assertEqual(client_leak.problems(CLIENT_MD % "## 対応内容\n\n今回の修正で解消しました。", markdown=True), [])

    def test_deck_data_audience(self):
        # medurance-web-docs の deck は .deck の data-audience で顧客向けを示す
        deck = '<div class="deck" data-headings="label" data-audience="%s"><section><p>貴社のご回答待ちです。</p></section></div>'
        self.assertTrue(client_leak.problems(deck % "ドクターズ株式会社さま向け"))
        self.assertTrue(client_leak.problems(deck % "社外共有用"))
        self.assertEqual(client_leak.problems(deck % "internal"), [])
        self.assertEqual(client_leak.problems(deck % "社内・協力会社向けの見本（架空の案件）"), [])
        self.assertEqual(client_leak.problems("<pre>&lt;div data-audience=&quot;x&quot;&gt;</pre><code>data-audience='A社さま向け'</code><p>確認待ち</p>"), [])
        self.assertEqual(client_leak.problems('<p data-audience="A社さま向け">属性の見本です。</p><p>確認待ち</p>'), [])
        self.assertEqual(client_leak.problems('<p>data-audience="A社さま向け" と書きます。確認待ち</p>'), [])

    def test_html_code_inside_markdown_is_ignored(self):
        self.assertEqual(client_leak.problems(CLIENT_MD % "<code>確認待ち</code>\n\n<pre>\n## 今回の対応\n</pre>", markdown=True), [])

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
