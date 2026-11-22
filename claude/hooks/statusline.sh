#!/usr/bin/env bash
# Claude Code の statusLine（stdin にセッション情報の JSON）。1行目: <アカウント> <dir> <model> <effort>、2行目: ctx <bar> <%>  5h <bar> <%> →<reset>  7d <bar> <%> →<reset>  $<費用>
# 数値はすべて「使用済み」に統一する。残量と使用済みが混在すると、どの数字が何を指すのか読み取れなくなるため (バーが埋まる向きと数字の増減も一致する)。
# 色だけは残量ベースで、少ないほど赤に寄せる。
set -u

# BSD 版と macOS 固有のコマンドは絶対パスで呼ぶ。プロジェクトの direnv が GNU coreutils を
# PATH に入れていると stat -f がファイルシステム情報の意味になり、date -j も存在しない
# (実際に別リポジトリの worktree で stat のエラーが出た)

input=$(cat)

IFS=$'\t' read -r dir model effort used cost fiveUsed fiveReset weekUsed weekReset transcript <<<"$(
  printf '%s' "$input" | jq -r '
    [ (.workspace.current_dir // "" | split("/") | last | if . == "" then "?" else . end),
      (.model.display_name // "?"),
      (.effort.level // "-"),
      (.context_window.used_percentage // -1),
      (.cost.total_cost_usd // 0),
      (.rate_limits.five_hour.used_percentage // -1),
      (.rate_limits.five_hour.resets_at // 0),
      (.rate_limits.seven_day.used_percentage // -1),
      (.rate_limits.seven_day.resets_at // 0),
      (.transcript_path // "")
    ] | @tsv'
)"
# IFS はタブ固定。model.display_name に空白が入る ("Opus 5.5") ため、既定の IFS だと
# フィールドがずれて以降の数値が全部壊れる。タブは IFS 空白なので空フィールドは
# 連続区切りとして潰される。dir に "?"、effort に "-" を jq 側で埋めるのはそのため

esc=$'\033'
dim="${esc}[2m"; cyan="${esc}[36m"; reset="${esc}[0m"
green="${esc}[32m"; yellow="${esc}[33m"; red="${esc}[31m"

# 使用済みが多いほど赤に寄せる。閾値は「まだ余裕 / そろそろ畳む / 危険」の3段階
color_by_used() {
  if   [ "$1" -ge 85 ]; then printf '%s' "$red"
  elif [ "$1" -ge 65 ]; then printf '%s' "$yellow"
  else                       printf '%s' "$green"
  fi
}

# 4 セルのバー。1 セル = 25%。3つ以上並べても横幅を食わない粒度に留める
bar_of() {
  local filled=$(( ($1 + 24) / 25 )) i=0 out=""
  [ "$filled" -gt 4 ] && filled=4
  [ "$filled" -lt 0 ] && filled=0
  while [ $i -lt 4 ]; do
    if [ $i -lt $filled ]; then out="${out}█"; else out="${out}░"; fi
    i=$(( i + 1 ))
  done
  printf '%s' "$out"
}

# リセットまでの残り時間。日跨ぎを見たいので 24h 以上は日+時で出す
until_reset() {
  local n diff
  n=$(date +%s)
  diff=$(( $1 - n ))
  [ "$diff" -le 0 ] && { printf 'まもなく'; return; }
  if   [ "$diff" -ge 86400 ]; then printf '%dd%dh' $(( diff / 86400 )) $(( diff % 86400 / 3600 ))
  elif [ "$diff" -ge 3600 ];  then printf '%dh%dm' $(( diff / 3600 )) $(( diff % 3600 / 60 ))
  else                             printf '%dm' $(( diff / 60 ))
  fi
}

# 使用量ひとかたまり: <label> <bar> <pct>% →<reset>。第4引数を立てるとパーセントの前に ~ を付ける。
# stdin から来る値は毎ターン最新だが、/usage のキャッシュ由来の値は開いた時点で固定され、その後どれだけ使っても増えない。
# 実際より低い数字を確定値のように見せると油断させるので、区別できるようにする
seg_of() {
  local label=$1 pct=$2 epoch=${3:-0} stale=${4:-} c approx=""
  c=$(color_by_used "$pct")
  [ -n "$stale" ] && approx="~"
  printf '%s%s %s%s %s%s%s%%%s' "$dim" "$label" "$c" "$(bar_of "$pct")" "$c" "$approx" "$pct" "$reset"
  [ "$epoch" -gt 0 ] 2>/dev/null && printf ' %s→%s%s' "$dim" "$(until_reset "$epoch")" "$reset"
}

# 非公開エンドポイント (api/oauth/usage) を叩くためのトークン。優先順: 環境変数 → プロファイルの .credentials.json → Keychain。
# CLAUDE_CONFIG_DIR に .credentials.json があればそれが確実かつ高速に取れる。Orca のアカウント管理が作るプロファイル
# （~/Library/Application Support/orca/claude-profiles/<id>/home）は .credentials.json を持たず Keychain だけに置くので、Keychain も読む
get_token() {
  local token svc
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && { printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN"; return; }
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    token=$(jq -r '.claudeAiOauth.accessToken // empty' "$CLAUDE_CONFIG_DIR/.credentials.json" 2>/dev/null)
    [ -n "$token" ] && { printf '%s' "$token"; return; }
  fi
  # Keychain。素の ~/.claude はサフィックスなし。プロファイルのサフィックスは CLAUDE_CONFIG_DIR の
  # SHA-256 の先頭 8 桁（Keychain の実物で確かめた）。列挙して先頭を使うと、プロファイルが
  # 2 つ以上あるとき別アカウントのトークンを掴み、使用量の取得が黙って失敗していた
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    svc="Claude Code-credentials-$(printf '%s' "$CLAUDE_CONFIG_DIR" | /usr/bin/shasum -a 256 | cut -c1-8)"
  else
    svc="Claude Code-credentials"
  fi
  # Keychain に入っているのは資格情報一式の JSON。そのまま Bearer に載せると当然 401 になる
  if [ -n "$svc" ]; then
    token=$(/usr/bin/security find-generic-password -s "$svc" -w 2>/dev/null \
      | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
    [ -n "$token" ] && { printf '%s' "$token"; return; }
  fi
  # 素の ~/.claude の最後の手段
  jq -r '.claudeAiOauth.accessToken // empty' "$HOME/.claude/.credentials.json" 2>/dev/null
}

# 非公開 API (api/oauth/usage) を叩いてキャッシュファイルへ書く。バックグラウンドで
# 走らせる前提なので、失敗は全て黙って捨てる
fetch_usage() {
  local out=$1 token json
  command -v curl >/dev/null 2>&1 || return
  token=$(get_token)
  [ -n "$token" ] || return
  json=$(curl -s --max-time 5 \
    -H "Accept: application/json" \
    -H "Authorization: Bearer $token" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "User-Agent: claude-code/2.1.220" \
    "https://api.anthropic.com/api/oauth/usage" 2>/dev/null) || return
  # レスポンスは .claude.json の cachedUsageUtilization.utilization と同じ構造
  json=$(printf '%s' "$json" | jq -r '
    (.limits // [])
    | map(select(.percent != null and .resets_at != null))
    | map([ (if .kind == "session" then "5h"
             elif .kind == "weekly_all" then "7d"
             else ("7d:" + (.scope.model.display_name // "?")) end),
            (.percent | floor | tostring),
            .resets_at ] | join(""))
    | join("")' 2>/dev/null) || return
  [ -n "$json" ] || return
  ( umask 077; printf '%s' "$json" > "$out.tmp" && mv "$out.tmp" "$out" )
}

# キャッシュを読むだけで、HTTP の完了は待たない。Claude Code は statusLine の実行中に次の更新契機が来るとスクリプトを打ち切るので、HTTP を待つ作りだと起動直後の連続更新で毎回打ち切られ、表示が出ずキャッシュも書かれないまま次の契機でまた叩く。
# これを繰り返して実際に 429 (rate_limit_error) を踏んだ。このエンドポイントは /usage も使うので、叩きすぎると Claude Code 本体の使用量表示まで巻き添えにする。
# 取得を始める前に必ず mtime を進め、成否によらず次の TTL まで再試行しない (失敗が続いても 1時間あたり最大4回)。使用量は分単位で急変しないため 15 分粒度で困らない
get_api_usage() {
  local cache now mtime
  cache="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.statusline-usage.json"
  now=$(date +%s)
  mtime=$(/usr/bin/stat -f %m "$cache" 2>/dev/null) || mtime=0
  if [ $(( now - ${mtime:-0} )) -ge 900 ]; then
    ( umask 077; : >> "$cache" ) 2>/dev/null
    touch "$cache" 2>/dev/null
    ( fetch_usage "$cache" >/dev/null 2>&1 & ) >/dev/null 2>&1
  fi
  [ -s "$cache" ] && cat "$cache" 2>/dev/null
}

# ── 1行目: どのアカウントで動いているか ── 事故 (別アカウントのまま作業) を目視で気づけるようにする。
# CLAUDE_CONFIG_DIR（Orca が起動時に設定する）があればその中の .claude.json、素の claude ならホーム直下の ~/.claude.json。
# ~/.claude/.claude.json ではない (そこには過去の移行作業で残った古いファイルがあり、参照すると別アカウントを表示してしまう)
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  cfg="$CLAUDE_CONFIG_DIR/.claude.json"
else
  cfg="$HOME/.claude.json"
fi
account=$(jq -r '.oauthAccount.emailAddress // empty' "$cfg" 2>/dev/null)

# アカウントごとに固定色 (文字列のハッシュで決まるので、同じメアドは常に同じ色)。
# red は警告用・dim は無ログイン用に取ってあるので候補から外す
account_color() {
  local palette=(32 33 34 35 36 92 93 94 95 96)
  printf '%s[1;%sm' "$esc" "${palette[$(( $(printf '%s' "$1" | cksum | cut -d' ' -f1) % ${#palette[@]} ))]}"
}
if [ -n "$account" ]; then
  accountColor=$(account_color "$account")
else
  account="(未ログイン)" accountColor="$dim"
fi

printf '%s%s%s %s%s%s %s%s%s' \
  "$accountColor" "$account" "$reset" \
  "$dim" "$dir" "$reset" \
  "$cyan" "$model" "$reset"
# effort は対応モデルでしか来ない
[ "$effort" != "-" ] && printf ' %s%s%s' "$dim" "$effort" "$reset"
printf '\n'

# ── 2行目: 残量まわり ──
line2=""
sep="  "
now=$(date +%s)

add_seg() {
  [ -n "$line2" ] && line2="${line2}${sep}"
  line2="${line2}$(seg_of "$1" "$2" "$3" "${4:-}")"
}

# limits 文字列 (\002 で枠を区切り、各枠は label/percent/resets_at を \001 で区切る) を 1枠ずつ add_seg する。
# 既に seen に入っている label はスキップし、採用したら seen に足す。stale が非空なら ~ を付ける (出所が古いことを示す)。
# stdin / 非公開 API / claude.json の 3系統で優先順 (先に来た方を採用) を同じロジックで保つため共通化する
add_limits() {
  local limits=$1 stale=$2 entry label rest pct iso epoch oldIFS
  [ -z "$limits" ] && return
  oldIFS=$IFS
  IFS=$'\002'
  for entry in $limits; do
    IFS=$oldIFS
    label=${entry%%$'\001'*}
    rest=${entry#*$'\001'}
    pct=${rest%%$'\001'*}
    iso=${rest#*$'\001'}
    case " $seen" in
      *" $label "*) IFS=$'\002'; continue ;;
    esac
    # resets_at は UTC。TZ を付けないと date -j がローカル時刻として解釈し、JST なら9時間ずれる
    epoch=$(TZ=UTC /bin/date -j -f "%Y-%m-%dT%H:%M:%S" "${iso%%.*}" +%s 2>/dev/null) || epoch=0
    if [ "${epoch:-0}" -gt "$now" ] 2>/dev/null; then
      add_seg "$label" "$pct" "$epoch" "$stale"
      seen="${seen}${label} "
    fi
    IFS=$'\002'
  done
  IFS=$oldIFS
}

# context_window は最初の API 応答が返るまで null
if [ "${used%.*}" -ge 0 ] 2>/dev/null; then
  add_seg ctx "${used%.*}" 0
fi

# 使用量は 3 系統を優先順の高い順にマージし、同じ枠は先に来たものを採用して下位の系統からは未出の枠だけを補う: 1. stdin の rate_limits（公式・常に最新。5h / 7d の合算のみで、最初の API 応答後にしか来ない）
# 2. 非公開 API (api/oauth/usage)（/usage キャッシュより新しいので stale を付けない。モデル別の枠 "7d:Fable" が取れる。通信できないときは何も足さない）
# 3. .claude.json の cachedUsageUtilization（/usage が置く非公開の内部キャッシュ。開いた時点で固定されるため stale 付きで出し、読めなければ何も足さない）
seen=""

for w in five week; do
  if [ "$w" = five ]; then u=${fiveUsed%.*}; t=$fiveReset; label="5h"
  else                     u=${weekUsed%.*}; t=$weekReset; label="7d"
  fi
  [ "$u" -ge 0 ] 2>/dev/null || continue
  add_seg "$label" "$u" "$t"
  seen="${seen}${label} "
done

# 3. 非公開 API — 非公開なので壊れても構文エラーを出さず黙って落とす。API 由来は最新
#    (stdin より古いが /usage キャッシュより新しい) ため stale マークを付けない
api_limits=$(get_api_usage)
add_limits "$api_limits" ""

# 鮮度判定に取得時刻を使わない: このキャッシュは /usage を開いたときしか更新されないので、時刻で切るとすぐモデル別が出なくなる。
# 代わりに resets_at で「まだ同じ集計期間の中か」を見る。期間内なら値が古くても下限として意味を持つが、リセットを跨いだ値は無意味
# (実測で 44 時間前の 7d 95% が残っていたが、その 20 分前にリセットされていて実際は 1% だった)
limits=$(jq -r '
  (.cachedUsageUtilization.utilization.limits // [])
  | map(select(.percent != null and .resets_at != null))
  | map([ (if .kind == "session" then "5h"
           elif .kind == "weekly_all" then "7d"
           else ("7d:" + (.scope.model.display_name // "?")) end),
          (.percent | floor | tostring),
          .resets_at ] | join(""))
  | join("")' "$cfg" 2>/dev/null)

if [ -n "$limits" ]; then
  oldIFS=$IFS
  IFS=$'\002'
  for entry in $limits; do
    IFS=$oldIFS
    label=${entry%%$'\001'*}
    rest=${entry#*$'\001'}
    pct=${rest%%$'\001'*}
    iso=${rest#*$'\001'}
    # stdin に同じ枠の最新値があるならそちらを使う (補いたいのはモデル別だけ)
    case " $seen" in
      *" $label "*) IFS=$'\002'; continue ;;
    esac
    # resets_at は UTC (+00:00)。TZ を付けないと date -j がローカル時刻として
    # 解釈し、JST なら9時間ずれる
    epoch=$(TZ=UTC /bin/date -j -f "%Y-%m-%dT%H:%M:%S" "${iso%%.*}" +%s 2>/dev/null) || epoch=0
    if [ "${epoch:-0}" -gt "$now" ] 2>/dev/null; then
      add_seg "$label" "$pct" "$epoch" stale
      seen="${seen}${label} "
    fi
    IFS=$'\002'
  done
  IFS=$oldIFS
fi

# サブスク利用時は実際の請求ではなく「API 課金だった場合」の推定値。
# 0 のときは出さない (セッション開始直後に $0.00 が並ぶのを避ける)
if [ "$(printf '%.2f' "$cost" 2>/dev/null)" != "0.00" ]; then
  [ -n "$line2" ] && line2="${line2}${sep}"
  line2="${line2}${dim}\$$(printf '%.2f' "$cost")${reset}"
fi

# if で書いて 0 で終える。`[ -n ] && printf` で終えると、2 行目が空のとき（起動直後で使用量も
# 費用もまだ無いとき）終了コードが 1 になり、Claude Code が失敗と見なして 1 行目ごと表示しない
if [ -n "$line2" ]; then printf '%s' "$line2"; fi
exit 0
