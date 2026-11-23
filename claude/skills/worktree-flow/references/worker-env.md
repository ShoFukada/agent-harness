# worker の設定と sandbox

worktree-flow skill の SKILL.md から分けた細部。worker の作業が sandbox で止まったとき、worker に MCP・Codex・顧客の SharePoint・Neon を使わせる brief を書くとき、DB・dev サーバー・ブラウザ・録画で確かめる worker を立てるとき、settings.worker.json を直すときに読む。

## 既定と検証用の 2 種類
| | 既定（settings.worker.json） | 検証用（settings.worker.verify.json） |
|---|---|---|
| 使う作業 | コードを書く・テストを流す・調べる | DB・dev サーバー・ブラウザ・録画で確かめる作業（画面の確認・E2E・demo-record・DB を使うテスト） |
| PostgreSQL | 起動できない | `claude/bin/pg-sandboxed` で起動できる（下の「PostgreSQL」） |
| dev サーバー・Playwright・ffmpeg | 使える（下の「dev サーバー」「ブラウザ」の決まりで） | 同じ |
| docker | 使えない | 使えない（ソケットを許すとコンテナが /Users を bind mount して外へ送れ、sandbox を丸ごと抜けるため。開けないと決めた。docker compose が要る検証は窓口か担当が sandbox の外で回す） |
| 秘密の読み取り・外への通信・Slack の送信 | 閉じている | 既定と同じ |

- 検証用は既定に pg-sandboxed を足しただけで、ほかは同じ（`claude/bin/pg-sandboxed_test.py` が差分をこれだけに保つ）。既定の設定を直したら検証用にも同じ直しを入れる
- 検証用で立てる: `orca-launch --worktree id:<worktree id> --title "<短い題>" --spec-file <brief> --settings ~/.config/nix-darwin/claude/settings.worker.verify.json`。`--settings` を付けなければ既定（`$ORCA_WORKER_SETTINGS`）になる
- brief には、使う道具の決まり（下の「PostgreSQL」「dev サーバー」「ブラウザ」）をそのまま写す。worker はこの文書を読まない

## PostgreSQL（検証用だけ）
- Claude Code の sandbox は SysV の共有メモリ（`shmget`）を許す設定を持たず、PostgreSQL は起動時にそれを必ず使うので、sandbox の中では起動できない。そこで `claude/bin/pg-sandboxed` だけを sandbox の外で動かす（`excludedCommands`）。pg-sandboxed は nix-darwin の initdb・pg_ctl を、自前の Seatbelt（denyRead の秘密は読めない・書けるのはデータのフォルダだけ・通信は localhost の指定のポートでの待ち受けとフォルダの中の socket だけで、TCP の発信はできない）で囲って起こす。`COPY ... PROGRAM` や `archive_command` もこの囲いの中で動く
- brief に書く呼び方（各行を他のコマンドと繋がず 1 行で呼ぶ。繋ぐと sandbox-exclude-guard.py が止める）:
  - `mkdir /tmp/claude-501/<名前>`（フォルダは sandbox の中で先に作る。pg-sandboxed は作らない）
  - `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed init /tmp/claude-501/<名前>`
  - `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed start /tmp/claude-501/<名前> <ポート>`
  - 接続は sandbox の中から `psql -h 127.0.0.1 -p <ポート> -U postgres`（`::1` も可。認証は trust）。アプリには `postgres://postgres@127.0.0.1:<ポート>/postgres` を渡す
  - 状態は `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed status /tmp/claude-501/<名前>`
  - 終わったら `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed stop /tmp/claude-501/<名前>`（止まるまで最大 10 秒待つ）で止め、フォルダを消す
- docker compose の DB は使えない。案件の DB が docker compose 前提なら、PostgreSQL（この Mac の nix のものは 16） を pg-sandboxed で立てて接続先を差し替えるか、窓口に返す

## dev サーバー（既定と検証用の両方）
- 127.0.0.1 と ::1 での listen と、そこへの curl・ブラウザの接続は通る（`allowLocalBinding`）
- 1 回の Bash で裏に起こしたプロセスは、次の Bash からは kill できない（sandbox の signal は同じ sandbox の中にしか届かず、Bash の呼び出しごとに sandbox が別になる）。dev サーバーは Bash の `run_in_background` で起こすか、起動・確認・停止を 1 つの Bash の中で済ませる。`pkill`・`pgrep` は sandbox の中では動かない

## ブラウザと録画（既定と検証用の両方）
- Playwright の Chromium は、起動引数に `--single-process` を付ける（`chromium.launch({ args: ['--single-process'] })`、`@playwright/test` なら `use: { launchOptions: { args: ['--single-process'] } }`）。付けないと Chromium が自分の mach のサービスを登録できず（`bootstrap_check_in ... MachPortRendezvousServer: Permission denied`）落ちる。Claude Code の sandbox にはこれを許す設定が無い。案件の playwright.config に足すときは、sandbox の中で動くときだけ付ける（環境変数で切り替える）
- スクリーンショット・`recordVideo` の録画・ffmpeg での mp4 と GIF への書き出しは通る
- demo-record は pr-assets の作業場を `/tmp/pr-assets-<番号>` に作るが、sandbox からは `/tmp` の直下に書けない。brief に「pr-assets の作業場は `/tmp/claude-501/pr-assets-<番号>` に作る」と書く（allowWrite に `/private/tmp/pr-assets-*` を足しても、フォルダは作れるが中に書けなかった。2026-11-21）

## settings.worker.json
- settings.worker.json は tldv・backlog・chrome-devtools など窓口でしか使わない MCP を止め、セッションごとに増えるプロセスを減らす。worker でそれらが要る作業は窓口か担当が受け持つ。Slack の MCP は worker でも使え、brief に書かれたスレッドを worker が自分で読み返せる。送る・予約する・下書き・canvas とリストの作成と更新・リアクション・チャンネル作成・ファイルのアップロードの道具は `permissions.deny` で止めてある（bypassPermissions でも止まる）。Slack の MCP に道具が増えたら、読むだけのもの以外をこの deny に足す。顧客の Slack の MCP（slack-<顧客>）は、その顧客のリポジトリとその worktree でだけ起動する（`claude/mcp.projects.json`）。effort は settings.json の modelSettings が決めるので付けない
- worker の 1 回の呼び出しに毎回入る道具の定義を減らすため、worker が使っていない道具と MCP を外してある（7 日のログで呼んだ回数が 0 か、窓口と担当が受け持つもの）:
  - `deniedMcpServers` に xmcp・notion・beeper
  - `disableClaudeAiConnectors: true`（claude.ai のコネクタ（Gmail・Drive・Calendar・Docs・Figma など）を全部止める）
  - `enableArtifact: false`（artifact の公開は担当と窓口が受け持つ）
  - `permissions.deny` に AskUserQuestion（worker は coordinator に `orca orchestration ask` で聞く）・Workflow・ScheduleWakeup
  - 残したのは Slack（ローカルの slack の MCP）と Claude in Chrome。Notion・Gmail などの中身が要る作業は、brief に中身を貼って渡す

## sandbox
- settings.worker.json は Claude Code の sandbox を有効にしている（2026-11 から試行中）。worker が読んだ文に仕込まれた指示に従っても、鍵を外の宛先に送れないようにするため
- 囲われるのは Bash のコマンドだけ。hook・MCP・WebFetch・ファイルを読み書きする道具は外で動く
- 通信できるのは GitHub・npm・PyPI・Playwright のブラウザの配布先だけ（`strictAllowlist` なので bypassPermissions でも止まる）。止められたコマンドを sandbox の外でやり直すこと（`dangerouslyDisableSandbox`）もできない。orca CLI は Orca の socket のフォルダを許可しているので使える。`orca terminal` で sandbox の外にコマンドを出せるので、ここは抜け道として残っている
- 書けるのは worktree・`$TMPDIR`・その worktree の元のリポジトリの `.git`（Claude Code が自動で許可する。別のリポジトリの `.git` は書けない）・npm / uv / pnpm のキャッシュ。Claude の設定フォルダは書けないので、worker からは別のリポジトリを信頼済みにできない（worker は worker を立てない）。`.git/config` と `.git/hooks` は Claude Code が守る場所で、許可を足しても書けない。`git push -u` は upstream の設定で失敗するので、worker には `git push origin HEAD` で push させる
- AWS・1Password・gcloud・Docker の資格情報と、GitHub 以外の ssh の鍵（`*.pem`・bastion の鍵）と、guestctl（旧名 spo）のブラウザのプロフィール（`~/.local/share/spo-cli`。顧客のテナントの Cookie が入っている）は読めない。GitHub への push に使う `~/.ssh/id_rsa` と gh の認証は読めるので、GitHub の API を宛先にした持ち出し（攻撃者のリポジトリへのコメントなど）は止まらない。ここを閉じるには、鍵を付けるプロキシか GitHub の操作の制限が要る
- Codex は `claude/bin/codex-ro` だけを sandbox の外で動かす（`excludedCommands`）。codex は ~/.codex に書き自分でも Seatbelt を張るので、中では起動できない。代わりに codex-ro が、config.toml・app・plugin・web 検索を切り、コマンドを「読むだけ・通信なし・denyRead を読めない」で走らせ、prompt と回答を `/tmp/claude-<uid>` の中に限る。呼び方は codex-review skill
- 顧客の SharePoint・Teams・Slack は `claude/bin/guestctl-ro` だけを sandbox の外で動かして読む（`excludedCommands`）。guestctl は顧客のテナントやワークスペースにログインした Chrome のプロフィールをまるごと使い、Chrome は環境変数のプロキシを見ないので、中では動かない。プロフィールと Microsoft・Slack の宛先を sandbox に許すと、どのコマンドでも Cookie を読んで送れるので、許さない。guestctl-ro は読む操作（sharepoint の whoami・ls・stat・cat・lists・search・items・`get -o <一時領域>`・`api GET`、teams の chats・channels・messages、`slack file -o <一時領域>`）だけを通し、アップロード・作成・移動・削除・リストの更新・login は断る。`get` と `slack file` の保存先は `/tmp/claude-<uid>` の中に限る。Slack Connect で外部の組織が上げたファイルは、まず Slack の MCP の `slack_read_file` にメッセージの File ID（`F...`）を渡して読む（外部のファイルは検索に出ないが、File ID なら読めることがある。2026-11-21 に Slack Connect の相手が上げた画像を読めた）。`file_not_found` が返ったときと、Slack の MCP が入っていないワークスペースのときだけ `guestctl-ro slack file` を使う。旧名の `claude/bin/spo-ro` も残してあり、`spo-ro <SharePoint のコマンド>`・`spo-ro teams ...` を guestctl-ro に渡す。外で動く guestctl とその Python を worker に書き換えさせないため、`~/.local/share/uv/tools` と `~/.local/share/uv/python` は `denyWrite` にしてある（worker では `uv tool install` と `uv python install` ができない）。`/usr/bin/python3`（Xcode の Python）はバイトコードを `~/Library/Caches/com.apple.python` から読むので、ここも `denyWrite` にしてある。書けると、外で動く codex-ro・guestctl-ro・hook の import に任意のコードを差し込める。呼び方は guestctl-ro の先頭の説明にある。worker は guestctl skill を読んでも素の `guestctl` を打つので、SharePoint・Teams・Slack を読ませる brief には「`/Users/fukadasho/.config/agent-harness/claude/bin/guestctl-ro <sharepoint|teams|slack> <サブコマンド> '<URL>'` を、他のコマンドと繋がずに 1 行で呼ぶ」と書く
- Neon の画面の採点（dev-standards の design-review）は `claude/bin/neon-design-review` だけを sandbox の外で動かす（`excludedCommands`）。agy は ~/.gemini に書き Google に通信するので、中では起動できない。入口は、画像と product.md を `/tmp/claude-<uid>` の中に限って link をたどらずに写し、プラグインの置き場の `scripts/design-review-neon.py` を走らせ、agy を `--sandbox` とコマンド・書き込み・URL・MCP を拒否する settings で呼ばせる。brief には「撮った画像を `/tmp/claude-<uid>` の中のフォルダに置き、`/Users/fukadasho/.config/agent-harness/claude/bin/neon-design-review <フォルダ> --kind business|lp` を他のコマンドと繋がずに 1 行で呼ぶ」と書く
- codex-ro・neon-design-review・pg-sandboxed と guestctl-ro（旧名の spo-ro も）を他のコマンドと繋いだり、引数に `$(...)` を埋めたりした呼び方は、PreToolUse の sandbox-exclude-guard.py が止める。名前を含むだけの読むコマンド（`grep ... claude/bin/pg-sandboxed` など）も止まるので、中身は Read で読む
- pnpm（v11 以降）は `$TMPDIR` を見ずに `/tmp/pnpm-*-<uid>` にロックを置くので、その 4 つを allowWrite に入れている
- sandbox で止まったときの決まりは、orca-launch が references/worker-rules.md を brief の先頭に足して渡す（brief に手で書かない）
- 止まった操作は `~/Library/Logs/claude-sandbox/worker.jsonl` に 1 行ずつ残る（PostToolUse の hook の sandbox-blocked-log.py）。通信の拒否は `kinds` が `network`、ファイルと socket の拒否は `denied`（sandbox 以外の理由の Operation not permitted も入るので command を見て仕分ける）。数えるときは `jq -r '.lines[]' ~/Library/Logs/claude-sandbox/worker.jsonl | sort | uniq -c | sort -rn`
- 止まる操作が多くて作業にならなければ、settings.worker.json の `sandbox` と、PostToolUse・PostToolUseFailure の hook を外して戻す
