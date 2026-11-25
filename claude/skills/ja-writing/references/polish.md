# 仕上げ（Gemini 4 Neon）の細部

ja-writing の SKILL.md の「仕上げ」から分けた細部。仕上げを手で通すとき、仕上げの結果がおかしいとき、規則や yomiyasu を直す・上げるとき、polish.py の引数を変えるときに読む。

## 手で通す手順
hook がかからない渡し方（Slack 文面・メール本文・チャット・artifact の公開だけ・Docs）と、hook が対象から除く指示文で、仕上げを手で通すときの手順。指示文で採用する修正の範囲は SKILL.md の「仕上げ」にある。

1. 構成と内容は自分で決め、本文を書き終える。渡すのは完成した本文
   - 顧客に出す文書は、仕上げに渡す前に相手の担当者になったつもりで一文ずつ読み、新しい質問を呼ぶ所・後退や手抜きに見える所・社内の事情が透ける所を直し、直した箇所を報告に並べる
2. 仕上げ結果を得る（元ファイルは書き換わらない）

```bash
python3 ~/.config/agent-harness/claude/skills/ja-writing/polish.py <file>          # 仕上げた本文を stdout に
python3 ~/.config/agent-harness/claude/skills/ja-writing/polish.py --diff <file>   # 元との unified diff
python3 ~/.config/agent-harness/claude/skills/ja-writing/polish.py --audience client --doc-type proposal <file>
```

3. stderr に「yomiyasu_diff が意味の変わる恐れを見つけた」と出たら、その種類の箇所を差分で先に見る。差分を確認し、事実・数値・固有名詞・引用・識別子、敬体と常体、Markdown の構造（見出し・箇条書き・表・コードブロック）が変わっていたら戻す
4. 採用する部分だけを元ファイルに反映する。全部を機械的に上書きしない

## 仕上げ役に渡す規則
- SKILL.md の「書き方の規則」節。食い違ったらこちらを優先させる
- yomiyasu（`~/.local/share/yomiyasu`、版は flake.lock で固定）の SKILL.md 1 章「基本原則」。見出し・太字・読点・装飾記号を直す 5 節は、Markdown の構造を保つ指示とぶつかるので外す
- 文書の種類が分かれば yomiyasu の `references/doc-types/<種類>.md`（formal なら「実施する」「〜するものとする」を、mail なら挨拶と結びを直さない）、顧客向け（`audience: client`）なら `references/persona.md`（書き手と読み手の関係から敬語を合わせる）

文書の種類は、本文の印（Markdown は frontmatter の `doc-type: proposal`、HTML は `<meta name="doc-type" content="proposal">`）、gh pr の本文なら pr、ファイル名（議事録・提案・マニュアル・手順・規程・契約・仕様・定義書・メール）の順で決め、決まらなければ渡さない。値は pr・article・incident・proposal・minutes・manual・slides・essay・formal・promo・mail・paper・script。

hook は書き直しを採る前に yomiyasu_diff で原文と比べ、許可・義務の言い方（「〜してよいか」→「〜して問題ないか」）、文の種類、数値が変わったか、原文に無い人や担当を足した書き直しを捨てる。否定の言い方は「無い」→「ない」も変化と数えるので、この判定には使わない（否定の数は hook が別に数える）。

hook がファイルに当てるのは、そのターンで変えた行に収まる書き直しだけ。変えた行は、そのターンで最初に書き込む前の本文（Write・Edit の結果に Claude Code が残す）と今の本文を行ごとに比べて決める。前の本文が分からないときだけ、書いた断片の位置と HEAD との git diff で決める。変えていない行に触れる書き直し（前後の行と 1 行にまとめるなど）は捨てる。採った行は、書いた直後の hook と同じ規則（claude/hooks/ja_spacing.py）で日本語と英数字の間の空白を詰め直す。

## polish.py の補足
- `--model` で agy に渡すモデルを変えられる。既定は `gemini-4-neon-high`。引数を省略すると stdin から読む
- 規則は SKILL.md の「書き方の規則」節と yomiyasu を実行時に読み込んで渡す。自分の規則を直すときは SKILL.md だけを直す。読み込めなかった規則は stderr に断ってから外して仕上げる
- yomiyasu を上げるときは `nix flake update yomiyasu` のあと、`JA_YOMIYASU_DIR=$(nix flake archive --json | jq -r .inputs.yomiyasu.path) python3 claude/hooks/ja-review_test.py` を流す。1 章の見出しや diff の JSON の形が変わると落ちる。通ったら darwin-rebuild switch で `~/.local/share/yomiyasu` を差し替える
- `polish.py file > file` はシェルが先に file を空にするので、出力は別ファイルか `--diff` で受ける。失敗すると stdout は空のまま非 0 で終わる。20 万字を超える入力は章ごとに分けて渡す
