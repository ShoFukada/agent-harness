# 担当・worker を立てたとき

cockpit skill の SKILL.md から分けた細部。担当か worker を立てたときに帳簿へ書く欄（`worker`・`owners[]`）と、担当から判断の依頼が届いたときの受け方。

立て方と知らせの受け方は worktree-flow skill の「窓口・担当・worker」。メインは窓口で、担当と自分で立てた worker の coordinator になる。帳簿を版 3 に移す前（`.orca/cockpit.v2.json` が無い間）は、下の `run_id`・`--cockpit-task` の代わりに references/setup.md の「版 3 の道具が入るまで」の書き方にする（`dispatch_id` を書き、続きで書き換える。`--title` で立てる）。

- worker は `orca-launch --cockpit-task <タスクの id> --spec-file <brief>` で立てる（道具は cockpit.json を書かない。名前と親子は worktree-flow skill の references/sidebar.md の「worker を立てるとき」）
- 立てたときの受け取り（`orca-launch` か `worker-start` が出す `runId`・`taskId`）を、そのタスクの `worker: { "run_id": "...", "task_id": "..." }` に書く道具で書く。あとから書き換えない。担当に `send` で続きを渡すと Orca は Task と Dispatch を新しく作るが、state.ts が最初の Task から続き（`follow_up_of`）をたどって今の Dispatch を引く。`dispatch_id` は書かない。表示名やコメントの文からは推し量らない
- 担当を立てたら `owners[]` に 1 行足す: `{ "id": "o1", "title": "<仕事の名前>", "stream": "s1", "agent": "claude", "session": "<orcaSessionId>", "state": "open" }`。`session` は `orca worktree ps --json` の、そのチャットの `agents[].orcaSessionId`。担当が端末で動くなら `session` の代わりに `terminal` に `term_…` を書く。仕事が終わって担当を片付けたら `state: "done"` にする
- worker の記録があるタスクの状態は、窓と hook が Orca の今の Dispatch の様子（`orca orchestration worker-show --dispatch <id>`）から出す: 進行中、worker_done を返したら取り込み待ち、人の確認待ち・起動できない・落ちた・端末が消えたなら停止の票、Dispatch が Orca に無ければ「Orca に見つからない」の停止。メインの書いた `state` がそのまま使われるのは、`ok`（取り込み済み）と `wait`（外の相手を待つ）だけ。worker の結果を取り込んだら `state` を `ok` にする。hook が、取り込み待ちが 10 分を超えたタスク・見つからないタスク・取り込まれたのに `run` のままのタスク（`checks.stale_tasks`）を発言のたびに名指しする
- 担当が深田の判断を求めてきたら（`判断: <題>` の send）、まず references/cards.md の「何を私の番に出すか」の 3 種（外に出る・戻せない・要件や設計が変わる）に当たるかを見る。当たらない戻せる小さな判断（UI の余白など）は窓口が決めて担当に返し、理由と戻し方を報告に書く。当たるものだけ、判断か許可のカードにして出す。`owner` に担当の id、`stream`・`tasks` に担当の仕事を書く。深田が決めたら `orca orchestration send --to dispatch:<担当の今の Dispatch> --body ...` で答えを送る（`reply` は担当に届かない。今の Dispatch は state.ts の出力で引く）
- 担当が質問で止まって深田の答えが要るなら、停止のカード（`reason` に担当の問いの原文、`answerable: true`）にする
- 担当が案の分かれる前に深田と話して詰めたいなら、相談のカード（`issue`・`stance`・`owner`）にする
- worker が終わって worktree を片付けたら、`worker` を消す

## サイドバーをそろえる
窓のカードと Orca のサイドバーを同じ名前・同じ状態にそろえる手順（`jobs[]` から打つコマンド・状態の対応・カードのコメント）と、表示名・題・親子の形は、worktree-flow skill の references/sidebar.md の「階層と題」「状態と片付け」。取り込んだ仕事の worktree の消し方は worktree-flow skill の references/cleanup.md。
