import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "account-failover")
STALLWATCH = os.path.join(HERE, "stallwatch")
MIN = 60_000
HOUR = 60 * MIN
A, B, C = "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002", "cccccccc-0000-0000-0000-000000000003"
EMAIL = {A: "owner@example.com", B: "admin@example.com", C: "member@example.com"}
SEATS = ["--seat", EMAIL[A], "--seat", EMAIL[B], "--seat", EMAIL[C]]
LIMIT_LINE = "  ⎿  You've hit your 5-hour limit · resets 4:40pm (Asia/Tokyo)"

# 偽の orca。状態は JSON ファイルに持ち、account select で選択を変え、Orca の窓がするように控えた端末の ptyId を変える。
FAKE_ORCA = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ["FAKE_DIR"]
a = [x for x in sys.argv[1:] if x != "--json"]
with open(os.path.join(d, "calls"), "a") as fh:
    fh.write(" ".join(a) + "\n")
def load(n):
    with open(os.path.join(d, n)) as fh:
        return json.load(fh)
def save(n, v):
    with open(os.path.join(d, n), "w") as fh:
        json.dump(v, fh)
def ok(r):
    print(json.dumps({"ok": True, "result": r}))
cmd = " ".join(a[:2])
if cmd == "account list":
    ok(load("accounts.json"))
elif cmd == "account select" and os.path.exists(os.path.join(d, "select-fails")):
    print(json.dumps({"ok": False, "error": {"message": "refused"}}))
elif cmd == "account select":
    acc = load("accounts.json")
    acc["claude"]["activeAccountId"] = a[a.index("--account") + 1]
    save("accounts.json", acc)
    terms = load("terminals.json")
    restart = set(load("restart.json"))
    for t in terms:
        if t["handle"] in restart:
            t["ptyId"] += "-new"
            t["handle"] += "-new"
    terms = [t for t in terms if not os.path.exists(os.path.join(d, "close-" + t["handle"]))]
    save("terminals.json", terms)
    ok(acc["claude"])
elif cmd == "terminal list":
    ok({"terminals": load("terminals.json")})
elif cmd == "agent list":
    ok({"agents": load("agents.json")} if not os.path.exists(os.path.join(d, "agents-renamed")) else {"sessions": []})
elif cmd == "terminal wait":
    h = a[a.index("--terminal") + 1]
    screen = load("screens.json").get(h)
    ok({"wait": {"satisfied": not screen, "status": "running" if screen else "tui-idle"}})
elif cmd == "terminal read":
    ok({"terminal": {"tail": load("screens.json").get(a[a.index("--terminal") + 1], [])}})
elif cmd == "orchestration worker-list":
    ok({"workers": load("workers.json")})
elif cmd == "orchestration worker-show":
    ok(load("shows.json")[a[a.index("--dispatch") + 1]])
elif cmd == "orchestration worker-start" and os.path.exists(os.path.join(d, "start-fenced")):
    print(json.dumps({"ok": False, "error": {"code": "consumer_fenced", "message": "This caller is not bound to Run run_1."}}))
elif cmd == "orchestration worker-start":
    ok({"state": "ready", "dispatchId": "ctx_re", "taskId": a[a.index("--task") + 1]})
elif cmd == "terminal send":
    ok({"accepted": True})
else:
    print(json.dumps({"ok": False, "error": {"message": "unknown"}}))
'''


def now_ms():
    return int(time.time() * 1000)


def usage(session=0, weekly=0, session_reset=None, weekly_reset=None, status="ok", updated=None, reading=None, failure=None):
    rl = {"status": status, "updatedAt": updated if updated is not None else now_ms() - MIN,
          "session": {"usedPercent": session, "resetsAt": session_reset if session_reset is not None else now_ms() + 2 * HOUR},
          "weekly": {"usedPercent": weekly, "resetsAt": weekly_reset if weekly_reset is not None else now_ms() + 48 * HOUR},
          "fableWeekly": {"usedPercent": 100, "resetsAt": now_ms() + HOUR}}
    if reading:
        rl["usageMetadata"] = {"readingAccount": {"accountId": reading}}
    if failure:
        rl.setdefault("usageMetadata", {})["failureKind"] = failure
    return rl


def terminal(handle, preview="❯", tab=None, wt=None):
    return {"handle": handle, "ptyId": "pty-" + handle, "tabId": tab or "tab-" + handle, "leafId": "leaf-" + handle,
            "connected": True, "title": "題 " + handle, "worktreePath": "/w/" + (wt or handle), "worktreeId": "r::/w/" + (wt or handle),
            "preview": preview, "lastOutputAt": now_ms() - MIN}


def claude_agent(handle, state="done", tab=None):
    return {"kind": "terminal", "agent": "claude", "state": state, "paneKey": "%s:leaf-%s" % (tab or "tab-" + handle, handle)}


def iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + ".000Z"


AUTO_MODE_SCREEN = ["Auto mode lets Claude handle permission prompts automatically.",
                    "❯ Yes, set auto mode as my default permission mode", "  No, keep bypass permissions"]


class AccountFailoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.fake = os.path.join(self.tmp, "fake")
        os.makedirs(self.fake)
        self.home = os.path.join(self.tmp, "home")
        self.script("orca", FAKE_ORCA)
        self.script("notify", "#!/bin/sh\nprintf '%%s\\t%%s\\n' \"$1\" \"$2\" >> %s\n" % os.path.join(self.tmp, "notes"))
        self.terminals([])
        self.agents([])
        self.restart([])
        self.put("screens.json", {})
        self.workers([])

    def script(self, name, body):
        path = os.path.join(self.bin, name)
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)

    def put(self, name, value):
        with open(os.path.join(self.fake, name), "w") as fh:
            json.dump(value, fh)

    def accounts(self, active, readings):
        """readings: 席 → usage()。今の席のものは rateLimits.claude に、ほかは inactiveClaudeAccounts に入れる（Orca の形）。"""
        self.put("accounts.json", {
            "claude": {"activeAccountId": active, "accounts": [{"id": i, "email": EMAIL[i]} for i in (C, B, A)]},
            "rateLimits": {"claude": dict(readings[active], usageMetadata={"readingAccount": {"accountId": active}}),
                           "inactiveClaudeAccounts": [{"accountId": i, "rateLimits": r} for i, r in readings.items() if i != active]}})

    def terminals(self, terms):
        self.put("terminals.json", terms)

    def agents(self, agents):
        self.put("agents.json", agents)

    def workers(self, lost=(), live=()):
        """lost: (dispatch, task, 古い handle, 枠, worktree) の失った Dispatch。live: (dispatch, handle, worktree) の動いている worker。"""
        # worker-list と同じく新しい順に並べる（動いている worker は失ったあとに立てたもの）。
        rows = [{"dispatchId": d, "taskId": "task_" + d, "state": "ready", "outcome": "in_progress", "terminal": h, "workspace": "r::/w/" + wt}
                for d, h, wt in live]
        rows += [{"dispatchId": d, "taskId": t, "state": "failed", "outcome": None, "terminal": h, "workspace": "r::/w/" + wt}
                 for d, t, h, _p, wt in lost]
        self.put("workers.json", rows)
        self.put("shows.json", {d: {"dispatch": {"id": d, "taskId": t, "runId": "run_1", "assigneeHandle": h, "assigneePaneKey": p,
                                                 "terminationReason": "operator_close", "completedAt": iso(now_ms())},
                                    "worker": {"worktreeId": "r::/w/" + wt}} for d, t, h, p, wt in lost})

    def seat_home(self, sid, **cfg):
        """席の置き場所（Orca の席の home）を作り、accounts.json の席に home を付ける。"""
        home = os.path.join(self.tmp, "seat-" + sid[:8])
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, ".claude.json"), "w") as fh:
            json.dump(dict({"hasCompletedOnboarding": True}, **cfg), fh)
        with open(os.path.join(home, "settings.json"), "w") as fh:
            json.dump({"permissions": {"defaultMode": "bypassPermissions"}}, fh)
        with open(os.path.join(self.fake, "accounts.json")) as fh:
            acc = json.load(fh)
        for x in acc["claude"]["accounts"]:
            if x["id"] == sid:
                x["home"] = home
        self.put("accounts.json", acc)

    def restart(self, handles):
        """account select のときに Orca が起動し直す端末。"""
        self.put("restart.json", handles)

    def env(self):
        env = dict(os.environ, PATH=self.bin + ":/usr/bin:/bin", STALLWATCH_HOME=self.home, FAKE_DIR=self.fake,
                   COCKPIT_DIR=os.path.join(self.tmp, "cockpit"), STALLWATCH_NOTIFY=os.path.join(self.bin, "notify"),
                   ORCA_CLI_COMMAND="orca", HOME=self.tmp, FAILOVER_RESTART_WAIT_S="1")
        env.pop("CLAUDE_CONFIG_DIR", None)
        return env

    def run_failover(self, *args):
        r = subprocess.run([sys.executable, SCRIPT] + SEATS + list(args), env=self.env(), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def calls(self):
        try:
            with open(os.path.join(self.fake, "calls")) as fh:
                return fh.read().splitlines()
        except FileNotFoundError:
            return []

    def selects(self):
        return [c.split("--account ")[1] for c in self.calls() if c.startswith("account select")]

    def sends(self):
        return [c.split("--terminal ")[1].split()[0] for c in self.calls() if c.startswith("terminal send")]

    def notes(self):
        try:
            with open(os.path.join(self.tmp, "notes")) as fh:
                return fh.read().splitlines()
        except FileNotFoundError:
            return []

    def status(self):
        with open(os.path.join(self.home, "failover.json")) as fh:
            return json.load(fh)["alerts"]

    def history(self):
        with open(os.path.join(self.home, "failover-history.jsonl")) as fh:
            return [json.loads(l) for l in fh]

    def test_quiet_while_the_current_seat_has_room(self):
        self.accounts(A, {A: usage(session=99), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.selects(), [])
        self.assertEqual(self.notes(), [])

    def test_moves_to_the_highest_seat_known_to_have_room(self):
        # 優先度は A → B → C。C の使用量が分からなくても、空きと分かっている B を先に選ぶ。
        self.accounts(A, {A: usage(session=100), B: usage(weekly=60), C: usage(status="error")})
        self.run_failover()
        self.assertEqual(self.selects(), [B])
        h = self.history()[-1]
        self.assertEqual((h["event"], h["from"], h["to"]), ("switched", EMAIL[A], EMAIL[B]))
        self.assertIn("admin@example.com に切り替えた", self.notes()[0])

    def test_tries_a_seat_whose_usage_is_unknown_when_no_seat_is_known_free(self):
        # stale-token は「しばらく動いていない席のトークンが古いだけ」（Orca の説明）なので、ログインが要るとは見なさない。
        self.accounts(A, {A: usage(weekly=100), B: usage(session=100), C: usage(status="error", failure="stale-token")})
        self.run_failover()
        self.assertEqual(self.selects(), [C])

    def test_weekly_limit_holds_even_after_the_5_hour_window_reset(self):
        # 2 席とも 5 時間の窓は戻ったが、B は週の枠が 100% のまま。B へは移らない。
        self.accounts(A, {A: usage(session=100), B: usage(session=100, session_reset=now_ms() - MIN, weekly=100), C: usage()})
        self.run_failover()
        self.assertEqual(self.selects(), [C])

    def test_ignores_the_fable_limit(self):
        self.accounts(A, {A: usage(session=40), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.selects(), [])

    def test_stale_reading_of_the_current_seat_is_not_trusted(self):
        self.accounts(A, {A: usage(session=100, updated=now_ms() - 40 * MIN), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.selects(), [])

    def test_restarted_terminals_that_stopped_or_were_working_are_asked_to_continue(self):
        stopped, busy, idle, stuck = (terminal("t1", "前の報告\n" + LIMIT_LINE + "\n❯"), terminal("t2", "● 調べています"),
                                      terminal("t3", "❯"), terminal("t4", LIMIT_LINE))
        # Claude でない端末（開発サーバー）のログに出た rate limit は数えない。
        server = terminal("t5", "[api] 429 rate limit exceeded, retrying")
        self.terminals([stopped, busy, idle, stuck, server])
        self.agents([{"kind": "terminal", "agent": "claude", "state": s, "paneKey": "tab-%s:leaf-%s" % (h, h)}
                     for h, s in (("t1", "done"), ("t2", "working"), ("t3", "done"), ("t4", "done"))])
        # Orca は前景が Claude の端末を起動し直す。t4 は Bash の子プロセスが前景で、移らなかった。
        self.restart(["t1", "t2", "t3"])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(sorted(self.sends()), ["t1-new", "t2-new"])
        h = self.history()[-1]
        self.assertEqual(sorted(h["nudged"]), ["題 t1（t1）", "題 t2（t2）"])
        self.assertEqual(h["not_moved"], ["題 t4（t4）"])
        self.assertIn("Orca が起動し直さなかった端末", self.notes()[0])
        self.assertTrue(all("席を admin@example.com に切り替えて" in c for c in self.calls() if c.startswith("terminal send")))

    def test_seat_that_needs_login_is_not_chosen_and_is_named(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage(status="error", failure="missing-credentials")})
        self.run_failover()
        self.run_failover()
        self.assertEqual(self.selects(), [])
        self.assertEqual(len(self.notes()), 1)
        self.assertIn("切り替えられる席が無い。member@example.com はログインが要る", self.notes()[0])
        self.assertTrue(self.status()[0]["id"].startswith("failover:no-seat:"))

    def test_dry_run_names_the_seat_that_needs_login(self):
        self.accounts(A, {A: usage(session=10), B: usage(), C: usage(status="error", failure="missing-credentials")})
        out = self.run_failover("--dry-run")
        self.assertIn("行き先にできない席: member@example.com はログインが要る", out)
        self.assertIn("切り替えない", out)
        # 上限でないあいだも、帯で先に知らせる。
        self.run_failover()
        self.assertEqual([x["id"] for x in self.status()], ["failover:seat:" + C])

    def test_seat_whose_claude_stops_at_a_startup_screen_is_not_chosen(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage()})
        self.seat_home(C)
        out = self.run_failover("--dry-run")
        self.assertIn("member@example.com はclaude を起こすと「auto mode を既定にするかの確認」で止まる", out)
        self.run_failover()
        self.assertEqual(self.selects(), [])
        # その席で一度答えれば（.claude.json に答えが残る）行き先になる。
        self.seat_home(C, hasSeenAutoDefaultNudge=True)
        self.run_failover()
        self.assertEqual(self.selects(), [C])

    def test_switch_names_workers_whose_dispatch_was_lost(self):
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        # launchd からは結び直せない（Orca は Run の coordinator にしか許さない）ので、打たずに知らせる。
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("Dispatch が失われた worker 1 個（task_1）", self.notes()[0])
        self.assertIn("account-failover --after-switch", self.notes()[0])
        (send,) = [c for c in self.calls() if c.startswith("terminal send")]
        self.assertIn("Dispatch は席の切り替えで失われた", send)
        self.assertEqual(self.history()[-1]["lost"][0]["new"], "t1-new")

    def test_restarted_terminal_stuck_at_a_startup_screen_is_named(self):
        self.terminals([terminal("t3")])
        self.agents([claude_agent("t3")])
        self.restart(["t3"])
        self.put("screens.json", {"t3-new": AUTO_MODE_SCREEN})
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.assertIn("起動し直したが止まっている端末（端末で答える）: 題 t3（t3） auto mode を既定にするかの確認", self.notes()[0])

    def run_after(self, *args):
        return subprocess.run([sys.executable, SCRIPT, "--after-switch"] + list(args), env=self.env(), capture_output=True, text=True)

    def test_after_switch_rebinds_lost_workers_to_the_terminals_orca_restarted(self):
        # t1: 同じ枠に起こし直した。t2: 別の端末（n2）で起こし直したらしい（切り替える前からいた別の Claude と見分けられない）。
        # t3: 誰かがもう結び直した。t4: 同じ worktree で worker を立て直したのに、Orca が起こし直した端末も残っている。
        # t5: 起こし直した端末が無く、同じ worktree で別の worker が動いている（立て直しか別の仕事かは分からない）。
        self.terminals([terminal("t1-new", tab="tab-t1"), terminal("n2", wt="t2"), terminal("t3-new", tab="tab-t3"),
                        terminal("t4-new", tab="tab-t4"), terminal("w4", wt="t4")])
        self.agents([claude_agent("t1-new", tab="tab-t1"), claude_agent("n2"), claude_agent("t3-new", tab="tab-t3"),
                     claude_agent("t4-new", tab="tab-t4"), claude_agent("w4", state="working")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1"), ("ctx_2", "task_2", "t2", "tab-t2:leaf-t2", "t2"),
                           ("ctx_3", "task_3", "t3", "tab-t3:leaf-t3-new", "t3"), ("ctx_4", "task_4", "t4", "tab-t4:leaf-t4-new", "t4")],
                     live=[("ctx_9", "t3-new", "t3"), ("ctx_8", "w4", "t4"), ("ctx_7", "w5", "t5")])
        with open(os.path.join(self.fake, "workers.json")) as fh:
            rows = json.load(fh)
        rows.append({"dispatchId": "ctx_5", "taskId": "task_5", "state": "failed", "terminal": "t5", "workspace": "r::/w/t5"})
        self.put("workers.json", rows)
        with open(os.path.join(self.fake, "shows.json")) as fh:
            shows = json.load(fh)
        shows["ctx_5"] = {"dispatch": dict(shows["ctx_1"]["dispatch"], id="ctx_5", taskId="task_5", assigneeHandle="t5",
                                           assigneePaneKey="tab-t5:leaf-t5"), "worker": {"worktreeId": "r::/w/t5"}}
        # 同じ枠の端末は leaf も同じ。t1 の枠は tab-t1:leaf-t1-new なので、枠を合わせる。
        shows["ctx_1"]["dispatch"]["assigneePaneKey"] = "tab-t1:leaf-t1-new"
        self.put("shows.json", shows)
        r = self.run_after()
        starts = [c for c in self.calls() if c.startswith("orchestration worker-start")]
        self.assertEqual(starts, ["orchestration worker-start --task task_1 --retry-of ctx_1 --terminal t1-new"])
        self.assertIn("task_2（ctx_2）: Orca が同じ worktree の別の端末で起こし直したらしい（題 n2（t2））。"
                      "この worker の会話か確かめてから打つ: orca orchestration worker-start --task task_2 --retry-of ctx_2 --terminal n2", r.stdout)
        self.assertIn("task_4（ctx_4）: 同じ worktree で worker（ctx_8）が動いている。Orca が起こし直した t4-new は閉じるか確かめる", r.stdout)
        self.assertNotIn("task_3", r.stdout)
        self.assertIn("task_5（ctx_5）: 同じ worktree で worker（ctx_7）が動いている。その worker で立て直したなら何もしない", r.stdout)
        self.assertEqual(r.returncode, 1)

    def test_after_switch_is_not_held_back_by_a_finished_worker_in_the_same_worktree(self):
        # 失った worker が動いているあいだに、同じ worktree で別の Task が始まって終わっていた。
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        with open(os.path.join(self.fake, "workers.json")) as fh:
            rows = json.load(fh)
        self.put("workers.json", [{"dispatchId": "ctx_6", "taskId": "task_6", "state": "succeeded", "outcome": None,
                                   "terminal": "t9", "workspace": "r::/w/t1"}] + rows)
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("orchestration worker-start --task task_1 --retry-of ctx_1 --terminal t1-new", self.calls())

    def test_after_switch_leaves_a_task_already_retried(self):
        # 前の --after-switch で結び直した worker が終わり、端末が入力待ちで残っている。同じ Task をもう一度打たない。
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        with open(os.path.join(self.fake, "workers.json")) as fh:
            rows = json.load(fh)
        self.put("workers.json", [{"dispatchId": "ctx_re", "taskId": "task_1", "state": "succeeded", "outcome": None,
                                   "terminal": "t1-new", "workspace": "r::/w/t1"}] + rows)
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))

    def test_after_switch_reports_a_dispatch_it_could_not_read(self):
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")])
        self.put("shows.json", {})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertIn("ctx_1", r.stdout)
        self.assertIn("確かめていない", r.stdout)

    def test_two_terminals_in_one_worktree_are_not_both_matched_to_one_new_terminal(self):
        # 同じ worktree の t1・t2 が消え、t2 の枠にだけ新しい端末が開いた。t1 を別の端末の起こし直しと見なして t2 の端末に送らない。
        self.terminals([terminal("t1", LIMIT_LINE, wt="x"), terminal("t2", "❯", wt="x")])
        self.agents([claude_agent("t1"), claude_agent("t2")])
        self.restart(["t2"])
        with open(os.path.join(self.fake, "restart.json"), "w") as fh:
            json.dump(["t2"], fh)
        open(os.path.join(self.fake, "close-t1"), "w").close()
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.sends(), [])
        self.assertIn("起動し直した先が分からない端末: 題 t1（x）", self.notes()[0])

    def test_a_failure_after_the_switch_is_reported_as_switched(self):
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        # 切り替えたあとの記録（履歴）に書けない。
        os.makedirs(os.path.join(self.home, "failover-history.jsonl"))
        self.run_failover()
        self.assertEqual(self.selects(), [B])
        (note,) = self.notes()
        self.assertTrue(note.startswith("Claude の席を切り替えた\t"), note)
        self.assertIn("admin@example.com に切り替えた。続きを頼む後処理が失敗した", note)
        self.assertEqual(len(self.status()), 1)

    def test_seat_never_started_is_not_chosen(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage()})
        self.seat_home(C)
        os.remove(os.path.join(self.tmp, "seat-" + C[:8], ".claude.json"))
        self.run_failover()
        self.assertEqual(self.selects(), [])
        self.assertIn("「初回の設定の画面」で止まる", self.notes()[0])

    def test_after_switch_outside_the_run_prints_the_command(self):
        self.terminals([terminal("t1-new", tab="tab-t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        open(os.path.join(self.fake, "start-fenced"), "w").close()
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertIn("Run run_1 の coordinator が打つ: orca orchestration worker-start --task task_1 --retry-of ctx_1 --terminal t1-new", r.stdout)

    def test_after_switch_does_not_type_into_a_startup_screen(self):
        self.terminals([terminal("t1-new", tab="tab-t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        self.put("screens.json", {"t1-new": AUTO_MODE_SCREEN})
        r = self.run_after()
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("確認の画面で止まっている端末: 題 t1-new（t1-new）「auto mode を既定にするかの確認」", r.stdout)
        self.assertEqual(r.returncode, 1)

    def test_all_seats_full_waits_and_tells_the_earliest_return_once(self):
        soon = now_ms() + 30 * MIN
        self.accounts(A, {A: usage(session=100), B: usage(session=100, session_reset=soon), C: usage(weekly=100)})
        self.run_failover()
        self.run_failover()
        self.assertEqual(self.selects(), [])
        self.assertEqual(len(self.notes()), 1)
        self.assertIn("全部の席が利用枠の上限", self.notes()[0])
        self.assertIn("最初に戻るのは admin@example.com の %s" % time.strftime("%H:%M", time.localtime(soon / 1000)), self.notes()[0])
        self.assertEqual(len(self.status()), 1)
        # stallwatch は帯にだけ合流させ、通知を重ねない。
        r = subprocess.run([sys.executable, STALLWATCH, "--window", "http://127.0.0.1:9"], env=self.env(), capture_output=True, text=True)
        with open(os.path.join(self.tmp, "cockpit", "alerts.json")) as fh:
            ids = [x["id"] for x in json.load(fh)["alerts"]]
        self.assertTrue(any(i.startswith("failover:all-full") for i in ids), (ids, r.stderr))
        self.assertFalse(any("全部の席" in n for n in self.notes()[1:]))
        # 枠が戻れば帯から消える。
        self.accounts(A, {A: usage(), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.status(), [])

    def test_does_not_bounce_back_to_a_seat_it_left_before_that_seat_resets(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.selects(), [B])
        # 10 分待つ代わりに、記録の時刻を戻す。B も上限になった。A の古い読み（離れる前のもの）は空きに見える。
        path = os.path.join(self.home, "failover-state.json")
        with open(path) as fh:
            st = json.load(fh)
        for s in st["switches"]:
            s["at"] -= 11 * MIN
        st["left"][A]["at"] -= 11 * MIN
        with open(path, "w") as fh:
            json.dump(st, fh)
        self.accounts(B, {B: usage(session=100), A: usage(session=10, updated=st["left"][A]["at"] - MIN), C: usage(status="error")})
        self.run_failover()
        self.assertEqual(self.selects(), [B, C])

    def test_tells_when_orca_cannot_read_the_seat_it_moved_to(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage(status="error")})
        self.run_failover()
        self.assertEqual(self.selects(), [C])
        path = os.path.join(self.home, "failover-state.json")
        with open(path) as fh:
            st = json.load(fh)
        st["moved_to"]["at"] -= 16 * MIN
        with open(path, "w") as fh:
            json.dump(st, fh)
        self.accounts(C, {C: usage(status="error"), A: usage(session=100), B: usage(session=100)})
        self.run_failover()
        self.assertTrue(any(x["id"] == "failover:blind:" + C for x in self.status()))

    def test_a_refused_switch_is_not_counted_and_is_retried(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        open(os.path.join(self.fake, "select-fails"), "w").close()
        r = subprocess.run([sys.executable, SCRIPT] + SEATS, env=self.env(), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        os.remove(os.path.join(self.fake, "select-fails"))
        # 断られた回を切り替えと数えていれば、10 分は待って試し直さない。
        self.run_failover()
        self.assertEqual(self.selects(), [B, B])
        self.assertEqual(self.history()[-1]["to"], EMAIL[B])

    def test_stops_before_switching_when_orca_changes_the_agent_list(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        open(os.path.join(self.fake, "agents-renamed"), "w").close()
        r = subprocess.run([sys.executable, SCRIPT] + SEATS, env=self.env(), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.selects(), [])
        self.assertIn("形が変わった", self.notes()[0])

    def test_waits_after_a_switch_before_switching_again(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.accounts(B, {B: usage(session=100), A: usage(session=100), C: usage()})
        out = self.run_failover()
        self.assertEqual(self.selects(), [B])
        self.assertIn("待つ", out)

    def test_dry_run_changes_nothing(self):
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([{"kind": "terminal", "agent": "claude", "state": "done", "paneKey": "tab-t1:leaf-t1"}])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        out = self.run_failover("--dry-run")
        self.assertIn("切り替える: owner@example.com → admin@example.com", out)
        self.assertIn("題 t1（t1）", out)
        self.assertEqual([c for c in self.calls() if c.startswith(("account select", "terminal send"))], [])
        self.assertFalse(os.path.exists(self.home))

    def test_assume_full_needs_dry_run(self):
        r = subprocess.run([sys.executable, SCRIPT] + SEATS + ["--assume-full"], env=self.env(), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)

    def test_unknown_seat_name_fails_loudly_once(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        args = [sys.executable, SCRIPT, "--seat", "nobody@example.com"]
        for _ in range(2):
            r = subprocess.run(args, env=self.env(), capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
        self.assertEqual(len(self.notes()), 1)
        self.assertIn("Orca に無い席", self.notes()[0])


if __name__ == "__main__":
    unittest.main()
