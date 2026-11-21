#!/usr/bin/env python3
"""workerctl が、worker の知らせを取りこぼさず、古い指示の止まりを完了と取り違えず、メインの hook で見張りの切れを止めることを保証する。

orca は PATH の先頭に置いた偽物に差し替える。偽物は FAKE_ORCA_DIR の terminals.json と agents.json を返し、呼ばれた引数を calls.jsonl に残す。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

WORKERCTL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workerctl")
MAIN = "term_main-0000"
WORKER = "term_worker-1111"

FAKE_ORCA = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ["FAKE_ORCA_DIR"]
args = sys.argv[1:]
with open(os.path.join(d, "calls.jsonl"), "a") as fh:
    fh.write(json.dumps(args) + "\n")
def read(name, default):
    try:
        return json.load(open(os.path.join(d, name)))
    except FileNotFoundError:
        return default
terms = read("terminals.json", [])
if args[:2] == ["terminal", "create"]:
    handle = read("next_handle.json", "term_new-2222")
    # 本物は選び方を解決した worktree の絶対パスを端末に持つ。偽物は create_path.json で解決先を決める。
    sel = args[args.index("--worktree") + 1]
    terms.append({"handle": handle, "tabId": "tab", "leafId": handle,
                  "worktreePath": read("create_path.json", sel[5:] if sel.startswith("path:") else "")})
    json.dump(terms, open(os.path.join(d, "terminals.json"), "w"))
    print(json.dumps({"ok": True, "result": {"terminal": {"handle": handle}}}))
elif args[:2] == ["terminal", "send"]:
    if read("send_fails.json", False):
        print(json.dumps({"ok": False, "error": {"code": "terminal_handle_stale"}})); sys.exit(1)
    print(json.dumps({"ok": True, "result": {}}))
elif args[:2] == ["terminal", "list"]:
    # 本物の list は tabId・leafId に "pty:…" の仮の値を返すことがある。show だけが本物を返す。
    listed = [dict(t, tabId="pty:" + t["handle"], leafId="pty:" + t["handle"]) for t in terms]
    print(json.dumps({"ok": True, "result": {"terminals": listed, "truncated": False}}))
elif args[:2] == ["terminal", "show"]:
    t = [t for t in terms if t["handle"] == args[args.index("--terminal") + 1]]
    if not t:
        print(json.dumps({"ok": False, "error": {"code": "terminal_handle_stale"}})); sys.exit(1)
    print(json.dumps({"ok": True, "result": {"terminal": t[0]}}))
elif args[:2] == ["worktree", "ps"]:
    rows = read("worktrees.json", []) + [{"agents": read("agents.json", [])}]
    print(json.dumps({"ok": True, "result": {"worktrees": rows}}))
elif args[:2] == ["plugin", "list"]:
    print(json.dumps({"ok": True, "result": {"plugins": read("plugins.json", [])}}))
elif args[:3] == ["plugin", "dev", "unload"]:
    if read("unload_fails.json", False):
        print(json.dumps({"ok": False, "error": {"code": "failed"}})); sys.exit(1)
    json.dump([p for p in read("plugins.json", []) if (p.get("source") or {}).get("reference") != args[3]],
              open(os.path.join(d, "plugins.json"), "w"))
    print(json.dumps({"ok": True, "result": {}}))
elif args[:2] == ["worktree", "rm"]:
    # 本物と同じく worktree を消し、--delete-branch では default ブランチに入ったと示せるブランチだけを消す。
    import subprocess
    rows = read("worktrees.json", [])
    path = args[args.index("--worktree") + 1][len("path:"):]
    row = [r for r in rows if r["path"] == path][0]
    root = [r for r in rows if r["repoId"] == row["repoId"] and r["isMainWorktree"]][0]["path"]
    force = ["--force"] if "--force" in args else []
    if subprocess.run(["git", "-C", root, "worktree", "remove"] + force + [path]).returncode != 0:
        print(json.dumps({"ok": False, "error": {"code": "worktree_remove_failed"}})); sys.exit(1)
    if "--delete-branch" in args:
        subprocess.run(["git", "-C", root, "branch", "-d", row["branch"][len("refs/heads/"):]], capture_output=True)
    json.dump([r for r in rows if r is not row], open(os.path.join(d, "worktrees.json"), "w"))
    print(json.dumps({"ok": True, "result": {}}))
'''


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="workerctl-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.home = os.path.join(self.dir, "home")
        self.fake = os.path.join(self.dir, "orca")
        os.makedirs(self.fake)
        binary = os.path.join(self.fake, "orca")
        with open(binary, "w") as fh:
            fh.write(FAKE_ORCA)
        os.chmod(binary, 0o755)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("ORCA_")}
        self.env.update(WORKERCTL_HOME=self.home, FAKE_ORCA_DIR=self.fake, ORCA_TERMINAL_HANDLE=MAIN,
                        PATH=self.fake + os.pathsep + os.environ["PATH"])
        self.set_terminals([{"handle": WORKER, "tabId": "tab", "leafId": "w1"}])
        # このリポジトリの親には本物の操縦席があるので、操縦席の無い一時フォルダから動かす。
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(self.dir)

    def set_terminals(self, terms):
        with open(os.path.join(self.fake, "terminals.json"), "w") as fh:
            json.dump(terms, fh)

    def set_agents(self, agents):
        with open(os.path.join(self.fake, "agents.json"), "w") as fh:
            json.dump(agents, fh)

    def run_ctl(self, *args, stdin=None, as_terminal=MAIN, check=True):
        env = dict(self.env)
        if as_terminal is None:
            env.pop("ORCA_TERMINAL_HANDLE")
        else:
            env["ORCA_TERMINAL_HANDLE"] = as_terminal
        done = subprocess.run([WORKERCTL] + list(args), input=stdin, text=True, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if check and done.returncode != 0:
            self.fail("workerctl %s が失敗した: %s" % (args, done.stderr))
        return done

    def hook(self, name, payload, as_terminal=MAIN):
        return self.run_ctl("hook", name, stdin=json.dumps(payload), as_terminal=as_terminal).stdout

    def worker_stop(self, text="終わった。差分は 3 ファイル"):
        return self.hook("worker", {"hook_event_name": "Stop", "stop_hook_active": False,
                                    "last_assistant_message": text}, as_terminal=WORKER)

    def worker_prompt(self, handle=WORKER):
        return self.hook("worker", {"hook_event_name": "UserPromptSubmit", "prompt": "指示"}, as_terminal=handle)

    def adopt_working(self):
        self.set_agents([{"paneKey": "tab:w1", "state": "working", "stateStartedAt": 0}])
        self.run_ctl("adopt", "--terminal", WORKER, "--title", "操縦席 v2")

    def workers(self):
        with open(os.path.join(self.home, "workers.json")) as fh:
            return json.load(fh)

    def calls(self):
        try:
            with open(os.path.join(self.fake, "calls.jsonl")) as fh:
                return [json.loads(line) for line in fh]
        except FileNotFoundError:
            return []


class Ledger(Base):
    def test_recorded_stop_shows_in_pending_and_resolve_clears_it(self):
        self.adopt_working()
        self.worker_stop()
        out = self.run_ctl("pending").stdout
        self.assertIn("未処理の知らせ 1 件", out)
        self.assertIn("#1", out)
        self.assertIn("終わった。差分は 3 ファイル", out)
        self.run_ctl("resolve", "1", "--note", "取り込んだ")
        self.assertIn("未処理の知らせ 0 件", self.run_ctl("pending").stdout)

    def test_a_stop_from_the_previous_instruction_is_not_counted_after_a_new_send(self):
        self.adopt_working()
        self.worker_stop("前の指示の結果")
        self.run_ctl("send", "--terminal", WORKER, "--text", "続き")
        out = self.run_ctl("pending").stdout
        self.assertIn("未処理の知らせ 0 件", out)
        self.assertIn("作業中（指示 2 回目）", out)
        self.worker_prompt()
        self.worker_stop("新しい指示の結果")
        out = self.run_ctl("pending").stdout
        self.assertIn("新しい指示の結果", out)
        self.assertNotIn("前の指示の結果", out)

    def test_a_stop_of_a_turn_begun_before_the_next_send_is_not_the_new_completion(self):
        self.adopt_working()
        self.hook("worker", {"hook_event_name": "UserPromptSubmit", "prompt": "最初の指示"}, as_terminal=WORKER)
        self.run_ctl("send", "--terminal", WORKER, "--text", "途中で送った次の指示")
        self.worker_stop("最初の指示の結果")
        out = self.run_ctl("pending").stdout
        self.assertIn("未処理の知らせ 0 件", out)
        self.assertIn("作業中（指示 2 回目）", out)
        self.hook("worker", {"hook_event_name": "UserPromptSubmit", "prompt": "次の指示"}, as_terminal=WORKER)
        self.worker_stop("次の指示の結果")
        self.assertIn("次の指示の結果", self.run_ctl("pending").stdout)

    def test_an_old_row_without_turn_gen_does_not_let_the_previous_stop_end_the_new_send(self):
        self.adopt_working()
        ws = self.workers()
        ws[WORKER]["gen"] = 2
        ws[WORKER].pop("turn_gen", None)
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)
        self.run_ctl("send", "--terminal", WORKER, "--text", "応答中に追加で送った指示")
        self.worker_stop("前の応答の結果")
        w = self.workers()[WORKER]
        self.assertEqual((w["gen"], w["state"]), (3, "working"))
        self.assertIn("未処理の知らせ 0 件", self.run_ctl("pending").stdout)

    def test_an_old_row_without_turn_gen_still_reports_the_current_turn(self):
        self.adopt_working()
        ws = self.workers()
        ws[WORKER].pop("turn_gen", None)
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)
        self.worker_stop("今の応答の結果")
        self.assertIn("今の応答の結果", self.run_ctl("pending").stdout)

    def test_other_owners_workers_are_not_listed(self):
        self.adopt_working()
        self.worker_stop()
        self.assertIn("登録した worker は無い", self.run_ctl("pending", as_terminal="term_other-9").stdout)

    def test_a_record_from_an_unregistered_terminal_is_kept(self):
        self.hook("worker", {"hook_event_name": "Stop", "last_assistant_message": "誰のでもない"},
                  as_terminal="term_stray-3")
        with open(os.path.join(self.home, "events.jsonl")) as fh:
            self.assertIn("term_stray-3", fh.read())

    def test_ask_and_permission_are_recorded_but_idle_after_a_stop_is_not(self):
        self.adopt_working()
        self.hook("worker", {"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion",
                             "tool_input": {"questions": [{"question": "A と B どちらにする？"}]}}, as_terminal=WORKER)
        self.hook("worker", {"hook_event_name": "Notification", "notification_type": "permission_prompt",
                             "message": "Claude needs your permission"}, as_terminal=WORKER)
        self.hook("worker", {"hook_event_name": "Notification", "notification_type": "idle_prompt",
                             "message": "waiting"}, as_terminal=WORKER)
        out = self.run_ctl("pending").stdout
        self.assertIn("質問で停止", out)
        self.assertIn("A と B どちらにする？", out)
        self.assertIn("許可待ち", out)
        self.assertNotIn("waiting", out)

    def test_done_closes_the_worker_and_its_events(self):
        self.adopt_working()
        self.worker_stop()
        self.run_ctl("done", "--terminal", WORKER)
        self.assertIn("登録した worker は無い", self.run_ctl("pending").stdout)

    def test_concurrent_records_under_flock_keep_every_line_and_unique_ids(self):
        self.adopt_working()
        procs = [subprocess.Popen([WORKERCTL, "record", "stopped", "--terminal", WORKER, "--text", "n%d" % i],
                                  env=self.env, stdout=subprocess.DEVNULL) for i in range(20)]
        for proc in procs:
            self.assertEqual(proc.wait(), 0)
        with open(os.path.join(self.home, "events.jsonl")) as fh:
            ids = [json.loads(line)["id"] for line in fh]
        self.assertEqual(sorted(ids), list(range(1, 21)))


class StartAndSend(Base):
    def test_start_creates_the_terminal_and_registers_it_to_the_caller(self):
        out = self.run_ctl("start", "--worktree", "id:repo::/w", "--title", "実装", "--",
                           "env CLAUDE_CONFIG_DIR=/p claude --model opus").stdout
        self.assertEqual(out.strip(), "term_new-2222")
        create = self.calls()[0]
        self.assertEqual(create[:2], ["terminal", "create"])
        self.assertEqual(create[create.index("--command") + 1], "env CLAUDE_CONFIG_DIR=/p claude --model opus")
        w = self.workers()["term_new-2222"]
        self.assertEqual((w["owner"], w["state"], w["gen"]), (MAIN, "started", 0))

    def test_a_failed_send_restores_the_state(self):
        self.adopt_working()
        self.worker_stop()
        with open(os.path.join(self.fake, "send_fails.json"), "w") as fh:
            json.dump(True, fh)
        self.assertNotEqual(self.run_ctl("send", "--terminal", WORKER, "--text", "x", check=False).returncode, 0)
        w = self.workers()[WORKER]
        self.assertEqual((w["state"], w["gen"]), ("stopped", 1))
        self.assertIn("未処理の知らせ 1 件", self.run_ctl("pending").stdout)

    def test_answer_with_empty_text_sends_only_enter(self):
        self.run_ctl("answer", "--terminal", WORKER, "--text", "")
        sends = [c for c in self.calls() if c[:2] == ["terminal", "send"]]
        self.assertEqual(len(sends), 1)
        self.assertIn("--enter", sends[0])
        self.assertNotIn("--text", sends[0])

    def test_a_send_from_another_main_keeps_the_owner(self):
        self.adopt_working()
        self.run_ctl("send", "--terminal", WORKER, "--text", "補足", as_terminal="term_other-9")
        self.assertEqual(self.workers()[WORKER]["owner"], MAIN)
        self.assertIn("作業中（指示 2 回目）", self.run_ctl("pending").stdout)

    def test_adopting_an_idle_worker_raises_a_notice(self):
        self.set_agents([{"paneKey": "tab:w1", "state": "done", "stateStartedAt": 1, "lastAssistantMessage": "完了"}])
        self.run_ctl("adopt", "--terminal", WORKER, "--title", "container")
        self.assertIn("未処理の知らせ 1 件", self.run_ctl("pending").stdout)


class Wait(Base):
    def start_wait(self):
        proc = subprocess.Popen([WORKERCTL, "wait", "--interval", "0.2", "--timeout-min", "1"], env=self.env,
                                stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        deadline = time.time() + 5
        while not os.path.exists(os.path.join(self.home, "wait.%s.pid" % MAIN)) and time.time() < deadline:
            time.sleep(0.05)
        return proc

    def test_wait_ends_when_the_worker_stops(self):
        self.adopt_working()
        proc = self.start_wait()
        self.assertIsNone(proc.poll())
        self.worker_stop()
        out, _ = proc.communicate(timeout=10)
        self.assertIn("未処理の知らせ 1 件", out)
        self.assertFalse(os.path.exists(os.path.join(self.home, "wait.%s.pid" % MAIN)))

    def test_wait_records_exited_when_the_terminal_disappears(self):
        self.adopt_working()
        proc = self.start_wait()
        self.set_terminals([])
        out, _ = proc.communicate(timeout=10)
        self.assertIn("端末が消えた", out)

    def test_wait_records_idle_when_an_agent_without_hooks_finishes_after_the_send(self):
        self.adopt_working()
        ws = self.workers()
        ws[WORKER]["sent_at_ms"] = int(time.time() * 1000) - 60000
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)
        self.set_agents([{"paneKey": "tab:w1", "state": "done", "stateStartedAt": int(time.time() * 1000) - 30000,
                          "lastAssistantMessage": "codex の報告"}])
        out, _ = self.start_wait().communicate(timeout=10)
        self.assertIn("入力待ち", out)
        self.assertIn("codex の報告", out)


class MissedWhileNotWatching(Base):
    """2026-11-16 の取りこぼし: wait が止まっていた間・起動前に終わった worker を、遷移を見ていなくても拾う。"""

    def age_send(self, seconds):
        ws = self.workers()
        ws[WORKER]["sent_at_ms"] = int(time.time() * 1000) - seconds * 1000
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)

    def finished(self, seconds_ago, message="20:48 に終わった"):
        self.set_agents([{"paneKey": "tab:w1", "state": "done",
                          "stateStartedAt": int(time.time() * 1000) - seconds_ago * 1000, "lastAssistantMessage": message}])

    def wait_once(self):
        return subprocess.run([WORKERCTL, "wait", "--interval", "0.2", "--timeout-min", "0.05"], env=self.env,
                              stdout=subprocess.PIPE, text=True, timeout=20).stdout

    def test_wait_reports_a_worker_already_done_when_it_starts(self):
        self.adopt_working()
        self.age_send(600)
        self.finished(300)
        out = self.wait_once()
        self.assertIn("入力待ち", out)
        self.assertIn("20:48 に終わった", out)

    def test_wait_reports_a_worker_that_finished_while_wait_was_stopped(self):
        self.adopt_working()
        self.age_send(600)
        stopped = subprocess.Popen([WORKERCTL, "wait", "--interval", "0.2"], env=self.env, stdout=subprocess.PIPE, text=True)
        time.sleep(0.5)
        stopped.kill()
        stopped.wait()
        self.finished(300)
        self.assertIn("20:48 に終わった", self.wait_once())

    def test_the_main_hook_reports_it_without_a_wait_and_spaces_its_checks(self):
        self.adopt_working()
        self.age_send(600)
        self.finished(300)
        out = self.hook("main-context", {"hook_event_name": "UserPromptSubmit"})
        self.assertIn("未処理の知らせ 1 件", out)
        self.assertIn("20:48 に終わった", out)
        calls = len(self.calls())
        self.run_ctl("send", "--terminal", WORKER, "--text", "続き")
        self.age_send(600)
        self.finished(300, "次も終わった")
        self.hook("main-context", {"hook_event_name": "UserPromptSubmit"})
        shows = [c for c in self.calls()[calls:] if c[:2] == ["terminal", "show"]]
        self.assertEqual(shows, [])  # 60 秒以内なので端末を照合しない

    def test_a_done_state_older_than_the_send_is_reported_after_a_quiet_minute(self):
        self.adopt_working()
        self.finished(3600, "送る前の応答")
        self.age_send(10)
        self.assertIn("未処理の知らせ 0 件", (self.wait_once(), self.run_ctl("pending").stdout)[1])
        self.age_send(120)
        out = self.wait_once()
        self.assertIn("作業中になっていない", out)

    def test_a_worker_still_working_is_not_reported(self):
        self.adopt_working()
        self.age_send(600)
        self.set_agents([{"paneKey": "tab:w1", "state": "working", "stateStartedAt": int(time.time() * 1000) - 300000}])
        self.assertIn("知らせが無い", self.wait_once())


class Cockpit(Base):
    """窓で利用者が押した操作でも wait が終わり、メインが起こされる。"""

    def setUp(self):
        super().setUp()
        self.root = os.path.join(self.dir, "ws")
        os.makedirs(os.path.join(self.root, ".orca"))
        os.makedirs(os.path.join(self.root, ".git"))
        self.write("cockpit.json", {"applied_ops": [1]})
        self.write("cockpit.user.json", {"ops": [{"op_id": 1, "item_id": "d1", "type": "decide"}]})
        os.chdir(self.root)

    def write(self, name, data):
        with open(os.path.join(self.root, ".orca", name), "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)

    def add_op(self):
        self.write("cockpit.user.json", {"ops": [{"op_id": 1, "item_id": "d1", "type": "decide"},
                                                 {"op_id": 2, "item_id": "d9", "type": "talk", "text": "apple container やったよ"}]})

    def wait(self, *extra):
        proc = subprocess.Popen([WORKERCTL, "wait", "--interval", "0.2"] + list(extra), env=self.env,
                                stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        return proc

    def test_wait_ends_at_once_on_an_op_already_pending(self):
        self.add_op()
        out, _ = self.wait().communicate(timeout=10)
        self.assertIn("【操縦席】未反映の操作 1 件（d9・talk・apple container やったよ）", out)
        self.assertIn("cockpit skill に従って反映する", out)

    def test_wait_keeps_waiting_without_workers_and_ends_on_a_new_op(self):
        proc = self.wait()
        time.sleep(1)
        self.assertIsNone(proc.poll())
        self.add_op()
        out, _ = proc.communicate(timeout=10)
        self.assertIn("未反映の操作 1 件", out)

    def test_wait_without_a_cockpit_or_workers_ends(self):
        os.chdir(self.dir)
        out, _ = self.wait().communicate(timeout=10)
        self.assertIn("作業中の worker がいない", out)

    def test_the_cockpit_is_found_from_a_subfolder_but_not_past_a_git_folder(self):
        os.makedirs(os.path.join(self.root, "sub", "deep"))
        os.makedirs(os.path.join(self.root, "inner", ".git"))
        self.add_op()
        os.chdir(os.path.join(self.root, "sub", "deep"))
        self.assertIn("未反映の操作", self.wait().communicate(timeout=10)[0])
        os.chdir(os.path.join(self.root, "inner"))
        self.assertIn("作業中の worker がいない", self.wait().communicate(timeout=10)[0])

    def stop(self, **extra):
        payload = {"hook_event_name": "Stop", "stop_hook_active": False, "cwd": self.root}
        payload.update(extra)
        out = self.hook("main-stop", payload)
        return json.loads(out) if out.strip() else None

    def test_stop_asks_for_a_wait_when_there_is_a_cockpit_and_no_workers(self):
        decision = self.stop()
        self.assertEqual(decision["decision"], "block")
        self.assertIn("【操縦席】", decision["reason"])
        self.assertIn("workerctl wait", decision["reason"])

    def test_a_consult_thread_is_not_asked_for_a_wait(self):
        self.env["CONSULT_THREAD"] = "1"
        self.assertIsNone(self.stop())

    def test_stop_lets_go_when_active_or_a_wait_runs_or_there_is_no_cockpit(self):
        self.assertIsNone(self.stop(stop_hook_active=True))
        self.assertIsNone(self.stop(background_tasks=[{"command": "workerctl wait", "status": "running"}]))
        self.assertIsNone(self.stop(cwd=self.dir))
        proc = self.wait()
        deadline = time.time() + 5
        while not os.path.exists(os.path.join(self.home, "wait.%s.pid" % MAIN)) and time.time() < deadline:
            time.sleep(0.05)
        self.assertIsNone(self.stop())


class StaleObservation(Base):
    """wait が古い世代で見た様子を、新しい指示の止まりとして記録しない。"""

    def load_module(self):
        import importlib.machinery
        import importlib.util
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        os.environ.clear()
        os.environ.update(self.env)
        loader = importlib.machinery.SourceFileLoader("workerctl_under_test", WORKERCTL)
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
        loader.exec_module(module)
        return module

    def test_poll_drops_an_observation_taken_before_the_next_send(self):
        self.adopt_working()
        ws = self.workers()
        ws[WORKER]["sent_at_ms"] = int(time.time() * 1000) - 60000
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)
        m = self.load_module()
        seen_by_wait = m.snapshot()[0]
        self.run_ctl("send", "--terminal", WORKER, "--text", "次の指示")
        self.set_agents([{"paneKey": "tab:w1", "state": "done", "stateStartedAt": int(time.time() * 1000) - 30000}])
        m.poll(seen_by_wait, [WORKER])
        self.assertEqual(self.workers()[WORKER]["state"], "working")
        self.assertIn("未処理の知らせ 0 件", self.run_ctl("pending").stdout)

    def test_poll_reports_a_turn_whose_prompt_hook_did_not_fire(self):
        self.adopt_working()
        self.run_ctl("send", "--terminal", WORKER, "--text", "次の指示")
        self.worker_stop("UserPromptSubmit が来なかった応答の結果")
        self.assertEqual(self.workers()[WORKER]["state"], "working")
        ws = self.workers()
        ws[WORKER]["sent_at_ms"] = int(time.time() * 1000) - 60000
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)
        self.set_agents([{"paneKey": "tab:w1", "state": "done", "stateStartedAt": int(time.time() * 1000) - 30000,
                          "lastAssistantMessage": "見張りが拾った結果"}])
        m = self.load_module()
        m.poll(m.snapshot()[0], [WORKER])
        self.assertIn("見張りが拾った結果", self.run_ctl("pending").stdout)


class MainHooks(Base):
    def stop(self, **extra):
        payload = {"hook_event_name": "Stop", "stop_hook_active": False, "last_assistant_message": "報告"}
        payload.update(extra)
        out = self.hook("main-stop", payload)
        return json.loads(out) if out.strip() else None

    def test_stop_blocks_while_a_worker_works_without_a_wait(self):
        self.adopt_working()
        decision = self.stop()
        self.assertEqual(decision["decision"], "block")
        self.assertIn("workerctl wait", decision["reason"])

    def test_stop_does_not_block_when_the_stop_hook_is_already_active(self):
        self.adopt_working()
        self.assertIsNone(self.stop(stop_hook_active=True))

    def test_stop_does_not_block_when_a_wait_runs_in_the_background(self):
        self.adopt_working()
        self.assertIsNone(self.stop(background_tasks=[{"id": "b1", "type": "shell", "status": "running",
                                                       "command": "workerctl wait"}]))

    def test_stop_blocks_once_for_the_same_pending_set(self):
        self.adopt_working()
        self.worker_stop()
        self.assertIn("未処理の知らせ 1 件", self.stop()["reason"])
        self.assertIsNone(self.stop())

    def test_stop_does_nothing_outside_orca(self):
        self.adopt_working()
        self.assertEqual(self.hook("main-stop", {"hook_event_name": "Stop"}, as_terminal=None), "")

    def test_context_names_pending_events_and_a_missing_wait(self):
        self.adopt_working()
        out = self.hook("main-context", {"hook_event_name": "UserPromptSubmit"})
        self.assertIn("見張りが動いていない", out)
        self.worker_stop()
        out = self.hook("main-context", {"hook_event_name": "SessionStart", "source": "compact"})
        self.assertIn("未処理の知らせ 1 件", out)
        self.assertLessEqual(len(out.strip().splitlines()), 3)

    def test_context_is_silent_without_workers(self):
        self.assertEqual(self.hook("main-context", {"hook_event_name": "UserPromptSubmit"}), "")

    def pretool(self, command, as_terminal=MAIN):
        out = self.hook("main-pretool", {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                                         "tool_input": {"command": command}}, as_terminal=as_terminal)
        return json.loads(out)["hookSpecificOutput"]["permissionDecision"] if out.strip() else None

    def test_pretool_denies_a_direct_send_and_agent_create(self):
        self.assertEqual(self.pretool("orca terminal send --terminal %s --text hi --enter" % WORKER), "deny")
        self.assertEqual(self.pretool('orca terminal create --worktree id:x --command "env CLAUDE_CONFIG_DIR=/p claude --model opus"'), "deny")
        self.assertEqual(self.pretool('"$ORCA_CLI_COMMAND" terminal send --terminal t --text a'), "deny")

    def test_pretool_denies_orca_in_command_position_only(self):
        self.assertEqual(self.pretool("FOO=1 orca terminal send --terminal t"), "deny")
        self.assertEqual(self.pretool("x=$(orca terminal send --terminal t)"), "deny")
        self.assertIsNone(self.pretool("echo orca terminal send"))
        self.assertIsNone(self.pretool('printf "%s" "orca terminal send"'))
        self.assertIsNone(self.pretool("cat <<'EOF' > note.md\norca terminal send --terminal t\nEOF"))

    def test_pretool_denies_direct_ops_inside_if_while_and_for(self):
        self.assertEqual(self.pretool('if true; then orca terminal create --worktree x --command "claude"; fi'), "deny")
        self.assertEqual(self.pretool("if orca terminal send --terminal t --text a; then :; fi"), "deny")
        self.assertEqual(self.pretool("while true; do orca terminal send --terminal t --text a; done"), "deny")
        self.assertEqual(self.pretool("for t in a b; do orca terminal send --terminal $t --text a; done"), "deny")
        self.assertEqual(self.pretool("if false; then :; else orca terminal send --terminal t; fi"), "deny")
        self.assertEqual(self.pretool("{ orca terminal send --terminal t; }"), "deny")
        self.assertEqual(self.pretool("! orca terminal send --terminal t"), "deny")

    def test_pretool_denies_a_direct_op_when_a_later_line_cannot_be_parsed(self):
        out = self.hook("main-pretool", {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {
            "command": 'orca terminal send --terminal t --text hi\nprintf "unclosed'}})
        decision = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertIn("解析できないので、orca を呼ぶ行を分けて workerctl", decision["permissionDecisionReason"])
        self.assertEqual(self.pretool('orca terminal create --worktree x --command claude\necho "unclosed'), "deny")

    def test_pretool_allows_an_unparsable_command_without_direct_ops(self):
        self.assertIsNone(self.pretool('echo "unclosed'))
        self.assertIsNone(self.pretool('orca terminal create --worktree x\necho "unclosed'))

    def test_pretool_allows_workerctl_and_other_orca_commands(self):
        self.assertIsNone(self.pretool('workerctl send --terminal t --text "orca terminal send の話"'))
        self.assertIsNone(self.pretool('orca terminal create --worktree active --command "pnpm dev"'))
        self.assertIsNone(self.pretool("orca terminal read --terminal t --limit 40"))

    def test_pretool_does_nothing_outside_orca(self):
        self.assertIsNone(self.pretool("orca terminal send --terminal t --text hi", as_terminal=None))


class Tidy(Base):
    """2026-11-16 に done だけ打って worktree 3 つとブランチ 4 本を残した。done が片付け、hook が片付け忘れと放置を拾う。"""

    def setUp(self):
        super().setUp()
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_NAME="t",
                        GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
        self.rows = []
        self.root = self.add_repo("repo", "r1")

    def add_repo(self, name, repo_id, branch="main"):
        root = os.path.join(self.dir, name)
        os.makedirs(root)
        self.git(root, "init", "-q", "-b", branch)
        self.commit(root, "README", "最初")
        self.rows.append({"path": root, "branch": "refs/heads/" + branch, "repoId": repo_id, "isMainWorktree": True,
                          "workspaceKind": "git", "agents": [], "lastActivityAt": self.ms_ago(0)})
        self.save_rows()
        return root

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", cwd] + list(args), env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, cwd, name, message):
        with open(os.path.join(cwd, name), "a") as fh:
            fh.write(message + "\n")
        self.git(cwd, "add", name)
        self.git(cwd, "commit", "-q", "-m", message)
        return self.git(cwd, "rev-parse", "HEAD")

    def ms_ago(self, hours):
        return int((time.time() - hours * 3600) * 1000)

    def save_rows(self):
        with open(os.path.join(self.fake, "worktrees.json"), "w") as fh:
            json.dump(self.rows, fh)

    def worktree(self, name, agents=(), hours_idle=0, root=None, repo_id="r1", branch=None, base="main", detach=False):
        path = os.path.join(self.dir, name)
        branch = branch or name
        if detach:
            self.git(root or self.root, "worktree", "add", "-q", "--detach", path, base)
        else:
            self.git(root or self.root, "worktree", "add", "-q", "-b", branch, path, base)
        self.rows.append({"path": path, "branch": "" if detach else "refs/heads/" + branch, "repoId": repo_id,
                          "isMainWorktree": False, "workspaceKind": "git", "agents": list(agents),
                          "lastActivityAt": self.ms_ago(hours_idle)})
        self.save_rows()
        return path

    def register(self, handle, path):
        os.makedirs(self.home, exist_ok=True)
        try:
            ws = self.workers()
        except FileNotFoundError:
            ws = {}
        ws[handle] = {"owner": MAIN, "title": "t", "worktree": "path:" + path, "state": "stopped", "gen": 1,
                      "sent_at_ms": 0}
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)

    def branches(self):
        return self.git(self.root, "branch", "--format=%(refname:short)").split()

    def rm_calls(self):
        return [c for c in self.calls() if c[:2] == ["worktree", "rm"]]

    def done(self, path, *extra):
        self.register(WORKER, path)
        return self.run_ctl("done", "--terminal", WORKER, *extra).stdout

    def test_done_removes_a_clean_merged_worktree_and_its_branch(self):
        path = self.worktree("merged")
        self.commit(path, "a", "取り込んだ変更")
        self.git(self.root, "merge", "-q", "--ff-only", "merged")
        out = self.done(path)
        self.assertIn("worktree を消した", out)
        self.assertEqual(self.rm_calls()[0][2:], ["--worktree", "path:" + path, "--delete-branch", "--json"])
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self.branches(), ["main"])

    def merged_worktree_with_a_dev_plugin(self, name):
        path = self.worktree(name)
        self.commit(path, "a", "取り込んだ変更")
        self.git(self.root, "merge", "-q", "--ff-only", name)
        src = os.path.join(path, "orca", "plugins", "cockpit")
        with open(os.path.join(self.fake, "plugins.json"), "w") as fh:
            json.dump([{"pluginKey": "local.cockpit", "isDev": False, "source": {"reference": "/home/me/agent-harness/orca/plugins/cockpit"}},
                       {"pluginKey": "local.cockpit", "isDev": True, "source": {"reference": src}},
                       {"pluginKey": "local.other", "isDev": True, "source": {"reference": path + "-other/p"}}], fh)
        return path, src

    def test_done_unloads_a_dev_plugin_loaded_from_the_worktree_before_removing_it(self):
        # 開発用の読み込み元を消すと、本物の操縦席のプラグインが承認待ちに戻り、窓が Orca に追いつかなくなった（2026-11-16）
        path, src = self.merged_worktree_with_a_dev_plugin("plugin-dev")
        out = self.done(path)
        self.assertIn("開発用に読み込んでいたプラグイン local.cockpit（%s）を外した" % src, out)
        unload = [c for c in self.calls() if c[:3] == ["plugin", "dev", "unload"]]
        self.assertEqual(unload, [["plugin", "dev", "unload", src, "--json"]], "名前の似た別の worktree の読み込みは外さない")
        calls = self.calls()
        self.assertLess(calls.index(unload[0]), calls.index(self.rm_calls()[0]))
        self.assertIn("worktree を消した", out)

    def test_done_keeps_the_worktree_when_its_dev_plugin_cannot_be_unloaded(self):
        path, src = self.merged_worktree_with_a_dev_plugin("plugin-stuck")
        with open(os.path.join(self.fake, "unload_fails.json"), "w") as fh:
            json.dump(True, fh)
        out = self.done(path)
        self.assertIn("worktree を残した: %s。開発用に読み込んだプラグイン local.cockpit（%s）を外せなかった" % (path, src), out)
        self.assertEqual(self.rm_calls(), [])
        self.assertTrue(os.path.exists(path))

    def test_a_cherry_picked_commit_counts_as_merged(self):
        path = self.worktree("picked")
        sha = self.commit(path, "a", "cherry-pick で取り込む")
        self.git(self.root, "cherry-pick", sha)
        self.assertIn("worktree を消した", self.done(path))

    def test_done_keeps_a_worktree_with_uncommitted_files(self):
        path = self.worktree("dirty")
        with open(os.path.join(path, "wip"), "w") as fh:
            fh.write("x")
        out = self.done(path)
        self.assertIn("未 commit のファイル 1 件", out)
        self.assertEqual(self.rm_calls(), [])
        self.assertIn("diff で控えて", out)

    def test_untracked_copies_of_root_files_do_not_block_the_removal(self):
        for base in (self.root, os.path.join(self.dir, "copied")):
            if base != self.root:
                self.worktree("copied")
            os.makedirs(os.path.join(base, ".claude"), exist_ok=True)
            for name in ("CLAUDE.local.md", os.path.join(".claude", "settings.local.json")):
                with open(os.path.join(base, name), "w") as fh:
                    fh.write("ルートと同じ")
        path = os.path.join(self.dir, "copied")
        self.assertIn("worktree を消した", self.done(path))
        self.assertIn("--force", self.rm_calls()[0])
        self.assertFalse(os.path.exists(path))

    def test_an_untracked_file_that_differs_from_the_root_blocks_the_removal(self):
        with open(os.path.join(self.root, "CLAUDE.local.md"), "w") as fh:
            fh.write("ルート")
        path = self.worktree("edited")
        with open(os.path.join(path, "CLAUDE.local.md"), "w") as fh:
            fh.write("worker が書き足した")
        self.assertIn("未 commit のファイル 1 件", self.done(path))
        self.assertEqual(self.rm_calls(), [])

    def test_done_keeps_a_worktree_with_unmerged_commits_and_names_them(self):
        path = self.worktree("ahead")
        self.commit(path, "a", "まだ入れていない変更")
        out = self.done(path)
        self.assertIn("main に無い commit 1 件", out)
        self.assertIn("まだ入れていない変更", out)
        self.assertIn("--discard", out)
        self.assertEqual(self.rm_calls(), [])

    def test_done_keeps_a_worktree_where_an_agent_works(self):
        path = self.worktree("busy", agents=[{"state": "working"}])
        self.assertIn("作業中のエージェントがいる", self.done(path))
        self.assertEqual(self.rm_calls(), [])

    def test_done_never_removes_the_repository_root(self):
        self.assertIn("リポジトリのルート", self.done(self.root, "--discard"))
        self.assertEqual(self.rm_calls(), [])

    def test_keep_skips_the_cleanup(self):
        path = self.worktree("kept")
        self.assertIn("--keep なので", self.done(path, "--keep"))
        self.assertEqual(self.rm_calls(), [])
        self.assertTrue(os.path.exists(path))
        self.assertEqual(self.workers()[WORKER]["state"], "closed")

    def test_discard_removes_unmerged_commits_and_the_branch(self):
        path = self.worktree("dropped")
        sha = self.commit(path, "a", "取り込まないと決めた変更")
        out = self.done(path, "--discard")
        self.assertIn("worktree を消した", out)
        self.assertIn("git branch dropped %s" % sha, out)
        self.assertEqual(self.branches(), ["main"])

    def test_discard_still_keeps_uncommitted_files(self):
        path = self.worktree("dropped-dirty")
        self.commit(path, "a", "捨てる")
        with open(os.path.join(path, "wip"), "w") as fh:
            fh.write("x")
        self.assertIn("未 commit のファイル 1 件", self.done(path, "--discard"))
        self.assertEqual(self.rm_calls(), [])

    # ---- Codex が再現した、消してはいけないものを消す 3 つの経路 ----

    def same_named_branch_in_another_repo(self):
        """別リポジトリに同名ブランチ task の worktree があり、未取り込みの commit を持つ。ps ではそちらが先に並ぶ。"""
        other = self.add_repo("other", "r2")
        other_path = self.worktree("other-task", root=other, repo_id="r2", branch="task")
        self.commit(other_path, "a", "別リポジトリの未取り込みの変更")
        mine = self.worktree("mine-task", branch="task")
        return other_path, mine

    def test_done_removes_the_worktree_the_terminal_was_started_in_not_a_same_named_branch(self):
        other_path, mine = self.same_named_branch_in_another_repo()
        with open(os.path.join(self.fake, "create_path.json"), "w") as fh:
            json.dump(mine, fh)
        handle = self.run_ctl("start", "--worktree", "branch:task", "--title", "t", "--", "claude").stdout.strip()
        self.assertEqual(self.workers()[handle]["worktree_path"], mine)
        out = self.run_ctl("done", "--terminal", handle, "--discard").stdout
        self.assertIn("worktree を消した: %s" % mine, out)
        self.assertTrue(os.path.exists(other_path))

    def test_adopt_records_the_terminal_path_even_with_a_branch_selector(self):
        other_path, mine = self.same_named_branch_in_another_repo()
        self.set_terminals([{"handle": WORKER, "tabId": "tab", "leafId": "w1", "worktreePath": mine}])
        self.run_ctl("adopt", "--terminal", WORKER, "--title", "t", "--worktree", "branch:task")
        self.run_ctl("done", "--terminal", WORKER, "--discard")
        self.assertFalse(os.path.exists(mine))
        self.assertTrue(os.path.exists(other_path))

    def test_an_old_registration_that_matches_several_worktrees_is_refused(self):
        other_path, mine = self.same_named_branch_in_another_repo()
        self.register(WORKER, mine)
        ws = self.workers()
        ws[WORKER]["worktree"] = "branch:task"
        with open(os.path.join(self.home, "workers.json"), "w") as fh:
            json.dump(ws, fh)
        out = self.run_ctl("done", "--terminal", WORKER, "--discard").stdout
        self.assertIn("2 つの worktree に当たる", out)
        self.assertEqual(self.rm_calls(), [])
        self.assertNotIn(other_path, self.context(cwd=self.dir))

    def test_a_change_only_in_a_merge_commit_is_not_taken_as_merged(self):
        path = self.worktree("evil")
        sha = self.commit(path, "a", "worker の変更")
        self.commit(self.root, "b", "main が進んだ")
        self.git(path, "merge", "-q", "--no-ff", "--no-commit", "main")
        with open(os.path.join(path, "b"), "a") as fh:
            fh.write("競合の解決でマージコミットにだけ入れた変更\n")
        self.git(path, "add", "b")
        self.git(path, "commit", "-q", "-m", "main をマージ")
        self.git(self.root, "cherry-pick", sha)
        out = self.done(path)
        self.assertIn("main に無いマージコミット 1 件", out)
        self.assertIn("--discard", out)
        self.assertEqual(self.rm_calls(), [])
        self.assertIn("worktree を消した", self.run_ctl("done", "--terminal", WORKER, "--discard").stdout)

    def test_a_detached_head_is_not_removed_automatically(self):
        path = self.worktree("detached", detach=True)
        out = self.done(path)
        self.assertIn("detached HEAD", out)
        self.assertEqual(self.rm_calls(), [])
        head = self.git(path, "rev-parse", "HEAD")
        self.assertIn(head, self.run_ctl("done", "--terminal", WORKER, "--discard").stdout)

    def test_the_branch_checked_out_at_the_root_is_not_taken_as_the_default(self):
        path = self.worktree("feat")
        self.commit(path, "a", "review にだけ入れた変更")
        self.git(self.root, "checkout", "-q", "-b", "review")
        self.git(self.root, "merge", "-q", "--ff-only", "feat")
        self.rows[0]["branch"] = "refs/heads/review"
        self.save_rows()
        out = self.done(path)
        self.assertIn("main に無い commit 1 件", out)
        self.assertEqual(self.rm_calls(), [])

    def test_without_origin_main_or_master_the_default_is_unknown_and_nothing_is_removed(self):
        trunk = self.add_repo("trunk-repo", "r3", branch="trunk")
        path = self.worktree("on-trunk", root=trunk, repo_id="r3", base="trunk")
        out = self.done(path, "--discard")
        self.assertIn("default ブランチを決められない", out)
        self.assertEqual(self.rm_calls(), [])

    def context(self, cwd=None):
        return self.hook("main-context", {"hook_event_name": "UserPromptSubmit", "cwd": cwd or self.dir})

    def stop(self, **extra):
        payload = {"hook_event_name": "Stop", "stop_hook_active": False, "cwd": self.root}
        payload.update(extra)
        out = self.hook("main-stop", payload)
        return json.loads(out) if out.strip() else None

    def test_hooks_name_a_forgotten_worktree_of_a_closed_worker_and_stop_once(self):
        path = self.worktree("forgotten")
        self.register(WORKER, path)
        self.run_ctl("done", "--terminal", WORKER, "--keep")
        out = self.context()
        self.assertIn("片付け忘れの worktree 1 件", out)
        self.assertIn(path, out)
        decision = self.stop()
        self.assertEqual(decision["decision"], "block")
        self.assertIn("片付け忘れ", decision["reason"])
        self.assertIsNone(self.stop())
        self.assertIsNone(self.stop(stop_hook_active=True))

    def test_hooks_find_unregistered_worktrees_of_the_repository_the_main_is_in(self):
        path = self.worktree("unregistered")
        self.assertNotIn(path, self.context())
        self.assertIn(path, self.context(cwd=os.path.join(self.root, "sub")))
        self.assertNotIn(self.root + "（", self.context(cwd=self.root))

    def test_hooks_skip_a_worktree_where_an_agent_works(self):
        self.worktree("busy", agents=[{"state": "working"}], hours_idle=48)
        self.assertEqual(self.context(cwd=self.root), "")
        self.assertIsNone(self.stop())

    def test_a_worktree_left_with_changes_for_a_day_is_named_but_does_not_stop(self):
        old = self.worktree("old", hours_idle=25)
        self.commit(old, "a", "放置された変更")
        recent = self.worktree("recent", hours_idle=1)
        self.commit(recent, "a", "まだ見ている変更")
        out = self.context(cwd=self.root)
        self.assertIn("放置の worktree 1 件", out)
        self.assertIn(old, out)
        self.assertIn("放置された変更", out)
        self.assertNotIn(recent, out)
        self.assertNotIn("片付け忘れ", out)
        self.assertIsNone(self.stop())


class FullFlow(Base):
    """偽の orca で start → send → worker の Stop → pending → wait が起きる → resolve を 1 回通す。"""

    def test_flow(self):
        handle = self.run_ctl("start", "--worktree", "id:repo::/w", "--title", "実装", "--", "claude").stdout.strip()
        self.run_ctl("send", "--terminal", handle, "--text", "brief を読んで実装して")
        proc = subprocess.Popen([WORKERCTL, "wait", "--interval", "0.2"], env=self.env, stdout=subprocess.PIPE, text=True)
        time.sleep(0.5)
        self.worker_prompt(handle)
        self.hook("worker", {"hook_event_name": "Stop", "last_assistant_message": "実装した。テスト 12 件通過"},
                  as_terminal=handle)
        out, _ = proc.communicate(timeout=10)
        self.assertIn("テスト 12 件通過", out)
        self.assertIn("テスト 12 件通過", self.run_ctl("pending").stdout)
        self.run_ctl("resolve", "#1")
        self.assertIn("未処理の知らせ 0 件", self.run_ctl("pending").stdout)
        if os.environ.get("WORKERCTL_SHOW_FLOW"):
            sys.stderr.write("\n--- wait の出力 ---\n" + out)


if __name__ == "__main__":
    unittest.main()
