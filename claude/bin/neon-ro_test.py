#!/usr/bin/env python3
"""neon-ro が読むだけの settings で agy を呼び、本文を stdin で渡し、答えだけを out に書くことを保証する。

agy は PATH の先頭に置いた偽物（agy_testing）に差し替え、受け取った引数・cwd・環境変数・stdin を残す。本物の agy は呼ばない。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(os.path.realpath(HERE), "neon-ro")
sys.path.insert(0, os.path.realpath(HERE))
import agy_testing  # noqa: E402
from sandbox_tmp import tmp_root  # noqa: E402



class NeonRo(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.d = self.dir.name
        self.bindir = bindir = agy_testing.install(self.d)
        self.work = os.path.join(self.d, "work")
        os.mkdir(self.work)
        self.repo = os.path.join(self.d, "repo")
        os.mkdir(self.repo)
        self.prompt = os.path.join(self.d, "prompt.md")
        with open(self.prompt, "w", encoding="utf-8") as f:
            f.write("深田: 既定を Neon にしたい\n")
        self.out = os.path.join(self.d, "out.md")
        self.env = agy_testing.polluted_env(bindir, NEON_LAUNCH_TMP=self.work)

    def run_ro(self, *args, **env):
        return subprocess.run([ENTRY, *args], env=dict(self.env, **env), capture_output=True, text=True)

    def called(self):
        (c,) = agy_testing.calls(self.bindir)
        return c

    def test_passes_body_on_stdin_with_read_only_settings(self):
        r = self.run_ro(self.repo, self.prompt, self.out)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(self.out, encoding="utf-8") as f:
            self.assertEqual(f.read(), "Neon: 前提が違う")
        c = self.called()
        argv = c["argv"]
        self.assertIn("--sandbox", argv)
        self.assertEqual(argv[argv.index("--add-dir") + 1], os.path.realpath(self.repo))
        perms = json.loads(argv[argv.index("--settings") + 1])["permissions"]
        self.assertEqual(perms["allow"], [f"read_file({os.path.realpath(self.repo)})"])
        for d in ["command(*)", "write_file(*)", "read_url(*)", "mcp(*)"]:
            self.assertIn(d, perms["deny"])
        # リポジトリの外の禁止パスは allow に入らないので名指ししない
        self.assertFalse([d for d in perms["deny"] if d.startswith("read_file(")], perms["deny"])
        self.assertNotIn("--dangerously-skip-permissions", argv)
        # 本文は argv に載せず、stdin の stream-json で渡す
        self.assertFalse(any("既定を Neon" in a for a in argv))
        line = json.loads(c["stdin"])
        self.assertEqual(line["message"]["content"][0]["text"], "深田: 既定を Neon にしたい\n")
        # cwd は使い捨ての空ディレクトリで、終わったら消す
        self.assertNotIn(c["cwd"], (os.path.realpath(self.repo), os.path.realpath(self.d)))
        self.assertFalse(os.path.exists(c["cwd"]))
        self.assertEqual(os.path.dirname(c["cwd"]), os.path.realpath(self.work))
        self.assertEqual(agy_testing.leaks(c, [os.path.realpath(self.d), self.d]), [])

    def worker_settings(self, *deny):
        path = os.path.join(self.d, "settings.worker.json")
        with open(path, "w") as f:
            json.dump({"sandbox": {"filesystem": {"denyRead": ["~/.aws", "~/.claude.json", *deny]}}}, f)
        return path

    def test_names_denied_paths_inside_the_repo_only(self):
        repo = os.path.realpath(self.repo)
        r = self.run_ro(self.repo, self.prompt, self.out,
                        ORCA_WORKER_SETTINGS=self.worker_settings(f"{repo}/secrets.env"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        c = self.called()
        argv = c["argv"]
        deny = json.loads(argv[argv.index("--settings") + 1])["permissions"]["deny"]
        self.assertEqual([d for d in deny if d.startswith("read_file(")], [f"read_file({repo}/secrets.env)"])
        self.assertEqual(agy_testing.leaks(c, [os.path.realpath(self.d), self.d]), [])

    def test_stops_before_agy_when_a_denied_path_inside_the_repo_names_claude(self):
        repo = os.path.realpath(self.repo)
        r = self.run_ro(self.repo, self.prompt, self.out,
                        ORCA_WORKER_SETTINGS=self.worker_settings(f"{repo}/claude/mcp.local.json"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("名指しで渡せない", r.stderr)
        self.assertEqual(agy_testing.calls(self.bindir), [])
        self.assertFalse(os.path.exists(self.out))

    def test_failure_writes_log_and_no_answer(self):
        for mode in ("fail", "error"):
            agy_testing.set_mode(self.bindir, mode)
            r = self.run_ro(self.repo, self.prompt, self.out)
            self.assertNotEqual(r.returncode, 0, mode)
            self.assertFalse(os.path.exists(self.out), mode)
            self.assertIn("ログは", r.stdout)
        with open(self.out + ".log") as f:
            self.assertIn("result", f.read())

    def test_timeout_keeps_stderr_in_log(self):
        import importlib.machinery, importlib.util
        from unittest import mock
        loader = importlib.machinery.SourceFileLoader("neon_ro", ENTRY)
        spec = importlib.util.spec_from_loader("neon_ro", loader)
        m = importlib.util.module_from_spec(spec)
        loader.exec_module(m)
        m.KILL_AFTER = 2
        agy_testing.set_mode(self.bindir, "hang")
        with mock.patch.dict(os.environ, self.env):
            self.assertEqual(m.main(["neon-ro", self.repo, self.prompt, self.out]), 124)
        self.assertFalse(os.path.exists(self.out))
        with open(self.out + ".log") as f:
            log = f.read()
        self.assertIn("still thinking", log)
        self.assertIn("打ち切った", log)

    def test_rejects_paths_outside_tmp_root(self):
        r = self.run_ro(self.repo, os.path.expanduser("~/.zshrc"), self.out)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(agy_testing.calls(self.bindir), [])
        r = self.run_ro(self.repo, self.prompt, os.path.expanduser("~/neon-ro-should-not-exist.md"))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(agy_testing.calls(self.bindir), [])  # agy を呼ぶ前に止める
        self.assertFalse(os.path.exists(os.path.expanduser("~/neon-ro-should-not-exist.md")))

    def test_does_not_follow_symlinked_prompt(self):
        link = os.path.join(self.d, "link.md")
        os.symlink(self.prompt, link)
        r = self.run_ro(self.repo, link, self.out)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(agy_testing.calls(self.bindir), [])

    def test_wrong_arguments(self):
        self.assertNotEqual(self.run_ro(self.repo, self.prompt).returncode, 0)
        self.assertNotEqual(self.run_ro(os.path.join(self.d, "nope"), self.prompt, self.out).returncode, 0)


if __name__ == "__main__":
    unittest.main()
