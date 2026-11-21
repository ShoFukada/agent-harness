# 操縦席（cockpit）

ワークスペースの `.orca/cockpit.json`（メインのエージェントが書く）を「要対応・全体・対応済み」の 3 つのタブで出す。全体のタブは「大タスクの一覧 → 大タスク → タスク」の順に開き、要対応・対応済みの確認と報告は大タスクごとに並んで、確認の上のたどりから大タスクへ上がれる。利用者がするのは、決める・顧客に聞く・成果物を見るの 3 つで、件数はこの 3 種（画面の印は判断・質問・確認）だけを数える。出す場所は 2 か所あり、主に使うのは窓。

- **パネル**: Orca の右のサイドバー。開いているワークスペース 1 つ
- **窓**: 左のディスプレイの上半分に置くブラウザの窓。左に操縦席のある全ワークスペースの列、右に選んだワークスペースの操縦席。Orca の前面に合わせて切り替わる

利用者が押した操作は `.orca/cockpit.user.json` に追記し、メインがそれを読んで反映する。ファイルの形は `src/model.ts`（リポジトリの README に例）、画面が満たすことは `docs/user-stories.md`。

## 構成

| ファイル | 役割 |
|---|---|
| `src/model.ts` | ファイルの形と、cockpit.json に操作ログを重ねる処理 |
| `src/state.ts` | 依頼・タスク・worker・利用者の番・期限を決める 1 か所。画面・左の列・`window/state.ts` はここを通す |
| `src/store.ts` | `.orca/` のファイルを読む・操作を追記する・メインに合図を送る。パネルの worker と窓の常駐のプロセスが共有する |
| `src/view.ts` | 表示の状態から HTML を作る（DOM に触らない） |
| `src/controller.ts` | クリック・キーボードを操作につなぐ。パネルと窓のページが共有する |
| `src/window-view.ts` | 窓の上の帯と左の列 |
| `src/worker.ts` | パネルの worker。前面のワークスペースのファイルを見張ってパネルに送り、前面が変わるたびに `focus.json` を書く |
| `src/panel.ts` | パネル（controller の送り先を worker にする） |
| `window/server.ts` | 窓の常駐のプロセス（launchd） |
| `window/page.ts` | 窓のページ（controller の送り先を常駐のプロセスにする） |
| `window/assistant.ts` | 話したいことへのすぐの回答（手元の `claude -p` を読むだけの道具で 1 回呼ぶ） |
| `window/state.ts` | 判定済みの状態を JSON で出すコマンド。hook（periodic-reminder.sh）とメインが、窓と同じ判定で状態を読む |
| `window/orca-state.ts` | `orca worktree ps`・`terminal list` からメイン・worker・worktree を決める（常駐のプロセスと `window/state.ts` が共有） |
| `window/reply.ts` | メインが話したいことへの回答を追記するコマンド（窓と同じロックを通す） |
| `fixtures/sample.json` | 確認用のサンプル（`fixtures/figures/` の図と一緒に `.orca/` に置く） |

## 窓

```
Orca ──workspace.changed / agent.status.changed──▶ パネルの worker
                                                     │ focus.json（前面のパス・メインの端末・エージェントの変化の時刻）
                                                     ▼  ~/Library/Application Support/cockpit/
   各ワークスペースの .orca/ ──fs.watch──▶ 常駐のプロセス（127.0.0.1:47231）──SSE──▶ 窓のページ
                                          │  orca worktree ps / terminal list（下の「Orca の状態」）
                                          └─ 操作の追記・orca terminal send / switch / worktree activate / file open
```

- 起動は launchd などの常駐の仕組みに任せる（リポジトリの README に plist の例）。窓はブラウザの普通のタブで `http://127.0.0.1:47231` を開く
- ブラウザ向けの TS は、配るときに Node の `module.stripTypeScriptTypes` で型を除く。ビルドの手順は無い。配るのは `window/server.ts` の `SERVED` に書いたファイルだけ
- 手で列の行を選ぶと、次に Orca の前面が変わるまでその行を出す

### Orca の状態
- 前面のワークスペースは、パネルの worker が書く `focus.json` を見張って取る（ポーリングしない）
- エージェントの状態と worktree の親子は、Orca のプラグインの API に親子の情報が無いので、`orca worktree ps` と `orca terminal list` で取る。呼ぶのは、窓が表示されている間（ページが隠れると SSE を切る）だけで、(1) 接続したとき、(2) `focus.json` のエージェントの変化の時刻が変わったとき（5 秒に 1 回まで）、(3) 60 秒ごと。60 秒ごとに呼ぶのは、プロセスが落ちた worker は Orca から知らせが来ないため
- 止まった理由: 許可待ち（blocked）・返事待ち（waiting）・落ちた（端末のプロセスが無い）・中断・エラーは Orca の状態から取る。ログイン切れと利用枠は Orca が状態として持たないので、短い最後の発言の文から推す
- 見張るファイルは、操縦席のある本線と、いま出しているワークスペースの `.orca/` だけ

### セキュリティ
- 待ち受けは 127.0.0.1 だけ。Host が `127.0.0.1:<port>`・`localhost:<port>` 以外の要求は断る（DNS rebinding）
- 書き込みと送信（`/api/*`）は、起動のたびに作るトークン（配るページにだけ埋める）と Origin の両方が合うものだけ受ける。SSE もトークンが要る
- 読むファイルは `.orca/` の中だけで、`..` とシンボリックリンクで外へ出るものは読まない（`src/store.ts` の `readInOrca`。パネルも同じ関数を通る）。開くファイルもワークスペースの中だけ
- figure の SVG は、パネルと同じ取り除き（script・外部参照・イベント属性）を通してから描く

### メモリ（2026-11-16 に測った値）
| 対象 | 物理フットプリント（アクティビティモニタの「メモリ」） | RSS |
|---|---|---|
| 常駐のプロセス（Orca の実物、窓 1 枚が接続して 60 秒ごとに確かめている間） | 51〜61 MB | 75〜95 MB |
| 参考: 何もしない Node 24 | 13 MB | 40 MB |
| 参考: `.ts` を 1 つ読み込んだ Node 24 | 32 MB | 65 MB |
| 窓 1 枚（Chrome のアプリ表示）で増える renderer | 35 MB（ほかに予備の renderer 12 MB） | |

目安の 50 MB を約 10 MB 超える。超える分のほとんどは、Node が `.ts` を読むときに読み込む型の除去（WebAssembly）で、プロセスが終わるまで残る。

## 成果物と資料を開く
`href`・`sources`・`links` などのリンクは、種類の印（Drive・PR・ページ・ファイル）を付けたボタンで出す。種類は URL のドメインから決める。
- http(s) の URL: 窓は常駐のプロセスが macOS の `open` で既定のブラウザに渡す（http と https 以外は断る）。パネルは Orca の `shell.openExternal`（初めてのホストは Orca が確かめる）
- ファイル: ワークスペースからの相対パス（日本語の名前も可）と、本線の子の worktree（`orca worktree ps` の親子）の中の絶対パスだけを開く。`path:行` は窓では `orca file open --line` でその行を開く。パネルの `editor.open` は行を受けないので、ファイルだけ開く。パネルが開ける絶対パスは、同じリポジトリ（projectId）の worktree の中だけ

## 話したいこと
「質問する」を押すと、その項目（判断・質問・確認・タスク）の詳細の中に入力欄が開き、やり取りが吹き出しで積まれる。
- 利用者の発言は `cockpit.user.json` に `talk`（`text` つき）として追記する。回答は `.orca/cockpit.talk.json` に追記し、書くのは窓の常駐のプロセスとメインだけ
- すぐの回答は、窓の常駐のプロセスが手元の `claude -p` を 1 回呼んで出す（利用者のサブスクの CLI。従量課金の API は呼ばない）。道具は Read・Grep・Glob だけ、MCP は読まず、hook は `disableAllHooks` で止める（`--setting-sources project` だけではそのリポジトリの hook が動いてファイルを書けることを確かめた。`--bare` は Keychain の認証を読まないので使えない。Orca が管理する plugin の hook は止まらない）。作業ディレクトリはそのワークスペース。1 回 90 秒で SIGTERM、5 秒で終わらなければ SIGKILL。失敗したら「回答できませんでした。メインが次に読みます」を残す。CLI は 1 本ずつ起こし、同じ発言には 1 度しか答えに行かない。起動し直したときは 10 分より古い発言に答え直さない
- アシスタントは判断・作業・変更が要る話なら答えの最後に印を付け、画面に「メインに渡す」を出す（押すと `talk` の `to_main` と、元の発言の `handoff_of`。記録するほうが元の本文を写す）。見ての「直してほしい」は、書き出しを入れた入力欄を開き、送るとメインに渡す
- 利用者が書く文（質問・選択肢以外の答え・判断材料を求める）は 4000 字まで。超えたら切り詰めずに断り、書きかけは送れるまで残す。入力欄に残りの字数を出す。検証はパネルと窓で同じ関数（`textError`）
- 書きかけは項目・タスクごとに持つ（別の項目に移っても混ざらない）
- メインの回答は `window/reply.ts` で追記する（窓と同じロック → 読み直し → 保存。同時に書いても片方が消えない）
- launchd の環境には `CLAUDE_CONFIG_DIR` と `USER` が無いので、launchd の設定で渡す（`USER` が無いと Keychain の認証を読めず「Not logged in」になる）
- 2026-11-16 に測った値: 1 回 3〜5 秒、最大 RSS 310 MB（物理フットプリント 217 MB）。終われば消える

## 判断材料と、選択肢以外の答え
- 決める項目の詳細は、今決める理由（`why`）→ 判断材料（`context` の 5 欄: 概要・現状・対応案・効果・懸念点）→ 送る文面 → 選択肢 の順に出る。判断材料は開いた状態が既定で、欄が欠けていると一覧の行と詳細の頭に「判断材料が足りません（無い欄: …）」と出る
- 上のタブの並びの「前にも言った」を押すと、項目を持たない `repeat`（`item_id` は空）を追記する。前に伝えたことをメインが落としたという合図で、メイン側の hook が押下を数えて新しいチャットへの引き継ぎに使う。hook が引き継いだときに書く `.orca/cockpit/handoff.json`（`at`・`reason`）を読み、1 日だけ上に「メインを新しいチャットに引き継ぎました」と出す
- 「判断材料を求める」を押すと `need_context` を追記する（話したいの欄に書きかけがあれば `text` に入れる）。今のバージョンに押してあれば「判断材料を依頼済み」と出し、メインが `rev` を上げると外れる
- どの項目にも「選択肢以外で決める」の欄がある。選択肢に無い答えや「もう手で送った」を書いて送ると、`decide`・`option_id: "other"`・`text` を追記する。反映待ちのあいだは「送った答え: …（メインが反映待ち）」、反映後は「あなたの答え: …」と対応済みに残る

## worker とタスク
メインが担当や worker を Orca の orchestration で立てたときに、タスクの `worker` に受け取りの `task_id`・`dispatch_id` を記録する。窓は済んでいないタスクの Dispatch を `orca orchestration worker-show --dispatch <id> --full` で引き（`window/orca-state.ts` の `orcaDispatches`）、Dispatch の端末で `orca worktree ps` のエージェントとタスクを結んで、止まった worker の帯にタスクの名前を出す。記録の無い worker は、worktree の表示名・コメントから名前を取る。

worker の記録があるタスクの状態は、メインの書いた `state` ではなく Dispatch の様子から出す（`model.ts` の `shownTask`）: worker_done を返したら取り込み待ち、起動できない・落ちた・端末が消えたら止まっている、人の確認待ちなら許可待ち、Orca に無ければ見つからない（記録漏れ）、それ以外は進行中。全体の行・大タスクの画面のタスクの行・タスクの詳細はすべてこれを通すので、場所によって状態が食い違わない。メインの書いた `state` をそのまま出すのは、`ok`（取り込み済み）と利用者の番の `stop`・`wait` だけ。パネルは orchestration を読めないので、メインの書いた `state` のまま出し、worker の欄を出さない。

## 書体
IBM Plex Sans JP（Mac に入れておく）を第一に、無ければヒラギノ。パネルは Orca のサンドボックスで Web フォントを読めないので、Mac に入れた書体を名前で指す。文字の大きさは 22・17・15・14 の 4 種類。

## メインの端末への合図

メインには中身を送らず、`【操縦席】未反映の操作があります` の 1 行だけを送る。利用者が決めたあとに「知らせる」操作はさせない。

- 取り消しの猶予（10 秒）が過ぎたら自動で送る。ただし Orca の `terminal.sendText`（窓は `orca terminal send`）は入力欄に打ち込むのと同じなので、メインのエージェントが作業中（working）の間は送らない。入力待ちになった知らせ（`agent.status.changed`、窓は `focus.json` の `agents_at`）で送る。ポーリングはしない
- 届けたら「メインに届けました」、送れなかったときだけ「もう一度送る」を出す。話したいことも同じく猶予のあとに送り、合図の 1 行に本文の頭を載せる
- パネルと窓は別のプロセスなので、操作を書いたほうが 10 秒で送り、もう片方は 30 秒待ってから拾う（書いたほうが送れなかったときだけ）。どこまで送ったかは `~/Library/Application Support/cockpit/notified.json` で共有する
- メインが Orca のチャットで動いていて `main.terminal` が空のときは、送る手段が無い（Orca の CLI にもチャットへ文を送るものが無い。`orca orchestration send` は送り主の端末が要り、端末を持たない窓の常駐のプロセスからは `no_active_sender_terminal` で断られる）ので、「次に話しかけたときに反映されます」と出す

## 開発

```sh
orca plugin test .          # model・view・worker と、窓の常駐のプロセス（window/server.test.ts）のテスト
orca plugin check . && orca plugin validate .
COCKPIT_PORT=47299 COCKPIT_DIR=$TMPDIR/cockpit node --disable-warning=ExperimentalWarning window/server.ts   # 窓を手元で動かす
node window/state.ts <ワークスペースの root>   # hook とメインが読む判定済みの状態
```

- `orca plugin dev load .` は本物の `local.cockpit` を置き換える。読み込み元を消すとプラグインの worker が止まり、Orca に合わせた切り替え（`focus.json`）が止まる。本物は承認待ちに戻る。worktree で触るときは、上のテストと別のポートの窓で確かめ、読み込んだら報告の前に `orca plugin dev unload <dir>` で外す（worktree を消す前にも外す）
- `local.cockpit` が承認待ち・止まっている・開発用に置き換わっているときは、窓の上の帯に理由を出し（`window/orca-state.ts` の `pluginProblem`）、hook がメインに承認を頼む dec を出させる

HTML パネルは `orca plugin shot --act` で操作できないので、操作の流れは窓のページ（同じ controller）をブラウザで確かめる。
