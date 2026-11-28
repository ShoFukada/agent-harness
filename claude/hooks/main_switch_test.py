#!/usr/bin/env python3
"""窓口を Claude と Gemini（agy）で乗り換えても、同じ Run・操縦席・記録を引き継いで動けることを保証する（main_switch.py。判断の記録 R245）。

操縦席は一時フォルダの写しで作り、orca は偽物にする（本物の Run を付け替えない）。帳簿はこのリポジトリの cockpit-write で書く。
"""

import json
import os
import subprocess
import time
import unittest

from keep_testing import Base, HOOK, read

COCKPIT_WRITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "orca", "plugins", "cockpit", "bin", "cockpit-write")
SWITCH_AGY = "~/.claude/hooks/compaction-keep.py switch --agent antigravity"


class Switch(Base):
    def setUp(self):
        super().setUp()
        self.cockpit.update(workspace={"name": "社内｜テスト"}, main={"agent": "claude", "terminal": "", "run_id": "run_main"})
        self.write_cockpit()
        self.session_file = os.path.join(self.root, ".orca", "cockpit", "main-session.json")
        with open(self.session_file, "w") as fh:
            json.dump({"run_id": "run_main", "agent": "claude", "session_id": "c-old", "transcript_path": "/c/old.jsonl",
                       "config_dir": "/seatA", "cwd": self.root, "at": "2026-11-21T09:00:00+09:00"}, fh)
        # Run の結び付きは偽の orca が bound に持つ。前の窓口（Claude）が Run を持っている
        self.bound = os.path.join(self.root, "bound")
        self.inbox_file = os.path.join(self.root, "inbox")
        self.terminals_file = os.path.join(self.root, "terminals")
        self.terminals([])
        with open(self.bound, "w") as fh:
            fh.write("run_main")
        self.fake("")

    def fake(self, run_use):
        """偽の orca。run_use は run-use のときに走らせる sh（空なら Run を結び直して成功を返す）。"""
        script = ['#!/bin/sh', 'echo "$@" >> "%s"' % self.orca_log, 'case "$2" in',
                  ' run-use) %s;;' % (run_use or 'printf %%s "$4" > "%s"; echo \'{"ok":true,"result":{}}\'' % self.bound),
                  ' run-current) echo "{\\"ok\\":true,\\"result\\":{\\"runId\\":\\"$(cat "%s")\\"}}";;' % self.bound,
                  ' check) if [ -f "%s" ]; then cat "%s"; rm "%s"; else echo \'{"ok":true,"result":{"messages":[]}}\'; fi;;' % ((self.inbox_file,) * 3),
                  ' list) cat "%s";;' % self.terminals_file,
                  ' *) echo \'{"ok":true,"result":{}}\';;', 'esac']
        with open(self.fake_orca, "w") as fh:
            fh.write("\n".join(script) + "\n")

    def terminals(self, rows, ok=True):
        """偽の orca の terminal list の結果。ok=False なら失敗を返す。"""
        with open(self.terminals_file, "w") as fh:
            json.dump({"ok": True, "result": {"terminals": rows}} if ok else {"ok": False, "error": "runtime_unavailable"}, fh)

    def agy_env(self, **extra):
        env = self.env(**{"COCKPIT_WRITE": COCKPIT_WRITE, "ORCA_TERMINAL_HANDLE": "term_gem", **extra})
        for k in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR"):
            env.pop(k, None)
        return env

    def claude_env(self, **extra):
        env = self.env(**{"COCKPIT_WRITE": COCKPIT_WRITE, "CLAUDECODE": "1", **extra})
        env.pop("ORCA_TERMINAL_HANDLE", None)
        return env

    def pretool(self, command, session, env=None, transcript="/agy/brain/g-1/transcript_full.jsonl"):
        return self.hook("PreToolUse", env=env, tool_name="Bash", tool_input={"command": command}, session_id=session, transcript_path=transcript)

    def switch(self, env, *args):
        return subprocess.run([HOOK, "switch", self.root, *args], text=True, capture_output=True, env=env)

    def ledger(self):
        with open(os.path.join(self.root, ".orca", "cockpit.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def session(self):
        with open(self.session_file, encoding="utf-8") as fh:
            return json.load(fh)

    def calls(self):
        return read(self.orca_log) if os.path.exists(self.orca_log) else ""

    def take_over_with_gemini(self):
        with open(self.inbox_file, "w") as fh:
            json.dump({"ok": True, "result": {"messages": [
                {"id": "msg_1", "from": "term_lead", "type": "worker_done", "subject": "W2 を取り込んだ", "body": "commit abc の差分を main に入れた"}]}},
                fh, ensure_ascii=False)
        self.assertEqual(self.pretool(SWITCH_AGY, "g-1", env=self.agy_env()), "")
        done = self.switch(self.agy_env(), "--agent", "antigravity")
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def test_a_gemini_main_takes_over_the_run_the_records_and_the_inbox(self):
        text = self.take_over_with_gemini()
        # Run を引き継ぎ、受信箱を空になるまで読む
        self.assertIn("orchestration run-use --id run_main --json", self.calls())
        self.assertEqual(self.calls().count("orchestration check --json"), 2)
        self.assertIn("- msg_1 term_lead（worker_done）: W2 を取り込んだ", text)
        self.assertIn("commit abc の差分を main に入れた", text)
        # M1: 窓口の種類と agy の会話 id を書き、前の窓口の会話は退かせる。agy に Claude の席は無い
        got = self.session()
        self.assertEqual({k: got[k] for k in ("run_id", "agent", "session_id", "transcript_path", "config_dir", "terminal", "retired")},
                         {"run_id": "run_main", "agent": "antigravity", "session_id": "g-1", "transcript_path": "/agy/brain/g-1/transcript_full.jsonl",
                          "config_dir": "", "terminal": "term_gem", "retired": ["c-old"]})
        # 帳簿の main は種類と端末だけが替わり、Run は保つ（cockpit-write で書く）
        self.assertEqual(self.ledger()["main"], {"agent": "antigravity", "terminal": "term_gem", "run_id": "run_main"})
        # M2: 再開の確かめを立て、組み直しの記録と確かめの形を出す
        self.assertEqual(self.keep()["verify"]["session"], "g-1")
        self.assertTrue(self.keep()["verify"]["pending"])
        self.assertNotIn("switch_claims", self.keep())
        self.assertIn("窓口を替えたあとの組み直し", text)
        self.assertIn("compaction-keep.py resume", text)
        self.assertEqual(self.jsonl("compactions.jsonl")[-1]["type"], "switch")
        # 環境変数の handle があれば端末の一覧は引かない
        self.assertNotIn("terminal list", self.calls())

    def gemini_rows(self):
        """窓口の worktree の agy 1 つと、引いてはいけない端末（カードの相談の Claude・別の worktree の agy・孤立した agy）。"""
        here = {"worktreePath": self.root, "orphaned": False}
        return [{"handle": "term_gem", "agentIdentity": "antigravity", **here},
                {"handle": "term_card", "agentIdentity": "claude", **here},
                {"handle": "term_mail", **here},
                {"handle": "term_lead", "agentIdentity": "antigravity", "worktreePath": self.root + "-lead", "orphaned": False},
                {"handle": "term_dead", "agentIdentity": "antigravity", "worktreePath": self.root, "orphaned": True}]

    def test_a_gemini_main_without_the_handle_finds_its_own_terminal(self):
        # agy の run_command には ORCA_TERMINAL_HANDLE が渡らない。同じ worktree で生きている agy の端末が 1 つならそれを書く
        self.cockpit["main"]["terminal"] = "term_old"
        self.write_cockpit()
        self.terminals(self.gemini_rows())
        env = self.agy_env()
        env.pop("ORCA_TERMINAL_HANDLE")
        self.pretool(SWITCH_AGY, "g-1", env=env)
        done = self.switch(env, "--agent", "antigravity")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("terminal list --worktree path:%s --limit 500 --json" % self.root, self.calls())
        self.assertEqual(self.ledger()["main"], {"agent": "antigravity", "terminal": "term_gem", "run_id": "run_main"})
        self.assertEqual(self.session()["terminal"], "term_gem")

    def test_a_gemini_main_whose_terminal_cannot_be_told_writes_nothing(self):
        # 候補が 0・複数・一覧を引けないときは、Run を引き継ぐ前に止め、帳簿の端末を空で上書きしない
        self.cockpit["main"]["terminal"] = "term_old"
        self.write_cockpit()
        before = self.session()
        env = self.agy_env()
        env.pop("ORCA_TERMINAL_HANDLE")
        cases = [(self.gemini_rows()[1:], True, "antigravity の端末が見つからなかった"),
                 (self.gemini_rows() + [{"handle": "term_gem2", "agentIdentity": "antigravity", "worktreePath": self.root}], True,
                  "antigravity の端末が 2 個あった（term_gem・term_gem2）"),
                 ([], False, "窓口の端末を引けなかった（orca terminal list: runtime_unavailable）")]
        for rows, ok, why in cases:
            with self.subTest(why=why):
                self.terminals(rows, ok)
                self.pretool(SWITCH_AGY, "g-1", env=env)
                done = self.switch(env, "--agent", "antigravity")
                self.assertEqual(done.returncode, 1)
                self.assertIn(why, done.stderr)
                self.assertIn("ORCA_TERMINAL_HANDLE=term_… ", done.stderr)
                self.assertNotIn("run-use", self.calls())
                self.assertEqual(self.ledger()["main"], {"agent": "claude", "terminal": "term_old", "run_id": "run_main"})
                self.assertEqual(self.session(), before)
                self.assertNotIn("verify", self.keep())

    def test_the_new_main_cannot_send_to_workers_until_the_resume_passes(self):
        self.take_over_with_gemini()
        send = "orca orchestration send --to dispatch:ctx_a --subject 続き --body-file b.md"
        out = self.pretool(send, "g-1", env=self.agy_env())
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")
        ok = subprocess.run([HOOK, "resume", self.root], input=json.dumps({"next": "続ける", "rulings": [], "permissions": [], "workers": ["ctx_a"], "paths": []}),
                            text=True, capture_output=True, env=self.agy_env())
        self.assertEqual(ok.returncode, 0, ok.stdout)
        self.assertEqual(self.pretool(send, "g-1", env=self.agy_env()), "")

    def test_a_notice_to_the_old_main_does_not_take_the_record_back_and_the_new_one_keeps_its_kind(self):
        self.take_over_with_gemini()
        before = self.session()
        # 閉じ忘れた前の窓口への知らせのターンは、Run が同じでも記録を戻さない（深田さんが話しかけたときだけ戻る。R253）
        self.hook("UserPromptSubmit", env=self.claude_env(CLAUDE_CONFIG_DIR="/seatA"), prompt="──── From: term_w (claude) (worker_done) ────\nSubject: 済んだ\n本文",
                  session_id="c-old", transcript_path="/c/old.jsonl")
        self.assertEqual(self.session(), before)
        # 新しい窓口の発言は、種類を保ったまま会話のファイルを書き直す（Claude の席は書かない）
        self.hook("UserPromptSubmit", env=self.agy_env(CLAUDE_CONFIG_DIR="/seatA"), prompt="続けて", session_id="g-1", transcript_path="/agy/brain/g-1/t2.jsonl")
        got = self.session()
        self.assertEqual((got["agent"], got["session_id"], got["transcript_path"], got["config_dir"], got["retired"]),
                         ("antigravity", "g-1", "/agy/brain/g-1/t2.jsonl", "", ["c-old"]))

    def test_the_retired_main_cannot_send_to_workers(self):
        # 閉じ忘れた前の窓口は、再開の確かめの相手ではないので、退いた会話として指示を止める
        self.take_over_with_gemini()
        out = self.pretool("orca orchestration send --to dispatch:ctx_a --subject x --body y", "c-old", env=self.claude_env())
        self.assertIn("窓口を退いた", json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertEqual(self.pretool("orca orchestration worker-list", "c-old", env=self.claude_env()), "")

    def test_a_silent_cockpit_write_failure_is_reported(self):
        silent = os.path.join(self.root, "silent-write")
        with open(silent, "w") as fh:
            fh.write("#!/bin/sh\nexit 3\n")
        os.chmod(silent, 0o755)
        self.pretool(SWITCH_AGY, "g-1", env=self.agy_env())
        done = self.switch(self.agy_env(COCKPIT_WRITE=silent), "--agent", "antigravity")
        self.assertEqual(done.returncode, 1)
        self.assertIn("帳簿の main を書けなかった（exit 3）", done.stderr)

    def test_switching_back_to_claude_uses_its_own_session_and_seat(self):
        self.take_over_with_gemini()
        self.pretool("~/.claude/hooks/compaction-keep.py switch", "c-new", env=self.claude_env(), transcript="/c/new.jsonl")
        done = self.switch(self.claude_env(CLAUDE_CODE_SESSION_ID="c-new", CLAUDE_CONFIG_DIR="/seatB"))
        self.assertEqual(done.returncode, 0, done.stderr)
        got = self.session()
        self.assertEqual((got["agent"], got["session_id"], got["transcript_path"], got["config_dir"], got["terminal"], got["retired"]),
                         ("claude", "c-new", "/c/new.jsonl", "/seatB", "", ["c-old", "g-1"]))
        self.assertEqual(self.ledger()["main"], {"agent": "claude", "terminal": "", "run_id": "run_main"})
        self.assertEqual(self.keep()["verify"]["session"], "c-new")

    def test_a_claude_main_that_is_already_in_the_ledger_does_not_rewrite_it(self):
        # Claude は環境変数の会話 id で足りる（PreToolUse の控えが無くても通る）。帳簿の値が同じなら cockpit-write を呼ばない
        env = self.claude_env(CLAUDE_CODE_SESSION_ID="c-old", CLAUDE_CONFIG_DIR="/seatA", COCKPIT_WRITE=os.path.join(self.root, "missing"))
        done = self.switch(env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.session()["retired"], [])
        self.assertTrue(self.keep()["verify"]["pending"])

    def test_the_tool_refuses_without_knowing_who_it_is_and_writes_nothing(self):
        before = self.session()
        # agy で PreToolUse の控えが無い・古い
        self.assertIn("会話の id を取れなかった", self.switch(self.agy_env(), "--agent", "antigravity").stderr)
        self.pretool(SWITCH_AGY, "g-1", env=self.agy_env())
        keep = self.keep()
        keep["switch_claims"]["g-1"]["clock"] = time.time() - 3600
        with open(os.path.join(self.root, ".orca", "cockpit", "keep.json"), "w") as fh:
            json.dump(keep, fh)
        self.assertIn("会話の id を取れなかった", self.switch(self.agy_env(), "--agent", "antigravity").stderr)
        # 種類の打ち間違い
        self.assertIn("Claude Code の中で動いている", self.switch(self.claude_env(CLAUDE_CODE_SESSION_ID="c-1"), "--agent", "antigravity").stderr)
        self.assertIn("--agent antigravity を付けて", self.switch(self.agy_env()).stderr)
        self.assertIn("--agent には", self.switch(self.agy_env(), "--agent", "gemini").stderr)
        self.assertNotIn("run-use", self.calls())
        self.assertEqual(self.session(), before)
        self.assertNotIn("verify", self.keep())

    def test_two_conversations_claiming_the_switch_at_once_are_refused(self):
        # 許可を待つあいだに別の会話も switch を打つと、どちらが打ったかを控えから決められない
        self.pretool(SWITCH_AGY, "g-1", env=self.agy_env())
        self.pretool(SWITCH_AGY, "g-2", env=self.agy_env())
        done = self.switch(self.agy_env(), "--agent", "antigravity")
        self.assertEqual(done.returncode, 1)
        self.assertIn("2 つの会話が続けて switch を打った（g-1・g-2）", done.stderr)
        self.assertNotIn("run-use", self.calls())

    def test_a_switch_bundled_with_a_worker_send_is_denied(self):
        out = self.pretool(SWITCH_AGY + " && orca orchestration send --to dispatch:ctx_a --subject x --body y", "g-1", env=self.agy_env())
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_a_handoff_still_launching_is_taken_by_the_switch(self):
        # 自動の引き継ぎの起動中に手で替えたら、遅れて起きた窓口の SessionStart が再開の確かめの相手を取り替えない
        keep = {"handoff": {"state": "launching", "at": self.now, "reason": "x", "from_session": "c-old", "agent": "claude"}}
        with open(os.path.join(self.root, ".orca", "cockpit", "keep.json"), "w") as fh:
            json.dump(keep, fh)
        self.take_over_with_gemini()
        self.assertEqual((self.keep()["handoff"]["state"], self.keep()["handoff"]["to_session"]), ("taken", "g-1"))
        self.hook("SessionStart", source="startup", session_id="c-late")
        self.assertEqual(self.keep()["verify"]["session"], "g-1")
        self.assertEqual(self.keep()["handoff"]["to_session"], "g-1")

    def test_a_conversation_opened_by_hand_is_told_it_takes_over_when_spoken_to(self):
        # M2: 手で開いた新しい窓口の開始に、話しかければ引き継ぐことを案内する。記録の窓口と退いた会話には出さない
        ctx = json.loads(self.hook("SessionStart", source="startup", session_id="g-1"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("記録の窓口は claude の会話 c-old", ctx)
        self.assertIn("この会話に話しかけると、hook が窓口の Run を引き継ぐ", ctx)
        self.assertEqual(self.hook("SessionStart", source="startup", session_id="c-old"), "")
        self.take_over_with_gemini()
        self.assertEqual(self.hook("SessionStart", source="startup", session_id="c-old"), "")

    def test_an_inbox_that_cannot_be_read_to_the_end_fails_after_showing_what_it_read(self):
        self.fake("")
        with open(self.fake_orca) as fh:
            script = fh.read()
        # 1 件読んだあとの check が失敗する
        script = script.replace(' check) ', ' check) if [ -f "%s.done" ]; then echo \'{"ok":false,"error":"orca_down"}\'; exit 1; fi; touch "%s.done"; ' % (self.inbox_file, self.inbox_file))
        with open(self.fake_orca, "w") as fh:
            fh.write(script)
        with open(self.inbox_file, "w") as fh:
            json.dump({"ok": True, "result": {"messages": [{"id": "msg_2", "from": "term_lead", "type": "status", "subject": "読めた知らせ"}]}}, fh, ensure_ascii=False)
        self.pretool(SWITCH_AGY, "g-1", env=self.agy_env())
        done = self.switch(self.agy_env(), "--agent", "antigravity")
        self.assertEqual(done.returncode, 1)
        self.assertIn("読めた知らせ", done.stdout)
        self.assertIn("受信箱を読み切れなかった（orca_down）", done.stderr)
        self.assertEqual(self.session()["session_id"], "g-1")

    def test_a_run_that_cannot_be_taken_over_leaves_the_records_alone(self):
        before = self.session()
        self.fake("echo '{\"ok\":false,\"error\":{\"code\":\"run_not_found\"}}'")
        self.pretool(SWITCH_AGY, "g-1", env=self.agy_env())
        with open(self.bound, "w") as fh:
            fh.write("")
        done = self.switch(self.agy_env(), "--agent", "antigravity")
        self.assertEqual(done.returncode, 1)
        self.assertIn("Run run_main を引き継げなかった", done.stderr)
        self.assertIn("run_not_found", done.stderr)
        self.assertEqual(self.session(), before)
        self.assertEqual(self.ledger()["main"]["agent"], "claude")
        self.assertNotIn("verify", self.keep())

    def test_a_ledger_without_the_run_is_refused(self):
        del self.cockpit["main"]["run_id"]
        self.write_cockpit()
        self.pretool(SWITCH_AGY, "g-1", env=self.agy_env())
        self.assertIn("main.run_id が無い", self.switch(self.agy_env(), "--agent", "antigravity").stderr)

    def test_a_switch_settles_the_handoff_booked_for_the_old_main(self):
        keep = {"handoff_due": "圧縮のあとの照合が 2 回続けて合わなかった"}
        with open(os.path.join(self.root, ".orca", "cockpit", "keep.json"), "w") as fh:
            json.dump(keep, fh)
        self.take_over_with_gemini()
        self.assertNotIn("handoff_due", self.keep())
        self.assertEqual(self.keep()["handoff_at"], self.now)


class HandoffToGemini(Base):
    """M3: 自動の引き継ぎは、帳簿に書いた窓口の種類で新しい窓口を起こす。新しい窓口の最初のターンで hook が Run を引き継ぐ（t178）。"""

    def test_a_gemini_main_is_handed_off_to_a_new_gemini_terminal(self):
        self.cockpit.update(main={"agent": "antigravity", "terminal": "term_gem", "run_id": "run_main"})
        self.write_cockpit()
        self.now = "2026-11-20T17:00:00+09:00"
        self.hook("UserPromptSubmit", prompt="昨日の最後の発言", session_id="g-1")
        ops = [{"op_id": i + 1, "at": "2026-11-20T18:00:00+09:00", "item_id": "", "item_rev": 0, "type": "repeat"} for i in range(2)]
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": ops}, fh)
        self.now = "2026-11-21T09:00:00+09:00"
        out = json.loads(self.hook("UserPromptSubmit", prompt="今日の最初の発言", session_id="g-1"))
        self.assertEqual(out["decision"], "block")
        self.assertIn("端末のタブ", out["reason"])
        args = read(self.orca_log)
        self.assertIn("agent launch --agent antigravity --worktree path:%s --surface terminal --model gemini-4-neon-high --prompt" % self.root, args)
        self.assertIn("--prompt 【引き継ぎ 2026-11-21T09:00:00+09:00】", args)
        ctx = json.loads(self.hook("SessionStart", source="startup", session_id="g-2"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("そのターンで hook が窓口の Run を引き継ぎ", ctx)
        self.assertNotIn("switch", ctx)

    def test_a_ledger_without_the_kind_hands_off_to_a_claude_chat(self):
        self.now = "2026-11-20T17:00:00+09:00"
        self.hook("UserPromptSubmit", prompt="昨日")
        ops = [{"op_id": i + 1, "at": "2026-11-20T18:00:00+09:00", "item_id": "", "item_rev": 0, "type": "repeat"} for i in range(2)]
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": ops}, fh)
        self.now = "2026-11-21T09:00:00+09:00"
        self.assertIn("チャットの一覧", json.loads(self.hook("UserPromptSubmit", prompt="今日"))["reason"])
        args = read(self.orca_log)
        self.assertIn("agent launch --agent claude --worktree path:%s --surface chat --prompt" % self.root, args)
        self.assertNotIn("--model", args)
        ctx = json.loads(self.hook("SessionStart", source="startup", session_id="s-new"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("そのターンで hook が窓口の Run を引き継ぎ", ctx)


if __name__ == "__main__":
    unittest.main()
