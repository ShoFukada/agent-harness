#!/usr/bin/env python3
"""orca-launch のテスト。orca は ORCA_CLI_COMMAND で偽物に差し替え、呼ばれた引数を記録する。"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCH = os.path.join(HERE, "orca-launch")

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as fh:
    fh.write(json.dumps(args) + "\n")
def out(result): print(json.dumps({"ok": True, "result": result}))
if args[:2] == ["worktree", "show"]:
    out({"worktree": {"path": os.environ["FAKE_WT"], "id": "r::wt"}})
elif args[:2] == ["worktree", "set"]:
    out({})
elif args[:2] == ["terminal", "create"]:
    out({"terminal": {"handle": "term_x"}})
elif args[:2] == ["terminal", "wait"]:
    blocked = os.environ.get("FAKE_BLOCKED")
    stuck = blocked or os.environ.get("FAKE_SCREEN")
    out({"wait": {"satisfied": not stuck, "status": "running", **({"blockedReason": blocked} if blocked else {})}})
elif args[:2] == ["terminal", "read"]:
    out({"terminal": {"tail": json.loads(os.environ.get("FAKE_SCREEN") or "[]")}})
elif args[:2] == ["account", "list"] and os.environ.get("FAKE_ACCOUNTS"):
    seen = sum(1 for l in open(os.environ["FAKE_LOG"]) if '"account", "list"' in l)
    later = os.environ.get("FAKE_ACCOUNTS_LATER")
    out(json.loads(later if later and seen > 1 else os.environ["FAKE_ACCOUNTS"]))
elif args[:2] == ["terminal", "close"]:
    out({})
elif args[:2] == ["orchestration", "worker-start"]:
    spec = args[args.index("--spec-file") + 1]
    with open(os.environ["FAKE_LOG"] + ".spec", "w") as fh:
        fh.write(open(spec).read())
    out({"runId": "run_1", "taskId": "task_1", "dispatchId": "ctx_1", "terminal": "term_x", "state": "ready"})
elif args[:2] == ["agent", "list"]:
    out({"agents": [{"orcaSessionId": "sess_lead", "worktreeId": "repo::/lead"}]})
elif args[:2] == ["terminal", "list"]:
    out({"terminals": []})
'''


class LaunchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.wt = os.path.join(self.tmp, "wt")
        self.cfg = os.path.join(self.tmp, "cfg")
        fake = os.path.join(self.tmp, "orca")
        with open(fake, "w") as fh:
            fh.write(FAKE)
        os.chmod(fake, 0o755)
        self.log = os.path.join(self.tmp, "log")
        self.spec = os.path.join(self.tmp, "brief.md")
        with open(self.spec, "w") as fh:
            fh.write("brief")
        self.env = {**{k: v for k, v in os.environ.items() if k != "ORCA_WORKTREE_ID"}, "ORCA_CLI_COMMAND": fake, "FAKE_LOG": self.log, "FAKE_WT": self.wt,
                    "CLAUDE_CONFIG_DIR": self.cfg, "ORCA_WORKER_SETTINGS": "/s/worker.json",
                    "STALLWATCH_HOME": os.path.join(self.tmp, "stallwatch")}

    def run_launch(self, *extra, **env):
        return subprocess.run([sys.executable, LAUNCH, "--worktree", "path:" + self.wt, "--title", "t",
                               "--spec-file", self.spec, *extra], capture_output=True, text=True,
                              env={**self.env, **env})

    def calls(self):
        with open(self.log) as fh:
            return [json.loads(l) for l in fh]

    def test_starts_with_account_model_settings(self):
        r = self.run_launch("--keep-open")
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        cmd = create[create.index("--command") + 1]
        self.assertIn("CLAUDE_CONFIG_DIR=" + self.cfg, cmd)
        # 席の切り替えで Orca が --settings を落としたとき、account-failover が戻せるよう端末と設定を記録する。
        with open(os.path.join(self.tmp, "stallwatch", "worker-launches.json")) as fh:
            rec = json.load(fh)
        self.assertEqual({h: (r["settings"], r["model"]) for h, r in rec.items()}, {"term_x": ("/s/worker.json", "opus")})
        self.assertIn("--model opus --settings /s/worker.json", cmd)
        start = next(x for x in self.calls() if x[:2] == ["orchestration", "worker-start"])
        self.assertEqual(start[start.index("--terminal") + 1], "term_x")
        self.assertEqual(start[start.index("--spec-file") + 1], self.spec)
        self.assertIn("--keep-open", start)
        self.assertEqual(create[create.index("--title") + 1], "t（worker）")
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertEqual(setw[setw.index("--display-name") + 1], "t")
        self.assertEqual(setw[setw.index("--workspace-status") + 1], "in-progress")
        self.assertEqual(json.loads(r.stdout)["dispatchId"], "ctx_1")

    def test_follows_the_seat_orca_has_selected(self):
        # account-failover が席を切り替えたあと、元の席に残った担当（CLAUDE_CONFIG_DIR は古い席）から立てても、新しい席で起動する。
        accounts = {"activeAccountId": "b", "accounts": [{"id": "a", "home": self.cfg}, {"id": "b", "home": "/p/b/home"}]}
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps(accounts))
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertTrue(create[create.index("--command") + 1].startswith("env CLAUDE_CONFIG_DIR=/p/b/home claude "))

    def test_seat_switched_while_starting_closes_the_terminal(self):
        a = {"activeAccountId": "a", "accounts": [{"id": "a", "home": "/p/a/home"}, {"id": "b", "home": "/p/b/home"}]}
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps(a), FAKE_ACCOUNTS_LATER=json.dumps(dict(a, activeAccountId="b")))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("席が切り替わった", r.stderr)
        self.assertTrue(any(x[:2] == ["terminal", "close"] for x in self.calls()))
        self.assertFalse(any(x[:2] == ["orchestration", "worker-start"] for x in self.calls()))

    def test_system_default_seat_sets_no_config_dir(self):
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps({"activeAccountId": None, "accounts": [{"id": "a", "home": self.cfg}]}))
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertTrue(create[create.index("--command") + 1].startswith("claude "))

    def test_blocked_prompt_does_not_dispatch(self):
        r = self.run_launch("--run", "run_9", "--keep-open", FAKE_BLOCKED="agent-trust-workspace")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("agent-trust-workspace", r.stderr)
        # やり直しのコマンドに、呼んだときの --run と --keep-open が残る
        self.assertIn("--terminal term_x --keep-open --run run_9", r.stderr)
        self.assertFalse(any(x[:2] == ["orchestration", "worker-start"] for x in self.calls()))

    def test_blocked_prompt_names_the_seat_and_the_screen(self):
        accounts = {"activeAccountId": "c", "accounts": [{"id": "c", "home": "/p/c/home", "email": "member@example.com"}]}
        screen = ["● 前の会話の続き: Do you trust の話をした", "", "Accessing workspace:", "/w/failover-fix",
                  "Quick safety check: Is this a project you created or one you trust?", "❯ 1. Yes, I trust this folder", "  2. No, exit"]
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps(accounts), FAKE_BLOCKED="agent-trust-workspace", FAKE_SCREEN=json.dumps(screen))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("席 member@example.com の端末 term_x が「フォルダを信頼するかの確認", r.stderr)
        self.assertIn("  | ❯ 1. Yes, I trust this folder", r.stderr)
        self.assertFalse(any(x[:2] == ["orchestration", "worker-start"] for x in self.calls()))

    def test_screen_orca_does_not_know_is_named_on_timeout(self):
        # auto mode の確認の画面は Orca の blockedReason に出ず、入力待ちにならないまま時間切れになる。
        accounts = {"activeAccountId": "c", "accounts": [{"id": "c", "home": "/p/c/home", "email": "member@example.com"}]}
        screen = ["Auto mode lets Claude handle permission prompts automatically.", "❯ Yes, set auto mode as my default permission mode",
                  "  No, keep bypass permissions"]
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps(accounts), FAKE_SCREEN=json.dumps(screen))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("席 member@example.com の端末 term_x が「auto mode を既定にするかの確認」で止まっている", r.stderr)
        self.assertFalse(any(x[:2] == ["orchestration", "worker-start"] for x in self.calls()))

    def test_own_worktree_keeps_its_name(self):
        r = self.run_launch(ORCA_WORKTREE_ID="r::wt")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(any(x[:2] == ["worktree", "set"] for x in self.calls()))

    def cockpit(self, owners, said=None, utter=None):
        root = os.path.join(self.tmp, "root")
        os.makedirs(os.path.join(root, ".orca", "cockpit"))
        if utter:
            with open(os.path.join(root, ".orca", "cockpit", "utterances.jsonl"), "w") as fh:
                fh.write("".join(json.dumps(u, ensure_ascii=False) + "\n" for u in utter) + "{書きかけ")
        with open(os.path.join(root, ".orca", "cockpit.json"), "w") as fh:
            json.dump({"version": 2, "workspace": {"name": "ハーネス"}, "streams": [{"id": "s1", "title": "操縦席の窓"}],
                       "tasks": [{"id": "t65", "stream": "s1", "phase": "実装", "title": "窓の版 3", "state": "run"}],
                       "owners": owners, "cards": [],
                       "requests": [{"id": "r30", "at": "", "title": "上限の判定", "tasks": ["t65"], "done_when": ["LIMIT が 3 行の上限の文言に当たる"],
                                     "utterances": said or []},
                                    {"id": "r31", "at": "", "title": "別の仕事", "tasks": ["t1"], "done_when": ["関係ない"],
                                     "utterances": [{"id": "u-9", "quote": "別の仕事の発言"}]}]}, fh)
        return root

    def run_cockpit(self, root):
        return subprocess.run([sys.executable, LAUNCH, "--worktree", "path:" + self.wt, "--cockpit-task", "t65", "--cockpit-root", root,
                               "--spec-file", self.spec], capture_output=True, text=True, env=self.env)

    def test_cockpit_task_names_parents_and_passes_done_when(self):
        root = self.cockpit([{"id": "o1", "title": "窓の版 3", "stream": "s1", "session": "sess_lead", "state": "open"}])
        r = self.run_cockpit(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertEqual(setw[setw.index("--display-name") + 1], "窓の版 3")
        self.assertEqual(setw[setw.index("--comment") + 1], "操縦席の窓 › t65｜worker が作業中")
        self.assertEqual(setw[setw.index("--parent-worktree") + 1], "id:repo::/lead")
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertEqual(create[create.index("--title") + 1], "窓の版 3（worker）")
        with open(self.log + ".spec") as fh:
            spec = fh.read()
        self.assertTrue(spec.startswith("brief"))
        self.assertIn("- r30#1: LIMIT が 3 行の上限の文言に当たる", spec)
        self.assertNotIn("r31", spec)
        with open(os.path.join(root, ".orca", "cockpit.json")) as fh:
            self.assertIn("t65", fh.read())

    def spec_text(self):
        with open(self.log + ".spec") as fh:
            return fh.read()

    def test_cockpit_task_passes_utterances_verbatim(self):
        # 原文は発言の記録の全文。記録に無い発言は依頼の引用で補う。ほかのタスクの依頼の発言は足さない。
        root = self.cockpit([], said=[{"id": "u-4", "quote": "記録に無い発言"}, {"id": "u-2", "quote": "一行目"}],
                            utter=[{"id": "u-2", "at": "2026-11-21T19:41:00+09:00", "prompt": "一行目\n二行目の細部"}])
        r = self.run_cockpit(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        spec = self.spec_text()
        self.assertIn("- r30#1: LIMIT が 3 行の上限の文言に当たる", spec)
        self.assertIn("深田（u-2）:\n> 一行目\n> 二行目の細部\n\n深田（u-4）:\n> 記録に無い発言\n", spec)
        self.assertNotIn("u-9", spec)
        self.assertNotIn("省いた", spec)

    def test_cockpit_task_keeps_each_quote_and_skips_broken_lines(self):
        # 記録に無い同じ発言を別の依頼が別の箇所で引いたら両方残す。UTF-8 が途中で切れた行があってもほかの行は読む（Codex 中 4・5）
        root = self.cockpit([], said=[{"id": "u-1", "quote": "前半の引用"}],
                            utter=[{"id": "u-3", "at": "", "prompt": "全文"}])
        path = os.path.join(root, ".orca", "cockpit", "utterances.jsonl")
        with open(path, "rb") as fh:
            body = fh.read()
        with open(path, "wb") as fh:
            fh.write('{"id": "u-2", "prompt": "途中'.encode()[:-1] + b"\n" + '{"id": "u-4", "prompt": "壊'.encode()[:-1] + b'"}\n' + body)
        with open(os.path.join(root, ".orca", "cockpit.json")) as fh:
            c = json.load(fh)
        c["requests"].append({"id": "r32", "at": "", "title": "同じ発言", "tasks": ["t65"], "done_when": ["x"],
                              "utterances": [{"id": "u-1", "quote": "後半の引用"}, {"id": "u-3", "quote": "全"}, {"id": "u-4", "quote": "壊れた行の引用"}]})
        with open(os.path.join(root, ".orca", "cockpit.json"), "w") as fh:
            json.dump(c, fh)
        r = self.run_cockpit(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        spec = self.spec_text()
        self.assertIn("深田（u-1）:\n> 前半の引用", spec)
        self.assertIn("深田（u-1）:\n> 後半の引用", spec)
        self.assertIn("深田（u-3）:\n> 全文", spec)
        self.assertIn("深田（u-4）:\n> 壊れた行の引用", spec)
        self.assertNotIn("\ufffd", spec)

    def test_cockpit_task_cuts_old_utterances_over_the_limit(self):
        big = lambda n, ch: {"id": "u-%d" % n, "at": "", "prompt": ch * 5000}
        root = self.cockpit([], said=[{"id": "u-%d" % n, "quote": "x"} for n in (3, 10, 7)],
                            utter=[big(3, "古"), big(7, "中"), big(10, "新")])
        r = self.run_cockpit(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        spec = self.spec_text()
        self.assertIn("深田（u-10）:", spec)
        self.assertNotIn("深田（u-7）:", spec)
        self.assertIn("古い発言 u-7・u-3 を省いた", spec)

    def test_cockpit_task_without_owner_hangs_under_main(self):
        root = self.cockpit([])
        r = self.run_cockpit(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertEqual(setw[setw.index("--parent-worktree") + 1], "path:" + root)

    def test_cockpit_task_unknown(self):
        root = self.cockpit([])
        r = subprocess.run([sys.executable, LAUNCH, "--worktree", "path:" + self.wt, "--cockpit-task", "t99", "--cockpit-root", root,
                            "--spec-file", self.spec], capture_output=True, text=True, env=self.env)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("タスク t99 が無い", r.stderr)

    def test_codex_takes_extra_args(self):
        r = self.run_launch("--agent", "codex", "--", "-m", "gpt-x")
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertEqual(create[create.index("--command") + 1], "codex -m gpt-x")


if __name__ == "__main__":
    unittest.main()
