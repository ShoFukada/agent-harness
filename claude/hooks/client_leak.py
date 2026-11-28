"""顧客向けの印のある文書に、こちらの作業の事情が混ざっていないかを見る（artifact-lint-hook.py が呼ぶ）。

common.md と ja-writing に「顧客には受け手が判断し行動するのに要ることだけを書く」とあるのに、直しが続いた（好みの集約 W05、11 月も続いた）。
「要ること」かは機械で決められないので、顧客の文書で正当に使う言い方と取り違えにくい語だけを拾って知らせる:
手元のパス・エージェントの仕組みの語に加え、進行の状態（「貴社のご回答待ち」）と作り手の説明（「生成の記録」「今回の対応」の見出し）。
社内の期日のように語で決められないものは、ja-writing の共有前の確認（新しい読み手に読ませる）が受け持つ。
語調と AI っぽい語は ja-review が書き直すので、ここでは見ない。
コード（pre・code・コードフェンス・インラインコード）の中は、操作手順として正当に書くことがあるので見ない。
"""

import re

META_RE = re.compile(r"<meta\b[^>]*>", re.I)
ATTR_RE = re.compile(r"""([\w-]+)\s*=\s*["']([^"']*)["']""")
CLIENT_COMMENT_RE = re.compile(r"<!--\s*audience:\s*client\s*-->", re.I)
# medurance-web-docs の deck は誰向けかを .deck の data-audience に書く（社内は "internal"、顧客は "◯◯株式会社さま向け"）。
# meta の印を重ねて付ける決まりは無いので、こちらで両方を読む
DATA_AUDIENCE_TAG_RE = re.compile(r"<[a-z][^>]*\bdata-audience\s*=[^>]*>", re.I)
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.S)
FRONTMATTER_CLIENT_RE = re.compile(r"(?m)^audience:[ \t]*[\"']?client[\"']?[ \t]*\r?$")
HTML_CODE_RE = re.compile(r"<(script|style|pre|code)\b.*?</\1>", re.S | re.I)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
TAG_RE = re.compile(r"<[^>]+>")
FENCE_RE = re.compile(r"(?ms)^ {0,3}(```|~~~).*?^ {0,3}\1")
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
LINK_RE = re.compile(r"""\b(?:href|src)\s*=\s*["']([^"']*)["']""", re.I)
HTML_HEADING_RE = re.compile(r"<h[1-6]\b[^>]*>(.*?)</h[1-6]\s*>", re.S | re.I)
MD_HEADING_RE = re.compile(r"(?m)^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$")
# 製品名として顧客の文書に出る語（見積もりの「ご担当者様がお使いになる Claude Code」）と一般語（窓口・担当）は入れない。
# 待ちの語は結びの「ご確認をお待ちしております」に当たらない形にし、「」で括った画面の状態名（「AI確認待ち」）を除く。
# 「承認待ち」は申請の画面の状態として操作マニュアルに出るので入れない
WAIT = r"(?:ご|お)?(?:回答|確認|返事|返答|連絡)待ち"
STATUS_LABEL_RE = re.compile(r"「[A-Za-z0-9ァ-ヺー・ ]{0,12}%s\s*」" % WAIT)
LEAKS = [
    ("手元のパス", re.compile(r"/Users/[\w.-]+|/private/tmp/|/tmp/claude|/var/folders/|~/\.(?:claude|config)")),
    ("作業用の置き場", re.compile(r"scratchpad|worktree", re.I)),
    ("エージェントの仕組みの語", re.compile(r"(?a:\b(?:subagent|agy)\b)|サブエージェント|操縦席", re.I)),
    ("進行の状態の語", re.compile(WAIT)),
    ("作り手の説明", re.compile(r"生成の記録|修正版と同じ")),
]
# 本文の中の「今回の対応により解消しました」は障害報告で正当に書くので、見出しに立てたときだけ拾う
HEADING_LEAKS = [
    ("作り手の説明", re.compile(r"^\s*今回の(?:対応|変更点|変更|修正)")),
]
MAX_HITS = 3


def deck_audience(html):
    """deck の data-audience を client / internal に読み替える（ja-review の語調の判定もこれを使う）。無ければ None。"""
    for tag in DATA_AUDIENCE_TAG_RE.findall(html):
        attrs = {k.lower(): v for k, v in ATTR_RE.findall(tag)}
        value = attrs.get("data-audience", "").strip()
        if "deck" in attrs.get("class", "").split() and value:
            return "internal" if value == "internal" or value.startswith("社内") else "client"
    return None


def is_client(text, markdown):
    if markdown:
        m = FRONTMATTER_RE.match(text)
        return bool(m and FRONTMATTER_CLIENT_RE.search(m.group(1)))
    html = COMMENT_RE.sub("", HTML_CODE_RE.sub("", text))
    for tag in META_RE.findall(html):
        attrs = {k.lower(): v for k, v in ATTR_RE.findall(tag)}
        if attrs.get("name", "").lower() == "audience" and attrs.get("content") == "client":
            return True
    return deck_audience(html) == "client" or bool(CLIENT_COMMENT_RE.search(text))


def _markdown_body(text):
    body = FENCE_RE.sub("", FRONTMATTER_RE.sub("", text, count=1))
    return HTML_CODE_RE.sub("", INLINE_CODE_RE.sub("", body))


def _html_body(text):
    return COMMENT_RE.sub("", HTML_CODE_RE.sub("", text))


def prose(text, markdown):
    if markdown:
        return STATUS_LABEL_RE.sub("", _markdown_body(text))
    html = _html_body(text)
    # リンク先は画面に出ないが顧客に渡るファイルに残るので、href・src の値も本文と一緒に見る
    links = " ".join(LINK_RE.findall(html))
    return STATUS_LABEL_RE.sub("", TAG_RE.sub(" ", html)) + " " + links


def headings(text, markdown):
    if markdown:
        return MD_HEADING_RE.findall(_markdown_body(text))
    return [TAG_RE.sub("", h).strip() for h in HTML_HEADING_RE.findall(_html_body(text))]


def problems(text, markdown=False):
    if not is_client(text, markdown):
        return []
    body = prose(text, markdown)
    heads = headings(text, markdown)
    found = {}
    for name, rx in LEAKS:
        found.setdefault(name, set()).update(m.group(0) for m in rx.finditer(body))
    for name, rx in HEADING_LEAKS:
        found.setdefault(name, set()).update(h for h in heads if rx.search(h))
    out = []
    for name, hits in found.items():
        if hits:
            hits = sorted(hits)
            out.append("%s（%s）" % (name, "・".join(hits[:MAX_HITS]) + ("ほか" if len(hits) > MAX_HITS else "")))
    return out


def notice(path, found):
    return ("%s は顧客向けの印があるのに、こちらの作業の事情が本文に残っている: %s。顧客には受け手が判断し行動するのに要ることだけを書く"
            "（ja-writing「成果物ごとの規律」）。消すか、顧客の言葉に置き換える。"
            "こちらや相手の返事を待っている状態と、作り手の説明（何を変えた・何と同じか・どう作ったか）は書かない。"
            "画面の状態名として書くなら「」で括り、手順として見せるパスやコマンドはコードの書式に入れる"
            % (path, "、".join(found)))
