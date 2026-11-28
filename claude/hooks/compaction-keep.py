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
                    switch を打つ会話の id を控える（窓口を替える道具が読む。main_switch.py）
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
  compaction-keep.py consult-return root カード < 返しの JSON  カードの相談の返しを、番号を付けて返しの記録 <カード id>.returns.jsonl に
                                                     保存し、窓口の Run に送る（return_id と送信の結果を 1 行ずつ出す）
  compaction-keep.py ask-context root 質問 [--since R<n> [--return <return_id>]]  窓からの質問の文脈（--since は増えた判断だけ）
  compaction-keep.py switch [root] [--agent antigravity]  窓口を替える。新しい窓口の会話の中で 1 回打つ（Run の引き継ぎ・窓口の種類と
                                                     会話 id の記録・再開の確かめ・受信箱の読み直し。main_switch.py。Claude は --agent を付けない。
                                                     種類を替えないなら、深田さんが新しい会話に話しかけたときに hook が同じことをする）
  compaction-keep.py unreflected [root] [--json]     カードの相談と質問の返しの記録にあって、判断の記録か帳簿に入っていない返し・
                                                     返しの無い「この答えを窓口に返す」・担当に伝えていない返し（判定は state.ts の
                                                     checks.unreflected_returns。先に切り替え前のメモの返しを記録へ取り込む）

操縦席のあるワークスペースのメインだけに効く（periodic-reminder.sh の find_cockpit_root と同じ判定。相談スレッドでは動かない）。
メインの UserPromptSubmit は、Orca の今の Run が帳簿の main.run_id と同じときに、会話 id と席を main-session.json に書く（設計 11.6 の 4）。
深田さんの発言のターンで、その会話が Run を持たなければ switch と同じ手順で main.run_id を引き継ぐ（窓口は最後に話しかけた本線の会話。
main_switch.py の bind_main。t178）。記録の窓口の種類は、switch か引き継ぎのときだけ替わる。
例外はカードの相談（claude/bin/consult --card が CONSULT_CARD=<root>#<カード id> を付けて立てる。Orca のチャットで立てたものは
環境変数の代わりに .orca/consult/chats.json の登録で見分ける。chat_card）で、UserPromptSubmit だけが
発言を root の発言の記録に card 付きで足し、前のターンのあとに増えた関係する判断とカードの rev の変化を流す（設計 10.3・10.7）。
もう 1 つの例外は窓からの質問（consult --ask が CONSULT_ASK=<root>#<質問 id> を付けて立てる）で、UserPromptSubmit が発言を ask 付きで
足して判断を流し、Stop が答えを控え ask-<質問 id>.md に足し、末尾の【窓口への返し】を ask-<質問 id>.returns.jsonl に保存して窓口に知らせ、
SessionStart(compact) が文脈を流し直す（設計 11 章）。
操縦席の無いワークスペースでも、Orca の窓口（orca_main_root）の UserPromptSubmit は発言の原文だけを同じ形で
<root>/.orca/cockpit/utterances.jsonl に残す。帳簿・引き継ぎ・判断の催促と PostToolUse の促しはしない。
モデルは呼ばない。hook はプロンプトを妨げないよう、壊れた入力でも exit 0 で黙る。

このファイルは hook の振り分け・組み直し・照合・引き継ぎ・帳簿の直書き止め・道具の口を持つ。カードの相談と窓からの質問は
consult_returns.py、判断と発言の記録・帳簿の読み取り・keep.json・state.ts の呼び出しは cockpit_records.py、
窓口の会話の記録と窓口を替える道具は main_switch.py にある。
"""

import datetime
import json
import os
import re
import subprocess
import sys
import textwrap
import time

# nix-darwin は ~/.claude/hooks にこの clone の hooks のフォルダを張る。同じフォルダのモジュールを読む
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from cockpit_records import (  # noqa: E402
    ASK_ID, BINDING, CARD_ID, KEEPER, RELAY_HEAD, RETURN_ID, active_rulings, add_ruling, append_jsonl, append_notice, append_utterance,
    cockpit, cockpit_root_at, cockpit_state_path, done_decisions, is_relay, iso, live_workers, load_keep, locked, mtime, norm, now,
    open_lines, orca_bin, orca_result, out, path_of, read_json, read_jsonl, ruling_line, rulings, save_keep, state_report, ts, utterances,
    write_json
)
from consult_returns import (  # noqa: E402
    ask_binding, ask_context, ask_since, chat_card, check_return, consult_ask_env, consult_card_env, consult_context, consult_scope,
    find_card, notify_main, on_ask_session_start, on_ask_stop, on_thread_prompt, related_rulings, returns_report, save_return,
    unreflected_lines, unreflected_returns
)
from main_switch import (  # noqa: E402
    AGENTS, bind_main, claim_switch, launch_args, main_agent, retired, switch, switch_hint
)


RECENT_UTTERANCES = 10
# 同時に動かす worker の上限（窓口が 11/21 に決めた。席を切り替えても全部の席が利用枠に当たるようなら下げる）。数はここだけに置き、skill は slots の出力を指す
WORKER_LIMIT = 4
HANDOFF_FRESH_SEC = 1800
# 引き継ぎ（launch_chat）が新しい窓口に渡す最初の発言の頭。中の時刻は keep.json の handoff.at で、その引き継ぎの 1 回だけ効く
HANDOFF_PROMPT = re.compile(r"【引き継ぎ ([^】\s]+)】")
# 作業メモの目安は CLAUDE.md の 1〜2k トークン。日本語は 1 字 3 バイト・1 字 1 トークン前後なので、2k トークンでおよそ 6〜8KB
MEMO_LIMIT = 8 * 1024
# 反映待ちの整理・棚卸しの指示で Stop を差し戻す間隔。subagent を待つあいだに知らせのターンが続いても、同じ指示で毎ターン止めない（t163）
TIDY_NUDGE_SEC = 1800
# Claude Code は hook の 1 つの出力が 10,000 字を超えると、全文をファイルに逃がして先頭 2,000 字だけを会話に渡す。
HOOK_TEXT_LIMIT = 9500
FIT_MIN_LINE = 24
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
# 窓口が 1 ターンで作業を抱え込んだ目安（R69）。読むのは CLAUDE.md の「3 ファイル以上を読む調べものは subagent」、呼び出しは確認と指示で収まる 20 回前後より少し上
BUSY_TOOL_CALLS = 25
BUSY_READ_FILES = 3


def find_cockpit_root(start):
    """periodic-reminder.sh の find_cockpit_root と同じ。worker（下の別のリポジトリ）と相談スレッドはメインではない。"""
    if os.environ.get("CONSULT_THREAD"):
        return None
    return cockpit_root_at(start)


def orca_main_root(start):
    """操縦席の無いワークスペースの窓口の root。cwd のリポジトリが元のチェックアウト（.git がフォルダ）で、Orca がこの端末に付けた
    worktree（ORCA_WORKTREE_ID の「<repo id>::<パス>」）がそのリポジトリのときだけ。担当と worker は子の worktree（.git がファイル）に立ち、
    そこから別のチェックアウトへ移っても端末の worktree は子のままなので外れる（worktree-flow の references/launch.md「担当を立てる（窓口）」）。"""
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


# ---------- ④ 組み直し ----------

def slot_lines(root, report):
    """空いた枠と待ちのタスク。作業中と未着手は state.ts の判定（report。読めなければ None）で数える（手書きの run は worker_done のあとも残り、枠を占めたままに見える）。"""
    c = cockpit(root)
    rows = {t.get("id"): t for t in (c.get("tasks") or []) if isinstance(t, dict)} if isinstance(c, dict) else {}
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
        # 空き枠と返しの未反映は、state.ts の 1 回の出力から読む（state.ts は Orca を読むので 1 回に数秒かかる）
        try:
            report = returns_report(root)
            left = unreflected_lines(root, report)
        except OSError as e:
            report, left = state_report(root), ["", "【記録】反映していない返しを読み出せなかった（%s）。%s unreflected %s で出せる" % (e, KEEPER, root)]
        blocks.append(("\n".join(slot_lines(root, report)), "%s slots %s" % (KEEPER, root), 1))
        if left:
            blocks.append(("\n".join(left), "%s unreflected %s" % (KEEPER, root), 1))
    return fit(blocks)


def reassembly(root, heading):
    # 時刻を推し量って書かないよう、組み直しの先頭に今の時刻を出す（推し量った時刻は何時間もずれる）
    blocks = [("今の時刻: %s（date の値。過去の出来事の時刻は op・ログ・git の記録から取る）\n# %s（compaction-keep。元の記録は .orca/cockpit/ にある）"
               % (now().strftime("%Y-%m-%d %H:%M %z"), heading), None, 0)]
    memo = path_of(root, "state.md")
    if os.path.isfile(memo):
        with open(memo, encoding="utf-8") as fh:
            blocks.append(("\n## 作業メモ (.orca/cockpit/state.md)\n" + fh.read().rstrip(), memo, 1))
    opens = open_lines(cockpit(root))
    blocks.append(("\n".join(["", "## 開いている操縦席のカードと済んでいないタスク（状態は state.ts の出力で読む）"] + (opens or ["- なし"])),
                   "node %s %s の出力" % (cockpit_state_path(), root), 1))
    report = returns_report(root)
    blocks.append(("\n".join(slot_lines(root, report)), "%s slots %s" % (KEEPER, root), 1))
    left = unreflected_lines(root, report)
    if left:
        blocks.append(("\n".join(left), "%s unreflected %s" % (KEEPER, root), 1))
    act = active_rulings(rulings(root))
    held = [r for r in act if r.get("kind") != "decision"]
    blocks.append(("\n".join(["", "## 有効な判断（.orca/cockpit/rulings.jsonl。撤回・置き換え済みのものは除いてある。有効かは %s rulings %s の出力で確認し、省いた分は示された全文の参照先を読む）" % (KEEPER, root),
                              "### 制約・許可・却下"] + (["- " + ruling_line(r) for r in held] or ["- なし"])),
                   "%s rulings %s" % (KEEPER, root), 2))
    blocks.append(("\n".join(["### 決定"] + (["- " + ruling_line(r) for r in act if r.get("kind") == "decision"] or ["- なし"])),
                   "%s rulings %s decision" % (KEEPER, root), 3))
    recent = utterances(root)[-RECENT_UTTERANCES:]
    blocks.append(("\n".join(["", "## 深田さんの直近の発言 %d 件（原文。古い順）" % len(recent)]
                             + (["- %s\n%s" % (u.get("at", ""), textwrap.indent(str(u.get("prompt") or ""), "  ")) for u in recent] or ["- なし"])),
                   path_of(root, "utterances.jsonl") + "（発言の直近 %d 件。Orca の知らせの行は除く）" % len(recent), 4))
    return blocks


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


def takeover_text(root, lead, full):
    """窓口を引き継いだ会話に出す文（switch と hook の引き継ぎで同じ）。lead は fit の塊。full なら組み直しの記録も付ける。"""
    return fit(lead + (reassembly(root, "窓口を替えたあとの組み直し") if full else []) + [(resume_request(root), None, 0)])


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


def launch_chat(root, prompt, agent, attempt):
    """帳簿に書いた種類の新しい窓口を起こし、深田さんの発言を最初のメッセージとして渡す（--prompt が無いと空のチャットのまま答えない）。
    起こしただけでは窓口の Run の知らせが届かない。新しい窓口の hook が、頭の【引き継ぎ <attempt>】の付いた最初のターンを深田さんの
    発言のターンとして扱い、Run を引き継ぐ（bind_main）。発言は前の窓口が記録したので記録し直さない。"""
    first = "【引き継ぎ %s】（前のチャットから引き継いだ深田さんの発言。組み直しの記録を読み、再開の確かめを通してから答える）\n\n" % attempt + prompt
    try:
        done = subprocess.run([orca_bin()] + launch_args(agent, root, first), capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return done.returncode == 0, (done.stdout or done.stderr).strip()[:300]


# ---------- hook ----------

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
            bind_main(root, inp, False, takeover_text)
            # 知らせが続く離席中も順番を見失わないよう、ID と理由だけを流す（R186。件数・念押し・checks は流さない）
            lines = order_lines(root, relay=True)
            if lines:
                print("\n".join(lines))
            return
        mark = HANDOFF_PROMPT.match(prompt)
        h = keep.get("handoff") or {}
        # 前の窓口が記録して渡した発言（launch_chat）。記録し直さず（仕分けが 2 回になる）、引き継ぎも起こさない
        forwarded = bool(mark) and h.get("at") == mark.group(1) and not h.get("forwarded_to")
        go = False
        # 起こしている間に深田さんが別の会話に話しかけ、その会話が引き継ぎを受けていれば、渡した発言では Run を取り返さない
        speaking = not forwarded or h.get("to_session") in (None, session)
        if forwarded:
            keep["handoff"] = {**h, "forwarded_to": session}
        else:
            reason = handoff_reason(root, keep)
            prev = keep.get("handoff")
            # 起動に失敗して launching のまま残っても、期限を過ぎれば次の日にもう一度試せる
            # 退いた会話の発言では起こさない。その発言で bind_main がその会話を窓口に戻し（R253）、次の日からはほかの窓口と同じに判定する
            go = bool(reason) and first_of_day(prior) and not fresh_handoff(prev) and not retired(root, session)
            attempt = iso()
            if go:
                # 起動より先に保存する。新しいチャットの SessionStart と最初の発言は起動の途中で走ることがある
                agent = main_agent(root)
                keep["handoff"] = {"state": "launching", "at": attempt, "reason": reason, "from_session": session, "prompt": prompt, "agent": agent}
            # 発言も起動より先に記録する。新しいチャットに渡した同じ発言が「その日の最初」と数えられないように
            append_utterance(root, {"at": attempt, "session": session, "prompt": prompt, **({"handoff": True} if go else {})})
        save_keep(root, keep)
        # 発言の記録から Run の引き継ぎまでを同じロックの中で済ませる（ほぼ同時に話しかけた 2 つの会話で、先の発言が後の発言の引き継ぎを取り返さないように）
        taken = [] if go else bind_main(root, inp, speaking, takeover_text)
    if not go:
        print("\n".join(order_lines(root) + taken))
        return
    ok, detail = launch_chat(root, prompt, agent, attempt)
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
             "reason": "このチャットの記憶が崩れてきたため（%s）、同じワークスペースの新しい%sに引き継ぎました。"
                       "いまの発言は新しい窓口に渡してあります。%s" % (reason, "Gemini の窓口" if agent == "antigravity" else "チャット",
                       "Orca の端末のタブから新しい窓口を開いてください。" if agent == "antigravity" else "Orca のチャットの一覧から新しいチャットを開いてください。")})
    else:
        print("【引き継ぎ】%s ため新しいチャットへの引き継ぎを試みたが失敗した（%s）。このチャットのまま続いている。記録の元は .orca/cockpit/（state.md・rulings.jsonl・utterances.jsonl）" % (reason, detail))
        with locked(root):
            taken = bind_main(root, inp, True, takeover_text)
        print("\n".join(order_lines(root) + taken))


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
                ("\n## 最初のメッセージ\n最初のメッセージは、前のチャットで受けた深田さんのこの日の最初の発言（原文）。そのターンで hook が窓口の Run を引き継ぎ"
                 "、答えるのは再開の確かめを通ったあと。", None, 0),
                (resume_request(root), None, 0)])
            out({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}})
            return
    if source == "startup":
        hint = switch_hint(root, session)
        if hint:
            out({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": hint}})
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
    command = strip_command((inp.get("tool_input") or {}).get("command") or "")
    # 窓口を替える道具は、打った会話の id をここで控えて読む（agy の道具は自分の会話 id を受け取れない）。
    # 道具が立てる再開の確かめは同じ呼び出しの後ろには効かないので、worker・担当への指示と 1 回にまとめたものは断る
    if claim_switch(root, inp, command):
        if WORKER_SEND.search(command):
            out({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                        "permissionDecisionReason": "窓口を替える道具（compaction-keep.py switch）と worker・担当への指示を 1 回の呼び出しにまとめない。"
                                                                    "switch だけを打ち、再開の確かめを通してから指示を出す"}})
        return
    if retired(root, inp.get("session_id")) and WORKER_SEND.search(command):
        out({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                    "permissionDecisionReason": "この会話は窓口を退いた（compaction-keep.py switch で別の会話が窓口になった）。worker・担当への指示は今の窓口から出す。"
                                                                "深田さんがこの会話に話しかけると、hook が窓口の Run を引き継いでこの会話を窓口に戻す"}})
        return
    v = load_keep(root).get("verify") or {}
    if not (v.get("pending") and v.get("session") == inp.get("session_id")):
        return
    if WORKER_SEND.search(command):
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


def unsorted_utterances(report):
    """state.ts の checks.unsorted（仕分けていない発言の id）。読めなければ空（ターンの終わりを止めない）。"""
    got = (report.get("checks") or {}).get("unsorted") or []
    return [x.get("id") if isinstance(x, dict) else x for x in got if isinstance(x, (str, dict))] if isinstance(got, list) else []


def tidy_reason(keep, pending):
    """窓の整理・棚卸しの指示（state.ts の checks.unapplied_tidy）を、報告を書かずに残したままターンを終えないための差し戻し（t163）。

    fitf で、合図は届いて読まれたのに、圧縮・別の依頼・許可待ちのあいだに後回しになり、窓に「実行中」のまま 9 件たまった。
    同じ指示の組には TIDY_NUDGE_SEC に 1 回だけ返す（subagent を待つあいだの知らせのターンで毎回止めない）。新しい指示が増えたらすぐ返す。
    pending は state.ts の checks.unapplied_tidy。None は読めなかったときで、何も返さず印も消さない。"""
    if pending is None:
        return None
    ops = [n for n in pending if isinstance(n, int)]
    if not ops:
        keep.pop("tidy_nudge", None)
        return None
    last = keep.get("tidy_nudge") or {}
    if set(ops) <= set(last.get("ops") or []) and time.time() - (last.get("clock") or 0) < TIDY_NUDGE_SEC:
        return None
    keep["tidy_nudge"] = {"ops": ops, "clock": time.time()}
    return ("窓の整理・棚卸しの指示 op %s が反映待ち（窓に「反映待ち」と出ている）。cockpit skill の references/tidy.md で実行し、"
            "結果の報告のカード（tidy_ops に番号）を cockpit-write で書く（書けば反映済みになり、窓の一覧から消える）。"
            "subagent などを待っている途中なら、何を待っているかを一言書いて終える" % "・".join(str(n) for n in ops))


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
    guard = ledger_guard(os.path.join(root, ".orca"))
    # state.ts は 1〜2 秒かかるので、未仕分けを見るときか、反映していない整理・棚卸しの指示がありうるときだけ呼ぶ（どれが残るかは state.ts が決める）
    applied = set(c.get("applied_ops") or [])
    try:
        with open(os.path.join(root, ".orca", "cockpit.user.json"), encoding="utf-8") as fh:
            log = json.load(fh).get("ops") or []
        maybe_tidy = any(isinstance(o, dict) and o.get("type") == "tidy" and o.get("op_id") not in applied for o in log)
    except FileNotFoundError:
        maybe_tidy = False
    except (OSError, ValueError, AttributeError):
        maybe_tidy = None  # 読めない回は分からない
    report = (state_report(root) if guard or maybe_tidy else None) or {}
    # 反映していない tidy が操作のログに無ければ空と分かる。ログか state.ts を読めなかったときは分からないので、差し戻しの印を残す
    pending = (report.get("checks") or {}).get("unapplied_tidy")
    tidy = tidy_reason(keep, [] if maybe_tidy is False else pending if maybe_tidy and isinstance(pending, list) else None)
    if tidy:
        reasons.append(tidy)
    loose = unsorted_utterances(report) if guard else []
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
                fn(root, inp)  # 引き継ぎで新しいチャットを起こす間はロックを外すので、自分で取る（Run の照合と引き継ぎもその中）
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
    if cmd in ("rule", "resume", "switch") and (os.environ.get("CONSULT_THREAD") or chat_card(os.getcwd())):
        sys.exit(thread)
    since, own, agent = None, None, "claude"
    if "--agent" in rest:
        i = rest.index("--agent")
        agent, rest = (rest[i + 1] if i + 1 < len(rest) else ""), rest[:i] + rest[i + 2:]
        if agent not in AGENTS:
            sys.exit("compaction-keep: --agent には %s を渡す" % "・".join(AGENTS))
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
    if cmd in ("rule", "resume", "switch") and chat_card(root):
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
    if cmd == "consult-return":
        if len(rest) < 2 or not CARD_ID.fullmatch(rest[1]):
            sys.exit("compaction-keep: consult-return <root> <カード id> < 返しの JSON")
        if find_card(root, rest[1]) is None:
            sys.exit("compaction-keep: カード %s が帳簿に無い" % rest[1])
        try:
            data = json.loads(sys.stdin.read())
        except ValueError as e:
            sys.exit("compaction-keep: 返しの JSON を読めない: %s" % e)
        if not isinstance(data, dict):
            sys.exit("compaction-keep: 返しは JSON のオブジェクト 1 つ")
        ret, err = check_return(data, rest[1], False, read_json(os.path.join(root, ".orca", "cockpit.user.json"), {}).get("ops"))
        if err:
            sys.exit("compaction-keep: 返しを保存しなかった: %s" % err)
        try:
            row, added = save_return(root, rest[1], ret, False, session=session)
        except OSError as e:
            sys.exit("compaction-keep: 返しを保存できなかった: %s" % e)
        if not added:
            print("compaction-keep: 同じ%sの返し %s が保存済みなので、新しい番号を付けずに送り直す" % (
                "差し戻し（replaces %s）" % ret["replaces"] if ret.get("replaces") else "op" if ret.get("op") is not None else "中身", row["return_id"]), file=sys.stderr)
        print("return_id %s" % row["return_id"])
        mid, why = notify_main(root, rest[1], row, False)
        print("message %s" % mid if mid else "送った（message の id は読めなかった）" if not why else "送れなかった: %s" % why)
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
        try:
            report = returns_report(root, files=True)
        except OSError as e:
            sys.exit("compaction-keep: 返しの記録を読めない: %s" % e)
        left = unreflected_returns(report)
        if left is None:
            sys.exit("compaction-keep: state.ts を読めない（理由は node %s %s --files の出力にある）" % (cockpit_state_path(), root))
        if "--json" in argv:
            print(json.dumps(left, ensure_ascii=False))
        else:
            print("\n".join(unreflected_lines(root, report)).strip())
        return
    if cmd == "rulings":
        kind = rest[1] if len(rest) > 1 else None
        for r in active_rulings(rulings(root)):
            if kind is None or r.get("kind") == kind:
                print(ruling_line(r))
        return
    if cmd == "switch":
        text, err = switch(root, agent, takeover_text)
        if text:
            print(text)
        if err:
            sys.exit("compaction-keep switch: " + err)
        return
    if cmd == "slots":
        print("\n".join(slot_lines(root, state_report(root))).strip())
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
    sys.exit("compaction-keep: 知らないコマンド %s（rule / rulings / slots / relay / resume / switch / consult-context / consult-return / ask-context / unreflected）" % cmd)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        tool(sys.argv[1:])
    else:
        hook()
