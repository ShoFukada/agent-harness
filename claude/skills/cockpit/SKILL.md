---
name: cockpit
description: Orca のワークスペースのメインが、操縦席（.orca/cockpit.json）を作るとき・更新するとき・深田が画面で押した操作を反映するときに使う。「操縦席を作って」「操縦席を更新して」「未反映の操作があります」「移し替えが要る」のときや、セッションの開始・圧縮のあとに cwd に .orca/cockpit.json があるときに発動する。担当と worker は使わない。
metadata:
  language: ja
---

# 読む順
この本体は毎回要る決まりだけを持つ。細部は同じフォルダの references/ にあり、次の場面で読む。

| 場面 | 読むもの |
|---|---|
| セッションの開始・圧縮のあと | [references/resume.md](references/resume.md)「セッションの開始・圧縮のあと」（ほかの作業の前に読む） |
| 深田に話しかけられたターンに仕分けていない発言がある、依頼の済を証拠に結ぶ | [references/intake.md](references/intake.md)「受付と仕分け」 |
| 操縦席を初めて作る、hook が「移し替えが要る」と出した、版 3 の欄に移す | [references/setup.md](references/setup.md) |
| cockpit.json・カード・依頼の帳簿・state.ts の出力の欄を確かめる、書く道具の使い方、どの事実をどこが持つかを確かめる | [references/schema.md](references/schema.md)（全項目の例は `template.json`） |
| 何を深田の番に出すかを決める、判断・許可・送信前・確認・相談のカードを書く、hook から判断材料や必須の欄の不足を指摘された | [references/cards.md](references/cards.md)（「何を私の番に出すか」が先頭） |
| 決定・制約・許可・却下を記録する、決めたことを置き場所に反映する | [references/rulings.md](references/rulings.md)「いつ書くか」「決めたとき」 |
| 作業メモを書く、hook から「今の順番」が無い・作業メモが大きいと指摘された | [references/memo.md](references/memo.md)「メインの作業メモ」 |
| 未反映の操作がある | [references/ops.md](references/ops.md) |
| 未反映の操作に整理・棚卸しの指示（`type: "tidy"`）がある | [references/tidy.md](references/tidy.md) |
| hook が `【操縦席】`・`【見張り】`・`【worktree】` の行で何かを名指しした、開始・圧縮のあとの文に「全文は」が付いていた | [references/checks.md](references/checks.md) |
| 担当・worker を立てる、担当から判断の依頼が届いた | [references/workers.md](references/workers.md) |
| サイドバーの名前・親子関係・状態をそろえる | worktree-flow skill の [references/sidebar.md](../worktree-flow/references/sidebar.md) |
| カードの相談から返しが届いた、hook が反映していない返しか残った相談のタブを名指しした | [references/consult.md](references/consult.md)「カードの相談」 |
| 窓からの質問の返しが届いた、hook が質問の返し・返しの無い「この答えを窓口に返す」・担当に伝えていない返しを名指しした | [references/consult.md](references/consult.md)「窓から質問する」 |
| 帳簿を版 3 に移す前（帳簿に `intake` が無い間） | [references/setup.md](references/setup.md)「版 3 の道具が入るまで」 |

# 役割
- メインは、そのワークスペースで深田とやり取りする窓口。まとまった作業は担当と worker に任せ、結果を取り込み、操縦席を最新に保つ
- 操縦席を書くのはメインだけ。担当と worker は書かない（指示にもそう書く）。担当が深田に決めてほしいことは窓口に send で届き、窓口がカードにする
- 深田の脳の資源は有限。エージェントが決められることは決め、決めたことは報告で共有する。深田がするのは、判断・許可・送信前・確認の 4 種類のカードへの返答と、停止への返事と、相談だけ。会話は担当のチャットで行う（カードの中に会話の欄は無い）
- 深田が主に使うのは左のディスプレイの窓（`cockpit-window`）。タブは「要対応」（深田さんが応じるカードを仕事ごとにまとめ、右に詳細を常に開く。下に件数に入らない「報告（参照のみ）」がある）・「全体」（仕事 → 工程 → タスク → worker の入れ子と、まだ済んでいない依頼）・「対応済み」の 3 つ。パネル（Orca の右のサイドバー）は前面の案件 1 つを同じ部品で出す

# ファイルと形の要点
- すべてワークスペースの root の `.orca/` に置く（グローバルの gitignore で外してあるので、顧客のリポジトリにも置いてよい）。`cockpit.json`・`cockpit.archive.json`・`cockpit/figures/`・`cockpit/rulings.jsonl` はメインだけが書く。`cockpit.user.json` は画面だけ、`cockpit/utterances.jsonl`・`compactions.jsonl`・`keep.json`・`handoff.json`・`main-session.json` は hook と決まったコマンドだけが書く。`consult/<カード id>.md`（相談のメモ）はカードの相談だけが書き、`consult/ask-<質問 id>.md`（質問と答えの控え）と `ask-<質問 id>.returns.jsonl`（質問の返しの記録）は consult --ask と hook だけが書く。一覧は references/schema.md の「ファイル」
- `cockpit.json` は書く道具 `cockpit-write` だけで書く（使い方は references/schema.md の「書く道具」）。型・参照・`rev`・仕分けを検査し、通らなければ書かずに理由を返す。Write・Edit で書くと hook が断る
- 時刻（カードの `at`・`due`、依頼の `at`、作業メモの時刻）は、`date '+%Y-%m-%dT%H:%M:%S%z'` で今の時刻を取ってから書く。推し量って書かない（推し量った時刻は実際から何時間もずれることがある）
- 必須の欄・工程・カードの種類とその値は references/schema.md の「cockpit.json の形」「カード」「必須の欄」に書いてあり、書く道具が入口で検査する。`workspace.name` の形は worktree-flow skill の references/sidebar.md の案件の行。ここには値を写さない
- 仕事（`streams`）の下にタスク（`tasks`）とカード（`cards`）がぶら下がる。仕事には形 `form` を書き（下の「仕事の形」）、タスクは 1 つの仕事に入れて工程を 1 つ付ける。タスクの `state` は `open` と `ok` だけを書き、止まり・待ち・未着手は state.ts が事実（カード・操作・worker・`wait`・`after`・日付）から決める。深田を待つタスクはカードの `tasks` から指し、外の相手・出来事・日付・空き枠を待つタスクは `wait`、先に済む必要があるタスクは `after` に書く。書き方は references/schema.md の `tasks[]` と「タスクの今の決まり方」
- カードの中身（選択肢・対象・本文・期限）を変えたら `rev` を 1 上げる。どのカードにも出た時刻 `at` を書く。確認依頼は、種類ごとの必須の欄がそろったものだけが窓に出る

# 状態を読む
カード・タスク・worker・深田の番・期限・仕事の今の状態は、窓・パネル・hook と同じ判定（`~/.config/agent-harness/orca/plugins/cockpit/src/state.ts`）で決まる。メインも状態はこの出力で読み、cockpit.json の生の `state` をそのまま状態として扱わない（手書きの状態を数えると、済んだ依頼を作業中と取り違える）。

```bash
node ~/.config/agent-harness/orca/plugins/cockpit/window/state.ts <ワークスペースの root>
```

出力は JSON（0.3 秒前後。Orca は worker の記録がある済んでいないタスクがあるときだけ呼ぶ）。版 1 の cockpit.json では「古い形」と断って exit 1 になる。

出力の欄（`counts`・`mine`・`jobs[]`・`checks` など）は references/schema.md の「state.ts の出力」。

# 何を私の番に出すかと受付の要点
- 件数に数えるのは停止・許可・判断・送信前・確認の 5 種類だけ。深田に出す判断は、外に出るもの・戻せないもの・要件や設計が変わるものの 3 種に絞り、それ以外はエージェントが決めて報告に理由と戻し方を書く（R52）。出す範囲・「確認」を出す範囲・成果物を artifact で出す決まりは references/cards.md の「何を私の番に出すか」
- 深田に頼むこと・聞くことは、チャットに書くだけで済ませず同じターンでカードにする
- 深田の依頼は受けた時点で依頼の帳簿（`requests[]`）に載せ、話しかけられたターンのうちに仕分けていない発言を仕分ける（R33）。済は窓口が書かず、証拠を結ぶ。手順は references/intake.md
- 決定・制約・許可・却下は、決めた時点で `compaction-keep.py rule` で判断の記録に 1 行書く。いつ書くかとコマンドは references/rulings.md の「いつ書くか」

# 仕事の形
仕事（`streams[]`）を作るときに、形 `form` を決めて書く（R51）。窓の「全体」タブは形ごとに置き場所と色を分ける。カードの種類（確認・許可 など）とは別の軸。
- `delegate`（任せる）: 担当・worker に任せて進み具合を見るもの。例「操縦席の窓の作り直し」
- `cowork`（一緒に作る）: 深田と話しながら作るもの。例「顧客への提案書」「提出物の作成」
  - 一緒に作る仕事は、深田の返事待ちに限らず、窓の「要対応」に「共同作業中」として出し、そこから担当のチャットに移れるようにする（R145）。行は state.ts が担当のチャットの様子から作るので、担当がまだ問いを送っていない仕事も出る。窓口はこの行のためにカードを書かない
  - 担当から「話し中: <題>」（今の論点・仮に置いた案・次に聞くこと）が届いても、窓口はカードを書かない。深田に聞かれたときの答えの材料にする
- `watch`（見張る）: Slack・メールなどの連絡を見張り、届いたものを受けるもの。受信（inbox）のカードは件数に入れずここに並ぶ
  - Orca の Bot（定期確認の automation）は、受け持つ案件の操縦席に見張る仕事として書き、その案件の窓口が保つ（R152）。Bot を作成・変更・終了するときは、その案件の窓口が見張る仕事の `watch`（automation の id・対象・送り先。形は references/schema.md）を書き換える。頻度や前回の結果は Orca が持つので写さない
  - 1 つの Bot は 1 つの案件を受け持ち、自分の案件の記録だけを読み、送り先は自分の案件の窓口だけにする（R144）。Bot の名前は「受け持つ範囲＋desk」（harness-desk・a-desk・office-desk。R149）
  - nix-darwin の窓にある「全体」タブは、各案件の操縦席にある見張る仕事を集めて表示する。案件の Bot の一覧を nix-darwin の操縦席に別に写さない
- 迷ったら、外に出るもの（顧客・Slack の相手に出すもの）を深田の言葉で作るなら `cowork`、それ以外は `delegate`
- タスクは仕事の形を引き継ぐ（タスクに欄は無い）。形の無い仕事は `checks.no_form` で名指しされる
- 形は、タスク・担当・worker を起こす前に決める。cockpit-write は、形の無い仕事を書かず、形の無い仕事にタスクや担当を結ばない。一緒に作る仕事に済んでいないタスクがあれば開いた担当を要り（担当の行は担当を立てた同じ書き込みで足す）、見張る仕事に担当を置かない。`orca-launch` は形の無い仕事・見張る仕事に立てず、窓口が一緒に作る仕事の worker を直接立てるのも断る（t159）

# カードの書き方の要点
細部と例は references/cards.md。
人が読む日本語は ja-writing skill の規則で書く。画面の文言は業務文書の語調にし、内輪の語（「こっちボール」など）を使わない。cockpit-write は、カードとタスクのうち人が読む欄に柔らかい言い回し（〜しておきました・〜ですね・〜かも、など）があれば欄と語を名指しして断る（R84。深田さんの原文の引用・draft・quote は見ない）。

- 判断・許可・送信前は、何のためか（`purpose` と `stream`・`tasks`）と具体例（選択肢の `example`・`compare`・`figure`・`quote`・`draft` の実際の値）の両方を持たせる。片方を書けないカードは出さず、書けるまで調べる
- 判断には `context` の 5 欄（`what`・`now`・`how`・`gain`・`cost`）、`fallback`、選択肢ごとの `example`、おすすめ 1 つの `recommended` を付ける。空の欄は hook が `checks.missing_context` で名指しする
- 判断を頼むカードは、出す時点で関係するタスク（`tasks`）・実物へのリンク（`links`）・おすすめの案（`recommended` と理由）をそろえる。深田に聞き返されてから足さない
- 依頼から起きたカードには、帳簿の依頼の id を `request_id` に書く。確認の `request` には依頼の原文を書く
- 要素から成る提案・設計・計画を判断・確認で出すときは、`elements` を書いてから出す（references/cards.md の「承認の前に要素を固める」）
- 文は硬めの業務文書の語調で書く（references/cards.md の「言葉づかい」。R50）
- 一度深田が答えたこと・自明なことをカードにしない。判断の記録と片付いたカードで過去の決定を確かめてからカードを出す

# 空いた枠に待ちの仕事を出す
同時に動かす worker の数は worktree-flow skill の「窓口・担当・worker」の決まりによる（上限の数は `compaction-keep.py` の `WORKER_LIMIT` だけが持つ）。worker_done を取り込んだとき・セッションの開始と再開のとき（圧縮のあとを含む）に、空き枠と待ちのタスク（未着手のタスク）を突き合わせ、優先順に出す。作業中と未着手は state.ts の判定で数える（タスクの手書きの状態は `open` と `ok` だけ）。開始・再開と圧縮のあとには、hook が空き枠と待ちのタスクを表示する（`compaction-keep.py slots <root>` でも出せる）。待ちのタスクを起こす仕組み（wake）は付けない。

# 担当・worker を立てたとき
立て方と知らせの受け方は worktree-flow skill の「窓口・担当・worker」、名前と親子関係は worktree-flow skill の references/sidebar.md。帳簿に書く欄（worker はタスクの `worker`、担当は `owners[]` の行と受け取りの `worker`）と、担当から判断の依頼が届いたときの受け方は references/workers.md。担当は `orca-launch --lead`、worker は `orca-launch --cockpit-task` で立て、`worker-start` を手で打たない
- brief に、タスクの id と、関係する判断の本文と原文を書く。担当の brief には「操縦席を書かない」も書く（worker には orca-launch が worktree-flow skill の references/worker-rules.md を足す）

# いつ更新するか
- 状態が変わったターンの終わり（仕事のもとになる事実が変わったら、その書き込みで仕事の `status` も書き直す。cockpit-write が古い文を断る）
- 担当・worker の結果を取り込んだとき（Orca が worker_done で起こす）
- 深田が画面で操作したとき（`【操縦席】未反映の操作があります` の知らせが、窓の郵便受けの端末から窓口の Run に届く。端末の窓口にもチャットの窓口にも同じ経路で届き、届かなくても hook の件数で拾う）
- 深田が確かめる成果物のあるタスクは、その確認が済むまで `ok` にしない。`open` のまま確認のカードの `tasks` でそのタスクを指す（state.ts が深田さん待ちと出し、承認で済にする）。確かめてもらう前に「済」と出さない
- 担当が深田と話して詰めたいことは、相談のカード（`kind: "consult"`、`issue` と `stance`）で出す。深田が「担当と協議」を押すと協議中の印が付く（相談は件数に数えない）。話がまとまったら判断・確認・送信前に書き換えて `rev` を上げる
- 更新したら、ワークスペースのカードのコメントとサイドバーを判定済みの状態にそろえる（worktree-flow skill の references/sidebar.md の「状態と片付け」）

# 操作を反映する
次のどれかのときは、references/ops.md の手順で `cockpit.user.json` の未反映の操作を反映し、カードの変更と反映した op_id（`applied_ops`）を書く道具の 1 回で書く。
- `【操縦席】未反映の操作があります` が届いた、hook が未反映の操作の件数を出した、または Stop の hook が反映待ちの整理・棚卸しの指示を名指しした（報告を書くまで窓に「反映待ち」と残る。references/tidy.md）
- 深田に話しかけられたターンの最初（帳簿に `main.run_id` が無い場合や郵便受けの端末を作れない場合は、画面からの知らせが届かないため）

間違えやすいのは、取り消し（`undo`）が指す op を先に外すこと、`item_rev` が今の `rev` と違う op を適用しないこと、決めたことを実行したらカードの `why` の先頭に「結果:」を足すこと、「担当と協議」と「直しを伝える」を受け取ったときにカードの中身と `rev` を変えないことの 4 点。

