#!/usr/bin/env python3
"""agy_launch が agy に Claude Code の下の環境を渡さず、使い捨ての cwd で走らせることを保証する。本物の agy は呼ばない。"""

import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import agy_launch  # noqa: E402
import agy_testing  # noqa: E402
from sandbox_tmp import tmp_root  # noqa: E402


class CleanEnv(unittest.TestCase):
    def test_keeps_what_agy_needs_and_drops_the_rest(self):
        env = dict(agy_testing.POLLUTED, HOME="/Users/u", PATH="/Users/u/.claude/plugins/x/bin:/usr/bin:/bin",
                   LC_ALL="ja_JP.UTF-8", GEMINI_API_KEY="g")
        with mock.patch.dict(os.environ, env, clear=True):
            out = agy_launch.clean_env()
        self.assertEqual(out["PATH"], "/usr/bin:/bin")
        self.assertEqual(out["TMPDIR"], agy_launch.user_tmp())
        for k in ("HOME", "LANG", "TERM", "LC_ALL", "AGY_ACCOUNT", "GEMINI_API_KEY"):
            self.assertEqual(out[k], env[k])
        self.assertEqual(set(out), {"HOME", "PATH", "TMPDIR", "LANG", "TERM", "LC_ALL", "AGY_ACCOUNT", "GEMINI_API_KEY"})

    def test_extra_is_added_but_never_a_telltale(self):
        with mock.patch.dict(os.environ, {"HOME": "/Users/u"}, clear=True):
            out = agy_launch.clean_env({"JA_REVIEW_ACTIVE": "1", "X": "/tmp/claude-501"})
        self.assertEqual(out.get("JA_REVIEW_ACTIVE"), "1")
        self.assertNotIn("X", out)

    def test_leaks_finds_launcher_context_but_not_repo_paths(self):
        call = {"env": {"HOME": "/Users/u", "CLAUDECODE": "1"}, "argv": ["--add-dir", "/Users/u/.config/nix-darwin/claude/skills"],
                "stdin": "Claude Code から起動された相談。サブエージェントの起動もしない。\n進行役: 案"}
        found = agy_testing.leaks(call)
        self.assertEqual([f.split(":")[0].split(" ")[0] for f in found], ["env", "env", "stdin", "stdin"])

    def test_user_tmp_is_not_the_sandbox_tmp(self):
        d = agy_launch.user_tmp()
        self.assertTrue(os.path.isabs(d))
        self.assertIsNone(agy_launch.TELLTALE.search(d))


class Run(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.d = self.dir.name
        self.bindir = agy_testing.install(self.d)
        self.root = os.path.join(self.d, "work")
        os.mkdir(self.root)
        self.fixtures = [os.path.realpath(self.d), self.d]

    def test_run_passes_clean_env_and_a_throwaway_cwd(self):
        with mock.patch.dict(os.environ, agy_testing.polluted_env(self.bindir, NEON_LAUNCH_TMP=self.root)):
            r = agy_launch.run(["agy", "--model", "gemini-m"], input="本文", timeout=30, prefix="t-")
        self.assertEqual(r.returncode, 0, r.stderr)
        (call,) = agy_testing.calls(self.bindir)
        self.assertEqual(call["argv"], ["--model", "gemini-m"])
        self.assertEqual(call["stdin"], "本文")
        self.assertEqual(os.path.dirname(call["cwd"]), os.path.realpath(self.root))
        self.assertFalse(os.path.exists(call["cwd"]))
        self.assertEqual(agy_testing.leaks(call, self.fixtures), [])

    def test_cli_replaces_itself_with_agy_in_a_clean_env(self):
        env = agy_testing.polluted_env(self.bindir)
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "agy_launch.py"), "agy", "-i", "最初の指示"],
                           env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 0, r.stderr)
        (call,) = agy_testing.calls(self.bindir)
        self.assertEqual(call["argv"], ["--model", "gemini-4-neon-high", "-i", "最初の指示"])
        self.assertEqual(agy_testing.leaks(call, self.fixtures), [])

    def test_missing_agy_raises_like_subprocess(self):
        with mock.patch.dict(os.environ, {"PATH": "/nonexistent", "NEON_LAUNCH_TMP": self.root}):
            with self.assertRaises(OSError):
                agy_launch.run(["agy"], input="", timeout=5)

    def test_only_gemini_models(self):
        self.assertEqual(agy_launch.pin_gemini(["agy", "--model", "gemini-4-neon", "-p"]), ["agy", "--model", "gemini-4-neon", "-p"])
        self.assertEqual(agy_launch.pin_gemini(["agy", "-p"]), ["agy", "--model", "gemini-4-neon-high", "-p"])
        for bad in (["agy", "--model", "claude-opus-5-5"], ["agy", "--model=gpt-6.2-astra"], ["agy", "--model"]):
            with self.assertRaises(ValueError):
                agy_launch.pin_gemini(bad)


if __name__ == "__main__":
    unittest.main()
