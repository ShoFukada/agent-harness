# 操縦席（cockpit）

全案件の「私の番」を期限順の 1 列に並べる画面。各ワークスペースの `.orca/cockpit.json`（窓口のエージェントが書く）を読み、カード（票）を左の期限の軸（止まっている → 期限切れ → 今の線 → 今日 → 明日 → 今週 → それより先 → 期限なし）にぶら下げる。案件を 1 つ選ぶとその案件の票だけに絞り、右に「案件の今」（節目と、仕事ごとの 私待ち・止まっている・作業中・顧客待ち）を出す。出す場所は 2 か所。

- **窓**: 左のディスプレイに置くブラウザの窓。全案件。幅 1440 で「案件の列｜私の番の 1 列｜案件の今・話し中・顧客待ち・報告・片付いた」の 3 列、狭い幅では 1 列に積む
- **パネル**: Orca の右のサイドバー。前面の案件 1 つ。Orca の下の帯（statusBar）に前面の案件の「私の番 n」を出し、押すとパネルを開く

利用者が押した操作は `.orca/cockpit.user.json` に追記し、窓口がそれを読んで反映する。画面が満たすことは `docs/user-stories.md`。

## カード
| 種類 | いつ出るか | 返答 | 件数 |
|---|---|---|---|
| 詰まり | 担当が質問・許可待ち・停止（Orca の状態からも作る） | 担当と話す・端末を開く | 数える |
| 許す | push・本番・データの変更の前 | 許す・この案件では任せる・止める | 数える |
| 決める | 設計・要件・費用・言い方が分かれる | 数字で選んで Enter・別の答え | 数える |
| 送る前 | 顧客か社内へ出す文面ができた | コピーしてスレッドを開く・送った・担当と直す・送らない | 数える |
| 見て | 任せた仕事の出来上がり | これでよい・直してほしい（担当と話す） | 数える |
| 届いた | 顧客の連絡が拾われた | 担当と話す・返事は要らない | 数えない |
| 話し中 | 担当と会話で作っている | 続きを話す | 数えない |
| 報告 | エージェントが決めた・済ませた | 戻して・受け取った | 数えない |

どのカードにも「担当と話す」がある。押すと、カードを引いた書き出し（`【操縦席 d21・決める】題 / 何のため: … / この件で: `）をクリップボードに入れ、担当の端末を前に出す（担当がチャットなら、そのチャットのあるワークスペースを前に出す）。カードは話し中に移って件数から外れ、担当が書き換えてバージョン（`rev`）が上がると私の番に戻る。Orca には既存のチャットを前に出す API が無いので、チャットのタブは利用者が選ぶ。

カードの状態は、`cockpit.json` の `state` に操作ログを重ねて決める（`src/model.ts` の `overlay`）。私の番 → 決めた（受け取り待ち）→ 窓口が受け取る → 片付いた。送ったカードは `awaiting` を持つと顧客待ちになり、催促の日を過ぎると朱になる。

## 構成

| ファイル | 役割 |
|---|---|
| `src/model.ts` | ファイルの形（バージョン 2）と、cockpit.json に操作ログを重ねる処理 |
| `src/migrate.ts` | バージョン 1（`items`）からバージョン 2（`cards`）への移し替え |
| `src/state.ts` | 期限の区切り・私の番の 1 列・案件の今・話す相手・Orca のサイドバーの状態を決める 1 か所。画面・`window/state.ts` はここを通す |
| `src/store.ts` | `.orca/` のファイルを読む・操作を追記する（バージョンと選択肢を確かめる）・窓口に合図を送る。パネルの worker と窓の常駐のプロセスが共有する |
| `src/view.ts` | 表示の状態から HTML を作る（DOM に触らない） |
| `src/style.ts` | CSS（明暗のトークン、container query で 1440／760 未満を切り替える） |
| `src/controller.ts` | クリック・キーボードを操作につなぐ。パネルと窓のページが共有する |
| `src/worker.ts` | パネルの worker。前面のワークスペースのファイルを見張ってパネルに送り、下の帯を更新し、前面が変わるたびに `focus.json` を書く |
| `src/panel.ts` | パネル（controller の送り先を worker にする） |
| `window/server.ts` | 窓の常駐のプロセス（launchd） |
| `window/page.ts` | 窓のページ（controller の送り先を常駐のプロセスにする） |
| `window/migrate.ts` | 移し替えのコマンド |
| `window/state.ts` | 判定済みの状態を JSON で出すコマンド。hook（periodic-reminder.sh）と窓口が、窓と同じ判定で状態を読む |
| `window/orca-state.ts` | `orca worktree ps`・`terminal list` からメイン・worker・worktree を決める |
| `fixtures/sample.ts`・`fixtures/demo.ts` | 架空の 4 案件の見本と、偽の Orca で窓を手元で動かす道具 |

## 移し替え（バージョン 1 → バージョン 2）
```sh
node window/migrate.ts <ワークスペースの root>          # 移した結果を出すだけ
node window/migrate.ts <ワークスペースの root> --write  # 書き換える
```
- 未反映の操作が残っていれば書かずに断る。先に窓口に反映させる
- 元は `cockpit.v1.json`・`cockpit.archive.v1.json` に残す
- `dec` は中身で分ける（`topic: push` は許す、`draft` があれば送る前、ほかは決める）。`ask` は送る前、`rev` は見て、`ack` は報告。どのカードも `rev` を 1 つ上げるので、古いバージョンで押した操作は通らない
- `tasks[].worker` は orchestration の形（`{ task_id, dispatch_id }`）だけを写す。workerctl の頃の形（`{ worktree_id, terminal }`）は指す先が無いので外し、済んでいないタスクの id を結果に出す（続けるなら立て直して書く）
- `summary`・`cockpit.talk.json` は移さない（依頼の `deliverables` は残す）。窓はバージョン 1 のファイルを読まず、移し替えのコマンドを添えて断る

## Orca のサイドバーとそろえる
窓のカードと Orca のサイドバーで、同じ仕事が同じ名前・同じ状態で出るようにする。`node window/state.ts <root>` の `jobs[].orca` に、仕事ごとの表示名（20 字まで）・状態・未読の印が出るので、窓口はそれに合わせて `orca worktree set --display-name / --workspace-status / --unread` を打つ。

| 案件の今 | Orca の状態 |
|---|---|
| 私待ち | `in-review`（未読の印を付ける） |
| 止まっている・作業中・顧客待ち | `in-progress` |
| 未着手 | `todo` |
| 済 | `completed`（取り込んだら消す） |

端末とチャットの題は `<短い題>（worker）`・`<短い題>（担当）`、窓口は `窓口（<案件の役割>）`。20 字を超える名前は `checks.long_names` に出る。

## 窓

```
Orca ──workspace.changed / agent.status.changed──▶ パネルの worker
                                                     │ focus.json（前面のパス・メインの端末・エージェントの変化の時刻）
                                                     ▼  ~/Library/Application Support/cockpit/
   各ワークスペースの .orca/ ──fs.watch──▶ 常駐のプロセス（127.0.0.1:47231）──SSE──▶ 窓のページ
                                          │  orca worktree ps / terminal list / agent list
                                          └─ 操作の追記・orca terminal send / switch / worktree activate / file open
```

- 起動は launchd などの常駐の仕組みに任せる。窓はブラウザの普通のタブで `http://127.0.0.1:47231` を開く
- ブラウザ向けの TS は、配るときに Node の `module.stripTypeScriptTypes` で型を除く。ビルドの手順は無い。配るのは `window/server.ts` の `SERVED` に書いたファイルだけ
- 操縦席の無い本線と、読めていない連絡の経路（`routes`）は「見ていない」として数を出す。見ていないものがあるときは「何もしなくてよい」と出さない
- 明・暗・Mac に合わせるの切り替えはブラウザに覚えさせる。既定は明るい地

### Orca の状態
- worker の記録: 窓口が担当や worker を Orca の orchestration で立てたら、タスクの `worker` に受け取りの `task_id`・`dispatch_id` を書く。窓は済んでいないタスクの Dispatch を `orca orchestration worker-show --dispatch <id> --full` で引き（`window/orca-state.ts` の `orcaDispatches`）、Dispatch の端末で worker とタスクを結ぶ。タスクの状態は Dispatch から出す（`model.ts` の `shownTask`）: worker_done を返したら取り込み待ち、起動できない・落ちた・人の確認待ちは詰まり、Orca に無ければ「Orca に見つからない」の詰まり。落ちて端末が消えた worker も詰まりの票になる
- Orca の監督の外で止まったもの（`bin/stallwatch` が書く `alerts.json`）は、窓の上にエラーの行で出す
- 前面のワークスペースは、パネルの worker が書く `focus.json` を見張って取る（ポーリングしない）
- エージェントの状態と worktree の親子は `orca worktree ps`・`orca terminal list`・`orca agent list` で取る。呼ぶのは窓が表示されている間だけで、(1) 接続したとき、(2) `focus.json` のエージェントの変化の時刻が変わったとき（5 秒に 1 回まで）、(3) 60 秒ごと
- 止まった worker は詰まりの票になる。名前は仕事の題を先にし、窓口が書いた詰まりと同じ仕事（タスクか担当の端末）なら重ねて出さない。許可待ち・返事待ちは「答えれば進む」、落ちた・ログイン切れは「私では直せない」と分ける

### セキュリティ
- 待ち受けは 127.0.0.1 だけ。Host が `127.0.0.1:<port>`・`localhost:<port>` 以外の要求は断る（DNS rebinding）
- 書き込みと送信（`/api/*`）は、起動のたびに作るトークン（配るページにだけ埋める）と Origin の両方が合うものだけ受ける。SSE もトークンが要る
- 読むファイルは `.orca/` の中だけで、`..` とシンボリックリンクで外へ出るものは読まない（`src/store.ts` の `readInOrca`）。開くファイルもワークスペースの中だけ
- figure の SVG は、パネルと同じように script・外部参照・イベント属性を取り除いてから描く

### メモリ（2026-11-16 に測った値）
| 対象 | 物理フットプリント | RSS |
|---|---|---|
| 常駐のプロセス（窓 1 枚が接続して 60 秒ごとに確かめている間） | 51〜61 MB | 75〜95 MB |
| 窓 1 枚（Chrome のアプリ表示）で増える renderer | 35 MB | |

超える分のほとんどは、Node が `.ts` を読むときに読み込む型の除去（WebAssembly）。

## 成果物と資料を開く
`href`・`links` は種類の印（Drive・PR・Slack・ページ・ファイル）を付けたボタンで出す。
- http(s) の URL: 窓は常駐のプロセスが macOS の `open` で既定のブラウザに渡す（http と https 以外は断る）。パネルは Orca の `shell.openExternal`
- ファイル: ワークスペースからの相対パスと、本線の子の worktree の中の絶対パスだけを開く。`path:行` は窓では `orca file open --line` でその行を開く

## 前にも言った・引き継ぎ
- 案件 1 つを出しているとき（パネル・絞り込み）は、上の帯に「前にも言った」がある。押すと、カードを持たない `repeat`（`item_id` は空）を追記する。前に伝えたことを窓口が落としたという合図で、窓口の hook が押下を数え、新しいチャットへの引き継ぎに使う
- hook が引き継いだときに書く `.orca/cockpit/handoff.json`（`at`・`reason`）を読み、1 日だけ「窓口を新しいチャットに引き継ぎました」と出す

## 窓口の端末への合図
端末には中身を送らず、`【操縦席】未反映の操作があります` の 1 行だけを送る。担当と話す・別の答えは、合図の 1 行にカードの id と本文の頭を載せる。
- 取り消しの猶予（10 秒）が過ぎ、窓口が入力待ちのときに自動で送る（作業中に送ると入力欄に混ざるため）
- パネルと窓は別のプロセスなので、操作を書いたほうが 10 秒で送り、もう片方は 30 秒待ってから拾う。どこまで送ったかは `~/Library/Application Support/cockpit/notified.json` で共有する
- 窓口が Orca のチャットで `main.terminal` が空のときは送る手段が無いので、「次に話しかけたときに反映されます」と出す

## 書体
IBM Plex Sans JP（Mac に入れておく）を第一に、無ければヒラギノ。パネルは Orca のサンドボックスで Web フォントを読めないので、Mac に入れた書体を名前で指す。

## 開発

```sh
orca plugin test .          # model・migrate・state・view・worker と、窓の常駐のプロセスのテスト
orca plugin check . && orca plugin validate .
COCKPIT_PORT=47299 node --disable-warning=ExperimentalWarning fixtures/demo.ts $TMPDIR/ckdemo   # 架空の 4 案件で窓を手元で動かす
node window/state.ts <ワークスペースの root>   # hook と窓口が読む判定済みの状態
```

- `orca plugin dev load .` は本物の `local.cockpit` を置き換える。worktree で触るときは、上のテストと別のポートの窓で確かめ、読み込んだら報告の前に `orca plugin dev unload <dir>` で外す
- `local.cockpit` が承認待ち・止まっている・開発用に置き換わっているときは、窓の上の帯に理由を出す（`window/orca-state.ts` の `pluginProblem`）
- HTML パネルは `orca plugin shot --act` で操作できないので、操作の流れは窓のページ（同じ controller）をブラウザで確かめる
