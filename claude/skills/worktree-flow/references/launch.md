# worker を立てるときの細部

worktree-flow skill の SKILL.md から分けた細部。`orca-launch` が確認の画面や時間切れで止まったとき、担当を立てるとき、brief に所有の 1 文を入れるか迷うとき、Orca のプラグインを触る worker を立てるときに読む。

## orca-launch がすること
- `orca-launch`（`~/.config/agent-harness/bin/orca-launch`、`~/.local/bin` に symlink）は次を 1 回でする。最後に `runId`・`taskId`・`dispatchId`・`terminal` を JSON で出す
- 端末を「作業｜<短い題>」の題で作り、`env CLAUDE_CONFIG_DIR=<Orcaで今選ばれている席のhome> claude --model opus --settings $ORCA_WORKER_SETTINGS` で起動する。`$ORCA_WORKER_SETTINGS` は home.nix が settings.worker.json を指す。`--settings <ファイル>` を渡すとそれで起動する（DB・dev サーバー・ブラウザ・録画で確かめる worker は `--settings ~/.config/nix-darwin/claude/settings.worker.verify.json`。違いは references/worker-env.md の「既定と検証用の 2 種類」）
- 表示名「作業｜<短い題>」が上限を超えたら、何も起こさずに exit 非 0 で断る。頭の語と上限は操縦席の state.ts の `WORKER_HEAD`・`NAME_MAX` から読む（値の文書の置き場所は references/sidebar.md）
- worktree の表示名を「作業｜<短い題>」、状態を in-progress にする（呼んだエージェントと同じ worktree に立てるときは変えない）。親は、`--cockpit-task` なら仕事の担当（いなければ窓口）、ほかは作ったときの記録、無ければ立てる人の worktree（`$ORCA_WORKTREE_ID`）
- brief の先頭に references/worker-rules.md を足す（brief に既に入っていれば足さない。ファイルが読めなければ立てずに断る）
- 入力待ちになるのを待ち、`orca orchestration worker-start --spec-file <brief> --terminal <handle>` で brief を Task として渡す
- 席は`orca account list --agent claude`で読む。システムの既定のログインが選ばれていれば`CLAUDE_CONFIG_DIR`を付けず、Orcaが読めなければ呼んだエージェントの値を使う。入力待ちになった時点で席を読み直し、起動の途中で席が切り替わっていたら、Taskを渡さずに端末を閉じて止まる（その端末はOrcaの起動し直しに入らず古い席に残るため）。同じ`orca-launch`を打ち直す
- `--cockpit-task <タスクの id>` のときは、ワークスペースの cockpit.json から、そのタスクを `tasks[]` に持つ依頼の済の条件（依頼の id・番号・本文）を brief の末尾に足して渡す。brief に手で書いた済の条件と食い違ったら、cockpit.json の側を正とする

## 確認の画面で止まったとき
- 確認の画面で止まったら、Task を渡さずに exit 非 0 で止め、端末の handle・理由・渡すためのコマンド（呼んだときの `--run` などを含む）を出す。Task も Dispatch もまだ無いので、Orca の escalation は来ない。呼んだエージェントがその場で片付ける（Orca も確認の画面の端末には Task を送らない。送ると指示の文字が「No, exit」を選び、worker が閉じることがあった）
- よく出るのは、そのリポジトリで初めて claude を起こすときの信頼の確認（信頼はリポジトリの本体のパスに付くので、同じリポジトリの別の worktree では出ない）。`orca terminal read --terminal <handle> --screen` で並びを読み、深田に答えてもらうか、窓口が「Yes, I trust this folder」を選んでから、出てきたコマンドで渡す。並びは「No, exit」が上のことがあるので、番号で選ばない。信頼を `.claude.json` に先に書くことはしない（動いている claude も書き換え、排他できないので、ほかの項目の更新を消す）
- 入力待ちにならずに時間切れになったときも同じ。渡さないなら `orca terminal close --terminal <handle>` で閉じ、worktree を片付ける

- `worker-start --agent` で立てた担当が信頼の確認で止まったときは、Task を送らずに coordinator へ escalation（never started など）が来る。`orca-launch` で立てる worker は、確認の画面では Task を渡す前に止まるので来ない

## 担当を立てる（窓口）
- brief をファイルに書く。深田の言葉は要約し直さず、決めた経緯とあわせて原文を引用で入れる（間に担当を挟むと文脈が落ちるので、ここで落とさない）。先頭に「`~/.config/nix-darwin/claude/roles/lead.md` を読み、その役割に従う」と書く
- 先に操縦席の仕事（`streams[]`）と形（`form` の `delegate` か `cowork`）を書いておく。担当は仕事を受け持つ（タスクではない）
- 立てる（窓口のワークスペースの root から）:
  ```bash
  orca-launch --lead <仕事の id> --name <slug>-lead --spec-file <brief>
  ```
  - 道具が、窓口の子の worktree（new-child）に Orca のチャットで担当を立て、表示名とチャットの題を「<形>｜<仕事の題>」にする（頭は仕事の形から。references/sidebar.md の仕事の行）。形を手で打たない（2026-11-25 に、任せる仕事に「一緒に｜」の担当がいた）。形の無い仕事・見張る仕事には立てない。担当の立て直し（`--replace`）と、形を変えながら立てる（`--form`）ときの書き方は cockpit skill の references/workers.md
  - 担当は窓口の子の worktree（担当の居場所。commit はしない）に立つ。窓口と同じ worktree に立てると、窓口用の hook が担当をメインと見なす。理由と、アカウント・チャットの題の細部は references/launch.md の「担当を立てるときの細部」
  - 道具が出した担当の行（`owner`。session と受け取りの `worker` を持つ）を、そのまま操縦席の `owners[]` に、立てた直後の 1 回の書き込みで書く。タスクの `worker` には書かない（書く欄は cockpit skill の references/workers.md）
- 続きの仕事を渡す: `orca orchestration send --to dispatch:<担当の今の Dispatch の id> --subject "<題>" --body-file <brief>`。担当が作業中なら今の応答の後に届き、終わっていれば続きの Task になる。操縦席の `worker` は最初の Task のまま書き換えない（今の Dispatch は操縦席の判定がたどる）

## 担当を立てるときの細部
- 担当は窓口の子の worktree（担当の居場所。commit はしない）に立てる。窓口と同じ worktree に立てると、操縦席を見つけた窓口用の hook（periodic-reminder・compaction-keep）が担当をメインと見なし、操縦席の更新を求め、圧縮のあとに担当の送信を止める。Orca の worker-start には環境変数を渡す手段が無いので、居場所で分ける（操縦席は git に入れないので子の worktree には無い）
- 担当は窓口と同じ設定（sandboxなし）で動き、立てたときにOrcaで選ばれている席（Claudeのアカウント）を使う。席が切り替わると、account-failover が担当の裏の claude を止め、担当は次のメッセージで同じ会話・同じ Dispatch のまま今の席で起きる（references/notify.md の「利用枠の上限に当たったとき」）
- 受け取りは操縦席の担当の行（`owners[].worker`）に書く（書く欄は cockpit skill の references/workers.md）
- チャットの題には `--task-title` がそのまま付く（2026-11-21 に確かめた）。あとで変えるときは `orca chat rename --session <id> --name "<題>"`（題の形は references/sidebar.md の仕事の行）。id は `orca worktree ps --json` の、そのチャットの `agents[].orcaSessionId`

## brief の所有の 1 文
- 所有: Medurance が長く保守するリポジトリでは、brief に「あなたがこのコードの所有者で、長く保守する。重複や崩れた構造は直してよい。直したものは PR 本文に全部並べる」の 1 文を入れる。顧客が差分を小さく保ちたい案件（顧客がレビューする・顧客のリポジトリに出す・差分の大きさを契約や運用で縛られている）では入れない。迷ったら入れない
  - 元は Anthropic のガイド（Prompting Claude Fable 5.2 の「Say who owns the code」）。Fable 5.2 の測定で、重複の統合が 10% 未満から約 75% に上がり、出力のトークンが 70〜80% 増えた。Opus 5.5 で同じ効果が出るかは確かめていない
  - 入れた worker の PR は、頼んだ変更と所有として直したものを分けて読む。直したものが PR 本文に並んでいなければ差し戻す

## Orca のプラグインを触る worker
- `orca plugin dev load` / `dev watch` で読み込むと、同じ名前の本物のプラグイン（操縦席なら `local.cockpit`）を置き換える。読み込み元の worktree を消すとプラグインの worker が止まり、戻った本物は承認待ちになる（2026-11-16 に、操縦席の窓が Orca の前面に合わせて切り替わらなくなった）
- 確かめるのは、まず `orca plugin test .`・`orca plugin check .`・窓なら別のポートで動かした常駐のプロセスで済ませる。Orca に読み込まないと確かめられないときだけ dev load し、報告の前に `orca plugin dev unload <dir>` で外す。外したことを報告に書く

## brief と worker の設定
- 会話で方針を固めたタスクは、出た文脈・決定事項を brief に圧縮して渡す。brief の質がそのまま引き継ぎの質になるので、目的・制約・決定済み事項・期待出力を全部書く。人間に直接引き継ぐ worker は、`--activate` と `terminal switch` でカードとターミナルを人間の画面に出して「続きはこの worker と」と伝える（その worker は見張らない）
  - 所有: Medurance が長く保守するリポジトリでは、brief に「あなたがこのコードの所有者で、長く保守する。重複や崩れた構造は直してよい。直したものは PR 本文に全部並べる」の 1 文を入れる。顧客が差分を小さく保ちたい案件では入れない。迷ったら入れない（根拠と PR の読み方は references/launch.md）
- worker は settings.worker.json（窓口だけで使う MCP を止め、Claude Code の sandbox を有効にした設定）で動く。sandbox で止まったときの決まりは orca-launch が brief に足す（SKILL.md の「worker を立てる（窓口か担当）」）。DB（PostgreSQL）・dev サーバー・ブラウザ・録画で確かめる作業は、検証用（settings.worker.verify.json。既定に PostgreSQL の起動を足したもの）で立てる。Codex・顧客の SharePoint・Neon を worker に使わせるときの呼び方、検証用との違い、Playwright と dev サーバーの決まり、sandbox が許す範囲は references/worker-env.md
- Orca のプラグイン（`orca/plugins/<name>/` など）を触る worker の brief には、references/launch.md の「Orca のプラグインを触る worker」の決まりを書く
