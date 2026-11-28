#!/usr/bin/env python3
"""agy_launch が agy に Claude Code の下の環境を渡さず、使い捨ての cwd で走らせることを保証する。本物の agy は呼ばない。"""

import json
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


class DenyReadWithin(unittest.TestCase):
    """agy に読ませるフォルダの中の禁止パスだけを名指しし、外のもの（~/.claude.json など）は argv に出さない。"""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.root = os.path.realpath(os.path.join(self.dir.name, "repo"))
        os.makedirs(os.path.join(self.root, "keys"))

    def within(self, deny, roots=None):
        settings = os.path.join(self.dir.name, "settings.worker.json")
        with open(settings, "w") as f:
            json.dump({"sandbox": {"filesystem": {"denyRead": deny}}}, f)
        with mock.patch.dict(os.environ, {"ORCA_WORKER_SETTINGS": settings}):
            return agy_launch.deny_read_within([self.root] if roots is None else roots)

    def test_names_only_the_denied_paths_inside_the_folder(self):
        rules = self.within(["~/.aws", "~/.claude.json", f"{self.root}/secret.txt", f"{self.root}/keys/*.pem"])
        self.assertEqual(rules, [f"read_file({self.root}/keys)", f"read_file({self.root}/secret.txt)"])

    def test_no_folder_names_nothing(self):
        self.assertEqual(self.within(["~/.aws", f"{self.root}/secret.txt"], roots=[]), [])

    def test_stops_instead_of_naming_a_path_that_points_at_claude(self):
        for rel in ("claude/mcp.local.json", ".claude.json", "anthropic/key", "subagent.env"):
            with self.subTest(rel=rel), self.assertRaises(SystemExit):
                self.within([f"{self.root}/{rel}"])

    def test_only_the_part_below_the_folder_is_checked(self):
        # フォルダ自体は allow と --add-dir で agy に渡る。名指しで増えるのはフォルダの下の部分だけ
        root = os.path.join(self.root, "keys")
        self.assertEqual(self.within([f"{root}/x.txt"], roots=[root]), [f"read_file({root}/x.txt)"])

    def test_stops_when_the_folder_is_inside_a_denied_path(self):
        with self.assertRaises(SystemExit):
            self.within([os.path.dirname(self.root)])

    def test_context_words_match_the_leak_check(self):
        self.assertEqual((agy_launch.CONTEXT_WORDS.pattern, agy_launch.CONTEXT_WORDS.flags),
                         (agy_testing.FORBIDDEN.pattern, agy_testing.FORBIDDEN.flags))


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
        env = agy_testing.polluted_env(self.bindir, NEON_LAUNCH_TMP=self.root)
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

    def test_run_and_exec_point_home_at_the_neon_home(self):
        with mock.patch.dict(os.environ, agy_testing.polluted_env(self.bindir, NEON_LAUNCH_TMP=self.root)), \
                mock.patch.object(agy_launch, "neon_home", return_value="/Users/u/T/agy-neon-home"):
            agy_launch.run(["agy"], input="", timeout=30)
            with mock.patch.object(agy_launch.os, "execve") as execve:
                agy_launch.exec_(["agy", "-i", "x"])
        (call,) = agy_testing.calls(self.bindir)
        self.assertEqual(call["env"]["HOME"], "/Users/u/T/agy-neon-home")
        self.assertEqual(execve.call_args[0][2]["HOME"], "/Users/u/T/agy-neon-home")

    def test_only_gemini_models(self):
        self.assertEqual(agy_launch.pin_gemini(["agy", "--model", "gemini-4-neon", "-p"]), ["agy", "--model", "gemini-4-neon", "-p"])
        self.assertEqual(agy_launch.pin_gemini(["agy", "-p"]), ["agy", "--model", "gemini-4-neon-high", "-p"])
        for bad in (["agy", "--model", "claude-opus-5-5"], ["agy", "--model=gpt-6.2-astra"], ["agy", "--model"]):
            with self.assertRaises(ValueError):
                agy_launch.pin_gemini(bad)


class NeonHome(unittest.TestCase):
    """Neon の HOME の .gemini/ が、認証などは本物を指し、対話用の決まり・skill・hook・MCP を見せないこと（R241）。"""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.real = os.path.join(self.dir.name, "home")
        g = os.path.join(self.real, ".gemini")
        os.makedirs(os.path.join(g, "config"))
        os.makedirs(os.path.join(g, "antigravity-cli", "brain"))
        for name in ("oauth_creds.json", "GEMINI.md", "AGENTS.md", "settings.json",
                     "config/config.json", "config/skills.json", "config/plugins.json", "config/hooks.json",
                     "config/mcp_config.json"):
            with open(os.path.join(g, name), "w") as f:
                f.write(name)
        lib = os.path.join(self.real, "Library")
        os.makedirs(os.path.join(lib, "Keychains"))
        os.makedirs(os.path.join(lib, "Application Support", "orca", "claude-profiles"))
        os.makedirs(os.path.join(lib, "Preferences"))
        self.root = os.path.join(self.dir.name, "T")

    def build(self):
        return agy_launch.neon_home(self.real, self.root)

    def view(self, home):
        g = os.path.join(home, ".gemini")
        return sorted(os.listdir(g)), sorted(os.listdir(os.path.join(g, "config")))

    def test_mirrors_the_real_gemini_without_rules_skills_hooks_and_mcp(self):
        home = self.build()
        self.assertEqual(home, os.path.join(self.root, "agy-neon-home"))
        self.assertEqual(self.view(home), (["antigravity-cli", "config", "oauth_creds.json", "settings.json"], ["config.json"]))
        g = os.path.join(home, ".gemini")
        self.assertEqual(os.readlink(os.path.join(g, "oauth_creds.json")), os.path.join(self.real, ".gemini", "oauth_creds.json"))
        self.assertEqual(os.readlink(os.path.join(g, "config", "config.json")),
                         os.path.join(self.real, ".gemini", "config", "config.json"))
        self.assertFalse(os.path.islink(os.path.join(g, "config")))

    def test_rebuilding_repairs_files_agy_replaced_and_drops_stale_links(self):
        home = self.build()
        g = os.path.join(home, ".gemini")
        # agy が rename で書いて symlink を普通のファイルに替えた・本物から消えたもの・前に見せていた決まり
        os.unlink(os.path.join(g, "oauth_creds.json"))
        with open(os.path.join(g, "oauth_creds.json"), "w") as f:
            f.write("古い認証")
        os.remove(os.path.join(self.real, ".gemini", "settings.json"))
        os.symlink(os.path.join(self.real, ".gemini", "GEMINI.md"), os.path.join(g, "GEMINI.md"))
        with open(os.path.join(g, "projects.json.tmp"), "w") as f:
            f.write("agy の書きかけ")
        self.assertEqual(self.build(), home)
        self.assertEqual(self.view(home)[0], ["antigravity-cli", "config", "oauth_creds.json", "projects.json.tmp"])
        with open(os.path.join(g, "oauth_creds.json")) as f:
            self.assertEqual(f.read(), "oauth_creds.json")

    def test_parallel_builds_do_not_break_each_other(self):
        code = ("import sys; sys.path.insert(0, %r); import agy_launch\n"
                "for _ in range(30): agy_launch.neon_home(%r, %r)\n") % (HERE, self.real, self.root)
        procs = [subprocess.Popen([sys.executable, "-c", code], stderr=subprocess.PIPE, text=True) for _ in range(6)]
        for p in procs:
            _, err = p.communicate(timeout=60)
            self.assertEqual(p.returncode, 0, err)
        self.assertEqual(self.view(os.path.join(self.root, "agy-neon-home"))[1], ["config.json"])
        self.assertEqual(os.listdir(os.path.join(self.root, "agy-neon-home", "Library")), ["Keychains"])

    def test_library_shows_only_the_real_keychains(self):
        # agy 1.5.18 は認証を keychain から読む。~/Library のほか（Application Support の Claude のプロフィールなど）は見せない
        home = self.build()
        lib = os.path.join(home, "Library")
        self.assertFalse(os.path.islink(lib))
        self.assertEqual(sorted(os.listdir(lib)), ["Keychains"])
        self.assertEqual(os.readlink(os.path.join(lib, "Keychains")), os.path.join(self.real, "Library", "Keychains"))

    def test_rebuilding_repairs_keychains_and_drops_other_library_links(self):
        home = self.build()
        lib = os.path.join(home, "Library")
        # agy が Keychains を実フォルダに替えた・前に見せていた別の場所・agy が Neon の HOME に書いたもの
        os.unlink(os.path.join(lib, "Keychains"))
        os.makedirs(os.path.join(lib, "Keychains"))
        os.symlink(os.path.join(self.real, "Library", "Application Support"), os.path.join(lib, "Application Support"))
        os.makedirs(os.path.join(lib, "Caches"))
        self.assertEqual(self.build(), home)
        self.assertEqual(sorted(os.listdir(lib)), ["Caches", "Keychains"])
        self.assertEqual(os.readlink(os.path.join(lib, "Keychains")), os.path.join(self.real, "Library", "Keychains"))

    def test_a_home_without_gemini_still_builds(self):
        home = agy_launch.neon_home(os.path.join(self.dir.name, "empty"), self.root)
        self.assertEqual(self.view(home), ([ "config"], []))

    def test_the_neon_home_under_the_user_tmp_has_no_telltale(self):
        self.assertIsNone(agy_launch.TELLTALE.search(os.path.join(agy_launch.user_tmp(), agy_launch.NEON_HOME)))


if __name__ == "__main__":
    unittest.main()
