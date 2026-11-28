#!/usr/bin/env python3
"""consult_returns.py（カードの相談と窓からの質問）を、compaction-keep.py の hook と道具の口から試す。発言の記録・判断の流し込み・
文脈の束・返しの保存と窓口への知らせ・返しの未反映（判定は state.ts。このリポジトリの window/state.ts を呼ぶ）。

操縦席は一時フォルダの写しで作る（本物の .orca/cockpit.json は読まない・書かない）。Orca は偽の orca を使う。
"""

import json
import os
import re
import subprocess
import unittest

from keep_testing import Base, FAKE_UNSORTED, HOOK, STATE, read


class ConsultBase(Base):
    """カードの相談のテストの操縦席（d21 と、関係する判断・しない判断 R1〜R6）と道具。"""

    def setUp(self):
        super().setUp()
        self.cockpit.update(
            streams=[{"id": "s7", "title": "窓の作り直し", "form": "cowork"}],
            requests=[{"id": "r30", "title": "凡例を減らす", "utterances": [{"id": "u-900", "quote": "凡例多すぎ"}],
                       "done_when": ["凡例の形が決まる"], "tasks": ["t2"]}])
        self.cockpit["cards"].append({"id": "d21", "rev": 1, "kind": "consult", "title": "凡例の減らし方", "state": "open",
                                      "stream": "s7", "tasks": ["t1"], "request_id": "r30", "issue": "凡例を何個出すか", "stance": "6 つ"})
        self.write_cockpit()
        self.rule(kind="constraint", text="返事は日本語", quote="日本語で")              # R1 全体の制約
        self.rule(kind="decision", text="d21 の凡例は 6 つまで")                         # R2 カードを挙げる
        self.rule(kind="decision", text="済の条件を変える", affects=["t1"])              # R3 結ばれたタスクに影響
        self.rule(kind="decision", text="d2 と d210 の話")                               # R4 関係しない（id の一部だけ）
        self.rule(kind="decision", text="仕事の判断", dec="s7")                          # R5 仕事を dec で挙げる
        self.rule(kind="decision", text="依頼のタスクの判断", affects=["t2"])            # R6 依頼のタスクに影響

    def env(self, **extra):
        return super().env(**{"COCKPIT_STATE": STATE, "COCKPIT_ORCA": "/usr/bin/false", **extra})

    def consult_env(self, **extra):
        return self.env(CONSULT_THREAD="1", CONSULT_CARD="%s#d21" % self.root, **extra)

    def say(self, prompt, **extra):
        return self.hook("UserPromptSubmit", env=self.consult_env(), prompt=prompt, session_id="s-consult", **extra)

    def launch(self, seen="R6", rev=1):
        return self.say("【相談の知らせ】カードの相談を始める\nrev: %d\nrulings_seen: %s\n本文" % (rev, seen))

    def write_memo(self, *returns):
        os.makedirs(os.path.join(self.root, ".orca", "consult"), exist_ok=True)
        body = "".join("### %s（送った）\n```json\n%s\n```\n" % (r["return_id"], json.dumps(r, ensure_ascii=False)) for r in returns)
        with open(os.path.join(self.root, ".orca", "consult", "d21.md"), "w", encoding="utf-8") as fh:
            fh.write("# 相談｜テスト｜d21\n## 決めたこと\n```json\n{\"return_id\": \"d21-9\"}\n```\n## 窓口に返したもの\n" + body + "## 残っている論点\n")

    def unreflected(self):
        done = self.tool_args("unreflected", "--json")
        self.assertEqual(done.returncode, 0, done.stderr)
        return {x["id"]: x["missing"] for x in json.loads(done.stdout)}

    def tool_args(self, *args):
        return subprocess.run([HOOK, args[0], self.root, *args[1:]], text=True, capture_output=True, env=self.env())


class ConsultCard(ConsultBase):
    """カードの相談（claude/bin/consult --card が CONSULT_CARD を付けて立てる端末）の発言の記録・流し込み・返しの照合（設計 10.3・10.7）。"""

    def test_her_words_in_the_consult_are_recorded_with_the_card_without_the_main_role(self):
        self.launch()
        out = self.say("案 A で。あと見積書も送って")
        [u] = self.jsonl("utterances.jsonl")
        self.assertEqual((u["id"], u["card"], u["session"], u["prompt"]), ("u-1", "d21", "s-consult", "案 A で。あと見積書も送って"))
        self.assertNotIn("メイン", out)
        # 圧縮・Stop の hook はメインのもので、相談では動かない
        self.assertEqual(self.hook("Stop", env=self.consult_env(), session_id="s-consult", last_assistant_message="どうしますか？"), "")
        self.assertEqual(self.hook("SessionStart", env=self.consult_env(), session_id="s-consult", source="compact"), "")

    # Orca のチャットで立てた相談（環境変数を渡せないので、最初の指示の印と合言葉で会話 id を登録する）
    TOKEN = "0123456789abcdef0123456789abcdef"  # gitleaks:allow 試験の合言葉の固定値

    def chat_say(self, prompt, chat="chat-1", **extra):
        return self.hook("UserPromptSubmit", env=self.env(ORCA_AGENT_SESSION_ID=chat), prompt=prompt, session_id="s-" + chat, **extra)

    def chat_launch(self, token=TOKEN, chat="chat-1"):
        os.makedirs(os.path.join(self.root, ".orca", "consult"), exist_ok=True)
        with open(os.path.join(self.root, ".orca", "consult", ".d21.chat-token"), "w") as fh:
            fh.write(self.TOKEN)
        return self.chat_say("【相談の知らせ】カードの相談を始める\n相談の印: d21#%s\nrev: 1\nrulings_seen: R6\n本文" % token, chat)

    def chats(self):
        p = os.path.join(self.root, ".orca", "consult", "chats.json")
        return json.loads(read(p)) if os.path.exists(p) else {}

    def test_a_chat_launched_with_the_mark_is_registered_and_treated_as_the_card_consult(self):
        out = self.chat_launch()
        self.assertNotIn("メイン", out)
        self.assertEqual({k: v["card"] for k, v in self.chats().items()}, {"chat-1": "d21"})
        self.chat_say("案 A で")
        [u] = self.jsonl("utterances.jsonl")
        self.assertEqual((u["card"], u["prompt"]), ("d21", "案 A で"))
        self.assertEqual(self.keep()["consults"]["d21"]["seen"], 6)
        done = subprocess.run([HOOK, "rule", self.root], input=json.dumps({"kind": "decision", "text": "x"}), text=True,
                              capture_output=True, env=self.env(ORCA_AGENT_SESSION_ID="chat-1"), cwd=self.root)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("相談スレッドは判断の記録を書かない", done.stderr)
        # 操縦席の外に cd してから root を指しても同じ
        done = subprocess.run([HOOK, "rule", self.root], input=json.dumps({"kind": "decision", "text": "x"}), text=True,
                              capture_output=True, env=self.env(ORCA_AGENT_SESSION_ID="chat-1"), cwd="/")
        self.assertIn("相談スレッドは判断の記録を書かない", done.stderr)

    def test_the_launch_pasted_again_into_the_main_chat_does_not_register_it(self):
        self.chat_launch()
        self.chat_say("【相談の知らせ】カードの相談を始める\n相談の印: d21#%s\nrev: 1\nrulings_seen: R6\n本文" % self.TOKEN, chat="main")
        self.assertEqual(list(self.chats()), ["chat-1"])
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "consult", ".d21.chat-token")))

    def test_a_wrong_token_or_a_mark_without_the_launch_head_registers_nothing(self):
        self.chat_launch(token="f" * 32)
        self.chat_say("相談の印: d21#%s" % self.TOKEN, chat="chat-2")
        self.assertEqual(self.chats(), {})
        self.assertNotIn("card", (self.jsonl("utterances.jsonl") or [{}])[-1])

    def test_a_broken_or_unknown_card_env_records_nothing(self):
        for v in ("%s" % self.root, "/nowhere#d21", "%s#../x" % self.root):
            self.hook("UserPromptSubmit", env=self.env(CONSULT_THREAD="1", CONSULT_CARD=v), prompt="相談")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_the_context_has_the_card_its_request_tasks_stream_and_the_related_rulings(self):
        done = self.tool_args("consult-context", "d21")
        self.assertEqual(done.returncode, 0, done.stderr)
        text = done.stdout
        for part in ("rev: 1", "rulings_seen: R6", '"issue": "凡例を何個出すか"', "依頼 r30", "u-900「凡例多すぎ」", "済の条件 1: 凡例の形が決まる",
                     "- t1（run）: hook を書く", "- t2（ok）", "仕事 s7: 窓の作り直し（形 cowork）"):
            self.assertIn(part, text)
        got = [l.split()[1] for l in text.splitlines() if l.startswith("- R")]
        self.assertEqual(sorted(got), ["R1", "R2", "R3", "R5", "R6"])
        # カードや仕事を挙げる判断を、全体の制約より先に並べる（上限で切るときに残す）
        self.assertEqual(got[-1], "R1")

    def test_a_revoked_constraint_is_not_in_the_context_but_its_revoke_is_new_since(self):
        self.rule(kind="revoke", text="英語でよくなった", quote="英語でいい", supersedes=["R1"])  # R7
        self.rule(kind="decision", text="関係しない")                                           # R8
        text = self.tool_args("consult-context", "d21").stdout
        self.assertNotIn("返事は日本語", text)
        since = self.tool_args("consult-context", "d21", "--since", "R6").stdout
        self.assertEqual([l.split()[1] for l in since.splitlines()], ["R7"])
        self.assertEqual(self.tool_args("consult-context", "d21", "--since", "R8").stdout.strip(), "- なし")

    def test_a_long_context_keeps_the_card_rulings_and_names_the_dropped_ones(self):
        for i in range(60):
            self.rule(kind="constraint", text="長い制約 %d " % i + "あ" * 150, quote="原文")
        text = self.tool_args("consult-context", "d21").stdout
        self.assertLessEqual(len(text), 8200)
        self.assertIn("d21 の凡例は 6 つまで", text)
        self.assertRegex(text, r"ほか \d+ 件（R\d+・.*）は長さの上限で省いた。要るときに .*rulings.jsonl")

    def test_an_unknown_card_is_refused(self):
        done = self.tool_args("consult-context", "d99")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("d99 が帳簿に無い", done.stderr)

    def test_rulings_and_a_new_rev_since_the_last_turn_are_announced_once(self):
        self.launch(seen="R5")  # 起動の指示の文脈は R5 までを読んだ
        self.rule(kind="constraint", text="本番は禁止", quote="本番だめ")                    # R7
        self.rule(kind="decision", text="d2 だけの話")                                      # R8
        self.cockpit["cards"][-1]["rev"] = 2
        self.write_cockpit()
        out = self.say("続けて")
        self.assertIn("R6 [decision] 依頼のタスクの判断", out)
        self.assertIn("R7 [constraint] 本番は禁止", out)
        self.assertNotIn("d2 だけの話", out)
        self.assertIn("rulings_seen に書く値は R8", out)
        self.assertIn("rev が 1 から 2 に変わった", out)
        self.assertEqual(self.say("次"), "")
        self.cockpit["cards"][-1]["state"] = "done"
        self.write_cockpit()
        self.assertIn("d21 が片付いた", self.say("まだある？"))

    def test_the_consult_cannot_write_rulings(self):
        done = subprocess.run([HOOK, "rule", self.root], input=json.dumps({"kind": "decision", "text": "x"}), text=True,
                              capture_output=True, env=self.consult_env())
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("窓口に返す", done.stderr)
        self.assertEqual(len(self.jsonl("rulings.jsonl")), 6)

    def test_main_and_consult_writing_at_once_get_distinct_ids_and_sorting_one_leaves_the_other(self):
        procs = []
        for i in range(8):
            for env, who in ((self.env(), "main"), (self.consult_env(), "consult")):
                payload = {"hook_event_name": "UserPromptSubmit", "session_id": who, "cwd": self.root, "prompt": "%s %d" % (who, i)}
                procs.append(subprocess.Popen([HOOK], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, env=env, text=True))
                procs[-1].stdin.write(json.dumps(payload))
                procs[-1].stdin.close()
        for p in procs:
            self.assertEqual(p.wait(), 0)
        rows = self.jsonl("utterances.jsonl")
        self.assertEqual([u["id"] for u in rows], ["u-%d" % n for n in range(1, 17)])
        self.assertEqual(sum(1 for u in rows if u.get("card") == "d21"), 8)
        # 窓口が自分の発言だけを仕分けて through を進めても、相談の発言は仕分けていないまま残る（state.ts の unsortedOf と同じ規則の偽物）
        mine = [u["id"] for u in rows if not u.get("card")]
        self.cockpit["intake"] = {"through": mine[-1], "none": mine}
        self.write_cockpit()
        fake = os.path.join(self.root, "fake-state.js")
        with open(fake, "w") as fh:
            fh.write(FAKE_UNSORTED)
        got = json.loads(subprocess.run(["node", fake, self.root], capture_output=True, text=True, check=True).stdout)["checks"]["unsorted"]
        self.assertEqual(sorted(got), sorted(u["id"] for u in rows if u.get("card") == "d21"))

    def test_a_return_stays_unreflected_until_both_the_rulings_and_the_ledger_have_it(self):
        ret = {"return_id": "d21-1", "card": "d21", "rev": 1, "rulings_seen": "R6", "choice": None,
               "decisions": [{"text": "凡例は 6 つ", "quote": "6 つでいい", "utterance": "u-3"}], "requests": [], "open": [], "affects": []}
        self.write_memo(ret)
        # 別の節の塊（d21-9）は返しではない
        self.assertEqual(self.unreflected(), {"d21-1": ["判断の記録", "帳簿"]})
        # 判断を書いた直後に止まり、再開で同じ返しをもう一度処理しても、判断は 1 件
        for _ in range(2):
            done = subprocess.run([HOOK, "rule", self.root], text=True, capture_output=True, env=self.env(),
                                  input=json.dumps({"kind": "decision", "text": "凡例は 6 つ", "quote": "6 つでいい", "dec": "d21", "from_return": "d21-1"}))
            self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([r["id"] for r in self.jsonl("rulings.jsonl") if r.get("from_return") == "d21-1"], ["R7"])
        self.assertIn("記録済み", done.stdout)
        self.assertEqual(self.unreflected(), {"d21-1": ["帳簿"]})
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("- d21-1（カード d21。無いもの: 帳簿。", text)
        self.cockpit["cards"][-1]["from_returns"] = ["d21-1"]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), {})
        self.assertNotIn("反映していない", json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"])

    def test_when_state_ts_cannot_be_read_the_returns_are_said_to_be_unknown_not_none(self):
        self.write_memo({"return_id": "d21-1", "card": "d21", "rev": 1, "rulings_seen": "R6",
                         "decisions": [{"text": "凡例は 6 つ", "quote": "6 つでいい", "utterance": "u-3"}]})
        broken = self.env(COCKPIT_STATE=os.path.join(self.root, "no-state.js"))
        done = subprocess.run([HOOK, "unreflected", self.root, "--json"], text=True, capture_output=True, env=broken)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("state.ts を読めない", done.stderr)
        # 読めなくても、切り替え前のメモの返しは記録へ取り込んである（state.ts が読めるようになれば出る）
        self.assertEqual([json.loads(l)["return_id"] for l in read(os.path.join(self.root, ".orca", "consult", "d21.returns.jsonl")).splitlines()], ["d21-1"])
        text = json.loads(self.hook("SessionStart", env=broken, source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("反映していないカードの相談と質問の返し: state.ts を読めず不明", text)
        self.assertEqual(self.unreflected(), {"d21-1": ["判断の記録", "帳簿"]})

    def test_when_orca_makes_state_ts_fail_the_returns_are_still_named_from_the_files(self):
        self.write_memo({"return_id": "d21-1", "card": "d21", "rev": 1, "rulings_seen": "R6",
                         "decisions": [{"text": "凡例は 6 つ", "quote": "6 つでいい", "utterance": "u-3"}]})
        # Orca を読む呼び出し（--files の無いもの）だけが時間切れなどで失敗する state.ts
        slow = os.path.join(self.root, "orca-fails.mjs")
        with open(slow, "w") as fh:
            fh.write("import { execFileSync } from 'node:child_process'\nif (!process.argv.includes('--files')) process.exit(1)\n"
                     "process.stdout.write(execFileSync('node', [%s, ...process.argv.slice(2)]))\n" % json.dumps(STATE))
        text = json.loads(self.hook("SessionStart", env=self.env(COCKPIT_STATE=slow), source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("state.ts を読めず、作業中の数と空きは不明", text)
        self.assertIn("- d21-1（カード d21。無いもの: 判断の記録・帳簿。", text)

    def test_a_card_moved_to_the_archive_still_counts_as_reflected(self):
        self.write_memo({"return_id": "d21-2", "card": "d21"})
        self.rule(kind="none", text="版違いで choice は保留、依頼だけ受けた", dec="d21", from_return="d21-2")
        with open(os.path.join(self.root, ".orca", "cockpit.archive.json"), "w") as fh:
            json.dump({"cards": [{"id": "d21", "from_returns": ["d21-2"]}]}, fh)
        self.assertEqual(self.unreflected(), {})

    def test_a_bad_return_id_is_refused(self):
        done = subprocess.run([HOOK, "rule", self.root], text=True, capture_output=True, env=self.env(),
                              input=json.dumps({"kind": "decision", "text": "x", "from_return": "d21"}))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("return_id", done.stderr)

    def test_a_held_return_stays_named_until_the_consult_returns_again(self):
        self.write_memo({"return_id": "d21-1", "card": "d21"})
        self.rule(kind="none", text="rev 違いで選択を保留、依頼は受けた", dec="d21", from_return="d21-1")
        self.cockpit["cards"][-1].update(from_returns=["d21-1"], held_returns=["d21-1", "d21-7"])
        self.write_cockpit()
        # d21-7 は相談がメモに書き損ねた返し
        self.assertEqual(self.unreflected(), {"d21-1": ["保留"], "d21-7": ["保留"]})
        self.cockpit["cards"][-1]["held_returns"] = []
        self.write_cockpit()
        self.assertEqual(self.unreflected(), {})

    def test_her_words_quoting_the_notice_mark_are_still_recorded(self):
        self.launch()
        self.say("【相談の知らせ】って何？")
        self.say("【相談の知らせ】反映済み d21-1（判断 R7 と依頼 r31）")
        self.assertEqual([u["prompt"] for u in self.jsonl("utterances.jsonl")], ["【相談の知らせ】って何？"])

    def test_a_long_card_field_is_cut_with_where_to_read_it(self):
        self.cockpit["cards"][-1]["context"] = {"what": "長い" * 6000}
        self.write_cockpit()
        text = self.tool_args("consult-context", "d21").stdout
        self.assertLess(len(text), 8200)
        self.assertIn("…（以下略。全文は 帳簿のカード d21 の欄 .context.what）", text)
        self.assertIn("R2 [decision] d21 の凡例は 6 つまで", text)

    def test_the_window_resuming_a_half_written_return_does_not_hold_it_for_its_own_rows(self):
        self.rule(kind="decision", text="d21 は案 A", dec="d21", from_return="d21-1")  # R7: 前の試みで書いた
        self.rule(kind="decision", text="d21 とは別の制約の話", dec="d21")            # R8: ほかで増えた
        got = self.tool_args("consult-context", "d21", "--since", "R6", "--return", "d21-1").stdout
        self.assertEqual([l.split()[1] for l in got.splitlines()], ["R8"])
        self.assertEqual(self.tool_args("consult-context", "d21", "--since", "R7", "--return", "d21-1").stdout.split()[1], "R8")

    def test_a_hold_on_a_closed_card_is_still_named(self):
        self.cockpit["cards"][-1].update(state="done", from_returns=["d21-1"], held_returns=["d21-1"])
        self.write_cockpit()
        self.assertEqual(self.unreflected(), {"d21-1": ["保留"]})

    def test_the_window_notices_in_the_documented_forms_are_not_her_words(self):
        self.launch()
        for notice in ("【相談の知らせ】R81・R82が増えた。d21-1 の選択と判断は保留した",
                       "【相談の知らせ】R81 が増えた。確かめて",
                       "【相談の知らせ】rev 4 に変わった。d21-1 の選択と判断は保留した",
                       "【相談の知らせ】反映済み d21-1（カードが片付いたので保留を解いた）"):
            self.say(notice)
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_a_long_condition_of_the_request_is_cut(self):
        self.cockpit["requests"][0]["done_when"] = ["条件" * 5000]
        self.write_cockpit()
        text = self.tool_args("consult-context", "d21").stdout
        self.assertIn("全文は 帳簿の依頼 r30 の done_when[0]", text)
        self.assertIn("R2 [decision] d21 の凡例は 6 つまで", text)


class ReturnRecord(ConsultBase):
    """カードの相談の返しの記録（.orca/consult/<カード id>.returns.jsonl）と consult-return。
    窓口の反映は cockpit skill の references/consult.md「カードの相談」の 1〜6 を、窓口が読む道具（unreflected・consult-context・
    返しの記録）だけでなぞる。古い形は、切り替え前の相談のタブが自分で番号を付けてメモに書いた返し。"""

    FORMS = ("old", "new")

    def setUp(self):
        super().setUp()
        self.cockpit["main"] = {"agent": "claude", "run_id": "run_main"}
        self.write_cockpit()
        with open(self.fake_orca, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\necho \'{"ok":true,"result":{"message":{"id":"msg_7"}}}\'\n' % self.orca_log)
        self.memo_rets = []

    def ret(self, **over):
        return {"card": "d21", "rev": 1, "rulings_seen": self.seen(), "choice": None, "decisions": [], "requests": [], "open": [], "affects": [], **over}

    def seen(self):
        return "R%d" % len(self.jsonl("rulings.jsonl"))

    def consult_return(self, ret, card="d21"):
        return subprocess.run([HOOK, "consult-return", self.root, card], input=json.dumps(ret, ensure_ascii=False),
                              text=True, capture_output=True, env=self.consult_env())

    def save(self, form, ret):
        """old: 切り替え前の相談のタブが、自分で付けた番号（ret の return_id）でメモに書く。new: consult-return に番号なしで渡す。"""
        if form == "old":
            self.memo_rets.append(ret)
            self.write_memo(*self.memo_rets)
            return ret["return_id"]
        done = self.consult_return({k: v for k, v in ret.items() if k != "return_id"})
        self.assertEqual(done.returncode, 0, done.stderr)
        head, sent = done.stdout.splitlines()
        self.assertEqual(sent, "message msg_7")
        return head.split()[1]

    def sends(self):
        return [l for l in read(self.orca_log).splitlines() if l.startswith("orchestration send")] if os.path.exists(self.orca_log) else []

    def record(self):
        p = os.path.join(self.root, ".orca", "consult", "d21.returns.jsonl")
        return [json.loads(l) for l in read(p).splitlines()] if os.path.exists(p) else []

    def card(self):
        return self.cockpit["cards"][-1]

    def requests_from(self, utterance):
        return [r for r in self.cockpit["requests"] if any(u["id"] == utterance for u in r.get("utterances") or [])]

    def reflect(self, rid, stop_after=None):
        """窓口が返し rid を反映する（consult.md の 1〜6）。返しの本文は unreflected が指す返しの記録から読む。"""
        card = self.card()
        if rid in card.get("from_returns", []):
            return "反映済み"
        entry = next(x for x in json.loads(self.tool_args("unreflected", "--json").stdout) if x["id"] == rid)
        row = next(r for r in (json.loads(l) for l in read(entry["returns"]).splitlines()) if r.get("return_id") == rid)
        since = self.tool_args("consult-context", "d21", "--since", row["rulings_seen"], "--return", rid).stdout.strip()
        held = row["rev"] != card["rev"] or since != "- なし"
        if row.get("replaces") and row["replaces"] not in card.get("held_returns", []):
            held = True
        if held:
            self.rule(kind="none", text="版違いか増えた判断で選択と判断を保留、依頼は受けた", dec="d21", from_return=rid)
        elif not (row.get("decisions", []) or row.get("choice")):
            self.rule(kind="none", text="受ける判断は無い。依頼と論点を受けた", dec="d21", from_return=rid)
        else:
            for d in row.get("decisions", []):
                self.rule(kind="decision", text=d["text"], quote=d["quote"], dec="d21", from_return=rid)
            if row.get("choice"):
                self.rule(kind="decision", text="d21 は案 %s" % row["choice"], dec="d21", from_return=rid)
        if stop_after == "rule":
            return "中断"
        for q in row.get("requests", []):
            if not self.requests_from(q["utterance"]):
                self.cockpit["requests"].append({"id": "r%d" % (31 + len(self.cockpit["requests"])), "title": q["quote"],
                                                 "utterances": [{"id": q["utterance"], "quote": q["quote"]}], "from_return": rid})
        card["from_returns"] = card.get("from_returns", []) + [rid]
        card["held_returns"] = [x for x in card.get("held_returns", []) if x != row.get("replaces")] + ([rid] if held else [])
        self.write_cockpit()
        return "保留" if held else "反映"

    def from_return(self, rid):
        return [(r["kind"], r["text"]) for r in self.jsonl("rulings.jsonl") if r.get("from_return") == rid]

    # ---- consult-return の形と出力 ----

    def test_consult_return_numbers_saves_and_sends_the_return(self):
        done = self.consult_return(self.ret(return_id="d21-9", decisions=[{"text": "凡例は 4 つ", "quote": "4 つで", "utterance": "u-3"}]))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, "return_id d21-1\nmessage msg_7\n")  # 相手が書いた番号は使わない
        [row] = [r for r in self.record() if "return_id" in r]
        self.assertEqual((row["return_id"], row["card"], row["decisions"][0]["quote"]), ("d21-1", "d21", "4 つで"))
        log = read(self.orca_log)
        self.assertIn("--to run:run_main", log)
        self.assertIn("相談 d21: 返し d21-1", log)
        self.assertIn('{"return_id": "d21-1", "card": "d21", "rev": 1', log)
        self.assertNotIn("saved_at", log)
        # 相談のメモは返しに使わない（無くてよく、作りもしない）
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "consult", "d21.md")))

    def test_consult_return_refuses_a_return_the_main_cannot_reflect_and_saves_nothing(self):
        good = {"decisions": [{"text": "凡例は 4 つ", "quote": "4 つで", "utterance": "u-3"}]}
        for broken, why in (({"rev": None}, "rev"), ({"card": "d1"}, "card は相談しているカードの id（d21）"),
                            ({"decisions": [{"text": "4 つ", "quote": "4 つ"}]}, "utterance"), ({"rulings_seen": "80"}, "rulings_seen"),
                            ({"replaces": "d1-1"}, "replaces"), ({"decisions": [], "choice": None}, "どれも空"),
                            ({"op": 99}, "op 99 はこのカード（d21）の操作ではない")):
            done = self.consult_return(self.ret(**{**good, **broken}))
            self.assertNotEqual(done.returncode, 0, broken)
            self.assertIn(why, done.stderr, broken)
        self.assertEqual(self.consult_return(self.ret(**good), card="zz9").returncode, 1)
        self.assertEqual([r for r in self.record() if "return_id" in r], [])
        self.assertFalse(os.path.exists(self.orca_log))
        # 選択だけの返しは受ける
        self.assertEqual(self.consult_return(self.ret(choice="a")).returncode, 0)

    def test_without_the_main_run_the_return_is_saved_and_the_reason_is_printed(self):
        del self.cockpit["main"]
        self.write_cockpit()
        done = self.consult_return(self.ret(open=["色"]))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.splitlines(), ["return_id d21-1", "送れなかった: 窓口の Run が帳簿（main.run_id）に無い。窓口は開始・再開のときに返しの記録から拾う"])
        self.assertEqual(self.unreflected(), {"d21-1": ["判断の記録", "帳簿"]})

    def test_the_memo_is_read_each_time_and_a_clashing_return_gets_a_new_number_and_is_named(self):
        # 切り替え前に 2 つのタブが同じ d21-7 を別の依頼で書いた（Astra の 2 回目の指摘 2）
        self.write_memo({"return_id": "d21-7", "card": "d21", "rev": 1, "rulings_seen": "R6", "requests": [{"quote": "図も", "utterance": "u-1"}]},
                        {"return_id": "d21-7", "card": "d21", "rev": 1, "rulings_seen": "R6", "requests": [{"quote": "表も", "utterance": "u-2"}]},
                        {"return_id": "d21-3", "rev": 1, "open": ["色"]})
        done = self.tool_args("unreflected", "--json")
        self.assertIn("メモの返し d21-7 は記録の同じ番号の返しと中身が違うので、d21-8 として取り込んだ", done.stderr)
        got = {x["id"]: (x["missing"], x.get("conflict_of")) for x in json.loads(done.stdout)}
        self.assertEqual(got, {"d21-7": (["判断の記録", "帳簿"], None), "d21-3": (["判断の記録", "帳簿"], None),
                               "d21-8": (["判断の記録", "帳簿", "番号の衝突"], "d21-7")})
        rows = self.record()
        self.assertEqual([(r["return_id"], r.get("conflict_of")) for r in rows], [("d21-7", None), ("d21-3", None), ("d21-8", "d21-7")])
        self.assertEqual(rows[1]["card"], "d21")  # card の無い塊はメモのカード
        self.assertEqual(rows[2]["requests"], [{"quote": "表も", "utterance": "u-2"}])  # ぶつかった返しの本文も残る
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("- d21-8（カード d21。無いもの: 判断の記録・帳簿・番号の衝突。切り替え前のメモで d21-7 と番号がぶつかった別の返し", text)
        # 読み直しても足さない（return_id と中身で冪等）
        self.unreflected()
        self.assertEqual(len(self.record()), 3)
        # 取り込みのあとに、閉じる前の古いタブがメモに書いた返しも拾う（Astra の 2 回目の指摘 1）
        self.memo_rets = [{"return_id": "d21-7", "card": "d21", "rev": 1, "rulings_seen": "R6", "requests": [{"quote": "図も", "utterance": "u-1"}]},
                          {"return_id": "d21-9", "card": "d21", "rev": 1, "rulings_seen": "R6", "requests": [{"quote": "地図も", "utterance": "u-4"}]}]
        self.write_memo(*self.memo_rets)
        self.assertEqual(sorted(self.unreflected()), ["d21-3", "d21-7", "d21-8", "d21-9"])
        self.assertEqual(self.save("new", self.ret(open=["形"])), "d21-10")
        # 窓口が衝突した返しを反映すると、名指しが消えて依頼が届く
        self.assertIn(self.reflect("d21-8"), ("反映", "保留"))
        self.assertNotIn("d21-8", self.unreflected())
        self.assertEqual(len(self.requests_from("u-2")), 1)

    def test_a_memo_that_cannot_be_read_stops_reading_and_saving_until_it_can(self):
        self.write_memo({"return_id": "d21-4", "card": "d21", "rev": 1, "open": ["色"]})
        memo = os.path.join(self.root, ".orca", "consult", "d21.md")
        os.chmod(memo, 0)
        self.addCleanup(os.chmod, memo, 0o644)
        done = self.tool_args("unreflected", "--json")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("返しの記録を読めない", done.stderr)
        self.assertEqual(self.record(), [])
        self.assertNotEqual(self.consult_return(self.ret(open=["形"])).returncode, 0)
        os.chmod(memo, 0o644)
        self.assertEqual(self.unreflected(), {"d21-4": ["判断の記録", "帳簿"]})
        self.assertEqual(self.save("new", self.ret(open=["形"])), "d21-5")

    def test_fields_the_tool_writes_are_not_taken_from_the_return(self):
        done = self.consult_return(self.ret(open=["色"], conflict_of="d21-3", saved_at="昔", imported_from="/x"))
        self.assertEqual(done.returncode, 0, done.stderr)
        [row] = self.record()
        self.assertNotIn("conflict_of", row)
        self.assertNotIn("imported_from", row)
        self.assertNotEqual(row["saved_at"], "昔")
        self.assertEqual(self.save("new", self.ret(open=["形"])), "d21-2")

    def test_a_card_whose_id_looks_like_a_question_is_still_a_card(self):
        self.cockpit["cards"].append({"id": "ask3", "rev": 2, "kind": "consult", "title": "名前が質問に似たカード", "state": "open"})
        self.write_cockpit()
        done = self.consult_return(self.ret(card="ask3", rev=2, choice="a"), card="ask3")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.splitlines()[0], "return_id ask3-1")
        self.assertTrue(os.path.exists(os.path.join(self.root, ".orca", "consult", "ask3.returns.jsonl")))
        self.assertFalse(os.path.exists(os.path.join(self.root, ".orca", "consult", "ask-ask3.returns.jsonl")))
        self.assertIn("相談 ask3: 返し ask3-1", read(self.orca_log))
        # 同じ id の質問 ask3 の返しは、カードの記録の番号も数えて次の番号になる（Astra の 2 回目の指摘 3）
        ret = {"rulings_seen": "R6", "decisions": [{"text": "凡例は 5 つ", "quote": "5 つにして", "utterance": "u-1"}]}
        reply = "答え\n\n【窓口への返し】\n```json\n%s\n```\n" % json.dumps(ret, ensure_ascii=False)
        self.hook("Stop", env=self.env(CONSULT_THREAD="1", CONSULT_ASK="%s#ask3" % self.root), session_id="s-ask", last_assistant_message=reply)
        [row] = [json.loads(l) for l in read(os.path.join(self.root, ".orca", "consult", "ask-ask3.returns.jsonl")).splitlines()]
        self.assertEqual(row["return_id"], "ask3-2")
        done = self.consult_return(self.ret(card="ask3", rev=2, choice="b"), card="ask3")
        self.assertEqual(done.stdout.splitlines()[0], "return_id ask3-3")

    # ---- 試験 ①〜④（古い形と新しい形の両方で） ----

    def test_1_a_choice_given_before_the_card_changed_is_held_and_its_request_arrives_once(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                said = {"choice": "a", "decisions": [{"text": "案 A にする", "quote": "Aで。資料も作って", "utterance": "u-5"}],
                        "requests": [{"quote": "資料も作って", "utterance": "u-5"}]}
                r1 = self.save(form, self.ret(return_id="d21-1", **said))
                self.card()["rev"] = 2  # 反映の前にカードが改訂された
                self.write_cockpit()
                self.assertEqual(self.unreflected(), {r1: ["判断の記録", "帳簿"]})
                self.assertEqual(self.reflect(r1), "保留")
                self.assertEqual(self.from_return(r1), [("none", "版違いか増えた判断で選択と判断を保留、依頼は受けた")])
                self.assertEqual(self.unreflected(), {r1: ["保留"]})
                self.assertEqual(self.reflect(r1), "反映済み")  # 同じ返しがもう一度届いた
                # 相談が読み直して返し直す（切り替えのあとは consult-return）
                r2 = self.save("new", self.ret(rev=2, replaces=r1, **said))
                self.assertEqual(r2, "d21-2")
                self.assertEqual(self.reflect(r2), "反映")
                self.assertEqual(self.from_return(r2), [("decision", "案 A にする"), ("decision", "d21 は案 a")])
                self.assertEqual(len(self.requests_from("u-5")), 1)
                self.assertEqual(self.requests_from("u-5")[0]["from_return"], r1)
                self.assertEqual(self.unreflected(), {})

    def test_2_a_reflection_stopped_after_the_rulings_resumes_once_even_if_the_memo_went_back(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                r1 = self.save(form, self.ret(return_id="d21-1", decisions=[{"text": "凡例は 4 つ", "quote": "4 つで。見積も出して", "utterance": "u-7"}],
                                              requests=[{"quote": "見積も出して", "utterance": "u-7"}]))
                self.assertEqual(self.reflect(r1, stop_after="rule"), "中断")
                self.write_memo()  # 相談が古い版のメモをもとに書き直し、返しの節が消えた
                self.assertEqual(self.unreflected(), {r1: ["帳簿"]})
                [entry] = json.loads(self.tool_args("unreflected", "--json").stdout)
                [row] = [r for r in (json.loads(l) for l in read(entry["returns"]).splitlines()) if r.get("return_id") == r1]
                self.assertEqual(row["requests"], [{"quote": "見積も出して", "utterance": "u-7"}])
                self.assertEqual(self.reflect(r1), "反映")
                self.assertEqual(self.from_return(r1), [("decision", "凡例は 4 つ")])
                self.assertEqual(len(self.requests_from("u-7")), 1)
                self.assertEqual(self.unreflected(), {})

    def test_3_the_same_return_twice_stops_as_reflected_and_a_reworded_answer_to_one_hold_keeps_one_number(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                r1 = self.save(form, self.ret(return_id="d21-1", decisions=[{"text": "凡例は 4 つ", "quote": "4 つで", "utterance": "u-3"}]))
                r2 = self.save(form, self.ret(return_id="d21-2", choice="b"))
                self.assertEqual(self.reflect(r1), "反映")
                rows, ledger = self.jsonl("rulings.jsonl"), json.dumps(self.cockpit)
                self.assertEqual(self.reflect(r1), "反映済み")
                self.assertEqual((self.jsonl("rulings.jsonl"), json.dumps(self.cockpit)), (rows, ledger))
                self.assertEqual(self.reflect(r2), "保留")  # r1 の判断が増えた
                sent = len(self.sends())
                first = self.consult_return(self.ret(replaces=r2, choice="b", decisions=[{"text": "凡例は 5 つにする", "quote": "B で", "utterance": "u-4"}]))
                again = self.consult_return(self.ret(replaces=r2, choice="b", decisions=[{"text": "凡例を 5 個にする", "quote": "B で", "utterance": "u-4"}]))
                self.assertEqual(first.stdout, "return_id d21-3\nmessage msg_7\n")
                self.assertEqual(again.stdout, first.stdout)
                self.assertIn("新しい番号を付けずに送り直す", again.stderr)
                self.assertEqual([r.get("replaces") for r in self.record() if "return_id" in r], [None, None, r2])
                self.assertEqual(len(self.sends()), sent + 2)
                self.assertEqual(self.reflect("d21-3"), "反映")
                self.assertEqual(self.from_return("d21-3"), [("decision", "凡例は 5 つにする"), ("decision", "d21 は案 b")])
                self.assertEqual(self.card()["held_returns"], [])
                self.assertEqual(self.unreflected(), {})
                # replaces も op も無い返しを、相手が出力を見失ってまったく同じ JSON で呼び直した
                same = self.ret(requests=[{"quote": "一覧も直して", "utterance": "u-6"}])
                once, twice = self.consult_return(same), self.consult_return(same)
                self.assertEqual(once.stdout, "return_id d21-4\nmessage msg_7\n")
                self.assertEqual(twice.stdout, once.stdout)
                self.assertIn("同じ中身の返し d21-4", twice.stderr)
                self.assertEqual(self.reflect("d21-4"), "反映")
                self.assertEqual(self.reflect("d21-4"), "反映済み")
                self.assertEqual(len(self.requests_from("u-6")), 1)
                # 発言の id が違えば、同じ文でも別の返し
                other = self.consult_return({**same, "requests": [{"quote": "一覧も直して", "utterance": "u-8"}]})
                self.assertEqual(other.stdout.splitlines()[0], "return_id d21-5")

    def test_4_two_returns_saved_at_once_get_their_own_numbers_and_both_requests_arrive(self):
        for form in self.FORMS:
            with self.subTest(form=form):
                self.setUp()  # 形ごとに新しい一時フォルダで始める
                if form == "old":
                    self.save(form, self.ret(return_id="d21-1", open=["色"]))
                asks = [self.ret(requests=[{"quote": q, "utterance": u}]) for q, u in (("図を描いて", "u-11"), ("表も作って", "u-12"))]
                procs = [subprocess.Popen([HOOK, "consult-return", self.root, "d21"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True, env=self.consult_env()) for _ in asks]
                # 両方に入力を渡し終えてから終わりを待つ（片方が保存し終える前に、もう片方も走らせる）
                for p, a in zip(procs, asks):
                    p.stdin.write(json.dumps(a, ensure_ascii=False))
                    p.stdin.close()
                outs = [p.stdout.read() for p in procs]
                for p in procs:
                    p.wait()
                    p.stdout.close()
                    p.stderr.close()
                self.assertEqual([p.returncode for p in procs], [0, 0])
                ids = sorted(o.splitlines()[0].split()[1] for o in outs)
                self.assertEqual(ids, ["d21-2", "d21-3"] if form == "old" else ["d21-1", "d21-2"])
                for rid in ids:
                    self.assertIn(self.reflect(rid), ("反映", "保留"))  # 先の返しの none の行が増えた判断になれば保留（依頼は受ける）
                self.assertEqual({k: v for k, v in self.unreflected().items() if k in ids}, {r: ["保留"] for r in ids[1:]})
                self.assertEqual((len(self.requests_from("u-11")), len(self.requests_from("u-12"))), (1, 1))


class AskFromWindow(Base):
    """窓からの質問（claude/bin/consult --ask が CONSULT_ASK を付けて立てる、窓口の会話を写した端末）と、窓口の会話の記録（設計 11 章）。"""

    def setUp(self):
        super().setUp()
        self.cockpit.update(main={"agent": "claude", "run_id": "run_main"}, streams=[{"id": "s7", "title": "窓", "form": "cowork"}])
        self.cockpit["cards"].append({"id": "d21", "rev": 1, "kind": "consult", "title": "凡例", "state": "open", "stream": "s7", "tasks": ["t1"]})
        self.write_cockpit()
        with open(self.fake_orca, "w") as fh:
            fh.write('#!/bin/sh\necho "$@" >> "%s"\ncase "$*" in *run-current*) echo "{\\"ok\\":true,\\"result\\":{\\"runId\\":\\"$FAKE_RUN\\"}}";; '
                     '*) echo \'{"ok":true,"result":{}}\';; esac\n' % self.orca_log)
        self.rule(kind="constraint", text="返事は日本語", quote="日本語で")   # R1
        self.rule(kind="decision", text="d21 の凡例は 6 つ")                # R2
        self.memo_dir = os.path.join(self.root, ".orca", "consult")
        os.makedirs(self.memo_dir)
        for ask, bind in (("ask1", ""), ("ask2", "- カード: d21\n"), ("ask3", "- 仕事: s7\n")):
            with open(os.path.join(self.memo_dir, "ask-%s.md" % ask), "w", encoding="utf-8") as fh:
                fh.write("# 質問｜テスト｜%s\n%s- 写した窓口の会話: s-main\n\n" % (ask, bind))

    def env(self, **extra):
        return super().env(**{"COCKPIT_STATE": STATE, "COCKPIT_ORCA": "/usr/bin/false", **extra})

    def ask_env(self, ask="ask1", **extra):
        return self.env(CONSULT_THREAD="1", CONSULT_ASK="%s#%s" % (self.root, ask), FAKE_RUN="run_main", **extra)

    def say(self, prompt, ask="ask1"):
        return self.hook("UserPromptSubmit", env=self.ask_env(ask), prompt=prompt, session_id="s-ask")

    def ops(self, ops):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": ops}, fh)

    def launch(self, seen, ask="ask1", question=None):
        text = "【相談の知らせ】質問を始める（consult --ask）\nrulings_seen: %s\n本文" % seen
        return self.say(text + ("\n--- 深田さんの質問（窓から） ---\n" + question if question else ""), ask)

    def stop(self, reply, ask="ask1", **extra):
        out = self.hook("Stop", env=self.ask_env(ask), session_id="s-ask", last_assistant_message=reply, **extra)
        return json.loads(out) if out.strip() else None

    def memo(self, ask="ask1"):
        with open(os.path.join(self.memo_dir, "ask-%s.md" % ask), encoding="utf-8") as fh:
            return fh.read()

    def returns(self, ask="ask1"):
        p = os.path.join(self.memo_dir, "ask-%s.returns.jsonl" % ask)
        return [json.loads(l) for l in read(p).splitlines()] if os.path.exists(p) else []

    def sends(self):
        return [l for l in read(self.orca_log).splitlines() if l.startswith("orchestration send")] if os.path.exists(self.orca_log) else []

    def unreflected(self):
        done = subprocess.run([HOOK, "unreflected", self.root, "--json"], text=True, capture_output=True, env=self.env())
        self.assertEqual(done.returncode, 0, done.stderr)
        return [{k: v for k, v in x.items() if k in ("id", "ask", "op", "missing", "tasks")} for x in json.loads(done.stdout)]

    RET = {"return_id": "ask1-1", "rulings_seen": "R2", "decisions": [{"text": "凡例は 5 つ", "quote": "5 つにして", "utterance": "u-1"}],
           "requests": [], "open": [], "affects": ["t1"]}

    def reply_with(self, ret, before="凡例は 5 つで進める、と決まった。返しの案を書いた。"):
        return "窓口の会話 09:58 時点（それより後に決まったことは知らない）\n%s\n\n【窓口への返し】\n```json\n%s\n```\n" % (before, json.dumps(ret, ensure_ascii=False))

    # ---- 質問の発言・答え・流し込み ----

    def test_the_question_from_the_window_is_her_words_and_the_launch_is_not(self):
        self.launch("R2", question="凡例は何個がいい？")
        self.say("5 つでどう？")
        rows = self.jsonl("utterances.jsonl")
        self.assertEqual([(u["id"], u["ask"], u["prompt"]) for u in rows], [("u-1", "ask1", "凡例は何個がいい？"), ("u-2", "ask1", "5 つでどう？")])
        self.assertNotIn("card", rows[0])
        self.stop("窓口の会話 09:58 時点\n5 つがよい")
        memo = self.memo()
        self.assertIn("### 質問 10:00（u-1）\n凡例は何個がいい？", memo)
        self.assertIn("### 答え 10:00\n窓口の会話 09:58 時点\n5 つがよい", memo)
        self.assertNotIn("rulings_seen", memo)
        self.say("【相談の知らせ】返しを書いて（op 812）")
        self.assertEqual(len(self.jsonl("utterances.jsonl")), 2)
        self.assertIn("### 知らせ 10:00\n【相談の知らせ】返しを書いて（op 812）", self.memo())

    def test_her_words_from_the_window_reply_are_kept_without_the_notice_line(self):
        self.launch("R2", question="凡例は何個がいい？")
        self.stop("窓口の会話 09:58 時点\n5 つがよい\n\n【選べる案】\n- A: 5 つ（推し）\n- B: 3 つ")
        # 窓の「A で返す」: 窓が op を書き、言葉を先に、改行して知らせを後に、1 回で届く
        self.ops([{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1", "choice": "A"},
                  {"op_id": 814, "type": "ask_decide", "item_id": "#ask:ask1", "text": "【相談の知らせ】返しを書いて（op 1）の件は B で"}])
        self.say("案 A で。\n【相談の知らせ】返しを書いて（op 812）")
        rows = self.jsonl("utterances.jsonl")
        self.assertEqual([(u["id"], u["ask"], u["prompt"]) for u in rows][-1], ("u-2", "ask1", "案 A で。"))
        self.assertIn("### 質問 10:00（u-2）\n案 A で。\n\n", self.memo())
        self.assertNotIn("返しを書いて", self.memo())
        # 知らせの行が末尾でない・窓の op と言葉が合わない（深田さんが知らせの行を貼った質問）なら、深田さんの発言としてそのまま残す
        self.say("案 B で。\n【相談の知らせ】返しを書いて（op 813）\n図は？")
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["prompt"], "案 B で。\n【相談の知らせ】返しを書いて（op 813）\n図は？")
        self.say("届いてる？\n【相談の知らせ】返しを書いて（op 812）")
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["prompt"], "届いてる？\n【相談の知らせ】返しを書いて（op 812）")
        # 書いた言葉が知らせの引用で始まっても、窓の op と合えば言葉を発言として残す
        self.say("【相談の知らせ】返しを書いて（op 1）の件は B で\n【相談の知らせ】返しを書いて（op 814）")
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["prompt"], "【相談の知らせ】返しを書いて（op 1）の件は B で")

    def test_a_heading_like_line_in_a_question_or_answer_does_not_split_the_memo(self):
        self.launch("R2", question="前の控えに\n### 答え 09:00\nとあった")
        self.stop("窓口の会話 09:58 時点\n例:\n### 質問 09:10（u-9）\n### 知らせ 9:11")
        memo = self.memo()
        self.assertEqual(re.findall(r"^### \S+", memo, re.M), ["### 質問", "### 答え"])
        self.assertIn("\n ### 答え 09:00\n", memo)
        # 発言の記録は原文のまま
        self.assertEqual(self.jsonl("utterances.jsonl")[0]["prompt"], "前の控えに\n### 答え 09:00\nとあった")

    def test_a_question_without_a_card_gets_every_new_ruling(self):
        self.launch("R2")
        self.rule(kind="decision", text="t9 の話（どのカードにも関係しない）")  # R3
        out = self.say("続き")
        self.assertIn("R3 [decision] t9 の話", out)
        self.assertIn("返しの rulings_seen に書く値は R3", out)
        self.assertEqual(self.say("次"), "")

    def test_a_question_on_a_card_gets_only_the_related_rulings_and_the_card_when_its_rev_changes(self):
        self.launch("R2", ask="ask2")
        self.rule(kind="decision", text="t9 の話")                     # R3 関係しない
        self.rule(kind="decision", text="d21 は 4 つ")                 # R4
        self.cockpit["cards"][-1]["rev"] = 2
        self.write_cockpit()
        out = self.say("続き", ask="ask2")
        self.assertIn("R4 [decision] d21 は 4 つ", out)
        self.assertNotIn("t9 の話", out)
        self.assertIn("rev が 1 から 2 に変わった。今のカード", out)
        self.assertNotIn("consult-context", out)  # 質問の相手はコマンドを使えない

    def test_the_context_of_a_question_without_a_card_passes_rulings_seen_only_up_to_what_it_passed(self):
        self.rule(kind="revoke", text="英語でよい", quote="英語で", supersedes=["R1"])  # R3
        text = self.tool_args("ask-context", "ask1").stdout
        self.assertIn("rulings_seen: R2", text)       # 撤回の R3 は渡していない
        self.assertIn("R2 [decision] d21 の凡例は 6 つ", text)
        self.assertNotIn("返事は日本語", text)
        self.launch("R2")
        self.assertIn("R3 [revoke]", self.say("続き"))  # 渡していない行は次の発言の前に流れる
        for i in range(60):
            self.rule(kind="constraint", text="長い制約 %d " % i + "あ" * 150, quote="原文")
        text = self.tool_args("ask-context", "ask1").stdout
        self.assertLessEqual(len(text), 9000)
        self.assertIn("rulings_seen: R63", text)   # 新しい順に渡し、上限で落ちるのは古いもの
        self.assertRegex(text, r"ほか \d+ 件（.*R2.*）は長さの上限で省いた")

    def test_the_context_of_a_question_on_a_card_is_the_card_bundle(self):
        text = self.tool_args("ask-context", "ask2").stdout
        self.assertIn("rev: 1", text)
        self.assertIn('"title": "凡例"', text)
        self.assertEqual(self.tool_args("ask-context", "ask2", "--since", "R1").stdout.split()[1], "R2")

    def test_after_compaction_the_question_gets_the_context_again(self):
        got = json.loads(self.hook("SessionStart", env=self.ask_env(), session_id="s-ask", source="compact"))
        self.assertIn("rulings_seen: R2", got["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.keep()["asks"]["ask1"]["seen"], 2)

    # ---- 返しの保存と知らせ（11.6 の 2） ----

    def test_the_return_at_the_end_of_the_last_reply_is_saved_once_and_sent_to_the_main(self):
        self.assertIsNone(self.stop(self.reply_with(self.RET)))
        [row] = self.returns()
        self.assertEqual((row["return_id"], row["ask"], row["decisions"][0]["quote"]), ("ask1-1", "ask1", "5 つにして"))
        [send] = self.sends()
        self.assertIn("--to run:run_main", send)
        self.assertIn("質問 ask1: 返し ask1-1", send)
        self.stop(self.reply_with(self.RET))  # 同じ返事で Stop がもう一度走っても 1 件
        self.assertEqual(len(self.returns()), 1)
        self.assertEqual(len(self.sends()), 1)

    def test_a_reworded_second_return_for_the_same_press_keeps_its_number(self):
        self.ops([{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}])
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "op": 812})))
        reworded = {**self.RET, "op": 812, "decisions": [{"text": "凡例を五つにする", "quote": "5 つにして", "utterance": "u-1"}]}
        self.assertIsNone(self.stop(self.reply_with(reworded, before="言い直す。凡例は五つ。")))
        self.assertEqual([(r["return_id"], r["decisions"][0]["text"]) for r in self.returns()], [("ask1-1", "凡例は 5 つ")])
        self.assertEqual(len(self.sends()), 1)

    def test_a_return_given_again_for_a_hold_is_saved_even_with_the_same_press(self):
        self.ops([{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}])
        self.stop(self.reply_with({**self.RET, "op": 812}))
        fixed = {**self.RET, "op": 812, "replaces": "ask1-1", "decisions": [{"text": "凡例は 4 つ", "quote": "4 つにして", "utterance": "u-2"}]}
        self.assertIsNone(self.stop(self.reply_with(fixed, before="増えた判断を読み直した。")))
        self.assertEqual([(r["return_id"], r.get("replaces")) for r in self.returns()], [("ask1-1", None), ("ask1-2", "ask1-1")])
        self.assertEqual(len(self.sends()), 2)

    def test_a_choice_alone_is_not_a_question_return(self):
        out = self.stop(self.reply_with({"rulings_seen": "R2", "choice": "A"}))
        self.assertIn("どれも空", out["reason"])
        self.assertEqual(self.returns(), [])

    def test_a_pasted_example_or_one_quoted_mid_reply_is_not_a_return(self):
        example = "【窓口への返し】\n```json\n%s\n```" % json.dumps(self.RET, ensure_ascii=False)
        self.say("返しの書式ってこれで合ってる？\n" + example)
        self.assertIsNone(self.stop("窓口の会話 09:58 時点\n合っている。たとえば\n\n" + example + "\n\nのように末尾に書く。"))
        self.assertEqual(self.returns(), [])
        self.assertEqual(self.sends(), [])

    def test_a_broken_return_at_the_end_is_sent_back_to_be_rewritten(self):
        out = self.stop(self.reply_with({**self.RET, "replaces": "ask9-1"}))
        self.assertEqual(out["decision"], "block")
        self.assertIn("ask1-<連番>", out["reason"])
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "replaces": "ask9-1"}), stop_hook_active=True))  # 2 回目は止めない
        self.assertEqual(self.returns(), [])

    def test_the_hook_numbers_the_return_and_ignores_a_number_the_reply_wrote(self):
        # 古い形の相手が書いた番号（使い済みの ask1-1 や、推し量った ask1-7）は使わず、道具が次の番号を付ける
        self.assertIsNone(self.stop(self.reply_with(self.RET)))
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "decisions": [{"text": "別の話", "quote": "x", "utterance": "u-2"}]})))
        self.rule(kind="decision", text="凡例は 5 つ", quote="5 つにして", from_return="ask1-6")  # 判断の記録の番号も数える
        self.assertIsNone(self.stop(self.reply_with({**self.RET, "return_id": "ask1-1", "open": ["色"]})))
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1", "ask1-2", "ask1-7"])
        self.assertEqual(self.returns()[1]["decisions"][0]["text"], "別の話")
        self.assertEqual(len(self.sends()), 3)
        self.assertIn("質問 ask1: 返し ask1-7", self.sends()[-1])
        self.assertIn('{"return_id": "ask1-7", "rulings_seen"', read(self.orca_log))
        self.assertNotIn("saved_at", read(self.orca_log))

    def test_without_the_hook_field_the_last_reply_is_read_from_the_transcript(self):
        t = os.path.join(self.root, "t.jsonl")
        rows = [{"type": "user", "message": {"content": "前の質問"}},
                {"type": "assistant", "message": {"id": "m0", "content": [{"type": "text", "text": self.reply_with({**self.RET, "return_id": "ask1-7"})}]}},
                {"type": "user", "message": {"content": "5 つで"}},
                {"type": "assistant", "message": {"id": "m1", "content": [{"type": "tool_use", "id": "x", "name": "Read", "input": {}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "x", "content": "..."}]}},
                {"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": self.reply_with(self.RET)}]}}]
        with open(t, "w", encoding="utf-8") as fh:
            fh.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        self.hook("Stop", env=self.ask_env(), session_id="s-ask", transcript_path=t)
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1"])  # 前の回の返しは拾わない

    # ---- 未反映の判定（11.3・11.6 の 3・5） ----

    def test_a_return_stays_unreflected_until_the_rulings_and_the_asks_have_it_and_the_owner_is_told(self):
        self.stop(self.reply_with(self.RET))
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["判断の記録", "帳簿"]}])
        self.rule(kind="decision", text="凡例は 5 つ", quote="5 つにして", affects=["t1"], from_return="ask1-1")
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["帳簿"]}])
        self.cockpit["asks"] = [{"id": "ask1", "memo": ".orca/consult/ask-ask1.md", "from_returns": ["ask1-1"],
                                 "notify": [{"return_id": "ask1-1", "task": "t1"}]}]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["担当への通知"], "tasks": ["t1"]}])
        text = json.loads(self.hook("SessionStart", source="compact"))["hookSpecificOutput"]["additionalContext"]
        self.assertIn("- ask1-1（質問 ask1。無いもの: 担当への通知（t1）", text)
        self.cockpit["asks"][0]["notify"][0]["message_id"] = "msg_1"
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [])

    def test_a_decide_press_without_a_return_is_named_until_a_return_carries_its_op(self):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": [{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1", "answer": {"at": "09:59", "head": "5 つがよい"}},
                               {"op_id": 813, "type": "ask_decide", "item_id": "#ask:ask2"}, {"op_id": 814, "type": "undo", "undo_of": 813}]}, fh)
        self.assertEqual(self.unreflected(), [{"id": None, "ask": "ask1", "op": 812, "missing": ["返し"]}])
        self.stop(self.reply_with({**self.RET, "op": 812}))
        self.assertEqual([x["id"] for x in self.unreflected()], ["ask1-1"])

    def test_a_return_carrying_the_op_of_another_question_is_refused_and_leaves_that_press_named(self):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": [{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}]}, fh)
        out = self.stop(self.reply_with({**self.RET, "return_id": "ask2-1", "op": 812}), ask="ask2")
        self.assertIn("op 812 はこの質問（ask2）の「この答えを窓口に返す」ではない", out["reason"])
        self.assertEqual(self.returns("ask2"), [])
        self.assertEqual(self.unreflected(), [{"id": None, "ask": "ask1", "op": 812, "missing": ["返し"]}])

    def test_a_return_the_main_cannot_reflect_is_sent_back(self):
        for broken, why in (({"decisions": [42]}, "decisions の各項目"), ({"decisions": [{"text": "5 つ", "quote": "5 つ"}]}, "utterance"),
                            ({"rulings_seen": None}, "rulings_seen"), ({"requests": [{"quote": "見積も"}]}, "requests の各項目"),
                            ({"requests": [{"quote": 12, "utterance": "u-1"}]}, "requests の各項目"),
                            ({"decisions": [{"text": {"a": 1}, "quote": "x", "utterance": "u-1"}]}, "decisions の各項目")):
            out = self.stop(self.reply_with({**self.RET, **broken}))
            self.assertIn(why, out["reason"], broken)
        self.assertEqual(self.returns(), [])

    def test_an_example_mid_reply_does_not_spoil_the_return_at_the_end(self):
        example = "【窓口への返し】\n```json\n{\"return_id\": \"ask1-9\"}\n```"
        self.assertIsNone(self.stop("書式はたとえば\n" + example + "\nのように書く。\n\n" + self.reply_with(self.RET)))
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1"])
        # 依頼の原文にバッククォートが 3 つ続いても、末尾の塊として読む
        ret = {**self.RET, "return_id": "ask1-2", "requests": [{"quote": "```で囲んで送って", "utterance": "u-2"}]}
        self.assertIsNone(self.stop(self.reply_with(ret)))
        self.assertEqual([r["return_id"] for r in self.returns()], ["ask1-1", "ask1-2"])

    def test_the_notice_to_write_the_return_still_carries_the_new_rulings(self):
        self.launch("R2")
        self.rule(kind="decision", text="t9 は止める")  # R3
        out = self.say("【相談の知らせ】返しを書いて（op 812）")
        self.assertIn("R3 [decision] t9 は止める", out)
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def test_a_question_on_a_stream_gets_the_rulings_on_the_stream_and_its_tasks(self):
        """仕事に結んだ質問（控えの頭の「- 仕事:」）は、仕事の id を挙げる・その下のタスクを affects に持つ判断と全体の制約だけを流す。"""
        self.cockpit["tasks"][0]["stream"] = "s7"
        self.write_cockpit()
        self.assertIn("仕事 s7 に結ばれた質問", self.tool_args("ask-context", "ask3").stdout)
        self.launch("R2", ask="ask3")
        self.rule(kind="decision", text="t9 の話（この仕事に関係しない）")      # R3
        self.rule(kind="decision", text="s7 は定例の前日までに出す")            # R4 仕事を名指し
        self.rule(kind="decision", text="入口を描く", affects=["t1"])          # R5 仕事の下のタスク
        self.rule(kind="constraint", text="費用は月 5 万円まで", quote="5 万")  # R6 全体の制約
        out = self.say("続き", ask="ask3")
        self.assertNotIn("t9 の話", out)
        for want in ("R4 [decision] s7 は定例", "R5 [decision] 入口を描く", "R6 [constraint] 費用は"):
            self.assertIn(want, out)
        # 関係しない判断は読んだことにする（カードの相談と同じ。窓口の照合も関係する判断だけを見る）
        self.assertIn("関係する判断が増えた", out)
        self.assertIn("返しの rulings_seen に書く値は R6", out)
        self.assertEqual(self.say("次", ask="ask3"), "")
        since = self.tool_args("ask-context", "ask3", "--since", "R2").stdout
        self.assertNotIn("t9 の話", since)
        self.assertIn("R4 [decision] s7 は定例", since)
        self.assertEqual(self.jsonl("utterances.jsonl")[-1]["ask"], "ask3")
        # 最初の文脈も仕事に関係する判断だけ（ほかの仕事の判断で長さの上限を使わない）。
        first = self.tool_args("ask-context", "ask3").stdout
        self.assertNotIn("t9 の話", first)
        self.assertIn("R5 [decision] 入口を描く", first)
        self.assertIn("rulings_seen: R6", first)

    def test_rulings_seen_of_a_question_without_a_card_stops_at_what_it_passed(self):
        self.launch("R2")
        self.rule(kind="decision", text="t9 の話")                       # R3
        self.rule(kind="none", text="記録しない", dec="d21")              # R4 渡さない
        out = self.say("続き")
        self.assertIn("返しの rulings_seen に書く値は R3", out)
        self.assertEqual(self.keep()["asks"]["ask1"]["seen"], 3)

    def test_a_decide_press_the_main_applied_itself_is_not_named(self):
        with open(os.path.join(self.root, ".orca", "cockpit.user.json"), "w") as fh:
            json.dump({"ops": [{"op_id": 812, "type": "ask_decide", "item_id": "#ask:ask1"}]}, fh)
        self.cockpit["applied_ops"] = [812]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [])

    def test_a_held_question_return_is_named(self):
        self.stop(self.reply_with(self.RET))
        self.rule(kind="none", text="増えた判断で保留", dec="d21", from_return="ask1-1")
        self.cockpit["asks"] = [{"id": "ask1", "from_returns": ["ask1-1"], "held_returns": ["ask1-1"]}]
        self.write_cockpit()
        self.assertEqual(self.unreflected(), [{"id": "ask1-1", "ask": "ask1", "missing": ["保留"]}])

    def test_a_broken_ask_env_does_nothing(self):
        for v in (self.root, "/nowhere#ask1", "%s#d21" % self.root):
            self.hook("UserPromptSubmit", env=self.env(CONSULT_THREAD="1", CONSULT_ASK=v), prompt="質問")
        self.assertEqual(self.jsonl("utterances.jsonl"), [])

    def tool_args(self, *args):
        return subprocess.run([HOOK, args[0], self.root, *args[1:]], text=True, capture_output=True, env=self.env())


if __name__ == "__main__":
    unittest.main()
