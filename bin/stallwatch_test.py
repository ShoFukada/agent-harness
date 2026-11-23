import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "stallwatch")
MIN = 60_000
HOUR = 60 * MIN
TOKYO = ZoneInfo("Asia/Tokyo")


def now_ms():
    return int(time.time() * 1000)


def resets(ms, date=False):
    """Claude Code の上限の 1 行の「resets」の後ろ（「4:40pm」「4pm」「Nov 22 at 9am」）。"""
    t = datetime.fromtimestamp(ms / 1000, TOKYO)
    hm = "%d%s%s" % (t.hour % 12 or 12, ":%02d" % t.minute if t.minute else "", "pm" if t.hour >= 12 else "am")
    return "%s %d at %s" % (t.strftime("%b"), t.day, hm) if date else hm


def shown(ms):
    """窓に出る時刻。今日なら 16:40、別の日なら 11/22 09:00。"""
    t = time.localtime(ms / 1000)
    today = time.strftime("%Y%m%d", t) == time.strftime("%Y%m%d")
    return time.strftime("%H:%M" if today else "%-m/%-d %H:%M", t)


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
        self.mail_log = os.path.join(self.tmp, "mails")
        self.mail_script()
        self.window_log = os.path.join(self.tmp, "window.log")
        open(self.window_log, "w").close()

    def mail_script(self):
        """偽の cockpit-mail。引数と標準入力の本文を 1 行の JSON で控える。"""
        self.script("cockpit-mail", "#!/usr/bin/env python3\nimport json, sys\nopen(%r, 'a').write(json.dumps({'args': sys.argv[1:], 'body': sys.stdin.read()}) + '\\n')\n" % self.mail_log)

    def mails(self):
        try:
            with open(self.mail_log) as fh:
                return [json.loads(l) for l in fh]
        except FileNotFoundError:
            return []

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
                   ORCA_CLI_COMMAND="orca", HOME=self.tmp, COCKPIT_MAIL=os.path.join(self.bin, "cockpit-mail"))
        env.pop("CLAUDE_CONFIG_DIR", None)
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

    def failed_main(self, at, said="Orca が再起動したので、状態を確かめ直しました。途中で止まった作業はありません。"):
        """2026-11-21 に上限で止まった、ある案件のメインの形。Orca は outcome: failure を付けるが、
        lastAssistantMessage には上限の 1 行が入らず、その前の普通の報告が残る。"""
        return self.main_agent(stateStartedAt=at, updatedAt=at + 47, mainAgent={"state": "done", "outcome": "failure", "stateStartedAt": at},
                               lastAssistantMessage=said)

    def transcript(self, at, text, error, home=".claude", name="61503ca7-72ff-4db3-9b0b-2811d8cccb17", offset=-9):
        """メインの会話記録（~/.claude/projects/<root の記号を - にしたもの>/<会話>.jsonl）の末尾を、実物の行の並びで書く。
        上限やログイン切れは、Claude Code が model <synthetic>・isApiErrorMessage の応答として書く。offset は Orca の記録との時刻の差。"""
        d = os.path.join(self.tmp, home, "projects", re.sub(r"[^A-Za-z0-9]", "-", self.root))
        os.makedirs(d, exist_ok=True)

        def reply(ms, body, err=None):
            e = {"type": "assistant", "sessionId": "61503ca7", "message": {
                "model": "<synthetic>" if err else "claude-opus-5-5", "role": "assistant", "content": [{"type": "text", "text": body}]},
                "timestamp": datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000)}
            if err:
                e.update(isApiErrorMessage=True, error=err)
            return e

        lines = [reply(at - 20 * MIN, "途中の報告"), {"type": "attachment", "sessionId": "61503ca7"},
                 {"type": "api-request", "sessionId": "61503ca7"}, reply(at + offset, text, error),
                 {"type": "last-prompt", "sessionId": "61503ca7"}, {"type": "cost-state", "sessionId": "61503ca7"}]
        with open(os.path.join(d, name + ".jsonl"), "w") as fh:
            fh.write('{"type":"api-request-blob","truncated":"' + "x" * 300_000 + '\n')
            fh.writelines(json.dumps(l, ensure_ascii=False) + "\n" for l in lines)

    def test_main_stopped_on_the_5_hour_limit_until_it_resets(self):
        at = now_ms() - 30 * MIN
        reset = (at + 3 * HOUR) // MIN * MIN
        # 同じ root の別の会話が、少し後に普通の応答を書いていても、時刻の近いメインの記録を採る。
        self.transcript(at, "別の会話の報告", None, name="82ca1a84-0a17-49f3-9bf1-4715c47173e2", offset=30_000)
        self.ps([self.failed_main(at, said="`/login` の手順を確かめました。")])
        self.transcript(at, "You've hit your 5-hour limit · resets %s (Asia/Tokyo)" % resets(reset), "rate_limit")
        self.run_watch()
        (a,) = self.alerts().values()
        self.assertIn("利用枠の上限で止まった（%s に戻る）" % shown(reset), a["text"], "前の短い報告より会話記録の最後を先に見る")
        at = now_ms() - 4 * HOUR
        reset = (at + HOUR) // MIN * MIN
        self.ps([self.failed_main(at)])
        self.transcript(at, "You've hit your 5-hour limit · resets %s (Asia/Tokyo)" % resets(reset), "rate_limit")
        self.run_watch()
        (a,) = self.alerts().values()
        self.assertIn("上限で止まったまま（枠は %s に戻った。新しい入力を待っている）" % shown(reset), a["text"],
                      "枠が戻っても、途切れた作業は入力するまで再開しないので弱めて残す")
        self.assertEqual(len(self.notes_lines()), 1, "弱めた表示に変わっても知らせ直さない")

    def test_main_failure_takes_its_cause_from_the_transcript(self):
        at = now_ms() - 30 * MIN
        self.ps([self.failed_main(at)])
        self.run_watch()
        self.assertIn("メインがエラーで止まった", self.alerts()["main-dead:" + self.root]["text"], "会話記録が無ければ前と同じ")
        reset = (at + 30 * HOUR) // HOUR * HOUR
        cases = [
            ("Login reached its time limit · Please run /login", "authentication_failed", "ログインが切れて止まった"),
            ("You've hit your weekly limit · resets %s (Asia/Tokyo)" % resets(reset, date=True), "rate_limit",
             "上限で止まった（%s に戻る）" % shown(reset)),
            ("You've hit your session limit · resets 4pm (Invalid/Zone)", "rate_limit", "利用枠の上限で止まった（"),
            ("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", "rate_limit",
             "利用枠の上限で止まった"),
            ("API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.", "server_error",
             "API のエラーで止まった（API Error: 529 Overloaded."),
        ]
        for text, error, want in cases:
            # Orca のプロファイルの CLAUDE_CONFIG_DIR に置かれた会話記録も読む。
            self.transcript(at, text, error, home="Library/Application Support/orca/claude-profiles/p1/home")
            self.run_watch()
            self.assertIn(want, self.alerts()["main-dead:" + self.root]["text"], text)
        self.ps([self.failed_main(at + 30 * MIN)])
        self.run_watch()
        self.assertIn("メインがエラーで止まった", self.alerts()["main-dead:" + self.root]["text"],
                      "最後の応答の時刻が Orca の記録と合わない会話記録は別の会話なので見ない")

    def test_worker_put_back_with_the_main_by_an_orca_restart_is_quiet(self):
        # 2026-11-21 14:57:04 の再起動で、ある案件のメインと worker の stateStartedAt が 5ms 差で付け直された形。
        back = now_ms() - 195 * MIN
        main = self.main_agent(paneKey="91bc831e:aad12dd0", stateStartedAt=back, updatedAt=back + 3327, hasLivePty=True,
                               mainAgent={"state": "done", "stateStartedAt": back + 3327}, lastAssistantMessage=None)
        worker = {"paneKey": "74647b77:11668409", "state": "done", "stateStartedAt": back + 5, "updatedAt": back + 2595,
                  "conversationName": "W29 文面集の修正", "hasLivePty": True, "mainAgent": {"state": "done", "stateStartedAt": back + 2595}}
        self.ps([main], kids=[worker])
        self.run_watch()
        self.assertEqual(self.alerts(), {})
        self.ps([main], kids=[dict(worker, stateStartedAt=back + 60 * MIN)])
        self.run_watch()
        (a,) = self.alerts().values()
        self.assertIn("W29 文面集の修正", a["text"], "再起動のあとに worker だけが止まったら知らせる")

    def test_quiet_when_nothing_is_stopped(self):
        self.ps([self.main_agent()], kids=[{"paneKey": "w", "state": "working", "stateStartedAt": now_ms() - 5 * MIN}])
        self.run_watch()
        self.assertEqual(self.notes_lines(), [])
        self.assertEqual(self.alerts(), {})

    def test_worker_stopped_and_main_idle_notifies_and_mails_main_once(self):
        self.ps([self.main_agent()],
                kids=[{"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN, "conversationName": "W1"}])
        self.run_watch()
        self.run_watch()
        notes = self.notes_lines()
        self.assertEqual(len(notes), 1, "同じものは 1 回だけ知らせる")
        self.assertIn("W1", notes[0])
        (a,) = self.alerts().values()
        self.assertEqual(a["root"], self.root)
        # 窓口の判断が要るので、cockpit-mail で窓口の Run にも 1 回だけ送る（R191）。orca に直に送らない。
        mails = self.mails()
        self.assertEqual(len(mails), 1, mails)
        self.assertEqual(mails[0]["args"], [self.root, "--subject", "【見張り】窓口の判断が要るものがあります", "--body-file", "-"])
        self.assertIn("W1", mails[0]["body"])
        self.assertFalse([c for c in self.orca_calls() if c.startswith("orchestration")])

    def test_question_and_card_consult_tabs_are_not_stopped_workers(self):
        # 窓からの質問・カードの相談のタブは窓口の worktree に残り、答えたら done で止まる。止まった worker として知らせない
        idle = now_ms() - 20 * MIN
        self.ps([self.main_agent(),
                 {"paneKey": "q", "state": "done", "stateStartedAt": idle, "conversationName": "質問｜社内 ハーネス｜ask4"},
                 {"paneKey": "c", "state": "done", "stateStartedAt": idle, "conversationName": "カード相談｜社内 ハーネス｜d21"}])
        self.run_watch()
        self.assertEqual(self.alerts(), {})
        self.assertEqual(self.mails(), [])

    def test_mailed_survives_an_orca_outage(self):
        kid = {"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN}
        self.ps([self.main_agent()], kids=[kid])
        self.run_watch()
        os.remove(self.ps_file)  # Orca に繋がらない回
        self.run_watch()
        self.ps([self.main_agent()], kids=[kid])
        self.run_watch()
        self.assertEqual(len(self.mails()), 1, "Orca に繋がらなかった回のあとに、同じ停止を送り直さない")

    def test_main_itself_stopped_is_not_mailed(self):
        self.ps([self.main_agent(hasLivePty=False, mainAgent={"outcome": "failure"})])
        self.run_watch()
        self.assertTrue([k for k in self.alerts() if k.startswith("main-dead:")], self.alerts())
        self.assertEqual(self.mails(), [], "窓口自身が止まった知らせは、窓口に送っても読まれない")

    def test_failed_mail_is_retried_once_delivered(self):
        self.ps([self.main_agent()],
                kids=[{"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN}])
        self.script("cockpit-mail", "#!/bin/sh\nexit 1\n")
        self.run_watch()
        self.mail_script()
        self.run_watch()
        self.run_watch()
        self.assertEqual(len(self.mails()), 1, "送れなかった回のあとに 1 回だけ送り直す")

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
        self.ps([self.main_agent(stateStartedAt=now_ms())])
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
