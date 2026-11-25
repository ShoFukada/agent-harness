#!/usr/bin/env python3
"""compaction-keep.py が、操縦席のあるワークスペースのメインだけで、判断と発言を会話の外に残し、圧縮のあとに組み直して照合することを保証する。

操縦席は一時フォルダの写しで作る（本物の .orca/cockpit.json は読まない・書かない）。新しいチャットは偽の orca で起こしたことにする。
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "compaction-keep.py")
SESSION = "s-main"


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="compaction-keep-test-")
        self.addCleanup(shutil.rmtree, self.root, True)
        os.makedirs(os.path.join(self.root, ".orca", "cockpit"))
        self.cockpit = {
            "version": 2, "workspace": {"name": "テスト"}, "streams": [],
            "tasks": [{"id": "t1", "title": "hook を書く", "state": "run", "next": "テストを足す",
                       "worker": {"task_id": "task_a", "dispatch_id": "ctx_a"}},
                      {"id": "t2", "title": "済んだ作業", "state": "ok", "worker": {"task_id": "task_old", "dispatch_id": "ctx_old"}}],
            "cards": [{"id": "d1", "rev": 1, "kind": "decide", "title": "引き継ぎの方式を決める", "state": "open"},
                      {"id": "w1", "rev": 1, "kind": "send", "title": "上限を聞く", "state": "waiting",
                       "awaiting": {"who": "先方の担当者", "what": "上限", "since": "2026-11-20T10:00:00+09:00"}},
                      {"id": "a1", "rev": 1, "kind": "report", "title": "読んだ報告", "state": "done"}],
        }
        self.write_cockpit()
        self.orca_log = os.path.join(self.root, "orca.log")
        self.fake_orca = os.path.join(self.root, "fake-orca")
        with open(self.fake_orca, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\necho \'{"ok":true}\'\n' % self.orca_log)
        os.chmod(self.fake_orca, 0o755)
        self.now = "2026-11-21T10:00:00+09:00"

    def write_cockpit(self):
        with open(os.path.join(self.root, ".orca", "cockpit.json"), "w", encoding="utf-8") as fh:
            json.dump(self.cockpit, fh, ensure_ascii=False)

    def env(self, **extra):
        # 窓口の設定で入れた切り替えが、テストを走らせる端末から漏れないようにする
        # Orca の端末で走らせても、Orca の外として始める（窓口の判定 orca_main_root が ORCA_WORKTREE_ID を見る）
        env = {k: v for k, v in os.environ.items()
               if k not in ("CONSULT_THREAD", "COCKPIT_LEDGER_GUARD", "COCKPIT_STATE") and not k.startswith("ORCA_")}
        # 本物の state.ts は呼ばない（呼ぶテストは偽のスクリプトを渡す）
        env.update(COMPACTION_KEEP_NOW=self.now, COMPACTION_KEEP_ORCA=self.fake_orca, COCKPIT_STATE=os.path.join(self.root, "no-state.js"))
        env.update(extra)
        return env

    def hook(self, event, env=None, **payload):
        payload = {"hook_event_name": event, "session_id": SESSION, "cwd": self.root, **payload}
        done = subprocess.run([HOOK], input=json.dumps(payload), text=True, capture_output=True, env=env or self.env())
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def tool(self, cmd, data=None):
        return subprocess.run([HOOK, cmd, self.root], input=json.dumps(data) if data is not None else "", text=True,
                              capture_output=True, env=self.env())

    def rule(self, **r):
        done = self.tool("rule", r)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.split()[1].rstrip(":")

    def jsonl(self, name):
        p = os.path.join(self.root, ".orca", "cockpit", name)
        if not os.path.exists(p):
            return []
        with open(p, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh]

    def keep(self):
        p = os.path.join(self.root, ".orca", "cockpit", "keep.json")
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)


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


class ConsultBase(Base):
    """カードの相談のテストの操縦席（d21 と、関係する判断・しない判断 R1〜R6）と道具。"""

    def setUp(self):
        super().setUp()
        self.cockpit.update(
            streams=[{"id": "s7", "title": "窓の作り直し", "form": "cowork"}],
            requests=[{"id": "r30", "title": "凡例を減らす", "utterances": [{"id": "u-900", "quote": "凡例多すぎ"}],
                       "done_when": ["凡例の形が決まる"], "tasks": ["t2"]}])
        self.cockpit["cards"].append({"id": "d21", "rev": 1, "kind": "consult", "title": "凡例の減らし方", "state": "open",
                                      "stream": "s7", "tasks": ["t1"], "request_id": "r30", "issue": "凡例を何個出すか", "stance": "6 つ"})
        self.write_cockpit()
        self.rule(kind="constraint", text="返事は日本語", quote="日本語で")              # R1 全体の制約
        self.rule(kind="decision", text="d21 の凡例は 6 つまで")                         # R2 カードを挙げる
        self.rule(kind="decision", text="済の条件を変える", affects=["t1"])              # R3 結ばれたタスクに影響
        self.rule(kind="decision", text="d2 と d210 の話")                               # R4 関係しない（id の一部だけ）
        self.rule(kind="decision", text="仕事の判断", dec="s7")                          # R5 仕事を dec で挙げる
        self.rule(kind="decision", text="依頼のタスクの判断", affects=["t2"])            # R6 依頼のタスクに影響

    def consult_env(self, **extra):
        return self.env(CONSULT_THREAD="1", CONSULT_CARD="%s#d21" % self.root, **extra)

    def say(self, prompt, **extra):
        return self.hook("UserPromptSubmit", env=self.consult_env(), prompt=prompt, session_id="s-consult", **extra)

    def launch(self, seen="R6", rev=1):
        return self.say("【相談の知らせ】カードの相談を始める\nrev: %d\nrulings_seen: %s\n本文" % (rev, seen))

    def write_memo(self, *returns):
        os.makedirs(os.path.join(self.root, ".orca", "consult"), exist_ok=True)
        body = "".join("### %s（送った）\n```json\n%s\n```\n" % (r["return_id"], json.dumps(r, ensure_ascii=False)) for r in returns)
        with open(os.path.join(self.root, ".orca", "consult", "d21.md"), "w", encoding="utf-8") as fh:
            fh.write("# 相談｜テスト｜d21\n## 決めたこと\n```json\n{\"return_id\": \"d21-9\"}\n```\n## 窓口に返したもの\n" + body + "## 残っている論点\n")

    def unreflected(self):
        done = self.tool_args("unreflected", "--json")
        self.assertEqual(done.returncode, 0, done.stderr)
        return {x["id"]: x["missing"] for x in json.loads(done.stdout)}

    def tool_args(self, *args):
        return subprocess.run([HOOK, args[0], self.root, *args[1:]], text=True, capture_output=True, env=self.env())


class ConsultCard(ConsultBase):
    """カードの相談（claude/bin/consult --card が CONSULT_CARD を付けて立てる端末）の発言の記録・流し込み・返しの照合（設計 10.3・10.7）。"""

    def test_her_words_in_the_consult_are_recorded_with_the_card_without_the_main_role(self):
        self.launch()
        out = self.say("案 A で。あと見積書も送って")
        [u] = self.jsonl("utterances.jsonl")
        self.assertEqual((u["id"], u["card"], u["session"], u["prompt"]), ("u-1", "d21", "s-consult", "案 A で。あと見積書も送って"))
        self.assertNotIn("メイン", out)
        # 圧縮・Stop の hook はメインのもので、相談では動かない
        self.assertEqual(self.hook("Stop", env=self.consult_env(), session_id="s-consult", last_assistant_message="どうしますか？"), "")
        self.assertEqual(self.hook("SessionStart", env=self.consult_env(), session_id="s-consult", source="compact"), "")

    # Orca のチャットで立てた相談（環境変数を渡せないので、最初の指示の印と合言葉で会話 id を登録する）
    TOKEN = "0123456789abcdef0123456789abcdef"  # gitleaks:allow 試験の合言葉の固定値

    def chat_say(self, prompt, chat="chat-1", **extra):
        return self.hook("UserPromptSubmit", env=self.env(ORCA_AGENT_SESSION_ID=chat), prompt=prompt, session_id="s-" + chat, **extra)

    def chat_launch(self, token=TOKEN, chat="chat-1"):
        os.makedirs(os.path.join(self.root, ".orca", "consult"), exist_ok=True)
        with open(os.path.join(self.root, ".orca", "consult", ".d21.chat-token"), "w") as fh:
            fh.write(self.TOKEN)
        return self.chat_say("【相談の知らせ】カードの相談を始める\n相談の印: d21#%s\nrev: 1\nrulings_seen: R6\n本文" % token, chat)

    def chats(self):
        p = os.path.join(self.root, ".orca", "consult", "chats.json")
        return json.loads(read(p)) if os.path.exists(p) else {}

    def test_a_chat_launched_with_the_mark_is_registered_and_treated_as_the_card_consult(self):
        out = self.chat_launch()
        self.assertNotIn("メイン", out)
        self.assertEqual({k: v["card"] for k, v in self.chats().items()}, {"chat-1": "d21"})
        self.chat_say("案 A で")
        [u] = self.jsonl("utterances.jsonl")
        self.assertEqual((u["card"], u["prompt"]), ("d21", "案 A で"))
        self.assertEqual(self.keep()["consults"]["d21"]["seen"], 6)
        done = subprocess.run([HOOK, "rule", self.root], input=json.dumps({"kind": "decision", "text": "x"}), text=True,
                              capture_output=True, env=self.env(ORCA_AGENT_SESSION_ID="chat-1"), cwd=self.root)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("相談スレッドは判断の記録を書かない", done.stderr)
        # 操縦席の外に cd してから root を指しても同じ
        done = subprocess.run([HOOK, "rule", self.root], input=json.dumps({"kind": "decision", "text": "x"}), text=True,
                              capture_output=True, env=self.env(ORCA_AGENT_SESSION_ID="chat-1"), cwd="/")
        self.assertIn("相談スレッドは判断の記録を書かない", done.stderr)

    def test_the_launch_pasted_again_into_the_main_chat_does_not_register_it(self):
        self.chat_launch()
        self.chat_say("【相談の知らせ】カードの相談を始める\n相談の印: d21#%s\nrev: 1\nrulings_seen: R6\n本文" % self.TOKEN, chat="main")
        self.assertEqual(list(self.chats()), ["chat-1"])
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "consult", ".d21.chat-token")))

    def test_a_wrong_token_or_a_mark_without_the_launch_head_registers_nothing(self):
        self.chat_launch(token="f" * 32)
        self.chat_say("相談の印: d21#%s" % self.TOKEN, chat="chat-2")
        self.assertEqual(self.chats(), {})
        self.assertNotIn("card", (self.jsonl("utterances.jsonl") or [{}])[-1])

    def test_a_broken_or_unknown_card_env_records_nothing(self):
        for v in ("%s" % self.root, "/nowhere#d21", "%s#../x" % self.root):
            self.hook("UserPromptSubmit", env=self.env(CONSULT_THREAD="1", CONSULT_CARD=v), prompt="相談")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_the_context_has_the_card_its_request_tasks_stream_and_the_related_rulings(self):
        done = self.tool_args("consult-context", "d21")
        self.assertEqual(done.returncode, 0, done.stderr)
        text = done.stdout
        for part in ("rev: 1", "rulings_seen: R6", '"issue": "凡例を何個出すか"', "依頼 r30", "u-900「凡例多すぎ」", "済の条件 1: 凡例の形が決まる",
                     "- t1（run）: hook を書く", "- t2（ok）", "仕事 s7: 窓の作り直し（形 cowork）"):
            self.assertIn(part, text)
        got = [l.split()[1] for l in text.splitlines() if l.startswith("- R")]
        self.assertEqual(sorted(got), ["R1", "R2", "R3", "R5", "R6"])
        # カードや仕事を挙げる判断を、全体の制約より先に並べる（上限で切るときに残す）
        self.assertEqual(got[-1], "R1")

    def test_a_revoked_constraint_is_not_in_the_context_but_its_revoke_is_new_since(self):
        self.rule(kind="revoke", text="英語でよくなった", quote="英語でいい", supersedes=["R1"])  # R7
        self.rule(kind="decision", text="関係しない")                                           # R8
        text = self.tool_args("consult-context", "d21").stdout
        self.assertNotIn("返事は日本語", text)
        since = self.tool_args("consult-context", "d21", "--since", "R6").stdout
        self.assertEqual([l.split()[1] for l in since.splitlines()], ["R7"])
        self.assertEqual(self.tool_args("consult-context", "d21", "--since", "R8").stdout.strip(), "- なし")

    def test_a_long_context_keeps_the_card_rulings_and_names_the_dropped_ones(self):
        for i in range(60):
            self.rule(kind="constraint", text="長い制約 %d " % i + "あ" * 150, quote="原文")
        text = self.tool_args("consult-context", "d21").stdout
        self.assertLessEqual(len(text), 8200)
        self.assertIn("d21 の凡例は 6 つまで", text)
        self.assertRegex(text, r"ほか \d+ 件（R\d+・.*）は長さの上限で省いた。要るときに .*rulings.jsonl")

    def test_an_unknown_card_is_refused(self):
        done = self.tool_args("consult-context", "d99")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("d99 が帳簿に無い", done.stderr)

    def test_rulings_and_a_new_rev_since_the_last_turn_are_announced_once(self):
        self.launch(seen="R5")  # 起動の指示の文脈は R5 までを読んだ
        self.rule(kind="constraint", text="本番は禁止", quote="本番だめ")                    # R7
        self.rule(kind="decision", text="d2 だけの話")                                      # R8
        self.cockpit["cards"][-1]["rev"] = 2
        self.write_cockpit()
        out = self.say("続けて")
        self.assertIn("R6 [decision] 依頼のタスクの判断", out)
        self.assertIn("R7 [constraint] 本番は禁止", out)
        self.assertNotIn("d2 だけの話", out)
        self.assertIn("rulings_seen に書く値は R8", out)
        self.assertIn("rev が 1 から 2 に変わった", out)
        self.assertEqual(self.say("次"), "")
        self.cockpit["cards"][-1]["state"] = "done"
        self.write_cockpit()
        self.assertIn("d21 が片付いた", self.say("まだある？"))

    def test_the_consult_cannot_write_rulings(self):
        done = subprocess.run([HOOK, "rule", self.root], input=json.dumps({"kind": "decision", "text": "x"}), text=True,
                              capture_output=True, env=self.consult_env())
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("窓口に返す", done.stderr)
        self.assertEqual(len(self.jsonl("rulings.jsonl")), 6)

    def test_main_and_consult_writing_at_once_get_distinct_ids_and_sorting_one_leaves_the_other(self):
        procs = []
        for i in range(8):
            for env, who in ((self.env(), "main"), (self.consult_env(), "consult")):
                payload = {"hook_event_name": "UserPromptSubmit", "session_id": who, "cwd": self.root, "prompt": "%s %d" % (who, i)}
                procs.append(subprocess.Popen([HOOK], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, env=env, text=True))
                procs[-1].stdin.write(json.dumps(payload))
                procs[-1].stdin.close()
        for p in procs:
            self.assertEqual(p.wait(), 0)
        rows = self.jsonl("utterances.jsonl")
        self.assertEqual([u["id"] for u in rows], ["u-%d" % n for n in range(1, 17)])
        self.assertEqual(sum(1 for u in rows if u.get("card") == "d21"), 8)
        # 窓口が自分の発言だけを仕分けて through を進めても、相談の発言は仕分けていないまま残る（state.ts の unsortedOf と同じ規則の偽物）
        mine = [u["id"] for u in rows if not u.get("card")]
        self.cockpit["intake"] = {"through": mine[-1], "none": mine}
        self.write_cockpit()
        fake = os.path.join(self.root, "fake-state.js")
        with open(fake, "w") as fh:
            fh.write(FAKE_UNSORTED)
        got = json.loads(subprocess.run(["node", fake, self.root], capture_output=True, text=True, check=True).stdout)["checks"]["unsorted"]
        self.assertEqual(sorted(got), sorted(u["id"] for u in rows if u.get("card") == "d21"))

    def test_a_return_stays_unreflected_until_both_the_rulings_and_the_ledger_have_it(self):
        ret = {"return_id": "d21-1", "card": "d21", "rev": 1, "rulings_seen": "R6", "choice": None,
               "decisions": [{"text": "凡例は 6 つ", "quote": "6 つでいい", "utterance": "u-3"}], "requests": [], "open": [], "affects": []}
        self.write_memo(ret)
        # 別の節の塊（d21-9）は返しではない
        self.assertEqual(self.unreflected(), {"d21-1": ["判断の記録", "帳簿"]})
        # 判断を書いた直後に止まり、再開で同じ返しをもう一度処理しても、判断は 1 件
        for _ in range(2):
            done = subprocess.run([HOOK, "rule", self.root], text=True, capture_output=True, env=self.env(),
                                  input=json.dumps({"kind": "decision", "text": "凡例は 6 つ", "quote": "6 つでいい", "dec": "d21", "from_return": "d21-1"}))
            self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([r["id"] for r in self.jsonl("rulings.jsonl") if r.get("from_return") == "d21-1"], ["R7"])
        self.assertIn("記録済み", done.stdout)
        self.assertEqual(self.unreflected(), {"d21-1": ["帳簿"]})
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("- d21-1（カード d21。無いもの: 帳簿。", text)
        self.cockpit["cards"][-1]["from_returns"] = ["d21-1"]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), {})
        self.assertNotIn("反映していない", json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"])

    def test_a_card_moved_to_the_archive_still_counts_as_reflected(self):
        self.write_memo({"return_id": "d21-2", "card": "d21"})
        self.rule(kind="none", text="版違いで choice は保留、依頼だけ受けた", dec="d21", from_return="d21-2")
        with open(os.path.join(self.root, ".orca", "cockpit.archive.json"), "w") as fh:
            json.dump({"cards": [{"id": "d21", "from_returns": ["d21-2"]}]}, fh)
        self.assertEqual(self.unreflected(), {})

    def test_a_bad_return_id_is_refused(self):
        done = subprocess.run([HOOK, "rule", self.root], text=True, capture_output=True, env=self.env(),
                              input=json.dumps({"kind": "decision", "text": "x", "from_return": "d21"}))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("return_id", done.stderr)

    def test_a_held_return_stays_named_until_the_consult_returns_again(self):
        self.write_memo({"return_id": "d21-1", "card": "d21"})
        self.rule(kind="none", text="rev 違いで選択を保留、依頼は受けた", dec="d21", from_return="d21-1")
        self.cockpit["cards"][-1].update(from_returns=["d21-1"], held_returns=["d21-1", "d21-7"])
        self.write_cockpit()
        # d21-7 は相談がメモに書き損ねた返し
        self.assertEqual(self.unreflected(), {"d21-1": ["保留"], "d21-7": ["保留"]})
        self.cockpit["cards"][-1]["held_returns"] = []
        self.write_cockpit()
        self.assertEqual(self.unreflected(), {})

    def test_her_words_quoting_the_notice_mark_are_still_recorded(self):
        self.launch()
        self.say("【相談の知らせ】って何？")
        self.say("【相談の知らせ】反映済み d21-1（判断 R7 と依頼 r31）")
        self.assertEqual([u["prompt"] for u in self.jsonl("utterances.jsonl")], ["【相談の知らせ】って何？"])

    def test_a_long_card_field_is_cut_with_where_to_read_it(self):
        self.cockpit["cards"][-1]["context"] = {"what": "長い" * 6000}
        self.write_cockpit()
        text = self.tool_args("consult-context", "d21").stdout
        self.assertLess(len(text), 8200)
        self.assertIn("…（以下略。全文は 帳簿のカード d21 の欄 .context.what）", text)
        self.assertIn("R2 [decision] d21 の凡例は 6 つまで", text)

    def test_the_window_resuming_a_half_written_return_does_not_hold_it_for_its_own_rows(self):
        self.rule(kind="decision", text="d21 は案 A", dec="d21", from_return="d21-1")  # R7: 前の試みで書いた
        self.rule(kind="decision", text="d21 とは別の制約の話", dec="d21")            # R8: ほかで増えた
        got = self.tool_args("consult-context", "d21", "--since", "R6", "--return", "d21-1").stdout
        self.assertEqual([l.split()[1] for l in got.splitlines()], ["R8"])
        self.assertEqual(self.tool_args("consult-context", "d21", "--since", "R7", "--return", "d21-1").stdout.split()[1], "R8")

    def test_a_hold_on_a_closed_card_is_still_named(self):
        self.cockpit["cards"][-1].update(state="done", from_returns=["d21-1"], held_returns=["d21-1"])
        self.write_cockpit()
        self.assertEqual(self.unreflected(), {"d21-1": ["保留"]})

    def test_the_window_notices_in_the_documented_forms_are_not_her_words(self):
        self.launch()
        for notice in ("【相談の知らせ】R81・R82が増えた。d21-1 の選択と判断は保留した",
                       "【相談の知らせ】R81 が増えた。確かめて",
                       "【相談の知らせ】rev 4 に変わった。d21-1 の選択と判断は保留した",
                       "【相談の知らせ】反映済み d21-1（カードが片付いたので保留を解いた）"):
            self.say(notice)
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_a_long_condition_of_the_request_is_cut(self):
        self.cockpit["requests"][0]["done_when"] = ["条件" * 5000]
        self.write_cockpit()
        text = self.tool_args("consult-context", "d21").stdout
        self.assertIn("全文は 帳簿の依頼 r30 の done_when[0]", text)
        self.assertIn("R2 [decision] d21 の凡例は 6 つまで", text)


class ReturnRecord(ConsultBase):
    """カードの相談の返しの記録（.orca/consult/<カード id>.returns.jsonl）と consult-return。
    窓口の反映は cockpit skill の references/consult.md「カードの相談」の 1〜6 を、窓口が読む道具（unreflected・consult-context・
    返しの記録）だけでなぞる。古い形は、切り替え前の相談のタブが自分で番号を付けてメモに書いた返し。"""

    FORMS = ("old", "new")

    def setUp(self):
        super().setUp()
        self.cockpit["main"] = {"agent": "claude", "run_id": "run_main"}
        self.write_cockpit()
        with open(self.fake_orca, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\necho \'{"ok":true,"result":{"message":{"id":"msg_7"}}}\'\n' % self.orca_log)
        self.memo_rets = []

    def ret(self, **over):
        return {"card": "d21", "rev": 1, "rulings_seen": self.seen(), "choice": None, "decisions": [], "requests": [], "open": [], "affects": [], **over}

    def seen(self):
        return "R%d" % len(self.jsonl("rulings.jsonl"))

    def consult_return(self, ret, card="d21"):
        return subprocess.run([HOOK, "consult-return", self.root, card], input=json.dumps(ret, ensure_ascii=False),
                              text=True, capture_output=True, env=self.consult_env())

    def save(self, form, ret):
        """old: 切り替え前の相談のタブが、自分で付けた番号（ret の return_id）でメモに書く。new: consult-return に番号なしで渡す。"""
        if form == "old":
            self.memo_rets.append(ret)
            self.write_memo(*self.memo_rets)
            return ret["return_id"]
        done = self.consult_return({k: v for k, v in ret.items() if k != "return_id"})
        self.assertEqual(done.returncode, 0, done.stderr)
        head, sent = done.stdout.splitlines()
        self.assertEqual(sent, "message msg_7")
        return head.split()[1]

    def sends(self):
        return [l for l in read(self.orca_log).splitlines() if l.startswith("orchestration send")] if os.path.exists(self.orca_log) else []

    def record(self):
        p = os.path.join(self.root, ".orca", "consult", "d21.returns.jsonl")
        return [json.loads(l) for l in read(p).splitlines()] if os.path.exists(p) else []

    def card(self):
        return self.cockpit["cards"][-1]

    def requests_from(self, utterance):
        return [r for r in self.cockpit["requests"] if any(u["id"] == utterance for u in r.get("utterances") or [])]

    def reflect(self, rid, stop_after=None):
        """窓口が返し rid を反映する（consult.md の 1〜6）。返しの本文は unreflected が指す返しの記録から読む。"""
        card = self.card()
        if rid in card.get("from_returns", []):
            return "反映済み"
        entry = next(x for x in json.loads(self.tool_args("unreflected", "--json").stdout) if x["id"] == rid)
        row = next(r for r in (json.loads(l) for l in read(entry["returns"]).splitlines()) if r.get("return_id") == rid)
        since = self.tool_args("consult-context", "d21", "--since", row["rulings_seen"], "--return", rid).stdout.strip()
        held = row["rev"] != card["rev"] or since != "- なし"
        if row.get("replaces") and row["replaces"] not in card.get("held_returns", []):
            held = True
        if held:
            self.rule(kind="none", text="版違いか増えた判断で選択と判断を保留、依頼は受けた", dec="d21", from_return=rid)
        elif not (row["decisions"] or row.get("choice")):
            self.rule(kind="none", text="受ける判断は無い。依頼と論点を受けた", dec="d21", from_return=rid)
        else:
            for d in row["decisions"]:
                self.rule(kind="decision", text=d["text"], quote=d["quote"], dec="d21", from_return=rid)
            if row.get("choice"):
                self.rule(kind="decision", text="d21 は案 %s" % row["choice"], dec="d21", from_return=rid)
        if stop_after == "rule":
            return "中断"
        for q in row["requests"]:
            if not self.requests_from(q["utterance"]):
                self.cockpit["requests"].append({"id": "r%d" % (31 + len(self.cockpit["requests"])), "title": q["quote"],
                                                 "utterances": [{"id": q["utterance"], "quote": q["quote"]}], "from_return": rid})
        card["from_returns"] = card.get("from_returns", []) + [rid]
        card["held_returns"] = [x for x in card.get("held_returns", []) if x != row.get("replaces")] + ([rid] if held else [])
        self.write_cockpit()
        return "保留" if held else "反映"

    def from_return(self, rid):
        return [(r["kind"], r["text"]) for r in self.jsonl("rulings.jsonl") if r.get("from_return") == rid]

    # ---- consult-return の形と出力 ----

    def test_consult_return_numbers_saves_and_sends_the_return(self):
        done = self.consult_return(self.ret(return_id="d21-9", decisions=[{"text": "凡例は 4 つ", "quote": "4 つで", "utterance": "u-3"}]))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, "return_id d21-1\nmessage msg_7\n")  # 相手が書いた番号は使わない
        [row] = [r for r in self.record() if "return_id" in r]
        self.assertEqual((row["return_id"], row["card"], row["decisions"][0]["quote"]), ("d21-1", "d21", "4 つで"))
        log = read(self.orca_log)
        self.assertIn("--to run:run_main", log)
        self.assertIn("相談 d21: 返し d21-1", log)
        self.assertIn('{"return_id": "d21-1", "card": "d21", "rev": 1', log)
        self.assertNotIn("saved_at", log)
        # 相談のメモは返しに使わない（無くてよく、作りもしない）
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "consult", "d21.md")))

    def test_consult_return_refuses_a_return_the_main_cannot_reflect_and_saves_nothing(self):
        good = {"decisions": [{"text": "凡例は 4 つ", "quote": "4 つで", "utterance": "u-3"}]}
        for broken, why in (({"rev": None}, "rev"), ({"card": "d1"}, "card は相談しているカードの id（d21）"),
                            ({"decisions": [{"text": "4 つ", "quote": "4 つ"}]}, "utterance"), ({"rulings_seen": "80"}, "rulings_seen"),
                            ({"replaces": "d1-1"}, "replaces"), ({"decisions": [], "choice": None}, "どれも空"),
                            ({"op": 99}, "op 99 はこのカード（d21）の操作ではない")):
            done = self.consult_return(self.ret(**{**good, **broken}))
            self.assertNotEqual(done.returncode, 0, broken)
            self.assertIn(why, done.stderr, broken)
        self.assertEqual(self.consult_return(self.ret(**good), card="zz9").returncode, 1)
        self.assertEqual([r for r in self.record() if "return_id" in r], [])
        self.assertFalse(os.path.exists(self.orca_log))
        # 選択だけの返しは受ける
        self.assertEqual(self.consult_return(self.ret(choice="a")).returncode, 0)

    def test_without_the_main_run_the_return_is_saved_and_the_reason_is_printed(self):
        del self.cockpit["main"]
        self.write_cockpit()
        done = self.consult_return(self.ret(open=["色"]))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.splitlines(), ["return_id d21-1", "送れなかった: 窓口の Run が帳簿（main.run_id）に無い。窓口は開始・再開のときに返しの記録から拾う"])
        self.assertEqual(self.unreflected(), {"d21-1": ["判断の記録", "帳簿"]})

    def test_the_memo_is_imported_once_and_a_conflicting_block_is_not(self):
        # 切り替え前に 2 つのタブが同じ d21-7 を別の依頼で書いた
        self.write_memo({"return_id": "d21-7", "card": "d21", "rev": 1, "requests": [{"quote": "図も", "utterance": "u-1"}]},
                        {"return_id": "d21-7", "card": "d21", "rev": 1, "requests": [{"quote": "表も", "utterance": "u-2"}]},
                        {"return_id": "d21-3", "rev": 1})
        done = self.tool_args("unreflected", "--json")
        self.assertIn("return_id d21-7 は返しの記録に中身の違う返しがある", done.stderr)
        self.assertEqual([x["id"] for x in json.loads(done.stdout)], ["d21-7", "d21-3"])
        rows = self.record()
        self.assertEqual([r.get("return_id") for r in rows], ["d21-7", "d21-3", None])
        self.assertEqual(rows[1]["card"], "d21")  # card の無い塊はメモのカード
        self.assertEqual(rows[-1]["skipped"][0]["return_id"], "d21-7")
        # 取り込みのあとはメモを読まない（メモを書き直しても、2 回目は取り込まない）
        self.write_memo({"return_id": "d21-20", "card": "d21", "rev": 1})
        self.assertEqual(sorted(self.unreflected()), ["d21-3", "d21-7"])
        self.assertEqual(len(self.record()), 3)
        self.assertEqual(self.save("new", self.ret(open=["色"])), "d21-8")

    def test_a_memo_that_cannot_be_read_is_not_marked_as_imported(self):
        self.write_memo({"return_id": "d21-4", "card": "d21", "rev": 1, "open": ["色"]})
        memo = os.path.join(self.root, ".orca", "consult", "d21.md")
        os.chmod(memo, 0)
        self.addCleanup(os.chmod, memo, 0o644)
        done = self.tool_args("unreflected", "--json")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("返しの記録を読めない", done.stderr)
        self.assertEqual(self.record(), [])
        self.assertNotEqual(self.consult_return(self.ret(open=["形"])).returncode, 0)
        os.chmod(memo, 0o644)
        self.assertEqual(self.unreflected(), {"d21-4": ["判断の記録", "帳簿"]})
        self.assertEqual(self.save("new", self.ret(open=["形"])), "d21-5")

    def test_fields_the_tool_writes_are_not_taken_from_the_return(self):
        done = self.consult_return(self.ret(open=["色"], skipped=1, memo_imported="x", saved_at="昔", imported_from="/x"))
        self.assertEqual(done.returncode, 0, done.stderr)
        [row] = [r for r in self.record() if "return_id" in r]
        self.assertNotIn("skipped", row)
        self.assertNotIn("memo_imported", row)
        self.assertNotEqual(row["saved_at"], "昔")
        self.assertEqual(self.save("new", self.ret(open=["形"])), "d21-2")

    def test_a_card_whose_id_looks_like_a_question_is_still_a_card(self):
        self.cockpit["cards"].append({"id": "ask3", "rev": 2, "kind": "consult", "title": "名前が質問に似たカード", "state": "open"})
        self.write_cockpit()
        done = self.consult_return(self.ret(card="ask3", rev=2, choice="a"), card="ask3")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.splitlines()[0], "return_id ask3-1")
        self.assertTrue(os.path.exists(os.path.join(self.root, ".orca", "consult", "ask3.returns.jsonl")))
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "consult", "ask-ask3.returns.jsonl")))
        self.assertIn("相談 ask3: 返し ask3-1", read(self.orca_log))

    # ---- 試験 ①〜④（古い形と新しい形の両方で） ----

    def test_1_a_choice_given_before_the_card_changed_is_held_and_its_request_arrives_once(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                said = {"choice": "a", "decisions": [{"text": "案 A にする", "quote": "Aで。資料も作って", "utterance": "u-5"}],
                        "requests": [{"quote": "資料も作って", "utterance": "u-5"}]}
                r1 = self.save(form, self.ret(return_id="d21-1", **said))
                self.card()["rev"] = 2  # 反映の前にカードが改訂された
                self.write_cockpit()
                self.assertEqual(self.unreflected(), {r1: ["判断の記録", "帳簿"]})
                self.assertEqual(self.reflect(r1), "保留")
                self.assertEqual(self.from_return(r1), [("none", "版違いか増えた判断で選択と判断を保留、依頼は受けた")])
                self.assertEqual(self.unreflected(), {r1: ["保留"]})
                self.assertEqual(self.reflect(r1), "反映済み")  # 同じ返しがもう一度届いた
                # 相談が読み直して返し直す（切り替えのあとは consult-return）
                r2 = self.save("new", self.ret(rev=2, replaces=r1, **said))
                self.assertEqual(r2, "d21-2")
                self.assertEqual(self.reflect(r2), "反映")
                self.assertEqual(self.from_return(r2), [("decision", "案 A にする"), ("decision", "d21 は案 a")])
                self.assertEqual(len(self.requests_from("u-5")), 1)
                self.assertEqual(self.requests_from("u-5")[0]["from_return"], r1)
                self.assertEqual(self.unreflected(), {})

    def test_2_a_reflection_stopped_after_the_rulings_resumes_once_even_if_the_memo_went_back(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                r1 = self.save(form, self.ret(return_id="d21-1", decisions=[{"text": "凡例は 4 つ", "quote": "4 つで。見積も出して", "utterance": "u-7"}],
                                              requests=[{"quote": "見積も出して", "utterance": "u-7"}]))
                self.assertEqual(self.reflect(r1, stop_after="rule"), "中断")
                self.write_memo()  # 相談が古い版のメモをもとに書き直し、返しの節が消えた
                self.assertEqual(self.unreflected(), {r1: ["帳簿"]})
                [entry] = json.loads(self.tool_args("unreflected", "--json").stdout)
                [row] = [r for r in (json.loads(l) for l in read(entry["returns"]).splitlines()) if r.get("return_id") == r1]
                self.assertEqual(row["requests"], [{"quote": "見積も出して", "utterance": "u-7"}])
                self.assertEqual(self.reflect(r1), "反映")
                self.assertEqual(self.from_return(r1), [("decision", "凡例は 4 つ")])
                self.assertEqual(len(self.requests_from("u-7")), 1)
                self.assertEqual(self.unreflected(), {})

    def test_3_the_same_return_twice_stops_as_reflected_and_a_reworded_answer_to_one_hold_keeps_one_number(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                r1 = self.save(form, self.ret(return_id="d21-1", decisions=[{"text": "凡例は 4 つ", "quote": "4 つで", "utterance": "u-3"}]))
                r2 = self.save(form, self.ret(return_id="d21-2", choice="b"))
                self.assertEqual(self.reflect(r1), "反映")
                rows, ledger = self.jsonl("rulings.jsonl"), json.dumps(self.cockpit)
                self.assertEqual(self.reflect(r1), "反映済み")
                self.assertEqual((self.jsonl("rulings.jsonl"), json.dumps(self.cockpit)), (rows, ledger))
                self.assertEqual(self.reflect(r2), "保留")  # r1 の判断が増えた
                sent = len(self.sends())
                first = self.consult_return(self.ret(replaces=r2, choice="b", decisions=[{"text": "凡例は 5 つにする", "quote": "B で", "utterance": "u-4"}]))
                again = self.consult_return(self.ret(replaces=r2, choice="b", decisions=[{"text": "凡例を 5 個にする", "quote": "B で", "utterance": "u-4"}]))
                self.assertEqual(first.stdout, "return_id d21-3\nmessage msg_7\n")
                self.assertEqual(again.stdout, first.stdout)
                self.assertIn("新しい番号を付けずに送り直す", again.stderr)
                self.assertEqual([r.get("replaces") for r in self.record() if "return_id" in r], [None, None, r2])
                self.assertEqual(len(self.sends()), sent + 2)
                self.assertEqual(self.reflect("d21-3"), "反映")
                self.assertEqual(self.from_return("d21-3"), [("decision", "凡例は 5 つにする"), ("decision", "d21 は案 b")])
                self.assertEqual(self.card()["held_returns"], [])
                self.assertEqual(self.unreflected(), {})

    def test_4_two_returns_saved_at_once_get_their_own_numbers_and_both_requests_arrive(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                if form == "old":
                    self.save(form, self.ret(return_id="d21-1", open=["色"]))
                asks = [self.ret(requests=[{"quote": q, "utterance": u}]) for q, u in (("図を描いて", "u-11"), ("表も作って", "u-12"))]
                procs = [subprocess.Popen([HOOK, "consult-return", self.root, "d21"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True, env=self.consult_env()) for _ in asks]
                outs = [p.communicate(json.dumps(a, ensure_ascii=False))[0] for p, a in zip(procs, asks)]
                ids = sorted(o.splitlines()[0].split()[1] for o in outs)
                self.assertEqual(ids, ["d21-2", "d21-3"] if form == "old" else ["d21-1", "d21-2"])
                for rid in ids:
                    self.assertIn(self.reflect(rid), ("反映", "保留"))  # 先の返しの none の行が増えた判断になれば保留（依頼は受ける）
                self.assertEqual({k: v for k, v in self.unreflected().items() if k in ids}, {r: ["保留"] for r in ids[1:]})
                self.assertEqual((len(self.requests_from("u-11")), len(self.requests_from("u-12"))), (1, 1))


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class AskFromWindow(Base):
    """窓からの質問（claude/bin/consult --ask が CONSULT_ASK を付けて立てる、窓口の会話を写した端末）と、窓口の会話の記録（設計 11 章）。"""

    def setUp(self):
        super().setUp()
        self.cockpit.update(main={"agent": "claude", "run_id": "run_main"}, streams=[{"id": "s7", "title": "窓", "form": "cowork"}])
        self.cockpit["cards"].append({"id": "d21", "rev": 1, "kind": "consult", "title": "凡例", "state": "open", "stream": "s7", "tasks": ["t1"]})
        self.write_cockpit()
        with open(self.fake_orca, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\ncase "$*" in *run-current*) echo "{\\"ok\\":true,\\"result\\":{\\"runId\\":\\"$FAKE_RUN\\"}}";; '
                     '*) echo \'{"ok":true,"result":{}}\';; esac\n' % self.orca_log)
        self.rule(kind="constraint", text="返事は日本語", quote="日本語で")   # R1
        self.rule(kind="decision", text="d21 の凡例は 6 つ")                # R2
        self.memo_dir = os.path.join(self.root, ".orca", "consult")
        os.makedirs(self.memo_dir)
        for ask, bind in (("ask1", ""), ("ask2", "- カード: d21\n"), ("ask3", "- 仕事: s7\n")):
            with open(os.path.join(self.memo_dir, "ask-%s.md" % ask), "w", encoding="utf-8") as fh:
                fh.write("# 質問｜テスト｜%s\n%s- 写した窓口の会話: s-main\n\n" % (ask, bind))

    def ask_env(self, ask="ask1", **extra):
        return self.env(CONSULT_THREAD="1", CONSULT_ASK="%s#%s" % (self.root, ask), FAKE_RUN="run_main", **extra)

    def say(self, prompt, ask="ask1"):
        return self.hook("UserPromptSubmit", env=self.ask_env(ask), prompt=prompt, session_id="s-ask")

    def ops(self, ops):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": ops}, fh)

    def launch(self, seen, ask="ask1", question=None):
        text = "【相談の知らせ】質問を始める（consult --ask）\nrulings_seen: %s\n本文" % seen
        return self.say(text + ("\n--- 深田さんの質問（窓から） ---\n" + question if question else ""), ask)

    def stop(self, reply, ask="ask1", **extra):
        out = self.hook("Stop", env=self.ask_env(ask), session_id="s-ask", last_assistant_message=reply, **extra)
        return json.loads(out) if out.strip() else None

    def memo(self, ask="ask1"):
        with open(os.path.join(self.memo_dir, "ask-%s.md" % ask), encoding="utf-8") as fh:
            return fh.read()

    def returns(self, ask="ask1"):
        p = os.path.join(self.memo_dir, "ask-%s.returns.jsonl" % ask)
        return [json.loads(l) for l in read(p).splitlines()] if os.path.exists(p) else []

    def sends(self):
        return [l for l in read(self.orca_log).splitlines() if l.startswith("orchestration send")] if os.path.exists(self.orca_log) else []

    def unreflected(self):
        done = subprocess.run([HOOK, "unreflected", self.root, "--json"], text=True, capture_output=True, env=self.env())
        self.assertEqual(done.returncode, 0, done.stderr)
        return [{k: v for k, v in x.items() if k in ("id", "ask", "op", "missing", "tasks")} for x in json.loads(done.stdout)]

    RET = {"return_id": "ask1-1", "rulings_seen": "R2", "decisions": [{"text": "凡例は 5 つ", "quote": "5 つにして", "utterance": "u-1"}],
           "requests": [], "open": [], "affects": ["t1"]}

    def reply_with(self, ret, before="凡例は 5 つで進める、と決まった。返しの案を書いた。"):
        return "窓口の会話 09:58 時点（それより後に決まったことは知らない）\n%s\n\n【窓口への返し】\n```json\n%s\n```\n" % (before, json.dumps(ret, ensure_ascii=False))

    # ---- 窓口の会話の記録（11.6 の 4・7） ----

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

    # ---- 質問の発言・答え・流し込み ----

    def test_the_question_from_the_window_is_her_words_and_the_launch_is_not(self):
        self.launch("R2", question="凡例は何個がいい？")
        self.say("5 つでどう？")
        rows = self.jsonl("utterances.jsonl")
        self.assertEqual([(u["id"], u["ask"], u["prompt"]) for u in rows], [("u-1", "ask1", "凡例は何個がいい？"), ("u-2", "ask1", "5 つでどう？")])
        self.assertNotIn("card", rows[0])
        self.stop("窓口の会話 09:58 時点\n5 つがよい")
        memo = self.memo()
        self.assertIn("### 質問 10:00（u-1）\n凡例は何個がいい？", memo)
        self.assertIn("### 答え 10:00\n窓口の会話 09:58 時点\n5 つがよい", memo)
        self.assertNotIn("rulings_seen", memo)
        self.say("【相談の知らせ】返しを書いて（op 812）")
        self.assertEqual(len(self.jsonl("utterances.jsonl")), 2)
        self.assertIn("### 知らせ 10:00\n【相談の知らせ】返しを書いて（op 812）", self.memo())

    def test_her_words_from_the_window_reply_are_kept_without_the_notice_line(self):
        self.launch("R2", question="凡例は何個がいい？")
        self.stop("窓口の会話 09:58 時点\n5 つがよい\n\n【選べる案】\n- A: 5 つ（推し）\n- B: 3 つ")
        # 窓の「A で返す」: 窓が op を書き、言葉を先に、改行して知らせを後に、1 回で届く
        self.ops([{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1", "choice": "A"},
                  {"op_id": 814, "type": "ask_decide", "item_id": "#ask:ask1", "text": "【相談の知らせ】返しを書いて（op 1）の件は B で"}])
        self.say("案 A で。\n【相談の知らせ】返しを書いて（op 812）")
        rows = self.jsonl("utterances.jsonl")
        self.assertEqual([(u["id"], u["ask"], u["prompt"]) for u in rows][-1], ("u-2", "ask1", "案 A で。"))
        self.assertIn("### 質問 10:00（u-2）\n案 A で。\n\n", self.memo())
        self.assertNotIn("返しを書いて", self.memo())
        # 知らせの行が末尾でない・窓の op と言葉が合わない（深田さんが知らせの行を貼った質問）なら、深田さんの発言としてそのまま残す
        self.say("案 B で。\n【相談の知らせ】返しを書いて（op 813）\n図は？")
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["prompt"], "案 B で。\n【相談の知らせ】返しを書いて（op 813）\n図は？")
        self.say("届いてる？\n【相談の知らせ】返しを書いて（op 812）")
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["prompt"], "届いてる？\n【相談の知らせ】返しを書いて（op 812）")
        # 書いた言葉が知らせの引用で始まっても、窓の op と合えば言葉を発言として残す
        self.say("【相談の知らせ】返しを書いて（op 1）の件は B で\n【相談の知らせ】返しを書いて（op 814）")
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["prompt"], "【相談の知らせ】返しを書いて（op 1）の件は B で")

    def test_a_heading_like_line_in_a_question_or_answer_does_not_split_the_memo(self):
        self.launch("R2", question="前の控えに\n### 答え 09:00\nとあった")
        self.stop("窓口の会話 09:58 時点\n例:\n### 質問 09:10（u-9）\n### 知らせ 9:11")
        memo = self.memo()
        self.assertEqual(re.findall(r"^### \S+", memo, re.M), ["### 質問", "### 答え"])
        self.assertIn("\n ### 答え 09:00\n", memo)
        # 発言の記録は原文のまま
        self.assertEqual(self.jsonl("utterances.jsonl")[0]["prompt"], "前の控えに\n### 答え 09:00\nとあった")

    def test_a_question_without_a_card_gets_every_new_ruling(self):
        self.launch("R2")
        self.rule(kind="decision", text="t9 の話（どのカードにも関係しない）")  # R3
        out = self.say("続き")
        self.assertIn("R3 [decision] t9 の話", out)
        self.assertIn("返しの rulings_seen に書く値は R3", out)
        self.assertEqual(self.say("次"), "")

    def test_a_question_on_a_card_gets_only_the_related_rulings_and_the_card_when_its_rev_changes(self):
        self.launch("R2", ask="ask2")
        self.rule(kind="decision", text="t9 の話")                     # R3 関係しない
        self.rule(kind="decision", text="d21 は 4 つ")                 # R4
        self.cockpit["cards"][-1]["rev"] = 2
        self.write_cockpit()
        out = self.say("続き", ask="ask2")
        self.assertIn("R4 [decision] d21 は 4 つ", out)
        self.assertNotIn("t9 の話", out)
        self.assertIn("rev が 1 から 2 に変わった。今のカード", out)
        self.assertNotIn("consult-context", out)  # 質問の相手はコマンドを使えない

    def test_the_context_of_a_question_without_a_card_passes_rulings_seen_only_up_to_what_it_passed(self):
        self.rule(kind="revoke", text="英語でよい", quote="英語で", supersedes=["R1"])  # R3
        text = self.tool_args("ask-context", "ask1").stdout
        self.assertIn("rulings_seen: R2", text)       # 撤回の R3 は渡していない
        self.assertIn("R2 [decision] d21 の凡例は 6 つ", text)
        self.assertNotIn("返事は日本語", text)
        self.launch("R2")
        self.assertIn("R3 [revoke]", self.say("続き"))  # 渡していない行は次の発言の前に流れる
        for i in range(60):
            self.rule(kind="constraint", text="長い制約 %d " % i + "あ" * 150, quote="原文")
        text = self.tool_args("ask-context", "ask1").stdout
        self.assertLessEqual(len(text), 9000)
        self.assertIn("rulings_seen: R63", text)   # 新しい順に渡し、上限で落ちるのは古いもの
        self.assertRegex(text, r"ほか \d+ 件（.*R2.*）は長さの上限で省いた")

    def test_the_context_of_a_question_on_a_card_is_the_card_bundle(self):
        text = self.tool_args("ask-context", "ask2").stdout
        self.assertIn("rev: 1", text)
        self.assertIn('"title": "凡例"', text)
        self.assertEqual(self.tool_args("ask-context", "ask2", "--since", "R1").stdout.split()[1], "R2")

    def test_after_compaction_the_question_gets_the_context_again(self):
        got = json.loads(self.hook("SessionStart", env=self.ask_env(), session_id="s-ask", source="compact"))
        self.assertIn("rulings_seen: R2", got["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.keep()["asks"]["ask1"]["seen"], 2)

    # ---- 返しの保存と知らせ（11.6 の 2） ----

    def test_the_return_at_the_end_of_the_last_reply_is_saved_once_and_sent_to_the_main(self):
        self.assertIsNone(self.stop(self.reply_with(self.RET)))
        [row] = self.returns()
        self.assertEqual((row["return_id"], row["ask"], row["decisions"][0]["quote"]), ("ask1-1", "ask1", "5 つにして"))
        [send] = self.sends()
        self.assertIn("--to run:run_main", send)
        self.assertIn("質問 ask1: 返し ask1-1", send)
        self.stop(self.reply_with(self.RET))  # 同じ返事で Stop がもう一度走っても 1 件
        self.assertEqual(len(self.returns()), 1)
        self.assertEqual(len(self.sends()), 1)

    def test_a_reworded_second_return_for_the_same_press_keeps_its_number(self):
        self.ops([{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}])
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "op": 812})))
        reworded = {**self.RET, "op": 812, "decisions": [{"text": "凡例を五つにする", "quote": "5 つにして", "utterance": "u-1"}]}
        self.assertIsNone(self.stop(self.reply_with(reworded, before="言い直す。凡例は五つ。")))
        self.assertEqual([(r["return_id"], r["decisions"][0]["text"]) for r in self.returns()], [("ask1-1", "凡例は 5 つ")])
        self.assertEqual(len(self.sends()), 1)

    def test_a_return_given_again_for_a_hold_is_saved_even_with_the_same_press(self):
        self.ops([{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}])
        self.stop(self.reply_with({**self.RET, "op": 812}))
        fixed = {**self.RET, "op": 812, "replaces": "ask1-1", "decisions": [{"text": "凡例は 4 つ", "quote": "4 つにして", "utterance": "u-2"}]}
        self.assertIsNone(self.stop(self.reply_with(fixed, before="増えた判断を読み直した。")))
        self.assertEqual([(r["return_id"], r.get("replaces")) for r in self.returns()], [("ask1-1", None), ("ask1-2", "ask1-1")])
        self.assertEqual(len(self.sends()), 2)

    def test_a_choice_alone_is_not_a_question_return(self):
        out = self.stop(self.reply_with({"rulings_seen": "R2", "choice": "A"}))
        self.assertIn("どれも空", out["reason"])
        self.assertEqual(self.returns(), [])

    def test_a_pasted_example_or_one_quoted_mid_reply_is_not_a_return(self):
        example = "【窓口への返し】\n```json\n%s\n```" % json.dumps(self.RET, ensure_ascii=False)
        self.say("返しの書式ってこれで合ってる？\n" + example)
        self.assertIsNone(self.stop("窓口の会話 09:58 時点\n合っている。たとえば\n\n" + example + "\n\nのように末尾に書く。"))
        self.assertEqual(self.returns(), [])
        self.assertEqual(self.sends(), [])

    def test_a_broken_return_at_the_end_is_sent_back_to_be_rewritten(self):
        out = self.stop(self.reply_with({**self.RET, "replaces": "ask9-1"}))
        self.assertEqual(out["decision"], "block")
        self.assertIn("ask1-<連番>", out["reason"])
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "replaces": "ask9-1"}), stop_hook_active=True))  # 2 回目は止めない
        self.assertEqual(self.returns(), [])

    def test_the_hook_numbers_the_return_and_ignores_a_number_the_reply_wrote(self):
        # 古い形の相手が書いた番号（使い済みの ask1-1 や、推し量った ask1-7）は使わず、道具が次の番号を付ける
        self.assertIsNone(self.stop(self.reply_with(self.RET)))
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "decisions": [{"text": "別の話", "quote": "x", "utterance": "u-2"}]})))
        self.rule(kind="decision", text="凡例は 5 つ", quote="5 つにして", from_return="ask1-6")  # 判断の記録の番号も数える
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "return_id": "ask1-1", "open": ["色"]})))
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1", "ask1-2", "ask1-7"])
        self.assertEqual(self.returns()[1]["decisions"][0]["text"], "別の話")
        self.assertEqual(len(self.sends()), 3)
        self.assertIn("質問 ask1: 返し ask1-7", self.sends()[-1])
        self.assertIn('{"return_id": "ask1-7", "rulings_seen"', read(self.orca_log))
        self.assertNotIn("saved_at", read(self.orca_log))

    def test_without_the_hook_field_the_last_reply_is_read_from_the_transcript(self):
        t = os.path.join(self.root, "t.jsonl")
        rows = [{"type": "user", "message": {"content": "前の質問"}},
                {"type": "assistant", "message": {"id": "m0", "content": [{"type": "text", "text": self.reply_with({**self.RET, "return_id": "ask1-7"})}]}},
                {"type": "user", "message": {"content": "5 つで"}},
                {"type": "assistant", "message": {"id": "m1", "content": [{"type": "tool_use", "id": "x", "name": "Read", "input": {}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "x", "content": "..."}]}},
                {"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": self.reply_with(self.RET)}]}}]
        with open(t, "w", encoding="utf-8") as fh:
            fh.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        self.hook("Stop", env=self.ask_env(), session_id="s-ask", transcript_path=t)
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1"])  # 前の回の返しは拾わない

    # ---- 未反映の判定（11.3・11.6 の 3・5） ----

    def test_a_return_stays_unreflected_until_the_rulings_and_the_asks_have_it_and_the_owner_is_told(self):
        self.stop(self.reply_with(self.RET))
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["判断の記録", "帳簿"]}])
        self.rule(kind="decision", text="凡例は 5 つ", quote="5 つにして", affects=["t1"], from_return="ask1-1")
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["帳簿"]}])
        self.cockpit["asks"] = [{"id": "ask1", "memo": ".orca/consult/ask-ask1.md", "from_returns": ["ask1-1"],
                                 "notify": [{"return_id": "ask1-1", "task": "t1"}]}]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["担当への通知"], "tasks": ["t1"]}])
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("- ask1-1（質問 ask1。無いもの: 担当への通知（t1）", text)
        self.cockpit["asks"][0]["notify"][0]["message_id"] = "msg_1"
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [])

    def test_a_decide_press_without_a_return_is_named_until_a_return_carries_its_op(self):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": [{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1", "answer": {"at": "09:59", "head": "5 つがよい"}},
                               {"op_id": 813, "type": "ask_decide", "item_id": "#ask:ask2"}, {"op_id": 814, "type": "undo", "undo_of": 813}]}, fh)
        self.assertEqual(self.unreflected(), [{"id": None, "ask": "ask1", "op": 812, "missing": ["返し"]}])
        self.stop(self.reply_with({**self.RET, "op": 812}))
        self.assertEqual([x["id"] for x in self.unreflected()], ["ask1-1"])

    def test_a_return_carrying_the_op_of_another_question_is_refused_and_leaves_that_press_named(self):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": [{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}]}, fh)
        out = self.stop(self.reply_with({**self.RET, "return_id": "ask2-1", "op": 812}), ask="ask2")
        self.assertIn("op 812 はこの質問（ask2）の「この答えを窓口に返す」ではない", out["reason"])
        self.assertEqual(self.returns("ask2"), [])
        self.assertEqual(self.unreflected(), [{"id": None, "ask": "ask1", "op": 812, "missing": ["返し"]}])

    def test_a_return_the_main_cannot_reflect_is_sent_back(self):
        for broken, why in (({"decisions": [42]}, "decisions の各項目"), ({"decisions": [{"text": "5 つ", "quote": "5 つ"}]}, "utterance"),
                            ({"rulings_seen": None}, "rulings_seen"), ({"requests": [{"quote": "見積も"}]}, "requests の各項目"),
                            ({"requests": [{"quote": 12, "utterance": "u-1"}]}, "requests の各項目"),
                            ({"decisions": [{"text": {"a": 1}, "quote": "x", "utterance": "u-1"}]}, "decisions の各項目")):
            out = self.stop(self.reply_with({**self.RET, **broken}))
            self.assertIn(why, out["reason"], broken)
        self.assertEqual(self.returns(), [])

    def test_an_example_mid_reply_does_not_spoil_the_return_at_the_end(self):
        example = "【窓口への返し】\n```json\n{\"return_id\": \"ask1-9\"}\n```"
        self.assertIsNone(self.stop("書式はたとえば\n" + example + "\nのように書く。\n\n" + self.reply_with(self.RET)))
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1"])
        # 依頼の原文にバッククォートが 3 つ続いても、末尾の塊として読む
        ret = {**self.RET, "return_id": "ask1-2", "requests": [{"quote": "```で囲んで送って", "utterance": "u-2"}]}
        self.assertIsNone(self.stop(self.reply_with(ret)))
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1", "ask1-2"])

    def test_the_notice_to_write_the_return_still_carries_the_new_rulings(self):
        self.launch("R2")
        self.rule(kind="decision", text="t9 は止める")  # R3
        out = self.say("【相談の知らせ】返しを書いて（op 812）")
        self.assertIn("R3 [decision] t9 は止める", out)
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_a_question_on_a_stream_gets_the_rulings_on_the_stream_and_its_tasks(self):
        """仕事に結んだ質問（控えの頭の「- 仕事:」）は、仕事の id を挙げる・その下のタスクを affects に持つ判断と全体の制約だけを流す。"""
        self.cockpit["tasks"][0]["stream"] = "s7"
        self.write_cockpit()
        self.assertIn("仕事 s7 に結ばれた質問", self.tool_args("ask-context", "ask3").stdout)
        self.launch("R2", ask="ask3")
        self.rule(kind="decision", text="t9 の話（この仕事に関係しない）")      # R3
        self.rule(kind="decision", text="s7 は定例の前日までに出す")            # R4 仕事を名指し
        self.rule(kind="decision", text="入口を描く", affects=["t1"])          # R5 仕事の下のタスク
        self.rule(kind="constraint", text="費用は月 5 万円まで", quote="5 万")  # R6 全体の制約
        out = self.say("続き", ask="ask3")
        self.assertNotIn("t9 の話", out)
        for want in ("R4 [decision] s7 は定例", "R5 [decision] 入口を描く", "R6 [constraint] 費用は"):
            self.assertIn(want, out)
        # 関係しない判断は読んだことにする（カードの相談と同じ。窓口の照合も関係する判断だけを見る）
        self.assertIn("関係する判断が増えた", out)
        self.assertIn("返しの rulings_seen に書く値は R6", out)
        self.assertEqual(self.say("次", ask="ask3"), "")
        since = self.tool_args("ask-context", "ask3", "--since", "R2").stdout
        self.assertNotIn("t9 の話", since)
        self.assertIn("R4 [decision] s7 は定例", since)
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["ask"], "ask3")
        # 最初の文脈も仕事に関係する判断だけ（ほかの仕事の判断で長さの上限を使わない）。
        first = self.tool_args("ask-context", "ask3").stdout
        self.assertNotIn("t9 の話", first)
        self.assertIn("R5 [decision] 入口を描く", first)
        self.assertIn("rulings_seen: R6", first)

    def test_rulings_seen_of_a_question_without_a_card_stops_at_what_it_passed(self):
        self.launch("R2")
        self.rule(kind="decision", text="t9 の話")                       # R3
        self.rule(kind="none", text="記録しない", dec="d21")              # R4 渡さない
        out = self.say("続き")
        self.assertIn("返しの rulings_seen に書く値は R3", out)
        self.assertEqual(self.keep()["asks"]["ask1"]["seen"], 3)

    def test_a_decide_press_the_main_applied_itself_is_not_named(self):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": [{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}]}, fh)
        self.cockpit["applied_ops"] = [812]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [])

    def test_a_held_question_return_is_named(self):
        self.stop(self.reply_with(self.RET))
        self.rule(kind="none", text="増えた判断で保留", dec="d21", from_return="ask1-1")
        self.cockpit["asks"] = [{"id": "ask1", "from_returns": ["ask1-1"], "held_returns": ["ask1-1"]}]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["保留"]}])

    def test_a_broken_ask_env_does_nothing(self):
        for v in (self.root, "/nowhere#ask1", "%s#d21" % self.root):
            self.hook("UserPromptSubmit", env=self.env(CONSULT_THREAD="1", CONSULT_ASK=v), prompt="質問")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def tool_args(self, *args):
        return subprocess.run([HOOK, args[0], self.root, *args[1:]], text=True, capture_output=True, env=self.env())


# state.ts の unsortedOf（intake の through より後と、through 以前でどの依頼にも none にも結ばれていない発言）と同じ規則
FAKE_UNSORTED = r"""
const fs = require('fs'), path = require('path'), root = process.argv[2]
const c = JSON.parse(fs.readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8'))
const ids = fs.readFileSync(path.join(root, '.orca', 'cockpit', 'utterances.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
const through = ids.indexOf(c.intake.through)
const bound = new Set([...(c.intake.none || []), ...(c.requests || []).flatMap((r) => (r.utterances || []).map((u) => u.id))])
console.log(JSON.stringify({ checks: { unsorted: ids.filter((id, i) => i > through || !bound.has(id)) } }))
"""


if __name__ == "__main__":
    unittest.main()
