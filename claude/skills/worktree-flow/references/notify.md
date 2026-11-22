# 知らせの経路と受け方

worktree-flow skill の SKILL.md から分けた決まり。担当・worker・カードの相談・窓口へ知らせを送るとき、coordinator として知らせを受けたとき、読み逃した知らせを探すとき、席の切り替えの知らせが来たときに読む。

## 知らせの経路
エージェントの会話の中へ届ける知らせは `orca orchestration send` の 1 本にそろえる（R191。2026-11-22 に深田が選んだ）。経路の決まりはこの節だけが持ち、ほかの文書はここを指す。

| 宛先 | `--to` |
|---|---|
| 窓口 | `run:<窓口の Run>`（帳簿の `main.run_id`）。担当・カードの相談・窓・Bot も同じ |
| 担当・worker | `dispatch:<今の Dispatch>`。worker の `question` への答えだけは `reply --id` |
| カードの相談 | 立てたときの handle（チャットは `orca_session_id:<id>`、端末は `term_…`）。Run も Dispatch も持たないため |

- 画面は今の割り当てのまま: 窓口・担当・カードの相談・Bot はチャット、worker と窓からの質問は端末。受け方は画面で違う（下の「知らせを受ける（coordinator）」）
- 送り主: エージェントは自分の会話から送る（端末は `--from "$ORCA_TERMINAL_HANDLE"`、チャットは `--from` なし。チャットは `--from orca_session_id:` で名乗れない）。Orca の外のプロセス（操縦席の窓・見張り）は送り主の端末が無いと `no_active_sender_terminal` で断られるので、AI を動かさない郵便受けの端末（タブ名「操縦席｜郵便受け」）を `--from` にする。見張りが会話へ送るのは判断が要る件だけで、ほかは通知と窓の帯に出す
- `orca terminal send` で入力に打つのは次だけ。受け手が `check` を打てないか、Orca の知らせが届く前の起こし直しだから
  - 質問のタブ宛て（窓が送る 2 回目以降の質問と「返しを書いて」、窓口が送る反映の知らせ）。質問の相手は Read・Grep・Glob しか使えない
  - 席の切り替えで端末を起こし直すとき（agent-harness の account-failover）
  - 顧客の相談スレッドの引き継ぎ（`consult --handoff <顧客> <テーマ>`）。Neon はコマンドを使えない
- 窓口から Bot へ送る経路は作らない（Bot は自分の automation でだけ起きる）

## 知らせを受ける（coordinator）
coordinator は知らせのたびに Orca に起こされる。チャットには 1 通ずつのメッセージ（`──── From: …` の見出しと本文）で届く。端末には「You have N orchestration messages. Run `orca orchestration check --terminal <自分の handle>`」の 1 文だけが差し込まれるので、そのコマンドを 1 回打って本文を読む（読んだ分は既読になる。受け手自身が読むための正しい使い方）。それ以外では `check` を打たない。見張りのスクリプト・`check` の繰り返し・`terminal read` のポーリングもしない（既読になると Orca が起こす材料が消え、スクリプトが読んだ分は会話に届かない）。読み逃した知らせは既読にしない `inbox` で探す（下）。応答が無いだけでは止まったと決めない。

| 届くもの | 意味 | すること |
|---|---|---|
| `worker_done`（succeeded） | Task が終わった。本文に報告 | 差分と報告の根拠を確かめて取り込む。足りなければ同じ worker に `send` で続きを渡す |
| `worker_done`（failed） | worker が失敗を報告した | 原因を読み、直せるなら `send` で続き、直せないなら上に返す。failed を完了扱いにしない |
| `question` | worker の `ask` | 依頼と決まりから答えられるなら `orca orchestration reply --id <message_id> --body "<答え>"`。深田の判断が要るなら操縦席に判断のカードを出し、決まってから答える |
| `escalation`（stopReason=finished） | worker_done なしでターンを終えた | 意図した待ち（担当が深田と話している・worker を待っている）なら何もしない（次からは書くまで知らせない）。止まっているなら `send` で続きを促す |
| `escalation`（stopReason=lost、exited、never started） | 端末が消えた・落ちた・起動できなかった（確認の画面で止まった担当もここに来る） | 理由を直してから、知らせに書かれた `worker-start --task <id> --retry-of <dispatch>` でやり直すか、上に返す |
| 許可の確認で止まった | worker が人の許可待ち | Orca の設定「Let coordinators approve worker permission prompts」がオンなら `orca orchestration approve` / `deny` で答える。オフなら深田に頼む |

- 状態を確かめるときは `orca orchestration worker-list`・`worker-show --dispatch <id>`・`task-list`。読み逃した知らせは `orca orchestration inbox --terminal run:<run_id> --limit 50`
- 担当・worker・窓口のどれが止まっても誰かが気づく形にしてある: worker が止まれば担当（か窓口）に escalation が来る。担当が止まれば窓口に escalation が来る。窓口自身が止まったことは、会話の外の見張り（agent-harness の bin/stallwatch、launchd で 5 分おき）が通知と操縦席の窓の帯で深田に知らせる

## 利用枠の上限に当たったとき
席の切り替えと、切り替えたあとの続け方（worker の結び直し・窓口のチャットの自動の続き・止まった担当のチャットの出し直し）は、agent-harness の README（`~/.config/agent-harness/README.md`）の「利用枠の上限で席を切り替える」が持つ。窓口と担当が守るのは次の 3 つ。
- 席を手で切り替えない（account-failover が切り替え、worker は自動で結び直されて続く）
- 「`account-failover --after-switch` を打つ」と知らせが来たら、coordinator（窓口・担当）が自分の端末かチャットから打つ。結び直せなかった worker と、上限で止まった担当のチャットの出し直しはこれで片付く（README の「切り替えたあとに worker を結び直す」「上限で止まった担当のチャットを出し直す」）
- 全部の席が上限のあいだ（窓の帯に最初に戻る席と時刻が出る）は、worker を新しく立てない
