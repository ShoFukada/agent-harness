"""
JA_YOMIYASU_DIR で置き場（既定 ~/.local/share/yomiyasu）を差し替えられる。darwin-rebuild switch の前に、
flake.lock の版で試すため。

SKILL.md の 1 章から 5 節を外すのは、見出し・太字・読点・装飾記号を直させると
「Markdown の構造を保つ」とぶつかるため（構造の直しは lint で Claude に返す）。
"""

import html.parser
import json
import os
import re
import subprocess
import tempfile

ROOT_ENV = "JA_YOMIYASU_DIR"
DEFAULT_ROOT = "~/.local/share/yomiyasu"
CHAPTER = "## 1. 基本原則"
NEXT_CHAPTER = "## 2. "
STRUCTURAL_SECTIONS = (
    "### 文長と読点の調整",
    "### 太字とラベル",
    "### 2文の否定対比と「もちろん、」",
    "### 案内用の見出し",
    "### 装飾記号の排除と太字の表示、コピー調の抑制",
)
# 外した 5 節の前置き。残すと、続く「直訳語」の節だけが lint の外で当てる節のように読める
LEAD_IN = "次の直しは、lint に出なくても当てます。"
DOC_TYPES = ("pr", "article", "incident", "proposal", "minutes", "manual", "slides",
             "essay", "formal", "promo", "mail", "paper", "script")
FILENAME_TYPES = (
    ("minutes", ("議事録", "minutes")),
    ("proposal", ("提案", "proposal")),
    ("manual", ("マニュアル", "manual", "手順")),
    ("formal", ("規程", "契約", "仕様", "定義書")),
    ("mail", ("メール", "mail")),
)
DOC_TYPE_RE = re.compile(
    r"\A---\n(?:.*\n)*?doc-type:\s*[\"']?([a-z]+)[\"']?\s*\n(?:.*\n)*?---\n"
    r"|<meta\s+name=[\"']doc-type[\"']\s+content=[\"']([a-z]+)[\"']"
    r"|<!--\s*doc-type:\s*([a-z]+)\s*-->")
# 16 文書で 89 件のうち、箇条書きの比率・ラベルの行のコロン・太字の数で 4 割を占め、業務文書では普通の書き方なので出さない
LINT_SKIP = {"excess_list", "trailing_colon", "excess_bold", "bold_label_list"}
# 書き直しを捨てる意味の変化。否定は「無い→ない」も変化と数えるので使わない（否定の数は ja-review の safe() が見る）
REJECT_KINDS = {"modality", "sentence_type", "number"}
TOOL_TIMEOUT = 20
HTML_RE = re.compile(r"<(?:!doctype|html|body|p|div|section|article|table|li)\b", re.I)


class Unavailable(Exception):
    """yomiyasu が置かれていないか、切り出す見出しが見つからない。"""


def root():
    base = os.environ.get(ROOT_ENV) or os.path.expanduser(DEFAULT_ROOT)
    return os.path.join(base, "skills", "yomiyasu")


def _read(*parts):
    path = os.path.join(root(), *parts)
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        raise Unavailable("%s を読めない" % path)


def principles():
    """SKILL.md の 1 章から構造に触る 5 節を外した本文。見出しが変わっていたら Unavailable。"""
    skill = _read("SKILL.md")
    start = skill.find(CHAPTER)
    end = skill.find("\n" + NEXT_CHAPTER, start)
    if start < 0 or end < 0:
        raise Unavailable("SKILL.md に「%s」の章が無い" % CHAPTER)
    lines = skill[start:end].splitlines()
    missing = [h for h in STRUCTURAL_SECTIONS if h not in lines]
    if missing:
        raise Unavailable("SKILL.md に外す節が無い: %s" % " / ".join(missing))
    kept = []
    dropping = False
    for line in lines[1:]:
        if line.startswith("### "):
            dropping = line in STRUCTURAL_SECTIONS
        if not dropping and line.strip() != LEAD_IN:
            kept.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def detect_doc_type(text, path=None):
    """文書の種類。本文の印（frontmatter の doc-type:、HTML の meta、コメント）> ファイル名。決まらなければ None。"""
    m = DOC_TYPE_RE.search(text or "")
    if m:
        found = next(g for g in m.groups() if g)
        return found if found in DOC_TYPES else None
    name = os.path.basename(path or "").lower()
    for kind, words in FILENAME_TYPES:
        if any(word in name for word in words):
            return kind
    return None


def gemini_block(doc_type=None, client=False):
    parts = [
        "\n次の yomiyasu の規則にも従ってください。上の規則と食い違うときは上の規則を優先してください。"
        "Markdown の構造（見出し・箇条書き・表・太字）は変えないでください。"
        "規則の中で「尋ねる」「変えたところ」「書き手に確かめたい点」に回すとしている箇所は、直さずに元のまま残し、"
        "欄や注記は出さないでください。\n",
        "--- yomiyasu: 基本原則 ---\n" + principles(),
    ]
    if doc_type:
        parts.append("--- yomiyasu: 文書の種類 %s ---\n%s" % (doc_type, _read("references", "doc-types", doc_type + ".md").strip()))
    if client:
        parts.append("--- yomiyasu: 書き手と読み手 ---\n" + _read("references", "persona.md").strip())
    return "\n\n".join(parts) + "\n"


class _Prose(html.parser.HTMLParser):
    """地の文だけを残し、タグの中の改行は残して行番号を元の HTML とそろえる。"""

    SKIP = {"script", "style", "svg", "code", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        self.out.append("\n" * (self.get_starttag_text() or "").count("\n"))
        if tag in self.SKIP:
            self.depth += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        self.out.append(data if not self.depth else "\n" * data.count("\n"))

    def handle_comment(self, data):
        self.out.append("\n" * data.count("\n"))


def html_text(raw):
    parser = _Prose()
    parser.feed(raw or "")
    parser.close()
    return "".join(parser.out)


def _run(script, args, stdin, cwd, timeout):
    done = subprocess.run(
        ["python3", os.path.join(root(), "scripts", script)] + args,
        input=stdin, cwd=cwd, timeout=max(1, min(TOOL_TIMEOUT, timeout or TOOL_TIMEOUT)), check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return json.loads(done.stdout)


def lint(text, timeout=None):
    """yomiyasu_lint の候補（LINT_SKIP を除く）。動かせなければ None。"""
    if not os.path.isfile(os.path.join(root(), "scripts", "yomiyasu_lint.py")):
        return None
    try:
        # 作業フォルダの .yomiyasu-words を拾わないよう、空の一時フォルダで動かす
        with tempfile.TemporaryDirectory(prefix="ja-yomiyasu-") as workdir:
            found = _run("yomiyasu_lint.py", ["--json", "--no-words", "-"], text, workdir, timeout)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return [f for f in found.get("findings", []) if f.get("rule") not in LINT_SKIP]


def meaning_risks(original, rewritten, doc_type=None, timeout=None):
    """書き直しを捨てる理由になる意味の変化の種類。動かせなければ None（判定しない）。"""
    if not os.path.isfile(os.path.join(root(), "scripts", "yomiyasu_diff.py")):
        return None
    if HTML_RE.search(original or ""):
        # yomiyasu_diff は HTML のブロックを変えない箇所として扱い、中の文の変化を数えない
        original, rewritten = html_text(original), html_text(rewritten)
    args = ["--json", "--no-words"] + (["--doc-type", doc_type] if doc_type in DOC_TYPES else [])
    try:
        # yomiyasu_diff は作業フォルダの外のファイルを読まないので、両方を一時フォルダに置く
        with tempfile.TemporaryDirectory(prefix="ja-yomiyasu-") as workdir:
            for name, body in (("before.md", original), ("after.md", rewritten)):
                with open(os.path.join(workdir, name), "w", encoding="utf-8") as fh:
                    fh.write(body)
            found = _run("yomiyasu_diff.py", args + ["before.md", "after.md"], None, workdir, timeout)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    kinds = [r.get("kind") for r in found.get("meaning_risks", []) if r.get("kind") in REJECT_KINDS]
    if found.get("added_actors"):
        kinds.append("added_actors")
    return kinds
