#!/usr/bin/env python3
"""claude-ro が読むだけの道具でサブスクリプションの claude を呼び、API キーを渡さず、答えだけを out に書くことを保証する。

claude は PATH の先頭に置いた偽物に、orca は ORCA_CLI_COMMAND の偽物に差し替える。本物の claude は呼ばない。
"""

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(os.path.realpath(HERE), "claude-ro")
sys.path.insert(0, os.path.realpath(HERE))
from sandbox_tmp import tmp_root  # noqa: E402

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time
here = os.path.dirname(os.path.realpath(__file__))
mode = open(os.path.join(here, "mode")).read().strip()
stdin = sys.stdin.read()
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "env": dict(os.environ), "stdin": stdin}, ensure_ascii=False) + "\n")
if mode == "hang":
    sys.stderr.write("still thinking\n")
    sys.stderr.flush()
    time.sleep(30)
if mode == "fail":
    sys.stderr.write("not logged in\n")
    sys.exit(1)
error = mode == "error"
print(json.dumps({"type": "result", "is_error": error, "result": "API Error: limit" if error else "Claude: 前提が違う"}, ensure_ascii=False))
'''

FAKE_ORCA = r'''#!/usr/bin/env python3
import json
print(json.dumps({"ok": True, "result": {"activeAccountId": "a2", "accounts": [{"id": "a1", "home": "/seat/one"}, {"id": "a2", "home": "/seat/two"}]}}))
'''


def load():
    loader = importlib.machinery.SourceFileLoader("claude_ro", ENTRY)
    spec = importlib.util.spec_from_loader("claude_ro", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class ClaudeRo(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.d = self.dir.name
        self.bindir = os.path.join(self.d, "bin")
        os.mkdir(self.bindir)
        for name, src in (("claude", FAKE_CLAUDE), ("orca", FAKE_ORCA)):
            with open(os.path.join(self.bindir, name), "w") as f:
                f.write(src)
            os.chmod(os.path.join(self.bindir, name), 0o755)
        self.mode("ok")
        self.repo = os.path.join(self.d, "repo")
        os.mkdir(self.repo)
        self.prompt = os.path.join(self.d, "prompt.md")
        with open(self.prompt, "w", encoding="utf-8") as f:
            f.write("深田: 既定を Gemini にしたい\n")
        self.out = os.path.join(self.d, "out.md")
        self.env = {**os.environ, "PATH": self.bindir + os.pathsep + os.environ["PATH"],
                    "ORCA_CLI_COMMAND": os.path.join(self.bindir, "orca"),
                    "ORCA_WORKER_SETTINGS": os.path.join(HERE, "testdata", "settings.worker.json"),
                    # 従量課金に流れる変数と sandbox の proxy は渡さない
                    "ANTHROPIC_API_KEY": "k", "ANTHROPIC_AUTH_TOKEN": "t", "ANTHROPIC_BASE_URL": "https://example.invalid",
                    "CLAUDE_CODE_USE_BEDROCK": "1", "AWS_BEARER_TOKEN_BEDROCK": "b", "CLAUDE_CODE_USE_VERTEX": "1",
                    "HTTPS_PROXY": "http://127.0.0.1:1", "CLAUDECODE": "1", "CLAUDE_CONFIG_DIR": "/seat/caller"}

    def mode(self, m):
        with open(os.path.join(self.bindir, "mode"), "w") as f:
            f.write(m)

    def calls(self):
        try:
            with open(os.path.join(self.bindir, "calls.jsonl"), encoding="utf-8") as f:
                return [json.loads(line) for line in f]
        except OSError:
            return []

    def run_ro(self, *args, **env):
        return subprocess.run([ENTRY, *args], env=dict(self.env, **env), capture_output=True, text=True)

    def test_reads_only_with_opus_on_the_subscription(self):
        r = self.run_ro(self.repo, self.prompt, self.out)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(self.out, encoding="utf-8") as f:
            self.assertEqual(f.read(), "Claude: 前提が違う")
        (c,) = self.calls()
        argv = c["argv"]
        self.assertEqual(argv[argv.index("--model") + 1], "claude-opus-5-5")
        self.assertEqual(argv[argv.index("--tools") + 1], "Read,Grep,Glob")
        for flag in ("-p", "--restricted", "--strict-mcp-config", "--no-session-persistence"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertNotIn("--dangerously-skip-permissions", argv)
        repo = os.path.realpath(self.repo)
        self.assertEqual(argv[argv.index("--add-dir") + 1], repo)
        s = json.loads(argv[argv.index("--settings") + 1])
        self.assertTrue(s["disableAllHooks"])
        self.assertEqual(s["permissions"]["allow"], [f"Read(/{repo}/**)"])
        aws = os.path.join(os.path.realpath(os.path.expanduser("~")), ".aws")
        self.assertIn(f"Read(/{aws}/**)", s["permissions"]["deny"])
        # 本文は argv に載せず stdin で渡す
        self.assertFalse(any("既定を Gemini" in a for a in argv))
        self.assertEqual(c["stdin"], "深田: 既定を Gemini にしたい\n")
        # API キー・Bedrock・Vertex・proxy の変数を渡さず、席は Orca で選ばれている席
        leaked = [k for k in c["env"] if k.startswith(("ANTHROPIC_", "AWS_", "CLAUDE_CODE_", "HTTPS_PROXY", "CLAUDECODE"))]
        self.assertEqual(leaked, [])
        self.assertEqual(c["env"]["CLAUDE_CONFIG_DIR"], "/seat/two")
        # cwd は使い捨ての空ディレクトリで、終わったら消す
        self.assertNotIn(c["cwd"], (repo, os.path.realpath(self.d)))
        self.assertFalse(os.path.exists(c["cwd"]))

    def test_falls_back_to_the_callers_seat_without_orca(self):
        r = self.run_ro(self.repo, self.prompt, self.out, ORCA_CLI_COMMAND=os.path.join(self.d, "no-orca"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        (c,) = self.calls()
        self.assertEqual(c["env"]["CLAUDE_CONFIG_DIR"], "/seat/caller")

    def test_failure_writes_log_and_no_answer(self):
        for m in ("fail", "error"):
            self.mode(m)
            r = self.run_ro(self.repo, self.prompt, self.out)
            self.assertNotEqual(r.returncode, 0, m)
            self.assertFalse(os.path.exists(self.out), m)
            self.assertIn("ログは", r.stdout)
        with open(self.out + ".log") as f:
            self.assertIn("API Error", f.read())

    def test_timeout_keeps_stderr_in_log(self):
        m = load()
        m.KILL_AFTER = 2
        self.mode("hang")
        with mock.patch.dict(os.environ, self.env):
            self.assertEqual(m.main(["claude-ro", self.repo, self.prompt, self.out]), 124)
        self.assertFalse(os.path.exists(self.out))
        with open(self.out + ".log") as f:
            log = f.read()
        self.assertIn("still thinking", log)
        self.assertIn("打ち切った", log)

    def test_rejects_paths_outside_tmp_root(self):
        r = self.run_ro(self.repo, os.path.expanduser("~/.zshrc"), self.out)
        self.assertNotEqual(r.returncode, 0)
        r = self.run_ro(self.repo, self.prompt, os.path.expanduser("~/claude-ro-should-not-exist.md"))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.calls(), [])  # claude を呼ぶ前に止める
        self.assertFalse(os.path.exists(os.path.expanduser("~/claude-ro-should-not-exist.md")))

    def test_does_not_follow_symlinked_prompt(self):
        link = os.path.join(self.d, "link.md")
        os.symlink(self.prompt, link)
        self.assertNotEqual(self.run_ro(self.repo, link, self.out).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_wrong_arguments(self):
        self.assertNotEqual(self.run_ro(self.repo, self.prompt).returncode, 0)
        self.assertNotEqual(self.run_ro(os.path.join(self.d, "nope"), self.prompt, self.out).returncode, 0)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
