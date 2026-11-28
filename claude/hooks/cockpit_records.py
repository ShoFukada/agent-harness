"""操縦席の記録（<root>/.orca/cockpit/）と帳簿の読み取りの共通部分。compaction-keep.py（窓口の hook と道具）と
consult_returns.py（カードの相談と窓からの質問）が使う。

  ① 判断の記録 rulings.jsonl（rule で足す・有効な判断を引く）
  ② 発言の記録 utterances.jsonl と Orca の知らせ notices.jsonl（Orca・窓・背景の作業の知らせの見分け is_relay）
  帳簿 .orca/cockpit.json の読み取り（書かない）、keep.json とそのロック、Orca の CLI と state.ts の呼び出し
"""

import contextlib
import datetime
import fcntl
import json
import os
import re
import subprocess


RULING_KINDS = ("decision", "constraint", "permission", "rejection", "revoke", "none")
# 守る対象として流し直し、照合で ID を求める種類。revoke（撤回）と none（記録しないと決めた dec）は効力を持たない。
BINDING = ("decision", "constraint", "permission", "rejection")
# nix-darwin が ~/.claude/hooks にこの clone の hooks を張る
KEEPER = "~/.claude/hooks/compaction-keep.py"
# カードの相談（claude/bin/consult --card）。カード id と、その相談が窓口に返した 1 回の返しの id（<カード id>-<連番>）
CARD_ID = re.compile(r"[A-Za-z0-9_]+")
RETURN_ID = re.compile(r"[A-Za-z0-9_]+-\d+")
# 窓からの質問（claude/bin/consult --ask。設計 11 章）の id。カードの id（種類の頭文字に連番。相談は q3）とぶつからないよう ask で始める
ASK_ID = re.compile(r"ask\d+")


# ---------- 時刻・ファイル ----------

def now():
    fixed = os.environ.get("COMPACTION_KEEP_NOW")
    if fixed:
        return datetime.datetime.fromisoformat(fixed)
    return datetime.datetime.now().astimezone()


def iso(t=None):
    return (t or now()).isoformat(timespec="seconds")


def ts(s):
    """ISO 8601 の日時を時刻の数にする。窓は UTC の Z で書くので、3.9 の fromisoformat が読める形に直す。読めなければ None。"""
    try:
        d = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (d if d.tzinfo else d.astimezone()).timestamp()


def cockpit_root_at(start):
    """start から親へたどった操縦席の root。読むだけの道具は、相談スレッドからも呼べるようにこちらで探す。"""
    d = os.path.abspath(start) if start else ""
    while d and d != "/":
        if os.path.isfile(os.path.join(d, ".orca", "cockpit.json")):
            return d
        if os.path.exists(os.path.join(d, ".git")):
            return None
        d = os.path.dirname(d)
    return None


def path_of(root, name):
    return os.path.join(root, ".orca", "cockpit", name)


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    v = json.loads(line)
                except ValueError:
                    continue
                if isinstance(v, dict):
                    out.append(v)
    except OSError:
        pass
    return out


def append_jsonl(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            v = json.load(fh)
        return v if isinstance(v, type(default)) else default
    except (OSError, ValueError):
        return default


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    os.replace(tmp, path)


def mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


def norm(s):
    return " ".join(str(s or "").split())


# ---------- ① 判断の記録 ----------

def rulings(root):
    return read_jsonl(path_of(root, "rulings.jsonl"))


def active_rulings(rows):
    """置き換えられていない、効力のある判断。撤回（revoke）は置き換え先を消すだけで、自身は効力を持たない。"""
    replaced = {s for r in rows for s in (r.get("supersedes") or [])}
    return [r for r in rows if r.get("id") not in replaced and r.get("kind") in BINDING]


def ruling_line(r):
    head = "%s [%s" % (r["id"], r["kind"])
    if r["kind"] == "permission":
        head += " %s 対象: %s" % ("許可" if r.get("allow") else "禁止", r.get("scope"))
    head += "]"
    parts = [head, norm(r.get("text"))]
    if r.get("rejected"):
        parts.append("却下した案: %s" % r["rejected"])
    if r.get("quote"):
        parts.append("原文「%s」" % r["quote"])
    if r.get("dec"):
        parts.append("操縦席 %s" % r["dec"])
    if r.get("paths"):
        parts.append("パス: %s" % " ".join(r["paths"]))
    if r.get("supersedes"):
        parts.append("置き換え: %s" % "・".join(r["supersedes"]))
    if r.get("affects"):
        parts.append("影響するタスク: %s" % "・".join(r["affects"]))
    if r.get("from_return"):
        parts.append("%sの返し %s" % ("質問" if ASK_ID.fullmatch(r["from_return"].rsplit("-", 1)[0]) else "相談", r["from_return"]))
    return " ".join(parts)


def validate_ruling(r, rows, tasks=None):
    """足す前に形を確かめる。間違った判断は記録を汚し、そのまま毎回流し直されるので、書く時点で断る。"""
    if not isinstance(r, dict):
        return "判断は JSON のオブジェクトで渡す"
    kind = r.get("kind")
    if kind not in RULING_KINDS:
        return "kind は %s のどれか" % " / ".join(RULING_KINDS)
    if not norm(r.get("text")):
        return "text（決定・制約の本文。revoke と none は理由）が要る"
    if kind in ("constraint", "permission", "revoke") and not norm(r.get("quote")):
        return "%s には根拠にした深田さんの発言の原文（quote）が要る" % kind
    if kind == "permission":
        if not norm(r.get("scope")):
            return "permission には許可・禁止の対象（scope）が要る"
        if not isinstance(r.get("allow"), bool):
            return "permission には allow（true が許可・false が禁止）が要る"
    if kind == "rejection" and not norm(r.get("rejected")):
        return "rejection には却下した案の名前（rejected。再提案を見つける短い語）が要る"
    if kind == "none" and not norm(r.get("dec")):
        return "none は記録しないと決めた操縦席のカードの id（dec）を持つ"
    sup = r.get("supersedes") or []
    if not isinstance(sup, list) or not all(isinstance(s, str) for s in sup):
        return "supersedes は置き換える判断の ID の配列"
    if kind == "revoke" and not sup:
        return "revoke には撤回する判断の ID（supersedes）が要る"
    live = {x["id"] for x in active_rulings(rows)}
    gone = [s for s in sup if s not in live]
    if gone:
        return "置き換える判断が有効な判断に無い: %s" % "・".join(gone)
    affects = r.get("affects", [])
    if not isinstance(affects, list) or not all(isinstance(t, str) and t for t in affects):
        return "affects は影響するタスクの id の配列"
    unknown = [t for t in affects if tasks is not None and t not in tasks]
    if unknown:
        return "affects のタスクが操縦席に無い: %s（済のタスクも含めて tasks の id を書く）" % "・".join(unknown)
    paths = r.get("paths") or []
    if not isinstance(paths, list) or not all(isinstance(p, str) and p.startswith("/") for p in paths):
        return "paths は絶対パスの配列"
    if "from_return" in r and not (isinstance(r["from_return"], str) and RETURN_ID.fullmatch(r["from_return"])):
        return "from_return はカードの相談か質問の返しの return_id（<カード id か質問 id>-<連番>）"
    return None


def ruling_num(r):
    m = re.match(r"R(\d+)$", str(r.get("id")))
    return int(m.group(1)) if m else 0


def add_ruling(root, r, session=""):
    """1 行足して返す。同じ相談の返し（from_return）の同じ判断が既にあれば、足さずにその行を返す（2 つ目は False）。"""
    rows = rulings(root)
    c = cockpit(root)
    err = validate_ruling(r, rows, {t.get("id") for t in c.get("tasks") or [] if isinstance(t, dict)} if isinstance(c, dict) else set())
    if err:
        raise ValueError(err)
    # 窓口が返しを反映する途中で止まり、再開で同じ返しをもう一度処理しても、判断は 1 件のまま（設計 10.7 の 1）
    same = next((x for x in rows if r.get("from_return") and x.get("from_return") == r["from_return"]
                 and x.get("kind") == r["kind"] and norm(x.get("text")) == norm(r["text"])), None)
    if same:
        return same, False
    n = max([ruling_num(x) for x in rows] + [0]) + 1
    keep = {k: r[k] for k in ("kind", "text", "quote", "scope", "allow", "rejected", "supersedes", "dec", "paths", "affects", "from_return")
            if k in r and r[k] not in (None, "", [])}
    row = {"id": "R%d" % n, "at": iso(), **keep}
    if session:
        row["session"] = session
    append_jsonl(path_of(root, "rulings.jsonl"), row)
    return row, True


# ---------- ② 発言の記録 ----------

# Orca は worker・担当の知らせ（worker_done・question など）を、深田さんの発言ではないのにユーザーの入力として coordinator に差し込む。その見出し（送り手・種類・罫線）と続く Subject: の行。
# 本人が「──── From: 」で書き始めただけの発言を落とさないよう、見出しの形全体で見る。
# 送り手と種類の間には、優先度の印（[URGENT]・[HIGH]）と古い形の印（[LEGACY READ-ONLY] など）が入る（Orca の orcad-server.js の見出しの組み立て）
RELAY_HEAD = re.compile(r"──── From: \S+ \([^)\s]+\)(?: \[(?:URGENT|HIGH)\])?(?: \[LEGACY [^\]\n]*\])? \([a-z_]+\) ─+\nSubject: ")
# 操縦席の窓・パネルが、深田さんの操作のあとに窓口の端末へ打つ合図（agent-harness の orca/plugins/cockpit/src/store.ts の SIGNAL）。
# 入力の全体が合図の形のときだけ除く（括弧の中には深田さんの書いた直しの文の頭 60 字が入り、改行も含みうる）
PANEL_SIGNAL = re.compile(r"【操縦席】未反映の操作があります(?:（.*）)?", re.S)
# カードの相談と質問のタブへ、consult（起動の指示・引き継ぎ）・窓口（版の差し戻し・反映済み）・窓（「この答えを窓口に返す」）が送る知らせの先頭の印。送る側は claude/bin/consult の CONSULT_NOTICE と
# cockpit skill の references/consult.md の「カードの相談」の 7・「窓から質問する」で、この書式だけを使う。入力に打たれるのは起動の指示と質問のタブ宛てだけで、カードの相談へは orchestration の知らせで届く（R191）。
# 印のあとの種類まで見る（深田さんが「【相談の知らせ】って何？」と書いた発言を落とさないため）
CONSULT_NOTICE = re.compile(r"【相談の知らせ】\s*(?:カードの相談を始める|質問を始める|返しを書いて|引き継ぎ\s*[:：]|反映済み\s*[A-Za-z0-9_]+-\d+|"
                            r"rev\s*\d+\s*に変わった|R\d+(?:\s*・\s*R\d+)*\s*が増えた)")
# Claude Code が背景の作業（subagent・Bash・Monitor）の知らせを人の入力として差し込む本文。
# 入力の全体がこのタグ 1 つのときだけ除く（深田さんが文の途中や頭にタグの名前を書いた発言を落とさないため）
TASK_NOTICE = re.compile(r"<task-notification>\n.*</task-notification>", re.S)
# Orca の「上限が解けたらチャットを自動で続ける」と Claude Code の再開が、人の入力として差し込む 1 文（R114 で設定をオンにした）
AUTO_CONTINUE = re.compile(r"Continue where you left off\.?")
# Orca が端末で動く coordinator（相談のタブなど）に、受信箱の知らせとして差し込む 1 文
ORCA_INBOX = re.compile(r"You have \d+ orchestration messages?\. Run `orca orchestration check[^`]*`\.?")


def is_relay(prompt):
    p = (prompt or "").strip()
    return bool(RELAY_HEAD.match(p) or PANEL_SIGNAL.fullmatch(p) or CONSULT_NOTICE.match(p) or TASK_NOTICE.fullmatch(p)
                or AUTO_CONTINUE.fullmatch(p) or ORCA_INBOX.fullmatch(p))


def utterances(root):
    # 直す前に記録された知らせも読み飛ばす（記録は hook だけが書くので消さない）
    return [u for u in read_jsonl(path_of(root, "utterances.jsonl")) if not is_relay(u.get("prompt"))]


def append_utterance(root, row):
    """発言に一意の id「u-<行番号>」を付けて足す。依頼の帳簿の仕分け（intake.through・none）がこの id で発言を指す。

    同じ秒に 2 行あることがあり、時刻では指せない。id を持たない古い行には、同じ規則の id を先に書き足す
    （移し替えが最後の行の id を intake.through に書くため）。読めない行も行番号を数えるので、番号はずれない。"""
    path = path_of(root, "utterances.jsonl")
    try:
        # splitlines は発言の中の U+2028 などでも切るので、改行だけで切る
        with open(path, encoding="utf-8", newline="") as fh:
            lines = fh.read().split("\n")
    except FileNotFoundError:
        lines = [""]
    # 書きかけで改行の無い最後の行には改行を足してから追記する（足さないと新しい行がつながって読めず、番号も同じになる）
    changed = lines[-1] != ""
    if not changed:
        lines.pop()
    fixed = []
    for n, line in enumerate(lines, 1):
        try:
            v = json.loads(line)
        except ValueError:
            v = None
        if isinstance(v, dict) and not v.get("id"):
            line, changed = json.dumps({"id": "u-%d" % n, **v}, ensure_ascii=False), True
        fixed.append(line)
    if changed:
        tmp = "%s.%d.tmp" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write("".join(l + "\n" for l in fixed))
        os.replace(tmp, path)
    uid = "u-%d" % (len(lines) + 1)
    append_jsonl(path, {"id": uid, **row})
    return uid


NOTICE_HEAD = 400


def append_notice(root, row):
    """Orca の知らせ（worker・担当・Bot から窓口に届いたもの）に id「n-<行番号>」を付けて notices.jsonl に足す。

    窓口が開いた相手・出来事の待ち（帳簿の tasks[].wait）と照らし、解いたら wait.met の by にこの id を書く（R204）。
    本文は頭だけ持つ（全文は orca orchestration inbox で読める）。"""
    path = path_of(root, "notices.jsonl")
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            n = sum(1 for line in fh.read().split("\n") if line.strip())
    except FileNotFoundError:
        n = 0
    nid = "n-%d" % (n + 1)
    append_jsonl(path, {"id": nid, **row, "prompt": (row.get("prompt") or "")[:NOTICE_HEAD]})
    return nid


# ---------- 操縦席の読み取り（書かない） ----------

def cockpit(root):
    return read_json(os.path.join(root, ".orca", "cockpit.json"), {})


def cards(c):
    """形の版 2 のカード。版 1（items）は読まない（窓と state.ts も版 2 だけを読む）。"""
    if not isinstance(c, dict) or c.get("version") != 2:
        return []
    return [x for x in c.get("cards") or [] if isinstance(x, dict)]


def is_decision(card):
    """判断の記録を求めるカード。版 1 の dec は、版 2 で決める・許す・送る文面のある判断（選択肢のある送る前）に分かれた。"""
    k = card.get("kind")
    return k in ("decide", "permit") or (k == "send" and bool(card.get("options")))


def open_lines(c):
    lines = []
    if isinstance(c, dict) and c and c.get("version") != 2:
        lines.append("- 操縦席が版 %s のままで、カードを読めない。移し替えが要る（cockpit skill の references/setup.md「移し替え」）" % c.get("version", 1))
    for x in cards(c):
        if x.get("state") == "open":
            lines.append("- %s %s: %s" % (x.get("id"), x.get("kind"), norm(x.get("title"))))
        elif x.get("state") == "waiting":
            a = x.get("awaiting") if isinstance(x.get("awaiting"), dict) else {}
            lines.append("- %s %s（%sの返事待ち）: %s" % (x.get("id"), x.get("kind"), norm(a.get("who")) or "相手", norm(x.get("title"))))
    for t in c.get("tasks") or []:
        if isinstance(t, dict) and t.get("state") != "ok":
            w = worker_id(t)
            who = " worker %s" % w if w else ""
            # 状態は state.ts が事実から決める（R204）。帳簿の生の値で書けるのは外の待ち（wait）と前提（after）だけ
            w = t.get("wait") if isinstance(t.get("wait"), dict) else {}
            wait = "。待ち（%s）: %s" % (w.get("kind"), norm(w.get("who") or w.get("what") or w.get("why") or w.get("on"))) if w else ""
            after = "。前提: %s" % "・".join(t["after"]) if isinstance(t.get("after"), list) and t["after"] else ""
            lines.append("- %s タスク: %s。次: %s%s%s%s" % (t.get("id"), norm(t.get("title")), norm(t.get("next")) or "-", wait, after, who))
    return lines


def worker_id(t):
    """タスクに結んだ担当・worker の、変わらない id（最初の Orca の Task の id）。

    版 3 の worker は { run_id, task_id } で、今の Dispatch は Orca からたどる。task_id の無い古い行だけ dispatch_id で指す。"""
    w = t.get("worker") if isinstance(t, dict) else None
    return (w.get("task_id") or w.get("dispatch_id") or None) if isinstance(w, dict) else None


def live_workers(c):
    """続ける worker・担当。済んでいないタスクの worker_id と、開いた担当の受け取り（owners[].worker。t159）と、答えで受ける別名（古い行の dispatch_id）。"""
    out = {}
    for t in c.get("tasks") or []:
        w = worker_id(t)
        if w and t.get("state") != "ok":
            out[w] = {w, t["worker"].get("dispatch_id")} - {None}
    for o in c.get("owners") or []:
        w = worker_id(o)
        if w and isinstance(o, dict) and o.get("state") != "done":
            out[w] = {w}
    return out


def done_decisions(c):
    return [x for x in cards(c) if is_decision(x) and x.get("state") == "done"]


# ---------- keep.json ----------

_HELD = set()


@contextlib.contextmanager
def locked(root):
    """keep.json と返しの記録の読み書きを 1 つずつにする（PostCompact と SessionStart(compact) は同時に走ることがある）。
    同じプロセスで取り直すと flock が自分を待って止まるので、持っている間の入れ子はそのまま通す。"""
    p = path_of(root, "keep.lock")
    key = os.path.realpath(p)
    if key in _HELD:
        yield
        return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        _HELD.add(key)
        try:
            yield
        finally:
            _HELD.discard(key)
            fcntl.flock(fh, fcntl.LOCK_UN)


def load_keep(root):
    return read_json(path_of(root, "keep.json"), {})


def save_keep(root, keep):
    write_json(path_of(root, "keep.json"), keep)


# ---------- Orca と state.ts ----------

def orca_bin():
    return os.environ.get("COMPACTION_KEEP_ORCA", "orca")


def orca_call(args, timeout=5):
    """orca の --json を呼び、(result, None) か (None, 失敗の理由) を返す。result が辞書でなければ空の辞書にする。"""
    try:
        done = subprocess.run([orca_bin(), *args, "--json"], capture_output=True, text=True, timeout=timeout)
        v = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        return None, str(e) or type(e).__name__
    if isinstance(v, dict) and v.get("ok"):
        return (v["result"] if isinstance(v.get("result"), dict) else {}), None
    err = v.get("error") if isinstance(v, dict) else None
    why = err if isinstance(err, str) else (err.get("message") or err.get("code")) if isinstance(err, dict) else done.stderr
    return None, norm(why)[:300] or "orca が失敗した"


def orca_result(args):
    """orca の --json の result。失敗・時間切れ・読めない出力は空（組み直しを止めない）。"""
    return orca_call(args)[0] or {}


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def cockpit_state_path():
    return os.environ.get("COCKPIT_STATE") or os.path.expanduser("~/.config/agent-harness/orca/plugins/cockpit/window/state.ts")


def state_report(root, files=False):
    """state.ts の判定（窓と同じ）。読めなければ None。files は Orca を読まずにファイルだけで決まる検査を読むとき（state.ts の --files）。"""
    try:
        done = subprocess.run(["node", cockpit_state_path(), root, *(["--files"] if files else [])], capture_output=True, text=True, timeout=10)
        v = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    return v if isinstance(v, dict) else None
