# カードの相談と窓からの質問

cockpit skill の SKILL.md から分けた手順。カードの相談・窓からの質問の返しが届いたとき、hook が反映していない返し・残った相談のタブ・質問の返し・担当に伝えていない返しを名指ししたときに読む。

# カードの相談
担当のいないカードで深田が「窓口と協議」を押すと、窓が `consult --card <root> <カード id>` でそのカード専用の相談を窓口の worktree に Orca のチャットで立てて前に出す（チャットで立たなければ Claude の端末のタブで立てる。2 回目は、端末なら同じタブを前に出し、チャットは CLI で前に出せないので handle を返すだけ。設計 10 章、R74）。相談は読むだけで、決まったことは窓口に「返し」として送る。決まったことが作業に反映されるのは、窓口が判断の記録と帳簿に書いたときだけ。
- 帳簿の `main.run_id` に窓口の Run を書いておく（references/setup.md の「最初に作るとき」）。無いと相談は返しをメモに書くだけになり、窓口が開始・再開で拾うまで届かない
- 返しは `orca orchestration send` の知らせ（件名「相談 <カード id>: …」。本文の末尾に JSON）で届く。知らせが失われても、相談は送る前に相談のメモ `.orca/consult/<カード id>.md` の「窓口に返したもの」に同じ JSON を書いており、hook が開始・再開・圧縮のあとに「反映していないカードの相談の返し」として名指しする（`~/.claude/hooks/compaction-keep.py unreflected <root>` でも出せる）
- 返しの JSON: `{"return_id": "d21-1", "card": "d21", "rev": 3, "rulings_seen": "R80", "choice": "<選択肢の id か null>", "decisions": [{"text", "quote", "utterance"}], "requests": [{"quote", "utterance"}], "open": [...], "affects": ["t50"]}`。保留された返しを返し直すときは `"replaces": "<元の return_id>"` が付く
- 相談の中の深田の発言も、hook が発言の記録に `card` 付きで残す。ほかの発言と同じく仕分ける（references/intake.md の「受付と仕分け」）
- 相談のタブへの知らせは、チャットでも端末でも `orca orchestration send --to <handle> --subject "相談 <カード id>: 知らせ" --body "<7 の書式の 1 文>"` で送る（経路の決まりは worktree-flow skill の references/notify.md「知らせの経路」）。本文は下の 7 の書式だけにする（書式が違うと、hook が深田の発言として記録する）。handle は talk の op の `terminal`（references/ops.md）
  - チャットは `orca_session_id:<id>`（`.orca/consult/chats.json` の、値の `card` がそのカードの id のキー）。送り主の見出し付きで届く
  - 端末は `term_…`（`orca terminal list --worktree path:<root>` のタブ名「カード相談｜<案件名>｜<カード id>」）。Orca が `check` を打てと差し込み、相談がそれで本文を読む

返しを受けたら、次の順で反映する。帳簿のカードの `from_returns` に return_id を足すのが最後の書き込みで、これが反映し終えた印になる。
1. 重複を見る: 帳簿のカードの `from_returns` にその return_id があれば反映済み。何も書かず、保留（カードの `held_returns`）に入っていれば 7 の差し戻しを、無ければ 7 の「反映済み」を送り直す。`from_returns` に無ければ、判断の記録に同じ `from_return` の行が一部あっても 2 から全部やり直す（`rule` は同じ返しの同じ判断を足さないので、書き損ねた判断だけが入る）。相談がメモに書き損ねた返しでも、届いた JSON で同じように反映する。`replaces` 付きの返しで、元の return_id がもう `held_returns` に無い（ほかの返し直しか画面の決定で片付いた）ときは、`choice` と `decisions` を反映せず、`requests` だけを照らして受け、5 の `none`・6 の `from_returns` を書いて「反映済み」を送る
2. 版を照らす: カードの今の `rev` と返しの `rev` が違えば、`choice` とこのカードについての `decisions` は反映しない（保留）。`requests` は版に関係なく、発言の id と原文で照らして受ける（同じ発言の同じ依頼が帳簿にあれば足さない）
3. 増えた判断を確かめる: `compaction-keep.py consult-context <root> <カード id> --since <rulings_seen> --return <return_id>`（この返しから書いた行は除かれる）が「- なし」でなければ、`choice` と `decisions` は保留にする。途中まで書いて止まった前の試みで、この返しの判断がもう有効になっていれば、保留にするときに `revoke` で撤回する
4. 食い違いを見る: `decisions` と `choice` を、同じコマンドの `--since` を付けない出力（このカード・仕事・タスクに関係する有効な判断）と照らす。食い違えば書かず、両方の原文を載せた判断のカードで深田に聞く
5. 判断の記録に書く: 受けた `decisions` ごとに `rule` で `kind: "decision"`・`dec`（カード id）・`quote`・`affects`・`from_return`（return_id）を書く。`choice` を受けたら、選んだ選択肢の id と中身を本文にした `decision` も 1 行書く（`decisions` に同じ内容があればそれで足りる）。受ける判断が無い・全部保留した返しも、`kind: "none"`・`dec`・`from_return` と、何を受けて何を保留したかの `text` で 1 行書く（同じ返しの同じ判断を 2 回書いても 1 行のまま）。書いたら references/rulings.md の「決めたとき」で置き場所を直す
6. 帳簿に書く: 書く道具の 1 回で、カードの `from_returns` に return_id を足し、`choice` は判断の op（`decide`）と同じ扱いでカードを閉じるか `rev` を上げ、`open` はカードの `undecided` に、`requests` は新しい依頼（`utterances` に発言の id と原文、`from_return`）か既存の依頼への追記にする。保留にしたら、カードの `held_returns` に return_id を足す。返しに `replaces`（相談が返し直した元の return_id）があれば、その id を `held_returns` から外す。発言を仕分けたら `intake` も同じ 1 回で渡す
7. 相談に知らせる（上の「相談のタブへの知らせ」の送り方で。下の書式だけを使う。ほかの書き方だと hook が深田の発言として記録する）
   - 反映した: `【相談の知らせ】反映済み <return_id>（<何を書いたか 1 行>）`
   - 版違いで保留した: `【相談の知らせ】rev <n> に変わった。<return_id> の選択と判断は保留した。前提を読み直し、新しい return_id に replaces: <return_id> を付けて返して`
   - 増えた判断で保留した: `【相談の知らせ】<R の id>（複数は・でつなぐ）が増えた。<return_id> の選択と判断は保留した。確かめて、新しい return_id に replaces: <return_id> を付けて返して`
8. タブを閉じる: カードを片付けるときは `held_returns` を空にし、保留していた返しごとに「反映済み <return_id>（カードが片付いたので保留を解いた）」を送る。カードが片付き、`unreflected` にこのカードの返しが無い（保留も無い）ときだけ `orca terminal close --terminal <handle>` で閉じる。チャットは Orca の CLI で閉じられないので、閉じてよいことを深田に伝える。相談のメモは消さない

`compaction-keep.py unreflected <root>` と state.ts の `checks.unreflected_returns`（`{ id: return_id, card, missing[] }`）は、相談のメモにあって 5 か 6 が済んでいない返し（`missing` に `判断の記録`・`帳簿`）と、保留のまま相談の返し直しを待つ返し（`保留`。差し戻しが届いていないかもしれないので 7 を送り直す）。`checks.stale_consults`（`{ id: カード id, terminal }`）はカードが片付いたのに残っている相談のタブ。hook が発言のたびに名指しするので、前者は上の手順で反映し、後者は 8 の条件を確かめて閉じる。

# 窓から質問する
深田が窓の質問の欄（やりとりのタブの一覧の上・カードとタスクの詳細の「〜について質問する」・全体のタブで仕事の名前を押した仕事の詳細）から聞くと、窓が `consult --ask <root> <質問 id> [--on-card <カード id>] [--on-task <タスク id>] [--on-stream <仕事 id>] --question <文>` で、窓口の会話を写した質問の相手（`claude --resume <窓口の会話> --fork-session`）を窓口の worktree のタブに立てる。タブは前に出さず、答えは窓のやりとりのタブの会話で読む（R219）。写しの会話は窓の「写しの会話を開く」を押したときだけ前に出る（設計 11 章、R105・R172）。同じ質問の続きは同じタブに送る。相手は Read・Grep・Glob しか使えず、帳簿・判断の記録・作業メモ・担当と worker への指示に触れない。窓口のメインのセッションの会話は質問で長くならない。決まったことは、相手が答えの末尾に書いた `【窓口への返し】` の塊を hook が返しの記録に保存し、窓口の Run に知らせる。決まったことが作業に反映されるのは、窓口が判断の記録と帳簿に書き、担当と worker に伝えたときだけ。
- 写す元の窓口の会話は、帳簿の `main.run_id` と同じ Run の窓口が発言したときに、hook が `.orca/cockpit/main-session.json`（会話 id・会話のファイル・席・cwd）に書く。`main.run_id` が無いか、同じ worktree の別の会話しか発言していないと、質問のタブは立たない（窓は「窓口の会話が分かりません。窓口が 1 回発言すると直ります」と出す）
- 質問 id は `ask<数>`（カードの id は種類の頭文字に連番で、相談は `q3` のように q を使うので、ぶつからないよう ask にした）。質問と答えの控え `.orca/consult/ask-<質問 id>.md`（頭に結んだカード・タスク・仕事の「- カード:」「- タスク:」「- 仕事:」の行）と、返しの記録 `.orca/consult/ask-<質問 id>.returns.jsonl` は consult と hook が書く。窓口は控えから返しを探さず、返しの記録だけを読む
- 質問の中の深田の発言（窓で打った最初の質問も）は、hook が発言の記録に `ask`（質問 id）付きで残す。ほかの発言と同じく仕分ける（references/intake.md の「受付と仕分け」）
- 返しの知らせは件名「質問 <質問 id>: 返し <return_id>」で、本文の末尾に返しの JSON が付く。JSON はカードの相談の返しから `card`・`rev`・`choice` を除いた形で、窓の「この答えを窓口に返す」に答えた返しは `op`（その op_id）を持つ: `{"return_id": "ask3-1", "rulings_seen": "R80", "op": 812, "decisions": [{"text", "quote", "utterance"}], "requests": [{"quote", "utterance"}], "open": [...], "affects": ["t50"]}`
- 窓から窓口に返す: 答えの末尾に `【選べる案】` の行（`- A: 題`、おすすめは `（推し）`。形は nix-darwin の claude/roles/ask.md）があれば、窓は案ごとに「A で返す」を出す。会話の下の入力欄には「続けて聞く」と「書いたことを窓口に返す」がある。どちらで返しても、窓が先に `ask_decide` の op（`item_id: "#ask:<質問 id>"`、選んだ案は `choice`、書いた文は `text`。references/ops.md）を書き、そのあと相手に深田の言葉（`案 A で。` か書いた文）と、改行して `【相談の知らせ】返しを書いて（op <op_id>）` を 1 回の入力で送る。hook は言葉を深田の発言（`ask` 付き）として発言の記録と控えの質問の節に残し、末尾の知らせの行は残さない。相手は言葉を返しの `quote` と `utterance` に引く。先頭が知らせの入力は発言として残らないので、言葉を先に置く。タブが見つからず届けられなかった知らせは、窓が 1 分ごとの定期確認で送り直す（届けた op は窓の置き場所の `asksent.json` に覚え、2 回送らない）。返した答えのあとに会話が先に進んだ op は、相手が新しい答えの案と取り違えるので窓は送らず、窓口が下の「返し」の行として控えから拾う。相手が書く前に止まっても、op が残るので窓口が拾える
- 質問のタブへの知らせは、カードの相談の 7 と同じ書式で `orca terminal send --terminal <タブの handle> --text "..." --enter` で送る。質問の相手は Read・Grep・Glob しか使えず `check` を打てないので、orchestration の知らせにしない（worktree-flow skill の「知らせの経路」の例外）。タブの handle は `orca terminal list --worktree path:<root> --include-visual-layouts` の `visualLayouts` のタブ名「質問｜<案件名>｜<質問 id>」で探す。Orca を開き直したあと画面がまだその worktree を開いていないと `visualLayouts` に出ないので、そのときだけ `terminals[]` の同じ worktree・同じ題の端末を使う（端末の題は中のプログラムが書き換えうるので、layouts があればそちらを使う）

返しを受けたら、「カードの相談」の 1〜7 を次のように読み替えて反映する。帳簿の `asks[]` の、その質問の行の `from_returns` に return_id を足すのが最後の書き込み。
1. 重複を見る: その質問の行の `from_returns` で見る。行が無ければ、6 の書き込みで `asks[]` に `{"id": "<質問 id>", "card": "<結んだカード id>", "task": "<結んだタスク id>", "stream": "<結んだ仕事 id>", "memo": ".orca/consult/ask-<質問 id>.md"}` を足す（結び先は控えの頭の「- カード:」「- タスク:」「- 仕事:」の行。無い欄は書かない）
2. 版を照らす: 質問の返しは rev を持たないので飛ばし、3 で照らす
3. 増えた判断を確かめる: `~/.claude/hooks/compaction-keep.py ask-context <root> <質問 id> --since <rulings_seen> --return <return_id>`（カード付きの質問はカードに関係する判断、仕事付きの質問はその仕事とその仕事のタスクに関係する判断、どちらも無い質問は全部）が「- なし」でなければ、`decisions` は保留にする（`requests` は受ける）
4. 食い違いを見る: 同じコマンドの `--since` を付けない出力と照らす。食い違えば書かず、両方の原文を載せた判断のカードで深田に聞く
5. 判断の記録に書く: `decisions` ごとに `rule` で `kind: "decision"`・`quote`・`affects`・`from_return`（カード付きなら `dec` にカード id）を書く。受ける判断が無い・全部保留した返しも、`kind: "none"`・`dec`（カード id、カードが無ければ質問 id）・`from_return` で 1 行書く。書いたら references/rulings.md の「決めたとき」で置き場所を直す
6. 帳簿に書く（書く道具の 1 回で）: 質問の行の `from_returns` に return_id を足す。`requests` は新しい依頼（`utterances` に発言の id と原文、`from_return`）か既存の依頼への追記にし、`open` はカード付きならカードの `undecided` に足す（タスク・仕事に結んだ質問と案件全体の質問は控えに残るだけでよい。仕事に結んだ質問の `requests` は、その仕事のタスクか新しい依頼に結ぶ）。保留にしたら `held_returns` に足し、`replaces` があれば元の return_id を外す。`op` があれば、その op_id を `applied_ops` に足す。`affects` に作業中の担当か worker のいるタスクがあれば、質問の行の `notify[]` に `{"return_id": "<return_id>", "task": "<タスク id>"}` を足す
7. 伝える: `notify[]` の行ごとに、そのタスクの担当か worker に `orca orchestration send --to dispatch:<今の Dispatch>` で、決まったこと（深田の原文と return_id）と、それで変わる作業を送る。通ったら返ってきた message の id を、その行の `message_id` に書く（書く道具）。そのあと、タブが開いていれば相手に `【相談の知らせ】反映済み <return_id>（<何を書いたか 1 行>）` を送る（保留にしたなら「カードの相談」の 7 の差し戻しの書式）

`compaction-keep.py unreflected <root>` と state.ts の `checks.unreflected_returns` には、質問の分が `ask` 付きで並ぶ。
- `{ "id": "<return_id>", "ask": "<質問 id>", "missing": [...] }`: `判断の記録`・`帳簿`（質問の行の `from_returns` に無い）は上の手順で反映する。`保留` は差し戻しを送り直して返し直しを待つ。`担当への通知`（`notify[]` に `message_id` の無い行。`tasks` にタスクの id）は 7 をやり直す。Run が替わっても新しい窓口がここから拾う
- `{ "id": null, "ask": "<質問 id>", "op": <op_id>, "missing": ["返し"] }`: 窓から窓口に返した（「A で返す」など）のに、その op に結ばれた返しが無い。`【相談の知らせ】返しを書いて（op <op_id>）` は窓が届くまで送り直すので、窓口は送らない（窓の質問の行に「写しに届けました・返し待ち」か「写しにまだ届いていません」が出る）。届いたのに相手が止まって書けないとき・タブが閉じていて届かないとき・届く前に会話が先に進んだとき（窓の質問の行に「会話が先に進んだので窓口が控えから拾います」と出る。窓は送り直さない）は、op の `answer`（控えの何番目の答えか）と `choice`・`text`（深田が選んだ案か書いた文）と控えのその答えを読んで、判断のカードで深田に確かめ、窓口が上の 5・6 で書いて op を `applied_ops` に足す
- 質問のタブは窓口が閉じない（深田が続きを聞く）。閉じられても、控えと返しの記録は残り、同じ質問 id で聞くと窓口の今の会話を写して立て直す
