#!/usr/bin/env python3
"""agy-hook.py が、agy の hook の入力を Claude の形に直して Claude の設定の hook を動かし、返事を agy の形に直すことを保証する。

入力は agy 1.5.3 で記録した実物（testdata/agy-hook/。lastUserInput だけ短くした）。Claude の設定は一時フォルダに作り、
hook は呼ばれた入力を控えて決めた返事をする偽物にする（危険な操作の拒否だけはこのリポジトリの本物の hook で確かめる）。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "agy-hook.py")
DATA = os.path.join(HERE, "testdata", "agy-hook")
PLUGIN = os.path.join(HERE, "..", "..", "gemini", "plugins", "harness")
# dev-standards の hooks.json にある draft-format-guard の matcher（Slack・Gmail に送る前の書式の検査）
# agy は --dangerously-skip-permissions で動くので、ask を確認の画面に出せない（11/28 の試しで force_ask も通った）
ASK_DENIED = "agy では確認の画面を出せないので止めた。"
DRAFT_MATCHER = r"^(Write|Bash|mcp__.*[Ss]lack.*__slack_(send_message|send_message_draft|schedule_message)|mcp__.*[Gg]mail.*__create_draft)$"

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
name = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
data = sys.stdin.read()
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"name": name, "input": json.loads(data), "cwd": os.getcwd(),
                        "env": {k: os.environ.get(k) for k in ("CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR")}},
                       ensure_ascii=False) + "\n")
reply = os.path.join(here, "replies", name)
def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()
if os.path.exists(reply + ".err"):
    sys.stderr.write(read(reply + ".err"))
if os.path.exists(reply):
    sys.stdout.write(read(reply))
sys.exit(int(read(reply + ".code")) if os.path.exists(reply + ".code") else 0)
'''


def group(*names, matcher=None, **extra):
    return dict({"hooks": [dict({"type": "command", "command": "FAKE %s" % n}, **extra) for n in names]},
                **({"matcher": matcher} if matcher is not None else {}))


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="agy-hook-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.config = os.path.join(self.dir, "claude")
        self.work = os.path.join(self.dir, "work")
        self.fakes = os.path.join(self.dir, "fakes")
        self.home = os.path.join(self.dir, "home")
        for d in (self.config, self.work, self.home, os.path.join(self.fakes, "replies")):
            os.makedirs(d)
        self.fake = os.path.join(self.fakes, "fake.py")
        with open(self.fake, "w") as f:
            f.write(FAKE)
        os.chmod(self.fake, 0o755)
        self.transcript = os.path.join(self.dir, "brain", "c", ".system_generated", "logs", "transcript_full.jsonl")
        os.makedirs(os.path.dirname(self.transcript))
        self.use_transcript("transcript-rec.jsonl")

    def settings(self, hooks, **extra):
        text = json.dumps(dict({"hooks": hooks}, **extra)).replace("FAKE ", self.fake + " ")
        with open(os.path.join(self.config, "settings.json"), "w") as f:
            f.write(text)

    def reply(self, name, out="", code=0, err=""):
        base = os.path.join(self.fakes, "replies", name)
        for suffix, text in (("", out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)),
                             (".code", str(code)), (".err", err)):
            with open(base + suffix, "w", encoding="utf-8") as f:
                f.write(text)

    def calls(self, name=None):
        try:
            with open(os.path.join(self.fakes, "calls.jsonl"), encoding="utf-8") as f:
                rows = [json.loads(line) for line in f]
        except FileNotFoundError:
            return []
        return [r for r in rows if name is None or r["name"] == name]

    def use_transcript(self, name, extra_rows=()):
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            text = f.read()
        with open(self.transcript, "w", encoding="utf-8") as f:
            f.write(text + "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in extra_rows))

    def recorded(self, name, **override):
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            inp = json.load(f)
        inp.update(transcriptPath=self.transcript, workspacePaths=[self.work], conversationId="conv-1")
        inp.update(override)
        return inp

    def env(self, home=False):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.config, AGY_HOOK_STATE=os.path.join(self.dir, "state"),
                   TMPDIR=self.dir)
        env.pop("COCKPIT_LEDGER_GUARD", None)  # このテストを動かす Claude Code の設定の env から入ってくる
        if home:
            # 偽の HOME は ~/.gemini に書く SessionStart と SyncSkills だけにする。ほかでも替えると、sandbox の中で
            # /usr/bin/python3（xcrun）が stderr に cache の警告を足し、hook の理由の文を比べるテストが落ちる
            env["HOME"] = self.home
        return env

    def run_hook(self, event, inp):
        r = subprocess.run([HOOK, event], input=json.dumps(inp), capture_output=True, text=True,
                           env=self.env(home=event == "SessionStart"), cwd=os.path.realpath(PLUGIN), timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout) if r.stdout.strip() else None


class ToolNames(Base):
    """道具名と引数を Claude の形に直してから matcher を当てる（H4 の Slack を含む）。"""

    def setUp(self):
        Base.setUp(self)
        self.settings({"PreToolUse": [group("bash", matcher="Bash"), group("read", matcher="Read"),
                                      group("write", matcher="Write|Edit|MultiEdit"), group("draft", matcher=DRAFT_MATCHER),
                                      group("mcp", matcher="mcp__.*"), group("all")]})

    def called(self, inp):
        self.run_hook("PreToolUse", inp)
        return {r["name"]: r["input"] for r in self.calls()}

    def test_run_command_is_bash(self):
        got = self.called(self.recorded("pre-run_command.json"))
        self.assertEqual(sorted(got), ["all", "bash", "draft"])
        self.assertEqual(got["bash"]["tool_name"], "Bash")
        self.assertEqual(got["bash"]["tool_input"], {"command": "echo hello"})
        self.assertEqual(got["bash"]["hook_event_name"], "PreToolUse")
        self.assertEqual(got["bash"]["session_id"], "conv-1")
        self.assertEqual(got["bash"]["cwd"], self.work)
        self.assertEqual(got["bash"]["permission_mode"], "default")
        self.assertEqual(got["bash"]["transcript_path"], self.transcript)

    def test_read_write_and_edit(self):
        got = self.called(self.recorded("pre-read_file.json"))
        self.assertEqual(got["read"]["tool_input"], {"file_path": self.recorded("pre-read_file.json")["toolCall"]["args"]["Path"]})
        os.remove(os.path.join(self.fakes, "calls.jsonl"))
        got = self.called(self.recorded("pre-write_file.json"))
        self.assertEqual(sorted(got), ["all", "draft", "write"])
        self.assertEqual(got["write"]["tool_name"], "Write")
        self.assertEqual(set(got["write"]["tool_input"]), {"file_path", "content"})
        self.assertEqual(got["write"]["tool_input"]["content"], "abc")
        os.remove(os.path.join(self.fakes, "calls.jsonl"))
        got = self.called(self.recorded("pre-edit_file-multiline.json"))
        self.assertEqual(got["write"]["tool_name"], "Edit")
        self.assertEqual(got["write"]["tool_input"]["old_string"], "line1\nLINE-TWO\nline3")
        self.assertEqual(got["write"]["tool_input"]["new_string"], "L1\nLINE-TWO\nL3")

    def test_mcp_calls_are_opened_to_the_server_and_tool(self):
        got = self.called(self.recorded("pre-call_mcp_tool.json"))
        self.assertEqual(sorted(got), ["all", "mcp"])
        self.assertEqual(got["mcp"]["tool_name"], "mcp__context7__resolve-library-id")
        self.assertEqual(got["mcp"]["tool_input"], {"libraryName": "react", "query": "react"})

    def test_a_slack_send_reaches_the_draft_format_guard(self):
        inp = self.recorded("pre-call_mcp_tool.json")
        inp["toolCall"]["args"] = {"ServerName": "slack", "ToolName": "slack_send_message",
                                   "Arguments": {"channel_id": "C1", "message": "**太字**"}}
        got = self.called(inp)
        self.assertEqual(sorted(got), ["all", "draft", "mcp"])
        self.assertEqual(got["draft"]["tool_name"], "mcp__slack__slack_send_message")
        self.assertEqual(got["draft"]["tool_input"], {"channel_id": "C1", "message": "**太字**"})


class PreToolOutput(Base):
    """Claude の hook の許可の返事を agy の decision に直す。"""

    def assert_ask_denied(self, out, reason):
        self.assertEqual(out["decision"], "deny")
        self.assertTrue(out["reason"].startswith(reason + "\n\n" + ASK_DENIED), out["reason"])
        self.assertIn("深田さんが自分で打つ", out["reason"])

    def setUp(self):
        Base.setUp(self)
        self.settings({"PreToolUse": [group("a", "b", matcher="Bash")]})
        self.inp = self.recorded("pre-run_command.json")

    def test_silence_prints_nothing(self):
        self.assertIsNone(self.run_hook("PreToolUse", self.inp))
        self.assertEqual(len(self.calls()), 2)

    def test_deny_by_json_or_exit_2(self):
        self.reply("a", {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                "permissionDecisionReason": "uv を使う"}})
        self.reply("b", code=2, err="危険なコマンド\n")
        out = self.run_hook("PreToolUse", self.inp)
        self.assertEqual(out["decision"], "deny")
        self.assertIn("uv を使う", out["reason"])
        self.assertIn("危険なコマンド", out["reason"])

    def test_deny_wins_over_ask_and_ask_is_denied_because_agy_cannot_show_a_prompt(self):
        self.reply("a", {"hookSpecificOutput": {"permissionDecision": "ask", "permissionDecisionReason": "課金"}})
        self.assert_ask_denied(self.run_hook("PreToolUse", self.inp), "課金")
        self.reply("b", {"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "止める"}})
        self.assertEqual(self.run_hook("PreToolUse", self.inp), {"decision": "deny", "reason": "止める"})

    def test_updated_input_goes_back_as_agy_arguments(self):
        self.reply("a", {"hookSpecificOutput": {"permissionDecision": "allow",
                                                "updatedInput": {"command": "gh pr create --body 'x'"}}})
        self.assertEqual(self.run_hook("PreToolUse", self.inp),
                         {"decision": "allow", "overwrite": {"CommandLine": "gh pr create --body 'x'"}})

    def test_other_exit_codes_and_broken_output_are_not_decisions(self):
        self.reply("a", "壊れた出力 {", code=1, err="落ちた")
        self.reply("b", "{not json")
        self.assertIsNone(self.run_hook("PreToolUse", self.inp))
        with open(os.path.join(self.dir, "agy-hook.log"), encoding="utf-8") as f:
            self.assertIn("exit 1 落ちた", f.read())

    def test_one_hook_registered_under_two_matchers_runs_for_both(self):
        # dev-standards の llm-call-guard は Write|Edit|MultiEdit と Bash に同じコマンドで登録されている
        self.settings({"PreToolUse": [group("guard", matcher="Write|Edit|MultiEdit"), group("guard", matcher="Bash"),
                                      group("guard", matcher="Bash")]})
        self.reply("guard", {"hookSpecificOutput": {"permissionDecision": "ask", "permissionDecisionReason": "課金"}})
        self.assert_ask_denied(self.run_hook("PreToolUse", self.inp), "課金")
        self.assertEqual(len(self.calls("guard")), 1)

    def test_context_and_notices_from_pre_tool_reach_the_next_invocation(self):
        self.reply("a", {"systemMessage": "時間切れで書き直しを見送った",
                         "hookSpecificOutput": {"permissionDecision": "allow", "additionalContext": "差分は /tmp/x.diff"}})
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json"))  # 道具の前には必ずその発言の呼び出しがある
        self.assertEqual(self.run_hook("PreToolUse", self.inp), {"decision": "allow"})
        self.assertEqual(self.run_hook("PreInvocation", self.recorded("pre-invocation-1.json", conversationId="other")), {})
        out = self.run_hook("PreInvocation", self.recorded("pre-invocation-1.json"))
        self.assertEqual(out, {"injectSteps": [
            {"systemMessage": {"systemMessage": "差分は /tmp/x.diff"}},
            {"systemMessage": {"systemMessage": "", "metadata": {"user_markdown": "時間切れで書き直しを見送った"}}}]})

    def test_a_deny_is_returned_even_when_the_state_cannot_be_written(self):
        with open(os.path.join(self.dir, "state"), "w") as f:
            f.write("フォルダの代わりのファイル")
        self.reply("a", {"systemMessage": "知らせ", "hookSpecificOutput": {"permissionDecision": "deny",
                                                                        "permissionDecisionReason": "止める"}})
        self.assertEqual(self.run_hook("PreToolUse", self.inp), {"decision": "deny", "reason": "止める"})

    def test_the_real_package_manager_guard_denies_pip(self):
        guard = os.path.join(HERE, "guard-package-manager.sh")
        with open(os.path.join(self.config, "settings.json"), "w") as f:
            json.dump({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": guard}]}]}}, f)
        self.inp["toolCall"]["args"]["CommandLine"] = "pip install requests"
        out = self.run_hook("PreToolUse", self.inp)
        self.assertEqual(out["decision"], "deny")
        self.assertIn("uv", out["reason"])
        self.inp["toolCall"]["args"]["CommandLine"] = "echo hello"
        self.assertIsNone(self.run_hook("PreToolUse", self.inp))


class Settings(Base):
    """どの hook を動かすかは Claude の設定とプラグインから読む。Orca の hook は呼ばない。"""

    def plugin(self, pid, hooks, manifest=None):
        root = os.path.join(self.dir, "plugins", pid.split("@")[0])
        os.makedirs(os.path.join(root, "hooks"))
        with open(os.path.join(root, "hooks", "hooks.json"), "w") as f:
            f.write(json.dumps({"hooks": hooks}).replace("FAKE ", self.fake + " "))
        if manifest is not None:
            os.makedirs(os.path.join(root, ".claude-plugin"))
            with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as f:
                json.dump(manifest, f)
        return root

    def install(self, roots):
        os.makedirs(os.path.join(self.config, "plugins"), exist_ok=True)
        with open(os.path.join(self.config, "plugins", "installed_plugins.json"), "w") as f:
            json.dump({"version": 2, "plugins": {pid: [{"scope": "user", "installPath": r}] for pid, r in roots.items()}}, f)

    def test_plugins_orca_hooks_and_disabled_plugins(self):
        on = self.plugin("dev@market", {"PreToolUse": [group("plugin", matcher="Bash")]})
        off = self.plugin("off@market", {"PreToolUse": [group("disabled")]})
        extra = self.plugin("extra@market", {}, manifest={"hooks": "./extra.json"})
        with open(os.path.join(extra, "extra.json"), "w") as f:
            f.write(json.dumps({"hooks": {"PreToolUse": [group("manifest")]}}).replace("FAKE ", self.fake + " "))
        self.install({"dev@market": on, "off@market": off, "extra@market": extra})
        orca = 'if [ -f "${HOME}/.orca/agent-hooks/claude-hook.sh" ]; then FAKE orca; fi; ORCA_AGENT_HOOK_PORT=1 FAKE orca'
        self.settings({"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": orca}]}, group("user")]},
                      enabledPlugins={"dev@market": True, "off@market": False, "extra@market": True})
        self.run_hook("PreToolUse", self.recorded("pre-run_command.json"))
        names = sorted(r["name"] for r in self.calls())
        self.assertEqual(names, ["manifest", "plugin", "user"])
        (plugin,) = self.calls("plugin")
        self.assertEqual(plugin["env"]["CLAUDE_PLUGIN_ROOT"], on)
        self.assertEqual(plugin["env"]["CLAUDE_PLUGIN_DATA"], os.path.join(self.config, "plugins", "data", "dev-market"))
        self.assertEqual(plugin["env"]["CLAUDE_PROJECT_DIR"], self.work)
        self.assertEqual(os.path.realpath(plugin["cwd"]), os.path.realpath(self.work))

    def test_async_hooks_are_not_waited_for_and_odd_entries_are_skipped(self):
        self.settings({"PreToolUse": [{"hooks": ["壊れた項目", {"type": "prompt", "prompt": "x"},
                                                 {"type": "command", "command": "sleep 5; FAKE late", "async": True}]},
                                      group("user")]})
        started = time.monotonic()
        self.run_hook("PreToolUse", self.recorded("pre-run_command.json"))
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual([r["name"] for r in self.calls()], ["user"])

    def project(self, name, hooks, **extra):
        os.makedirs(os.path.join(self.work, ".claude"), exist_ok=True)
        with open(os.path.join(self.work, ".claude", name), "w") as f:
            f.write(json.dumps(dict({"hooks": hooks}, **extra)).replace("FAKE ", self.fake + " "))

    def test_project_settings_are_read_and_user_disable_all_hooks_stops_everything(self):
        self.project("settings.local.json", {"PreToolUse": [group("project")]})
        self.settings({"PreToolUse": [group("user")]})
        self.run_hook("PreToolUse", self.recorded("pre-run_command.json"))
        self.assertEqual(sorted(r["name"] for r in self.calls()), ["project", "user"])
        self.settings({"PreToolUse": [group("user")]}, disableAllHooks=True)
        self.run_hook("PreToolUse", self.recorded("pre-run_command.json"))
        self.assertEqual(len(self.calls()), 2)

    def test_project_disable_all_hooks_drops_only_that_projects_hooks(self):
        # 開いたリポジトリの設定で、ユーザー側の拒否の hook とプラグインの hook を止めさせない（Astra の指摘 1）
        on = self.plugin("dev@market", {"PreToolUse": [group("plugin", matcher="Bash")]})
        by_project = self.plugin("proj@market", {"PreToolUse": [group("project-plugin")]})
        self.install({"dev@market": on, "proj@market": by_project})
        self.settings({"PreToolUse": [group("user")]}, enabledPlugins={"dev@market": True})
        self.project("settings.json", {"PreToolUse": [group("project")]}, disableAllHooks=True,
                     enabledPlugins={"proj@market": True})
        self.project("settings.local.json", {"PreToolUse": [group("local")]})
        self.run_hook("PreToolUse", self.recorded("pre-run_command.json"))
        self.assertEqual(sorted(r["name"] for r in self.calls()), ["local", "plugin", "user"])


class HookEnv(Base):
    """hook の環境には、Claude Code と同じくユーザー側の settings.json の env を足す。プロジェクトの env は足さない。"""

    GUARD = os.path.join(HERE, "compaction-keep.py")

    def setUp(self):
        Base.setUp(self)
        os.makedirs(os.path.join(self.work, ".orca"))
        self.ledger = os.path.join(self.work, ".orca", "cockpit.json")
        with open(self.ledger, "w", encoding="utf-8") as f:
            json.dump({"version": 3, "intake": []}, f)  # 版 3 の帳簿（intake の欄がある）
        self.inp = self.recorded("pre-write_file.json")
        self.inp["toolCall"]["args"]["Path"] = self.ledger

    def user(self, **extra):
        with open(os.path.join(self.config, "settings.json"), "w") as f:
            json.dump(dict({"hooks": {"PreToolUse": [{"matcher": "Write|Edit|MultiEdit",
                                                       "hooks": [{"type": "command", "command": self.GUARD}]}]}},
                           **extra), f)

    def test_the_ledger_guard_is_on_through_the_user_settings_env(self):
        # nix-darwin の claude/settings.json の env が COCKPIT_LEDGER_GUARD=1 を持つ（Astra の指摘 2）
        self.user(env={"COCKPIT_LEDGER_GUARD": "1"})
        out = self.run_hook("PreToolUse", self.inp)
        self.assertEqual(out["decision"], "deny", out)
        self.assertIn("cockpit-write", out["reason"])

    def test_the_ledger_guard_stays_off_without_the_user_env_and_the_project_env_is_not_used(self):
        self.user()
        os.makedirs(os.path.join(self.work, ".claude"))
        with open(os.path.join(self.work, ".claude", "settings.json"), "w") as f:
            json.dump({"env": {"COCKPIT_LEDGER_GUARD": "1"}}, f)
        self.assertIsNone(self.run_hook("PreToolUse", self.inp))


class Prompts(Base):
    """PreInvocation はモデルを呼ぶたびに来るが、UserPromptSubmit は会話記録のユーザー入力の行ごとに 1 回（H1）。"""

    def setUp(self):
        Base.setUp(self)
        self.settings({"UserPromptSubmit": [group("prompt")], "SessionStart": [group("start", matcher="startup|resume")]})

    def test_session_start_is_startup_and_its_text_is_injected(self):
        self.reply("start", "【操縦席】このセッションは窓口\n")
        out = self.run_hook("SessionStart", self.recorded("session-start.json"))
        self.assertEqual(out, {"injectSteps": [{"systemMessage": {"systemMessage": "【操縦席】このセッションは窓口"}}]})
        (call,) = self.calls("start")
        self.assertEqual(call["input"]["source"], "startup")
        self.assertEqual(call["input"]["hook_event_name"], "SessionStart")

    def test_one_prompt_is_submitted_once_across_invocations(self):
        self.reply("prompt", {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "今: 14:31"}})
        first = self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json"))
        self.assertEqual(first, {"injectSteps": [{"systemMessage": {"systemMessage": "今: 14:31"}}]})
        self.assertEqual(self.run_hook("PreInvocation", self.recorded("pre-invocation-1.json")), {})
        (call,) = self.calls("prompt")
        self.assertTrue(call["input"]["prompt"].startswith("次を順に答えて。1)"), call["input"]["prompt"])
        self.assertNotIn("USER_REQUEST", call["input"]["prompt"])
        self.assertNotIn("ADDITIONAL_METADATA", call["input"]["prompt"])
        self.assertEqual(call["input"]["hook_event_name"], "UserPromptSubmit")

    def test_the_same_words_on_the_next_turn_are_a_new_prompt(self):
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json"))
        with open(os.path.join(DATA, "transcript-rec.jsonl"), encoding="utf-8") as f:
            again = dict(json.loads(f.readline()), step_index=6)
        self.use_transcript("transcript-rec.jsonl", [again])
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json", initialNumSteps=7))
        prompts = [c["input"]["prompt"] for c in self.calls("prompt")]
        self.assertEqual(len(prompts), 2)
        self.assertEqual(prompts[0], prompts[1])

    def test_conversations_are_kept_apart(self):
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json"))
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json", conversationId="conv-2"))
        self.assertEqual([c["input"]["session_id"] for c in self.calls("prompt")], ["conv-1", "conv-2"])

    def test_a_blocked_prompt_terminates_before_the_model(self):
        self.reply("prompt", {"decision": "block", "reason": "新しいチャットに引き継いだ"})
        self.assertEqual(self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json")),
                         {"injectSteps": [{"errorMessage": {"userMessage": "新しいチャットに引き継いだ"}}],
                          "terminationBehavior": "terminate"})


class Writes(Base):
    """PostToolUse の指摘は次のモデルの呼び出しで返し、書き込めたファイルは Stop に渡す（H3）。"""

    def setUp(self):
        Base.setUp(self)
        self.settings({"PreToolUse": [group("pre")],
                       "PostToolUse": [group("post", matcher="Write|Edit|MultiEdit"), group("anytool")],
                       "Stop": [group("stop")], "UserPromptSubmit": [group("prompt")]})
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json"))

    def stop_input(self):
        self.run_hook("Stop", self.recorded("stop.json"))
        return self.calls("stop")[-1]["input"]

    def test_successful_writes_and_edits_reach_stop_in_claude_form(self):
        write = self.recorded("post-write_file.json")
        edit = self.recorded("post-edit_file-multiline.json")
        self.assertEqual(self.run_hook("PostToolUse", write), {})
        self.run_hook("PostToolUse", edit)
        self.run_hook("PostToolUse", self.recorded("post-run_command-exit127.json"))
        failed = self.recorded("post-edit_file-multiline.json", error="target not found")
        self.run_hook("PostToolUse", failed)
        writes = self.stop_input()["turn_writes"]
        self.assertEqual([w["tool_input"]["file_path"] for w in writes],
                         [write["toolCall"]["args"]["Path"], edit["toolCall"]["args"]["Path"]])
        self.assertEqual(writes[0]["tool_input"]["content"], "abc")
        self.assertEqual(writes[1]["tool_input"]["new_string"], "L1\nLINE-TWO\nL3")
        self.assertEqual([w["original"] for w in writes], [None, None], "PreToolUse を通っていない書き込みは前の本文が分からない")
        self.assertEqual([c["input"]["tool_name"] for c in self.calls("post")], ["Write", "Edit"])
        self.assertEqual(len(self.calls("anytool")), 3, "失敗した道具には PostToolUse を呼ばない（exit 127 でも error は空）")

    def test_the_text_before_each_write_is_read_at_pre_tool_use(self):
        target = os.path.join(self.work, "note.md")
        with open(target, "w", encoding="utf-8") as f:
            f.write("利用者が直した本文\n")
        edit = self.recorded("pre-edit_file.json")
        edit["toolCall"]["args"]["Path"] = target
        new = self.recorded("pre-write_file.json")
        new["toolCall"]["args"]["Path"] = os.path.join(self.work, "new.md")
        for pre in (edit, new):
            self.run_hook("PreToolUse", pre)
            with open(pre["toolCall"]["args"]["Path"], "w", encoding="utf-8") as f:
                f.write("agy が書いた本文\n")
            self.run_hook("PostToolUse", dict(pre, error=""))
        writes = self.stop_input()["turn_writes"]
        self.assertEqual([(w["tool_input"]["file_path"], w["original"]) for w in writes],
                         [(target, "利用者が直した本文\n"), (os.path.join(self.work, "new.md"), "")])
        self.assertEqual([c["input"]["tool_response"] for c in self.calls("post")],
                         [{"originalFile": "利用者が直した本文\n"}, {"originalFile": ""}])

    def test_a_fifo_as_the_write_target_does_not_hang_the_guard(self):
        fifo = os.path.join(self.work, "pipe.md")
        os.mkfifo(fifo)
        pre = self.recorded("pre-write_file.json")
        pre["toolCall"]["args"]["Path"] = fifo
        self.reply("pre", {"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "止める"}})
        self.assertEqual(self.run_hook("PreToolUse", pre), {"decision": "deny", "reason": "止める"})

    def test_post_tool_context_is_returned_on_the_next_invocation(self):
        self.reply("post", {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "空白を詰めた"}})
        self.reply("anytool", {"systemMessage": "利用者向け"})
        self.run_hook("PostToolUse", self.recorded("post-write_file.json"))
        out = self.run_hook("PreInvocation", self.recorded("pre-invocation-1.json"))
        self.assertEqual(out, {"injectSteps": [
            {"systemMessage": {"systemMessage": "空白を詰めた"}},
            {"systemMessage": {"systemMessage": "", "metadata": {"user_markdown": "利用者向け"}}}]})
        self.assertEqual(self.run_hook("PreInvocation", self.recorded("pre-invocation-1.json")), {})

    def test_model_notes_from_an_unfinished_turn_are_not_carried_into_the_next_prompt(self):
        self.reply("post", {"hookSpecificOutput": {"additionalContext": "前のターンの指摘"}})
        self.reply("anytool", {"systemMessage": "利用者向け"})
        self.run_hook("PostToolUse", self.recorded("post-write_file.json"))
        with open(os.path.join(DATA, "transcript-rec.jsonl"), encoding="utf-8") as f:
            again = dict(json.loads(f.readline()), step_index=6)
        self.use_transcript("transcript-rec.jsonl", [again])
        out = self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json", initialNumSteps=7))
        self.assertEqual(out, {"injectSteps": [
            {"systemMessage": {"systemMessage": "", "metadata": {"user_markdown": "利用者向け"}}}]})

    def test_a_new_prompt_starts_a_new_list(self):
        self.run_hook("PostToolUse", self.recorded("post-write_file.json"))
        with open(os.path.join(DATA, "transcript-rec.jsonl"), encoding="utf-8") as f:
            again = dict(json.loads(f.readline()), step_index=6)
        self.use_transcript("transcript-rec.jsonl", [again])
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json", initialNumSteps=7))
        self.assertEqual(self.stop_input()["turn_writes"], [])


class Stops(Base):
    """Stop に最後の返答を渡し、差し戻したかを次の Stop の stop_hook_active にする（H2）。"""

    def setUp(self):
        Base.setUp(self)
        self.settings({"Stop": [group("stop")], "UserPromptSubmit": [group("prompt")]})

    def test_the_last_reply_comes_from_the_transcript(self):
        self.run_hook("Stop", self.recorded("stop.json"))
        (call,) = self.calls("stop")
        self.assertTrue(call["input"]["last_assistant_message"].startswith("1) **決まり（rules）の合言葉**"))
        self.assertIs(call["input"]["stop_hook_active"], False)
        self.assertEqual(call["input"]["hook_event_name"], "Stop")

    def test_a_folder_as_transcript_path_is_followed_to_the_log(self):
        folder = os.path.dirname(os.path.dirname(os.path.dirname(self.transcript)))
        self.run_hook("Stop", self.recorded("stop.json", transcriptPath=folder))
        self.assertEqual(self.calls("stop")[0]["input"]["transcript_path"], self.transcript)

    def test_block_continues_and_the_next_stop_is_active_until_a_new_prompt(self):
        self.reply("stop", {"decision": "block", "reason": "先送りがある"})
        self.assertEqual(self.run_hook("Stop", self.recorded("stop.json")), {"decision": "continue", "reason": "先送りがある"})
        self.reply("stop", code=2, err="まだ日本語の検査が残る")
        self.assertEqual(self.run_hook("Stop", self.recorded("stop.json")),
                         {"decision": "continue", "reason": "まだ日本語の検査が残る"})
        self.reply("stop", "")
        self.assertEqual(self.run_hook("Stop", self.recorded("stop.json")), {"decision": ""})
        self.run_hook("Stop", self.recorded("stop.json"))
        self.assertEqual([c["input"]["stop_hook_active"] for c in self.calls("stop")], [False, True, True, False])
        self.reply("stop", {"decision": "block", "reason": "x"})
        self.run_hook("Stop", self.recorded("stop.json"))
        self.run_hook("PreInvocation", self.recorded("pre-invocation-0.json"))
        self.run_hook("Stop", self.recorded("stop.json"))
        self.assertIs(self.calls("stop")[-1]["input"]["stop_hook_active"], False)

    def test_cancelled_or_failed_runs_do_not_call_stop(self):
        self.assertEqual(self.run_hook("Stop", self.recorded("stop.json", terminationReason="USER_CANCELED")), {"decision": ""})
        self.assertEqual(self.calls("stop"), [])

    def test_a_stop_notice_is_shown_to_the_user_next_time(self):
        self.reply("stop", {"systemMessage": "ja-review: 1 ファイルを書き直した"})
        self.assertEqual(self.run_hook("Stop", self.recorded("stop.json")), {"decision": ""})
        out = self.run_hook("PreInvocation", self.recorded("pre-invocation-1.json"))
        self.assertEqual(out["injectSteps"][-1],
                         {"systemMessage": {"systemMessage": "", "metadata": {"user_markdown": "ja-review: 1 ファイルを書き直した"}}})


class SyncSkills(Base):
    def setUp(self):
        Base.setUp(self)
        self.gemini = os.path.join(self.home, ".gemini", "config")
        self.target = os.path.join(self.gemini, "skills.json")
        os.makedirs(self.gemini)
        self.user_skills = os.path.join(self.home, ".claude", "skills")
        os.makedirs(self.user_skills)
        os.makedirs(os.path.join(self.config, "plugins"))

    def plugin(self, name, skills=True, manifest=None):
        root = os.path.join(self.dir, "seat", "cache", name, "1.0.0")
        os.makedirs(os.path.join(root, "skills") if skills else root)
        if manifest is not None:
            os.makedirs(os.path.join(root, ".claude-plugin"))
            with open(os.path.join(root, ".claude-plugin", "plugin.json"), "w") as f:
                json.dump(manifest, f)
        return root

    def setup_plugins(self, installed, enabled):
        with open(os.path.join(self.config, "plugins", "installed_plugins.json"), "w") as f:
            json.dump({"version": 2, "plugins": {pid: [{"scope": "user", "installPath": r}] for pid, r in installed.items()}}, f)
        self.settings({}, enabledPlugins=enabled)

    def sync(self, code=0):
        # 標準入力を開いたままにする: 入力を読みに行くと、閉じるまで終わらずに timeout で落ちる
        p = subprocess.Popen([HOOK, "SyncSkills"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=self.env(home=True))
        try:
            p.wait(timeout=30)
        finally:
            p.kill()
            p.stdin.close()
        out, err = p.stdout.read(), p.stderr.read()
        p.stdout.close()
        p.stderr.close()
        self.assertEqual(p.returncode, code, err)
        return out if code == 0 else err

    def entries(self):
        with open(self.target, encoding="utf-8") as f:
            return [e["path"] for e in json.load(f)["entries"]]

    def test_enabled_plugins_with_skills_are_listed_after_the_user_skills(self):
        dev = self.plugin("dev", manifest={"name": "dev"})
        extra = self.plugin("extra", manifest={"skills": ["./more", "./skills", "./missing"]})
        os.makedirs(os.path.join(extra, "more"))
        lsp = self.plugin("lsp", skills=False)
        off = self.plugin("off")
        self.setup_plugins({"dev@m": dev, "extra@m": extra, "lsp@m": lsp, "off@m": off,
                            "gone@m": os.path.join(self.dir, "removed")},
                           {"dev@m": True, "extra@m": True, "lsp@m": True, "off@m": False, "gone@m": True,
                            "unknown@m": True})
        self.assertIn("書いた（4 件）", self.sync())
        self.assertEqual(self.entries(), [self.user_skills, os.path.join(dev, "skills"), os.path.join(extra, "skills"),
                                          os.path.join(extra, "more")])
        self.assertTrue(all(os.path.isabs(p) for p in self.entries()))

    def test_a_plugin_switched_off_drops_out_on_the_next_sync(self):
        dev = self.plugin("dev")
        self.setup_plugins({"dev@m": dev}, {"dev@m": True})
        self.sync()
        self.settings({}, enabledPlugins={"dev@m": False})
        self.sync()
        self.assertEqual(self.entries(), [self.user_skills])

    def test_the_same_content_is_not_written_again(self):
        self.setup_plugins({"dev@m": self.plugin("dev")}, {"dev@m": True})
        self.sync()
        before = os.stat(self.target)
        self.assertIn("変わりなし", self.sync())
        after = os.stat(self.target)
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))
        self.assertEqual(sorted(os.listdir(self.gemini)), ["skills.json"])

    def test_a_symlink_managed_by_nix_is_left_alone(self):
        managed = os.path.join(self.dir, "nix-store-skills.json")
        with open(managed, "w") as f:
            f.write('{"entries": []}\n')
        os.symlink(managed, self.target)
        self.setup_plugins({"dev@m": self.plugin("dev")}, {"dev@m": True})
        self.assertIn("symlink", self.sync())
        self.assertTrue(os.path.islink(self.target))
        with open(managed) as f:
            self.assertEqual(f.read(), '{"entries": []}\n')

    def test_the_first_sync_creates_the_agy_config_folder(self):
        shutil.rmtree(os.path.join(self.home, ".gemini"))
        self.sync()
        self.assertEqual(self.entries(), [self.user_skills])

    def test_broken_claude_settings_fail_without_touching_the_file(self):
        dev = self.plugin("dev")
        self.setup_plugins({"dev@m": dev}, {"dev@m": True})
        self.sync()
        for broken in (os.path.join(self.config, "settings.json"),
                       os.path.join(self.config, "plugins", "installed_plugins.json")):
            with open(broken) as f:
                good = f.read()
            for bad in ("{壊れた", '{"enabledPlugins": [], "plugins": []}'):
                with open(broken, "w") as f:
                    f.write(bad)
                self.assertIn("SyncSkills", self.sync(code=1))
                self.assertEqual(self.entries(), [self.user_skills, os.path.join(dev, "skills")])
            with open(broken, "w") as f:
                f.write(good)
        os.chmod(os.path.join(self.config, "plugins"), 0)
        try:
            self.assertIn("Permission denied", self.sync(code=1))
        finally:
            os.chmod(os.path.join(self.config, "plugins"), 0o755)
        self.assertEqual(self.entries(), [self.user_skills, os.path.join(dev, "skills")])

    def test_other_keys_of_the_file_are_kept(self):
        with open(self.target, "w") as f:
            json.dump({"entries": [{"path": "/old"}], "other": 1}, f)
        self.sync()
        with open(self.target) as f:
            self.assertEqual(json.load(f), {"entries": [{"path": self.user_skills}], "other": 1})

    def test_session_start_syncs_and_a_failure_does_not_stop_the_other_hooks(self):
        self.setup_plugins({"dev@m": self.plugin("dev")}, {"dev@m": True})
        self.settings({"SessionStart": [group("start")]}, enabledPlugins={"dev@m": True})
        self.reply("start", "【操縦席】窓口\n")
        self.run_hook("SessionStart", self.recorded("session-start.json"))
        self.assertEqual(len(self.entries()), 2)
        os.remove(self.target)
        os.makedirs(self.target)
        out = self.run_hook("SessionStart", self.recorded("session-start.json"))
        self.assertEqual(out, {"injectSteps": [{"systemMessage": {"systemMessage": "【操縦席】窓口"}}]})
        with open(os.path.join(self.dir, "agy-hook.log"), encoding="utf-8") as f:
            self.assertIn("SessionStart SyncSkills", f.read())


class RepoSkills(Base):
    def skill(self, root, folder, text):
        d = os.path.join(root, ".claude", "skills", folder)
        os.makedirs(d)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(text)
        return os.path.join(d, "SKILL.md")

    def start(self, work):
        out = self.run_hook("SessionStart", self.recorded("session-start.json", workspacePaths=[work]))
        return [s["systemMessage"]["systemMessage"] for s in (out or {}).get("injectSteps", [])]

    def test_the_skills_of_the_repository_root_are_listed_from_a_subfolder(self):
        repo = os.path.realpath(self.work)
        subprocess.run(["git", "init", "-q", repo], check=True)
        deck = self.skill(repo, "deck", "---\nname: deck\ndescription: >\n  提案資料を作る。\n  「スライド作って」で発動する。\n---\n本文\n")
        quoted = self.skill(repo, "estimate", '---\nname: "estimate-x"\ndescription: "見積書を作る"\n---\n')
        bare = self.skill(repo, "plain", "# 前置きなし\n")
        os.makedirs(os.path.join(repo, ".claude", "skills", "empty"))
        sub = os.path.join(repo, "docs", "a")
        os.makedirs(sub)
        (text,) = self.start(sub)
        lead, *rows = text.split("\n- ")
        self.assertIn("このリポジトリ（%s）の skill" % repo, lead)
        self.assertIn("read_file でその SKILL.md を読み", lead)
        self.assertIn("office の deck）よりこちらを優先する", lead)
        self.assertEqual(rows, ["deck: 提案資料を作る。 「スライド作って」で発動する。\n  %s" % deck,
                                "estimate-x: 見積書を作る\n  %s" % quoted,
                                "plain: （説明なし）\n  %s" % bare])

    def test_a_repository_without_skills_adds_nothing(self):
        subprocess.run(["git", "init", "-q", self.work], check=True)
        os.makedirs(os.path.join(self.work, ".claude"))
        self.assertEqual(self.start(self.work), [])

    def test_a_folder_outside_git_adds_nothing(self):
        # $HOME で起動したときに ~/.claude/skills をリポジトリの skill として出さない
        self.skill(self.work, "deck", "---\ndescription: x\n---\n")
        self.assertEqual(self.start(self.work), [])

    def test_many_skills_and_long_descriptions_are_cut(self):
        subprocess.run(["git", "init", "-q", self.work], check=True)
        for i in range(45):
            self.skill(self.work, "s%02d" % i, "---\ndescription: %s\n---\n" % ("長" * 300))
        (text,) = self.start(self.work)
        rows = text.split("\n- ")[1:]
        self.assertEqual(len(rows), 41)
        self.assertTrue(rows[0].startswith("s00: " + "長" * 199 + "…\n"), rows[0][:20])
        self.assertTrue(rows[-1].startswith("ほか 5 件は"), rows[-1])


class PluginFile(unittest.TestCase):
    """agy のプラグインは、agy の 5 つのイベントで入口を呼ぶだけ。"""

    def test_each_event_calls_the_entry_with_its_name(self):
        with open(os.path.join(PLUGIN, "hooks.json"), encoding="utf-8") as f:
            (spec,) = json.load(f).values()
        with open(os.path.join(PLUGIN, "plugin.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["name"], "harness")
        self.assertEqual(sorted(spec), ["PostToolUse", "PreInvocation", "PreToolUse", "SessionStart", "Stop"])
        for event, handlers in spec.items():
            if event in ("PreToolUse", "PostToolUse"):
                (g,) = handlers
                self.assertEqual(g["matcher"], "*")
                handlers = g["hooks"]
            (h,) = handlers
            path, name = h["command"].split()
            self.assertEqual(name, event)
            self.assertEqual(os.path.realpath(os.path.join(PLUGIN, path)), os.path.realpath(HOOK))
        self.assertGreaterEqual(spec["Stop"][0]["timeout"], 900)
        self.assertGreaterEqual(spec["PreToolUse"][0]["hooks"][0]["timeout"], 290)
        self.assertTrue(os.access(HOOK, os.X_OK))


if __name__ == "__main__":
    unittest.main()
