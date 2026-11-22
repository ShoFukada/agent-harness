#!/usr/bin/env python3
"""HTML のページで、意図せず文字が折り返すレイアウトを検出する。

- grid/flex コンテナ直下での生テキストと inline 要素の混在（1 文字ずつ折り返す）
- 狭い max-width の枠に入った表・図・カードの並び（ページの途中の幅で折り返す）
- 見出しや表より狭い max-width で折り返す段落・リスト・blockquote と、それらを包む枠
  （ページは 1 つの同じ幅の列に並べ、幅は列に 1 つだけ掛ける。ja-writing の references/pages.md「ページの幅」）
"""

import argparse
import os
import re
import stat
import sys
from html.parser import HTMLParser

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

# 暗黙終了。html.parser は補完しないので、閉じ忘れで木が歪むのを最小限だけ防ぐ。
AUTO_CLOSE = {
    "li": {"li"},
    "dt": {"dt", "dd"},
    "dd": {"dt", "dd"},
    "tr": {"tr", "td", "th"},
    "td": {"td", "th"},
    "th": {"td", "th"},
    "option": {"option"},
    "thead": {"tr", "td", "th"},
    "tbody": {"tr", "td", "th"},
    "tfoot": {"tr", "td", "th"},
}
P_CLOSERS = {
    "address", "article", "aside", "blockquote", "details", "div", "dl",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
    "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
    "section", "table", "ul",
}
TABLE_TAGS = {"table", "thead", "tbody", "tfoot", "tr"}

CONDITIONAL_AT_RULES = {"media", "supports", "container"}
NESTING_AT_RULES = CONDITIONAL_AT_RULES | {"layer", "scope"}
FLEXGRID_VALUES = {"flex", "grid", "inline-flex", "inline-grid"}

PHRASING_TAGS = {
    "code", "kbd", "samp", "var", "a", "em", "strong", "b", "i", "span",
    "abbr", "time", "small", "mark", "q", "cite",
}

TRACKED_PROPS = (
    "display", "position", "content", "grid-template-columns", "grid-auto-flow",
    "max-width", "flex-wrap", "flex-flow",
)

UNIT_PX = {"px": 1.0, "rem": 16.0, "em": 16.0, "ch": 8.0}
NARROW_PX = 48.0
MARKER_CHARS = 2
MAX_TRACKS = 1000
MAX_BYTES = 20 * 1024 * 1024

MAX_ELEMENTS_PER_SELECTOR = 3
PREVIEW_CHARS = 72

FIX_HINT = """  直し方: コンテナ直下は要素ノードだけにする。
    - マーカー付きリストは grid をやめ、padding-left + position:absolute の ::before で組む
    - grid/flex を使うなら、テキスト側の中身をまとめて1個の <span> で包んで1セルにする"""

PROSE_WIDTH_PX = 900.0
PROSE_CARRIERS = {
    "p", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "figcaption", "caption",
    "summary", "h1", "h2", "h3", "h4", "h5", "h6",
}
INLINE_CONTEXT = PHRASING_TAGS | PROSE_CARRIERS | {"button", "label", "td", "th"}
ICON_SVG_PX = 120.0
CARD_TAGS = {"div", "article", "section", "li", "figure", "aside", "blockquote"}
CARD_TEXT_CHARS = 20
NARROW_OK_ATTR = "data-narrow"

TEXT_TAGS = {"p", "ul", "ol", "blockquote"}
NEIGHBOR_TAGS = {
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "blockquote", "dl",
    "table", "pre", "figure", "details", "summary", "hr", "svg",
}
# 目次・脇・足もと・浮いた部品は列の外にあり、列の幅の比べに入れない
OFF_COLUMN_TAGS = {"nav", "aside", "footer", "dialog", "table", "figure", "button", "label"}
SAME_WIDTH_SLACK_PX = 48.0

WIDTH_FIX_HINT = """  直し方: 見出し・文章・表・図・カードを 1 つの同じ幅の列に並べる。
    max-width はページ全体の列（.wrap など、目安 1100px）に 1 つだけ掛け、
    p・ul・ol・blockquote・節（section）・本文の枠（.prose など）には別の max-width を掛けない。
    意図して狭くする表・図（1 列の短い表など）は、その要素か枠に data-narrow 属性を付けると外れる"""


class Node(object):
    __slots__ = ("tag", "attrs", "classes", "ident", "style", "parent", "children",
                 "line", "start", "end")

    def __init__(self, tag, attrs=None, parent=None, line=0, start=0):
        self.tag = tag
        self.attrs = {}
        self.classes = set()
        self.ident = None
        self.style = ""
        if attrs:
            for name, value in attrs:
                self.attrs[name] = value or ""
                if value is None:
                    continue
                if name == "class":
                    self.classes.update(value.split())
                elif name == "id":
                    self.ident = value
                elif name == "style":
                    self.style = value.lower()
        self.parent = parent
        self.children = []
        self.line = line
        self.start = start
        self.end = None


class TextNode(object):
    __slots__ = ("text",)

    def __init__(self, text):
        self.text = text


class Tree(HTMLParser):
    def __init__(self, line_offsets):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]
        self.styles = []
        self.line_offsets = line_offsets
        self._in_style = False
        self._template = 0

    def _abs_pos(self):
        lineno, offset = self.getpos()
        idx = lineno - 1
        if 0 <= idx < len(self.line_offsets):
            return self.line_offsets[idx] + offset
        return 0

    def _pop_through(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                pos = self._abs_pos()
                for node in self.stack[i:]:
                    node.end = pos
                del self.stack[i:]
                return True
        return False

    def _implicit_close(self, tag):
        closable = AUTO_CLOSE.get(tag)
        if closable and self.stack[-1].tag in closable:
            self.stack.pop().end = self._abs_pos()
        elif tag in P_CLOSERS and self.stack[-1].tag == "p":
            self.stack.pop().end = self._abs_pos()

    def handle_starttag(self, tag, attrs):
        if tag == "template":
            self._template += 1
            return
        if self._template:
            return
        if tag == "style":
            self._in_style = True
            return
        if tag in VOID_TAGS:
            self.handle_startendtag(tag, attrs)
            return
        self._implicit_close(tag)
        node = Node(tag, attrs, self.stack[-1], self.getpos()[0], self._abs_pos())
        self.stack[-1].children.append(node)
        self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        if tag == "template" or self._template or tag == "style":
            return
        self._implicit_close(tag)
        node = Node(tag, attrs, self.stack[-1], self.getpos()[0], self._abs_pos())
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag):
        if tag == "template":
            if self._template:
                self._template -= 1
            return
        if self._template:
            return
        if tag == "style":
            self._in_style = False
            return
        if tag in VOID_TAGS:
            return
        self._pop_through(tag)

    def handle_data(self, data):
        if self._template:
            return
        if self._in_style:
            self.styles.append(data)
            return
        parent = self.stack[-1]
        if parent.tag == "script":
            return
        if parent.children and isinstance(parent.children[-1], TextNode):
            parent.children[-1].text += data
        else:
            parent.children.append(TextNode(data))


def strip_css_comments(css):
    return re.sub(r"/\*.*?\*/", " ", css, flags=re.S)


def _match_block(css, start):
    depth = 0
    i = start
    quote = None
    while i < len(css):
        ch = css[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def has_nested_block(body):
    quote = None
    i = 0
    while i < len(body):
        ch = body[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "{":
            return True
        i += 1
    return False


def iter_rules(css, conditional=False):
    i = 0
    n = len(css)
    while i < n:
        brace = css.find("{", i)
        semi = css.find(";", i)
        if brace < 0:
            return
        if 0 <= semi < brace:
            i = semi + 1
            continue
        prelude = css[i:brace].strip()
        end = _match_block(css, brace)
        if end < 0:
            return
        body = css[brace + 1:end]
        if prelude.startswith("@"):
            name = re.match(r"@([\w-]+)", prelude)
            if name and name.group(1).lower() in NESTING_AT_RULES:
                nested = conditional or name.group(1).lower() in CONDITIONAL_AT_RULES
                for rule in iter_rules(body, nested):
                    yield rule
        elif prelude and not has_nested_block(body):
            yield prelude, body, conditional
        i = end + 1


def split_top_level(value):
    parts = []
    depth = 0
    buf = []
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if depth == 0 and ch.isspace():
            if buf:
                parts.append("".join(buf))
                buf = []
            continue
        buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return parts


LENGTH_RE = re.compile(r"^(-?\d*\.?\d+)(px|rem|em|ch)$")
NEGATIVE_RE = re.compile(r"-\d*\.?\d+(?:px|rem|em|ch|%|fr)")


def split_args(args):
    parts, depth, start = [], 0, 0
    for i, ch in enumerate(args):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(args[start:i])
            start = i + 1
    parts.append(args[start:])
    return parts


def track_width_px(token):
    """静的に評価できる固定幅なら px 値、できなければ None。"""
    token = token.strip().lower()
    if token == "0":
        return 0.0
    if token.startswith("minmax(") and token.endswith(")"):
        args = split_args(token[len("minmax("):-1])
        return track_width_px(args[1]) if len(args) == 2 else None
    m = LENGTH_RE.match(token)
    if not m:
        return None
    return float(m.group(1)) * UNIT_PX[m.group(2)]


def expand_tracks(value):
    """[(狭いか, 元のトークン)] を返す。列数が確定しない値は None。"""
    value = re.sub(r"\[[^\]]*\]", " ", value).strip().lower()
    if not value or "subgrid" in value or value == "none":
        return None
    if NEGATIVE_RE.search(value):
        return None
    tracks = []
    for token in split_top_level(value):
        if not token:
            continue
        if token.startswith("var("):
            return None
        if token.startswith("repeat("):
            if not token.endswith(")"):
                return None
            head, _, rest = token[len("repeat("):-1].partition(",")
            head = head.strip()
            if not head.isdigit() or int(head) > MAX_TRACKS:
                return None
            sub = expand_tracks(rest)
            if sub is None or int(head) * len(sub) > MAX_TRACKS:
                return None
            tracks.extend(sub * int(head))
        else:
            width = track_width_px(token)
            tracks.append((width is not None and width <= NARROW_PX, token))
        if len(tracks) > MAX_TRACKS:
            return None
    return tracks or None


PSEUDO_ELEMENT_RE = re.compile(r"(::?(?:before|after))\s*$", re.I)
COMPOUND_RE = re.compile(r"^(?:([A-Za-z][\w-]*)|(\*))?((?:[.#][\w-]+)*)$")
UNSUPPORTED_RE = re.compile(r"[\[\]()+~,|^$=\"']")


def parse_selector(selector):
    """(parts, pseudo) を返す。対応外の記法は (None, None)。"""
    sel = selector.strip()
    if not sel:
        return None, None
    pseudo = None
    m = PSEUDO_ELEMENT_RE.search(sel)
    if m:
        pseudo = m.group(1).lower().lstrip(":")
        sel = sel[:m.start()].strip()
    if not sel or UNSUPPORTED_RE.search(sel) or ":" in sel or "\\" in sel:
        return None, None

    tokens = re.split(r"\s*(>)\s*|\s+", sel)
    parts = []
    combinator = None
    child_combinator = False
    for token in tokens:
        if token is None or token == "":
            continue
        if token == ">":
            combinator = ">"
            child_combinator = True
            continue
        cm = COMPOUND_RE.match(token)
        if not cm:
            return None, None
        tag = cm.group(1)
        classes = set()
        ident = None
        for piece in re.findall(r"[.#][\w-]+", cm.group(3) or ""):
            if piece[0] == ".":
                classes.add(piece[1:])
            else:
                ident = piece[1:]
        parts.append((combinator, tag.lower() if tag else None, classes, ident))
        combinator = " "
    if not parts:
        return None, None
    # tbody は自動挿入されるので、自前のツリーでは table > tr の一致が実際とずれる
    if child_combinator and any(p[1] in TABLE_TAGS for p in parts):
        return None, None
    return parts, pseudo


def compound_matches(node, tag, classes, ident):
    if tag and node.tag != tag:
        return False
    if ident and node.ident != ident:
        return False
    if classes and not classes.issubset(node.classes):
        return False
    return True


def selector_matches(node, parts, index=None):
    if index is None:
        index = len(parts) - 1
    combinator, tag, classes, ident = parts[index]
    if not compound_matches(node, tag, classes, ident):
        return False
    if index == 0:
        return True
    parent = node.parent
    if combinator == ">":
        if parent is None or parent.tag == "#root":
            return False
        return selector_matches(parent, parts, index - 1)
    while parent is not None and parent.tag != "#root":
        if selector_matches(parent, parts, index - 1):
            return True
        parent = parent.parent
    return False


def walk(node):
    for child in node.children:
        if isinstance(child, Node):
            yield child
            for sub in walk(child):
                yield sub


def last_decl(body, prop):
    value = None
    pattern = r"(?:^|[;}{])\s*%s\s*:\s*([^;!}]+)" % prop
    for m in re.finditer(pattern, body, re.I):
        value = m.group(1).strip().lower()
    return value


PLACEMENT_RE = re.compile(
    r"(?:^|[;}{])\s*(?:grid-(?:column|row|area)(?:-start|-end)?|order)\s*:", re.I)


def read_decls(body):
    decls = {}
    for prop in TRACKED_PROPS:
        value = last_decl(body, prop)
        if value is not None:
            decls[prop] = value
    if PLACEMENT_RE.search(body):
        decls["placement"] = True
    return decls


def collect_css(styles):
    rules = []
    candidates = {}
    for block in styles:
        css = strip_css_comments(block)
        for prelude, body, conditional in iter_rules(css):
            decls = read_decls(body)
            if not decls:
                continue
            for raw in prelude.split(","):
                parts, pseudo = parse_selector(raw)
                if parts is None:
                    continue
                rules.append((parts, pseudo, decls, conditional))
                if pseudo is None and decls.get("display") in FLEXGRID_VALUES:
                    candidates.setdefault(" ".join(raw.split()), parts)
    return rules, candidates


def line_offsets_of(source):
    offsets = [0]
    for line in source.splitlines(True):
        offsets.append(offsets[-1] + len(line))
    return offsets


def preview(source, node):
    stop = node.start + PREVIEW_CHARS * 6
    if node.end is not None:
        stop = min(stop, node.end)
    raw = source[node.start:stop]
    text = re.sub(r"\s+", " ", raw).strip()
    if len(text) > PREVIEW_CHARS:
        return text[:PREVIEW_CHARS] + "…"
    return text


def inner_text(node):
    out = []
    stack = list(node.children)
    while stack:
        child = stack.pop(0)
        if isinstance(child, TextNode):
            out.append(child.text)
        else:
            stack = list(child.children) + stack
    return "".join(out).strip()


def analyze(source):
    """(grid/flex の混在の指摘, 狭い枠の表・図の指摘, 狭い枠の文章の指摘) を返す。"""
    offsets = line_offsets_of(source)
    parser = Tree(offsets)
    parser.feed(source)
    parser.close()

    rules, candidates = collect_css(parser.styles)
    elements = list(walk(parser.root))
    computed = cascade(rules)
    width = width_findings(elements, computed)
    framed = set(id(f[0]) for f in width)
    text_width = [f for f in text_width_findings(elements, computed) if id(f[0]) not in framed]
    return layout_findings(elements, candidates, computed), width, text_width


def cascade(rules):
    cache = {}

    def computed(node, pseudo=None):
        """(全ルール, メディア条件外のみ)。詳細度は解決せず後勝ちと inline style 優先だけで決める。"""
        key = (id(node), pseudo)
        hit = cache.get(key)
        if hit is None:
            merged, static = {}, {}
            for parts, rule_pseudo, decls, conditional in rules:
                if rule_pseudo != pseudo or not selector_matches(node, parts):
                    continue
                merged.update(decls)
                if not conditional:
                    static.update(decls)
            if pseudo is None and node.style:
                inline = read_decls(node.style)
                merged.update(inline)
                static.update(inline)
            hit = cache[key] = (merged, static)
        return hit

    return computed


def layout_findings(elements, candidates, computed):
    if not candidates:
        return []
    track_cache = {}

    def is_marker(node, pseudo):
        decls = computed(node, pseudo)[0]
        content = decls.get("content")
        if not content or content in ("none", "normal"):
            return False
        if decls.get("display") == "none":
            return False
        return decls.get("position") not in ("absolute", "fixed")

    def is_out_of_flow(node):
        decls = computed(node)[0]
        if decls.get("display") == "none":
            return True
        return decls.get("position") in ("absolute", "fixed")

    def placement_overridden(node, children):
        flow = computed(node)[0].get("grid-auto-flow") or ""
        if "column" in flow or "dense" in flow:
            return True
        if any(computed(node, ps)[0].get("placement") for ps in ("before", "after")):
            return True
        for child in children:
            decls = computed(child)[0]
            if decls.get("placement") or decls.get("display") == "contents":
                return True
        return False

    def tracks_of(gtc):
        if gtc not in track_cache:
            track_cache[gtc] = expand_tracks(gtc)
        return track_cache[gtc]

    def narrow_cell(node, children):
        gtc = computed(node)[1].get("grid-template-columns")
        if not gtc:
            return None
        tracks = tracks_of(gtc)
        if not tracks or not any(narrow for narrow, _ in tracks):
            return None
        if placement_overridden(node, children):
            return None
        items = []
        if is_marker(node, "before"):
            items.append(("pseudo", None))
        for child in node.children:
            if isinstance(child, TextNode):
                if child.text.strip():
                    items.append(("text", None))
            elif not is_out_of_flow(child):
                # 1グリフのバッジは狭い列に収まる。潰れるのは中身が長いときだけ
                fits = len(inner_text(child)) <= MARKER_CHARS
                items.append(("elem", None if fits else child.tag))
        if is_marker(node, "after"):
            items.append(("pseudo", None))
        for i, (kind, tag) in enumerate(items):
            narrow, token = tracks[i % len(tracks)]
            if narrow and (kind == "text" or (kind == "elem" and tag in PHRASING_TAGS)):
                return token
        return None

    findings = []
    reported = set()
    for key, parts in candidates.items():
        hits = []
        display = None
        has_gtc = False
        narrow_token = None
        for node in elements:
            if not selector_matches(node, parts):
                continue
            decls, _ = computed(node)
            current = decls.get("display")
            if current not in FLEXGRID_VALUES:
                continue
            texts = [c for c in node.children if isinstance(c, TextNode) and c.text.strip()]
            if not texts:
                continue
            children = [c for c in node.children if isinstance(c, Node)]
            # テキストが1本しか無く疑似要素マーカーも無い場合は「見出し + バッジ」等の
            # 正常な使い方と区別できないので見送る（誤検知より見逃しを取る）
            split_text = len(texts) >= 2
            marked = children and any(is_marker(node, ps) for ps in ("before", "after"))
            squeezed = narrow_cell(node, children) if current.endswith("grid") else None
            if not split_text and not marked and not squeezed:
                continue
            if id(node) in reported:
                continue
            reported.add(id(node))
            hits.append(node)
            if display is None:
                display = current
                has_gtc = decls.get("grid-template-columns") is not None
            if squeezed and not split_text and not marked:
                narrow_token = narrow_token or squeezed
        if hits:
            findings.append((key, display, has_gtc, hits, narrow_token))

    findings.sort(key=lambda f: f[3][0].line)
    return findings


def max_width_px(value):
    """max-width の値を px にする。min() は静的に読める引数の小さいほう。読めなければ None。"""
    value = value.strip()
    if value.startswith("min(") and value.endswith(")"):
        widths = [track_width_px(a) for a in split_args(value[len("min("):-1])]
        widths = [w for w in widths if w is not None]
        return min(widths) if widths else None
    return track_width_px(value)


def svg_width_px(node):
    """表示幅の px。width="100%" のように読めない幅は None（大きい図として扱う）。"""
    if "width" in node.attrs:
        width = node.attrs["width"].strip()
        return float(width) if re.match(r"^\d*\.?\d+$", width) else track_width_px(width)
    box = node.attrs.get("viewbox", "").replace(",", " ").split()
    try:
        return float(box[2])
    except (IndexError, ValueError):
        return None


def is_card_grid(node, computed):
    static = computed(node)[1]
    display = static.get("display")
    if display in ("grid", "inline-grid"):
        gtc = static.get("grid-template-columns") or ""
        tracks = expand_tracks(gtc) if gtc else None
        multi = ("auto-fit" in gtc or "auto-fill" in gtc
                 or bool(tracks) and sum("fr" in token for _, token in tracks) >= 2)
    elif display in ("flex", "inline-flex"):
        flow = (static.get("flex-flow") or "") + " " + (static.get("flex-wrap") or "")
        multi = bool(re.search(r"(?<![\w-])wrap", flow))
    else:
        return False
    cards = [c for c in node.children if isinstance(c, Node) and c.tag in CARD_TAGS
             and len(re.sub(r"\s+", " ", inner_text(c))) >= CARD_TEXT_CHARS]
    return multi and len(cards) >= 2


def wide_kind(node, computed, inline):
    """本文の幅に入れてはいけない要素なら、その呼び名を返す。"""
    if node.tag in ("table", "figure", "pre"):
        return {"table": "表", "figure": "図 (figure)", "pre": "pre"}[node.tag]
    if node.tag == "svg":
        if inline:
            return None
        width = svg_width_px(node)
        return None if width is not None and width < ICON_SVG_PX else "図 (svg)"
    if is_card_grid(node, computed):
        return "カードの並び (%s)" % computed(node)[1].get("display")
    return None


def opted_out(node):
    while node is not None:
        if NARROW_OK_ATTR in node.attrs:
            return True
        node = node.parent
    return False


def contains(frame, node):
    while node is not None:
        if node is frame:
            return True
        node = node.parent
    return False


def text_width_findings(elements, computed):
    """列の中で、隣の見出し・表などより狭い max-width で折り返す文章とその枠を返す。

    [(枠, max-width の値, px, 列, 列の px, 隣の要素, 隣の px)]。列は max-width を持つ最も近い祖先で、
    無ければページ全体（px は None）。隣の px は、隣から列までに掛かる max-width の最小。
    """
    own = {}

    def width_of(node):
        hit = own.get(id(node))
        if hit is None:
            value = computed(node)[1].get("max-width")
            width = max_width_px(value) if value else None
            hit = own[id(node)] = (value, width if width and width > 0 else None)
        return hit

    def column_of(node):
        parent = node.parent
        while parent.tag != "#root" and width_of(parent)[1] is None:
            parent = parent.parent
        return parent

    cards = {}

    def is_cards(node):
        hit = cards.get(id(node))
        if hit is None:
            hit = cards[id(node)] = is_card_grid(node, computed)
        return hit

    def off_column(node, include_self):
        """node が列の外の部品・浮いた部品・カードの中にあるか。列を越えてページの根まで見る。"""
        current = node
        while current.tag != "#root":
            own_part = current is not node or include_self
            if own_part and current.tag in OFF_COLUMN_TAGS:
                return True
            if computed(current)[1].get("position") in ("absolute", "fixed"):
                return True
            if current is not node and is_cards(current):
                return True
            current = current.parent
        return False

    def holds_text(node):
        if node.tag in TEXT_TAGS:
            return True
        return sum(1 for n in walk(node) if n.tag in TEXT_TAGS and not off_column(n, False)) >= 2

    def is_neighbor(node, column):
        if opted_out(node) or off_column(node, False):
            return False
        if node.tag not in NEIGHBOR_TAGS:
            return is_cards(node) and not off_column(node, True)
        if node.tag != "svg":
            return True
        parent = node.parent
        while parent is not column:
            if parent.tag in INLINE_CONTEXT:
                return False
            parent = parent.parent
        width = svg_width_px(node)
        return width is None or width >= ICON_SVG_PX

    def limit_in(node, column):
        widths = []
        while node is not column:
            width = width_of(node)[1]
            if width is not None:
                widths.append(width)
            node = node.parent
        return min(widths) if widths else None

    def column_px_of(column):
        """列の実効の幅。列から根までに掛かる max-width の最小。"""
        root = column
        while root.parent is not None:
            root = root.parent
        return limit_in(column, root)

    neighbors = {}

    def neighbors_of(column):
        """列の中の隣の候補を、広い順に [(px, 要素)]。列より狭くないものは px を列の幅にする。"""
        if id(column) not in neighbors:
            column_px = column_px_of(column)
            found = []
            for node in walk(column):
                if is_neighbor(node, column):
                    limits = [w for w in (limit_in(node, column), column_px) if w is not None]
                    found.append((min(limits) if limits else None, node))
            inf = float("inf")
            found.sort(key=lambda f: -(f[0] if f[0] is not None else inf))
            neighbors[id(column)] = found
        return neighbors[id(column)]

    findings = []
    for node in elements:
        value, width = width_of(node)
        if width is None or opted_out(node):
            continue
        column = column_of(node)
        if off_column(node, True) or not holds_text(node):
            continue
        for limit, other in neighbors_of(column):
            if limit is not None and limit <= width + SAME_WIDTH_SLACK_PX:
                break
            if contains(node, other) or contains(other, node):
                continue
            findings.append((node, value, width, column, column_px_of(column), other, limit))
            break
    return findings


def width_findings(elements, computed):
    def wide_descendants(node, inline=False):
        for child in node.children:
            if not isinstance(child, Node) or NARROW_OK_ATTR in child.attrs:
                continue
            kind = wide_kind(child, computed, inline)
            if kind:
                yield child, kind
            else:
                for hit in wide_descendants(child, inline or child.tag in INLINE_CONTEXT):
                    yield hit

    findings = []
    reported = set()
    page_wide = None
    for node in elements:
        if node.tag in PROSE_CARRIERS:
            continue
        value = computed(node)[1].get("max-width")
        width = max_width_px(value) if value else None
        if width is None or not 0 < width <= PROSE_WIDTH_PX or opted_out(node):
            continue
        if page_wide is None:
            page_wide = [n for n, _ in wide_descendants(elements[0].parent)]
        if all(contains(node, n) for n in page_wide):
            continue
        hits = [(n, k) for n, k in wide_descendants(node) if id(n) not in reported]
        reported.update(id(n) for n, _ in hits)
        if hits:
            findings.append((node, value, width, hits))
    return findings


def describe(node):
    out = "<" + node.tag
    if node.ident:
        out += ' id="%s"' % node.ident
    if node.classes:
        out += ' class="%s"' % " ".join(sorted(node.classes))
    return out + ">"


def format_width_report(source, findings):
    lines = [
        "artifact-lint: 狭い max-width の枠の中に表・図・カードの並びがあります"
        "（ページの途中の幅で折り返される原因）",
        "",
    ]
    for node, value, width, hits in findings:
        lines.append("  L%d  %s  (max-width: %s ≒ %dpx)" % (node.line, describe(node), value, width))
        for hit, kind in hits[:MAX_ELEMENTS_PER_SELECTOR]:
            lines.append("    L%d  %s  %s" % (hit.line, kind, preview(source, hit)))
        rest = len(hits) - MAX_ELEMENTS_PER_SELECTOR
        if rest > 0:
            lines.append("    ほか %d 要素" % rest)
        lines.append("")
    return "\n".join(lines)


def format_text_width_report(source, findings):
    lines = [
        "artifact-lint: 段落・リスト・blockquote か、それを包む枠が、同じ列の見出しや表より狭い max-width で"
        "折り返しています（文章だけがページの途中の幅で折り返される原因）",
        "",
    ]
    groups = {}
    for finding in findings:
        groups.setdefault(finding[1], []).append(finding)
    for value, group in groups.items():
        node, _, width, column, column_px, other, limit = group[0]
        column_label = "ページ全体" if column.tag == "#root" else describe(column)
        if column_px is not None:
            column_label += " ≒ %dpx" % column_px
        other_px = "列の幅" if limit is None or limit == column_px else "%dpx" % limit
        lines.append("  max-width: %s ≒ %dpx  (列は %s。L%d の %s は%sまで広がる)"
                     % (value, width, column_label, other.line, describe(other), other_px))
        counts = {}
        for hit in group:
            label = describe(hit[0])
            counts[label] = counts.get(label, 0) + 1
        lines.append("    掛かっている要素: " + "・".join(
            label if n == 1 else "%s ×%d" % (label, n) for label, n in counts.items()))
        for hit in group[:MAX_ELEMENTS_PER_SELECTOR]:
            lines.append("    L%d  %s" % (hit[0].line, preview(source, hit[0])))
        rest = len(group) - MAX_ELEMENTS_PER_SELECTOR
        if rest > 0:
            lines.append("    ほか %d 要素" % rest)
        lines.append("")
    return "\n".join(lines)


def format_report(source, findings):
    lines = [
        "artifact-lint: grid/flex の直下に生テキストと inline 要素が混在しています"
        "（1文字ずつ折り返される原因）",
        "",
    ]
    for key, display, has_gtc, hits, narrow_token in findings:
        label = "display: " + display
        if narrow_token:
            label += ", %s の狭い列に本文が落ちる" % narrow_token
        elif has_gtc:
            label += ", grid-template-columns あり"
        lines.append("  %s  (%s)" % (key, label))
        for node in hits[:MAX_ELEMENTS_PER_SELECTOR]:
            lines.append("    L%d  %s" % (node.line, preview(source, node)))
        rest = len(hits) - MAX_ELEMENTS_PER_SELECTOR
        if rest > 0:
            lines.append("    ほか %d 要素" % rest)
        lines.append("")
    lines.append(FIX_HINT)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("path", nargs="?")
    try:
        args, _ = parser.parse_known_args()
    except SystemExit:
        return 0
    path = args.path
    if not path or os.path.splitext(path)[1].lower() not in (".html", ".htm"):
        return 0
    try:
        info = os.stat(path)
    except (IOError, OSError, ValueError):
        return 0
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        return 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            source = fh.read(MAX_BYTES)
    except (IOError, OSError):
        return 0

    try:
        layout, width, text_width = analyze(source)
    except Exception:
        return 0
    reports = []
    if layout:
        reports.append(format_report(source, layout))
    if width:
        reports.append(format_width_report(source, width))
    if text_width:
        reports.append(format_text_width_report(source, text_width))
    if width or text_width:
        reports[-1] += "\n" + WIDTH_FIX_HINT
    if not reports:
        return 0
    sys.stdout.write("\n\n".join(reports) + "\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
