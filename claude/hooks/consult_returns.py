"""カードの相談（claude/bin/consult --card。設計 10 章）と窓からの質問（claude/bin/consult --ask。設計 11 章）を受け持つ。
compaction-keep.py の hook と道具（consult-context・consult-return・ask-context・unreflected）がここを呼ぶ。

  相談・質問の発言の記録と、前のターンのあとに増えた判断の流し込み（on_thread_prompt）
  相談・質問の文脈の束（consult_context・ask_context）
  返しの記録 .orca/consult/<カード id>.returns.jsonl・ask-<質問 id>.returns.jsonl への保存（save_return）と窓口への知らせ（notify_main）
  切り替え前の相談のメモの返しの取り込み（card_returns）。返しの未反映の判定は state.ts に置き、ここではその出力を読む（returns_report）
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from cockpit_records import (
    ASK_ID, BINDING, CARD_ID, KEEPER, RETURN_ID, active_rulings, append_jsonl, append_utterance, cockpit, cockpit_root_at, is_relay, iso,
    load_keep, locked, norm, now, open_lines, orca_bin, out, path_of, read_json, read_jsonl, ruling_line, ruling_num, rulings, save_keep,
    state_report, write_json
)


# 相談の文脈の束の目安。超える判断はパスと ID だけにし、要るときに読ませる（設計 10.2、R33「必要に応じて情報を取得する」）
CONTEXT_LIMIT = 8000
LONG_FIELD = 600


# ---------- カードの相談（設計 10 章。claude/bin/consult --card が立てる） ----------

def consult_memo_path(root, card_id):
    """相談のメモ。.orca/cockpit/ の外に置き、相談スレッドが書いてよい唯一のファイル。"""
    return os.path.join(root, ".orca", "consult", card_id + ".md")


def ledger_cards(root):
    """帳簿のカードと、片付けて移したカード（返しの照合は、移したあとのカードにも効かせる）。"""
    out = []
    for c in (cockpit(root), read_json(os.path.join(root, ".orca", "cockpit.archive.json"), {})):
        out += [x for x in c.get("cards") or [] if isinstance(x, dict)]
    return out


def find_card(root, card_id):
    return next((x for x in ledger_cards(root) if x.get("id") == card_id), None)


def consult_scope(root, card):
    """カードに結ばれた仕事の id・タスクの id（カードの tasks と、request_id の依頼の tasks）・依頼。"""
    c = cockpit(root)
    rid = card.get("request_id")
    req = next((r for r in c.get("requests") or [] if isinstance(r, dict) and rid and r.get("id") == rid), None)
    tasks = [t for t in (card.get("tasks") or []) + ((req or {}).get("tasks") or []) if isinstance(t, str) and t]
    return card.get("stream") or None, list(dict.fromkeys(tasks)), req


def touches_card(card_id, stream, tasks):
    """判断の行が、カード id か仕事の id を本文か dec で挙げるか、結ばれたタスクを affects に持つか。"""
    names = [x for x in (card_id, stream) if x]
    named = re.compile(r"(?<![A-Za-z0-9_-])(?:%s)(?![A-Za-z0-9_-])" % "|".join(map(re.escape, names))) if names else None
    return lambda r: bool(set(tasks) & set(r.get("affects") or [])
                          or (named and named.search("%s %s" % (r.get("text") or "", r.get("dec") or ""))))


def related_rulings(rows, card_id, stream, tasks, since=None):
    """カードの相談に関係する判断。相談を立てるとき・毎回の発言の前・窓口が返しを反映する直前で、この 1 つを使う（設計 10.7 の 3）。

    ① 全体の制約（constraint）② カード id か仕事の id を本文か dec に含む行 ③ 結ばれたタスクを affects に持つ行と、
    それらを置き換え・撤回した行。since が無ければ今も有効なものだけ、あれば R<since> より後に足された行を撤回も含めて全部。"""
    touches = touches_card(card_id, stream, tasks)
    hit = set()
    for r in rows:  # 置き換えは前の行を指すので、前から 1 回たどれば連鎖も拾える
        if r.get("kind") == "constraint" or touches(r) or set(r.get("supersedes") or []) & hit:
            hit.add(r.get("id"))
    if since is None:
        live = {r["id"] for r in active_rulings(rows)}
        return [r for r in rows if r.get("id") in hit and r.get("id") in live]
    return [r for r in rows if r.get("id") in hit and ruling_num(r) > since]


def shorten(v, where):
    """長い文字列を頭だけにし、全文の場所を添える。カードの長い欄で文脈の束が上限を超えないようにする。"""
    if isinstance(v, str) and len(v) > LONG_FIELD:
        return v[:LONG_FIELD // 2] + "…（以下略。全文は %s）" % where
    if isinstance(v, dict):
        return {k: shorten(x, "%s.%s" % (where, k)) for k, x in v.items()}
    if isinstance(v, list):
        return [shorten(x, "%s[%d]" % (where, i)) for i, x in enumerate(v)]
    return v


def consult_context(root, card_id):
    """相談スレッドに最初に渡す文脈の束（設計 10.2）。上限を超える判断はパスと ID だけにする。"""
    card = find_card(root, card_id)
    if card is None:
        raise ValueError("カード %s が帳簿に無い" % card_id)
    c = cockpit(root)
    rows = rulings(root)
    stream, tasks, req = consult_scope(root, card)
    out = ["# カード %s の相談の文脈（%s 時点。読み直すときは compaction-keep.py consult-context %s %s）"
           % (card_id, now().strftime("%Y-%m-%d %H:%M"), root, card_id),
           "rev: %s" % card.get("rev"),
           "rulings_seen: R%d" % max([ruling_num(r) for r in rows] + [0]),
           "", "## カード（帳簿 .orca/cockpit.json の全欄）", "```json", json.dumps(shorten(card, "帳簿のカード %s の欄 " % card_id), ensure_ascii=False, indent=1), "```"]
    if req:
        where = "帳簿の依頼 %s の " % req.get("id")
        out += ["", "## 依頼 %s（このカードの request_id）: %s" % (req.get("id"), shorten(norm(req.get("title")), where + "title"))]
        out += ["- 原文 %s「%s」" % (u.get("id"), shorten(u.get("quote"), where + "utterances"))
                for u in req.get("utterances") or [] if isinstance(u, dict)]
        if isinstance(req.get("source"), dict):
            out.append("- 出典「%s」" % shorten(req["source"].get("quote"), where + "source.quote"))
        out += ["- 済の条件 %d: %s" % (i, shorten(w, where + "done_when[%d]" % (i - 1))) for i, w in enumerate(req.get("done_when") or [], 1)]
    if tasks:
        report = state_report(root) or {}
        shown = {t.get("id"): t for t in report.get("tasks") or [] if isinstance(t, dict)}
        raw = {t.get("id"): t for t in c.get("tasks") or [] if isinstance(t, dict)}
        out += ["", "## 結ばれたタスク（状態は state.ts の判定%s）" % ("" if shown else "。読めなかったので手書きの値")]
        for t in tasks:
            row = raw.get(t) or {}
            out.append("- %s（%s）: %s" % (t, (shown.get(t) or row).get("state") or "帳簿に無い", norm(row.get("title"))))
    if stream:
        s = next((x for x in c.get("streams") or [] if isinstance(x, dict) and x.get("id") == stream), {})
        out += ["", "## 仕事 %s: %s（形 %s）" % (stream, norm(s.get("title")) or "帳簿に無い", s.get("form") or "未記入")]
    related = related_rulings(rows, card_id, stream, tasks)
    # 上限で切るときは、このカード・仕事・タスクを挙げる判断を全体の制約より先に残す
    touches = touches_card(card_id, stream, tasks)
    related.sort(key=lambda r: not touches(r))
    out += ["", "## 関係する判断（%s を挙げる判断・%s に影響する判断・全体の制約。原文つき）"
            % ("・".join(x for x in (card_id, stream) if x), "・".join(tasks) or "結ばれたタスク")]
    size, dropped = len("\n".join(out)), []
    for r in related:
        line = "- " + ruling_line(r)
        if size + len(line) + 1 > CONTEXT_LIMIT:
            dropped.append(r["id"])
            continue
        out.append(line)
        size += len(line) + 1
    if not related:
        out.append("- なし")
    if dropped:
        out.append("- ほか %d 件（%s）は長さの上限で省いた。要るときに %s の同じ id の行を読む"
                   % (len(dropped), "・".join(dropped), path_of(root, "rulings.jsonl")))
    return "\n".join(out)


def consult_card_env():
    """CONSULT_CARD=<root>#<カード id>。形が違うか root に操縦席が無ければ (None, None)。"""
    root, sep, card = (os.environ.get("CONSULT_CARD") or "").rpartition("#")
    if not (sep and root and CARD_ID.fullmatch(card) and os.path.isfile(os.path.join(root, ".orca", "cockpit.json"))):
        return None, None
    return root, card


# consult --card が Orca のチャットで立てた相談の、最初の指示の 1 行（claude/bin/consult の CHAT_MARK と同じ書式）
CHAT_MARK = re.compile(r"^相談の印: ([A-Za-z0-9_]+)#([0-9a-f]{32})$", re.M)


def chats_path(root):
    """Orca の会話 id（ORCA_AGENT_SESSION_ID）→ カードの相談の対応。periodic-reminder.sh と consult も読む。"""
    return os.path.join(root, ".orca", "consult", "chats.json")


def chat_card(cwd, inp=None):
    """Orca のチャットで立てたカードの相談なら <root>#<カード id>、違えば None。チャットには環境変数を渡せないので、
    consult が書いた合言葉（.orca/consult/.<カード id>.chat-token）と最初の指示の印が合ったときに、会話 id を chats.json に登録する。"""
    sid = os.environ.get("ORCA_AGENT_SESSION_ID")
    root = cockpit_root_at(cwd) if sid else None
    if not root:
        return None
    card = (read_json(chats_path(root), {}).get(sid) or {}).get("card")
    head = ((inp or {}).get("prompt") or "").split("\n", 2)
    m = (CHAT_MARK.fullmatch(head[1]) if not card and (inp or {}).get("hook_event_name") == "UserPromptSubmit" and len(head) > 1
         and head[0].startswith("【相談の知らせ】カードの相談を始める") else None)
    if m:
        token = os.path.join(root, ".orca", "consult", ".%s.chat-token" % m.group(1))
        # 合言葉は 1 回で使い切る（起動の指示を窓口に貼り直しても、窓口を相談として登録しない）
        with locked(root):
            reg = read_json(chats_path(root), {})
            try:
                with open(token, encoding="utf-8") as fh:
                    ok = fh.read().strip() == m.group(2)
            except OSError:
                ok = False
            if ok:
                reg[sid] = {"card": m.group(1), "at": iso()}
                write_json(chats_path(root), reg)
                os.remove(token)
            card = (reg.get(sid) or {}).get("card")
    return "%s#%s" % (root, card) if isinstance(card, str) and CARD_ID.fullmatch(card) else None


SEEN_LINE = re.compile(r"^rulings_seen: R(\d+)$", re.M)
REV_LINE = re.compile(r"^rev: (\d+)$", re.M)
# 質問の起動の指示の末尾に consult --ask が付ける、窓で打たれた深田さんの最初の質問の見出し
ASK_QUESTION_HEAD = "--- 深田さんの質問（窓から） ---\n"
# 窓の「A で返す」「書いたことを窓口に返す」は、深田さんの言葉のあとに改行して「返しを書いて」の知らせを付け、1 回の入力で送る
# （agent-harness の orca/plugins/cockpit/window/ask-tabs.ts の askMessage）。言葉は発言として残し、末尾の知らせの行は発言に入れない
ASK_REPLY_TAIL = re.compile(r"\n+【相談の知らせ】返しを書いて（op (\d+)）\s*\Z")


def ask_reply_words(root, ask_id, prompt):
    """窓が送った「言葉 + 返しを書いて（op n）」なら言葉を返す。op n がこの質問の ask_decide で、op から組み立てた言葉と一致するときだけ
    （深田さんが本当の知らせの行を貼った質問の末尾を削らない。知らせの引用で始まる言葉も、知らせとして落とさない。Codex の指摘 4）。"""
    m = ASK_REPLY_TAIL.search(prompt or "")
    if not m:
        return None
    words = prompt[:m.start()].strip()
    for o in read_json(os.path.join(root, ".orca", "cockpit.user.json"), {}).get("ops") or []:
        if isinstance(o, dict) and o.get("type") == "ask_decide" and o.get("item_id") == "#ask:" + ask_id and str(o.get("op_id")) == m.group(1):
            # src/model.ts の askWords と同じ（案を選んだら「案 A で。」、書いたらその文）
            want = ("案 %s で。" % o["choice"]) if isinstance(o.get("choice"), str) and o["choice"] else (o.get("text") or "").strip() if isinstance(o.get("text"), str) else ""
            return words if want and words == want else None
    return None


def on_thread_prompt(root, inp, kind, tid, card_id, stream_id=None):
    """カードの相談（kind "card"、tid はカード id）と窓からの質問（kind "ask"、tid は質問 id）の発言を、窓口と同じロックと採番で
    root の発言の記録に card か ask 付きで足し（設計 10.7 の 4・11.2）、前のターンのあとに増えた判断とカードの rev の変化を流す
    （10.3 の 4・11.6 の 6）。メインの役割は流さない。

    起点は keep.json の consults[カード id] か asks[質問 id]。起動の指示（知らせの印つき）が持つ rulings_seen と rev から始める。
    増えた判断は、カードか仕事（stream_id。仕事に結んだ質問）があればそれに関係するものだけ（related_rulings）、
    どちらにも結ばれていない質問は対象で絞らずに全部流す。"""
    prompt = inp.get("prompt") or ""
    tag = "相談" if kind == "card" else "質問"
    lines, asked, uid = [], None, None
    with locked(root):
        keep = load_keep(root)
        seen = keep.setdefault("consults" if kind == "card" else "asks", {})
        card = (find_card(root, card_id) or {}) if card_id else {}
        rows = rulings(root)
        reply = ask_reply_words(root, tid, prompt) if kind == "ask" else None
        relay = reply is None and is_relay(prompt)
        m = SEEN_LINE.search(prompt) if relay else None
        if relay and m:
            v = REV_LINE.search(prompt)
            seen[tid] = {"seen": int(m.group(1)), "rev": int(v.group(1)) if v else card.get("rev"), "state": card.get("state"), "at": iso()}
            # 質問の起動の指示は、窓で打たれた最初の質問を末尾に持つ。指示は記録しないが、質問は深田さんの発言として残す
            asked = prompt.rpartition(ASK_QUESTION_HEAD)[2].strip() if kind == "ask" and ASK_QUESTION_HEAD in prompt else None
        elif not relay:
            asked = prompt if reply is None else reply
        if asked:
            uid = append_utterance(root, {"at": iso(), "session": inp.get("session_id") or "", kind: tid, "prompt": asked})
        # 起動の指示だけが起点を決める。窓・窓口の知らせ（「この答えを窓口に返す」・差し戻し）は記録しないが、増えた判断は流す
        # （古い前提のまま返しを書かせない。Codex の指摘 2）
        base = None if m else seen.get(tid)
        shown = None
        if base:
            scoped = bool(card_id or stream_id)
            if scoped:
                new = ask_related(root, rows, card_id, stream_id, base.get("seen") or 0)
            else:
                new = [r for r in rows if ruling_num(r) > (base.get("seen") or 0) and r.get("kind") in BINDING + ("revoke",)]
            # カード・仕事付きは関係しない判断を読んだことにしてよい（窓口の照合も関係する判断だけを見る）。どちらも無い質問は、
            # 渡した判断の最後の id までしか進めない（窓口の照合は全部を見るので、渡していない id まで進めると見逃す。11.6 の 6）
            shown = max([ruling_num(r) for r in rows] + [0]) if scoped else max([ruling_num(r) for r in new] + [base.get("seen") or 0])
            if new:
                lines.append("【%s】前のターンのあとに、窓口の判断の記録に%s判断が増えた（扱いは役割の文書。%sの rulings_seen に書く値は R%d）:"
                             % (tag, "関係する" if scoped else "", "窓口に返すとき" if kind == "card" else "返し", shown))
                lines += ["- " + ruling_line(r) for r in new]
            if card_id and card.get("rev") != base.get("rev"):
                if kind == "card":
                    lines.append("【相談】カード %s の rev が %s から %s に変わった。今のカードは compaction-keep.py consult-context %s %s の出力にあり、"
                                 "相談のメモの「前提のカード」は前の rev のまま" % (card_id, base.get("rev"), card.get("rev"), root, card_id))
                else:  # 質問の相手はコマンドを使えないので、今のカードをそのまま渡す
                    lines.append("【質問】カード %s の rev が %s から %s に変わった。今のカード:\n%s"
                                 % (card_id, base.get("rev"), card.get("rev"), json.dumps(shorten(card, "帳簿のカード %s の欄 " % card_id), ensure_ascii=False)))
            if card_id and card.get("state") == "done" and base.get("state") != "done":
                lines.append("【%s】カード %s が片付いた（扱いは役割の文書）" % (tag, card_id))
        if not m:
            # 起点が無い（起動の指示を受けていない・keep.json が消えた）ときは、今までどおり今の最後の id から数え始める
            last = shown if shown is not None else max([ruling_num(r) for r in rows] + [0])
            seen[tid] = {"seen": last, "rev": card.get("rev"), "state": card.get("state"), "at": iso()}
        save_keep(root, keep)
    # 質問の控えには、深田さんの質問と、窓・窓口からの知らせ（「この答えを窓口に返す」など）を残す。起動の指示そのものは残さない
    if kind == "ask" and (asked or not m):
        head = ("質問 %s（%s）" % (now().strftime("%H:%M"), uid)) if asked else ("知らせ %s" % now().strftime("%H:%M"))
        append_text(ask_memo_path(root, tid), "### %s\n%s\n\n" % (head, escape_sections((asked or prompt).strip())))
    if lines:
        print("\n".join(lines))


# 控えの節の見出しと同じ形の行。本文の中にあると、窓（agent-harness の src/model.ts の escapeAskSections と同じ形）が節を割るので 1 字下げる
ASK_SECTION = re.compile(r"^(?=### (?:質問|答え|知らせ) \d{1,2}:\d{2})", re.M)


def escape_sections(text):
    return ASK_SECTION.sub(" ", text)


def append_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(text)


RETURN_BLOCK = re.compile(r"```json[ \t]*\n(.*?)\n[ \t]*```", re.S)
# 返しの記録の行のうち、道具が足す欄（窓口に送る返しの JSON には入れない）
RECORD_FIELDS = ("ask", "saved_at", "session", "reply", "imported_from")
# 切り替え前のメモで、記録の同じ番号の返しと中身が違ったために、道具が新しい番号を付けた返しの元の番号
CONFLICT = "conflict_of"
CONSULT_FILE = re.compile(r"([A-Za-z0-9_]+)\.(?:md|returns\.jsonl)")


def return_body(r):
    """返しの中身（道具が付ける欄を除いたもの）。同じ返しかどうかを中身で比べるときに使う。"""
    return {k: v for k, v in r.items() if k not in ("return_id", CONFLICT) + RECORD_FIELDS}


def card_returns_path(root, card_id):
    """カードの相談の返しの記録（正本）。consult-return が 1 行ずつ足す。窓口・state.ts は返しをここだけから読む。"""
    return os.path.join(root, ".orca", "consult", "%s.returns.jsonl" % card_id)


def memo_blocks(text):
    """切り替え前の相談のメモの「## 窓口に返したもの」の節にある ```json の塊のうち、return_id を持つもの（同じ id も全部、書いた順）。"""
    m = re.search(r"^## 窓口に返したもの[^\n]*\n(.*?)(?=^## |\Z)", text or "", re.S | re.M)
    out = []
    for block in RETURN_BLOCK.findall(m.group(1) if m else ""):
        try:
            v = json.loads(block)
        except ValueError:
            continue
        if isinstance(v, dict) and isinstance(v.get("return_id"), str) and RETURN_ID.fullmatch(v["return_id"]):
            out.append(v)
    return out


def memo_pending(root, card_id, rows):
    """切り替え前のメモの返しのうち、記録にまだ無いもの [(塊, 衝突した番号か None)]。
    記録に同じ番号の返しが無ければそのまま、中身の違う返しがあれば番号の衝突として返す。同じ中身の取り込み済みは返さない。"""
    try:
        with open(consult_memo_path(root, card_id), encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        return []
    # ほかの読み取りの誤り（権限など）は上げる。黙って空とすると、そのメモの返しと番号を数え落とす
    have = [(r, return_body(r)) for r in valid_returns(rows)]
    out = []
    for v in memo_blocks(text):
        v = {**v, "card": v.get("card") or card_id}
        body = return_body(v)
        if any(r.get(CONFLICT, r["return_id"]) == v["return_id"] and b == body for r, b in have):
            continue
        clash = any(r["return_id"] == v["return_id"] for r, _ in have)
        out.append((v, v["return_id"] if clash else None))
        have.append(({**v, "return_id": "" if clash else v["return_id"], **({CONFLICT: v["return_id"]} if clash else {})}, body))
    return out


def card_returns(root, card_id):
    """カードの相談の返しの記録の全部の行。切り替え前のメモの返しのうち記録に無いものは、読むたびにロックの中で記録へ足す
    （古いタブが閉じる前にメモに書いた返しも拾う。return_id で冪等）。番号がぶつかった返しは、新しい番号を付け、
    元の番号を conflict_of に残して足す（本文を落とさず、窓口が「番号の衝突」として拾う）。"""
    path = card_returns_path(root, card_id)
    rows = read_jsonl(path)
    if not memo_pending(root, card_id, rows):
        return rows
    with locked(root):
        rows = read_jsonl(path)
        # ぶつからない返しを先に足してから、ぶつかった返しに番号を付ける（メモにある番号を新しい番号に使わない）
        for v, clash in sorted(memo_pending(root, card_id, rows), key=lambda x: x[1] is not None):
            row = {**v, "imported_from": consult_memo_path(root, card_id), "saved_at": iso()}
            if clash:
                row = {**row, "return_id": next_return_id(root, card_id, rows), CONFLICT: clash}
                print("compaction-keep: メモの返し %s は記録の同じ番号の返しと中身が違うので、%s として取り込んだ" % (clash, row["return_id"]), file=sys.stderr)
            append_jsonl(path, row)
            rows.append(row)
    return rows


def valid_returns(rows):
    """記録の行のうち、return_id のある返し（同じ id は先の行）。"""
    out = {}
    for r in rows:
        if isinstance(r.get("return_id"), str) and RETURN_ID.fullmatch(r["return_id"]):
            out.setdefault(r["return_id"], r)
    return list(out.values())


def consult_cards(root):
    """相談のメモか返しの記録のあるカードの id（名前の順）。"""
    try:
        names = os.listdir(os.path.join(root, ".orca", "consult"))
    except OSError:
        return []
    return sorted({m.group(1) for n in names for m in [CONSULT_FILE.fullmatch(n)] if m})


def import_memo_returns(root):
    """切り替え前のメモの返しのうち記録に無いものを、記録へ足す（card_returns）。state.ts は返しの記録だけを読むので、返しの未反映を読む前に通す。"""
    for card_id in consult_cards(root):
        card_returns(root, card_id)


def returns_report(root, files=False):
    """返しの未反映を読むための state.ts の出力（読めなければ None）。先に切り替え前のメモの返しを記録へ取り込む。
    取り込めなければ OSError を上げる（メモの返しを数え落とした結果を出さない）。"""
    import_memo_returns(root)
    return state_report(root, files)


def unreflected_returns(report):
    """state.ts の checks.unreflected_returns（設計 10.7 の 1・11 章）。判定は state.ts の unreflectedReturns の 1 か所に置き、ここでは写さない。
    形は { id, card, missing[], memo, returns, conflict_of? } と、質問の分の { id, ask, missing[], memo, returns, tasks? }・{ id: null, ask, op, missing: ['返し'], memo }。
    state.ts を読めなければ None。"""
    got = ((report or {}).get("checks") or {}).get("unreflected_returns")
    return got if isinstance(got, list) else None


def same_return(rows, ret, reply=None):
    """既にある返しのうち、ret と同じもの。同じとみなす鍵はここだけに置く:
      - 返し直し（replaces あり）: 同じ replaces の返し。言い換えた返し直しで番号を増やさない
      - 同じ op の返し（窓の 1 回の操作に返しは 1 つ）
      - 質問の hook が同じ返事をもう一度処理した: reply（session と返事の本文の sha256。reply_key）が同じ
      - 道具が付ける欄（return_id・RECORD_FIELDS）を除いた中身が完全に同じ（相手が出力を見失って同じ返しで呼び直した）。
        発言の id まで同じなので、言い換えた別の返しは同じにならない"""
    for r in valid_returns(rows):
        # 返し直しは同じ replaces の返しとだけ比べる（元の返しと同じ op を持っていても、直した中身を捨てない）
        if ret.get("replaces"):
            if r.get("replaces") == ret["replaces"]:
                return r
            continue
        if ret.get("op") is not None and r.get("op") is not None and str(r["op"]) == str(ret["op"]):
            return r
        if (reply and r.get("reply") == reply) or return_body(r) == return_body(ret):
            return r
    return None


def next_return_id(root, owner, rows):
    """<カード id か質問 id>-<n>。n は、その id のカードの記録と質問の記録（カード ask3 と質問 ask3 が同じ番号を採らないよう両方）と、
    判断の記録の from_return の最大に 1 を足す。呼ぶ側が locked(root) を持つ。rows は呼ぶ側が読んだ記録（足したばかりの行を含む）。"""
    pat = re.compile(r"%s-(\d+)" % re.escape(owner))
    ids = [r.get("return_id") for r in rows + read_jsonl(card_returns_path(root, owner)) + read_jsonl(ask_returns_path(root, owner))]
    ids += [r.get("from_return") for r in rulings(root)]
    n = max([int(m.group(1)) for x in ids if isinstance(x, str) for m in [pat.fullmatch(x)] if m] + [0])
    return "%s-%d" % (owner, n + 1)


def save_return(root, owner, ret, is_ask, **extra):
    """返しを記録に保存する。カードの相談（consult-return）と質問（Stop の hook）の両方がここを通る。
    ロックの中で、既にある返しとの照合 → 採番 → 追記をする。入力の return_id は使わず、道具が付ける。
    (保存した行か既にあった行, 新しく足したか) を返す。送るのは呼ぶ側で、ロックを外してから。"""
    path = ask_returns_path(root, owner) if is_ask else card_returns_path(root, owner)
    with locked(root):
        rows = read_jsonl(path) if is_ask else card_returns(root, owner)
        old = same_return(rows, ret, extra.get("reply"))
        if old is not None:
            return old, False
        row = {"return_id": next_return_id(root, owner, rows), **{k: v for k, v in ret.items() if k != "return_id"},
               **{k: v for k, v in extra.items() if v}, "saved_at": iso()}
        append_jsonl(path, row)
    return row, True


def unreflected_lines(root, report):
    """report は returns_report の出力。"""
    left = unreflected_returns(report)
    if left is None:
        # Orca の問い合わせが時間切れでも、返しはファイルだけで決まるので Orca を読まずに読み直す（空き枠は不明のまま）
        left = unreflected_returns(state_report(root, files=True))
    if left is None:
        return ["", "## 反映していないカードの相談と質問の返し: state.ts を読めず不明（%s unreflected %s で確かめる）" % (KEEPER, root)]
    if not left:
        return []

    def line(x):
        if "ask" not in x:
            clash = "。切り替え前のメモで %s と番号がぶつかった別の返し。%s と同じ判断・依頼が帳簿にあれば足さない" % (x[CONFLICT], x[CONFLICT]) if x.get(CONFLICT) else ""
            return "- %s（カード %s。無いもの: %s%s。返しの記録: %s）" % (x["id"], x["card"], "・".join(x["missing"]), clash, x["returns"] or "無い")
        if x.get("op") is not None:
            return "- 質問 %s の「この答えを窓口に返す」（op %s）に結ばれた返しが無い。質問のタブに返しを頼み直すか、答えの控え %s から窓口が反映して op を applied_ops に足す" % (
                x["ask"], x["op"], x["memo"])
        tasks = "（%s）" % "・".join(str(t) for t in x["tasks"] if t) if any(x.get("tasks") or []) else ""
        return "- %s（質問 %s。無いもの: %s%s。返しの記録: %s）" % (x["id"], x["ask"], "・".join(x["missing"]), tasks, x.get("returns") or "無い")
    return ["", "## 反映していないカードの相談と質問の返し（返しの記録にあって、判断の記録か帳簿に入っていないか、保留のまま・担当への通知が済んでいない。"
                "cockpit skill の「カードの相談」「窓から質問する」の手順で反映する。保留は差し戻しの知らせを送り直し、新しい返しを待つ）"] + [line(x) for x in left]


# ---------- 窓から質問する（設計 11 章。claude/bin/consult --ask が立てる） ----------

def ask_memo_path(root, ask_id):
    """質問と答えの控え（表示専用。consult --ask が頭を書き、hook が質問と答えを追記する。窓口はここから返しを探さない）。"""
    return os.path.join(root, ".orca", "consult", "ask-%s.md" % ask_id)


def ask_returns_path(root, ask_id):
    """質問の返しの記録。hook が相手の最後の返事の【窓口への返し】から 1 行ずつ足す。窓口・state.ts はここだけを読む（11.6 の 2）。"""
    return os.path.join(root, ".orca", "consult", "ask-%s.returns.jsonl" % ask_id)


ASK_BIND = re.compile(r"^- (カード|タスク|仕事): ([A-Za-z0-9_]+)$", re.M)


def ask_binding(root, ask_id):
    """質問に結ばれた (カード id, タスク id, 仕事 id)。consult --ask が控えの頭（最初の ### より前）に書いた行から読む（結び先は 1 つまで）。"""
    try:
        with open(ask_memo_path(root, ask_id), encoding="utf-8") as fh:
            head = fh.read().split("\n###", 1)[0]
    except OSError:
        return None, None, None
    got = dict(ASK_BIND.findall(head))
    return got.get("カード"), got.get("タスク"), got.get("仕事")


def stream_tasks(root, stream_id):
    return [t["id"] for t in cockpit(root).get("tasks") or [] if isinstance(t, dict) and t.get("stream") == stream_id and isinstance(t.get("id"), str)]


def ask_related(root, rows, card_id, stream_id, since):
    """結んだ質問に関係する、R<since> より後の判断。カードはカードの相談と同じ、仕事は仕事の id とその下のタスクで引く
    （consult の stream_rulings と同じ引き方に、全体の制約と撤回を足したもの。related_rulings に仕事だけを渡す）。"""
    if card_id:
        stream, tasks, _ = consult_scope(root, find_card(root, card_id) or {})
        return related_rulings(rows, card_id, stream, tasks, since)
    return related_rulings(rows, None, stream_id, stream_tasks(root, stream_id), since)


def git_log(root):
    """最近の履歴。固定の引数で取る（質問の相手は Bash を使えない。11.6 の 1）。"""
    try:
        done = subprocess.run(["git", "-C", root, "log", "--oneline", "--no-decorate", "-15"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return done.stdout.strip().splitlines() if done.returncode == 0 else []


def ask_context(root, ask_id):
    """質問の相手に最初に渡す文脈（11.1・11.6 の 1・6）。カード付きはカードの相談と同じ束、カードの無い質問は有効な判断を新しい順に全部
    （上限を超えた古いものは id とパスだけ）。rulings_seen は実際に渡した判断の最後の id。最後に git の最近の履歴を付ける。"""
    card_id, task_id, stream_id = ask_binding(root, ask_id)
    if card_id:
        out = [consult_context(root, card_id)]
    else:
        c = cockpit(root)
        # 仕事に結んだ質問の仕事・タスク・関係する判断は consult --ask が足す（nix-darwin の claude/bin/consult の stream_context）
        out = ["# 質問 %s の文脈（%s 時点。%s）" % (ask_id, now().strftime("%Y-%m-%d %H:%M"),
                                              "仕事 %s に結ばれた質問" % stream_id if stream_id else "カードに結ばれていない質問")]
        if task_id:
            report = state_report(root) or {}
            shown = next((t for t in report.get("tasks") or [] if isinstance(t, dict) and t.get("id") == task_id), {})
            row = next((t for t in c.get("tasks") or [] if isinstance(t, dict) and t.get("id") == task_id), None)
            out += ["", "## 聞いているタスク %s（状態は state.ts の判定%s）" % (task_id, "" if shown else "。読めなかったので手書きの値"),
                    "```json", json.dumps(shorten({**(row or {"id": task_id, "note": "帳簿に無い"}), **({"state": shown["state"]} if shown.get("state") else {})},
                                                  "帳簿のタスク %s の欄 " % task_id), ensure_ascii=False, indent=1), "```"]
        out += ["", "## 開いているカードと済んでいないタスク（帳簿の手書きの値）"] + (open_lines(c) or ["- なし"])
        # 仕事に結んだ質問は、仕事に関係する判断だけを数えて詰める（ほかの仕事の判断で上限が埋まり、関係する判断が落ちないように）。
        rows = rulings(root)
        act = sorted(ask_related(root, rows, None, stream_id, None) if stream_id else active_rulings(rows), key=ruling_num, reverse=True)
        body, size, dropped = [], len("\n".join(out)), []
        for r in act:
            line = "- " + ruling_line(r)
            if size + len(line) + 1 > CONTEXT_LIMIT:
                dropped.append(r["id"])
                continue
            body.append(line)
            size += len(line) + 1
        passed = [r for r in act if r["id"] not in dropped]
        out += ["rulings_seen: R%d" % max([ruling_num(r) for r in passed] + [0]),
                "", "## %s（新しい順。原文つき）" % ("仕事に関係する有効な判断" if stream_id else "有効な判断")] + (body or ["- なし"])
        if dropped:
            out.append("- ほか %d 件（%s）は長さの上限で省いた。要るときに %s の同じ id の行を読む" % (len(dropped), "・".join(dropped), path_of(root, "rulings.jsonl")))
    log = git_log(root)
    if log:
        out += ["", "## git の最近の履歴（%s。git log --oneline -15）" % root] + ["- " + l for l in log]
    return "\n".join(out)


def ask_since(root, ask_id, since, own=None):
    """質問の返しの rulings_seen より後に増えた判断（窓口が反映する直前の確かめ。own の返しから書いた行は除く）。
    カード付きはカードの相談と同じ関係する判断、仕事付きは仕事とその下のタスクに関係する判断、どちらにも結ばれていない質問は全部。"""
    rows = rulings(root)
    card_id, _, stream_id = ask_binding(root, ask_id)
    card = find_card(root, card_id) if card_id else None
    if card is not None or stream_id:
        new = ask_related(root, rows, card_id if card is not None else None, stream_id, since)
    else:
        new = [r for r in rows if ruling_num(r) > since and r.get("kind") in BINDING + ("revoke",)]
    return [r for r in new if not own or r.get("from_return") != own]


def consult_ask_env():
    """CONSULT_ASK=<root>#<質問 id>。形が違うか root に操縦席が無ければ (None, None)。"""
    root, sep, ask_id = (os.environ.get("CONSULT_ASK") or "").rpartition("#")
    if not (sep and root and ASK_ID.fullmatch(ask_id) and os.path.isfile(os.path.join(root, ".orca", "cockpit.json"))):
        return None, None
    return root, ask_id


def text_of(msg):
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content
    return "".join(c.get("text") or "" for c in content or [] if isinstance(c, dict) and c.get("type") == "text")


def last_reply(inp):
    """その回の相手の最後の返事。hook の入力の last_assistant_message が無ければ、会話の記録の最後の人の発言より後から取る
    （同じメッセージが内容のかたまりごとに複数行に書かれるので、最後に文のあるメッセージの行をつなぐ）。"""
    text = inp.get("last_assistant_message")
    if isinstance(text, str) and text.strip():
        return text
    turn = []
    for row in read_jsonl(inp.get("transcript_path") or ""):
        msg = row.get("message") or {}
        if row.get("type") == "user" and (isinstance(msg.get("content"), str) or text_of(msg)):
            turn = []
        elif row.get("type") == "assistant" and text_of(msg):
            turn.append((msg.get("id"), text_of(msg)))
    if not turn:
        return ""
    last = turn[-1][0]
    return "".join(t for i, t in turn if i == last) if last else turn[-1][1]


RETURN_MARK = "【窓口への返し】"
# 返しは返事の末尾にだけ置く（途中に貼った例や、深田さんが貼った書式の例を返しとして拾わない。11.6 の 2・7）。
# 途中に例があっても末尾の 1 塊だけを読むよう、最後の印の行から末尾までに当てる（Codex の指摘 5）
# 閉じの囲みは行の頭だけで見る（JSON の文字列の中のバッククォートは許す）
RETURN_TAIL = re.compile(r"【窓口への返し】[^\n]*\n+```(?:json)?[ \t]*\n(.*?)\n[ \t]*```\s*\Z", re.S)
UTTERANCE_ID = re.compile(r"u-\d+")


def reply_return(text, ask_id, ops=None):
    """(返し, 断る理由)。末尾に印の行と JSON の塊が無ければ (None, None)。ops は窓が書いた op の一覧（op の照合に使う）。

    窓口が判断の記録・依頼に書けない返し（原文・発言の id の無い決定、rulings_seen の無い返し）は、保存する前に相手に直させる。"""
    text = text or ""
    m = RETURN_TAIL.match(text, text.rfind("\n【窓口への返し】") + 1)  # 印の行が無ければ先頭から当てて外れる
    if not m:
        # 末尾に無いものは、書式の説明や例として書いたものかもしれないので、直させずに拾わない
        return None, None
    try:
        v = json.loads(m.group(1))
    except ValueError as e:
        return None, "【窓口への返し】の JSON を読めない（%s）" % e
    if not isinstance(v, dict):
        return None, "【窓口への返し】は JSON のオブジェクト 1 つ"
    return check_return(v, ask_id, True, ops)


def check_return(v, owner, ask, ops=None):
    """(返し, 断る理由)。質問の返し（owner が質問 id）とカードの相談の返し（owner がカード id）の形を同じ規則で確かめる。
    return_id は書かなくてよく、書いてあっても外す（番号は save_return が付ける。相手が推し量った番号で衝突しないように）。"""
    # 道具が付ける欄は、相手が書いても使わない
    v = {k: x for k, x in v.items() if k not in ("return_id", CONFLICT) + RECORD_FIELDS}
    if not ask:
        if v.get("card") not in (None, owner):
            return None, "card は相談しているカードの id（%s）" % owner
        v["card"] = owner
        if not (isinstance(v.get("rev"), int) and not isinstance(v["rev"], bool)):
            return None, "rev に前提にしたカードの rev（数）を書く"
        if not (v.get("choice") is None or isinstance(v["choice"], str)):
            return None, "choice は選んだ選択肢の id か null"
    if "replaces" in v and not (isinstance(v["replaces"], str) and re.fullmatch(r"%s-\d+" % re.escape(owner), v["replaces"])):
        return None, "replaces は保留された返しの return_id（%s-<連番>）" % owner
    if not (isinstance(v.get("rulings_seen"), str) and re.fullmatch(r"R\d+", v["rulings_seen"])):
        return None, "rulings_seen に、読んだ最後の判断の id（R80 の形）を書く"
    for key in ("decisions", "requests", "open", "affects"):
        if not isinstance(v.get(key, []), list):
            return None, "%s は配列" % key
    text_ok = lambda x: isinstance(x, str) and bool(x.strip())
    utt_ok = lambda x: isinstance(x, str) and bool(UTTERANCE_ID.fullmatch(x))
    for d in v.get("decisions") or []:
        if not (isinstance(d, dict) and text_ok(d.get("text")) and text_ok(d.get("quote")) and utt_ok(d.get("utterance"))):
            return None, "decisions の各項目は text（決まったこと）・quote（深田さんの原文）・utterance（発言の id u-12）を持つ"
    for q in v.get("requests") or []:
        if not (isinstance(q, dict) and text_ok(q.get("quote")) and utt_ok(q.get("utterance"))):
            return None, "requests の各項目は quote（依頼の原文）・utterance（発言の id u-12）を持つ"
    if not all(isinstance(x, str) and x for x in (v.get("open") or []) + (v.get("affects") or [])):
        return None, "open は論点の文、affects はタスクの id の配列"
    if not (v.get("decisions") or v.get("requests") or v.get("open") or (not ask and v.get("choice"))):
        return None, "decisions・requests・open のどれも空。決まったことが無ければ返さない"
    if v.get("op") is not None:
        # 別の質問・カードの op や、役割の例の番号をそのまま書いた返しで、その op が片付いたことにしない
        item = "#ask:" + owner if ask else owner
        mine = {str(o.get("op_id")) for o in ops or [] if isinstance(o, dict) and o.get("item_id") == item and (not ask or o.get("type") == "ask_decide")}
        if str(v["op"]) not in mine:
            if ask:
                return None, "op %s はこの質問（%s）の「この答えを窓口に返す」ではない。【相談の知らせ】返しを書いて（op <番号>）で届いた番号だけを書き、届いていなければ op を書かない" % (v["op"], owner)
            return None, "op %s はこのカード（%s）の操作ではない。届いた op の番号だけを書き、届いていなければ op を書かない" % (v["op"], owner)
    return v, None


def reply_key(inp, text):
    """同じ返事を Stop が 2 回処理したと見分ける鍵（会話 id と返事）。hook の入力は返事の message id を持たず、会話の記録の最後の行は
    Stop の時点でまだ書かれていないことがあるので、返事の本文の要約値を message id の代わりにする。"""
    return "%s#%s" % (inp.get("session_id") or "", hashlib.sha256(text.encode("utf-8")).hexdigest()[:16])


def on_ask_stop(root, ask_id, inp):
    """質問の相手の返事を控えに足し、末尾の【窓口への返し】を返しの記録に保存して、窓口の Run に知らせる（11.6 の 2、11.3 の届け方）。
    相手はファイルを書けず orchestration にも送れないので、hook が代わりに書いて送る（hook はモデルの権限の外で動く）。"""
    text = last_reply(inp).strip()
    if not text:
        return
    # 返しの形で差し戻して書き直させた返事（stop_hook_active）も、深田さんが見る最後の答えなので控えに足す
    append_text(ask_memo_path(root, ask_id), "### 答え %s\n%s\n\n" % (now().strftime("%H:%M"), escape_sections(text)))
    ret, err = reply_return(text, ask_id, read_json(os.path.join(root, ".orca", "cockpit.user.json"), {}).get("ops"))
    if ret:
        row, added = save_return(root, ask_id, ret, True, ask=ask_id, session=inp.get("session_id") or "", reply=reply_key(inp, text))
        if added:
            notify_main(root, ask_id, row, True)
    if err and not inp.get("stop_hook_active"):
        out({"decision": "block", "reason": "【質問】返しを保存できなかった: %s。役割の「窓口への返し」の形で、返事の末尾に書き直す" % err})


def sent_id(stdout):
    """orchestration send --json の出力から、送った message の id。形が読めなければ None。"""
    try:
        v = json.loads(stdout)
    except ValueError:
        return None
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            for k in ("messageId", "message_id", "id"):
                if isinstance(x.get(k), str) and (k != "id" or x[k].startswith("msg")):
                    return x[k]
            stack += list(x.values())
        elif isinstance(x, list):
            stack += x
    return None


def notify_main(root, owner, row, ask):
    """保存した返しを窓口の Run に知らせる。(message の id, 送れなかった理由)。知らせは受け取りを早めるためだけで、
    失われても窓口は返しの記録から拾う（unreflected）。"""
    rid = row["return_id"]
    run = (cockpit(root).get("main") or {}).get("run_id")
    if not run:
        return None, "窓口の Run が帳簿（main.run_id）に無い。窓口は開始・再開のときに返しの記録から拾う"
    ret = {k: v for k, v in row.items() if k not in RECORD_FIELDS}
    said = [norm(d.get("text")) for d in ret.get("decisions") or [] if isinstance(d, dict)]
    if ask:
        subject = "質問 %s: 返し %s" % (owner, rid)
        head = "質問 %s の相手が返しを書いた（hook が %s に保存）。cockpit skill の「窓から質問する」の手順で反映する。" % (owner, ask_returns_path(root, owner))
    else:
        subject = "相談 %s: 返し %s" % (owner, rid)
        head = "カード %s の相談が返しを書いた（consult-return が %s に保存）。cockpit skill の「カードの相談」の手順で反映する。" % (owner, card_returns_path(root, owner))
    body = "\n".join([head] + ["- " + s for s in said] + [json.dumps(ret, ensure_ascii=False)])
    frm = ["--from", os.environ["ORCA_TERMINAL_HANDLE"]] if os.environ.get("ORCA_TERMINAL_HANDLE") else []
    try:
        done = subprocess.run([orca_bin(), "orchestration", "send", "--to", "run:" + run, *frm, "--type", "status",
                               "--subject", subject, "--body", body, "--json"],
                              capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        why = str(e)
    else:
        if done.returncode == 0:
            return sent_id(done.stdout), None
        why = (done.stderr or done.stdout).strip()[:200]
    print("compaction-keep: 返し %s を窓口に知らせられなかった: %s" % (rid, why), file=sys.stderr)
    return None, why


def on_ask_session_start(root, ask_id, inp):
    """圧縮のあと、質問の相手に文脈を流し直す（相手はコマンドを使えないので、hook が出す）。"""
    if inp.get("source") != "compact":
        return
    with locked(root):
        keep = load_keep(root)
        text = ask_context(root, ask_id)
        m = SEEN_LINE.search(text)
        if m:
            keep.setdefault("asks", {})[ask_id] = {**keep.get("asks", {}).get(ask_id, {}), "seen": int(m.group(1)), "at": iso()}
            save_keep(root, keep)
    out({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join([
        "【質問】圧縮のあと。役割は claude/roles/ask.md のまま。前の質問と答えは控え %s にある。今の文脈:" % ask_memo_path(root, ask_id), "", text])}})
