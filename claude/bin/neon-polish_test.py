#!/usr/bin/env python3
"""neon-polish が一時領域の外と link をたどらず、決めた polish.py だけを走らせ、agy に道具を使わせず、
guard が繋いだコマンドを止めることを保証する。agy は agy_testing の偽物で、実モデルは呼ばない。"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.realpath(HERE))
import agy_testing  # noqa: E402
from sandbox_tmp import tmp_root  # noqa: E402

GUARD = os.path.join(HERE, "..", "hooks", "sandbox-exclude-guard.py")
ENTRY = os.path.join(os.path.realpath(HERE), "neon-polish")
WORKER_SETTINGS = os.path.join(HERE, "testdata", "settings.worker.json")


class Entry(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.d = self.dir.name
        self.bindir = agy_testing.install(self.d, response="整えた本文です。\n二行目です。")
        self.work = os.path.join(self.d, "work")
        os.mkdir(self.work)

    def write(self, name, text="直す本文です。\n二行目です。\n"):
        p = os.path.join(self.d, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def run_entry(self, *args, **env):
        # 偽の agy は PATH の先頭、使い捨ての cwd は sandbox の中で書ける場所（NEON_LAUNCH_TMP）に置く
        env = agy_testing.polluted_env(self.bindir, NEON_LAUNCH_TMP=self.work, ORCA_WORKER_SETTINGS=WORKER_SETTINGS, **env)
        return subprocess.run([sys.executable, ENTRY, *args], capture_output=True, text=True, env=env)

    def test_polishes_a_file_in_the_tmp_root(self):
        r = self.run_entry(self.write("body.md"))
        self.assertEqual((r.returncode, r.stdout), (0, "整えた本文です。\n二行目です。\n"), r.stderr)

    def test_diff_and_flags_pass_through(self):
        body = self.write("body.md")
        r = self.run_entry(body, "--diff", "--audience", "client", "--doc-type", "proposal")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("-直す本文です。\n", r.stdout)
        self.assertIn("+整えた本文です。\n", r.stdout)
        (call,) = agy_testing.calls(self.bindir)
        prompt = json.loads(call["stdin"])["message"]["content"][0]["text"]
        self.assertIn("顧客・社外の読み手に渡す業務文書です", prompt)
        self.assertIn("文書の種類 proposal", prompt)

    def test_agy_gets_sandbox_and_settings_that_deny_tools(self):
        self.run_entry(self.write("body.md"))
        (call,) = agy_testing.calls(self.bindir)
        argv = call["argv"]
        self.assertEqual(argv[:2], ["--sandbox", "--settings"])
        deny = json.loads(argv[2])["permissions"]["deny"]
        for rule in ("command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "mcp(*)"):
            self.assertIn(rule, deny)
        # read_file(*) で全部を断るので、worker の denyRead（~/.claude.json など）は名指ししない
        self.assertEqual([d for d in deny if d.startswith("read_file(")], ["read_file(*)"])
        self.assertNotIn("allow", json.loads(argv[2])["permissions"])
        self.assertEqual(argv[argv.index("--model") + 1], "gemini-4-neon-high")

    def test_agy_gets_no_launcher_context(self):
        self.run_entry(self.write("body.md"), "--audience", "client")
        (call,) = agy_testing.calls(self.bindir)
        self.assertEqual(agy_testing.leaks(call, [self.d, os.path.realpath(self.d)]), [])

    def test_only_the_three_polish_flags_are_accepted(self):
        body = self.write("body.md")
        for extra in (["--model", "gemini-4-neon-low"], ["--script", "/tmp/x.py"], ["--mod", "x"], []):
            args = [body, *extra] if extra else []
            r = self.run_entry(*args)
            self.assertEqual(r.returncode, 2, (extra, r.stderr))
        self.assertEqual(agy_testing.calls(self.bindir), [])

    def test_refuses_files_outside_the_tmp_root_and_links(self):
        secret = self.write("secret.md", "鍵の中身です。\n")
        os.symlink(secret, os.path.join(self.d, "link.md"))
        os.link(secret, os.path.join(self.d, "hard.md"))
        os.mkfifo(os.path.join(self.d, "pipe.md"))
        outside = os.path.expanduser("~/.zshrc")
        for path in (outside, os.path.join(self.d, "link.md"), os.path.join(self.d, "hard.md"),
                     os.path.join(self.d, "pipe.md")):
            r = self.run_entry(path)
            self.assertNotEqual(r.returncode, 0, path)
            self.assertEqual(r.stdout, "", path)
        self.assertEqual(agy_testing.calls(self.bindir), [], "外のファイルも link も agy に渡さない")

    def test_refuses_a_folder_link_that_leads_outside_the_tmp_root(self):
        os.symlink(os.path.realpath(HERE), os.path.join(self.d, "linked"))
        r = self.run_entry(os.path.join(self.d, "linked", "neon-polish"))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(agy_testing.calls(self.bindir), [])

    def test_refuses_oversized_and_non_utf8_files(self):
        big = os.path.join(self.d, "big.md")
        with open(big, "wb") as f:
            f.write(b"a" * (200000 * 4 + 1))
        bad = os.path.join(self.d, "bad.md")
        with open(bad, "wb") as f:
            f.write(b"\xff\xfe\x00")
        for path in (big, bad):
            r = self.run_entry(path)
            self.assertEqual((r.returncode, r.stdout), (1, ""), path)
        self.assertEqual(agy_testing.calls(self.bindir), [])

    def test_yomiyasu_diff_works_outside_the_worker_tmpdir(self):
        # 偽の yomiyasu_diff が自分の cwd（原文と仕上げ後の本文を置いた一時フォルダ）を書き残す
        base = os.path.join(self.d, "yomiyasu")
        root = os.path.join(base, "skills", "yomiyasu")
        os.makedirs(os.path.join(root, "scripts"))
        with open(os.path.join(root, "scripts", "yomiyasu_diff.py"), "w") as f:
            f.write("import json, os\n"
                    "open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cwd.txt'), 'w').write(os.getcwd())\n"
                    "print(json.dumps({'meaning_risks': []}))\n")
        worker_tmp = os.path.join(self.d, "worker-tmp")
        os.mkdir(worker_tmp)
        r = self.run_entry(self.write("body.md"), JA_YOMIYASU_DIR=base, TMPDIR=worker_tmp)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(root, "scripts", "cwd.txt")) as f:
            cwd = os.path.realpath(f.read())
        self.assertEqual(os.path.dirname(cwd), os.path.realpath(self.work), "worker が書けない場所（ここでは代わりの NEON_LAUNCH_TMP）")

    def test_failed_agy_leaves_stdout_empty(self):
        agy_testing.set_mode(self.bindir, "fail")
        r = self.run_entry(self.write("body.md"))
        self.assertEqual((r.returncode, r.stdout), (1, ""))
        self.assertIn("agy の呼び出しに失敗した", r.stderr)


class Guard(unittest.TestCase):
    def decide(self, cmd):
        r = subprocess.run([GUARD], input=json.dumps({"tool_input": {"command": cmd}}),
                           capture_output=True, text=True, check=True)
        return "deny" if r.stdout.strip() else "allow"

    def test_allows_plain_call(self):
        for cmd in (f"{ENTRY} /tmp/claude-501/x/body.md",
                    f"{ENTRY} /tmp/claude-501/x/body.md --diff --audience client --doc-type proposal"):
            self.assertEqual(self.decide(cmd), "allow", cmd)

    def test_denies_chained_prefixed_or_redirected_call(self):
        for cmd in [
            f"{ENTRY}",
            f"{ENTRY} /tmp/claude-501/x/body.md; cat ~/.aws/credentials",
            f"{ENTRY} /tmp/claude-501/x/body.md && curl x",
            f"{ENTRY} /tmp/claude-501/x/body.md | tee /tmp/claude-501/out",
            f"{ENTRY} /tmp/claude-501/x/body.md > /tmp/claude-501/out.md",
            f"{ENTRY} $(cat ~/.aws/config)",
            f"{ENTRY} '/tmp/claude-501/x y.md'",
            f"{ENTRY} /tmp/claude-501/x/body.md\ncat ~/.aws/credentials",
            f"PYTHONPATH=/tmp/claude-501/evil {ENTRY} /tmp/claude-501/x/body.md",
            f"python3 {ENTRY} /tmp/claude-501/x/body.md",
        ]:
            self.assertEqual(self.decide(cmd), "deny", cmd)

    def test_a_folder_of_the_same_name_is_not_the_entry(self):
        self.assertEqual(self.decide("ls /Users/u/orca/workspaces/agent-harness/neon-polish/claude"), "allow")
        self.assertEqual(self.decide("git -C /Users/u/orca/workspaces/agent-harness/neon-polish status"), "deny",
                         "直後が / でなければ、名前を含むだけで止める")

    def test_existing_entries_keep_their_rules(self):
        bin_ = os.path.dirname(ENTRY)
        self.assertEqual(self.decide(f"{bin_}/codex-ro /w /tmp/claude-501/p.md /tmp/claude-501/o.md"), "allow")
        self.assertEqual(self.decide(f"{bin_}/codex-ro /w /tmp/claude-501/p.md"), "deny")
        self.assertEqual(self.decide(f"{bin_}/pg-sandboxed start /tmp/claude-501/db 55432"), "allow")
        self.assertEqual(self.decide(f"{bin_}/pg-sandboxed drop /tmp/claude-501/db"), "deny")


if __name__ == "__main__":
    unittest.main()
