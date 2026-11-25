---
name: worktree-flow
description: Orca の worktree でコードを書く作業の進め方。コードを書く作業を始めるとき、worker や担当を立てる・引き継ぐ・マージするときに使う。コマンドの細部（orca-cli・orchestration）とマージ済みブランチの掃除（tidy-branches）には使わない。
---

# 読む順
この本体は毎回要る流れだけを持つ。細部は同じフォルダの references/ にあり、次の場面で読む。

| 場面 | 読むもの |
|---|---|
| worktree を作った直後に .env・node_modules をそろえる | [references/setup.md](references/setup.md) |
| 担当を立てる、`orca-launch` が確認の画面で止まった、brief を書く、Orca のプラグインを触る worker を立てる | [references/launch.md](references/launch.md) |
| 知らせを送る、coordinator として知らせを受けた・読み逃した | [references/notify.md](references/notify.md) |
| 差分を見せる、完了を報告する、マージ・片付けをする | [references/merge.md](references/merge.md) |
| どの worker にも渡す決まり（brief の先頭に orca-launch が足す文）を直す | [references/worker-rules.md](references/worker-rules.md) |
| worker の作業が sandbox で止まった、worker に Codex・顧客の SharePoint・Neon を使わせる、DB・ブラウザ・録画で確かめる worker（検証用）を立てる、settings.worker.json を直す | [references/worker-env.md](references/worker-env.md) |
| サイドバーの表示名・題・状態をそろえる | [references/sidebar.md](references/sidebar.md) |
| 依存する複数の PR を stack に積む | [references/stack.md](references/stack.md) |

# 前提
worktree の状態は Orca アプリが持つものを基準にする。人間は Orca の左サイドバーで repo ごとに worktree カードが並ぶのを見ていて、各カードに表示名・comment・status・走っているエージェントの状態が出る。差分も Orca のエディタで見る。worktree は増えるほど人間の視界を圧迫するので、数・名前・寿命を人間が追える状態に保つ（references/sidebar.md）。

リポジトリのルートは default ブランチ（main）に固定する。ルートで `git switch -c` や `git checkout <branch>` をしない。ルートで行うのは fetch / pull と全体の閲覧、および main に直接コミットしてよい類の変更（dotfiles の設定更新など）だけ。生の `git worktree add` と Claude Code の EnterWorktree / ExitWorktree は使わない（Orca のサイドバーに出ない checkout が増える）。

worker の起動・指示・知らせ・停止の検知は Orca の orchestration（Run・Task・Dispatch）に載せる。自前の一覧や見張りのスクリプトは持たない。

# 作る
- 作る前に、PR が何本になるかと、PR 同士の依存を決める。1 つの機能が複数の PR に分かれ、後の PR が前の PR のコードに依存するなら、main から PR ごとに worktree を切らず、1 つの stack にする（references/stack.md）。依存しない部分だけを別の worktree・別の stack に分けて並列にする
- あわせて `gh pr list` で open の PR を見る。新しい作業がどれかの PR のコードに依存する、または同じ箇所を触って衝突が見えているなら、その PR の上に積む
- 作る前にルートで `git fetch` する。base は既定でリポジトリの default base（`origin/<default>`）。ローカルの default ブランチが origin より先行しているリポジトリでは `--base-branch <default>` を明示する
- `orca worktree create --repo id:<repoId> --name <slug> --parent-worktree <立てる人の worktree> --json`。checkout は `~/orca/workspaces/<repo>/<name>/`、ブランチは `<git-username>/<name>` になる。立てる人（窓口か担当）の worktree の子にする（窓口 → 担当 → worker の順に並ぶ）。無関係な作業だけ `--no-parent` を付ける。別のリポジトリ（dev-standards など）に worker の worktree を作るときも、立てる人の worktree を `--parent-worktree` に指定する（親が無いと、夜の定期確認（bin/worktree-sweep）が終わった記録と結べず、取り込み後も残る）
- 親子の記録と base は別。親のコードの上で試す子 worktree は、`--base-branch` に親の commit を指定する（省くと default base から切られる）。親の未コミットの変更は入らないので、先に commit する
- `--name` は ASCII の slug（ブランチ名になる）。人間が見る名前は表示名で、worker を立てるときに `orca-launch` が付ける（references/sidebar.md）。`agent-<乱数>` のような自動生成名を人間が見る worktree に残さない
- 人間にすぐ見せるなら `--activate`。裏で並列に走らせるなら付けない
- gitignore されていて worktree に付いてこないもの（.env・node_modules など）を references/setup.md の手順でそろえる

# 窓口・担当・worker
worktree の中身を書くのは、その worktree のターミナルで走るエージェント。カードの「エージェント作業中」表示はターミナルの所属で決まるので、窓口のターミナルから他 worktree のファイルを編集すると（サブエージェント経由でも同じ）、人間からは誰も働いていない worktree の差分だけが動いて見える。まとまった編集は worker に流す。レビュー中の数行の手直しまでは窓口から直してよい。

役は 3 つ。誰が誰の coordinator（Orca の Run を持ち、知らせで起こされる役）になるかで分ける。

| 役 | 何をするか | 立て方 | coordinator |
|---|---|---|---|
| 窓口 | 深田の窓口と操縦席。依頼を受け、担当を立てるか自分で片付ける | ワークスペースのメイン（深田が開く） | 担当と、自分で立てた worker の coordinator |
| 担当 | 1 つの仕事を終わりまで受け持つ。深田と直接話し、自分の worker を立てて結果を確かめ、窓口に返す | 窓口が `orca-launch --lead` で Orca のチャットに立てる（references/launch.md） | 自分の worker の coordinator。自分は窓口の worker |
| worker | 1 つの worktree でコードを書く | 窓口か担当が `orca-launch` で立てる | なし（coordinator に worker_done・ask で返す） |

- 1 日を超える仕事と、顧客向けに深田と一緒に作る仕事には担当を立てる。小さい依頼は窓口が片付ける（自分で直すか、worker を 1 本立てる）。操縦席のある窓口は、先に仕事の形を決めてタスクを帳簿に書き、`orca-launch --cockpit-task` で立てる（`--title` だけの起動は道具が断る）。一緒に作る仕事（`cowork`）の作業は、worker を立てずに担当へ `send` で渡す
- 担当は仕事が終わるまで残り、worker とは寿命を分ける。worker は 1 つの worktree・1 つの Task ごとに立てて畳む
- 1 つの worktree に worker は 1 人
- 同時に動かす worker は、窓口と担当の配下を合わせて上限の中に収める。上限の数は compaction-keep.py の `WORKER_LIMIT` だけが持ち、`~/.claude/hooks/compaction-keep.py slots <窓口の root>` の見出しに出る（開始・再開と圧縮のあとには hook も出す）。slots が作業中に数えるのは操縦席のタスクに結んだ worker だけなので、担当の配下で動く worker（`orca orchestration worker-list`）は足して数える。全部の席が利用枠の上限のあいだは、空き枠があっても立てない（references/notify.md の「利用枠の上限に当たったとき」）
- 同じ成果物を作る worker がいれば新しく立てずにそこへ `send` で送る。方針が変わったら、動いている worker と担当の全員に `send` で伝える

## worker を立てる（窓口か担当）
```bash
orca worktree create --repo id:<repoId> --name <slug> --parent-worktree <立てる人の worktree> --json
orca-launch --worktree id:<worktree id> --cockpit-task <操縦席のタスクの id> --spec-file <brief>   # 操縦席のあるワークスペースの窓口
orca-launch --worktree id:<worktree id> --title "<短い題>" --spec-file <brief> --run <担当の Run>   # 担当
orca-launch --worktree id:<worktree id> --title "<短い題>" --spec-file <brief>           # 操縦席の無いところ
orca-launch --worktree id:<worktree id> --title "<短い題>" --spec-file <brief> --settings ~/.config/nix-darwin/claude/settings.worker.verify.json   # 検証用（DB・dev サーバー・ブラウザ・録画）
orca-launch --worktree id:<worktree id> --title "<短い題>" --spec-file <brief> --agent codex -- <codex の引数>
```
- 担当が立てるときは、`orca-launch` に `--run <担当の Run>`（担当が仕事を始めたときに作った Run。roles/lead.md）を付ける。表示名は `--title "<タスクの題>"` で付ける。worker の worktree の親は、作ったときの記録を使い、無ければ `orca-launch` が立てる人の worktree（`$ORCA_WORKTREE_ID`）にする（`orca worktree create` は、Orca の環境変数か cwd から立てる人の worktree を親に推定する。別のリポジトリでも付く）
- 操縦席のあるワークスペースの窓口は `--cockpit-task` で立てる。表示名・comment・親の worktree を操縦席のタスクと仕事からそろえる（references/sidebar.md）。`orca-launch` がまだ `--cockpit-task` を受けない間は `--title "<タスクの題>"` で立て、comment を手でそろえる
- `orca-launch` は、worker 用の設定で claude（か codex）を起こした端末を作り、表示名・状態・親をそろえ、入力待ちを待って brief を Task として渡す。表示名が上限（references/sidebar.md）を超えるときは何も起こさずに断るので、題を短くして打ち直す（中でしていることと出力は references/launch.md の「orca-launch がすること」）
- どの worker にも渡す決まり（操縦席を書かない・sandbox で止まったら・途中経過を送らない・従量課金の LLM の許可）は、`orca-launch` が references/worker-rules.md を brief の先頭に足す。brief に手で書かない（文言を直すときは worker-rules.md だけを直す）
- 確認の画面（初めてのリポジトリの信頼の確認など）や時間切れで止まったら、Task を渡さずに exit 非 0 で止まる。片付け方は references/launch.md の「確認の画面で止まったとき」
- `orca orchestration worker-start --agent claude` で worker を立てない。起動コマンドを指定できず、worker 用の設定（sandbox）が付かない
- 立てたら、そのターンを終える。worker_done・質問・停止は Orca が coordinator を起こして知らせる（下）
- 操縦席のあるワークスペースでは、brief にそのタスクの依頼の完了条件（依頼の id・番号・本文。例「r30 の 2: before/after のページを公開する」）を入れる。`orca-launch --cockpit-task` は自動で brief の末尾に足す。worker_done が来たら、worker の報告の「仮定」からではなく、完了条件を起点に証拠（commit・URL・出力）を照合する。条件を変えて済ませたものはそのまま取り込まず、判断のカードに回す（cockpit skill の「受付と仕分け」）
- brief の書き方（文脈の圧縮・所有の 1 文）は references/launch.md の「brief の書き方」、worker 用の設定と検証用は同じファイルの「worker の設定」、Orca のプラグインを触る worker の決まりは「Orca のプラグインを触る worker」

## 担当を立てる・知らせ
- 担当の立て方（brief・`worker-start` のコマンド・続きの渡し方）は references/launch.md の「担当を立てる（窓口）」
- 知らせは `orca orchestration send` の 1 本にそろえる（R191）。宛先ごとの `--to`・送り主・`orca terminal send` を使う例外は references/notify.md の「知らせの経路」、届いた `worker_done`・`question`・`escalation` への対応は同じファイルの「知らせを受ける（coordinator）」
- 知らせは Orca に起こされて受ける。見張りのスクリプト・`check` の繰り返し・`terminal read` のポーリングはしない

## 担当と窓口のやり取り
- 担当と worker は、途中経過を coordinator（窓口か担当）に送らない。送ってよい 4 つは references/worker-rules.md が持ち、worker には orca-launch がそのファイルを brief の先頭に足して渡す。途中経過のたびに窓口が起こされ、深田の発言と次にやることが埋もれた（R184）。ほかの文書はここを指す
- 担当は仕事ごとに自分の Run を作り（`orca orchestration run-create`）、その coordinator になる（入れ子の coordinator）
- 担当から窓口へ: 仕事の結果は `worker_done`（worker の報告は要約し直さずに添え、自分で確かめた結果を分けて書く）。深田の判断が要るときは `orca orchestration send --to run:<窓口の Run> --type status --subject "判断: <題>" --body-file <選択肢とおすすめ>`
- 窓口から担当へ: 答えも続きの仕事も `orca orchestration send --to dispatch:<担当の今の Dispatch の id>` で送る
- 担当は `ask` を使わず、窓口は担当に `reply` しない。入れ子の coordinator には `reply` が届かず、質問が開いたまま残る（`send --to dispatch:` は担当の Run の受信箱に回されて届く）
- 深田が担当のチャットで直接答えたときは、担当が窓口に「判断 <題> は深田さんがチャットで答えた（答えの原文）」と send し、窓口が操縦席の判断のカードを閉じる。深田の判断待ちを出すのは操縦席の窓の 1 か所にする

## サイドバーの出し方
人間はサイドバーの名前・状態・印で仕事を追う。worker と担当を立てる・終えるたびに、references/sidebar.md の形にそろえる。取り込み済み・使い終わった worktree を残さない（ベルの印が残り、人間の視界を埋める）。

# stack に積む
依存する複数の PR は、1 つの stack を 1 つの worktree・1 人の worker で下の層から順に作る。層ごとに worktree や worker を分けて並列にしない。手順は references/stack.md、コマンドは gh-stack skill。

# 見せる・マージする・片付ける
手順は references/merge.md。毎回守るのは次の 3 つ。
- マージは人間の承認を待つのが既定。worker が完遂したら worktree を in-review・`--unread` にし、diff を開いて報告し、そこで止まる
- 完了報告は、要約より先に「確かめたコマンドとその出力」を置き、「決めたこと・置いた仮定」の一覧を付ける
- マージは、検証とレビューを済ませた commit の SHA を控えて `git merge --ff-only <その SHA>` で行い、取り込んだ worktree は消す（references/cleanup.md）
