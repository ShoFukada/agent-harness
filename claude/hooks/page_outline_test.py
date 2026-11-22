#!/usr/bin/env python3
"""page_outline が、背景から入らない・図の無い説明のページだけを名指しし、artifact-lint-hook がそれを返すことを保証する。"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import page_outline  # noqa: E402

PROSE = "<p>" + "業務の流れを説明する文です。" * 80 + "</p>"
SVG = '<svg viewBox="0 0 10 10"><rect width="1" height="1"/></svg>'


def page(*heads, figure=True, extra=""):
    return extra + "".join("<h2>%s</h2>%s" % (h, PROSE) for h in heads) + (SVG if figure else "")


class Problems(unittest.TestCase):
    def test_page_that_starts_from_background_with_a_figure_passes(self):
        self.assertEqual(page_outline.problems(page("背景と前提", "結論", "各論")), [])

    def test_missing_background_and_figure_are_named(self):
        found = page_outline.problems(page("結論", "各論", "残る判断", figure=False))
        self.assertEqual(len(found), 2)
        self.assertIn("最初の章「結論」", found[0])

    def test_short_pages_and_client_pages_are_not_checked(self):
        self.assertEqual(page_outline.problems("<h2>結論</h2><h2>a</h2><h2>b</h2><p>短い</p>"), [])
        client = page("提案の概要", "進め方", "費用", figure=False, extra='<meta name="audience" content="client">')
        self.assertEqual(page_outline.problems(client), [])

    def test_client_meta_in_any_attribute_order_and_commented_svg(self):
        flipped = page("提案の概要", "進め方", "費用", figure=False, extra='<meta content="client" name="audience">')
        self.assertEqual(page_outline.problems(flipped), [])
        commented = page("背景", "結論", "各論", figure=False) + "<!-- <svg></svg> -->"
        self.assertEqual(len(page_outline.problems(commented)), 1, "コメントの中の svg は図に数えない")

    def test_svg_file_referenced_by_img_counts_as_a_figure(self):
        self.assertEqual(page_outline.problems(page("背景", "結論", "各論", figure=False) + '<img src="flow.svg">'), [])


class Hook(unittest.TestCase):
    def test_hook_returns_the_outline_notice_for_html(self):
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as fh:
            fh.write(page("結論", "各論", "残る判断"))
        self.addCleanup(os.unlink, fh.name)
        out = subprocess.run([sys.executable, os.path.join(HERE, "artifact-lint-hook.py")],
                             input=json.dumps({"tool_input": {"file_path": fh.name}}),
                             capture_output=True, text=True, check=True).stdout
        self.assertIn("最初の章「結論」", json.loads(out)["hookSpecificOutput"]["additionalContext"])


if __name__ == "__main__":
    unittest.main()
