import importlib.machinery
import importlib.util
import json
import os
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
elif cmd == "orchestration worker-list":
    ok({"workers": load("workers.json", [])})
elif cmd == "orchestration worker-show":
    ok(load("shows.json", {}).get(val("--dispatch"), {}))
elif cmd == "orchestration send" and flag("send-fails"):
    fail()
elif cmd == "orchestration send":
    ok({"messageId": "msg_1"})
elif cmd == "terminal send":
    h, text = val("--terminal"), val("--text")
    procs = load("processes.json", [])
    if text == "/exit":
        if not flag("exit-hangs"):
            save("processes.json", [p for p in procs if p["env"].get("ORCA_TERMINAL_HANDLE") != h])
        if flag("exit-reply-lost"):  # 届いたが、応答だけが時間切れになった
            fail("timeout")
            sys.exit(0)
    elif text.startswith("env "):
        if flag("launch-fails"):
            fail()
            sys.exit(0)
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


class ConvergeTest(FailoverTestBase):
    """古い席の claude を今の席へ移す処理（R205）。"""

    def old_terminal(self, handle="term_1", pid=101, preview="❯", state="done", argv=None, session=S1, **kw):
        self.put("terminals.json", [terminal(handle, preview)])
        self.put("agents.json", [pane_agent(handle, state)])
        self.proc(pid, seat=A, handle=handle, session=session,
                  argv=argv if argv is not None else ["--model", "opus", "--settings", self.settings, "--resume", S1], **kw)

    def launched(self, handle="term_1"):
        return [t for t in self.typed(handle) if t.startswith("env ")]

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
        self.put("shows.json", {"ctx_l": {"dispatch": {"id": "ctx_l", "runId": "run_9"}}})

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
        line = self.mod.relaunch_command(rec, "/Users/x/Library/Application Support/orca/claude-profiles/b/home")
        self.assertEqual(shlex.split(line), [
            "env", "CLAUDE_CONFIG_DIR=/Users/x/Library/Application Support/orca/claude-profiles/b/home",
            "ORCA_WORKER_SETTINGS=/cfg/settings worker.json", "claude", "--plugin-dir", "/Users/x/Library/Application Support/orca/view",
            "--settings", '{"fastMode":false}', "--effort", "high", "--resume", S1])
        # 既定の席（~/.claude）へ戻すときは、受け継いだ CLAUDE_CONFIG_DIR を外す。
        self.assertEqual(shlex.split(self.mod.relaunch_command(dict(rec, ws=None, argv=[]), None)),
                         ["env", "-u", "CLAUDE_CONFIG_DIR", "claude", "--resume", S1])

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
