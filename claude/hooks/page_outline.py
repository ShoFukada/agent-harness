"""説明・報告の HTML のページが、背景と前提の章から入り、図を持つかを見る（artifact-lint-hook.py が呼ぶ）。

common.md「書く」と ja-writing の references/pages.mdに章立ての決まりがあるのに、背景を飛ばした・図の無いページを
作って直され続けた（好みの集約 O03、11 月に 4 回以上）。文の決まりだけでは止まらないので、書いた直後に知らせる。
短いページ・章の少ないページ・顧客向けの印のあるページ（提案書や LP は別の章立て）は見ない。
"""

import re

H2_RE = re.compile(r"<h2\b[^>]*>(.*?)</h2>", re.S | re.I)
TAG_RE = re.compile(r"<[^>]+>")
HIDDEN_RE = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)
JAPANESE_RE = re.compile(r"[ぁ-ゖァ-ヺ一-龯]")
BACKGROUND_RE = re.compile(r"背景|前提|経緯|いきさつ|なぜ")
FIGURE_RE = re.compile(r"<svg\b|<img\b[^>]*\.svg\b", re.I)
META_RE = re.compile(r"<meta\b[^>]*>", re.I)
ATTR_RE = re.compile(r"""([\w-]+)\s*=\s*["']([^"']*)["']""")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
CLIENT_COMMENT_RE = re.compile(r"<!--\s*audience:\s*client\s*-->", re.I)
MIN_JAPANESE = 800
MIN_SECTIONS = 3


def is_client(html):
    for tag in META_RE.findall(html):
        attrs = {k.lower(): v for k, v in ATTR_RE.findall(tag)}
        if attrs.get("name", "").lower() == "audience" and attrs.get("content") == "client":
            return True
    return bool(CLIENT_COMMENT_RE.search(html))


def problems(html):
    if is_client(html):
        return []
    body = COMMENT_RE.sub("", HIDDEN_RE.sub("", html))
    heads = [TAG_RE.sub("", h).strip() for h in H2_RE.findall(body)]
    if len(heads) < MIN_SECTIONS or len(JAPANESE_RE.findall(TAG_RE.sub("", body))) < MIN_JAPANESE:
        return []
    out = []
    if not BACKGROUND_RE.search(heads[0]):
        out.append("最初の章「%s」が背景と前提になっていない" % heads[0][:30])
    if not FIGURE_RE.search(body):
        out.append("仕組み・流れ・変更の前後を見せる SVG の図が無い")
    return out


def notice(path, found):
    return ("%s は、説明・報告のページの章立て（common.md「書く」、ja-writing の references/pages.md: 背景と前提 → 結論 → "
            "全体像の図 → 各論 → 未検証と残る判断）から外れている: %s。説明・報告のページでなければそのままでよい"
            % (path, "、".join(found)))
