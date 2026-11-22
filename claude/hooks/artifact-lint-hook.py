#!/usr/bin/env python3
"""PostToolUse(Write|Edit) から artifact-lint.py と page_outline（HTML）・client_leak（HTML と Markdown）を呼び、指摘を Claude に返す。

publish 後ではなくファイル書き込み直後に鳴らす: PreToolUse(Artifact) の
additionalContext はツール結果の隣に挿入される仕様のため、Artifact に付けると
壊れたまま公開されてから指摘が届く。
"""

import json
import os
import subprocess
import sys

LINTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifact-lint.py")
# 壊れ方によっては指摘がセレクタの数だけ出るので、会話に入る量はここで頭打ちにする
# (linter 単体で叩いたときは全文が要るため、切るのは注入側だけ)
MAX_CONTEXT_BYTES = 8 * 1024
MAX_PAGE_BYTES = 4 * 1024 * 1024

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import client_leak  # noqa: E402
import page_outline  # noqa: E402


def lint(path):
    try:
        proc = subprocess.run(
            [sys.executable, LINTER, path],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return ""

    out = proc.stdout.strip()
    if proc.returncode != 1 or not out:
        return ""

    encoded = out.encode()
    if len(encoded) > MAX_CONTEXT_BYTES:
        head = encoded[:MAX_CONTEXT_BYTES].decode(errors="ignore").rsplit("\n", 1)[0]
        out = head + "\n\n  （指摘が多すぎるため以降は省略。上から直すと残りも消えることが多い）"
    return out


def read_page(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read(MAX_PAGE_BYTES)
    except OSError:
        return None


def notices(path, html):
    text = read_page(path)
    if text is None:
        return []
    out = []
    if html:
        found = page_outline.problems(text)
        out.append(page_outline.notice(path, found) if found else "")
    found = client_leak.problems(text, markdown=not html)
    out.append(client_leak.notice(path, found) if found else "")
    return out


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    tool_input = payload.get("tool_input") or {}
    path = tool_input.get("file_path")
    if not isinstance(path, str):
        return
    html = path.lower().endswith((".html", ".htm"))
    if not html and not path.lower().endswith((".md", ".mdx")):
        return

    out = "\n\n".join(x for x in [lint(path) if html else "", *notices(path, html)] if x)
    if not out:
        return

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": out,
            }
        },
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
