#!/usr/bin/env python3
"""操縦席のあるワークスペースのメインが、自動圧縮を何十回重ねても決定・制約・許可・却下理由・パスを落とさずに続けるための hook と道具。

元の記録は会話の外（<root>/.orca/cockpit/）に置き、圧縮のたびにそこから組み直す。要約は薄く保ち、記録を写させない。
  rulings.jsonl      ① 判断の記録。メインが決めた時点で `rule` で 1 行足す。撤回は置き換え（supersedes）として書く
  utterances.jsonl   ② 深田さんの発言の原文。UserPromptSubmit が id（u-<行番号>）を付けて追記する（モデルを通さない。Orca の知らせは除く）
  compactions.jsonl  圧縮の回数・要約の大きさ・state.md の古さ・照合の結果
  keep.json          ⑥ 再開の確かめと ⑦ 引き継ぎの状態
  handoff.json       ⑦ 引き継いだことを窓に 1 行出すための知らせ（窓が読む）

hook（標準入力に Claude Code の hook の JSON）:
  UserPromptSubmit  ② 発言の記録、⑦ 引き継ぎ（その日の最初の発言の前）、作業メモの「今の順番」を流す（知らせのターンは ID と理由だけ。R186）
  PreCompact        ③ 薄い要約の指示（stdout が要約の指示になる）
  PostCompact       記録と、要約の照合（撤回された判断の ID・却下した案・落ちたパス）
  SessionStart      ④ 組み直し（compact。最後の発言より後に届いた Orca の知らせの見出しも）と、引き継いだ新しいチャットへの組み直し（startup）
  PreToolUse(Bash)  ⑥ 照合を通るまで worker・担当への新しい指示（orca orchestration send / worker-start・orca-launch）を止める
  PreToolUse(Write・Edit・MultiEdit)  帳簿（.orca/cockpit.json）の直書きを断り、書く道具 cockpit-write を案内する（COCKPIT_LEDGER_GUARD=1 のときだけ）
  PostToolUse       1 ターンで呼び出しや読んだファイルが多い窓口に、作業を出すよう 1 回促す（subagent は数えない）
  Stop              ① 判断の書き漏れ・⑤ state.md の大きさ・⑥ 未回答・仕分けていない発言（COCKPIT_LEDGER_GUARD=1 のときだけ）を、ターンの終わりに 1 回促す。
                    最後の返事が英語主体なら、それとは別にターンに 1 回だけ日本語で書き直させる

道具（メインが Bash で呼ぶ。root を省くと cwd から操縦席を探す）:
  compaction-keep.py rule [root] < 判断の JSON      ① 1 行足して ID を出す（同じ返しの同じ判断は足さずに既にある行を出す）
  compaction-keep.py rulings [root] [kind]           有効な判断を原文で出す（kind で constraint などに絞る）
  compaction-keep.py slots [root]                    空き枠と待ちのタスク（開始・再開のときに hook が出す）
  compaction-keep.py relay < hook の入力の JSON      prompt が Orca・窓・背景の作業の知らせなら exit 0、深田さんの発言なら exit 1（periodic-reminder.sh が使う）
  compaction-keep.py resume [root] < 答えの JSON     ⑥ 照合する。合わなければ exit 1
  compaction-keep.py consult-context root カード [--since R<n> [--return <return_id>]]  カードの相談の文脈の束
                                                     （--since は、その判断より後に増えた関係する判断だけ。--return の返しから書いた行は除く）
  compaction-keep.py ask-context root 質問 [--since R<n> [--return <return_id>]]  窓からの質問の文脈（--since は増えた判断だけ）
  compaction-keep.py unreflected [root] [--json]     相談のメモと質問の返しの記録にあって、判断の記録か帳簿に入っていない返し・
                                                     返しの無い「この答えを窓口に返す」・担当に伝えていない返し

操縦席のあるワークスペースのメインだけに効く（periodic-reminder.sh の find_cockpit_root と同じ判定。相談スレッドでは動かない）。
メインの UserPromptSubmit は、Orca の今の Run が帳簿の main.run_id と同じときに、会話 id と席を main-session.json に書く（設計 11.6 の 4）。
例外はカードの相談（claude/bin/consult --card が CONSULT_CARD=<root>#<カード id> を付けて立てる。Orca のチャットで立てたものは
環境変数の代わりに .orca/consult/chats.json の登録で見分ける。chat_card）で、UserPromptSubmit だけが
発言を root の発言の記録に card 付きで足し、前のターンのあとに増えた関係する判断とカードの rev の変化を流す（設計 10.3・10.7）。
もう 1 つの例外は窓からの質問（consult --ask が CONSULT_ASK=<root>#<質問 id> を付けて立てる）で、UserPromptSubmit が発言を ask 付きで
足して判断を流し、Stop が答えを控え ask-<質問 id>.md に足し、末尾の【窓口への返し】を ask-<質問 id>.returns.jsonl に保存して窓口に知らせ、
SessionStart(compact) が文脈を流し直す（設計 11 章）。
操縦席の無いワークスペースでも、Orca の窓口（orca_main_root）の UserPromptSubmit は発言の原文だけを同じ形で
<root>/.orca/cockpit/utterances.jsonl に残す。帳簿・引き継ぎ・判断の催促と PostToolUse の促しはしない。
モデルは呼ばない。hook はプロンプトを妨げないよう、壊れた入力でも exit 0 で黙る。
"""

import contextlib
import datetime
import fcntl
import json
import os
import re
import subprocess
import sys
import textwrap
import time

RULING_KINDS = ("decision", "constraint", "permission", "rejection", "revoke", "none")
# 守る対象として流し直し、照合で ID を求める種類。revoke（撤回）と none（記録しないと決めた dec）は効力を持たない。
BINDING = ("decision", "constraint", "permission", "rejection")
RECENT_UTTERANCES = 10
# 同時に動かす worker の上限（窓口が 11/21 に決めた。席を切り替えても全部の席が利用枠に当たるようなら下げる）。数はここだけに置き、skill は slots の出力を指す
WORKER_LIMIT = 4
HANDOFF_FRESH_SEC = 1800
# 作業メモの目安は CLAUDE.md の 1〜2k トークン。日本語は 1 字 3 バイト・1 字 1 トークン前後なので、2k トークンでおよそ 6〜8KB
MEMO_LIMIT = 8 * 1024
# Claude Code は hook の 1 つの出力が 10,000 字を超えると、全文をファイルに逃がして先頭 2,000 字だけを会話に渡す。
HOOK_TEXT_LIMIT = 9500
FIT_MIN_LINE = 24
# nix-darwin が ~/.claude/hooks にこの clone の hooks を張る
KEEPER = "~/.claude/hooks/compaction-keep.py"
# 許可・禁止・撤回らしい言い回し。当たったターンに判断を記録していなければ Stop で促す。誤検知はメインが一言書いて終える。
PERMISSION_WORDS = re.compile(
    r"て(も)?(いい|よい|OK)|OK|許可|任せ|しないで|するな|禁止|やめて|ダメ|だめ|使わない|"
    r"触らない|触らないで|止めて|待って|勝手に|しなくていい|不要|撤回|取り消"
)
# 引用したパス（"/…/orca" orchestration send・"/…/orca-launch"）も当てる。ヒアドキュメントの本文と行継続は判定の前に外す（strip_command）。
WORKER_SEND = re.compile(
    r"(?:^|[\s;&|(`\"'/])(?:orca[\"']?\s+[\"']?orchestration[\"']?\s+[\"']?(?:send|worker-start)|orca-launch)\b")
REJECT_WORDS = re.compile(r"却下|採らない|不採用|やめ|退け|しない")
# 返事が英語主体かの判定（R55「日本語で説明して。」）。コード・URL・引用ブロック・鉤括弧の中と、パス・識別子・オプションの語は数えない
NON_PROSE = re.compile(r"```.*?(?:```|\Z)|~~~.*?(?:~~~|\Z)|`[^`\n]*`|https?://\S+|^[ \t]*>.*$|「[^「」]*」|『[^『』]*』", re.S | re.M)
NON_PROSE_TOKEN = re.compile(r"[^\s「」（）()、。]*(?:/|_|\w\.\w|::|=)[^\s「」（）()、。]*|(?<!\S)--?\w\S*")
JA_CHAR = re.compile(r"[ぁ-ゖァ-ヺー一-龯々〆ヵヶ]")
EN_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
# 「OK」「Done.」のような短い返事は止めない。日本語 1 字を英単語 0.5 語と見て、英単語が日本語の字数の 2 倍を超えたら英語主体
EN_MIN_WORDS = 6
# カードの相談（claude/bin/consult --card）。カード id と、その相談が窓口に返した 1 回の返しの id（<カード id>-<連番>）
CARD_ID = re.compile(r"[A-Za-z0-9_]+")
RETURN_ID = re.compile(r"[A-Za-z0-9_]+-\d+")
# 窓からの質問（claude/bin/consult --ask。設計 11 章）の id。カードの id（種類の頭文字に連番。相談は q3）とぶつからないよう ask で始める
ASK_ID = re.compile(r"ask\d+")
# 相談の文脈の束の目安。超える判断はパスと ID だけにし、要るときに読ませる（設計 10.2、R33「必要に応じて情報を取得する」）
CONTEXT_LIMIT = 8000
LONG_FIELD = 600
# 窓口が 1 ターンで作業を抱え込んだ目安（R69）。読むのは CLAUDE.md の「3 ファイル以上を読む調べものは subagent」、呼び出しは確認と指示で収まる 20 回前後より少し上
BUSY_TOOL_CALLS = 25
BUSY_READ_FILES = 3


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


def find_cockpit_root(start):
    """periodic-reminder.sh の find_cockpit_root と同じ。worker（下の別のリポジトリ）と相談スレッドはメインではない。"""
    if os.environ.get("CONSULT_THREAD"):
        return None
    return cockpit_root_at(start)


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


def orca_main_root(start):
    """操縦席の無いワークスペースの窓口の root。cwd のリポジトリが元のチェックアウト（.git がフォルダ）で、Orca がこの端末に付けた
    worktree（ORCA_WORKTREE_ID の「<repo id>::<パス>」）がそのリポジトリのときだけ。担当と worker は子の worktree（.git がファイル）に立ち、
    そこから別のチェックアウトへ移っても端末の worktree は子のままなので外れる（worktree-flow の references/launch.md「担当を立てるときの細部」）。"""
    own = (os.environ.get("ORCA_WORKTREE_ID") or "").partition("::")[2]
    if os.environ.get("CONSULT_THREAD") or not own:
        return None
    d = os.path.abspath(start) if start else ""
    while d and d != "/":
        git = os.path.join(d, ".git")
        if os.path.exists(git):
            return d if os.path.isdir(git) and os.path.realpath(d) == os.path.realpath(own) else None
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

@contextlib.contextmanager
def locked(root):
    """keep.json の読み書きを 1 つずつにする（PostCompact と SessionStart(compact) は同時に走ることがある）。"""
    p = path_of(root, "keep.lock")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def load_keep(root):
    return read_json(path_of(root, "keep.json"), {})


def save_keep(root, keep):
    write_json(path_of(root, "keep.json"), keep)


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
# （agent-harness の orca/plugins/cockpit/window/server.ts の askMessage）。言葉は発言として残し、末尾の知らせの行は発言に入れない
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
            # server.ts の askWords と同じ（案を選んだら「案 A で。」、書いたらその文）
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


def memo_returns(text):
    """相談のメモの「## 窓口に返したもの」の節にある ```json の塊のうち、return_id を持つもの（相談スレッドが送る前に書く）。"""
    m = re.search(r"^## 窓口に返したもの[^\n]*\n(.*?)(?=^## |\Z)", text or "", re.S | re.M)
    out = {}
    for block in RETURN_BLOCK.findall(m.group(1) if m else ""):
        try:
            v = json.loads(block)
        except ValueError:
            continue
        if isinstance(v, dict) and isinstance(v.get("return_id"), str) and RETURN_ID.fullmatch(v["return_id"]):
            out.setdefault(v["return_id"], v)
    return list(out.values())


def unreflected_returns(root):
    """相談のメモにあって、判断の記録の from_return か帳簿のカードの from_returns のどちらかに無い返し（設計 10.7 の 1）と、
    窓口が版違い・増えた判断で保留にした返し（カードの held_returns。相談が返し直すまで残す）。
    形は state.ts の checks.unreflected_returns と同じ { id, card, missing[], memo }。missing は 判断の記録・帳簿・保留。"""
    folder = os.path.join(root, ".orca", "consult")
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".md"))
    except OSError:
        names = []
    in_rulings = {r.get("from_return") for r in rulings(root)}
    in_ledger = {x for card in ledger_cards(root) if isinstance(card.get("from_returns"), list) for x in card["from_returns"]}
    # 片付いた・移したカードの保留も数える（窓口が片付けるときに held_returns を空にするまで残す）
    held = {x: card.get("id") for card in ledger_cards(root) if isinstance(card.get("held_returns"), list) for x in card["held_returns"]}
    out = []
    for name in names:
        path = os.path.join(folder, name)
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        for v in memo_returns(text):
            missing = [label for label, have in (("判断の記録", in_rulings), ("帳簿", in_ledger)) if v["return_id"] not in have]
            missing += ["保留"] if v["return_id"] in held else []
            if missing:
                out.append({"id": v["return_id"], "card": v.get("card") or name[:-3], "missing": missing, "memo": path})
    # 相談がメモに書き損ねた返しでも、保留にしたものは相談が返し直すまで名指しする
    named = {x["id"] for x in out}
    out += [{"id": x, "card": c, "missing": ["保留"], "memo": None} for x, c in sorted(held.items()) if x not in named]
    return out + unreflected_asks(root, in_rulings)


def unreflected_lines(root):
    left = unreflected_returns(root)
    if not left:
        return []

    def line(x):
        if "ask" not in x:
            return "- %s（カード %s。無いもの: %s。メモ: %s）" % (x["id"], x["card"], "・".join(x["missing"]), x["memo"] or "無い")
        if x.get("op") is not None:
            return "- 質問 %s の「この答えを窓口に返す」（op %s）に結ばれた返しが無い。質問のタブに返しを頼み直すか、答えの控え %s から窓口が反映して op を applied_ops に足す" % (
                x["ask"], x["op"], x["memo"])
        tasks = "（%s）" % "・".join(x["tasks"]) if x.get("tasks") else ""
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
    rid = v.get("return_id")
    if not (isinstance(rid, str) and re.fullmatch(r"%s-\d+" % re.escape(ask_id), rid)):
        return None, "return_id は %s-<連番>（ask の id にハイフンと数）" % ask_id
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
    if not (v.get("decisions") or v.get("requests") or v.get("open")):
        return None, "decisions・requests・open のどれも空。決まったことが無ければ【窓口への返し】を書かない"
    if v.get("op") is not None:
        # 別の質問の「この答えを窓口に返す」や、役割の例の番号をそのまま書いた返しで、その op が片付いたことにしない（Codex の指摘 1）
        mine = {str(o.get("op_id")) for o in ops or [] if isinstance(o, dict) and o.get("type") == "ask_decide" and o.get("item_id") == "#ask:" + ask_id}
        if str(v["op"]) not in mine:
            return None, "op %s はこの質問（%s）の「この答えを窓口に返す」ではない。【相談の知らせ】返しを書いて（op <番号>）で届いた番号だけを書き、届いていなければ op を書かない" % (v["op"], ask_id)
    return v, None


def on_ask_stop(root, ask_id, inp):
    """質問の相手の返事を控えに足し、末尾の【窓口への返し】を返しの記録に保存して、窓口の Run に知らせる（11.6 の 2、11.3 の届け方）。
    相手はファイルを書けず orchestration にも送れないので、hook が代わりに書いて送る（hook はモデルの権限の外で動く）。"""
    text = last_reply(inp).strip()
    if not text:
        return
    # 返しの形で差し戻して書き直させた返事（stop_hook_active）も、深田さんが見る最後の答えなので控えに足す
    append_text(ask_memo_path(root, ask_id), "### 答え %s\n%s\n\n" % (now().strftime("%H:%M"), escape_sections(text)))
    ret, err = reply_return(text, ask_id, read_json(os.path.join(root, ".orca", "cockpit.user.json"), {}).get("ops"))
    path = ask_returns_path(root, ask_id)
    if ret:
        with locked(root):
            have = {r.get("return_id"): r for r in read_jsonl(path)}
            old = have.get(ret["return_id"])
            strip = lambda r: {k: v for k, v in r.items() if k not in ("ask", "saved_at", "session")}
            if old is None:
                append_jsonl(path, {**ret, "ask": ask_id, "saved_at": iso(), "session": inp.get("session_id") or ""})
            elif strip(old) != strip(ret):
                err = "return_id %s は使い済み（中身が違う）。使っていない次の番号で書き直す" % ret["return_id"]
        if old is None:
            notify_main(root, ask_id, ret)
    if err and not inp.get("stop_hook_active"):
        out({"decision": "block", "reason": "【質問】返しを保存できなかった: %s。役割の「窓口への返し」の形で、返事の末尾に書き直す" % err})


def notify_main(root, ask_id, ret):
    """新しい返しを窓口の Run に知らせる。知らせは受け取りを早めるためだけで、失われても窓口は返しの記録から拾う（unreflected）。"""
    run = (cockpit(root).get("main") or {}).get("run_id")
    if not run:
        return
    said = [norm(d.get("text")) for d in ret.get("decisions") or [] if isinstance(d, dict)]
    body = "\n".join(["質問 %s の相手が返しを書いた（hook が %s に保存）。cockpit skill の「窓から質問する」の手順で反映する。" % (ask_id, ask_returns_path(root, ask_id))]
                     + ["- " + s for s in said] + [json.dumps(ret, ensure_ascii=False)])
    head = ["--from", os.environ["ORCA_TERMINAL_HANDLE"]] if os.environ.get("ORCA_TERMINAL_HANDLE") else []
    try:
        done = subprocess.run([orca_bin(), "orchestration", "send", "--to", "run:" + run, *head, "--type", "status",
                               "--subject", "質問 %s: 返し %s" % (ask_id, ret["return_id"]), "--body", body, "--json"],
                              capture_output=True, text=True, timeout=10)
        if done.returncode != 0:
            print("compaction-keep: 返し %s を窓口に知らせられなかった: %s" % (ret["return_id"], (done.stderr or done.stdout).strip()[:200]), file=sys.stderr)
    except (OSError, subprocess.TimeoutExpired) as e:
        print("compaction-keep: 返し %s を窓口に知らせられなかった: %s" % (ret["return_id"], e), file=sys.stderr)


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


def ledger_asks(root):
    out = []
    for c in (cockpit(root), read_json(os.path.join(root, ".orca", "cockpit.archive.json"), {})):
        out += [x for x in c.get("asks") or [] if isinstance(x, dict) and isinstance(x.get("id"), str)]
    return out


def ask_ids(root):
    try:
        names = os.listdir(os.path.join(root, ".orca", "consult"))
    except OSError:
        return []
    return sorted({m.group(1) for n in names for m in [re.fullmatch(r"ask-(ask\d+)\.(?:md|returns\.jsonl)", n)] if m}, key=lambda s: int(s[3:]))


def unreflected_asks(root, in_rulings):
    """質問の返しのうち、窓口が反映し終えていないもの（11.3・11.6 の 2・3・5）。形は state.ts の checks.unreflected_returns と同じで、ask を持つ:
      { id: return_id, ask, missing[], memo, returns, tasks? }  missing は 判断の記録・帳簿（asks[].from_returns）・保留（asks[].held_returns）・担当への通知
      { id: null, ask, op, missing: ['返し'], memo }            「この答えを窓口に返す」（ask_decide の op）に結ばれた返しが無く、op も applied_ops に無い"""
    asks = {a["id"]: a for a in ledger_asks(root)}
    reflected = {x for a in asks.values() for x in a.get("from_returns") or [] if isinstance(x, str)}
    held = {x: a["id"] for a in asks.values() for x in a.get("held_returns") or [] if isinstance(x, str)}
    found, bound = {}, set()
    for ask_id in ask_ids(root):
        path = ask_returns_path(root, ask_id)
        for v in read_jsonl(path):
            rid = v.get("return_id")
            if not (isinstance(rid, str) and RETURN_ID.fullmatch(rid)):
                continue
            if v.get("op") is not None:
                bound.add((ask_id, str(v["op"])))
            missing = [label for label, have in (("判断の記録", in_rulings), ("帳簿", reflected)) if rid not in have]
            found.setdefault(rid, {"id": rid, "ask": ask_id, "missing": [], "memo": ask_memo_path(root, ask_id), "returns": path})["missing"] = missing
    for rid, ask_id in held.items():
        found.setdefault(rid, {"id": rid, "ask": ask_id, "missing": [], "memo": ask_memo_path(root, ask_id), "returns": None})["missing"].append("保留")
    # 窓口が担当・worker に伝え損ねた返し。Run が替わっても新しい窓口が拾えるよう、帳簿の notify[] の message_id の有無で見る
    for a in asks.values():
        for n in a.get("notify") or []:
            if isinstance(n, dict) and isinstance(n.get("return_id"), str) and not n.get("message_id"):
                x = found.setdefault(n["return_id"], {"id": n["return_id"], "ask": a["id"], "missing": [], "memo": ask_memo_path(root, a["id"]), "returns": None})
                if "担当への通知" not in x["missing"]:
                    x["missing"].append("担当への通知")
                x.setdefault("tasks", []).append(n.get("task"))
    out = [x for x in found.values() if x["missing"]]
    log = read_json(os.path.join(root, ".orca", "cockpit.user.json"), {}).get("ops") or []
    applied = {str(o) for o in cockpit(root).get("applied_ops") or []}
    undone = {str(o.get("undo_of")) for o in log if isinstance(o, dict) and o.get("type") == "undo"}
    for o in log:
        if not (isinstance(o, dict) and o.get("type") == "ask_decide" and str(o.get("item_id") or "").startswith("#ask:")):
            continue
        op, ask_id = str(o.get("op_id")), o["item_id"][len("#ask:"):]
        if (ask_id, op) not in bound and op not in applied and op not in undone:
            out.append({"id": None, "ask": ask_id, "op": o.get("op_id"), "missing": ["返し"], "memo": ask_memo_path(root, ask_id)})
    return out


def record_main_session(root, inp):
    """窓口の会話 id・会話のファイル・席を main-session.json に 1 組で置き換える（consult --ask が写す元。11.1・11.6 の 4・7）。
    同じ worktree で動く別の会話を窓口と取り違えないよう、Orca の今の Run が帳簿の main.run_id と同じときだけ書く。
    呼ぶ側が locked(root) を取る（帳簿と保存値はロックの中で読む）。"""
    run = (cockpit(root).get("main") or {}).get("run_id")
    if not run:
        return
    row = {"run_id": run, "session_id": inp.get("session_id") or "", "transcript_path": inp.get("transcript_path") or "",
           "config_dir": os.environ.get("CLAUDE_CONFIG_DIR") or "", "cwd": inp.get("cwd") or root}
    path = path_of(root, "main-session.json")
    old = read_json(path, {})
    if not row["session_id"] or all(old.get(k) == v for k, v in row.items()):
        return
    if orca_result(["orchestration", "run-current"]).get("runId") != run:
        return
    write_json(path, {**row, "at": iso()})


# ---------- ④ 組み直し ----------

def slot_lines(root):
    """空いた枠と待ちのタスク。作業中と未着手は state.ts の判定で数える（手書きの run は worker_done のあとも残り、枠を占めたままに見える）。"""
    c = cockpit(root)
    rows = {t.get("id"): t for t in (c.get("tasks") or []) if isinstance(t, dict)} if isinstance(c, dict) else {}
    report = state_report(root)
    shown = report.get("tasks") if isinstance(report, dict) else None
    if not isinstance(shown, list):
        head = "## 空き枠と待ちのタスク（上限 %d。state.ts を読めず、作業中の数と空きは不明。node %s <root> で確かめる）" % (WORKER_LIMIT, cockpit_state_path())
        idle = [t for t in rows.values() if t.get("state") == "idle" or (isinstance(t.get("wait"), dict) and t["wait"].get("kind") == "slot")]
    else:
        busy = sum(1 for t in shown if isinstance(t, dict) and t.get("from") == "working")
        head = "## 空き枠と待ちのタスク（上限 %d・作業中 %d・空き %d。worker_done の取り込みと再開のときに、優先の順に空き枠へ出す）" % (WORKER_LIMIT, busy, max(0, WORKER_LIMIT - busy))
        idle = [rows.get(t.get("id")) or t for t in shown if isinstance(t, dict) and t.get("state") == "idle"]
    out = ["", head]
    for t in idle:
        w = t.get("worker") if isinstance(t.get("worker"), dict) else {}
        who = " worker run %s・task %s" % (w.get("run_id") or "-", w.get("task_id") or "-") if w else ""
        out.append("- %s（%s）: %s%s" % (t.get("id"), t.get("stream") or "仕事なし", norm(t.get("title")), who))
    return out + ([] if idle else ["- 待ちのタスクは無い"])


def clip_lines(text, width, source):
    lines, cut = [], False
    for line in text.split("\n"):
        if len(line) > width and line.strip() and not line.lstrip().startswith("#"):
            line, cut = line[:width - 1] + "…", True
        lines.append(line)
    return "\n".join(lines + (["（長い行を %d 字で切った。全文は %s）" % (width, source)] if cut else []))


def collapse(text, source):
    head = next((x for x in text.split("\n") if x.strip()), "")
    return "%s\n%s（%d 字を省いた。全文は %s）" % ("\n" if text.startswith("\n") else "", head, len(text), source)


def fit(blocks, limit=HOOK_TEXT_LIMIT):
    """blocks は (本文, 全文の読み方, 削る順) の列で、"\\n" でつなぐ。読み方が None の塊は削らない。削る順の大きい塊から削る。"""
    cur = [b[0] for b in blocks]
    for tier in sorted({b[2] for b in blocks if b[1]}, reverse=True):
        if len("\n".join(cur)) <= limit:
            break
        idx = [i for i, b in enumerate(blocks) if b[1] and b[2] == tier]

        def size(width):
            return len("\n".join(clip_lines(blocks[i][0], width, blocks[i][1]) if i in idx else t for i, t in enumerate(cur)))
        lo, hi, best = FIT_MIN_LINE, max(len(x) for i in idx for x in blocks[i][0].split("\n")), None
        while lo <= hi:
            mid = (lo + hi) // 2
            if size(mid) <= limit:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        for i in idx:
            cur[i] = clip_lines(blocks[i][0], best, blocks[i][1]) if best else collapse(blocks[i][0], blocks[i][1])
    return "\n".join(cur)


def start_context(head, args):
    """--memo <path> <見出し> で作業メモを、--root <root> で操縦席の有効な制約・空き枠・反映していない返しを足す。"""
    blocks = [(head.rstrip("\n"), None, 0)]
    if "--memo" in args:
        i = args.index("--memo")
        path, label = args[i + 1], args[i + 2]
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                blocks.append(("\n# 作業メモ (%s)\n%s" % (label, fh.read().rstrip()), path, 1))
    root = cockpit_root_at(args[args.index("--root") + 1]) if "--root" in args else None
    if root:
        try:
            rules = ["- " + ruling_line(r) for r in active_rulings(rulings(root)) if r.get("kind") == "constraint"]
            if rules:
                blocks.append(("\n".join(["", "# 守る制約（.orca/cockpit/rulings.jsonl の有効な constraint。原文つき）"] + rules),
                               "%s rulings %s constraint" % (KEEPER, root), 1))
        except (OSError, ValueError) as e:
            blocks.append(("\n【記録】有効な制約を読み出せなかった（%s）。%s rulings %s constraint で出せる" % (e, KEEPER, root), None, 0))
        blocks.append(("\n".join(slot_lines(root)), "%s slots %s" % (KEEPER, root), 1))
        left = unreflected_lines(root)
        if left:
            blocks.append(("\n".join(left), "%s unreflected %s" % (KEEPER, root), 1))
    return fit(blocks)


def reassembly(root, heading):
    # 時刻を推し量って書かないよう、組み直しの先頭に今の時刻を出す（11/21 に作業メモの時刻が約 5 時間 20 分ずれた）
    blocks = [("今の時刻: %s（date の値。過去の出来事の時刻は op・ログ・git の記録から取る）\n# %s（compaction-keep。元の記録は .orca/cockpit/ にある）"
               % (now().strftime("%Y-%m-%d %H:%M %z"), heading), None, 0)]
    memo = path_of(root, "state.md")
    if os.path.isfile(memo):
        with open(memo, encoding="utf-8") as fh:
            blocks.append(("\n## 作業メモ (.orca/cockpit/state.md)\n" + fh.read().rstrip(), memo, 1))
    opens = open_lines(cockpit(root))
    blocks.append(("\n".join(["", "## 開いている操縦席のカードと済んでいないタスク（状態は state.ts の出力で読む）"] + (opens or ["- なし"])),
                   "node %s %s の出力" % (cockpit_state_path(), root), 1))
    blocks.append(("\n".join(slot_lines(root)), "%s slots %s" % (KEEPER, root), 1))
    left = unreflected_lines(root)
    if left:
        blocks.append(("\n".join(left), "%s unreflected %s" % (KEEPER, root), 1))
    act = active_rulings(rulings(root))
    held = [r for r in act if r.get("kind") != "decision"]
    blocks.append(("\n".join(["", "## 有効な判断（.orca/cockpit/rulings.jsonl。撤回・置き換え済みのものは除いてある。ここに無い判断は効力が無い）",
                              "### 制約・許可・却下"] + (["- " + ruling_line(r) for r in held] or ["- なし"])),
                   "%s rulings %s" % (KEEPER, root), 2))
    blocks.append(("\n".join(["### 決定"] + (["- " + ruling_line(r) for r in act if r.get("kind") == "decision"] or ["- なし"])),
                   "%s rulings %s decision" % (KEEPER, root), 3))
    recent = utterances(root)[-RECENT_UTTERANCES:]
    blocks.append(("\n".join(["", "## 深田さんの直近の発言 %d 件（原文。古い順）" % len(recent)]
                             + (["- %s\n%s" % (u.get("at", ""), textwrap.indent(str(u.get("prompt") or ""), "  ")) for u in recent] or ["- なし"])),
                   path_of(root, "utterances.jsonl") + "（発言の直近 %d 件。Orca の知らせの行は除く）" % len(recent), 4))
    return blocks


def orca_bin():
    return os.environ.get("COMPACTION_KEEP_ORCA", "orca")


def orca_result(args):
    """orca の --json の result。失敗・時間切れ・読めない出力は空（組み直しを止めない）。"""
    try:
        done = subprocess.run([orca_bin(), *args, "--json"], capture_output=True, text=True, timeout=5)
        v = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {}
    return v["result"] if isinstance(v, dict) and v.get("ok") and isinstance(v.get("result"), dict) else {}


def late_notices(root):
    """深田さんの最後の発言より後に窓口の Run の受信箱へ届いた知らせ（古い順）。

    要約は圧縮の直前に届いた知らせを落とす（2026-11-21 に担当の知らせを 1 時間ほど見落とした）。
    check は既読にするので使わず、既読にしない inbox で読む。chat の窓口は自分の Run を run-current で引ける。"""
    said = utterances(root)
    since = ts(said[-1].get("at")) if said else None
    run = orca_result(["orchestration", "run-current"]).get("runId") if since is not None else None
    if not isinstance(run, str) or not run:
        return [], None
    msgs = orca_result(["orchestration", "inbox", "--terminal", "run:" + run, "--full", "--limit", "50"]).get("messages")
    late = [m for m in msgs if isinstance(m, dict) and (ts(m.get("created_at")) or 0) > since] if isinstance(msgs, list) else []
    return sorted(late, key=lambda m: ts(m.get("created_at"))), run


def notice_lines(msgs, run):
    if not msgs:
        return []
    return ["", "## 深田さんの最後の発言より後に届いた Orca の知らせ %d 件（古い順。要約に入っていないことがある。本文は orca orchestration inbox --terminal run:%s --full にある）" % (len(msgs), run)] + [
        "- %s %s（%s）: %s" % (m.get("created_at", ""), m.get("from_handle", ""), m.get("type", ""), norm(m.get("subject"))) for m in msgs]


def resume_request(root):
    ids = [r["id"] for r in active_rulings(rulings(root))]
    return "\n".join([
        "",
        "## 再開の確かめ（⑥。通るまで orca orchestration send / worker-start・orca-launch は止まる）",
        "確かめは `%s resume %s` が標準入力の JSON で行う（手順は cockpit skill の references/resume.md）。照合するのは ID・許可の対象と値・却下した案・パス。JSON の形:" % (KEEPER, root),
        '{"next": "次にやること 1〜3 文", "rulings": [守る判断の ID を全部], "permissions": [{"id", "scope", "allow"} 有効な許可・禁止を全部],'
        ' "workers": [済んでいないタスクの worker.task_id（Orca の最初の Task の id）], "paths": [編集の途中のファイルの絶対パス]}',
        "有効な判断の ID: %s" % ("・".join(ids) or "なし"),
    ])


# ---------- ⑥ 照合 ----------

def rejected_hits(text, act):
    """却下した案を、却下だと書かずに出している行。"""
    hits = []
    for r in act:
        if r.get("kind") != "rejection":
            continue
        word = norm(r.get("rejected"))
        for line in str(text or "").splitlines():
            if word and word in line and not REJECT_WORDS.search(line) and r["id"] not in line:
                hits.append((r["id"], word, norm(line)[:80]))
                break
    return hits


def verify_answer(ans, rows, c, required_paths):
    """構造化した答えを記録と操縦席に突き合わせ、食い違いの一覧を返す（空なら合格）。ID の一致だけでなく、許可の対象と値・却下した案・パスも見る。"""
    if not isinstance(ans, dict):
        return ["答えは JSON のオブジェクトで渡す"]
    issues = []
    act = active_rulings(rows)
    live = {r["id"]: r for r in act}
    known = {r.get("id"): r for r in rows}
    cited = [x for x in ans.get("rulings") or [] if isinstance(x, str)]
    perms = [p for p in ans.get("permissions") or [] if isinstance(p, dict)]
    for x in cited + [p.get("id") for p in perms]:
        if x not in live:
            issues.append("%s は有効な判断ではない（%s）" % (x, "撤回・置き換え済み" if x in known else "記録に無い"))
    for x in sorted(set(live) - set(cited) - {p.get("id") for p in perms}, key=lambda s: int(s[1:]) if s[1:].isdigit() else 0):
        issues.append("%s（%s）が答えに無い: %s" % (x, live[x]["kind"], norm(live[x].get("text"))[:60]))
    for p in perms:
        r = live.get(p.get("id"))
        if not r:
            continue
        if r.get("kind") != "permission":
            issues.append("%s は許可・禁止の判断ではない（%s）" % (r["id"], r["kind"]))
            continue
        if p.get("allow") is not r.get("allow"):
            issues.append("%s の値が違う: 記録は%s" % (r["id"], "許可" if r.get("allow") else "禁止"))
        if norm(p.get("scope")) != norm(r.get("scope")):
            issues.append("%s の対象が違う: 記録は「%s」" % (r["id"], r.get("scope")))
    for r in act:
        if r.get("kind") == "permission" and r["id"] in cited and r["id"] not in {p.get("id") for p in perms}:
            issues.append("%s は許可・禁止なので permissions に対象と値を書く" % r["id"])
    for rid, word, line in rejected_hits(ans.get("next"), act):
        issues.append("次にやることに却下した案「%s」（%s）がある: %s" % (word, rid, line))
    want = live_workers(c)
    got = {w for w in ans.get("workers") or [] if isinstance(w, str)}
    for w in sorted(w for w, names in want.items() if not names & got):
        issues.append("続ける worker %s が答えに無い" % w)
    for w in sorted(got - set().union(*want.values())):
        issues.append("worker %s は操縦席の済んでいないタスクに無い" % w)
    have = {os.path.normpath(p) for p in ans.get("paths") or [] if isinstance(p, str)}
    for p in required_paths:
        if os.path.normpath(p) not in have:
            issues.append("パス %s が答えに無い（圧縮のときに編集の途中だった）" % p)
    if not norm(ans.get("next")):
        issues.append("next（次にやること）が空")
    return issues


def lint_summary(summary, rows, required_paths, memo_text):
    """要約そのものの照合。撤回された判断の ID を生きたものとして引いていないか、却下した案を出していないか、パスを落としていないか。"""
    issues = []
    live = {r["id"] for r in active_rulings(rows)}
    known = {r.get("id") for r in rows}
    for line in str(summary or "").splitlines():
        for x in re.findall(r"\bR\d+\b", line):
            if x in known and x not in live and not re.search(r"撤回|置き換え|取り消", line):
                issues.append("撤回・置き換え済みの %s を引いている: %s" % (x, norm(line)[:80]))
    for rid, word, line in rejected_hits(summary, active_rulings(rows)):
        issues.append("却下した案「%s」（%s）を出している: %s" % (word, rid, line))
    for p in required_paths:
        if p not in (summary or "") and p not in (memo_text or ""):
            issues.append("パス %s が要約にも作業メモにも無い" % p)
    return issues


EDIT_TOOLS = ("Edit", "MultiEdit", "NotebookEdit")


def is_boundary(row):
    return row.get("type") == "system" and row.get("subtype") == "compact_boundary"


def count_boundaries(transcript):
    return sum(1 for row in read_jsonl(transcript) if is_boundary(row)) if transcript else 0


def repo_relpath(p):
    """リポジトリの root からの相対パス。リポジトリの外なら None。"""
    d = os.path.dirname(p)
    while d and d != "/":
        if os.path.exists(os.path.join(d, ".git")):
            return os.path.relpath(p, d)
        d = os.path.dirname(d)
    return None


def names_path(command, p):
    """コマンドがそのファイルをパスで挙げているか（ファイル名だけの一致は、同じ名前の別のファイルと区別できないので数えない）。"""
    rel = repo_relpath(p)
    return any(re.search(r"(?<![\w./-])%s(?![\w./-])" % re.escape(x), command) for x in (p, rel) if x)


def edited_paths(transcript, boundaries_before=None):
    """圧縮の直前の区切り（compact_boundary の間）で編集の途中だったファイル。いま有る絶対パスだけ。

    Edit したものと 2 回以上 Write したものを数える。1 回 Write しただけのもの（brief）と、最後の編集のあと
    artifact に公開できたもの（出来上がったページ）・パスを挙げて commit できたものは外す
    （2026-11-21 の 3 回の圧縮で、再開の確かめから外れたパスはこの 3 つと、空の区切りから遡ったものだけだった）。
    boundaries_before は PreCompact の時点の区切りの数。"""
    segments, cur, talked, seen = [], [], False, set()
    for row in read_jsonl(transcript) if transcript else []:
        if is_boundary(row):
            segments.append((cur, talked))
            cur, talked = [], False
            continue
        talked = talked or row.get("type") == "assistant"
        msg = row.get("message") or {}
        for c in msg.get("content") or [] if isinstance(msg, dict) and isinstance(msg.get("content"), list) else []:
            if isinstance(c, dict) and c.get("type") == "tool_result":
                cur.append(("result", c.get("tool_use_id"), not c.get("is_error"), None))
            if not (isinstance(c, dict) and c.get("type") == "tool_use"):
                continue
            # 会話の記録は同じ tool_use を 2 行に書くことがある
            if c.get("id"):
                if c["id"] in seen:
                    continue
                seen.add(c["id"])
            i = c.get("input") or {}
            p = i.get("file_path") or i.get("notebook_path")
            if c.get("name") == "Bash" and isinstance(i.get("command"), str):
                cur.append(("Bash", c.get("id"), None, i["command"]))
            elif isinstance(p, str) and p.startswith("/"):
                cur.append((c.get("name"), c.get("id"), p, i.get("action")))
    segments.append((cur, talked))
    # 今回の区切りがもう書かれていれば、その手前が今回の区切り。手前で何も編集していなければ空のまま返す（もっと前の区切りまで遡らない）。
    # PreCompact の数が無いときは、区切りのあとにモデルが話していない（要約だけ）ことで見分ける
    written = len(segments) - 1 > boundaries_before if boundaries_before is not None else not segments[-1][1]
    if len(segments) > 1 and written:
        segments.pop()
    edits, writes, last, finished, pending = {}, {}, {}, {}, {}
    for n, (name, uid, p, arg) in enumerate(segments[-1][0]):
        if name == "result":
            # 公開と commit は、成功の結果が返ってから済んだとみなす（pre-commit で落ちた commit は済んでいない）
            done, at = pending.pop(uid, ([], 0))
            if p:  # 結果の行では 3 つ目が成功したか
                finished.update({q: at for q in done})
        elif name == "Artifact" and arg in (None, "publish"):
            pending[uid] = ([p], n)
        elif name == "Bash" and "git commit" in arg:
            # パスを挙げた commit だけを見る（git add -A のようにパスの無い commit は見分けない）
            pending[uid] = ([q for q in last if names_path(arg, q)], n)
        elif name in EDIT_TOOLS or name == "Write":
            count = edits if name in EDIT_TOOLS else writes
            count[p] = count.get(p, 0) + 1
            last[p] = n
    return [p for p in last if (edits.get(p) or writes.get(p, 0) >= 2) and finished.get(p, -1) < last[p] and os.path.exists(p)]


# ---------- ⑦ 引き継ぎ ----------

def repeat_presses(root, since):
    log = read_json(os.path.join(root, ".orca", "cockpit.user.json"), {})
    after = ts(since) if since else None
    return [o for o in log.get("ops") or [] if isinstance(o, dict) and o.get("type") == "repeat"
            and ts(o.get("at")) is not None and (after is None or ts(o.get("at")) > after)]


def handoff_reason(root, keep):
    # 照合が 2 回続けて合わなかった予約は、そのあと照合が通っても消さない（引き継ぐまで残す）
    if keep.get("handoff_due"):
        return keep["handoff_due"]
    if len(repeat_presses(root, keep.get("handoff_at"))) >= 2:
        return "窓の「前にも言った」が 2 回押された"
    return None


def first_of_day(prior):
    """直前までの発言の最後が今日より前（または発言が無い）なら、これがその日の最初の発言。"""
    if not prior:
        return True
    t = ts(prior[-1].get("at", ""))
    if t is None:
        return True
    return datetime.datetime.fromtimestamp(t, now().tzinfo).date() < now().date()


def launch_chat(root, prompt):
    """新しいチャットを起こし、深田さんの発言を最初のメッセージとして渡す（--prompt が無いと空のチャットのまま答えない）。"""
    orca = orca_bin()
    first ="（前のチャットから引き継いだ深田さんの発言。組み直しの記録を読み、再開の確かめを通してから答える）\n\n" + prompt
    try:
        done = subprocess.run([orca, "agent", "launch", "--agent", "claude", "--worktree", "path:" + root,
                               "--surface", "chat", "--prompt", first, "--json"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return done.returncode == 0, (done.stdout or done.stderr).strip()[:300]


# ---------- hook ----------

def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def fresh_handoff(h):
    """起動中か、受け取られた直後の引き継ぎ。この間は次の引き継ぎを起こさない（新しいチャットに渡した発言で連鎖させない）。"""
    at = ts((h or {}).get("at"))
    return (h or {}).get("state") in ("launching", "launched", "taken") and at is not None and now().timestamp() - at <= HANDOFF_FRESH_SEC


# 作業メモの先頭に窓口が持つ「今の順番」（R184）。形は cockpit skill の「メインの作業メモ」
ORDER_HEAD = "## 今の順番"
ORDER_MAX = 3
ORDER_WIDTH = 120  # 1 行の上限（字）。長い理由で流し込みが膨らまないように


def order_lines(root, relay=False):
    """今の順番の 1〜3 行。深田さんの発言のターンはタスクの題を帳簿から添え、知らせのターン（relay）は ID と理由だけにする（R186）。
    帳簿の next は添えない。作業メモの順番と食い違う古い next が「次」として並んだため（監査の指摘 2）。"""
    try:
        with open(path_of(root, "state.md"), encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        text = ""
    rows, inside = [], False
    for line in text.split("\n"):
        if line.strip() == ORDER_HEAD:
            inside = True
            continue
        if inside and line.lstrip().startswith("#"):
            break
        # 字下げした補足の行は数えない（3 件の枠を食わないように）
        if inside and re.match(r"(?:\d+[.)]|[-*])\s+\S", line):
            rows.append(re.sub(r"^(?:\d+[.)]|[-*])\s+", "", line).strip())
    if not rows:
        # 知らせのターンには書くよう促さない（念押しを流さない。R186）
        return [] if relay else ["【今の順番】作業メモ .orca/cockpit/state.md の先頭に「%s」が無い（書き方は cockpit skill の references/memo.md「今の順番」）" % ORDER_HEAD]
    c = cockpit(root)
    tasks = {t.get("id"): t for t in (c.get("tasks") or []) if isinstance(t, dict)} if isinstance(c, dict) and not relay else {}
    out = ["【今の順番】" if relay else "【今の順番】（作業メモの先頭）"]
    for n, row in enumerate(rows[:ORDER_MAX], 1):
        # ja-review が「t119 監査」を「t119監査」に詰めるので、\b（漢字も単語の文字）でなく数字の切れ目で ID を取る
        m = re.match(r"(t\d+)(?!\d)", row)
        title = (tasks.get(m.group(1)) or {}).get("title") if m else None
        line = "%d. %s%s" % (n, row, "（%s）" % title if title else "")
        out.append(line if len(line) <= ORDER_WIDTH else line[:ORDER_WIDTH - 1] + "…")
    return out


def on_prompt(root, inp):
    session = inp.get("session_id") or ""
    prompt = inp.get("prompt") or ""
    with locked(root):
        prior = utterances(root)
        keep = load_keep(root)
        # ターンはセッションごとに持つ。引き継ぎで同じワークスペースに 2 つのチャットがあると、片方の Stop がもう片方のターンを消費するため
        # ファイルの mtime と比べる時刻（clock）は、時計を差し替えるテストでも実時間で持つ
        keep["turns"] = {k: v for k, v in (keep.get("turns") or {}).items() if time.time() - (v.get("clock") or 0) < 7 * 86400}
        keep["turns"][session] = {"at": iso(), "clock": time.time()}
        for old in ("turn_at", "turn_clock", "stop_nudged"):  # セッションごとに持つ前の欄
            keep.pop(old, None)
        if is_relay(prompt):
            # Orca の知らせだけを記録する（窓の合図・相談の知らせ・背景の作業の知らせは、待ちを解く出来事ではない）
            if RELAY_HEAD.match(prompt.strip()):
                append_notice(root, {"at": iso(), "session": session, "prompt": prompt.strip()})
            save_keep(root, keep)
            # 知らせが続く離席中も順番を見失わないよう、ID と理由だけを流す（R186。件数・念押し・checks は流さない）
            lines = order_lines(root, relay=True)
            if lines:
                print("\n".join(lines))
            return
        reason = handoff_reason(root, keep)
        prev = keep.get("handoff")
        # 起動に失敗して launching のまま残っても、期限を過ぎれば次の日にもう一度試せる
        go = bool(reason) and first_of_day(prior) and not fresh_handoff(prev)
        attempt = iso()
        if go:
            # 起動より先に保存する。新しいチャットの SessionStart と最初の発言は起動の途中で走ることがある
            keep["handoff"] = {"state": "launching", "at": attempt, "reason": reason, "from_session": session, "prompt": prompt}
        # 発言も起動より先に記録する。新しいチャットに渡した同じ発言が「その日の最初」と数えられないように
        append_utterance(root, {"at": attempt, "session": session, "prompt": prompt, **({"handoff": True} if go else {})})
        save_keep(root, keep)
    if not go:
        print("\n".join(order_lines(root)))
        return
    ok, detail = launch_chat(root, prompt)
    with locked(root):
        keep = load_keep(root)
        h = keep.get("handoff") or {}
        mine = h.get("at") == attempt
        # CLI がタイムアウトなどで失敗を返しても、新しいチャットが受け取っていれば引き継ぎは済んでいる
        ok = ok or (mine and h.get("state") == "taken")
        if ok:
            if mine and h.get("state") == "launching":
                h["state"] = "launched"
            keep["handoff"] = h
            keep["handoff_at"] = attempt
            keep.pop("handoff_due", None)
            v = keep.get("verify") or {}
            if v.get("session") == session:
                keep["verify"] = {}
        elif mine:
            if prev is None:
                keep.pop("handoff", None)
            else:
                keep["handoff"] = prev
        save_keep(root, keep)
    append_jsonl(path_of(root, "compactions.jsonl"), {"type": "handoff", "at": iso(), "session": session, "reason": reason, "ok": ok, "detail": detail})
    if ok:
        write_json(path_of(root, "handoff.json"), {"at": attempt, "reason": reason})
        out({"decision": "block",
             "reason": "このチャットの記憶が崩れてきたため（%s）、同じワークスペースの新しいチャットに引き継ぎました。"
                       "いまの発言は新しいチャットに渡してあります。Orca のチャットの一覧から新しいチャットを開いてください。" % reason})
    else:
        print("【引き継ぎ】%s ため新しいチャットへの引き継ぎを試みたが失敗した（%s）。このチャットのまま続いている。記録の元は .orca/cockpit/（state.md・rulings.jsonl・utterances.jsonl）" % (reason, detail))
        print("\n".join(order_lines(root)))


def on_bare_prompt(root, inp):
    prompt = inp.get("prompt") or ""
    if is_relay(prompt):
        return
    with locked(root):
        append_utterance(root, {"at": iso(), "session": inp.get("session_id") or "", "prompt": prompt})


THIN = """この要約は 1.5k トークン以内で書く。次の記録は圧縮のあとに hook が原文で流し直すので、中身を写さず ID で指す（R12・d51・t3・o1 など）:
- 作業メモ .orca/cockpit/state.md
- 操縦席 .orca/cockpit.json（カード・タスク・担当・worker）
- 判断の記録 .orca/cockpit/rulings.jsonl（決定・制約・許可・却下した案）
- 深田さんの発言の記録 .orca/cockpit/utterances.jsonl（直近 10 件を流す）
作業中のことだけを具体的に書く。落とさないもの: いま触っているファイルの絶対パス・リンク・タスクと項目の ID・担当と worker の dispatch id・実行中のジョブの ID・直前のエラー文言の原文。
撤回・置き換え済みの判断を生きたものとして書かない。却下した案を次の一手に書かない。見出しは CLAUDE.md の Compact instructions に従う。"""


def on_precompact(root, inp):
    lines = [THIN]
    memo = mtime(path_of(root, "state.md"))
    newest = max(mtime(os.path.join(root, ".orca", "cockpit.json")), mtime(path_of(root, "rulings.jsonl")))
    if memo and newest > memo:
        lines.append("作業メモが操縦席・判断の記録より %d 分古い。作業メモに無い直近の決定と変更を、ID 付きで要約の冒頭に残す。" % ((newest - memo) // 60))
    elif not memo:
        lines.append("作業メモ（.orca/cockpit/state.md）がまだ無い。作業中のことを Compact instructions の見出しで具体的に残す。")
    # PostCompact で、今回の区切りがもう会話の記録に書かれたかを数の増減で見分けるため
    keep = load_keep(root)
    keep["precompact"] = {"session": inp.get("session_id") or "", "boundaries": count_boundaries(inp.get("transcript_path"))}
    save_keep(root, keep)
    print("\n".join(lines))


def on_postcompact(root, inp):
    session = inp.get("session_id") or ""
    summary = inp.get("compact_summary") or ""
    rows = rulings(root)
    memo_path = path_of(root, "state.md")
    memo_text = open(memo_path, encoding="utf-8").read() if os.path.isfile(memo_path) else ""
    keep = load_keep(root)
    pre = keep.get("precompact") or {}
    required = edited_paths(inp.get("transcript_path"), pre.get("boundaries") if pre.get("session") == session else None)
    issues = lint_summary(summary, rows, required, memo_text)
    memo = mtime(memo_path)
    newest = max(mtime(os.path.join(root, ".orca", "cockpit.json")), mtime(path_of(root, "rulings.jsonl")))
    log = path_of(root, "compactions.jsonl")
    n = sum(1 for r in read_jsonl(log) if r.get("type") == "compact" and r.get("session") == session) + 1
    append_jsonl(log, {"type": "compact", "at": iso(), "session": session, "trigger": inp.get("trigger"), "n": n,
                       "summary_chars": len(summary), "state_md_age_sec": int(now().timestamp() - memo) if memo else None,
                       "state_md_stale": bool(memo) and newest > memo, "summary_issues": issues, "required_paths": required})
    keep.pop("precompact", None)
    v = keep.get("verify") or {}
    keep["verify"] = {"pending": True, "since": iso(), "session": session, "failures": v.get("failures", 0) if v.get("pending") else 0,
                      "required_paths": required, "summary_issues": issues}
    save_keep(root, keep)


def on_session_start(root, inp):
    source = inp.get("source")
    session = inp.get("session_id") or ""
    keep = load_keep(root)
    h = keep.get("handoff") or {}
    if source == "startup" and h.get("state") in ("launching", "launched") and h.get("from_session") != session:
        at = ts(h.get("at"))
        if at is not None and now().timestamp() - at <= HANDOFF_FRESH_SEC:
            keep["handoff"] = {**h, "state": "taken", "to_session": session}
            keep["verify"] = {"pending": True, "since": iso(), "session": session, "failures": 0, "required_paths": []}
            save_keep(root, keep)
            text = fit(reassembly(root, "前のチャットからの引き継ぎ（%s）" % h.get("reason", "")) + [
                ("\n## 最初のメッセージ\n最初のメッセージは、前のチャットで受けた深田さんのこの日の最初の発言（原文）。答えるのは再開の確かめを通ったあと。", None, 0),
                (resume_request(root), None, 0)])
            out({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}})
            return
    if source != "compact":
        return
    v = keep.get("verify") or {}
    if not (v.get("pending") and v.get("session") == session):
        keep["verify"] = {"pending": True, "since": iso(), "session": session, "failures": v.get("failures", 0) if v.get("pending") else 0,
                          "required_paths": v.get("required_paths", []) if v.get("session") == session else []}
        save_keep(root, keep)
    msgs, run = late_notices(root)
    # chat の窓口の hook から run-current で Run を引けたかを、次の本物の圧縮で確かめられるよう残す
    append_jsonl(path_of(root, "compactions.jsonl"), {"type": "notices", "at": iso(), "session": session, "run": run, "n": len(msgs)})
    blocks = reassembly(root, "圧縮のあとの組み直し")
    if msgs:
        blocks.append(("\n".join(notice_lines(msgs, run)), "orca orchestration inbox --terminal run:%s --full" % run, 4))
    blocks.append((resume_request(root), None, 0))
    issues = (keep.get("verify") or {}).get("summary_issues") or []
    if issues:
        blocks.append(("\n## 要約の照合で見つかった食い違い（要約より上の記録を正とする）\n" + "\n".join("- " + i for i in issues), None, 0))
    out({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": fit(blocks)}})


def strip_command(command):
    """行継続をつなぎ、ヒアドキュメントの本文を外す（resume に渡す JSON の中の「orca orchestration send」で止めないため）。"""
    out_lines, ends = [], []
    for line in command.replace("\\\n", " ").split("\n"):
        if ends:
            if line.strip() == ends[0]:
                ends.pop(0)
            continue
        out_lines.append(line)
        ends += re.findall(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", line)
    return "\n".join(out_lines)


def on_pretool(root, inp):
    if inp.get("tool_name") != "Bash":
        return
    v = load_keep(root).get("verify") or {}
    if not (v.get("pending") and v.get("session") == inp.get("session_id")):
        return
    if WORKER_SEND.search(strip_command((inp.get("tool_input") or {}).get("command") or "")):
        out({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                    "permissionDecisionReason": "圧縮のあとの再開の確かめ（compaction-keep.py resume）を通るまで、worker・担当への新しい指示（orca orchestration send / worker-start・orca-launch）を止めている。"
                                                                "記録と操縦席を読み直し、cockpit skill の「圧縮のあと」の形で答えてから打ち直す"}})


def on_posttool(root, inp):
    if inp.get("agent_id"):  # subagent の呼び出し（deny-destructive-ops.sh と同じ見分け方）
        return
    keep = load_keep(root)
    mine = (keep.get("turns") or {}).get(inp.get("session_id") or "")
    if mine is None or mine.get("busy_nudged"):
        return
    mine["tools"] = mine.get("tools", 0) + 1
    reads = mine.setdefault("reads", [])
    p = (inp.get("tool_input") or {}).get("file_path") if inp.get("tool_name") == "Read" else None
    p = os.path.normpath(os.path.join(inp.get("cwd") or root, p)) if isinstance(p, str) and p else None
    if p and p not in reads:
        reads.append(p)
    busy = mine["tools"] >= BUSY_TOOL_CALLS or len(reads) >= BUSY_READ_FILES
    mine["busy_nudged"] = busy
    save_keep(root, keep)
    if busy:
        out({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext":
             "【窓口】このターンでツールを %d 回呼び、別々のファイルを %d 件読んだ。窓口の作業の出し方（subagent・worker・担当）は"
             "役割の文書 roles/main.md にある。すぐ終わる確認ならこのまま続けて差し支えない" % (mine["tools"], len(reads))}})


# ---------- 帳簿を書く道具に限る（操縦席 版 3） ----------

def ledger_guard(dot_orca):
    """帳簿の直書きを止める hook と未仕分けの Stop の入り切り。agent-harness の窓・書く道具が入り、
    帳簿を migrate-v3 で移したあとに窓口が settings.json の env で 1 にする（設計 6 章の 7 の ⑤）。
    設定は全案件に共通なので、版 3 の帳簿（intake の欄がある）だけに効かせる。cockpit-write init で作った案件には
    移し替えの控え（cockpit.v2.json）が無いので、控えでは見分けない（R195）。periodic-reminder.sh も `ledger-guard` でこれを呼ぶ。"""
    if os.environ.get("COCKPIT_LEDGER_GUARD") != "1":
        return False
    try:
        with open(os.path.join(dot_orca, "cockpit.json"), encoding="utf-8") as fh:
            ledger = json.load(fh)
    except (OSError, ValueError):
        return False
    return isinstance(ledger, dict) and "intake" in ledger


WRITE_TOOLS = ("Write", "Edit", "MultiEdit")
LEDGER_DENY = ("操縦席の帳簿（.orca/cockpit.json）は Write・Edit で書かない。型・参照・rev・仕分けを検査する書く道具 cockpit-write で、"
               "変えるカード・タスク・依頼・intake・applied_ops を id 単位で渡す（cockpit skill の references/schema.md「書く道具」）。"
               "検査に通らなければ理由が返るので、直して渡し直す")


def ledger_path(path, cwd):
    """操縦席の帳簿なら実体のパス、違えば None。相対パスは cwd から、symlink は実体まで解く（.orca の中で cockpit.json とだけ書いても、別名のリンクでも当てる）。"""
    if not path:
        return None
    p = os.path.realpath(os.path.join(cwd or os.getcwd(), str(path)))
    return p if os.path.basename(p).lower() == "cockpit.json" and os.path.basename(os.path.dirname(p)).lower() == ".orca" else None


def deny_ledger_write(inp):
    """Write・Edit・MultiEdit の対象が操縦席の帳簿なら断る。worker・担当の場所でも同じ（操縦席を書かない）。"""
    if not (inp.get("hook_event_name") == "PreToolUse" and inp.get("tool_name") in WRITE_TOOLS):
        return False
    target = ledger_path((inp.get("tool_input") or {}).get("file_path"), inp.get("cwd"))
    if not (target and ledger_guard(os.path.dirname(target))):
        return False
    out({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": LEDGER_DENY}})
    return True


def cockpit_state_path():
    return os.environ.get("COCKPIT_STATE") or os.path.expanduser("~/.config/agent-harness/orca/plugins/cockpit/window/state.ts")


def state_report(root):
    """state.ts の判定（窓と同じ）。読めなければ None。"""
    try:
        done = subprocess.run(["node", cockpit_state_path(), root], capture_output=True, text=True, timeout=10)
        v = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    return v if isinstance(v, dict) else None


def unsorted_utterances(root):
    """state.ts の checks.unsorted（仕分けていない発言の id）。読めなければ空（ターンの終わりを止めない）。"""
    v = state_report(root) or {}
    got = (v.get("checks") or {}).get("unsorted") or []
    return [x.get("id") if isinstance(x, dict) else x for x in got if isinstance(x, (str, dict))] if isinstance(got, list) else []


def english_reply(msg):
    """地の文が英語主体なら (日本語の字数, 英単語の数)、そうでなければ None。コード・URL・パス・識別子・オプション・引用は数えない。"""
    prose = NON_PROSE.sub(" ", msg or "")
    prose = NON_PROSE_TOKEN.sub(" ", prose)
    ja, words = len(JA_CHAR.findall(prose)), len(EN_WORD.findall(prose))
    return (ja, words) if words >= EN_MIN_WORDS and ja * 2 < words else None


def on_stop(root, inp):
    session = inp.get("session_id") or ""
    keep = load_keep(root)
    reasons = []
    # 「返事は日本語」は他の Stop の差し戻しのあとの返事にも効かせるので、stop_hook_active を見ずにターンに 1 回だけ止める
    mine = (keep.get("turns") or {}).get(session)
    en = english_reply(inp.get("last_assistant_message"))
    if en and mine is not None and not mine.get("ja_nudged"):
        mine["ja_nudged"] = True
        reasons.append("【返事】最後の返事が英語主体（日本語 %d 字・英単語 %d 語。コード・パス・コマンドは数えない）。深田さんへの返事は、作業の合間の説明・"
                       "subagent や担当の報告の中継を含めて日本語で書く。同じ内容を日本語で書き直して終える" % en)
    if not inp.get("stop_hook_active"):
        reasons += ["【記録】" + r for r in record_reasons(root, keep, session)]
    save_keep(root, keep)
    if reasons:
        out({"decision": "block", "reason": "\n".join(reasons) + "\nこれを済ませてから終える"})


def record_reasons(root, keep, session):
    """判断の書き漏れ・作業メモ・再開の確かめ・未仕分け。ターンに 1 回だけ（nudged）。"""
    mine = (keep.get("turns") or {}).get(session)
    if mine is None and keep.get("turn_at"):
        # セッションごとに持つ前の hook が受けた発言のターン（入れ替えた直後の 1 ターン）
        mine = {"at": keep["turn_at"], "clock": keep.get("turn_clock"), "nudged": keep.get("stop_nudged") == keep["turn_at"]}
    mine = mine or {}
    turn_at = mine.get("at")
    if not turn_at or mine.get("nudged"):
        return []
    turn = mine.get("clock") or 0
    reasons = []
    v = keep.get("verify") or {}
    if v.get("pending") and v.get("session") == session:
        reasons.append("圧縮のあとの再開の確かめをまだ通っていない。cockpit skill の「圧縮のあと」の JSON を compaction-keep.py resume に渡す")
    rows = rulings(root)
    wrote = mtime(path_of(root, "rulings.jsonl")) >= turn
    c = cockpit(root)
    since = keep.setdefault("since", turn_at)
    noted = {r.get("dec") for r in rows if r.get("dec")}
    missing = [x.get("id") for x in done_decisions(c) if (ts(x.get("resolved_at")) or 0) >= (ts(since) or 0) and x.get("id") not in noted]
    if missing:
        reasons.append("操縦席で決まったカード %s が判断の記録に無い。決定・制約・許可・却下した案を compaction-keep.py rule で書く（残す判断が無いなら kind: none で dec にカードの id を書く）" % "・".join(missing))
    last = next((u for u in reversed(utterances(root)) if u.get("session") == session), None)
    hit = PERMISSION_WORDS.search(last.get("prompt", "")) if last and (ts(last.get("at")) or 0) >= (ts(turn_at) or 0) else None
    if hit and not wrote:
        reasons.append("このターンの深田さんの発言に許可・禁止・撤回らしい言い回し（「%s」）がある。判断なら compaction-keep.py rule で原文付きで書く（撤回は supersedes で置き換える）。違うならそう一言書いて終える" % hit.group(0))
    loose = unsorted_utterances(root) if ledger_guard(os.path.join(root, ".orca")) else []
    if loose:
        reasons.append("仕分けていない深田さんの発言がある（%s）。発言ごとに、新しい依頼（requests に utterances で結ぶ）・既存の依頼への追記か返答・依頼でない（intake.none）を"
                       "cockpit-write で書き、intake.through を進める（cockpit skill の references/schema.md「依頼の帳簿」）" % "・".join(str(x) for x in loose[:10]))
    # 作業メモの古さでは止めない（R184。帳簿を書くたびに差し戻すと、窓口の会話が事務で埋まる）。作業メモは節目と圧縮の前に書く
    memo = mtime(path_of(root, "state.md"))
    size = os.path.getsize(path_of(root, "state.md")) if memo else 0
    if size > MEMO_LIMIT:
        reasons.append("作業メモ .orca/cockpit/state.md が %.1fKB あり、目安の 1〜2k トークン（%dKB）を超えている。済んだ時刻つきの行を .orca/cockpit/state.history.md へ移し、"
                       "state.md は Compact instructions の見出しで今の状態だけにする（cockpit skill の「メインの作業メモ」）" % (size / 1024, MEMO_LIMIT // 1024))
    if reasons:
        mine["nudged"] = True
        keep.setdefault("turns", {})[session] = mine
    return reasons


HOOKS = {"UserPromptSubmit": on_prompt, "PreCompact": on_precompact, "PostCompact": on_postcompact,
         "SessionStart": on_session_start, "PreToolUse": on_pretool, "PostToolUse": on_posttool, "Stop": on_stop}


def hook():
    try:
        inp = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return
    if not isinstance(inp, dict) or deny_ledger_write(inp):
        return
    event = inp.get("hook_event_name")
    try:
        chat = None if os.environ.get("CONSULT_CARD") else chat_card(inp.get("cwd") or os.getcwd(), inp)
    except OSError as e:
        print("compaction-keep: %s" % e, file=sys.stderr)
        return
    if chat:
        os.environ.update(CONSULT_THREAD="1", CONSULT_CARD=chat)
    if os.environ.get("CONSULT_CARD"):
        # カードの相談は発言の記録と流し込みだけ。圧縮・再開の確かめ・Stop の促しはメインのもの
        root, card_id = consult_card_env()
        if root and event == "UserPromptSubmit":
            try:
                on_thread_prompt(root, inp, "card", card_id, card_id)
            except OSError as e:
                print("compaction-keep: %s" % e, file=sys.stderr)
        return
    if os.environ.get("CONSULT_ASK"):
        # 質問の相手は、発言と答えの控え・返しの保存と知らせ・判断の流し込みだけ（設計 11 章）
        root, ask_id = consult_ask_env()
        try:
            if root and event == "UserPromptSubmit":
                card_id, _, stream_id = ask_binding(root, ask_id)
                on_thread_prompt(root, inp, "ask", ask_id, card_id, stream_id)
            elif root and event == "Stop":
                on_ask_stop(root, ask_id, inp)
            elif root and event == "SessionStart":
                on_ask_session_start(root, ask_id, inp)
        except (OSError, ValueError) as e:
            print("compaction-keep: %s" % e, file=sys.stderr)
        return
    cwd = inp.get("cwd") or os.getcwd()
    root = find_cockpit_root(cwd)
    if not root and event == "UserPromptSubmit":
        bare = orca_main_root(cwd)
        try:
            if bare:
                on_bare_prompt(bare, inp)
        except OSError as e:
            print("compaction-keep: %s" % e, file=sys.stderr)
        return
    fn = HOOKS.get(event)
    if root and fn:
        try:
            if fn is on_prompt:
                fn(root, inp)  # 引き継ぎで新しいチャットを起こす間はロックを外すので、自分で取る
                # 照合から置き換えまでを 1 つずつにする（Run が替わる前の窓口の hook が遅れて、新しい窓口の記録を戻さないように）
                with locked(root):
                    record_main_session(root, inp)
            else:
                with locked(root):
                    fn(root, inp)
        except OSError as e:
            # 記録に失敗しても、プロンプトと作業は止めない
            print("compaction-keep: %s" % e, file=sys.stderr)


# ---------- 道具 ----------

def tool(argv):
    cmd, rest = argv[0], [a for a in argv[1:] if a != "--json"]
    if cmd == "relay":
        try:
            inp = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            inp = {}
        sys.exit(0 if isinstance(inp, dict) and is_relay(inp.get("prompt")) else 1)
    if cmd == "ledger-guard":
        # periodic-reminder.sh が未仕分けの発言を出すかを、この hook と同じ判定で決める（0 で効く、1 で効かない）
        sys.exit(0 if rest and ledger_guard(os.path.join(rest[0], ".orca")) else 1)
    if cmd == "start-context":
        print(start_context(sys.stdin.read(), rest))
        return
    thread = "compaction-keep: 相談スレッドは判断の記録を書かない。決まったことは窓口に返す（役割の「窓口に返す」）"
    if cmd in ("rule", "resume") and (os.environ.get("CONSULT_THREAD") or chat_card(os.getcwd())):
        sys.exit(thread)
    since, own = None, None
    if "--return" in rest:
        i = rest.index("--return")
        own, rest = (rest[i + 1] if i + 1 < len(rest) else ""), rest[:i] + rest[i + 2:]
        if not RETURN_ID.fullmatch(own):
            sys.exit("compaction-keep: --return には return_id（d21-1）を渡す")
    if "--since" in rest:
        i = rest.index("--since")
        m = re.fullmatch(r"R?(\d+)", rest[i + 1] if i + 1 < len(rest) else "")
        if not m:
            sys.exit("compaction-keep: --since には判断の id（R80）を渡す")
        since, rest = int(m.group(1)), rest[:i] + rest[i + 2:]
    root = cockpit_root_at(rest[0] if rest else os.getcwd())
    if not root:
        sys.exit("compaction-keep: 操縦席（.orca/cockpit.json）が見つからない")
    if cmd in ("rule", "resume") and chat_card(root):
        sys.exit(thread)
    session = os.environ.get("CLAUDE_SESSION_ID") or ""
    if cmd == "consult-context":
        if len(rest) < 2 or not CARD_ID.fullmatch(rest[1]):
            sys.exit("compaction-keep: consult-context <root> <カード id> [--since R<n> [--return <return_id>]]")
        card = find_card(root, rest[1])
        if card is None:
            sys.exit("compaction-keep: カード %s が帳簿に無い" % rest[1])
        if since is None:
            print(consult_context(root, rest[1]))
        else:
            stream, tasks, _ = consult_scope(root, card)
            # 反映の途中で止まった窓口が、自分の書いた行を「増えた判断」と数えて自分の返しを保留にしないよう、その返しの行は除く
            new = [r for r in related_rulings(rulings(root), rest[1], stream, tasks, since) if not own or r.get("from_return") != own]
            print("\n".join("- " + ruling_line(r) for r in new) or "- なし")
        return
    if cmd == "ask-context":
        if len(rest) < 2 or not ASK_ID.fullmatch(rest[1]):
            sys.exit("compaction-keep: ask-context <root> <質問 id（ask3）> [--since R<n> [--return <return_id>]]")
        try:
            print(ask_context(root, rest[1]) if since is None else
                  "\n".join("- " + ruling_line(r) for r in ask_since(root, rest[1], since, own)) or "- なし")
        except ValueError as e:
            sys.exit("compaction-keep: %s" % e)
        return
    if cmd == "unreflected":
        left = unreflected_returns(root)
        if "--json" in argv:
            print(json.dumps(left, ensure_ascii=False))
        else:
            print("\n".join(unreflected_lines(root)).strip())
        return
    if cmd == "rulings":
        kind = rest[1] if len(rest) > 1 else None
        for r in active_rulings(rulings(root)):
            if kind is None or r.get("kind") == kind:
                print(ruling_line(r))
        return
    if cmd == "slots":
        print("\n".join(slot_lines(root)).strip())
        return
    try:
        data = json.loads(sys.stdin.read())
    except ValueError as e:
        sys.exit("compaction-keep: JSON を読めない: %s" % e)
    if cmd == "rule":
        try:
            with locked(root):
                row, added = add_ruling(root, data, session)
        except ValueError as e:
            sys.exit("compaction-keep rule: %s" % e)
        head = "記録しました" if added else "同じ返しの同じ判断が記録済みのため足していません"
        print("%s: %s" % (head, ruling_line(row)) if row["kind"] in BINDING else "%s: %s %s" % (head, row["id"], row["kind"]))
        return
    if cmd == "resume":
        with locked(root):
            keep = load_keep(root)
            v = keep.get("verify") or {}
            issues = verify_answer(data, rulings(root), cockpit(root), v.get("required_paths") or [])
            failures = 0 if not issues else v.get("failures", 0) + 1
            keep["verify"] = {**v, "pending": bool(issues), "failures": failures, "last": iso()}
            if failures >= 2:
                keep["handoff_due"] = "圧縮のあとの照合が 2 回続けて合わなかった"
            save_keep(root, keep)
        append_jsonl(path_of(root, "compactions.jsonl"), {"type": "resume", "at": iso(), "session": v.get("session"), "ok": not issues, "issues": issues, "failures": failures})
        if not issues:
            print("照合を通りました。worker への指示を再開できます")
            return
        print("照合が合いません（%d 回目）。記録（compaction-keep.py rulings）・操縦席・作業メモを読み直して出し直す:" % failures)
        for i in issues:
            print("- " + i)
        if failures >= 2:
            print("2 回続けて合わないため、その日の最初の発言の前に新しいチャットへ引き継ぎます（それまではこのチャットで、読み直してから進める）")
        sys.exit(1)
    sys.exit("compaction-keep: 知らないコマンド %s（rule / rulings / slots / relay / resume / consult-context / ask-context / unreflected）" % cmd)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        tool(sys.argv[1:])
    else:
        hook()
