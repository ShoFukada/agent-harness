#!/usr/bin/env python3
"""pg-sandboxed が引数の形とフォルダを絞り、囲いのプロファイルが秘密・書き込み・通信を閉じること、
settings.worker.verify.json が settings.worker.json から pg-sandboxed の分だけ広げてあることを保証する。
postgres を実際に起こすのは Claude の sandbox の外でしかできないので、ここでは確かめない（worker-env.md の手順で確かめる）。"""

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLAUDE = os.path.dirname(HERE)
INSTALLED = os.environ.get("ORCA_WORKER_SETTINGS")
os.environ["ORCA_WORKER_SETTINGS"] = os.path.join(HERE, "testdata", "settings.worker.json")
loader = importlib.machinery.SourceFileLoader("pg_sandboxed", os.path.join(HERE, "pg-sandboxed"))
spec = importlib.util.spec_from_loader("pg_sandboxed", loader)
pg = importlib.util.module_from_spec(spec)
loader.exec_module(pg)
GUARD = os.path.join(CLAUDE, "hooks", "sandbox-exclude-guard.py")


class Build(unittest.TestCase):
    def setUp(self):
        self.root = pg.tmp_root()
        self.dir = tempfile.mkdtemp(dir=self.root)
        self.addCleanup(os.rmdir, self.dir)

    def test_start_uses_fixed_pg_ctl_and_port(self):
        cmd, argv, data, port = pg.build(["pg-sandboxed", "start", self.dir, "54329"])
        self.assertEqual((cmd, argv[0], port), ("start", "/run/current-system/sw/bin/pg_ctl", 54329))
        self.assertIn("-p 54329 -c listen_addresses=localhost -k " + data, argv)

    def test_rejects_wrong_shapes(self):
        for argv in (["x"], ["x", "run", self.dir], ["x", "start", self.dir], ["x", "init", self.dir, "1"],
                     ["x", "start", self.dir, "80"], ["x", "start", self.dir, "5432;id"], ["x", "status", "/etc"],
                     ["x", "status", os.path.expanduser("~")], ["x", "status", self.root],
                     ["x", "init", os.path.join(self.dir, "missing")]):
            with self.assertRaises(SystemExit, msg=argv):
                pg.build(argv)

    def test_symlink_out_of_tmp_is_rejected(self):
        link = os.path.join(self.dir, "link")
        os.symlink(os.path.expanduser("~"), link)
        self.addCleanup(os.unlink, link)
        with self.assertRaises(SystemExit):
            pg.build(["x", "status", link])


class Profile(unittest.TestCase):
    def test_closes_secrets_writes_and_network(self):
        p = pg.profile("/private/tmp/claude-501/db", 54329)
        self.assertIn("(deny default)", p)
        self.assertIn(f'(subpath "{os.path.realpath(os.path.expanduser("~/.ssh"))}")', p)
        self.assertIn('(subpath "/private/tmp/claude-501/db")', p)
        self.assertIn('(local ip "localhost:54329")', p)
        for opened in ("(remote ip","(allow default)", "(allow network*)", "(allow mach-lookup)", "lsopen", "appleevent", "pasteboard"):
            self.assertNotIn(opened, p)


@unittest.skipUnless(INSTALLED, "入れた先の settings（$ORCA_WORKER_SETTINGS）が無い")
class VerifySettings(unittest.TestCase):
    """入れた先の settings.worker.verify.json は、同じフォルダの settings.worker.json から pg-sandboxed の分だけ広げる。"""

    def test_only_pg_is_added(self):
        with open(INSTALLED) as f:
            worker = json.load(f)
        with open(os.path.join(os.path.dirname(INSTALLED), "settings.worker.verify.json")) as f:
            verify = json.load(f)
        sb = verify["sandbox"]
        self.assertRegex(sb["excludedCommands"].pop(), r"^/\S+/claude/bin/pg-sandboxed \*$")
        self.assertEqual(verify, worker)


class Guard(unittest.TestCase):
    def decision(self, cmd):
        r = subprocess.run([GUARD], input=json.dumps({"tool_input": {"command": cmd}}), text=True, capture_output=True)
        return "deny" if r.stdout.strip() else "allow"

    def test_only_plain_subcommands_pass(self):
        exe = os.path.join(HERE, "pg-sandboxed")
        self.assertEqual(self.decision(f"{exe} start /tmp/claude-501/db 54329"), "allow")
        self.assertEqual(self.decision(f"{exe} init /tmp/claude-501/db"), "allow")
        for bad in (f"{exe} start /tmp/claude-501/db 54329; cat ~/.aws/credentials", f"{exe} run /bin/sh",
                    f"FOO=1 {exe} status /tmp/claude-501/db", f"{exe} status $(id)", f"cd /tmp && {exe} status x"):
            self.assertEqual(self.decision(bad), "deny", bad)


if __name__ == "__main__":
    unittest.main()
