"""agy_launch が環境を絞るので FAKE_* の変数は偽物に届かない。応答の種類は偽物と同じフォルダの mode ファイルで決める。"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import agy_launch  # noqa: E402

FAKE = r'''#!/usr/bin/env python3
import json, os, sys, time
here = os.path.dirname(os.path.realpath(__file__))
def read(name, default):
    try:
        with open(os.path.join(here, name), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return default
stdin = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "env": dict(os.environ), "stdin": stdin},
                       ensure_ascii=False) + "\n")
mode = read("mode", "ok").strip()
if mode == "fail":
    sys.stderr.write("auth expired\n")
    sys.exit(3)
if mode == "hang":
    sys.stderr.write("still thinking\n")
    sys.stderr.flush()
    time.sleep(30)
status = "SUCCESS" if mode == "ok" else "ERROR"
print(json.dumps({"event": "progress"}))
print(json.dumps({"event": "result", "result": {"status": status, "response": read("response", "Neon: 前提が違う")}},
                 ensure_ascii=False))
'''

# Claude Code（Orca の中・sandbox の中）から動かしたときに受け継がれる環境の見本
POLLUTED = {
    "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_SESSION_ID": "s-1",
    "CLAUDE_CODE_EXECPATH": "/x/claude", "CLAUDE_CODE_TMPDIR": "/tmp/claude-501",
    "CLAUDE_CONFIG_DIR": "/Users/u/Library/Application Support/orca/claude-profiles/p/home",
    "CLAUDE_PLUGIN_DATA": "/x", "CLAUDE_PID": "1", "CLAUDE_EFFORT": "high", "CLAUDE_AGENT_SDK_VERSION": "1",
    "ANTHROPIC_API_KEY": "k", "ANTHROPIC_BASE_URL": "https://example.invalid",
    "AI_AGENT": "claude-code_2-1-321_agent",
    "ORCA_AGENT_SESSION_ID": "o", "ORCA_AGENT_HOOK_TOKEN": "t", "ORCA_PANE_KEY": "pane", "ORCA_AGENT_PANE": "1",
    "ORCA_CLAUDE_CONFIG_DIR": "/x",
    "HTTPS_PROXY": "http://srt.user:pass@127.0.0.1:1", "HTTP_PROXY": "http://srt.user:pass@127.0.0.1:1",
    "TMPDIR": "/tmp/claude-501",
    "AGY_ACCOUNT": "personal", "LANG": "ja_JP.UTF-8", "TERM": "xterm-256color",
}
FORBIDDEN = re.compile(r"claude|anthropic|サブエージェント|subagent|エージェント|opus|sonnet|fable", re.I)
# リポジトリの構造上避けられないパス（~/.config/nix-darwin/claude/skills/… など）と、worker の denyRead の鍵の置き場
ALLOWED = [re.compile(r"[\w~./-]*/claude/(?:skills|roles|bin|hooks)\b[\w./-]*"),
           re.compile(r"read_file\([^)]*/\.config/anthropic\)")]


def install(d, mode="ok", response=None):
    bindir = os.path.join(d, "bin")
    os.makedirs(bindir, exist_ok=True)
    path = os.path.join(bindir, "agy")
    with open(path, "w") as f:
        f.write(FAKE)
    os.chmod(path, 0o755)
    set_mode(bindir, mode, response)
    return bindir


def set_mode(bindir, mode, response=None):
    with open(os.path.join(bindir, "mode"), "w") as f:
        f.write(mode)
    if response is not None:
        with open(os.path.join(bindir, "response"), "w", encoding="utf-8") as f:
            f.write(response)


def calls(bindir):
    try:
        with open(os.path.join(bindir, "calls.jsonl"), encoding="utf-8") as f:
            return [json.loads(line) for line in f]
    except FileNotFoundError:
        return []


def polluted_env(bindir, **extra):
    env = dict(os.environ, **POLLUTED)
    env["PATH"] = os.pathsep.join([bindir, "/Users/u/.claude/plugins/x/bin", os.environ.get("PATH", "")])
    env.update(extra)
    return env


def leaks(call, fixtures=()):
    """fixtures はテストが置いた一時フォルダ（sandbox の中で /tmp/claude-<uid> にある）。"""
    out = []
    for k, v in call["env"].items():
        if agy_launch.TELLTALE.search(k + "=" + v):
            out.append(f"env {k}={v}")
        if k.startswith(("ORCA_", "AI_AGENT", "CLAUDE")) or k.upper() in ("HTTP_PROXY", "HTTPS_PROXY"):
            out.append(f"env {k}")
    for label, text in [("argv", a) for a in call["argv"]] + [("stdin", call["stdin"])]:
        for f in fixtures:
            text = text.replace(f, "<fixture>")
        for pat in ALLOWED:
            text = pat.sub("<allowed>", text)
        out += [f"{label}: …{text[max(0, m.start() - 30):m.end() + 30]}…" for m in FORBIDDEN.finditer(text)]
    return out
