#!/usr/bin/env python3
"""orca-launch のテスト。orca は ORCA_CLI_COMMAND で偽物に差し替え、呼ばれた引数を記録する。"""

import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCH = os.path.join(HERE, "orca-launch")
_loader = SourceFileLoader("orca_launch", LAUNCH)
ol = importlib.util.module_from_spec(importlib.util.spec_from_loader("orca_launch", _loader))
_loader.exec_module(ol)
HEAD, NAME_MAX = ol.name_rule()
RULES = "## どの worker にも渡す決まり\n- 操縦席を書かない\n- 途中経過を送らない"

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as fh:
    fh.write(json.dumps(args) + "\n")
def out(result): print(json.dumps({"ok": True, "result": result}))
if args[:2] == ["worktree", "show"]:
    out({"worktree": {"path": os.environ["FAKE_WT"], "id": "r::wt", "parentWorktreeId": os.environ.get("FAKE_PARENT")}})
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
        # 決まりの文言はリポジトリの中から読むので、入口と読む相手を一時のリポジトリの形に写して差し替える
        repo = os.path.join(self.tmp, "repo")
        for rel in ("bin/orca-launch", "bin/stallwatch", "orca/plugins/cockpit/src/state.ts"):
            os.makedirs(os.path.dirname(os.path.join(repo, rel)), exist_ok=True)
            shutil.copy(os.path.join(HERE, "..", rel), os.path.join(repo, rel))
        self.launch = os.path.join(repo, "bin", "orca-launch")
        self.rules = os.path.join(repo, "claude", "skills", "worktree-flow", "references", "worker-rules.md")
        os.makedirs(os.path.dirname(self.rules))
        with open(self.rules, "w") as fh:
            fh.write(RULES + "\n")
        self.env = {**{k: v for k, v in os.environ.items() if k != "ORCA_WORKTREE_ID"}, "ORCA_CLI_COMMAND": fake, "FAKE_LOG": self.log, "FAKE_WT": self.wt,
                    "CLAUDE_CONFIG_DIR": self.cfg, "ORCA_WORKER_SETTINGS": "/s/worker.json",
                    "STALLWATCH_HOME": os.path.join(self.tmp, "stallwatch"), "HOME": self.tmp}

    def run_launch(self, *extra, title="t", **env):
        return subprocess.run([sys.executable, self.launch, "--worktree", "path:" + self.wt, "--title", title,
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
        self.assertIn("--model opus --settings /s/worker.json", cmd)
        start = next(x for x in self.calls() if x[:2] == ["orchestration", "worker-start"])
        self.assertEqual(start[start.index("--terminal") + 1], "term_x")
        self.assertEqual(self.spec_text(), RULES + "\n\nbrief\n")
        self.assertIn("--keep-open", start)
        self.assertEqual(create[create.index("--title") + 1], "作業｜t")
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertEqual(setw[setw.index("--display-name") + 1], "作業｜t")
        self.assertEqual(setw[setw.index("--workspace-status") + 1], "in-progress")
        self.assertEqual(json.loads(r.stdout)["dispatchId"], "ctx_1")

    def test_name_over_the_limit_is_refused_before_anything_starts(self):
        # 頭の「作業｜」も含めて上限を超えたら、何も起こさずに断る（R146・R181）。上限ちょうどは通す。
        title = "あ" * (NAME_MAX - len(HEAD))
        r = self.run_launch(title=title)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("名前「%s｜%s」が %d 字で、上限の %d 字を超える" % (HEAD, title, NAME_MAX + 1, NAME_MAX), r.stderr)
        self.assertFalse(os.path.exists(self.log), "orca を 1 回も呼ばない")
        r = self.run_launch(title=title[1:])
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertEqual(create[create.index("--title") + 1], "%s｜%s" % (HEAD, title[1:]))

    def test_worktree_without_parent_hangs_under_the_launcher(self):
        # 担当が --title で立てる worker: 作ったときに親が付かなかった worktree は、立てる人の作業場所の子にする。
        r = self.run_launch(ORCA_WORKTREE_ID="r::lead")
        self.assertEqual(r.returncode, 0, r.stderr)
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertEqual(setw[setw.index("--parent-worktree") + 1], "id:r::lead")

    def test_worktree_parent_recorded_at_creation_is_kept(self):
        r = self.run_launch(ORCA_WORKTREE_ID="r::lead", FAKE_PARENT="r::other")
        self.assertEqual(r.returncode, 0, r.stderr)
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertNotIn("--parent-worktree", setw)

    def test_worktree_without_parent_or_launcher_is_named(self):
        r = self.run_launch()
        self.assertEqual(r.returncode, 0, r.stderr)
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertNotIn("--parent-worktree", setw)
        self.assertIn("親を付けていない", r.stderr)

    def test_rules_are_added_once(self):
        # 渡した brief（先頭に決まりが入ったもの）で打ち直しても、決まりは 1 回だけ。
        with open(self.spec, "w") as fh:
            fh.write(RULES + "\n\nbrief\n")
        r = self.run_launch()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.spec_text().count(RULES), 1)
        self.assertEqual(self.spec_text(), RULES + "\n\nbrief\n")

    def test_cockpit_name_over_the_limit_asks_orca_nothing(self):
        # 担当のいるタスクでも、担当の worktree を Orca に問い合わせる前に断る（Codex 高）。
        root = self.cockpit([{"id": "o1", "title": "x", "stream": "s1", "session": "sess_lead", "state": "open"}])
        with open(os.path.join(root, ".orca", "cockpit.json")) as fh:
            c = json.load(fh)
        c["tasks"][0]["title"] = "あ" * NAME_MAX
        with open(os.path.join(root, ".orca", "cockpit.json"), "w") as fh:
            json.dump(c, fh)
        r = self.run_cockpit(root)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("cockpit-write で直す", r.stderr)
        self.assertFalse(os.path.exists(self.log), "orca を 1 回も呼ばない")

    def test_blank_rules_refuse(self):
        with open(self.rules, "w") as fh:
            fh.write(" \n\n")
        r = self.run_launch()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("決まり", r.stderr)
        self.assertFalse(os.path.exists(self.log))

    def test_missing_rules_refuses(self):
        os.remove(self.rules)
        r = self.run_launch()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("worker に渡す決まり", r.stderr)
        self.assertFalse(os.path.exists(self.log))

    def test_rules_live_in_this_repo(self):
        with open(ol.WORKER_RULES, encoding="utf-8") as fh:
            self.assertTrue(fh.read().strip())

    def test_follows_the_seat_orca_has_selected(self):
        # 席を切り替えた直後で、まだ古い席で動いている担当（CLAUDE_CONFIG_DIR は古い席）から立てても、新しい席で起動する。
        accounts = {"activeAccountId": "b", "accounts": [{"id": "a", "home": self.cfg}, {"id": "b", "home": "/p/b/home"}]}
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps(accounts))
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertTrue(create[create.index("--command") + 1].startswith("env CLAUDE_CONFIG_DIR=/p/b/home ORCA_WORKER_SETTINGS=/s/worker.json claude "))

    def launch_command(self, *extra, env=None):
        r = subprocess.run([sys.executable, self.launch, "--worktree", "path:" + self.wt, "--title", "t", "--spec-file", self.spec, *extra],
                           capture_output=True, text=True, env=env or self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        return create[create.index("--command") + 1]

    def test_given_settings_reach_helper_bins_over_the_default(self):
        # claude/bin の入口は denyRead を $ORCA_WORKER_SETTINGS から読むので、選んだ設定を --settings と同じ絶対パスで渡す
        cmd = self.launch_command("--settings", "~/verify.json")
        given = os.path.join(self.tmp, "verify.json")
        self.assertIn("ORCA_WORKER_SETTINGS=%s claude --model opus --settings %s" % (given, given), cmd)
        self.assertNotIn("/s/worker.json", cmd)

    def test_given_settings_reach_helper_bins_without_the_default(self):
        env = {k: v for k, v in self.env.items() if k != "ORCA_WORKER_SETTINGS"}
        cmd = self.launch_command("--settings", "/s/verify.json", env=env)
        self.assertIn("ORCA_WORKER_SETTINGS=/s/verify.json claude --model opus --settings /s/verify.json", cmd)

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
        cmd = create[create.index("--command") + 1]
        self.assertTrue(cmd.startswith("env ORCA_WORKER_SETTINGS=/s/worker.json claude "), cmd)
        self.assertNotIn("CLAUDE_CONFIG_DIR", cmd)

    def test_blocked_prompt_does_not_dispatch(self):
        r = self.run_launch("--run", "run_9", "--keep-open", FAKE_BLOCKED="agent-trust-workspace")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("agent-trust-workspace", r.stderr)
        # やり直しのコマンドに、呼んだときの --run と --keep-open が残る
        self.assertIn("--terminal term_x --keep-open --run run_9", r.stderr)
        # やり直しのコマンドが渡す brief は、決まりを先頭に 1 回だけ足したもの
        retry = r.stderr.split("--spec-file ", 1)[1].split(" ", 1)[0]
        with open(retry) as fh:
            self.assertEqual(fh.read(), RULES + "\n\nbrief\n")
        self.assertFalse(any(x[:2] == ["orchestration", "worker-start"] for x in self.calls()))

    def test_blocked_prompt_names_the_seat_and_the_screen(self):
        accounts = {"activeAccountId": "c", "accounts": [{"id": "c", "home": "/p/c/home", "email": "seat-c@example.com"}]}
        screen = ["● 前の会話の続き: Do you trust の話をした", "", "Accessing workspace:", "/w/failover-fix",
                  "Quick safety check: Is this a project you created or one you trust?", "❯ 1. Yes, I trust this folder", "  2. No, exit"]
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps(accounts), FAKE_BLOCKED="agent-trust-workspace", FAKE_SCREEN=json.dumps(screen))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("席 seat-c@example.com の端末 term_x が「フォルダを信頼するかの確認", r.stderr)
        self.assertIn("  | ❯ 1. Yes, I trust this folder", r.stderr)
        self.assertFalse(any(x[:2] == ["orchestration", "worker-start"] for x in self.calls()))

    def test_screen_orca_does_not_know_is_named_on_timeout(self):
        # auto mode の確認の画面は Orca の blockedReason に出ず、入力待ちにならないまま時間切れになる。
        accounts = {"activeAccountId": "c", "accounts": [{"id": "c", "home": "/p/c/home", "email": "seat-c@example.com"}]}
        screen = ["Auto mode lets Claude handle permission prompts automatically.", "❯ Yes, set auto mode as my default permission mode",
                  "  No, keep bypass permissions"]
        r = self.run_launch(FAKE_ACCOUNTS=json.dumps(accounts), FAKE_SCREEN=json.dumps(screen))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("席 seat-c@example.com の端末 term_x が「auto mode を既定にするかの確認」で止まっている", r.stderr)
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
        return subprocess.run([sys.executable, self.launch, "--worktree", "path:" + self.wt, "--cockpit-task", "t65", "--cockpit-root", root,
                               "--spec-file", self.spec], capture_output=True, text=True, env=self.env)

    def test_cockpit_task_names_parents_and_passes_done_when(self):
        root = self.cockpit([{"id": "o1", "title": "窓の版 3", "stream": "s1", "session": "sess_lead", "state": "open"}])
        r = self.run_cockpit(root)
        self.assertEqual(r.returncode, 0, r.stderr)
        (setw,) = [x for x in self.calls() if x[:2] == ["worktree", "set"]]
        self.assertEqual(setw[setw.index("--display-name") + 1], "作業｜窓の版 3")
        self.assertEqual(setw[setw.index("--comment") + 1], "操縦席の窓 › t65｜worker が作業中")
        self.assertEqual(setw[setw.index("--parent-worktree") + 1], "id:repo::/lead")
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertEqual(create[create.index("--title") + 1], "作業｜窓の版 3")
        spec = self.spec_text()
        self.assertTrue(spec.startswith(RULES + "\n\nbrief\n\n## 済の条件"))
        self.assertEqual(spec.count(RULES), 1)
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
        r = subprocess.run([sys.executable, self.launch, "--worktree", "path:" + self.wt, "--cockpit-task", "t99", "--cockpit-root", root,
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
