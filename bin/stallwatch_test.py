import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "stallwatch")
MIN = 60_000


def now_ms():
    return int(time.time() * 1000)


class Page(http.server.BaseHTTPRequestHandler):
    status = 200

    def do_GET(self):
        self.send_response(Page.status)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class StallwatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        Page.status = 200
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.root = os.path.join(self.tmp, "ws")
        os.makedirs(os.path.join(self.root, ".orca"))
        with open(os.path.join(self.root, ".orca", "cockpit.json"), "w") as fh:
            fh.write("{}")
        self.ps_file = os.path.join(self.tmp, "ps.json")
        self.calls = os.path.join(self.tmp, "orca-calls")
        self.notes = os.path.join(self.tmp, "notes")
        self.launchd = os.path.join(self.tmp, "launchd")
        os.makedirs(self.launchd)
        self.runtime = os.path.join(self.tmp, "runtime")
        self.set_runtime("rt1")
        self.script("orca", """#!/bin/sh
echo "$*" >> {calls}
case "$1 $2" in
  "worktree ps") if [ -f {ps} ]; then printf '{{"ok":true,"result":'; cat {ps}; printf ',"_meta":{{"runtimeId":"%s"}}}}' "$(cat {rt})"; else echo 'connect ECONNREFUSED' >&2; exit 1; fi ;;
esac
""".format(calls=self.calls, ps=self.ps_file, rt=self.runtime))
        self.script("launchctl", """#!/bin/sh
f=%s/$(basename "$2")
[ -f "$f" ] || exit 113
cat "$f"
""" % self.launchd)
        self.script("notify", "#!/bin/sh\nprintf '%%s\\t%%s\\n' \"$1\" \"$2\" >> %s\n" % self.notes)
        self.window_log = os.path.join(self.tmp, "window.log")
        open(self.window_log, "w").close()

    def set_runtime(self, rid):
        with open(self.runtime, "w") as fh:
            fh.write(rid)

    def script(self, name, body):
        path = os.path.join(self.bin, name)
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)

    def ps(self, agents, kids=()):
        rows = [{"worktreeId": "r::ws", "path": self.root, "parentWorktreeId": None, "agents": agents}]
        rows += [{"worktreeId": "r::k%d" % i, "path": os.path.join(self.tmp, "k%d" % i), "parentWorktreeId": "r::ws",
                  "agents": [a]} for i, a in enumerate(kids)]
        with open(self.ps_file, "w") as fh:
            json.dump({"worktrees": rows}, fh)

    def job(self, label, state="not running", code="0"):
        with open(os.path.join(self.launchd, label), "w") as fh:
            fh.write("gui/501/%s = {\n\tstate = %s\n\tlast exit code = %s\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n"
                     % (label, state, code))

    def run_watch(self, *args):
        env = dict(os.environ, PATH=self.bin + ":/usr/bin:/bin", STALLWATCH_HOME=os.path.join(self.tmp, "home"),
                   COCKPIT_DIR=os.path.join(self.tmp, "cockpit"), STALLWATCH_NOTIFY=os.path.join(self.bin, "notify"),
                   ORCA_CLI_COMMAND="orca")
        r = subprocess.run([sys.executable, SCRIPT, "--window", self.url, "--window-log", self.window_log] + list(args),
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def notes_lines(self):
        try:
            with open(self.notes) as fh:
                return fh.read().splitlines()
        except FileNotFoundError:
            return []

    def alerts(self):
        with open(os.path.join(self.tmp, "cockpit", "alerts.json")) as fh:
            return {a["id"]: a for a in json.load(fh)["alerts"]}

    def orca_calls(self):
        try:
            with open(self.calls) as fh:
                return fh.read().splitlines()
        except FileNotFoundError:
            return []

    def main_agent(self, **over):
        a = {"paneKey": "structured-agent-session-s1:x", "state": "done", "stateStartedAt": now_ms() - 60 * MIN,
             "updatedAt": now_ms() - 60 * MIN, "orcaSessionId": "s1", "mainAgent": {"outcome": "success"}}
        a.update(over)
        return a

    def test_quiet_when_nothing_is_stopped(self):
        self.ps([self.main_agent()], kids=[{"paneKey": "w", "state": "working", "stateStartedAt": now_ms() - 5 * MIN}])
        self.run_watch()
        self.assertEqual(self.notes_lines(), [])
        self.assertEqual(self.alerts(), {})

    def test_worker_stopped_and_main_idle_notifies_once_without_mailing_main(self):
        self.ps([self.main_agent()],
                kids=[{"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN, "conversationName": "W1"}])
        self.run_watch()
        self.run_watch()
        notes = self.notes_lines()
        self.assertEqual(len(notes), 1, "同じものは 1 回だけ知らせる")
        self.assertIn("W1", notes[0])
        (a,) = self.alerts().values()
        self.assertEqual(a["root"], self.root)
        self.assertFalse([c for c in self.orca_calls() if c.startswith("orchestration")], "会話の中へは送らない（起こすのは Orca）")

    def test_failed_notification_is_retried(self):
        self.ps([self.main_agent()],
                kids=[{"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN}])
        self.script("notify", "#!/bin/sh\nexit 1\n")
        self.run_watch()
        self.script("notify", "#!/bin/sh\nprintf '%%s\\t%%s\\n' \"$1\" \"$2\" >> %s\n" % self.notes)
        self.run_watch()
        self.run_watch()
        self.assertEqual(len(self.notes_lines()), 1, "出せなかった通知を 1 回だけ出し直す")

    def test_main_stopped_mid_work_by_an_orca_restart(self):
        self.ps([self.main_agent(state="working", updatedAt=now_ms())])
        self.run_watch()
        restart = now_ms()
        self.set_runtime("rt2")
        self.ps([self.main_agent(stateStartedAt=restart)])
        self.run_watch()
        self.run_watch()
        (a,) = self.alerts().values()
        self.assertIn("Orca の再起動", a["text"])
        self.assertEqual(len(self.notes_lines()), 1)
        self.assertNotIn("orchestration send", " ".join(self.orca_calls()), "終えたのか止まったのか分からないので起こさない")
        os.remove(self.ps_file)
        self.run_watch()
        self.ps([self.main_agent(stateStartedAt=restart)])
        self.run_watch()
        self.assertEqual(len(self.notes_lines()), 1, "Orca に繋がらない回を挟んでも知らせ直さない")
        self.ps([self.main_agent(stateStartedAt=restart + 1000)])
        self.run_watch()
        self.assertEqual(self.alerts(), {}, "メインが動いたら消える")

    def test_idle_main_across_an_orca_restart_is_quiet(self):
        self.ps([self.main_agent()])
        self.run_watch()
        self.set_runtime("rt2")
        self.ps([self.main_agent(stateStartedAt=now_ms())])
        self.run_watch()
        self.assertEqual(self.alerts(), {})

    def test_worker_handled_by_main_is_not_reported(self):
        self.ps([self.main_agent(stateStartedAt=now_ms() - 5 * MIN)],
                kids=[{"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN}])
        self.run_watch()
        self.assertEqual(self.alerts(), {})

    def test_main_terminal_exited(self):
        self.ps([self.main_agent(paneKey="t:m", hasLivePty=False, orcaSessionId=None)])
        self.run_watch()
        self.assertIn("端末が終わった", self.notes_lines()[0])
        self.assertNotIn("orchestration send", " ".join(self.orca_calls()), "止まったメインは起こさない")

    def test_main_silent_while_working_needs_two_runs(self):
        self.ps([self.main_agent(state="working", updatedAt=now_ms() - 50 * MIN)])
        self.run_watch()
        self.assertEqual(self.notes_lines(), [], "1 回目は待つ")
        self.run_watch()
        self.assertIn("50 分動きが無い", self.notes_lines()[0])

    def test_orca_down(self):
        self.run_watch()
        self.assertEqual(self.alerts(), {})
        self.run_watch()
        self.run_watch()
        notes = self.notes_lines()
        self.assertEqual(len(notes), 1)
        self.assertIn("Orca に繋がらない", notes[0])
        self.assertIn("orca-down", self.alerts())

    def test_window_500_and_log_errors(self):
        self.ps([self.main_agent()])
        with open(self.window_log, "a") as fh:
            fh.write("Error: 入れる前に済んだ昔のエラー\n" * 5)
        self.run_watch()
        self.assertEqual(self.alerts(), {}, "入れる前のログは知らせない")
        Page.status = 500
        self.run_watch()
        with open(self.window_log, "a") as fh:
            fh.write("Error: ENOENT: no such file or directory, open '/old/page.ts'\n" * 3)
        self.run_watch()
        al = self.alerts()
        self.assertIn("500", al["window-http"]["text"])
        self.assertIn("ENOENT", al["window-log"]["text"])
        Page.status = 200
        self.run_watch()
        al = self.alerts()
        self.assertNotIn("window-http", al, "応答が戻ったら消える")
        self.assertIn("window-log", al, "エラーが途切れた 1 回では直ったと見なさない")
        with open(self.window_log, "a") as fh:
            fh.write("Error: ENOENT again\n" * 3)
        self.run_watch()
        self.assertEqual(len(self.notes_lines()), 1, "同じ障害を知らせ直さない")

    def test_jobs(self):
        self.ps([self.main_agent()])
        log = os.path.join(self.tmp, "harvest.log")
        with open(log, "w") as fh:
            fh.write("2026-11-21 06:00:09 2026-11-20: Failed to authenticate: this login reached its time limit\n")
        self.job("org.nixos.harvest", code="0")
        self.job("org.nixos.digest", code="1")
        self.job("org.nixos.window", state="not running", code="(never exited)")
        self.job("org.nixos.never", code="(never exited)")
        args = ["--job", "org.nixos.harvest=" + log, "--job", "org.nixos.digest", "--job", "org.nixos.never",
                "--job", "org.nixos.missing", "--service", "org.nixos.window"]
        self.run_watch(*args)
        al = self.alerts()
        self.assertIn("Failed to authenticate", al["job:org.nixos.harvest"]["text"], "終わりのコードが 0 でもログで拾う")
        self.assertIn("コード 1", al["job:org.nixos.digest"]["text"])
        self.assertIn("登録されていない", al["job:org.nixos.missing"]["text"])
        self.assertIn("動いていない", al["job:org.nixos.window"]["text"])
        self.assertNotIn("job:org.nixos.never", al)
        self.run_watch(*args)
        self.assertEqual(len(self.notes_lines()), 1, "まとめて 1 回、2 回目は出さない")
        with open(log, "a") as fh:
            fh.write("done\n")
        self.run_watch(*args)
        with open(log, "a") as fh:
            fh.write("error: again\n")
        self.run_watch(*args)
        self.assertEqual(len(self.notes_lines()), 2)
        self.assertIn("again", self.notes_lines()[1])


if __name__ == "__main__":
    unittest.main()
