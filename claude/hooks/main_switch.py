"""窓口（ワークスペースのメイン）を Claude と Gemini（agy）で乗り換えるための記録と道具（判断の記録 R245）。

compaction-keep.py が hook と道具の口から呼ぶ。中身は 3 つ:
  record_main_session  発言のたびに、窓口の会話を main-session.json に書く（consult --ask が写す元）
  claim_switch         PreToolUse(Bash) で `compaction-keep.py switch` を見たら、打った会話の id を keep.json に控える
  switch               窓口を替える道具の本体（新しい窓口の会話の中で 1 回打つ）

窓口を替える道具は、次をまとめて行う（cockpit skill の references/resume.md「窓口を替える」）:
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

from cockpit_records import KEEPER, append_jsonl, cockpit, iso, load_keep, locked, orca_bin, orca_result, path_of, read_json, save_keep, write_json

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


def record_main_session(root, inp):
    """窓口の会話 id・会話のファイル・席を main-session.json に置き換える（consult --ask が写す元。11.1・11.6 の 4・7）。
    同じ worktree で動く別の会話を窓口と取り違えないよう、Orca の今の Run が帳簿の main.run_id と同じときだけ書く。
    窓口の種類は hook からは分からないので、記録にある種類を保つ（種類を変えるのは switch だけ）。switch で退いた会話は書かない。
    呼ぶ側が locked(root) を取る（帳簿と保存値はロックの中で読む）。"""
    run = (cockpit(root).get("main") or {}).get("run_id")
    if not run:
        return
    path = path_of(root, "main-session.json")
    old = read_json(path, {})
    session = inp.get("session_id") or ""
    if not session or session in (old.get("retired") or []):
        return
    agent = old.get("agent") if old.get("agent") in AGENTS else "claude"
    row = {"run_id": run, "agent": agent, "session_id": session, "transcript_path": inp.get("transcript_path") or "",
           "config_dir": (os.environ.get("CLAUDE_CONFIG_DIR") or "") if agent == "claude" else "", "cwd": inp.get("cwd") or root}
    if all(old.get(k) == v for k, v in row.items()):
        return
    if orca_result(["orchestration", "run-current"]).get("runId") != run:
        return
    write_json(path, {**old, **row, "at": iso()})


def switch_hint(root, session):
    """手で開いた新しい窓口（M2）への 1 行の案内。記録の窓口と違う会話が始まったときだけ出す（退いた会話には出さない）。"""
    ms = read_json(path_of(root, "main-session.json"), {})
    if not session or not ms.get("session_id") or session == ms["session_id"] or session in (ms.get("retired") or []):
        return None
    return ("【窓口】この会話は窓口として記録されていない（記録の窓口は %s の会話 %s）。この会話を窓口として続けるなら、最初に `%s` を打つ"
            "（Gemini なら --agent antigravity を付ける。cockpit skill の references/resume.md「窓口を替える」）。打つまで担当・worker の知らせはこの会話に届かない"
            % (ms.get("agent") or "claude", ms["session_id"], switch_command("claude", root)))


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


def orca_call(args):
    """orca の --json を呼び、(result, エラーの文) を返す。"""
    try:
        done = subprocess.run([orca_bin(), *args, "--json"], capture_output=True, text=True, timeout=30)
        v = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        return None, str(e)
    if isinstance(v, dict) and v.get("ok"):
        return (v.get("result") if isinstance(v.get("result"), dict) else {}), None
    err = v.get("error") if isinstance(v, dict) else v
    return None, json.dumps(err, ensure_ascii=False)[:300] if not isinstance(err, str) else err[:300]


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


def read_inbox():
    """受信箱の未読を全部読む（既読にする）。(知らせの一覧, 読み切れなかった理由)。"""
    msgs = []
    for _ in range(INBOX_BATCHES):
        got, err = orca_call(["orchestration", "check"])
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
    for m in msgs:
        body = re.sub(r"\s+", " ", str(m.get("body") or "")).strip()
        rows.append("- %s %s（%s）: %s%s" % (m.get("created_at", ""), m.get("from_handle", ""), m.get("type", ""),
                                            str(m.get("subject") or "").strip(),
                                            "\n  " + (body if len(body) <= BODY_WIDTH else body[:BODY_WIDTH - 1] + "…") if body else ""))
    if err:
        rows.append("- 読み切れなかった（%s）。orca orchestration check で読み直す" % err)
    return "\n".join(["", head] + (rows or ["- 未読は無い"]))


def switch(root, agent, reassemble):
    """窓口を替える道具の本体。reassemble(root) は組み直しの文（compaction-keep.py の組み直しと再開の確かめの形）を返す。
    (出す文, 失敗の理由) を返す。替えられなければ出す文は None。受信箱を読み切れなかったときは両方を返す。"""
    if agent == "antigravity" and os.environ.get("CLAUDECODE") == "1":
        return None, "Claude Code の中で動いている。Claude の窓口なら --agent を付けずに打つ"
    if agent == "claude" and os.environ.get("CLAUDECODE") != "1":
        return None, "Claude Code の外で動いている。Gemini（agy）の窓口なら --agent antigravity を付けて打つ"
    terminal = os.environ.get("ORCA_TERMINAL_HANDLE") or ""
    # Run の引き継ぎから帳簿までを 1 つずつにする（2 つの会話の switch が混ざると、Run と記録と帳簿が別々の窓口を指す）
    with locked(root):
        keep = load_keep(root)
        session, got = who_am_i(agent, keep)
        if not session:
            return None, got
        transcript = got
        main = cockpit(root).get("main") or {}
        run = main.get("run_id")
        if not run:
            return None, "帳簿に main.run_id が無い。先に cockpit skill の references/setup.md「最初に作るとき」で帳簿を作る"
        # 1. Run を引き継ぐ
        _, err = orca_call(["orchestration", "run-use", "--id", run])
        bound = orca_result(["orchestration", "run-current"]).get("runId")
        if bound != run:
            return None, "Run %s を引き継げなかった（run-use: %s・run-current: %s）。記録は書き換えていない" % (run, err or "成功", bound)
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
                return None, "帳簿の main を書けなかった（%s）。Run・窓口の会話の記録・再開の確かめは済んだ。打ち直せば続きから進む" % fail
    # 4. 受信箱を読み直し、組み直しと再開の確かめの形を出す
    msgs, err = read_inbox()
    head = "窓口を替えた: %s の会話 %s が Run %s を引き継いだ（前の窓口: %s %s）。" % (
        agent, session, run, old.get("agent") or "-", old.get("session_id") or "-")
    text = "\n".join([head, inbox_lines(msgs, err, run), reassemble(root)])
    return text, ("受信箱を読み切れなかった（%s）。orca orchestration check で続きを読む" % err if err else None)
