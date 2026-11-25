import importlib.machinery
import importlib.util
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "account-failover")
STALLWATCH = os.path.join(HERE, "stallwatch")
MIN = 60_000
HOUR = 60 * MIN
A, B, C = "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002", "cccccccc-0000-0000-0000-000000000003"
EMAIL = {A: "seat-a@example.com", B: "seat-b@example.com", C: "seat-c@example.com"}
SEATS = ["--seat", EMAIL[A], "--seat", EMAIL[B], "--seat", EMAIL[C]]
LIMIT_LINE = "  ⎿  You've hit your 5-hour limit · resets 4:40pm (Asia/Tokyo)"
S1, S2 = "58edbc6e-ae7a-4cad-b6c9-613f01bceda8", "73147483-b7f2-48de-83f1-b2428f1e2b56"
EXTERNAL_IMPORTS = ["Allow external CLAUDE.md file imports?",
                    "This project's CLAUDE.md imports files outside the current working directory.",
                    "❯ 1. Yes, allow external imports", "  2. No, disable external imports"]
AUTO_MODE_SCREEN = ["Auto mode lets Claude handle permission prompts automatically.",
                    "❯ Yes, set auto mode as my default permission mode", "  No, keep bypass permissions"]

# 偽の orca。状態は JSON ファイルに持つ。claude のプロセスは processes.json（account-failover の FAILOVER_PROCESSES）に持ち、
# /exit でそのプロセスを消し、`env … claude …` で今の端末に新しいプロセスを足す（その席の sessions/<pid>.json も書く）。
FAKE_ORCA = r'''#!/usr/bin/env python3
import json, os, shlex, sys
d = os.environ["FAKE_DIR"]
a = [x for x in sys.argv[1:] if x != "--json"]
with open(os.path.join(d, "calls"), "a") as fh:
    fh.write(json.dumps(a, ensure_ascii=False) + "\n")
def load(n, default=None):
    try:
        with open(os.path.join(d, n)) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
def save(n, v):
    with open(os.path.join(d, n), "w") as fh:
        json.dump(v, fh)
def ok(r):
    print(json.dumps({"ok": True, "result": r}))
def fail(m="refused"):
    print(json.dumps({"ok": False, "error": {"message": m}}))
def flag(n):
    return os.path.exists(os.path.join(d, n))
def val(k):
    return a[a.index(k) + 1]
cmd = " ".join(a[:2])
if cmd == "account list":
    ok(load("accounts.json"))
elif cmd == "account select" and flag("select-fails"):
    fail()
elif cmd == "account select":
    acc = load("accounts.json")
    acc["claude"]["activeAccountId"] = val("--account")
    save("accounts.json", acc)
    ok(acc["claude"])
elif cmd == "terminal list":
    ok({"terminals": load("terminals.json", [])})
elif cmd == "agent list":
    ok({"agents": load("agents.json", [])} if not flag("agents-renamed") else {"sessions": []})
elif cmd == "terminal read" and flag("read-fails"):
    fail()
elif cmd == "terminal read":
    ok({"terminal": {"tail": load("screens.json", {}).get(val("--terminal"), [])}})
elif cmd == "orchestration worker-list" and flag("list-fails"):
    fail()
elif cmd == "orchestration worker-list" and load("workers-late", 0) > 0:
    # 最初の n 回の一覧のあとに Dispatch が届いた（移している間に coordinator が送った）
    save("workers-late", load("workers-late") - 1)
    ok({"workers": []})
elif cmd == "orchestration worker-list":
    ok({"workers": load("workers.json", [])})
elif cmd == "orchestration worker-show":
    ok(load("shows.json", {}).get(val("--dispatch"), {}))
elif cmd == "orchestration run-show":
    ok(load("runs.json", {}).get(val("--id"), {}))
elif cmd == "orchestration send" and flag("send-fails"):
    fail()
elif cmd == "orchestration send" and val("--to").startswith("dispatch:"):
    # 実物（Orca 1.4.271）: 閉じた Dispatch あてに、その Run の coordinator が送ると follow-up の Dispatch になる。
    # worker 自身の名だと Run の受信箱に回る（2026-11-23 に確かめた）
    old, shows = val("--to")[len("dispatch:"):], load("shows.json", {})
    run = shows.get(old, {}).get("runId")
    if not flag("follow-up-refused") and shows.get(old, {}).get("state") == "failed" and load("runs.json", {}).get(run, {}).get("run", {}).get("coordinator_handle") == val("--from"):
        workers = load("workers.json", [])
        new = "ctx_f%d" % (sum(1 for w in workers if w["dispatchId"].startswith("ctx_f")) + 1)
        shows[new] = {"dispatchId": new, "runId": run, "state": "ready", "followUpOf": old, "terminal": shows[old].get("terminal")}
        save("shows.json", shows)
        save("workers.json", workers + [{"dispatchId": new, "state": "ready", "outcome": "in_progress", "terminal": shows[old].get("terminal")}])
        if flag("follow-up-reply-lost"):  # 作って端末に打ったが、応答だけが時間切れになった
            fail("timeout")
            sys.exit(0)
        ok({"delivery": "follow_up", "followUpOf": old, "dispatchId": new, "runId": run, "state": "ready"})
    else:
        ok({"messageId": "msg_1"})
elif cmd == "orchestration send":
    ok({"messageId": "msg_1"})
elif cmd == "terminal send":
    h, text = val("--terminal"), val("--text")
    procs = load("processes.json", [])
    if text == "/exit":
        if not flag("exit-hangs"):
            save("processes.json", [p for p in procs if p["env"].get("ORCA_TERMINAL_HANDLE") != h])
            if flag("exit-closes-dispatch"):  # Orca 1.4.271: claude が終わると、その端末の Dispatch を failed で閉じる
                workers, shows = load("workers.json", []), load("shows.json", {})
                for w in workers:
                    if w["terminal"] == h and w.get("outcome") == "in_progress":
                        w.pop("outcome")
                        w["state"] = "failed"
                        shows[w["dispatchId"]]["state"] = "failed"
                save("workers.json", workers)
                save("shows.json", shows)
        if flag("exit-reply-lost"):  # 届いたが、応答だけが時間切れになった
            fail("timeout")
            sys.exit(0)
    elif text.startswith(("env ", "sh ")):
        if flag("launch-closes-terminal"):
            save("terminals.json", [t for t in load("terminals.json", []) if t["handle"] != h])
            fail("terminal not found")
            sys.exit(0)
        if flag("launch-fails"):
            fail()
            sys.exit(0)
        if text.startswith("sh "):
            with open(shlex.split(text)[1]) as fh:
                text = fh.read()
            assert text.startswith("exec env ") and text.endswith("\n"), text
            text = text[len("exec "):]
        words = shlex.split(text)
        env, i = {"ORCA_TERMINAL_HANDLE": h}, 1
        while "=" in words[i] or words[i] == "-u":
            if words[i] == "-u":
                i += 2
                continue
            k, v = words[i].split("=", 1)
            env[k] = v
            i += 1
        argv = words[i:]
        pid = max([p["pid"] for p in procs] + [1000]) + 1
        procs.append({"pid": pid, "ppid": 40000, "comm": ".claude-wrapped", "argv": argv, "env": env})
        save("processes.json", procs)
        if not flag("launch-no-session"):
            home = env.get("CLAUDE_CONFIG_DIR")
            os.makedirs(os.path.join(home, "sessions"), exist_ok=True)
            with open(os.path.join(home, "sessions", "%d.json" % pid), "w") as fh:
                json.dump({"pid": pid, "sessionId": argv[argv.index("--resume") + 1], "cwd": "/w/x",
                           "status": load("launch-status", "idle")}, fh)
        screens = load("screens.json", {})
        screens[h] = load("after-launch.json", [])
        save("screens.json", screens)
    ok({"accepted": True})
else:
    fail("unknown")
'''

# 偽の kill（FAILOVER_KILL）。本物の signal は送らず、processes.json からそのプロセスを消す。
FAKE_KILL = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ["FAKE_DIR"]
with open(os.path.join(d, "calls"), "a") as fh:
    fh.write(json.dumps(["kill", sys.argv[1]]) + "\n")
if not os.path.exists(os.path.join(d, "kill-ignored")):
    path = os.path.join(d, "processes.json")
    with open(path) as fh:
        procs = json.load(fh)
    with open(path, "w") as fh:
        json.dump([p for p in procs if p["pid"] != int(sys.argv[1])], fh)
'''


def now_ms():
    return int(time.time() * 1000)


def usage(session=0, weekly=0, session_reset=None, weekly_reset=None, status="ok", updated=None, failure=None):
    rl = {"status": status, "updatedAt": updated if updated is not None else now_ms() - MIN,
          "session": {"usedPercent": session, "resetsAt": session_reset if session_reset is not None else now_ms() + 2 * HOUR},
          "weekly": {"usedPercent": weekly, "resetsAt": weekly_reset if weekly_reset is not None else now_ms() + 48 * HOUR},
          "fableWeekly": {"usedPercent": 100, "resetsAt": now_ms() + HOUR}}
    if failure:
        rl["usageMetadata"] = {"failureKind": failure}
    return rl


def terminal(handle, preview="❯", title=None):
    return {"handle": handle, "ptyId": "pty-" + handle, "tabId": "tab-" + handle, "leafId": "leaf-" + handle,
            "connected": True, "title": title or "題 " + handle, "worktreePath": "/w/" + handle, "preview": preview}


def pane_agent(handle, state="done"):
    return {"kind": "terminal", "agent": "claude", "state": state, "paneKey": "tab-%s:leaf-%s" % (handle, handle)}


def chat_agent(chat, state="done", title=None):
    return {"kind": "chat", "agent": "claude", "state": state, "orcaSessionId": chat, "title": title or "題 " + chat}


def iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + ".000Z"


class FailoverTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.fake = os.path.join(self.tmp, "fake")
        os.makedirs(self.fake)
        self.home = os.path.join(self.tmp, "home")
        self.script("orca", FAKE_ORCA)
        self.script("kill", FAKE_KILL)
        self.script("notify", "#!/bin/sh\nprintf '%%s\\t%%s\\n' \"$1\" \"$2\" >> %s\n" % os.path.join(self.tmp, "notes"))
        self.put("processes.json", [])
        self.settings = os.path.join(self.tmp, "cfg", "settings.worker.json")
        os.makedirs(os.path.dirname(self.settings))
        with open(self.settings, "w") as fh:
            fh.write("{}")

    def script(self, name, body):
        path = os.path.join(self.bin, name)
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)

    def put(self, name, value):
        with open(os.path.join(self.fake, name), "w") as fh:
            json.dump(value, fh)

    def get(self, name):
        with open(os.path.join(self.fake, name)) as fh:
            return json.load(fh)

    def flag(self, name, on=True):
        path = os.path.join(self.fake, name)
        if on:
            open(path, "w").close()
        elif os.path.exists(path):
            os.remove(path)

    def seat_dir(self, sid):
        # Orca の席の置き場所と同じく、パスに空白が入る。
        return os.path.join(self.tmp, "Application Support", "seat-" + sid[:8], "home")

    def accounts(self, active, readings):
        """readings: 席 → usage()。今の席のものは rateLimits.claude に、ほかは inactiveClaudeAccounts に入れる（Orca の形）。席の置き場所も作る。"""
        for sid in (A, B, C):
            home = self.seat_dir(sid)
            if not os.path.exists(home):
                os.makedirs(home)
                with open(os.path.join(home, ".claude.json"), "w") as fh:
                    json.dump({"hasCompletedOnboarding": True}, fh)
        self.put("accounts.json", {
            "claude": {"activeAccountId": active, "accounts": [{"id": i, "email": EMAIL[i], "home": self.seat_dir(i)} for i in (C, B, A)]},
            "rateLimits": {"claude": dict(readings[active], usageMetadata={"readingAccount": {"accountId": active}}),
                           "inactiveClaudeAccounts": [{"accountId": i, "rateLimits": r} for i, r in readings.items() if i != active]}})

    def seat_settings(self, sid, mode, **cfg):
        home = self.seat_dir(sid)
        with open(os.path.join(home, ".claude.json"), "w") as fh:
            json.dump(dict({"hasCompletedOnboarding": True}, **cfg), fh)
        with open(os.path.join(home, "settings.json"), "w") as fh:
            json.dump({"permissions": {"defaultMode": mode}}, fh)

    def proc(self, pid, seat=A, handle=None, chat=None, argv=(), session=None, status="idle", cwd=None, ppid=30000,
             comm=".claude-wrapped", env=None, reply=None, then=None):
        """claude のプロセスを足す。session があればその席の sessions/<pid>.json を書き、reply があれば会話記録の最後の応答にする。"""
        e = dict(env or {})
        if seat:
            e["CLAUDE_CONFIG_DIR"] = self.seat_dir(seat)
        if handle:
            e["ORCA_TERMINAL_HANDLE"] = handle
        if chat:
            e["ORCA_AGENT_SESSION_ID"] = chat
        e.setdefault("ORCA_WORKER_SETTINGS", self.settings)
        procs = self.get("processes.json")
        procs.append({"pid": pid, "ppid": ppid, "comm": comm, "argv": ["/nix/store/x/bin/.claude-wrapped", *argv], "env": e})
        self.put("processes.json", procs)
        cwd = cwd or "/w/p%d" % pid
        if session and seat:
            os.makedirs(os.path.join(self.seat_dir(seat), "sessions"), exist_ok=True)
            with open(os.path.join(self.seat_dir(seat), "sessions", "%d.json" % pid), "w") as fh:
                json.dump({"pid": pid, "sessionId": session, "cwd": cwd, "status": status}, fh)
        if reply is not None:
            proj = os.path.join(self.seat_dir(seat), "projects", cwd.replace("/", "-"))
            os.makedirs(proj, exist_ok=True)
            with open(os.path.join(proj, session + ".jsonl"), "w") as fh:
                fh.write(json.dumps({"type": "user", "message": {"content": "続けて"}}) + "\n")
                fh.write(json.dumps({"type": "assistant", "timestamp": iso(now_ms() - MIN), "isApiErrorMessage": reply == LIMIT_LINE,
                                     "message": {"content": [{"type": "text", "text": reply}]}}) + "\n")
                if then:
                    fh.write(json.dumps({"type": "user", "message": {"content": then}}) + "\n")

    def env(self):
        env = dict(os.environ, PATH=self.bin + ":/usr/bin:/bin", STALLWATCH_HOME=self.home, FAKE_DIR=self.fake,
                   COCKPIT_DIR=os.path.join(self.tmp, "cockpit"), STALLWATCH_NOTIFY=os.path.join(self.bin, "notify"),
                   ORCA_CLI_COMMAND="orca", HOME=self.tmp, FAILOVER_PROCESSES=os.path.join(self.fake, "processes.json"),
                   FAILOVER_KILL=os.path.join(self.bin, "kill"), FAILOVER_EXIT_WAIT_S="1", FAILOVER_APPEAR_WAIT_S="1",
                   FAILOVER_STOP_WAIT_S="1")
        env.pop("CLAUDE_CONFIG_DIR", None)
        env.pop("ORCA_WORKER_SETTINGS", None)
        return env

    def run_cmd(self, *args, timeout=60):
        """試験の環境で args を動かす。偽の orca が返らないときは孫ごと止め、最後に呼んだ orca を出して落とす。"""
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
                return [json.loads(l) for l in fh]
        except FileNotFoundError:
            return []

    def selects(self):
        return [c[c.index("--account") + 1] for c in self.calls() if c[:2] == ["account", "select"]]

    def typed(self, handle=None):
        """端末に打った文字（handle を省けばすべての端末の (handle, 文字)）。"""
        got = [(c[c.index("--terminal") + 1], c[c.index("--text") + 1]) for c in self.calls() if c[:2] == ["terminal", "send"]]
        return [t for h, t in got if h == handle] if handle else got

    def sent(self):
        """orchestration send の (送り主, 宛先, 件名, 本文)。"""
        out = []
        for c in self.calls():
            if c[:2] == ["orchestration", "send"]:
                g = lambda k: c[c.index(k) + 1] if k in c else None
                out.append((g("--from"), g("--to"), g("--subject"), g("--body")))
        return out

    def kills(self):
        return [int(c[1]) for c in self.calls() if c[0] == "kill"]

    def notes(self):
        try:
            with open(os.path.join(self.tmp, "notes")) as fh:
                return fh.read().splitlines()
        except FileNotFoundError:
            return []

    def status(self):
        with open(os.path.join(self.home, "failover.json")) as fh:
            return json.load(fh)["alerts"]

    def band(self):
        return " / ".join(x["text"] for x in self.status() if x["id"].startswith("failover:converge:"))

    def history(self):
        with open(os.path.join(self.home, "failover-history.jsonl")) as fh:
            return [json.loads(l) for l in fh]

    def state(self):
        with open(os.path.join(self.home, "failover-state.json")) as fh:
            return json.load(fh)

    def edit_state(self, **fields):
        st = self.state() if os.path.exists(os.path.join(self.home, "failover-state.json")) else {}
        st.update(fields)
        os.makedirs(self.home, exist_ok=True)
        with open(os.path.join(self.home, "failover-state.json"), "w") as fh:
            json.dump(st, fh)

    def processes(self):
        return self.get("processes.json")


class SwitchTest(FailoverTestBase):
    """席の選び方・往復の抑止・全席が上限の知らせ（古い席の claude が無いとき）。"""

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
        h = self.history()[0]
        self.assertEqual((h["event"], h["from"], h["to"]), ("switched", EMAIL[A], EMAIL[B]))
        self.assertIn("seat-b@example.com に切り替えた", self.notes()[0])
        self.assertTrue(self.status()[0]["id"].startswith("failover:switched:"))

    def test_tries_a_seat_whose_usage_is_unknown_when_no_seat_is_known_free(self):
        # stale-token は「しばらく動いていない席のトークンが古いだけ」（Orca の説明）なので、ログインが要るとは見なさない。
        self.accounts(A, {A: usage(weekly=100), B: usage(session=100), C: usage(status="error", failure="stale-token")})
        self.run_failover()
        self.assertEqual(self.selects(), [C])

    def test_weekly_limit_holds_even_after_the_5_hour_window_reset(self):
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
        self.seat_settings(C, "bypassPermissions")
        out = self.run_failover("--dry-run")
        self.assertIn("seat-c@example.com はclaude を起こすと「auto mode を既定にするかの確認」で止まる", out)
        self.run_failover()
        self.assertEqual(self.selects(), [])
        # その席で一度答えれば（.claude.json に答えが残る）行き先になる。
        self.seat_settings(C, "bypassPermissions", hasSeenAutoDefaultNudge=True)
        self.run_failover()
        self.assertEqual(self.selects(), [C])

    def test_seat_never_started_is_not_chosen(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage()})
        os.remove(os.path.join(self.seat_dir(C), ".claude.json"))
        self.run_failover()
        self.assertEqual(self.selects(), [])
        self.assertIn("「初回の設定の画面」で止まる", self.notes()[0])

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
        st = self.state()
        for s in st["switches"]:
            s["at"] -= 11 * MIN
        st["left"][A]["at"] -= 11 * MIN
        self.edit_state(**st)
        self.accounts(B, {B: usage(session=100), A: usage(session=10, updated=st["left"][A]["at"] - MIN), C: usage(status="error")})
        self.run_failover()
        self.assertEqual(self.selects(), [B, C])

    def test_tells_when_orca_cannot_read_the_seat_it_moved_to(self):
        self.accounts(A, {A: usage(session=100), B: usage(session=100), C: usage(status="error")})
        self.run_failover()
        self.assertEqual(self.selects(), [C])
        st = self.state()
        st["moved_to"]["at"] -= 16 * MIN
        self.edit_state(**st)
        self.accounts(C, {C: usage(status="error"), A: usage(session=100), B: usage(session=100)})
        self.run_failover()
        self.assertTrue(any(x["id"] == "failover:blind:" + C for x in self.status()))

    def test_a_refused_switch_is_not_counted_and_is_retried(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.flag("select-fails")
        r = self.run_cmd(sys.executable, SCRIPT, *SEATS)
        self.assertNotEqual(r.returncode, 0)
        self.flag("select-fails", False)
        # 断られた回を切り替えと数えていれば、10 分は待って試し直さない。
        self.run_failover()
        self.assertEqual(self.selects(), [B, B])
        self.assertEqual(self.history()[-1]["to"], EMAIL[B])

    def test_waits_after_a_switch_before_switching_again(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.run_failover()
        self.accounts(B, {B: usage(session=100), A: usage(session=100), C: usage()})
        out = self.run_failover()
        self.assertEqual(self.selects(), [B])
        self.assertIn("待つ", out)

    def test_a_failure_after_the_switch_is_still_told_as_switched(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        # 切り替えたあとの記録（履歴）に書けない。
        os.makedirs(os.path.join(self.home, "failover-history.jsonl"))
        r = self.run_cmd(sys.executable, SCRIPT, *SEATS)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.selects(), [B])
        self.assertTrue(self.notes()[0].startswith("Claude の席を切り替えた\t"), self.notes())
        self.assertIn("席の切り替え（account-failover）が失敗した", self.notes()[1])

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

    def test_a_success_after_a_failure_ends_the_log_with_recovered(self):
        # stallwatch はログの最後の行で失敗を判断する。直ったあとも Traceback が最後に残ると、止まったと出し続ける。
        self.accounts(A, {A: usage(), B: usage(), C: usage()})
        self.assertNotEqual(self.run_cmd(sys.executable, SCRIPT, "--seat", "nobody@example.com").returncode, 0)
        last = self.run_failover().strip().splitlines()[-1]
        self.assertEqual(json.loads(last)["event"], "recovered")
        self.assertEqual(self.run_failover().strip(), "")


class ConvergeTest(FailoverTestBase):
    """古い席の claude を今の席へ移す処理（R205）。"""

    def old_terminal(self, handle="term_1", pid=101, preview="❯", state="done", argv=None, session=S1, **kw):
        self.put("terminals.json", [terminal(handle, preview)])
        self.put("agents.json", [pane_agent(handle, state)])
        self.proc(pid, seat=A, handle=handle, session=session,
                  argv=argv if argv is not None else ["--model", "opus", "--settings", self.settings, "--resume", S1], **kw)

    def launched(self, handle="term_1"):
        return [t for t in self.typed(handle) if t.startswith(("env ", "sh "))]

    def test_a_terminal_left_by_a_manual_switch_is_moved_in_place(self):
        # 人が席を B に切り替えた。上限ではないので切り替えはしないが、A に残った端末は同じ端末で B に移す。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal()
        self.run_failover()
        self.assertEqual(self.selects(), [])
        self.assertEqual(self.typed("term_1")[0], "/exit")
        (line,) = self.launched()
        self.assertEqual(shlex.split(line), ["env", "CLAUDE_CONFIG_DIR=" + self.seat_dir(B), "ORCA_WORKER_SETTINGS=" + self.settings,
                                             "claude", "--model", "opus", "--settings", self.settings, "--resume", S1])
        # 上限でも作業中でもなかったので、続きは頼まない。
        self.assertEqual(len(self.typed("term_1")), 2)
        (p,) = self.processes()
        self.assertEqual((p["env"]["ORCA_TERMINAL_HANDLE"], p["env"]["CLAUDE_CONFIG_DIR"]), ("term_1", self.seat_dir(B)))
        events = [h["event"] for h in self.history()]
        self.assertEqual(events, ["moved", "converge", "converged"])
        self.assertEqual(self.status(), [])
        self.assertEqual(self.state()["moves"], {})

    def test_a_limited_terminal_is_moved_right_after_the_switch_and_asked_to_continue(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.old_terminal(preview="前の報告\n" + LIMIT_LINE + "\n❯")
        self.run_failover()
        self.assertEqual(self.selects(), [B])
        typed = self.typed("term_1")
        self.assertEqual(typed[0], "/exit")
        self.assertTrue(typed[1].startswith("env 'CLAUDE_CONFIG_DIR=%s'" % self.seat_dir(B)), typed[1])
        self.assertIn("席の切り替えで、claude を今の席（seat-b@example.com）で起こし直しました", typed[2])
        self.assertEqual([h["event"] for h in self.history()][:2], ["switched", "moved"])
        self.assertTrue(self.history()[1]["nudged"])

    def test_a_terminal_whose_conversation_hit_the_limit_is_moved_while_orca_still_shows_it_working(self):
        # 上限のエラーで止まった claude は、Orca の状態が working のままでも移す（画面ではなく会話記録で見る）。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(state="working", reply=LIMIT_LINE)
        self.run_failover()
        self.assertEqual(self.typed("term_1")[0], "/exit")
        self.assertEqual(len(self.typed("term_1")), 3)

    def test_a_working_terminal_waits_for_the_next_round(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(state="working")
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("題 term_1（端末 term_1） が古い席 seat-a@example.com の claude のまま: 作業中。手が空いたら移す", self.band())
        # 作業中を待つだけなら通知しない。
        self.assertEqual(self.notes(), [])
        # 次の回に手が空いていれば移し、帯を消す。
        self.put("agents.json", [pane_agent("term_1", "done")])
        self.run_failover()
        self.assertEqual(self.typed("term_1")[0], "/exit")
        self.assertEqual(self.status(), [])
        self.assertEqual(self.history()[-1]["event"], "converged")

    def test_a_terminal_that_claude_says_is_busy_waits(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(status="busy")
        self.run_failover()
        self.assertEqual(self.typed(), [])

    def test_a_worker_whose_settings_cannot_be_read_is_not_touched(self):
        # Dispatch を受けた端末なのに、claude の引数に worker の設定が無い（Orca が --settings を落として起こし直したもの）。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=["--plugin-dir", "/x/orca-agent-view", "--resume", S1])
        self.put("workers.json", [{"dispatchId": "ctx_1", "taskId": "task_1", "state": "done", "outcome": "succeeded", "terminal": "term_1"}])
        self.run_failover()
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("worker の設定（--settings のファイル）が無いので触らない", self.band())
        (note,) = self.notes()
        self.assertIn("題 term_1（端末 term_1）", note)

    def test_a_worker_whose_settings_file_is_gone_is_not_touched(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=["--settings", "/nowhere/settings.worker.json", "--resume", S1])
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("worker の設定 /nowhere/settings.worker.json を読めない", self.band())

    def test_a_terminal_without_a_conversation_id_is_named(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=["--model", "opus"], session=None)
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("会話 id が分からない", self.band())

    def test_the_conversation_id_comes_from_the_argument_when_claude_wrote_no_session_file(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=["--resume", S2], session=None)
        self.run_failover()
        self.assertEqual(shlex.split(self.launched()[0])[-2:], ["--resume", S2])

    def test_continue_is_replaced_by_the_running_conversation(self):
        # --continue で起きた claude は、sessions/<pid>.json の会話 id で --resume に替える（同じ会話のまま）。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=["--plugin-dir", "/Users/x/Library/Application Support/orca/view", "--model", "opus", "--continue"], session=S2)
        self.run_failover()
        self.assertEqual(shlex.split(self.launched()[0])[3:],
                         ["claude", "--plugin-dir", "/Users/x/Library/Application Support/orca/view", "--model", "opus", "--resume", S2])

    def ask_argv(self, prompt):
        """consult --ask が起こした claude の引数（実際の質問の端末と同じ形）。最後が最初の指示の位置引数。"""
        return ["--resume", S2, "--fork-session", "--name", "質問｜FitFounder AI 基盤｜ask2", "--tools", "Read,Grep,Glob",
                "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent",
                "--permission-mode", "dontAsk", "--strict-mcp-config", "--system-prompt-snapshot", "off",
                "--append-system-prompt-file", "/cfg/roles/ask.md", prompt]

    def test_a_question_terminal_is_relaunched_without_its_first_instruction(self):
        # 2026-11-23 16:2x: 7,000 字あまりの最初の指示を残した 8KB 近い行を打ち、zsh が `quote>` の続き入力になって壊れた。
        # 最初の指示は外し（残すと同じ会話にもう一度送られる）、値を取るオプションの値は残す。
        prompt = "【相談の知らせ】質問を始める。\n「窓口」の会話を写した。" + "背景の説明。" * 1200
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=self.ask_argv(prompt), session=S1)
        self.run_failover()
        (line,) = self.launched()
        self.assertLess(len(line), 1000)
        self.assertEqual(shlex.split(line)[3:], [
            "claude", "--name", "質問｜FitFounder AI 基盤｜ask2", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob",
            "--disallowedTools", "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent", "--permission-mode", "dontAsk",
            "--strict-mcp-config", "--system-prompt-snapshot", "off", "--append-system-prompt-file", "/cfg/roles/ask.md", "--resume", S1])
        self.assertEqual(self.processes()[0]["env"]["CLAUDE_CONFIG_DIR"], self.seat_dir(B))
        self.assertEqual(self.state()["moves"], {})

    def test_a_long_relaunch_line_is_written_to_a_file_and_started_with_a_short_one(self):
        long_prompt = "役割の説明。" * 400
        argv = ["--model", "opus", "--settings", self.settings, "--append-system-prompt", long_prompt, "--resume", S1]
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=argv)
        self.run_failover()
        (line,) = self.launched()
        self.assertLess(len(line), 300)
        path = os.path.join(self.home, "relaunch", "term_1.sh")
        self.assertEqual(shlex.split(line), ["sh", path])
        (p,) = self.processes()
        self.assertEqual(p["argv"], ["claude", "--model", "opus", "--settings", self.settings, "--append-system-prompt", long_prompt, "--resume", S1])
        self.assertEqual(p["env"]["CLAUDE_CONFIG_DIR"], self.seat_dir(B))
        self.assertFalse(os.path.exists(path))
        self.assertEqual(self.state()["moves"], {})

    def test_an_argument_whose_value_is_unclear_is_not_relaunched(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(argv=["--model", "opus", "--settings", self.settings, "--new-option", "x", "--resume", S1])
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("claude の引数 --new-option が値を取るか分からない", self.band())

    def test_a_terminal_closed_before_the_relaunch_is_cleared_without_a_band(self):
        # 2026-11-23 16:25 の drop-sales-view-flag: 窓口が worktree を消して、/exit のあと端末が閉じた。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal()
        self.flag("launch-closes-terminal")
        self.run_failover()
        self.assertEqual(self.status(), [])
        self.assertEqual(self.state()["moves"], {})
        gone = [h for h in self.history() if h["event"] == "gone"]
        self.assertEqual([(g["handle"], g["session"], g["stage"]) for g in gone], [("term_1", S1, "launch")])
        self.assertEqual(self.notes(), [])

    def test_a_relaunched_terminal_that_closed_is_cleared_at_once(self):
        # 起こし直すコマンドを打ったあとに端末が閉じた。3 分待って打ち直さず、すぐ片付ける。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [])
        self.put("agents.json", [])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": False, "working": False,
               "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "launched", "at": now_ms() - MIN,
               "launched_at": now_ms() - MIN, "tries": 0}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertEqual(self.status(), [])
        self.assertEqual(self.state()["moves"], {})
        self.assertEqual(self.history()[-1]["event"], "gone")

    def test_a_given_up_terminal_that_closed_is_cleared(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": False, "working": False,
               "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "failed", "failed_at": "launch",
               "why": "起こし直すコマンドを送れなかった", "at": now_ms() - MIN, "tries": 3}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        self.assertEqual(self.status(), [])
        self.assertEqual(self.state()["moves"], {})
        self.assertEqual([(h["event"], h["stage"]) for h in self.history()][-1:], [("gone", "launch")])

    def test_a_given_up_terminal_that_closed_is_only_shown_in_a_dry_run(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": False, "working": False,
               "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "failed", "failed_at": "launch",
               "why": "起こし直すコマンドを送れなかった", "at": now_ms() - MIN, "tries": 3}
        self.edit_state(moves={"term_1": rec})
        out = self.run_failover("--dry-run")
        self.assertIn("片付ける: 題 term_1（端末 term_1）（端末が閉じた。会話 %s）" % S1, out)
        self.assertFalse(os.path.exists(os.path.join(self.home, "failover-history.jsonl")))
        self.assertEqual(self.state()["moves"]["term_1"]["stage"], "failed")

    def test_a_move_recorded_by_the_previous_version_with_an_unclear_argument_is_given_up(self):
        # 前の版は引数を確かめずに /exit した。次の版で起こすコマンドを組めなくても、ほかの端末を止めずにその端末だけ名指しする
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_1"), terminal("term_2")])
        self.put("agents.json", [pane_agent("term_2")])
        self.proc(102, seat=A, handle="term_2", session=S2, argv=["--model", "opus", "--settings", self.settings, "--resume", S2])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--new-option", "x", "--resume", S1], "ws": None, "limited": False,
               "working": False, "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "launch", "at": now_ms() - MIN, "tries": 0}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        self.assertEqual(self.typed("term_1"), [])
        self.assertEqual(self.state()["moves"]["term_1"]["stage"], "failed")
        self.assertIn("claude の引数 --new-option が値を取るか分からない", self.band())
        self.assertIn("会話 %s を手で起こし直す" % S1, self.band())
        self.assertEqual(len(self.launched("term_2")), 1)

    def test_a_launched_move_of_the_previous_version_finishes_even_with_an_unclear_argument(self):
        # 起こし直したあとの記録はコマンドを組まないので、引数が分からなくても済にする（Dispatch の付け直しや続きの頼みを飛ばさない）
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_1")])
        self.put("agents.json", [pane_agent("term_1")])
        self.proc(201, seat=B, handle="term_1", session=S1, argv=["--new-option", "x", "--resume", S1])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--new-option", "x", "--resume", S1], "ws": None, "limited": True,
               "working": False, "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "launched", "at": now_ms() - MIN,
               "launched_at": now_ms() - MIN, "tries": 0}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        (typed,) = self.typed("term_1")
        self.assertIn("続けてください", typed)
        self.assertEqual(self.state()["moves"], {})

    def test_a_terminal_at_a_startup_screen_is_named_and_not_answered(self):
        # 調査の D: 古い席の確認の画面（External imports）で止まった端末。Orca の一覧には claude として出ない。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal()
        self.put("agents.json", [])
        self.put("screens.json", {"term_1": EXTERNAL_IMPORTS})
        self.run_failover()
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("確認の画面「CLAUDE.md の外部 import の承認（External imports）」で止まっている（自動では答えない）。端末で答える", self.band())
        self.assertEqual(len(self.notes()), 1)

    def test_a_relaunched_terminal_at_a_startup_screen_is_named_and_continued_once_answered(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(preview=LIMIT_LINE)
        self.put("after-launch.json", EXTERNAL_IMPORTS)
        self.run_failover()
        self.assertEqual(len(self.typed("term_1")), 2)  # /exit と起こすコマンドだけ。確認の画面に文字を打たない
        self.assertIn("今の席で起こし直したが、確認の画面「CLAUDE.md の外部 import の承認（External imports）」で止まっている", self.band())
        self.assertEqual(self.state()["moves"]["term_1"]["stage"], "launched")
        # 人が答えたら、次の回に続きを頼んで済にする。
        self.put("screens.json", {"term_1": ["❯"]})
        self.run_failover()
        typed = self.typed("term_1")
        self.assertEqual(len(typed), 3)
        self.assertIn("続けてください", typed[2])
        self.assertEqual(self.status(), [])

    def test_a_move_interrupted_after_exit_continues_from_the_launch(self):
        # 前の回が /exit を送ったあとに落ちた（claude は終わり、端末はシェルに戻っている）。次の回は /exit を送らずに起こす。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_1")])
        self.put("agents.json", [])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--model", "opus", "--settings", self.settings, "--resume", S1],
               "ws": self.settings, "limited": True, "working": False, "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A),
               "stage": "exit", "at": now_ms() - MIN, "tries": 0}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        typed = self.typed("term_1")
        self.assertEqual(len(typed), 2)
        self.assertTrue(typed[0].startswith("env "))
        self.assertIn("続けてください", typed[1])
        self.assertEqual(self.state()["moves"], {})

    def test_a_move_interrupted_after_the_launch_does_not_type_the_command_twice(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_1")])
        self.put("agents.json", [pane_agent("term_1")])
        self.proc(201, seat=B, handle="term_1", session=S1, argv=["--resume", S1])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": False, "working": False,
               "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "launched", "at": now_ms() - MIN,
               "launched_at": now_ms() - MIN, "tries": 0}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertEqual(self.state()["moves"], {})

    def test_a_claude_that_will_not_exit_is_tried_again_then_named(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal()
        self.flag("exit-hangs")
        self.run_failover()
        # 終わらなくても /exit は打ち直さない（入力先の状態を確かめないまま文字を重ねない）。
        self.assertEqual(self.typed("term_1"), ["/exit"])
        self.assertIn("/exit のあと claude が終わらない（/exit は打ち直さない）。次の回に続きから試す", self.band())
        for _ in range(3):
            self.run_failover()
        self.assertEqual(self.typed("term_1"), ["/exit"])
        # 諦めた印は残し、手で直るまで帯に出し続ける（最初からやり直さない）。
        self.assertIn("3 回試して諦めた。手で移す", self.band())
        self.assertEqual(self.state()["moves"]["term_1"]["stage"], "failed")
        self.assertEqual(len(self.notes()), 1)
        # 人が端末で今の席に移したら、帯から消える。
        self.put("processes.json", [])
        self.proc(201, seat=B, handle="term_1", session=S1)
        self.run_failover()
        self.assertEqual(self.status(), [])
        self.assertEqual(self.state()["moves"], {})

    def test_a_launch_interrupted_before_it_was_recorded_is_not_typed_again(self):
        # 前の回が起こすコマンドを送ったあと、記録する前に落ちた。起きた claude（の入力欄）にコマンドを打ち直さない。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_1")])
        self.put("agents.json", [pane_agent("term_1")])
        self.proc(201, seat=B, handle="term_1", session=S1, argv=["--resume", S1])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": True, "working": False,
               "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "launch", "at": now_ms() - MIN, "tries": 0}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        typed = self.typed("term_1")
        self.assertEqual(len(typed), 1)
        self.assertIn("続けてください", typed[0])

    def test_a_relaunched_claude_on_another_conversation_is_not_asked_to_continue(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_1")])
        self.put("agents.json", [pane_agent("term_1")])
        self.proc(201, seat=B, handle="term_1", session=S2, argv=["--resume", S2])
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": True, "working": False,
               "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "launched", "at": now_ms() - MIN,
               "launched_at": now_ms() - MIN, "tries": 0}
        self.edit_state(moves={"term_1": rec})
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("今の席で会話 %s を開き直したものと確かめられない" % S1, self.band())

    def test_an_exit_whose_reply_was_lost_still_relaunches(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal()
        self.flag("exit-reply-lost")
        self.run_failover()
        self.assertEqual(len(self.launched()), 1)
        self.assertEqual(self.processes()[0]["env"]["CLAUDE_CONFIG_DIR"], self.seat_dir(B))

    def test_a_terminal_that_went_on_after_the_limit_is_not_exited(self):
        # 画面には上限の 1 行が残るが、会話記録ではそのあと新しい指示を受けて作業している。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(preview=LIMIT_LINE, state="working", reply=LIMIT_LINE, then="続けて")
        self.run_failover()
        self.assertEqual(self.typed(), [])

    def test_a_terminal_running_two_claude_is_not_touched(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal()
        self.proc(102, seat=B, handle="term_1", session=S2)
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("同じ端末に claude が 2 個ある（pid 101, 102）ので触らない", self.band())

    def test_a_terminal_whose_screen_cannot_be_read_is_not_touched(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(preview=LIMIT_LINE)
        self.flag("read-fails")
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("端末の画面を読めない", self.band())

    def worker(self, coordinator="structworker_lead", **kw):
        """Dispatch を受けている worker の端末。Orca 1.4.271 と同じく、claude が終わると Dispatch を failed で閉じる。"""
        self.old_terminal(**kw)
        self.put("workers.json", [{"dispatchId": "ctx_w", "taskId": "task_w", "state": "ready", "outcome": "in_progress", "terminal": "term_1"}])
        self.put("shows.json", {"ctx_w": {"dispatchId": "ctx_w", "taskId": "task_w", "runId": "run_w", "state": "ready", "terminal": "term_1"}})
        # 実物の `orca orchestration run-show --id <run> --full --json` の result の形（2026-11-23 に確かめた）。窓口のチャットが coordinator なら null
        self.put("runs.json", {"run_w": {"run": {"id": "run_w", "coordinator_handle": coordinator}}})
        self.flag("exit-closes-dispatch")

    def test_a_worker_whose_dispatch_orca_closed_gets_a_follow_up_from_its_coordinator(self):
        # 2026-11-23 15:18 の ask-thread-tab の worker: 起こし直しても Dispatch は閉じたままで、担当が手で続きを送った（t143）。
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.worker(preview=LIMIT_LINE)
        self.assertIn("（Dispatch ctx_w が閉じたら続きを送る）", self.run_failover("--dry-run"))
        self.run_failover()
        (notice, follow) = self.sent()
        # 先に Run の受信箱へ、立て直さないよう知らせる（Orca が「Worker exited without reporting」を出すため）
        self.assertEqual(notice[:2], ("term_1", "run:run_w"))
        self.assertIn("Dispatch ctx_w を failed で閉じ「Worker exited without reporting」を出すが、worker-start で立て直さない", notice[3])
        self.assertEqual(follow[:2], ("structworker_lead", "dispatch:ctx_w"))
        self.assertIn("この Dispatch の id で worker_done を送る", follow[3])
        order = [" ".join(c[:2]) + ("" if c[:2] != ["terminal", "send"] else ":" + c[c.index("--text") + 1].split()[0]) for c in self.calls()
                 if c[:2] in (["terminal", "send"], ["orchestration", "send"])]
        self.assertEqual(order, ["orchestration send", "terminal send:/exit", "terminal send:env", "orchestration send"])
        self.assertEqual(len(self.typed("term_1")), 2)
        moved = [h for h in self.history() if h["event"] == "moved"][0]
        self.assertEqual((moved["dispatch"], moved["follow_up"], moved["nudged"]), ("ctx_w", "ctx_f1", False))
        self.assertEqual(self.state()["moves"], {})

    def test_a_worker_of_a_chat_coordinator_is_continued_and_its_coordinator_is_asked(self):
        # Orca はチャットを --from で名乗らせない（session_caller_chat_not_declarable）。
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.worker(coordinator=None, preview=LIMIT_LINE)
        self.run_failover()
        (notice, ask) = self.sent()
        self.assertIn("起き直したと知らせたら `orca orchestration send --to dispatch:ctx_w` で続きを送る", notice[3])
        self.assertEqual(ask[:2], ("term_1", "run:run_w"))
        self.assertIn("`orca orchestration send --to dispatch:ctx_w --subject <題> --body <続きの指示>` で続き", ask[3])
        self.assertIn("続けてください", self.typed("term_1")[2])
        moved = [h for h in self.history() if h["event"] == "moved"][0]
        self.assertEqual((moved["follow_up"], moved["asked"], moved["nudged"]), (None, True, True))

    def test_a_follow_up_that_orca_turns_into_mail_falls_back_to_asking_the_coordinator(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker(reply=LIMIT_LINE)
        self.flag("follow-up-refused")
        self.run_failover()
        tos = [(f, t) for f, t, _s, _b in self.sent()]
        self.assertEqual(tos, [("term_1", "run:run_w"), ("structworker_lead", "dispatch:ctx_w"), ("term_1", "run:run_w")])
        self.assertIn("続けてください", self.typed("term_1")[2])
        self.assertTrue([h for h in self.history() if h["event"] == "moved"][0]["asked"])

    def test_a_follow_up_whose_reply_was_lost_is_not_sent_twice(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker(reply=LIMIT_LINE)
        self.flag("follow-up-reply-lost")
        self.run_failover()
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["run:run_w", "dispatch:ctx_w"])
        self.assertEqual(len(self.typed("term_1")), 2)
        self.assertEqual([h for h in self.history() if h["event"] == "moved"][0]["follow_up"], "ctx_f1")

    def test_a_follow_up_sent_before_a_crash_is_not_sent_again(self):
        # 前の回が続きを送ったあと、記録する前に落ちた。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker(reply=LIMIT_LINE)
        self.put("processes.json", [])
        self.proc(201, seat=B, handle="term_1", session=S1, argv=["--resume", S1])
        # 続きはもう済んでいる（worker_done を送った）
        self.put("workers.json", [{"dispatchId": "ctx_w", "state": "failed", "terminal": "term_1"},
                                  {"dispatchId": "ctx_f1", "state": "succeeded", "terminal": "term_1"},
                                  {"dispatchId": "ctx_other", "state": "succeeded", "terminal": "term_1"}])
        shows = self.get("shows.json")
        shows["ctx_w"]["state"] = "failed"
        shows["ctx_f1"] = {"dispatchId": "ctx_f1", "state": "succeeded", "followUpOf": "ctx_w"}
        shows["ctx_other"] = {"dispatchId": "ctx_other", "state": "succeeded", "followUpOf": None}
        self.put("shows.json", shows)
        self.edit_state(moves={"term_1": self.launched_worker()})
        self.run_failover()
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.typed(), [])
        self.assertEqual(self.history()[0]["follow_up"], "ctx_f1")

    def test_a_worker_is_not_exited_until_its_run_has_been_told(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker(reply=LIMIT_LINE)
        self.flag("send-fails")
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertIn("先の知らせを run:run_w に送れなかったので、まだ移していない", self.band())
        self.flag("send-fails", False)
        self.run_failover()
        self.assertEqual(self.typed("term_1")[0], "/exit")
        # 断られた 1 通は送り直さない（次の回に改めて 1 通送る）
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["run:run_w", "run:run_w", "dispatch:ctx_w"])

    def launched_worker(self):
        """起こし直したあと、Dispatch を付け直す前に落ちた記録。"""
        return {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": True, "working": False,
                "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "launched", "at": now_ms() - MIN,
                "launched_at": now_ms() - MIN, "tries": 0, "dispatch": "ctx_w", "run": "run_w", "coordinator": "structworker_lead"}

    def test_a_dispatch_that_cannot_be_checked_after_the_move_waits_for_the_next_round(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker(reply=LIMIT_LINE)
        self.put("processes.json", [])
        self.proc(201, seat=B, handle="term_1", session=S1, argv=["--resume", S1])
        self.put("workers.json", [{"dispatchId": "ctx_w", "state": "failed", "terminal": "term_1"}])
        shows = self.get("shows.json")
        shows["ctx_w"]["state"] = "failed"
        self.put("shows.json", shows)
        self.edit_state(moves={"term_1": self.launched_worker()})
        self.flag("list-fails")
        self.run_failover()
        self.assertEqual((self.sent(), self.typed()), ([], []))
        self.assertIn("Dispatch ctx_w を確かめられない", self.band())
        self.assertEqual(self.state()["moves"]["term_1"]["stage"], "launched")
        self.flag("list-fails", False)
        self.run_failover()
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["dispatch:ctx_w"])
        self.assertEqual(self.state()["moves"], {})

    def test_a_dispatch_still_open_is_left_alone_even_if_another_on_the_terminal_is_live(self):
        # 同じ端末で別件の Dispatch が動いていても、それを続きと見なさない。旧 Dispatch が開いていれば何も送らない
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker(reply=LIMIT_LINE)
        self.flag("exit-closes-dispatch", False)
        workers = self.get("workers.json")
        self.put("workers.json", workers + [{"dispatchId": "ctx_other", "state": "ready", "outcome": "in_progress", "terminal": "term_1"}])
        shows = self.get("shows.json")
        shows["ctx_other"] = {"dispatchId": "ctx_other", "state": "ready", "followUpOf": None}
        self.put("shows.json", shows)
        self.run_failover()
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["run:run_w"])
        self.assertIsNone(self.history()[0]["follow_up"])

    def test_a_worker_relaunched_by_hand_on_the_current_seat_still_gets_its_dispatch_back(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker(reply=LIMIT_LINE)
        rec = {"kind": "terminal", "pid": 101, "session": S1, "argv": ["--resume", S1], "ws": None, "limited": True, "working": False,
               "label": "題 term_1（端末 term_1）", "from": self.seat_dir(A), "stage": "exit", "at": now_ms() - MIN, "tries": 0,
               "dispatch": "ctx_w", "run": "run_w", "coordinator": "structworker_lead"}
        self.edit_state(moves={"term_1": rec})
        self.put("processes.json", [])
        self.proc(201, seat=B, handle="term_1", session=S1, argv=["--resume", S1])
        workers = self.get("workers.json")
        workers[0].update(state="failed")
        workers[0].pop("outcome")
        self.put("workers.json", workers)
        shows = self.get("shows.json")
        shows["ctx_w"]["state"] = "failed"
        self.put("shows.json", shows)
        self.run_failover()
        self.assertEqual(self.typed(), [])
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["dispatch:ctx_w"])

    def test_a_dispatch_orca_kept_open_is_not_followed_up(self):
        # Orca 1.4.271 より前（2026-11-22 の T2）は、claude を替えても Dispatch が残った。そのときは続きを送らず、端末に続きを打つ。
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.worker(preview=LIMIT_LINE)
        self.flag("exit-closes-dispatch", False)
        self.run_failover()
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["run:run_w"])
        self.assertIn("続けてください", self.typed("term_1")[2])

    def test_a_dispatch_given_while_others_were_moved_is_followed_up(self):
        # 2026-11-23 の ui-verify-loop の worker: 移す順を待つ間（15:19:51）に担当が続きを送り、その Dispatch が /exit で閉じた。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.worker()
        self.put("workers-late", 1)
        self.run_failover()
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["run:run_w", "dispatch:ctx_w"])

    def test_limited_terminals_are_moved_before_idle_ones(self):
        # 端末は 1 つ 10 秒ほどかかる。上限で止まった端末（と Dispatch を受けている端末）を、手の空いた端末より先に移す。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_a"), terminal("term_b"), terminal("term_c", preview=LIMIT_LINE)])
        self.put("agents.json", [pane_agent("term_a"), pane_agent("term_b"), pane_agent("term_c")])
        for pid, h in ((101, "term_a"), (102, "term_b"), (103, "term_c")):
            self.proc(pid, seat=A, handle=h, session=S1, argv=["--settings", self.settings, "--resume", S1])
        self.put("workers.json", [{"dispatchId": "ctx_b", "taskId": "task_b", "state": "ready", "outcome": "in_progress", "terminal": "term_b"}])
        self.put("shows.json", {"ctx_b": {"dispatchId": "ctx_b", "runId": "run_b", "state": "ready"}})
        self.put("runs.json", {"run_b": {"run": {"id": "run_b", "coordinator_handle": "structworker_lead"}}})
        self.run_failover()
        exits = [h for h, t in self.typed() if t == "/exit"]
        self.assertEqual(exits, ["term_c", "term_b", "term_a"])

    def test_a_dispatch_given_during_another_move_moves_that_terminal_next(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal(h) for h in ("term_a", "term_b", "term_z")])
        self.put("agents.json", [pane_agent(h) for h in ("term_a", "term_b", "term_z")])
        for pid, h in ((101, "term_a"), (102, "term_b"), (103, "term_z")):
            self.proc(pid, seat=A, handle=h, session=S1, argv=["--settings", self.settings, "--resume", S1])
        self.put("workers.json", [{"dispatchId": "ctx_z", "taskId": "task_z", "state": "ready", "outcome": "in_progress", "terminal": "term_z"}])
        self.put("shows.json", {"ctx_z": {"dispatchId": "ctx_z", "runId": "run_z", "state": "ready"}})
        self.put("runs.json", {"run_z": {"run": {"id": "run_z", "coordinator_handle": "structworker_lead"}}})
        # 1 回目は順を選ぶとき、2 回目は term_a を /exit する直前。term_a を移している間に term_z が Dispatch を受けた
        self.put("workers-late", 2)
        self.run_failover()
        self.assertEqual([h for h, t in self.typed() if t == "/exit"], ["term_a", "term_z", "term_b"])

    def test_a_chat_without_a_turn_is_stopped(self):
        # 窓口のチャットは ORCA_TERMINAL_HANDLE を持たない。作業中のターンが無いので裏の claude を止める（次の発言で今の席に起きる）。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("agents.json", [chat_agent("chat_1")])
        self.proc(301, seat=A, chat="chat_1", session=S1)
        self.run_failover()
        self.assertEqual(self.kills(), [301])
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.status(), [])
        self.assertEqual(self.history()[0]["kind"], "chat")

    def test_a_chat_in_the_middle_of_a_turn_is_left(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("agents.json", [chat_agent("chat_1", "working")])
        self.proc(301, seat=A, chat="chat_1", session=S1, reply="調べています")
        self.run_failover()
        self.assertEqual(self.kills(), [])
        self.assertIn("作業中のターンがある。終わったら止める", self.band())

    def test_a_working_chat_that_keeps_hitting_the_limit_is_stopped(self):
        # 調査の A（BW の窓口）: 監視を抱えて Orca の状態は working のまま、会話の最後が上限のエラー。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("agents.json", [chat_agent("chat_1", "working")])
        self.proc(301, seat=A, chat="chat_1", session=S1, reply=LIMIT_LINE)
        self.run_failover()
        self.assertEqual(self.kills(), [301])
        # Dispatch の無い窓口には続きを送らない（Orca の自動の続きに任せる）。
        self.assertEqual(self.sent(), [])

    def test_a_chat_given_new_input_after_the_limit_is_not_stopped(self):
        # 上限の応答のあとに新しい指示が届き、まだ答えていない。古い上限の応答を根拠に止めない。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("agents.json", [chat_agent("chat_1", "working")])
        self.proc(301, seat=A, chat="chat_1", session=S1, reply=LIMIT_LINE, then="続けて")
        self.run_failover()
        self.assertEqual(self.kills(), [])

    def test_a_lead_that_started_a_turn_while_waiting_to_be_told_is_not_stopped(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.lead()
        self.flag("send-fails")
        self.run_failover()
        self.flag("send-fails", False)
        self.put("agents.json", [chat_agent("chat_l", "working", "任せる｜仕事")])
        self.run_failover()
        self.assertEqual(self.kills(), [])
        self.assertEqual(len(self.sent()), 1)  # 断られた 1 回だけ。作業中の担当に「止めた」と送らない
        self.assertIn("作業中のターンがある", self.band())

    def test_a_lead_is_not_stopped_after_the_seat_was_switched_back_to_it(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.lead()
        self.flag("send-fails")
        self.run_failover()
        self.flag("send-fails", False)
        # 人が席を A に戻した。担当はもう今の席で動いているので、持ち越した停止はしない。
        self.accounts(A, {A: usage(), B: usage(), C: usage()})
        self.run_failover()
        self.assertEqual(self.kills(), [])
        self.assertEqual(self.state()["moves"], {})
        self.assertEqual(self.status(), [])

    def lead(self, reply="報告した", state="done"):
        self.put("agents.json", [chat_agent("chat_l", state, "任せる｜仕事")])
        self.proc(401, seat=A, handle="structworker_l", chat="chat_l", session=S1, reply=reply)
        self.put("workers.json", [{"dispatchId": "ctx_l", "taskId": "task_l", "state": "ready", "outcome": "in_progress", "terminal": "structworker_l"}])
        # 実物の `orca orchestration worker-show --dispatch <id> --json` の result の形（2026-11-23 に確かめた）
        self.put("shows.json", {"ctx_l": {"dispatchId": "ctx_l", "taskId": "task_l", "runId": "run_9", "state": "ready",
                                          "terminal": "structworker_l", "workspace": "r::/w/l"}})

    def test_a_waiting_lead_tells_its_run_before_it_is_stopped(self):
        # 調査の B: Dispatch を持つ担当。止めると Orca が coordinator に「Worker exited」を出すので、先に Run の受信箱へ 1 通送る。
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.lead()
        self.run_failover()
        order = [c[0] if c[0] == "kill" else " ".join(c[:2]) for c in self.calls() if c[0] == "kill" or c[:2] == ["orchestration", "send"]]
        self.assertEqual(order, ["orchestration send", "kill"])
        ((frm, to, _subject, body),) = self.sent()
        self.assertEqual((frm, to), ("structworker_l", "run:run_9"))
        self.assertIn("「任せる｜仕事」の裏の claude を止めた。Dispatch は生きているので立て直さない", body)

    def test_a_lead_stopped_at_the_limit_is_told_to_continue(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.lead(reply=LIMIT_LINE)
        self.run_failover()
        self.assertEqual(self.kills(), [401])
        (_notice, (frm, to, _s, body)) = self.sent()
        self.assertEqual((frm, to), ("structworker_l", "dispatch:ctx_l"))
        self.assertIn("バックグラウンドの監視は止まったので、要るものは張り直す", body)
        self.assertTrue(self.history()[0]["resumed"])

    def test_a_lead_is_not_stopped_until_its_run_has_been_told(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.lead()
        self.flag("send-fails")
        self.run_failover()
        self.assertEqual(self.kills(), [])
        self.assertIn("止める前の知らせを run:run_9 に送れなかったので、まだ止めていない", self.band())
        # 送れるようになったら、1 通だけ送って止める。
        self.flag("send-fails", False)
        self.run_failover()
        self.assertEqual(self.kills(), [401])
        # 送ったのは、断られた 1 回目と届いた 2 回目だけ（止めたあとに知らせを重ねない）。
        self.assertEqual([to for _f, to, _s, _b in self.sent()], ["run:run_9", "run:run_9"])
        self.assertEqual(self.status(), [])

    def test_a_chat_that_will_not_stop_is_tried_again(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("agents.json", [chat_agent("chat_1")])
        self.proc(301, seat=A, chat="chat_1", session=S1)
        self.flag("kill-ignored")
        self.run_failover()
        self.assertIn("SIGTERM を送ったが終わらない", self.band())
        self.flag("kill-ignored", False)
        self.run_failover()
        self.assertEqual(self.kills(), [301, 301])
        self.assertEqual(self.status(), [])

    def test_a_process_on_the_current_seat_is_left_and_nothing_is_read(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.proc(101, seat=B, handle="term_1", session=S1)
        self.run_failover()
        # 今の席と違うプロセスが無ければ、Orca の端末やチャットの一覧も読まない。
        self.assertEqual([c[:2] for c in self.calls()], [["account", "list"]])

    def test_a_process_that_cannot_be_moved_for_six_hours_is_given_up(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal(state="working")
        self.run_failover()
        st = self.state()
        st["converge"]["term_1"]["since"] -= 7 * HOUR
        self.edit_state(**st)
        self.run_failover()
        self.assertIn("6 時間たっても移せないので諦めた（作業中。手が空いたら移す）。手で移す", self.band())
        self.assertEqual(len(self.notes()), 1)
        # 次の回も同じ文のまま（理由を重ねない）。
        first = self.band()
        self.run_failover()
        self.assertEqual(self.band(), first)

    def test_dry_run_changes_nothing(self):
        self.accounts(A, {A: usage(session=100), B: usage(), C: usage()})
        self.old_terminal(preview=LIMIT_LINE)
        self.put("agents.json", [pane_agent("term_1"), chat_agent("chat_1")])
        self.proc(301, seat=A, chat="chat_1", session=S2)
        out = self.run_failover("--dry-run")
        self.assertIn("切り替える: seat-a@example.com → seat-b@example.com", out)
        self.assertIn("移す: 題 term_1（端末 term_1）: /exit → env 'CLAUDE_CONFIG_DIR=%s'" % self.seat_dir(B), out)
        self.assertIn("止める: 題 chat_1（チャット）", out)
        self.assertEqual([c for c in self.calls() if c[:2] in (["account", "select"], ["terminal", "send"]) or c[0] == "kill"], [])
        self.assertFalse(os.path.exists(self.home))

    def test_a_changed_agent_list_stops_the_move_and_is_told(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.old_terminal()
        self.flag("agents-renamed")
        r = self.run_cmd(sys.executable, SCRIPT, *SEATS)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.typed(), [])
        self.assertIn("形が変わった", self.notes()[0])
        self.assertIn("古い席の claude を今の席へ移す処理が失敗した", self.band())


class InventoryTest(FailoverTestBase):
    def test_inventory_lists_orca_claude_by_seat_and_fails_while_any_is_on_an_old_seat(self):
        self.accounts(B, {A: usage(), B: usage(), C: usage()})
        self.put("terminals.json", [terminal("term_1", title="作業｜x"), terminal("term_2", title="作業｜y")])
        self.put("agents.json", [pane_agent("term_1"), chat_agent("chat_1", "working", "窓口")])
        self.proc(101, seat=A, handle="term_1", session=S1)
        self.proc(102, seat=B, chat="chat_1")
        self.proc(103, seat=B, handle="term_2", argv=["--resume", S2])
        r = self.run_cmd(sys.executable, SCRIPT, "--inventory")
        self.assertEqual(r.returncode, 1, r.stderr)
        lines = r.stdout.splitlines()
        self.assertEqual(lines[0], "今の席: seat-b@example.com")
        self.assertEqual(lines[1].split("\t"), ["seat-a@example.com", "端末", "term_1", "作業｜x", "done　← 古い席"])
        self.assertEqual(lines[2].split("\t"), ["seat-b@example.com", "チャット", "-", "窓口", "working"])
        self.assertEqual(lines[-1], "合わせて 3 個。今の席と違うもの 1 個")
        self.assertEqual(self.calls()[-1][:2], ["terminal", "list"])  # 読むだけ
        os.remove(os.path.join(self.seat_dir(A), "sessions", "101.json"))
        self.put("processes.json", [p for p in self.processes() if p["pid"] != 101])
        self.assertEqual(self.run_cmd(sys.executable, SCRIPT, "--inventory").returncode, 0)


def load_module():
    loader = importlib.machinery.SourceFileLoader("account_failover", SCRIPT)
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("account_failover", loader))
    loader.exec_module(mod)
    return mod


class UnitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_module()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def with_processes(self, procs):
        path = os.path.join(self.tmp, "processes.json")
        with open(path, "w") as fh:
            json.dump(procs, fh)
        return mock.patch.dict(os.environ, {"FAILOVER_PROCESSES": path})

    def test_inventory_leaves_out_child_claude_and_claude_outside_orca(self):
        home = os.path.join(self.tmp, "Application Support", "seat", "home")
        os.makedirs(os.path.join(home, "sessions"))
        with open(os.path.join(home, "sessions", "10.json"), "w") as fh:
            json.dump({"sessionId": S1, "cwd": "/w", "status": "idle"}, fh)
        orca = {"CLAUDE_CONFIG_DIR": home, "ORCA_TERMINAL_HANDLE": "term_1"}
        procs = [
            {"pid": 10, "ppid": 5, "comm": ".claude-wrapped", "argv": ["claude", "--resume", S2], "env": orca},
            # worker が Bash で起こした claude -p（環境変数を受け継ぐので同じ handle を持つ）
            {"pid": 11, "ppid": 10, "comm": "zsh", "argv": ["zsh"], "env": orca},
            {"pid": 12, "ppid": 11, "comm": "claude", "argv": ["claude", "-p", "x"], "env": orca},
            # Chrome の native host など、Orca の外の claude
            {"pid": 13, "ppid": 5, "comm": ".claude-wrapped", "argv": ["claude", "--chrome-native-host"], "env": {}},
            # 窓口のチャット（ORCA_TERMINAL_HANDLE が無い）
            {"pid": 14, "ppid": 6, "comm": ".claude-wrapped", "argv": ["claude", "--resume=" + S2],
             "env": {"ORCA_AGENT_SESSION_ID": "chat_1", "CLAUDE_CONFIG_DIR": home}},
            {"pid": 5, "ppid": 1, "comm": "login", "argv": [], "env": {}},
            {"pid": 6, "ppid": 1, "comm": "orca-provider-ex", "argv": [], "env": {}},
        ]
        with self.with_processes(procs):
            rows = self.mod.inventory()
        self.assertEqual([(r["pid"], r["kind"], r["handle"], r["chat"]) for r in rows], [(10, "terminal", "term_1", None), (14, "chat", None, "chat_1")])
        # 会話 id は sessions/<pid>.json が先、無ければ引数（`--resume=<id>` の形も）
        self.assertEqual([r["session"] for r in rows], [S1, S2])
        self.assertEqual(rows[0]["seat"], os.path.realpath(home))

    def test_relaunch_command_quotes_every_argument_and_replaces_the_conversation_flags(self):
        rec = {"argv": ["--plugin-dir", "/Users/x/Library/Application Support/orca/view", "--settings", '{"fastMode":false}',
                        "--resume", S2, "-c", "--fork-session", "--session-id", S2, "--resume=" + S2, "-r", S2, "--effort", "high"],
               "ws": "/cfg/settings worker.json", "session": S1}
        line = self.mod.relaunch_line(rec, "/Users/x/Library/Application Support/orca/claude-profiles/b/home")
        self.assertEqual(shlex.split(line), [
            "env", "CLAUDE_CONFIG_DIR=/Users/x/Library/Application Support/orca/claude-profiles/b/home",
            "ORCA_WORKER_SETTINGS=/cfg/settings worker.json", "claude", "--plugin-dir", "/Users/x/Library/Application Support/orca/view",
            "--settings", '{"fastMode":false}', "--effort", "high", "--resume", S1])
        # 既定の席（~/.claude）へ戻すときは、受け継いだ CLAUDE_CONFIG_DIR を外す。
        self.assertEqual(shlex.split(self.mod.relaunch_line(dict(rec, ws=None, argv=[]), None)),
                         ["env", "-u", "CLAUDE_CONFIG_DIR", "claude", "--resume", S1])

    def test_relaunch_args_drop_the_first_instruction_but_keep_option_values(self):
        args = self.mod.relaunch_args
        self.assertEqual(args(["--name", "-題-", "--model=opus", "最初の指示"]), ["--name", "-題-", "--model=opus"])
        # 続く値を全部取るもの（commander の <x...>）は、次の `-` までを値にする。claude もそう読むので、元の claude でも値だった
        self.assertEqual(args(["--add-dir", "/a", "/b", "--verbose", "指示"]), ["--add-dir", "/a", "/b", "--verbose"])
        # 値を取ってもよいもの（[x]）は次の 1 語まで
        self.assertEqual(args(["--debug", "hooks", "指示"]), ["--debug", "hooks"])
        self.assertEqual(args(["--debug", "--verbose"]), ["--debug", "--verbose"])
        # 会話を選ぶものは値ごと外す。値の無い --resume（選び直しの画面）も
        self.assertEqual(args(["--resume", "--model", "opus", "-r", S1, "--fork-session", "--continue"]), ["--model", "opus"])
        self.assertEqual(args(["--verbose", "--", "--model", "x"]), ["--verbose"])
        self.assertEqual(args(["--new-flag", "--model", "opus"]), ["--new-flag", "--model", "opus"])
        self.assertEqual(args(["--new-flag=1", "指示"]), ["--new-flag=1"])
        with self.assertRaises(ValueError):
            args(["--new-option", "x"])
        # commander は `-n題` を -n の値と読み、値が要る <x...> の最初の 1 語は `-` で始まっても値に取る
        self.assertEqual(args(["-n題", "指示"]), ["-n題"])
        self.assertEqual(args(["--add-dir", "-archive", "--verbose"]), ["--add-dir", "-archive", "--verbose"])

    def test_a_short_line_with_a_newline_is_also_started_from_a_file(self):
        # 改行の入った行を端末に打つと zsh が続き入力になる。短くてもファイルに書く。短く改行も無ければそのまま打つ
        rec = {"argv": ["--append-system-prompt", "1 行目\n2 行目"], "ws": None, "session": S1}
        with mock.patch.object(self.mod, "HOME", self.tmp):
            cmd = self.mod.relaunch_command(rec, "/h", "term_1")
            path = os.path.join(self.tmp, "relaunch", "term_1.sh")
            self.assertEqual(shlex.split(cmd), ["sh", path])
            with open(path) as fh:
                self.assertEqual(fh.read(), "exec " + self.mod.relaunch_line(rec, "/h") + "\n")
            self.assertEqual(self.mod.relaunch_command(dict(rec, argv=["--model", "opus"]), "/h", "term_2"),
                             self.mod.relaunch_line(dict(rec, argv=["--model", "opus"]), "/h"))

    def test_the_claude_argument_table_matches_claude_help(self):
        # claude を上げて引数が増えたり形が変わったりしたら、ここで気づく（表に無い引数の次に語があると、起こし直さずに名指しする）
        try:
            out = subprocess.run(["claude", "--help"], capture_output=True, text=True, timeout=60).stdout
        except (OSError, subprocess.TimeoutExpired):
            self.skipTest("claude が無い")
        m = self.mod
        for line in out.splitlines():
            got = re.match(r"^  (-[^ ].*?)(?:\s{2,}|$)", line)
            if not got:
                continue
            spec = got.group(1)
            names = re.findall(r"(?<![\w-])(--?[\w-]+)", spec.split(" <")[0].split(" [")[0])
            kind = (m.CLAUDE_MANY if "...>" in spec else m.CLAUDE_ONE if "<" in spec else m.CLAUDE_MAYBE if "[" in spec else m.CLAUDE_FLAGS)
            for n in names:
                self.assertIn(n, kind, "claude --help の %s が表と合わない" % spec)

    def test_json_settings_are_not_a_worker_settings_file(self):
        self.assertIsNone(self.mod.settings_file(["--settings", '{"fastMode":false}']))
        self.assertEqual(self.mod.settings_file(["--settings=/cfg/w.json"]), "/cfg/w.json")

    def test_a_fake_process_list_never_reaches_a_real_signal(self):
        with self.with_processes([]), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("FAILOVER_KILL", None)
            with mock.patch.object(os, "kill") as kill:
                with self.assertRaises(RuntimeError):
                    self.mod.stop(12345)
                kill.assert_not_called()

    def test_the_external_imports_screen_is_recognised(self):
        self.assertEqual(self.mod.sw.startup_screen(EXTERNAL_IMPORTS), "CLAUDE.md の外部 import の承認（External imports）")
        self.assertEqual(self.mod.sw.startup_screen(AUTO_MODE_SCREEN), "auto mode を既定にするかの確認")

    def test_the_real_process_table_can_be_read(self):
        # 本物の sysctl を読むだけ（signal は送らない）。自分のプロセスの親と引数が読める。
        if sys.platform != "darwin":
            self.skipTest("macOS の sysctl")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("FAILOVER_PROCESSES", None)
            table = self.mod.process_table()
            self.assertEqual(table[os.getpid()][0], os.getppid())
            argv, env = self.mod.proc_args(os.getpid())
            self.assertEqual(env.get("HOME"), os.environ.get("HOME"))
            self.assertTrue(any(a.endswith("account_failover_test.py") for a in argv) or argv)


if __name__ == "__main__":
    unittest.main()
