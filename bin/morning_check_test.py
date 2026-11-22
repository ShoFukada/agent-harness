import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "morning-check")
NOW = "2026-11-22T08:00:00+09:00"


def task(tid, state, **kw):
    return dict({"id": tid, "title": "タスク" + tid, "state": state, "next": "次の手" + tid}, **kw)


class MorningCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "ws")
        os.makedirs(os.path.join(self.root, ".orca"))
        self.dir = os.path.join(self.tmp, "cockpit")
        os.makedirs(self.dir)
        self.cockpit = {"version": 2, "tasks": [], "cards": [], "requests": []}
        self.judged = None  # state.ts の判定。None なら操縦席の state をそのまま返す
        self.alerts = None

    def run_check(self, state_fails=False, orca="ok", raw=None):
        with open(os.path.join(self.root, ".orca", "cockpit.json"), "w") as fh:
            fh.write(raw if raw is not None else json.dumps(self.cockpit))
        if self.alerts is not None:
            with open(os.path.join(self.dir, "alerts.json"), "w") as fh:
                json.dump({"alerts": self.alerts}, fh)
        judged = self.judged or {t["id"]: t["state"] for t in self.cockpit["tasks"] if t}
        fake = os.path.join(self.tmp, "state.js")
        with open(fake, "w") as fh:
            fh.write("process.exit(1)" if state_fails else "console.log(%s)" % json.dumps(json.dumps(
                {"orca": orca, "tasks": [{"id": k, "state": v} for k, v in judged.items()]})))
        env = dict(os.environ, COCKPIT_DIR=self.dir, COCKPIT_STATE=fake)
        r = subprocess.run([sys.executable, SCRIPT, "--cockpit", os.path.join(self.root, ".orca", "cockpit.json"), "--now", NOW],
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_nothing_prints_nothing(self):
        self.cockpit["tasks"] = [task("t1", "ok", done=[{"text": "済", "at": "2026-11-01T00:00:00+09:00"}]),
                                 task("t2", "run"), task("t3", "wait", waiting_since="2026-11-20T08:00:01+09:00")]
        self.alerts = []
        self.assertEqual(self.run_check(), "")

    def test_check_on_today_is_picked_tomorrow_is_not(self):
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2026-11-22"), task("t2", "wait", check_on="2026-11-23"),
                                 task("t3", "run", check_on="2026-11-21"), task("t4", "ok", check_on="2026-11-01")]
        out = self.run_check()
        self.assertIn("### 確認日が来たタスク", out)
        self.assertIn("- タスクt1（t1、待機、確認日11/22）：次の手t1", out)
        self.assertIn("- タスクt3（t3、作業中、確認日11/21）", out)
        self.assertNotIn("t2", out)
        self.assertNotIn("t4", out)

    def test_task_without_check_on_is_not_due(self):
        self.cockpit["tasks"] = [task("t1", "run")]
        self.assertEqual(self.run_check(), "")

    def test_unreadable_check_on_is_reported(self):
        self.cockpit["tasks"] = [task("t1", "idle", check_on="あした")]
        self.assertIn("- タスクt1（t1、未着手、確認日を読めない：あした）", self.run_check())

    def test_judged_state_wins_over_record(self):
        # worker の記録があるタスクは state.ts の判定を使う。記録の上では wait でも、判定が ok なら拾わない
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2026-11-20")]
        self.judged = {"t1": "ok"}
        self.assertEqual(self.run_check(), "")

    def test_stale_at_exactly_72_hours(self):
        self.cockpit["tasks"] = [
            task("t1", "wait", waiting_since="2026-11-19T08:00:00+09:00", waiting_on="BW のマージ"),
            task("t2", "idle", done=[{"text": "a", "at": "2026-11-19T08:00:01+09:00"}]),
            task("t3", "run", waiting_since="2026-11-01T00:00:00+09:00"),
            task("t4", "ok", waiting_since="2026-11-01T00:00:00+09:00"),
        ]
        out = self.run_check()
        self.assertIn("### 動きの無いタスク（未着手・待機のまま3日以上）", out)
        self.assertIn("- タスクt1（t1、待機、最後の動き11/19 08:00）：BW のマージ", out)
        self.assertNotIn("t2", out)
        self.assertNotIn("t3", out)
        self.assertNotIn("t4", out)

    def test_latest_move_comes_from_cards_and_requests(self):
        old = [{"text": "a", "at": "2026-11-01T00:00:00+09:00"}]
        self.cockpit["tasks"] = [task("t1", "wait", done=old), task("t2", "idle", done=old), task("t3", "idle", done=old)]
        # カードの resolved_at は UTC の Z で書かれていることがある（11/21 13:00 JST）
        self.cockpit["cards"] = [{"id": "d1", "tasks": ["t1"], "at": "2026-11-01T00:00:00+09:00", "resolved_at": "2026-11-21T04:00:00.000Z"}]
        self.cockpit["requests"] = [{"id": "r1", "tasks": ["t2"], "at": "2026-11-20T00:00:00+09:00"}]
        out = self.run_check()
        self.assertNotIn("t1", out)
        self.assertNotIn("t2", out)
        self.assertIn("- タスクt3（t3、未着手、最後の動き11/1 00:00）", out)

    def test_task_without_any_move_is_stale(self):
        self.cockpit["tasks"] = [task("t1", "idle", done=["文字列だけの記録"]), task("t2", "idle", done=[], check_on="2026-12-04")]
        out = self.run_check()
        self.assertIn("- タスクt1（t1、未着手、動きの記録なし）：次の手t1", out)
        # 先の確認日が入っていれば、その日まで待つと決めてあるので拾わない
        self.assertNotIn("t2", out)

    def test_due_task_is_listed_once(self):
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2026-11-22")]
        out = self.run_check()
        self.assertEqual(out.count("タスクt1"), 1)
        self.assertNotIn("動きの無いタスク", out)

    def test_alerts_for_this_workspace_and_harness_only(self):
        self.alerts = [{"id": "a", "text": "窓のサーバーが落ちた", "root": None},
                       {"id": "b", "text": "nix-darwin のメインが止まった", "root": self.root + "/"},
                       {"id": "c", "text": "pasona のメインが止まった", "root": "/somewhere/pasona"}]
        out = self.run_check()
        self.assertIn("### 止まったもの\n- 窓のサーバーが落ちた\n- nix-darwin のメインが止まった\n", out)
        self.assertNotIn("pasona", out)

    def test_no_alerts_file_is_quiet(self):
        self.assertEqual(self.run_check(), "")

    def test_state_failure_falls_back_to_record(self):
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2026-11-22")]
        out = self.run_check(state_fails=True)
        self.assertIn("- タスクt1（t1、待機、確認日11/22）", out)
        self.assertIn("### 読めなかったもの\n- 状態の判定が失敗", out)

    def test_orca_error_counts_as_state_failure(self):
        # Orca を読めないと state.ts は正常終了で orca: "error" を返す
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2026-11-22")]
        self.assertIn("### 読めなかったもの\n- 状態の判定が失敗", self.run_check(orca="error"))

    def test_broken_cockpit_still_reports_alerts(self):
        self.alerts = [{"id": "a", "text": "窓のサーバーが落ちた", "root": None}]
        out = self.run_check(raw="{壊れた")
        self.assertIn("### 止まったもの\n- 窓のサーバーが落ちた", out)
        self.assertIn("- 操縦席を読めない", out)

    def test_check_on_with_trailing_text_is_unreadable(self):
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2099-01-01oops")]
        self.assertIn("確認日を読めない：2099-01-01oops", self.run_check())

    def test_unexpected_shape_is_reported_not_silent(self):
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2026-11-22"), None]
        self.assertIn("- 朝の定期確認が失敗（AttributeError", self.run_check())

    def test_header_has_time(self):
        self.cockpit["tasks"] = [task("t1", "wait", check_on="2026-11-22")]
        self.assertTrue(self.run_check().startswith("朝の定期確認（11/22 08:00時点）\n\n### 確認日が来たタスク\n"))


if __name__ == "__main__":
    unittest.main()
