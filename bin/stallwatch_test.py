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
        self.dispatches = os.path.join(self.tmp, "dispatches")
        os.makedirs(self.dispatches)
        self.set_runtime("rt1")
        self.script("orca", """#!/bin/sh
echo "$*" >> {calls}
case "$1 $2" in
  "worktree ps") if [ -f {ps} ]; then printf '{{"ok":true,"result":'; cat {ps}; printf ',"_meta":{{"runtimeId":"%s"}}}}' "$(cat {rt})"; else echo 'connect ECONNREFUSED' >&2; exit 1; fi ;;
  "orchestration dispatch-show") if [ -f {d}/down ]; then echo 'connect ECONNREFUSED' >&2; exit 1; elif [ -f {d}/$4 ]; then printf '{{"ok":true,"result":{{"dispatch":'; cat {d}/$4; printf '}}}}'; else echo '{{"ok":false,"error":{{"code":"not_found"}}}}'; fi ;;
esac
""".format(calls=self.calls, ps=self.ps_file, rt=self.runtime, d=self.dispatches))
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

    def ledger(self, panes=(), **cockpit):
        """帳簿（cockpit.json）に、panes の worker を結んだ済んでいないタスクを 1 つずつ書く。Orca の dispatch-show は Task の Dispatch の
        assignee_pane_key（worker の端末かチャットの paneKey）と、立てた会話（creator_orca_session_id。既定は窓口の s1）を返す。
        panes の要素は paneKey か (paneKey, 立てた会話)。"""
        tasks = []
        for i, pane in enumerate(panes):
            pane, creator = (pane, "s1") if isinstance(pane, str) else pane
            tasks.append({"id": "t%d" % i, "title": "タスク %d" % i, "state": "open", "worker": {"run_id": "run_1", "task_id": "task_%d" % i}})
            self.dispatch("task_%d" % i, assignee_pane_key=pane, creator_orca_session_id=creator)
        with open(os.path.join(self.root, ".orca", "cockpit.json"), "w") as fh:
            json.dump(dict({"tasks": tasks}, **cockpit), fh)

    def dispatch(self, task, **d):
        with open(os.path.join(self.dispatches, task), "w") as fh:
            json.dump(d, fh)

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

    def transcript(self, at, text, error, home=".claude", name="61503ca7-72ff-4db3-9b0b-2811d8cccb17", offset=-9, main=True):
        """会話記録（~/.claude/projects/<root の記号を - にしたもの>/<会話>.jsonl）の末尾を、実物の行の並びで書く。
        上限やログイン切れは、Claude Code が model <synthetic>・isApiErrorMessage の応答として書く。offset は Orca の記録との時刻の差。
        main なら、hook と同じく帳簿の横の main-session.json に窓口の会話として書く。"""
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
        if main:
            os.makedirs(os.path.join(self.root, ".orca", "cockpit"), exist_ok=True)
            with open(os.path.join(self.root, ".orca", "cockpit", "main-session.json"), "w") as fh:
                json.dump({"run_id": "run_main", "session_id": name, "transcript_path": os.path.join(d, name + ".jsonl")}, fh)

    def test_main_stopped_on_the_5_hour_limit_until_it_resets(self):
        at = now_ms() - 30 * MIN
        reset = (at + 3 * HOUR) // MIN * MIN
        # 同じ root の別の会話が普通の応答を書いていても、窓口の会話（main-session.json）を読む。
        self.transcript(at, "別の会話の報告", None, name="82ca1a84-0a17-49f3-9bf1-4715c47173e2", offset=-5, main=False)
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
        soon = (at + 3 * HOUR) // MIN * MIN
        cases = [
            ("Login reached its time limit · Please run /login", "authentication_failed", "ログインが切れて止まった"),
            ("You've hit your weekly limit · resets %s (Asia/Tokyo)" % resets(reset, date=True), "rate_limit",
             "上限で止まった（%s に戻る）" % shown(reset)),
            # 読めないタイムゾーンは手元の時刻で読む。戻る時刻は固定にせず at から決める（16:00〜16:30 に走らせると「4pm」は戻ったあとになった）。
            ("You've hit your session limit · resets %s (Invalid/Zone)" % resets(soon), "rate_limit", "利用枠の上限で止まった（%s に戻る）" % shown(soon)),
            ("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", "rate_limit",
             "利用枠の上限で止まった"),
            ("API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.", "server_error",
             "API のエラーで止まった（API Error: 529 Overloaded."),
        ]
        for text, error, want in cases:
            # Orca のプロファイルの CLAUDE_CONFIG_DIR に置かれた会話記録も、main-session.json の場所で読む。
            self.transcript(at, text, error, home="Library/Application Support/orca/claude-profiles/p1/home")
            self.run_watch()
            self.assertIn(want, self.alerts()["main-dead:" + self.root]["text"], text)
        self.ps([self.failed_main(at + 30 * MIN)])
        self.run_watch()
        self.assertIn("メインがエラーで止まった", self.alerts()["main-dead:" + self.root]["text"],
                      "最後の応答の時刻が Orca の記録と合わない会話記録は別のターンなので見ない")

    # 2026-11-28 13:44 に「medurance-management」のメインが上限で止まったと誤って知らせた形。窓口は定時ジョブの失敗を報告していて、
    # 報告の 220 字目までに上限の 1 行を引用していた。Orca の要約（lastAssistantMessage）は 200 字で切れ、outcome は success。
    HARVEST_REPORT = ("受け取った依頼：\n- 失敗していた定時ジョブ knowledge-harvest（毎朝 6:00 に Claude で知識を集めるジョブ）をやり直す\n\n"
                      "11/28 13:40 にいつもと同じ経路でやり直しましたが、同じ理由でまた失敗しました。Claude の週の利用枠を使い切っていて、"
                      "ログには「You've hit your weekly limit · resets Nov 30 at 4am (Asia/Tokyo)」と出ています。11/26 分と 11/27 分の失敗も、"
                      "原因はこの上限でした。\n\n- **11/30 に確かめること**：枠は 11/30 の 4:00 に戻ります。" + "。" * 300)

    def test_a_report_quoting_the_limit_is_not_a_stop(self):
        at = now_ms() - 4 * MIN
        self.transcript(at, self.HARVEST_REPORT, None, offset=-20)
        self.ps([self.main_agent(stateStartedAt=at, updatedAt=at, lastAssistantMessage=self.HARVEST_REPORT[:200])])
        self.run_watch()
        self.assertEqual(self.alerts(), {}, "Orca が失敗と言っていないターンを、要約の中の引用で止まったと言わない")
        self.assertEqual(self.notes_lines(), [])
        # Orca が失敗を付けても、最後の応答が API のエラーでなければ、引用を理由にしない。
        self.ps([self.failed_main(at, said=self.HARVEST_REPORT[:200])])
        self.run_watch()
        self.assertEqual(self.alerts()["main-dead:" + self.root]["text"], "「ws」のメインがエラーで止まった")

    def test_the_transcript_is_the_main_conversation_not_the_nearest_one(self):
        at = now_ms() - 30 * MIN
        # 同じ root の別のチャット（質問のタブなど）が、Orca の時刻に近い上限の応答で終わっていても、窓口の会話ではないので読まない。
        self.transcript(at, "You've hit your 5-hour limit · resets 4pm (Asia/Tokyo)", "rate_limit",
                        name="82ca1a84-0a17-49f3-9bf1-4715c47173e2", offset=-1, main=False)
        self.transcript(at, "API Error: 529 Overloaded.", "server_error", offset=-40)
        self.ps([self.failed_main(at)])
        self.run_watch()
        self.assertIn("API のエラーで止まった（API Error: 529 Overloaded.）", self.alerts()["main-dead:" + self.root]["text"])
        os.remove(os.path.join(self.root, ".orca", "cockpit", "main-session.json"))
        self.run_watch()
        self.assertEqual(self.alerts()["main-dead:" + self.root]["text"], "「ws」のメインがエラーで止まった",
                         "窓口の会話が分からなければ、同じ root の会話を時刻で当てない")

    def test_worker_put_back_with_the_main_by_an_orca_restart_is_quiet(self):
        # 2026-11-21 14:57:04 の再起動で、ある案件のメインと worker の stateStartedAt が 5ms 差で付け直された形。
        back = now_ms() - 195 * MIN
        main = self.main_agent(paneKey="91bc831e:aad12dd0", stateStartedAt=back, updatedAt=back + 3327, hasLivePty=True,
                               mainAgent={"state": "done", "stateStartedAt": back + 3327}, lastAssistantMessage=None)
        worker = {"paneKey": "74647b77:11668409", "state": "done", "stateStartedAt": back + 5, "updatedAt": back + 2595,
                  "conversationName": "W29 文面集の修正", "hasLivePty": True, "mainAgent": {"state": "done", "stateStartedAt": back + 2595}}
        self.ledger(["74647b77:11668409"])
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

    def test_worker_of_a_ledger_task_stopped_and_main_idle_notifies_once_without_mailing(self):
        self.ledger(["w"])
        self.ps([self.main_agent()],
                kids=[{"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN, "conversationName": "W1"}])
        self.run_watch()
        self.run_watch()
        notes = self.notes_lines()
        self.assertEqual(len(notes), 1, "同じものは 1 回だけ知らせる")
        self.assertIn("「ws」の worker「W1」（タスク t0）が止まったあと", notes[0])
        (a,) = self.alerts().values()
        self.assertEqual(a["root"], self.root)
        # 窓口を起こすのは Orca の orchestration（worker_done・escalation）。見張りは窓口の Run に送らない。
        self.assertEqual(self.mails(), [])
        self.assertFalse([c for c in self.orca_calls() if c.startswith("orchestration send")])

    def test_only_workers_of_open_ledger_tasks_are_reported(self):
        # 2026-11-26〜27 に繰り返し知らせたもの: 入れ替え済みで帳簿に結ばれていない agy のチャット、深田さんの返事を待つ一緒に作る担当。
        idle = now_ms() - 20 * MIN
        self.ledger(["done-task"], owners=[{"id": "o1", "session": "s-owner", "state": "open"}])
        with open(os.path.join(self.root, ".orca", "cockpit.json")) as fh:
            c = json.load(fh)
        c["tasks"][0]["state"] = "ok"
        with open(os.path.join(self.root, ".orca", "cockpit.json"), "w") as fh:
            json.dump(c, fh)
        self.ps([self.main_agent()], kids=[
            {"paneKey": "agy-old", "agentType": "agy", "state": "done", "stateStartedAt": idle, "conversationName": "このフォルダの HANDOFF.md を読み、11/26…"},
            {"paneKey": "structured-agent-session-s-owner:x", "orcaSessionId": "s-owner", "state": "done", "stateStartedAt": idle,
             "conversationName": "一緒に｜11/27 定例資料"},
            {"paneKey": "done-task", "state": "done", "stateStartedAt": idle, "conversationName": "済んだタスクの worker"},
            # 2026-11-28 15:29: 自分の worker の報告を待ってターンを終えた担当（帳簿の owners に session の無い行で、タスクの worker ではない）。
            {"paneKey": "structured-agent-session-031962c5:y", "orcaSessionId": "031962c5", "state": "done", "stateStartedAt": idle,
             "conversationName": "届かない・止まるの穴埋め（担当）"},
            # 窓からの質問・カードの相談のタブは窓口の worktree に残り、答えたら done で止まる（cockpit skill の consult.md）。
            {"paneKey": "q", "state": "done", "stateStartedAt": idle, "conversationName": "質問｜社内 ハーネス｜ask4"},
            {"paneKey": "c", "state": "done", "stateStartedAt": idle, "conversationName": "カード相談｜社内 ハーネス｜d21"}])
        self.run_watch()
        self.assertEqual(self.alerts(), {})
        self.assertEqual(self.notes_lines(), [])

    def test_a_restamped_worker_without_a_new_turn_is_not_reported_again(self):
        # Orca が同じ worker の stateStartedAt だけを付け直しても、新しいターンが無ければ、最初に見た止まった時刻のまま扱う。
        self.ledger(["w"])
        kid = {"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN, "conversationName": "W1",
               "prompt": "brief を読んで作業する", "lastAssistantMessage": "済みました"}
        self.ps([self.main_agent()], kids=[kid])
        self.run_watch()
        self.assertEqual(len(self.notes_lines()), 1)
        # 知らせたまま窓口が動かないうちに、今の時刻へ付け直された（10 分未満になっても消えず、10 分後に知らせ直さない）。
        for stamp in (now_ms() - 1 * MIN, now_ms() - 11 * MIN):
            self.ps([self.main_agent()], kids=[dict(kid, stateStartedAt=stamp)])
            self.assertEqual(self.run_watch(), "", "出たまま")
            self.assertEqual(len(self.alerts()), 1)
        self.assertEqual(len(self.notes_lines()), 1)
        # 窓口が動いて消えたあとに付け直されても、同じターンは出し直さない。
        moved = self.main_agent(stateStartedAt=now_ms() - 15 * MIN)
        self.ps([moved], kids=[kid])
        self.run_watch()
        self.assertEqual(self.alerts(), {}, "窓口が動いたら消える")
        for stamp in (now_ms() - 12 * MIN, now_ms() - 1 * MIN):
            self.ps([moved], kids=[dict(kid, stateStartedAt=stamp)])
            self.run_watch()
            self.assertEqual(self.alerts(), {})
        # 新しいターン（最後の発言が変わった）は知らせる。
        self.ps([moved], kids=[dict(kid, stateStartedAt=now_ms() - 11 * MIN, lastAssistantMessage="次の報告")])
        self.run_watch()
        self.assertEqual(len(self.notes_lines()), 2)
        self.assertEqual(self.mails(), [])

    def test_a_failed_lookup_does_not_clear_and_renotify(self):
        # 出ている知らせの worker を Orca に問い合わせた回だけ失敗しても、前の回の答えで出し続け、次の回に知らせ直さない。
        self.ledger(["w"])
        self.ps([self.main_agent()], kids=[{"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN, "conversationName": "W1"}])
        self.run_watch()
        open(os.path.join(self.dispatches, "down"), "w").close()
        self.assertEqual(self.run_watch(), "")
        os.remove(os.path.join(self.dispatches, "down"))
        self.assertEqual(self.run_watch(), "")
        self.assertEqual(len(self.notes_lines()), 1)

    def test_workers_are_found_by_the_ledger_not_by_the_worktree_parent(self):
        idle = now_ms() - 20 * MIN
        # 担当の worktree の下に窓口が立てた worker（窓口の孫）も知らせる。担当が立てた worker は担当が受けるので知らせない。
        # 帳簿のタスクの worker が担当のチャットそのもの（2026-11-28 の fitf の t2「一緒に｜GE の案件管理」）も知らせない。
        self.ledger(["by-main", ("by-lead", "s-lead"), "structured-agent-session-s-lead:z"],
                    owners=[{"id": "o1", "session": "s-lead", "state": "open"}])
        self.ps([self.main_agent()], kids=[{"paneKey": "structured-agent-session-s-lead:z", "orcaSessionId": "s-lead", "state": "done",
                                            "stateStartedAt": idle, "conversationName": "一緒に｜GE の案件管理"}])
        with open(self.ps_file) as fh:
            rows = json.load(fh)["worktrees"]
        rows += [{"worktreeId": "r::g%d" % i, "path": os.path.join(self.tmp, "g%d" % i), "parentWorktreeId": "r::k0",
                  "agents": [{"paneKey": p, "state": "done", "stateStartedAt": idle, "conversationName": p}]} for i, p in enumerate(("by-main", "by-lead"))]
        with open(self.ps_file, "w") as fh:
            json.dump({"worktrees": rows}, fh)
        self.run_watch()
        self.assertEqual([a["text"] for a in self.alerts().values()], ["「ws」の worker「by-main」（タスク t0）が止まったあと、メインが 20 分動いていない"])
        # 帳簿に session の無い担当は、担当を立てた Task の Dispatch の受け手で見分ける（端末の担当は handle で立てる）。
        self.dispatch("task_lead", assignee_pane_key="lead-tab:1", assignee_handle="term_lead")
        self.ledger(["by-main", ("by-lead", None), "lead-tab:1"], owners=[{"id": "o1", "state": "open", "worker": {"task_id": "task_lead"}}])
        self.dispatch("task_1", assignee_pane_key="by-lead", creator_handle="term_lead")
        rows.append({"worktreeId": "r::lead", "path": os.path.join(self.tmp, "lead"), "parentWorktreeId": "r::ws",
                     "agents": [{"paneKey": "lead-tab:1", "state": "done", "stateStartedAt": idle, "conversationName": "任せる｜x"}]})
        with open(self.ps_file, "w") as fh:
            json.dump({"worktrees": rows}, fh)
        self.run_watch()
        self.assertEqual([a["text"] for a in self.alerts().values()], ["「ws」の worker「by-main」（タスク t0）が止まったあと、メインが 20 分動いていない"])

    def test_the_log_has_only_what_appeared_and_cleared(self):
        self.ledger(["w"])
        kid = {"paneKey": "w", "state": "done", "stateStartedAt": now_ms() - 20 * MIN, "conversationName": "W1"}
        self.ps([self.main_agent()], kids=[kid])
        out = self.run_watch()
        self.assertRegex(out, r"^\S+ 出た: 「ws」の worker「W1」（タスク t0）が止まったあと、メインが 20 分動いていない（今回知らせた）\n$")
        self.assertEqual(self.run_watch(), "", "出たままのものを毎回書かない")
        self.ps([self.main_agent(stateStartedAt=now_ms())], kids=[kid])
        self.assertRegex(self.run_watch(), r"^\S+ 消えた: 「ws」の worker「W1」")

    def test_main_itself_stopped(self):
        self.ps([self.main_agent(hasLivePty=False, mainAgent={"outcome": "failure"})])
        self.run_watch()
        self.assertTrue([k for k in self.alerts() if k.startswith("main-dead:")], self.alerts())

    def test_failed_notification_is_retried(self):
        self.ledger(["w"])
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
        self.ledger(["w"])
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
