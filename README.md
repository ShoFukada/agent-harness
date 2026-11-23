# agent-harness

Orca で複数のコーディングエージェントを並べて動かすときに、人が判断にだけ頭を使えるようにする道具の集まりです。案件ごとの窓口のエージェント（各ワークスペースのメイン）が作業を進め、人は「自分の番」のものだけを 1 か所で片付けます。

## 目指すもの

土台にある考えは一つです。持ち主の認知負荷は最も貴重な資源なので、人は判断と大事な確認にだけ頭を使い、抜けの検出・文脈の維持・情報の整理は、人が覚えていなくても仕組みが受け持ちます。そのために、窓口・担当・worker・Botのすべてが次の5つを守ります。

### 1. 漏れなく一貫して遂行する

窓口・担当・worker・Botは同じ構造と同じ名前の付け方で動き、受けた依頼を、済んだ証拠がそろうまで手放しません。抜けを人が覚えていることを前提にしないためです。

- 依頼は受けた時点で帳簿に載せ、済の条件と証拠（mainに入ったcommit、公開したページ、人の操作）で済を決める
- 抜けたら直すだけでなく、抜けた原因まで潰す
- 案件・仕事・タスク・workerは、名前と並びで階層が分かるようにする
- 決まりは領域ごとに1か所にだけ置き、ほかの文書はそこを指す。名前の形・工程名・必須の欄のように形で決まるものは、書く道具が入口で断る

### 2. 必要な情報を渡す

人に何かを頼むときは、判断に要る文脈・実物・具体例を最初からそろえます。聞き返しが1往復増えるたびに、人の時間と集中が削られるためです。

- 判断の依頼には、何を決めるか・今どうなっているか・選ぶと何が起きるか・得るもの・失うもの・おすすめを付ける
- 見てほしいページは手元のパスではなくURLで渡し、手作業はそのまま写せる手順で渡す
- 何を出すかは、これまでの指示と好みから割り出す。細部は、人が質問して取りに行ける形にしておく

### 3. 判断と協調を分類して回す

エージェントが決められることはエージェントが決め、理由と戻し方を報告で共有します。人に回すのは、外に出るもの・戻せないもの・要件や設計が変わるものだけです。全部を聞けば判断の数が依頼の数だけ増え、黙って決めれば信頼が崩れるためです。

- 人に回すものは、停止・許可・判断・送信前・確認の5種類に分け、期限順の1列に並べる
- 繰り返す許可は「この案件では任せる」で一任に切り替え、以後は聞かない
- 仕事は「任せる」「一緒に作る」「見張る」の3つの形に分け、形ごとに人の関わり方を変える
- 1つのBotは1つの案件を受け持ち、知らせる先も1つにする

### 4. 認知負荷を上げない

画面と文には、見る情報だけを決まった形で出します。説明文に頼らず、並び・位置・語で分からせます。

- 状態と種類は語で示し、意味の分からない印や色を増やさない
- エージェントの内部の作業と、窓口が自分で片付けるものは、人の前に出さない
- 報告・カード・画面の文は業務の漢語で書き、話し言葉や幼い言い回しを避ける
- 画面は、作ったモデルとは別系統のモデルに見た目を確認させてから出す

### 5. 文脈を管理してAIを鈍らせない

決定・制約・人の原文は会話の外に置き、圧縮しても原文のまま戻します。各エージェントには、その仕事に要る文脈だけを持たせます。文脈の質が、そのまま遂行の質になるためです。

- 決めたことは判断の記録に1行で残し、圧縮のあとに原文で流し直して、作業に戻る前に照合する
- 窓口は人と話すために空けておき、調査はsubagent、コードはworker、1日を超える仕事は担当に出す
- 写した会話で決まったことは本線に返し、記録と帳簿に書いてから作業に反映する
- 閉じた話や関係のない話で、本線の文脈を汚さない

### 作り方の約束

- 根本から直し、場当たりの継ぎはぎにしない。ただし検査・スクリプト・定期確認をむやみに増やさない。まず写しを消し、今ある仕組みを使い回す
- 状態は1か所に持ち、どの画面から見ても同じに出す
- 早く出して、使いながら直す
- 費用・規約・外に出るものは、歯止めを先に決める
- 設計とコードのレビュー、日本語と見た目の確認には、作ったモデルとは別系統のモデルの目を通す

| 道具 | できること |
|---|---|
| 操縦席（`orca/plugins/cockpit`） | 全案件で自分の番のもの（判断・許可・送信前など）を、期限順の1列に並べる画面。押した操作は窓口に届き、迷うものは仕事の担当のチャットへ渡せる |
| orca-launch（`bin/orca-launch`） | worker（別の worktree の端末で動く Claude Code や Codex）を、Orca で今選ばれている Claude の席と worker 用の設定で立ち上げ、指示を Orca の orchestration の Task として渡す |
| stallwatch（`bin/stallwatch`） | Orca の監視外で止まったもの（Orca そのもの・各ワークスペースのメイン・操縦席の窓・launchd の定時ジョブ）を数分おきに見て、macOS の通知と操縦席の窓の上の帯に出す。モデルは呼ばない |
| worktree-sweep（`bin/worktree-sweep`） | 取り込み済みで使い終わった worker・担当の worktree を毎晩消し、取り込むか捨てるかを人が決めるものを一覧にする。モデルは呼ばない |
| account-failover（`bin/account-failover`） | 今の Claude の席が利用枠の上限に当たったら、優先度が高く空いている席へ切り替え、Orca の中で動く claude（端末・チャット）を全部、同じ枠のまま今の席へ移す。全部の席が上限なら戻る時刻を知らせる。モデルは呼ばない |

## 毎日の使い方

![2 枚のディスプレイでの使い方](docs/two-displays.svg)

左のディスプレイに操縦席の窓を置き、主のディスプレイに Orca を置きます。

1. 朝は窓の上の帯で全案件の「私の番」の数を見て、1列を上から片付けます。判断のカードはおすすめを選んだ状態で開くので、よければボタンを1回押すだけで次のカードに進みます
2. 迷うカードは「担当と協議」（担当がいなければ「窓口と協議」）を押します。カードの書き出しがクリップボードに入り、Orca でその仕事の担当のいるワークスペースが前に出るので、知らせに出たタブを開いて貼ります。決まったことは担当が窓口に送り、窓口がカードに書き戻します
3. SlackやTeamsの連絡は、見張りのBot（このリポジトリの外）が拾って「受信」に出し、返事が要るものは担当が「送信前」の文面にします。人はコピーして送り、「送信済みにする」を押します
4. workerの結果は「確認」に出ます。止まったworkerは、窓口が書かなくても1列の先頭の「停止」に出ます
5. 一緒に作る仕事は、返事待ちでなくても1列に「共同作業」として常に出て、そこから担当のチャットに移れます。仕事の形の細部は `claude/skills/cockpit/SKILL.md` の「仕事の形」にあります
6. 夕方は要対応のタブの下の「報告（参照のみ）」、全体のタブの「顧客待ち」の仕事、対応済みのタブ（直近14日）を見て、残りを確かめます

画面の見方、カードの種類、キーボードの操作は [操縦席の README](orca/plugins/cockpit/README.md) にあります。

## 入れ方

macOS、Orca 1.4.259 以降、Node 24 以降、Python 3.9 以降を前提とします。

1. 置き場所に clone する。以下の例は `~/.config/agent-harness`
   ```sh
   git clone https://github.com/<owner>/agent-harness ~/.config/agent-harness
   ```
2. `orca-launch` を PATH に通し、worker に付ける Claude Code 設定のパスを `ORCA_WORKER_SETTINGS` に入れる（無ければ設定を付けずに起動する）。どの worker にも渡す決まりの文言は `claude/skills/worktree-flow/references/worker-rules.md` にある（orca-launch が brief の先頭に足す。無ければ立てずに断る）
   ```sh
   ln -s ~/.config/agent-harness/bin/orca-launch ~/.local/bin/orca-launch
   export ORCA_WORKER_SETTINGS=~/.claude/settings.worker.json
   ```
3. 操縦席のプラグインをフォルダから入れる。権限の確認が出たら、表示された `--approve <fingerprint>` を付けて打ち直す
   ```sh
   orca plugin install ~/.config/agent-harness/orca/plugins/cockpit
   ```
4. 窓の常駐プロセスを launchd で動かす。`~/Library/LaunchAgents/` に置く plist の主な項目は次のとおり。窓はブラウザで `http://127.0.0.1:47231` を開いて表示する
   ```xml
   <key>ProgramArguments</key>
   <array>
     <string>/path/to/node</string>
     <string>--disable-warning=ExperimentalWarning</string>
     <string>/Users/you/.config/agent-harness/orca/plugins/cockpit/window/server.ts</string>
   </array>
   <key>EnvironmentVariables</key>
   <dict>
     <!-- orca CLI を呼ぶので Orca.app の bin を入れる -->
     <key>PATH</key><string>/Applications/Orca.app/Contents/Resources/bin:/usr/bin:/bin</string>
   </dict>
   <key>RunAtLoad</key><true/>
   <key>KeepAlive</key><true/>
   ```
5. 見張り（stallwatch）を launchd で 5 分おきに動かす。Orca の更新や再起動でメインと一緒に止まらないよう、Orca の automations ではなく launchd に置く。PATH には orca CLI のある Orca.app の bin を入れる
   ```xml
   <key>ProgramArguments</key>
   <array>
     <string>/usr/bin/python3</string>
     <string>/Users/you/.config/agent-harness/bin/stallwatch</string>
     <string>--window-log</string><string>/Users/you/Library/Logs/cockpit-window.log</string>
     <string>--service</string><string>com.example.cockpit-window</string>
     <string>--job</string><string>com.example.nightly=/Users/you/Library/Logs/nightly.log</string>
   </array>
   <key>StartInterval</key><integer>300</integer>
   ```
   `--job` は終了コードとログの最後の行を見る（失敗した実行のあとでも launchctl が終了コード 0 を返したことがあるので、ログにだけ残った失敗も拾う）。`--service` は動いているかを見る。知らせは macOS の通知と窓の上の帯に出す。窓口の判断が要るもの（worker が止まったあとメインが動いていない）だけは、`bin/cockpit-mail` で窓口の Run にも送る（R191。launchd から送り手なしで `orca orchestration send` を打つと `no_active_sender_terminal` で断られるので、窓と同じ郵便受けの端末を送り手にする）。窓口自身が止まった知らせは送らない

6. worktree の見回り（worktree-sweep）を launchd で毎晩 1 回 `--apply` 付きで動かす。PATH には orca CLI のある Orca.app の bin と git と gh を入れる。何を消すかは下の「worktree の片付け」にある
   ```xml
   <key>ProgramArguments</key>
   <array>
     <string>/usr/bin/python3</string>
     <string>/Users/you/.config/agent-harness/bin/worktree-sweep</string>
     <string>--apply</string>
   </array>
   <key>StartCalendarInterval</key><dict><key>Hour</key><integer>23</integer><key>Minute</key><integer>30</integer></dict>
   <key>EnvironmentVariables</key>
   <dict>
     <key>PATH</key><string>/Applications/Orca.app/Contents/Resources/bin:/usr/bin:/bin</string>
   </dict>
   ```
   stallwatch の `--job <label>=<ログ>` に足しておくと、消せなかった回や Orca の一覧を読めなかった回（終了コード 1）が通知と窓の帯に出る

7. 席の切り替え（account-failover）を launchd で 1 分おきに動かす。`--seat` に切り替えてよい席のメールアドレスを優先度の高い順に並べる（Orca の `orca account list` に出る席だけ）。PATH には orca CLI のある Orca.app の bin を入れる。先に Orca の設定「アカウントを切り替えたとき端末の Claude を」を keep にする。何をするかは下の「利用枠の上限で席を切り替える」にある
   ```xml
   <key>ProgramArguments</key>
   <array>
     <string>/usr/bin/python3</string>
     <string>/Users/you/.config/agent-harness/bin/account-failover</string>
     <string>--seat</string><string>me@example.com</string>
     <string>--seat</string><string>second@example.com</string>
   </array>
   <key>StartInterval</key><integer>60</integer>
   <key>EnvironmentVariables</key>
   <dict>
     <key>PATH</key><string>/Applications/Orca.app/Contents/Resources/bin:/usr/bin:/bin</string>
   </dict>
   <key>StandardOutPath</key><string>/Users/you/Library/Logs/account-failover.log</string>
   <key>StandardErrorPath</key><string>/Users/you/Library/Logs/account-failover.log</string>
   ```
   入れる前に `--dry-run`（`--assume-full` を足すと今の席を上限と見なす）で、どの席へ移り、どの claude をどう移すかを、`--inventory` で今どの claude がどの席で動いているかを確かめる。stallwatch の `--job` に足すと、失敗した回が窓の帯に出る

8. Orca本体の見張り（orca-watch）をlaunchdの `KeepAlive` で常駐させる。PATHにはorca CLIのある Orca.app のbinと、`ioreg` のある `/usr/sbin` を入れる。何をするかは下の「Orca本体が落ちたら起動し直す」にある
   ```xml
   <key>ProgramArguments</key>
   <array>
     <string>/usr/bin/python3</string>
     <string>/Users/you/.config/agent-harness/bin/orca-watch</string>
   </array>
   <key>RunAtLoad</key><true/>
   <key>KeepAlive</key><true/>
   <key>EnvironmentVariables</key>
   <dict>
     <key>PATH</key><string>/Applications/Orca.app/Contents/Resources/bin:/usr/sbin:/usr/bin:/bin</string>
   </dict>
   <key>StandardOutPath</key><string>/Users/you/Library/Logs/orca-watch.log</string>
   <key>StandardErrorPath</key><string>/Users/you/Library/Logs/orca-watch.log</string>
   ```
   stallwatchの `--service` に足しておくと、見張りが動いていないときに通知と窓の帯に出る

窓口のエージェントには、`.orca/cockpit.json` にカードを書かせます。ファイルの形と最小の例は [操縦席の README の「ファイルの形」](orca/plugins/cockpit/README.md#ファイルの形バージョン-2) にあります。

<details>
<summary>設定のリポジトリ（nix-darwin）から参照するとき</summary>

作者は nix-darwin（home-manager）の設定から、このリポジトリの clone を `mkOutOfStoreSymlink` で指しています。手で直した内容を switch なしですぐ使えるようにすることを優先し、次の 2 点から flake input にはしませんでした。

- flake input にすると、ファイルが読み取り専用の `/nix/store` に入る。1 行直して確かめるたびに、commit・push・`nix flake update`・switch が要る
- Orca は操縦席をフォルダから入れ、launchd は `server.ts` をそのまま動かす。どちらも書き換えられる実体のパスを指す必要がある

代わりに、home-manager の activation で clone が無いときだけ clone します。どのコミットで動いているかは clone の `git log` で分かりますが、flake.lock のようには固定されません。

```nix
home.activation.agentHarness = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
  if [ ! -e "$HOME/.config/agent-harness" ] && [[ ! -v DRY_RUN ]]; then
    ${pkgs.git}/bin/git clone https://github.com/<owner>/agent-harness "$HOME/.config/agent-harness" || true
  fi
'';
home.file.".local/bin/orca-launch".source =
  config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agent-harness/bin/orca-launch";
```

</details>

## worktree の片付け

worker の結果を取り込んだら、窓口がその場で worktree を消します（worktree-flow skill の決まり）。worktree-sweep は、そこで取りこぼしたものを拾う 2 段階目です。Orca は終わった worker の端末を閉じますが、worktree は消しません。

見るのは、Orca が `~/orca/workspaces/<リポジトリ>/<名前>`（`--under` で変えられる）に作った worktree だけです。リポジトリのルートと、Orca 以外で作った checkout は見ません。1 つずつ次の 3 つに分けます。

| 分け方 | 条件 | `--apply` のとき |
|---|---|---|
| 触らない | 作業中のエージェントがいる、Orca の状態が `completed`、担当か worker の dispatch が生きている（`orca orchestration worker-list` で Task が終わっていないか端末が live）、開発用プラグインの読み込み元、エージェントの会話が開いている（担当のチャットや人の会話。入力待ちのまま 24 時間たっても人に決めさせる対象に出さない）、残っているものがあっても動きが無くなって 24 時間たっていない | 何もしない |
| 判断が要る | 動きが無いまま 24 時間以上で、次のどれかがある: その worktree を使った worker・担当が終わった記録（worker-list の終わった dispatch）が無い、未 commit・未追跡のファイル（ルートから写した `CLAUDE.local.md` なども含む）、default ブランチに無い commit・マージコミット、detached HEAD、ルートと違うかルートに無い gitignore されたファイル（`.env` など）、作り直せると決めていない gitignore されたディレクトリ（`postgres_data/` など）。同じリポジトリで同じブランチかパスの worktree が 2 つ以上ある（Orca の一覧の外のものも `git worktree list` で数える）、Orca の記録と実際のブランチが違う、git の検査が通らない場合もここ | 何もしない。取り込むか捨てるかを人が決める |
| 消してよい | 上のどれにも当たらず、作られて 24 時間以上たっている（その worktree を使った worker・担当が終わった記録があり、取り込み済みで、固有のデータが無い。または、ブランチの PR がマージ済みで、そのあとに commit を積んでおらず、固有のデータが無い） | `orca worktree rm --worktree path:<path> --delete-branch` で消す |

- worktree を残したいときは、Orca で状態を `completed` にする（`orca worktree set --worktree path:<path> --workspace-status completed`）。`comment` は担当や操縦席が書き換えるので、残す印には使わない
- default ブランチは、リポジトリごとに `origin/HEAD` から決める。ローカルの default と `origin` の default のどちらか一方に全部入っていれば入っている扱いにする（2 つに分かれて入っているものは入っていない扱い）。squash merge で入れたブランチは `git cherry` で入っていないと出るので、ブランチの PR を `gh pr list --state merged --head <branch> --base <default>`（worktree の remote のリポジトリ）で見る（積み重ねた PR で親のブランチにだけマージしたものは default に入っていないので数えない）。マージ済みの PR の head の SHA が今の HEAD と同じなら、default に入っていない commit があっても、終わった記録が無くても（担当の居場所・手で立てた worktree）消してよい扱いにする。HEAD が違えば（マージのあとに積んだ commit がある）「判断が要る」に回す。未 commit のファイル・固有のデータ・作業中のエージェント・開いている会話・生きている dispatch があるものは、PR がマージ済みでも消さない。gh を読めないときと、default ブランチを決められないか git の比較が通らないときは、PR を見ずに今までどおり扱う。launchd の PATH に gh（`/run/current-system/sw/bin`）を入れる
- 人が Orca で作ったばかりの worktree は、worker・担当が終わった記録が無いので消さない（24 時間たつと「判断が要る」に出る）。終わった記録はパスで当てるので、片付けたあとに同じパスで作り直した worktree にも当たる。Orca は dispatch の時刻を launchd から読める形で出さないので、作られて（ps の `createdAt`）24 時間たつまでは消さない
- 終わった記録として数えるのは、state が終わっていて liveness が `exited` か `unverifiable` の dispatch だけ。liveness が欠けている・知らない値のものは生きているものとして守る
- 未追跡のファイルは、ルートから写した `CLAUDE.local.md`・`.claude/settings.local.json` でも残す理由にする（確かめた後に人が保存しうるので、無人では消さない）。この 2 つは gitignore されていてルートと同じ中身でも残す理由にする。消すときは `--force` を付けずに `orca worktree rm` を呼ぶ（読み直した後に何か書かれていれば git が断る）
- gitignore されたディレクトリは、作り直せると決めた名前（`node_modules`・`.venv`・`venv`・`dist`・`build`・`.next`・`.nuxt`・`.output`・`__pycache__`・`.turbo`・`.cache`・`.pytest_cache`・`.mypy_cache`・`.ruff_cache`・`.parcel-cache`・`.svelte-kit`・`coverage`・`.tox`・`.gradle`）と、中身が `*` だけの `.gitignore` を置いた道具の置き場（`.pytest_cache`・`.husky/_` など）の下だけを見ない。それ以外（ローカルの DB の `postgres_data/` など）は中身を見ずに残す理由にする。作り直せるものを足すときは `bin/worktree-sweep` の `REGEN` に足す
- gitignore されたファイルは、上の置き場の下と `.DS_Store` を除いて、ルートと同じ中身でなければ残す理由にする
- パスはシンボリックリンクを解いた実体で比べる
- `--apply` では、消す直前にその 1 件を Orca から読み直し、まだ「消してよい」のときだけ消す
- dispatch の一覧かプラグインの一覧を読めなかった回は、何も消さない。応答に `workers`・`plugins` の配列が無い、開発用プラグインの読み込み元が空のときも読めなかった扱い
- 結果は 1 行ずつ出し、最後の行に件数を出す。消せなかったものがあったか、dispatch かプラグインの一覧を読めなかったときは終了コード 1
- 同じ結果を `~/Library/Application Support/worktree-sweep/sweep.json`（`WORKTREE_SWEEP_HOME`）にも書く。`decide` が判断が要るもので、各項目の `parent` は親の worktree のパス、`main` は親を辿って最初に当たる窓口のワークスペースのパス（担当の下の worker も窓口に届く）。メインの hook は `main` で自分の下だけを拾える

## Orca本体が落ちたら起動し直す

2026-11-21・22の夜、macOSの自動アップデートの再起動がOrca本体を正常に終了させ、Chromeが終了を断って再起動が中止されたため、Orcaは朝まで止まっていた。Orcaのdaemonとclaudeは動き続けていたので、Orcaを起動し直せば作業は戻る。同じときlaunchdのユーザーの領域が on-demand-only になり、一定間隔のジョブ（stallwatch・account-failover）は起こされなかった。そこで、すでに動いている常駐のプロセス（orca-watch）が1分おきに `orca status` の `runtime.reachable` を見る。

- 落ちたのに気づいたら、1回だけ起動し直してよい落ち方かを決める。Orcaが最後に動いていたのを見た時刻より後にキーボードかマウスが触られていれば（`ioreg` の `HIDIdleTime`）、人が自分で終了したと見なして起動し直さない。見張りが動き出してからOrcaを一度も見ていないときと、無操作の時間を読めないときも起動し直さない
- この見分け方は入力の有無しか見ないので、両方向に外れる。人がいる間にOrcaが落ちて、そのあと別のアプリを触ると起動し直さない（人がいるので気づける）。人が触らずにOrcaを終える手段（別の端末からの終了など）では起動し直す。確実に止めておきたいときは `~/Library/Application Support/stallwatch/orca-watch.pause`（`STALLWATCH_HOME`）を置く。起動し直す直前にも見る
- 人のいないあいだに落ちていれば、気づいてから5分待って `open -a Orca` を打つ（macOSの再起動の手順は2026-11-22で47秒だった。Orcaの自己更新にかかる時間は測っていない。5分を超える手順の途中には打ちうる）。戻らなければ5分おきに試し、1時間に3回で止めて通知する。止めたあとは、最後に起動し直してから1時間たって、Orcaが動いているのを見るまで起動し直さない
- `orca status` が失敗し続けるだけでOrca本体は動いているときも、止まっていると数える。`open -a Orca` は動いているOrcaを前に出すだけなので、3回で止まって通知する
- 起動し直す前に回数を記録に書く。書けなければ起動しない（回数を残さないまま起動し続けないため）
- `open -a Orca` を打ったこと・失敗したこと・止めたことは `~/Library/Logs/orca-watch.log` に書き、`STALLWATCH_HOME/orca-watch.json` に書いたものをstallwatchが窓の帯に合流させる。「見張りが起動し直した」は、Orcaが戻ったのを見てから12時間出す。stallwatchが起こされない間は帯に出ず、ログにだけ残る
- 見張り自身の例外ではプロセスを終えない（on-demand-only の間はlaunchdが起こし直さないため）。同じ例外はログに1回だけ書く

## 利用枠の上限で席を切り替える

前提: Orca の設定「When you switch accounts while Claude is running in terminals」は「Never restart」（値は `keep`。端末に何もしない）にしておく（Orca の設定の画面で変える。CLI からは変えられない）。「Always restart」のままだと、切り替えで Orca が端末を閉じて開き直し、worker の Dispatch が lost になり、`--settings`（worker の設定）も落ちる（2026-11-22 に確かめた）。あわせて、Orca の設定「上限がリセットされたらチャットを自動で続ける」（`nativeChatAutoContinueAfterUsageLimit`）はオンにしておく（Dispatch の無い窓口のチャットは、これで新しい席で続く）。

account-failover は、Orca が読んでいる各席の使用量（`orca account list --json` の `rateLimits`。ほかの席の分も、その席を使わずに Orca が読んでいる）と、claude のプロセスの引数と環境変数だけで判断し、トークンや Keychain には触りません。launchd が 1 分おきに起こし、毎回 2 つのことをします（R205）。

- 今の席が上限なら、空いている席へ `orca account select` で切り替える（下の「切り替え」）
- 切り替えの判断に関わらず、claude のプロセスを席ごとに数え、今の席と違うものを同じ枠のまま今の席へ移す（下の「古い席の claude を移す」）。自動の切り替えの直後も、人が手で切り替えたあとも、同じ処理が拾う。今の席と違うプロセスも移しかけの記録も無ければ、プロセスの一覧を 1 回読んで終える

Orca の外（launchd）から案件の窓口の会話に知らせを届けるときは、`bin/cockpit-mail <root> --subject <件名> --body-file <path|->` を使います（窓口の Run に、操縦席の窓と同じ郵便受けの端末から送る。R191）。

### 切り替え

1. 今の席の 5 時間の枠か週の枠が 100% で、戻る時刻がまだ先なら「上限」と見なす。Orca の読みが 30 分より古いか読めていないときは判断しない。Fable の週の枠は見ない
2. 行き先は `--seat` の優先度順に選ぶ。使用量が空きと分かっている席を先に、無ければ使用量の分からない席を試す。Orca の `stale-token`（しばらく動いていない席のトークンが古いだけで、次に Claude が動けば更新される）は使用量の分からない席として試す。上限で離れた席は、その枠が戻る時刻を過ぎるか、離れたあとに Orca が空きと読むまで選ばない
3. 次の席は行き先にしない。上限でないあいだも窓の帯に「上限に当たってもこの席へは切り替えない」と出し、行き先が無くなったら切り替えずに通知と帯で名指しする
   - ログインが切れている席（Orca の使用量の失敗が `missing-credentials`）。Orca のアカウントの画面でログインし直す
   - claude を対話で起こすと、席で一度だけの確認の画面で止まる席（その席の `.claude.json` で、初回の設定が済んでいないか、`settings.json` の `permissions.defaultMode` が auto 以外なのに「auto mode を既定にするか」に答えた記録 `hasSeenAutoDefaultNudge` が無い）。その席で一度 claude を対話で起こして答えると、記録が残って行き先に戻る
4. 切り替えたことを、通知・窓の帯（30 分）・`~/Library/Application Support/stallwatch/failover-history.jsonl`（`STALLWATCH_HOME`）の `switched` に残す。同じ実行の中で、続けて下の「古い席の claude を移す」をする
- 全部の席が上限なら切り替えず、最初に戻る席と時刻を 1 回だけ通知し、窓の帯に出し続ける。どれかの席の枠が戻ると、次に上限に当たったときに優先度の高い席から選び直す。上限に当たっていないときに優先度の高い席へ戻ることはしない（作業中の claude を止めないため）
- 切り替えたあと 10 分は次の切り替えをしない（Orca が新しい席の使用量を読むのを待つ）。6 時間に 6 回を超えたら往復していると見なして止め、知らせる。使用量の分からない席へ移って 15 分たっても Orca が読めなければ、「上限に当たっても自動では切り替えられない」と帯に出す

### 古い席の claude を移す

claude がどの席で動くかは、起動したときの環境変数 `CLAUDE_CONFIG_DIR` で決まり、あとから変わらない。そこで実物を数えて移す。

1. 数え上げ: macOS の `sysctl`（KERN_PROC_ALL で一覧、KERN_PROCARGS2 で引数と環境変数）で claude のプロセス（comm が `claude` か nix の `.claude-wrapped`）を読む。`ps` の表示は引数の境界を失い、`Application Support` の空白や JSON の `--settings` が壊れるため使わない。次のものは数えない
   - 祖先に claude がいるもの（ツールや hook が起こした `claude -p` など。環境変数を受け継ぐので、親と同じ handle を持つ）
   - Orca の印が無いもの（Orca の外。Chrome の native host など）。印は、端末と担当のチャットの `ORCA_TERMINAL_HANDLE`（`term_…`・`structworker_…`）と、チャットの `ORCA_AGENT_SESSION_ID`。窓口のチャットは `ORCA_TERMINAL_HANDLE` を持たない（2026-11-23 に確かめた）
   - 席は `CLAUDE_CONFIG_DIR`（無ければ既定の `~/.claude`）。目標は `orca account list` の `activeAccountId` の席の `home`。会話 id は claude が動いている間に書く `<席>/sessions/<pid>.json` の `sessionId`、無ければ引数の `--resume`・`--session-id`（確認の画面で止まった claude は書かないことがある）
   - `account-failover --inventory` で、1 プロセス 1 行（席・種類・handle・題・状態）に出す。今の席と違うものがあれば終了コード 1。次の本物の切り替えのあと 5 分ほどして打って確かめる
2. 端末（worker を含む）: 入力待ち（Orca の状態が作業中・許可待ち・返事待ちでなく、`sessions/<pid>.json` の status も busy でない）か、会話の最後か画面に上限の 1 行が出ているときだけ移す。Orca の `terminal wait --for tui-idle` は、入力待ちの古い席の端末でも時間切れになった（2026-11-23 の実機。上限の「continuing automatically at …」を待つものも、そうでないものも）ので使わない
   - 移す前に `failover-state.json` の `moves` に、handle・元の pid・会話 id・引数・`ORCA_WORKER_SETTINGS`・段階・時刻・上限で止まっていたかを残してから `/exit` を送る
   - 元の pid が消え、その端末にほかの claude が起きていないのを確かめ、同じ端末に `env CLAUDE_CONFIG_DIR=<今の席> [ORCA_WORKER_SETTINGS=<元の値>] claude <元の引数> --resume <会話 id>` を打つ。引数は 1 つずつ引用し、会話を選ぶもの（`--resume`・`--continue`・`--session-id`・`--fork-session`）は外して、実際に動いていた会話 id の `--resume` に替える。Dispatch は端末に結び付くので、claude を替えても残る（2026-11-22 の T2 で確かめた）
   - 起きた claude が入力待ち（status が idle）になったら済。上限で止まっていたものには「席の切り替えで、claude を今の席で起こし直した。止まったところから続けて」と送る
   - worker（引数に設定のファイルを指す `--settings` がある、か Dispatch を受けたことがある端末）で、設定のファイルを読めないか引数に無ければ、sandbox の外で動かさないよう触らずに名指しする。`ORCA_WORKER_SETTINGS` は Orca の中の claude がみな受け継いでいるので worker の印にはしない。Orca が claude に直に渡す JSON の `--settings`（`{"fastMode":false}` など）は worker の設定と見なさない
   - 途中で落ちたら、次の回が記録の段階（`exit`・`launch`・`launched`）から続ける。`launch` で端末にもう claude が起きていれば、コマンドは打ち直さない（起きた claude の入力欄に打たない）。`/exit` のあと claude が終わらなくても `/exit` は打ち直さない。同じ段階で 3 回うまくいかなければ諦め、印（段階 `failed`）を残して、今の席の claude がその端末で起きるか端末が閉じるまで帯に出し続ける
   - 端末の画面を読めないとき、同じ端末に claude が 2 つ以上あるとき、起きた claude が今の席で同じ会話を開き直したものと確かめられないとき（会話 id を `sessions/<pid>.json` で照合する）は、文字を打たずに名指しする
3. チャット（窓口・担当）: 作業中のターンが無い（Orca の状態が done など）か、会話の最後（`<席>/projects/<作業場所>/<会話 id>.jsonl` の最後の応答）が上限のエラーなら、裏の claude に SIGTERM を送る。Orca は次の発言で、今選ばれている席の claude を同じ会話のまま起こす（2026-11-22 の T1・T4 で確かめた）
   - working でも上限のエラーで止まっているもの（バックグラウンドの監視を抱えて上限のエラーを出し続けたもの。2026-11-22 の BW の窓口）は止める。監視も一緒に止まる
   - 会話の最後の応答より新しい入力（user）があれば、上限で止まったとは見なさない（新しい指示に答える途中）。前の回から持ち越した停止も、止める直前にもう一度ターンを見て、作業中なら止めない
   - Dispatch を持つチャット（担当）は、止める前に Run の受信箱（`run:<run>`）へ担当の名（`structworker_…`）で「席の切り替えで <題> の裏の claude を止めた。Dispatch は生きているので立て直さない」と 1 通送る（止めると Orca が coordinator に「Worker exited without reporting」を出すため。launchd はチャットの窓口の名を名乗れない）。送れなければ止めずに次の回に試す
   - 上限で止まっていた担当には、止めたあと `--to dispatch:<id>` で「席の切り替えで起こし直した。バックグラウンドの監視は止まったので、要るものは張り直す」を送る（そのメッセージで今の席の claude が起きる）。Dispatch の無い窓口は Orca の自動の続きに任せ、作業中でも上限でもない待機中のものは起こさない（次の発言で起きる）
   - 元の pid が消え、そのチャットに古い席の claude が無くなれば済
4. 作業中のまま上限のエラーも出ないプロセスは触らず、次の回に回す（古い席が上限なら、作業中のターンはやがて上限のエラーで終わり、そのあとに移す）。6 時間たっても残れば諦めて名指しする
5. 確認の画面（`bin/stallwatch` の `STARTUP_SCREENS`。ログイン・フォルダの信頼・auto mode・bypass permissions・初回の設定・CLAUDE.md の外部 import の承認（External imports））で止まった端末には、自動で答えず、席・端末・画面の名前を帯と通知で名指しする。席ごとの承認（`.claude.json`）をほかの席へ写すことはしない（動いている claude と書き込みがぶつかり、片方の変更が消える。R205）。承認は席ごとに人が一度する
6. 数え直し: 毎回の終わりに数え直し、古い席が 0 なら帯を消して `failover-history.jsonl` に `converged` を残す。残ったものは、名前・理由・次に要る操作を帯（`STALLWATCH_HOME/failover.json`）に出す。通知は、人の手が要るもの（作業中・移している途中を除く）が新しく出たときだけ出す

- 送れなかった知らせは `STALLWATCH_HOME/failover-tells.json` に残し、次の回に送り直す（1 日で捨てる）
- 窓の帯へは、account-failover が `STALLWATCH_HOME/failover.json` に書き、stallwatch が `alerts.json` に合流させる（帯の書き手を stallwatch 1 つに保つ。orca-watch の `orca-watch.json` も同じ）。通知は account-failover が書いた時点で出すので、stallwatch は重ねて出さない
- `--dry-run` は、どの席へ切り替え、どの claude をどう移すか（打つコマンド・止めるチャット・移さない理由）を出すだけで、何も変えない。手で打つときも launchd と同じロック（`STALLWATCH_HOME/failover.lock`）を取る

## 決まりの置き場所

運用の決まりは、領域ごとに次の 1 か所だけに書く。ほかの文書は中身を写さず、ここに挙げた文書の節を指す。名前の形・工程名・カードの種類・必須の欄のように形で決まるものは、入口の道具のコード（cockpit-write・state.ts・orca-launch）が検査する。値を挙げる文書は下の置き場所だけにし、ほかの文書には写さない。決めたことを反映する手順は cockpit skill の references/rulings.md「決めたとき」。

| 領域 | 置き場所 |
|---|---|
| ハーネスの目指すもの（決まりを足す・直すときの拠り所） | `~/.config/agent-harness/README.md`「目指すもの」 |
| 今やる作業と、待ってよい理由（先送りの禁止） | `~/.config/nix-darwin/agents/common.md`「判断」の「聞かずにやる」 |
| 帳簿（cockpit.json）の欄・必須の欄・どの事実をどこが持つか | cockpit skill の references/schema.md |
| カードの書き方・深田に回す範囲・一任した操作 | cockpit skill の references/cards.md |
| 判断の記録と、決めたときに直す手順 | cockpit skill の references/rulings.md |
| 仕事の形（任せる・一緒に作る・見張る）と、一緒に作る仕事の受け方 | cockpit skill の SKILL.md「仕事の形」 |
| 名前（案件・仕事・タスク・窓口・タブ）と親子・サイドバーの状態 | worktree-flow skill の references/sidebar.md |
| 担当・worker の立て方・親の worktree・知らせ（窓口に送るもの）・同時に動かす数 | worktree-flow skill の SKILL.md「窓口・担当・worker」（知らせの経路と受け方は references/notify.md、担当の立て方は references/launch.md） |
| worker の囲い（使える道具・使えないもの） | worktree-flow skill の references/worker-env.md |
| 席の切り替えと、切り替えたあとの続き | `~/.config/agent-harness/README.md`「利用枠の上限で席を切り替える」 |
| メインの作業メモの中身と「今の順番」の形 | cockpit skill の references/memo.md |
| 窓口（ワークスペースのメイン）だけの動き方 | `~/.config/nix-darwin/claude/roles/main.md` |
| 担当だけの動き方 | `~/.config/nix-darwin/claude/roles/lead.md` |
| 日本語の語の選び方（業務の漢語など） | dev-standards の rules/docs/writing.md |
| 外に出す文面の書式 | dev-standards の rules/docs/message-formats.md |
| 従量課金の LLM API の使い方 | dev-standards の rules/dev/principles.md「AI の使い方」 |
| Bot の受け持ちと動き | `~/.orca/bots/<名前>/SOUL.md`（帳簿への載せ方は cockpit skill の SKILL.md「仕事の形」） |

## 入っているもの

| 場所 | 中身 |
|---|---|
| `orca/plugins/cockpit/` | Orca のプラグイン（パネルと worker）と、窓の常駐プロセス（`window/server.ts`）。使い方と仕組みは同じ場所の README、画面が満たす条件は `docs/user-stories.md` |
| `bin/orca-launch`・`bin/orca_launch_test.py` | worker の起動（端末の作成・確認画面の検出と名指し（どの席で何の画面か）・Task の受け渡し・サイドバーの表示名と状態と親・上限を超える名前を断る・どの worker にも渡す決まりを brief の先頭に足す）とそのテスト |
| `bin/stallwatch`・`bin/stallwatch_test.py` | 止まったものの見張りとそのテスト。記録先は `~/Library/Application Support/stallwatch/`（`STALLWATCH_HOME`）、見つけたものの書き出し先は窓が読む `~/Library/Application Support/cockpit/alerts.json`（`COCKPIT_DIR`） |
| `bin/cockpit-mail` | Orca の外のプロセスから案件の窓口の Run に知らせるコマンド。中身と試験は `orca/plugins/cockpit/window/mail.ts`・`mail.test.ts` |
| `bin/account-failover`・`bin/account_failover_test.py` | 利用枠の上限での席の切り替えとそのテスト。記録先は stallwatch と同じ `STALLWATCH_HOME`（`failover-state.json`・`failover.json`・`failover-history.jsonl`） |
| `bin/orca-watch`・`bin/orca_watch_test.py` | Orca本体が人のいないあいだに落ちたときの起動し直しとそのテスト。記録先はstallwatchと同じ `STALLWATCH_HOME`（`orca-watch-state.json`・`orca-watch.json`・`orca-watch.pause`） |
| `bin/worktree-sweep`・`bin/worktree_sweep_test.py` | 使い終わった worktree の見回りとそのテスト。結果の書き出し先は `~/Library/Application Support/worktree-sweep/sweep.json`（`WORKTREE_SWEEP_HOME`） |
| `claude/` | Claude Codeに読ませるskill・agent・hookと、workerのsandboxの外で動くスクリプト（下の「claude/」） |
| `docs/harness-map.html` | 見取り図。役・知らせの経路・帳簿の読み書き・状態の決め方・席の切り替えを図で示す1つのHTML。設計が変わる取り込みのたびに直す（cockpit skillの references/workers.md） |
| `docs/harness-detail.html` | 詳しい図。ファイルごとの読み書き・仕事の形と工程・カードの種類・タスクの状態の決まり方・処理の流れ5本・書く道具が断る規則を図で示す1つのHTML |

## claude/

Claude Codeの `~/.claude/` に張る道具です。並びは `~/.claude/` と同じで、nix-darwin がこのcloneの各フォルダへのsymlinkを張ります。settings.json・CLAUDE.md・rolesなど持ち主の環境に依るものは、このリポジトリに置きません。

| 場所 | 中身 |
|---|---|
| `claude/agents/` | subagent（researcher・test-runner・test-sweeper） |
| `claude/skills/<名前>/` | skill。本文は `SKILL.md` |
| `claude/hooks/` | hookと、その試験・`testdata/`。どの出来事で呼ぶかとtimeoutは、持ち主の環境の settings.json が決める |
| `claude/bin/` | workerのsandboxの外で動かすスクリプト（Codex・Gemini・PostgreSQL・顧客のSharePointを読む囲い）と、その共通部品（`sandbox_tmp.py`・`agy_launch.py`） |

外に置くものは環境変数で受け取ります。

- `claude/bin/` のスクリプトは、workerのsettingsの `denyRead` を自分でも塞ぐため、そのパスを `$ORCA_WORKER_SETTINGS` から読む（無ければ動かずに止まる）。orca-launch は worker を起こすときに `--settings` と同じ絶対パスをこの変数にも入れ、account-failover は端末の claude を今の席で起こし直すときに元のプロセスの値をそのまま渡す
- `claude/hooks/periodic-reminder.sh` は、カードの相談の役割の文書を `$CLAUDE_ROLES_DIR`（既定は `~/.config/nix-darwin/claude/roles`）から読む
- `claude/hooks/sandbox-exclude-guard.py` は、sandboxの外で動かしてよいスクリプトを、自分の場所から見た `../bin` で決める。settings.worker.json の `excludedCommands` には、このcloneの `claude/bin/` のパスを書く

## テスト

```sh
(cd orca/plugins/cockpit && orca plugin test .)
python3 bin/orca_launch_test.py
python3 bin/stallwatch_test.py
python3 bin/worktree_sweep_test.py
python3 bin/account_failover_test.py
python3 bin/orca_watch_test.py
for t in claude/bin/*_test.py claude/hooks/*_test.py claude/skills/*/*_test.py; do python3 "$t"; done
python3 claude/skills/diagrams/build_catalog.py --check
```

## ライセンス

MIT（`LICENSE`）
