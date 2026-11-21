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
    out({"wait": {"satisfied": not blocked, "status": "running", **({"blockedReason": blocked} if blocked else {})}})
elif args[:2] == ["orchestration", "worker-start"]:
    out({"runId": "run_1", "taskId": "task_1", "dispatchId": "ctx_1", "terminal": "term_x", "state": "ready"})
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
                    "CLAUDE_CONFIG_DIR": self.cfg, "ORCA_WORKER_SETTINGS": "/s/worker.json"}

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

    def test_blocked_prompt_does_not_dispatch(self):
        r = self.run_launch("--run", "run_9", "--keep-open", FAKE_BLOCKED="agent-trust-workspace")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("agent-trust-workspace", r.stderr)
        # やり直しのコマンドに、呼んだときの --run と --keep-open が残る
        self.assertIn("--terminal term_x --keep-open --run run_9", r.stderr)
        self.assertFalse(any(x[:2] == ["orchestration", "worker-start"] for x in self.calls()))

    def test_own_worktree_keeps_its_name(self):
        r = self.run_launch(ORCA_WORKTREE_ID="r::wt")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(any(x[:2] == ["worktree", "set"] for x in self.calls()))

    def test_codex_takes_extra_args(self):
        r = self.run_launch("--agent", "codex", "--", "-m", "gpt-x")
        self.assertEqual(r.returncode, 0, r.stderr)
        create = next(x for x in self.calls() if x[:2] == ["terminal", "create"])
        self.assertEqual(create[create.index("--command") + 1], "codex -m gpt-x")


if __name__ == "__main__":
    unittest.main()
