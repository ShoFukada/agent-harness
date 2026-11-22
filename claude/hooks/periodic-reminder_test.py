#!/usr/bin/env python3
"""periodic-reminder.sh が、compact / resume のときに reminder と作業メモを両方流すことを保証する。

scratchpad のパスは cwd の / と . を - に潰した名前で決まる（実在する
/private/tmp/claude-<uid>/ 配下の名前と同じ形）。UserPromptSubmit の周期は N 回に 1 回のまま。
"""

import atexit
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest import mock

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "periodic-reminder.sh")
# hook は窓と同じ判定を通す
# 手元の本物の Orca は呼ばない（偽の orca を使うテストだけ fake_orca で差し替える）
os.environ["COCKPIT_ORCA"] = "/usr/bin/false"
os.environ["STALLWATCH_ALERTS"] = "/nonexistent/alerts.json"
os.environ["WORKTREE_SWEEP_HOME"] = "/nonexistent/worktree-sweep"
# Orca のチャットから走らせても、チャットの相談の判定（会話 id と ORCA_STRUCTURED_SESSION）を受け継がない
for _k in ("ORCA_AGENT_SESSION_ID", "ORCA_STRUCTURED_SESSION", "CONSULT_THREAD", "CONSULT_CARD"):
    os.environ.pop(_k, None)
os.environ.setdefault("COCKPIT_STATE", os.path.join(os.path.dirname(HOOK), "..", "..", "orca", "plugins", "cockpit", "window", "state.ts"))
# 役割の文書は持ち主の環境の側にあるので、試験用の写しを渡す
ROLES = tempfile.mkdtemp(prefix="periodic-reminder-roles-")
with open(os.path.join(ROLES, "consult-card.md"), "w", encoding="utf-8") as _fh:
    _fh.write("カードの相談の役割の本文\n")
os.environ["CLAUDE_ROLES_DIR"] = ROLES
atexit.register(shutil.rmtree, ROLES, True)
SCRATCHPAD_ROOT = "/private/tmp/claude-%d" % os.getuid()


def run(reminder, env=None, **payload):
    """reminder を渡すと Codex の呼び方（codex/config.toml は第 1 引数で reminder を渡す）、None なら Claude の呼び方。"""
    done = subprocess.run([HOOK] + ([reminder] if reminder else []), input=json.dumps(payload), text=True, check=True,
                          stdout=subprocess.PIPE, env=env)
    return done.stdout


class SessionStart(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="periodic-reminder-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.reminder = os.path.join(self.dir, "reminder.md")
        with open(self.reminder, "w", encoding="utf-8") as fh:
            fh.write("リマインドの本文\n")
        self.cwd = "/Users/tester/.config/some.project"
        self.session = str(uuid.uuid4())
        self.slug_root = os.path.join(SCRATCHPAD_ROOT, "-Users-tester--config-some-project")
        self.scratchpad = os.path.join(self.slug_root, self.session, "scratchpad")

    def write_state(self, text="いまの作業メモ\n"):
        os.makedirs(self.scratchpad)
        self.addCleanup(shutil.rmtree, self.slug_root, True)
        path = os.path.join(self.scratchpad, "state.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def start(self):
        return run(self.reminder, hook_event_name="SessionStart", source="compact",
                   session_id=self.session, cwd=self.cwd)

    def test_state_is_appended_to_the_reminder(self):
        self.write_state()
        output = self.start()
        self.assertIn("リマインドの本文", output)
        self.assertIn("いまの作業メモ", output)
        self.assertLess(output.index("リマインドの本文"), output.index("いまの作業メモ"))

    def test_the_reminder_alone_is_injected_without_a_state_file(self):
        output = self.start()
        self.assertIn("リマインドの本文", output)
        self.assertNotIn("scratchpad", output)

    def test_a_session_without_an_id_is_still_reminded(self):
        self.write_state()
        output = run(self.reminder, hook_event_name="SessionStart", cwd=self.cwd)
        self.assertEqual(output, "リマインドの本文\n")


def card(id, kind, state="open", **kw):
    return {"id": id, "rev": 1, "kind": kind, "title": id, "state": state, **kw}


# 窓の必須の欄（agent-harness の model.ts の missingFields）をそろえたカード。欠けたカードは私の番に数えられない
FULL = {"stream": "s1", "purpose": "p", "why": "w", "fallback": "f", "links": [{"label": "l", "href": "https://example.com"}],
        "context": {"what": "a", "now": "b", "how": "c", "gain": "d", "cost": "e"},
        "options": [{"id": "a", "label": "A", "example": "x", "recommended": True}, {"id": "b", "label": "B", "example": "y"}],
        "request": "r", "href": "https://example.com/v", "look_for": ["l"], "evidence": ["e"]}


def full_card(id, kind, state="open", **kw):
    return card(id, kind, state, **{**FULL, **kw})


def task(id, state, **kw):
    return {"id": id, "stream": "s1", "phase": "作成", "title": id, "state": state, **kw}


class Cockpit(unittest.TestCase):
    """cwd に .orca/cockpit.json（形の版 2）があれば、窓と同じ判定（state.ts）の結果を Claude のメインに添える。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="periodic-reminder-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.codex_reminder = os.path.join(self.dir, "reminder.md")
        with open(self.codex_reminder, "w", encoding="utf-8") as fh:
            fh.write("リマインドの本文\n")
        self.reminder = None  # Claude の呼び方（既定の reminder.md）
        os.makedirs(os.path.join(self.dir, ".orca"))

    def write(self, name, value):
        if name == "cockpit.json" and isinstance(value, dict):
            value = {"version": 2, "workspace": {"name": "案件"}, "streams": [{"id": "s1", "title": "仕事"}], "tasks": [], "cards": [], **value}
        with open(os.path.join(self.dir, ".orca", name), "w", encoding="utf-8") as fh:
            fh.write(value if isinstance(value, str) else json.dumps(value))

    def start(self):
        return run(self.reminder, hook_event_name="SessionStart", source="compact",
                   session_id=str(uuid.uuid4()), cwd=self.dir)

    def test_unapplied_ops_are_counted(self):
        self.write("cockpit.json", {"applied_ops": [1]})
        self.write("cockpit.user.json", {"ops": [{"op_id": 1}, {"op_id": 2}, {"op_id": 3}]})
        self.assertIn("操縦席あり（.orca/cockpit.json）・未反映の操作 2 件", self.start())

    def test_no_user_log_means_zero(self):
        self.write("cockpit.json", {"applied_ops": []})
        self.assertIn("未反映の操作 0 件", self.start())

    def test_broken_json_still_reminds(self):
        self.write("cockpit.json", "{ broken")
        self.write("cockpit.user.json", "{ broken")
        output = self.start()
        self.assertIn("【定期リマインド】", output)
        self.assertIn("操縦席あり（.orca/cockpit.json）・状態を読めない", output)
        self.assertNotIn("移し替え", output, "版が読めないものを版 1 と決めつけない")

    def test_a_version_1_cockpit_asks_for_the_migration(self):
        # 版 2 の state.ts は版 1 を読まず、役割の 1 行しか出なくなった（2026-11-21、両方の main を戻した）
        self.write("cockpit.json", json.dumps({"workspace": {"name": "案件A"}, "streams": [], "tasks": [],
                                               "items": [{"id": "d1", "kind": "dec", "state": "open"}]}))
        self.assertIn("「案件A」", self.start())
        for out in (self.start(), self.prompt()):
            self.assertIn("【操縦席】cockpit.json が版 1 のままで、状態を読めない。移し替えが要る", out)
            self.assertIn("migrate.ts %s で中身を確かめ、--write で移し替える" % self.dir, out)
        self.write("cockpit.json", {})
        self.assertNotIn("移し替え", self.prompt())
        self.write("cockpit.json", '{"version": 1} garbage')
        self.assertNotIn("移し替え", self.prompt(), "後ろが壊れたファイルに --write を案内しない")

    def test_no_cockpit_no_line(self):
        self.assertNotIn("【操縦席】", self.start())
        self.assertNotIn("操縦席あり", self.start())

    def test_the_main_memo_lives_in_the_workspace_not_the_scratchpad(self):
        # メインのチャットが替わっても（/clear・新しいチャット）同じメモを辿れるよう、操縦席があればワークスペースのメモを流す
        self.write("cockpit.json", {"applied_ops": []})
        os.makedirs(os.path.join(self.dir, ".orca", "cockpit"))
        with open(os.path.join(self.dir, ".orca", "cockpit", "state.md"), "w", encoding="utf-8") as fh:
            fh.write("ワークスペースの作業メモ\n")
        session = str(uuid.uuid4())
        slug_root = os.path.join(SCRATCHPAD_ROOT, self.dir.replace("/", "-").replace(".", "-"))
        os.makedirs(os.path.join(slug_root, session, "scratchpad"))
        self.addCleanup(shutil.rmtree, slug_root, True)
        with open(os.path.join(slug_root, session, "scratchpad", "state.md"), "w", encoding="utf-8") as fh:
            fh.write("セッションの作業メモ\n")
        output = run(self.reminder, hook_event_name="SessionStart", source="resume", session_id=session, cwd=self.dir)
        self.assertIn("# 作業メモ (.orca/cockpit/state.md)\nワークスペースの作業メモ", output)
        self.assertNotIn("セッションの作業メモ", output)
        self.assertLess(output.index("ワークスペースの作業メモ"), output.index("操縦席あり"))
        # 圧縮のあとは compaction-keep.py が組み直しの中で流すので、ここでは流さない
        output = run(self.reminder, hook_event_name="SessionStart", source="compact", session_id=session, cwd=self.dir)
        self.assertNotIn("ワークスペースの作業メモ", output)
        self.assertNotIn("セッションの作業メモ", output)
        self.assertIn("操縦席あり", output)

    def prompt(self):
        return run(self.reminder, hook_event_name="UserPromptSubmit",
                   session_id=str(uuid.uuid4()), cwd=self.dir)

    def git_ahead_by_one(self):
        """root を、upstream より 1 commit 進んだリポジトリにする（.orca は外す）。"""
        remote = tempfile.mkdtemp(prefix="periodic-reminder-remote-")
        self.addCleanup(shutil.rmtree, remote, True)
        g = lambda *a, cwd=self.dir: subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)
        g("init", "-q", "--bare", remote, cwd=remote)
        g("init", "-q", "-b", "main")
        g("config", "user.email", "t@example.com"); g("config", "user.name", "t")
        with open(os.path.join(self.dir, ".gitignore"), "w") as fh:
            fh.write(".orca/\nreminder.md\n")
        g("add", ".gitignore"); g("commit", "-qm", "a")
        g("remote", "add", "origin", remote); g("push", "-qu", "origin", "main")
        with open(os.path.join(self.dir, "b.txt"), "w") as fh:
            fh.write("b")
        g("add", "b.txt"); g("commit", "-qm", "b")

    def test_unpushed_commits_are_named_once_work_is_done(self):
        self.git_ahead_by_one()
        self.write("cockpit.json", {"tasks": [task("t1", "ok")]})
        self.assertIn("push していない commit 1 件・commit していない変更 0 件", self.prompt())

    def test_unpushed_is_quiet_while_a_task_runs_or_a_push_item_is_open(self):
        self.git_ahead_by_one()
        self.write("cockpit.json", {"tasks": [task("t1", "run")]})
        self.assertNotIn("push していない", self.prompt())
        self.write("cockpit.json", {"cards": [card("p1", "permit", scope="push", stream="s1")]})
        self.assertNotIn("push していない", self.prompt())

    def test_every_prompt_reports_unapplied_ops(self):
        self.write("cockpit.json", {"applied_ops": [1]})
        self.write("cockpit.user.json", {"ops": [{"op_id": 1}, {"op_id": 2}]})
        self.assertIn("【操縦席】未反映の操作が 1 件", self.prompt())

    def test_stalled_things_found_by_the_watchdog_are_named_for_this_workspace(self):
        self.write("cockpit.json", {})
        alerts = os.path.join(self.dir, "alerts.json")
        with open(alerts, "w", encoding="utf-8") as fh:
            json.dump({"alerts": [{"text": "定時ジョブ x が失敗", "root": None},
                                  {"text": "ここのメインが止まった", "root": self.dir},
                                  {"text": "よそのメインが止まった", "root": "/elsewhere"}]}, fh)
        with mock.patch.dict(os.environ, {"STALLWATCH_ALERTS": alerts}):
            out = self.prompt()
        self.assertIn("【見張り】止まっているもの: 定時ジョブ x が失敗・ここのメインが止まった。", out)
        self.assertNotIn("よそ", out)
        self.assertNotIn("【見張り】", self.prompt(), "見張りの記録が無ければ出さない")

    def test_prompt_has_no_pending_line_when_everything_is_applied(self):
        self.write("cockpit.json", {"applied_ops": [1]})
        self.write("cockpit.user.json", {"ops": [{"op_id": 1}]})
        self.assertNotIn("未反映", self.prompt())

    def test_the_role_and_the_whole_picture_come_at_start_not_on_every_prompt(self):
        # 件数は私の番の 5 種類だけ。届いた・話し中・報告と済んだカードは数えない
        self.write("cockpit.json", {
            "workspace": {"name": "案件A"},
            "cards": [full_card("d1", "decide"), card("a1", "report", stream="s1"), full_card("v1", "review"),
                      card("d2", "decide", "done", stream="s1"), card("i1", "inbox"), card("c1", "talk", stream="s1"),
                      card("w1", "send", "waiting", stream="s1", awaiting={"who": "先方の担当者", "what": "回答", "since": "2026-11-20T10:00:00+09:00"})],
            "tasks": [task("t1", "run", title="画面の実装", worker={"task_id": "task_1", "dispatch_id": "ctx_1"}),
                      task("t2", "run", title="メインの作業")]})
        env = self.fake_orca([], shows={"ctx_1": self.show("ready")})
        start = lambda: run(self.reminder, env=env, hook_event_name="SessionStart", source="startup", session_id=str(uuid.uuid4()), cwd=self.dir)
        out = start()
        self.assertIn("「案件A」のメイン（案件全体の進行役）", out)
        # 種類の名前は窓の名前（R84）。版 3 の窓は kind: talk のカードを協議中に数えない（協議中は talk の op から決まる）
        self.assertIn("全体: 私の番 2 件（判断 1・確認 1）・話し中 0・顧客待ち 1・動いている worker 1（画面の実装）", out)
        # R184: 発言のたびに役割と件数を流すと、次にやることが薄れた
        out = self.prompt_with(env)
        self.assertNotIn("メインの役割", out)
        self.assertNotIn("全体:", out)
        env = self.fake_orca([], shows={"ctx_1": self.show("succeeded", done_ms_ago=60000)})
        self.assertIn("・動いている worker 0", start())

    def test_cockpit_is_found_from_a_subfolder(self):
        self.write("cockpit.json", {"workspace": {"name": "案件A"}})
        os.makedirs(os.path.join(self.dir, "sub", "deeper"))
        out = run(self.reminder, hook_event_name="SessionStart", source="startup", session_id=str(uuid.uuid4()),
                  cwd=os.path.join(self.dir, "sub", "deeper"))
        self.assertIn("「案件A」のメイン", out)

    def test_a_nested_repository_does_not_get_the_main_role(self):
        self.write("cockpit.json", {"workspace": {"name": "案件A"}})
        os.makedirs(os.path.join(self.dir, "other-repo", ".git"))
        out = run(self.reminder, hook_event_name="UserPromptSubmit", session_id=str(uuid.uuid4()),
                  cwd=os.path.join(self.dir, "other-repo"))
        self.assertNotIn("メインの役割", out)

    def test_a_consult_thread_does_not_get_the_main_role(self):
        self.write("cockpit.json", {"workspace": {"name": "案件A"}})
        out = run(self.reminder, env=dict(os.environ, CONSULT_THREAD="1"), hook_event_name="UserPromptSubmit",
                  session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertNotIn("メイン", out)
        self.assertNotIn("操縦席", out)

    def test_worktrees_the_nightly_sweep_left_for_a_decision_are_named_for_this_main_only(self):
        self.write("cockpit.json", {})
        sweep = os.path.join(self.dir, "sweep")
        os.makedirs(sweep)
        with open(os.path.join(sweep, "sweep.json"), "w", encoding="utf-8") as fh:
            json.dump({"decide": [
                {"path": "/w/mine", "main": self.dir, "reasons": ["10 時間動きが無い", "main に無い commit 2 件"]},
                {"path": "/w/other", "main": "/elsewhere", "reasons": ["r"]}]}, fh)
        out = run(self.reminder, env={**os.environ, "WORKTREE_SWEEP_HOME": sweep}, hook_event_name="SessionStart",
                  source="compact", session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertIn("【worktree】判断が要る worktree 1 件", out)
        self.assertIn("/w/mine（10 時間動きが無い・main に無い commit 2 件）", out)
        self.assertNotIn("/w/other", out)
        self.assertNotIn("【worktree】", self.start())

    def test_session_start_also_restates_the_role(self):
        self.write("cockpit.json", {"workspace": {"name": "案件A"}})
        self.assertIn("「案件A」のメイン", self.start())

    def test_open_decisions_without_full_context_are_named(self):
        full = {"what": "何か", "now": "今", "how": "入れ方", "gain": "得", "cost": "損"}
        self.write("cockpit.json", {"cards": [
            card("d1", "decide", stream="s1"),
            card("d2", "decide", stream="s1", context={**full, "how": "", "cost": None}),
            card("d3", "decide", stream="s1", context=full),
            card("d4", "decide", "done", stream="s1"),
            card("a1", "report", stream="s1")]})
        out = self.prompt()
        self.assertIn("【操縦席】帳簿の直し: missing_context 2 件（d1、d2）・", out)
        self.assertIn("判断材料が欠けている判断のカード: d1", self.start())

    def test_deliverables_left_in_a_temp_folder_are_named(self):
        self.write("cockpit.json", {"cards": [
            card("a1", "report", stream="s1", href="/private/tmp/claude-501/x/scratchpad/page.html"),
            card("a2", "review", stream="s1", links=[{"label": "比較", "href": "file:///tmp/cmp.html"}]),
            card("a3", "review", stream="s1", href="https://claude.ai/artifact/abc"),
            card("a4", "report", stream="s1", href="/Users/me/repo/docs/design.md"),
            card("a5", "review", "done", stream="s1", href="/tmp/old.html")]})
        self.assertIn("local_deliverables 2 件（a1、a2）", self.prompt())

    def test_cards_routes_and_names_that_need_care_are_named(self):
        long = "とても長い名前の仕事でサイドバーで切れてしまうもの"
        self.write("cockpit.json", {
            "streams": [{"id": "s1", "title": "仕事"}, {"id": "s2", "title": long}],
            "tasks": [task("t2", "run", stream="s2")],
            "routes": [{"id": "slack", "label": "Slack #dev", "error": "token expired"}],
            "cards": [card("d1", "decide"), card("d2", "decide", stream="s1"), card("i1", "inbox"),
                      card("w1", "send", "waiting", stream="s1", awaiting={"who": "先方の担当者", "what": "回答", "since": "2026-11-01T10:00:00+09:00",
                                                                          "remind_at": "2026-11-03T10:00:00+09:00"})]})
        out = self.prompt()
        # 要対応と警告は 1 件ずつ、帳簿の形の直しは 1 行にまとめる
        self.assertIn("催促の日を過ぎた顧客待ち: w1。", out)
        self.assertIn("連絡を拾えていない経路: Slack #dev: token expired。", out)
        self.assertIn("orphan_cards 1 件（d1）", out)
        self.assertIn("long_names 1 件（s2（%d 字））" % len(long), out)
        self.assertEqual(out.count("【操縦席】帳簿の直し"), 1)

    def turn_then_stop(self, message, touch_cockpit=False, active=False):
        session = str(uuid.uuid4())
        self.write("cockpit.json", {})
        old = 1_000_000_000
        os.utime(os.path.join(self.dir, ".orca", "cockpit.json"), (old, old))
        run(self.reminder, hook_event_name="UserPromptSubmit", session_id=session, cwd=self.dir)
        if touch_cockpit:
            self.write("cockpit.json", {"updated": True})
        return run(self.reminder, hook_event_name="Stop", session_id=session, cwd=self.dir,
                   stop_hook_active=active, last_assistant_message=message)

    def test_stop_blocks_a_request_to_the_user_when_the_cockpit_was_not_written_this_turn(self):
        out = json.loads(self.turn_then_stop("マージの進め方を決めていただけますか。"))
        self.assertEqual(out["decision"], "block")
        self.assertIn("判断・送信前・確認・許可のカード", out["reason"])

    def test_stop_passes_when_the_cockpit_was_written_this_turn(self):
        self.assertEqual(self.turn_then_stop("switch を打ってください。", touch_cockpit=True), "")

    def test_stop_passes_a_report_without_a_request(self):
        self.assertEqual(self.turn_then_stop("テストは 39 件通りました。"), "")

    def test_stop_passes_fullwidth_punctuation_under_the_c_locale(self):
        # hook は locale 無しで動くことがあり、「：」が「？」と先頭のバイトを共有して当たった（2026-11-16）
        with mock.patch.dict(os.environ, {"LC_ALL": "C", "LANG": ""}):
            self.assertEqual(self.turn_then_stop("**どこで見るか**：Apple の container には画面がない。"), "")

    def test_stop_blocks_only_once(self):
        self.assertEqual(self.turn_then_stop("決めてください。", active=True), "")

    @staticmethod
    def show(stage, liveness="live", done_ms_ago=None):
        import datetime
        r = {"projection": {"stage": {"worker": stage}, "liveness": {"verdict": liveness}}}
        if done_ms_ago is not None:
            at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(milliseconds=done_ms_ago)
            r["dispatch"] = {"completedAt": at.isoformat().replace("+00:00", "Z")}
        return r

    def fake_orca(self, worktrees, plugin_status="running", shows=None):
        """worktree ps・terminal list・agent list・worker-show の結果を返す偽の orca。worktrees は本線（self.dir）の子にする。
        shows は dispatch id → worker-show の結果。無い id は dispatch_not_found。呼ばれた回数を calls に残す。"""
        bin_dir = os.path.join(self.dir, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        show_dir = os.path.join(self.dir, "shows")
        os.makedirs(show_dir, exist_ok=True)
        for d, r in (shows or {}).items():
            with open(os.path.join(show_dir, d + ".json"), "w", encoding="utf-8") as fh:
                json.dump({"ok": True, "result": r}, fh)
        root = {"worktreeId": "root", "path": self.dir, "parentWorktreeId": None, "agents": []}
        kids = [{"path": os.path.join(self.dir, "wt", w["worktreeId"]), "parentWorktreeId": "root",
                 **w, "agents": [{"paneKey": "t:%s-%d" % (w["worktreeId"], n), **a} for n, a in enumerate(w.get("agents", []))]}
                for w in worktrees]
        with open(os.path.join(self.dir, "ps.json"), "w", encoding="utf-8") as fh:
            json.dump({"ok": True, "result": {"worktrees": [root, *kids]}}, fh)
        with open(os.path.join(self.dir, "terms.json"), "w", encoding="utf-8") as fh:
            json.dump({"ok": True, "result": {"terminals": []}}, fh)
        with open(os.path.join(self.dir, "plugins.json"), "w", encoding="utf-8") as fh:
            json.dump({"ok": True, "result": {"plugins": [{"pluginKey": "local.cockpit", "status": plugin_status,
                                                           "needsReconsent": plugin_status == "pending", "isDev": False}]}}, fh)
        orca = os.path.join(bin_dir, "orca")
        with open(orca, "w", encoding="utf-8") as fh:
            fh.write('#!/bin/sh\necho "$*" >> "%s/calls"\n[ "$1" = terminal ] && exec cat "%s/terms.json"\n[ "$1" = plugin ] && exec cat "%s/plugins.json"\n'
                     '[ "$1" = agent ] && echo \'{"ok": true, "result": {"agents": []}}\' && exit 0\n'
                     'if [ "$1" = orchestration ]; then\n  [ -f "%s/$4.json" ] && exec cat "%s/$4.json"\n'
                     '  echo \'{"ok": false, "error": {"code": "dispatch_not_found", "message": "no dispatch"}}\'; exit 1\nfi\n'
                     'cat "%s/ps.json"\n'
                     % (self.dir, self.dir, self.dir, show_dir, show_dir, self.dir))
        os.chmod(orca, 0o755)
        return dict(os.environ, PATH=bin_dir + ":" + os.environ["PATH"], COCKPIT_ORCA=orca)

    def calls(self):
        try:
            with open(os.path.join(self.dir, "calls"), encoding="utf-8") as fh:
                return fh.read().splitlines()
        except FileNotFoundError:
            return []

    def prompt_with(self, env):
        return run(self.reminder, env=env, hook_event_name="UserPromptSubmit", session_id=str(uuid.uuid4()), cwd=self.dir)

    def test_tasks_whose_worker_finished_long_ago_or_is_missing_are_named_with_the_fix(self):
        w = lambda n: {"task_id": "task_" + n, "dispatch_id": "ctx_" + n}
        self.write("cockpit.json", {
            "cards": [card("d1", "decide", stream="s1", tasks=["t6"])],
            "tasks": [task("t1", "ok", worker=w("1")), task("t25", "run", worker=w("25")),
                      task("t26", "run", worker=w("26")), task("t27", "run", worker=w("27")),
                      task("t30", "run", worker=w("30")), task("t6", "wait", worker=w("6")), task("t7", "run")]})
        env = self.fake_orca([], shows={
            "ctx_25": self.show("succeeded", done_ms_ago=11 * 60000),
            "ctx_26": self.show("succeeded", done_ms_ago=5 * 60000),
            "ctx_27": self.show("ready")})
        out = self.prompt_with(env)
        self.assertIn("【操縦席】worker が終わったのに取り込んでいないタスク: t25。worker の結果を確かめて取り込み、state を ok にする", out)
        self.assertIn("missing_workers 1 件（t30）", out)
        shows = ["orchestration worker-show --dispatch ctx_%s --full --json" % n for n in ("25", "26", "27", "30", "6")]
        self.assertEqual(sorted(self.calls()), sorted(["agent list --json", "plugin list --json", "terminal list --limit 500 --json", "worktree ps --limit 500 --json", *shows]),
                         "orca はそれぞれ 1 回だけ。済んだタスクの Dispatch は問い合わせない")

    def test_orca_is_not_called_without_a_task_given_to_a_worker(self):
        self.write("cockpit.json", {"tasks": [task("t1", "ok", worker={"task_id": "task_1", "dispatch_id": "ctx_1"}),
                                              task("t2", "run")]})
        out = self.prompt_with(self.fake_orca([]))
        self.assertNotIn("worker が", out)
        # 版 3 の窓は、止まったエージェントと担当の様子（放置の検出・一緒に作る仕事）を見るため、worker の無いときもエージェント・端末・worktree の一覧を 1 回ずつ読む。worker-show は呼ばない
        self.assertEqual(sorted(self.calls()), ["agent list --json", "plugin list --json", "terminal list --limit 500 --json", "worktree ps --limit 500 --json"])

    def test_a_cockpit_plugin_waiting_for_approval_asks_for_a_decision(self):
        # プラグインの worker が止まると、窓が Orca の前面に追いつかない（2026-11-16、理由が分からないまま切り替わらなくなった）
        self.write("cockpit.json", {})
        out = self.prompt_with(self.fake_orca([], plugin_status="pending"))
        self.assertIn("【操縦席】Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています。深田さんに Orca で操縦席のプラグインを承認", out)
        self.assertNotIn("プラグイン", self.prompt_with(self.fake_orca([])))

    def test_no_missing_context_line_when_every_decision_is_complete(self):
        self.write("cockpit.json", {"cards": [card("d1", "decide", stream="s1", context={
            "what": "a", "now": "b", "how": "c", "gain": "d", "cost": "e"})]})
        self.assertNotIn("missing_context", self.prompt())


class Version3Checks(unittest.TestCase):
    """版 3 の検査（state.ts の checks）を発言のたびに名指す。state.ts の出力は偽のスクリプトで固定する（agent-harness の版 3 より先に入るため）。"""

    setUp = Cockpit.setUp
    write = Cockpit.write

    def v3_prompt(self, checks, reminder=None, ledger=None, **env):
        fake = os.path.join(self.dir, "fake-state.js")
        with open(fake, "w") as fh:
            fh.write("console.log(%s)" % json.dumps(json.dumps({"checks": checks}, ensure_ascii=False)))
        self.write("cockpit.json", ledger or {})
        return run(reminder, env={**os.environ, "COCKPIT_STATE": fake, **env}, hook_event_name="UserPromptSubmit",
                   session_id=str(uuid.uuid4()), cwd=self.dir)

    def test_idle_tasks_are_named_once_per_stretch_and_a_bad_workspace_name_every_time(self):
        tmp = tempfile.mkdtemp(prefix="periodic-reminder-tmp-")
        self.addCleanup(shutil.rmtree, tmp, True)
        checks = {"idle_tasks": [{"task": "t12", "since": "2026-11-22T09:00:00+09:00", "hours": 3}], "workspace_name": {"name": "dev-standards", "message": "案件の名前「dev-standards」が「<顧客>｜<案件>」の形になっていない。"}}
        # 同じ root で先に動いた Codex は名指しを受け取らず、窓口宛ての 1 回を消費しない（監査の指摘 3）
        codex = self.v3_prompt(checks, reminder=self.codex_reminder, TMPDIR=tmp)
        self.assertNotIn("【操縦席】", codex)
        first = self.v3_prompt(checks, TMPDIR=tmp)
        self.assertIn("線を越えて動いていないタスク: t12（3 時間）。", first)
        self.assertIn("workspace_name 1 件（dev-standards）", first)
        again = self.v3_prompt(checks, TMPDIR=tmp)
        self.assertNotIn("線を越えて動いていないタスク", again)
        self.assertIn("workspace_name 1 件（dev-standards）", again)
        # タスクが動いて since が変わり、また線を越えたら、もう 1 回流す
        moved = self.v3_prompt({"idle_tasks": [{"task": "t12", "since": "2026-11-22T13:00:00+09:00", "hours": 2}]}, TMPDIR=tmp)
        self.assertIn("線を越えて動いていないタスク: t12（2 時間）。", moved)

    git_ahead_by_one = Cockpit.git_ahead_by_one

    def test_a_delegated_push_is_named_without_asking_for_a_card(self):
        self.git_ahead_by_one()
        out = self.v3_prompt({"push_delegated": True, "push_check": False})
        self.assertIn("push していない commit 1 件", out)
        self.assertIn("この案件では push が一任されている", out)
        self.assertNotIn("許可のカードにして窓に出し", out)
        asked = self.v3_prompt({"push_check": True})
        self.assertIn("許可のカードにして窓に出し", asked)
        self.assertNotIn("一任されている（判断の記録）", asked)
        self.assertNotIn("push していない", self.v3_prompt({}))

    def test_watch_jobs_without_settings_or_bot_are_named(self):
        out = self.v3_prompt({"watch_missing": ["s3"], "watch_unknown": ["s4"]})
        self.assertIn("watch_missing 1 件（s3）・watch_unknown 1 件（s4）", out)

    def test_jobs_and_tasks_without_status_are_counted_on_one_line(self):
        out = self.v3_prompt({"status_missing": ["s3", "s4", "s7", "s9"]})
        self.assertIn("status_missing 4 件（s3、s4、s7 ほか）", out)

    def test_stale_status_and_unsorted_notices_are_named(self):
        # 元の事実が変わった状況の文と、開いた待ちと照らしていない知らせ（R204。state.ts の checks.stale_status・unsorted_notices）
        out = self.v3_prompt({"stale_status": [{"id": "s1", "changes": ["t3「直す」: 完了（前: run）", "v9: 閉じた・無くなった", "x"]}], "unsorted_notices": ["n-4", "n-5"]})
        self.assertIn("状況の文が古い仕事: s1（t3「直す」: 完了（前: run）／v9: 閉じた・無くなった）", out)
        self.assertIn("開いた待ちと照らしていない知らせ: n-4、n-5", out)

    def test_incomplete_cards_stale_loose_and_off_phase_tasks_are_named(self):
        out = self.v3_prompt({"incomplete_cards": [{"id": "v90", "missing": ["evidence", "fallback"]}, "p97"],
                                "stale_tasks": ["t58"], "loose_tasks": [{"id": "t70"}], "unknown_phase": ["t66"],
                                "no_form": ["s9"], "unsorted": ["u-160"]})
        self.assertIn("【操縦席】帳簿の直し: incomplete_cards 2 件（v90、p97）・stale_tasks 1 件（t58）・loose_tasks 1 件（t70）・"
                      "unknown_phase 1 件（t66）・no_form 1 件（s9）。直し方は cockpit skill の references/schema.md で検査の名前を引く", out)
        self.assertNotIn("u-160", out)  # 帳簿を移すまでは未仕分けを出さない

    def test_unsorted_utterances_are_named_once_the_switch_is_on_and_the_ledger_is_moved(self):
        out = self.v3_prompt({"unsorted": ["u-160", {"id": "u-161"}]}, COCKPIT_LEDGER_GUARD="1")
        self.assertNotIn("u-160", out)  # 版 3 でない帳簿（intake が無い）には出さない
        self.write("cockpit.v2.json", {})
        out = self.v3_prompt({"unsorted": ["u-160", {"id": "u-161"}]}, COCKPIT_LEDGER_GUARD="1")
        self.assertNotIn("u-160", out)  # 移し替えの控えだけがあっても、intake が無ければ出さない（R195）
        os.remove(os.path.join(self.dir, ".orca", "cockpit.v2.json"))
        v3 = {"intake": {"through": "", "none": []}}
        out = self.v3_prompt({"unsorted": ["u-160", {"id": "u-161"}]}, ledger=v3, COCKPIT_LEDGER_GUARD="1")
        self.assertIn("仕分けていない発言: u-160、u-161。", out)  # init で作った帳簿（控えが無い）にも出す
        self.assertNotIn("u-160", self.v3_prompt({"unsorted": ["u-160"]}, ledger=v3, COCKPIT_LEDGER_GUARD="0"))  # 切り替えが切れていれば出さない

    # 受入（設計 9.8）: 11/21 の台帳で抜けた 4 件を、窓口に名指しする
    def test_A006_an_approval_without_the_element_map_is_named(self):
        out = self.v3_prompt({"unmapped_elements": [{"card": "v89", "missing": [3, 5]}]})
        self.assertIn("要素の行き先（element_map）が欠けたカード: v89（要素 3・5）。", out)

    def test_B025_a_request_whose_tasks_are_done_without_proof_is_named(self):
        out = self.v3_prompt({"unproven": [{"request": "r27", "when": [2]}]})
        self.assertIn("証拠の無い済の条件が残る依頼: r27（済の条件 2）。", out)

    def test_t50_a_task_affected_by_the_R39_scope_change_is_named(self):
        out = self.v3_prompt({"affected_tasks": [{"ruling": "R39", "task": "t50"}]})
        self.assertIn("見直していないタスク: R39→t50。", out)

    def test_B035_a_commitment_left_unsorted_is_named(self):
        out = self.v3_prompt({"unsorted": ["u-171"]}, ledger={"intake": {"through": "", "none": []}}, COCKPIT_LEDGER_GUARD="1")
        self.assertIn("仕分けていない発言: u-171。", out)

    def test_nothing_is_said_when_the_checks_are_empty(self):
        out = self.v3_prompt({"incomplete_cards": [], "unsorted": [], "unmapped_elements": [], "unproven": [], "affected_tasks": []},
                             COCKPIT_LEDGER_GUARD="1")
        for word in ("帳簿の直し", "仕分けていない", "element_map", "証拠の無い", "見直していない"):
            self.assertNotIn(word, out)

    def test_active_constraints_are_restated_at_startup_but_not_after_compact(self):
        # 「返事は日本語」（R55）のような制約を、開始・再開のたびに流し直す
        self.write("cockpit.json", {})
        os.makedirs(os.path.join(self.dir, ".orca", "cockpit"), exist_ok=True)
        with open(os.path.join(self.dir, ".orca", "cockpit", "rulings.jsonl"), "w", encoding="utf-8") as fh:
            for r in ({"id": "R1", "kind": "constraint", "text": "深田さんへの返事は日本語で書く", "quote": "日本語で\n引用は原文のまま"},
                      {"id": "R2", "kind": "decision", "text": "A で作る"},
                      {"id": "R3", "kind": "constraint", "text": "古い制約", "quote": "x"},
                      {"id": "R4", "kind": "revoke", "text": "撤回", "quote": "y", "supersedes": ["R3"]}):
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        for source in ("startup", "resume", "clear"):
            out = run(self.reminder, hook_event_name="SessionStart", source=source, session_id=str(uuid.uuid4()), cwd=self.dir)
            self.assertIn("R1 [constraint] 深田さんへの返事は日本語で書く 原文「日本語で\n引用は原文のまま」", out, source)
            self.assertIn("## 空き枠と待ちのタスク（上限 4・作業中 0・空き 4。", out, source)
            self.assertNotIn("R2", out)
            self.assertNotIn("R3", out)
        self.assertNotIn("R1 [constraint]", Cockpit.start(self))

    def test_codex_in_the_workspace_root_gets_no_main_role(self):
        # codex exec のレビューは窓口の root で動く。窓口宛ての役割・名指し（push の一任を含む）を Codex に流さない
        self.write("cockpit.json", {"workspace": {"name": "案件A"}})
        for event in ("SessionStart", "UserPromptSubmit"):
            out = run(self.codex_reminder, hook_event_name=event, source="startup", session_id=str(uuid.uuid4()), cwd=self.dir)
            self.assertNotIn("メインの役割", out, event)
            self.assertNotIn("操縦席", out, event)

    # カードの相談（設計 10.7 の 1・8）
    def test_unreflected_returns_and_tabs_left_after_the_card_closed_are_named(self):
        out = self.v3_prompt({"unreflected_returns": [{"id": "d21-1", "card": "d21", "missing": ["帳簿"]}],
                              "stale_consults": [{"id": "d19", "terminal": "term_x"}]})
        self.assertIn("反映していないカードの相談の返し: d21-1（帳簿）。", out)
        self.assertIn("stale_consults 1 件（d19）", out)

    def test_a_return_left_in_the_consult_memo_is_named_at_startup(self):
        self.write("cockpit.json", {"cards": [{"id": "d21", "rev": 1, "kind": "consult", "title": "x", "state": "open"}]})
        os.makedirs(os.path.join(self.dir, ".orca", "consult"))
        with open(os.path.join(self.dir, ".orca", "consult", "d21.md"), "w", encoding="utf-8") as fh:
            fh.write('# 相談\n## 窓口に返したもの\n```json\n{"return_id": "d21-1", "card": "d21"}\n```\n')
        out = run(self.reminder, hook_event_name="SessionStart", source="startup", session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertIn("- d21-1（カード d21。無いもの: 判断の記録・帳簿。", out)

    def test_a_card_consult_rereads_its_memo_after_compact_but_gets_no_main_role(self):
        self.write("cockpit.json", {})
        env = {**os.environ, "CONSULT_THREAD": "1", "CONSULT_CARD": self.dir + "#d21"}
        out = run(self.reminder, env=env, hook_event_name="SessionStart", source="compact", session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertIn("カード d21 の相談を続ける前に", out)
        self.assertIn(os.path.join(self.dir, ".orca", "consult", "d21.md"), out)
        self.assertIn("consult-context %s d21" % self.dir, out)
        self.assertNotIn("メインの役割", out)
        # 立てたときは起動の指示が文脈の束を持つので、ここでは流さない
        out = run(self.reminder, env=env, hook_event_name="SessionStart", source="startup", session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertNotIn("相談を続ける前に", out)
        # 端末の相談は役割を system prompt に持つので、流し直さない
        out = run(self.reminder, env=env, hook_event_name="SessionStart", source="compact", session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertNotIn("# 役割", out)

    def test_a_card_consult_in_an_orca_chat_is_known_by_its_registration_or_its_launch_mark(self):
        # 版 1 の帳簿にして、メインの発言のターンにだけ移し替えの 1 行が出ることで、メインかどうかを見る（state.ts の版に依らない）
        self.write("cockpit.json", json.dumps({"workspace": {"name": "案件A"}, "streams": [], "tasks": [], "items": []}))
        os.makedirs(os.path.join(self.dir, ".orca", "consult"))
        with open(os.path.join(self.dir, ".orca", "consult", "chats.json"), "w", encoding="utf-8") as fh:
            json.dump({"chat-1": {"card": "d21"}}, fh)
        chat = {**os.environ, "ORCA_AGENT_SESSION_ID": "chat-1", "ORCA_STRUCTURED_SESSION": "1"}
        out = run(self.reminder, env=chat, hook_event_name="SessionStart", source="compact", session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertIn("カード d21 の相談を続ける前に", out)
        self.assertIn("# 役割（claude/roles/consult-card.md）\nカードの相談の役割の本文", out)
        self.assertNotIn("メインの役割", out)
        # 役割のファイルが無ければ、見出しだけで黙らずに読めないことを出す
        out = run(self.reminder, env={**chat, "CLAUDE_ROLES_DIR": "/nonexistent/roles"}, hook_event_name="SessionStart",
                  source="compact", session_id=str(uuid.uuid4()), cwd=self.dir)
        self.assertIn("役割のファイル /nonexistent/roles/consult-card.md を読めない", out)
        out = run(self.reminder, env=chat, hook_event_name="UserPromptSubmit", session_id=str(uuid.uuid4()), cwd=self.dir, prompt="案 A で")
        self.assertNotIn("【操縦席】", out)
        # 登録より先に届く最初の指示は、指示の中の印で見分ける
        other = {**chat, "ORCA_AGENT_SESSION_ID": "chat-2"}
        mark = "【相談の知らせ】カードの相談を始める\n相談の印: d21#%s\n本文" % ("0" * 32)
        out = run(self.reminder, env=other, hook_event_name="UserPromptSubmit", session_id=str(uuid.uuid4()), cwd=self.dir, prompt=mark)
        self.assertNotIn("【操縦席】", out)
        # 窓口のチャット（登録されていない会話 id）はメインのまま
        out = run(self.reminder, env=other, hook_event_name="UserPromptSubmit", session_id=str(uuid.uuid4()), cwd=self.dir, prompt="進捗は？")
        self.assertIn("【操縦席】cockpit.json が版 1", out)
        # 起動の見出しの無い発言に印の行を引いても、メインのまま
        out = run(self.reminder, env=other, hook_event_name="UserPromptSubmit", session_id=str(uuid.uuid4()), cwd=self.dir,
                  prompt="メモ\n相談の印: d21#%s" % ("0" * 32))
        self.assertIn("【操縦席】cockpit.json が版 1", out)



class UserPrompt(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="periodic-reminder-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.reminder = os.path.join(self.dir, "reminder.md")
        with open(self.reminder, "w", encoding="utf-8") as fh:
            fh.write("リマインドの本文\n")
        self.session = str(uuid.uuid4())
        counter = os.path.join(os.environ.get("TMPDIR", "/tmp"),
                               "claude-periodic-reminder", self.session)
        self.addCleanup(lambda: os.path.exists(counter) and os.unlink(counter))

    def test_the_reminder_comes_back_every_fifth_prompt(self):
        seen = ["リマインドの本文" in run(self.reminder, hook_event_name="UserPromptSubmit",
                                      session_id=self.session) for _ in range(10)]
        self.assertEqual(seen, [False] * 4 + [True] + [False] * 4 + [True])

    def test_a_relayed_notice_gets_only_the_time(self):
        # R184・R186: 担当・worker・背景の作業の知らせのターンには時刻だけ（今の順番は compaction-keep.py が流す）。念押し・checks は流さない
        os.makedirs(os.path.join(self.dir, ".orca"))
        with open(os.path.join(self.dir, ".orca", "cockpit.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": 2, "workspace": {"name": "x"}, "streams": [], "tasks": [], "cards": [], "applied_ops": [1]}, fh)
        with open(os.path.join(self.dir, ".orca", "cockpit.user.json"), "w", encoding="utf-8") as fh:
            json.dump({"ops": [{"op_id": 1}, {"op_id": 2}]}, fh)
        for prompt in ("──── From: worker (term_1) (worker_done) ────\nSubject: 済\n本文",
                       "<task-notification>\n<status>completed</status>\n</task-notification>"):
            for reminder in (self.reminder, None):
                outs = [run(reminder, hook_event_name="UserPromptSubmit", session_id=self.session, cwd=self.dir, prompt=prompt) for _ in range(5)]
                for out in outs:
                    self.assertRegex(out, r"\A今: \d{4}-\d{2}-\d{2} \d{2}:\d{2}（date の出力）\n\Z", prompt)

    def test_the_claude_main_with_a_cockpit_gets_no_periodic_reminder(self):
        os.makedirs(os.path.join(self.dir, ".orca"))
        with open(os.path.join(self.dir, ".orca", "cockpit.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": 2, "workspace": {"name": "案件"}, "streams": [], "tasks": [], "cards": []}, fh)
        payload = json.dumps({"hook_event_name": "UserPromptSubmit", "session_id": self.session, "cwd": self.dir, "prompt": "進捗は？"})
        # Claude の設定は引数なしで呼ぶ（既定の reminder.md）
        outs = [subprocess.run([HOOK], input=payload, text=True, check=True, stdout=subprocess.PIPE).stdout for _ in range(5)]
        self.assertFalse(any("【定期リマインド】" in o for o in outs))
        self.assertTrue(all("（date の出力）" in o for o in outs))
        # Codex は第 1 引数で自分の reminder を渡し、今の順番を受け取らないので念押しを保つ
        outs = [run(self.reminder, hook_event_name="UserPromptSubmit", session_id=self.session, cwd=self.dir, prompt="進捗は？") for _ in range(5)]
        self.assertIn("リマインドの本文", outs[-1])
        self.assertFalse(any("【操縦席】" in o for o in outs))

    def test_every_prompt_states_the_current_time(self):
        # 11/21 に、担当が 20:07 を 20:20、窓口が 20:05 を 20:25 と推し量って書いた
        out = run(self.reminder, hook_event_name="UserPromptSubmit", session_id=self.session)
        self.assertRegex(out, r"(?m)^今: \d{4}-\d{2}-\d{2} \d{2}:\d{2}（date の出力）$")


if __name__ == "__main__":
    unittest.main()
