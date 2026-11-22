#!/usr/bin/env python3
"""worker の Bash が sandbox に止められた跡を 1 行の JSON にして追記する。

  sandbox-blocked-log.py < PostToolUse / PostToolUseFailure(Bash) の入力 JSON

hook は sandbox の外で動くので、sandbox の中から書けない場所にも書ける。
通信の拒否は Claude Code が stderr に <sandbox_violations> として付けるが、ファイルや
Unix socket の拒否は付かず、コマンドの出力に Operation not permitted / EPERM としてだけ出る。
そのため両方を拾う。後者は sandbox 以外の理由でも出るので、数えるときは command を見て仕分ける。
書き先は ~/Library/Logs/claude-sandbox/worker.jsonl（CLAUDE_SANDBOX_LOG で差し替え）。
記録に失敗しても worker を止めないよう、常に何も出さず 0 で終わる。
"""

import datetime
import json
import os
import re
import sys

LOG = os.environ.get("CLAUDE_SANDBOX_LOG") or os.path.expanduser("~/Library/Logs/claude-sandbox/worker.jsonl")
VIOLATIONS = re.compile(r"<sandbox_violations>\s*(.*?)\s*</sandbox_violations>", re.S)
DENIED = re.compile(r"Operation not permitted|\bEPERM\b|Sandbox is required")


def findings(text):
    found = []
    for block in VIOLATIONS.findall(text):
        found += [("network" if "network" in line else "sandbox", line.strip()) for line in block.splitlines() if line.strip()]
    text = VIOLATIONS.sub("", text)
    found += [("denied", line.strip()) for line in text.splitlines() if DENIED.search(line)]
    return found


def main():
    event = json.load(sys.stdin)
    if event.get("tool_name") != "Bash":
        return
    response = event.get("tool_response") or {}
    if not isinstance(response, dict):
        response = {"stdout": str(response)}
    text = "\n".join(str(part) for part in (response.get("stdout"), response.get("stderr"), event.get("error")) if part)
    found = findings(text)
    if not found:
        return
    record = {
        "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "session_id": event.get("session_id"),
        "cwd": event.get("cwd"),
        "command": str((event.get("tool_input") or {}).get("command", ""))[:300],
        "kinds": sorted({kind for kind, _ in found}),
        "lines": [line[:200] for _, line in found[:10]],
    }
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
