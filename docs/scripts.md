# 常駐スクリプトの仕組み

launchd で動かす常駐のスクリプト（worktree-sweep・orca-watch・account-failover）が、何をどの条件で行うかの詳しい説明。入れ方は README の「入れ方」、窓口と担当が守ることは worktree-flow skill の references/notify.md と references/cleanup.md にある。日付つきの記述は、その決まりを入れたときに確かめた事実の記録。

## stallwatch の知らせ

- `--job` は終了コードとログの最後の行を見る。実行に失敗したあとでも launchctl が終了コード 0 を返したことがあるので、ログにだけ残った失敗も拾う
- 窓口の判断が要るもの（worker が止まったあとメインが動いていない）だけは、`bin/cockpit-mail` で窓口の Run にも送る（R191）。launchd から送り手なしで `orca orchestration send` を打つと `no_active_sender_terminal` で断られるので、窓と同じ郵便受けの端末を送り手にする。窓口自身が止まったときの知らせは送らない

## worktree の片付け

worker の結果を取り込んだら、窓口がその場で worktree を消します（worktree-flow skill の決まり）。worktree-sweep は、そこで取りこぼしたものを拾う 2 段階目です。Orca は終わった worker の端末を閉じますが、worktree は消しません。

見るのは、Orca が `~/orca/workspaces/<リポジトリ>/<名前>`（`--under` で変えられる）に作った worktree だけです。リポジトリのルートと、Orca 以外で作った checkout は見ません。1 つずつ次の 3 つに分けます。

| 分け方 | 条件 | `--apply` のとき |
|---|---|---|
| 触らない | 作業中のエージェントがいる、Orca の状態が `completed`、担当か worker の dispatch が生きている（`orca orchestration worker-list` で Task が終わっていないか端末が live）、開発用プラグインの読み込み元、エージェントの会話が開いている（担当のチャットや人の会話。入力待ちのまま 24 時間たっても人に決めさせる対象に出さない）、残っているものがあっても動きが無くなって 24 時間たっていない | 何もしない |
| 判断が要る | 動きが無いまま 24 時間以上で、次のどれかがある: その worktree を使った worker・担当が終わった記録（worker-list の終わった dispatch）が無い、未 commit・未追跡のファイル（ルートから写した `CLAUDE.local.md` なども含む）、default ブランチに無い commit・マージコミット、detached HEAD、ルートと違うかルートに無い gitignore されたファイル（`.env` など）、作り直せると決めていない gitignore されたディレクトリ（`postgres_data/` など）。同じリポジトリで同じブランチかパスの worktree が 2 つ以上ある（Orca の一覧の外のものも `git worktree list` で数える）、Orca の記録と実際のブランチが違う、git の検査が通らない場合もここ | 何もしない。取り込むか捨てるかを人が決める |
| 消してよい | 上のどれにも当たらず、作られて 24 時間以上たっている（その worktree を使った worker・担当が終わった記録があり、取り込み済みで、固有のデータが無い。または、ブランチの PR がマージ済みで、そのあとに commit を積んでおらず、固有のデータが無い） | `orca worktree rm --worktree path:<path> --delete-branch` で消す |

- worktree を残したいときは、Orca で状態を `completed` にする（`orca worktree set --worktree path:<path> --workspace-status completed`）。`comment` は担当や操縦席が書き換えるので、残す印には使わない
- default ブランチは、リポジトリごとに `origin/HEAD` から決める。ローカルの default と `origin` の default のどちらか一方に全部入っていれば入っている扱いにする（2 つに分かれて入っているものは入っていない扱い）。squash merge で入れたブランチは `git cherry` で入っていないと出るので、ブランチの PR を `gh pr list --state merged --head <branch> --base <default>`（worktree の remote のリポジトリ）で見る（積み重ねた PR で親のブランチにだけマージしたものは default に入っていないので数えない）。マージ済みの PR の head の SHA が今の HEAD と同じなら、default に入っていない commit があっても、終わった記録が無くても（担当の居場所・手で立てた worktree）、消してよい扱いにする。HEAD が違えば（マージのあとに積んだ commit がある）、「判断が要る」に回す。未 commit のファイル・固有のデータ・作業中のエージェント・開いている会話・生きている dispatch があるものは、PR がマージ済みでも消さない。gh を読めないときと、default ブランチを決められないか git の比較が通らないときは、PR を見ずに今までどおり扱う。launchd の PATH に gh（`/run/current-system/sw/bin`）を入れる
- 人が Orca で作ったばかりの worktree は、worker・担当が終わった記録が無いので消さない（24 時間たつと「判断が要る」に出る）。終わった記録はパスで照合するので、片付けたあとに同じパスで作り直した worktree にも該当する。Orca は dispatch の時刻を launchd から読める形で出さないので、作られてから（ps の `createdAt`）24 時間たつまでは消さない
- 終わった記録として数えるのは、state が終わっていて liveness が `exited` か `unverifiable` の dispatch だけ。liveness が欠けているか知らない値のものは、生きているものとして守る
- 未追跡のファイルは、ルートから写した `CLAUDE.local.md`・`.claude/settings.local.json` でも残す理由にする（確かめた後に人が保存しうるので、無人では消さない）。この 2 つは gitignore されていてルートと同じ中身でも残す理由にする。消すときは `--force` を付けずに `orca worktree rm` を呼ぶ（読み直した後に何か書かれていれば git が断る）
- gitignore されたディレクトリは、作り直せると決めた名前（`node_modules`・`.venv`・`venv`・`dist`・`build`・`.next`・`.nuxt`・`.output`・`__pycache__`・`.turbo`・`.cache`・`.pytest_cache`・`.mypy_cache`・`.ruff_cache`・`.parcel-cache`・`.svelte-kit`・`coverage`・`.tox`・`.gradle`）と、中身が `*` だけの `.gitignore` を置いた道具の置き場（`.pytest_cache`・`.husky/_` など）の下だけを見ない。それ以外（ローカルの DB の `postgres_data/` など）は中身を見ずに残す理由にする。作り直せるものを足すときは `bin/worktree-sweep` の `REGEN` に足す
- gitignore されたファイルは、上の置き場の下と `.DS_Store` を除いて、ルートと同じ中身でなければ残す理由にする
- パスはシンボリックリンクを解いた実体で比べる
- `--apply` では、消す直前にその 1 件を Orca から読み直し、まだ「消してよい」のときだけ消す
- dispatch の一覧かプラグインの一覧を読めなかった回は、何も消さない。応答に `workers`・`plugins` の配列が無いときや、開発用プラグインの読み込み元が空のときも読めなかった扱いにする
- 結果は 1 行ずつ出し、最後の行に件数を出す。消せなかったものがあったか、dispatch かプラグインの一覧を読めなかったときは終了コード 1
- 同じ結果を `~/Library/Application Support/worktree-sweep/sweep.json`（`WORKTREE_SWEEP_HOME`）にも書く。`decide` は判断が要るもので、各項目の `parent` は親の worktree のパス、`main` は親を辿って最初に当たる窓口のワークスペースのパス（担当の下の worker も窓口に届く）。メインの hook は `main` で自分の下だけを拾える

## Orca本体が落ちたら起動し直す

2026-11-21・22の夜、macOSの自動アップデートの再起動がOrca本体を正常に終了させ、Chromeが終了を断って再起動が中止されたため、Orcaは朝まで止まっていた。Orcaのdaemonとclaudeは動き続けていたので、Orcaを起動し直せば作業は戻る。同じとき、launchdのユーザーの領域が on-demand-only になり、一定間隔のジョブ（stallwatch・account-failover）は起こされなかった。そこで、すでに動いている常駐のプロセス（orca-watch）が1分おきに `orca status` の `runtime.reachable` を見る。

- 落ちたのに気づいたら、1回だけ起動し直してよい落ち方かを決める。Orcaが最後に動いていたのを見た時刻より後にキーボードかマウスが触られていれば（`ioreg` の `HIDIdleTime`）、人が自分で終了したと見なして起動し直さない。見張りが動き出してからOrcaを一度も見ていないときと、無操作の時間を読めないときも起動し直さない
- この見分け方は入力の有無しか見ないので、両方向に外れる。人がいる間にOrcaが落ちて、そのあと別のアプリを触ると起動し直さない（人がいるので気づける）。人が触らずにOrcaを終える手段（別の端末からの終了など）では起動し直す。確実に止めておきたいときは `~/Library/Application Support/stallwatch/orca-watch.pause`（`STALLWATCH_HOME`）を置く。起動し直す直前にも見る
- 人のいないあいだに落ちていれば、気づいてから5分待って `open -a Orca` を打つ（macOSの再起動の手順は2026-11-22で47秒だった。Orcaの自己更新にかかる時間は測っていない。5分を超える手順の途中には打ちうる）。戻らなければ5分おきに試し、1時間に3回で止めて通知する。止めたあとは、最後に起動し直してから1時間たって、Orcaが動いているのを見るまで起動し直さない
- `orca status` が失敗し続けるだけでOrca本体は動いているときも、止まっていると見なす。`open -a Orca` は動いているOrcaを前に出すだけなので、3回で止まって通知する
- 起動し直す前に回数を記録に書く。書けなければ起動しない（回数を残さないまま起動し続けないため）
- `open -a Orca` を打ったこと・失敗したこと・止めたことは `~/Library/Logs/orca-watch.log` に書き、`STALLWATCH_HOME/orca-watch.json` に書いたものをstallwatchが窓の帯に合流させる。「見張りが起動し直した」は、Orcaが戻ったのを見てから12時間出す。stallwatchが起こされない間は帯に出ず、ログにだけ残る
- 見張り自身の例外ではプロセスを終えない（on-demand-only の間はlaunchdが起こし直さないため）。同じ例外はログに1回だけ書く

## 利用枠の上限で席を切り替える

前提: Orca の設定「When you switch accounts while Claude is running in terminals」は「Never restart」（値は `keep`。端末に何もしない）にしておく（Orca の設定画面で変える。CLI からは変えられない）。「Always restart」のままだと、切り替えで Orca が端末を閉じて開き直し、worker の Dispatch が lost になり、`--settings`（worker の設定）も落ちる（2026-11-22 に確かめた）。あわせて、Orca の設定「上限がリセットされたらチャットを自動で続ける」（`nativeChatAutoContinueAfterUsageLimit`）はオンにしておく（Dispatch の無い窓口のチャットは、これで新しい席で続く）。

account-failover は、Orca が読んでいる各席の使用量（`orca account list --json` の `rateLimits`。ほかの席の分も、その席を使わずに Orca が読んでいる）と、claude プロセスの引数と環境変数だけで判断し、トークンや Keychain には触りません。launchd が 1 分おきに起こし、毎回 2 つのことをします（R205）。

- 今の席が上限なら、空いている席へ `orca account select` で切り替える（下の「切り替え」）
- 切り替えの判断に関わらず、claude のプロセスを席ごとに数え、今の席と違うものを同じ枠のまま今の席へ移す（下の「古い席の claude を移す」）。自動切り替えの直後も、人が手で切り替えたあとも、同じ処理が拾う。今の席と違うプロセスも移しかけの記録も無ければ、プロセスの一覧を 1 回読んで終える

Orca の外（launchd）から案件の窓口の会話に知らせを届けるときは、`bin/cockpit-mail <root> --subject <件名> --body-file <path|->` を使います（窓口の Run に、操縦席の窓と同じ郵便受けの端末から送る。R191）。

### 切り替え

1. 今の席の 5 時間の枠か週の枠が 100% で、戻る時刻がまだ先なら「上限」と見なす。Orca が読んだ使用量が 30 分より古いか読めていないときは判断しない。Fable の週の枠は見ない
2. 行き先は `--seat` の優先度順に選ぶ。使用量に空きがあると分かっている席を先に、無ければ使用量の分からない席を試す。Orca の `stale-token`（しばらく動いていない席のトークンが古いだけで、次に Claude が動けば更新される）は使用量の分からない席として試す。上限で離れた席は、その枠が戻る時刻を過ぎるか、離れたあとに Orca が空きと読むまで選ばない
3. 次の席は行き先にしない。上限でないあいだも窓の帯に「上限に当たってもこの席へは切り替えない」と出し、行き先が無くなったら切り替えずに通知と帯で名指しする
   - ログインが切れている席（Orca の使用量取得が `missing-credentials` で失敗している）。Orca のアカウント画面でログインし直す
   - claude を対話で起こすと、席で一度だけの確認画面で止まる席（その席の `.claude.json` で、初回設定が済んでいないか、`settings.json` の `permissions.defaultMode` が auto 以外なのに「auto mode を既定にするか」に答えた記録 `hasSeenAutoDefaultNudge` が無い）。その席で一度 claude を対話で起こして答えると、記録が残って行き先に戻る
4. 切り替えたことを、通知・窓の帯（30 分）・`~/Library/Application Support/stallwatch/failover-history.jsonl`（`STALLWATCH_HOME`）の `switched` に残す。同じ実行の中で、続けて下の「古い席の claude を移す」を行う
- 全部の席が上限なら切り替えず、最初に戻る席と時刻を 1 回だけ通知し、窓の帯に出し続ける。どれかの席の枠が戻ると、次に上限に当たったときに優先度の高い席から選び直す。上限に当たっていないときに優先度の高い席へ戻ることはしない（作業中の claude を止めないため）
- 切り替えたあと 10 分は次の切り替えをしない（Orca が新しい席の使用量を読むのを待つ）。6 時間に 6 回を超えたら往復していると見なして止め、知らせる。使用量の分からない席へ移って 15 分たっても Orca が読めなければ、「上限に当たっても自動では切り替えられない」と帯に出す

### 古い席の claude を移す

claude がどの席で動くかは、起動したときの環境変数 `CLAUDE_CONFIG_DIR` で決まり、あとから変わらない。そこで実物を数えて移す。

1. 数え上げ: macOS の `sysctl`（KERN_PROC_ALL で一覧、KERN_PROCARGS2 で引数と環境変数）で claude のプロセス（comm が `claude` か nix の `.claude-wrapped`）を読む。`ps` の表示は引数の区切りが失われ、`Application Support` の空白や JSON の `--settings` が壊れるため使わない。次のものは数えない
   - 祖先に claude がいるもの（ツールや hook が起こした `claude -p` など。環境変数を受け継ぐので、親と同じ handle を持つ）
   - Orca の印が無いもの（Orca の外。Chrome の native host など）。印は、端末と担当のチャットの `ORCA_TERMINAL_HANDLE`（`term_…`・`structworker_…`）と、チャットの `ORCA_AGENT_SESSION_ID`。窓口のチャットは `ORCA_TERMINAL_HANDLE` を持たない（2026-11-23 に確かめた）
   - 席は `CLAUDE_CONFIG_DIR`（無ければ既定の `~/.claude`）。目標は `orca account list` の `activeAccountId` の席の `home`。会話 id は claude が動いている間に書く `<席>/sessions/<pid>.json` の `sessionId`、無ければ引数の `--resume`・`--session-id`（確認画面で止まった claude は書かないことがある）
   - `account-failover --inventory` で、1 プロセス 1 行（席・種類・handle・題・状態）で出す。今の席と違うものがあれば終了コード 1。次の本物の切り替えのあと 5 分ほどして打って確かめる
2. 端末（worker を含む）: 入力待ち（Orca の状態が作業中・許可待ち・返事待ちでなく、`sessions/<pid>.json` の status も busy でない）か、会話の最後か画面に上限の 1 行が出ているときだけ移す。Orca の `terminal wait --for tui-idle` は、入力待ちの古い席の端末でも時間切れになった（2026-11-23 の実機。上限の「continuing automatically at …」を待つものも、そうでないものも）ので使わない
   - 移す前に `failover-state.json` の `moves` に、handle・元の pid・会話 id・引数・`ORCA_WORKER_SETTINGS`・段階・時刻・上限で止まっていたかを残してから `/exit` を送る
   - 元の pid が消え、その端末にほかの claude が起きていないのを確かめ、同じ端末に `env CLAUDE_CONFIG_DIR=<今の席> [ORCA_WORKER_SETTINGS=<元の値>] claude <元の引数> --resume <会話 id>` を打つ。引数は 1 つずつ引用符で囲み、会話を選ぶもの（`--resume`・`--continue`・`--session-id`・`--fork-session`）は外して、実際に動いていた会話 id の `--resume` に替える
   - 元の引数のうち位置引数（consult --ask が渡した最初の指示の文など）は外す。残すと同じ会話に最初の指示がもう一度送られる。オプションの値と位置引数は、claudeの `--help` の書式（`<x>` は値を1つ、`<x...>` は次の `-` までの値を全部、`[x]` は `-` で始まらない次の1語を値に取る）と、helpに出ない `--append-system-prompt-file` などを足した表で分ける。表に無い引数の次に `-` で始まらない語があれば、値か最初の指示かを決められないので、`/exit` を打たずに名指しする。claudeのバージョンを上げて表とずれたら `bin/account_failover_test.py` が落ちる
   - 打つ行が1,000字を超えるか改行を含むときは、行を `STALLWATCH_HOME/relaunch/<handle>.sh` に `exec <行>` として書き、端末には `sh <そのファイル>` だけを打つ（claudeの親は端末のシェルのまま）。改行入りの長い行を直に打つと、zshが `quote>` の続き入力になり文字が化ける（2026-11-23 16:2xの切り替えで、consult --ask の質問の端末2つの起こし直しが7,166〜7,480字の最初の指示を残して壊れた。使い捨ての端末で、改行入りの6,764字の行は同じく壊れ、改行の無い3,022字の行は通った）。ファイルは移し終えたら消す
   - 起きた claude が入力待ち（status が idle）になったら済。上限で止まっていたものには「席の切り替えで、claude を今の席で起こし直した。止まったところから続けて」と送る
   - Dispatch を受けている worker（`worker-list` の outcome が in_progress）: Orca 1.4.271 は、端末の claude が終わった時点で Dispatch を failed（stage `process_exited`）で閉じ、coordinator に「Worker exited without reporting」を出す。同じ端末で同じ会話を起こし直しても開き直さない（2026-11-23 に使い捨ての worker で確かめた。2026-11-22 の T2 の「claude を替えても Dispatch は残る」は、この版では成り立たない）。そこで次のようにする
     - `/exit` の前に、Run の受信箱（`run:<run>`）へ worker の名で「立て直さない（worker-start で 2 つ目の worker を立てない）」と 1 通送る
     - 起こし直したあと Dispatch が failed なら、Run の coordinator（`orca orchestration run-show --id <run> --full` の `coordinator_handle`）の名で `orca orchestration send --to dispatch:<閉じた Dispatch>` を送る。Orca は follow-up の Dispatch を作り、その文を同じ端末の claude に打つので、それが続きの依頼になる（上の「続けて」は送らない）。worker 自身の名で送ると Run の受信箱に回るだけで、続きにならない。launchd の素の環境からも送れる（2026-11-23 に確かめた）
     - 窓口のチャットが coordinator の Run は `coordinator_handle` が空で、Orca はチャットを `--from` で名乗らせない（`session_caller_chat_not_declarable`）。そのときと、続きが follow-up にならなかったときは、端末に上の「続けて」を打って先に進め、Run の受信箱へ「`send --to dispatch:<id>` で続きを送る」と頼む
     - 閉じたかと、もう続きがあるか（その端末の Dispatch のうち、`worker-show` の `followUpOf` が閉じた Dispatch のもの。済んだものも含む）は、送る前と送ったあとに `worker-list` で確かめる。応答だけが失われたときや、送ったあと記録する前に落ちたときに二重に送らないため。一覧を読めなければ何も送らず、次の回に見る
     - `failover-history.jsonl` の `moved` に、閉じた Dispatch（`dispatch`）・新しい Dispatch（`follow_up`）・coordinator に頼んだか（`asked`）を残す
   - worker（引数に設定ファイルを指す `--settings` があるか、Dispatch を受けたことがある端末）で、設定ファイルを読めないか引数に無ければ、sandbox の外で動かさないよう触らずに名指しする。`ORCA_WORKER_SETTINGS` は Orca の中の claude がみな受け継いでいるので worker の印にはしない。Orca が claude に直に渡す JSON の `--settings`（`{"fastMode":false}` など）は worker の設定と見なさない
   - 途中で落ちたら、次の回で記録の段階（`exit`・`launch`・`launched`）から続ける。`launch` で端末にすでに claude が起きていれば、コマンドは打ち直さない（起きた claude の入力欄に打たない）。`/exit` のあと claude が終わらなくても `/exit` は打ち直さない。同じ段階で 3 回うまくいかなければ諦め、印（段階 `failed`）を残して、今の席の claude がその端末で起きるか端末が閉じるまで帯に出し続ける
   - 移しかけの端末が閉じたら（窓口がworktreeを消したなど）、帯にも通知にも出さず、`failover-history.jsonl` に `gone`（handle・会話id・段階）を残して記録を消す。会話は `claude --resume <会話 id>` で開ける。その回の初めに端末の一覧を読んだあとに閉じて、起こすコマンドを送れなかったときと、起こしたあとclaudeが見えないときは、端末の一覧を読み直して確かめる（2026-11-23 16:25の drop-sales-view-flag の3端末は、読み直さなかったので帯に「起こし直すコマンドを送れなかった」が1回出た）
   - 端末の画面を読めないとき、同じ端末に claude が 2 つ以上あるとき、起きた claude が今の席で同じ会話を開き直したものと確かめられないとき（会話 id を `sessions/<pid>.json` で照合する）は、文字を打たずに名指しする
3. チャット（窓口・担当）: 作業中のターンが無い（Orca の状態が done など）か、会話の最後（`<席>/projects/<作業場所>/<会話 id>.jsonl` の最後の応答）が上限のエラーなら、裏の claude に SIGTERM を送る。Orca は次の発言で、今選ばれている席の claude を同じ会話のまま起こす（2026-11-22 の T1・T4 で確かめた）
   - working でも上限のエラーで止まっているもの（バックグラウンドの監視を抱えて上限のエラーを出し続けたもの。2026-11-22 にある案件の窓口で起きた）は止める。監視も一緒に止まる
   - 会話の最後の応答より新しい入力（user）があれば、上限で止まったとは見なさない（新しい指示に答える途中）。前の回から持ち越した停止も、止める直前にもう一度ターンを見て、作業中なら止めない
   - Dispatch を持つチャット（担当）は、止める前に Run の受信箱（`run:<run>`）へ担当の名（`structworker_…`）で「席の切り替えで <題> の裏の claude を止めた。Dispatch は生きているので立て直さない」と 1 通送る（止めると Orca が coordinator に「Worker exited without reporting」を出すため。launchd はチャットの窓口の名を名乗れない）。送れなければ止めずに次の回に試す
   - 上限で止まっていた担当には、止めたあと `--to dispatch:<id>` で「席の切り替えで起こし直した。バックグラウンドの監視は止まったので、要るものは張り直す」を送る（そのメッセージで今の席の claude が起きる）。Dispatch の無い窓口は Orca の自動継続に任せ、作業中でも上限でもない待機中のものは起こさない（次の発言で起きる）
   - 元の pid が消え、そのチャットに古い席の claude が無くなれば済
4. 移す順: 端末は 1 つ移すのに 10 秒ほどかかり、十数個あると最後は切り替えから数分あとになる（2026-11-23 15:17 の切り替えでは 13 個目の ui-verify-loop の worker が 15:21 に移った。その間の 15:19 に担当が送った続きは、古い席の claude ですぐ上限のエラーになり、窓に停止の票が出た）。そこで 1 つ移すごとに残りを選び直し、チャット・移しかけの端末・上限で止まった端末・Dispatch を受けている端末・ほかの端末の順に移す。Dispatch は移す直前に一覧を読み直し、移している間に届いたものも拾う
5. 作業中のまま上限のエラーも出ないプロセスは触らず、次の回に回す（古い席が上限なら、作業中のターンはやがて上限のエラーで終わり、そのあとに移す）。6 時間たっても残れば諦めて名指しする
6. 確認画面（`bin/stallwatch` の `STARTUP_SCREENS`。ログイン・フォルダの信頼・auto mode・bypass permissions・初回設定・CLAUDE.md の外部 import の承認（External imports））で止まった端末には、自動で答えず、席・端末・画面の名前を帯と通知で名指しする。席ごとの承認（`.claude.json`）をほかの席へ写すことはしない（動いている claude と書き込みがぶつかり、片方の変更が消える。R205）。承認は席ごとに人が一度行う
7. 数え直し: 毎回の終わりに数え直し、古い席が 0 なら帯を消して `failover-history.jsonl` に `converged` を残す。残ったものは、名前・理由・次に要る操作を帯（`STALLWATCH_HOME/failover.json`）に出す。通知は、人の手が要るもの（作業中・移している途中を除く）が新しく出たときだけ出す

- 送れなかった知らせは `STALLWATCH_HOME/failover-tells.json` に残し、次の回に送り直す（1 日で捨てる）
- 窓の帯へは、account-failover が `STALLWATCH_HOME/failover.json` に書き、stallwatch が `alerts.json` に合流させる（帯の書き手を stallwatch 1 つに保つ。orca-watch の `orca-watch.json` も同じ）。通知は account-failover が書いた時点で出すので、stallwatch は重ねて出さない
- `--dry-run` は、どの席へ切り替え、どの claude をどう移すか（打つコマンド・止めるチャット・移さない理由）を出すだけで、何も変えない。手で打つときも launchd と同じロック（`STALLWATCH_HOME/failover.lock`）を取る
