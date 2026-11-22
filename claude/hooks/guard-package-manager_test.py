#!/usr/bin/env python3
"""guard-package-manager.sh が、pip と brew でパッケージを入れる操作だけを弾くことを保証する。

読み取り系（pip list・brew info）と uv 経由、引用符の中に現れる pip / brew は通す。
"""

import json
import os
import subprocess
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard-package-manager.sh")


def run(command):
    """(弾いたか, 理由)。"""
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    done = subprocess.run([HOOK], input=payload, text=True, check=True,
                          stdout=subprocess.PIPE)
    output = done.stdout.strip()
    if not output:
        return False, ""
    decision = json.loads(output)["hookSpecificOutput"]
    return decision["permissionDecision"] == "deny", decision["permissionDecisionReason"]


class Denied(unittest.TestCase):
    def deny(self, *commands):
        for command in commands:
            with self.subTest(command=command):
                self.assertTrue(run(command)[0])

    def test_pip_package_operations_are_denied(self):
        self.deny("pip install requests",
                  "pip install -r requirements.txt",
                  "pip uninstall -y requests",
                  "pip download requests",
                  "pip --quiet install requests")

    def test_pip3_is_denied_like_pip(self):
        self.deny("pip3 install requests",
                  "pip3 uninstall requests",
                  "pip3 download requests",
                  "pip3.12 install requests",
                  "/usr/bin/pip3 install requests")

    def test_python_m_pip_is_denied(self):
        self.deny("python -m pip install requests",
                  "python3 -m pip install -U pip",
                  "python3 -m pip uninstall requests",
                  "python3 -W ignore -m pip install requests",
                  "python3.12 -m pip download requests")

    def test_brew_package_operations_are_denied(self):
        self.deny("brew install ripgrep",
                  "brew install --cask orca",
                  "brew reinstall ripgrep",
                  "brew uninstall ripgrep",
                  "brew remove ripgrep",
                  "brew upgrade",
                  "brew tap homebrew/cask",
                  "brew untap homebrew/cask",
                  "brew link python",
                  "brew unlink python")

    def test_a_denied_command_behind_a_separator_is_found(self):
        self.deny("cd /tmp && pip install requests",
                  "echo start; brew install ripgrep",
                  "sudo pip install requests",
                  "env FOO=1 pip install requests",
                  "make setup || pip install requests")

    def test_the_reason_names_uv_and_nix(self):
        reason = run("pip install requests")[1]
        self.assertIn("uv", reason)
        self.assertIn("nix", reason)


class Allowed(unittest.TestCase):
    def allow(self, *commands):
        for command in commands:
            with self.subTest(command=command):
                self.assertFalse(run(command)[0])

    def test_uv_is_the_supported_route(self):
        self.allow("uv pip install requests",
                   "uv add requests",
                   "uv run python -m pip install requests",
                   "uvx ruff check",
                   "uv pip uninstall requests")

    def test_pip_read_only_subcommands_pass(self):
        self.allow("pip --version",
                   "pip list",
                   "pip show requests",
                   "pip freeze",
                   "pip3 list --outdated")

    def test_brew_read_only_subcommands_pass(self):
        self.allow("brew list",
                   "brew info ripgrep",
                   "brew search ripgrep",
                   "brew outdated",
                   "brew --version",
                   "brew --prefix",
                   "brew doctor",
                   "brew bundle check")

    def test_quoted_mentions_pass(self):
        self.allow('grep "pip install" README.md',
                   "echo brew",
                   "echo 'brew install ripgrep は使わない'",
                   'rg "brew install" docs/',
                   "git commit -m 'pip install を uv に置き換える'")

    def test_a_separator_inside_quotes_does_not_split_the_command(self):
        self.allow('git commit -m "uv に寄せる; pip install をやめる"',
                   'echo "cd /tmp && brew install ripgrep"',
                   "python3 -c 'print(1)' # pip install",
                   'rg "brew install|pip install" docs/')

    def test_unrelated_commands_pass(self):
        self.allow("ls -la",
                   "python3 script.py",
                   "python3 -m venv .venv",
                   "npm install",
                   "")


if __name__ == "__main__":
    unittest.main()
