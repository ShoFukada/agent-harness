#!/bin/bash
# PreToolUse(Bash)フック: サブエージェントによる破壊的コマンド（terraform apply/destroy、AWS CLIの削除系、DROP/TRUNCATE等の破壊的SQL、dropdb、dockerボリューム削除）を遮断する。
# ペイロードに agent_id があればサブエージェント実行（agent_type は --agent 起動のメインにも付くので判定に使わない）。
# サブエージェントのみ拒否し、メインセッションは通常の許可フローに委ねる。
input=$(cat)
agent_id=$(echo "$input" | jq -r '.agent_id // empty')
[ -z "$agent_id" ] && exit 0
cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
if echo "$cmd" | grep -qiE \
  -e 'terraform +(apply|destroy)' \
  -e '\baws +\S+ +(delete|terminate|remove)-' \
  -e '\baws +s3 +(rm|rb)\b' \
  -e 'drop +(schema|database|table)\b' \
  -e '\btruncate\s' \
  -e '\bdropdb\b' \
  -e 'docker +volume +(rm|prune)\b' \
  -e 'docker( +|-)compose +down.*(-v\b|--volumes)'; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"サブエージェントによる破壊的コマンド（terraform apply/destroy・AWS削除系・DROP/TRUNCATE・dropdb・dockerボリューム削除）はフックでブロックされています。必要な場合はメインセッションまたはユーザーが実行してください。"}}
EOF
fi
exit 0
