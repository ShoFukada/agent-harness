#!/usr/bin/env python3
"""人間が読む日本語（Issue / PR の本文、.md / .html / .txt）を、別系統のモデルに書き直させる。

  ja-review.py --hook pre    < PreToolUse(Bash) の入力 JSON
  ja-review.py --hook stop   < Stop の入力 JSON
  ja-review.py --hook post   < PostToolUse(Write/Edit/MultiEdit/apply_patch) の入力 JSON
  ja-review.py --rewrite     < 生テキスト（書き直した本文を返す）

書き直し役は agy の gemini-4-neon-high。ja-writing skill の「書き方の規則」節と、
dev-standards プラグインの ja-vocab-lint.py の単語表が拾った硬い語を規則として渡し、判定と書き直しを 1 回の呼び出しで済ませる。
yomiyasu の規則（ja_yomiyasu.py が切り出す）も足し、文書の種類が分かればその種類の規則、顧客向けなら
書き手と読み手の規則を添える。語調の扱いは本文の読み手の印で切り替える（frontmatter の audience: client、HTML の meta、<!-- audience: … -->、medurance-web-docs の deck の data-audience）。
client なら口語を業務文書の語に直させ、internal なら元の語調を保たせ、印が無ければ本文の手がかりで判断させる。
stop はそのターンに書いた .md / .mdx / .html / .txt をファイルごとに見て、書き直しが返ったら
ファイルを更新し、件数と差分の置き場を systemMessage で知らせる（安全確認は hook が済ませているので
差し戻さず、Claude に追加のターンを使わせない）。pre は gh の本文を書き直し、`--body-file` なら
そのファイルを、インラインの `--body` なら updatedInput でコマンドごと差し替える。差分は会話に載せず
$TMPDIR/ja-review-diffs/ に書き、知らせるのはそのパスだけにする（会話の本線が差分で埋まるのを
避ける。7 日で消える）。

stop は transcript から、最後のユーザープロンプト以降に成功した Write / Edit / MultiEdit と
apply_patch を拾い、重複を除いたパスのディスク上の現在の内容を見る。書き直しのうち採るのは、そのターンで
変えた行（ターンで最初の書き込みの結果にある書き込む前の本文と、今の本文の行の差分。前の本文が分からなければ
Edit の断片の位置と HEAD との git diff）の中に収まる変更だけで、触れていない行は、改行コードと末尾の空行も
含めて書き換えない（PR の範囲の外の差分を混ぜないため）。agy から呼ぶとき（agy-hook.py）は transcript の代わりに、
入力の turn_writes（そのターンに書き込めた Write / Edit の入力と、書き込む前の本文の一覧）を読む。
採った行は ja_spacing の規則で日本語と英数字の間の空白を詰め直す。変えた行が無いファイルは渡さない。
書き直しを呼ぶのは地の文の日本語が 300 文字以上のファイルだけで、それ未満は単語表の閾値だけを見る。
CLAUDE.md・CLAUDE.local.md・AGENTS.md・SKILL.md、agents/ skills/ .claude/ 配下、scratchpad 配下、
brief で始まる名前は、読み手がエージェントなので見ない。同じ本文を二度書き直さないよう、OK と
判定された本文と書き直した後の本文の sha256 を $TMPDIR/ja-review-cache/ に 7 日だけ残す（timeout・
認証失敗・形式外は残さない）。stop_hook_active のときは黙り、差し戻した結果の再判定は次のターンに任せる。

書き直せなかったときは単語表の閾値だけで判定し、Tier1 が 1 語か Tier2 が 3 語あれば語の一覧を差し戻す。
安全確認で落ちた書き直し（unsafe_rewrite）は差し戻さず、件数とパスを systemMessage に載せる。
原因は $TMPDIR/ja-review-failures.log に 1 行だけ追記する（時刻・モード・原因・本文の文字数）。原因は
呼び出し側（agy_missing・timeout・nonzero_exit・too_long）と応答側（empty_response は agy が成功扱いで
空を返したもの、unsafe_rewrite は安全確認で落としたもの、bad_output は stream-json を読めなかったもの）
に分かれる。別のモデルへの切り替えはしない。

書き直しを採るのは、数字と単位の列・見出しの深さ・インラインコード・コードフェンスの中身・リンク先が
元と同じ順序で一致し、否定で終わる文の数・敬称の付いた名前・鉤括弧の引用がそのまま残り、
地の文が元の 6 割以上残っていて、文末の敬体と常体が反転しておらず、yomiyasu_diff が許可・義務の言い方、
文の種類、数値の変化と、原文に無い人や担当の追加を見つけなかったときだけ
（繰り返しの多い本文はモデルが重複をまとめて 1 行に潰すことがあり、同じ本文を二度通すと常体が
敬体に変わることがある）。上書きは、読んだ内容が書き込み直前も変わっていないことを確かめてから、
同じディレクトリの一時ファイルを os.replace で置き換える形で行う。1 MB 超のファイルと UTF-8 で読めない
ファイルは対象にしない。hook 全体の締め切りは 170 秒で、残りが 20 秒を切ったファイルは処理せず理由に
並べる。agy は claude/bin/agy_launch.py から起動し、使い捨ての空ディレクトリを cwd にして project の
AGENTS.md を読ませず、環境変数を許可リストで絞る。本文は argv ではなく stdin の stream-json で渡す
（`agy -p` は stdin を読まないので、長い本文で argv が溢れるのを避けるにはこの経路しかない）。
Orca の agy 用 hook（~/.gemini/config/hooks.json）は ORCA_PANE_KEY・ORCA_AGENT_PANE が無いと何もしないので、
絞った環境では書き直し中に発火しない。

抽出できない本文は書き直さず通す: `--body-file -`（stdin）、`$(`、バッククォート置換、heredoc。
`cd` を含むコマンドは、直列（`&&` / `;`）に cd だけが先頭から並ぶ形のときだけ合成して解決し、
サブシェル・パイプ・`||`・cd の前に別のコマンドがある形は書き直さず通す。インラインの本文を
updatedInput で差し替えるのは、素の gh から始まり、区切り・cd・`$`・リダイレクトの無い単一の呼び出しの
ときだけで、それ以外は deny して書き直した本文を理由に載せる。

post は書き込んだ .md / .mdx / .html / .txt の、書き込みで変えた行（stop と同じ決め方）の日本語と英数字の
間の半角の空白を ja_spacing の規則で詰めてファイルを更新し（LLM は使わない）、詰めた行を知らせる。
続けて yomiyasu_lint をかけ、変えた行に出た候補だけを additionalContext で返す（差し戻しはしない）。HTML はタグを落とした地の文を渡す。
ja-vocab-lint の単語表と同じ語の slop_vocabulary は重ねて出さない。

JA_REVIEW_ACTIVE=1 は書き直し役の中から再入したしるしで、即座に通す。JA_REVIEW_SKIP=1 で黙る。

対処しない既知の境界: subagent（sidechain）が書いた文書は見ない。TMPDIR 未設定で /tmp に落ちた
ときの所有者確認（single-user の Mac 前提）。
"""

import difflib
import hashlib
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "bin"))
import agy_launch  # noqa: E402
import client_leak  # noqa: E402
import ja_spacing  # noqa: E402
import ja_yomiyasu  # noqa: E402

MODEL = "gemini-4-neon"
CLI_MODEL = "gemini-4-neon-high"
PRINT_TIMEOUT = "4m"
REWRITE_TIMEOUT = 260
CACHE_DIR = "ja-review-cache"
FAILURE_LOG = "ja-review-failures.log"
STDERR_TAIL = 200
CACHE_TTL = 7 * 24 * 60 * 60
MIN_JAPANESE = 300
PRE_MIN_JAPANESE = 100
POST_MAX_FINDINGS = 10
POST_DEADLINE = 25
MAX_CHARS = 200000
MAX_FILE_BYTES = 1024 * 1024
MAX_DIFF = 200000
DIFF_DIR = "ja-review-diffs"
GIT_TIMEOUT = 5
DEADLINE = 280
MIN_SLICE = 20
MIN_KEPT = 0.6
POLITENESS_MIN = 2
TEXT_EXTENSIONS = (".md", ".mdx", ".html", ".txt")
INSTRUCTION_NAMES = {"claude.md", "claude.local.md", "agents.md", "gemini.md", "skill.md", "reminder.md"}
INSTRUCTION_DIRS = {".claude", ".codex", ".agy", "agents", "skills", "commands", "rules", "prompts",
                    "scratchpad"}
INSTRUCTION_NAME_RE = re.compile(r"\Abrief(?:[-_.]|\Z)")
# 契約書の条文は法律用語を平易にすると意味が変わる（「担保に供する」→「保証にして」など）ので書き直さない
LEGAL_DIRS = {"contracts"}
WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "apply_patch")
GUIDE = "ja-writing skill の「書き方の規則」"
SECTION_HEADING = "# 書き方の規則"
RULES_MD = os.path.join(
    os.path.dirname(os.path.dirname(os.path.realpath(__file__))),
    "skills", "ja-writing", "SKILL.md")

JAPANESE_RE = re.compile(r"[ぁ-ゖァ-ヺ一-龯々〆ヵヶ]")
OK_RE = re.compile(r"^OK[。.]?$")
ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
RAW_LINE_RE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+\Z")
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", re.M)
FENCE_LINE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})")
HEADING_LEVEL_RE = re.compile(r"^(#+)", re.M)
INLINE_CODE_RE = re.compile(r"(`+)([^\n]*?)\1")
LINK_URL_RE = re.compile(r"\[[^\]\n]*\]\(([^)\n]*)\)")
NUMBER_UNITS = ("時間", "トークン", "ページ", "文字", "KB", "MB", "GB", "TB", "ms",
                "万", "億", "兆", "円", "%", "％", "割", "人", "件", "行", "回", "日", "月", "年",
                "分", "秒", "倍", "個", "本", "台", "点", "位", "版", "k", "M", "G")
SPACE_RE = re.compile(r"[ \t　]+")
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)*(?:[ \t　]*(?:%s))*" % "|".join(NUMBER_UNITS))
SENTENCE_RE = re.compile(r"[^。\n]+")
NEGATIVE_END_RE = re.compile(r"(?:ない|なかった|ません|ませんでした|せず|不可)[^。\n]{0,8}$")
HONORIFIC_NAME_RE = re.compile(r"([一-龯々〆ヵヶァ-ヺー]{2,})(?=さん|氏|様|先生)")
QUOTED_RE = re.compile(r"「([^」\n]{1,40})」")
POLITE_RE = re.compile(r"(?:です|ます|ました|ません|でした|ください|ましょう)(?=[。、！？\n)）」』]|$)", re.M)
PLAIN_RE = re.compile(
    r"(?:(?<!で)(?<!ま)する|した|ない|なる|ある|いる|だ|である|よい|れる|られる)"
    r"(?=[。！？\n)）」』]|$)", re.M)
REBUILD_UNSAFE = ("$", "<", ">")
FENCE_WRAP_RE = re.compile(r"\A```[^\n]*\n(.*)\n```\Z", re.S)
STRUCTURAL = ("#", "-", "*", ">", "|", "`", "+", "1.")
PREAMBLE_RE = re.compile(
    r"\A(?:以下|こちら|下記)[^\n]{0,60}\Z"
    r"|\A[^\n]{0,60}(?:仕上げ|修正|校正|整え|清書|推敲|直し|書き直)まし[^\n]{0,20}\Z")

SEPARATOR_CHARS = ";|&()<>\n"
MASK = dict((ch, chr(0xE000 + i)) for i, ch in enumerate(SEPARATOR_CHARS))
UNMASK = dict((v, k) for k, v in MASK.items())
SEPARATORS = {"&&", "||", ";", "|", "|&", "&", "(", ")", "{", "}", ";;", "\n"}
SERIAL = {"&&", ";"}
PREFIX_COMMANDS = {"env", "command", "nohup", "time", "exec"}

GLOBAL_WITH_VALUE = {"-R", "--repo"}
BODY_FLAGS = {"--body", "-b", "--notes", "-n"}
FILE_FLAGS = {"--body-file", "-F", "--notes-file"}
TITLE_FLAGS = {"--title"}
VALUE_FLAGS = BODY_FLAGS | FILE_FLAGS | TITLE_FLAGS
TARGETS = {
    ("issue", "create"), ("issue", "comment"),
    ("pr", "create"), ("pr", "comment"), ("pr", "review"),
    ("release", "create"),
}

PROMPT = """以下の日本語の本文を、規則に従って読みやすく書き直してください。
内容・事実・数値・固有名詞・引用・識別子・コードブロック・敬体と常体・Markdown の構造（見出し・箇条書き・表・リンク）は変えないでください。
直訳調の言い回し、一度読んで意味の取れない複雑な文構造、硬すぎる語彙だけを直してください。
業界で普通に使う用語は言い換えないでください。
%s
書き直す必要がなければ OK の 1 行だけを出力してください。
書き直すなら、書き直した本文全体だけを出力してください。前置き・説明・変更点の一覧を付けず、全体をコードフェンスで囲まないでください。
%s%s
--- 対象 ---
%s
"""

# 読み手の印。顧客向けの文書が軽い言い方のまま残らないよう、印か本文の手がかりで語調の扱いを切り替える。
# 判定は dev-standards の ja-vocab-lint.py の audience() とそろえる（frontmatter は先頭のブロックの中、
# meta とコメントはコード・引用の外だけを読む）。deck の data-audience は ja-vocab-lint が読まないが、client_leak と同じ読み替えでこちらは読む
FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)^---[ \t]*$", re.S | re.M)
FRONTMATTER_AUDIENCE_RE = re.compile(r"(?m)^audience:[ \t]*[\"']?(client|internal)[\"']?[ \t]*\r?$")
META_RE = re.compile(r"<meta\b[^>]*>", re.I)
ATTR_RE = re.compile(r"([\w-]+)\s*=\s*[\"']([^\"']*)[\"']")
COMMENT_AUDIENCE_RE = re.compile(r"<!--\s*audience:\s*(client|internal)\s*-->")
TONE = {
    "client": "書き手は受託開発の会社、読み手は取引先の担当者（社外の特定の相手）です。この本文は顧客・社外の読み手に渡す業務文書です。話し言葉・口語の言い回しは、規則の「業務文書の語調」に従って業務文書の語に直してください。文の働き（相談・依頼・提案・宣言）・言い切りの強さ・文書の用語は変えず、敬体と常体も変えないでください。",
    "internal": "元の語調を保ち、業務文書を口語に崩したり、口語の文章を業務文書に硬くしたりしないでください。",
    None: "読み手を本文から判断してください。宛名の「様」・御社・貴社や、提案・報告・定義書・操作マニュアルのように顧客・社外に渡す業務文書なら、話し言葉・口語の言い回しを規則の「業務文書の語調」に従って業務文書の語に直してください（文の働き・言い切りの強さ・文書の用語は変えない）。社内向けや個人の文章なら元の語調を保ち、口語の文章を業務文書に硬くしないでください。どちらでも敬体と常体は変えないでください。",
}


def audience(text):
    """本文に付いた読み手の印（client / internal）。印が無ければ None。"""
    text = text or ""
    block = FRONTMATTER_RE.match(text)
    if block:
        m = FRONTMATTER_AUDIENCE_RE.search(block.group(1))
        if m:
            return m.group(1)
    # 手順書のコード例や引用に書いた印を、その文書の印と取り違えない
    prose = _VOCAB.mask_non_prose(text) if _VOCAB is not None else text
    for tag in META_RE.finditer(prose):
        attrs = {k.lower(): v for k, v in ATTR_RE.findall(tag.group(0))}
        if attrs.get("name", "").lower() == "audience" and attrs.get("content") in ("client", "internal"):
            return attrs["content"]
    m = COMMENT_AUDIENCE_RE.search(prose)
    return m.group(1) if m else client_leak.deck_audience(prose)


def _load_vocab_lint():
    # 単語表は dev-standards プラグインが持つ。マーケットプレイスの取り込み先は、プラグインのバージョンが変わっても同じ
    path = os.path.expanduser("~/.claude/plugins/marketplaces/medurance-dev-standards/hooks/ja-vocab-lint.py")
    try:
        spec = importlib.util.spec_from_file_location("ja_vocab_lint", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


_VOCAB = _load_vocab_lint()


def prose_japanese_length(text):
    """コード・URL・引用・鉤括弧を落とした地の文の日本語文字数。"""
    if _VOCAB is not None:
        text = _VOCAB.mask_non_prose(text or "")
    return len(JAPANESE_RE.findall(text or ""))


def japanese_length(text):
    return len(JAPANESE_RE.findall(text or ""))


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def read_raw(path):
    """改行コードをそのまま残して読む。1 MB 超と UTF-8 で読めないファイルは対象外（None）。"""
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        with open(path, encoding="utf-8", newline="") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError, ValueError):
        return None


def replace_file(path, before, text):
    """(置き換えたか, 置き換えなかった理由)。読んだ後に変わっていたファイルは触らない。"""
    if read_raw(path) != before:
        return False, "書き直し中にファイルが変わったので更新しなかった"
    directory = os.path.dirname(os.path.abspath(path))
    try:
        handle, temporary = tempfile.mkstemp(prefix=".ja-review-", dir=directory)
    except OSError:
        return False, "ファイルを更新できなかった"
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        try:
            os.chmod(temporary, os.stat(path).st_mode & 0o7777)
        except OSError:
            pass
        os.replace(temporary, path)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        return False, "ファイルを更新できなかった"
    return True, ""


def normalize(text):
    return (text or "").replace("\r\n", "\n").replace("\r", "\n")


def restore(text, original):
    """書き直した本文を、元の改行コードと末尾改行に合わせる。"""
    body = normalize(text)
    if original.endswith("\n") or original.endswith("\r"):
        body = body.rstrip("\n") + "\n"
    else:
        body = body.rstrip("\n")
    return body.replace("\n", "\r\n") if "\r\n" in original else body


def vocab_result(text):
    return _VOCAB.scan(text) if _VOCAB is not None else None


def listed(result):
    return _VOCAB.listed(result) if _VOCAB is not None else ""


def over_threshold(result):
    return bool(result) and _VOCAB is not None and _VOCAB.over_threshold(result)


def rules():
    """ja-writing skill の「書き方の規則」節。読めなければ空文字（規則なしで書き直させる）。"""
    try:
        with open(RULES_MD, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return ""
    heads = [i for i, line in enumerate(lines) if line.startswith(SECTION_HEADING)]
    if not heads:
        return ""
    body = lines[heads[0] + 1:]
    end = [i for i, line in enumerate(body) if line.startswith("# ")]
    if end:
        body = body[:end[0]]
    return "\n".join(body).strip()


def prompt_rules(aud=None, doc_type=None):
    """(プロンプトに挟む規則, 同梱できなかった理由の一覧)。読めない規則は外して残りで書き直させる。"""
    problems = []
    section = rules()
    if not section:
        problems.append("%s の「%s」節を読めない" % (RULES_MD, SECTION_HEADING))
    block = "" if not section else "\n次の規則に従ってください。\n%s\n" % section
    try:
        block += ja_yomiyasu.gemini_block(doc_type, aud == "client")
    except ja_yomiyasu.Unavailable as error:
        problems.append("yomiyasu: %s" % error)
    return block, problems


def rules_block(aud=None, doc_type=None):
    block, problems = prompt_rules(aud, doc_type)
    for problem in problems:
        log_failure("rules", problem, "")
    return block


def hits_block(result):
    if not result or not result["hits"]:
        return ""
    return "\n次の語は言い換えてください: %s。括弧内は言い換え候補です。\n" % listed(result)


def remaining(result):
    if not result or not result["hits"]:
        return ""
    return "\n残っている語: %s" % listed(result)


def agy_input(prompt):
    return json.dumps({"event": "user", "message": {
        "role": "user", "content": [{"type": "text", "text": prompt}]}}) + "\n"


def parse_agy(returncode, output):
    """stream-json の result 行から応答の本文を取り出す。取り出せなければ None。"""
    if returncode != 0:
        return None
    for line in reversed((output or "").splitlines()):
        try:
            event = json.loads(line.strip() or "null")
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get("event") != "result":
            continue
        result = event.get("result")
        if not isinstance(result, dict) or result.get("status") != "SUCCESS":
            return None
        response = result.get("response")
        return response if isinstance(response, str) else None
    return None


def with_tail(problem, tail):
    return "%s stderr: %s" % (problem, tail) if tail else problem


def time_left(deadline):
    return None if deadline is None else deadline - time.monotonic()


def slice_timeout(deadline):
    """hook 全体の締め切りに収まる subprocess の timeout。"""
    left = time_left(deadline)
    if left is None:
        return REWRITE_TIMEOUT
    return max(1, min(REWRITE_TIMEOUT, int(left)))


def call_agy(prompt, deadline=None):
    """(応答, 失敗の原因)。応答が取れたときの原因は None。"""
    try:
        done = agy_launch.run(
            ["agy", *agy_launch.text_only_args(), "--model", CLI_MODEL,
             "--input-format", "stream-json", "--output-format", "stream-json",
             "--print-timeout", PRINT_TIMEOUT, "--disable-slash-commands"],
            input=agy_input(prompt), timeout=slice_timeout(deadline), prefix="ja-review-",
            extra_env={"JA_REVIEW_ACTIVE": "1"})
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "agy_missing"
    except subprocess.SubprocessError:
        return None, "bad_output"
    tail = " ".join((done.stderr or "")[-STDERR_TAIL:].split())
    if done.returncode != 0:
        return None, with_tail("nonzero_exit=%d" % done.returncode, tail)
    response = parse_agy(done.returncode, done.stdout)
    if response is None:
        return None, with_tail("bad_output", tail)
    return response, None


def log_failure(mode, problem, text):
    """書き直せなかった原因を 1 行追記する（書けなくても黙って続ける）。"""
    line = "%s\t%s\t%s\t%d 字\n" % (
        time.strftime("%Y-%m-%dT%H:%M:%S%z"), mode or "-", problem, len(text or ""))
    try:
        with open(os.path.join(tempfile.gettempdir(), FAILURE_LOG), "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


def strip_wrapping(response, original=""):
    """本文全体を包むコードフェンスと、本文の前に付いた 1 行の前置きを外す。

    元の本文に同じ行があるときは前置きと見なさない（本文の 1 行目を落とす誤爆を避ける）。
    """
    text = (response or "").strip("\n")
    fenced = FENCE_WRAP_RE.match(text)
    if fenced:
        text = fenced.group(1)
    lines = text.split("\n")
    body = [line for line in lines[1:] if line.strip()]
    if (len(body) >= 2 and not lines[0].startswith(STRUCTURAL)
            and PREAMBLE_RE.match(lines[0]) and lines[0].strip() not in (original or "")):
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines = lines[1:]
        text = "\n".join(lines)
    return text


def count_lines(text, pattern):
    return sum(1 for line in (text or "").splitlines() if pattern.match(line))


def code_spans(text):
    """バッククォートで囲んだインラインコードの中身を、現れた順に返す。"""
    return [m.group(2) for m in INLINE_CODE_RE.finditer(text or "")]


def fenced_lines(text):
    """コードフェンスの内側の行を、現れた順に返す。"""
    inside = []
    opening = None
    for line in (text or "").splitlines():
        found = FENCE_LINE_RE.match(line)
        if opening is None:
            if found:
                opening = found.group(1)
            continue
        if found and found.group(1)[0] == opening[0] and len(found.group(1)) >= len(opening):
            opening = None
            continue
        inside.append(line)
    return inside


def politeness(text):
    """敬体と常体のどちらで書かれているか。判定が付かなければ None。"""
    masked = _VOCAB.mask_non_prose(text or "") if _VOCAB is not None else (text or "")
    polite = len(POLITE_RE.findall(masked))
    plain = len(PLAIN_RE.findall(masked))
    if polite + plain < POLITENESS_MIN:
        return None
    if polite > plain * 2:
        return True
    if plain > polite * 2:
        return False
    return None


def quantities(text):
    """数字と、それに続く単位の列。「10万円」と「10 万円」は同じものとして扱う。"""
    return [SPACE_RE.sub("", m.group()) for m in NUMBER_RE.finditer(text or "")]


def negations(text):
    """文末付近が否定で終わる文の数。地の文だけを見る。"""
    masked = _VOCAB.mask_non_prose(text or "") if _VOCAB is not None else (text or "")
    return sum(1 for line in SENTENCE_RE.findall(masked) if NEGATIVE_END_RE.search(line))


def names(text):
    """敬称（さん・氏・様・先生）の直前に置かれた 2 文字以上の語。"""
    return set(HONORIFIC_NAME_RE.findall(text or ""))


def quotations(text):
    """鉤括弧で引用した語。落とすと引用でなくなるので、書き直しでも残す。"""
    return set(QUOTED_RE.findall(text or ""))


def structure(text):
    """地の文でない要素（数量・見出しの深さ・コード・リンク先）を、現れた順に並べる。"""
    return (
        quantities(text),
        [len(m.group(1)) for m in HEADING_LEVEL_RE.finditer(text or "")],
        code_spans(text),
        fenced_lines(text),
        [m.group(1) for m in LINK_URL_RE.finditer(text or "")],
    )


def safe(original, rewritten):
    """構造と数量と固有名詞が元のままで、地の文が大きく減っていない書き直しだけを採る。"""
    if not (rewritten or "").strip():
        return False
    if count_lines(original, FENCE_LINE_RE) != count_lines(rewritten, FENCE_LINE_RE):
        return False
    before = prose_japanese_length(original)
    if before and prose_japanese_length(rewritten) < before * MIN_KEPT:
        return False
    tone = politeness(original)
    if tone is not None and politeness(rewritten) is not None and politeness(rewritten) != tone:
        return False
    if negations(original) != negations(rewritten):
        return False
    if names(original) != names(rewritten):
        return False
    if quotations(original) - quotations(rewritten):
        return False
    return structure(original) == structure(rewritten)


def rewrite(text, result=None, mode="", deadline=None, doc_type=None):
    """(本文, 失敗の原因)。OK は ("", None)、書き直せたら (本文, None)、書き直せなければ (None, 原因)。"""
    if not text:
        return None, "empty_input"
    if len(text) > MAX_CHARS:
        log_failure(mode, "too_long", text)
        return None, "too_long"
    aud = audience(text)
    response, problem = call_agy(
        PROMPT % (TONE[aud], rules_block(aud, doc_type), hits_block(result), text), deadline)
    if response is None:
        log_failure(mode, problem, text)
        return None, problem
    body = strip_wrapping(response, text)
    lines = [line for line in body.splitlines() if line.strip()]
    if not lines:
        log_failure(mode, "empty_response", text)
        return None, "empty_response"
    if len(lines) == 1 and OK_RE.match(lines[0].strip()):
        return "", None
    if not safe(text, body):
        log_failure(mode, "unsafe_rewrite", text)
        return None, "unsafe_rewrite"
    risks = ja_yomiyasu.meaning_risks(text, body, doc_type, timeout=time_left(deadline))
    if risks:
        log_failure(mode, "unsafe_rewrite meaning_risk=%s" % ",".join(sorted(set(risks))), text)
        return None, "unsafe_rewrite"
    return body, None


def cache_path(text):
    digest = hashlib.sha256((text or "").encode("utf-8")).hexdigest()
    return os.path.join(tempfile.gettempdir(), CACHE_DIR, digest)


def cached(text):
    try:
        return time.time() - os.path.getmtime(cache_path(text)) < CACHE_TTL
    except OSError:
        return False


def remember(text):
    path = cache_path(text)
    directory = os.path.dirname(path)
    try:
        os.makedirs(directory, 0o700, exist_ok=True)
    except OSError:
        return
    prune(directory)
    try:
        open(path, "w").close()
    except OSError:
        pass


def prune(directory):
    cutoff = time.time() - CACHE_TTL
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        stale = os.path.join(directory, name)
        try:
            if os.path.getmtime(stale) < cutoff:
                os.unlink(stale)
        except OSError:
            continue


def scan_command(command):
    """区切り文字を引用の内外で区別できる形に直す。判定不能な構文があれば知らせる。"""
    out = []
    quote = ""
    escaped = False
    unsupported = False
    boundary = True
    i = 0
    while i < len(command):
        ch = command[i]
        if escaped:
            out.append(MASK.get(ch, ch))
            escaped = False
            boundary = False
            i += 1
            continue
        if ch == "\\" and quote != "'":
            out.append(ch)
            escaped = True
            i += 1
            continue
        if quote == "'":
            out.append(ch if ch == "'" else MASK.get(ch, ch))
            if ch == "'":
                quote = ""
            i += 1
            continue
        if ch == "`" or command.startswith("$(", i):
            unsupported = True
        if quote == '"':
            out.append(ch if ch == '"' else MASK.get(ch, ch))
            if ch == '"':
                quote = ""
            i += 1
            continue
        if ch == "#" and boundary:
            while i < len(command) and command[i] != "\n":
                i += 1
            continue
        if command.startswith("<<", i):
            unsupported = True
        if ch in "'\"":
            quote = ch
            out.append(ch)
            boundary = False
            i += 1
            continue
        out.append(" ; " if ch == "\n" else ch)
        boundary = ch in " \t\n" or ch in SEPARATOR_CHARS
        i += 1
    return "".join(out), unsupported


def unmask(token):
    return "".join(UNMASK.get(ch, ch) for ch in token)


def tokenize(command):
    masked, unsupported = scan_command(re.sub(r"\\\n", " ", command))
    if unsupported:
        return None
    lexer = shlex.shlex(masked, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError:
        return None


def split_command(tokens):
    """(空でないコマンドの一覧, 現れた区切りの一覧)"""
    commands, separators, current = [], [], []
    for token in tokens:
        if token in SEPARATORS:
            separators.append(token)
            if current:
                commands.append(current)
            current = []
        else:
            current.append(token)
    if current:
        commands.append(current)
    return commands, separators


def gh_index(segment):
    """`env FOO=1 gh …` のような前置きを飛ばして gh の位置を返す。"""
    for i, token in enumerate(segment):
        if ASSIGNMENT_RE.match(token) or token in PREFIX_COMMANDS:
            continue
        return i if os.path.basename(unmask(token)) == "gh" else None
    return None


def subcommand(args):
    pair = []
    i = 0
    while i < len(args) and len(pair) < 2:
        token = args[i]
        if token.startswith("-"):
            if token in GLOBAL_WITH_VALUE:
                i += 2
                continue
            i += 1
            continue
        pair.append(token)
        i += 1
    return tuple(pair) if len(pair) == 2 else None


def value_at(args, i):
    """`--body=X` `-bX` `-b X` の3形を (フラグ名, 値, 値の位置, 同じトークン内の前置き, 次の位置)。"""
    token = args[i]
    if token.startswith("--") and "=" in token:
        name, value = token.split("=", 1)
        return name, value, i, name + "=", i + 1
    if len(token) > 2 and token[0] == "-" and token[1] != "-" and token[:2] in VALUE_FLAGS:
        return token[:2], token[2:], i, token[:2], i + 1
    if token in VALUE_FLAGS:
        if i + 1 >= len(args):
            return token, None, None, "", i + 2
        return token, args[i + 1], i + 1, "", i + 2
    return token, None, None, "", i + 1


def resolve_body_file(name, cwd):
    if name == "-":
        return None
    path = os.path.expanduser(name)
    if not os.path.isabs(path):
        if not cwd:
            return None
        path = os.path.join(cwd, path)
    return path


def advance_cwd(cwd, segment):
    args = [unmask(t) for t in segment[1:] if not t.startswith("-")]
    if len(args) != 1 or args[0] == "-":
        return None
    target = os.path.expanduser(args[0])
    if os.path.isabs(target):
        return target
    if not cwd:
        return None
    return os.path.normpath(os.path.join(cwd, target))


def target_args(segment):
    """gh の対象サブコマンドならその引数、そうでなければ None。"""
    index = gh_index(segment)
    if index is None:
        return None
    args = segment[index + 1:]
    return args if subcommand(args) in TARGETS else None


def gh_bodies(command, base_cwd):
    """gh の本文系オプションから本文を集める。None は判定不能（通す）。

    file は書き戻す path と生の内容、inline は組み直し用のトークン位置を持つ。位置が None の
    ものは updatedInput で差し替えられない（区切りか cd がある形）。
    """
    tokens = tokenize(command)
    if tokens is None:
        return None
    commands, separators = split_command(tokens)
    targets = dict((i, args) for i, args in
                   ((i, target_args(c)) for i, c in enumerate(commands)) if args is not None)
    if not targets:
        return []
    last = max(targets)
    moves = [i for i, c in enumerate(commands) if unmask(c[0]) == "cd" and i < last]
    if moves:
        if any(s not in SERIAL for s in separators):
            return None
        if any("(" in c or ")" in c for c in commands):
            return None
        if any(i not in moves for i in range(moves[-1])):
            return None
    simple = not separators and len(commands) == 1 and len(targets) == 1

    cwd = base_cwd
    records = []
    for i, segment in enumerate(commands):
        if i in moves:
            cwd = advance_cwd(cwd, segment)
            if cwd is None:
                return None
            continue
        args = targets.get(i)
        if args is None:
            continue
        kind = "pr" if subcommand(args)[0] == "pr" else None
        base = gh_index(segment) + 1
        j = 0
        while j < len(args):
            name, value, at, prefix, j = value_at(args, j)
            if name not in VALUE_FLAGS:
                continue
            if value is None:
                return None
            value = unmask(value)
            if name in TITLE_FLAGS:
                continue
            if name in FILE_FLAGS:
                path = resolve_body_file(value, cwd)
                raw = read_raw(path) if path else None
                if raw is None:
                    return None
                records.append({"kind": "file", "text": normalize(raw), "raw": raw, "path": path,
                                "doc_type": kind})
            elif value:
                records.append({"kind": "inline", "text": value, "prefix": prefix,
                                "token": (base + at) if simple else None, "doc_type": kind})
    return records


def gh_human_text(command, base_cwd):
    """gh の本文系オプションから人間が読む文章を集める。None は判定不能（通す）。"""
    records = gh_bodies(command, base_cwd)
    if records is None:
        return None
    return "\n\n".join(r["text"] for r in records if r["text"])


def rebuildable(command):
    """組み直してよいのは、素の gh から始まり、展開もリダイレクトも無いコマンドだけ。"""
    if any(ch in command for ch in REBUILD_UNSAFE):
        return False
    tokens = tokenize(command)
    if not tokens:
        return False
    head = unmask(tokens[0])
    return not ASSIGNMENT_RE.match(head) and os.path.basename(head) == "gh"


def rebuild(command, replacements):
    """トークン列の指定位置だけ差し替えてコマンドを組み直す。組み直せなければ None。"""
    tokens = tokenize(command)
    if tokens is None:
        return None
    plain = [unmask(token) for token in tokens]
    for index, prefix, value in replacements:
        if index is None or index >= len(plain):
            return None
        plain[index] = prefix + value
    return shlex.join(plain)


def parse_patch(text):
    paths = []
    for raw in (text or "").splitlines():
        m = re.match(r"\*\*\* (Add|Update|Move to)(?: File)?: (.+)$", raw)
        if m:
            target = m.group(2).strip()
            if target not in paths:
                paths.append(target)
    return paths


def written_paths(tool_input, cwd):
    """書き込み先の絶対パス。file_path か apply_patch のエンベロープから拾う。"""
    path = tool_input.get("file_path")
    if isinstance(path, str) and path:
        return [path]
    if isinstance(tool_input.get("command"), str):
        return [os.path.join(cwd, rel) if cwd and not os.path.isabs(rel) else rel
                for rel in parse_patch(tool_input["command"])]
    return []


def is_user_prompt(entry):
    """人間が打ったプロンプト。tool_result・skill の注入・背景の通知は区切りにしない。"""
    if entry.get("type") != "user" or entry.get("isSidechain") or entry.get("isMeta"):
        return False
    if entry.get("promptSource") == "system":
        return False
    origin = entry.get("origin")
    if isinstance(origin, dict) and origin.get("kind") == "task-notification":
        return False
    message = entry.get("message")
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") != "tool_result" for b in content)
    return False


def given_writes(payload, cwd):
    """agy-hook.py が渡す、そのターンに書き込めた書き込み（turn_writes。{"tool_input": Claude の形の入力,
    "original": 書き込む前の本文か None} の一覧）を turn_writes() と同じ形にする。agy の会話記録は Claude の形でないので、
    transcript から拾えない。turn_writes が無ければ None。"""
    given = payload.get("turn_writes")
    if not isinstance(given, list):
        return None
    writes = {}
    for item in given:
        tool_input = item.get("tool_input") if isinstance(item, dict) else None
        if not isinstance(tool_input, dict):
            continue
        original = item.get("original") if isinstance(item.get("original"), str) else None
        for path in written_paths(tool_input, cwd):
            writes.setdefault(path, []).append((tool_input, original))
    return list(writes.items())


def turn_writes(transcript_path, cwd):
    """最後のユーザープロンプト以降に書き込めたパスごとに、(パス, [(書き込みの入力, 書き込む前の本文), ...])
    を現れた順に返す。本文は toolUseResult の originalFile で、分からなければ None。

    失敗した Edit（is_error の tool_result）、結果がまだ無い tool_use、書いていない（staged）結果は採らない。
    """
    if not isinstance(transcript_path, str) or not os.path.isfile(transcript_path):
        return []
    written = []
    succeeded = {}
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict):
                    continue
                if is_user_prompt(entry):
                    written, succeeded = [], {}
                    continue
                if entry.get("isSidechain"):
                    continue
                message = entry.get("message")
                content = message.get("content") if isinstance(message, dict) else None
                if not isinstance(content, list):
                    continue
                results = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"]
                # toolUseResult は entry に 1 つなので、tool_result が 1 つの entry だけで対応が決まる
                result = entry.get("toolUseResult") if len(results) == 1 else None
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_result" and not block.get("is_error"):
                        identifier = block.get("tool_use_id")
                        staged = isinstance(result, dict) and result.get("staged") is True
                        if isinstance(identifier, str) and identifier and not staged:
                            succeeded[identifier] = result
                        continue
                    if block.get("type") != "tool_use" or block.get("name") not in WRITE_TOOLS:
                        continue
                    identifier = block.get("id")
                    tool_input = block.get("input")
                    if not isinstance(identifier, str) or not isinstance(tool_input, dict):
                        continue
                    for path in written_paths(tool_input, cwd):
                        written.append((identifier, path, tool_input))
    except OSError:
        return []
    writes = {}
    for identifier, path, tool_input in written:
        if identifier in succeeded:
            writes.setdefault(path, []).append((tool_input, original_of(succeeded[identifier])))
    return list(writes.items())


def is_instruction_file(path):
    """エージェント向けの指示文と作業メモ、契約書の条文。書き直さない。"""
    parts = os.path.normpath(path).lower().split(os.sep)
    name = parts[-1]
    return (name in INSTRUCTION_NAMES
            or INSTRUCTION_NAME_RE.match(name) is not None
            or any(p in INSTRUCTION_DIRS or p in LEGAL_DIRS for p in parts[:-1]))


def ends_with_newline(text):
    return text if text.endswith("\n") else text + "\n"


def diff_text(original, rewritten, name, limit):
    body = "".join(difflib.unified_diff(
        ends_with_newline(original).splitlines(True),
        ends_with_newline(rewritten).splitlines(True),
        fromfile=name, tofile=name + "（書き直し後）"))
    if len(body) > limit:
        body = body[:limit] + "\n（以下省略）"
    return body


def diff_directory():
    return os.path.join(tempfile.gettempdir(), DIFF_DIR)


def diff_file(original, rewritten, name):
    """差分を $TMPDIR に書いてそのパスを返す。書けなければ None。"""
    body = diff_text(original, rewritten, name, MAX_DIFF)
    directory = diff_directory()
    try:
        os.makedirs(directory, 0o700, exist_ok=True)
    except OSError:
        return None
    prune(directory)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.basename(name)) or "body"
    try:
        handle, path = tempfile.mkstemp(dir=directory, prefix=slug + "-", suffix=".diff")
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            fh.write(body)
    except OSError:
        return None
    return path


def diff_note(original, rewritten, name):
    path = diff_file(original, rewritten, name)
    return "差分: %s" % path if path else "差分は書き出せなかった"


def emit(payload):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def vocab_notice(where, result):
    return "%s に、%sで避けるとしている語がある: %s。括弧内は言い換え候補。" % (
        where, GUIDE, listed(result))


def hook_stop(payload):
    if payload.get("stop_hook_active"):
        return
    deadline = time.monotonic() + DEADLINE
    parts = []
    notes = []
    done = []
    diffs = []
    unsafe = []
    skipped = []
    cwd = payload.get("cwd") or ""
    given = given_writes(payload, cwd)
    for path, writes in turn_writes(payload.get("transcript_path"), cwd) if given is None else given:
        if not path.lower().endswith(TEXT_EXTENSIONS) or is_instruction_file(path):
            continue
        raw = read_raw(path)
        if raw is None:
            continue
        text = normalize(raw)
        lines = changed_lines(writes, text, path, cwd)
        if lines is not None and not lines:
            continue
        result = vocab_result(lines_of(text, lines))
        if prose_japanese_length(text) < MIN_JAPANESE:
            if over_threshold(result):
                parts.append(vocab_notice(path, result))
            continue
        if cached(text):
            continue
        if time_left(deadline) < MIN_SLICE:
            skipped.append(path)
            continue
        body, cause = rewrite(text, result, mode="stop", deadline=deadline,
                              doc_type=ja_yomiyasu.detect_doc_type(text, path))
        if body is None:
            if cause == "unsafe_rewrite":
                unsafe.append(path)
            elif over_threshold(result):
                parts.append(vocab_notice(path, result))
            continue
        taken = None
        if body and lines is not None:
            body, taken = confine(raw, normalize(body), lines)
            if body == raw:
                body = ""
            elif not safe(text, normalize(body)):
                log_failure("stop", "unsafe_rewrite confined", text)
                unsafe.append(path)
                continue
        if not body:
            remember(text)
            if over_threshold(result):
                parts.append(vocab_notice(path, result))
            continue
        # 書き直し役が空白を入れ直した行を、書いた直後の hook と同じ規則で詰め直す
        if taken is None:
            updated = restore(ja_spacing.tighten(normalize(body)), raw)
        else:
            updated = ja_spacing.tighten(body, taken)
        written, problem = replace_file(path, raw, updated)
        if not written:
            notes.append("%s の日本語を書き直したが、%s" % (path, problem))
            continue
        remember(normalize(updated))
        diff = diff_file(text, normalize(updated), path)
        if diff:
            diffs.append(diff)
        done.append(path)
    if done:
        where = "（差分: %s）" % diff_directory() if diffs else ""
        notes.insert(0, "%d ファイルを書き直した%s" % (len(done), where))
    if unsafe:
        notes.append("%d ファイルは安全確認で書き直しを見送った: %s" % (len(unsafe), " / ".join(unsafe)))
    if skipped:
        notes.append("時間切れで未処理: %s" % " / ".join(skipped))
    out = {}
    if notes:
        out["systemMessage"] = "ja-review: " + "\n".join(notes)
    if parts:
        out.update({"decision": "block", "reason": "\n\n".join(parts)})
    if out:
        emit(out)


def fragments(tool_input, path, cwd):
    """書き込みが入れた文字列の断片。ファイル全体を書いたときは None。"""
    if isinstance(tool_input.get("content"), str):
        return None
    if isinstance(tool_input.get("edits"), list):
        return [e.get("new_string") for e in tool_input["edits"] if isinstance(e, dict)]
    if "new_string" in tool_input:
        return [tool_input.get("new_string")]
    if isinstance(tool_input.get("command"), str) and _VOCAB is not None:
        return [fragment for rel, parts in _VOCAB.parse_patch(tool_input["command"])
                if os.path.normpath(os.path.join(cwd, rel)) == os.path.normpath(path)
                for fragment in parts]
    return None


def original_of(result):
    """Write / Edit の結果（transcript の toolUseResult か tool_response）にある、書き込む前の本文。

    新しいファイルは ""、書いていない（staged）か分からないときは None。
    """
    if not isinstance(result, dict) or result.get("staged") is True:
        return None
    if isinstance(result.get("originalFile"), str):
        return result["originalFile"]
    if result.get("type") == "create":
        return ""
    return None


def _opcodes(before, after):
    return difflib.SequenceMatcher(None, normalize(before).split("\n"), normalize(after).split("\n"),
                                   autojunk=False).get_opcodes()


def lines_since(before, after):
    """before から after で変わった行（after での 1 始まりの行番号）の集合。消しただけの所は含まない。"""
    return {j + 1 for tag, _, _, j1, j2 in _opcodes(before, after) if tag != "equal" for j in range(j1, j2)}


def written_lines(tool_input, before, after):
    """1 つの書き込みが after で変えた行。

    Edit は before の中の old_string の位置から決める。本文全体の行の差分だと、近くに同じ内容の行が
    あるとき、変えていない方の行を変えたと取り違える。
    """
    old, new = tool_input.get("old_string"), tool_input.get("new_string")
    if isinstance(old, str) and old and isinstance(new, str) and not tool_input.get("replace_all") \
            and before.count(old) == 1:
        start = normalize(before[:before.find(old)]).count("\n")
        return {start + n for n in lines_since(old, new)}
    return lines_since(before, after)


def carried(lines, before, after):
    """before での行番号を after での行番号に移す。書き換えられて対応の無い行は落とす。"""
    out = set()
    for tag, i1, i2, j1, j2 in _opcodes(before, after):
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1):
            out.update(j1 + n - i1 for n in lines if i1 < n <= i2)
    return out


def git_changed_lines(path):
    """HEAD から変わった行の番号の集合。git の管理外か HEAD に無いファイルは None（全行が新しい）。

    git を呼べなかったときは空の集合を返し、どの行も直さない。
    """
    directory, name = os.path.split(os.path.abspath(path))
    try:
        if subprocess.run(["git", "-C", directory, "rev-parse", "--is-inside-work-tree"],
                          capture_output=True, timeout=GIT_TIMEOUT).returncode != 0:
            return None
        tree = subprocess.run(["git", "-C", directory, "ls-tree", "-z", "HEAD", "--", name],
                              capture_output=True, timeout=GIT_TIMEOUT)
        if tree.returncode != 0:
            return set()
        if not tree.stdout:
            return None
        diff = subprocess.run(
            ["git", "-C", directory, "diff", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", name],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return set()
    if diff.returncode != 0:
        return set()
    lines = set()
    for m in HUNK_RE.finditer(diff.stdout):
        start = int(m.group(1))
        lines.update(range(start, start + int(m.group(2) or 1)))
    return lines


def changed_lines(writes, text, path, cwd):
    """書き込み（[(入力, 書き込む前の本文), ...]）で変わった、今の本文での行番号の集合。全行が新しいときは None。

    どの書き込みも前の本文が分かれば、書き込みごとに変えた行を求め、後の書き込みの行のずれに合わせて
    今の本文まで移す。分からなければ、Edit の断片は本文の中の位置で決め、Write と、同じ文字列が他の行にも
    あって位置を決められない断片は HEAD との差分で決める。後の書き込みで消えた断片は、その書き込みの行で
    足りるので見ない。
    """
    befores = [before for _, before in writes]
    if befores and all(isinstance(before, str) for before in befores):
        lines = set()
        for k, (tool_input, before) in enumerate(writes):
            after = befores[k + 1] if k + 1 < len(writes) else text
            lines = carried(lines, before, after) | written_lines(tool_input, before, after)
        return lines
    lines = set()
    for tool_input, _ in writes:
        parts = fragments(tool_input, path, cwd)
        unplaced = parts is None
        for fragment in parts or []:
            if not isinstance(fragment, str) or not fragment.strip():
                continue
            # stop が読むときには、書いた直後の hook が断片の空白を詰めている
            found = [f for f in (fragment, ja_spacing.tighten(fragment)) if f in text]
            if not found:
                continue
            placed = next((f for f in found if text.count(f) == 1), None)
            if placed is None:
                unplaced = True
                continue
            first = text.count("\n", 0, text.find(placed)) + 1
            span = placed[:-1] if placed.endswith("\n") else placed
            lines.update(range(first, first + span.count("\n") + 1))
        if unplaced:
            known = git_changed_lines(path)
            if known is not None:
                lines |= known
            elif parts is None:
                return None
    return lines


def lines_of(text, lines):
    """lines（1 始まりの行番号の集合）の行だけを残した本文。None なら全体。"""
    if lines is None:
        return text
    return "\n".join(line for n, line in enumerate(text.split("\n"), 1) if n in lines)


def _ending(line):
    return line[len(line.rstrip("\r\n")):]


def confine(raw, rewritten, lines):
    """rewritten の変更のうち、raw の lines の行だけを書き換えるものを raw に当てる。

    (本文, 書き換えを当てた後の本文での行番号の集合)。lines の外の行に触れる変更は捨てる。
    行数の同じ置き換えは 1 行ずつ、それ以外はまとまり全体が lines に収まるときだけ採る。
    挿入は前後どちらかの行が lines にあるときだけ採る。lines の外の行は、改行コードと末尾の空行も
    含めて raw のまま残し、採った行には置き換えた元の行の改行コードを付ける。
    """
    old_raw = RAW_LINE_RE.findall(raw)
    old = [normalize(line).rstrip("\n") for line in old_raw]
    new = rewritten.split("\n")
    if rewritten.endswith("\n"):
        new.pop()
    eol = "\r\n" if "\r\n" in raw else "\n"
    out = []
    taken = set()

    def take(line, end):
        if out and not _ending(out[-1]):
            out[-1] += eol
        out.append(line + end)
        taken.add(len(out))

    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            out.extend(old_raw[i1:i2])
            continue
        if tag == "replace" and i2 - i1 == j2 - j1:
            for i, j in zip(range(i1, i2), range(j1, j2)):
                if i + 1 in lines:
                    take(new[j], _ending(old_raw[i]))
                else:
                    out.append(old_raw[i])
            continue
        if i2 > i1:
            inside = all(i + 1 in lines for i in range(i1, i2))
            last = _ending(old_raw[i2 - 1])
        else:
            inside = i1 in lines or i1 + 1 in lines
            last = "" if i1 == len(old_raw) and old_raw and not _ending(old_raw[-1]) else eol
        if not inside:
            out.extend(old_raw[i1:i2])
            continue
        for j in range(j1, j2):
            take(new[j], last if j == j2 - 1 else eol)
    return "".join(out), taken


def known_word(finding):
    """ja-vocab-lint の単語表にもある slop_vocabulary。同じ語を 2 つの hook から指摘しない。"""
    if finding.get("rule") != "slop_vocabulary" or _VOCAB is None:
        return False
    word = re.search(r"「([^」]+)」", finding.get("message") or "")
    return bool(word and _VOCAB.scan(word.group(1))["hits"])


def lint_notice(path, findings):
    shown = ["%s 行目 %s: %s" % (f.get("line"), f.get("rule"), " ".join((f.get("snippet") or "").split())[:40])
             for f in findings[:POST_MAX_FINDINGS]]
    if len(findings) > POST_MAX_FINDINGS:
        shown.append("ほか %d 件" % (len(findings) - POST_MAX_FINDINGS))
    return ("%s に yomiyasu の lint の候補がある。%sに照らして直すものだけ直す（意味や用語を担う表現は残す）:\n%s"
            % (path, GUIDE, "\n".join("- " + line for line in shown)))


def spacing_notice(path, before, after):
    numbers = [str(n) for n, (a, b) in enumerate(
        zip(normalize(before).split("\n"), normalize(after).split("\n")), 1) if a != b]
    return ("%s の %s 行目で、日本語と英数字の間の半角の空白を詰めた（%s）。"
            "このファイルを続けて Edit するなら読み直す" % (path, "・".join(numbers), GUIDE))


def hook_post(payload):
    tool_input = payload.get("tool_input") or {}
    response = payload.get("tool_response")
    if isinstance(response, dict) and response.get("staged") is True:
        return
    cwd = payload.get("cwd") or ""
    deadline = time.monotonic() + POST_DEADLINE
    notes = []
    for path in written_paths(tool_input, cwd):
        if not path.lower().endswith(TEXT_EXTENSIONS) or is_instruction_file(path):
            continue
        if time_left(deadline) < 1:
            break
        raw = read_raw(path)
        if raw is None:
            continue
        text = normalize(raw)
        if not japanese_length(text):
            continue
        lines = changed_lines([(tool_input, original_of(response))], text, path, cwd)
        tightened = ja_spacing.tighten(raw, lines)
        if tightened != raw:
            written, _ = replace_file(path, raw, tightened)
            if written:
                text = normalize(tightened)
                notes.append(spacing_notice(path, raw, tightened))
        prose = ja_yomiyasu.html_text(text) if path.lower().endswith(".html") else text
        if not japanese_length(prose):
            continue
        findings = ja_yomiyasu.lint(prose, timeout=time_left(deadline))
        if not findings:
            continue
        findings = [f for f in findings
                    if (lines is None or f.get("line") in lines) and not known_word(f)]
        if findings:
            notes.append(lint_notice(path, findings))
    if notes:
        emit({"hookSpecificOutput": {
            "hookEventName": payload.get("hook_event_name") or "PostToolUse",
            "additionalContext": "\n\n".join(notes),
        }})


def deny(event, reason):
    emit({"hookSpecificOutput": {
        "hookEventName": event,
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }})


def hook_pre(payload):
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command")
    if not isinstance(command, str) or "gh" not in command:
        return
    event = payload.get("hook_event_name") or "PreToolUse"
    records = gh_bodies(command, payload.get("cwd") or "")
    if not records:
        return
    joined = "\n\n".join(r["text"] for r in records)
    if not japanese_length(joined):
        return
    if prose_japanese_length(joined) < PRE_MIN_JAPANESE:
        result = vocab_result(joined)
        if over_threshold(result):
            deny(event, vocab_notice("gh に渡す本文", result))
        return

    deadline = time.monotonic() + DEADLINE
    rewritten = []
    blocked = []
    skipped = []
    for record in records:
        result = vocab_result(record["text"])
        if time_left(deadline) < MIN_SLICE:
            skipped.append(record.get("path") or "gh に渡す本文")
            continue
        body, _ = rewrite(record["text"], result, mode="pre", deadline=deadline,
                          doc_type=record["doc_type"] or ja_yomiyasu.detect_doc_type(record["text"]))
        if body is None:
            if over_threshold(result):
                blocked.append(vocab_notice(record.get("path") or "gh に渡す本文", result))
            continue
        if body:
            rewritten.append((record, body))
    late = "時間切れで未処理: %s" % " / ".join(skipped) if skipped else ""
    if blocked:
        reason = "\n\n".join(blocked)
        if rewritten:
            reason += "\n\n書き直せた本文:\n%s" % "\n\n".join(body for _, body in rewritten)
        deny(event, reason + ("\n\n" + late if late else ""))
        return
    if not rewritten:
        if late:
            emit({"systemMessage": late})
        return

    notes = []
    replacements = []
    stranded = []
    for record, body in rewritten:
        if record["kind"] == "file":
            written, problem = replace_file(record["path"], record["raw"],
                                            restore(body, record["raw"]))
            if not written:
                notes.append("%s を書き直したが、%s。" % (record["path"], problem))
                continue
            notes.append("%s を書き直した。%s%s" % (
                record["path"],
                diff_note(record["text"], normalize(body), record["path"]),
                remaining(vocab_result(body))))
        elif record["token"] is None:
            stranded.append(body)
        else:
            replacements.append((record["token"], record["prefix"], body))
            notes.append("gh に渡す本文を書き直した。%s%s" % (
                diff_note(record["text"], normalize(body), "本文"),
                remaining(vocab_result(body))))
    if late:
        notes.append(late)

    command_line = (rebuild(command, replacements)
                    if replacements and rebuildable(command) else None)
    if stranded or (replacements and command_line is None):
        bodies = [body for record, body in rewritten if record["kind"] == "inline"]
        reason = ("gh に渡す本文を書き直し役（%s）が書き直した。次の本文に差し替えて実行すること:"
                  "\n%s%s" % (MODEL, "\n\n".join(bodies),
                              remaining(vocab_result("\n\n".join(bodies)))))
        if notes:
            reason += "\n\n" + "\n\n".join(notes)
        deny(event, reason)
        return
    if not notes:
        return
    out = {
        "hookEventName": event,
        "permissionDecision": "allow",
        "permissionDecisionReason": "書き直した本文でそのまま実行してよい。",
        "additionalContext": "\n\n".join(notes),
    }
    if command_line is not None:
        out["updatedInput"] = dict(tool_input, command=command_line)
    emit({"hookSpecificOutput": out})


def main(argv):
    if os.environ.get("JA_REVIEW_SKIP") or os.environ.get("JA_REVIEW_ACTIVE"):
        return 0
    if "--rewrite" in argv:
        text = normalize(sys.stdin.read())
        body, _ = rewrite(text, vocab_result(text), mode="manual",
                          doc_type=ja_yomiyasu.detect_doc_type(text))
        if body is None:
            sys.stderr.write("書き直せなかった（未実行・timeout・形式外のいずれか）\n")
            return 1
        if not body:
            sys.stderr.write("OK（書き直す必要なし）\n")
            return 0
        sys.stdout.write(ends_with_newline(body))
        return 0
    if "--hook" in argv:
        mode = argv[argv.index("--hook") + 1] if argv.index("--hook") + 1 < len(argv) else ""
        try:
            payload = json.load(sys.stdin)
        except Exception:
            return 0
        if mode == "post":
            hook_post(payload)
            return 0
        if _VOCAB is None:
            # 単語表が無いとコードと地の文を分けられず、コード内の日本語まで書き直しの対象に数えてしまう
            print(json.dumps({"systemMessage": "ja-review: dev-standards プラグインの ja-vocab-lint.py を読めないので、書き直しを止めた。プラグインを入れ直す"}, ensure_ascii=False))
            return 0
        if mode == "pre":
            hook_pre(payload)
        elif mode == "stop":
            hook_stop(payload)
        return 0
    sys.stderr.write(__doc__)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.exit(0)
