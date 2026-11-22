#!/usr/bin/env python3
"""ja_spacing.tighten が、判断の記録 R88 の「詰める」所だけを詰め、「残す」所に触らないことを保証する。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import ja_spacing  # noqa: E402

tighten = ja_spacing.tighten


class Tightens(unittest.TestCase):
    """R88 の「詰める」: 数字や短い語の前後。"""

    CASES = [
        ("3 件", "3件"),
        ("22:00 に始める", "22:00に始める"),
        ("main に入れる", "mainに入れる"),
        ("ID で指す", "IDで指す"),
        ("Neon が見る", "Neonが見る"),
        ("未 commit 1 つ", "未commit 1つ"),
        ("2 秒速くなる", "2秒速くなる"),
        ("v1.2.3 に上げる", "v1.2.3に上げる"),
        ("PR #12 を見る", "PR #12を見る"),
        ("（3 件）", "（3件）"),
        ("(3 件)", "(3件)"),
        ("[Neon が見る](https://example.com/a b)", "[Neonが見る](https://example.com/a b)"),
        ("項目 A と B", "項目AとB"),
        ("Claude Code を使う", "Claude Codeを使う"),
        ("50% を超える", "50%を超える"),
        ("C++ で書く", "C++で書く"),
        ("10 MB を超える", "10 MBを超える"),
        ("<p>3 件</p>", "<p>3件</p>"),
    ]

    def test_cases(self):
        for before, after in self.CASES:
            with self.subTest(before=before):
                self.assertEqual(tighten(before), after)


class Keeps(unittest.TestCase):
    """R88 の「残す」: 英数字の続き・コード・パス・SHA・ブランチ名・英語の名前の中。"""

    CASES = [
        "未commit 1つ",
        "Claude Codeを使う",
        "`git status` を流す",
        "結果は `main` です",
        "https://example.com を開く",
        "<https://example.com> を開く",
        "claude/hooks/ja-review.py を直す",
        "ja-review.py を直す",
        "README.md に書く",
        "26ab5f5 で入れた",
        "ShoFukada/ja-spacing に積む",
        "--diff を付ける",
        "LLM_BACKEND=stub が既定",
        "**ID:** で指す",
        "s.fukada@example.com に送る",
        "$TMPDIR に置く",
        "Note: 注意",
        "日本 語",
        "<code>main</code> に入れる",
        "[Neon](https://example.com) が見る",
        "git add 報告.md",
        "git add 報告.markdown",
        "docs/報告.md を見る",
        "修正は ja-spacing に入れる",
        "as-is と to-be",
    ]

    def test_cases(self):
        for text in self.CASES:
            with self.subTest(text=text):
                self.assertEqual(tighten(text), text)

    def test_ordered_list_markers_stay(self):
        for text in ("1. 準備する", "  2) 確かめる"):
            with self.subTest(text=text):
                self.assertEqual(tighten(text), text)

    def test_code_blocks_and_raw_html_are_not_touched(self):
        text = ("```\n3 件\n```\n~~~sh\nNeon が見る\n~~~\n"
                "<pre>3 件</pre>\n<script>const a = 'Neon が見る';</script>\n"
                "<style>.a::after{content:'3 件'}</style>\n<!-- 3 件 -->\n")
        self.assertEqual(tighten(text), text)

    def test_indented_quoted_and_multiline_code_is_not_touched(self):
        for text in ("    echo 3 件\n", "本文\n\n    echo 3 件\n", "> ```\n> 3 件\n> ```\n", "`a\n3 件`\n",
                     "    - 3 件\n    echo 4 件\n", ">     echo 3 件\n"):
            with self.subTest(text=text):
                self.assertEqual(tighten(text), text)

    def test_indented_lines_that_are_not_code_are_tightened(self):
        self.assertEqual(tighten("本文\n    続き 3 件\n"), "本文\n    続き3件\n")
        self.assertEqual(tighten("- 項目\n\n    - 3 件を見る\n"), "- 項目\n\n    - 3件を見る\n")

    def test_frontmatter_is_not_touched(self):
        text = "---\ntitle: 3 件の報告\n---\n\n3 件の報告\n"
        self.assertEqual(tighten(text), "---\ntitle: 3 件の報告\n---\n\n3件の報告\n")
        for text in ("---\r\ntitle: 3 件\r\n---\r\n", "\ufeff---\ntitle: 3 件\n---\n"):
            with self.subTest(text=text):
                self.assertEqual(tighten(text), text)

    def test_tag_attributes_and_link_targets_are_not_touched(self):
        text = '<a title="3 件" href="x">見る</a>\n[a]: https://example.com/3 件\n'
        self.assertEqual(tighten(text), text)

    def test_full_width_space_and_tabs_stay(self):
        for text in ("3　件", "3\t件"):
            self.assertEqual(tighten(text), text)


class Lines(unittest.TestCase):
    def test_only_the_given_lines_change(self):
        text = "3 件\n4 件\n5 件\n"
        self.assertEqual(tighten(text, {2}), "3 件\n4件\n5 件\n")

    def test_empty_line_set_changes_nothing(self):
        self.assertEqual(tighten("3 件\n", set()), "3 件\n")

    def test_crlf_lines_are_counted_like_lf(self):
        self.assertEqual(tighten("3 件\r\n4 件\r\n", {2}), "3 件\r\n4件\r\n")


if __name__ == "__main__":
    unittest.main()
