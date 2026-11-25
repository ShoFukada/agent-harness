# 整理・棚卸しの指示を実行する

cockpit skill の SKILL.md から分けた手順。窓の全体のタブの「整理・棚卸し」から深田が送った指示（`cockpit.user.json` の `type: "tidy"` の操作）を反映するときに読む（r132。深田の依頼「workerとかコックピットとかが古くなることあって」）。

指示はほかの操作と同じ合図（`【操縦席】未反映の操作があります（整理・棚卸し（<種類>）op <番号>: <文の頭>）`）で届き、本文に指示の全文が載る。定期では動かさない。深田が送ったときだけ実行する（R181）。

## 操作の形
- `item_id` は空、`item_rev` は 0、`text` は深田が送った指示の全文（既定の文を書き換えたもの・書き足したものを含む）
- `option_id` は既定の指示の種類。`workers`（workerとworktreeの整理）・`cockpit`（操縦席の整理）・`inventory`（棚卸し）のどれかで、自由に書いた指示には無い
- 手順は種類で選び、`text` は範囲と注文として読む（「#pj-xxx と docs/ を見て」「s3 は触らない」など）。`text` が既定の手順と食い違えば `text` を採る。自由な指示は、`text` に近い種類の手順を使い、どれにも当たらなければ書かれたとおりに進める

## 進め方（種類に共通）
1. 受けたら、深田への答えを待たずに実行する。ただし op の `at` から 10 秒（窓の取り消しの猶予）が過ぎていない指示は、まだ実行しない（ほかの知らせで起きたときに拾っても、取り消されうる）。実行の直前に `cockpit.user.json` を読み直し、その op を指す `undo` があれば実行せずに references/ops.md の 1 で反映済みにする。窓は合図を送った時点から「実行中」と出す
2. 戻せる片付け・直しは窓口がそのまま行う。戻せない操作は行わず、許可のカード（`kind: "permit"`、`target` に対象の全部、`undo` に戻せない理由）にする。戻せない操作に当たるもの:
   - 未 commit の変更か main に無い commit がある worktree の削除・ブランチの削除
   - 深田の判断待ち（判断・許可・確認・送信前・停止）のカードを閉じる・中身を変える
   - 外に出る操作（Slack・メールへの送信、push、本番の変更）
3. 3 ファイル以上を読む調べもの（棚卸しの Slack・ファイル・やり取りの読み込み、worker の結果の読み比べ）は subagent に出す。会話に依存しない読み物は researcher、会話の文脈が要るものは fork。結論と出典だけを受け取る
4. 結果は報告のカード 1 枚で返す（`kind: "report"`、`tidy_op` にこの op の番号、`done[]` に 1 件ずつ `what`・`why`・`undo`）。窓は送った指示の行から、このカードへ移れる。何も見つからなかったときも「見つけたもの 0 件」の報告を書く（窓が完了と出す元になるため）。許可のカードを出したら報告の `done[]` の最後に「許可待ち: <題>」を足す
5. 報告のカード・許可のカード・直した帳簿と、反映した op の番号（`applied_ops`）を、`cockpit-write` の 1 回で書く（references/ops.md の 5）
6. 整理の中で新しく仕事を始める（タスク・担当・worker・worktree を起こす）ときは、ふだんと同じ順にする（t159。2026-11-25 の整理で、形を決めずに担当・worker を立て、議事録を帳簿に無い worktree で書いた）:
   - 先に、どの仕事の話かを決める。既にある仕事に当たるなら、その仕事に入れる（議事録なら、その会議の仕事）。無ければ仕事を作り、形（任せる・一緒に作る）を決めて書く
   - 一緒に作る仕事の作業は、担当がいれば担当に `send` で渡し、いなければ `orca-launch --lead` で担当を立てる。窓口は worker を立てず、自分でも書かない（深田と担当のチャットで進めるため。R145）
   - 任せる仕事の作業は、タスクを書いてから `orca-launch --cockpit-task` で worker を立てるか、窓口が自分で片付ける。`--no-parent` の worktree や、帳簿のタスクに結ばない worker を作らない
   - 担当・worker の受け取りは立てた直後の 1 回の書き込みで帳簿に書く（担当は `owners[]`、worker はタスクの `worker`。references/workers.md）
7. 題・概要・状況の文は、深田が前の流れを覚えていなくても初見で分かる文にする（R187）。報告の題は「workerとworktreeを整理した（4件を片付け、1件は許可待ち）」のように、した数と残りを入れる

## workerとworktreeの整理（workers）
この案件（この窓口の帳簿）の worker と worktree だけを見る。別の案件の分は触らず、出さない（R132）。

1. 今を読む: `node ~/.config/agent-harness/orca/plugins/cockpit/window/state.ts <root>` の `tasks`（今の Dispatch と worker の様子）と `checks.stale_tasks`、`orca orchestration worker-list`、`orca worktree ps --json`（この案件の root の子孫の worktree）、`~/.config/agent-harness/bin/worktree-sweep`（`--apply` なし。一覧を出すだけ）
2. 片付けるもの:
   - worker_done を返したのに取り込んでいない worker: 取り込みの手順（worktree-flow skill の「窓口・担当・worker」）で取り込むか、取り込めない理由を報告に書く
   - 止まったまま・Orca に見つからない worker: 結んだタスクの `worker` を消すか、立て直す。どちらにしたかを報告に書く。担当（`owners[]` の開いた行。チャットがターンを終えると Dispatch は exited・failed になる）は worker として片付けない（`worker-release` しない）。担当を片付けるのは、仕事が済んだか形を変えたときだけ
   - 担当の受け取りがタスクの `worker` に残る古い行: 担当の行の `worker` に移し、タスクの `worker` を消す（references/workers.md の最後の行）
   - 取り込み済みで使い終わった worktree: worktree-flow skill の references/cleanup.md の順で、1 つずつ消す。`worktree-sweep --apply` は使わない（`~/orca/workspaces` の全部の案件の worktree を消すため）。一覧は `sweep.json` の `main` がこの窓口の root の行だけを使う（cleanup.md と同じ絞り方）。「判断が要る」と出したもの・未 commit や main に無い commit があるものは許可のカードにする
   - 帳簿のタスクに結ばれていない worktree・worker: 取り込むか捨てるかが分からなければ許可のカードにする
3. サイドバーの名前と状態を、worktree-flow skill の references/sidebar.md の「状態と片付け」でそろえる。担当の表示名の頭（「一緒に｜」「任せる｜」）が仕事の形と違えば直し、済んだタスク・片付いたカードを指す古い comment を今の判定に書き直す

## 操縦席の整理（cockpit）
1. 今を読む: state.ts の出力の `checks`（`stale_tasks`・`loose_tasks`・`incomplete_cards`・`incomplete_requests`・`unsorted`・`stale_status`・`stale_consults`・`unreflected_returns`・`no_form`・`unknown_phase`・`long_names`・`local_deliverables` など）と `jobs`・`mine`、`cockpit.json` の開いたカード、作業メモ（`.orca/cockpit/state.md`）
2. 直すもの: `checks` が名指ししたもの（直し方は references/checks.md）、形の無い仕事（`no_form`。形を決めて書く）、済んだのに `open` のタスク（済の証拠を結んで `ok` にする）、元の事実が変わった仕事の `status`、片付けた相談のタブ、作業メモの古い「今の順番」
3. 深田の判断待ちのカードが古い（前提が変わった・もう要らない）と見えたら、窓口は閉じずに、閉じるかを許可のカードにする

## 棚卸し（inventory）
1. 見る範囲は `text` の「見る範囲」に従う。書いていなければ、この案件の見張る経路（`routes`・見張る仕事の `watch.targets`）、発言の記録（`.orca/cockpit/utterances.jsonl`）の直近 2 週間、案件の docs（questions.yaml・Issue）を見る
2. 読み込みは subagent に出す（上の 3）。渡すもの: 見る範囲、帳簿の依頼の一覧（`requests[]` の id・題・完了条件）と開いたタスクの一覧、探すもの（帳簿に無い依頼・返していない連絡・古くなったタスク）、返す形（1 件ごとに原文・出典・どの依頼かタスクに当たるか）
3. 見つけた抜けた依頼は、深田の発言の原文があれば依頼の帳簿に足す（references/intake.md の「受付と仕分け」）。原文が無く深田が決めることなら判断のカードにする。古くなったタスクは、操縦席の整理の 2 と同じに直す
4. 同じ種類の直しを深田が 2 回言っている、のような仕組みに上げる話は、週 1 の手直しの棚卸し（nix-darwin の操縦席の見張る仕事 s14、harness-desk）が受け持つ。この棚卸しでは拾わず、見つけたら報告に 1 行書くだけにする（同じ手順を 2 か所に持たない）
