import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "worktree-sweep")
HOUR = 3600_000

# 偽の orca。読む一覧は ORCA_FAKE の下の JSON から返し、worktree rm は本物の Orca と同じく git worktree remove とブランチの削除をする。
FAKE_ORCA = r'''#!%s
import json, os, subprocess, sys
d = os.environ["ORCA_FAKE"]
args = [a for a in sys.argv[1:] if a != "--json"]
with open(os.path.join(d, "calls"), "a") as fh:
    fh.write(" ".join(args) + "\n")
def out(name):
    p = os.path.join(d, name)
    if not os.path.exists(p):
        sys.stderr.write("connect ECONNREFUSED\n"); sys.exit(1)
    print(json.dumps({"ok": True, "result": json.load(open(p))}))
key = " ".join(args[:2])
if key == "worktree ps":
    n = sum(1 for l in open(os.path.join(d, "calls")) if l.startswith("worktree ps"))
    out("ps-after.json" if n > 1 and os.path.exists(os.path.join(d, "ps-after.json")) else "ps.json")
elif key == "plugin list": out("plugins.json")
elif key == "orchestration worker-list":
    n = sum(1 for l in open(os.path.join(d, "calls")) if l.startswith("orchestration worker-list"))
    out("missing.json" if n > 1 and os.path.exists(os.path.join(d, "fail-after-first")) else "workers.json")
elif key == "orchestration dispatch-show":
    links = json.load(open(os.path.join(d, "links.json"))) if os.path.exists(os.path.join(d, "links.json")) else {}
    print(json.dumps({"ok": True, "result": {"dispatch": links.get(args[args.index("--task") + 1])}}))
elif key == "worktree rm":
    path = args[args.index("--worktree") + 1][len("path:"):]
    branch = subprocess.run(["git", "-C", path, "branch", "--show-current"], capture_output=True, text=True).stdout.strip()
    common = subprocess.run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                            capture_output=True, text=True).stdout.strip()
    r = subprocess.run(["git", "--git-dir", common, "worktree", "remove"] + (["--force"] if "--force" in args else []) + [path],
                       capture_output=True, text=True)
    if r.returncode:
        print(json.dumps({"ok": False, "error": {"message": r.stderr.strip()}})); sys.exit(1)
    subprocess.run(["git", "--git-dir", common, "branch", "-d", branch], capture_output=True)
    print(json.dumps({"ok": True, "result": {}}))
''' % sys.executable

# 偽の gh。gh pr list --state merged --head <branch> に、ORCA_FAKE の prs.json（ブランチ → PR の一覧）を返す。
FAKE_GH = r'''#!%s
import json, os, sys
d = os.environ["ORCA_FAKE"]
a = sys.argv[1:]
with open(os.path.join(d, "gh-calls"), "a") as fh:
    fh.write(" ".join(a) + "\n")
p = os.path.join(d, "prs.json")
prs = json.load(open(p)) if os.path.exists(p) else {}
base = a[a.index("--base") + 1] if "--base" in a else None
print(json.dumps([x for x in prs.get(a[a.index("--head") + 1], []) if base in (None, x.get("base", "trunk"))]))
''' % sys.executable


def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


class WorktreeSweepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = os.path.join(self.tmp, "fake")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.fake)
        os.makedirs(self.bin)
        for name, body in (("orca", FAKE_ORCA), ("gh", FAKE_GH)):
            with open(os.path.join(self.bin, name), "w") as fh:
                fh.write(body)
            os.chmod(os.path.join(self.bin, name), 0o755)
        self.prs = {}
        self.links = {}  # dispatch-show --task の dispatch（続き・やり直しの元）
        self.under = os.path.join(self.tmp, "workspaces")
        self.root = os.path.join(self.tmp, "repo")
        os.makedirs(self.root)
        git(self.root, "init", "-q", "-b", "trunk")
        git(self.root, "config", "user.email", "t@example.com")
        git(self.root, "config", "user.name", "t")
        self.commit(self.root, ".gitignore", ".env\nnode_modules/\n.DS_Store\npostgres_data/\n")
        # default ブランチは origin/HEAD が指す trunk にする。
        git(self.root, "update-ref", "refs/remotes/origin/trunk", "HEAD")
        git(self.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
        self.rows = [self.row(self.root, "trunk", main=True)]
        self.workers = []
        self.plugins = []
        self.workers_doc = self.plugins_doc = None  # 渡すと一覧の代わりにそのまま返す

    def commit(self, cwd, name, body):
        with open(os.path.join(cwd, name), "w") as fh:
            fh.write(body)
        git(cwd, "add", name)
        git(cwd, "commit", "-q", "-m", "add " + name)

    def row(self, path, branch, main=False, agents=(), idle=1, status="in-progress", repo="r1"):
        return {"path": path, "branch": "refs/heads/" + branch, "repoId": repo, "repo": "repo", "isMainWorktree": main,
                "workspaceKind": "git", "hostId": "local", "displayName": os.path.basename(path), "agents": list(agents),
                "workspaceStatus": status, "lastActivityAt": int(time.time() * 1000) - idle * HOUR,
                "createdAt": int(time.time() * 1000) - 48 * HOUR,
                "worktreeId": "r1::" + path, "parentWorktreeId": None if main else "r1::" + self.root}

    def worktree(self, name, finished=True, **kw):
        """finished: その worktree を使った worker が終わった記録（dispatch）を Orca の一覧に置く。"""
        path = os.path.join(self.under, "repo", name)
        git(self.root, "worktree", "add", "-q", "-b", name, path)
        self.rows.append(self.row(path, name, **kw))
        if finished:
            self.workers.append({"state": "succeeded", "liveness": "unverifiable", "workspace": "r1::" + path})
        return path

    def run_sweep(self, *args, code=0):
        for name, data in (("ps.json", {"worktrees": self.rows}), ("plugins.json", {"plugins": self.plugins} if self.plugins_doc is None else self.plugins_doc),
                           ("workers.json", {"workers": self.workers, "scope": {"source": "all"}} if self.workers_doc is None
                            and self.workers is not None else self.workers_doc)):
            if data is not None:
                with open(os.path.join(self.fake, name), "w") as fh:
                    json.dump(data, fh)
        with open(os.path.join(self.fake, "prs.json"), "w") as fh:
            json.dump(self.prs, fh)
        with open(os.path.join(self.fake, "links.json"), "w") as fh:
            json.dump(self.links, fh)
        env = dict(os.environ, PATH=self.bin + ":/usr/bin:/bin", ORCA_FAKE=self.fake, ORCA_CLI_COMMAND="orca",
                   WORKTREE_SWEEP_HOME=os.path.join(self.tmp, "home"))
        r = subprocess.run([sys.executable, SCRIPT, "--under", self.under] + list(args), env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        return r.stdout

    def kind(self, out, path):
        (line,) = [l for l in out.splitlines() if ": %s（" % path in l]
        return line.split(":", 1)[0]

    def removed(self):
        if not os.path.exists(os.path.join(self.fake, "calls")):
            return []
        with open(os.path.join(self.fake, "calls")) as fh:
            return [l.split()[3][len("path:"):] for l in fh.read().splitlines() if l.startswith("worktree rm")]

    def test_three_kinds_and_only_removable_ones_are_removed(self):
        merged = self.worktree("merged")
        working = self.worktree("working", agents=[{"state": "working"}])
        kept = self.worktree("kept", status="completed")
        lead = self.worktree("lead")
        self.workers += [{"state": "ready", "liveness": "live", "workspace": "r1::" + lead}]
        chat = self.worktree("chat", agents=[{"state": "done", "address": "orca_session_id:x"}])
        stale = self.worktree("stale", idle=30)
        self.commit(stale, "b.txt", "b")
        fresh = self.worktree("fresh", idle=2)
        self.commit(fresh, "c.txt", "c")
        dirty = self.worktree("dirty", idle=30)
        with open(os.path.join(dirty, "a.txt"), "w") as fh:
            fh.write("changed")
        out = self.run_sweep()
        self.assertEqual(self.kind(out, merged), "消してよい")
        for p in (working, kept, lead, chat, fresh):
            self.assertEqual(self.kind(out, p), "触らない", p)
        self.assertEqual(self.kind(out, stale), "判断が要る")
        self.assertEqual(self.kind(out, dirty), "判断が要る")
        self.assertNotIn(self.root + "（", out, "リポジトリのルートは対象にしない")
        self.assertEqual(self.removed(), [], "--apply が無ければ消さない")
        with open(os.path.join(self.tmp, "home", "sweep.json")) as fh:
            sweep = json.load(fh)
        self.assertEqual(sorted(e["path"] for e in sweep["decide"]), sorted([stale, dirty]))
        self.assertIn("b.txt", " ".join(sweep["decide"][1 if sweep["decide"][0]["path"] == dirty else 0]["reasons"]))
        self.assertEqual({e["main"] for e in sweep["decide"]}, {self.root}, "メインの hook が自分の下だけを拾えるように窓口を書く")
        # 担当の worktree の下に立てた worker も、親を辿って窓口に届く。
        self.rows[-1]["parentWorktreeId"] = "r1::" + lead
        self.run_sweep()
        with open(os.path.join(self.tmp, "home", "sweep.json")) as fh:
            sweep = json.load(fh)
        nested = [e for e in sweep["decide"] if e["path"] == dirty][0]
        self.assertEqual((nested["parent"], nested["main"]), (lead, self.root))

        out = self.run_sweep("--apply")
        self.assertEqual(self.removed(), [merged])
        self.assertFalse(os.path.exists(merged))
        self.assertNotIn("merged", git(self.root, "branch", "--list", "merged"), "ブランチも消す")
        for p in (working, kept, lead, chat, stale, fresh, dirty):
            self.assertTrue(os.path.exists(p), p)
        self.assertIn("消した: %s（merged）" % merged, out)

    def test_squash_merged_branch_is_left_for_a_person(self):
        squashed = self.worktree("squashed", idle=30)
        self.commit(squashed, "b.txt", "b")
        self.commit(squashed, "c.txt", "c")
        # trunk には同じ中身を 1 つの commit にまとめて入れる（squash merge）。
        git(self.root, "merge", "-q", "--squash", "squashed")
        git(self.root, "commit", "-q", "-m", "squash")
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, squashed), "判断が要る")
        self.assertIn("trunk に無い commit 2 件", out)
        self.assertEqual(self.removed(), [])

    def squash_merged(self, name, **kw):
        """name のブランチを 2 commit 積んで trunk に squash でマージし、その PR（head は今の HEAD）をマージ済みとして置く。
        終わった Dispatch の記録は無い（担当の居場所や手で立てた worktree）。"""
        path = self.worktree(name, finished=False, **kw)
        self.commit(path, name + "-b.txt", "b")
        self.commit(path, name + "-c.txt", "c")
        git(self.root, "merge", "-q", "--squash", name)
        git(self.root, "commit", "-q", "-m", "squash " + name)
        self.prs[name] = [{"number": 7, "headRefOid": git(path, "rev-parse", "HEAD")}]
        return path

    def test_squash_merged_pr_without_a_dispatch_record_is_removed(self):
        squashed = self.squash_merged("squashed")
        out = self.run_sweep("--apply")
        self.assertEqual(self.removed(), [squashed])
        self.assertIn("消した: %s（squashed）" % squashed, out)
        with open(os.path.join(self.fake, "gh-calls")) as fh:
            self.assertIn("pr list --state merged --head squashed", fh.read())

    def test_squash_merged_pr_with_commits_after_the_merge_is_kept(self):
        later = self.squash_merged("later", idle=30)
        self.commit(later, "d.txt", "d")
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, later), "判断が要る")
        self.assertIn("PR #7 はマージ済みだが、マージのあとに積んだ commit がある", out)
        self.assertEqual(self.removed(), [])

    def test_pr_merged_into_a_stacked_parent_is_not_taken_as_merged(self):
        # 積み重ねた PR: child → parent だけがマージ済みで、parent → trunk はまだ。
        child = self.worktree("child", finished=False, idle=30)
        self.commit(child, "b.txt", "b")
        self.prs["child"] = [{"number": 8, "headRefOid": git(child, "rev-parse", "HEAD"), "base": "parent"}]
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, child), "判断が要る")
        self.assertEqual(self.removed(), [])
        with open(os.path.join(self.fake, "gh-calls")) as fh:
            self.assertIn("--head child --base trunk", fh.read())

    def test_merged_pr_does_not_clear_a_failed_comparison(self):
        squashed = self.squash_merged("squashed")
        git(self.root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
        out = self.run_sweep("--apply")
        self.assertIn("default ブランチを決められない", out)
        self.assertEqual(self.removed(), [])
        self.assertTrue(os.path.exists(squashed))

    def test_squash_merged_pr_with_uncommitted_changes_or_a_working_agent_is_kept(self):
        dirty = self.squash_merged("dirty", idle=30)
        with open(os.path.join(dirty, "dirty-b.txt"), "w") as fh:
            fh.write("changed")
        busy = self.squash_merged("busy", agents=[{"state": "working"}])
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, dirty), "判断が要る")
        self.assertIn("未 commit のファイル 1 件", out)
        self.assertEqual(self.kind(out, busy), "触らない")
        self.assertEqual(self.removed(), [])

    def test_fast_forwarded_branch_is_removed(self):
        ff = self.worktree("ff")
        self.commit(ff, "b.txt", "b")
        git(self.root, "merge", "-q", "--ff-only", "ff")
        self.run_sweep("--apply")
        self.assertEqual(self.removed(), [ff])

    def test_dev_plugin_source_is_not_removed(self):
        dev = self.worktree("dev")
        self.plugins = [{"pluginKey": "local.cockpit", "isDev": True, "source": {"reference": os.path.join(dev, "plugin")}},
                        {"pluginKey": "local.other", "isDev": False, "source": {"reference": self.worktree("other")}}]
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, dev), "触らない")
        self.assertIn("開発用プラグインの読み込み元", out)
        self.assertEqual(self.removed(), [os.path.join(self.under, "repo", "other")], "本物のプラグインの読み込み元は見ない")

    def test_two_worktrees_on_the_same_branch_are_not_removed(self):
        one = self.worktree("one")
        twin = dict(self.rows[-1], path=os.path.join(self.under, "repo", "twin"))
        self.rows.append(twin)
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, one), "判断が要る")
        self.assertIn("取り違え", out)
        self.assertEqual(self.removed(), [])

    def test_orca_branch_record_mismatch_is_not_removed(self):
        moved = self.worktree("moved")
        git(moved, "checkout", "-q", "-b", "elsewhere")
        out = self.run_sweep("--apply")
        self.assertIn("実際のブランチ elsewhere", out)
        self.assertEqual(self.removed(), [])

    def test_ignored_files_unlike_the_root_keep_the_worktree(self):
        local = self.worktree("local", idle=30)
        copy = self.worktree("copy")
        with open(os.path.join(self.root, ".env"), "w") as fh:
            fh.write("A=1\n")
        with open(os.path.join(self.root, "CLAUDE.local.md"), "w") as fh:
            fh.write("memo\n")
        with open(os.path.join(local, ".env"), "w") as fh:
            fh.write("A=2\n")
        os.makedirs(os.path.join(copy, "node_modules", "x"))
        open(os.path.join(copy, "node_modules", "x", "i.js"), "w").close()
        # pytest は .pytest_cache に「*」だけの .gitignore を置く。日本語のパスの .DS_Store も作業の跡ではない。
        os.makedirs(os.path.join(copy, ".pytest_cache", "v"))
        with open(os.path.join(copy, ".pytest_cache", ".gitignore"), "w") as fh:
            fh.write("# Created by pytest automatically.\n*\n")
        open(os.path.join(copy, ".pytest_cache", "v", "lastfailed"), "w").close()
        os.makedirs(os.path.join(copy, "資料"))
        open(os.path.join(copy, "資料", ".DS_Store"), "w").close()
        with open(os.path.join(copy, ".env"), "w") as fh:
            fh.write("A=1\n")
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, local), "判断が要る")
        self.assertIn("gitignore されたファイルがルートと違うかルートに無い（.env）", out)
        self.assertEqual(self.removed(), [copy], "ルートと同じ .env と作り直せるものだけなら消す")
        with open(os.path.join(self.fake, "calls")) as fh:
            self.assertNotIn("--force", fh.read())
        self.assertFalse(os.path.exists(copy))

    def test_untracked_copy_of_a_root_file_is_left_untouched(self):
        # 最後に確かめたあとに人が保存するかもしれないので、ルートと同じ中身でも無人では消さない。
        copy = self.worktree("copy", idle=30)
        for d in (self.root, copy):
            with open(os.path.join(d, "CLAUDE.local.md"), "w") as fh:
                fh.write("memo\n")
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, copy), "判断が要る")
        self.assertEqual(self.removed(), [])
        self.assertTrue(os.path.exists(os.path.join(copy, "CLAUDE.local.md")))

    def test_ignored_directory_that_is_not_regenerable_keeps_the_worktree(self):
        db = self.worktree("db", idle=30)
        built = self.worktree("built")
        os.makedirs(os.path.join(db, "postgres_data"))
        open(os.path.join(db, "postgres_data", "PG_VERSION"), "w").close()
        os.makedirs(os.path.join(built, "node_modules", "x"))
        open(os.path.join(built, "node_modules", "x", "i.js"), "w").close()
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, db), "判断が要る")
        self.assertIn("postgres_data/", out)
        self.assertEqual(self.removed(), [built])

    def test_worktree_without_a_finished_worker_is_not_removed(self):
        # 人が Orca で作ったばかりで、まだ会話も編集も始めていない worktree。
        new = self.worktree("new", finished=False)
        old = self.worktree("old", finished=False, idle=30)
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, new), "触らない")
        self.assertEqual(self.kind(out, old), "判断が要る")
        self.assertIn("終わった記録が無い", out)
        self.assertEqual(self.removed(), [])

    def ledger(self, tasks=(), owners=()):
        """窓口の帳簿（ルートの .orca/cockpit.json）。tasks・owners は (Orca の task_id, state) の組。"""
        os.makedirs(os.path.join(self.root, ".orca"), exist_ok=True)
        with open(os.path.join(self.root, ".orca", "cockpit.json"), "w") as fh:
            json.dump({"tasks": [{"id": "t%d" % i, "state": st, "worker": {"run_id": "run_m", "task_id": tid}} for i, (tid, st) in enumerate(tasks)],
                       "owners": [{"id": "o%d" % i, "state": st, "worker": {"run_id": "run_m", "task_id": tid}} for i, (tid, st) in enumerate(owners)]}, fh)

    def test_stopped_worker_counts_as_finished(self):
        # worker-stop で止めた worker（2026-11-28 の一覧で intloop-aidx/task-1126-lead などが「生きている」扱いで残っていた）。
        stopped = self.worktree("stopped", finished=False)
        self.workers.append({"state": "stopped", "liveness": "exited", "workspace": "r1::" + stopped})
        self.run_sweep("--apply")
        self.assertEqual(self.removed(), [stopped])

    def test_closed_without_worker_done_is_removed_once_the_ledger_settles_it(self):
        # 担当がチャットを閉じた（worker_done なしで端末が exited）dispatch は、窓口の帳簿で結んだタスク・担当が済なら終わったものとして数える。
        lead = self.worktree("lead", finished=False)
        worker = self.worktree("worker", finished=False)
        running = self.worktree("running", finished=False)
        restarted = self.worktree("restarted", finished=False)
        self.workers += [{"state": "ready", "liveness": "exited", "taskId": "task_lead", "dispatchId": "ctx_lead", "workspace": "r1::" + lead},
                         {"state": "ready", "liveness": "exited", "taskId": "task_w", "workspace": "r1::" + worker},
                         {"state": "ready", "liveness": "live", "taskId": "task_run", "workspace": "r1::" + running},
                         {"state": "ready", "liveness": "unverifiable", "taskId": "task_re", "workspace": "r1::" + restarted}]
        out = self.run_sweep("--apply")
        for p in (lead, worker, running, restarted):
            self.assertEqual(self.kind(out, p), "触らない", p)
        self.assertIn("帳簿で結んだタスク・担当が済になっていない", out)
        self.ledger(tasks=[("task_w", "open"), ("task_run", "ok"), ("task_re", "ok")], owners=[("task_lead", "open")])
        self.run_sweep("--apply")
        self.assertEqual(self.removed(), [], "帳簿で開いているタスク・担当の worktree は消さない")
        self.ledger(tasks=[("task_w", "ok"), ("task_run", "ok"), ("task_re", "ok")], owners=[("task_lead", "done")])
        out = self.run_sweep("--apply")
        self.assertEqual(sorted(self.removed()), sorted([lead, worker]))
        self.assertEqual(self.kind(out, running), "触らない", "端末が生きている dispatch は帳簿が済でも消さない")
        self.assertEqual(self.kind(out, restarted), "触らない", "Orca の再起動で確かめられない（unverifiable）だけの dispatch は帳簿が済でも消さない")

    def test_ledger_settles_only_when_every_bound_row_is_done(self):
        # 同じ worktree の別の dispatch に結んだタスクが開いていれば消さない。帳簿に結んだ行が無い dispatch が 1 つでもあれば消さない。
        two = self.worktree("two", finished=False)
        stray = self.worktree("stray", finished=False)
        unbound = self.worktree("unbound", finished=False)
        self.workers += [{"state": "succeeded", "liveness": "exited", "taskId": "task_a", "workspace": "r1::" + two},
                         {"state": "ready", "liveness": "exited", "taskId": "task_b", "workspace": "r1::" + two},
                         {"state": "succeeded", "liveness": "exited", "taskId": "task_c", "workspace": "r1::" + stray},
                         {"state": "ready", "liveness": "exited", "taskId": "task_d", "dispatchId": "ctx_d", "workspace": "r1::" + stray},
                         {"state": "ready", "liveness": "exited", "taskId": "task_x", "workspace": "r1::" + unbound}]
        self.ledger(tasks=[("task_a", "ok"), ("task_b", "open"), ("task_c", "ok")])
        out = self.run_sweep("--apply")
        self.assertEqual(self.removed(), [])
        for p in (two, stray, unbound):
            self.assertEqual(self.kind(out, p), "触らない", p)

    def test_follow_up_of_a_settled_owner_counts_as_settled(self):
        # 担当に send で続きを渡すと Task と Dispatch が新しくなる。続きの元をたどった先が帳簿で済なら、続きも終わったものとして数える。
        lead = self.worktree("lead", finished=False)
        self.workers += [{"state": "succeeded", "liveness": "exited", "taskId": "task_l1", "dispatchId": "ctx_l1", "workspace": "r1::" + lead},
                         {"state": "ready", "liveness": "exited", "taskId": "task_l2", "dispatchId": "ctx_l2", "workspace": "r1::" + lead},
                         {"state": "ready", "liveness": "exited", "taskId": "task_l3", "dispatchId": "ctx_l3", "workspace": "r1::" + lead}]
        self.links = {"task_l2": {"follow_up_of_dispatch_id": "ctx_l1"}, "task_l3": {"retry_of_dispatch_id": "ctx_l2"}}
        self.ledger(owners=[("task_l1", "open")])
        out = self.run_sweep("--apply")
        self.assertEqual(self.removed(), [], "たどった先の行が開いていれば消さない")
        self.ledger(owners=[("task_l1", "done")])
        self.run_sweep("--apply")
        self.assertEqual(self.removed(), [lead])

    def test_follow_up_found_in_another_worktree_must_be_settled_too(self):
        # 続きの元が別の worktree の dispatch で、その帳簿の行が開いていれば、続きの worktree も消さない。
        child = self.worktree("child", finished=False)
        self.workers += [{"state": "ready", "liveness": "exited", "taskId": "task_c", "dispatchId": "ctx_c", "workspace": "r1::" + child},
                         {"state": "ready", "liveness": "live", "taskId": "task_p", "dispatchId": "ctx_p", "workspace": "r1::/elsewhere"}]
        self.links = {"task_c": {"follow_up_of_dispatch_id": "ctx_p"}}
        self.ledger(owners=[("task_p", "open")])
        self.run_sweep("--apply")
        self.assertEqual(self.removed(), [])

    def test_long_follow_up_chain_reaches_the_first_task(self):
        # 担当に続きを何度渡しても（ここでは 30 回）、帳簿が指す最初の Task までたどる。
        lead = self.worktree("lead", finished=False)
        self.workers.append({"state": "succeeded", "liveness": "exited", "taskId": "task_0", "dispatchId": "ctx_0", "workspace": "r1::" + lead})
        for n in range(1, 31):
            self.workers.append({"state": "ready", "liveness": "exited", "taskId": "task_%d" % n, "dispatchId": "ctx_%d" % n, "workspace": "r1::" + lead})
            self.links["task_%d" % n] = {"follow_up_of_dispatch_id": "ctx_%d" % (n - 1)}
        self.ledger(owners=[("task_0", "done")])
        self.run_sweep("--apply")
        self.assertEqual(self.removed(), [lead])

    def test_settled_ledger_does_not_remove_unfinished_work(self):
        # 帳簿で済でも、未 commit の差分か main に無い commit があれば、今の sweep と同じく人に決めさせる。
        dirty = self.worktree("dirty", finished=False, idle=30)
        ahead = self.worktree("ahead", finished=False, idle=30)
        with open(os.path.join(dirty, "a.txt"), "w") as fh:
            fh.write("changed")
        self.commit(ahead, "b.txt", "b")
        self.workers += [{"state": "ready", "liveness": "exited", "taskId": "task_d", "workspace": "r1::" + dirty},
                         {"state": "ready", "liveness": "exited", "taskId": "task_h", "workspace": "r1::" + ahead}]
        self.ledger(tasks=[("task_d", "ok"), ("task_h", "ok")])
        out = self.run_sweep("--apply")
        self.assertEqual(self.removed(), [])
        self.assertEqual(self.kind(out, dirty), "判断が要る")
        self.assertEqual(self.kind(out, ahead), "判断が要る")
        self.assertIn("trunk に無い commit 1 件", out)

    def test_lists_missing_their_arrays_count_as_unreadable(self):
        merged = self.worktree("merged")
        for workers, plugins in (({"scope": {"source": "all"}}, None), (None, {}),
                                 (None, {"plugins": [{"pluginKey": "local.x", "isDev": True, "source": {}}]})):
            self.workers_doc, self.plugins_doc = workers, plugins
            out = self.run_sweep("--apply", code=1)
            self.assertEqual(self.kind(out, merged), "触らない", (workers, plugins))
        self.assertEqual(self.removed(), [])

    def test_root_notes_ignored_and_identical_to_the_root_are_kept(self):
        notes = self.worktree("notes", idle=30)
        with open(os.path.join(self.root, ".gitignore"), "a") as fh:
            fh.write("CLAUDE.local.md\n")
        git(self.root, "commit", "-qam", "ignore notes")
        git(notes, "merge", "-q", "--ff-only", "trunk")
        for d in (self.root, notes):
            with open(os.path.join(d, "CLAUDE.local.md"), "w") as fh:
                fh.write("memo\n")
        out = self.run_sweep("--apply")
        self.assertIn("CLAUDE.local.md", out)
        self.assertEqual(self.removed(), [])

    def test_dispatch_with_unknown_liveness_still_protects(self):
        merged = self.worktree("merged", finished=False)
        for liveness in (None, "starting"):
            self.workers = [{"state": "succeeded", "workspace": "r1::" + merged, **({"liveness": liveness} if liveness else {})}]
            out = self.run_sweep("--apply")
            self.assertEqual(self.kind(out, merged), "触らない", liveness)
        self.assertEqual(self.removed(), [])

    def test_worktree_recreated_on_a_finished_workers_path_waits_a_day(self):
        # 終わった worker の worktree を片付けたあと、人が同じパスに作り直したばかりのもの。
        again = self.worktree("again")
        self.rows[-1]["createdAt"] = int(time.time() * 1000) - HOUR
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, again), "触らない")
        self.assertIn("作られて 24 時間たっていない", out)
        self.assertEqual(self.removed(), [])

    def test_open_conversation_is_not_offered_as_a_decision(self):
        waiting = self.worktree("waiting", idle=30, agents=[{"state": "done", "address": "orca_session_id:x"}])
        self.commit(waiting, "b.txt", "b")
        out = self.run_sweep()
        self.assertEqual(self.kind(out, waiting), "触らない")
        self.assertIn("会話が開いている", out)

    def test_nothing_is_removed_when_dispatches_or_plugins_cannot_be_read(self):
        merged = self.worktree("merged")
        self.workers = None
        out = self.run_sweep("--apply", code=1)
        self.assertEqual(self.kind(out, merged), "触らない")
        self.assertEqual(self.removed(), [])

    def test_ignored_file_inside_an_untracked_directory_is_seen(self):
        nested = self.worktree("nested")
        os.makedirs(os.path.join(nested, "config"))
        with open(os.path.join(nested, "config", ".env"), "w") as fh:
            fh.write("A=1\n")
        out = self.run_sweep("--apply")
        self.assertIn("（config/.env）", out)
        self.assertEqual(self.removed(), [])

    def test_commits_split_between_local_and_origin_are_not_merged(self):
        split = self.worktree("split", idle=30)
        self.commit(split, "b.txt", "b")
        b = git(split, "rev-parse", "HEAD")
        self.commit(split, "c.txt", "c")
        c = git(split, "rev-parse", "HEAD")
        # ローカルの trunk には b だけ、origin/trunk には c だけを入れる。どちらにも全部はそろっていない。
        base = git(self.root, "rev-parse", "HEAD")
        git(self.root, "cherry-pick", b)
        other = os.path.join(self.tmp, "other")
        git(self.root, "worktree", "add", "-q", "--detach", other, base)
        git(other, "cherry-pick", c)
        git(self.root, "update-ref", "refs/remotes/origin/trunk", git(other, "rev-parse", "HEAD"))
        git(self.root, "worktree", "remove", "--force", other)
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, split), "判断が要る")
        self.assertEqual(self.removed(), [])

    def test_tag_named_like_the_default_branch_is_not_mistaken_for_it(self):
        tagged = self.worktree("tagged", idle=30)
        self.commit(tagged, "b.txt", "b")
        git(self.root, "tag", "trunk", git(tagged, "rev-parse", "HEAD"))
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, tagged), "判断が要る")
        self.assertEqual(self.removed(), [])

    def test_worktree_that_started_working_after_the_first_look_is_kept(self):
        merged = self.worktree("merged")
        after = [dict(r, agents=[{"state": "working"}]) if r["path"] == merged else r for r in self.rows]
        with open(os.path.join(self.fake, "ps-after.json"), "w") as fh:
            json.dump({"worktrees": after}, fh)
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, merged), "触らない")
        self.assertEqual(self.removed(), [])
        self.assertTrue(os.path.exists(merged))

    def test_dev_plugin_loaded_through_a_symlink_is_protected(self):
        dev = self.worktree("dev")
        link = os.path.join(self.tmp, "link")
        os.symlink(dev, link)
        self.plugins = [{"pluginKey": "local.cockpit", "isDev": True, "source": {"reference": os.path.join(link, "plugin")}}]
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, dev), "触らない")
        self.assertEqual(self.removed(), [])

    def test_root_file_linking_to_the_worktree_is_not_a_copy(self):
        linked = self.worktree("linked")
        with open(os.path.join(linked, "CLAUDE.local.md"), "w") as fh:
            fh.write("only here\n")
        os.symlink(os.path.join(linked, "CLAUDE.local.md"), os.path.join(self.root, "CLAUDE.local.md"))
        out = self.run_sweep("--apply")
        self.assertIn("未 commit のファイル 1 件", out)
        self.assertEqual(self.removed(), [])

    def test_dev_plugin_through_a_tracked_link_inside_the_worktree_is_protected(self):
        outside = os.path.join(self.tmp, "outside-plugin")
        os.makedirs(outside)
        os.symlink(outside, os.path.join(self.root, "plugin"))
        git(self.root, "add", "plugin")
        git(self.root, "commit", "-q", "-m", "link")
        dev = self.worktree("dev")
        self.plugins = [{"pluginKey": "local.cockpit", "isDev": True, "source": {"reference": os.path.join(dev, "plugin")}}]
        out = self.run_sweep("--apply")
        self.assertEqual(self.kind(out, dev), "触らない")
        self.assertEqual(self.removed(), [])

    def test_stops_removing_when_orca_cannot_be_read_again(self):
        first, second = self.worktree("first"), self.worktree("second")
        open(os.path.join(self.fake, "fail-after-first"), "w").close()
        out = self.run_sweep("--apply", code=1)
        self.assertEqual(self.removed(), [])
        self.assertTrue(os.path.exists(first) and os.path.exists(second))
        self.assertIn("読めなかったので消していない", out.splitlines()[-1])
        with open(os.path.join(self.tmp, "home", "sweep.json")) as fh:
            self.assertFalse(json.load(fh)["readable"])


if __name__ == "__main__":
    unittest.main()
