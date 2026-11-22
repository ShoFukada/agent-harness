#!/usr/bin/env python3
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "testdata", "artifact-lint")
LINTER = os.path.join(HERE, "artifact-lint.py")

spec = importlib.util.spec_from_file_location("artifact_lint", LINTER)
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return fh.read()


def width(source):
    return lint.analyze(source)[1]


def text_width(source):
    return lint.analyze(source)[2]


def narrowed(source):
    return sorted(set((lint.describe(f[0]), f[1]) for f in text_width(source)))


def page(css, body):
    return "<style>%s</style>%s" % (css, body)


CARDS = '<div class="cards"><div>%s</div><div>%s</div></div>' % (("カードの本文です。" * 3,) * 2)
TABLE = "<table><tr><th>列</th><td>値</td></tr></table>"
FIG = '<div class="fig"><svg viewBox="0 0 960 300"></svg></div>'


class Examples(unittest.TestCase):
    def test_cockpit_redesign_names_the_tables_in_chapters_1_and_7(self):
        found = width(fixture("cockpit-redesign.html"))
        self.assertEqual(len(found), 2)
        for node, value, _, hits in found:
            self.assertEqual((node.tag, node.classes, value), ("section", {"prose"}, "78ch"))
            self.assertEqual([kind for _, kind in hits], ["表"])

    def test_request_trace_names_the_table_in_chapter_1(self):
        found = width(fixture("request-trace.html"))
        self.assertEqual(len(found), 1)
        self.assertEqual([kind for _, kind in found[0][3]], ["表"])

    def test_harness_map_that_narrows_only_paragraphs_and_lists_is_named(self):
        source = fixture("harness-map.html")
        self.assertEqual(width(source), [])
        self.assertEqual(set(value for _, value in narrowed(source)), {"44em", "46em", "48em", "52em"})
        self.assertIn(("<p>", "46em"), narrowed(source))
        self.assertIn(('<blockquote>', "44em"), narrowed(source))

    def test_one_column_harness_map_passes(self):
        self.assertEqual(lint.analyze(fixture("harness-map-one-column.html")), ([], [], []))

    def test_taking_the_section_out_of_the_prose_width_clears_it(self):
        for name in ("cockpit-redesign.html", "request-trace.html"):
            fixed = fixture(name).replace('<section class="prose">', "<section>")
            self.assertEqual(lint.analyze(fixed)[1:], ([], []), name)


class TextWidth(unittest.TestCase):
    WRAP = '<div class="wrap"><h2>見出し</h2>%s</div>'

    def test_paragraph_narrower_than_the_heading_in_the_same_column_is_named(self):
        for css in ("p{max-width:42em}", "ul,ol{max-width:46em}", "blockquote{max-width:40em}"):
            body = self.WRAP % "<p>文</p><ul><li>項目</li></ul><ol><li>項目</li></ol><blockquote>引用</blockquote>"
            found = text_width(page(".wrap{max-width:1100px}" + css, body))
            self.assertTrue(found, css)
            self.assertEqual(found[0][3].classes, {"wrap"})

    def test_prose_frame_around_paragraphs_is_named_but_its_paragraphs_are_not(self):
        body = self.WRAP % '<div class="prose"><p>文</p><p>文</p></div>'
        self.assertEqual(narrowed(page(".wrap{max-width:1100px} .prose{max-width:68ch}", body)),
                         [('<div class="prose">', "68ch")])

    def test_one_column_page_passes(self):
        body = self.WRAP % ("<p>文</p><ul><li>項目</li></ul>%s%s" % (TABLE, FIG))
        self.assertEqual(text_width(page(".wrap{max-width:1100px}", body)), [])

    def test_whole_page_column_at_the_root_passes(self):
        self.assertEqual(text_width(page("main{max-width:760px}", "<main><h1>題</h1><p>文</p></main>")), [])

    def test_heading_outside_a_narrow_column_makes_it_named(self):
        source = page("main{max-width:760px}", "<header><h1>題</h1></header><main><p>文</p><p>文</p></main>")
        self.assertEqual(narrowed(source), [("<main>", "760px")])

    def test_neighbors_in_nav_inline_icons_and_floating_parts_are_not_the_column(self):
        css = ".wrap{max-width:1100px} p{max-width:42em} .toast{position:fixed}"
        body = ('<div class="wrap"><nav><ol><li>目次</li></ol></nav><p>文<svg width="100%"></svg></p>'
                '<div class="toast"><h2>浮いた見出し</h2></div></div>')
        self.assertEqual(text_width(page(css, body)), [])

    def test_text_inside_a_card_grid_or_a_table_is_not_named(self):
        css = (".wrap{max-width:1100px} .cards{display:grid;grid-template-columns:1fr 1fr}"
               " .cards p, td p{max-width:20em}")
        body = self.WRAP % ('%s<table><tr><td><p>セルの文</p></td></tr></table>' % CARDS.replace(
            "<div>カード", "<div><p>カード").replace("。</div>", "。</p></div>"))
        self.assertEqual(text_width(page(css, body)), [])

    def test_slightly_narrower_text_within_the_slack_passes(self):
        body = self.WRAP % "<p>文</p>"
        self.assertEqual(text_width(page(".wrap{max-width:1100px} p{max-width:1080px}", body)), [])

    def test_data_narrow_opts_out(self):
        body = self.WRAP % "<p data-narrow>文</p>"
        self.assertEqual(text_width(page(".wrap{max-width:1100px} p{max-width:42em}", body)), [])

    def test_dialog_with_its_own_width_is_off_the_column(self):
        css = "dialog{max-width:600px} p{max-width:400px}"
        self.assertEqual(text_width(page(css, "<h1>題</h1><dialog><h2>確認</h2><p>文</p><p>文</p></dialog>")), [])

    def test_neighbor_wider_than_the_column_is_clamped_to_the_column(self):
        css = "main{max-width:800px} h2{max-width:1200px} p{max-width:800px}"
        self.assertEqual(text_width(page(css, "<main><h2>見出し</h2><p>文</p></main>")), [])

    def test_column_is_clamped_by_a_narrower_frame_outside_it(self):
        css = "body{max-width:800px} main{max-width:1100px} p{max-width:800px}"
        self.assertEqual(text_width(page(css, "<body><main><h2>見出し</h2><p>文</p></main></body>")), [])

    def test_two_column_nav_grid_is_not_a_card_row_neighbor(self):
        css = "main{max-width:1100px} p{max-width:42em} nav{display:grid;grid-template-columns:1fr 1fr}"
        item = "<div>%s</div>" % ("目次" * 13)
        self.assertEqual(text_width(page(css, "<main><p>文</p><nav>%s%s</nav></main>" % (item, item))), [])

    def test_full_width_card_row_is_a_neighbor(self):
        css = "main{max-width:1100px} p{max-width:42em} .cards{display:grid;grid-template-columns:1fr 1fr}"
        body = '<main><p>文</p>%s</main>' % CARDS.replace("<div>カード", "<article>カード").replace("。</div>", "。</article>")
        self.assertEqual(narrowed(page(css, body)), [("<p>", "42em")])

    def test_summary_of_details_is_a_neighbor(self):
        css = "main{max-width:1100px} p{max-width:42em}"
        body = "<main><details open><summary>見出し</summary><p>本文</p></details></main>"
        self.assertEqual(narrowed(page(css, body)), [("<p>", "42em")])

    def test_card_grid_is_judged_once_per_node(self):
        card = "<article><p>%s</p></article>" % ("本文" * 11)
        css = "main{max-width:1100px} p{max-width:42em} .g{display:grid;grid-template-columns:1fr 1fr}"
        source = page(css, '<main><h1>題</h1><p>文</p><div class="g">%s</div></main>' % (card * 200))
        calls = []
        original = lint.is_card_grid

        def counting(node, computed):
            calls.append(id(node))
            return original(node, computed)

        lint.is_card_grid = counting
        self.addCleanup(setattr, lint, "is_card_grid", original)
        text_width(source)
        self.assertEqual(max(calls.count(n) for n in set(calls)), 1)

    def test_frame_named_by_the_table_check_is_not_named_twice(self):
        found = lint.analyze(fixture("request-trace.html"))
        framed = set(id(f[0]) for f in found[1])
        self.assertTrue(framed)
        self.assertFalse([f for f in found[2] if id(f[0]) in framed])


class Rules(unittest.TestCase):
    CSS = ".wrap{max-width:1120px} .prose{max-width:78ch} "

    def test_table_figure_pre_and_card_grid_in_prose_width_are_named(self):
        body = ('<div class="wrap">%s<section class="prose"><p>文</p>%s<pre>x</pre>'
                '%s</section></div>') % (FIG, TABLE, CARDS)
        found = width(page(self.CSS + ".cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}", body))
        self.assertEqual([kind for _, kind in found[0][3]], ["表", "pre", "カードの並び (grid)"])

    def test_paragraphs_lists_icons_chips_and_label_rows_are_not_named(self):
        css = self.CSS + (".legend{display:flex;flex-wrap:wrap} .row{display:grid;grid-template-columns:9.5em 1fr}")
        body = ('<div class="wrap">%s<section class="prose"><p>文<svg width="16" viewBox="0 0 960 960"></svg></p>'
                '<div class="note"><svg width="14"></svg>注</div>'
                '<ul class="legend"><li>主役</li><li>脇役</li></ul><div class="row"><b>見出し</b><span>本文</span></div>'
                '</section></div>') % FIG
        self.assertEqual(width(page(css, body)), [])

    def test_width_units_and_min(self):
        for value, named in (("78ch", True), ("46em", True), ("min(78ch, 100%)", True), ("760px", True),
                             ("100%", False), ("1120px", False), ("72rem", False), ("var(--w)", False)):
            source = page(".x{max-width:%s}" % value, '%s<div class="x">%s</div>' % (FIG, TABLE))
            self.assertEqual(bool(width(source)), named, value)

    def test_narrow_list_is_named_as_text_not_as_a_table_frame(self):
        source = page("ul{max-width:46em}", "%s<ul><li>%s</li></ul>" % (FIG, TABLE))
        self.assertEqual(width(source), [])
        self.assertEqual(narrowed(source), [("<ul>", "46em")])

    def test_frame_that_holds_every_table_and_figure_is_the_page_width(self):
        self.assertEqual(width(page("main{max-width:860px}", "<main>%s%s</main>" % (FIG, TABLE))), [])

    def test_data_narrow_on_the_frame_or_the_table_opts_out(self):
        css = self.CSS
        on_frame = '%s<section class="prose" data-narrow>%s</section>' % (FIG, TABLE)
        on_table = '%s<section class="prose">%s</section>' % (FIG, TABLE.replace("<table>", "<table data-narrow>"))
        self.assertEqual(width(page(css, on_frame)), [])
        self.assertEqual(width(page(css, on_table)), [])

    def test_media_override_does_not_hide_the_wide_screen_card_grid(self):
        css = self.CSS + (".cards{display:grid;grid-template-columns:1fr 1fr}"
                          "@media print{.cards{display:block}}")
        body = '%s<section class="prose">%s</section>' % (TABLE, CARDS)
        self.assertEqual([kind for _, kind in width(page(css, body))[0][3]], ["カードの並び (grid)"])

    def test_data_narrow_on_an_outer_frame_covers_inner_narrow_boxes(self):
        body = '%s<main data-narrow><section class="x">%s</section></main>' % (FIG, TABLE)
        self.assertEqual(width(page(".x{max-width:700px}", body)), [])

    def test_frame_inside_a_figure_is_not_mistaken_for_the_page_frame(self):
        body = '<figure><section class="x">%s%s</section></figure><pre>x</pre>' % (TABLE, TABLE)
        found = width(page(".x{max-width:700px}", body))
        self.assertEqual([kind for _, kind in found[0][3]], ["表", "表"])

    def test_svg_sized_by_percent_is_a_figure_even_with_a_small_viewbox(self):
        body = '%s<section class="prose"><svg width="100%%" viewBox="0 0 24 24"></svg></section>' % TABLE
        self.assertEqual([kind for _, kind in width(page(self.CSS, body))[0][3]], ["図 (svg)"])

    def test_button_row_in_a_narrow_dialog_is_not_a_card_row(self):
        css = ".box{max-width:360px} .row{display:grid;grid-template-columns:1fr 1fr}"
        body = '%s<div class="box"><p>消しますか</p><div class="row"><a>やめる</a><a>消す</a></div></div>' % TABLE
        self.assertEqual(width(page(css, body)), [])

    def test_rem_sized_icon_and_whitespace_padded_buttons_are_not_named(self):
        css = self.CSS + ".row{display:grid;grid-template-columns:1fr 1fr}"
        pad = "<div>保存\n" + " " * 24 + "<span>→</span></div>"
        body = '%s<section class="prose"><svg width="1rem" viewBox="0 0 960 960"></svg><div class="row">%s%s</div></section>' % (TABLE, pad, pad)
        self.assertEqual(width(page(css, body)), [])

    def test_flex_row_of_text_cards_is_a_card_row(self):
        card = "<div>" + "カードの本文です。" * 4 + "</div>"
        source = page(self.CSS + ".row{display:flex;flex-wrap:wrap}",
                      '%s<section class="prose"><div class="row">%s%s</div></section>' % (FIG, card, card))
        self.assertEqual([kind for _, kind in width(source)[0][3]], ["カードの並び (flex)"])


class Cli(unittest.TestCase):
    def run_lint(self, source):
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as fh:
            fh.write(source)
        self.addCleanup(os.unlink, fh.name)
        return fh.name, subprocess.run([sys.executable, LINTER, fh.name], capture_output=True, text=True)

    def test_cli_reports_both_checks_with_the_fix(self):
        mixed = page(".g{display:grid}", '<div class="g">a<code>b</code>c</div>')
        _, proc = self.run_lint(fixture("cockpit-redesign.html") + mixed)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("1文字ずつ折り返される", proc.stdout)
        self.assertIn("狭い max-width の枠の中に表", proc.stdout)
        self.assertIn("max-width はページ全体の列", proc.stdout)
        self.assertIn("p・ul・ol・blockquote・節（section）・本文の枠（.prose など）には別の max-width を掛けない", proc.stdout)
        self.assertIn("data-narrow", proc.stdout)
        self.assertEqual(proc.stdout.count("直し方: 見出し・文章"), 1)

    def test_cli_names_paragraphs_narrower_than_the_column(self):
        _, proc = self.run_lint(fixture("harness-map.html"))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("同じ列の見出しや表より狭い max-width", proc.stdout)
        self.assertIn("max-width: 46em ≒ 736px  (列は <div class=\"wrap\"> ≒ 1120px", proc.stdout)
        self.assertIn("掛かっている要素: <p> ×", proc.stdout)
        self.assertIn("1 つの同じ幅の列に並べる", proc.stdout)

    def test_clean_page_exits_zero(self):
        _, proc = self.run_lint(fixture("harness-map-one-column.html"))
        self.assertEqual((proc.returncode, proc.stdout), (0, ""))

    def test_hook_returns_the_width_notice_after_write(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "page.html")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(fixture("request-trace.html"))
        out = subprocess.run([sys.executable, os.path.join(HERE, "artifact-lint-hook.py")],
                             input=json.dumps({"tool_name": "Write", "tool_input": {"file_path": path}}),
                             capture_output=True, text=True, check=True).stdout
        context = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn('<section class="prose">', context)
        self.assertIn("1 つの同じ幅の列に並べる", context)


if __name__ == "__main__":
    unittest.main()
