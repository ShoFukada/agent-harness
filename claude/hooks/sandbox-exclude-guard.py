#!/usr/bin/env python3
"""settings.worker.json の sandbox.excludedCommands は codex-ro・neon-design-review・guestctl-ro・spo-ro（guestctl-ro の旧名）を、
settings.worker.verify.json はそれに加えて pg-sandboxed を sandbox の外で動かす。`codex-ro a b c; cat ~/.aws/...` のように後ろへ別のコマンドを繋いだり、引数に $(...) を
埋めたりすると、それまで外で動くおそれがあるので、入口の名前を含むコマンドは次の形に限る。
- codex-ro・neon-design-review・pg-sandboxed: シェルの記号を含まない引数だけ（環境変数を前に付けることもできない）
- guestctl-ro・spo-ro: URL・検索語・OData の $filter を渡すので引用符は許し、展開・繋ぎ・リダイレクト・glob に
  なる記号は引用符の外では許さない（' の中は何でも文字のまま。" の中は $ ` \\ ! を許さない）
"""

import json
import os
import re
import sys

BIN = os.path.normpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "bin"))
CODEX_RO = os.path.join(BIN, "codex-ro")
READERS = {name: os.path.join(BIN, name) for name in ("guestctl-ro", "spo-ro")}
CODEX_RO_ALLOWED = re.compile(r"^" + re.escape(CODEX_RO) + r"( [A-Za-z0-9_@%+=:,./-]+){3,4}$")
NEON = os.path.join(BIN, "neon-design-review")
NEON_ALLOWED = re.compile(r"^" + re.escape(NEON) + r"( [A-Za-z0-9_@%+=:,./-]+)+$")
PG = os.path.join(BIN, "pg-sandboxed")
PG_ALLOWED = re.compile(r"^" + re.escape(PG) + r" (init|start|stop|status)( [A-Za-z0-9_@%+=:,./-]+){1,2}$")
PLAIN = re.compile(r"[A-Za-z0-9_@%+=:,./ -]")


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
    if "codex-ro" in cmd and not CODEX_RO_ALLOWED.match(cmd):
        deny(f"codex-ro は他のコマンドと繋がず、引数だけで 1 行で呼ぶ: "
             f"{CODEX_RO} <作業ディレクトリ> <prompt.md> <out.md> [<session id>]（パスに空白や記号を含めない）")
        return 0
    if "neon-design-review" in cmd and not NEON_ALLOWED.match(cmd):
        deny(f"neon-design-review は他のコマンドと繋がず、引数だけで 1 行で呼ぶ: "
             f"{NEON} <画像のフォルダ> --kind business|lp [--product <product.md>]（画像と product.md は /tmp/claude-<uid> の中。パスに空白や記号を含めない）")
        return 0
    if "pg-sandboxed" in cmd and not PG_ALLOWED.match(cmd):
        deny(f"pg-sandboxed は他のコマンドと繋がず、引数だけで 1 行で呼ぶ: "
             f"{PG} init|start|stop|status <データのフォルダ> [<ポート>]（フォルダは /tmp/claude-<uid> の中。パスに空白や記号を含めない）")
        return 0
    names = [name for name in READERS if name in cmd]
    if names and not any(reader_allowed(cmd, path) for path in READERS.values()):
        deny(f"{names[0]} は他のコマンドと繋がず、1 行で呼ぶ: {READERS['guestctl-ro']} <サービス> <サブコマンド> <引数…>。"
             f"URL や検索語は ' で囲む（$ を含む URL も ' の中なら渡せる）。; & | < > $( ) ` * ? ~ と改行は使えない")
    return 0


if __name__ == "__main__":
    sys.exit(main())
