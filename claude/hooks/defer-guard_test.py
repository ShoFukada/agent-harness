#!/usr/bin/env python3
"""defer-guard.py が、都合での先送りで終える発言と worker_done を 1 回だけ差し戻し、外の理由で待つものは止めないことを保証する。"""

import json
import os
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "defer-guard.py")

# 止めるもの: 窓口・担当・worker の都合での先送り
DEFERS = [
    "skill の整理は窓の作り直しが落ち着いてから進めます。",
    "移し替えは 12 月に進める。",
    "残りは来月やります。",
    "この直しは別 PR で入れます。",
    "テストの追加は次の PR にします。",
    "細かい点は申し送りとして残します。",
    "残りは後で対応します。",
    "残りは別 PR で対応することにしました。",
    "残りは別 PR で対応するので今は触りません。",
    "> 完了\n\n残りは別 PR で直す。",
    "残りは申し送りに書いておく。",
    "残りは別 PR で新たに実装します。",
    "12 月に進める予定にした。",
    "一段落してから手を付けます。",
    "当面は様子を見ます。",
    "ほかの作業とぶつかるので後回しにします。",
    "命名の揺れは TODO として残す。",
]

# 止めないもの: 日付で初めて取れるデータ・外の相手の返事・済んだこと・決まりの説明
KEEPS = [
    "12/4 にログイン切れの通知を確かめる。",
    "12 月 4 日にログイン切れの通知が出たかを確かめる。",
    "12 月 4 日のリリースに合わせて本番へ入れる。",
    "先方の担当者の返事が届いたら、検証環境へ入れる日程を決める。",
    "worker の結果が届いたあとで main に入れる。",
    "11 月に対応した分は main に入っている。",
    "2026 年 11 月に整理を進めた。",
    "後回しにせず、今のターンで直した。",
    "申し送りや TODO を作らない決まりにした。",
    "見つけた書き方は「別 PR で」「落ち着いてから」「12 月に」の 3 つ。",
    "`様子を見る` を検索語に入れた。",
    "> 窓の作り直しが落ち着いてから進める\n\nこの引用は以前の発言で、今は全部片付けた。",
    "12 月の請求データを確かめる。",
    "12/4 に初めてログが集まったら通知を確認します。",
    "申し送りは不要です。",
    "命名の揺れは別 PR で修正済み。",
    "TODO を残さない。",
    "別 PR でログイン切れの通知を修正しました。",
    "来週の定例で聞く項目を確認のカードにした。",
]


class DeferGuard(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def run_hook(self, payload):
        done = subprocess.run([HOOK], input=json.dumps(payload), text=True, capture_output=True,
                              env={**os.environ, "TMPDIR": self.dir.name})
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        return json.loads(done.stdout) if done.stdout.strip() else None

    def stop(self, msg, active=False):
        return self.run_hook({"hook_event_name": "Stop", "session_id": "s1", "stop_hook_active": active,
                              "last_assistant_message": msg})

    def send(self, command, session="s1"):
        return self.run_hook({"hook_event_name": "PreToolUse", "session_id": session, "tool_name": "Bash",
                              "tool_input": {"command": command}})

    def test_stop_blocks_defers(self):
        for msg in DEFERS:
            with self.subTest(msg=msg):
                out = self.stop(msg)
                self.assertIsNotNone(out, msg)
                self.assertEqual(out["decision"], "block")
                self.assertIn("外の理由", out["reason"])

    def test_stop_keeps_external_waits_and_mentions(self):
        for msg in KEEPS:
            with self.subTest(msg=msg):
                self.assertIsNone(self.stop(msg), msg)

    def test_stop_lets_second_try_through(self):
        self.assertIsNone(self.stop(DEFERS[0], active=True))

    def test_worker_done_denied_once_then_passes(self):
        cmd = 'orca orchestration send --from term_x --type worker_done --subject "済" --body "直した。残りは別 PR で入れる。" --task-id t1'
        out = self.send(cmd)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("別 PR で", out["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertIsNone(self.send(cmd))
        # 別のセッションでは数えない
        self.assertEqual(self.send(cmd, session="s2")["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_worker_done_body_file(self):
        body = os.path.join(self.dir.name, "body.md")
        with open(body, "w", encoding="utf-8") as fh:
            fh.write("直した。命名の揺れは落ち着いてから直す。")
        out = self.send("orca orchestration send --from term_x --type worker_done --body-file %s" % body)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        # 同じ本文なら、別の名前のファイルから打ち直しても通す
        other = os.path.join(self.dir.name, "other.md")
        with open(other, "w", encoding="utf-8") as fh:
            fh.write("直した。命名の揺れは落ち着いてから直す。")
        self.assertIsNone(self.send("orca orchestration send --type worker_done --body-file %s" % other))

    def test_worker_done_body_file_env_and_relative(self):
        with open(os.path.join(self.dir.name, "r.md"), "w", encoding="utf-8") as fh:
            fh.write("残りは後で対応します。")
        out = self.send('orca orchestration send --type worker_done --body-file "$TMPDIR/r.md"')
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        out = self.run_hook({"hook_event_name": "PreToolUse", "session_id": "s9", "cwd": self.dir.name, "tool_name": "Bash",
                             "tool_input": {"command": "orca orchestration send --type=worker_done --body-file r.md"}})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_worker_done_judges_body_only(self):
        self.assertIsNone(self.send('orca orchestration send --type worker_done --subject "別 PR で" --body "別 PR で修正済み" --task-id t1'))

    def test_worker_done_ignores_other_commands_in_chain(self):
        self.assertIsNone(self.send('gh pr create --body "別 PR で直す" && orca orchestration send --type worker_done --body "完了した。"'))
        out = self.send('git add -A && orca orchestration send --type worker_done --body "残りは来月やります。"')
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_worker_done_passes_when_record_fails(self):
        blocked = os.path.join(self.dir.name, "claude-defer-guard")
        with open(blocked, "w") as fh:
            fh.write("")  # ディレクトリを作れなくする
        self.assertIsNone(self.send('orca orchestration send --type worker_done --body "残りは別 PR で入れる。"'))

    def test_other_commands_pass(self):
        self.assertIsNone(self.send('orca orchestration send --type worker_done --body "全部直して commit した。"'))
        self.assertIsNone(self.send('git commit -m "別 PR で直す"'))
        self.assertIsNone(self.send('orca orchestration send --type escalation --body "12 月に進める"'))

    def test_text_mode(self):
        done = subprocess.run([HOOK, "--text", "移し替えは 12 月に進める。"], text=True, capture_output=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn("12 月に進め", done.stdout)
        done = subprocess.run([HOOK, "--text", "12/4 にログイン切れの通知を確かめる。"], text=True, capture_output=True)
        self.assertEqual((done.returncode, done.stdout), (0, ""))

    def test_bad_input_is_silent(self):
        done = subprocess.run([HOOK], input="not json", text=True, capture_output=True)
        self.assertEqual((done.returncode, done.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
