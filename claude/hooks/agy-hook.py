#!/usr/bin/env python3
"""agy（Antigravity CLI）の hook から、Claude Code と同じ hook を動かす入口（判断の記録 R246）。

  agy-hook.py <SessionStart|PreInvocation|PreToolUse|PostToolUse|Stop>   < agy の hook の入力 JSON

agy からは gemini/plugins/harness/hooks.json が呼ぶ。どの hook を動かすかはここに持たない。Claude の設定
（$CLAUDE_CONFIG_DIR か ~/.claude の settings.json と、cwd の .claude/settings.json・settings.local.json）の hooks と、
有効なプラグインの hooks.json をそのまま読み、イベントと matcher に合うものを Claude Code と同じく並行に動かす。
Claude に hook を足せば agy でも同じものが動く。agy 専用の検査は書かない（R181）。Orca が書いた hook（状態表示）は
呼ばない。Orca は agy 用のものを ~/.gemini/config/hooks.json に別に書いている。

入力は Claude の形に直して渡し、返事は agy の形に直して返す。
- SessionStart → SessionStart（source は startup）。追加の文脈（stdout の文か additionalContext）は injectSteps の systemMessage
- PreInvocation → 会話記録のユーザー入力の行ごとに 1 回だけ UserPromptSubmit（prompt はその行の本文）。PreInvocation は
  1 回の発言でモデルを呼ぶたびに来るので、毎回渡すと操縦席の発言の記録に同じ依頼が別の番号で並ぶ。会話 id と行の
  step_index で見分け、本文の一致では見分けない（同じ文を次のターンで送ったときに落ちる）。止められたら terminate
- PreToolUse・PostToolUse → 同じ名前。道具名と引数は TOOLS で直し、call_mcp_tool は mcp__<サーバー>__<操作> に開いてから
  matcher を当てる（Slack の送信も外側は call_mcp_tool の 1 つの名前で来るので、開かないと送る文面の書式の検査を通らない）。
  deny と exit 2 は deny、ask は force_ask（agy の ask は保存済みの「常に許可」を使うので、課金の許可が 2 回目から聞かれない）、
  updatedInput は agy の引数の名前に戻して overwrite。何も言わない hook だけなら何も出さない（Orca の agy 用の hook と同じ）
- PreToolUse の追加の文脈と知らせ、PostToolUse の返事は、その場では agy のモデルに返せないので、控えて次の
  PreInvocation で systemMessage にして返す。道具の後には必ずモデルの呼び出しが来るので、書いた直後の検査の指摘も
  同じターンのうちに届く。前のターンのモデル向けの控えは新しい発言に持ち越さない。失敗した道具（error が空でない）には
  PostToolUse を呼ばない（Claude Code も失敗した道具には呼ばない）
- Stop → Stop。agy の Stop には最後の返答が無いので、会話記録の最後の返答を last_assistant_message に入れる。差し戻した
  （continue を返した）かを会話ごとに控え、次の Stop の stop_hook_active にする。そのターンに書き込めた write_file・edit_file
  を turn_writes（{"tool_input": Claude の形の入力, "original": 書き込む前の本文}の一覧）にして渡す（ja-review.py が
  transcript の代わりに読む。agy の会話記録は Claude の形でないため）。書き込む前の本文は PreToolUse で読んで控える
  （無いと HEAD との差分で決まり、利用者が先に直した未 commit の行まで書き直しの対象になる）。Claude の Stop に当たる
  終わり方（NO_TOOL_CALL）のときだけ呼ぶ
- 利用者向けの知らせ（systemMessage）は、モデルに見せない user_markdown にして次の PreInvocation で出す

permission_mode は default を渡す。ask は毎回聞く force_ask で返すので、許可の画面が出る前提の hook（llm-call-guard）が
そのまま動く。transcript_path には agy の会話記録を渡す（Claude の形を前提に読む hook は何も拾わない）。
会話ごとの控えは $AGY_HOOK_STATE（無ければ $TMPDIR/agy-hook）の <会話 id>.json。agy は hook を 1 つずつ順に呼ぶので
ロックは持たない。動かせなかった hook（timeout・exit 0 と 2 以外）は $TMPDIR/agy-hook.log に 1 行ずつ書く。
hooks.json の timeout は、そのイベントで最も長い Claude の hook に合わせる（PreToolUse は ja-review pre の 290 秒、
Stop は codex プラグインの 900 秒）。agy に打ち切られると、そのイベントの返事がすべて落ちるため。
"""

import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

ORCA_MARKS = (".orca/agent-hooks", "ORCA_AGENT_HOOK")
DEFAULT_TIMEOUT = 600  # Claude Code の command hook の既定
# agy の道具名 → (Claude の道具名, {agy の引数: Claude の引数})。名前は agy 1.5.3 が hook に送る実物で、
# 同梱の文書にある write_to_file・replace_file_content とは違う
TOOLS = {
    "run_command": ("Bash", {"CommandLine": "command"}),
    "read_file": ("Read", {"Path": "file_path"}),
    "write_file": ("Write", {"Path": "file_path", "Content": "content"}),
    "edit_file": ("Edit", {"Path": "file_path", "Target": "old_string", "Replacement": "new_string"}),
}
WRITE_TOOLS = ("write_file", "edit_file")
STOP_REASONS = ("", "NO_TOOL_CALL")
MAX_ORIGINAL = 1024 * 1024


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return default
    return doc if isinstance(doc, type(default)) else default


def log(event, what, cause):
    try:
        with open(os.path.join(tempfile.gettempdir(), "agy-hook.log"), "a", encoding="utf-8") as f:
            f.write("%s %s %s: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), event, what[:120], cause[:200]))
    except OSError:
        pass


# ---------- Claude の設定 ----------

def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def entries(hooks, event, plugin=None):
    out = []
    for group in (hooks.get(event) if isinstance(hooks, dict) else None) or []:
        if not isinstance(group, dict):
            continue
        for h in group.get("hooks") or []:
            command = h.get("command") if isinstance(h, dict) else None
            if not isinstance(command, str) or h.get("type", "command") != "command" \
                    or any(mark in command for mark in ORCA_MARKS):
                continue
            timeout = h.get("timeout")
            out.append({"matcher": group.get("matcher"), "command": command, "async": h.get("async") is True,
                        "timeout": timeout if isinstance(timeout, (int, float)) and timeout > 0 else DEFAULT_TIMEOUT,
                        "plugin": plugin})
    return out


def install_path(rows):
    rows = [r for r in rows or [] if isinstance(r, dict) and isinstance(r.get("installPath"), str)]
    rows.sort(key=lambda r: r.get("scope") != "user")
    return next((r["installPath"] for r in rows if os.path.isdir(r["installPath"])), None)


def plugin_hook_docs(root):
    """プラグインの hooks/hooks.json と、plugin.json の hooks（パスかその一覧か中身）。"""
    files, docs = [os.path.join(root, "hooks", "hooks.json")], []
    extra = read_json(os.path.join(root, ".claude-plugin", "plugin.json"), {}).get("hooks")
    for item in extra if isinstance(extra, list) else [extra]:
        if isinstance(item, str):
            files.append(os.path.normpath(os.path.join(root, item)))
        elif isinstance(item, dict):
            docs.append(item)
    seen = set()
    for f in files:
        if os.path.realpath(f) not in seen and os.path.isfile(f):
            seen.add(os.path.realpath(f))
            docs.append(read_json(f, {}))
    return [d["hooks"] if isinstance(d.get("hooks"), dict) else d for d in docs]


def configured(event, cwd):
    """event の hook を、Claude Code が読む順（ユーザー・プロジェクト・ローカルの設定、有効なプラグイン）に並べる。"""
    files = [os.path.join(config_dir(), "settings.json")]
    if cwd:
        files += [os.path.join(cwd, ".claude", name) for name in ("settings.json", "settings.local.json")]
    hooks, enabled = [], {}
    for path in files:
        settings = read_json(path, {})
        if settings.get("disableAllHooks") is True:
            return []
        hooks += entries(settings.get("hooks"), event)
        if isinstance(settings.get("enabledPlugins"), dict):
            enabled.update(settings["enabledPlugins"])
    installed = read_json(os.path.join(config_dir(), "plugins", "installed_plugins.json"), {}).get("plugins") or {}
    for pid, on in enabled.items():
        root = install_path(installed.get(pid)) if on is True else None
        if not root:
            continue
        plugin = {"root": root, "data": os.path.join(config_dir(), "plugins", "data", re.sub(r"[^A-Za-z0-9_-]", "-", pid))}
        for doc in plugin_hook_docs(root):
            hooks += entries(doc, event, plugin)
    return hooks


def matches(matcher, target):
    if target is None or matcher in (None, "", "*"):
        return True
    try:
        return re.fullmatch(matcher, target) is not None
    except re.error:
        return matcher == target


# ---------- 動かす ----------

def run_one(hook, data, cwd, event):
    env = dict(os.environ, CLAUDE_PROJECT_DIR=cwd)
    if hook["plugin"]:
        env.update(CLAUDE_PLUGIN_ROOT=hook["plugin"]["root"], CLAUDE_PLUGIN_DATA=hook["plugin"]["data"])
    # 待たない（async）hook の出力は読まないので捨てる。パイプに溜まると hook が書き込みで止まる
    out = subprocess.DEVNULL if hook["async"] else subprocess.PIPE
    try:
        p = subprocess.Popen(["/bin/bash", "-c", hook["command"]], stdin=subprocess.PIPE, stdout=out, stderr=out,
                             cwd=cwd if os.path.isdir(cwd) else None, env=env,
                             text=True, encoding="utf-8", errors="replace", start_new_session=True)
    except OSError as e:
        log(event, hook["command"], str(e))
        return None, "", ""
    if hook["async"]:
        try:
            p.stdin.write(data)
            p.stdin.close()
        except OSError:
            pass
        return None, "", ""
    try:
        out, err = p.communicate(data, timeout=hook["timeout"])
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        p.communicate()
        log(event, hook["command"], "timeout %ss" % hook["timeout"])
        return None, "", ""
    if p.returncode not in (0, 2):
        log(event, hook["command"], "exit %s %s" % (p.returncode, err.strip()))
    return p.returncode, out, err


def outcome(event, results):
    """Claude の hook の返事をまとめる。deny・ask・block は理由の一覧、context はモデル向け、notice は利用者向け。"""
    o = {"deny": [], "ask": [], "allow": False, "updated": None, "block": [], "context": [], "notice": []}
    for code, out, err in results:
        if code == 2:
            o["deny" if event == "PreToolUse" else "block"].append(err.strip() or "hook が止めた（exit 2）")
            continue
        if code != 0:
            continue
        text = out.strip()
        try:
            doc = json.loads(text) if text.startswith("{") else None
        except ValueError:
            doc = None
        if not isinstance(doc, dict):
            if text and event in ("SessionStart", "UserPromptSubmit"):
                o["context"].append(text)
            continue
        if isinstance(doc.get("systemMessage"), str) and doc["systemMessage"].strip():
            o["notice"].append(doc["systemMessage"].strip())
        reason = doc.get("reason") if isinstance(doc.get("reason"), str) else ""
        if doc.get("decision") == "block":
            o["deny" if event == "PreToolUse" else "block"].append(reason or "hook が止めた")
        elif doc.get("decision") == "approve" and event == "PreToolUse":
            o["allow"] = True
        spec = doc.get("hookSpecificOutput")
        if not isinstance(spec, dict):
            continue
        decision = spec.get("permissionDecision")
        why = spec.get("permissionDecisionReason") if isinstance(spec.get("permissionDecisionReason"), str) else ""
        if decision in ("deny", "ask"):
            o[decision].append(why or "hook が%s" % ("止めた" if decision == "deny" else "確認を求めた"))
        elif decision == "allow":
            o["allow"] = True
        if isinstance(spec.get("updatedInput"), dict):
            o["updated"] = spec["updatedInput"]
        if isinstance(spec.get("additionalContext"), str) and spec["additionalContext"].strip():
            o["context"].append(spec["additionalContext"].strip())
    return o


def run_event(event, payload, target=None):
    # 同じコマンドは 1 回だけ動かす（Claude Code と同じ）。除くのは matcher を当てた後: 同じ hook を別の matcher で
    # 2 回登録している（llm-call-guard の Write|Edit|MultiEdit と Bash）ので、先に除くと後の登録が消える
    hooks, seen = [], set()
    for h in configured(event, payload.get("cwd") or ""):
        key = (h["command"], (h["plugin"] or {}).get("root"))
        if matches(h["matcher"], target) and key not in seen:
            seen.add(key)
            hooks.append(h)
    data = json.dumps(payload, ensure_ascii=False)
    cwd = payload.get("cwd") or ""
    with ThreadPoolExecutor(max_workers=max(1, len(hooks))) as pool:
        results = list(pool.map(lambda h: run_one(h, data, cwd, event), hooks))
    return outcome(event, results)


# ---------- agy の入力 ----------

def claude_tool(call):
    """agy の toolCall を Claude の (tool_name, tool_input) にする。知らない道具は名前も引数もそのまま。"""
    name, args = call.get("name") or "", call.get("args") or {}
    if name == "call_mcp_tool":
        arguments = args.get("Arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except ValueError:
                arguments = None
        return "mcp__%s__%s" % (args.get("ServerName"), args.get("ToolName")), \
            dict(arguments) if isinstance(arguments, dict) else {}
    if name in TOOLS:
        tool, fields = TOOLS[name]
        return tool, {c: args[a] for a, c in fields.items() if a in args}
    return name, dict(args)


def agy_overwrite(call, updated):
    """Claude の updatedInput を、agy の引数のうち変わったものだけにする。"""
    name, args = call.get("name") or "", call.get("args") or {}
    if name == "call_mcp_tool":
        return {"Arguments": updated} if updated != claude_tool(call)[1] else {}
    back = {c: a for a, c in TOOLS[name][1].items()} if name in TOOLS else {k: k for k in updated}
    return {back[k]: v for k, v in updated.items() if k in back and args.get(back[k]) != v}


def transcript_of(inp):
    """agy の会話記録。入力の transcriptPath は transcript_full.jsonl（会話のフォルダのこともあるので両方を見る）。"""
    path = inp.get("transcriptPath") or ""
    if not isinstance(path, str) or not path:
        return ""
    logs = os.path.join(path, ".system_generated", "logs")
    for c in (path, os.path.join(os.path.dirname(path), "transcript.jsonl"),
              os.path.join(logs, "transcript_full.jsonl"), os.path.join(logs, "transcript.jsonl")):
        if os.path.isfile(c):
            return c
    return ""


def rows_of(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    out.append(row)
    except OSError:
        pass
    return out


def last_user_input(rows):
    return next((r for r in reversed(rows) if r.get("type") == "USER_INPUT"), None)


def prompt_text(content):
    """ユーザー入力の行の本文。agy が足す ADDITIONAL_METADATA などを除いた USER_REQUEST の中身。"""
    m = re.search(r"<USER_REQUEST>\n?(.*?)\n?</USER_REQUEST>", content or "", re.S)
    return m.group(1) if m else (content or "")


def last_reply(rows):
    """最後のユーザー入力より後の、最後のモデルの返答の本文。"""
    reply = ""
    for r in rows:
        if r.get("type") == "USER_INPUT":
            reply = ""
        elif r.get("type") == "PLANNER_RESPONSE" and r.get("source") == "MODEL" \
                and isinstance(r.get("content"), str) and r["content"].strip():
            reply = r["content"]
    return reply


def original_text(path):
    """書き込む前の本文。新しいファイルは ""、読めない・大きすぎるもの（ja-review が見ない 1 MB 超）は None。"""
    if not isinstance(path, str) or not path:
        return None
    if not os.path.lexists(path):
        return ""
    try:
        # O_NONBLOCK と普通のファイルかの確かめ: FIFO や /dev/zero を書き込み先にされても、判定の前で止まらない
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            return None
        data = f.read(MAX_ORIGINAL + 1)
    if len(data) > MAX_ORIGINAL:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def common(inp, event):
    paths = inp.get("workspacePaths") or []
    cwd = paths[0] if paths and isinstance(paths[0], str) else ""
    return {"session_id": inp.get("conversationId") or "", "transcript_path": transcript_of(inp), "cwd": cwd,
            "hook_event_name": event, "permission_mode": "default"}


# ---------- 会話ごとの控え ----------

def state_path(conversation):
    root = os.environ.get("AGY_HOOK_STATE") or os.path.join(tempfile.gettempdir(), "agy-hook")
    return os.path.join(root, re.sub(r"[^A-Za-z0-9_-]", "_", conversation or "unknown") + ".json")


def load_state(conversation):
    return read_json(state_path(conversation), {})


def save_state(conversation, state):
    path = state_path(conversation)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, path)


def keep_for_later(conversation, o, model):
    state = load_state(conversation)
    texts = (o["context"] + o["block"]) if model else []
    state["pending"] = (state.get("pending") or []) + [{"to": "model", "text": t} for t in texts] \
        + [{"to": "user", "text": t} for t in o["notice"]]
    save_state(conversation, state)


# ---------- agy の返事 ----------

def inject(context, notice):
    steps = [{"systemMessage": {"systemMessage": "\n\n".join(context)}}] if context else []
    steps += [{"systemMessage": {"systemMessage": "", "metadata": {"user_markdown": t}}} for t in notice]
    return {"injectSteps": steps} if steps else {}


def on_session_start(inp):
    o = run_event("SessionStart", dict(common(inp, "SessionStart"), source="startup"), target="startup")
    return inject(o["context"], o["notice"])


def on_pre_invocation(inp):
    conversation = inp.get("conversationId") or ""
    base = common(inp, "UserPromptSubmit")
    state = load_state(conversation)
    context, notice = [], []
    user = last_user_input(rows_of(base["transcript_path"]))
    if user is not None and user.get("step_index") != state.get("prompt_step"):
        # 新しい発言。hook より先に控える（hook が長引いて agy に打ち切られても、次の呼び出しで同じ発言を二度渡さない）
        # 前のターンのモデル向けの指摘は持ち越さない（中断されたターンの指摘が別の依頼に入る）。利用者向けの知らせは出す
        state = {"prompt_step": user.get("step_index"),
                 "pending": [p for p in state.get("pending") or [] if p.get("to") == "user"]}
        save_state(conversation, state)
        o = run_event("UserPromptSubmit", dict(base, prompt=prompt_text(user.get("content"))))
        if o["block"]:
            return {"injectSteps": [{"errorMessage": {"userMessage": "\n\n".join(o["block"])}}],
                    "terminationBehavior": "terminate"}
        context, notice = o["context"], o["notice"]
        state = load_state(conversation)
    pending = state.pop("pending", None) or []
    if pending:
        save_state(conversation, state)
    return inject([p["text"] for p in pending if p.get("to") == "model"] + context,
                  [p["text"] for p in pending if p.get("to") == "user"] + notice)


def tool_payload(inp, event):
    call = inp.get("toolCall") or {}
    name, tool_input = claude_tool(call)
    payload = dict(common(inp, event), tool_name=name, tool_input=tool_input, tool_use_id="agy-%s" % inp.get("stepIdx", ""))
    return call, payload


def on_pre_tool(inp):
    conversation = inp.get("conversationId") or ""
    call, payload = tool_payload(inp, "PreToolUse")
    before = original_text(payload["tool_input"].get("file_path")) if call.get("name") in WRITE_TOOLS else None
    o = run_event("PreToolUse", payload, target=payload["tool_name"])
    try:
        # 控えを書けなくても（一時フォルダが一杯など）、拒否と確認の判定は返す
        if call.get("name") in WRITE_TOOLS:
            state = load_state(conversation)
            state.setdefault("before", {})[str(inp.get("stepIdx", ""))] = before
            save_state(conversation, state)
        keep_for_later(conversation, o, model=True)
    except OSError as e:
        log("PreToolUse", "agy-hook", "控えを書けない: %s" % e)
    if o["deny"]:
        return {"decision": "deny", "reason": "\n\n".join(o["deny"])}
    if o["ask"]:
        return {"decision": "force_ask", "reason": "\n\n".join(o["ask"])}
    overwrite = agy_overwrite(call, o["updated"]) if o["updated"] is not None else {}
    if overwrite:
        return {"decision": "allow" if o["allow"] else "ask", "overwrite": overwrite}
    return {"decision": "allow"} if o["allow"] else None


def on_post_tool(inp):
    if inp.get("error"):
        return {}
    conversation = inp.get("conversationId") or ""
    call, payload = tool_payload(inp, "PostToolUse")
    response = {}
    if call.get("name") in WRITE_TOOLS and payload["tool_input"].get("file_path"):
        state = load_state(conversation)
        before = (state.get("before") or {}).pop(str(inp.get("stepIdx", "")), None)
        state["writes"] = (state.get("writes") or []) + [{"tool_input": payload["tool_input"], "original": before}]
        save_state(conversation, state)
        if before is not None:
            # 書いた直後の hook（ja-review post）も、変えた行を前の本文から決められるように Claude の toolUseResult の形で渡す
            response = {"originalFile": before}
    o = run_event("PostToolUse", dict(payload, tool_response=response), target=payload["tool_name"])
    keep_for_later(conversation, o, model=True)
    return {}


def on_stop(inp):
    if (inp.get("terminationReason") or "") not in STOP_REASONS:
        return {"decision": ""}
    conversation = inp.get("conversationId") or ""
    base = common(inp, "Stop")
    state = load_state(conversation)
    o = run_event("Stop", dict(base, stop_hook_active=bool(state.get("continued")),
                               last_assistant_message=last_reply(rows_of(base["transcript_path"])),
                               turn_writes=state.get("writes") or []))
    state = load_state(conversation)
    state["continued"] = bool(o["block"])
    save_state(conversation, state)
    keep_for_later(conversation, o, model=False)
    if o["block"]:
        return {"decision": "continue", "reason": "\n\n".join(o["block"])}
    return {"decision": ""}


HANDLERS = {"SessionStart": on_session_start, "PreInvocation": on_pre_invocation, "PreToolUse": on_pre_tool,
            "PostToolUse": on_post_tool, "Stop": on_stop}


def main(argv):
    handler = HANDLERS.get(argv[0] if argv else "")
    try:
        inp = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        inp = {}
    if handler is None or not isinstance(inp, dict):
        print("{}")
        return 0
    try:
        out = handler(inp)
    except Exception as e:  # hook の入口が落ちても agy の作業は止めない（Claude Code の hook の失敗と同じ扱い）
        log(argv[0], "agy-hook", "%s: %s" % (type(e).__name__, e))
        out = {"decision": ""} if argv[0] == "Stop" else (None if argv[0] == "PreToolUse" else {})
    if out is not None:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
