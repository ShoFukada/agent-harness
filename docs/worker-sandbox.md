# workerのsandboxの仕組み

worker（settings.worker.json と settings.worker.verify.json で動くClaude Code）のsandboxが、何をなぜ許し、何をなぜ止めているかの解説。workerの立て方とbriefに書くコマンドは worktree-flow skillの references/worker-env.md にある。ここは、設定を直すとき・止まった理由を調べるときに読む。

## 目的
- workerが読んだ文に仕込まれた指示に従っても、鍵を外の宛先に送れないようにする（2026-11から試行中）
- 止まる操作が多くて作業にならなければ、settings.worker.json の `sandbox` と、PostToolUse・PostToolUseFailureのhookを外して戻す

## 囲う範囲
- 囲われるのはBashのコマンドだけ。hook・MCP・WebFetch・ファイルを読み書きする道具は外で動く
- 通信できるのはGitHub・npm・PyPI・Playwrightのブラウザの配布先だけ（`strictAllowlist` なのでbypassPermissionsでも止まる）。止められたコマンドをsandboxの外でやり直すこと（`dangerouslyDisableSandbox`）もできない。orca CLIはOrcaのsocketのフォルダを許可しているので使える。`orca terminal` でsandboxの外にコマンドを出せるので、ここは抜け道として残っている
- 書けるのはworktree・`$TMPDIR`・そのworktreeの元のリポジトリの `.git`（Claude Codeが自動で許可する。別のリポジトリの `.git` は書けない）・npm / uv / pnpmのキャッシュ。Claudeの設定フォルダは書けないので、workerからは別のリポジトリを信頼済みにできない（workerはworkerを立てない）。`.git/config` と `.git/hooks` はClaude Codeが守る場所で、許可を足しても書けない。`git push -u` はupstreamの設定で失敗するので、workerには `git push origin HEAD` でpushさせる
- AWS・1Password・gcloud・Dockerの資格情報と、GitHub以外のsshの鍵（`*.pem`・bastionの鍵）と、guestctl（旧名spo）のブラウザのプロフィール（`~/.local/share/spo-cli`。顧客のテナントのCookieが入っている）は読めない。GitHubへのpushに使う `~/.ssh/id_rsa` とghの認証は読めるので、GitHubのAPIを宛先にした持ち出し（攻撃者のリポジトリへのコメントなど）は止まらない。ここを閉じるには、鍵を付けるプロキシかGitHubの操作の制限が要る
- pnpm（v11以降）は `$TMPDIR` を見ずに `/tmp/pnpm-*-<uid>` にロックを置くので、その4つをallowWriteに入れている
- dockerは既定・検証用のどちらでも使えない。ソケットを許すとコンテナが /Users をbind mountして外へ送れ、sandboxを丸ごと抜けるため、開けないと決めた。docker composeが要る検証は窓口か担当がsandboxの外で回す

## sandboxの外で動かす入口（`excludedCommands`）
どれも、他のコマンドと繋いだり引数に `$(...)` を埋めたりした呼び方をPreToolUseの sandbox-exclude-guard.py が止める。名前を含むだけの読むコマンド（`grep ... claude/bin/pg-sandboxed` など）も止まる。

- `claude/bin/pg-sandboxed`（検証用だけ）: Claude CodeのsandboxはSysVの共有メモリ（`shmget`）を許す設定を持たず、PostgreSQLは起動時にそれを必ず使うので、sandboxの中では起動できない。pg-sandboxed は nix-darwin のinitdb・pg_ctl を、自前のSeatbelt（denyReadの秘密は読めない・書けるのはデータのフォルダだけ・通信はlocalhostの指定のポートでの待ち受けとフォルダの中のsocketだけで、TCPの発信はできない）で囲って起こす。`COPY ... PROGRAM` や `archive_command` もこの中で動く。検証用は既定に pg-sandboxed を足しただけで、`claude/bin/pg-sandboxed_test.py` が差分をこれだけに保つ
- `claude/bin/codex-ro`: codexは ~/.codex に書き自分でもSeatbeltを張るので、中では起動できない。codex-ro が、config.toml・app・plugin・web検索を切り、コマンドを「読むだけ・通信なし・denyReadを読めない」で走らせ、promptと回答を `/tmp/claude-<uid>` の中に限る
- `claude/bin/guestctl-ro`（旧名の `claude/bin/spo-ro` も残してあり、guestctl-ro に渡す）: guestctlは顧客のテナントやワークスペースにログインしたChromeのプロフィールをまるごと使い、Chromeは環境変数のプロキシを見ないので、中では動かない。プロフィールとMicrosoft・Slackの宛先をsandboxに許すと、どのコマンドでもCookieを読んで送れるので、許さない。guestctl-ro は読む操作（sharepointのwhoami・ls・stat・cat・lists・search・items・`get -o <一時領域>`・`api GET`、teamsのchats・channels・messages、`slack file -o <一時領域>`）だけを通し、アップロード・作成・移動・削除・リストの更新・loginは断る。`get` と `slack file` の保存先は `/tmp/claude-<uid>` の中に限る
  - 外で動くguestctlとそのPythonをworkerに書き換えさせないため、`~/.local/share/uv/tools` と `~/.local/share/uv/python` は `denyWrite` にしてある（workerでは `uv tool install` と `uv python install` ができない）。`/usr/bin/python3`（XcodeのPython）はバイトコードを `~/Library/Caches/com.apple.python` から読むので、ここも `denyWrite` にしてある。書けると、外で動く codex-ro・guestctl-ro・hookのimportに任意のコードを差し込める
- `claude/bin/neon-design-review`: agyは ~/.gemini に書きGoogleに通信するので、中では起動できない。入口は、画像と product.md を `/tmp/claude-<uid>` の中に限ってlinkをたどらずに写し、dev-standards プラグインの `scripts/design-review-neon.py` を走らせ、agyを `--sandbox` とコマンド・書き込み・URL・MCPを拒否するsettingsで呼ばせる

## sandboxの中で起きること
- 1回のBashで裏に起こしたプロセスは、次のBashからはkillできない。sandboxのsignalは同じsandboxの中にしか届かず、Bashの呼び出しごとにsandboxが別になる。`pkill`・`pgrep` もsandboxの中では動かない
- PlaywrightのChromiumは `--single-process` を付けないと、自分のmachのサービスを登録できず（`bootstrap_check_in ... MachPortRendezvousServer: Permission denied`）落ちる。Claude Codeのsandboxにはこれを許す設定が無い
- sandboxからは `/tmp` の直下に書けない。allowWriteに `/private/tmp/pr-assets-*` を足しても、フォルダは作れるが中に書けなかった（2026-11-21）

## settings.worker.json のMCPと道具
- tldv・backlog・chrome-devtools など窓口でしか使わないMCPを止め、セッションごとに増えるプロセスを減らす。workerでそれらが要る作業は窓口か担当が受け持つ
- SlackのMCPはworkerでも使え、briefに書かれたスレッドをworkerが自分で読み返せる。送る・予約する・下書き・canvasとリストの作成と更新・リアクション・チャンネル作成・ファイルのアップロードの道具は `permissions.deny` で止めてある（bypassPermissionsでも止まる）。SlackのMCPに道具が増えたら、読むだけのもの以外をこのdenyに足す。顧客のSlackのMCP（slack-<顧客>）は、その顧客のリポジトリとそのworktreeでだけ起動する（`claude/mcp.projects.json`）
- effortは settings.json のmodelSettingsが決めるので付けない
- workerの1回の呼び出しに毎回入る道具の定義を減らすため、workerが使っていない道具とMCPを外してある（7日のログで呼んだ回数が0か、窓口と担当が受け持つもの）:
  - `deniedMcpServers` にxmcp・notion・beeper
  - `disableClaudeAiConnectors: true`（claude.ai のコネクタ（Gmail・Drive・Calendar・Docs・Figmaなど）を全部止める）
  - `enableArtifact: false`（artifactの公開は担当と窓口が受け持つ）
  - `permissions.deny` にAskUserQuestion（workerはcoordinatorに `orca orchestration ask` で聞く）・Workflow・ScheduleWakeup
  - 残したのはSlack（ローカルのslackのMCP）とClaude in Chrome。Notion・Gmailなどの中身が要る作業は、briefに中身を貼って渡す
- 既定の設定を直したら検証用にも同じ直しを入れる

## 止まった操作の記録
止まった操作は `~/Library/Logs/claude-sandbox/worker.jsonl` に1行ずつ残る（PostToolUseのhookの sandbox-blocked-log.py）。通信の拒否は `kinds` が `network`、ファイルとsocketの拒否は `denied`（sandbox以外の理由のOperation not permittedも入るのでcommandを見て仕分ける）。数えるときは `jq -r '.lines[]' ~/Library/Logs/claude-sandbox/worker.jsonl | sort | uniq -c | sort -rn`
