#!/usr/bin/env python3
"""codex-ro が sandbox の一時領域の外を読み書きせず、sandbox-exclude-guard が繋いだコマンドを止めることを保証する。"""

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GUARD = os.path.join(HERE, "..", "hooks", "sandbox-exclude-guard.py")
WRAPPER = os.path.join(os.path.realpath(HERE), "codex-ro")
os.environ["ORCA_WORKER_SETTINGS"] = os.path.join(HERE, "testdata", "settings.worker.json")


def load():
    loader = importlib.machinery.SourceFileLoader("codex_ro", os.path.join(HERE, "codex-ro"))
    spec = importlib.util.spec_from_loader("codex_ro", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class Paths(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.dir = tempfile.TemporaryDirectory(dir=self.m.tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.d = self.dir.name

    def test_reads_and_writes_inside_tmp_root(self):
        p = os.path.join(self.d, "prompt.md")
        with open(p, "w") as f:
            f.write("hi")
        self.assertEqual(self.m.read_prompt(p), b"hi")
        o = os.path.join(self.d, "out.md")
        self.m.write_file(o, b"ok")
        with open(o) as f:
            self.assertEqual(f.read(), "ok")

    def test_rejects_paths_outside_tmp_root(self):
        with self.assertRaises(SystemExit):
            self.m.read_prompt(os.path.expanduser("~/.zshrc"))
        with self.assertRaises(SystemExit):
            self.m.write_file(os.path.expanduser("~/codex-ro-should-not-exist"), b"x")

    def test_does_not_follow_symlinked_file(self):
        target = os.path.join(self.d, "target")
        with open(target, "w") as f:
            f.write("keep")
        link = os.path.join(self.d, "link")
        os.symlink(target, link)
        with self.assertRaises(OSError):
            self.m.read_prompt(link)
        self.m.write_file(link, b"x")  # symlink そのものを置き換え、指す先には書かない
        self.assertFalse(os.path.islink(link))
        with open(target) as f:
            self.assertEqual(f.read(), "keep")

    def test_does_not_touch_hard_linked_file(self):
        outside = tempfile.NamedTemporaryFile(dir=self.d, delete=False)  # 一時領域の外のファイルの代わり
        outside.write(b"keep")
        outside.close()
        link = os.path.join(self.d, "o.md.log")
        os.link(outside.name, link)
        with self.assertRaises(SystemExit):
            self.m.read_prompt(link)
        self.m.write_file(link, b"new")
        with open(outside.name) as f:
            self.assertEqual(f.read(), "keep")
        with open(link) as f:
            self.assertEqual(f.read(), "new")

    def test_denied_paths_cover_settings_deny_read(self):
        denied = self.m.denied_paths()
        home = os.path.realpath(os.path.expanduser("~"))
        self.assertIn(os.path.join(home, ".aws"), denied)
        self.assertIn(os.path.join(home, ".ssh"), denied)  # ~/.ssh/*.pem は手前の階層ごと

    def test_stops_without_worker_settings(self):
        saved = os.environ.pop("ORCA_WORKER_SETTINGS")
        self.addCleanup(os.environ.__setitem__, "ORCA_WORKER_SETTINGS", saved)
        with self.assertRaises(SystemExit):
            self.m.denied_paths()

    def test_rejects_flag_as_session_id(self):
        p = os.path.join(self.d, "prompt.md")
        with open(p, "w") as f:
            f.write("hi")
        for bad in ["--dangerously-bypass-approvals-and-sandbox", "-s", "abc"]:
            with self.assertRaises(SystemExit) as e:
                self.m.main(["codex-ro", self.d, p, os.path.join(self.d, "o.md"), bad])
            self.assertIn("UUID", str(e.exception.code))


class Guard(unittest.TestCase):
    def decide(self, cmd):
        r = subprocess.run([GUARD], input=json.dumps({"tool_input": {"command": cmd}}),
                           capture_output=True, text=True, check=True)
        return "deny" if r.stdout.strip() else "allow"

    def test_allows_plain_call(self):
        self.assertEqual(self.decide(f"{WRAPPER} /repo /tmp/claude-501/x/p.md /tmp/claude-501/x/o.md"), "allow")
        self.assertEqual(self.decide(f"{WRAPPER} /repo /tmp/p.md /tmp/o.md 019a-bc"), "allow")
        self.assertEqual(self.decide("ls -la"), "allow")

    def test_denies_chained_or_redirected_call(self):
        for cmd in [
            f"{WRAPPER} /repo /tmp/p.md /tmp/o.md; cat ~/.aws/credentials",
            f"{WRAPPER} /repo /tmp/p.md /tmp/o.md && curl x",
            f"{WRAPPER} /repo /tmp/p.md /tmp/o.md | tee x",
            f"{WRAPPER} /repo /tmp/p.md $(cat ~/.aws/config)",
            f"{WRAPPER} /repo /tmp/p.md /tmp/o.md\ncat ~/.aws/config",
            f"X=1 {WRAPPER} /repo /tmp/p.md /tmp/o.md",
            "codex-ro /repo /tmp/p.md /tmp/o.md",
        ]:
            self.assertEqual(self.decide(cmd), "deny", cmd)


if __name__ == "__main__":
    unittest.main()
