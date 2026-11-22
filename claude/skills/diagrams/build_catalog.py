#!/usr/bin/env python3
"""samples/ の SVG に base.css を書き写し、形式を確かめて catalog.html を作り直す。

使い方: python3 build_catalog.py [--check]
--check は何も書かず、作り直すと変わるファイルがあれば一覧を出して 1 で終わる。
"""
import html
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / "samples"
NS = "{http://www.w3.org/2000/svg}"
BASE_RE = re.compile(r"/\* base[^*]*\*/.*?/\* /base \*/", re.S)
BASE_HEAD = "/* base: base.css から build_catalog.py が書き写す。ここは直接直さない */"
FIELDS = ("形", "使う場面", "使わない場面")

# 分類の並び、その分類が答える問い、カタログでの見本の並び（ここに無い見本は後ろに名前順で付く）
CATEGORIES = {
    "flow": ("流れ", "何がどの順に起きるか",
             ["steps", "flowchart", "swimlane", "sequence", "data-flow", "cycle", "gate", "fallback", "funnel"]),
    "state": ("状態", "1 つのものがどう移り変わるか", ["state-machine", "lifecycle", "status-board"]),
    "structure": ("構成", "何が何でできているか", ["layers", "tree", "nested", "hub-spoke", "screen-grid"]),
    "compare": ("比べ", "どちらを選ぶか、何が変わるか",
                ["before-after", "option-table", "matrix-2x2", "pros-cons", "spectrum"]),
    "time": ("時間", "いつ何が起きる・起きたか", ["timeline", "gantt", "milestones", "week-rhythm"]),
    "relation": ("関係", "誰と何がどうつながるか", ["dependency", "raci", "read-write", "wiring", "venn"]),
}


def parse_desc(text: str, path: Path) -> dict:
    fields = {}
    for line in text.strip().splitlines():
        key, sep, value = line.strip().partition(":")
        if sep and key.strip() in FIELDS:
            fields[key.strip()] = value.strip()
    missing = [f for f in FIELDS if f not in fields]
    if missing:
        sys.exit(f"{path}: <desc> に {'・'.join(missing)} がない")
    return fields


def load(path: Path, base: str, outputs: dict) -> dict:
    src = path.read_text(encoding="utf-8")
    if not BASE_RE.search(src):
        sys.exit(f"{path}: <style> に /* base */ 〜 /* /base */ の区切りがない")
    synced = BASE_RE.sub(lambda _: f"{BASE_HEAD}\n{base}\n/* /base */", src, count=1)
    outputs[path] = synced
    root = ET.fromstring(synced)
    if "dg" not in root.get("class", "").split():
        sys.exit(f"{path}: ルートの <svg> に class=\"dg\" がない")
    if not root.get("viewBox"):
        sys.exit(f"{path}: viewBox がない")
    title = root.find(f"{NS}title")
    desc = root.find(f"{NS}desc")
    if title is None or not (title.text or "").strip() or desc is None:
        sys.exit(f"{path}: <title> と <desc> が要る")
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "name": title.text.strip(),
        **parse_desc(desc.text or "", path),
        "svg": synced.strip(),
    }


def tokens(base: str) -> tuple[str, str]:
    """base.css の fallback 値を、カタログのページ側の --dg-* 定義（明るい画面・暗い画面）にする。"""
    blocks = [re.findall(r"--_[\w-]+:var\((--dg-[\w-]+),(#[0-9a-fA-F]+)\)", line) for line in base.splitlines()]
    light, dark = [b for b in blocks if b][:2]
    if len(light) != len(dark):
        sys.exit("base.css の明るい画面と暗い画面で変数の数が違う")
    return tuple(";".join(f"{k}:{v}" for k, v in b) + ";" for b in (light, dark))


def card(s: dict) -> str:
    e = html.escape
    # 見本ごとの <style> とアニメーションが混ざらないよう、shadow DOM に閉じ込める。
    # 一覧では動きを最初の場面で止め、拡大表示（catalog.template.html の script）でだけ動かす
    return f"""<article class="card">
<div class="name"><h3>{e(s['name'])}</h3><span class="path">{e(s['path'])}</span></div>
<div class="fig"><div><template shadowrootmode="open"><style>:host{{display:block}}svg{{display:block;width:100%;height:auto}}svg *{{animation-play-state:paused!important}}</style>{s['svg']}</template></div><button type="button" class="zoom">拡大</button></div>
<dl><dt>形</dt><dd>{e(s['形'])}</dd><dt>使う場面</dt><dd class="use">{e(s['使う場面'])}</dd><dt>使わない場面</dt><dd>{e(s['使わない場面'])}</dd></dl>
</article>"""


def main() -> None:
    check = sys.argv[1:] == ["--check"]
    if sys.argv[1:] and not check:
        sys.exit(__doc__)
    outputs: dict[Path, str] = {}
    base = (ROOT / "base.css").read_text(encoding="utf-8").strip()
    dirs = sorted(p.name for p in SAMPLES.iterdir() if p.is_dir() and not p.name.startswith("."))
    unknown = set(dirs) - CATEGORIES.keys()
    if unknown:
        sys.exit(f"CATEGORIES にない分類: {', '.join(sorted(unknown))}")
    sections, nav, total = [], [], 0
    for key, (label, question, order) in CATEGORIES.items():
        rank = {slug: i for i, slug in enumerate(order)}
        files = sorted((SAMPLES / key).glob("*.svg"), key=lambda f: (rank.get(f.stem, len(order)), f.stem))
        if not files:
            continue
        total += len(files)
        nav.append(f'<a href="#{key}">{label}<span>{len(files)}</span></a>')
        cards = "\n".join(card(load(f, base, outputs)) for f in files)
        sections.append(
            f'<section id="{key}"><div class="sec-head"><h2>{label}</h2><p>{question}</p>'
            f'<span class="count">{len(files)} 枚</span></div>\n<div class="grid">\n{cards}\n</div></section>'
        )
    template = (ROOT / "catalog.template.html").read_text(encoding="utf-8")
    light, dark = tokens(base)
    out = (
        template.replace("{{dg_light}}", light)
        .replace("{{dg_dark}}", dark)
        .replace("{{nav}}", "\n".join(nav))
        .replace("{{sections}}", "\n".join(sections))
        .replace("{{total}}", str(total))
    )
    outputs[ROOT / "catalog.html"] = out
    stale = [p for p, text in outputs.items() if not p.exists() or p.read_text(encoding="utf-8") != text]
    if check:
        if stale:
            names = "\n".join(f"  {p.relative_to(ROOT)}" for p in stale)
            sys.exit(f"作り直しが要る（python3 build_catalog.py を流す）:\n{names}")
        print(f"catalog.html: {total} 枚、作り直し不要")
        return
    for p in stale:
        p.write_text(outputs[p], encoding="utf-8")
    print(f"catalog.html: {total} 枚")


if __name__ == "__main__":
    main()
