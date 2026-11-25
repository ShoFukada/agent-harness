---
name: codex-review
description: Codex（GPT-6.2 Astra）にレビュー・相談・独立した設計案を頼むときに使う。CLAUDE.md の Codex の条件に当たったとき、行き詰まったバグや設計を相談したいとき、設計の選択肢をユーザーに出す前、「Codex に見せて」「Astra に聞いて」「別の目で見て」で発動する。日本語の文面と見た目には使わない（Neon）。
---

# なぜ異系統に見せるか
同系統のモデル同士では何度レビューを重ねても同じ見落としが揃って残る。学習系統の違うモデルにレビューさせると、回数を増やすのとは別の種類の漏れを見つけられる。相手は GPT-6.2 Astra で、Codex 側の AGENTS.md には、この起動方法をレビュアー用として書いてある。

Codex が受け持つのはコード・設計・原因の反証。人が読む日本語の表面と画面の見た目は Gemini 4 Neon が受け持つ（CLAUDE.md の Neon の使い所、ja-writing skill の仕上げ、dev-standards の design-review）ので、Codex に文面や見た目の好みを聞かない。

# 呼ぶ条件
次のときは呼ぶ（「まだ自力でいける」という自己評価で飛ばさない。ユーザーが急ぐと言ったときだけ省いてよく、省いたことを報告に書く）:
1. 同じ問題に対する修正が 2 回失敗したら、3 回目を試す前に相談する。相談の前に、2 回の修正がどちらも当然と考えていた前提を 1 文で書き、その前提が誤りなら結果が変わる観測（ログ・実際の値・失敗の分布）を 1 つ取る。prompt には前提とその観測結果を入れ、前提そのものを疑う観点で見てもらう
2. commit 前に、タスク開始時点からの累積の実質差分（自動生成物・lock ファイル・機械的な rename を除く）が 200 行以上または 5 ファイル以上なら、敵対的レビューを通す。観点はバグ・境界条件・後方互換・不要な複雑さ。規模が小さくても認証・権限・課金・マイグレーション・運用設定に触れる変更は通す
3. ユーザーが「本番」「リリース」「重要」と明示したタスクは、実装を終えて commit する前に、要件一覧と実装済みコードのパスを渡して漏れチェックを通す
4. 認証・権限・課金・データモデル・公開 API・不可逆なインフラ変更の設計に着手するときは、自分の案を固める前に独立した案を作らせる。自分の案は見せず、要件と制約だけを渡して後から比較する。軽微な内部リファクタは含めない

判断して呼ぶ:
- 自分で解決できない・確信が持てないバグや設計の行き詰まり。状況・試したこと・手がかりを整理して相談する
- 設計の選択肢をユーザーに出すとき、迷ったら相手の意見も添える

# 呼び方
worker（settings.worker.json の sandbox の中）では、相談・レビューは `codex-ro` で呼ぶ。素の `codex exec` は sandbox の中では起動できない。

```bash
# 新規。prompt と回答は scratchpad（/tmp/claude-<uid> の中）に置く。他のコマンドと繋がず、この 1 行だけで呼ぶ
~/.config/agent-harness/claude/bin/codex-ro <リポジトリの絶対パス> <scratchpad>/codex-prompt.md <scratchpad>/codex-out.md
# 出力の「session id: ...」を控え、続きはその ID を 4 つ目に付ける
~/.config/agent-harness/claude/bin/codex-ro <リポジトリの絶対パス> <scratchpad>/codex-prompt.md <scratchpad>/codex-out.md <session id>
```

- 実際には `~` を展開した絶対パス（`/Users/fukadasho/.config/agent-harness/claude/bin/codex-ro`）で書く。`cd`・`;`・`&&`・`|`・リダイレクト・`$(...)` を付けると hook が止める
- codex-ro は読むだけで、通信もできない（web 検索・MCP・ChatGPT の app も切ってある）。調べものや、書かせる作業は main 側で素の `codex exec` に回す
- 回答は `<out>`、session id とログは `<out>.log` に出る

main 側（sandbox の外）では、Bash から `codex exec` を使う。

```bash
# 新規。prompt はファイルに書いて stdin から渡す（引用符とシェル展開の事故を避ける）
codex exec -m gpt-6.2-astra -s read-only -C <リポジトリの絶対パス> -o <scratchpad>/codex-out.md - < <scratchpad>/codex-prompt.md 2> <scratchpad>/codex-err.txt
grep -m1 "session id:" <scratchpad>/codex-err.txt    # 続きに使う ID

# 続き。resume は -C と -s を受け付けないので、対象リポジトリの中で実行し、sandbox は -c で渡す
cd <リポジトリ> && codex exec resume <session id> -m gpt-6.2-astra -c sandbox_mode='"read-only"' -o <scratchpad>/codex-out.md - < <scratchpad>/codex-prompt.md
```

- 回答は `-o` のファイルだけを読む。stdout と stderr には途中経過と hook のログが大量に出るので自分の会話に入れない
- `-m gpt-6.2-astra` を明示する（config.toml の既定に頼らない）
- 相談・レビューは `-s read-only`。作業を渡すときだけ `-s workspace-write` にし、Claude 側と同じファイルを同時に触らせない
- 一連の相談は `session id` を保持して `codex exec resume` で続ける。毎回新しいセッションを作らない
- 数分かかるので Bash の `run_in_background` で実行し、完了通知を待つ
- prompt の冒頭に書く: 「Claude Code から起動されたレビュー/相談。サブエージェントの起動も `claude -p` での呼び返しもしない」
- prompt は単体で完結するように書く（会話は共有されない）: 目的、対象ファイルの絶対パス、cwd、見てほしい観点（バグ・境界条件・後方互換・不要な複雑さ）、期待する出力形式と長さ
- 結果は自分で検証してから採用する（テスト実行は test-runner で裏取り）
- 失敗したとき（認証切れ・利用枠・タイムアウト）はリトライし続けず、「レビュー未実施」と明記して、commit などを進めてよいかの判断だけユーザーに戻す。独立して進められる作業は進める

# 指摘の採り方
指摘は網羅的だが重要度の順位付けがされていない前提で受け取る。言われた順に全部対応すると作りすぎになる。採否は自分で決める:
1. 不具合が起きるシナリオが具体的に書かれているか。「〜の可能性がある」止まりなら、決める前に自分で再現を試みる
2. そのシナリオがこの環境の運用で実際に起きるか（single-user の Mac で他ユーザーからの読み取りを想定する類は優先度が低い）
3. 修正で増える複雑さが、防げるリスクに見合うか。見合わないなら「対処しない」が正しい

指摘に論理で反論できないことは、採る理由にならない。上の 1〜3 で決める。

不採用にしたものは黙って省かず、理由を 1 行添えてユーザーに報告する。一度レビューを通した後は、追加差分と、その変更で前提が変わった箇所だけ再レビューすればよい。

1 つの変更につき、Codex との往復は 2 回まで（最初のレビューと、直した後の再レビュー）。再レビューの prompt には、前回の指摘ごとの採否と、不採用の理由を 1 行入れる。3 回目が要ると思ったら再レビューはせず、残った指摘と採否の案を添えてユーザーに戻す。
Neon を挟む往復（relay-consult skill）は、Neon と Astra に 1 回ずつ聞くのを 1 巡と数え、2 巡までにする。
