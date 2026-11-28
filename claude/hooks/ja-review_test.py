#!/usr/bin/env python3
"""ja-review.py が、人間の文章だけを書き直し役に渡し、安全な書き直しだけを採ることを保証する。

書き直し役（agy）の実モデルは呼ばない。呼ぶ前の抽出・閾値と、返ってきた本文の採否・書き戻し・
差し戻しの形だけを対象にする。
"""

import importlib.util
import io
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "bin"))
import agy_testing  # noqa: E402

# 書き直し役の使い捨ての cwd は利用者の一時フォルダに作る。sandbox の中ではそこに書けないので、テストの一時領域に向ける
os.environ.setdefault("NEON_LAUNCH_TMP", tempfile.gettempdir())
_SPEC = importlib.util.spec_from_file_location("ja_review", os.path.join(_HERE, "ja-review.py"))
review = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(review)


_IDS = itertools.count()


def user_prompt(text="次の作業をして"):
    return {"type": "user", "isSidechain": False, "promptSource": "typed",
            "origin": {"kind": "human"}, "message": {"role": "user", "content": text}}


def task_notification(text="<task-notification>\n<task-id>a52</task-id>\n</task-notification>"):
    """サブエージェントの完了通知。人間の入力と同じ type: user で届く。"""
    return {"type": "user", "isSidechain": False, "promptSource": "system",
            "origin": {"kind": "task-notification"}, "queueSkipAttachments": True,
            "message": {"role": "user", "content": text}}


def tool_call(name, tool_input, sidechain=False, ok=True, result_data=None):
    """tool_use と、その結果の tool_result を対で返す。result_data は transcript の toolUseResult。"""
    identifier = "toolu_%d" % next(_IDS)
    result = {"type": "tool_result", "tool_use_id": identifier, "content": "ok"}
    if not ok:
        result = dict(result, is_error=True, content="String to replace not found in file.")
    return [
        {"type": "assistant", "isSidechain": sidechain, "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": identifier, "name": name, "input": tool_input}]}},
        dict({"type": "user", "isSidechain": sidechain, "message": {
            "role": "user", "content": [result]}},
            **({"toolUseResult": result_data} if result_data is not None else {})),
    ]


class TempDir(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ja-review-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        directory = os.path.dirname(path)
        if not os.path.isdir(directory):
            os.makedirs(directory)
        with io.open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        return path

    def read(self, path):
        with io.open(path, encoding="utf-8", newline="") as fh:
            return fh.read()

    def transcript(self, entries, name="transcript.jsonl"):
        flat = []
        for entry in entries:
            flat.extend(entry if isinstance(entry, list) else [entry])
        return self.write(name, "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in flat))


class Isolated(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, review, "FAILURE_LOG", review.FAILURE_LOG)
        review.FAILURE_LOG = "ja-review-test-%d-failures.log" % os.getpid()
        log = os.path.join(tempfile.gettempdir(), review.FAILURE_LOG)
        self.addCleanup(lambda: os.path.exists(log) and os.unlink(log))


class RewriteOutput(Isolated):
    def stub(self, response):
        self.addCleanup(setattr, review, "call_agy", review.call_agy)
        self.prompts = []

        def fake(prompt, deadline=None):
            self.prompts.append(prompt)
            return (response, None) if response is not None else (None, "bad_output")
        review.call_agy = fake

    def test_ok_line_means_no_rewrite(self):
        self.stub("OK")
        self.assertEqual(review.rewrite("硬い日本語の本文"), ("", None))

    def test_ok_with_a_period_is_still_ok(self):
        self.stub("OK。\n")
        self.assertEqual(review.rewrite("硬い日本語の本文"), ("", None))

    def test_rewritten_body_is_adopted(self):
        self.stub("読みやすい本文")
        self.assertEqual(review.rewrite("硬い本文"), ("読みやすい本文", None))

    def test_failed_call_is_not_adopted(self):
        self.stub(None)
        self.assertEqual(review.rewrite("硬い本文"), (None, "bad_output"))

    def test_empty_response_is_not_adopted(self):
        self.stub("   \n")
        self.assertEqual(review.rewrite("硬い本文"), (None, "empty_response"))

    def test_wrapping_code_fence_is_stripped(self):
        self.stub("```\n読みやすい本文\n```")
        self.assertEqual(review.rewrite("硬い本文"), ("読みやすい本文", None))

    def test_one_line_preamble_is_dropped(self):
        self.stub("以下のように書き直しました\n\n一行目の本文\n二行目の本文")
        self.assertEqual(review.rewrite("一行目\n二行目"),
                         ("一行目の本文\n二行目の本文", None))

    def test_oversized_text_reaches_no_model(self):
        self.stub("OK")
        self.assertEqual(review.rewrite("あ" * (review.MAX_CHARS + 1)), (None, "too_long"))
        self.assertEqual(self.prompts, [])

    def test_prompt_carries_the_rules_and_the_listed_words(self):
        self.stub("OK")
        review.rewrite("正本を更新した。", review.vocab_result("正本を更新した。"))
        self.assertIn("文の組み立て方", self.prompts[0])
        self.assertIn("正本", self.prompts[0])


class Audience(Isolated):
    """顧客向けの印があれば口語を業務文書に直させ、社内の印なら語調を保たせ、印が無ければ本文から判断させる。"""

    stub = RewriteOutput.stub

    def test_frontmatter_marks_a_client_document(self):
        self.stub("OK")
        review.rewrite("---\ntitle: 提案\naudience: client\n---\n\nいちばん安い案です。")
        self.assertIn("顧客・社外の読み手に渡す業務文書です", self.prompts[0])
        self.assertNotIn("元の語調を保ち", self.prompts[0])

    def test_html_meta_marks_a_client_document(self):
        self.assertEqual(review.audience('<title>報告</title>\n<meta name="audience" content="client">'), "client")

    def test_deck_data_audience_marks_the_reader(self):
        self.assertEqual(review.audience('<div class="deck" data-audience="ドクターズ株式会社さま向け">'), "client")
        self.assertEqual(review.audience('<div class="deck" data-audience="internal">'), "internal")

    def test_internal_marker_keeps_the_tone(self):
        self.stub("OK")
        review.rewrite("<!-- audience: internal -->\nざっくり直しました。")
        self.assertIn("元の語調を保ち", self.prompts[0])
        self.assertNotIn("規則の「業務文書の語調」に従って", self.prompts[0])

    def test_unmarked_text_is_judged_from_its_content(self):
        self.stub("OK")
        review.rewrite("株式会社〇〇 御中\n\nざっくり見積もりました。")
        self.assertIn("読み手を本文から判断してください", self.prompts[0])

    def test_audience_in_a_later_paragraph_is_not_a_marker(self):
        self.assertIsNone(review.audience("本文\n\naudience: client と書くと顧客向けになる"))

    def test_meta_attributes_in_either_order(self):
        self.assertEqual(review.audience('<meta content="client" name="audience">'), "client")
        self.assertEqual(review.audience("<META NAME='audience' CONTENT='client' />"), "client")

    def test_markers_in_code_or_quotes_are_examples(self):
        for text in (
            "# 手順書\n\n顧客向けには次の印を付ける。\n\n```html\n<!-- audience: client -->\n```\n",
            "# 手順書\n\n印は `<meta name=\"audience\" content=\"client\">` と書く。\n",
            "# 手順書\n\n> <!-- audience: client -->\n",
        ):
            with self.subTest(text=text):
                self.assertIsNone(review.audience(text))

    def test_frontmatter_is_read_only_inside_the_first_block(self):
        text = "---\ntitle: 手順\n---\n\n設定の例:\n\n---\naudience: client\n---\n\nちゃんと動く。\n"
        self.assertIsNone(review.audience(text))
        self.assertEqual(review.audience("---\ntitle: 提案\naudience: 'client'\n---\n本文\n"), "client")

    def test_the_rules_carry_the_business_register(self):
        self.assertIn("業務文書の語調", review.rules())


class Safety(Isolated):
    def stub(self, response):
        self.addCleanup(setattr, review, "call_agy", review.call_agy)
        review.call_agy = lambda prompt, deadline=None: (response, None)

    def test_same_structure_is_accepted(self):
        original = "# 見出し\n本文が 3 件ある。\n```\ncode\n```\n"
        self.assertTrue(review.safe(original, "# 見出し\n本文は 3 件。\n```\ncode\n```\n"))

    def test_number_structure_mismatch_is_rejected(self):
        for original, rewritten in (("3 件ある。", "4 件ある。"),
                                    ("2026-09-09 の記録。", "その日の記録。"),
                                    ("10 円と 20 円。", "20 円と 10 円。")):
            with self.subTest(original=original):
                self.assertFalse(review.safe(original, rewritten))

    def test_dropped_code_fence_is_rejected(self):
        self.assertFalse(review.safe("説明。\n```\ncode\n```\n", "説明。\ncode\n"))

    def test_dropped_heading_is_rejected(self):
        self.assertFalse(review.safe("# 見出し\n本文。", "本文。"))

    def test_empty_rewrite_is_rejected(self):
        self.assertFalse(review.safe("本文。", "  \n"))

    def test_changed_heading_level_is_rejected(self):
        self.assertFalse(review.safe("# 見出し\n本文。", "## 見出し\n本文。"))

    def test_changed_inline_code_is_rejected(self):
        self.assertFalse(review.safe("`foo` を使う。", "`bar` を使う。"))

    def test_dropped_inline_code_is_rejected(self):
        self.assertFalse(review.safe("`foo` を使う。", "foo を使う。"))

    def test_changed_fenced_line_is_rejected(self):
        self.assertFalse(review.safe("説明。\n```\nfoo\n```\n", "説明。\n```\nbar\n```\n"))

    def test_changed_link_url_is_rejected(self):
        self.assertFalse(review.safe("[説明](https://a.example)。",
                                     "[説明](https://b.example)。"))

    def test_link_text_may_change(self):
        self.assertTrue(review.safe("[古い説明](https://a.example) を読む。",
                                    "[新しい説明](https://a.example) を読む。"))

    def test_prose_around_the_structure_may_change(self):
        original = "## 手順\n`make` を実行する。\n```\nmake all\n```\n[詳細](https://a.example)\n"
        rewritten = "## 手順\n`make` を叩く。\n```\nmake all\n```\n[詳細](https://a.example)\n"
        self.assertTrue(review.safe(original, rewritten))

    def test_collapsed_body_is_rejected(self):
        original = "同じ趣旨の文がいくつも並ぶ長い本文です。" * 10
        self.assertFalse(review.safe(original, "趣旨をまとめた一行。"))

    def test_moderate_shortening_is_accepted(self):
        original = "本節においては当該処理の内容を記述するものである。" * 4
        self.assertTrue(review.safe(original, "この節では処理の内容を説明する。" * 4))

    PLAIN = ("担当者は次の手順で導入する。まず権限を確認する。確認後、設定ファイルを編集する。"
             "検証環境へデプロイして稼働を確認する。問題なければ本番環境へ展開する。")
    POLITE = ("担当者は次の手順で導入します。まず権限を確認します。確認後、設定ファイルを編集します。"
              "検証環境へデプロイして稼働を確認します。問題なければ本番環境へ展開します。")

    def test_plain_turned_polite_is_rejected(self):
        self.assertFalse(review.safe(self.PLAIN, self.POLITE))

    def test_polite_turned_plain_is_rejected(self):
        self.assertFalse(review.safe(self.POLITE, self.PLAIN))

    def test_a_short_text_turned_plain_is_rejected(self):
        self.assertFalse(review.safe("設定を更新します。内容を確認します。",
                                     "設定を更新する。内容を確認する。"))

    def test_same_tone_is_accepted(self):
        self.assertTrue(review.safe(self.PLAIN, self.PLAIN.replace("次の手順で", "次のとおり")))

    def test_short_text_has_no_tone_to_compare(self):
        self.assertIsNone(review.politeness("直した。"))
        self.assertTrue(review.safe("硬い本文。", "読みやすい本文です。"))

    def test_flipped_negation_is_rejected(self):
        self.assertFalse(review.safe("このコマンドはファイルを削除しません。",
                                     "このコマンドはファイルを削除します。"))

    def test_kept_negation_is_accepted(self):
        self.assertTrue(review.safe("このコマンドはファイルを削除しません。",
                                    "このコマンドはファイルを消しません。"))

    def test_changed_unit_is_rejected(self):
        self.assertFalse(review.safe("費用は 10万円だった。", "費用は 10円だった。"))

    def test_spacing_inside_a_quantity_does_not_matter(self):
        self.assertTrue(review.safe("費用は 10万円だった。", "費用は 10 万円だった。"))

    def test_changed_name_is_rejected(self):
        self.assertFalse(review.safe("田中さんに確認する。", "鈴木さんに確認する。"))

    def test_a_compound_ending_in_an_honorific_is_not_a_name(self):
        self.assertTrue(review.safe("同様の手順で進める。", "同じ手順で進める。"))

    def test_a_katakana_word_may_be_rephrased(self):
        self.assertTrue(review.safe("コンテキストを引き継ぐ手順を決める。",
                                    "文脈を引き継ぐ手順を決める。"))

    def test_dropped_quotation_is_rejected(self):
        self.assertFalse(review.safe("「完遂原則」に従う。", "決めた原則に従う。"))

    def test_unsafe_response_is_not_adopted_by_rewrite(self):
        self.stub("4 件ある。")
        self.assertEqual(review.rewrite("3 件ある。"), (None, "unsafe_rewrite"))


class FailureCauses(Isolated):
    def stub(self, response):
        self.addCleanup(setattr, review, "call_agy", review.call_agy)
        review.call_agy = lambda prompt, deadline=None: (response, None)

    def log(self):
        with open(os.path.join(tempfile.gettempdir(), review.FAILURE_LOG), encoding="utf-8") as fh:
            return fh.read()

    def test_empty_response_is_logged_apart_from_an_unsafe_rewrite(self):
        self.stub("   \n")
        self.assertEqual(review.rewrite("硬い本文", mode="stop"), (None, "empty_response"))
        self.assertIn("empty_response", self.log())

    def test_unsafe_rewrite_has_its_own_cause(self):
        self.stub("4 件ある。")
        self.assertEqual(review.rewrite("3 件ある。", mode="stop"), (None, "unsafe_rewrite"))
        self.assertIn("unsafe_rewrite", self.log())


class StripWrapping(unittest.TestCase):
    def test_preamble_absent_from_the_original_is_dropped(self):
        text = review.strip_wrapping("以下のように書き直しました\n\n一行目\n二行目", "元の本文\n別の行")
        self.assertEqual(text, "一行目\n二行目")

    def test_first_line_present_in_the_original_is_kept(self):
        original = "以下の手順で進める\n\n一行目\n二行目"
        self.assertEqual(review.strip_wrapping(original, original), original)


class ReadGuards(TempDir):
    def test_oversized_file_is_not_read(self):
        path = self.write("big.md", "あ" * (review.MAX_FILE_BYTES // 3 + 10))
        self.assertGreater(os.path.getsize(path), review.MAX_FILE_BYTES)
        self.assertIsNone(review.read_raw(path))

    def test_non_utf8_file_is_not_read(self):
        path = os.path.join(self.dir, "sjis.md")
        with open(path, "wb") as fh:
            fh.write("日本語の本文。".encode("shift_jis"))
        self.assertIsNone(review.read_raw(path))

    def test_plain_file_is_read_as_is(self):
        path = self.write("a.md", "本文。\r\n")
        self.assertEqual(review.read_raw(path), "本文。\r\n")


class ReplaceFile(TempDir):
    def test_unchanged_file_is_replaced(self):
        path = self.write("a.md", "元の本文\n")
        self.assertEqual(review.replace_file(path, "元の本文\n", "直した本文\n"), (True, ""))
        self.assertEqual(self.read(path), "直した本文\n")

    def test_file_changed_underneath_is_left_alone(self):
        path = self.write("a.md", "他の人が書いた本文\n")
        written, problem = review.replace_file(path, "元の本文\n", "直した本文\n")
        self.assertFalse(written)
        self.assertIn("書き直し中にファイルが変わった", problem)
        self.assertEqual(self.read(path), "他の人が書いた本文\n")

    def test_permissions_are_kept(self):
        path = self.write("a.md", "元の本文\n")
        os.chmod(path, 0o640)
        review.replace_file(path, "元の本文\n", "直した本文\n")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)

    def test_no_temporary_file_is_left_behind(self):
        path = self.write("a.md", "元の本文\n")
        review.replace_file(path, "元の本文\n", "直した本文\n")
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith(".ja-review-")], [])


class FailureLog(TempDir):
    def setUp(self):
        TempDir.setUp(self)
        self.addCleanup(setattr, review, "FAILURE_LOG", review.FAILURE_LOG)
        review.FAILURE_LOG = os.path.basename(self.dir) + "-failures.log"
        self.log = os.path.join(tempfile.gettempdir(), review.FAILURE_LOG)
        self.addCleanup(lambda: os.path.exists(self.log) and os.unlink(self.log))
        self.addCleanup(setattr, review, "call_agy", review.call_agy)

    def test_cause_and_length_are_appended(self):
        review.call_agy = lambda prompt, deadline=None: (
            None, "nonzero_exit=1 stderr: quota exceeded")
        review.rewrite("硬い本文", mode="stop")
        review.rewrite("硬い本文", mode="pre")
        lines = self.read(self.log).splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("stop", lines[0])
        self.assertIn("nonzero_exit=1", lines[0])
        self.assertIn("quota exceeded", lines[0])
        self.assertIn("4 字", lines[0])
        self.assertIn("pre", lines[1])

    def test_oversized_text_is_logged_as_too_long(self):
        review.call_agy = lambda prompt, deadline=None: (None, "should not be called")
        review.rewrite("あ" * (review.MAX_CHARS + 1), mode="stop")
        self.assertIn("too_long", self.read(self.log))


class Newlines(unittest.TestCase):
    def test_crlf_file_keeps_its_newlines(self):
        self.assertEqual(review.restore("一行目\n直した\n", "一行目\r\n二行目\r\n"),
                         "一行目\r\n直した\r\n")

    def test_trailing_newline_is_added_back(self):
        self.assertEqual(review.restore("本文", "元の本文\n"), "本文\n")

    def test_missing_trailing_newline_stays_missing(self):
        self.assertEqual(review.restore("本文\n", "元の本文"), "本文")


class Rules(unittest.TestCase):
    def test_section_is_read_from_the_skill(self):
        section = review.rules()
        self.assertIn("文の組み立て方", section)
        self.assertNotIn("# 仕上げ", section)

    def test_missing_rules_file_yields_no_rules(self):
        self.addCleanup(setattr, review, "RULES_MD", review.RULES_MD)
        review.RULES_MD = "/nonexistent/SKILL.md"
        self.assertEqual(review.rules(), "")
        self.assertNotIn("文の組み立て方", review.rules_block())


class Extraction(unittest.TestCase):
    def text(self, command, cwd="/tmp"):
        return review.gh_human_text(command, cwd)

    def test_title_is_not_collected(self):
        self.assertEqual(self.text('gh pr create --title "件名" --body "本文"'), "本文")

    def test_multiline_body_keeps_its_newlines(self):
        self.assertEqual(self.text('gh pr create --body "一行目\n二行目"'), "一行目\n二行目")

    def test_short_flag_joined_to_its_value(self):
        self.assertEqual(self.text("gh pr create -b本文連結"), "本文連結")

    def test_short_flag_joined_to_a_quoted_value(self):
        self.assertEqual(self.text("gh pr create -b'引用付き 本文'"), "引用付き 本文")

    def test_long_flag_with_equals(self):
        self.assertEqual(self.text('gh issue create --body=本文 --title=件名'), "本文")

    def test_global_option_with_a_value_is_skipped(self):
        self.assertEqual(self.text('gh -R owner/repo pr comment 5 --body "本文"'), "本文")

    def test_env_prefix_is_skipped(self):
        self.assertEqual(self.text('env FOO=1 gh issue create --body "本文"'), "本文")

    def test_assignment_prefix_is_skipped(self):
        self.assertEqual(self.text('FOO=bar gh issue create --body "本文"'), "本文")

    def test_quoted_separators_do_not_split_the_body(self):
        self.assertEqual(self.text('gh pr create --body "a ; b | c && d"'), "a ; b | c && d")

    def test_body_is_found_after_another_command(self):
        self.assertEqual(self.text('git status && gh pr create --body "本文" && git push'), "本文")

    def test_release_notes_are_collected(self):
        self.assertEqual(self.text('gh release create v1 --notes "リリース本文"'), "リリース本文")

    def test_non_target_subcommand_yields_nothing(self):
        self.assertEqual(self.text("gh pr list --json number"), "")

    def test_unrelated_command_yields_nothing(self):
        self.assertEqual(self.text('git commit -m "本文"'), "")

    def test_shell_comment_line_does_not_hide_the_command(self):
        self.assertEqual(self.text('# PR を出す\ngh pr create --body "本文"'), "本文")

    def test_trailing_shell_comment_is_dropped(self):
        self.assertEqual(self.text('gh pr create --body "本文" # あとで直す'), "本文")

    def test_hash_inside_the_body_is_kept(self):
        self.assertEqual(self.text('gh pr create --body "見出し # と本文"'), "見出し # と本文")

    def test_hash_inside_a_word_is_not_a_comment(self):
        self.assertEqual(self.text('gh pr create --body issue#12の対応'), "issue#12の対応")


class Unsupported(unittest.TestCase):
    def text(self, command, cwd="/tmp"):
        return review.gh_human_text(command, cwd)

    def test_command_substitution_is_not_rewritten(self):
        self.assertIsNone(self.text('gh pr create --body "$(cat body.md)"'))

    def test_backtick_substitution_is_not_rewritten(self):
        self.assertIsNone(self.text('gh pr create --body "`cat body.md`"'))

    def test_heredoc_is_not_rewritten(self):
        self.assertIsNone(self.text('gh pr create --body-file - <<EOF\n本文\nEOF'))

    def test_stdin_body_file_is_not_rewritten(self):
        self.assertIsNone(self.text("gh pr create --body-file -"))

    def test_missing_body_file_is_not_rewritten(self):
        self.assertIsNone(self.text("gh pr create --body-file /nonexistent/body.md"))

    def test_unbalanced_quote_is_not_rewritten(self):
        self.assertIsNone(self.text('gh pr create --body "閉じていない'))

    def test_backtick_inside_single_quotes_is_literal(self):
        self.assertEqual(self.text("gh pr create --body '`code` を含む本文'"), "`code` を含む本文")

    def test_flag_without_a_value_is_not_rewritten(self):
        self.assertIsNone(self.text("gh pr create --body"))


class BodyFile(TempDir):
    def test_relative_path_resolves_against_cwd(self):
        self.write("docs/body.md", "ファイルの本文。")
        self.assertEqual(review.gh_human_text("gh pr create --body-file docs/body.md", self.dir),
                         "ファイルの本文。")

    def test_cd_is_composed_before_resolving(self):
        self.write("docs/body.md", "ファイルの本文。")
        self.assertEqual(review.gh_human_text("cd docs && gh pr create -F body.md", self.dir),
                         "ファイルの本文。")

    def test_nested_cd_is_composed_left_to_right(self):
        self.write("a/b/body.md", "深い本文。")
        self.assertEqual(review.gh_human_text("cd a && cd b && gh pr create -F body.md", self.dir),
                         "深い本文。")

    def test_cd_to_parent_is_composed(self):
        self.write("body.md", "親の本文。")
        self.write("docs/x.txt", "")
        self.assertEqual(review.gh_human_text("cd docs && cd .. && gh pr create -F body.md", self.dir),
                         "親の本文。")

    def test_cd_after_gh_does_not_move_the_lookup(self):
        self.write("body.md", "本文。")
        self.assertEqual(review.gh_human_text("gh pr create -F body.md && cd /elsewhere", self.dir),
                         "本文。")

    def test_unresolvable_cd_is_not_rewritten(self):
        self.assertIsNone(review.gh_human_text('cd - && gh pr create --body "本文"', self.dir))

    def test_relative_path_without_a_cwd_is_not_rewritten(self):
        self.assertIsNone(review.gh_human_text("gh pr create -F body.md", ""))

    def test_semicolon_between_cd_and_gh_is_serial(self):
        self.write("docs/body.md", "本文。")
        self.assertEqual(review.gh_human_text("cd docs ; gh pr create -F body.md", self.dir), "本文。")

    def test_command_before_cd_is_not_rewritten(self):
        self.assertIsNone(review.gh_human_text('false && cd docs && gh pr create --body "本文"', self.dir))

    def test_subshell_around_cd_is_not_rewritten(self):
        self.assertIsNone(review.gh_human_text('(cd docs && gh pr create --body "本文")', self.dir))

    def test_pipe_next_to_cd_is_not_rewritten(self):
        self.assertIsNone(review.gh_human_text('cd docs | cat ; gh pr create --body "本文"', self.dir))

    def test_or_next_to_cd_is_not_rewritten(self):
        self.assertIsNone(review.gh_human_text('cd docs || true ; gh pr create --body "本文"', self.dir))

    def test_pipe_without_a_cd_is_still_collected(self):
        self.assertEqual(review.gh_human_text('cat x | gh pr create --body "本文"', self.dir), "本文")


class InlineRebuild(unittest.TestCase):
    def records(self, command, cwd="/tmp"):
        return review.gh_bodies(command, cwd)

    def test_single_gh_call_carries_a_token_position(self):
        record = self.records('gh issue create --repo o/r --title t --body "本文"')[0]
        self.assertIsNotNone(record["token"])

    def test_compound_command_carries_no_token_position(self):
        record = self.records('git status && gh issue create --body "本文"')[0]
        self.assertIsNone(record["token"])

    def test_equals_form_keeps_its_prefix(self):
        record = self.records("gh issue create --body=本文")[0]
        self.assertEqual(record["prefix"], "--body=")

    def test_replacement_rebuilds_the_command(self):
        command = 'gh issue create --repo o/r --body "硬い本文"'
        record = self.records(command)[0]
        rebuilt = review.rebuild(command, [(record["token"], record["prefix"], "直した 本文")])
        self.assertEqual(rebuilt, "gh issue create --repo o/r --body '直した 本文'")

    def test_replacement_keeps_the_equals_form(self):
        command = "gh issue create --body=硬い本文"
        record = self.records(command)[0]
        rebuilt = review.rebuild(command, [(record["token"], record["prefix"], "直した本文")])
        self.assertEqual(rebuilt, "gh issue create '--body=直した本文'")


class ProseLength(unittest.TestCase):
    def test_code_block_does_not_count_toward_the_threshold(self):
        prose = "説明の文。\n"
        code = "```\n" + ("日本語のコメント\n" * 40) + "```\n"
        self.assertLess(review.prose_japanese_length(prose + code), review.MIN_JAPANESE)

    def test_plain_japanese_counts(self):
        self.assertEqual(review.prose_japanese_length("これはテストです abc 123"), 8)

    def test_quoted_block_does_not_count(self):
        self.assertEqual(review.prose_japanese_length("> 引用の日本語\n"), 0)


class Cache(unittest.TestCase):
    def setUp(self):
        self.text = "重複した書き直しを避けるための本文 %d" % os.getpid()
        self.addCleanup(self.remove)

    def remove(self):
        try:
            os.unlink(review.cache_path(self.text))
        except OSError:
            pass

    def test_unseen_text_is_not_cached(self):
        self.remove()
        self.assertFalse(review.cached(self.text))

    def test_remembered_text_is_cached(self):
        review.remember(self.text)
        self.assertTrue(review.cached(self.text))

    def test_different_text_has_its_own_entry(self):
        review.remember(self.text)
        self.assertFalse(review.cached(self.text + "違う"))

    def test_entry_older_than_the_ttl_is_ignored(self):
        review.remember(self.text)
        path = review.cache_path(self.text)
        stale = time.time() - review.CACHE_TTL - 60
        os.utime(path, (stale, stale))
        self.assertFalse(review.cached(self.text))

    def test_prune_removes_only_stale_entries(self):
        review.remember(self.text)
        fresh = review.cache_path(self.text)
        old = os.path.join(os.path.dirname(fresh), "0" * 64)
        open(old, "w").close()
        stale = time.time() - review.CACHE_TTL - 60
        os.utime(old, (stale, stale))
        review.prune(os.path.dirname(fresh))
        self.assertTrue(os.path.exists(fresh))
        self.assertFalse(os.path.exists(old))


class WrittenPaths(TempDir):
    def test_file_path_is_taken_as_is(self):
        self.assertEqual(review.written_paths({"file_path": "/tmp/a.md", "content": "本文"}, ""),
                         ["/tmp/a.md"])

    def test_apply_patch_paths_resolve_against_cwd(self):
        command = "*** Begin Patch\n*** Update File: docs/a.md\n@@\n+本文\n*** End Patch\n"
        self.assertEqual(review.written_paths({"command": command}, "/work"),
                         ["/work/docs/a.md"])

    def test_unrelated_input_yields_nothing(self):
        self.assertEqual(review.written_paths({"pattern": "本文"}, ""), [])


class TurnWrittenPaths(TempDir):
    def paths(self, entries):
        return [w[0] for w in review.turn_writes(self.transcript(entries), self.dir)]

    def test_only_writes_after_the_last_prompt_are_collected(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Write", {"file_path": "/w/old.md", "content": "前のターン"}),
            user_prompt("次のお願い"),
            tool_call("Write", {"file_path": "/w/new.md", "content": "今のターン"}),
        ]), ["/w/new.md"])

    def test_repeated_edits_of_one_file_are_collected_once(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Edit", {"file_path": "/w/a.md", "new_string": "一度目"}),
            tool_call("MultiEdit", {"file_path": "/w/a.md", "edits": []}),
            tool_call("Write", {"file_path": "/w/b.md", "content": "別の文書"}),
        ]), ["/w/a.md", "/w/b.md"])

    def test_sidechain_writes_are_ignored(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Write", {"file_path": "/w/sub.md", "content": "subagent"}, sidechain=True),
            tool_call("Write", {"file_path": "/w/main.md", "content": "本体"}),
        ]), ["/w/main.md"])

    def test_tool_results_do_not_reset_the_turn(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Write", {"file_path": "/w/a.md", "content": "本文"}),
            tool_call("Bash", {"command": "ls"}),
        ]), ["/w/a.md"])

    def test_injected_user_entry_does_not_reset_the_turn(self):
        injected = user_prompt("skill の説明")
        injected["isMeta"] = True
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Write", {"file_path": "/w/a.md", "content": "本文"}),
            injected,
            tool_call("Write", {"file_path": "/w/b.md", "content": "本文"}),
        ]), ["/w/a.md", "/w/b.md"])

    def test_task_notification_does_not_reset_the_turn(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Write", {"file_path": "/w/a.md", "content": "本文"}),
            task_notification(),
            tool_call("Write", {"file_path": "/w/b.md", "content": "本文"}),
        ]), ["/w/a.md", "/w/b.md"])

    def test_failed_edit_is_not_collected(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Edit", {"file_path": "/w/failed.md", "new_string": "断片"}, ok=False),
            tool_call("Write", {"file_path": "/w/a.md", "content": "本文"}),
        ]), ["/w/a.md"])

    def test_write_without_a_result_is_not_collected(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Write", {"file_path": "/w/pending.md", "content": "本文"})[0],
        ]), [])

    def test_a_failed_edit_does_not_drop_an_earlier_success(self):
        self.assertEqual(self.paths([
            user_prompt(),
            tool_call("Write", {"file_path": "/w/a.md", "content": "本文"}),
            tool_call("Edit", {"file_path": "/w/a.md", "new_string": "断片"}, ok=False),
        ]), ["/w/a.md"])

    def test_apply_patch_targets_are_collected(self):
        command = "*** Begin Patch\n*** Update File: docs/a.md\n@@\n+本文\n*** End Patch\n"
        self.assertEqual(self.paths([user_prompt(), tool_call("apply_patch", {"command": command})]),
                         [os.path.join(self.dir, "docs/a.md")])

    def test_missing_transcript_yields_nothing(self):
        self.assertEqual(review.turn_writes(os.path.join(self.dir, "none.jsonl"), ""), [])
        self.assertEqual(review.turn_writes(None, ""), [])

    def test_broken_lines_are_skipped(self):
        entries = tool_call("Write", {"file_path": "/w/a.md", "content": "本文"})
        path = self.write("broken.jsonl", "壊れた行\n\n%s\n" % "\n".join(
            json.dumps(e, ensure_ascii=False) for e in entries))
        self.assertEqual([w[0] for w in review.turn_writes(path, "")], ["/w/a.md"])


class Hook(TempDir):
    def setUp(self):
        TempDir.setUp(self)
        self.calls = []
        self.doc_types = []
        self.addCleanup(setattr, review, "rewrite", review.rewrite)
        self.addCleanup(setattr, review, "CACHE_DIR", review.CACHE_DIR)
        review.CACHE_DIR = os.path.basename(self.dir) + "-cache"
        self.addCleanup(shutil.rmtree, os.path.dirname(review.cache_path("")), True)
        self.addCleanup(setattr, review, "DIFF_DIR", review.DIFF_DIR)
        review.DIFF_DIR = os.path.basename(self.dir) + "-diffs"
        self.addCleanup(shutil.rmtree,
                        os.path.join(tempfile.gettempdir(), review.DIFF_DIR), True)

    def sole_diff(self, message):
        """メッセージが指す置き場に書かれた、ただ一つの差分ファイル。"""
        found = re.search(r"差分: ([^）]+)）", message)
        self.assertIsNotNone(found, message)
        names = os.listdir(found.group(1))
        self.assertEqual(len(names), 1, names)
        return os.path.join(found.group(1), names[0])

    def stub(self, result, cause="nonzero_exit=1"):
        def fake(text, hits=None, mode="", deadline=None, doc_type=None):
            self.calls.append(text)
            self.doc_types.append(doc_type)
            body = result(text) if callable(result) else result
            return body, (None if body is not None else cause)
        review.rewrite = fake

    def run_hook(self, mode, payload):
        stdin, stdout = sys.stdin, sys.stdout
        sys.stdin = io.StringIO(json.dumps(payload))
        sys.stdout = io.StringIO()
        try:
            review.main(["--hook", mode])
            return sys.stdout.getvalue()
        finally:
            sys.stdin, sys.stdout = stdin, stdout


class MissingVocab(Hook):
    def test_skips_rewrite_and_notifies_when_plugin_vocab_is_missing(self):
        saved = review._VOCAB
        review._VOCAB = None
        try:
            out = self.run_hook("stop", {})
        finally:
            review._VOCAB = saved
        self.assertIn("ja-vocab-lint.py を読めない", json.loads(out)["systemMessage"])
        self.assertEqual(self.calls, [])


class Stop(Hook):
    def setUp(self):
        Hook.setUp(self)
        self.body = "この本文は書き直し役に渡される長さの日本語です。" * 20
        self.path = self.write("a.md", self.body)
        self.transcript_path = self.transcript([
            user_prompt(),
            tool_call("Write", {"file_path": self.path, "content": self.body}),
        ])

    def run_stop(self, **payload):
        payload.setdefault("transcript_path", self.transcript_path)
        payload.setdefault("cwd", self.dir)
        return self.run_hook("stop", payload)

    def hard_file(self):
        """単語表の閾値に当たる本文を、そのターンで書いた唯一のファイルにする。"""
        path = self.write("hard.md", self.body + "正本を更新した。")
        self.transcript_path = self.transcript(
            [user_prompt(), tool_call("Write", {"file_path": path, "content": "本文"})],
            name="hard.jsonl")
        return path

    def test_body_is_long_enough_to_be_rewritten(self):
        self.assertGreaterEqual(review.prose_japanese_length(self.body), review.MIN_JAPANESE)

    def test_txt_file_is_rewritten_like_markdown(self):
        path = self.write("note.txt", self.body)
        transcript = self.transcript([
            user_prompt(),
            tool_call("Write", {"file_path": path, "content": self.body}),
        ], name="txt.jsonl")
        self.stub("読みやすくした本文。")
        output = json.loads(self.run_stop(transcript_path=transcript))
        self.assertIn("1 ファイルを書き直した", output["systemMessage"])
        self.assertEqual(self.read(path), "読みやすくした本文。")

    def test_source_files_are_left_alone(self):
        path = self.write("mod.py", self.body)
        transcript = self.transcript([
            user_prompt(),
            tool_call("Write", {"file_path": path, "content": self.body}),
        ], name="py.jsonl")
        self.stub("読みやすくした本文。")
        self.assertEqual(self.run_stop(transcript_path=transcript), "")
        self.assertEqual(self.read(path), self.body)

    def test_ok_is_silent_and_not_asked_twice(self):
        self.stub("")
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(len(self.calls), 1)

    def test_rewrite_updates_the_file_and_points_at_the_diff(self):
        self.stub("読みやすくした本文。")
        output = json.loads(self.run_stop())
        self.assertIn("1 ファイルを書き直した", output["systemMessage"])
        self.assertEqual(self.read(self.path), "読みやすくした本文。")
        written = self.read(self.sole_diff(output["systemMessage"]))
        self.assertIn("+読みやすくした本文。", written)
        self.assertNotIn("+読みやすくした本文。", output["systemMessage"])

    def test_a_rewritten_file_is_not_handed_back_to_claude(self):
        self.stub("読みやすくした本文。")
        output = json.loads(self.run_stop())
        self.assertNotIn("decision", output)
        self.assertNotIn("reason", output)

    def test_rewritten_files_are_counted_together(self):
        second = self.write("b.md", self.body + "もう一つの文書。")
        self.transcript_path = self.transcript([
            user_prompt(),
            tool_call("Write", {"file_path": self.path, "content": "本文"}),
            tool_call("Write", {"file_path": second, "content": "本文"}),
        ], name="two-rewritten.jsonl")
        self.stub("読みやすくした本文。")
        output = json.loads(self.run_stop())
        self.assertIn("2 ファイルを書き直した", output["systemMessage"])
        self.assertNotIn("decision", output)

    def test_the_message_stays_short_for_a_long_diff(self):
        self.stub(lambda text: "".join("直した行（%d）\n" % i for i in range(4000)))
        output = json.loads(self.run_stop())
        self.assertLess(len(output["systemMessage"]), 400)
        self.assertIn("直した行（3999）", self.read(self.sole_diff(output["systemMessage"])))

    def test_the_rewritten_body_is_not_rewritten_again(self):
        long_body = "これは書き直した後の十分に長い日本語の本文です。" * 20
        self.stub(long_body)
        self.assertIn("書き直した", self.run_stop())
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(len(self.calls), 1)

    def test_only_the_written_body_is_remembered(self):
        long_body = "これは書き直した後の十分に長い日本語の本文です。" * 20
        self.stub(long_body)
        self.assertIn("書き直した", self.run_stop())
        self.assertTrue(review.cached(long_body))
        self.assertFalse(review.cached(self.body))

    def test_an_ok_response_remembers_the_original(self):
        self.stub("")
        self.assertEqual(self.run_stop(), "")
        self.assertTrue(review.cached(self.body))

    def test_a_file_changed_during_the_rewrite_is_not_overwritten(self):
        def racing(text):
            self.write("a.md", "他のプロセスが書いた本文\n")
            return "読みやすくした本文。"
        self.stub(racing)
        output = json.loads(self.run_stop())
        self.assertIn("書き直し中にファイルが変わったので更新しなかった", output["systemMessage"])
        self.assertNotIn("decision", output)
        self.assertEqual(self.read(self.path), "他のプロセスが書いた本文\n")
        self.assertFalse(review.cached(self.body))

    def test_files_past_the_deadline_are_listed_as_unprocessed(self):
        self.addCleanup(setattr, review, "DEADLINE", review.DEADLINE)
        review.DEADLINE = 0
        self.stub("読みやすくした本文。")
        output = json.loads(self.run_stop())
        self.assertIn("時間切れで未処理: %s" % self.path, output["systemMessage"])
        self.assertNotIn("decision", output)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.read(self.path), self.body)

    def test_failed_call_is_silent_and_not_cached(self):
        self.stub(None)
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(review.cached(self.body))

    def test_failed_call_falls_back_to_the_word_list(self):
        hard = self.hard_file()
        self.stub(None)
        output = json.loads(self.run_stop())
        self.assertEqual(output["decision"], "block")
        self.assertIn("正本 1 回", output["reason"])
        self.assertEqual(self.read(hard), self.body + "正本を更新した。")

    def test_unsafe_rewrite_is_reported_without_blocking(self):
        self.stub(None, "unsafe_rewrite")
        output = json.loads(self.run_stop())
        self.assertIn("1 ファイルは安全確認で書き直しを見送った", output["systemMessage"])
        self.assertIn(self.path, output["systemMessage"])
        self.assertNotIn("decision", output)
        self.assertEqual(self.read(self.path), self.body)

    def test_unsafe_rewrite_does_not_fall_back_to_the_word_list(self):
        self.hard_file()
        self.stub(None, "unsafe_rewrite")
        output = json.loads(self.run_stop())
        self.assertNotIn("decision", output)
        self.assertNotIn("正本", output["systemMessage"])

    def test_an_unsafe_rewrite_is_not_asked_again_in_the_same_conversation(self):
        # 11/28 の worker: 同じ README がターンの終わりのたびに unsafe_rewrite で約 4 分ずつ止めた
        self.stub(None, "unsafe_rewrite")
        self.assertIn("見送った", self.run_stop(session_id="s1"))
        self.assertEqual(self.run_stop(session_id="s1"), "")
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(review.cached(self.body))

    def test_a_changed_body_is_asked_again_after_an_unsafe_rewrite(self):
        self.stub(None, "unsafe_rewrite")
        self.run_stop(session_id="s1")
        self.write("a.md", self.body + "書き足した。")
        self.assertIn("見送った", self.run_stop(session_id="s1"))
        self.assertEqual(len(self.calls), 2)

    def test_another_conversation_is_asked_again_after_an_unsafe_rewrite(self):
        self.stub(None, "unsafe_rewrite")
        self.run_stop(session_id="s1")
        self.assertIn("見送った", self.run_stop(session_id="s2"))
        self.assertEqual(len(self.calls), 2)

    def test_another_path_with_the_same_body_is_asked_after_an_unsafe_rewrite(self):
        self.stub(None, "unsafe_rewrite")
        self.run_stop(session_id="s1")
        copy = self.write("copy.md", self.body)
        transcript = self.transcript(
            [user_prompt(), tool_call("Write", {"file_path": copy, "content": self.body})], name="copy.jsonl")
        self.assertIn("見送った", self.run_stop(session_id="s1", transcript_path=transcript))
        self.assertEqual(len(self.calls), 2)

    def test_an_unsafe_rewrite_without_a_conversation_is_asked_again(self):
        self.stub(None, "unsafe_rewrite")
        self.run_stop()
        self.run_stop()
        self.assertEqual(len(self.calls), 2)

    def test_a_timeout_is_asked_again(self):
        self.stub(None, "timeout")
        self.run_stop(session_id="s1")
        self.run_stop(session_id="s1")
        self.assertEqual(len(self.calls), 2)

    def test_a_block_and_a_rewrite_are_reported_together(self):
        short = self.write("short.md", "正本を更新した。")
        self.transcript_path = self.transcript([
            user_prompt(),
            tool_call("Write", {"file_path": self.path, "content": "本文"}),
            tool_call("Write", {"file_path": short, "content": "正本"}),
        ], name="mixed.jsonl")
        self.stub("読みやすくした本文。")
        output = json.loads(self.run_stop())
        self.assertIn("1 ファイルを書き直した", output["systemMessage"])
        self.assertEqual(output["decision"], "block")
        self.assertIn("正本 1 回", output["reason"])

    def test_stop_hook_active_is_silent(self):
        self.stub("読みやすくした本文。")
        self.assertEqual(self.run_stop(stop_hook_active=True), "")
        self.assertEqual(self.calls, [])

    def test_each_file_is_rewritten_on_its_own(self):
        self.write("a.md", self.body + "断片。\n別の断片。\n")
        second = self.write("b.md", self.body + "もう一つの文書。")
        self.transcript_path = self.transcript([
            user_prompt(),
            tool_call("Edit", {"file_path": self.path, "new_string": "断片"}),
            tool_call("Edit", {"file_path": self.path, "new_string": "別の断片"}),
            tool_call("Write", {"file_path": second, "content": "本文"}),
        ], name="two.jsonl")
        self.stub("")
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(len(self.calls), 2)
        self.assertIn("もう一つの文書。", self.calls[1])

    def test_code_only_turn_is_not_rewritten(self):
        code = self.write("a.py", "# %s\n" % self.body)
        self.transcript_path = self.transcript(
            [user_prompt(), tool_call("Write", {"file_path": code, "content": "本文"})],
            name="code.jsonl")
        self.stub("読みやすくした本文。")
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(self.calls, [])

    def test_disk_content_is_rewritten_not_the_recorded_content(self):
        self.transcript_path = self.transcript([
            user_prompt(),
            tool_call("Write", {"file_path": self.path, "content": "古い本文"}),
        ], name="stale.jsonl")
        self.stub("")
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(self.calls, [self.body])

    def test_short_file_with_hard_words_blocks_without_a_rewrite(self):
        short = self.write("short.md", "正本を更新した。")
        self.transcript_path = self.transcript(
            [user_prompt(), tool_call("Write", {"file_path": short, "content": "正本"})],
            name="short.jsonl")
        self.stub("読みやすくした本文。")
        output = json.loads(self.run_stop())
        self.assertEqual(output["decision"], "block")
        self.assertIn("正本 1 回", output["reason"])
        self.assertIn(short, output["reason"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.read(short), "正本を更新した。")

    def test_short_plain_file_is_silent(self):
        short = self.write("plain.md", "元のファイルを更新した。")
        self.transcript_path = self.transcript(
            [user_prompt(), tool_call("Write", {"file_path": short, "content": "本文"})],
            name="plain.jsonl")
        self.stub("読みやすくした本文。")
        self.assertEqual(self.run_stop(), "")
        self.assertEqual(self.calls, [])

    def test_crlf_file_keeps_its_newlines(self):
        crlf = self.write("crlf.md", self.body.replace("。", "。\r\n"))
        self.transcript_path = self.transcript(
            [user_prompt(), tool_call("Write", {"file_path": crlf, "content": "本文"})],
            name="crlf.jsonl")
        self.stub("一行目の本文\n二行目の本文\n")
        self.assertIn("書き直した", self.run_stop())
        self.assertEqual(self.read(crlf), "一行目の本文\r\n二行目の本文\r\n")


class Confine(unittest.TestCase):
    """書き直しのうち、変えた行の中に収まるものだけを採る。"""

    ORIGINAL = "一行目\n二行目\n三行目\n四行目\n"

    def test_only_rewrites_on_the_given_lines_are_taken(self):
        body, taken = review.confine(self.ORIGINAL, "1行目\n2行目\n3行目\n4行目\n", {2})
        self.assertEqual(body, "一行目\n2行目\n三行目\n四行目\n")
        self.assertEqual(taken, {2})

    def test_a_merge_across_an_unchanged_line_is_dropped(self):
        body, taken = review.confine(self.ORIGINAL, "一行目\n二行目と三行目\n四行目\n", {2})
        self.assertEqual(body, self.ORIGINAL)
        self.assertEqual(taken, set())

    def test_a_merge_inside_the_changed_lines_is_taken(self):
        body, taken = review.confine(self.ORIGINAL, "一行目\n二行目と三行目\n四行目\n", {2, 3})
        self.assertEqual(body, "一行目\n二行目と三行目\n四行目\n")
        self.assertEqual(taken, {2})

    def test_untouched_lines_keep_their_newlines_and_trailing_blank_lines(self):
        body, taken = review.confine("一行目\r\n二行目\n末尾\n\n", "一行目\n2行目\n末尾\n", {2})
        self.assertEqual(body, "一行目\r\n2行目\n末尾\n\n")
        self.assertEqual(taken, {2})
        body, _ = review.confine("一行目\n二行目", "一行目\n二行目\n足した行\n", {2})
        self.assertEqual(body, "一行目\n二行目\n足した行")

    def test_an_insertion_next_to_a_changed_line_is_taken(self):
        body, _ = review.confine(self.ORIGINAL, "一行目\n二行目\n足した行\n三行目\n四行目\n", {2})
        self.assertEqual(body, "一行目\n二行目\n足した行\n三行目\n四行目\n")
        body, _ = review.confine(self.ORIGINAL, "足した行\n一行目\n二行目\n三行目\n四行目\n", {4})
        self.assertEqual(body, self.ORIGINAL)


class ChangedLines(TempDir):
    def test_lines_since_the_original_exclude_edit_context(self):
        before = "既存の 3 件\n旧文\n残り 4 件\n"
        text = "既存の 3 件\n新文\n残り 4 件\n"
        edit = {"file_path": "a.md", "old_string": before, "new_string": text}
        self.assertEqual(review.changed_lines([(edit, before)], text, "a.md", self.dir), {2})

    def test_a_new_file_from_the_original_is_every_line(self):
        self.assertEqual(review.changed_lines([({"content": "一\n二\n"}, "")], "一\n二\n", "a.md", ""), {1, 2})

    def test_original_of_reads_edit_and_create_results(self):
        self.assertEqual(review.original_of({"filePath": "a", "originalFile": "前"}), "前")
        self.assertEqual(review.original_of({"type": "create", "filePath": "a", "originalFile": None}), "")
        self.assertIsNone(review.original_of({"filePath": "a", "originalFile": "前", "staged": True}))
        self.assertIsNone(review.original_of({"filePath": "a", "success": True}))
        self.assertIsNone(review.original_of(None))

    def test_a_fragment_ending_in_a_newline_does_not_take_the_next_line(self):
        text = "一\n新しい行\n三\n"
        edit = {"file_path": "a.md", "old_string": "x", "new_string": "新しい行\n"}
        self.assertEqual(review.changed_lines([(edit, None)], text, "a.md", self.dir), {2})

    def test_an_edit_next_to_an_identical_line_is_placed_by_its_position(self):
        edit = {"file_path": "a.md", "old_string": "旧文", "new_string": "3 件"}
        self.assertEqual(review.changed_lines([(edit, "旧文\n3 件")], "3 件\n3 件", "a.md", self.dir), {1})

    def test_earlier_lines_are_carried_past_later_edits(self):
        first = {"file_path": "a.md", "old_string": "三", "new_string": "3 件"}
        second = {"file_path": "a.md", "old_string": "一", "new_string": "足した行\n一"}
        writes = [(first, "一\n二\n三\n"), (second, "一\n二\n3 件\n")]
        self.assertEqual(review.changed_lines(writes, "足した行\n一\n二\n3 件\n", "a.md", self.dir), {1, 4})

    def test_a_fragment_overwritten_later_in_the_turn_is_ignored(self):
        text = "一\n公開予定\n三\n"
        edits = [{"file_path": "a.md", "old_string": "草案", "new_string": "確認中"},
                 {"file_path": "a.md", "old_string": "確認中", "new_string": "公開予定"}]
        self.assertEqual(review.changed_lines([(e, None) for e in edits], text, "a.md", self.dir), {2})


def git(directory, *args):
    subprocess.run(["git", "-C", directory, "-c", "user.name=t", "-c", "user.email=t@example.com",
                    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"] + list(args),
                   check=True, capture_output=True)


class GitChangedLines(TempDir):
    def setUp(self):
        TempDir.setUp(self)
        git(self.dir, "init", "-q")
        self.path = self.write("doc.md", "一\n二\n三\n四\n")
        git(self.dir, "add", "doc.md")
        git(self.dir, "commit", "-qm", "init")

    def test_lines_changed_since_head(self):
        self.write("doc.md", "一\n2\n三\n四\n五\n")
        self.assertEqual(review.git_changed_lines(self.path), {2, 5})

    def test_an_unchanged_file_has_no_lines(self):
        self.assertEqual(review.git_changed_lines(self.path), set())

    def test_a_failed_tree_lookup_changes_no_lines(self):
        real = subprocess.run

        def broken(args, **kwargs):
            if "ls-tree" in args:
                return subprocess.CompletedProcess(args, 128, b"", b"fatal: bad tree")
            return real(args, **kwargs)
        with mock.patch.object(review.subprocess, "run", broken):
            self.assertEqual(review.git_changed_lines(self.path), set())

    def test_a_git_failure_changes_no_lines(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("git", 5)
        with mock.patch.object(review.subprocess, "run", timeout):
            self.assertEqual(review.git_changed_lines(self.path), set())

    def test_untracked_and_outside_git_are_none(self):
        self.assertIsNone(review.git_changed_lines(self.write("new.md", "一\n")))
        outside = tempfile.mkdtemp(prefix="ja-review-nogit-")
        self.addCleanup(shutil.rmtree, outside, True)
        path = os.path.join(outside, "a.md")
        with io.open(path, "w", encoding="utf-8") as fh:
            fh.write("一\n")
        self.assertIsNone(review.git_changed_lines(path))


class StopKeepsUntouchedLines(Hook):
    """Stop の書き直しが、そのターンで変えていない行を書き換えない（11/21 の README・tooling.md）。"""

    LINE = "この行は書き直し役に渡される長さの日本語の本文で、前から変わっていない。"

    def setUp(self):
        Hook.setUp(self)
        self.lines = [self.LINE + str(i) for i in range(12)]
        self.before = "\n".join(self.lines) + "\n"

    def every_line_rewritten(self, text):
        return text.replace("本文で、", "本文であり、")

    def run_stop(self, tool_input):
        transcript = self.transcript([user_prompt(), tool_call(tool_input.pop("tool"), tool_input)])
        self.stub(self.every_line_rewritten)
        return self.run_hook("stop", {"transcript_path": transcript, "cwd": self.dir})

    def test_a_whole_file_write_is_confined_to_the_git_diff(self):
        git(self.dir, "init", "-q")
        path = self.write("README.md", self.before)
        git(self.dir, "add", "README.md")
        git(self.dir, "commit", "-qm", "init")
        lines = list(self.lines)
        lines[5] = "書き足した行は 3 件の本文で、新しい。" + lines[5]
        after = "\n".join(lines) + "\n"
        self.write("README.md", after)
        self.assertIn("書き直した", self.run_stop({"tool": "Write", "file_path": path, "content": after}))
        expected = list(lines)
        expected[5] = self.every_line_rewritten(lines[5]).replace("は 3 件", "は3件")
        self.assertEqual(self.read(path), "\n".join(expected) + "\n")

    def test_an_edit_is_confined_to_its_fragment(self):
        lines = list(self.lines)
        lines[3] = "直した行の本文で、新しい。"
        path = self.write("tooling.md", "\n".join(lines) + "\n")
        self.assertIn("書き直した", self.run_stop(
            {"tool": "Edit", "file_path": path, "old_string": "x", "new_string": lines[3]}))
        expected = list(lines)
        expected[3] = "直した行の本文であり、新しい。"
        self.assertEqual(self.read(path), "\n".join(expected) + "\n")

    def test_the_original_in_the_transcript_limits_lines_to_this_turn(self):
        git(self.dir, "init", "-q")
        path = self.write("README.md", self.before)
        git(self.dir, "add", "README.md")
        git(self.dir, "commit", "-qm", "init")
        lines = list(self.lines)
        lines[1] = "前のターンに足した行は本文で、未commit。"
        start = "\n".join(lines) + "\n"
        lines[8] = "草案の本文で、新しい。"
        middle = "\n".join(lines) + "\n"
        lines[8] = "公開予定の本文で、新しい。"
        after = "\n".join(lines) + "\n"
        self.write("README.md", after)
        transcript = self.transcript([
            user_prompt(),
            tool_call("Edit", {"file_path": path, "old_string": self.lines[8], "new_string": "草案の本文で、新しい。"},
                      result_data={"filePath": path, "originalFile": start}),
            tool_call("Edit", {"file_path": path, "old_string": "草案", "new_string": "公開予定"},
                      result_data={"filePath": path, "originalFile": middle}),
        ])
        self.stub(self.every_line_rewritten)
        self.assertIn("書き直した", self.run_hook("stop", {"transcript_path": transcript, "cwd": self.dir}))
        expected = list(lines)
        expected[8] = "公開予定の本文であり、新しい。"
        self.assertEqual(self.read(path), "\n".join(expected) + "\n")

    def test_a_staged_write_is_not_collected(self):
        path = self.write("a.md", self.before)
        transcript = self.transcript([user_prompt(), tool_call(
            "Edit", {"file_path": path, "old_string": "x", "new_string": self.lines[2]},
            result_data={"filePath": path, "originalFile": "", "staged": True})])
        self.assertEqual(review.turn_writes(transcript, self.dir), [])

    def test_an_edit_tightened_by_post_is_still_placed_outside_git(self):
        lines = list(self.lines)
        lines[3] = "直した行は3件の本文で、新しい。"
        path = self.write("tooling.md", "\n".join(lines) + "\n")
        self.assertIn("書き直した", self.run_stop(
            {"tool": "Edit", "file_path": path, "old_string": "x", "new_string": "直した行は 3 件の本文で、新しい。"}))
        expected = list(lines)
        expected[3] = "直した行は3件の本文であり、新しい。"
        self.assertEqual(self.read(path), "\n".join(expected) + "\n")

    def test_an_unsafe_confined_rewrite_is_not_asked_again_in_the_same_conversation(self):
        lines = list(self.lines)
        lines[3] = "直した行の本文で、新しい。"
        path = self.write("tooling.md", "\n".join(lines) + "\n")
        transcript = self.transcript([user_prompt(), tool_call(
            "Edit", {"file_path": path, "old_string": "x", "new_string": lines[3]})])
        self.stub(self.every_line_rewritten)
        self.addCleanup(setattr, review, "safe", review.safe)
        review.safe = lambda original, rewritten: False
        payload = {"transcript_path": transcript, "cwd": self.dir, "session_id": "s1"}
        self.assertIn("見送った", self.run_hook("stop", payload))
        self.assertEqual(self.run_hook("stop", payload), "")
        self.assertEqual(len(self.calls), 1)

    def test_a_tracked_file_without_changes_is_not_sent(self):
        git(self.dir, "init", "-q")
        path = self.write("README.md", self.before)
        git(self.dir, "add", "README.md")
        git(self.dir, "commit", "-qm", "init")
        self.assertEqual(self.run_stop({"tool": "Write", "file_path": path, "content": self.before}), "")
        self.assertEqual(self.calls, [])


class StopFromAgy(Hook):
    """agy-hook.py が transcript の代わりに渡す turn_writes（Claude の形の入力の一覧）から、書いたファイルを見つける（H3）。"""

    LINE = StopKeepsUntouchedLines.LINE
    setUp = StopKeepsUntouchedLines.setUp
    every_line_rewritten = StopKeepsUntouchedLines.every_line_rewritten

    def run_given(self, writes, transcript=""):
        self.stub(self.every_line_rewritten)
        return self.run_hook("stop", {"turn_writes": writes, "transcript_path": transcript, "cwd": self.dir})

    def test_a_write_in_turn_writes_is_rewritten_without_a_claude_transcript(self):
        path = self.write("note.md", self.before)
        agy_log = self.write("transcript_full.jsonl", json.dumps({"step_index": 0, "type": "USER_INPUT"}) + "\n")
        self.assertIn("1 ファイルを書き直した", self.run_given(
            [{"tool_input": {"file_path": path, "content": self.before}, "original": None}], agy_log))
        self.assertEqual(self.read(path), self.every_line_rewritten(self.before))

    def test_an_edit_in_turn_writes_is_confined_to_its_fragment(self):
        lines = list(self.lines)
        lines[3] = "直した行の本文で、新しい。"
        path = self.write("tooling.md", "\n".join(lines) + "\n")
        self.assertIn("書き直した", self.run_given(
            [{"tool_input": {"file_path": path, "old_string": self.LINE + "3", "new_string": lines[3]}, "original": None}]))
        expected = list(lines)
        expected[3] = "直した行の本文であり、新しい。"
        self.assertEqual(self.read(path), "\n".join(expected) + "\n")

    def test_the_original_keeps_lines_the_user_changed_before_the_turn(self):
        git(self.dir, "init", "-q")
        path = self.write("README.md", self.before)
        git(self.dir, "add", "README.md")
        git(self.dir, "commit", "-qm", "init")
        lines = list(self.lines)
        lines[1] = "利用者が先に直した行は本文で、未commit。"
        start = "\n".join(lines) + "\n"
        lines[8] = "agy が書いた行の本文で、新しい。"
        after = "\n".join(lines) + "\n"
        self.write("README.md", after)
        self.assertIn("書き直した", self.run_given([{"tool_input": {"file_path": path, "content": after}, "original": start}]))
        expected = list(lines)
        expected[8] = "agyが書いた行の本文であり、新しい。"  # 採った行は ja_spacing で詰め直す
        self.assertEqual(self.read(path), "\n".join(expected) + "\n")

    def test_an_empty_list_wins_over_the_transcript(self):
        path = self.write("a.md", self.before)
        transcript = self.transcript([user_prompt(), tool_call("Write", {"file_path": path, "content": self.before})])
        self.assertEqual(self.run_given([], transcript), "")
        self.assertEqual(self.calls, [])


class Pre(Hook):
    def setUp(self):
        Hook.setUp(self)
        self.body = "この本文は書き直し役に渡される長さの日本語です。" * 5
        self.assertGreaterEqual(review.prose_japanese_length(self.body), review.PRE_MIN_JAPANESE)

    def run_pre(self, command, **tool_input):
        tool_input.setdefault("command", command)
        output = self.run_hook("pre", {"hook_event_name": "PreToolUse",
                                       "tool_input": tool_input, "cwd": self.dir})
        return json.loads(output)["hookSpecificOutput"] if output.strip() else None

    def test_inline_body_is_replaced_through_updated_input(self):
        self.stub("読みやすくした本文。")
        out = self.run_pre("gh issue create --repo o/r --title t --body '%s'" % self.body,
                           description="issue を作る")
        self.assertEqual(out["permissionDecision"], "allow")
        self.assertIn("読みやすくした本文。", out["updatedInput"]["command"])
        self.assertNotIn(self.body, out["updatedInput"]["command"])
        self.assertEqual(out["updatedInput"]["description"], "issue を作る")
        self.assertIn("差分", out["additionalContext"])

    def test_body_file_is_overwritten_and_reported(self):
        path = self.write("body.md", self.body)
        self.stub("読みやすくした本文。")
        out = self.run_pre("gh pr create -F %s" % path)
        self.assertEqual(out["permissionDecision"], "allow")
        self.assertNotIn("updatedInput", out)
        self.assertIn(path, out["additionalContext"])
        self.assertEqual(self.read(path), "読みやすくした本文。")

    def test_compound_command_is_denied_with_the_rewritten_body(self):
        self.stub("読みやすくした本文。")
        out = self.run_pre("git status && gh issue create --body '%s'" % self.body)
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("読みやすくした本文。", out["permissionDecisionReason"])

    def test_variable_expansion_is_denied_instead_of_rebuilt(self):
        self.stub("読みやすくした本文。")
        out = self.run_pre("gh issue create --assignee $USER --body '%s'" % self.body)
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("読みやすくした本文。", out["permissionDecisionReason"])

    def test_redirection_is_denied_instead_of_rebuilt(self):
        self.stub("読みやすくした本文。")
        out = self.run_pre("gh issue create --body '%s' > out.txt" % self.body)
        self.assertEqual(out["permissionDecision"], "deny")

    def test_env_prefix_is_denied_instead_of_rebuilt(self):
        self.stub("読みやすくした本文。")
        out = self.run_pre("env GH_TOKEN=x gh issue create --body '%s'" % self.body)
        self.assertEqual(out["permissionDecision"], "deny")

    def test_assignment_prefix_is_denied_instead_of_rebuilt(self):
        self.stub("読みやすくした本文。")
        out = self.run_pre("GH_TOKEN=x gh issue create --body '%s'" % self.body)
        self.assertEqual(out["permissionDecision"], "deny")

    def test_body_file_changed_during_the_rewrite_is_not_overwritten(self):
        path = self.write("body.md", self.body)

        def racing(text):
            self.write("body.md", "他のプロセスが書いた本文\n")
            return "読みやすくした本文。"
        self.stub(racing)
        out = self.run_pre("gh pr create -F %s" % path)
        self.assertIn("書き直し中にファイルが変わったので更新しなかった", out["additionalContext"])
        self.assertEqual(self.read(path), "他のプロセスが書いた本文\n")

    def test_bodies_past_the_deadline_are_reported_without_a_decision(self):
        self.addCleanup(setattr, review, "DEADLINE", review.DEADLINE)
        review.DEADLINE = 0
        self.stub("読みやすくした本文。")
        output = self.run_hook("pre", {"hook_event_name": "PreToolUse", "cwd": self.dir,
                                       "tool_input": {"command": "gh issue create --body '%s'"
                                                                 % self.body}})
        self.assertIn("時間切れで未処理", json.loads(output)["systemMessage"])
        self.assertEqual(self.calls, [])

    def test_ok_body_passes_silently(self):
        self.stub("")
        self.assertIsNone(self.run_pre("gh issue create --body '%s'" % self.body))

    def test_failed_call_passes_silently(self):
        self.stub(None)
        self.assertIsNone(self.run_pre("gh issue create --body '%s'" % self.body))

    def test_failed_call_falls_back_to_the_word_list(self):
        self.stub(None)
        out = self.run_pre("gh issue create --body '%s正本を更新した。'" % self.body)
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("正本 1 回", out["permissionDecisionReason"])

    def test_short_body_with_hard_words_is_denied(self):
        self.stub("読みやすくした本文。")
        out = self.run_pre("gh issue create --body '正本を更新した。'")
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("正本 1 回", out["permissionDecisionReason"])
        self.assertEqual(self.calls, [])

    def test_short_plain_body_passes(self):
        self.stub("読みやすくした本文。")
        self.assertIsNone(self.run_pre("gh issue create --body '元のファイルを更新した。'"))
        self.assertEqual(self.calls, [])

    def test_title_is_not_sent_to_the_rewriter(self):
        self.stub("")
        self.run_pre("gh issue create --title '%s' --body '%s'" % (self.body, self.body))
        self.assertEqual(self.calls, [self.body])

    def test_heredoc_command_passes_untouched(self):
        self.stub("読みやすくした本文。")
        self.assertIsNone(self.run_pre("gh pr create --body-file - <<EOF\n%s\nEOF" % self.body))
        self.assertEqual(self.calls, [])


class Skip(unittest.TestCase):
    def run_hook(self, mode, payload):
        stdin, stdout = sys.stdin, sys.stdout
        sys.stdin = io.StringIO(json.dumps(payload))
        sys.stdout = io.StringIO()
        try:
            review.main(["--hook", mode])
            return sys.stdout.getvalue()
        finally:
            sys.stdin, sys.stdout = stdin, stdout

    def test_skip_env_silences_the_hook(self):
        os.environ["JA_REVIEW_SKIP"] = "1"
        try:
            self.assertEqual(self.run_hook("pre", {"tool_input": {"command": 'gh pr create --body "本文"'}}), "")
        finally:
            del os.environ["JA_REVIEW_SKIP"]

    def test_rewriter_session_env_silences_the_hook(self):
        os.environ["JA_REVIEW_ACTIVE"] = "1"
        try:
            self.assertEqual(self.run_hook("pre", {"tool_input": {"command": 'gh pr create --body "本文"'}}), "")
        finally:
            del os.environ["JA_REVIEW_ACTIVE"]


class AgyOutput(unittest.TestCase):
    """stream-json の最後の result 行だけを見る。"""

    def envelope(self, response, status="SUCCESS"):
        init = json.dumps({"event": "init", "init": {"model": review.CLI_MODEL}})
        step = json.dumps({"event": "step_update", "step_update": {"text_delta": "考え中"}})
        result = json.dumps({"event": "result", "result": {
            "conversation_id": "x", "status": status, "response": response,
            "duration_seconds": 1.0, "num_turns": 1, "usage": {}}})
        return "\n".join([init, step, result]) + "\n"

    def test_response_is_extracted(self):
        self.assertEqual(review.parse_agy(0, self.envelope("読みやすくした本文")), "読みやすくした本文")

    def test_failed_status_yields_nothing(self):
        self.assertIsNone(review.parse_agy(0, self.envelope("OK", status="ERROR")))

    def test_missing_response_yields_nothing(self):
        self.assertIsNone(review.parse_agy(0, json.dumps(
            {"event": "result", "result": {"status": "SUCCESS"}})))

    def test_missing_result_event_yields_nothing(self):
        self.assertIsNone(review.parse_agy(0, json.dumps({"event": "init", "init": {}})))

    def test_broken_json_yields_nothing(self):
        self.assertIsNone(review.parse_agy(0, "agy: could not authenticate"))

    def test_noise_before_the_result_line_is_ignored(self):
        self.assertEqual(review.parse_agy(0, "warning: ignoring x\n" + self.envelope("OK")), "OK")

    def test_nonzero_exit_yields_nothing(self):
        self.assertIsNone(review.parse_agy(1, self.envelope("OK")))


class AgyCall(unittest.TestCase):
    class Completed(object):
        def __init__(self, returncode, stdout, stderr=""):
            self.returncode = returncode
            self.stdout = stdout
            self.stderr = stderr

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
        self.addCleanup(setattr, review.agy_launch, "subprocess", review.agy_launch.subprocess)
        review.agy_launch.subprocess = shim

    def envelope(self, response):
        return json.dumps({"event": "result",
                           "result": {"status": "SUCCESS", "response": response}})

    def test_response_is_returned(self):
        self.stub(self.Completed(0, self.envelope("読みやすくした本文")))
        self.assertEqual(review.call_agy("プロンプト"), ("読みやすくした本文", None))

    def test_missing_agy_is_named_as_the_cause(self):
        self.stub(OSError("no such file"))
        self.assertEqual(review.call_agy("プロンプト"), (None, "agy_missing"))

    def test_timeout_is_named_as_the_cause(self):
        self.stub(subprocess.TimeoutExpired("agy", 150))
        self.assertEqual(review.call_agy("プロンプト"), (None, "timeout"))

    def test_nonzero_exit_carries_the_stderr_tail(self):
        self.stub(self.Completed(1, "", "quota exceeded\n"))
        response, problem = review.call_agy("プロンプト")
        self.assertIsNone(response)
        self.assertIn("nonzero_exit=1", problem)
        self.assertIn("quota exceeded", problem)

    def test_unusable_output_is_named_as_the_cause(self):
        self.stub(self.Completed(0, "agy: could not authenticate", "auth failed"))
        response, problem = review.call_agy("プロンプト")
        self.assertIsNone(response)
        self.assertIn("bad_output", problem)

    def test_body_goes_over_stdin_not_argv(self):
        self.stub(self.Completed(0, self.envelope("OK")))
        review.call_agy("本文の目印カワセミ")
        command, kwargs, _ = self.commands[0]
        self.assertEqual(command[0], "agy")
        self.assertIn(review.CLI_MODEL, command)
        self.assertNotIn("-p", command)
        self.assertNotIn("カワセミ", " ".join(command))
        message = json.loads(kwargs["input"].strip())
        self.assertEqual(message["event"], "user")
        self.assertIn("カワセミ", message["message"]["content"][0]["text"])

    def test_runs_in_an_empty_throwaway_cwd_and_marks_the_session(self):
        self.stub(self.Completed(0, self.envelope("OK")))
        review.call_agy("一つ目")
        review.call_agy("二つ目")
        first, second = self.commands
        self.assertEqual((first[2], second[2]), ([], []))
        self.assertEqual(first[1]["env"]["JA_REVIEW_ACTIVE"], "1")
        self.assertNotEqual(first[1]["cwd"], second[1]["cwd"])
        self.assertFalse(os.path.exists(first[1]["cwd"]))

    def test_the_deadline_shortens_the_subprocess_timeout(self):
        self.stub(self.Completed(0, self.envelope("OK")))
        review.call_agy("プロンプト", time.monotonic() + 30)
        self.assertLessEqual(self.commands[0][1]["timeout"], 30)

    def test_without_a_deadline_the_full_timeout_is_used(self):
        self.stub(self.Completed(0, self.envelope("OK")))
        review.call_agy("プロンプト")
        self.assertEqual(self.commands[0][1]["timeout"], review.REWRITE_TIMEOUT)


# hook の timeout は持ち主の環境の settings が持つので、入れた先のものを確かめる
INSTALLED_SETTINGS = os.path.expanduser("~/.claude/settings.json")


class Timeouts(unittest.TestCase):
    def hook_timeouts(self):
        if not os.path.exists(INSTALLED_SETTINGS):
            self.skipTest("入れた先の settings（%s）が無い" % INSTALLED_SETTINGS)
        with io.open(INSTALLED_SETTINGS, encoding="utf-8") as fh:
            settings = json.load(fh)
        found = []
        for event in ("PreToolUse", "Stop"):
            for group in settings["hooks"][event]:
                for hook in group.get("hooks", []):
                    if "ja-review.sh" in hook.get("command", ""):
                        found.append(hook.get("timeout"))
        return found

    def test_rewriter_gives_up_before_the_hook_does(self):
        timeouts = self.hook_timeouts()
        self.assertEqual(len(timeouts), 2)
        for timeout in timeouts:
            self.assertLess(review.REWRITE_TIMEOUT, timeout)

    def test_the_whole_hook_finishes_before_its_timeout(self):
        for timeout in self.hook_timeouts():
            self.assertLess(review.DEADLINE, timeout)

    def test_a_file_needs_a_usable_slice_of_the_deadline(self):
        self.assertLess(review.MIN_SLICE, review.DEADLINE)


class InstructionFiles(unittest.TestCase):
    def test_agent_instruction_files_are_skipped(self):
        for path in ("/r/CLAUDE.md", "/r/CLAUDE.local.md", "/r/sub/AGENTS.md", "/r/.claude/skills/x/SKILL.md",
                     "/r/agents/common.md", "/r/claude/skills/dev-stack/SKILL.md",
                     "/r/.codex/AGENTS.md", "/r/codex/reminder.md"):
            self.assertTrue(review.is_instruction_file(path), path)

    def test_scratchpad_and_briefs_are_skipped(self):
        for path in ("/tmp/session/scratchpad/plan.md", "/r/brief-timeline.md",
                     "/r/docs/brief.md"):
            self.assertTrue(review.is_instruction_file(path), path)

    def test_contract_clauses_are_skipped(self):
        for path in ("/r/contracts/templates/07-member-itaku.md", "/r/contracts/MED-X-001/kihon.md"):
            self.assertTrue(review.is_instruction_file(path), path)

    def test_human_documents_are_kept(self):
        for path in ("/r/docs/proposal.md", "/r/README.md", "/r/notes/議事録.md",
                     "/r/site/index.html", "/r/memo.txt", "/r/briefing-notes.md"):
            self.assertFalse(review.is_instruction_file(path), path)


yomiyasu = review.ja_yomiyasu


class YomiyasuRules(TempDir):
    """yomiyasu の SKILL.md の見出しが変わったら、ここで落ちて気づく（nix flake update yomiyasu の後に流す）。"""

    def test_principles_drop_the_structural_sections(self):
        text = yomiyasu.principles()
        self.assertIn("### 最優先ルール: 意味の保持", text)
        self.assertIn("### 直訳語、漢語の詰まり、連用形名詞", text)
        for heading in yomiyasu.STRUCTURAL_SECTIONS:
            self.assertNotIn(heading, text)
        self.assertNotIn(yomiyasu.LEAD_IN, text)
        self.assertNotIn("## 2. 実行手順", text)

    def test_doc_types_and_persona_are_readable(self):
        block = yomiyasu.gemini_block("proposal", client=True)
        self.assertIn("文書の種類 proposal", block)
        self.assertIn("書き手と読み手", block)
        for kind in yomiyasu.DOC_TYPES:
            self.assertIn(kind, yomiyasu.gemini_block(kind))

    def fake_root(self, skill):
        self.write("skills/yomiyasu/SKILL.md", skill)
        patcher = mock.patch.dict(os.environ, {"JA_YOMIYASU_DIR": self.dir})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_missing_structural_heading_is_reported(self):
        self.fake_root("## 1. 基本原則\n### 最優先ルール: 意味の保持\n本文\n## 2. 実行手順\n")
        with self.assertRaises(yomiyasu.Unavailable):
            yomiyasu.principles()

    def test_missing_install_is_reported_and_tools_are_skipped(self):
        with mock.patch.dict(os.environ, {"JA_YOMIYASU_DIR": self.dir}):
            with self.assertRaises(yomiyasu.Unavailable):
                yomiyasu.gemini_block()
            self.assertIsNone(yomiyasu.lint("本文です。"))
            self.assertIsNone(yomiyasu.meaning_risks("本文です。", "本文だ。"))


class YomiyasuDocType(unittest.TestCase):
    def test_marker_wins_over_the_file_name(self):
        self.assertEqual(yomiyasu.detect_doc_type("---\ntitle: x\ndoc-type: formal\n---\n本文", "提案.md"), "formal")

    def test_html_meta_and_comment(self):
        self.assertEqual(yomiyasu.detect_doc_type('<meta name="doc-type" content="manual">'), "manual")
        self.assertEqual(yomiyasu.detect_doc_type("<!-- doc-type: mail -->\n本文"), "mail")

    def test_file_name(self):
        self.assertEqual(yomiyasu.detect_doc_type("本文", "/p/docs/議事録_1111.md"), "minutes")
        self.assertEqual(yomiyasu.detect_doc_type("本文", "/p/proposal-v2.md"), "proposal")

    def test_unknown_type_and_no_clue_decide_nothing(self):
        self.assertIsNone(yomiyasu.detect_doc_type("<!-- doc-type: memo -->\n本文", "提案.md"))
        self.assertIsNone(yomiyasu.detect_doc_type("本文", "/p/notes.md"))


class YomiyasuTools(unittest.TestCase):
    def test_html_text_keeps_line_numbers_and_drops_code(self):
        prose = yomiyasu.html_text('<p>一行目\n<b\nclass="x">三行目</b></p>\n<script>\nvar a = "日本語";\n</script>\n<p>六行目</p>')
        lines = prose.split("\n")
        self.assertIn("一行目", lines[0])
        self.assertIn("三行目", lines[2])
        self.assertIn("六行目", lines[6])
        self.assertNotIn("日本語", prose)

    def test_lint_skips_list_ratio_and_label_colons(self):
        text = "".join("- **項目%d**: 説明です。\n" % i for i in range(8)) + "完了しました🎉\n"
        rules = set(f["rule"] for f in yomiyasu.lint(text))
        self.assertIn("emoji_prohibited", rules)
        self.assertFalse(rules & yomiyasu.LINT_SKIP)

    def test_lost_permission_is_a_risk(self):
        self.assertEqual(yomiyasu.meaning_risks("stg で起動してよいか、明日までに確かめます。\n",
                                                "stg で起動して問題ないか、明日までに確かめます。\n"),
                         ["modality"])

    def test_added_number_is_a_risk(self):
        self.assertIn("number", yomiyasu.meaning_risks("同期は 19 ジョブだった。\n",
                                                       "直近 21 日の同期は 19 ジョブだった。\n"))

    def test_added_actor_inside_html_is_a_risk(self):
        page = "<html><body><p>明日までに確認します。</p></body></html>\n"
        self.assertIn("added_actors", yomiyasu.meaning_risks(
            page, page.replace("明日まで", "担当者が明日まで")))

    def test_kana_spelling_of_a_negation_is_not_a_risk(self):
        self.assertEqual(yomiyasu.meaning_risks("指定の無い起動は、今と同じ文字列になります。\n",
                                                "指定のない起動は、現在と同じ文字列になります。\n"), [])


class MeaningRisk(Isolated):
    stub = RewriteOutput.stub

    def test_rewrite_that_drops_a_permission_is_not_adopted(self):
        self.stub("stg で起動して問題ないか、明日までに確かめます。")
        self.assertEqual(review.rewrite("stg で起動してよいか、明日までに確かめます。"),
                         (None, "unsafe_rewrite"))
        with open(os.path.join(tempfile.gettempdir(), review.FAILURE_LOG), encoding="utf-8") as fh:
            self.assertIn("meaning_risk=modality", fh.read())

    def test_doc_type_reaches_the_prompt(self):
        self.stub("OK")
        review.rewrite("本文です。", doc_type="minutes")
        self.assertIn("文書の種類 minutes", self.prompts[0])


class DocTypeFromHooks(Hook):
    def test_gh_pr_body_is_a_pr(self):
        self.stub("")
        body = "この本文は書き直し役に渡される長さの日本語です。" * 5
        self.run_hook("pre", {"hook_event_name": "PreToolUse", "cwd": self.dir, "tool_input": {
            "command": "gh pr create --title t --body '%s'" % body}})
        self.assertEqual(self.doc_types, ["pr"])

    def test_stop_uses_the_file_name(self):
        self.stub("")
        body = "この本文は書き直し役に渡される長さの日本語です。" * 20
        path = self.write("議事録.md", body)
        transcript = self.transcript([user_prompt(),
                                      tool_call("Write", {"file_path": path, "content": body})])
        self.run_hook("stop", {"transcript_path": transcript, "cwd": self.dir})
        self.assertEqual(self.doc_types, ["minutes"])


class Post(Hook):
    BODY = "# 報告\n\n確認しました。\n\n台帳を更新しました。\n\n完了しました🎉\n"

    def run_post(self, tool_input):
        output = self.run_hook("post", {"hook_event_name": "PostToolUse", "cwd": self.dir,
                                        "tool_name": "Write", "tool_input": tool_input})
        return json.loads(output)["hookSpecificOutput"]["additionalContext"] if output.strip() else None

    def test_written_file_gets_the_lint_findings(self):
        path = self.write("report.md", self.BODY)
        context = self.run_post({"file_path": path, "content": self.BODY})
        self.assertIn(path, context)
        self.assertIn("7 行目 emoji_prohibited", context)

    def test_words_in_the_vocabulary_table_are_left_to_ja_vocab_lint(self):
        path = self.write("report.md", self.BODY)
        self.assertNotIn("台帳", self.run_post({"file_path": path, "content": self.BODY}))

    def test_edit_reports_only_the_edited_lines(self):
        path = self.write("report.md", self.BODY)
        self.assertIsNone(self.run_post({"file_path": path, "old_string": "確認",
                                         "new_string": "確認しました。"}))
        self.assertIn("emoji_prohibited", self.run_post(
            {"file_path": path, "old_string": "完了", "new_string": "完了しました🎉"}))

    def test_edit_whose_text_appears_twice_is_not_pinned_to_the_first_line(self):
        body = "確認しました。🎉\n\n確認しました。\n"
        path = self.write("report.md", body)
        self.assertIsNone(self.run_post({"file_path": path, "old_string": "変更対象です。",
                                         "new_string": "確認しました。"}))

    def test_html_is_linted_as_prose(self):
        page = "<html><body>\n<p>完了しました🎉</p>\n<script>const s = '🎉';</script>\n</body></html>\n"
        path = self.write("page.html", page)
        context = self.run_post({"file_path": path, "content": page})
        self.assertIn("2 行目 emoji_prohibited", context)
        self.assertNotIn("3 行目", context)

    def test_instruction_files_and_code_are_skipped(self):
        for name in ("CLAUDE.md", "notes.py"):
            path = self.write(name, self.BODY)
            self.assertIsNone(self.run_post({"file_path": path, "content": self.BODY}))

    def test_edit_tightens_spacing_only_on_the_edited_lines(self):
        body = "# 報告\n\n昨日は 3 件を直した。\n\n```\n3 件\n```\n"
        path = self.write("report.md", body)
        edited = body.replace("# 報告", "# 報告\n\n今日は Neon が 2 件を見た。")
        self.write("report.md", edited)
        context = self.run_post({"file_path": path, "old_string": "# 報告",
                                 "new_string": "# 報告\n\n今日は Neon が 2 件を見た。"})
        self.assertEqual(self.read(path), edited.replace("は Neon が 2 件", "はNeonが2件"))
        self.assertIn("3 行目で、日本語と英数字の間の半角の空白を詰めた", context)

    def test_edit_with_context_tightens_only_the_changed_line(self):
        before = "既存の 3 件\n旧文\n残り 4 件\n"
        after = "既存の 3 件\n新しい 5 件\n残り 4 件\n"
        path = self.write("report.md", after)
        self.run_hook("post", {"hook_event_name": "PostToolUse", "cwd": self.dir, "tool_name": "Edit",
                               "tool_input": {"file_path": path, "old_string": before, "new_string": after},
                               "tool_response": {"filePath": path, "originalFile": before}})
        self.assertEqual(self.read(path), "既存の 3 件\n新しい5件\n残り 4 件\n")

    def test_a_staged_edit_changes_nothing(self):
        path = self.write("report.md", "旧文\n既存の 3 件\n")
        self.run_hook("post", {"hook_event_name": "PostToolUse", "cwd": self.dir, "tool_name": "Edit",
                               "tool_input": {"file_path": path, "old_string": "旧文", "new_string": "3 件"},
                               "tool_response": {"filePath": path, "originalFile": "旧文\n既存の 3 件\n",
                                                 "staged": True}})
        self.assertEqual(self.read(path), "旧文\n既存の 3 件\n")

    def test_write_of_a_new_file_tightens_every_line_outside_code(self):
        body = "3 件を `git status` で見た。\r\n\r\n```\r\n3 件\r\n```\r\n"
        path = self.write("new.md", body)
        self.run_post({"file_path": path, "content": body})
        self.assertEqual(self.read(path), body.replace("3 件を", "3件を", 1))

    def test_write_of_a_tracked_file_tightens_only_the_git_diff(self):
        git(self.dir, "init", "-q")
        path = self.write("doc.md", "古い 3 件。\n\n古い 4 件。\n")
        git(self.dir, "add", "doc.md")
        git(self.dir, "commit", "-qm", "init")
        body = "古い 3 件。\n\n新しい 5 件。\n"
        self.write("doc.md", body)
        self.run_post({"file_path": path, "content": body})
        self.assertEqual(self.read(path), "古い 3 件。\n\n新しい5件。\n")

    def test_instruction_files_are_not_tightened(self):
        path = self.write("CLAUDE.md", "3 件を直す。\n")
        self.run_post({"file_path": path, "content": "3 件を直す。\n"})
        self.assertEqual(self.read(path), "3 件を直す。\n")

    def test_apply_patch_reports_the_added_lines(self):
        path = self.write("report.md", self.BODY)
        patch = "*** Begin Patch\n*** Update File: report.md\n@@\n-完了\n+完了しました🎉\n*** End Patch\n"
        self.assertIn("emoji_prohibited", self.run_post({"command": patch}))


class LaunchContext(unittest.TestCase):
    """偽の agy で、書き直し役が受け取る環境変数と指示文に、Claude Code から起動された文脈が無いことを見る。"""

    def test_rewriter_gets_no_launcher_context(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        bindir = agy_testing.install(d, response="OK")
        work = os.path.join(d, "work")
        os.mkdir(work)
        with mock.patch.dict(os.environ, agy_testing.polluted_env(bindir, NEON_LAUNCH_TMP=work)):
            for aud in (None, "client", "internal"):
                for doc_type in (None,) + review.ja_yomiyasu.DOC_TYPES:
                    block, _ = review.prompt_rules(aud, doc_type)
                    prompt = review.PROMPT % (review.TONE[aud], block, "", "本文")
                    self.assertEqual(review.call_agy(prompt), ("OK", None))
        calls = agy_testing.calls(bindir)
        self.assertEqual(len(calls), 3 * (1 + len(review.ja_yomiyasu.DOC_TYPES)))
        for call in calls:
            self.assertEqual(agy_testing.leaks(call, [d, os.path.realpath(d)]), [])
            self.assertEqual(call["env"].get("JA_REVIEW_ACTIVE"), "1")


if __name__ == "__main__":
    unittest.main()
