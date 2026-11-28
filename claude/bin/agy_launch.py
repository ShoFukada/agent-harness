"""agy に渡すものに、Claude Code の下から起動されたと分かる文脈を入れない（判断の記録 R29。Antigravity の FAQ が
agy -p を第三者のコーディングエージェントで包む使い方を個人プランの対象外としているため）。
- 環境変数は許可リストで選ぶ。Claude Code の下では CLAUDE*・CLAUDE_CODE_*・ANTHROPIC_*・AI_AGENT・ORCA_AGENT_* と
  sandbox の proxy（HTTP(S)_PROXY）が受け継がれる。proxy を渡さないのは、agy は sandbox の外でしか動かず、
  この環境の proxy の変数は sandbox のものだけだから
- 使い捨ての cwd は利用者の一時フォルダ（/var/folders/…/T）に作る。agy は cwd を作業場所として扱う
- HOME は利用者の一時フォルダの agy-neon-home にする（neon_home）。~/.gemini に置いた対話用の決まり（GEMINI.md・
  AGENTS.md）と config/ の skill・プラグインの hook・MCP を、Neon の単発の呼び出しに読ませないため（R241）。
  ANTIGRAVITY_CONFIG_REL_DIR では決まりと skill が分かれなかった（11/28 の試し）

  python3 -I agy_launch.py agy <agy の引数...>   環境を絞って agy に置き換わる
"""

import fcntl
import json
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


NEON_HOME = "agy-neon-home"
# config/ からは config.json（アカウントと既定の設定）だけを見せる。skills.json・plugins.json・hooks.json・mcp_config.json は対話用
HIDDEN = {"GEMINI.md", "AGENTS.md", "config"}
CONFIG_KEEP = {"config.json"}


def _link(target, path):
    """path を target への symlink にする。違うものがあれば置き換える。agy は設定を一時ファイルの rename で書くので、
    前の呼び出しが symlink を普通のファイルに替えていることがある（残すと、ログインし直した ~/.gemini の認証を隠す）。"""
    if os.path.islink(path) and os.readlink(path) == target:
        return
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    tmp = "%s.%d.link" % (path, os.getpid())
    os.symlink(target, tmp)
    os.replace(tmp, path)


def _mirror(src, dst, keep):
    os.makedirs(dst, exist_ok=True)
    names = set(keep(os.listdir(src))) if os.path.isdir(src) else set()
    for name in names:
        _link(os.path.join(src, name), os.path.join(dst, name))
    for name in os.listdir(dst):
        if name not in names and os.path.islink(os.path.join(dst, name)):
            os.unlink(os.path.join(dst, name))


def neon_home(real_home=None, root=None):
    """Neon を起こすときの HOME。.gemini/ に本当の ~/.gemini の中身を symlink で並べ、HIDDEN を除く。
    パスに claude を含めない（clean_env が HOME ごと捨て、agy が起動しない）。"""
    real = os.path.join(real_home or os.path.expanduser("~"), ".gemini")
    home = os.path.join(root or workdir_root(), NEON_HOME)
    dst = os.path.join(home, ".gemini")
    os.makedirs(home, exist_ok=True)
    # Neon は並行に呼ばれる（ja-review と consult など）。並べ直しを直列にしないと、片方の掃除がもう片方の作りかけの
    # symlink を消し、os.replace が落ちる
    with open(os.path.join(home, ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _mirror(real, dst, lambda names: [n for n in names if n not in HIDDEN])
        _mirror(os.path.join(real, "config"), os.path.join(dst, "config"), lambda names: [n for n in names if n in CONFIG_KEEP])
    return home


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
DENY_TOOLS = ["command(*)", "write_file(*)", "read_url(*)", "mcp(*)"]


def text_only_args(deny_read=()):
    """本文を stdin で渡し、本文だけを返させる呼び出し（仕上げ・書き直し）の引数。ファイルも読ませない。
    agentMode "" は Default（Auto は workspace の外のファイルを聞かずに読む）。
    未検証: read_file(*) が全部のパスに当たるかは agy 1.5.3 の help と changelog に無いので、鍵の置き場は deny_read で名指しもする"""
    deny = DENY_TOOLS + ["read_file(*)"] + ["read_file(%s)" % p for p in deny_read]
    return ["--sandbox", "--settings", json.dumps({"agentMode": "", "permissions": {"deny": deny}})]


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
    env = clean_env(dict(extra_env or {}, HOME=neon_home()))
    with tempfile.TemporaryDirectory(prefix=prefix, dir=workdir_root()) as cwd:
        return subprocess.run(args, executable=_exe(args[0]), input=input, cwd=cwd, env=env,
                              timeout=timeout, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def exec_(args):
    args = pin_gemini(args)
    os.execve(_exe(args[0]), args, clean_env({"HOME": neon_home()}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    exec_(sys.argv[1:])
