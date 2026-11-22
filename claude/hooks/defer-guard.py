#!/usr/bin/env python3
"""窓口・担当・worker が、自分の都合での先送り（「12 月に進める」「落ち着いてから」「別 PR で」）で終えるのを 1 回差し戻す（R193）。

  defer-guard.py < Stop / PreToolUse(Bash) の入力 JSON
  defer-guard.py --text "<文>"   当たりを出して 1 で終わる（無ければ 0）。帳簿の書く道具が同じ言い回しで断るための入口

決まりの本文は agents/common.md の「判断」の「聞かずにやる」。待ってよいのは外の理由（人の返事・承認、
日付が来ないと取れないデータや起きない出来事、利用枠）があるときだけ。
- Stop: 最後の発言に先送りの言い回しがあれば止める。stop_hook_active なら通す（誤検知は一言書いて終えれば抜ける）
- PreToolUse(Bash): `orca orchestration send --type worker_done` の本文（--body・--body-file）に当たれば、
  送る前に 1 回だけ断る。送ったあとの worker_done は取り消せないため。同じ本文で打ち直せば通す（件名と引数は見ない）
引用（「」・『』・``・コードの囲み・> の行）の中は、決まりを説明する文が当たらないよう見ない。
日付の決まったもの（「12/4 に通知を確かめる」「12 月 4 日にリリースする」）と、確かめる・見るだけの予定は拾わない。
"""

import hashlib
import json
import os
import re
import shlex
import sys

QUOTED = re.compile(r"(?s:```.*?```)|`[^`\n]*`|「[^」]*」|『[^』]*』|“[^”]*”|^[ \t]*>[^\n]*", re.M)
ACT = r"(?:進め|やる|やり|着手|対応|回す|回し|再開|整理|取りかか|取り掛か|手を付け|片付け|直す|直し|入れ)"
# 当たりから節の終わりまでが完了の形なら、先送りでなく報告なので外す。
# 「別 PR で対応することにしました」は先送りを決めた報告なので、予定・方針の語があれば外さない
DONE_FORM = re.compile(r"(?:した|ました|めた|った|けた|れた|えた|いた|んだ|済み?|ずみ|ている|ていた|てある)$")
PLANNED = re.compile(r"ことに|予定|つもり|方針")
# 当たりの直後の打ち消し（例「後回しにせず」）は外す。節の終わりまで見ると
# 「別 PR で対応するので今は触りません」の先送りまで外れるので、直後の数文字だけを見る
DENIED = re.compile(r"^[^。、\n]{0,4}?(?:ない|せず|さず|ず(?:[。、\s]|$)|ません|不要)")
PATTERNS = [
    re.compile(r"落ち着(?:いて|いた)(?:から|ら|あと)"),
    re.compile(r"(?:別|次|後続)の?\s?PR\s?(?:で|に|へ|として)"),
    re.compile(r"申し送り(?:に|へ|を|として)[^。\n]{0,4}?(?:残|書|回|入れ|置)"),
    # 「届いたあとで入れる」のような出来事のあとの手順は拾わない
    re.compile(r"(?<![ただ])(?:後|あと|のち)(?:で|ほど)[^。\n]{0,12}?" + ACT),
    re.compile(r"後回し"),
    re.compile(r"次回(?:に|へ|以降)?[^。\n]{0,6}?" + ACT),
    re.compile(r"TODO\s?(?:として|を|に)?\s?(?:残|置)"),
    re.compile(r"様子を見(?:る|て|ます|ましょう)"),
    re.compile(r"(?:余裕|手|時間)が(?:でき|空い|あい)(?:たら|てから)|一段落(?:したら|してから)|区切りが(?:つい|付い)(?:たら|てから)"),
    # 月・週だけの日付で寝かせる。日まで決まった日付（12 月 4 日・12/4）は外の出来事として拾わない
    re.compile(r"(?:\d+|来|再来|翌)\s?(?:月|週)(?!\s?\d+\s?日)(?:に|から|以降|ごろ|頃|中に|明け)?[^。\n\d]{0,10}?" + ACT),
    re.compile(r"別の機会|いずれ[^。\n]{0,8}?" + ACT + r"|今後の課題|追って対応"),
    re.compile(r"ほかの作業と(?:ぶつかる|重なる|衝突する)ので"),
]

RULE = ("今やれる作業は今やる（R193。agents/common.md「判断」の「聞かずにやる」）。待ってよいのは外の理由"
        "（人の返事・承認、日付が来ないと取れないデータや起きない出来事、利用枠）があるときだけで、"
        "落ち着いてから・N 月に・別 PR で・申し送りのような自分や窓口・担当の都合では先送りしない。"
        "ぶつかるなら順番を決めて今の枠に入れる")


def hit(text):
    """先送りの言い回しの最初の当たりを、前後を少し付けて返す。無ければ None。"""
    text = QUOTED.sub("", text or "")
    for pat in PATTERNS:
        for m in pat.finditer(text):
            after = text[m.end():m.end() + 40]
            clause = re.split(r"[。、\n]", after, maxsplit=1)[0].rstrip()
            if DENIED.match(after) or (DONE_FORM.search(text[m.start():m.end()] + clause) and not PLANNED.search(clause)):
                continue
            return text[max(0, m.start() - 15):m.end()].replace("\n", " ").strip()
    return None


def worker_done_body(command, cwd):
    """`orca orchestration send --type worker_done` の本文（--body と --body-file の中身）。worker_done の送信でなければ None。"""
    if "orchestration" not in command or "worker_done" not in command:
        return None
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return None
    # `gh pr create --body ... && orca orchestration send ...` の前の本文を混ぜないよう、送信のコマンドの引数だけを見る
    segments, cur = [], []
    for t in tokens:
        if t and set(t) <= set("&|;"):
            segments.append(cur)
            cur = []
        else:
            cur.append(t)
    segments.append(cur)
    texts = []
    for args in segments:
        if "orchestration" in args and "send" in args:
            texts += send_body(args, cwd)
    return "\n".join(texts) if texts else None


def send_body(args, cwd):
    opts, i = {}, 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and "=" in a:
            k, v = a.split("=", 1)
            opts.setdefault(k, []).append(v)
        elif a.startswith("--") and i + 1 < len(args):
            opts.setdefault(a, []).append(args[i + 1])
            i += 1
        i += 1
    if "worker_done" not in opts.get("--type", []):
        return []
    texts = list(opts.get("--body", []))
    for path in opts.get("--body-file", []):
        path = os.path.expanduser(os.path.expandvars(path))
        try:
            with open(os.path.join(cwd or "", path), encoding="utf-8") as fh:
                texts.append(fh.read())
        except OSError:
            pass
    return texts


def pre_tool_use(data):
    body = worker_done_body((data.get("tool_input") or {}).get("command") or "", data.get("cwd"))
    found = hit(body) if body else None
    if not found:
        return None
    seen_dir = os.path.join(os.environ.get("TMPDIR") or "/tmp", "claude-defer-guard")
    seen = os.path.join(seen_dir, "%s.txt" % re.sub(r"[^\w-]", "_", data.get("session_id") or "unknown"))
    key = hashlib.sha1(body.encode("utf-8")).hexdigest()
    try:
        with open(seen, encoding="utf-8") as fh:
            if key in fh.read().split():
                return None
    except OSError:
        pass
    try:
        os.makedirs(seen_dir, exist_ok=True)
        with open(seen, "a", encoding="utf-8") as fh:
            fh.write(key + "\n")
    except OSError:
        return None  # 記録できないと打ち直しでも通らず、worker_done を送れなくなる
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "worker_done の本文に先送りの言い回しがある: 「%s」。%s。今やれるなら済ませてから送る。外の理由で待つなら、"
                                    "何を待ち、来たら何をするかを本文に書いて送る。誤検知なら同じコマンドをもう一度打てば通る" % (found, RULE),
    }}


def stop(data):
    if data.get("stop_hook_active"):
        return None
    found = hit(data.get("last_assistant_message") or "")
    if not found:
        return None
    return {"decision": "block",
            "reason": "最後の発言に先送りの言い回しがある: 「%s」。%s。今やれるなら今やってから終える。外の理由で待つなら、"
                      "何を待ち、来たら何をするかを一言書いて終える。誤検知ならそう一言書いて終える" % (found, RULE)}


def main():
    if sys.argv[1:2] == ["--text"]:
        found = hit(" ".join(sys.argv[2:]))
        if found:
            print(found)
        sys.exit(1 if found else 0)
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    event = data.get("hook_event_name")
    out = stop(data) if event == "Stop" else pre_tool_use(data) if event == "PreToolUse" else None
    if out:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
