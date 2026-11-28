#!/usr/bin/env python3
"""compaction-keep_test.py と consult_returns_test.py が共に使う、一時フォルダの操縦席と hook の呼び方（試験ではない）。"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "compaction-keep.py")
# 返しの未反映は state.ts が決める（compaction-keep.py は写さない）。返しの試験はこのリポジトリの state.ts を呼ぶ
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "orca", "plugins", "cockpit", "window", "state.ts")
SESSION = "s-main"


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="compaction-keep-test-")
        self.addCleanup(shutil.rmtree, self.root, True)
        os.makedirs(os.path.join(self.root, ".orca", "cockpit"))
        self.cockpit = {
            "version": 2, "workspace": {"name": "テスト"}, "streams": [],
            "tasks": [{"id": "t1", "title": "hook を書く", "state": "run", "next": "テストを足す",
                       "worker": {"task_id": "task_a", "dispatch_id": "ctx_a"}},
                      {"id": "t2", "title": "済んだ作業", "state": "ok", "worker": {"task_id": "task_old", "dispatch_id": "ctx_old"}}],
            "cards": [{"id": "d1", "rev": 1, "kind": "decide", "title": "引き継ぎの方式を決める", "state": "open"},
                      {"id": "w1", "rev": 1, "kind": "send", "title": "上限を聞く", "state": "waiting",
                       "awaiting": {"who": "先方の担当者", "what": "上限", "since": "2026-11-20T10:00:00+09:00"}},
                      {"id": "a1", "rev": 1, "kind": "report", "title": "読んだ報告", "state": "done"}],
        }
        self.write_cockpit()
        self.orca_log = os.path.join(self.root, "orca.log")
        self.fake_orca = os.path.join(self.root, "fake-orca")
        with open(self.fake_orca, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\necho \'{"ok":true}\'\n' % self.orca_log)
        os.chmod(self.fake_orca, 0o755)
        self.now = "2026-11-21T10:00:00+09:00"

    def write_cockpit(self):
        with open(os.path.join(self.root, ".orca", "cockpit.json"), "w", encoding="utf-8") as fh:
            json.dump(self.cockpit, fh, ensure_ascii=False)

    def env(self, **extra):
        # 窓口の設定で入れた切り替えが、テストを走らせる端末から漏れないようにする
        # Orca の端末で走らせても、Orca の外として始める（窓口の判定 orca_main_root が ORCA_WORKTREE_ID を見る）
        env = {k: v for k, v in os.environ.items()
               if k not in ("CONSULT_THREAD", "COCKPIT_LEDGER_GUARD", "COCKPIT_STATE") and not k.startswith("ORCA_")}
        # 本物の state.ts は呼ばない（呼ぶテストは偽のスクリプトを渡す）
        env.update(COMPACTION_KEEP_NOW=self.now, COMPACTION_KEEP_ORCA=self.fake_orca, COCKPIT_STATE=os.path.join(self.root, "no-state.js"))
        env.update(extra)
        return env

    def hook(self, event, env=None, **payload):
        payload = {"hook_event_name": event, "session_id": SESSION, "cwd": self.root, **payload}
        done = subprocess.run([HOOK], input=json.dumps(payload), text=True, capture_output=True, env=env or self.env())
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def tool(self, cmd, data=None):
        return subprocess.run([HOOK, cmd, self.root], input=json.dumps(data) if data is not None else "", text=True,
                              capture_output=True, env=self.env())

    def rule(self, **r):
        done = self.tool("rule", r)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.split()[1].rstrip(":")

    def jsonl(self, name):
        p = os.path.join(self.root, ".orca", "cockpit", name)
        if not os.path.exists(p):
            return []
        with open(p, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh]

    def keep(self):
        p = os.path.join(self.root, ".orca", "cockpit", "keep.json")
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# state.ts の unsortedOf（intake の through より後と、through 以前でどの依頼にも none にも結ばれていない発言）と同じ規則
FAKE_UNSORTED = r"""
const fs = require('fs'), path = require('path'), root = process.argv[2]
const c = JSON.parse(fs.readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8'))
const ids = fs.readFileSync(path.join(root, '.orca', 'cockpit', 'utterances.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
const through = ids.indexOf(c.intake.through)
const bound = new Set([...(c.intake.none || []), ...(c.requests || []).flatMap((r) => (r.utterances || []).map((u) => u.id))])
console.log(JSON.stringify({ checks: { unsorted: ids.filter((id, i) => i > through || !bound.has(id)) } }))
"""
