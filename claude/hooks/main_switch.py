"""窓口（ワークスペースのメイン）を Claude と Gemini（agy）で乗り換えるための記録と道具（判断の記録 R245）。

compaction-keep.py が hook と道具の口から呼ぶ。中身は 3 つ:
  bind_main     発言のたびに、窓口の会話を main-session.json に書く（consult --ask が写す元）。Run を持たない本線の会話に
                深田さんが話しかけたら、switch と同じ手順（take_over）で帳簿の Run を引き継ぐ（t178）
  claim_switch  PreToolUse(Bash) で `compaction-keep.py switch` を見たら、打った会話の id を keep.json に控える
  switch        窓口を替える道具の本体（新しい窓口の会話の中で打つ。種類を Claude と Gemini で替えるときと、hook の引き継ぎが効かないとき）

窓口を替える道具は、次をまとめて行う（cockpit skill の references/resume.md「窓口を替える」）:
  0. 窓口の端末を決める（main_terminal。決まらなければ何も書かずに止める）
  1. 帳簿の main.run_id の Run を `orca orchestration run-use` で引き継ぐ（担当・worker からの知らせの宛先を変えない）
  2. 窓口の種類と会話 id を main-session.json に書き、再開の確かめ（keep.json の verify.pending）を立てる。
     通るまで worker・担当への新しい指示は PreToolUse が止める
  3. 種類と端末を帳簿の main に（cockpit-write で）書く
  4. 受信箱を読み直し（`orca orchestration check`）、組み直しの記録と再開の確かめの形を出す
打ち直してよい（どの段も同じ値を書き直すだけ）。

agy の道具（run_command）は自分の会話 id を環境変数で受け取れないので、会話 id は PreToolUse の hook の入力から控える
（agy は agy-hook.py を通って同じ PreToolUse が動き、session_id に agy の会話 id が入る）。Claude は CLAUDE_CODE_SESSION_ID でも取れる。
"""

import json
import os
import re
import subprocess
import time

from cockpit_records import KEEPER, append_jsonl, cockpit, iso, load_keep, locked, orca_call, orca_result, path_of, read_json, save_keep, write_json

# Orca の agent launch の --agent の名前。帳簿の main.agent と main-session.json の agent もこの名前で書く（write.ts の MAIN_AGENTS）
AGENTS = ("claude", "antigravity")
# agy では Gemini のモデルだけを使う（R108）。Orca は agy をチャットで開けないので端末で起こす（設計 F1）
AGY_MODEL = "gemini-4-neon-high"
# 道具を打ってから PreToolUse の控えを使えるまでの猶予。許可の画面で待つ分を含める
CLAIM_SEC = 600
# 退いた窓口の会話を覚えておく数。退いた会話の発言の hook が、新しい窓口の記録を戻さないようにする
RETIRED_MAX = 10
SWITCH_CMD = re.compile(r"compaction-keep(?:\.py)?[\"']?\s+switch(?:\s|$)")
INBOX_BATCHES = 20
BODY_WIDTH = 600
# run-use・check・terminal list は Orca が混んでいると 5 秒を超えることがある
ORCA_SLOW_SEC = 30


def switch_command(agent, root=None):
    """新しい窓口が打つコマンド（引き継ぎの最初のメッセージと、組み直しの案内に出す）。"""
    return "%s switch%s%s" % (KEEPER, " " + root if root else "", " --agent antigravity" if agent == "antigravity" else "")


def main_agent(root):
    """帳簿に書いた窓口の種類（無ければ claude。この欄を書く前の帳簿は Claude の窓口だけだった）。"""
    agent = (cockpit(root).get("main") or {}).get("agent")
    return agent if agent in AGENTS else "claude"


def launch_args(agent, root, prompt):
    """引き継ぎで新しい窓口を起こす orca の引数（M3）。agy はチャットで開けないので端末で、Gemini のモデルを付けて起こす。"""
    args = ["agent", "launch", "--agent", agent, "--worktree", "path:" + root]
    args += ["--surface", "terminal", "--model", AGY_MODEL] if agent == "antigravity" else ["--surface", "chat"]
    return args + ["--prompt", prompt, "--json"]


def bind_main(root, inp, user_turn, compose):
    """窓口を「深田さんが最後に話しかけた本線の会話」にそろえる。返すのはその会話に流す行。呼ぶ側が locked(root) を取る。

    Orca の Run の受け取り手は Run を作った（run-use した）会話のままで、人がその会話を閉じると、同じ worktree に新しい会話を
    立てても知らせは届かない（2026-11-25 に fitf の窓口の Run 宛ての 58 通が 3 日残った）。そこで:
    - Orca の今の Run が帳簿の main.run_id の会話は、窓口の会話 id・会話のファイル・席を main-session.json に置き換える
      （consult --ask が写す元。11.1・11.6 の 4・7）。種類は記録にあるものを保つ
    - 深田さんの発言のターン（user_turn）で Run を持たない会話は、switch と同じ手順（take_over）で帳簿の Run を引き継ぐ。
      Orca は run-use の直後に、それまで誰にも届いていなかった知らせをこの会話に届け直す（2026-11-28 の試験で確かめた）
    - 自分の Run を持つ会話（別の Run を作った窓口・担当）は切り替えず、1 行で知らせ、窓の帯が読む run-takeover.json に残す
    - switch・引き継ぎで退いた会話も、深田さんが話しかければ同じく引き継いで窓口に戻る（R253「前の窓口のチャットに戻って話しかければ、
      また引き継ぐ」）。知らせのターンでは書き換えない（閉じ忘れた前の窓口が、知らせのたびに記録を取り返さないように）
    main-session.json がこの会話と Run のままなら Orca に聞き直さない（毎回の発言を遅らせない）。
    compose(root, lead, full) は引き継いだ会話に出す文を作る（switch と同じ。full なら組み直しの記録も付ける）。"""
    run = (cockpit(root).get("main") or {}).get("run_id")
    session = inp.get("session_id") or ""
    if not run or not session:
        return []
    path, refused = path_of(root, "main-session.json"), path_of(root, "run-takeover.json")
    old = read_json(path, {})
    # hook は Claude Code の中か、agy-hook.py から呼ばれる（switch の種類の見分け方と同じ）
    here = "claude" if os.environ.get("CLAUDECODE") == "1" else "antigravity"
    if not user_turn and session in (old.get("retired") or []):
        return []
    agent = old.get("agent") if old.get("agent") in AGENTS else "claude"
    row = {"run_id": run, "agent": agent, "session_id": session, "transcript_path": inp.get("transcript_path") or "",
           "config_dir": (os.environ.get("CLAUDE_CONFIG_DIR") or "") if agent == "claude" else "", "cwd": inp.get("cwd") or root}
    if all(old.get(k) == v for k, v in row.items()):
        if user_turn and os.path.exists(refused):
            os.remove(refused)
        return []
    cur, _ = orca_call(["orchestration", "run-current"])
    if cur is None or "runId" not in cur:
        return []
    mine = cur.get("runId")
    if mine == run:
        write_json(path, {**old, **row, "at": iso(), "retired": [x for x in old.get("retired") or [] if x != session]})
        if user_turn and os.path.exists(refused):
            os.remove(refused)
        return []
    if not user_turn:
        return []
    if mine:
        write_json(refused, {"at": iso(), "session_id": session, "own_run": mine, "ledger_run": run})
        return ["【窓口】この会話は自分の Run（%s）を持つので、帳簿の窓口の Run（%s）を引き継がない。窓口への知らせはこの会話に届かない"
                "（窓口として話すなら、Run を持たない本線の会話で話しかける）" % (mine, run)]
    agent = here
    terminal, why = main_terminal(root, agent)
    if terminal is None:
        return ["【窓口】帳簿の窓口の Run（%s）を引き継げなかった（%s）。窓口への知らせはこの会話に届かない" % (run, why)]
    keep = load_keep(root)
    # 引き継ぎで起きた会話と圧縮のあとの会話は、組み直しの記録をもう受け取っている
    v = keep.get("verify") or {}
    told = bool(v.get("pending")) and v.get("session") == session
    old, why = take_over(root, keep, agent, session, inp.get("transcript_path") or "", terminal)
    if old is None:
        return ["【窓口】%s。窓口への知らせはこの会話に届かない" % why.rstrip("。")]
    if os.path.exists(refused):
        os.remove(refused)
    msgs, err = read_inbox()
    head = ("【窓口】この会話が帳簿の窓口の Run（%s）を引き継いだ（前の窓口: %s %s）。窓・worker・担当から窓口への知らせは、これからこの会話に届く"
            % (run, old.get("agent") or "-", old.get("session_id") or "-"))
    lines = [compose(root, [(head, None, 0), (inbox_lines(msgs, err, run), "orca orchestration inbox --terminal run:%s --full" % run, 2)], not told)]
    if why:
        lines.append("【窓口】" + why)
    if err:
        lines.append("【窓口】受信箱を読み切れなかった（%s）。orca orchestration check で続きを読む" % err)
    return lines


def switch_hint(root, session):
    """手で開いた新しい窓口（M2）への 1 行の案内。記録の窓口と違う会話が始まったときだけ出す（退いた会話には出さない）。"""
    ms = read_json(path_of(root, "main-session.json"), {})
    if not session or not ms.get("session_id") or session == ms["session_id"] or session in (ms.get("retired") or []):
        return None
    return ("【窓口】この会話は窓口として記録されていない（記録の窓口は %s の会話 %s）。深田さんがこの会話に話しかけると、hook が窓口の Run を引き継ぐ"
            "（この会話が自分の Run を持たないとき。cockpit skill の references/resume.md「窓口を替える」）。それまで担当・worker の知らせはこの会話に届かない"
            % (ms.get("agent") or "claude", ms["session_id"]))


def retired(root, session):
    """switch で退いた窓口の会話か。閉じずに残った前の窓口が、worker・担当に指示を出し続けないために見る。"""
    return bool(session) and session in (read_json(path_of(root, "main-session.json"), {}).get("retired") or [])


def claim_switch(root, inp, command):
    """`compaction-keep.py switch` を打つ会話の id と会話のファイルを、会話ごとに控える。switch でなければ False。
    呼ぶ側が locked(root) を取る。"""
    if not SWITCH_CMD.search(command):
        return False
    keep = load_keep(root)
    claims = {k: v for k, v in (keep.get("switch_claims") or {}).items() if time.time() - (v.get("clock") or 0) <= CLAIM_SEC}
    claims[inp.get("session_id") or ""] = {"transcript_path": inp.get("transcript_path") or "", "clock": time.time()}
    keep["switch_claims"] = claims
    save_keep(root, keep)
    return True


def cockpit_write_path():
    return os.environ.get("COCKPIT_WRITE") or os.path.expanduser("~/.config/agent-harness/orca/plugins/cockpit/bin/cockpit-write")


def who_am_i(agent, keep):
    """(会話 id, 会話のファイル) か、取れなければ (None, 理由)。Claude は環境変数の会話 id を使い、agy は控えから取る。
    控えが 2 つの会話から来ていれば、どちらが打ったか分からないので止める。"""
    claims = {k: v for k, v in (keep.get("switch_claims") or {}).items() if k and time.time() - (v.get("clock") or 0) <= CLAIM_SEC}
    if agent == "claude" and os.environ.get("CLAUDE_CODE_SESSION_ID"):
        session = os.environ["CLAUDE_CODE_SESSION_ID"]
        return session, (claims.get(session) or {}).get("transcript_path") or ""
    if len(claims) == 1:
        session, claim = next(iter(claims.items()))
        return session, claim.get("transcript_path") or ""
    if claims:
        return None, "%d つの会話が続けて switch を打った（%s）。どの会話が打ったか分からないので、窓口でない会話を閉じて %d 分待ってから打ち直す" % (
            len(claims), "・".join(sorted(claims)), CLAIM_SEC // 60)
    return None, ("この会話の id を取れなかった。PreToolUse の hook（compaction-keep.py。agy では agy-hook.py を通る）が"
                  "このコマンドを見ていない。窓口の会話の中で Bash（agy では run_command）から打ち直す")


def main_terminal(root, agent):
    """(帳簿の main.terminal に書く端末の handle, 決まらなかった理由)。環境変数 ORCA_TERMINAL_HANDLE を先に使う。
    agy の run_command にはこの値が渡らないので、同じ worktree で生きている agy の端末が 1 つだけならその handle を使う
    （setup.md の「最初に作るとき」と同じ引き方）。0 か複数なら handle を決めずに止める（空で上書きすると窓が窓口の端末を開けなくなる）。
    Claude で値が無いのはチャットの窓口で、端末が無いので空にする（同じ worktree の Claude の端末はカードの相談なので引かない）。"""
    if os.environ.get("ORCA_TERMINAL_HANDLE"):
        return os.environ["ORCA_TERMINAL_HANDLE"], None
    if agent == "claude":
        return "", None
    retry = "自分の端末の handle を `ORCA_TERMINAL_HANDLE=term_… %s` の形で前に付けて打ち直す" % switch_command(agent, root)
    got, err = orca_call(["terminal", "list", "--worktree", "path:" + root, "--limit", "500"], ORCA_SLOW_SEC)
    if err:
        return None, "窓口の端末を引けなかった（orca terminal list: %s）。何も書き換えていない。%s" % (err, retry)
    here = os.path.realpath(root)
    rows = [t for t in got.get("terminals") or [] if isinstance(t, dict) and t.get("agentIdentity") == agent and t.get("handle")
            and not t.get("orphaned") and os.path.realpath(t.get("worktreePath") or "") == here]
    if len(rows) == 1:
        return rows[0]["handle"], None
    found = "見つからなかった" if not rows else " %d 個あった（%s）" % (len(rows), "・".join(t["handle"] for t in rows))
    return None, "ORCA_TERMINAL_HANDLE が無く、この worktree の %s の端末が%s。どれが窓口か決められないので何も書き換えていない。%s" % (agent, found, retry)


def read_inbox():
    """受信箱の未読を全部読む（既読にする）。(知らせの一覧, 読み切れなかった理由)。"""
    msgs = []
    for _ in range(INBOX_BATCHES):
        got, err = orca_call(["orchestration", "check"], ORCA_SLOW_SEC)
        if err:
            return msgs, err
        batch = [m for m in (got or {}).get("messages") or [] if isinstance(m, dict)]
        if not batch:
            return msgs, None
        msgs += batch
    return msgs, "%d 回読んでもまだ残っている" % INBOX_BATCHES


def inbox_lines(msgs, err, run):
    head = "## 受信箱（orca orchestration check で読み、既読にした %d 件。全文は orca orchestration inbox --terminal run:%s --full）" % (len(msgs), run)
    rows = []
    # check の 1 通は {id, type, from, subject, body}（inbox の from_handle・created_at は無い。Orca 1.4.280 で確かめた）
    for m in msgs:
        body = re.sub(r"\s+", " ", str(m.get("body") or "")).strip()
        rows.append("- %s %s（%s）: %s%s" % (m.get("id", ""), m.get("from", ""), m.get("type", ""),
                                            str(m.get("subject") or "").strip(),
                                            "\n  " + (body if len(body) <= BODY_WIDTH else body[:BODY_WIDTH - 1] + "…") if body else ""))
    if err:
        rows.append("- 読み切れなかった（%s）。orca orchestration check で読み直す" % err)
    return "\n".join(["", head] + (rows or ["- 未読は無い"]))


def take_over(root, keep, agent, session, transcript, terminal):
    """帳簿の main.run_id の Run を引き継ぎ、窓口の会話の記録・再開の確かめ・帳簿の main をそろえる（switch と hook の引き継ぎの共通の段）。
    (前の main-session.json, None) を返す。Run を引き継げなければ (None, 理由)、引き継いだが帳簿の main だけ書けなければ (前の記録, 理由)。
    呼ぶ側が locked(root) を取り、keep はその中で読んだもの。"""
    main = cockpit(root).get("main") or {}
    run = main.get("run_id")
    if not run:
        return None, "帳簿に main.run_id が無い。先に cockpit skill の references/setup.md「最初に作るとき」で帳簿を作る"
    # 1. Run を引き継ぐ。run-use が成功を返せば結び付きは済んでいる（直後の run-current が遅れて失敗しても、記録を書かずに止めると
    #    Orca の届け先と記録が別々の会話を指したままになる）。失敗・時間切れのときだけ、実際に結び付いたかを run-current で見る
    _, err = orca_call(["orchestration", "run-use", "--id", run], ORCA_SLOW_SEC)
    if err:
        bound = orca_result(["orchestration", "run-current"]).get("runId")
        if bound != run:
            return None, "Run %s を引き継げなかった（run-use: %s・run-current: %s）。記録は書き換えていない" % (run, err, bound)
    # 2. 窓口の会話の記録と再開の確かめ（帳簿を書けなくても、worker への指示はここから止まる）
    path = path_of(root, "main-session.json")
    old = read_json(path, {})
    retired = [x for x in old.get("retired") or [] if x != session]
    if old.get("session_id") and old["session_id"] != session:
        retired.append(old["session_id"])
    write_json(path, {"run_id": run, "agent": agent, "session_id": session, "transcript_path": transcript,
                      "config_dir": (os.environ.get("CLAUDE_CONFIG_DIR") or "") if agent == "claude" else "",
                      "cwd": root, "terminal": terminal, "at": iso(), "retired": retired[-RETIRED_MAX:]})
    keep.pop("switch_claims", None)
    # 同じ会話の確かめが途中なら（圧縮のあと）、求めるパスと失敗の数を保つ
    v = keep.get("verify") or {}
    if not (v.get("pending") and v.get("session") == session):
        keep["verify"] = {"pending": True, "since": iso(), "session": session, "failures": 0, "required_paths": []}
    # 記憶が崩れた前の窓口の引き継ぎの予約は、新しい窓口に替えたことで済んだ。起動の途中の引き継ぎもこの窓口が受けたことにする
    # （遅れて起きた窓口の SessionStart が、再開の確かめの相手をこの窓口から取り替えないように）
    keep.pop("handoff_due", None)
    keep["handoff_at"] = iso()
    h = keep.get("handoff") or {}
    if h.get("state") in ("launching", "launched"):
        keep["handoff"] = {**h, "state": "taken", "to_session": session}
    save_keep(root, keep)
    append_jsonl(path_of(root, "compactions.jsonl"), {"type": "switch", "at": iso(), "session": session, "agent": agent, "run": run,
                                                      "from_session": old.get("session_id"), "from_agent": old.get("agent")})
    # 3. 帳簿の種類と端末（窓が窓口の端末を開く先）。変わったときだけ書く。cockpit-write は帳簿の別のロックを取る
    if main.get("agent") != agent or (main.get("terminal") or "") != terminal:
        try:
            done = subprocess.run([cockpit_write_path(), root], input=json.dumps({"main": {"agent": agent, "terminal": terminal}}),
                                  capture_output=True, text=True, timeout=60)
            fail = None if done.returncode == 0 else ((done.stderr or done.stdout).strip()[:300] or "exit %d" % done.returncode)
        except (OSError, subprocess.TimeoutExpired) as e:
            fail = str(e)
        if fail is not None:
            return old, "帳簿の main を書けなかった（%s）。Run・窓口の会話の記録・再開の確かめは済んだ。switch を打ち直せば続きから進む" % fail
    return old, None


def switch(root, agent, compose):
    """窓口を替える道具の本体。compose(root, lead, full) は出す文（compaction-keep.py の組み直しと再開の確かめの形）を作る。
    (出す文, 失敗の理由) を返す。替えられなければ出す文は None。受信箱を読み切れなかったときは両方を返す。"""
    if agent == "antigravity" and os.environ.get("CLAUDECODE") == "1":
        return None, "Claude Code の中で動いている。Claude の窓口なら --agent を付けずに打つ"
    if agent == "claude" and os.environ.get("CLAUDECODE") != "1":
        return None, "Claude Code の外で動いている。Gemini（agy）の窓口なら --agent antigravity を付けて打つ"
    # 端末は Run を引き継ぐ前に決める（決まらないまま引き継ぐと、Run と記録が新しい窓口なのに帳簿の端末が古い・空になる）
    terminal, err = main_terminal(root, agent)
    if terminal is None:
        return None, err
    # Run の引き継ぎから帳簿までを 1 つずつにする（2 つの会話の switch が混ざると、Run と記録と帳簿が別々の窓口を指す）
    with locked(root):
        keep = load_keep(root)
        session, got = who_am_i(agent, keep)
        if not session:
            return None, got
        old, err = take_over(root, keep, agent, session, got, terminal)
        if err:
            return None, err  # 帳簿だけ書けなかったときも、打ち直せば続きから進む
    # 4. 受信箱を読み直し、組み直しと再開の確かめの形を出す
    run = (cockpit(root).get("main") or {}).get("run_id")
    msgs, err = read_inbox()
    head = "窓口を替えた: %s の会話 %s が Run %s を引き継いだ（前の窓口: %s %s）。" % (
        agent, session, run, old.get("agent") or "-", old.get("session_id") or "-")
    text = compose(root, [(head, None, 0), (inbox_lines(msgs, err, run), "orca orchestration inbox --terminal run:%s --full" % run, 2)], True)
    return text, ("受信箱を読み切れなかった（%s）。orca orchestration check で続きを読む" % err if err else None)
