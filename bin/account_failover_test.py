import json
import os
import re
import signal
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
EMAIL = {A: "seat-a@example.com", B: "seat-b@example.com", C: "seat-c@example.com"}
SEATS = ["--seat", EMAIL[A], "--seat", EMAIL[B], "--seat", EMAIL[C]]
LIMIT_LINE = "  ⎿  You've hit your 5-hour limit · resets 4:40pm (Asia/Tokyo)"

# 偽の orca。状態は JSON ファイルに持ち、account select で選択を変え、Orca の窓がするように控えた端末の ptyId を変える。
FAKE_ORCA = r'''#!/usr/bin/env python3
import json, os, re, sys
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
    orphan = os.path.exists(os.path.join(d, "orphan-on-restart"))
    for t in terms:
        if t["handle"] in restart:
            t["ptyId"] += "-new"
            t["handle"] += "-new"
            if orphan:  # 窓に出ていない端末として開き直す（Orca は枠を recordedPaneKey に残す）
                t["recordedPaneKey"] = "%s:%s" % (t["tabId"], t["leafId"])
                t["tabId"] = t["leafId"] = "pty:" + t["ptyId"]
    terms = [t for t in terms if not os.path.exists(os.path.join(d, "close-" + t["handle"]))]
    if os.path.exists(os.path.join(d, "appear.json")):  # Orca が別の枠に開き直す端末
        terms += load("appear.json")
    save("terminals.json", terms)
    if os.path.exists(os.path.join(d, "workers-after.json")):
        save("workers.json", load("workers-after.json"))
    ok(acc["claude"])
elif cmd == "terminal list":
    ok({"terminals": load("terminals.json")})
elif cmd == "agent list":
    ok({"agents": load("agents.json")} if not os.path.exists(os.path.join(d, "agents-renamed")) else {"sessions": []})
elif cmd == "terminal wait":
    h = a[a.index("--terminal") + 1]
    screen = load("screens.json").get(h)
    ok({"wait": {"satisfied": not screen, "status": "running" if screen else "tui-idle"}})
elif cmd == "terminal read" and "--cursor" in a:
    # 既定は orca-launch の worker（--settings 付き）を起こした行。
    head = load("heads.json").get(a[a.index("--terminal") + 1]) or {"tail": ["  claude '--settings' '/cfg/default.json' '--resume' '00000000-0000-0000-0000-000000000000'"]}
    ok({"terminal": {"tail": head.get("tail", []), "truncated": head.get("truncated", False)}})
elif cmd == "terminal read":
    ok({"terminal": {"tail": load("screens.json").get(a[a.index("--terminal") + 1], [])}})
elif cmd == "orchestration task-list" and os.path.exists(os.path.join(d, "tasks-fail")):
    print(json.dumps({"ok": False, "error": {"code": "run_required", "message": "not bound"}}))
elif cmd == "orchestration task-list":
    ok({"tasks": load("tasks.json").get(a[a.index("--run") + 1], [])})
elif cmd == "orchestration worker-list":
    ok({"workers": load("workers.json")})
elif cmd == "orchestration worker-show":
    ok(load("shows.json")[a[a.index("--dispatch") + 1]])
elif cmd == "orchestration run-current":
    ok({"runId": load("run-current.json") if os.path.exists(os.path.join(d, "run-current.json")) else "run_1"})
elif cmd == "orchestration run-show":
    coords = load("coords.json") if os.path.exists(os.path.join(d, "coords.json")) else {"run_1": "coord_1"}
    run = a[a.index("--id") + 1]
    ok({"run": {"id": run, "coordinator_handle": coords[run]}} if run in coords else {})
elif cmd == "orchestration send" and os.path.exists(os.path.join(d, "send-fails")):
    print(json.dumps({"ok": False, "error": {"message": "refused"}}))
elif cmd == "orchestration send":
    ok({"messageId": "msg_1"})
elif cmd == "orchestration run-list":
    ok({"runs": load("runs.json") if os.path.exists(os.path.join(d, "runs.json")) else []})
elif cmd == "orchestration inbox":
    box = a[a.index("--terminal") + 1]
    ok({"messages": [m for m in (load("inbox.json") if os.path.exists(os.path.join(d, "inbox.json")) else []) if m["to_handle"] == box]})
elif cmd == "agent read":
    ok({"entries": load("talk.json") if os.path.exists(os.path.join(d, "talk.json")) else [], "source": "chat"})
elif cmd == "orchestration worker-start" and "--spec-file" in a:
    with open(a[a.index("--spec-file") + 1]) as fh:
        spec = fh.read()
    with open(os.path.join(d, "started-spec.md"), "w") as fh:
        fh.write(spec)
    if os.path.exists(os.path.join(d, "start-fails")):
        print(json.dumps({"ok": False, "error": {"message": "start failed"}}))
    else:
        if os.path.exists(os.path.join(d, "old-resumes-on-start")):
            save("agents.json", [dict(x, state="working") if x.get("kind") == "chat" else x for x in load("agents.json")])
        ws = a[a.index("--worktree") + 1].replace("path:", "r::")
        save("workers.json", [{"dispatchId": "ctx_new", "taskId": "task_new", "state": "ready", "outcome": "in_progress",
                               "terminal": "structworker_new", "workspace": ws}] + load("workers.json"))
        ok({"state": "ready", "dispatchId": "ctx_new", "taskId": "task_new", "terminal": "structworker_new"})
elif cmd == "orchestration worker-stop":
    disp = a[a.index("--dispatch") + 1]
    if not os.path.exists(os.path.join(d, "stop-keeps-chat")):
        save("workers.json", [dict(w, state="failed", outcome="failed") if w["dispatchId"] == disp else w for w in load("workers.json")])
        save("agents.json", [x for x in load("agents.json") if x.get("dispatch") != disp])
    ok({"processAction": "closed_agent_terminal"})
elif cmd == "orchestration task-update" and os.path.exists(os.path.join(d, "task-update-fails-once")):
    os.remove(os.path.join(d, "task-update-fails-once"))
    print(json.dumps({"ok": False, "error": {"message": "refused"}}))
elif cmd in ("orchestration worker-release", "orchestration task-update"):
    ok({})
elif cmd == "orchestration worker-start" and os.path.exists(os.path.join(d, "start-fenced")):
    print(json.dumps({"ok": False, "error": {"code": "consumer_fenced", "message": "This caller is not bound to Run run_1."}}))
elif cmd == "orchestration worker-start":
    ok({"state": "ready", "dispatchId": "ctx_re", "taskId": a[a.index("--task") + 1]})
elif cmd == "terminal close":
    h = a[a.index("--terminal") + 1]
    save("terminals.json", [t for t in load("terminals.json") if t["handle"] != h])
    ok({"closed": True})
elif cmd == "terminal send":
    h, text = a[a.index("--terminal") + 1], a[a.index("--text") + 1]
    screens = load("screens.json")
    if text.startswith(("claude ", "env ")) and os.path.exists(os.path.join(d, "launch-fails-once")):
        os.remove(os.path.join(d, "launch-fails-once"))
        print(json.dumps({"ok": False, "error": {"message": "send failed"}}))
        sys.exit(0)
    if text == "/exit" and os.path.exists(os.path.join(d, "exit-closes-dispatch")):
        # claude を終えると、Orca がその端末の Dispatch を閉じる場合。
        save("workers.json", [dict(w, state="failed", outcome=None) if w.get("terminal") == h else w for w in load("workers.json")])
    if text == "/exit" and not os.path.exists(os.path.join(d, "exit-hangs")):
        # claude は終わるときに会話を開き直すコマンドを出し、画面の幅で折り返す。
        # 開き直していた会話 id（出力に無ければ、閉じた端末の終わりの案内のもの）。
        sid = re.findall(r"[0-9a-f]{8}-[0-9a-f-]{27}", json.dumps(load("heads.json").get(h)) + json.dumps(load("shows.json")))[0]
        screens[h] = ["Resume this session with:", "claude --resume " + sid[:20], sid[20:], "~/w/x", "❯"]
    elif text.startswith(("claude ", "env ")):
        screens[h] = load("after-launch.json") if os.path.exists(os.path.join(d, "after-launch.json")) else []
    save("screens.json", screens)
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
            "preview": preview, "lastOutputAt": now_ms() - MIN, "agentIdentity": "claude"}


def claude_agent(handle, state="done", tab=None):
    return {"kind": "terminal", "agent": "claude", "state": state, "paneKey": "%s:leaf-%s" % (tab or "tab-" + handle, handle)}


def resume_hint(session, settings=None):
    return "✽ Clauding…\nResume this session with:\nclaude --model opus%s --resume %s\n~/w ShoFukada/x 3m\n❯" % (
        " --settings " + settings if settings else "", session) if session else "❯"


def launch_head(session, settings=None):
    return {"tail": ["", "~/w/x", "  claude  '/orca-agent-view' '--dangerously-skip-permissions'%s '--resume' '%s'" % (
        " '--settings' '%s'" % settings if settings else "", session)]}


WORKER_SETTINGS = "/cfg/claude/settings.worker.json"
S1, S2 = "58edbc6e-ae7a-4cad-b6c9-613f01bceda8", "73147483-b7f2-48de-83f1-b2428f1e2b56"


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
        self.put("heads.json", {})
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

    def workers(self, lost=(), live=(), status="ready", sessions=None, settings=None):
        """lost: (dispatch, task, 古い handle, 枠, worktree) の失った Dispatch。live: (dispatch, handle, worktree) の動いている worker。
        status: 失った Task の今の状態（Orca は operator_close で失った Task を ready に戻す）。sessions: dispatch → 閉じた端末で動いていた会話 id。"""
        # worker-list と同じく新しい順に並べる（動いている worker は失ったあとに立てたもの）。
        rows = [{"dispatchId": d, "taskId": "task_" + d, "state": "ready", "outcome": "in_progress", "terminal": h, "workspace": "r::/w/" + wt}
                for d, h, wt in live]
        rows += [{"dispatchId": d, "taskId": t, "state": "failed", "outcome": None, "terminal": h, "workspace": "r::/w/" + wt}
                 for d, t, h, _p, wt in lost]
        self.put("workers.json", rows)
        self.put("shows.json", {d: {"dispatch": {"id": d, "taskId": t, "runId": "run_1", "assigneeHandle": h, "assigneePaneKey": p,
                                                 "terminationReason": "operator_close", "completedAt": iso(now_ms())},
                                    "worker": {"worktreeId": "r::/w/" + wt},
                                    "terminal": {"handle": h, "connected": False, "preview": resume_hint((sessions or {}).get(d), settings)}}
                                for d, t, h, p, wt in lost})
        self.put("tasks.json", {"run_1": [{"id": t, "status": status} for _d, t, _h, _p, _wt in lost]})

    def show(self, dispatch, **fields):
        """失ったあとに立った Dispatch の詳細（followUpOf・retryOfDispatchId）を worker-show に足す。"""
        with open(os.path.join(self.fake, "shows.json")) as fh:
            shows = json.load(fh)
        shows[dispatch] = {"dispatch": dict({"id": dispatch}, **fields)}
        self.put("shows.json", shows)

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

    def lose_on_switch(self):
        """今の workers.json の失った Dispatch を、切り替える前は動いていたことにする（account select で失う）。"""
        with open(os.path.join(self.fake, "workers.json")) as fh:
            rows = json.load(fh)
        self.put("workers-after.json", rows)
        self.put("workers.json", [dict(w, state="ready", outcome="in_progress") if w["state"] == "failed" else w for w in rows])

    def restart(self, handles):
        """account select のときに Orca が起動し直す端末。"""
        self.put("restart.json", handles)

    def env(self):
        env = dict(os.environ, PATH=self.bin + ":/usr/bin:/bin", STALLWATCH_HOME=self.home, FAKE_DIR=self.fake,
                   COCKPIT_DIR=os.path.join(self.tmp, "cockpit"), STALLWATCH_NOTIFY=os.path.join(self.bin, "notify"),
                   ORCA_CLI_COMMAND="orca", HOME=self.tmp, FAILOVER_RESTART_WAIT_S="1", FAILOVER_EXIT_WAIT_S="3",
                   FAILOVER_SCRATCH_ROOT=os.path.join(self.tmp, "scratch"))
        env.pop("CLAUDE_CONFIG_DIR", None)
        env.pop("ORCA_WORKER_SETTINGS", None)
        return env

    def run_cmd(self, *args, timeout=60):
        """試験の環境で args を動かす。偽の orca が返らないと account-failover は呼び出しごとに 30 秒まで待つので、
        上限を超えたら孫の偽の orca ごと止め、最後に呼んだ orca を出して落とす（全件が止まって見えないように）。"""
        p = subprocess.Popen(args, env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            out, err = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()
            self.fail("%d 秒で終わらなかった: %s。最後に呼んだ orca: %s" % (timeout, " ".join(args[1:]), self.calls()[-3:]))
        return subprocess.CompletedProcess(args, p.returncode, out, err)

    def run_failover(self, *args):
        r = self.run_cmd(sys.executable, SCRIPT, *SEATS, *args)
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
        self.assertIn("seat-b@example.com に切り替えた", self.notes()[0])

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
        self.assertTrue(all("席を seat-b@example.com に切り替えて" in c for c in self.calls() if c.startswith("terminal send")))

    def test_seat_that_needs_login_is_not_chosen_and_is_named(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage(status="error", failure="missing-credentials")})
        self.run_failover()
        self.run_failover()
        self.assertEqual(self.selects(), [])
        self.assertEqual(len(self.notes()), 1)
        self.assertIn("切り替えられる席が無い。seat-c@example.com はログインが要る", self.notes()[0])
        self.assertTrue(self.status()[0]["id"].startswith("failover:no-seat:"))

    def test_dry_run_names_the_seat_that_needs_login(self):
        self.accounts(A, {A: usage(session=10), B: usage(), C: usage(status="error", failure="missing-credentials")})
        out = self.run_failover("--dry-run")
        self.assertIn("行き先にできない席: seat-c@example.com はログインが要る", out)
        self.assertIn("切り替えない", out)
        # 上限でないあいだも、帯で先に知らせる。
        self.run_failover()
        self.assertEqual([x["id"] for x in self.status()], ["failover:seat:" + C])

    def test_seat_whose_claude_stops_at_a_startup_screen_is_not_chosen(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage()})
        self.seat_home(C)
        out = self.run_failover("--dry-run")
        self.assertIn("seat-c@example.com はclaude を起こすと「auto mode を既定にするかの確認」で止まる", out)
        self.run_failover()
        self.assertEqual(self.selects(), [])
        # その席で一度答えれば（.claude.json に答えが残る）行き先になる。
        self.seat_home(C, hasSeenAutoDefaultNudge=True)
        self.run_failover()
        self.assertEqual(self.selects(), [C])

    def lost_on_switch(self):
        """切り替えで Dispatch を失う worker の端末 t1（上限で止まっていた）。Orca は t1-new として worker の設定のまま起こし直す。"""
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1}, settings=WORKER_SETTINGS)
        self.lose_on_switch()
        self.put("heads.json", {"t1-new": launch_head(S1, WORKER_SETTINGS)})
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})

    def test_switch_rebinds_lost_workers_as_their_coordinator(self):
        self.lost_on_switch()
        self.run_failover()
        # coordinator（窓口・担当）が上限で止まっていても進むよう、launchd が Run の coordinator の名で結び直す。
        self.assertIn("orchestration worker-start --task task_1 --terminal t1-new --from coord_1 --run run_1", self.calls())
        # worker-start が Task を渡して作業を始めさせるので、続きは別に頼まない（二重に頼まない）。
        self.assertEqual(self.sends(), [])
        # 結び直したことを、worker の端末から coordinator に知らせる。
        (told,) = [c for c in self.calls() if c.startswith("orchestration send")]
        self.assertIn("--from t1-new --type status", told)
        self.assertIn("同じ Task を別の worker に出さない", told)
        self.assertIn("Dispatch が失われた worker 1 個（task_1）を、Orca が起こし直した端末に結び直して続けさせた", self.notes()[0])
        self.assertEqual(self.history()[-1]["rebound"], ["task_1"])

    def test_switch_asks_the_worker_to_continue_when_it_cannot_rebind(self):
        self.lost_on_switch()
        self.put("coords.json", {})
        self.run_failover()
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        # 続きを頼むと、coordinator が別の端末に出し直した同じ Task と二重に動きうるので頼まない。
        self.assertEqual(self.sends(), [])
        self.assertIn("続きを頼んでいない。Dispatch を結び直せなかった（Run run_1 の coordinator が分からない）", self.notes()[0])
        # coordinator がチャットで launchd から名乗れないときは、Run の受信箱あてに知らせる。
        (told,) = [c for c in self.calls() if c.startswith("orchestration send")]
        self.assertIn("--from t1-new --to run:run_1 --type status", told)
        self.assertIn("account-failover --after-switch", told)
        self.assertIn("結び直せなかった worker task_1（Run run_1 の coordinator が分からない）。Run run_1 の coordinator が "
                      "account-failover --after-switch を打つ", self.notes()[0])

    def test_switch_resends_the_notice_to_the_coordinator_when_it_could_not_send(self):
        self.lost_on_switch()
        open(os.path.join(self.fake, "send-fails"), "w").close()
        self.run_failover()
        os.remove(os.path.join(self.fake, "send-fails"))
        self.accounts(B, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        tells = [c for c in self.calls() if c.startswith("orchestration send")]
        self.assertEqual(len(tells), 2)
        self.assertEqual(tells[0], tells[1])
        self.assertEqual(len([c for c in self.calls() if c.startswith("orchestration worker-start")]), 1)
        self.run_failover()
        self.assertEqual(len([c for c in self.calls() if c.startswith("orchestration send")]), 2)  # 送れたら送り直さない

    def test_restarted_terminal_stuck_at_a_startup_screen_is_named(self):
        self.terminals([terminal("t3")])
        self.agents([claude_agent("t3")])
        self.restart(["t3"])
        self.put("screens.json", {"t3-new": AUTO_MODE_SCREEN})
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.assertIn("起動し直したが止まっている端末（端末で答える）: 題 t3（t3） auto mode を既定にするかの確認", self.notes()[0])

    def run_after(self, *args):
        return self.run_cmd(sys.executable, SCRIPT, "--after-switch", *args)

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
        self.put("tasks.json", {"run_1": [{"id": "task_%d" % n, "status": "ready"} for n in range(1, 6)]})
        self.show("ctx_9", retryOfDispatchId="ctx_3")
        r = self.run_after()
        starts = [c for c in self.calls() if c.startswith("orchestration worker-start")]
        self.assertEqual(starts, ["orchestration worker-start --task task_1 --terminal t1-new"])
        self.assertIn("task_2（ctx_2）: Orca が同じ worktree の別の端末で起こし直したらしい（題 n2（t2））が、失った worker の会話か確かめられない。"
                      "確かめてから打つ: orca orchestration worker-start --task task_2 --terminal n2", r.stdout)
        self.assertIn("task_4（ctx_4）: 同じ worktree で worker（ctx_8）が動いている。Orca が起こし直した t4-new は閉じるか確かめる", r.stdout)
        self.assertIn("結び直さない worker task_3（ctx_3）: 結び直し済み（ctx_9）", r.stdout)
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
        self.assertIn("orchestration worker-start --task task_1 --terminal t1-new", self.calls())

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
        self.assertIn("task_1（ctx_1）: 結び直し済み（ctx_re）", r.stdout)

    def test_after_switch_uses_retry_of_only_for_a_failed_or_blocked_task(self):
        # --retry-of は failed・blocked の Task にしか通らない（ready の Task では task_not_startable）。
        for status, cmd in (("failed", "--task task_1 --retry-of ctx_1 --terminal t1-new"), ("blocked", "--task task_1 --retry-of ctx_1 --terminal t1-new"),
                            ("ready", "--task task_1 --terminal t1-new")):
            os.remove(os.path.join(self.fake, "calls")) if os.path.exists(os.path.join(self.fake, "calls")) else None
            self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
            self.agents([claude_agent("t1-new", tab="tab-t1")])
            self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")], status=status)
            r = self.run_after()
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual([c for c in self.calls() if c.startswith("orchestration worker-start")], ["orchestration worker-start " + cmd])

    def test_after_switch_does_not_start_a_task_whose_state_it_cannot_read(self):
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        open(os.path.join(self.fake, "tasks-fail"), "w").close()
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("task_1（ctx_1）: Task の状態を Orca から読めない（not bound）", r.stdout)

    def test_after_switch_skips_a_task_dispatched_again_elsewhere(self):
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        self.put("tasks.json", {"run_1": [{"id": "task_1", "status": "dispatched", "dispatchId": "ctx_other"}]})
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("結び直さない worker task_1（ctx_1）: 結び直し済み（ctx_other）", r.stdout)

    def test_after_switch_finds_a_terminal_reopened_outside_the_window(self):
        # 本物（11/21）: Orca は窓に出ていない端末を tabId・leafId を pty:<ptyId> にして開き、元の枠を recordedPaneKey に残す。
        # agent list の paneKey も recordedPaneKey の方。
        new = dict(terminal("n1", wt="t1"), tabId="pty:r::/w/t1@@c6ea", leafId="pty:r::/w/t1@@c6ea", recordedPaneKey="tab-t1:leaf-t1")
        self.terminals([new])
        self.agents([dict(claude_agent("n1"), paneKey="tab-t1:leaf-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")])
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("orchestration worker-start --task task_1 --terminal n1", self.calls())

    def test_after_switch_matches_the_terminal_that_resumed_the_lost_conversation(self):
        self.terminals([terminal("n1", wt="t1"), terminal("n2", wt="t1")])
        self.agents([claude_agent("n1"), claude_agent("n2")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1})
        self.put("heads.json", {"n1": launch_head(S1, WORKER_SETTINGS), "n2": launch_head(S2, WORKER_SETTINGS)})
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith("orchestration worker-start")],
                         ["orchestration worker-start --task task_1 --terminal n1"])

    def test_after_switch_only_suggests_when_the_conversation_cannot_be_confirmed(self):
        self.terminals([terminal("n1", wt="t1")])
        self.agents([claude_agent("n1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1})
        self.put("heads.json", {"n1": dict(launch_head(S1), truncated=True)})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("確かめてから打つ: orca orchestration worker-start --task task_1 --terminal n1", r.stdout)

    def test_after_switch_skips_a_worker_already_given_a_follow_up(self):
        # 本物（11/21 の worker A）: 担当が、起こし直した端末へ別の Task の続き（followUpOf）を送り、それはもう終わっている。
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        with open(os.path.join(self.fake, "workers.json")) as fh:
            rows = json.load(fh)
        self.put("workers.json", [{"dispatchId": "ctx_g", "taskId": "task_g", "state": "ready", "outcome": "in_progress",
                                   "terminal": "t1-new", "workspace": "r::/w/t1"},
                                  {"dispatchId": "ctx_f", "taskId": "task_f", "state": "succeeded", "outcome": None,
                                   "terminal": "t1-new", "workspace": "r::/w/t1"}] + rows)
        self.show("ctx_f", followUpOf="ctx_1")
        self.show("ctx_g", followUpOf="ctx_f")
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("結び直さない worker task_1（ctx_1）: 結び直し済み（ctx_g）", r.stdout)

    def test_after_switch_does_not_count_an_unrelated_dispatch_as_rebound(self):
        # 起こし直した端末で、失った Dispatch と関係の無い Task が一度動いて終わった。元の Task は結び直していない。
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        with open(os.path.join(self.fake, "workers.json")) as fh:
            rows = json.load(fh)
        self.put("workers.json", [{"dispatchId": "ctx_u", "taskId": "task_u", "state": "succeeded", "outcome": None,
                                   "terminal": "t1-new", "workspace": "r::/w/t1"}] + rows)
        self.show("ctx_u")
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("task_1（ctx_1）: Orca が起こし直した t1-new で、失ったあとに別の Dispatch（ctx_u）が動いた", r.stdout)

    def test_after_switch_does_not_trust_the_slot_when_the_conversation_differs(self):
        # 同じ枠の端末が、失った worker の会話（S1）ではなく別の会話（S2）を開いている。
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")], sessions={"ctx_1": S1})
        self.put("heads.json", {"t1-new": launch_head(S2)})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))

    def test_after_switch_does_not_match_the_conversation_on_a_terminal_that_is_not_claude(self):
        # 失った会話（S1）の起動の行と同じ文字が、Claude でない端末（シェル）の先頭に出ている。
        self.terminals([dict(terminal("n1", wt="t1"), agentIdentity=None)])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1})
        self.put("heads.json", {"n1": {"tail": ["echo 見本", "  claude '--resume' '%s'" % S1]}})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))

    def test_after_switch_does_not_guess_when_a_later_dispatch_cannot_be_read(self):
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")])
        with open(os.path.join(self.fake, "workers.json")) as fh:
            rows = json.load(fh)
        self.put("workers.json", [{"dispatchId": "ctx_x", "taskId": "task_x", "state": "succeeded", "outcome": None,
                                   "terminal": "t1-new", "workspace": "r::/w/t1"}] + rows)
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("（ctx_x）の詳細を読めず、結び直したか確かめられない", r.stdout)
        self.assertNotIn("確かめてから打つ", r.stdout)

    def test_after_switch_ignores_a_resume_quoted_in_the_work_output(self):
        # 失った端末の画面に終わりの案内が無く、作業の出力に別の会話の --resume が引用されているだけ。
        self.terminals([terminal("n1", wt="t1")])
        self.agents([claude_agent("n1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")])
        with open(os.path.join(self.fake, "shows.json")) as fh:
            shows = json.load(fh)
        shows["ctx_1"]["terminal"]["preview"] = "README を直した: `claude '--resume' '%s'` で開き直す\n❯" % S2
        self.put("shows.json", shows)
        self.put("heads.json", {"n1": {"tail": ["echo 見本", "  claude '--resume' '%s'" % S2]}})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("確かめてから打つ: orca orchestration worker-start --task task_1 --terminal n1", r.stdout)

    def test_switch_follows_terminals_reopened_outside_the_window(self):
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        open(os.path.join(self.fake, "orphan-on-restart"), "w").close()
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.sends(), ["t1-new"])
        self.assertIn("上限で止まった担当は、coordinator が account-failover --after-switch を打つと新しいチャットに出し直す", self.notes()[0])

    def lost_worker_without_settings(self, head_settings=None, truncated=False):
        """Orca が起こし直した t1-new は、失った worker（--settings 付き）の会話 S1 を開き直したが、--settings を落としている。"""
        self.accounts(A, {A: usage(), B: usage(), C: usage()})
        self.seat_home(A)
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")], sessions={"ctx_1": S1}, settings=WORKER_SETTINGS)
        self.put("heads.json", {"t1-new": dict(launch_head(S1, head_settings), truncated=truncated)})

    def relaunch_line(self):
        return "env CLAUDE_CONFIG_DIR=%s ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s --resume %s" % (
            os.path.join(self.tmp, "seat-" + A[:8]), WORKER_SETTINGS, WORKER_SETTINGS, S1)

    def test_after_switch_restores_the_worker_settings_before_rebinding(self):
        self.lost_worker_without_settings()
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        acts = [c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))]
        self.assertEqual(acts, ["terminal send --terminal t1-new --text /exit --enter --wait-submit 10",
                                "terminal send --terminal t1-new --text %s --enter" % self.relaunch_line(),
                                "orchestration worker-start --task task_1 --terminal t1-new"])

    def test_after_switch_dry_run_shows_the_relaunch(self):
        self.lost_worker_without_settings()
        r = self.run_after("--dry-run")
        self.assertIn("先に claude を終えて worker の設定で起こし直す: " + self.relaunch_line(), r.stdout)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))], [])

    def test_after_switch_leaves_a_claude_that_kept_its_settings(self):
        self.lost_worker_without_settings(head_settings=WORKER_SETTINGS)
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))],
                         ["orchestration worker-start --task task_1 --terminal t1-new"])

    def test_after_switch_stops_when_it_cannot_tell_the_settings(self):
        self.lost_worker_without_settings(truncated=True)
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))], [])
        self.assertIn("worker の設定（--settings）で動いているか確かめられない", r.stdout)

    def test_after_switch_names_a_claude_that_would_not_exit(self):
        self.lost_worker_without_settings()
        open(os.path.join(self.fake, "exit-hangs"), "w").close()
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("設定を付けて起こし直せなかった（/exit のあと 3 秒で claude が終わらなかった）。結び直していない。"
                      "端末 t1-new で claude を終えて %s を打ってから結び直す" % self.relaunch_line(), r.stdout)

    def test_switch_restores_the_worker_settings_before_asking_to_continue(self):
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.seat_home(B, hasSeenAutoDefaultNudge=True)
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1})
        self.lose_on_switch()
        # 終わりの案内には --settings が出ない（本物）。切り替える前の起動の行から worker の設定を控える。
        self.put("heads.json", {"t1": {"tail": ["env 'CLAUDE_CONFIG_DIR=/seat/a' claude --model opus --settings " + WORKER_SETTINGS]},
                                "t1-new": launch_head(S1)})
        self.run_failover()
        sends = [c.split("--text ")[1] for c in self.calls() if c.startswith("terminal send")]
        self.assertEqual(sends[:2], ["/exit --enter --wait-submit 10", "env CLAUDE_CONFIG_DIR=%s ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s --resume %s --enter"
                                     % (os.path.join(self.tmp, "seat-" + B[:8]), WORKER_SETTINGS, WORKER_SETTINGS, S1)])
        self.assertEqual(len(sends), 2)
        acts = [c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))]
        self.assertEqual(acts[-1], "orchestration worker-start --task task_1 --terminal t1-new --from coord_1 --run run_1")
        # 次の切り替えでも戻せるよう、記録は新しい端末に移る。
        with open(os.path.join(self.home, "worker-launches.json")) as fh:
            self.assertEqual({h: r["settings"] for h, r in json.load(fh).items()}, {"t1-new": WORKER_SETTINGS})

    def finished_worker(self, record=True, head=None):
        """Task を終えて開いたまま待っていた worker の端末 t1（in_progress の Dispatch が無い）。Orca は --settings を落として起こし直す。"""
        self.terminals([terminal("t1")])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.seat_home(B, hasSeenAutoDefaultNudge=True)
        if record:
            os.makedirs(self.home, exist_ok=True)
            with open(os.path.join(self.home, "worker-launches.json"), "w") as fh:
                json.dump({"t1": {"settings": WORKER_SETTINGS, "model": "opus", "at": now_ms()}}, fh)
        self.put("heads.json", {"t1": head or {"tail": ["❯"]}, "t1-new": launch_head(S1)})

    def test_switch_restores_the_settings_of_a_worker_that_had_finished_its_task(self):
        self.finished_worker()
        self.run_failover()
        sends = [c.split("--text ")[1] for c in self.calls() if c.startswith("terminal send")]
        self.assertEqual(sends, ["/exit --enter --wait-submit 10", "env CLAUDE_CONFIG_DIR=%s ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s --resume %s --enter"
                                 % (os.path.join(self.tmp, "seat-" + B[:8]), WORKER_SETTINGS, WORKER_SETTINGS, S1)])
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))

    def test_switch_hands_the_recorded_settings_to_helper_bins_over_the_default(self):
        # $ORCA_WORKER_SETTINGS に別の既定があっても、記録した設定を --settings と claude/bin の入口の両方に渡す
        self.finished_worker()
        base = self.env
        self.env = lambda: dict(base(), ORCA_WORKER_SETTINGS="/cfg/claude/other.json")
        self.run_failover()
        sends = [c.split("--text ")[1] for c in self.calls() if c.startswith("terminal send")]
        self.assertEqual(sends[1], "env CLAUDE_CONFIG_DIR=%s ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s --resume %s --enter"
                         % (os.path.join(self.tmp, "seat-" + B[:8]), WORKER_SETTINGS, WORKER_SETTINGS, S1))

    def test_switch_reads_the_worker_settings_from_the_launch_line_before_switching(self):
        # orca-launch の記録が無い（記録を始める前に立てた）worker は、切り替える前の起動の行から設定を読む。
        self.finished_worker(record=False, head={"tail": ["env 'CLAUDE_CONFIG_DIR=/seat/a' claude --model opus --settings " + WORKER_SETTINGS]})
        self.run_failover()
        self.assertIn("terminal send --terminal t1-new --text env CLAUDE_CONFIG_DIR=%s ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s --resume %s --enter"
                      % (os.path.join(self.tmp, "seat-" + B[:8]), WORKER_SETTINGS, WORKER_SETTINGS, S1), self.calls())

    def test_switch_does_not_take_settings_given_as_json_for_a_worker(self):
        # Orca は claude に JSON の設定を直に渡すことがある。それは worker の設定ではないので、worker と見なさない。
        self.finished_worker(record=False, head={"tail": ["claude '/orca-agent-view' --settings '{\"fastMode\":false}'"]})
        self.run_failover()
        self.assertEqual(self.sends(), [])

    def seat_session(self, sid, session, cwd, pid=1, entrypoint="cli"):
        """Claude Code が席の置き場所に書く、動いている claude の記録（sessions/<pid>.json）。切り替えのあとに起きたことにする。"""
        path = os.path.join(self.tmp, "seat-" + sid[:8], "sessions")
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "%d.json" % pid), "w") as fh:
            json.dump({"pid": pid, "sessionId": session, "cwd": cwd, "startedAt": now_ms() + MIN, "kind": "interactive",
                       "entrypoint": entrypoint}, fh)

    # 本物（11/22）: Orca が打った起動の行は、折り返した会話 id が行の頭に重なって残り、--resume の後ろに会話 id が無い。
    def garbled_head(self, session):
        return {"tail": ["", "'%s'o/Library/Application Support/orca/claude-agent-view/64e2/orca-agent-view' '--effort' 'medium' '--resume'" % session]}

    def test_switch_relaunches_a_finished_worker_whose_launch_line_is_garbled(self):
        # 本物（11/22 の max-win-notify-first）: 起動の行から会話 id を読めず、worker の設定なしで残った。席の claude の記録から会話 id を取る。
        self.finished_worker()
        self.put("heads.json", {"t1": {"tail": ["❯"]}, "t1-new": self.garbled_head(S1)})
        self.seat_session(B, S1, "/w/t1")
        self.seat_session(B, S2, "/w/other", pid=2)
        self.seat_session(B, S2, "/w/t1", pid=3, entrypoint="orca")  # 同じ worktree のチャットは数えない
        self.run_failover()
        self.assertEqual(self.texts(), ["/exit --enter --wait-submit 10", "env CLAUDE_CONFIG_DIR=%s ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s --resume %s --enter"
                                        % (os.path.join(self.tmp, "seat-" + B[:8]), WORKER_SETTINGS, WORKER_SETTINGS, S1)])

    def test_switch_does_not_guess_the_conversation_of_a_finished_worker(self):
        # 同じ worktree で切り替えのあとに起きた claude が 2 つあり、どちらの会話か決まらない。
        self.finished_worker()
        self.put("heads.json", {"t1": {"tail": ["❯"]}, "t1-new": self.garbled_head(S1)})
        self.seat_session(B, S1, "/w/t1")
        self.seat_session(B, S2, "/w/t1", pid=2)
        self.run_failover()
        self.assertEqual(self.sends(), [])
        self.assertIn("会話 id を起動の行からも席の claude の記録からも読めず", self.notes()[0])

    def lost_with_coordinator_racing(self, relaunched_by_coordinator, reopened_elsewhere):
        """切り替えで worker t1（Task task_1・会話 S1）を失う。Orca は同じ枠（t1-new）か別の枠（n1）に worker の設定なしで起こし直し、
        起動の行は崩れている。relaunched_by_coordinator なら、launchd が調べる前に coordinator が同じ worktree に w1 を立て直している。"""
        self.terminals([terminal("t1", "❯")])
        self.agents([claude_agent("t1")])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.seat_home(B, hasSeenAutoDefaultNudge=True)
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1}, settings=WORKER_SETTINGS,
                     live=[("ctx_8", "w1", "t1")] if relaunched_by_coordinator else ())
        self.lose_on_switch()
        with open(os.path.join(self.fake, "workers.json")) as fh:
            before = [w for w in json.load(fh) if w["dispatchId"] == "ctx_1"]  # w1 は切り替えのあとに立つ
        self.put("workers.json", before)
        new = "n1" if reopened_elsewhere else "t1-new"
        if reopened_elsewhere:
            open(os.path.join(self.fake, "close-t1"), "w").close()
            self.restart([])
            self.put("appear.json", [terminal("n1", wt="t1")] + ([terminal("w1", wt="t1")] if relaunched_by_coordinator else []))
        else:
            self.restart(["t1"])
        self.put("heads.json", {"t1": {"tail": ["claude --model opus --settings " + WORKER_SETTINGS]}, new: self.garbled_head(S1),
                                "w1": launch_head(S1, WORKER_SETTINGS)})
        self.seat_session(B, S1, "/w/t1")
        return new

    def test_switch_closes_orcas_restart_when_the_coordinator_already_started_a_worker(self):
        # 本物（11/22 12:22 の single-source-a・ext-period-decided-sql）: coordinator が 26〜56 秒で立て直し、
        # Orca が同じ枠に起こし直した端末が worker の設定なしで同じ worktree に残った。
        self.lost_with_coordinator_racing(True, False)
        self.run_failover()
        self.assertIn("terminal close --terminal t1-new", self.calls())
        self.assertEqual(self.sends(), [])
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))
        self.assertIn("Orca が起こし直した t1-new は worker の設定なしで動くので閉じた", self.notes()[0])
        self.assertEqual(self.history()[-1]["closed"], ["t1-new"])

    def test_switch_closes_orcas_restart_in_another_pane_when_the_coordinator_already_started_a_worker(self):
        # 本物（11/22 12:22 の cockpit-v3）: Orca は別の枠（term_88cf3315）に開き直し、担当が手で閉じた。
        self.lost_with_coordinator_racing(True, True)
        self.run_failover()
        self.assertEqual([c for c in self.calls() if c.startswith("terminal close")], ["terminal close --terminal n1"])
        self.assertEqual(self.sends(), [])
        self.assertNotIn("起動し直した先が分からない端末", self.notes()[0])

    def test_switch_does_not_close_a_claude_a_person_opened_in_another_pane(self):
        # 切り替えを待つ間に、人が同じ worktree の別の枠で自分の claude を開いた（Orca の開き直しの行が無い）。
        self.lost_with_coordinator_racing(True, True)
        self.put("heads.json", {"t1": {"tail": ["claude --model opus --settings " + WORKER_SETTINGS]},
                                "n1": {"tail": ["", "'%s'xx 崩れた行" % S2]}})
        self.run_failover()
        self.assertFalse(any(c.startswith("terminal close") for c in self.calls()))
        self.assertEqual(self.sends(), [])

    def test_switch_does_not_relaunch_a_conversation_started_after_orcas_restart(self):
        # Orca の開き直しのあと、人が同じ端末で claude を終えて別の会話を始めた（起動の行は拾えない）。
        self.finished_worker()
        self.put("heads.json", {"t1": {"tail": ["❯"]}, "t1-new": {"tail": self.garbled_head(S1)["tail"] + [
            "Resume this session with:", "claude --resume " + S1, "clenv '…"]}})
        self.seat_session(B, S2, "/w/t1")
        self.run_failover()
        self.assertEqual(self.sends(), [])

    def test_switch_closes_orcas_restart_when_the_same_task_was_dispatched_again(self):
        # coordinator が失った Task そのものを、立て直した w1 に出し直した。
        self.lost_with_coordinator_racing(True, False)
        with open(os.path.join(self.fake, "workers-after.json")) as fh:
            rows = json.load(fh)
        self.put("workers-after.json", [dict(w, taskId="task_1") if w["dispatchId"] == "ctx_8" else w for w in rows])
        self.run_failover()
        self.assertIn("terminal close --terminal t1-new", self.calls())
        self.assertIn("結び直さない worker task_1: 結び直し済み（ctx_8）。Orca が起こし直した t1-new は worker の設定なしで動くので閉じた",
                      self.notes()[0])

    def test_switch_does_not_close_a_conversation_a_person_started_in_orcas_restart(self):
        # 同じ Task を出し直したあと、人が Orca の起こし直しの端末で claude を終えて別の会話を始めた（起動の行は崩れて拾えない）。
        self.lost_with_coordinator_racing(True, False)
        with open(os.path.join(self.fake, "workers-after.json")) as fh:
            rows = json.load(fh)
        self.put("workers-after.json", [dict(w, taskId="task_1") if w["dispatchId"] == "ctx_8" else w for w in rows])
        self.put("heads.json", {"t1": {"tail": ["claude --model opus --settings " + WORKER_SETTINGS]}, "t1-new": {
            "tail": self.garbled_head(S1)["tail"] + ["Resume this session with:", "claude --resume " + S1, "clenv '…",
                                                     "❯ orca-agent-view と '--resume' の関係を調べて"]}})
        self.run_failover()
        self.assertFalse(any(c.startswith("terminal close") for c in self.calls()))

    def test_switch_does_not_take_a_persons_words_for_orcas_restart(self):
        self.finished_worker()
        self.put("heads.json", {"t1": {"tail": ["❯"]}, "t1-new": {"tail": ["", "❯ orca-agent-view と --resume の関係を調べて"]}})
        self.seat_session(B, S2, "/w/t1")
        self.run_failover()
        self.assertEqual(self.sends(), [])

    def test_after_switch_fails_when_orcas_restart_beside_a_redispatched_task_stays_open(self):
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1"), terminal("w1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1"), claude_agent("w1", state="working")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")], live=[("ctx_8", "w1", "t1")])
        with open(os.path.join(self.fake, "workers.json")) as fh:
            self.put("workers.json", [dict(w, taskId="task_1") if w["dispatchId"] == "ctx_8" else w for w in json.load(fh)])
        self.put("heads.json", {"t1-new": launch_head(S1)})
        self.put("screens.json", {"t1-new": AUTO_MODE_SCREEN})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith("terminal close") for c in self.calls()))
        self.assertIn("結び直していない worker task_1（ctx_1）: 結び直し済み（ctx_8）。Orca が起こし直した t1-new（worker の設定なし）を閉じられなかった", r.stdout)

    def test_switch_relaunches_a_lost_worker_reopened_in_another_pane(self):
        # coordinator が立て直していなければ、別の枠の起こし直しを worker の設定で起こし直してから結び直す。
        self.lost_with_coordinator_racing(False, True)
        self.run_failover()
        acts = [c for c in self.calls() if c.startswith(("terminal send", "terminal close", "orchestration worker-start"))]
        self.assertEqual(acts, ["terminal send --terminal n1 --text /exit --enter --wait-submit 10",
                                "terminal send --terminal n1 --text env CLAUDE_CONFIG_DIR=%s ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s --resume %s --enter"
                                % (os.path.join(self.tmp, "seat-" + B[:8]), WORKER_SETTINGS, WORKER_SETTINGS, S1),
                                "orchestration worker-start --task task_1 --terminal n1 --from coord_1 --run run_1"])

    def test_after_switch_closes_orcas_restart_left_beside_a_rebuilt_worker(self):
        self.terminals([terminal("t1-new", tab="tab-t1", wt="t1"), terminal("w1", wt="t1")])
        self.agents([claude_agent("t1-new", tab="tab-t1"), claude_agent("w1", state="working")])
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1-new", "t1")], live=[("ctx_8", "w1", "t1")])
        self.put("heads.json", {"t1-new": launch_head(S1)})
        r = self.run_after("--dry-run")
        self.assertIn("Orca が起こし直した t1-new は worker の設定なしで動くので閉じる", r.stdout)
        self.assertFalse(any(c.startswith("terminal close") for c in self.calls()))
        r = self.run_after()
        self.assertIn("terminal close --terminal t1-new", self.calls())
        self.assertIn("task_1（ctx_1）: 同じ worktree で worker（ctx_8）が動いている。その worker で立て直したなら何もしない。"
                      "別の仕事なら、この Task は orca-launch で立て直す。Orca が起こし直した t1-new は worker の設定なしで動くので閉じた", r.stdout)

    def stale_terminal(self, preview=LIMIT_LINE, record=False):
        """切り替えで Orca が起動し直さなかった端末 t4（既定は元の席の上限で止まっている）を作って切り替える。record は orca-launch の記録。"""
        self.terminals([terminal("t4", preview)])
        self.agents([dict(claude_agent("t4"), orcaSessionId="claude_" + S2.replace("-", "_"))])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.restart([])
        self.put("heads.json", {"t4": launch_head(S2)})
        if record:
            os.makedirs(self.home, exist_ok=True)
            with open(os.path.join(self.home, "worker-launches.json"), "w") as fh:
                json.dump({"t4": {"settings": WORKER_SETTINGS, "model": "opus", "at": now_ms()}}, fh)
        self.run_failover()
        self.assertEqual(self.history()[-1]["not_moved"], ["題 t4（t4）"])
        self.accounts(B, {A: usage(session=100), B: usage(), C: usage()})
        self.seat_home(B, hasSeenAutoDefaultNudge=True)

    def relaunched_to(self, settings=None):
        return "env CLAUDE_CONFIG_DIR=%s%s claude%s --resume %s --enter" % (
            os.path.join(self.tmp, "seat-" + B[:8]), " ORCA_WORKER_SETTINGS=" + settings if settings else "",
            " --model opus --settings " + settings if settings else "", S2)

    def texts(self):
        return [c.split("--text ")[1] for c in self.calls() if c.startswith("terminal send")]

    def test_terminal_left_on_the_old_seat_is_moved_when_it_is_idle(self):
        self.stale_terminal()
        self.run_failover()
        sends = self.texts()
        self.assertEqual(sends[:2], ["/exit --enter --wait-submit 10", self.relaunched_to()])
        self.assertIn("席を seat-b@example.com に切り替えて", sends[2])  # 上限で止まっていたので続きを頼む
        self.assertIn("題 t4（t4） を今の席 seat-b@example.com で起こし直した", self.notes()[-1])
        self.run_failover()
        self.assertEqual(len(self.texts()), 3)  # 1 回だけ

    def test_terminal_left_on_the_old_seat_waits_while_busy_or_working_on_its_task(self):
        self.stale_terminal(preview="❯")
        self.put("screens.json", {"t4": ["● 調べています"]})
        self.run_failover()
        self.assertEqual(self.sends(), [])
        # Task を持って入力待ち（上限ではない）の worker は、claude を終えると Dispatch を失うので触らない。
        self.put("screens.json", {})
        self.workers(live=[("ctx_9", "t4", "t4")])
        self.run_failover()
        self.assertEqual(self.sends(), [])

    def test_terminal_left_on_the_old_seat_is_not_touched_after_its_conversation_changed(self):
        self.stale_terminal()
        # 切り替えのあと、人が同じ端末で別の会話を始めた。
        self.agents([dict(claude_agent("t4"), orcaSessionId="claude_" + S1.replace("-", "_"))])
        self.run_failover()
        self.assertEqual(self.sends(), [])
        self.assertIn("別の会話に替わったか", self.notes()[-1])

    def test_worker_left_on_the_old_seat_without_known_settings_is_not_touched(self):
        # 記録を始める前に立てて、Task を終えた worker（Dispatch は終わっていて、起動の行も読めない）。
        self.put("workers.json", [{"dispatchId": "ctx_8", "taskId": "task_8", "state": "succeeded", "outcome": "succeeded",
                                   "terminal": "t4", "workspace": "r::/w/t4"}])
        self.stale_terminal()
        self.run_failover()
        self.assertEqual(self.sends(), [])
        self.assertIn("worker だが、worker の設定（--settings）が分からないので起こし直さない", self.notes()[-1])

    def test_worker_left_on_the_old_seat_at_its_limit_keeps_its_dispatch(self):
        self.workers(live=[("ctx_9", "t4", "t4")])
        self.stale_terminal(record=True)
        self.run_failover()
        sends = self.texts()
        self.assertEqual(sends[:2], ["/exit --enter --wait-submit 10", self.relaunched_to(WORKER_SETTINGS)])
        self.assertIn("席を seat-b@example.com に切り替えて", sends[2])
        self.assertFalse(any(c.startswith("orchestration worker-start") for c in self.calls()))

    def test_worker_left_on_the_old_seat_is_rebound_when_exiting_closed_its_dispatch(self):
        self.workers(live=[("ctx_9", "t4", "t4")])
        self.show("ctx_9", runId="run_1", taskId="task_ctx_9")
        self.put("tasks.json", {"run_1": [{"id": "task_ctx_9", "status": "failed"}]})
        open(os.path.join(self.fake, "exit-closes-dispatch"), "w").close()
        self.stale_terminal(record=True)
        self.run_failover()
        self.assertIn("orchestration worker-start --task task_ctx_9 --retry-of ctx_9 --terminal t4 --from coord_1 --run run_1", self.calls())
        self.assertEqual(len(self.texts()), 2)  # worker-start が Task を渡すので、続きは別に頼まない

    def test_terminal_left_on_the_old_seat_is_not_given_the_command_twice(self):
        self.stale_terminal()
        # 起こしたが、claude が確認の画面で止まって入力待ちにならない。
        self.put("after-launch.json", AUTO_MODE_SCREEN)
        self.run_failover()
        self.run_failover()
        self.assertEqual(self.texts().count(self.relaunched_to()), 1)  # 起こした claude に起動の行を打ち込まない
        self.put("screens.json", {})
        self.run_failover()
        self.assertEqual(self.texts().count(self.relaunched_to()), 1)
        self.assertIn("題 t4（t4） を今の席 seat-b@example.com で起こし直した", self.notes()[-1])

    def test_terminal_left_on_the_old_seat_is_started_when_exit_could_not_be_confirmed(self):
        self.stale_terminal()
        open(os.path.join(self.fake, "exit-hangs"), "w").close()  # /exit は届いたが、終わりの案内を読めない
        self.run_failover()
        self.agents([])  # 次の回にはもう claude ではない（シェルに戻った）
        self.run_failover()
        self.assertEqual(self.texts(), ["/exit --enter --wait-submit 10", self.relaunched_to()] + self.texts()[2:])
        self.assertEqual(self.texts().count("/exit --enter --wait-submit 10"), 1)

    def test_terminal_left_on_the_old_seat_is_started_again_after_claude_exited(self):
        self.stale_terminal()
        open(os.path.join(self.fake, "launch-fails-once"), "w").close()
        self.run_failover()
        self.assertEqual(self.texts(), ["/exit --enter --wait-submit 10", self.relaunched_to()])
        # claude はもう終わっている（端末はシェル）ので、次の回は起こすところから続ける。
        self.agents([])
        self.run_failover()
        self.assertEqual(self.texts()[2], self.relaunched_to())
        self.assertEqual(self.texts().count("/exit --enter --wait-submit 10"), 1)

    LEAD_SID = "765e8793-f3d8-4879-9163-e2b220fbb7fc"

    def stuck_lead(self, memo=True, run=True):
        """元の席の上限で止まった担当のチャット（Run run_1 の Dispatch ctx_lead、自分の Run run_lead の coordinator）を作る。"""
        wt = os.path.join(self.tmp, "lead-wt")
        os.makedirs(wt)
        for cmd in (["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "窓の版 3 の途中"]):
            subprocess.run(["git", "-C", wt, *cmd], check=True)
        sid = self.LEAD_SID
        # fake の worker-stop が消すチャットを決めるため、Dispatch を持たせる（本物の agent list には無い）。
        self.agents([{"orcaSessionId": sid, "kind": "chat", "agent": "claude", "state": "done", "worktreeId": "r::" + wt, "dispatch": "ctx_lead",
                      "title": "操縦席の作り直し（担当）", "updatedAt": now_ms() - 5 * MIN}])
        proj = os.path.join(self.tmp, ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", wt))
        os.makedirs(proj)
        # 枠が戻るのは 2 時間あと（実行する時刻に依らないよう、今から決める）。
        reset = time.gmtime(now_ms() / 1000 + 9 * 3600 + 2 * 3600)
        limit = "You've hit your 5-hour limit · resets %d:%02d%s (Asia/Tokyo)" % (reset.tm_hour % 12 or 12, reset.tm_min, "pm" if reset.tm_hour >= 12 else "am")
        line = lambda text, ago: json.dumps({"type": "assistant", "timestamp": iso(now_ms() - ago * MIN), "message": {"content": [{"type": "text", "text": text}]}})
        with open(os.path.join(proj, "a519465d-5f0c-47e9-9f1e-1e8ec17d6d5b.jsonl"), "w") as fh:
            fh.write(line("担当の最後の返事: 追加 22 を A に出した", 8) + "\n" + line(limit, 5) + "\n")
        # 同じ worktree の別の会話（端末の Claude）。上限の時刻が近くても、担当のものと取り違えない。
        with open(os.path.join(proj, "99999999-0000-0000-0000-000000000000.jsonl"), "w") as fh:
            fh.write(line("別の会話の返事", 6) + "\n" + line("ふつうの返事で止まった", 5) + "\n")
        self.put("workers.json", [{"dispatchId": "ctx_lead", "taskId": "task_lead", "state": "ready", "outcome": "in_progress",
                                   "terminal": "structworker_old", "workspace": "r::" + wt},
                                  {"dispatchId": "ctx_w1", "taskId": "task_w1", "state": "ready", "outcome": "in_progress",
                                   "terminal": "term_w1", "workspace": "r::/w/w1", "terminalState": "active"}])
        self.put("shows.json", {"ctx_lead": {"dispatch": {"id": "ctx_lead", "runId": "run_1", "taskId": "task_lead", "processIncarnation": "structured:" + sid,
                                                          "createdAt": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now_ms() / 1000 - 3600))},
                                             "worker": {"worktreeId": "r::" + wt, "startOptions": {"launch": {"requested": {"model": "claude-opus-5-5"}}}}}})
        self.put("tasks.json", {"run_1": [{"id": "task_lead", "status": "dispatched", "task_title": "操縦席の作り直し", "spec": "lead.md を読み、窓の版 3 を仕上げる（元の brief）"}]})
        if run:
            self.put("runs.json", [{"id": "run_lead", "coordinator_handle": "structworker_old"}])
        recent = iso(now_ms() - 30 * MIN)
        self.put("inbox.json", [
            {"id": "msg_unread", "to_handle": "run:run_lead", "from_handle": "orca_session_id:main", "subject": "上限で止まっていた間に追加 23 を直接出した",
             "body": "追加 23 は窓口が直接出した。担当は出し直さない。", "read": 0, "created_at": recent},
            {"id": "msg_report", "to_handle": "run:run_lead", "from_handle": "term_w1", "subject": "worker の報告", "body": "報告の本文", "read": 1, "created_at": recent},
            {"id": "msg_old", "to_handle": "run:run_lead", "from_handle": "orca_session_id:main", "subject": "前の担当のころの指示",
             "body": "古い指示", "read": 1, "created_at": iso(now_ms() - 5 * HOUR)}])
        self.put("talk.json", [{"kind": "tool", "name": "Bash"},
                               {"kind": "message", "role": "user", "text": "深田さんの最後の発言: 線で区切った一覧にして"},
                               {"kind": "message", "role": "assistant", "text": "担当の最後の返事: 追加 22 を A に出した"}])
        for session, text in ((("a519465d-5f0c-47e9-9f1e-1e8ec17d6d5b", "# 作業メモ\n追加 23 の結び直し待ち"),) if memo else ()) + (
                ("99999999-0000-0000-0000-000000000000", "別の会話の作業メモ"),):
            path = os.path.join(self.tmp, "scratch", re.sub(r"[^A-Za-z0-9]", "-", wt), session, "scratchpad")
            os.makedirs(path)
            with open(os.path.join(path, "state.md"), "w") as fh:
                fh.write(text)
        return wt

    def started_spec(self):
        with open(os.path.join(self.fake, "started-spec.md")) as fh:
            return fh.read()

    def test_after_switch_hands_off_a_lead_stuck_on_the_old_seat(self):
        wt = self.stuck_lead()
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        spec = self.started_spec()
        self.assertTrue(spec.startswith("席が切り替わって、前の担当のチャットが止まったので出し直した。"))
        self.assertIn("「前の担当を止めた。始めて」が届くまでは", spec)
        self.assertNotIn("別の会話の作業メモ", spec)
        for part in ("lead.md を読み、窓の版 3 を仕上げる（元の brief）",          # 元の Task の brief
                     "追加 23 は窓口が直接出した。担当は出し直さない。", "未読",       # 届いた指示（未読も）
                     "深田さんの最後の発言: 線で区切った一覧にして", "担当の最後の返事: 追加 22 を A に出した",  # 会話の最後
                     "追加 23 の結び直し待ち",                                       # 作業メモ
                     "ctx_w1 Task task_w1", "orca orchestration run-use --id run_lead",  # 配下の worker と Run の引き継ぎ
                     "窓の版 3 の途中"):                                              # git の log
            self.assertIn(part, spec)
        self.assertNotIn("古い指示", spec)  # 担当になる前の指示は入れない
        self.assertNotIn("報告の本文", spec)  # 配下の worker の既読の報告は入れない
        self.assertNotIn("取れなかった材料", spec)
        acts = [c.split(" --subject")[0].split(" --spec-file")[0].split(" --status")[0]
                for c in self.calls() if c.startswith(("orchestration worker-start", "orchestration worker-stop", "orchestration task-update", "orchestration send"))]
        # 新しいほうが立ってから古いほうを止め、止めてから新しいほうに始めるよう送る。
        self.assertEqual(acts, ["orchestration worker-start", "orchestration worker-stop --dispatch ctx_lead", "orchestration task-update --id task_lead",
                                "orchestration send --to dispatch:ctx_new --type status"])
        start = next(c for c in self.calls() if c.startswith("orchestration worker-start"))
        self.assertIn("--agent claude --worktree path:%s --keep-open" % wt, start)
        self.assertIn("--model claude-opus-5-5", start)
        self.assertIn("出し直した担当: 操縦席の作り直し（担当）: チャット %s（Dispatch ctx_lead）→ 新しいチャット structworker_new" % self.LEAD_SID, r.stdout)
        self.assertNotIn("閉じられなかった", r.stdout)
        self.assertEqual(self.history()[-1]["handoffs"][0].split(":")[0], "操縦席の作り直し（担当）")

    def test_after_switch_names_the_materials_it_could_not_gather(self):
        self.stuck_lead(memo=False, run=False)
        r = self.run_after()
        spec = self.started_spec()
        self.assertIn("## 取れなかった材料", spec)
        self.assertIn("担当の作業メモ", spec)
        self.assertIn("担当が coordinator をしている Run", spec)
        self.assertIn("取れなかった材料: ", r.stdout)

    def test_after_switch_keeps_the_old_chat_when_the_new_one_fails(self):
        self.stuck_lead()
        open(os.path.join(self.fake, "start-fails"), "w").close()
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertFalse(any(c.startswith(("orchestration worker-stop", "orchestration task-update")) for c in self.calls()))
        self.assertIn("新しいチャットが立たなかったので、古いチャットは残した", r.stdout)

    def test_after_switch_twice_starts_only_one_chat(self):
        self.stuck_lead()
        open(os.path.join(self.fake, "stop-keeps-chat"), "w").close()
        r = self.run_after()
        self.assertIn("古いチャットは止めたが Orca の一覧に残っている（手で閉じる）", r.stdout)
        self.run_after()
        self.assertEqual(len([c for c in self.calls() if c.startswith("orchestration worker-start")]), 1)

    def test_after_switch_stops_the_new_chat_when_the_old_one_started_again(self):
        self.stuck_lead()
        open(os.path.join(self.fake, "old-resumes-on-start"), "w").close()
        r = self.run_after()
        stops = [c for c in self.calls() if c.startswith("orchestration worker-stop")]
        self.assertEqual(stops, ["orchestration worker-stop --dispatch ctx_new"])
        self.assertFalse(any(c.startswith("orchestration send --to dispatch:ctx_new") for c in self.calls()))
        self.assertIn("前の担当が動き出したので、新しいチャット structworker_new を止めて前の担当を残した", r.stdout)

    def test_after_switch_finishes_the_cleanup_it_could_not_finish(self):
        self.stuck_lead()
        open(os.path.join(self.fake, "task-update-fails-once"), "w").close()
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertIn("終わっていない後始末: 古い Task を閉じる", r.stdout)
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(len([c for c in self.calls() if c.startswith("orchestration worker-start")]), 1)
        self.assertEqual(len([c for c in self.calls() if c.startswith("orchestration task-update")]), 2)
        self.assertEqual(len([c for c in self.calls() if c.startswith("orchestration send --to dispatch:ctx_new")]), 1)

    def test_after_switch_dry_run_writes_the_brief_but_starts_nothing(self):
        self.stuck_lead()
        r = self.run_after("--dry-run")
        self.assertIn("新しいチャットに出し直す（brief: ", r.stdout)
        self.assertFalse(any(c.startswith(("orchestration worker-start", "orchestration worker-stop")) for c in self.calls()))

    def test_switch_tells_the_coordinator_once_about_a_stuck_lead(self):
        self.stuck_lead()
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()  # 切り替える
        self.accounts(B, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.run_failover()
        tells = [c for c in self.calls() if c.startswith("orchestration send") and "--from structworker_old" in c]
        self.assertEqual(len(tells), 1)
        self.assertIn("account-failover --after-switch", tells[0])
        self.assertFalse(any(c.startswith("orchestration worker-start --spec-file") for c in self.calls()))

    def test_after_switch_trusts_a_relaunch_done_by_the_switch(self):
        self.test_switch_restores_the_worker_settings_before_asking_to_continue()
        # 自動の切り替えが打った行は、出力に崩れて残る。
        self.put("heads.json", {"t1-new": {"tail": launch_head(S1)["tail"] + ["Resume this session with:", "claude --resume " + S1, "clenv 'CLAUDE_CON"]}})
        self.put("screens.json", {})
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("orchestration worker-start --task task_1 --terminal t1-new", self.calls())

    def test_switch_does_not_ask_an_unchecked_worker_to_continue(self):
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1}, settings=WORKER_SETTINGS)
        self.lose_on_switch()
        self.put("heads.json", {"t1-new": dict(launch_head(S1), truncated=True)})
        self.run_failover()
        self.assertEqual(self.sends(), [])
        self.assertIn("続きを頼んでいない。worker の端末だが、worker の設定（--settings）で動いているか確かめられない"
                      "（Orca が起こし直した t1-new の claude の起動の行を読めず", self.notes()[0])

    def test_switch_does_not_ask_a_worker_to_continue_when_its_task_cannot_be_read(self):
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1}, settings=WORKER_SETTINGS)
        self.lose_on_switch()
        self.put("heads.json", {"t1-new": launch_head(S1)})
        open(os.path.join(self.fake, "tasks-fail"), "w").close()
        self.run_failover()
        self.assertEqual(self.sends(), [])
        self.assertIn("Task の状態を Orca から読めない", self.notes()[0])

    def test_after_switch_stops_when_the_worker_settings_are_unknown(self):
        # 終わりの案内に --settings が無く、$ORCA_WORKER_SETTINGS も無い。起こし直した claude にも --settings が無い。
        self.lost_worker_without_settings()
        with open(os.path.join(self.fake, "shows.json")) as fh:
            shows = json.load(fh)
        shows["ctx_1"]["terminal"]["preview"] = resume_hint(S1)
        self.put("shows.json", shows)
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))], [])
        self.assertIn("worker の設定のファイルが分からない", r.stdout)

    def test_after_switch_does_not_exit_a_worker_of_another_run(self):
        self.lost_worker_without_settings()
        self.put("run-current.json", "run_other")
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))], [])
        self.assertIn("Run run_1 の coordinator が、端末 t1-new で claude を終えて %s を打ってから結び直す" % self.relaunch_line(), r.stdout)

    def test_after_switch_does_not_exit_a_different_conversation_opened_since(self):
        # Orca が S1 を開き直したあと、同じ端末で誰かが新しい会話の claude を起こした。
        self.lost_worker_without_settings()
        self.put("heads.json", {"t1-new": {"tail": launch_head(S1)["tail"] + ["Resume this session with:", "claude --resume " + S1,
                                                                              "~/w/x", "❯ claude"]}})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))], [])
        self.assertIn("失った worker の会話か確かめられない", r.stdout)

    def test_after_switch_does_not_bind_a_fresh_claude_in_the_same_slot(self):
        # 同じ枠で、--resume の無い新しい会話の claude（worker の設定付き）が動いている。
        self.lost_worker_without_settings()
        self.put("heads.json", {"t1-new": {"tail": ["  claude '--settings' '%s'" % WORKER_SETTINGS]}})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))], [])

    def test_after_switch_stops_when_claude_was_started_in_a_way_it_cannot_read(self):
        # Orca が S1 を開き直したあと、claude が終わり、拾えない形（command claude）で別の claude が起きた。
        self.lost_worker_without_settings()
        self.put("heads.json", {"t1-new": {"tail": launch_head(S1)["tail"] + ["Resume this session with:", "claude --resume " + S1,
                                                                              "~/w/x", "❯ command claude"]}})
        r = self.run_after()
        self.assertEqual(r.returncode, 1)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))], [])
        self.assertIn("誰かがもう終えて起こし直していて、その引数を出力から読めない。worker の設定（--settings）で起こし直してあるか確かめてから打つ: "
                      "orca orchestration worker-start --task task_1 --terminal t1-new", r.stdout)

    def test_after_switch_relaunches_when_orcas_launch_line_was_cut(self):
        # 本物（11/21 の term_d7e9026d）: Orca が打った行が画面の幅で切れ、出力に --resume が残っていない。会話 id は終わりの案内から取る。
        self.lost_worker_without_settings()
        self.put("heads.json", {"t1-new": {"tail": ["", "~/w/x", "claude   '/orca-agent-view' '--dangerously-skip-permissions'",
                                                    "  Press up to edit queued messages"]}})
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))],
                         ["terminal send --terminal t1-new --text /exit --enter --wait-submit 10",
                          "terminal send --terminal t1-new --text %s --enter" % self.relaunch_line(),
                          "orchestration worker-start --task task_1 --terminal t1-new"])

    def test_switch_checks_a_worker_that_started_just_before_the_switch(self):
        # 一覧を読んだ時点では t1 に Dispatch が無く、切り替えまでに始まって失われた。
        self.terminals([terminal("t1", LIMIT_LINE)])
        self.agents([claude_agent("t1")])
        self.restart(["t1"])
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.workers(lost=[("ctx_1", "task_1", "t1", "tab-t1:leaf-t1", "t1")], sessions={"ctx_1": S1}, settings=WORKER_SETTINGS)
        self.lose_on_switch()
        self.put("workers.json", [])
        self.put("heads.json", {"t1-new": dict(launch_head(S1), truncated=True)})
        self.run_failover()
        self.assertEqual(self.sends(), [])

    def test_after_switch_does_not_relaunch_twice(self):
        # 自動の切り替えで worker の設定を付けて起こし直したあと、出力には Orca の行と、ここで打った行の両方が残っている。
        self.lost_worker_without_settings()
        self.put("heads.json", {"t1-new": {"tail": launch_head(S1)["tail"] + [
            "Resume this session with:", "claude --resume " + S1, "~/w/x", "❯ " + self.relaunch_line()]}})
        r = self.run_after()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith(("terminal send", "orchestration worker-start"))],
                         ["orchestration worker-start --task task_1 --terminal t1-new"])

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
        self.assertIn("seat-b@example.com に切り替えた。続きを頼む後処理が失敗した", note)
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
        self.assertIn("Run run_1 の coordinator が打つ: orca orchestration worker-start --task task_1 --terminal t1-new", r.stdout)

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
        # 日付をまたぐと「11/22 00:10」のように日付が付くので、時刻だけを見る。
        self.assertIn("最初に戻るのは seat-b@example.com の ", self.notes()[0])
        self.assertIn(time.strftime("%H:%M", time.localtime(soon / 1000)), self.notes()[0])
        self.assertEqual(len(self.status()), 1)
        # stallwatch は帯にだけ合流させ、通知を重ねない。
        r = self.run_cmd(sys.executable, STALLWATCH, "--window", "http://127.0.0.1:9")
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
        r = self.run_cmd(sys.executable, SCRIPT, *SEATS)
        self.assertNotEqual(r.returncode, 0)
        os.remove(os.path.join(self.fake, "select-fails"))
        # 断られた回を切り替えと数えていれば、10 分は待って試し直さない。
        self.run_failover()
        self.assertEqual(self.selects(), [B, B])
        self.assertEqual(self.history()[-1]["to"], EMAIL[B])

    def test_stops_before_switching_when_orca_changes_the_agent_list(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        open(os.path.join(self.fake, "agents-renamed"), "w").close()
        r = self.run_cmd(sys.executable, SCRIPT, *SEATS)
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
        self.assertIn("切り替える: seat-a@example.com → seat-b@example.com", out)
        self.assertIn("題 t1（t1）", out)
        self.assertEqual([c for c in self.calls() if c.startswith(("account select", "terminal send"))], [])
        self.assertFalse(os.path.exists(self.home))

    def test_assume_full_needs_dry_run(self):
        r = self.run_cmd(sys.executable, SCRIPT, *SEATS, "--assume-full")
        self.assertNotEqual(r.returncode, 0)

    def test_unknown_seat_name_fails_loudly_once(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        args = [sys.executable, SCRIPT, "--seat", "nobody@example.com"]
        for _ in range(2):
            r = self.run_cmd(*args)
            self.assertNotEqual(r.returncode, 0)
        self.assertEqual(len(self.notes()), 1)
        self.assertIn("Orca に無い席", self.notes()[0])


class HandoffTitleTest(unittest.TestCase):
    def test_suffix_is_not_repeated(self):
        import importlib.machinery, importlib.util
        loader = importlib.machinery.SourceFileLoader("account_failover", SCRIPT)
        mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("account_failover", loader))
        loader.exec_module(mod)
        once = "任せる｜窓の版3（席の切り替えで引き継ぎ）"
        self.assertEqual(mod.handoff_title("任せる｜窓の版3"), once)
        self.assertEqual(mod.handoff_title(once + "（席の切り替えで引き継ぎ）（席の切り替えで引き継ぎ）"), once)


if __name__ == "__main__":
    unittest.main()
