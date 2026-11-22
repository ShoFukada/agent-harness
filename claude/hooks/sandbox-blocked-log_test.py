#!/usr/bin/env python3
"""sandbox-blocked-log.py が、止められた Bash だけを記録し、どんな入力でも worker を止めないことを保証する。"""

import json
import os
import subprocess
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sandbox-blocked-log.py")


class SandboxBlockedLog(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.log = os.path.join(self.dir.name, "sub", "worker.jsonl")

    def run_hook(self, payload):
        raw = payload if isinstance(payload, str) else json.dumps(payload)
        done = subprocess.run([HOOK], input=raw, text=True, capture_output=True,
                              env={**os.environ, "CLAUDE_SANDBOX_LOG": self.log})
        self.assertEqual((done.returncode, done.stdout), (0, ""))

    def records(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh]

    def test_network_violation(self):
        self.run_hook({
            "tool_name": "Bash", "session_id": "s1", "cwd": "/w",
            "tool_input": {"command": "curl https://example.com"},
            "tool_response": {"stdout": "", "stderr": "curl: (56) CONNECT tunnel failed\n<sandbox_violations>\n"
                              "deny network-outbound example.com:443 (host is not on the allow list)\n</sandbox_violations>"},
        })
        [rec] = self.records()
        self.assertEqual(rec["kinds"], ["network"])
        self.assertEqual(rec["lines"], ["deny network-outbound example.com:443 (host is not on the allow list)"])
        self.assertEqual((rec["session_id"], rec["command"]), ("s1", "curl https://example.com"))

    def test_file_denied_from_failure_event(self):
        self.run_hook({
            "tool_name": "Bash", "tool_input": {"command": "touch ~/x"},
            "error": "Exit code 1\ntouch: /Users/u/x: Operation not permitted",
        })
        [rec] = self.records()
        self.assertEqual(rec["kinds"], ["denied"])

    def test_ignores_success_and_other_tools(self):
        self.run_hook({"tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_response": {"stdout": "a\nb", "stderr": ""}})
        self.run_hook({"tool_name": "Read", "tool_response": {"stdout": "Operation not permitted"}})
        self.assertEqual(self.records(), [])

    def test_broken_input_does_not_fail(self):
        self.run_hook("not json")
        self.assertEqual(self.records(), [])


if __name__ == "__main__":
    unittest.main()
