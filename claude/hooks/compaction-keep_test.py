#!/usr/bin/env python3
"""compaction-keep.py が、操縦席のあるワークスペースのメインだけで、判断と発言を会話の外に残し、圧縮のあとに組み直して照合することを保証する。

操縦席は一時フォルダの写しで作る（本物の .orca/cockpit.json は読まない・書かない）。新しいチャットは偽の orca で起こしたことにする。
カードの相談と窓からの質問（consult_returns.py）の試験は consult_returns_test.py にある。
"""

import json
import os
import subprocess
import unittest

from keep_testing import Base, HOOK, SESSION, read


class OnlyTheMain(Base):
    def test_a_workspace_without_a_cockpit_is_left_alone(self):
        os.remove(os.path.join(self.root, ".orca", "cockpit.json"))
        self.assertEqual(self.hook("UserPromptSubmit", prompt="こんにちは"), "")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_a_worker_repository_under_the_cockpit_is_not_the_main(self):
        sub = os.path.join(self.root, "worker")
        os.makedirs(os.path.join(sub, ".git"))
        self.hook("UserPromptSubmit", prompt="worker への指示", cwd=sub)
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_a_consult_thread_is_not_the_main(self):
        self.hook("UserPromptSubmit", env=self.env(CONSULT_THREAD="1"), prompt="相談")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_broken_input_is_silent(self):
        done = subprocess.run([HOOK], input="{", text=True, capture_output=True, env=self.env())
        self.assertEqual((done.returncode, done.stdout), (0, ""))


class Utterances(Base):
    def test_a_long_prompt_is_restored_whole_with_its_line_breaks(self):
        text = "前置き。" * 300 + "\n最後に: 本番は禁止"
        self.hook("UserPromptSubmit", prompt=text)
        ctx = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("\n  最後に: 本番は禁止", ctx)

    def test_the_prompt_is_kept_verbatim(self):
        text = "本番には出さないで。\n  dev だけでいい"
        self.hook("UserPromptSubmit", prompt=text)
        [u] = self.jsonl("utterances.jsonl")
        self.assertEqual((u["id"], u["prompt"], u["session"], u["at"]), ("u-1", text, SESSION, self.now))

    def test_prompts_in_the_same_second_get_distinct_ids(self):
        # 依頼の帳簿の仕分け（intake.through・none）は発言を id で指す。同じ秒の 2 行が実データにある
        # 行の区切りでない U+2028 を含む発言でも、行番号はずれない
        for text in ("A をして", "B もして", "貼った文\u2028の続き"):
            self.hook("UserPromptSubmit", prompt=text)
        self.hook("UserPromptSubmit", prompt="最後")
        rows = self.jsonl("utterances.jsonl")
        self.assertEqual([u["id"] for u in rows], ["u-1", "u-2", "u-3", "u-4"])
        self.assertEqual(rows[2]["prompt"], "貼った文\u2028の続き")

    def test_old_rows_without_an_id_get_one_by_their_line_number(self):
        # 移し替えは、今ある最後の行の id を intake.through に書く。読めない行も行番号を数える
        p = os.path.join(self.root, ".orca", "cockpit", "utterances.jsonl")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write('{"at": "2026-11-21T09:00:00+09:00", "session": "s0", "prompt": "古い 1"}\n')
            fh.write("{壊れた行\n")
            fh.write('{"at": "2026-11-21T09:00:00+09:00", "session": "s0", "prompt": "古い 3"}\n')
        self.hook("UserPromptSubmit", prompt="新しい発言")
        with open(p, encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        self.assertEqual(lines[1], "{壊れた行")
        rows = self.jsonl_ok("utterances.jsonl")
        self.assertEqual([(u["id"], u["prompt"]) for u in rows], [("u-1", "古い 1"), ("u-3", "古い 3"), ("u-4", "新しい発言")])

    def test_a_last_line_without_a_newline_is_closed_before_appending(self):
        # 書きかけで落ちた行に新しい発言がつながると、両方読めなくなり、次の id も同じになる
        p = os.path.join(self.root, ".orca", "cockpit", "utterances.jsonl")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write('{"id": "u-1", "prompt": "前の依頼"}\n{"id": "u-2", "pro')
        self.hook("UserPromptSubmit", prompt="新しい発言")
        self.hook("UserPromptSubmit", prompt="次の発言")
        self.assertEqual([(u["id"], u["prompt"]) for u in self.jsonl_ok("utterances.jsonl")],
                         [("u-1", "前の依頼"), ("u-3", "新しい発言"), ("u-4", "次の発言")])

    def test_the_signal_the_window_types_is_not_her_utterance(self):
        # 窓は深田さんの操作のあと、窓口の Run に「【操縦席】未反映の操作があります」の知らせを送る（R191）。深田さんの発言には数えない
        for signal in ("【操縦席】未反映の操作があります", "【操縦席】未反映の操作があります（直してほしい v91: 表の幅を\n狭く）"):
            self.hook("UserPromptSubmit", prompt=signal)
        self.hook("UserPromptSubmit", prompt="【操縦席】未反映の操作がありますって出るけど何？")
        self.assertEqual([u["prompt"] for u in self.jsonl("utterances.jsonl")], ["【操縦席】未反映の操作がありますって出るけど何？"])

    def jsonl_ok(self, name):
        rows = []
        with open(os.path.join(self.root, ".orca", "cockpit", name), encoding="utf-8") as fh:
            for line in fh:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
        return rows

    def test_the_escalation_recorded_on_11_21_at_19_19_is_not_recorded(self):
        # 2026-11-21 19:19 に実際に発言として記録された Orca の知らせの本文（ハーネスの utterances.jsonl の 152 行目）
        relay = ("──── From: STRUCTWORKER_974C3043-4722-4467-AC1B-12D51550A101 (structworker_974c3043-4722-4467-ac1b-12d51550a101) [HIGH] (escalation) ────\n"
                 "Subject: Worker stopped without reporting\n"
                 "Worker structworker_974c3043-4722-4467-ac1b-12d51550a101 ended its turn without sending worker_done for task \"操縦席の作り直し（担当）\" (task_069cde9db38c).\n"
                 "Last output:\nNeon（読むだけ）の見直しを待っています。終わったら指摘を採否して直し、窓口に送ります。\n"
                 "────────────────────────────────────────────────────────────")
        self.hook("UserPromptSubmit", prompt="状況を教えて")
        self.hook("UserPromptSubmit", prompt=relay)
        self.hook("UserPromptSubmit", prompt="次")
        self.assertEqual([(u["id"], u["prompt"]) for u in self.jsonl("utterances.jsonl")], [("u-1", "状況を教えて"), ("u-2", "次")])
        # 発言には入れず、待ちと照らす知らせとして n-<行番号> で残す（R204）
        self.assertEqual([(u["id"], u["prompt"]) for u in self.jsonl("notices.jsonl")], [("n-1", relay.strip()[:400])])
        self.hook("UserPromptSubmit", prompt=self.TASK_NOTICE)
        self.hook("UserPromptSubmit", prompt=relay)
        self.assertEqual([u["id"] for u in self.jsonl("notices.jsonl")], ["n-1", "n-2"])

    # 2026-11-21 22:38 に発言として記録された subagent の完了の知らせ（ハーネスの utterances.jsonl の u-216）を縮めた形
    TASK_NOTICE = ("<task-notification>\n<task-id>aca9879aae583e335</task-id>\n<tool-use-id>toolu_01YFmep9nSPqCG6we6sBHZDo</tool-use-id>\n"
                   "<output-file>/private/tmp/claude-501/x/tasks/aca9879aae583e335.output</output-file>\n<status>completed</status>\n"
                   "<summary>Agent \"証拠の無い依頼11件の証拠を探す\" finished</summary>\n"
                   "<result>## 確かめてほしいこと\n- 待って</result>\n<usage><tool_uses>59</tool_uses></usage>\n</task-notification>")

    def test_the_background_task_notice_recorded_on_11_21_at_22_38_is_not_recorded(self):
        monitor = "<task-notification>\n<task-id>bugq0trml</task-id>\n<summary>Monitor event: \"見る\"</summary>\n<event>[]</event>\n</task-notification>"
        mid = "さっきの <task-notification> が発言に入ってた。直して"
        head = "<task-notification> って何？"
        for p in ("状況を教えて", self.TASK_NOTICE, monitor, mid, head):
            self.hook("UserPromptSubmit", prompt=p)
        self.assertEqual([(u["id"], u["prompt"]) for u in self.jsonl("utterances.jsonl")], [("u-1", "状況を教えて"), ("u-2", mid), ("u-3", head)])

    # 2026-11-22 00:21 に Orca の自動で続ける 1 文が発言 u-225 として帳簿の仕分けに出た
    def test_the_auto_continue_line_is_not_recorded(self):
        mixed = "Continue where you left off. あと窓も直して"
        for p in ("状況を教えて", "Continue where you left off.", mixed):
            self.hook("UserPromptSubmit", prompt=p)
        self.assertEqual([(u["id"], u["prompt"]) for u in self.jsonl("utterances.jsonl")], [("u-1", "状況を教えて"), ("u-2", mixed)])

    # 2026-11-22 09:38 に Orca の受信箱の知らせが相談のタブで発言 u-236 として記録された
    def test_the_orca_inbox_line_is_not_recorded(self):
        notice = "You have 1 orchestration message. Run `orca orchestration check --terminal term_36592f9a-bf2f-477c-b361-66fd6c53041d`."
        mixed = notice + " それと窓も直して"
        for p in (notice, "You have 2 orchestration messages. Run `orca orchestration check --terminal term_x`.", mixed):
            self.hook("UserPromptSubmit", prompt=p)
        self.assertEqual([(u["id"], u["prompt"]) for u in self.jsonl("utterances.jsonl")], [("u-1", mixed)])

    def test_a_notice_recorded_before_the_fix_is_skipped_but_keeps_its_line_number(self):
        p = os.path.join(self.root, ".orca", "cockpit", "utterances.jsonl")
        with open(p, "w", encoding="utf-8") as fh:
            for i, text in enumerate(("前の依頼", self.TASK_NOTICE), 1):
                fh.write(json.dumps({"id": "u-%d" % i, "at": "2026-11-21T09:00:00+09:00", "session": SESSION, "prompt": text}, ensure_ascii=False) + "\n")
        self.hook("UserPromptSubmit", prompt="新しい発言")
        ctx = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("前の依頼", ctx)
        self.assertIn("新しい発言", ctx)
        self.assertNotIn("task-notification", ctx)
        self.assertEqual([u["id"] for u in self.jsonl("utterances.jsonl")], ["u-1", "u-2", "u-3"])


class MainWithoutCockpit(Base):
    def setUp(self):
        super().setUp()
        os.remove(os.path.join(self.root, ".orca", "cockpit.json"))
        os.makedirs(os.path.join(self.root, ".git"))
        self.orca = self.env(ORCA_WORKTREE_ID="repo::%s" % self.root)

    def test_the_prompt_is_kept_verbatim_and_nothing_else_is_written(self):
        text = "本番には出さないで。\n  dev だけでいい"
        self.assertEqual(self.hook("UserPromptSubmit", env=self.orca, prompt=text), "")
        self.hook("UserPromptSubmit", env=self.orca, prompt="次", cwd=os.path.join(self.root, "sub"))
        self.assertEqual([(u["id"], u["prompt"], u["session"], u["at"]) for u in self.jsonl("utterances.jsonl")],
                         [("u-1", text, SESSION, self.now), ("u-2", "次", SESSION, self.now)])
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, ".orca", "cockpit"))), ["keep.lock", "utterances.jsonl"])

    def test_notices_are_not_her_utterances(self):
        self.hook("UserPromptSubmit", env=self.orca, prompt="<task-notification>\n<summary>x</summary>\n</task-notification>")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_other_places_are_not_the_main(self):
        child = os.path.join(self.root, "child")
        os.makedirs(child)
        with open(os.path.join(child, ".git"), "w") as fh:
            fh.write("gitdir: %s/.git/worktrees/child\n" % self.root)
        self.hook("UserPromptSubmit", env=self.orca, prompt="担当・worker の worktree", cwd=child)
        self.hook("UserPromptSubmit", prompt="Orca の外")
        self.hook("UserPromptSubmit", env={**self.orca, "CONSULT_THREAD": "1"}, prompt="相談スレッド")
        # 担当・worker の端末（子の worktree の id）から、操縦席の無い元のチェックアウトへ移って起こした会話
        self.hook("UserPromptSubmit", env={**self.orca, "ORCA_WORKTREE_ID": "repo::%s" % child}, prompt="移った担当")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_the_other_hooks_stay_quiet(self):
        self.hook("UserPromptSubmit", env=self.orca, prompt="作業して")
        for _ in range(30):
            self.assertEqual(self.hook("PostToolUse", env=self.orca, tool_name="Bash", tool_input={"command": "ls"}), "")
        self.assertEqual(self.hook("Stop", env=self.orca, last_assistant_message="done"), "")
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "cockpit", "keep.json")))


class BusyMain(Base):
    def call(self, tool="Bash", **extra):
        out = self.hook("PostToolUse", tool_name=tool, tool_input=extra.pop("tool_input", {"command": "ls"}), **extra)
        return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""

    def read(self, path, **extra):
        return self.call("Read", tool_input={"file_path": path}, **extra)

    def test_many_calls_nudge_once_per_turn(self):
        self.hook("UserPromptSubmit", prompt="作業して")
        self.assertEqual([self.call() for _ in range(24)], [""] * 24)
        ctx = self.call()
        self.assertIn("ツールを 25 回", ctx)
        self.assertIn("subagent", ctx)
        self.assertEqual(self.call(), "")
        self.hook("UserPromptSubmit", prompt="次の依頼")
        self.assertEqual(self.call(), "")

    def test_three_distinct_files_nudge(self):
        self.hook("UserPromptSubmit", prompt="調べて")
        a = os.path.join(self.root, "a.py")
        self.assertEqual(self.read(a), "")
        self.assertEqual(self.read(os.path.join(self.root, ".", "a.py")), "")
        self.assertEqual(self.read("a.py", cwd=self.root), "")
        self.assertEqual(self.read(os.path.join(self.root, ".orca", "cockpit", "state.md")), "")
        self.assertIn("別々のファイルを 3 件", self.read("/src/c.py"))

    def test_subagent_calls_and_no_turn_are_not_counted(self):
        self.assertEqual([self.call() for _ in range(30)], [""] * 30)
        self.hook("UserPromptSubmit", prompt="出して")
        for i in range(30):
            self.assertEqual(self.read("/src/%d.py" % i, agent_id="sub-1"), "")
        self.assertEqual(self.read("/src/x.py"), "")

    def test_a_worker_under_the_cockpit_is_not_nudged(self):
        sub = os.path.join(self.root, "worker")
        os.makedirs(os.path.join(sub, ".git"))
        self.hook("UserPromptSubmit", prompt="作業して")
        self.assertEqual([self.call(cwd=sub) for _ in range(26)], [""] * 26)


class Rulings(Base):
    def test_a_permission_needs_scope_value_and_the_quote(self):
        done = self.tool("rule", {"kind": "permission", "text": "dev に入れてよい", "allow": True})
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("quote", done.stderr)
        rid = self.rule(kind="permission", text="dev に入れてよい", scope="dev への反映", allow=True, quote="dev には入れていいよ")
        self.assertEqual(rid, "R1")

    def test_a_revoked_permission_is_no_longer_active(self):
        self.rule(kind="permission", text="本番に入れてよい", scope="本番への反映", allow=True, quote="本番入れていいよ")
        self.rule(kind="revoke", text="本番はやめる", supersedes=["R1"], quote="待って、本番はまだ")
        done = self.tool("rulings")
        self.assertEqual(done.stdout, "")
        again = self.tool("rule", {"kind": "revoke", "text": "二重の撤回", "supersedes": ["R1"], "quote": "x"})
        self.assertIn("有効な判断に無い", again.stderr)

    def test_a_ruling_that_changes_the_scope_names_the_tasks_it_affects(self):
        # 範囲を変える判断は、影響する既存のタスク（済も含む）を挙げる（11/21 の R39 と済の t50）
        for bad in ("t1", False, [""]):
            done = self.tool("rule", {"kind": "decision", "text": "nix-darwin だけで始める", "affects": bad})
            self.assertIn("affects は影響するタスクの id の配列", done.stderr, bad)
        done = self.tool("rule", {"kind": "decision", "text": "nix-darwin だけで始める", "affects": ["t500"]})
        self.assertIn("affects のタスクが操縦席に無い: t500", done.stderr)  # t50 の打ち間違いで見直しから漏れないように
        self.rule(kind="decision", text="nix-darwin だけで始める", affects=["t1", "t2"])  # t2 は済のタスク
        self.assertIn("影響するタスク: t1・t2", self.tool("rulings").stdout)

    def test_a_replacement_keeps_only_the_new_one(self):
        self.rule(kind="decision", text="A 方式で作る")
        self.rule(kind="decision", text="B 方式で作る", supersedes=["R1"])
        self.assertIn("R2", self.tool("rulings").stdout)
        self.assertNotIn("R1 ", self.tool("rulings").stdout)


class ThinSummary(Base):
    def test_precompact_asks_for_a_thin_summary_that_points_by_id(self):
        output = self.hook("PreCompact", trigger="auto")
        self.assertIn("1.5k トークン以内", output)
        self.assertIn("ID で指す", output)
        self.assertIn("絶対パス", output)
        self.assertLess(len(output), 10000)

    def test_a_stale_memo_is_named_in_the_instruction(self):
        memo = os.path.join(self.root, ".orca", "cockpit", "state.md")
        with open(memo, "w") as fh:
            fh.write("古いメモ")
        os.utime(memo, (1, 1))
        self.assertIn("作業メモが操縦席・判断の記録より", self.hook("PreCompact", trigger="auto"))


class Reassembly(Base):
    def test_compact_restores_memo_open_items_active_rulings_and_recent_prompts(self):
        with open(os.path.join(self.root, ".orca", "cockpit", "state.md"), "w") as fh:
            fh.write("# 目的と受入条件\nhook を入れる")
        self.rule(kind="constraint", text="push しない", quote="push はしないで")
        self.rule(kind="permission", text="本番 OK", scope="本番", allow=True, quote="本番いいよ")
        self.rule(kind="revoke", text="本番は取り消し", supersedes=["R2"], quote="やっぱり本番は待って")
        for i in range(12):
            self.hook("UserPromptSubmit", prompt="発言 %d" % i)
        out = json.loads(self.hook("SessionStart", source="compact"))
        text = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("hook を入れる", text)
        self.assertIn("d1 decide: 引き継ぎの方式を決める", text)
        self.assertIn("w1 send（先方の担当者の返事待ち）: 上限を聞く", text)
        self.assertNotIn("a1", text)
        self.assertIn("t1 タスク", text)
        self.assertNotIn("t2 タスク", text)
        self.assertIn("R1 [constraint] push しない", text)
        self.assertIn("原文「push はしないで」", text)
        self.assertNotIn("R2 [", text)
        self.assertIn("発言 11", text)
        self.assertIn("発言 2", text)
        self.assertNotIn("発言 1\n", text)
        self.assertIn("compaction-keep.py resume", text)
        self.assertTrue(self.keep()["verify"]["pending"])

    def test_a_long_record_is_cut_to_the_hook_limit_from_prompts_then_rulings(self):
        # Claude Code は 10,000 字を超えた hook の出力を先頭 2,000 字だけ渡す。判断が 150 件・長い発言が並ぶ窓口で 4 万字になった
        with open(os.path.join(self.root, ".orca", "cockpit", "state.md"), "w") as fh:
            fh.write("## 今の順番\n1. t1: 続き")
        with open(os.path.join(self.root, ".orca", "cockpit", "rulings.jsonl"), "w") as fh:
            for i in range(1, 151):
                fh.write(json.dumps({"id": "R%d" % i, "at": self.now, "kind": "decision", "text": "決めたこと %d " % i + "理由" * 80}, ensure_ascii=False) + "\n")
        for i in range(10):
            self.hook("UserPromptSubmit", prompt="長い依頼 %d " % i + "本文" * 600)
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertLessEqual(len(text), 9500)
        self.assertIn("1. t1: 続き", text)
        self.assertIn("有効な判断の ID: R1・R2・", text)
        self.assertIn("・R150", text)
        self.assertIn("utterances.jsonl（発言の直近 10 件。", text)
        self.assertIn("compaction-keep.py rulings %s decision）" % self.root, text)
        self.assertIn("- R150 [decision] 決めたこと 150", text)

    def test_a_short_record_is_not_cut(self):
        self.hook("UserPromptSubmit", prompt="短い依頼")
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("全文は", text)
        # 短くする処理が判断を省いても嘘にならないよう、有効かの確かめ先を出し、「ここに無い判断は効力が無い」とは言わない
        self.assertIn("有効かは ~/.claude/hooks/compaction-keep.py rulings %s の出力で確認し、省いた分は示された全文の参照先を読む" % self.root, text)
        self.assertNotIn("効力が無い", text)

    def test_the_reassembly_starts_with_the_current_time(self):
        # 11/21 に、窓口と担当が時刻を推し量って書き、約 5 時間 20 分ずれた（F26）
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertTrue(text.startswith("今の時刻: 2026-11-21 10:00 +0900（date の値。"), text[:80])

    def test_free_slots_and_waiting_tasks_are_listed(self):
        self.cockpit["tasks"] += [{"id": "t80", "stream": "s7", "title": "窓の凡例を減らす", "state": "idle"},
                                  {"id": "t81", "title": "続きの直し", "state": "idle", "worker": {"run_id": "run_x", "task_id": "task_y"}},
                                  {"id": "t82", "title": "外の返事待ち", "state": "wait", "worker": {"task_id": "task_w"}},
                                  {"id": "t83", "title": "取り込み待ち", "state": "run", "worker": {"task_id": "task_d"}}]
        self.write_cockpit()
        # 作業中は state.ts の判定（Orca の Dispatch）で数える。手書きの run のままの取り込み待ち（t83）は枠を占めない
        fake = os.path.join(self.root, "state.js")
        shown = [{"id": "t1", "state": "run", "from": "working"}, {"id": "t83", "state": "run", "from": "intake"},
                 {"id": "t80", "state": "idle", "from": "record"}, {"id": "t81", "state": "idle", "from": "record"},
                 {"id": "t82", "state": "wait", "from": "record"}]
        with open(fake, "w") as fh:
            fh.write("console.log(%s)" % json.dumps(json.dumps({"tasks": shown})))
        text = json.loads(self.hook("SessionStart", env=self.env(COCKPIT_STATE=fake), source="compact"))["hookSpecificOutput"]["additionalContext"]
        text = text[text.index("## 空き枠"):text.index("## 有効な判断")]
        self.assertIn("## 空き枠と待ちのタスク（上限 4・作業中 1・空き 3。", text)
        self.assertIn("- t80（s7）: 窓の凡例を減らす\n", text)
        self.assertIn("- t81（仕事なし）: 続きの直し worker run run_x・task task_y", text)
        self.assertNotIn("- t82", text)

    def test_an_unreadable_state_says_the_free_slots_are_unknown(self):
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("state.ts を読めず、作業中の数と空きは不明", text)

    def test_startup_and_resume_are_left_to_the_reminder(self):
        self.assertEqual(self.hook("SessionStart", source="startup"), "")
        self.assertEqual(self.hook("SessionStart", source="resume"), "")


class Verify(Base):
    """⑥ 圧縮のあとの答えを記録と操縦席に突き合わせる。ID の一致だけでなく、許可の値・対象・却下した案・パスを見る。"""

    def setUp(self):
        super().setUp()
        self.edited = os.path.join(self.root, "hook.py")
        open(self.edited, "w").close()
        self.rule(kind="constraint", text="push しない", quote="push はしないで")                                   # R1
        self.rule(kind="permission", text="本番に入れてよい", scope="本番への反映", allow=True, quote="本番いいよ")  # R2
        self.rule(kind="revoke", text="本番は待つ", supersedes=["R2"], quote="やっぱり本番は待って")               # R3
        self.rule(kind="permission", text="dev には入れてよい", scope="dev への反映", allow=True, quote="dev はいい")  # R4
        self.rule(kind="rejection", text="週ごとにチャットを切り替える案は採らない", rejected="週ごとの切り替え",
                  quote="これはめんどくない？")                                                                     # R5
        transcript = os.path.join(self.root, "t.jsonl")
        with open(transcript, "w") as fh:
            for row in [
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "/nonexistent/old.py"}}]}},
                {"type": "system", "subtype": "compact_boundary"},
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": self.edited}}]}},
            ]:
                fh.write(json.dumps(row) + "\n")
        self.summary_ok = "## 未完了の項目と次の一手\n- t1: %s にテストを足す（R1・R4 を守る）" % self.edited
        self.hook("PostCompact", trigger="auto", compact_summary=self.summary_ok, transcript_path=transcript)
        self.good = {"next": "t1 のテストを足して dev に入れる", "rulings": ["R1", "R5"],
                     "permissions": [{"id": "R4", "scope": "dev への反映", "allow": True}],
                     "workers": ["ctx_a"], "paths": [self.edited]}

    def resume(self, **change):
        return self.tool("resume", {**self.good, **change})

    def test_the_right_answer_passes_and_unblocks_workers(self):
        self.assertTrue(self.keep()["verify"]["pending"])
        send = "orca orchestration send --to dispatch:ctx_a --subject 続き --body-file b.md"
        out = self.hook("PreToolUse", tool_name="Bash", tool_input={"command": send})
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")
        done = self.resume()
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertFalse(self.keep()["verify"]["pending"])
        self.assertEqual(self.hook("PreToolUse", tool_name="Bash", tool_input={"command": send}), "")

    def test_other_commands_are_not_blocked_while_pending(self):
        self.assertEqual(self.hook("PreToolUse", tool_name="Bash", tool_input={"command": "orca orchestration worker-list"}), "")

    def denied(self, command):
        out = self.hook("PreToolUse", tool_name="Bash", tool_input={"command": command})
        return bool(out) and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_a_quoted_path_or_a_line_continuation_is_still_blocked(self):
        self.assertTrue(self.denied('"/Applications/Orca.app/Contents/Resources/bin/orca" orchestration send --to dispatch:ctx_a'))
        self.assertTrue(self.denied("orca orchestration \\\n  worker-start --spec-file b.md --terminal term_a"))
        self.assertTrue(self.denied('"/Users/x/.local/bin/orca-launch" --worktree w --title t --spec-file b.md'))

    def test_the_answer_mentioning_orchestration_in_a_heredoc_is_not_blocked(self):
        cmd = "~/.claude/hooks/compaction-keep.py resume /w <<'JSON'\n{\"next\": \"orca orchestration send で t1 を続ける\"}\nJSON"
        self.assertFalse(self.denied(cmd))

    def test_a_revoked_permission_that_came_back_fails(self):
        done = self.resume(permissions=self.good["permissions"] + [{"id": "R2", "scope": "本番への反映", "allow": True}])
        self.assertEqual(done.returncode, 1)
        self.assertIn("R2 は有効な判断ではない（撤回・置き換え済み）", done.stdout)
        self.assertTrue(self.keep()["verify"]["pending"])

    def test_a_matching_id_with_a_flipped_value_or_scope_fails(self):
        done = self.resume(permissions=[{"id": "R4", "scope": "本番への反映", "allow": True}])
        self.assertIn("R4 の対象が違う", done.stdout)
        done = self.resume(permissions=[{"id": "R4", "scope": "dev への反映", "allow": False}])
        self.assertIn("R4 の値が違う", done.stdout)

    def test_proposing_a_rejected_plan_again_fails(self):
        done = self.resume(next="来週から週ごとの切り替えで新しいチャットにする")
        self.assertEqual(done.returncode, 1)
        self.assertIn("却下した案「週ごとの切り替え」（R5）", done.stdout)

    def test_a_dropped_path_fails(self):
        done = self.resume(paths=[])
        self.assertEqual(done.returncode, 1)
        self.assertIn("パス %s が答えに無い" % self.edited, done.stdout)

    def test_a_missing_constraint_or_worker_fails(self):
        done = self.resume(rulings=["R5"], workers=[])
        self.assertIn("R1（constraint）が答えに無い", done.stdout)
        self.assertIn("続ける worker task_a が答えに無い", done.stdout)  # 古い行も最初の Task の id で名指す
        done = self.resume(workers=["ctx_a", "ctx_old"])
        self.assertIn("worker ctx_old は操縦席の済んでいないタスクに無い", done.stdout)

    def test_a_version_3_worker_is_named_by_its_first_task(self):
        # 版 3 の worker は { run_id, task_id } だけを持ち、今の Dispatch は Orca からたどる
        self.cockpit["tasks"].append({"id": "t3", "title": "窓の作り直し", "state": "run",
                                      "worker": {"run_id": "run_x", "task_id": "task_v3"}})
        self.write_cockpit()
        done = self.resume()
        self.assertIn("続ける worker task_v3 が答えに無い", done.stdout)
        done = self.resume(workers=["task_a", "task_v3"])
        self.assertEqual(done.returncode, 0, done.stdout)
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("t3 タスク: 窓の作り直し。次: - worker task_v3", text)
        self.assertIn("worker.task_id", text)

    def test_an_open_lead_is_named_by_its_receipt(self):
        # 担当の受け取りは owners[].worker に置く（t159）。開いた担当は続ける相手に数え、片付けた担当は数えない
        self.cockpit["owners"] = [{"id": "o1", "title": "窓", "stream": "s1", "session": "sess", "state": "open", "worker": {"run_id": "run_l", "task_id": "task_lead"}},
                                  {"id": "o2", "title": "前", "stream": "s1", "session": "sess2", "state": "done", "worker": {"run_id": "run_l", "task_id": "task_old"}}]
        self.write_cockpit()
        done = self.resume()
        self.assertIn("続ける worker task_lead が答えに無い", done.stdout)
        self.assertNotIn("task_old", done.stdout)
        done = self.resume(workers=["task_a", "task_lead"])
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_the_summary_itself_is_checked_for_the_same_three(self):
        [row] = [r for r in self.jsonl("compactions.jsonl") if r["type"] == "compact"]
        self.assertEqual(row["summary_issues"], [])
        self.assertEqual(row["required_paths"], [self.edited])
        self.assertEqual((row["n"], row["summary_chars"]), (1, len(self.summary_ok)))
        bad = "- R2 の許可で本番に入れる\n- 次は週ごとの切り替えを試す"
        self.hook("PostCompact", trigger="auto", compact_summary=bad,
                  transcript_path=os.path.join(self.root, "t.jsonl"))
        issues = self.jsonl("compactions.jsonl")[-1]["summary_issues"]
        self.assertTrue(any("撤回・置き換え済みの R2" in i for i in issues), issues)
        self.assertTrue(any("却下した案「週ごとの切り替え」" in i for i in issues), issues)
        self.assertTrue(any("パス %s が要約にも作業メモにも無い" % self.edited in i for i in issues), issues)
        self.assertEqual(self.jsonl("compactions.jsonl")[-1]["n"], 2)
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("要約の照合で見つかった食い違い", text)

    def test_results_are_recorded(self):
        self.resume(paths=[])
        self.resume()
        rows = [r for r in self.jsonl("compactions.jsonl") if r["type"] == "resume"]
        self.assertEqual([(r["ok"], r["failures"]) for r in rows], [(False, 1), (True, 0)])

    def test_stop_asks_for_the_answer_once_per_turn(self):
        self.hook("UserPromptSubmit", prompt="続けて")
        out = json.loads(self.hook("Stop", last_assistant_message="はい"))
        self.assertIn("再開の確かめ", out["reason"])
        self.assertEqual(self.hook("Stop", last_assistant_message="はい"), "")


class EditedPaths(Base):
    """照合で求めるパスは、圧縮のときに編集の途中だったファイルだけ。2026-11-21 の 3 回の圧縮の会話の記録の形を写して確かめる。"""

    def file(self, *parts):
        p = os.path.join(self.root, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").close()
        return p

    def use(self, name, path, uid=None, **extra):
        c = {"type": "tool_use", "name": name, "input": {"file_path": path, **extra}}
        if uid:
            c["id"] = uid
        return {"type": "assistant", "message": {"content": [c]}}

    BOUNDARY = {"type": "system", "subtype": "compact_boundary"}
    # 区切りのあとに書かれる行（要約と添付）。モデルの発言は無い
    AFTER = [{"type": "attachment", "attachment": {"type": "date"}},
             {"type": "user", "isCompactSummary": True, "message": {"content": "要約"}}]

    def result(self, uid, error=False):
        return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": uid, "is_error": error, "content": "x"}]}}

    def bash(self, uid, command):
        return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": uid, "name": "Bash", "input": {"command": command}}]}}

    def required(self, rows, before=None):
        """before を渡すと、その記録で PreCompact を走らせてから rows で PostCompact を走らせる（区切りの数の増減を見る経路）。"""
        transcript = os.path.join(self.root, "t.jsonl")
        for event, content in (("PreCompact", before), ("PostCompact", rows)):
            if content is None:
                continue
            with open(transcript, "w") as fh:
                for row in content:
                    fh.write(json.dumps(row) + "\n")
            self.hook(event, trigger="auto", compact_summary="", transcript_path=transcript)
        return self.jsonl("compactions.jsonl")[-1]["required_paths"]

    def test_briefs_written_once_and_a_published_page_are_not_required(self):
        # 18:54 の圧縮: brief 4 つは 1 回 Write しただけ、harness-map は Edit のあと artifact に公開して済んでいた
        briefs = [self.file("scratchpad", n) for n in ("brief-t65-lead.md", "brief-t66.md", "brief-t67.md", "brief-t68.md")]
        hook, test = self.file("hooks", "compaction-keep.py"), self.file("hooks", "compaction-keep_test.py")
        page = self.file("scratchpad", "harness-map", "index.html")
        rows = [self.use("Write", briefs[0], "w1"), self.use("Write", briefs[1], "w2"), self.use("Write", briefs[2], "w3")]
        rows += [self.use("Edit", hook, "e%d" % i) for i in range(4)] + [self.use("Edit", test, "t%d" % i) for i in range(2)]
        rows += [self.use("Write", briefs[3], "w4")]
        # 会話の記録は同じ tool_use を 2 行に書くことがある（1 回の Write が 2 回に数えられないこと）
        rows += [{"type": "progress", "message": {"content": [{"type": "tool_use", "id": "w4", "name": "Write", "input": {"file_path": briefs[3]}}]}}]
        rows += [self.use("Edit", page, "p%d" % i) for i in range(8)] + [self.use("Artifact", page, "a1"), self.result("a1")]
        self.assertEqual(self.required(rows + [self.BOUNDARY] + self.AFTER), [hook, test])

    def test_a_file_committed_by_its_path_after_the_edit_is_not_required(self):
        # 13:44 の圧縮: run.sh は Edit の 6 秒後に git add run.sh && git commit で済んでいた
        os.makedirs(os.path.join(self.root, "repo", ".git"))
        run_sh = self.file("repo", "claude", "skills", "knowledge-harvest", "run.sh")
        commit = "cd ~/.config/nix-darwin && git add claude/skills/knowledge-harvest/run.sh && git commit -q -m 'x'"
        self.assertEqual(self.required([self.use("Edit", run_sh, "e1"), self.bash("b1", commit), self.result("b1"), self.BOUNDARY] + self.AFTER), [])

    def test_a_failed_or_unrelated_commit_or_publish_keeps_the_file(self):
        os.makedirs(os.path.join(self.root, "repo", ".git"))
        skill = self.file("repo", "claude", "skills", "cockpit", "SKILL.md")
        page = self.file("page.html")
        rows = [self.use("Edit", skill, "e1"), self.use("Edit", page, "e2"),
                # 同じファイル名の別のファイルの commit・パスを挙げたが pre-commit で落ちた commit・結果がまだ無い公開
                self.bash("b1", "git add claude/skills/how/SKILL.md && git commit -m 'SKILL.md を直す'"), self.result("b1"),
                self.bash("b2", "git add claude/skills/cockpit/SKILL.md && git commit -m x"), self.result("b2", error=True),
                self.use("Artifact", page, "a1")]
        self.assertEqual(self.required(rows + [self.BOUNDARY] + self.AFTER), [skill, page])

    def test_an_empty_segment_before_the_compaction_does_not_reach_back(self):
        # 16:09 の圧縮: 直前の区切りでは何も編集しておらず、13:44 より前に Edit した run.sh を求めていた
        run_sh = self.file("knowledge-harvest", "run.sh")
        rows = [self.use("Edit", run_sh, "e1"), self.BOUNDARY] + self.AFTER
        rows += [{"type": "assistant", "message": {"content": [{"type": "text", "text": "続けます"}]}}, self.BOUNDARY] + self.AFTER
        self.assertEqual(self.required(rows), [])

    def test_compacting_again_before_the_model_answers_does_not_reach_back(self):
        # 圧縮の直後、モデルが答える前にもう一度 /compact した。区切りの数は PreCompact で数える
        old = self.file("old.py")
        before = [self.use("Edit", old, "e1"), self.BOUNDARY] + self.AFTER + [{"type": "user", "message": {"content": "/compact"}}]
        self.assertEqual(self.required(before, before=before), [])  # 今回の区切りがまだ書かれていない
        self.assertEqual(self.required(before + [self.BOUNDARY] + self.AFTER, before=before), [])  # もう書かれた
        self.assertNotIn("precompact", self.keep())

    def test_the_file_being_edited_is_still_required(self):
        p = self.file("hook.py")
        # 区切りがまだ書かれていない記録でも、最後の区切りのあとの編集を見る
        self.assertEqual(self.required([self.use("Edit", self.file("old.py"), "e0"), self.BOUNDARY, self.use("Edit", p, "e1")]), [p])
        # 2 回以上 Write したもの、公開したあとにまた直したものも途中
        twice, again = self.file("twice.md"), self.file("again.html")
        rows = [self.use("Write", twice, "w1"), self.use("Write", twice, "w2"),
                self.use("Edit", again, "e2"), self.use("Artifact", again, "a1"), self.use("Edit", again, "e3"),
                self.use("Artifact", self.file("db.json"), "a2", action="write_db")]
        self.assertEqual(self.required(rows + [self.BOUNDARY] + self.AFTER), [twice, again])

    def test_a_dropped_edited_file_still_fails_the_resume(self):
        p = self.file("hook.py")
        self.required([self.use("Edit", p, "e1"), self.use("Write", self.file("brief.md"), "w1"), self.BOUNDARY] + self.AFTER)
        done = self.tool("resume", {"next": "続ける", "rulings": [], "permissions": [], "workers": ["ctx_a"], "paths": []})
        self.assertEqual(done.returncode, 1)
        self.assertIn("パス %s が答えに無い" % p, done.stdout)
        self.assertNotIn("brief.md", done.stdout)


class LateNotices(Base):
    """圧縮のあとの組み直しに、深田さんの最後の発言より後に届いた Orca の知らせの見出しを入れる。"""

    def orca(self, script):
        with open(self.fake_orca, "w") as fh:
            fh.write("#!/bin/sh\necho \"$@\" >> '%s'\n%s\n" % (self.orca_log, script))

    def inbox(self, messages):
        body = json.dumps({"ok": True, "result": {"messages": messages}}, ensure_ascii=False)
        self.orca("case \"$2\" in\n run-current) echo '{\"ok\":true,\"result\":{\"runId\":\"run_x\"}}';;\n"
                  " inbox) cat <<'JSON'\n%s\nJSON\n;;\n esac" % body)

    def context(self):
        return json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]

    def test_notices_after_her_last_prompt_are_listed_without_marking_them_read(self):
        self.hook("UserPromptSubmit", prompt="v90 はおすすめでいいよ")  # 10:00 JST = 01:00Z
        self.inbox([
            {"from_handle": "term_lead", "type": "status", "subject": "R35: 2 つの案のページの表の幅を直した。同じ URL に出し直してください",
             "created_at": "2026-11-21T01:30:00Z", "read": 1},
            {"from_handle": "term_old", "type": "worker_done", "subject": "前に読んだ報告", "created_at": "2026-11-21T00:30:00Z", "read": 1},
        ])
        text = self.context()
        self.assertIn("最後の発言より後に届いた Orca の知らせ 1 件", text)
        self.assertIn("term_lead（status）: R35: 2 つの案のページの表の幅を直した", text)
        self.assertNotIn("前に読んだ報告", text)
        self.assertIn("compaction-keep.py resume", text)
        with open(self.orca_log) as fh:
            calls = fh.read()
        self.assertIn("orchestration inbox --terminal run:run_x", calls)
        self.assertNotIn("check", calls)
        row = self.jsonl("compactions.jsonl")[-1]
        self.assertEqual((row["type"], row["run"], row["n"]), ("notices", "run_x", 1))

    def test_every_late_notice_is_listed(self):
        self.hook("UserPromptSubmit", prompt="続けて")
        self.inbox([{"from_handle": "term_%d" % i, "type": "question" if i == 0 else "status", "subject": "知らせ %d" % i,
                     "created_at": "2026-11-21T01:%02d:00Z" % (i + 1)} for i in range(21)])
        text = self.context()
        self.assertIn("Orca の知らせ 21 件", text)
        self.assertIn("term_0（question）: 知らせ 0", text)

    def test_an_unreadable_inbox_is_skipped_silently(self):
        self.hook("UserPromptSubmit", prompt="続けて")
        for broken in ("echo 'not running' >&2\nexit 1",
                       "case \"$2\" in\n run-current) echo '{\"ok\":true,\"result\":{\"runId\":\"run_x\"}}';;\n inbox) echo 'broken'; exit 1;;\n esac"):
            self.orca(broken)
            text = self.context()
            self.assertNotIn("Orca の知らせ", text)
            self.assertIn("compaction-keep.py resume", text)
        with open(self.orca_log) as fh:
            self.assertIn("orchestration inbox --terminal run:run_x", fh.read())


class Handoff(Base):
    """⑦ 照合が 2 回続けて合わないか「前にも言った」が 2 回押されたら、その日の最初の発言の前に新しいチャットへ引き継ぐ。"""

    def fail_twice(self):
        self.hook("PostCompact", trigger="auto", compact_summary="")
        for _ in range(2):
            self.assertEqual(self.tool("resume", {"next": "", "rulings": [], "workers": []}).returncode, 1)

    def press_repeat(self, n, at="2026-11-20T18:00:00+09:00"):
        ops = [{"op_id": i + 1, "at": at, "item_id": "", "item_rev": 0, "type": "repeat"} for i in range(n)]
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": ops}, fh)

    def say(self, at, prompt="おはよう", session=SESSION):
        self.now = at
        return self.hook("UserPromptSubmit", prompt=prompt, session_id=session)

    def launched(self):
        if not os.path.exists(self.orca_log):
            return ""
        with open(self.orca_log) as fh:
            return fh.read()

    def test_two_failures_hand_off_before_the_first_prompt_of_the_next_day(self):
        self.say("2026-11-20T17:00:00+09:00", "昨日の最後の発言")
        self.now = "2026-11-20T17:30:00+09:00"
        self.fail_twice()
        self.assertNotIn("引き継", self.say("2026-11-20T18:00:00+09:00", "同じ日の続き"))
        self.assertFalse(self.launched())
        out = json.loads(self.say("2026-11-21T09:00:00+09:00", "今日の最初の発言"))
        self.assertEqual(out["decision"], "block")
        self.assertIn("新しいチャットに引き継ぎました", out["reason"])
        self.assertIn("agent launch --agent claude --worktree path:%s --surface chat" % self.root, self.launched())
        with open(os.path.join(self.root, ".orca", "cockpit", "handoff.json")) as fh:
            self.assertIn("2 回続けて", json.load(fh)["reason"])
        new = json.loads(self.hook("SessionStart", source="startup", session_id="s-new"))
        text = new["hookSpecificOutput"]["additionalContext"]
        self.assertIn("前のチャットからの引き継ぎ", text)
        self.assertIn("今日の最初の発言", text)
        self.assertIn("compaction-keep.py resume", text)
        self.assertEqual(self.keep()["verify"]["session"], "s-new")
        self.assertEqual(self.hook("SessionStart", source="startup", session_id="s-other"), "")

    def test_the_new_chat_gets_the_prompt_and_its_context_even_while_the_launch_runs(self):
        # 本物の Orca は起動の途中で新しいチャットの SessionStart を走らせることがある。偽の orca の中で hook を呼んで再現する
        got = os.path.join(self.root, "new-start.json")
        payload = json.dumps({"hook_event_name": "SessionStart", "source": "startup", "session_id": "s-new", "cwd": self.root})
        with open(self.fake_orca, "w") as fh:
            fh.write("#!/bin/sh\nprintf '%%s\\n' \"$@\" >> '%s'\necho '%s' | '%s' > '%s'\necho '{}'\n" % (self.orca_log, payload, HOOK, got))
        self.say("2026-11-20T17:00:00+09:00")
        self.press_repeat(2)
        out = json.loads(self.say("2026-11-21T09:00:00+09:00", "今日の最初の発言"))
        self.assertEqual(out["decision"], "block")
        self.assertRegex(self.launched(), r"--prompt\n（前のチャットから引き継いだ[^\n]*）\n\n今日の最初の発言\n--json")
        with open(got) as fh:
            ctx = json.load(fh)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("前のチャットからの引き継ぎ", ctx)
        self.assertEqual(self.keep()["handoff"]["state"], "taken")

    def orca_that_starts_the_new_chat(self, exit_code=0, also_prompt=False):
        """本物の Orca と同じく、起動の途中で新しいチャットの SessionStart（と最初の発言）を走らせる偽の orca。"""
        got = os.path.join(self.root, "new-start.json")
        start = json.dumps({"hook_event_name": "SessionStart", "source": "startup", "session_id": "s-new", "cwd": self.root})
        prompt = json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": "今日の最初の発言", "session_id": "s-new", "cwd": self.root})
        lines = ["#!/bin/sh", "printf '%%s\\n' \"$@\" >> '%s'" % self.orca_log, "echo '%s' | '%s' > '%s'" % (start, HOOK, got)]
        if also_prompt:
            lines.append("echo '%s' | '%s' > '%s.prompt'" % (prompt, HOOK, got))
        lines += ["echo '{}'", "exit %d" % exit_code]
        with open(self.fake_orca, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        return got

    def test_the_prompt_handed_to_the_new_chat_does_not_hand_off_again(self):
        got = self.orca_that_starts_the_new_chat(also_prompt=True)
        self.say("2026-11-20T17:00:00+09:00")
        self.press_repeat(2)
        self.assertEqual(json.loads(self.say("2026-11-21T09:00:00+09:00", "今日の最初の発言"))["decision"], "block")
        with open(got + ".prompt") as fh:
            self.assertNotIn("引き継", fh.read())
        self.assertEqual(self.launched().count("agent\nlaunch"), 1)

    def test_a_launch_that_reports_failure_after_the_new_chat_took_over_still_stops_the_old_chat(self):
        self.orca_that_starts_the_new_chat(exit_code=1)
        self.say("2026-11-20T17:00:00+09:00")
        self.press_repeat(2)
        out = json.loads(self.say("2026-11-21T09:00:00+09:00", "今日の最初の発言"))
        self.assertEqual(out["decision"], "block")
        self.assertEqual(self.keep()["handoff"]["state"], "taken")

    def test_a_handoff_left_launching_is_retried_the_next_day(self):
        self.say("2026-11-20T17:00:00+09:00")
        self.press_repeat(2)
        keep = {"handoff": {"state": "launching", "at": "2026-11-20T17:05:00+09:00", "reason": "x", "from_session": SESSION}}
        with open(os.path.join(self.root, ".orca", "cockpit", "keep.json"), "w") as fh:
            json.dump(keep, fh)
        self.assertEqual(json.loads(self.say("2026-11-21T09:00:00+09:00"))["decision"], "block")

    def test_presses_recorded_in_utc_by_the_window_are_counted(self):
        self.say("2026-11-20T17:00:00+09:00")
        self.press_repeat(2, at="2026-11-20T08:10:00.000Z")  # 17:10 JST。窓は toISOString で UTC を書く
        out = json.loads(self.say("2026-11-21T09:00:00+09:00"))
        self.assertEqual(out["decision"], "block")
        self.press_repeat(2, at="2026-11-21T00:10:00.000Z")  # 引き継いだ 09:00 JST より後の 09:10 JST
        self.assertEqual(json.loads(self.say("2026-11-22T09:00:00+09:00", session="s-new"))["decision"], "block")

    def test_a_pass_after_two_failures_keeps_the_handoff_booked(self):
        self.say("2026-11-20T17:00:00+09:00")
        self.now = "2026-11-20T17:30:00+09:00"
        self.fail_twice()
        ok = self.tool("resume", {"next": "続ける", "rulings": [], "permissions": [], "workers": ["ctx_a"], "paths": []})
        self.assertEqual(ok.returncode, 0, ok.stdout)
        out = json.loads(self.say("2026-11-21T09:00:00+09:00"))
        self.assertIn("2 回続けて", out["reason"])
        self.assertNotIn("handoff_due", self.keep())

    def test_one_failure_does_not_hand_off(self):
        self.say("2026-11-20T17:00:00+09:00")
        self.hook("PostCompact", trigger="auto", compact_summary="")
        self.tool("resume", {"next": ""})
        self.assertNotIn("引き継", self.say("2026-11-21T09:00:00+09:00"))
        self.assertFalse(self.launched())

    def test_a_pass_between_single_failures_resets_the_count(self):
        self.say("2026-11-20T17:00:00+09:00")
        self.hook("PostCompact", trigger="auto", compact_summary="")
        self.tool("resume", {"next": ""})
        self.tool("resume", {"next": "続ける", "rulings": [], "permissions": [], "workers": ["ctx_a"], "paths": []})
        self.tool("resume", {"next": ""})
        self.assertNotIn("引き継", self.say("2026-11-21T09:00:00+09:00"))

    def test_two_repeat_presses_hand_off_but_one_does_not(self):
        self.say("2026-11-20T17:00:00+09:00")
        self.press_repeat(1)
        self.assertNotIn("引き継", self.say("2026-11-21T09:00:00+09:00"))
        self.press_repeat(2)
        self.assertNotIn("引き継", self.say("2026-11-21T09:30:00+09:00"))  # 同じ日の 2 回目の発言では引き継がない
        self.assertFalse(self.launched())
        out = json.loads(self.say("2026-11-22T09:00:00+09:00"))
        self.assertEqual(out["decision"], "block")
        self.assertIn("前にも言った", out["reason"])
        # 引き継いだあとは、それより前の押下を数えない
        self.assertNotIn("引き継", self.say("2026-11-23T09:00:00+09:00", session="s-new"))

    def test_a_failed_launch_keeps_the_old_chat_and_says_so(self):
        with open(self.fake_orca, "w") as fh:
            fh.write("#!/bin/sh\necho 'no runtime' >&2\nexit 1\n")
        self.say("2026-11-20T17:00:00+09:00")
        self.press_repeat(2)
        out = self.say("2026-11-21T09:00:00+09:00")
        self.assertIn("引き継ぎを試みたが失敗した", out)
        self.assertIn("【今の順番】", out)
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["prompt"], "おはよう")


class StopNudges(Base):
    def turn(self, prompt):
        self.hook("UserPromptSubmit", prompt=prompt)

    def test_a_permission_in_the_prompt_without_a_ruling_is_nudged_once(self):
        self.turn("dev には入れていいよ")
        out = json.loads(self.hook("Stop", last_assistant_message="入れます"))
        self.assertIn("許可・禁止・撤回らしい言い回し", out["reason"])
        self.assertEqual(self.hook("Stop", last_assistant_message="入れます"), "")

    def test_writing_the_ruling_in_the_turn_passes(self):
        self.turn("push はしないで")
        self.now = "2026-11-21T10:01:00+09:00"
        self.rule(kind="constraint", text="push しない", quote="push はしないで")
        with open(os.path.join(self.root, ".orca", "cockpit", "state.md"), "w") as fh:
            fh.write("R1 を足した")
        self.assertEqual(self.hook("Stop", last_assistant_message="了解"), "")

    def test_a_plain_prompt_is_not_nudged(self):
        self.turn("状況を教えて")
        self.assertEqual(self.hook("Stop", last_assistant_message="こうです"), "")

    def test_a_worker_report_relayed_by_orca_is_not_her_utterance(self):
        # 2026-11-21 に、worker_done の本文の「待って」で止め、発言の記録にも 11 件混ざっていた
        self.turn("状況を教えて")
        self.hook("Stop", last_assistant_message="こうです")
        self.now = "2026-11-21T10:05:00+09:00"
        self.turn("──── From: TERM_0D76 (term_0d76) (worker_done) ────\nSubject: t66\n新しい入力を待っている形にした。OK")
        self.assertEqual(self.hook("Stop", last_assistant_message="取り込みました"), "")
        self.assertEqual([u["prompt"] for u in self.jsonl("utterances.jsonl")], ["状況を教えて"])

    def test_an_urgent_relay_with_a_priority_tag_is_not_her_utterance(self):
        # 2026-11-22 に、[HIGH] の付いた escalation が発言として記録され、本文の「待って」で Stop が止めた。
        # 印は優先度（[URGENT]・[HIGH]）と古い形の印が続けて入りうる（Orca の orcad-server.js の見出しの組み立て）
        self.turn("──── From: STRUCTWORKER_974C (structworker_974c) [HIGH] (escalation) ────\nSubject: Worker stopped\n見直しを待っています。")
        self.assertEqual(self.hook("Stop", last_assistant_message="待ちます"), "")
        for tags in ("[URGENT]", "[HIGH] [LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]", "[LEGACY READ-ONLY]"):
            self.turn("──── From: TERM_A (term_a) %s (question) ────\nSubject: 確認\n待って" % tags)
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_a_memo_over_the_limit_is_asked_to_be_trimmed(self):
        memo = os.path.join(self.root, ".orca", "cockpit", "state.md")
        with open(memo, "w") as fh:
            fh.write("- 13:44 済んだ\n" * 500)  # 9KB
        os.utime(memo, (1, 1))  # このターンで操縦席は動いていないので、古さの促しは出ない
        self.turn("状況を教えて")
        out = json.loads(self.hook("Stop", last_assistant_message="こうです"))
        self.assertIn("目安の 1〜2k トークン（8KB）を超えている", out["reason"])
        self.assertIn("state.history.md", out["reason"])
        with open(memo, "w") as fh:
            fh.write("# 未完了の項目と次の一手\n- t36 を取り込む\n")
        self.now = "2026-11-21T10:01:00+09:00"
        self.turn("次")
        self.assertEqual(self.hook("Stop", last_assistant_message="はい"), "")

    def test_her_own_prompt_that_merely_starts_like_a_relay_is_kept(self):
        self.turn("──── From: の表示を直して")
        self.hook("Stop", last_assistant_message="直します")
        pasted = "──── From: TERM_A (term_a) [TODO] (question) ────\nSubject: x\nこの見出しの [TODO] は何？"
        self.turn(pasted)  # Orca が付けない印の付いた見出しを貼っただけの発言
        self.assertEqual([u["prompt"] for u in self.jsonl("utterances.jsonl")], ["──── From: の表示を直して", pasted])

    def test_a_dec_closed_after_install_without_a_ruling_is_named(self):
        self.turn("状況を教えて")
        self.hook("Stop", last_assistant_message="こうです")
        self.cockpit["cards"][0].update(state="done", resolved_at="2026-11-21T10:05:00+09:00")
        # 送ったら済む送る前（選択肢の無い問い合わせ）は判断ではないので求めない
        self.cockpit["cards"].append({"id": "s1", "rev": 1, "kind": "send", "title": "送った", "state": "done",
                                      "resolved_at": "2026-11-21T10:05:00+09:00"})
        self.write_cockpit()
        self.now = "2026-11-21T10:06:00+09:00"
        self.turn("d1 決めた")
        out = json.loads(self.hook("Stop", last_assistant_message="反映しました"))
        self.assertIn("カード d1 が判断の記録に無い", out["reason"])
        self.assertNotIn("s1", out["reason"])
        self.now = "2026-11-21T10:07:00+09:00"
        self.turn("次")
        self.rule(kind="none", text="実装の細部で残す判断は無い", dec="d1")
        self.assertNotIn("d1", self.hook("Stop", last_assistant_message="はい"))

    def test_a_version_1_cockpit_asks_for_the_migration_after_compact(self):
        self.cockpit = {"workspace": {"name": "テスト"}, "streams": [], "tasks": self.cockpit["tasks"],
                        "items": [{"id": "d1", "kind": "dec", "title": "古い形の判断", "state": "open"}]}
        self.write_cockpit()
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("操縦席が版 1 のままで、カードを読めない。移し替えが要る", text)
        self.assertIn("t1 タスク", text)
        self.assertNotIn("古い形の判断", text)

    def test_an_old_memo_after_the_cockpit_moved_is_not_sent_back(self):
        # R184: 帳簿を書くたびに作業メモの古さで差し戻すと、窓口の会話が事務で埋まった（9:11〜12:07 に差し戻し 16 回）
        memo = os.path.join(self.root, ".orca", "cockpit", "state.md")
        with open(memo, "w") as fh:
            fh.write("古い")
        os.utime(memo, (1, 1))
        self.turn("状況を教えて")
        self.write_cockpit()  # このターンで操縦席が動いた
        self.rule(kind="decision", text="方式は A")
        self.assertEqual(self.hook("Stop", last_assistant_message="更新しました"), "")


class Order(Base):
    """R184・R186: 作業メモの先頭の「今の順番」を、深田さんの発言のターンにはタスクの題つきで、知らせのターンには ID と理由だけで流す。"""

    def memo(self, text):
        with open(os.path.join(self.root, ".orca", "cockpit", "state.md"), "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_her_prompt_gets_the_order_with_the_task_title_but_not_next(self):
        self.memo("## 今の順番\n1. t1 深田さんが急ぎと言った\n   - 補足は数えない\n2. t9 帳簿に無いタスク\n3. t2 済んだら閉じる\n4. t5 4 件目は流さない\n\n  ## 字下げした次の見出し\n- 別の節の行\n")
        out = self.hook("UserPromptSubmit", prompt="状況を教えて")
        self.assertIn("1. t1 深田さんが急ぎと言った（hook を書く）\n", out)
        self.assertIn("2. t9 帳簿に無いタスク\n", out)
        self.assertIn("3. t2 済んだら閉じる（済んだ作業）", out)
        # 帳簿の next は順番と食い違うことがあるので添えない（監査の指摘 2）
        self.assertNotIn("次:", out)
        self.assertNotIn("テストを足す", out)
        self.assertNotIn("t5", out)
        self.assertNotIn("別の節の行", out)
        self.assertNotIn("補足", out)

    def test_an_id_glued_to_the_reason_still_finds_the_task(self):
        # ja-review が「t1 監査」を「t1監査」に詰める。\b では漢字の前で切れず、題が付かなかった
        self.memo("## 今の順番\n1. t1監査の直し\n2. t12 は帳簿に無い\n")
        out = self.hook("UserPromptSubmit", prompt="状況を教えて")
        self.assertIn("1. t1監査の直し（hook を書く）\n", out)
        self.assertIn("2. t12 は帳簿に無い\n", out, "t1 の題を t12 に付けない")

    def test_a_long_row_is_cut_at_120_characters(self):
        self.memo("## 今の順番\n1. t1 " + "理由" * 100 + "\n")
        for prompt in ("状況を教えて", "<task-notification>\nx\n</task-notification>"):
            line = next(l for l in self.hook("UserPromptSubmit", prompt=prompt).split("\n") if l.startswith("1. "))
            self.assertEqual(len(line), 120, prompt)
            self.assertTrue(line.endswith("…"))

    def test_a_memo_without_the_order_asks_for_it(self):
        self.memo("## 目的と受入条件\n- なにか\n")
        self.assertIn("「## 今の順番」が無い", self.hook("UserPromptSubmit", prompt="状況を教えて"))

    def test_relayed_notices_get_only_the_ids_and_reasons(self):
        # R186: 知らせが続く離席中も順番を見失わないよう、ID と理由だけを流す。題・next・件数・念押しは流さない
        self.memo("## 今の順番\n1. t1 急ぎ\n2. t2 その次\n")
        notices = ("──── From: worker (term_1) (worker_done) ────\nSubject: 済\n本文",
                   "<task-notification>\n<status>completed</status>\n</task-notification>",
                   "You have 2 orchestration messages. Run `orca orchestration check --terminal t`.")
        for prompt in notices:
            self.assertEqual(self.hook("UserPromptSubmit", prompt=prompt), "【今の順番】\n1. t1 急ぎ\n2. t2 その次\n", prompt)
        # 見出しが無ければ知らせのターンには何も流さない（書くよう促すのは深田さんの発言のターンだけ）
        self.memo("## 目的と受入条件\n- なにか\n")
        for prompt in notices:
            self.assertEqual(self.hook("UserPromptSubmit", prompt=prompt), "", prompt)

    def test_the_relay_command_tells_a_notice_from_her_prompt(self):
        def relay(prompt):
            return subprocess.run([HOOK, "relay"], input=json.dumps({"prompt": prompt}), text=True, capture_output=True, env=self.env()).returncode
        self.assertEqual(relay("<task-notification>\nx\n</task-notification>"), 0)
        self.assertEqual(relay("状況を教えて"), 1)
        self.assertEqual(subprocess.run([HOOK, "relay"], input="{", text=True, capture_output=True, env=self.env()).returncode, 1)


class EnglishReply(Base):
    """メインの最後の返事が英語主体なら、ターンに 1 回だけ日本語で書き直させる（R55。11/21 に途中の返事約 40 件が英語になった）。"""

    # 11/21 の会話記録にあった返事
    EN = "The coordinator cancelled t85, so I'll only finish the one-column work. Next I'll check whether the same rule is written anywhere else."

    def stop(self, msg, **kw):
        got = self.hook("Stop", last_assistant_message=msg, **kw)
        return json.loads(got)["reason"] if got else ""

    def test_an_english_reply_is_sent_back_once_per_turn(self):
        self.hook("UserPromptSubmit", prompt="状況を教えて")
        self.assertIn("【返事】最後の返事が英語主体（日本語 0 字・英単語 23 語", self.stop(self.EN))
        self.assertNotIn("【返事】", self.stop(self.EN, stop_hook_active=True))
        self.assertNotIn("【返事】", self.stop(self.EN))
        self.hook("UserPromptSubmit", prompt="次")
        self.assertIn("【返事】", self.stop(self.EN))

    def test_it_also_runs_after_another_stop_hook_sent_the_turn_back(self):
        # 操縦席の書き漏れの差し戻し（periodic-reminder.sh）のあとの返事が英語でも止める
        self.hook("UserPromptSubmit", prompt="状況を教えて")
        self.assertIn("【返事】", self.stop(self.EN, stop_hook_active=True))

    def test_japanese_with_code_paths_and_commands_passes(self):
        self.hook("UserPromptSubmit", prompt="状況を教えて")
        msg = ("Stop の hook で `last_assistant_message` を見るように claude/hooks/compaction-keep.py を直し、"
               "Codex review は skip した。\n\n```sh\norca orchestration send --from term_a --type worker_done --subject done\n```\n"
               "> The worker said everything passed and nothing is left to do here.\n"
               "PR は https://github.com/example/repo/pull/12 に出した。")
        self.assertEqual(self.stop(msg), "")

    def test_english_quoted_in_brackets_or_short_replies_pass(self):
        self.hook("UserPromptSubmit", prompt="状況を教えて")
        self.assertEqual(self.stop("Done."), "")
        self.assertEqual(self.stop("worker の報告は「All tests pass and the branch is clean, nothing left to do.」でした。"), "")

    def test_english_with_japanese_quotes_is_still_english(self):
        self.hook("UserPromptSubmit", prompt="状況を教えて")
        msg = 'The "本文をコピー" button now copies in each format, and the 「件名」 line is removed from the body before pasting.'
        self.assertIn("【返事】", self.stop(msg))

    def test_a_worker_under_the_workspace_is_not_checked(self):
        sub = os.path.join(self.root, "worker")
        os.makedirs(os.path.join(sub, ".git"))
        self.hook("UserPromptSubmit", prompt="状況を教えて", cwd=sub)
        self.assertEqual(self.stop(self.EN, cwd=sub), "")


class LedgerGuard(Base):
    """帳簿の直書きを止める hook と、仕分けていない発言の Stop。COCKPIT_LEDGER_GUARD=1 のときだけ効く（窓口が帳簿を移したあとに入れる）。"""

    def setUp(self):
        super().setUp()
        self.ledger = os.path.join(self.root, ".orca", "cockpit.json")
        self.unsorted = []
        self.fake_state = os.path.join(self.root, "fake-state.js")
        self.calls = os.path.join(self.root, "state.calls")
        self.write_state()
        self.migrated(True)

    def migrated(self, yes):
        # 版 3 の帳簿は intake の欄を持つ（R195。移し替えの控え cockpit.v2.json の有無では見ない）
        if yes:
            self.cockpit["intake"] = {"through": "", "none": []}
        else:
            self.cockpit.pop("intake", None)
        self.write_cockpit()

    def write_state(self):
        with open(self.fake_state, "w") as fh:
            fh.write("require('fs').appendFileSync(%s, 'x');console.log(JSON.stringify({checks: {unsorted: %s}}))"
                     % (json.dumps(self.calls), json.dumps(self.unsorted)))

    def on(self, **extra):
        return self.env(**{"COCKPIT_LEDGER_GUARD": "1", "COCKPIT_STATE": self.fake_state, **extra})

    def write_to(self, tool, path, env=None, cwd=None):
        out = self.hook("PreToolUse", env=env, tool_name=tool, cwd=cwd or self.root,
                        tool_input={"file_path": path, "content": "{}", "old_string": "a", "new_string": "b"})
        return json.loads(out)["hookSpecificOutput"] if out else None

    def test_off_by_default(self):
        self.assertIsNone(self.write_to("Write", self.ledger))
        self.unsorted = ["u-3"]
        self.write_state()
        self.hook("UserPromptSubmit", prompt="状況を教えて")
        self.assertEqual(self.hook("Stop", last_assistant_message="こうです"), "")
        self.assertFalse(os.path.exists(self.calls))  # 切っている間は state.ts も呼ばない

    def test_a_workspace_not_yet_moved_to_version_3_is_left_alone(self):
        # 設定は全案件に共通なので、版 3 でない帳簿（intake が無い）では効かせない。移し替えの控えだけがあっても同じ（R195）
        self.migrated(False)
        open(os.path.join(self.root, ".orca", "cockpit.v2.json"), "w").close()
        self.assertIsNone(self.write_to("Write", self.ledger, env=self.on()))
        self.unsorted = ["u-3"]
        self.write_state()
        self.hook("UserPromptSubmit", env=self.on(), prompt="状況を教えて")
        self.assertEqual(self.hook("Stop", env=self.on(), last_assistant_message="こうです"), "")
        self.assertFalse(os.path.exists(self.calls))

    def test_a_turn_started_by_the_previous_hook_is_still_checked(self):
        # 入れ替えた直後は、前の hook が keep.json に turn_at だけを書いたターンの Stop が来る
        self.unsorted = ["u-3"]
        self.write_state()
        with open(os.path.join(self.root, ".orca", "cockpit", "keep.json"), "w") as fh:
            json.dump({"turn_at": self.now, "turn_clock": 1}, fh)
        out = json.loads(self.hook("Stop", env=self.on(), last_assistant_message="はい"))
        self.assertIn("仕分けていない", out["reason"])
        self.assertEqual(self.hook("Stop", env=self.on(), last_assistant_message="はい"), "")

    def test_writing_the_ledger_directly_is_denied_with_the_tool_to_use(self):
        for tool in ("Write", "Edit", "MultiEdit"):
            got = self.write_to(tool, self.ledger, env=self.on())
            self.assertEqual(got["permissionDecision"], "deny", tool)
            self.assertIn("cockpit-write", got["permissionDecisionReason"])
            self.assertIn("references/schema.md「書く道具」", got["permissionDecisionReason"])

    def test_other_files_and_the_users_ops_are_not_denied(self):
        for path in (os.path.join(self.root, ".orca", "cockpit", "state.md"), os.path.join(self.root, "cockpit.json"),
                     os.path.join(self.root, ".orca", "cockpit.json.bak")):
            self.assertIsNone(self.write_to("Write", path, env=self.on()), path)
        self.assertIsNone(self.write_to("Read", self.ledger, env=self.on()))

    def test_a_ledger_made_by_init_without_the_v2_copy_is_guarded(self):
        # cockpit-write init で作った版 3 の帳簿には移し替えの控えが無いが、直書きは止める（R195）
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "cockpit.v2.json")))
        self.assertEqual(self.write_to("Write", self.ledger, env=self.on())["permissionDecision"], "deny")

    def test_the_ledger_guard_command_answers_with_the_same_rule(self):
        # periodic-reminder.sh が未仕分けの出し分けに使う口。0 で効く、1 で効かない
        cmd = lambda env: subprocess.run([HOOK, "ledger-guard", self.root], env=env, capture_output=True).returncode
        self.assertEqual(cmd(self.on()), 0)
        self.assertEqual(cmd(self.env()), 1)
        self.migrated(False)
        self.assertEqual(cmd(self.on()), 1)
        with open(self.ledger, "w") as fh:
            fh.write("{ 壊れた")
        self.assertEqual(cmd(self.on()), 1)

    def test_a_relative_path_or_a_link_to_the_ledger_is_denied(self):
        dot = os.path.join(self.root, ".orca")
        self.assertEqual(self.write_to("Write", "cockpit.json", env=self.on(), cwd=dot)["permissionDecision"], "deny")
        link = os.path.join(self.root, "ledger-link.json")
        os.symlink(self.ledger, link)
        self.assertEqual(self.write_to("Edit", link, env=self.on())["permissionDecision"], "deny")

    def test_another_chat_in_the_same_workspace_does_not_use_up_the_stop(self):
        # 引き継ぎで 2 つのチャットが同じワークスペースにあるとき、片方の Stop がもう片方のターンを消費しない
        self.unsorted = ["u-3"]
        self.write_state()
        self.hook("UserPromptSubmit", env=self.on(), prompt="状況を教えて")
        self.hook("UserPromptSubmit", env=self.on(), prompt="続き", session_id="s-new")
        self.assertIn("仕分けていない", json.loads(self.hook("Stop", env=self.on(), last_assistant_message="はい"))["reason"])
        self.assertIn("仕分けていない", json.loads(self.hook("Stop", env=self.on(), session_id="s-new", last_assistant_message="はい"))["reason"])

    def test_a_worker_under_the_workspace_is_denied_too(self):
        sub = os.path.join(self.root, "worker")
        os.makedirs(os.path.join(sub, ".git"))
        self.assertEqual(self.write_to("Edit", self.ledger, env=self.on(), cwd=sub)["permissionDecision"], "deny")

    def test_unsorted_utterances_stop_the_turn_once(self):
        self.unsorted = ["u-3", {"id": "u-4", "quote": "直して"}]
        self.write_state()
        self.hook("UserPromptSubmit", env=self.on(), prompt="状況を教えて")
        out = json.loads(self.hook("Stop", env=self.on(), last_assistant_message="こうです"))
        self.assertIn("仕分けていない深田さんの発言がある（u-3・u-4）", out["reason"])
        self.assertIn("intake.through", out["reason"])
        self.assertEqual(self.hook("Stop", env=self.on(), last_assistant_message="こうです"), "")

    def test_nothing_unsorted_or_an_unreadable_state_passes(self):
        self.hook("UserPromptSubmit", env=self.on(), prompt="状況を教えて")
        self.assertEqual(self.hook("Stop", env=self.on(), last_assistant_message="こうです"), "")
        self.now = "2026-11-21T10:01:00+09:00"
        self.hook("UserPromptSubmit", env=self.on(COCKPIT_STATE=os.path.join(self.root, "none.js")), prompt="次")
        self.assertEqual(self.hook("Stop", env=self.on(COCKPIT_STATE=os.path.join(self.root, "none.js")), last_assistant_message="はい"), "")


class TidyNudge(Base):
    """窓の整理・棚卸しの指示を反映しないまま残してターンを終えない（t163）。fitf で、合図は届いて読まれたのに、別の依頼と圧縮のあいだに 9 件たまった。"""

    def setUp(self):
        super().setUp()
        self.fake_state = os.path.join(self.root, "fake-state.js")
        self.tidy([])

    def tidy(self, ops):
        # どれが残るかは state.ts（ここでは偽のスクリプト）が決める。hook は操作のログに反映していない tidy があるときだけ state.ts を呼ぶ
        with open(self.fake_state, "w") as fh:
            fh.write("console.log(JSON.stringify({checks: {unapplied_tidy: %s}}))" % json.dumps(ops))
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": [{"op_id": n, "at": "2026-11-21T00:00:00.000Z", "item_id": "", "item_rev": 0, "type": "tidy", "text": "整理"} for n in ops]}, fh)

    def turn(self, prompt="状況を教えて"):
        env = self.env(COCKPIT_STATE=self.fake_state)
        self.hook("UserPromptSubmit", env=env, prompt=prompt)
        out = self.hook("Stop", env=env, last_assistant_message="こうです")
        return json.loads(out)["reason"] if out else ""

    def test_unapplied_tidy_stops_the_turn_and_names_the_ops(self):
        self.tidy([76, 77])
        reason = self.turn()
        self.assertIn("窓の整理・棚卸しの指示 op 76・77 が反映待ち", reason)
        self.assertIn("tidy_ops", reason)
        self.assertIn("何を待っているかを一言書いて終える", reason)

    def test_the_same_ops_are_not_named_again_soon_but_new_ones_are(self):
        self.tidy([76])
        self.assertIn("op 76", self.turn())
        # subagent を待つあいだの知らせのターンでは、同じ指示で続けて止めない
        self.assertEqual(self.turn("──── From: X (x) (status) ────\nSubject: 途中経過"), "")
        self.tidy([76, 79])
        self.assertIn("op 76・79", self.turn())

    def test_an_unreadable_state_keeps_the_mark(self):
        self.tidy([76])
        self.assertIn("op 76", self.turn())
        # state.ts を読めない回（タイムアウトなど）は、何も返さず印も消さない（次の正常な回で 30 分の間を保つ）
        with open(self.fake_state, "w") as fh:
            fh.write("process.exit(1)")
        self.assertEqual(self.turn(), "")
        self.tidy([76])
        self.assertEqual(self.turn(), "")
        # 操作のログを読めない回も同じ
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            fh.write("{壊れた")
        self.assertEqual(self.turn(), "")
        self.tidy([76])
        self.assertEqual(self.turn(), "")

    def test_nothing_unapplied_passes_and_resets(self):
        self.assertEqual(self.turn(), "")
        self.tidy([76])
        self.assertIn("op 76", self.turn())
        self.tidy([])
        self.assertEqual(self.turn(), "")
        self.tidy([76])
        self.assertIn("op 76", self.turn(), "反映して消えたあとに同じ番号が出直したら、また名指しする")


class MainSession(Base):
    """窓口の会話の記録（main-session.json。consult --ask が写す元。設計 11.6 の 4・7）。"""

    def setUp(self):
        super().setUp()
        self.cockpit.update(main={"agent": "claude", "run_id": "run_main"})
        self.write_cockpit()
        with open(self.fake_orca, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\ncase "$*" in *run-current*) echo "{\\"ok\\":true,\\"result\\":{\\"runId\\":\\"$FAKE_RUN\\"}}";; '
                     '*) echo \'{"ok":true,"result":{}}\';; esac\n' % self.orca_log)
    def test_the_main_writes_its_session_and_seat_only_when_its_run_is_the_ledgers(self):
        path = os.path.join(self.root, ".orca", "cockpit", "main-session.json")
        self.hook("UserPromptSubmit", env=self.env(FAKE_RUN="run_other", CLAUDE_CONFIG_DIR="/seatA"), prompt="hi", transcript_path="/t/a.jsonl")
        self.assertFalse(os.path.exists(path))  # 同じ worktree の別の会話（Run が違う）は窓口として書かない
        self.hook("UserPromptSubmit", env=self.env(FAKE_RUN="run_main", CLAUDE_CONFIG_DIR="/seatA"), prompt="hi", transcript_path="/t/a.jsonl")
        with open(path) as fh:
            got = json.load(fh)
        self.assertEqual({k: got[k] for k in ("run_id", "session_id", "transcript_path", "config_dir", "cwd")},
                         {"run_id": "run_main", "session_id": SESSION, "transcript_path": "/t/a.jsonl", "config_dir": "/seatA", "cwd": self.root})
        calls = read(self.orca_log).count("run-current")
        # 変わらなければ Run を引き直さない（毎回の発言を遅らせない）。既定の席に替わったら空で置き換える
        self.hook("UserPromptSubmit", env=self.env(FAKE_RUN="run_main", CLAUDE_CONFIG_DIR="/seatA"), prompt="hi", transcript_path="/t/a.jsonl")
        self.assertEqual(read(self.orca_log).count("run-current"), calls)
        env = self.env(FAKE_RUN="run_main")
        env.pop("CLAUDE_CONFIG_DIR", None)
        self.hook("UserPromptSubmit", env=env, prompt="hi", transcript_path="/t/a.jsonl")
        with open(path) as fh:
            self.assertEqual(json.load(fh)["config_dir"], "")

    def test_a_ledger_without_the_run_writes_no_session(self):
        del self.cockpit["main"]["run_id"]
        self.write_cockpit()
        self.hook("UserPromptSubmit", env=self.env(FAKE_RUN="run_main"), prompt="hi", transcript_path="/t/a.jsonl")
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "cockpit", "main-session.json")))


if __name__ == "__main__":
    unittest.main()
