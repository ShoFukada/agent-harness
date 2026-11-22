"""顧客向けの印のある文書に、こちらの作業の事情（手元のパス・エージェントの仕組みの語）が混ざっていないかを見る（artifact-lint-hook.py が呼ぶ）。

common.md と ja-writing に「顧客には受け手が判断し行動するのに要ることだけを書く」とあるのに、直しが続いた（好みの集約 W05、11 月も続いた）。
「要ること」かは機械で決められないので、取り違えようのない内部の痕跡だけを拾って知らせる。語調と AI っぽい語は ja-review が書き直すので、ここでは見ない。
コード（pre・code・コードフェンス・インラインコード）の中は、操作手順として正当に書くことがあるので見ない。
"""

import re

META_RE = re.compile(r"<meta\b[^>]*>", re.I)
ATTR_RE = re.compile(r"""([\w-]+)\s*=\s*["']([^"']*)["']""")
CLIENT_COMMENT_RE = re.compile(r"<!--\s*audience:\s*client\s*-->", re.I)
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.S)
FRONTMATTER_CLIENT_RE = re.compile(r"(?m)^audience:[ \t]*[\"']?client[\"']?[ \t]*\r?$")
HTML_CODE_RE = re.compile(r"<(script|style|pre|code)\b.*?</\1>", re.S | re.I)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
TAG_RE = re.compile(r"<[^>]+>")
FENCE_RE = re.compile(r"(?ms)^ {0,3}(```|~~~).*?^ {0,3}\1")
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
LINK_RE = re.compile(r"""\b(?:href|src)\s*=\s*["']([^"']*)["']""", re.I)
# こちらの内部でしか使わないもの。顧客の文書に製品名として正当に出る語（Claude Code・Codex・Cloudflare Workers など。
# 見積もりの「ご担当者様がお使いになる Claude Code」）と、日本語の一般語（窓口・担当など）は入れない
LEAKS = [
    ("手元のパス", re.compile(r"/Users/[\w.-]+|/private/tmp/|/tmp/claude|/var/folders/|~/\.(?:claude|config)")),
    ("作業用の置き場", re.compile(r"scratchpad|worktree", re.I)),
    ("エージェントの仕組みの語", re.compile(r"(?a:\b(?:subagent|agy)\b)|サブエージェント|操縦席", re.I)),
]
MAX_HITS = 3


def is_client(text, markdown):
    if markdown:
        m = FRONTMATTER_RE.match(text)
        return bool(m and FRONTMATTER_CLIENT_RE.search(m.group(1)))
    for tag in META_RE.findall(COMMENT_RE.sub("", text)):
        attrs = {k.lower(): v for k, v in ATTR_RE.findall(tag)}
        if attrs.get("name", "").lower() == "audience" and attrs.get("content") == "client":
            return True
    return bool(CLIENT_COMMENT_RE.search(text))


def prose(text, markdown):
    if markdown:
        return INLINE_CODE_RE.sub("", FENCE_RE.sub("", FRONTMATTER_RE.sub("", text, count=1)))
    html = COMMENT_RE.sub("", HTML_CODE_RE.sub("", text))
    # リンク先は画面に出ないが顧客に渡るファイルに残るので、href・src の値も本文と一緒に見る
    links = " ".join(LINK_RE.findall(html))
    return TAG_RE.sub(" ", html) + " " + links


def problems(text, markdown=False):
    if not is_client(text, markdown):
        return []
    body = prose(text, markdown)
    out = []
    for name, rx in LEAKS:
        hits = sorted(set(m.group(0) for m in rx.finditer(body)))
        if hits:
            out.append("%s（%s）" % (name, "・".join(hits[:MAX_HITS]) + ("ほか" if len(hits) > MAX_HITS else "")))
    return out


def notice(path, found):
    return ("%s は顧客向けの印があるのに、こちらの作業の事情が本文に残っている: %s。顧客には受け手が判断し行動するのに要ることだけを書く"
            "（ja-writing「書き方の規則」）。消すか、顧客の言葉に置き換える。手順として顧客に見せるものならコードの書式に入れる"
            % (path, "、".join(found)))
