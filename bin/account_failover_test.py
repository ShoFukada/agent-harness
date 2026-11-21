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
    save("terminals.json", terms)
    ok(acc["claude"])
elif cmd == "terminal list":
    ok({"terminals": load("terminals.json")})
elif cmd == "agent list":
    ok({"agents": load("agents.json")} if not os.path.exists(os.path.join(d, "agents-renamed")) else {"sessions": []})
elif cmd == "terminal wait":
    ok({"wait": {"satisfied": True, "status": "tui-idle"}})
elif cmd == "terminal send":
    ok({"accepted": True})
else:
    print(json.dumps({"ok": False, "error": {"message": "unknown"}}))
'''


def now_ms():
    return int(time.time() * 1000)


def usage(session=0, weekly=0, session_reset=None, weekly_reset=None, status="ok", updated=None, reading=None):
    rl = {"status": status, "updatedAt": updated if updated is not None else now_ms() - MIN,
          "session": {"usedPercent": session, "resetsAt": session_reset if session_reset is not None else now_ms() + 2 * HOUR},
          "weekly": {"usedPercent": weekly, "resetsAt": weekly_reset if weekly_reset is not None else now_ms() + 48 * HOUR},
          "fableWeekly": {"usedPercent": 100, "resetsAt": now_ms() + HOUR}}
    if reading:
        rl["usageMetadata"] = {"readingAccount": {"accountId": reading}}
    return rl


def terminal(handle, preview="❯", tab=None):
    return {"handle": handle, "ptyId": "pty-" + handle, "tabId": tab or "tab-" + handle, "leafId": "leaf-" + handle,
            "connected": True, "title": "題 " + handle, "worktreePath": "/w/" + handle, "preview": preview,
            "lastOutputAt": now_ms() - MIN}


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
        self.accounts(A, {A: usage(weekly=100), B: usage(session=100), C: usage(status="error")})
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
