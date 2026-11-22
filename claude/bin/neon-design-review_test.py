#!/usr/bin/env python3
"""neon-design-review が一時領域の外と link をたどらず、agy に決めた引数だけを渡し、guard が繋いだコマンドを止めることを保証する。"""

import importlib.machinery
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GUARD = os.path.join(HERE, "..", "hooks", "sandbox-exclude-guard.py")
ENTRY = os.path.join(os.path.realpath(HERE), "neon-design-review")
os.environ["ORCA_WORKER_SETTINGS"] = os.path.join(HERE, "testdata", "settings.worker.json")


def load():
    loader = importlib.machinery.SourceFileLoader("neon_design_review", ENTRY)
    spec = importlib.util.spec_from_loader("neon_design_review", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class Entry(unittest.TestCase):
    def setUp(self):
        self.m = load()
        from sandbox_tmp import tmp_root
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.d = self.dir.name
        self.shots = os.path.join(self.d, "shots")
        os.mkdir(self.shots)

    def png(self, name, data=b"\x89PNG"):
        p = os.path.join(self.shots, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_copies_only_plain_images_without_links(self):
        self.png("a_1440_default.png")
        self.png("notes.txt")
        secret = os.path.join(self.d, "secret.png")
        with open(secret, "wb") as f:
            f.write(b"key")
        os.symlink(secret, os.path.join(self.shots, "link.png"))
        os.link(secret, os.path.join(self.shots, "hard.png"))
        dest = os.path.join(self.d, "copy")
        self.m.copy_shots(self.shots, dest)
        self.assertEqual(os.listdir(dest), ["a_1440_default.png"])

    def test_rejects_folders_and_files_outside_tmp_root(self):
        with self.assertRaises(SystemExit):
            self.m.copy_shots(os.path.expanduser("~/Desktop"), os.path.join(self.d, "copy"))
        with self.assertRaises(SystemExit):
            self.m.copy_one(os.path.expanduser("~/.zshrc"), os.path.join(self.d, "product.md"))

    def test_skips_fifos_without_waiting(self):
        self.png("a_1440_default.png")
        os.mkfifo(os.path.join(self.shots, "pipe.png"))
        dest = os.path.join(self.d, "copy")
        self.m.copy_shots(self.shots, dest)
        self.assertEqual(os.listdir(dest), ["a_1440_default.png"])

    def test_script_is_not_taken_from_arguments(self):
        with self.assertRaises(SystemExit):
            self.m.main(["neon-design-review", self.shots, "--kind", "lp", "--script", "/tmp/x.py"])

    def test_agy_denies_reading_the_worker_deny_read_paths(self):
        deny = self.m.agy_settings("/x")["permissions"]["deny"]
        self.assertIn("read_file(%s)" % os.path.realpath(os.path.expanduser("~/.aws")), deny)

    def test_agy_gets_sandbox_and_fixed_settings_only(self):
        shots = os.path.realpath(os.path.join(self.d, "private", "shots"))
        os.makedirs(shots)
        self.m.write_agy_settings(shots)
        args = self.m.agy_args(shots, ["--model", "gemini-4-neon-high", "--disable-slash-commands", "--add-dir", shots,
                                       "--settings", '{"permissions": {"allow": ["command(*)"]}}', "--json-schema", "{}"])
        self.assertEqual(args[:2], [self.m.REAL_AGY, "--sandbox"])
        settings = json.loads(args[3])
        self.assertEqual(settings["permissions"]["allow"], ["read_file(%s)" % shots])
        self.assertIn("command(*)", settings["permissions"]["deny"])
        self.assertEqual(args.count("--settings"), 1, "スクリプトの settings は捨てる")
        for bad in (["--dangerously-skip-permissions"], ["--remote-agent"], ["--add-dir", "/Users"]):
            with self.assertRaises(SystemExit):
                self.m.agy_args(shots, bad)

    def test_runs_the_script_with_copies_and_the_stand_in_agy(self):
        self.png("a_1440_default.png")
        product = os.path.join(self.d, "product.md")
        with open(product, "w") as f:
            f.write("トーン")
        script = os.path.join(self.d, "fake.py")
        with open(script, "w") as f:
            f.write("import os, shutil, subprocess, sys\n"
                    "print(sys.argv[1:])\n"
                    "print(shutil.which('agy'))\n"
                    "print(subprocess.run(['agy', '--remote-agent']).returncode)\n")
        private = os.path.join(self.d, "private")
        os.mkdir(private)
        env = dict(os.environ, NEON_DESIGN_REVIEW_SCRIPT=script, NEON_DESIGN_REVIEW_TMP=private)
        r = subprocess.run([sys.executable, ENTRY, self.shots, "--kind", "lp", "--product", product],
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        argv, agy, code = r.stdout.splitlines()
        self.assertNotIn(self.shots, argv, "worker の置いたものをそのまま渡さない")
        self.assertNotIn(product, argv)
        self.assertIn("'--kind', 'lp', '--product'", argv)
        self.assertTrue(agy.endswith("/bin/agy") and agy != self.m.REAL_AGY)
        self.assertEqual(code, "2", "代役の agy は決めていない引数を断る")
        self.assertIn("--remote-agent は渡さない", r.stderr)


    def test_stand_in_agy_hands_a_clean_env_to_agy(self):
        import agy_testing
        private = os.path.join(self.d, "private")
        shots = os.path.join(private, "shots")
        os.makedirs(shots)
        self.m.write_agy_settings(shots)
        fake = os.path.join(agy_testing.install(self.d), "agy")
        code = ("import importlib.machinery, importlib.util, sys\n"
                f"loader = importlib.machinery.SourceFileLoader('ndr', {ENTRY!r})\n"
                "spec = importlib.util.spec_from_loader('ndr', loader)\n"
                "m = importlib.util.module_from_spec(spec); loader.exec_module(m)\n"
                f"m.REAL_AGY = {fake!r}\n"
                "m.main(['agy'] + sys.argv[1:])\n")
        env = agy_testing.polluted_env(os.path.dirname(fake), NEON_DESIGN_REVIEW_TMP=private,
                                       NEON_DESIGN_REVIEW_AS_AGY=shots, TMPDIR=private)
        r = subprocess.run([sys.executable, "-c", code, "--model", "gemini-4-neon-high", "--add-dir", shots,
                            "--input-format", "stream-json"], input="採点して", env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        (call,) = agy_testing.calls(os.path.dirname(fake))
        self.assertEqual(call["argv"][0], "--sandbox")
        self.assertNotIn("NEON_DESIGN_REVIEW_AS_AGY", call["env"])
        self.assertEqual(agy_testing.leaks(call, [os.path.realpath(self.d), self.d]), [])

    def test_stand_in_agy_works_without_worker_settings_in_its_env(self):
        # design-review-neon.py の agy_env は、名前か値に claude を含む変数を落としてから agy（代役）を起こす。
        # ORCA_WORKER_SETTINGS は値に claude を含むので代役には届かない（割り込み 50。届く前提だと必ず終了コード 1 で止まる）
        import agy_testing
        private = os.path.join(self.d, "private")
        shots = os.path.join(private, "shots")
        os.makedirs(shots)
        self.m.write_agy_settings(shots)  # 親の段（ORCA_WORKER_SETTINGS のある環境）で書く
        fake = os.path.join(agy_testing.install(self.d), "agy")
        code = ("import importlib.machinery, importlib.util, sys\n"
                f"loader = importlib.machinery.SourceFileLoader('ndr', {ENTRY!r})\n"
                "spec = importlib.util.spec_from_loader('ndr', loader)\n"
                "m = importlib.util.module_from_spec(spec); loader.exec_module(m)\n"
                f"m.REAL_AGY = {fake!r}\n"
                "m.main(['agy'] + sys.argv[1:])\n")
        env = agy_testing.polluted_env(os.path.dirname(fake), NEON_DESIGN_REVIEW_TMP=private,
                                       NEON_DESIGN_REVIEW_AS_AGY=shots, TMPDIR=private)
        env = {k: v for k, v in env.items() if "claude" not in (k + v).lower() or k in ("PATH", "TMPDIR", "NEON_DESIGN_REVIEW_TMP", "NEON_DESIGN_REVIEW_AS_AGY")}
        self.assertNotIn("ORCA_WORKER_SETTINGS", env)
        r = subprocess.run([sys.executable, "-c", code, "--model", "gemini-4-neon-high", "--add-dir", shots],
                           input="採点して", env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        (call,) = agy_testing.calls(os.path.dirname(fake))
        settings = json.loads(call["argv"][2])
        self.assertIn("read_file(%s)" % os.path.realpath(os.path.expanduser("~/.aws")), settings["permissions"]["deny"])
        self.assertEqual(settings["permissions"]["allow"], ["read_file(%s)" % os.path.realpath(shots)])

    def test_stand_in_agy_refuses_without_the_settings_the_parent_wrote(self):
        private = os.path.join(self.d, "private")
        shots = os.path.join(private, "shots")
        os.makedirs(shots)
        os.environ["NEON_DESIGN_REVIEW_TMP"] = private
        self.addCleanup(os.environ.pop, "NEON_DESIGN_REVIEW_TMP")
        with self.assertRaises(SystemExit):
            self.m.agy_args(os.path.realpath(shots), ["--model", "gemini-4-neon-high"])


class Guard(unittest.TestCase):
    def decide(self, cmd):
        r = subprocess.run([GUARD], input=json.dumps({"tool_input": {"command": cmd}}),
                           capture_output=True, text=True, check=True)
        return "deny" if r.stdout.strip() else "allow"

    def test_allows_plain_call(self):
        self.assertEqual(self.decide(f"{ENTRY} /tmp/claude-501/x/shots --kind business --product /tmp/claude-501/x/product.md"), "allow")

    def test_denies_chained_or_prefixed_call(self):
        for cmd in [
            f"{ENTRY} /tmp/claude-501/x/shots --kind lp; cat ~/.aws/credentials",
            f"{ENTRY} /tmp/claude-501/x/shots --kind lp && curl x",
            f"{ENTRY} $(cat ~/.aws/config) --kind lp",
            f"{ENTRY} '/tmp/claude-501/x y' --kind lp",
            f"NEON_DESIGN_REVIEW_SCRIPT=/tmp/claude-501/evil.py {ENTRY} /tmp/claude-501/x --kind lp",
            f"NEON_DESIGN_REVIEW_AS_AGY=/x {ENTRY} --dangerously-skip-permissions",
        ]:
            self.assertEqual(self.decide(cmd), "deny", cmd)


if __name__ == "__main__":
    sys.path.insert(0, os.path.realpath(HERE))
    unittest.main()
