#!/bin/bash
# 長いセッションでは指示が薄れるので、UserPromptSubmit では N 回に 1 回リマインドを stdout から注入する。compact / resume の直後は指示と作業メモが最も失われているので毎回注入し、作業メモ state.md（操縦席のあるワークスペースでは <root>/.orca/cockpit/state.md、無ければ scratchpad/state.md）も続けて流す。
# 操縦席（.orca/cockpit.json）のあるワークスペースでは、メインの役割の文書（roles/main.md）と全体像を開始・再開・圧縮のあとに流す（発言のたびには流さない。R184）。
# プロンプトを妨げないよう常に exit 0。第 1 引数でリマインドファイルを差し替えられる (Codex は codex/reminder.md)。

INTERVAL=5
reminder="${1:-$(cd "$(dirname "$0")" && pwd)/reminder.md}"
# 第 1 引数を渡すのは Codex（codex/config.toml）だけ。Codex はレビューと worker の席で窓口ではないので、操縦席の役割・名指しを流さず、
# 放置の名指しの「通知済み」も記録しない（同じ root で先に動いた Codex が窓口宛ての 1 回を消費したため。監査の指摘 3）
codex="${1:+1}"
[ -f "$reminder" ] || exit 0

# 操縦席の判定済みの状態。窓と同じ判定（agent-harness の orca/plugins/cockpit/src/state.ts）を通し、cockpit.json の手書きの state を状態として数えない
# （2026-11-16 に、requests[].state を手書きのまま数えて、済んだ依頼 2 件をメインが作業中と思い込んだ）。読めなければ空。
# state.ts は cockpit.json の形の版 2 だけを読み、版 1 は例外で落ちる。
COCKPIT_STATE="${COCKPIT_STATE:-$HOME/.config/agent-harness/orca/plugins/cockpit/window/state.ts}"
COCKPIT_MIGRATE="$(dirname "$COCKPIT_STATE")/migrate.ts"
# 役割の文書（roles）は持ち主の環境の側に置く。hook は ~/.claude/hooks の symlink から呼ばれるので、自分の場所からの相対では辿れない
CLAUDE_ROLES_DIR="${CLAUDE_ROLES_DIR:-$HOME/.config/nix-darwin/claude/roles}"
cockpit_state() { node "$COCKPIT_STATE" "$1" 2>/dev/null; }
# 版 1 のまま残った案件では状態が読めないので、移し替えを促す 1 行を出す。壊れた JSON（版が読めない）は黙る。
migrate_line() {
  # -s で全体を読む（後ろが壊れたファイルでも、先頭の値だけを出して版 1 と案内しないように）
  v=$(jq -rs 'if length == 1 and (.[0] | type) == "object" then (.[0].version // 1) else empty end' "$1/.orca/cockpit.json" 2>/dev/null)
  [ -n "$v" ] && [ "$v" != 2 ] &&
    printf '\n【操縦席】cockpit.json が版 %s のままで、状態を読めない。移し替えが要る（中身の確かめは node %s %s。手順は cockpit skill の references/setup.md「移し替え」）\n' "$v" "$COCKPIT_MIGRATE" "$1"
}
pick() { printf '%s' "$state" | jq -r "$1" 2>/dev/null; }

# 開始・再開・圧縮のあとのたびに流すので、個別の作業に入り込んだあとも役割と今の全体像が文脈に残る。
cockpit_overview() {
  name=$(pick '.workspace // empty')
  # 状態を読めない（版 1 など）ときも、案件の名前は cockpit.json から出す
  [ -n "$name" ] || name=$(jq -r '.workspace.name // empty' "$root/.orca/cockpit.json" 2>/dev/null)
  printf '【操縦席】このセッションは「%s」のメイン（窓口）。役割の文書 %s/main.md:\n' "${name:-このワークスペース}" "$CLAUDE_ROLES_DIR"
  cat "$CLAUDE_ROLES_DIR/main.md" 2>/dev/null || printf '（%s/main.md を読めない）\n' "$CLAUDE_ROLES_DIR"
  pick '.overview // empty'
}

# 夜の見回り（agent-harness の bin/worktree-sweep、launchd で 23:30）が「取り込むか捨てるかを人が決める」とした、この窓口の子の worktree。
# 夜に 1 回しか変わらないので開始時だけ出す。読めない回・消せなかった回の知らせは stallwatch の --job が受け持つ。
SWEEP="${WORKTREE_SWEEP_HOME:-$HOME/Library/Application Support/worktree-sweep}/sweep.json"
sweep_line() {
  jq -r --arg root "$1" '[.decide[]? | select(.main == $root)] | select(length > 0)
    | "【worktree】取り込むか捨てるかの判断が要る worktree \(length) 件（扱いは cockpit skill の references/checks.md）: "
      + (map("\(.path)（\(.reasons | join("・") | .[0:80])）") | .[0:5] | join("、"))' "$SWEEP" 2>/dev/null
}

# 名指しの一覧（読点区切り）。空なら空。版 3 の検査は { id, ... } の形もあるので、id を出す（欠けた欄があれば括弧に添える）。
names() { pick "[(.checks.$1 // [])[] | if type == \"object\" then (.id // \"?\") + (if (.missing | type) == \"array\" then \"（\" + (.missing | join(\"・\")) + \"）\" else \"\" end) else tostring end] | join(\"、\")"; }

# 帳簿の形の直しの検査。名前ごとに件数と先頭 3 件（版 3 の { id, ... } は id、案件の名前は name）を「・」で並べる。
LEDGER_FIXES='"missing_context","local_deliverables","missing_workers","orphan_cards","incomplete_cards","stale_tasks","loose_tasks","unknown_phase","no_form","long_names","watch_missing","watch_unknown","stale_consults","workspace_name","status_missing"'
ledger_fixes() {
  pick "[($LEDGER_FIXES) as \$k | (.checks[\$k] // empty) | (if type == \"array\" then . else [.] end)
    | map(if type == \"object\" then (.id // .name // \"?\") else tostring end) | select(length > 0)
    | \"\\(\$k) \\(length) 件（\\(.[0:3] | join(\"、\"))\\(if length > 3 then \" ほか\" else \"\" end)）\"] | join(\"・\")"
}

# 深田さんに聞かれるまで push を出し忘れた（2026-11-16）ため。出すかどうかは state.ts（push_check・push_delegated）に任せ、ここで判定を写さない
unpushed() {
  [ "$(pick '.checks.push_check')" = true ] || [ "$(pick '.checks.push_delegated')" = true ] || return 0
  ahead=$(git -C "$1" rev-list --count '@{u}..HEAD' 2>/dev/null) || ahead=0
  dirty=$(git -C "$1" status --porcelain 2>/dev/null | grep -vc '^?? \.claude/$')
  [ "${ahead:-0}" -gt 0 ] || [ "${dirty:-0}" -gt 0 ] || return 0
  printf 'push していない commit %s 件・commit していない変更 %s 件' "${ahead:-0}" "${dirty:-0}"
}

input=$(cat)
# 作業中に cwd が .orca や下のフォルダへ移っても操縦席を見失わないよう、親へたどって探す。
find_cockpit_root() {
  # 相談スレッド（claude/bin/consult が CONSULT_THREAD=1 で立てる）は深田と直接話す場所で、メインの役割を流さない
  [ -n "${CONSULT_THREAD:-}" ] && return
  [ -n "$codex" ] && return
  d="$1"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    [ -f "$d/.orca/cockpit.json" ] && { printf '%s' "$d"; return; }
    [ -e "$d/.git" ] && return  # 操縦席の下にある別のリポジトリ（worker など）にはメインの役割を流さない
    d=$(dirname "$d")
  done
}
event=$(echo "$input" | jq -r '.hook_event_name // empty' 2>/dev/null) || exit 0
# Orca のチャットで立てたカードの相談（claude/bin/consult --card）には環境変数を渡せないので、compaction-keep.py が
# <root>/.orca/consult/chats.json に登録した Orca の会話 id で見分ける。登録と同時に届く最初の指示は、指示の中の印で見分ける
if [ -z "${CONSULT_CARD:-}" ] && [ -n "${ORCA_AGENT_SESSION_ID:-}" ]; then
  croot=$(find_cockpit_root "$(echo "$input" | jq -r '.cwd // empty')")
  if [ -n "$croot" ]; then
    card=$(jq -r --arg id "$ORCA_AGENT_SESSION_ID" '.[$id].card // empty' "$croot/.orca/consult/chats.json" 2>/dev/null)
    [ -n "$card" ] || card=$(echo "$input" | jq -r '.prompt // empty' |
      sed -n '1{/^【相談の知らせ】カードの相談を始める/!q;};2s/^相談の印: \([A-Za-z0-9_][A-Za-z0-9_]*\)#[0-9a-f]\{32\}$/\1/p;2q')
    [ -n "$card" ] && export CONSULT_THREAD=1 CONSULT_CARD="$croot#$card"
  fi
fi

case "$event" in
  SessionStart)
    source=$(echo "$input" | jq -r '.source // empty')
    session=$(echo "$input" | jq -r '.session_id // empty')
    cwd=$(echo "$input" | jq -r '.cwd // empty'); root=$(find_cockpit_root "$cwd")
    # 作業メモ・制約などの長くなる部分は compaction-keep.py start-context が上限（hook の 1 つの出力は 10,000 字まで）に収める。
    head=$(
      cat "$reminder"
      # カードの相談（claude/bin/consult --card）が圧縮・再開・/clear のあとに、古い前提のまま話を続けないようにする（設計 10.2 の「始め方と再開」）
      if [ -n "${CONSULT_CARD:-}" ] && [ "$source" != startup ]; then
        card="${CONSULT_CARD##*#}"; croot="${CONSULT_CARD%#*}"
        printf '\n【相談】カード %s の相談の続き（圧縮・再開・/clear のあと）。前提の元: 相談のメモ %s/.orca/consult/%s.md と、%s/compaction-keep.py consult-context %s %s の出力（カードの今の rev と関係する判断）。続け方は役割の「再開」\n' \
          "$card" "$croot" "$card" "$(dirname "$0")" "$croot" "$card"
        # チャットの相談は役割を system prompt に持たず最初の指示で受けるので、圧縮・再開・/clear のあとに流し直す
        if [ -n "${ORCA_STRUCTURED_SESSION:-}" ]; then
          printf '\n# 役割（claude/roles/consult-card.md）\n'
          cat "$CLAUDE_ROLES_DIR/consult-card.md" 2>/dev/null ||
            printf '役割のファイル %s/consult-card.md を読めない。役割の文書が無いまま相談が続いている（窓口に知らせる件）\n' "$CLAUDE_ROLES_DIR"
        fi
      fi
      # 操縦席のあるワークスペースでは、深田がパネルで押した操作の取りこぼしを最初に拾う
      if [ -n "$root" ]; then
        state=$(cockpit_state "$root")
        printf '\n%s\n' "$(cockpit_overview)"
        if [ -n "$state" ]; then
          printf '\n操縦席あり（.orca/cockpit.json）・未反映の操作 %s 件（扱いは cockpit skill の「操作を反映する」）。状態は node %s <root> の出力にある\n' "$(pick '.checks.pending_ops // 0')" "$COCKPIT_STATE"
        elif ! migrate_line "$root"; then
          printf '\n操縦席あり（.orca/cockpit.json）・状態を読めない。理由は node %s %s の出力にある\n' "$COCKPIT_STATE" "$root"
        fi
        lacking=$(names missing_context)
        [ -n "$lacking" ] && printf '判断材料が欠けている判断のカード: %s\n' "$lacking"
        line=$(sweep_line "$root"); [ -n "$line" ] && printf '\n%s\n' "$line"
      fi
    )
    # メインの作業メモは、操縦席があればワークスペースに置く（scratchpad はセッションごとに変わり、/clear や新しいチャットで辿れない）。
    args=()
    if [ -n "$root" ] && [ "$source" = compact ]; then
      :  # 圧縮のあとは compaction-keep.py が作業メモ・操縦席・判断の記録・発言をまとめて流し直す（同じメモを 2 回流さない）
    elif [ -n "$root" ]; then
      args=(--memo "$root/.orca/cockpit/state.md" .orca/cockpit/state.md --root "$root")
    elif [ -n "$session" ] && [ -n "$cwd" ]; then
      slug=$(printf '%s' "$cwd" | tr '/.' '--')
      args=(--memo "/private/tmp/claude-$(id -u)/$slug/$session/scratchpad/state.md" scratchpad/state.md)
    fi
    printf '%s\n' "$head" | "$(dirname "$0")/compaction-keep.py" start-context "${args[@]}" 2>/dev/null ||
      printf '%s\n\n【記録】作業メモと操縦席の記録を組めなかった（%s/compaction-keep.py start-context が失敗）\n' "$head" "$(dirname "$0")"
    ;;
  UserPromptSubmit)
    session=$(echo "$input" | jq -r '.session_id // "unknown"')
    state_dir="${TMPDIR:-/tmp}/claude-periodic-reminder"
    mkdir -p "$state_dir"
    count_file="$state_dir/$session"
    date +%s > "$state_dir/$session.turn"  # Stop で、このターンに操縦席を書いたかを比べる
    # 時刻を推し量って書かないよう、知らせのターンも含めて毎回今の時刻を出す（11/21 に、担当が 20:07 を 20:20、窓口が 20:05 を 20:25 と書いた。R186）
    printf '今: %s（date の出力）\n' "$(date '+%Y-%m-%d %H:%M')"
    # 担当・worker・Bot・ほかの窓口の知らせと背景の作業の完了のターンには、時刻のほかは今の順番（compaction-keep.py）だけを流す
    # （R184・R186。知らせのたびに同じ事務が付き、次にやることが薄れた）。見分けは発言の記録と同じ判定（compaction-keep.py の is_relay）を使う
    printf '%s' "$input" | "$(dirname "$0")/compaction-keep.py" relay && exit 0
    cwd=$(echo "$input" | jq -r '.cwd // empty'); root=$(find_cockpit_root "$cwd")
    # 操縦席のある Claude のメインには定期の念押しを流さない。深田さんの発言のターンに流すのは、今の順番（compaction-keep.py）・未処理の要対応・重要な警告だけ
    if [ -z "$root" ]; then
      n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$count_file"
      [ $(( n % INTERVAL )) -eq 0 ] && cat "$reminder"
    fi
    # hook は何が何件かという事実だけを流し、扱いは cockpit skill の references/checks.md が持つ
    # （命令の形の文は、hook の文として prompt injection の防御に当たりやすい。Claude Code の hooks の文書）
    [ -n "$root" ] && notes=$(
      state=$(cockpit_state "$root")
      [ -n "$state" ] || migrate_line "$root"
      pending=$(pick '.checks.pending_ops // 0')
      [ "${pending:-0}" -gt 0 ] 2>/dev/null &&
        printf '\n【操縦席】未反映の操作 %s 件（扱いは cockpit skill の「操作を反映する」）\n' "$pending"
      intake=$(names intake)
      [ -n "$intake" ] &&
        printf '\n【操縦席】worker が終わったのに取り込んでいないタスク: %s\n' "$intake"
      remind=$(names remind_due)
      [ -n "$remind" ] &&
        printf '\n【操縦席】催促の日を過ぎた顧客待ち: %s\n' "$remind"
      routes=$(names routes)
      [ -n "$routes" ] &&
        printf '\n【操縦席】連絡を拾えていない経路: %s\n' "$routes"
      # 未仕分けは帳簿が版 3（intake の欄がある）のときだけ意味を持つ（その前は古い発言が全部並ぶ）。Stop で止めるのと同じ判定を compaction-keep.py に聞く（R195）
      if [ "${COCKPIT_LEDGER_GUARD:-0}" = 1 ] && "$(dirname "$0")/compaction-keep.py" ledger-guard "$root"; then
        unsorted=$(names unsorted)
        [ -n "$unsorted" ] &&
          printf '\n【操縦席】仕分けていない発言: %s\n' "$unsorted"
      fi
      # 状況の文が古い仕事と、開いた待ちと照らしていない知らせ（R204）。どちらも次の cockpit-write で直す（書く道具が同じ判定で断る）
      stale=$(pick '[(.checks.stale_status // [])[] | "\(.id)（\((.changes // [])[0:2] | join("／"))）"] | join("、")')
      [ -n "$stale" ] &&
        printf '\n【操縦席】状況の文が古い仕事: %s\n' "$stale"
      notices=$(names unsorted_notices)
      [ -n "$notices" ] &&
        printf '\n【操縦席】開いた待ちと照らしていない知らせ: %s\n' "$notices"
      # 線を越えて動いていないタスク（R170）。task@since ごとに最初の 1 回だけ流す（since はタスクが動くたびに変わるので、戻ってまた越えたらもう 1 回）
      idle_seen="$state_dir/idle-notified.txt"
      idle_new=$(pick '(.checks.idle_tasks // [])[] | "\(.task)@\(.since)\t\(.task)（\(.hours) 時間）"' | while IFS="$(printf '\t')" read -r key label; do
        grep -qxF "$root $key" "$idle_seen" 2>/dev/null && continue
        printf '%s %s\n' "$root" "$key" >> "$idle_seen"; printf '%s、' "$label"
      done)
      [ -n "$idle_new" ] &&
        printf '\n【操縦席】線を越えて動いていないタスク: %s\n' "${idle_new%、}"
      # 承認・照合・範囲の変更の抜け（設計 9.2・9.4・9.5）。要素は { card, missing[] }・{ request, when[] }・{ ruling, task }
      unmapped=$(pick '[(.checks.unmapped_elements // [])[] | "\(.card)（要素 \((.missing // []) | map(tostring) | join("・"))）"] | join("、")')
      [ -n "$unmapped" ] &&
        printf '\n【操縦席】「承認する」が来たのに、要素の行き先（element_map）が欠けたカード: %s\n' "$unmapped"
      unproven=$(pick '[(.checks.unproven // [])[] | "\(.request)（済の条件 \((.when // []) | map(tostring) | join("・"))）"] | join("、")')
      [ -n "$unproven" ] &&
        printf '\n【操縦席】タスクは全部済なのに、証拠の無い済の条件が残る依頼: %s\n' "$unproven"
      affected=$(pick '[(.checks.affected_tasks // [])[] | "\(.ruling)→\(.task)"] | join("、")')
      [ -n "$affected" ] &&
        printf '\n【操縦席】判断で範囲・対象が変わったのに、見直していないタスク: %s\n' "$affected"
      # カードの相談（設計 10.7 の 1）。要素は { id: return_id, card, missing[] }
      returns=$(names unreflected_returns)
      [ -n "$returns" ] &&
        printf '\n【操縦席】反映していないカードの相談の返し: %s\n' "$returns"
      # 帳簿の形の直し（R184 の「今の順番・未処理の要対応・重要な警告」に当たらないもの）は 1 行にまとめ、検査ごとの直し方を写さない（R181）。
      # 案件の名前の形（R165）もここで直るまで毎回名指す
      fixes=$(ledger_fixes)
      [ -n "$fixes" ] &&
        printf '\n【操縦席】帳簿の直し: %s\n' "$fixes"
      plugin=$(pick '.checks.plugin // empty')
      # 古い写しは、権限が変わらなければ承認を保ったまま入れ直せるので、メインがその場で直す
      # $( ) の中の case は、bash 3.2 が閉じ括弧を取り違えないよう ( で始める形で書く
      case "$plugin" in
        (*'orca plugin update'*)
          printf '\n【操縦席】%s（古い写し。入れ直しは orca plugin update local.cockpit）\n' "$plugin" ;;
        (?*)
          printf '\n【操縦席】%s（承認は深田さんが Orca で選ぶ）\n' "$plugin" ;;
      esac
      stalled=$(jq -r --arg root "$root" '[.alerts[]? | select(.root == null or .root == $root) | .text] | join("・")' \
        "${STALLWATCH_ALERTS:-$HOME/Library/Application Support/cockpit/alerts.json}" 2>/dev/null)
      [ -n "$stalled" ] &&
        printf '\n【見張り】止まっているもの: %s\n' "$stalled"
      left=$(unpushed "$root")
      if [ -n "$left" ] && [ "$(pick '.checks.push_delegated')" = true ]; then
        printf '\n【操縦席】進行中のタスクが無いのに、ワークスペースの root に %s がある。この案件では push が一任されている（判断の記録）\n' "$left"
      elif [ -n "$left" ]; then
        printf '\n【操縦席】進行中のタスクが無いのに、ワークスペースの root に %s がある。push の一任は判断の記録に無い\n' "$left"
      fi
    )
    [ -n "${notes:-}" ] && printf '%s\n\n（上の行の扱いは cockpit skill の references/checks.md にある。行の頭の語で引く）\n' "$notes"
    ;;
  Stop)
    # 深田さんに頼む・聞くことをチャットにだけ書くと、窓だけ見て進められない（2026-11-16 にマージの進め方と switch を窓に出し忘れた）。
    # 返答に依頼や問いがあるのに、このターンで操縦席を書いていなければ 1 回だけ止める。
    [ "$(echo "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0
    cwd=$(echo "$input" | jq -r '.cwd // empty'); root=$(find_cockpit_root "$cwd")
    [ -n "$root" ] || exit 0
    session=$(echo "$input" | jq -r '.session_id // "unknown"')
    turn=$(cat "${TMPDIR:-/tmp}/claude-periodic-reminder/$session.turn" 2>/dev/null) || exit 0
    msg=$(echo "$input" | jq -r '.last_assistant_message // empty')
    # UTF-8 の locale でないと [？?] がバイト単位になり、「（」など先頭のバイトが同じ全角文字に当たる
    hit=$(printf '%s' "$msg" | LC_ALL=en_US.UTF-8 grep -oE '[^。\n]{0,20}(ください|お願いします|お願いしたい|いただければ|いただけますか|いただきたい|でしょうか|ますか[。？?]|[？?])' | head -1)
    [ -n "$hit" ] || exit 0
    [ "$(stat -f %m "$root/.orca/cockpit.json" 2>/dev/null || echo 0)" -ge "$turn" ] && exit 0
    jq -n --arg hit "$hit" '{decision: "block", reason: ("当たった文: 「" + $hit + "」（誤検知ならそう一言書けば次は止まらない）。") + "返答に深田さんへ頼む・聞くことがあるが、このターンで操縦席（.orca/cockpit.json）を更新していない。深田さんは窓だけ見て進めるため、頼むこと・聞くことは判断・送信前・確認・許可のカードにして stream・tasks で仕事に結ぶ決まり（cockpit skill の「何を私の番に出すかと受付の要点」）。すでに開いたカードにあるなら、どのカードかを返答に一言書けば足りる"}'
    ;;
esac
exit 0
