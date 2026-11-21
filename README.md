# agent-harness

Orca で複数のコーディングエージェントを並べて動かすときに、人が判断にだけ頭を使えるようにする道具の集まりです。案件ごとの窓口のエージェント（各ワークスペースのメイン）が作業を進め、人は「自分の番」のものだけを 1 か所で片付けます。

| 道具 | できること |
|---|---|
| 操縦席（`orca/plugins/cockpit`） | 全案件で自分が決める・許す・送る・見るものを、期限順の 1 列に並べる画面。押した操作は窓口に届き、迷うものは仕事の担当のチャットへ渡せる |
| orca-launch（`bin/orca-launch`） | worker（別の worktree の端末で動く Claude Code や Codex）を、呼んだエージェントと同じアカウントと worker 用の設定で立ち上げ、指示を Orca の orchestration の Task として渡す |
| stallwatch（`bin/stallwatch`） | Orca の監視外で止まったもの（Orca そのもの・各ワークスペースのメイン・操縦席の窓・launchd の定時ジョブ）を数分おきに見て、macOS の通知と操縦席の窓の上の帯に出す。モデルは呼ばない |
| worktree-sweep（`bin/worktree-sweep`） | 取り込み済みで使い終わった worker・担当の worktree を毎晩消し、取り込むか捨てるかを人が決めるものを一覧にする。モデルは呼ばない |
| account-failover（`bin/account-failover`） | 今の Claude の席が利用枠の上限に当たったら、優先度が高く空いている席へ切り替え、Orca が起動し直した端末に続きを頼む。全部の席が上限なら戻る時刻を知らせる。モデルは呼ばない |

## 毎日の使い方

![2 枚のディスプレイでの使い方](docs/two-displays.svg)

左のディスプレイに操縦席の窓を置き、主のディスプレイに Orca を置きます。

1. 朝は窓の上の帯で全案件の「私の番」の数を見て、1 列を上から片付けます。決めるカードはおすすめを選んだ状態で開くので、よければボタンを 1 回押すだけで次のカードに進みます
2. 迷うカードは「担当と話す」を押します。カードの書き出しがクリップボードに入り、Orca でその仕事の担当のいるワークスペースが前に出るので、知らせに出たタブを開いて貼ります。決まったことは担当がカードに書き戻します
3. Slack や Teams の連絡は、見張りの Bot（このリポジトリの外）が拾って「届いた」に出し、返事が要るものは担当が「送る前」の文面にします。人はコピーして送り、「送った」を押します
4. worker の結果は「見て」に出ます。止まった worker は、窓口が書かなくても 1 列の先頭の「止まっている」に出ます
5. 夕方は右の列の報告・顧客待ち・片付いたを見て、残りを確かめます

画面の見方、カードの種類、キーボードの操作は [操縦席の README](orca/plugins/cockpit/README.md) にあります。

## 入れ方

macOS、Orca 1.4.259 以降、Node 24 以降、Python 3.9 以降を前提とします。

1. 置き場所に clone する。以下の例は `~/.config/agent-harness`
   ```sh
   git clone https://github.com/<owner>/agent-harness ~/.config/agent-harness
   ```
2. `orca-launch` を PATH に通し、worker に付ける Claude Code 設定のパスを `ORCA_WORKER_SETTINGS` に入れる（無ければ設定を付けずに起動する）
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
   `--job` は終了コードとログの最後の行を見る（失敗した実行のあとでも launchctl が終了コード 0 を返したことがあるので、ログにだけ残った失敗も拾う）。`--service` は動いているかを見る。知らせは macOS の通知と窓の上の帯だけに出し、会話の中へは送らない（worker の完了と停止でメインを起こすのは Orca の orchestration。launchd から `orca orchestration send` を打つと送り主が決まらず断られる）

6. worktree の見回り（worktree-sweep）を launchd で毎晩 1 回 `--apply` 付きで動かす。PATH には orca CLI のある Orca.app の bin と git を入れる。何を消すかは下の「worktree の片付け」にある
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

7. 席の切り替え（account-failover）を launchd で 1 分おきに動かす。`--seat` に切り替えてよい席のメールアドレスを優先度の高い順に並べる（Orca の `orca account list` に出る席だけ）。PATH には orca CLI のある Orca.app の bin を入れる。何をするかは下の「利用枠の上限で席を切り替える」にある
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
   入れる前に `--dry-run`（`--assume-full` を足すと今の席を上限と見なす）で、どの席へ移り、どの端末に続きを頼むかを確かめる。stallwatch の `--job` に足すと、失敗した回が窓の帯に出る

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
| 消してよい | 上のどれにも当たらず、作られて 24 時間以上たっている（その worktree を使った worker・担当が終わった記録があり、取り込み済みで、固有のデータが無い） | `orca worktree rm --worktree path:<path> --delete-branch` で消す |

- worktree を残したいときは、Orca で状態を `completed` にする（`orca worktree set --worktree path:<path> --workspace-status completed`）。`comment` は担当や操縦席が書き換えるので、残す印には使わない
- default ブランチは、リポジトリごとに `origin/HEAD` から決める。ローカルの default と `origin` の default のどちらか一方に全部入っていれば入っている扱いにする（2 つに分かれて入っているものは入っていない扱い）。squash merge で入れたブランチは `git cherry` で入っていないと出るので「判断が要る」に回る
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

## 利用枠の上限で席を切り替える

account-failover は、Orca が読んでいる各席の使用量（`orca account list --json` の `rateLimits`。ほかの席の分も、その席を使わずに Orca が読んでいる）だけで判断し、トークンや Keychain には触りません。

1. 今の席の 5 時間の枠か週の枠が 100% で、戻る時刻がまだ先なら「上限」と見なす。Orca の読みが 30 分より古いか読めていないときは判断しない。Fable の週の枠は見ない
2. 行き先は `--seat` の優先度順に選ぶ。使用量が空きと分かっている席を先に、無ければ使用量の分からない席（トークンが古く Orca が読めていない席など）を試す。上限で離れた席は、その枠が戻る時刻を過ぎるか、離れたあとに Orca が空きと読むまで選ばない
3. 切り替える前に、上限の 1 行が画面に出ている端末と、作業中の Claude の端末を控える
4. `orca account select` で切り替える。CLI からの切り替えを、Orca の窓は既定の設定（実行中の Claude を「確認する」）のまま起動し直しとして扱い、古い席で前景に Claude がいる端末を `claude --resume` で開き直す。Bash などの子プロセスが前景の端末は移らない
5. 控えた端末のうち Orca が起動し直したもの（最大 90 秒待つ）が入力待ちになったら、「席を切り替えて起動し直した。止まったところから続けて」と送る。起動し直したが作業中でも上限でもなかった端末には送らない
6. 切り替えたことを、通知・窓の帯（30 分）・`~/Library/Application Support/stallwatch/failover-history.jsonl`（`STALLWATCH_HOME`）に、時刻・元の席・先の席・続けさせた端末・移らなかった端末・上限で止まっているチャットとして残す

- チャット（Orca のチャットのタブ）は切り替えでは起動し直らず、外から「続ける」を押す口も無いので、知らせるだけにする。窓口のチャットは「続ける」で新しい席になる。`orca orchestration worker-start` で立てた担当のチャットは元の席に残るので、作業の状態を確かめて立て直す
- 全部の席が上限なら切り替えず、最初に戻る席と時刻を 1 回だけ通知し、窓の帯に出し続ける。どれかの席の枠が戻ると、次に上限に当たったときに優先度の高い席から選び直す。上限に当たっていないときに優先度の高い席へ戻ることはしない（作業中の端末を止めないため）
- 切り替えたあと 10 分は次の切り替えをしない（Orca が新しい席の使用量を読むのを待つ）。6 時間に 6 回を超えたら往復していると見なして止め、知らせる。使用量の分からない席へ移って 15 分たっても Orca が読めなければ、「上限に当たっても自動では切り替えられない」と帯に出す
- Orca の設定「ターミナルで Claude を実行中にアカウントを切り替える場合」を「維持」にしていると、端末は起動し直らない。Orca が窓を開かずに動いているときも起動し直らない
- 窓の帯へは、account-failover が `STALLWATCH_HOME/failover.json` に書き、stallwatch が `alerts.json` に合流させる（帯の書き手を stallwatch 1 つに保つ）。通知は account-failover が書いた時点で出すので、stallwatch は重ねて出さない

## 入っているもの

| 場所 | 中身 |
|---|---|
| `orca/plugins/cockpit/` | Orca のプラグイン（パネルと worker）と、窓の常駐プロセス（`window/server.ts`）。使い方と仕組みは同じ場所の README、画面が満たす条件は `docs/user-stories.md` |
| `bin/orca-launch`・`bin/orca_launch_test.py` | worker の起動（端末の作成・確認画面の検出・Task の受け渡し・サイドバーの表示名と状態）とそのテスト |
| `bin/stallwatch`・`bin/stallwatch_test.py` | 止まったものの見張りとそのテスト。記録先は `~/Library/Application Support/stallwatch/`（`STALLWATCH_HOME`）、見つけたものの書き出し先は窓が読む `~/Library/Application Support/cockpit/alerts.json`（`COCKPIT_DIR`） |
| `bin/account-failover`・`bin/account_failover_test.py` | 利用枠の上限での席の切り替えとそのテスト。記録先は stallwatch と同じ `STALLWATCH_HOME`（`failover-state.json`・`failover.json`・`failover-history.jsonl`） |
| `bin/worktree-sweep`・`bin/worktree_sweep_test.py` | 使い終わった worktree の見回りとそのテスト。結果の書き出し先は `~/Library/Application Support/worktree-sweep/sweep.json`（`WORKTREE_SWEEP_HOME`） |

## テスト

```sh
(cd orca/plugins/cockpit && orca plugin test .)
python3 bin/orca_launch_test.py
python3 bin/stallwatch_test.py
python3 bin/worktree_sweep_test.py
python3 bin/account_failover_test.py
```

## ライセンス

MIT（`LICENSE`）
