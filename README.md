# agent-harness

Orca で複数のコーディングエージェントを並べて動かすときに、人が判断にだけ頭を使えるようにする道具の集まりです。案件ごとの窓口のエージェント（各ワークスペースのメイン）が作業を進め、人は「自分の番」のものだけを 1 か所で片付けます。

## 目指すもの

土台にある考えは一つです。持ち主の認知負荷は最も貴重な資源なので、人は判断と大事な確認にだけ頭を使い、抜けの検出・文脈の維持・情報の整理は、人が覚えていなくても仕組みが受け持ちます。そのために、窓口・担当・worker・Botのすべてが次の5つを守ります。

### 1. 漏れなく一貫して遂行する

窓口・担当・worker・Botは同じ構造と同じ名前の付け方で動き、受けた依頼を、済んだ証拠がそろうまで手放しません。抜けを人が覚えていることを前提にしないためです。

- 依頼は受けた時点で帳簿に載せ、完了条件と証拠（mainに入ったcommit、公開したページ、人の操作）で済を決める
- 抜けたら直すだけでなく、抜けた原因まで取り除く
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
- 写した会話で決まったことは元の会話に返し、記録と帳簿に書いてから作業に反映する
- 閉じた話や関係のない話で、自分の会話の文脈を汚さない

### 作り方の約束

- 根本から直し、場当たりの継ぎはぎにしない。ただし検査・スクリプト・定期確認をむやみに増やさない。まず写しを消し、今ある仕組みを使い回す
- 状態は1か所に持ち、どの画面から見ても同じ内容を表示する
- 早く出して、使いながら直す
- 費用・規約・外に出るものは、歯止めを先に決める
- 設計とコードのレビュー、日本語と見た目の確認には、作ったモデルとは別系統のモデルの目を通す

| 道具 | できること |
|---|---|
| 操縦席（`orca/plugins/cockpit`） | 全案件で自分の番のもの（判断・許可・送信前など）を、期限順の1列に並べる画面。押した操作は窓口に届き、迷うものは仕事の担当のチャットへ渡せる |
| orca-launch（`bin/orca-launch`） | worker（別の worktree の端末で動く Claude Code や Codex）を、Orca で今選ばれている Claude の席と worker 用の設定で立ち上げ、指示を Orca の orchestration の Task として渡す |
| stallwatch（`bin/stallwatch`） | Orca の監視外で止まったもの（Orca そのもの・各ワークスペースのメイン・操縦席の窓・launchd の定時ジョブ）を数分おきに見て、macOS の通知と操縦席の窓の上の帯に出す。モデルは呼ばない |
| worktree-sweep（`bin/worktree-sweep`） | 取り込み済みで使い終わった worker・担当の worktree を毎晩消し、取り込むか捨てるかを人が決めるものを一覧にする。モデルは呼ばない |
| account-failover（`bin/account-failover`） | 今の Claude の席が利用枠の上限に達したら、優先度が高く空いている席へ切り替え、Orca の中で動く claude（端末・チャット）を全部、同じ枠のまま切り替え先の席へ移す。全部の席が上限なら、利用枠が戻る時刻を知らせる。モデルは呼ばない |

## 毎日の使い方

![2 枚のディスプレイでの使い方](docs/two-displays.svg)

左のディスプレイに操縦席の窓を置き、主のディスプレイに Orca を置きます。

1. 朝は窓の上の帯で全案件の要対応の数を見て、1列を上から片付けます。判断のカードはおすすめを選んだ状態で開くので、よければボタンを1回押すだけで次のカードに進みます
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
   `--job` は終了コードとログの最後の行を見る（ログにだけ残った失敗も拾う）。`--service` は動いているかを見る。知らせは macOS の通知と窓の上の帯に出し、窓口の Run には送らない（窓口を起こすのは Orca。docs/scripts.md「stallwatch の知らせ」）

6. worktree の定期確認（worktree-sweep）を launchd で毎晩 1 回 `--apply` 付きで動かす。PATH には orca CLI のある Orca.app の bin と git と gh を入れる。何を消すかは [docs/scripts.md](docs/scripts.md) の「worktree の片付け」にある
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

7. 席の切り替え（account-failover）を launchd で 1 分おきに動かす。`--seat` に切り替えてよい席のメールアドレスを優先度の高い順に並べる（Orca の `orca account list` に出る席だけ）。PATH には orca CLI のある Orca.app の bin を入れる。先に Orca の設定「アカウントを切り替えたとき端末の Claude を」を keep（Never restart）にし、「上限がリセットされたらチャットを自動で続ける」（`nativeChatAutoContinueAfterUsageLimit`）をオンにする（Dispatch の無い窓口のチャットは、これで新しい席で続く）。何をするかは [docs/scripts.md](docs/scripts.md) の「利用枠の上限で席を切り替える」にある
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
   入れる前に `--dry-run`（`--assume-full` を足すと今の席を上限と見なす）でどの席へ移り、どの claude をどう移すかを確かめる。あわせて `--inventory` で、今どの claude がどの席で動いているかも確かめる。stallwatch の `--job` に足すと、失敗した回が窓の帯に出る

8. Orca本体の見張り（orca-watch）をlaunchdの `KeepAlive` で常駐させる。PATHにはorca CLIのある Orca.app のbinと、`ioreg` のある `/usr/sbin` を入れる。何をするかは [docs/scripts.md](docs/scripts.md) の「Orca本体が落ちたら起動し直す」にある
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

## 決まりの置き場所

運用の決まりは、領域ごとに次の 1 か所だけに書く。ほかの文書は中身を写さず、ここに挙げた文書の節を指す。名前の形・工程名・カードの種類・必須の欄のように形で決まるものは、入口の道具のコード（cockpit-write・state.ts・orca-launch）が検査する。値を挙げる文書は下の置き場所だけにし、ほかの文書には写さない。決めたことを反映する手順は cockpit skill の references/rulings.md「決めたとき」にある。

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
| worker の sandbox（使える道具・使えないもの） | worktree-flow skill の references/worker-env.md（仕組みは `docs/worker-sandbox.md`） |
| 席の切り替えと、切り替えたあとの続き | `~/.config/agent-harness/docs/scripts.md`「利用枠の上限で席を切り替える」 |
| メインの作業メモの中身と「今の順番」の形 | cockpit skill の references/memo.md |
| 窓口（ワークスペースのメイン）だけの動き方 | `~/.config/nix-darwin/claude/roles/main.md` |
| 担当だけの動き方 | `~/.config/nix-darwin/claude/roles/lead.md` |
| 日本語の語の選び方（業務の漢語など） | dev-standards の rules/docs/writing.md |
| 外に出す文面の書式 | dev-standards の rules/docs/message-formats.md |
| agy（Gemini）でClaudeと同じhookとskillを使う仕組み（イベント・道具名・返事の対応、skills.json の作り方、リポジトリのskillの渡し方） | `claude/hooks/agy-hook.py` の冒頭の説明 |
| 従量課金の LLM API の使い方 | dev-standards の rules/dev/principles.md「AI の使い方」 |
| Bot の受け持ちと動き | `~/.orca/bots/<名前>/SOUL.md`（帳簿への載せ方は cockpit skill の SKILL.md「仕事の形」） |

## 入っているもの

| 場所 | 中身 |
|---|---|
| `orca/plugins/cockpit/` | Orca のプラグイン（パネルと worker）と、窓の常駐プロセス（`window/server.ts`）。使い方と仕組みは同じ場所の README、画面が満たす条件は `docs/user-stories.md` |
| `bin/orca-launch`・`bin/orca_launch_test.py` | worker の起動とそのテスト。中でしていることは worktree-flow skill の references/launch.md |
| `bin/stallwatch`・`bin/stallwatch_test.py` | 止まったものの見張りとそのテスト。記録先は `~/Library/Application Support/stallwatch/`（`STALLWATCH_HOME`）、見つけたものの書き出し先は窓が読む `~/Library/Application Support/cockpit/alerts.json`（`COCKPIT_DIR`） |
| `bin/cockpit-mail` | Orca の外のプロセスから案件の窓口の Run に知らせるコマンド。中身と試験は `orca/plugins/cockpit/window/mail.ts`・`mail.test.ts` |
| `bin/account-failover`・`bin/account_failover_test.py` | 利用枠の上限に達したときの席の切り替えとそのテスト。記録先は stallwatch と同じ `STALLWATCH_HOME`（`failover-state.json`・`failover.json`・`failover-history.jsonl`） |
| `bin/orca-watch`・`bin/orca_watch_test.py` | Orca本体が人のいないあいだに落ちたときの起動し直しとそのテスト。記録先はstallwatchと同じ `STALLWATCH_HOME`（`orca-watch-state.json`・`orca-watch.json`・`orca-watch.pause`） |
| `bin/worktree-sweep`・`bin/worktree_sweep_test.py` | 使い終わった worktree の片付けとそのテスト。結果の書き出し先は `~/Library/Application Support/worktree-sweep/sweep.json`（`WORKTREE_SWEEP_HOME`） |
| `claude/` | Claude Codeに読ませるskill・agent・hookと、workerのsandboxの外で動くスクリプト（下の「claude/」） |
| `gemini/plugins/harness/` | agy（Antigravity CLI）のプラグイン。`hooks.json` はagyの5つのイベントで `claude/hooks/agy-hook.py` を呼ぶだけで、どのhookを動かすかは持たない。nix-darwinが `~/.gemini/config/plugins.json` のentriesに `gemini/plugins` のフォルダを書く。`~/.gemini/config/skills.json` は、nix-darwinのactivationとagyの起動のたびに、`agy-hook.py SyncSkills` が `~/.claude/skills` と有効なプラグイン（enabledPlugins）のskillのフォルダから作る。作業中のリポジトリの `.claude/skills` は、起動のときに一覧と SKILL.md のパスを渡す |
| `docs/harness-map.html` | 見取り図。役・知らせの経路・帳簿の読み書き・状態の決め方・席の切り替えを図で示す1つのHTML。設計が変わる取り込みのたびに直す（cockpit skillの references/workers.md） |
| `docs/harness-detail.html` | 詳しい図。ファイルごとの読み書き・仕事の形と工程・カードの種類・タスクの状態の決まり方・処理の流れ5本・書く道具が断る規則を図で示す1つのHTML |
| `docs/scripts.md` | 常駐スクリプト（worktree-sweep・orca-watch・account-failover）が何をどの条件でするかの詳しい説明 |
| `docs/worker-sandbox.md` | worker の sandbox が何をなぜ許し、何をなぜ止めているかの解説 |

## claude/

Claude Codeの `~/.claude/` に張る道具です。並びは `~/.claude/` と同じで、nix-darwin がこのcloneの各フォルダへのsymlinkを張ります。settings.json・CLAUDE.md・rolesなど持ち主の環境によるものは、このリポジトリに置きません。

| 場所 | 中身 |
|---|---|
| `claude/agents/` | subagent（researcher・test-runner・test-sweeper） |
| `claude/skills/<名前>/` | skill。本文は `SKILL.md` |
| `claude/hooks/` | hookと、その試験・`testdata/`。どの出来事で呼ぶかとtimeoutは、持ち主の環境の settings.json が決める。`agy-hook.py` は agy から同じ settings.json とプラグインの hook を読んで動かす入口で、agy 用の hook は別に書かない |
| `claude/bin/` | workerのsandboxの外で動かすスクリプト（Codex・Gemini・PostgreSQL・顧客のSharePointを読む入口）と、その共通部品（`sandbox_tmp.py`・`agy_launch.py`）。Neon を単発で呼ぶものはどれも `agy_launch.py` を通り、HOME を利用者の一時フォルダの `agy-neon-home` に替えて、`~/.gemini` の対話用の決まり・skill・hook・MCP を読ませない |

外に置くものは環境変数で受け取ります。

- `claude/bin/` のスクリプトは、workerのsettingsの `denyRead` を自分でも塞ぐため、そのパスを `$ORCA_WORKER_SETTINGS` から読む（無ければ動かずに止まる）。orca-launch は worker を起こすときに `--settings` と同じ絶対パスをこの変数にも入れ、account-failover は端末の claude を今の席で起こし直すときに元のプロセスの値をそのまま渡す
- `claude/hooks/periodic-reminder.sh` は、カードの相談で使う役割の文書を `$CLAUDE_ROLES_DIR`（既定は `~/.config/nix-darwin/claude/roles`）から読む
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
