# workerのsandboxの仕組み

worker（settings.worker.json と settings.worker.verify.json で動くClaude Code）のsandboxが、何をなぜ許し、何をなぜ止めているかの解説。workerの立て方とbriefに書くコマンドは worktree-flow skillの references/worker-env.md にある。この文書は、設定を直すときや止まった理由を調べるときに読む。

## 目的
- workerが読んだ文に仕込まれた指示に従っても、鍵を外部の宛先に送れないようにする（2026-11から試行中）
- 止まる操作が多くて作業にならなければ、settings.worker.json の `sandbox` と、PostToolUse・PostToolUseFailureのhookを外して元に戻す

## 囲う範囲
- 囲われるのはBashのコマンドだけ。hook・MCP・WebFetch・ファイルを読み書きする道具は外で動く
- 通信できるのはGitHub・npm・PyPI・Playwrightのブラウザ配布先だけ（`strictAllowlist` なのでbypassPermissionsでも止まる）。止められたコマンドをsandboxの外でやり直すこと（`dangerouslyDisableSandbox`）もできない。orca CLIはOrcaのsocketフォルダを許可しているので使える。`orca terminal` でsandboxの外にコマンドを出せるので、ここは抜け道として残っている
- 書けるのはworktree・`$TMPDIR`・そのworktreeの元のリポジトリの `.git`（Claude Codeが自動で許可する。別のリポジトリの `.git` は書けない）・npm / uv / pnpmのキャッシュ。Claudeの設定フォルダは書けないので、workerからは別のリポジトリを信頼済みにできない（workerはworkerを立てない）。`.git/config` と `.git/hooks` はClaude Codeが守る場所で、許可を足しても書けない。`git push -u` はupstreamの設定で失敗するので、workerには `git push origin HEAD` でpushさせる
- AWS・1Password・gcloud・Dockerの資格情報、GitHub以外のssh鍵（`*.pem`・bastionの鍵）、guestctl（旧名spo）のブラウザプロフィール（`~/.local/share/spo-cli`。顧客テナントのCookieが入っている）は読めない。GitHubへのpushに使う `~/.ssh/id_rsa` とghの認証情報は読めるので、GitHubのAPIを宛先にした持ち出し（攻撃者のリポジトリへのコメントなど）は止まらない。これを止めるには、鍵を付けるプロキシかGitHub操作の制限が要る
- pnpm（v11以降）は `$TMPDIR` を参照せず `/tmp/pnpm-*-<uid>` にロックを置くので、その4つをallowWriteに入れている
- dockerは既定・検証用のどちらでも使えない。ソケットを許可すると、コンテナが /Users をbind mountして外部へ送れるようになり、sandboxを丸ごと抜けられるため、許可しないと決めた。docker composeが要る検証は窓口か担当がsandboxの外で実行する

## sandboxの外で動かす入口（`excludedCommands`）
どれも、他のコマンドとつないだり引数に `$(...)` を埋め込んだりした呼び出しは、PreToolUseの sandbox-exclude-guard.py が止める。コマンド名を含むだけの読み取りコマンド（`grep ... claude/bin/pg-sandboxed` など）も止まる。ただし名前の直後に `/` が続くもの（`neon-polish` という名前のworktreeの下のパスなど）は、入口として実行できないので止めない。

- `claude/bin/pg-sandboxed`（検証用だけ）: Claude CodeのsandboxはSysVの共有メモリ（`shmget`）を許す設定を持たず、PostgreSQLは起動時にそれを必ず使うので、sandboxの中では起動できない。pg-sandboxed は nix-darwin のinitdb・pg_ctl を、自前のSeatbelt（denyReadの秘密は読めない・書けるのはデータのフォルダだけ・通信はlocalhostの指定のポートでの待ち受けとフォルダの中のsocketだけで、TCPの発信はできない）で囲って起こす。`COPY ... PROGRAM` や `archive_command` もこの中で動く。検証用は既定に pg-sandboxed を足しただけで、`claude/bin/pg-sandboxed_test.py` が差分をこれだけに保つ
- `claude/bin/codex-ro`: codexは ~/.codex に書き自分でもSeatbeltを張るので、中では起動できない。codex-ro が、config.toml・app・plugin・web検索を切り、コマンドを「読むだけ・通信なし・denyReadを読めない」で走らせ、promptと回答を `/tmp/claude-<uid>` の中に限る
- `claude/bin/guestctl-ro`（旧名の `claude/bin/spo-ro` も残してあり、guestctl-ro に渡す）: guestctlは顧客のテナントやワークスペースにログインしたChromeのプロフィールをまるごと使い、Chromeは環境変数のプロキシを見ないので、中では動かない。プロフィールとMicrosoft・Slackの宛先をsandboxに許すと、どのコマンドでもCookieを読んで送れるので、許さない。guestctl-ro は読む操作（sharepointのwhoami・ls・stat・cat・lists・search・items・`get -o <一時領域>`・`api GET`、teamsのchats・channels・messages、`slack file -o <一時領域>`）だけを通し、アップロード・作成・移動・削除・リストの更新・loginは断る。`get` と `slack file` の保存先は `/tmp/claude-<uid>` の中に限る
  - 外で動くguestctlとそのPythonをworkerに書き換えさせないため、`~/.local/share/uv/tools` と `~/.local/share/uv/python` は `denyWrite` にしてある（workerでは `uv tool install` と `uv python install` ができない）。`/usr/bin/python3`（XcodeのPython）はバイトコードを `~/Library/Caches/com.apple.python` から読むので、ここも `denyWrite` にしてある。書けると、外で動く codex-ro・guestctl-ro・hookのimportに任意のコードを差し込める
- `claude/bin/neon-design-review`: agyは ~/.gemini に書きGoogleに通信するので、中では起動できない。入口は、画像と product.md を `/tmp/claude-<uid>` の中に限ってリンクをたどらずにコピーし、dev-standards プラグインの `scripts/design-review-neon.py` を走らせ、コマンド・書き込み・URL・MCPを拒否するsettingsと `--sandbox` でagyを呼ばせる
- `claude/bin/neon-polish`: 日本語の仕上げ（ja-writing skillの polish.py）もagyを使うので、中では動かない。入口は、文章を `/tmp/claude-<uid>` の中に限ってリンクをたどらずに1回だけ読み込み、読んだ本文を隣の `../skills/ja-writing/polish.py` に渡す（走らせるスクリプトは引数で受けず、通す引数は `--diff`・`--audience`・`--doc-type` だけ）。仕上げの後に yomiyasu_diff へ渡す一時ファイルは、workerが書けない利用者の一時フォルダ（/var/folders/…/T）に作る。workerの `$TMPDIR` に作ると、書く前にlinkへ差し替えられ、外の権限で任意のファイルを上書きさせられるため。agyには `--sandbox` と、コマンド・書き込み・ファイルとURLの読み取り・MCPを拒否し、workerのdenyReadも名指しで拒否するsettingsを渡す。窓口や担当が polish.py を直に呼ぶときも、ja-review hookの書き直しも、同じく道具を拒否する（`agy_launch.text_only_args`）

## sandboxの中で起きること
- 1回のBashでバックグラウンドで起動したプロセスは、次のBashからはkillできない。sandboxのsignalは同じsandboxの中にしか届かず、Bashの呼び出しごとにsandboxが別になる。`pkill`・`pgrep` もsandboxの中では動かない
- PlaywrightのChromiumは `--single-process` を付けないと、自身のmachサービスを登録できずに落ちる（`bootstrap_check_in ... MachPortRendezvousServer: Permission denied`）。Claude Codeのsandboxにはこれを許可する設定がない
- sandboxからは `/tmp` の直下に書き込めない。allowWriteに `/private/tmp/pr-assets-*` を足しても、フォルダは作れるが中には書き込めなかった（2026-11-21）

## settings.worker.json のMCPと道具
- tldv・backlog・chrome-devtools など窓口でしか使わないMCPを止め、セッションごとに増えるプロセスを減らす。workerでそれらが要る作業は窓口か担当が受け持つ
- SlackのMCPはworkerでも使え、briefに書かれたスレッドをworkerが自分で読み返せる。送信・予約・下書き・canvasとリストの作成と更新・リアクション・チャンネル作成・ファイルアップロードの道具は `permissions.deny` で止めてある（bypassPermissionsでも止まる）。SlackのMCPに道具が増えたら、読むだけのもの以外をこのdenyに足す。顧客のSlackのMCP（slack-<顧客>）は、その顧客のリポジトリとそのworktreeでだけ起動する（`claude/mcp.projects.json`）
- effortは settings.json のmodelSettingsで決まるため、設定しない
- workerの1回の呼び出しごとに含まれる道具の定義を減らすため、workerが使っていない道具とMCPを外してある（7日のログで呼んだ回数が0か、窓口と担当が受け持つもの）:
  - `deniedMcpServers` にxmcp・notion・beeper
  - `disableClaudeAiConnectors: true`（claude.ai のコネクタ（Gmail・Drive・Calendar・Docs・Figmaなど）を全部止める）
  - `enableArtifact: false`（artifactの公開は担当と窓口が受け持つ）
  - `permissions.deny` にAskUserQuestion（workerはcoordinatorに `orca orchestration ask` で聞く）・Workflow・ScheduleWakeup
  - 残したのはSlack（ローカルのslackのMCP）とClaude in Chrome。Notion・Gmailなどの内容が要る作業は、briefに貼って渡す
- 既定の設定を直したら、検証用の設定にも同じ修正を入れる

## 止まった操作の記録
止まった操作は `~/Library/Logs/claude-sandbox/worker.jsonl` に1行ずつ残る（PostToolUseのhookの sandbox-blocked-log.py）。通信の拒否は `kinds` が `network`、ファイルとsocketの拒否は `denied`（sandbox以外の理由のOperation not permittedも入るのでcommandを見て仕分ける）。数えるときは `jq -r '.lines[]' ~/Library/Logs/claude-sandbox/worker.jsonl | sort | uniq -c | sort -rn`
