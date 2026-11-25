# 担当・worker を立てたとき

cockpit skill の SKILL.md から分けた細部。担当か worker を立てたときに帳簿へ書く欄（`worker`・`owners[]`）と、担当から判断の依頼が届いたときの受け方。

立て方と知らせの受け方は worktree-flow skill の「窓口・担当・worker」。メインは窓口で、担当と自分で立てた worker の coordinator になる。帳簿を版 3 に移す前（帳簿に `intake` が無い間）は、下の `run_id`・`--cockpit-task` の代わりに references/setup.md の「版 3 の道具が入るまで」の書き方にする（`dispatch_id` を書き、続きで書き換える。`--title` で立てる）。

- 立てる前に、仕事（`streams[]`）と形（`form`）を決めて帳簿に書く。形の無い仕事にはタスクも担当も結べず（cockpit-write が断る）、`orca-launch` も立てない（t159。2026-11-25 の整理で、形を決めずに担当・worker を立て、窓・サイドバー・帳簿が別々の形を言った）
- worker は `orca-launch --cockpit-task <タスクの id> --spec-file <brief>` で立てる（道具は cockpit.json を書かない。名前と親子は worktree-flow skill の references/sidebar.md の「worker を立てるとき」）。窓口は一緒に作る仕事（`cowork`）の worker を立てない（道具が断る）。一緒に作る仕事の作業は担当に `send` で渡し、担当が自分の Run と自分の worktree から worker を立てる（道具はその仕事の開いた担当の worktree からの起動だけを通す）
- 担当は `orca-launch --lead <仕事の id> --name <slug>-lead --spec-file <brief>` で立てる。表示名とチャットの題の頭（「一緒に｜」「任せる｜」）は道具が仕事の形から付ける（手で打たない）。形の無い仕事・見張る仕事には立てない。開いた担当のいる仕事には、立て直すときだけ `--replace <今の担当の id>` で立て、道具が出す片付けの行（`replaced`）と新しい担当の行を同じ書き込みで書く。仕事の形を変えながら担当を立てるときは `--form <delegate|cowork>` を付け、道具が出す仕事の行（`stream`。今の行の form だけを変えたもの）も同じ書き込みで書く（先に形だけ変えると担当のいない一緒に作る仕事になり、先に担当を立てると古い形の頭が付く）
- 立てたときの受け取りは、worker ならそのタスクの `worker: { "run_id": "...", "task_id": "..." }` に、担当なら道具が出した担当の行（`owner`）をそのまま `owners[]` に、立てた直後の 1 回の書き込みで書く。担当の行は `{ "id": "o1", "title": "<仕事の名前>", "stream": "s1", "agent": "claude", "session": "<orcaSessionId>", "worker": { "run_id": "...", "task_id": "..." }, "state": "open" }`。担当の受け取りをタスクの `worker` に書かない（cockpit-write が断る。タスクの `worker` は worker だけのもので、担当を書くと窓が担当を「worker が止まった」と出し、整理が片付けうる）。あとから書き換えない。担当に `send` で続きを渡すと Orca は Task と Dispatch を新しく作るが、state.ts が最初の Task から続き（`follow_up_of`）をたどって今の Dispatch を引く。`dispatch_id` は書かない。表示名やコメントの文からは推し量らない
- 担当が端末で動くなら `session` の代わりに `terminal` に `term_…` を書く。仕事が終わって担当を片付けたら `state: "done"` にする。一緒に作る仕事に済んでいないタスクが残るあいだは、担当だけを片付けられない（cockpit-write が断る。タスクを済ませるか、形を `delegate` に変える）。1 つの仕事の開いた担当は 1 人
- worker の記録があるタスクの状態は、窓と hook が Orca の今の Dispatch の様子（`orca orchestration worker-show --dispatch <id>`）から出す: 進行中、worker_done を返したら取り込み待ち、人の確認待ち・起動できない・落ちた・端末が消えたなら停止の票、Dispatch が Orca に無ければ「Orca に見つからない」の停止。開いた深田さんのカード（確認・判断など）を結んだタスクは、worker の様子より深田さん待ちが勝つ（references/schema.md の「タスクの今の決まり方」）。worker の結果を取り込んだら `state` を `ok` にする（確認のカードを出すなら `open` のまま結び、承認で済になる）。hook が、取り込み待ちが 10 分を超えたタスク・見つからないタスク・取り込まれたのに `open` のままのタスク（`checks.stale_tasks`）を発言のたびに名指しする
- agent-harness の担当・worker の結果を取り込んで、ハーネスの設計（役・知らせの経路・帳簿を書く道具と読む道具・状態の決め方・席の切り替え・見張り）が変わったら、同じ取り込みの中で見取り図（agent-harness の `docs/harness-map.html`）と詳しい図（`docs/harness-detail.html`。タスクの状態の決まり方・書く道具の規則は実物の順番を写しているので、state.ts と cockpit-write が変わったときも）を直して commit する。図と文が実物から離れると、深田さんが仕組みを確かめる元が無くなるため（R216）
- 担当が深田の判断を求めてきたら（`判断: <題>` の send）、まず references/cards.md の「何を私の番に出すか」の 3 種（外に出る・戻せない・要件や設計が変わる）に当たるかを見る。当たらない戻せる小さな判断（UI の余白など）は窓口が決めて担当に返し、理由と戻し方を報告に書く。当たるものだけ、判断か許可のカードにして出す。`owner` に担当の id、`stream`・`tasks` に担当の仕事を書く。深田が決めたら `orca orchestration send --to dispatch:<担当の今の Dispatch> --body ...` で答えを送る（`reply` は担当に届かない。今の Dispatch は state.ts の出力で引く）
- 担当が質問で止まって深田の答えが要るなら、停止のカード（`reason` に担当の問いの原文、`answerable: true`）にする
- 担当が案の分かれる前に深田と話して詰めたいなら、相談のカード（`issue`・`stance`・`owner`）にする
- worker が終わって worktree を片付けたら、`worker` を消す
- 2026-11-25 より前の帳簿には、担当の受け取りがタスクの `worker` にある行が残る。窓は、Dispatch のチャットが同じ仕事の開いた担当のものなら、worker として判定せず「担当「<題>」が受け持つ」と出す。その仕事に触る次の書き込みで、受け取りを担当の行の `worker` に移し、タスクの `worker` を消す

## サイドバーをそろえる
窓のカードと Orca のサイドバーを同じ名前・同じ状態にそろえる手順（`jobs[]` から打つコマンド・状態の対応・カードのコメント）と、表示名・題・親子の形は、worktree-flow skill の references/sidebar.md の「階層と題」「状態と片付け」。取り込んだ仕事の worktree の消し方は worktree-flow skill の references/cleanup.md。
