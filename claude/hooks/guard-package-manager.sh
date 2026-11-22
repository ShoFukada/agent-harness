#!/bin/bash
# PreToolUse(Bash)フック: pip と brew でのパッケージ操作を遮断するガードレール。
# 引用符で囲んだ中身を落としてから `;` `|` `&` で区切り、各セグメントの先頭コマンドだけを見る。
# 文字列として書かれた pip / brew（grep "pip install …" など）と `uv pip` はここを通る。
set -f
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0
bare=$(printf '%s' "$cmd" | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g')

denied=0
while IFS= read -r segment; do
  # shellcheck disable=SC2086
  set -- $segment
  while [ $# -gt 0 ]; do
    case "$1" in
      [A-Za-z_]*=*|sudo|env|command|nohup|time|exec) shift ;;
      *) break ;;
    esac
  done
  [ $# -eq 0 ] && continue
  name=${1##*/}
  shift
  case "$name" in
    pip|pip3|pip3.*) verbs="install uninstall download" ;;
    python|python3|python3.*)
      while [ $# -gt 1 ] && ! { [ "$1" = "-m" ] && [ "$2" = "pip" ]; }; do shift; done
      [ $# -gt 1 ] || continue
      shift 2
      verbs="install uninstall download"
      ;;
    brew) verbs="install reinstall uninstall remove upgrade tap untap link unlink" ;;
    *) continue ;;
  esac
  while [ $# -gt 0 ]; do
    case "$1" in -*) shift ;; *) break ;; esac
  done
  [ $# -eq 0 ] && continue
  for verb in $verbs; do
    [ "$1" = "$verb" ] && denied=1
  done
done < <(printf '%s\n' "$bare" | tr ';|&' '\n\n\n')

if [ "$denied" = 1 ]; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Python のパッケージ操作は uv（uv add / uv pip / uvx）で行ってください。システム依存は nix-darwin が管理しているので brew では入れず、必要ならユーザーに nix への追加を依頼してください。"}}
EOF
fi
exit 0
