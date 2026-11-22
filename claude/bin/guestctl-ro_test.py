#!/usr/bin/env python3

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
GUARD = os.path.join(HERE, "..", "hooks", "sandbox-exclude-guard.py")
WRAPPER = os.path.join(os.path.realpath(HERE), "guestctl-ro")
OLD_WRAPPER = os.path.join(os.path.realpath(HERE), "spo-ro")
sys.path.insert(0, HERE)
from sandbox_tmp import tmp_root  # noqa: E402


def load():
    loader = importlib.machinery.SourceFileLoader("guestctl_ro", os.path.join(HERE, "guestctl-ro"))
    spec = importlib.util.spec_from_loader("guestctl_ro", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class Argv(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def argv(self, *args):
        return self.m.guestctl_argv(self.m.build_parser().parse_args(list(args)), "/w")

    def test_read_commands_pass_through(self):
        u = "https://c.sharepoint.com/sites/s/Shared%20Documents"
        sp = "sharepoint"
        self.assertEqual(self.argv(sp, "ls", u), [sp, "ls", u])
        self.assertEqual(self.argv(sp, "search", u, "見積", "--limit", "5"), [sp, "search", u, "見積", "--limit=5"])
        self.assertEqual(self.argv(sp, "items", u, "課題", "--filter", "Title eq 'A'", "--all"),
                         [sp, "items", u, "課題", "--filter=Title eq 'A'", "--all"])
        self.assertEqual(self.argv(sp, "api", "GET", u + "/_api/web?$select=Title"), [sp, "api", "GET", u + "/_api/web?$select=Title"])
        self.assertEqual(self.argv(sp, "get", u + "/a.xlsx", "-o", "/tmp/x"), [sp, "get", u + "/a.xlsx", "--output=/w"])
        self.assertEqual(self.argv("teams", "channels", "contoso"), ["teams", "channels", "contoso"])
        self.assertEqual(self.argv("teams", "messages", "contoso", "19:abc@thread.v2", "--limit", "3"),
                         ["teams", "messages", "contoso", "19:abc@thread.v2", "--limit=3"])
        f = "https://files.slack.com/files-pri/T1-F1/a.png"
        self.assertEqual(self.argv("slack", "file", f, "-o", "/tmp/x", "-w", "acme"),
                         ["slack", "file", f, "--output=/w", "--workspace=acme"])

    def test_rejects_writes_login_and_smuggled_options(self):
        u = "https://c.sharepoint.com/sites/s"
        f = "https://acme.slack.com/files/U1/F1/a.png"
        for bad in [
            [u], ["ls", u],  # サービスの指定がない
            *[["sharepoint", *b] for b in [
                ["put", "/tmp/a", u], ["mkdir", u], ["rm", u], ["mv", u, u], ["cp", u, u],
                ["item-add", u, "L", "-d", "{}"], ["item-update", u, "L", "1", "-d", "{}"], ["login", u],
                ["api", "POST", u + "/_api/web"], ["api", "get", u + "/_api/web"],
                ["api", "GET", u + "/_api/web", "-d", "{}"], ["api", "GET", u + "/_api/web", "-H", "X-HTTP-Method:MERGE"],
                ["items", u, "L", "--fil", "x"],  # argparse の略記
                ["search", u, "--overwrite"], ["items", u, "L", "--select", "--all"],
                ["ls", "file:///etc/passwd"], ["get", u + "/a"],
            ]],
            ["teams", "login", "contoso"], ["teams", "chats", "--limit=1"],
            ["slack", "login", "acme"], ["slack", "file", f],  # -o なし
            ["slack", "file", f, "-o", "/tmp/x", "-w", "--all"], ["slack", "file", "http://x/a", "-o", "/tmp/x"],
            ["slack", "file", f, "-o", "/tmp/x", "--work", "acme"],  # argparse の略記
        ]:
            with self.assertRaises(SystemExit, msg=bad):
                self.m.build_parser().parse_args(bad)


class Get(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.dir = tempfile.TemporaryDirectory(dir=tmp_root())
        self.addCleanup(self.dir.cleanup)
        self.d = self.dir.name

    def fake_guestctl(self, argv, stdout):
        out = next(x for x in argv if x.startswith("--output=")).removeprefix("--output=")
        p = os.path.join(out, "a.txt")
        with open(p, "wb") as f:
            f.write(b"body")
        return subprocess.CompletedProcess(argv, 0, json.dumps({"path": p, "bytes": 4}).encode())

    def run_get(self, output, cmd=("sharepoint", "get", "https://c.sharepoint.com/sites/s/a.txt")):
        a = self.m.build_parser().parse_args([*cmd, "-o", output])
        work = tempfile.mkdtemp(dir=self.d)
        with mock.patch.object(self.m.subprocess, "run", side_effect=self.fake_guestctl), \
                mock.patch.object(self.m, "WORK_ROOT", work):
            return self.m.download(a)

    def test_slack_file_saves_like_get(self):
        cmd = ("slack", "file", "https://acme.slack.com/files/U1/F1/a.txt", "-w", "acme")
        self.assertEqual(self.run_get(self.d, cmd), 0)
        with open(os.path.join(self.d, "a.txt"), "rb") as f:
            self.assertEqual(f.read(), b"body")
        self.assertEqual(self.run_get(self.d, cmd), 1)
        with self.assertRaises(SystemExit):
            self.run_get(os.path.expanduser("~/guestctl-ro-should-not-exist"), cmd)
        self.assertFalse(os.path.exists(os.path.expanduser("~/guestctl-ro-should-not-exist")))

    def test_work_dir_is_outside_tmp_root(self):
        # 途中のファイルを worker が書ける場所に置くと、外で読む前に symlink に差し替えられる
        self.assertNotEqual(os.path.commonpath([os.path.realpath(os.path.dirname(self.m.WORK_ROOT)), tmp_root()]), tmp_root())
        self.assertTrue(self.m.WORK_ROOT.startswith(os.path.expanduser("~/.local/share/spo-cli/")))

    def test_saves_into_tmp_root_without_overwrite(self):
        self.assertEqual(self.run_get(self.d), 0)
        with open(os.path.join(self.d, "a.txt"), "rb") as f:
            self.assertEqual(f.read(), b"body")
        self.assertEqual(self.run_get(self.d), 1)

    def test_does_not_write_through_symlink(self):
        target = os.path.join(self.d, "target")
        with open(target, "w") as f:
            f.write("keep")
        link = os.path.join(self.d, "link")
        os.symlink(target, link)
        self.assertEqual(self.run_get(link), 1)
        with open(target) as f:
            self.assertEqual(f.read(), "keep")

    def test_rejects_destination_outside_tmp_root(self):
        with self.assertRaises(SystemExit):
            self.run_get(os.path.expanduser("~/guestctl-ro-should-not-exist"))
        self.assertFalse(os.path.exists(os.path.expanduser("~/guestctl-ro-should-not-exist")))


class Guard(unittest.TestCase):
    def decide(self, cmd):
        r = subprocess.run([GUARD], input=json.dumps({"tool_input": {"command": cmd}}),
                           capture_output=True, text=True, check=True)
        return "deny" if r.stdout.strip() else "allow"

    def test_allows_plain_and_quoted_calls(self):
        for cmd in [
            f"{WRAPPER} sharepoint ls 'https://c.sharepoint.com/sites/s/Shared Documents'",
            f"{WRAPPER} sharepoint api GET 'https://c.sharepoint.com/sites/s/_api/web?$select=Title&$top=5'",
            f"{WRAPPER} sharepoint items https://c.sharepoint.com/sites/s 課題 --filter \"Title eq 'A'\"",
            f"{WRAPPER} teams messages contoso 19:abc@thread.v2 --limit 20",
            f"{WRAPPER} slack file 'https://acme.slack.com/files/U1/F1/a.png' -o /tmp/claude-501/x -w acme",
            f"{OLD_WRAPPER} ls 'https://c.sharepoint.com/sites/s'",
            f"{WRAPPER} sharepoint search https://c.sharepoint.com/sites/s 'spo-ro'",
        ]:
            self.assertEqual(self.decide(cmd), "allow", cmd)

    def test_denies_old_name_misuse(self):
        for cmd in [
            f"{OLD_WRAPPER} ls https://c.sharepoint.com/s; id",
            f"{OLD_WRAPPER} ls $(id)",
            "spo-ro ls https://c.sharepoint.com/s",
        ]:
            self.assertEqual(self.decide(cmd), "deny", cmd)

    def test_denies_chained_expanded_or_redirected_call(self):
        for cmd in [
            f"{WRAPPER} sharepoint ls https://c.sharepoint.com/s; cat ~/.aws/credentials",
            f"{WRAPPER} sharepoint ls https://c.sharepoint.com/s && curl x",
            f"{WRAPPER} sharepoint ls https://c.sharepoint.com/s | tee x",
            f"{WRAPPER} sharepoint ls https://c.sharepoint.com/s > ~/x",
            f"{WRAPPER} sharepoint ls $(cat ~/.aws/config)",
            f"{WRAPPER} sharepoint ls \"$(cat ~/.aws/config)\"",
            f"{WRAPPER} sharepoint ls `id`",
            f"{WRAPPER} sharepoint ls https://c.sharepoint.com/s\ncat ~/.aws/config",
            f"{WRAPPER} sharepoint ls 'unterminated",
            f"{WRAPPER} sharepoint get https://c.sharepoint.com/s/a -o ~/x",
            f"{WRAPPER} slack file https://acme.slack.com/files/U1/F1/a -o ~/x",
            f"{WRAPPER} sharepoint ls https://c.sharepoint.com/s*",
            f"X=1 {WRAPPER} sharepoint ls https://c.sharepoint.com/s",
            "guestctl-ro sharepoint ls https://c.sharepoint.com/s",
            f"bash -c '{WRAPPER} sharepoint ls x; id'",
        ]:
            self.assertEqual(self.decide(cmd), "deny", cmd)


class OldName(unittest.TestCase):
    def error(self, *args):
        r = subprocess.run([OLD_WRAPPER, *args], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        return r.stderr.splitlines()[0]

    def test_maps_to_sharepoint_or_teams(self):
        # 引数の検査で止まる呼び方で、旧名の形が guestctl-ro のどのサブコマンドに渡ったかを見る
        self.assertIn("https://", self.error("ls", "file:///etc/passwd"))
        self.assertIn("conversation_id", self.error("teams", "messages", "contoso"))
        self.assertIn("invalid choice: 'login'", self.error("login", "https://c.sharepoint.com/s"))
        self.assertIn("invalid choice: 'login'", self.error("teams", "login", "contoso"))


if __name__ == "__main__":
    unittest.main()
