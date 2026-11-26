#!/usr/bin/env python3
"""settings.worker.json の sandbox.excludedCommands は codex-ro・neon-design-review・neon-polish・guestctl-ro・spo-ro（guestctl-ro の旧名）を、
settings.worker.verify.json はそれに加えて pg-sandboxed を sandbox の外で動かす。`codex-ro a b c; cat ~/.aws/...` のように後ろへ別のコマンドを繋いだり、引数に $(...) を
埋めたりすると、それまで外で動くおそれがあるので、入口の名前を含むコマンドは次の形に限る。
- codex-ro・neon-design-review・neon-polish・pg-sandboxed: シェルの記号を含まない引数だけ（環境変数を前に付けることもできない）
- guestctl-ro・spo-ro: URL・検索語・OData の $filter を渡すので引用符は許し、展開・繋ぎ・リダイレクト・glob に
  なる記号は引用符の外では許さない（' の中は何でも文字のまま。" の中は $ ` \\ ! を許さない）
"""

import json
import os
import re
import sys

BIN = os.path.normpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "bin"))
READERS = {name: os.path.join(BIN, name) for name in ("guestctl-ro", "spo-ro")}
ARG = r" [A-Za-z0-9_@%+=:,./-]+"
PLAIN_ENTRIES = {
    "codex-ro": (f"({ARG}){{3,4}}", "<作業ディレクトリ> <prompt.md> <out.md> [<session id>]（パスに空白や記号を含めない）"),
    "neon-design-review": (f"({ARG})+", "<画像のフォルダ> --kind business|lp [--product <product.md>]"
                                         "（画像と product.md は /tmp/claude-<uid> の中。パスに空白や記号を含めない）"),
    "neon-polish": (f"({ARG})+", "<file> [--diff] [--audience client|internal] [--doc-type <種類>]"
                                  "（file は /tmp/claude-<uid> の中。パスに空白や記号を含めない）"),
    "pg-sandboxed": (f" (init|start|stop|status)({ARG}){{1,2}}", "init|start|stop|status <データのフォルダ> [<ポート>]"
                                                                 "（フォルダは /tmp/claude-<uid> の中。パスに空白や記号を含めない）"),
}
PLAIN = re.compile(r"[A-Za-z0-9_@%+=:,./ -]")


def mentions(name, cmd):
    """名前を含むか。直後に / が続くもの（同じ名前の worktree・ブランチのフォルダ）は、入口として実行できないので数えない。"""
    return re.search(re.escape(name) + "(?!/)", cmd) is not None


def plain_args(rest):
    quote = None
    for ch in rest:
        if ch == "\n":
            return False
        if quote == "'":
            if ch == "'":
                quote = None
        elif quote == '"':
            if ch == '"':
                quote = None
            elif ch in "$`\\!":
                return False
        elif ch in "'\"":
            quote = ch
        elif not (PLAIN.fullmatch(ch) or ord(ch) > 127):
            return False
    return quote is None


def reader_allowed(cmd, path):
    return cmd.startswith(path + " ") and plain_args(cmd[len(path) + 1:])


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                             "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}, ensure_ascii=False))


def main():
    try:
        cmd = json.load(sys.stdin)["tool_input"]["command"].strip()
    except Exception:
        return 0
    for name, (rest, usage) in PLAIN_ENTRIES.items():
        path = os.path.join(BIN, name)
        if mentions(name, cmd) and not re.fullmatch(re.escape(path) + rest, cmd):
            deny(f"{name} は他のコマンドと繋がず、引数だけで 1 行で呼ぶ: {path} {usage}")
            return 0
    names = [name for name in READERS if mentions(name, cmd)]
    if names and not any(reader_allowed(cmd, path) for path in READERS.values()):
        deny(f"{names[0]} は他のコマンドと繋がず、1 行で呼ぶ: {READERS['guestctl-ro']} <サービス> <サブコマンド> <引数…>。"
             f"URL や検索語は ' で囲む（$ を含む URL も ' の中なら渡せる）。; & | < > $( ) ` * ? ~ と改行は使えない")
    return 0


if __name__ == "__main__":
    sys.exit(main())
