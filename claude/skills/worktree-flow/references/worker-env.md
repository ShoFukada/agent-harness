# worker の設定と sandbox

worktree-flow skill の SKILL.md から分けた細部。worker の作業が sandbox で止まったとき、worker に Codex・顧客の SharePoint・Neon を使わせる brief を書くとき、DB・dev サーバー・ブラウザ・録画で確かめる worker を立てるときに読む。sandbox が何をなぜ止めるかと、settings.worker.json を直すときの内容は agent-harness の docs/worker-sandbox.md にある。

## どの設定で立てるか
| | 既定（settings.worker.json） | 検証用（settings.worker.verify.json） |
|---|---|---|
| 使う作業 | コードを書く・テストを実行する・調べる | DB・dev サーバー・ブラウザ・録画で確かめる作業（画面の確認・E2E・demo-record・DB を使うテスト） |
| PostgreSQL | 起動できない | `claude/bin/pg-sandboxed` で起動できる（下の「PostgreSQL」） |
| dev サーバー・Playwright・ffmpeg | 使える（下の「dev サーバー」「ブラウザと録画」の決まりに従う） | 同じ |
| docker | 使えない | 使えない（docker compose が要る検証は窓口か担当が sandbox の外で実行する） |
| 秘密の読み取り・外への通信・Slack の送信 | 閉じている | 既定と同じ |

- 検証用で立てる: `orca-launch --worktree id:<worktree id> --title "<短い題>" --spec-file <brief> --settings ~/.config/nix-darwin/claude/settings.worker.verify.json`。`--settings` を付けなければ既定（`$ORCA_WORKER_SETTINGS`）になる
- brief には、使う道具の決まり（下の各節）をそのまま写す。worker はこの文書を読まない
- worker では Notion・Gmail などの MCP と claude.ai のコネクタを止めてある（使えるのは Slack の読み取りと Claude in Chrome）。それらの中身が要る作業は、brief に本文を貼って渡す
- sandbox で止まったときの決まりは、orca-launch が references/worker-rules.md を brief の先頭に足して渡す（brief に手で書かない）。止まった操作の記録の読み方は、docs/worker-sandbox.md の「止まった操作の記録」にある

## brief に書く 1 行のコマンド
どれも他のコマンドとつながず 1 行で呼ぶ（つないだり引数に `$(...)` を埋めたりすると sandbox-exclude-guard.py が止める。名前を含むだけの読み取りコマンドも止まるので、中身は Read で読む）。

### PostgreSQL（検証用だけ）
- `mkdir /tmp/claude-501/<名前>`（フォルダは sandbox の中で先に作る。pg-sandboxed は作らない）
- `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed init /tmp/claude-501/<名前>`
- `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed start /tmp/claude-501/<名前> <ポート>`
- 接続は sandbox の中から `psql -h 127.0.0.1 -p <ポート> -U postgres`（`::1` も可。認証は trust）。アプリには `postgres://postgres@127.0.0.1:<ポート>/postgres` を渡す
- 状態は `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed status /tmp/claude-501/<名前>`
- 終わったら `/Users/fukadasho/.config/agent-harness/claude/bin/pg-sandboxed stop /tmp/claude-501/<名前>`（止まるまで最大 10 秒待つ）で止め、フォルダを消す
- docker compose の DB は使えない。案件の DB が docker compose 前提なら、PostgreSQL（この Mac の nix のものは 16） を pg-sandboxed で立てて接続先を差し替えるか、窓口に返す

### Codex
- 呼び方は codex-review skill

### 顧客の SharePoint・Teams・Slack
- worker は guestctl skill を読んでも素の `guestctl` を打つので、brief には「`/Users/fukadasho/.config/agent-harness/claude/bin/guestctl-ro <sharepoint|teams|slack> <サブコマンド> '<URL>'` を、他のコマンドとつながずに 1 行で呼ぶ」と書く。通すのは読み取り操作だけで、`get` と `slack file` の保存先は `/tmp/claude-<uid>` の中に限る。呼び方の細部は guestctl-ro の先頭の説明にある
- Slack Connect で外部の組織が上げたファイルは、まず Slack の MCP の `slack_read_file` にメッセージの File ID（`F...`）を渡して読む（外部のファイルは検索に出ないが、File ID なら読めることがある）。`file_not_found` が返ったときと、Slack の MCP が入っていないワークスペースのときだけ `guestctl-ro slack file` を使う

### Neon の画面の採点（dev-standards の design-review）
- brief には「撮った画像を `/tmp/claude-<uid>` の中のフォルダに置き、`/Users/fukadasho/.config/agent-harness/claude/bin/neon-design-review <フォルダ> --kind business|lp` を他のコマンドとつながずに 1 行で呼ぶ」と書く

### Neon の日本語の仕上げ（ja-writing skill の polish.py）
- worker の sandbox の中では polish.py の agy が Google に届かず、「agy の呼び出しに失敗した」で止まる。brief には「仕上げる文章を `/tmp/claude-<uid>` の中に写し、`/Users/fukadasho/.config/agent-harness/claude/bin/neon-polish <file> --diff` を他のコマンドとつながずに 1 行で呼ぶ」と書く
- 通せる引数は `--diff`・`--audience client|internal`・`--doc-type <種類>` だけ。結果は stdout に出るので、採る部分を自分で元のファイルに反映する（リダイレクトやパイプはつなげない）

## dev サーバー（既定と検証用の両方）
- 127.0.0.1 と ::1 での listen と、そこへの curl・ブラウザの接続は通る（`allowLocalBinding`）
- 1 回の Bash でバックグラウンド起動したプロセスは、次の Bash からは kill できない。dev サーバーは Bash の `run_in_background` で起動するか、起動・確認・停止を 1 つの Bash の中で済ませる。`pkill`・`pgrep` は sandbox の中では動かない

## ブラウザと録画（既定と検証用の両方）
- Playwright の Chromium は、起動引数に `--single-process` を付ける（`chromium.launch({ args: ['--single-process'] })`、`@playwright/test` なら `use: { launchOptions: { args: ['--single-process'] } }`）。付けないと落ちる。案件の playwright.config に足すときは、sandbox の中で動くときだけ付ける（環境変数で切り替える）
- スクリーンショット・`recordVideo` の録画・ffmpeg での mp4 と GIF への書き出しは通る
- demo-record は pr-assets の作業場を `/tmp/pr-assets-<番号>` に作るが、sandbox からは `/tmp` の直下に書けない。brief に「pr-assets の作業場は `/tmp/claude-501/pr-assets-<番号>` に作る」と書く
