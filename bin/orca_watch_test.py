import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "orca-watch")
STALLWATCH = os.path.join(HERE, "stallwatch")
MIN = 60_000
HOUR = 60 * MIN


class OrcaWatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.home = os.path.join(self.tmp, "home")
        self.up_file = os.path.join(self.tmp, "up")
        self.idle_file = os.path.join(self.tmp, "idle")
        self.opens = os.path.join(self.tmp, "opens")
        self.notes = os.path.join(self.tmp, "notes")
        # 実物の orca status --json の形（runtime.reachable）。落ちているあいだは Orca に繋がらず ok: false。
        self.script("orca", """#!/bin/sh
if [ -f {up} ]; then echo '{{"ok":true,"result":{{"app":{{"running":true}},"runtime":{{"state":"ready","reachable":true}}}}}}'
else echo '{{"ok":false,"error":{{"code":"runtime_unavailable","message":"Could not read Orca runtime metadata"}}}}'; exit 1; fi
""".format(up=self.up_file))
        self.script("ioreg", '#!/bin/sh\nprintf \'    | |     "HIDIdleTime" = %%s\\n\' "$(cat %s)"\n' % self.idle_file)
        self.script("open-orca", "#!/bin/sh\necho open >> %s\n" % self.opens)
        self.script("notify", "#!/bin/sh\nprintf '%%s\\t%%s\\n' \"$1\" \"$2\" >> %s\n" % self.notes)
        self.now = int(time.time() * 1000)
        self.idle(10 * HOUR)

    def script(self, name, body):
        path = os.path.join(self.bin, name)
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)

    def idle(self, ms):
        with open(self.idle_file, "w") as fh:
            fh.write(str(ms * 1_000_000))

    def orca(self, up):
        if up:
            open(self.up_file, "w").close()
        elif os.path.exists(self.up_file):
            os.remove(self.up_file)

    def env(self):
        env = dict(os.environ, PATH=self.bin + ":/usr/bin:/bin", STALLWATCH_HOME=self.home, COCKPIT_DIR=os.path.join(self.tmp, "cockpit"),
                   STALLWATCH_NOTIFY=os.path.join(self.bin, "notify"), ORCA_WATCH_OPEN=os.path.join(self.bin, "open-orca"),
                   ORCA_CLI_COMMAND="orca", ORCA_WATCH_NOW=str(self.now))
        return env

    def tick(self, minutes=1):
        """偽の時計を進めて 1 回見る。"""
        self.now += minutes * MIN
        r = subprocess.run([sys.executable, SCRIPT, "--once"], env=self.env(), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def lines(self, path):
        try:
            with open(path) as fh:
                return fh.read().splitlines()
        except FileNotFoundError:
            return []

    def alerts(self):
        with open(os.path.join(self.home, "orca-watch.json")) as fh:
            return {a["id"]: a for a in json.load(fh)["alerts"]}

    def test_relaunches_orca_that_went_down_while_nobody_was_there(self):
        # 2026-11-22 01:21 の形: 夜通し誰も触っていない Mac で、Orca が正常に終了させられた。
        self.orca(True)
        self.tick()
        self.orca(False)
        out = self.tick()
        self.assertIn("人が触っていない", out)
        # macOS の再起動の手順や Orca の自己更新の途中には割り込まない。
        self.tick(3)
        self.assertEqual(self.lines(self.opens), [])
        out = self.tick(2)
        self.assertEqual(self.lines(self.opens), ["open"])
        self.assertIn("open -a Orca を打った", out)
        # 戻ったのを見るまでは、起動し直したとは帯に出さない。
        self.assertEqual(self.alerts(), {})
        self.orca(True)
        self.assertIn("今は動いている", self.tick())
        self.assertIn("見張りが起動し直した", self.alerts()["orca-watch:relaunched"]["text"])
        # 戻ったら起動しない。帯の知らせは朝に読めるよう残る。
        self.tick(5)
        self.assertEqual(self.lines(self.opens), ["open"])
        self.assertIn("orca-watch:relaunched", self.alerts())
        self.assertEqual(self.lines(self.notes), [])
        # 12 時間たてば帯から消える。
        self.tick(12 * 60)
        self.assertEqual(self.alerts(), {})

    def test_stops_relaunching_and_tells_when_orca_keeps_going_down(self):
        self.orca(True)
        self.tick()
        self.orca(False)
        # 気づいてから 5 分で 1 回目、そのあと 5 分おきに 3 回まで。4 回目の代わりに止めて知らせる。
        counts = []
        for _ in range(20):
            self.tick()
            counts.append(len(self.lines(self.opens)))
        self.assertEqual(counts, [0] * 5 + [1] * 5 + [2] * 5 + [3] * 5)
        self.assertIn("orca-watch:gave-up", self.alerts())
        self.assertEqual(len(self.lines(self.notes)), 1)
        self.assertIn("繋がらない状態が続く", self.lines(self.notes)[0])
        # 1 時間たっても、人が起動するまでは起動し直さず、知らせも重ねない。
        for _ in range(7):
            self.tick(10)
        self.assertEqual(len(self.lines(self.opens)), 3)
        self.assertEqual(len(self.lines(self.notes)), 1)
        # 人が起動して動き続ければ、止めたことは解ける。
        self.orca(True)
        self.tick()
        self.assertNotIn("orca-watch:gave-up", self.alerts())

    def test_counts_crashes_between_short_runs(self):
        # 起動し直すたびにすぐ落ちる。動いた回を挟んでも、1 時間に 3 回で止める。
        self.orca(True)
        self.tick()
        for _ in range(4):
            self.orca(False)
            for _ in range(6):
                self.tick()
            self.orca(True)
            self.tick()
        self.assertEqual(len(self.lines(self.opens)), 3)
        self.assertEqual(len(self.lines(self.notes)), 1)

    def test_leaves_orca_alone_when_someone_quit_it_by_hand(self):
        self.orca(True)
        self.tick()
        self.orca(False)
        self.idle(5_000)
        self.assertIn("自分で終了した", self.tick())
        # そのあと人が席を外しても、同じ止まり方のあいだは起動しない。
        self.idle(10 * HOUR)
        for _ in range(10):
            self.tick()
        self.assertEqual(self.lines(self.opens), [])

    def test_does_not_relaunch_while_paused(self):
        self.orca(True)
        self.tick()
        os.makedirs(self.home, exist_ok=True)
        open(os.path.join(self.home, "orca-watch.pause"), "w").close()
        self.orca(False)
        self.assertIn("一時停止", self.tick())
        for _ in range(10):
            self.tick()
        self.assertEqual(self.lines(self.opens), [])

    def test_a_pause_placed_after_it_noticed_still_holds(self):
        self.orca(True)
        self.tick()
        self.orca(False)
        self.tick()
        # 起動し直すのを待つ間に一時停止を置いた。
        open(os.path.join(self.home, "orca-watch.pause"), "w").close()
        for _ in range(10):
            self.tick()
        self.assertEqual(self.lines(self.opens), [])

    def test_does_not_launch_when_it_cannot_record_the_try(self):
        # 回数を書けないまま起動すると、上限も間隔も守れない。
        self.orca(True)
        self.tick()
        self.orca(False)
        self.tick()
        os.chmod(self.home, 0o500)
        try:
            for _ in range(8):
                self.now += MIN
                subprocess.run([sys.executable, SCRIPT, "--once"], env=self.env(), capture_output=True, text=True)
        finally:
            os.chmod(self.home, 0o700)
        self.assertEqual(self.lines(self.opens), [])

    def test_launches_even_when_the_band_file_cannot_be_written(self):
        os.makedirs(os.path.join(self.home, "orca-watch.json"))
        self.orca(True)
        self.tick()
        self.orca(False)
        for _ in range(6):
            self.tick()
        self.assertEqual(self.lines(self.opens), ["open"])

    def test_does_not_claim_it_relaunched_when_open_failed_and_a_person_started_orca(self):
        self.script("open-orca", "#!/bin/sh\necho open >> %s\necho 'LSOpenURLsWithRole() failed' >&2\nexit 1\n" % self.opens)
        self.orca(True)
        self.tick()
        self.orca(False)
        for _ in range(6):
            self.tick()
        self.assertEqual(self.lines(self.opens), ["open"])
        self.assertIn("LSOpenURLsWithRole", self.alerts()["orca-watch:open-failed"]["text"])
        self.orca(True)
        self.tick()
        self.assertNotIn("orca-watch:relaunched", self.alerts())

    def test_forgets_an_earlier_open_once_a_later_one_failed(self):
        # 1 回目の open は通ったが Orca は戻らず、2 回目は失敗した。そのあと人が起動しても、見張りが起動し直したとは出さない。
        self.script("open-orca", "#!/bin/sh\necho open >> {o}\n[ $(wc -l < {o}) -le 1 ] || exit 1\n".format(o=self.opens))
        self.orca(True)
        self.tick()
        self.orca(False)
        for _ in range(11):
            self.tick()
        self.assertEqual(self.lines(self.opens), ["open"] * 2)
        self.orca(True)
        self.tick()
        self.assertNotIn("orca-watch:relaunched", self.alerts())

    def test_starts_over_from_a_broken_state_file(self):
        os.makedirs(self.home)
        with open(os.path.join(self.home, "orca-watch-state.json"), "w") as fh:
            json.dump({"tries": [None], "alerts": {"x": None}, "down_since": "x"}, fh)
        self.orca(True)
        self.assertIn("空から始め直す", self.tick())
        self.orca(False)
        for _ in range(6):
            self.tick()
        self.assertEqual(self.lines(self.opens), ["open"])

    def test_does_not_relaunch_an_orca_it_never_saw_running(self):
        # ログインの直後など、見張りが動き出したときから Orca が止まっている。
        self.orca(False)
        self.assertIn("見ていない", self.tick())
        for _ in range(10):
            self.tick()
        self.assertEqual(self.lines(self.opens), [])

    def test_stallwatch_shows_it_on_the_band_without_notifying_again(self):
        self.orca(True)
        self.tick()
        self.orca(False)
        for _ in range(6):
            self.tick()
        self.orca(True)
        self.tick()
        r = subprocess.run([sys.executable, STALLWATCH, "--window", "http://127.0.0.1:9"], env=self.env(), capture_output=True, text=True)
        with open(os.path.join(self.tmp, "cockpit", "alerts.json")) as fh:
            texts = {a["id"]: a["text"] for a in json.load(fh)["alerts"]}
        self.assertIn("見張りが起動し直した", texts.get("orca-watch:relaunched", ""), r.stderr)
        self.assertFalse(any("起動し直した" in n for n in self.lines(self.notes)))


if __name__ == "__main__":
    unittest.main()
