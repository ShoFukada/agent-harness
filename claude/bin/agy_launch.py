"""agy に渡すものに、Claude Code の下から起動されたと分かる文脈を入れない（判断の記録 R29。Antigravity の FAQ が
agy -p を第三者のコーディングエージェントで包む使い方を個人プランの対象外としているため）。
- 環境変数は許可リストで選ぶ。Claude Code の下では CLAUDE*・CLAUDE_CODE_*・ANTHROPIC_*・AI_AGENT・ORCA_AGENT_* と
  sandbox の proxy（HTTP(S)_PROXY）が受け継がれる。proxy を渡さないのは、agy は sandbox の外でしか動かず、
  この環境の proxy の変数は sandbox のものだけだから
- 使い捨ての cwd は利用者の一時フォルダ（/var/folders/…/T）に作る。agy は cwd を作業場所として扱う

  python3 -I agy_launch.py agy <agy の引数...>   環境を絞って agy に置き換わる
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

# agy 1.5.3 のバイナリが読む変数のうち、動くのに要るもの（認証は HOME の ~/.gemini、アカウントは AGY_ACCOUNT）
KEEP = {"HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "LANGUAGE", "TERM", "COLORTERM", "NO_COLOR",
        "TZ", "EDITOR", "VISUAL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "NIX_SSL_CERT_FILE"}
KEEP_PREFIXES = ("LC_", "AGY_", "ANTIGRAVITY_", "GEMINI_", "GOOGLE_")
TELLTALE = re.compile(r"claude|anthropic", re.I)


def user_tmp():
    """macOS の利用者の一時フォルダ。このマシンの python3（3.9）は os.confstr の CS_DARWIN_USER_TEMP_DIR を知らないので getconf で取る。"""
    # 絶対パスで呼ぶ: worker の sandbox の外で動く neon-design-review が、写し先を決めるのに使う
    try:
        r = subprocess.run(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True)
        d = r.stdout.strip() if r.returncode == 0 else ""
    except OSError:
        d = ""
    return os.path.realpath(d or "/var/tmp")


def workdir_root():
    # NEON_LAUNCH_TMP: テストを Claude の sandbox の中で走らせるため（利用者の一時フォルダに書けない）
    return os.path.realpath(os.environ.get("NEON_LAUNCH_TMP") or user_tmp())


def clean_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k in KEEP or k.startswith(KEEP_PREFIXES)}
    env["PATH"] = os.pathsep.join(p for p in env.get("PATH", "").split(os.pathsep) if p and not TELLTALE.search(p))
    if TELLTALE.search(env.get("TMPDIR", "")):
        env["TMPDIR"] = user_tmp()
    env.update(extra or {})
    return {k: v for k, v in env.items() if not TELLTALE.search(k + "=" + v)}


def _exe(name):
    # 呼び出し元の PATH で探す（絞った PATH には、テストの偽物や sandbox の中のフォルダが無い）。
    # 見つからないときに名前のまま返すと、execve が cwd の同じ名前のファイルを起動する
    path = shutil.which(name)
    if not path:
        raise FileNotFoundError(2, "agy が PATH に無い", name)
    return path


DEFAULT_MODEL = "gemini-4-neon-high"


def pin_gemini(args):
    """agy は Claude・GPT も選べるが、深田の決まり（R108）で Gemini だけに使う。--model が無ければ Gemini を足し、Gemini 以外は断る。"""
    args = list(args)
    models = [(i, a.split("=", 1)[1] if "=" in a else (args[i + 1] if i + 1 < len(args) else ""))
              for i, a in enumerate(args) if a == "--model" or a.startswith("--model=")]
    for _, m in models:
        if not m.lower().startswith("gemini-"):
            raise ValueError("agy では Gemini 以外のモデルを使わない（R108）: %s" % m)
    if not models:
        args[1:1] = ["--model", DEFAULT_MODEL]
    return args


def run(args, input, timeout, prefix="neon-", extra_env=None):
    """agy を使い捨ての空の cwd で走らせ、subprocess.run の結果を返す。例外は subprocess.run のものをそのまま上げる。"""
    args = pin_gemini(args)
    with tempfile.TemporaryDirectory(prefix=prefix, dir=workdir_root()) as cwd:
        return subprocess.run(args, executable=_exe(args[0]), input=input, cwd=cwd, env=clean_env(extra_env),
                              timeout=timeout, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def exec_(args):
    args = pin_gemini(args)
    os.execve(_exe(args[0]), args, clean_env())


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    exec_(sys.argv[1:])
