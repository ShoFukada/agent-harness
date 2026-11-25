# cockpit.json の形と、状態の持ち場所

cockpit skill の SKILL.md から分けた細部。cockpit.json を作る・欄を足す・欄の意味を確かめるとき、カードの欄を書くとき、state.ts の出力の欄を読むときに参照する。

目次: ファイル / 書く道具 / cockpit.json の形 / カード / 依頼の帳簿 / state.ts の出力 / リンク（href）/ 同じ内容を 2 か所に持たない

## ファイル
すべてワークスペースの root の `.orca/` に置く。下のファイルはグローバルの gitignore（home.nix の `programs.git.ignores`）で除外してあるので、顧客のリポジトリにもそのまま置いてよい。

| ファイル | 書く人 | 中身 |
|---|---|---|
| `cockpit.json` | メインだけ（書く道具 `cockpit-write` で） | 操縦席の本体（形の版 2）。形はこのファイルの「cockpit.json の形」と `template.json` |
| `cockpit.v2.json` | 移し替えのコマンド（`cockpit-write migrate-v3`）だけ | 版 3 の欄に移す前の控え。読まない・消さない |
| `cockpit.user.json` | 画面（パネルと窓）だけ | 深田の操作の追記ログ。メインは読むだけ |
| `cockpit.archive.json` | メインだけ | 片付けて 14 日を過ぎたカード。`{ "cards": [...] }` |
| `cockpit.v1.json`・`cockpit.archive.v1.json` | 移し替えのコマンドだけ | 版 1 の控え。読まない・消さない |
| `cockpit.v3.json`・`cockpit.v3-<時刻>.json` | 移し替えのコマンド（`cockpit-write migrate-facts --write`）だけ | 待ちと済を事実から決める形に移す前の控え。戻すときはこれを `cockpit.json` に写す。読まない・消さない |
| `cockpit/notices.jsonl` | hook だけ | 窓口に届いた Orca の知らせ（「──── From: … ────」の見出しで始まる本文）。UserPromptSubmit が `id`（`n-<行番号>`）・`at`・`session`・`prompt`（先頭 400 字）を追記する。待ちを解く `wait.met[].by` と、仕分けの位置 `intake.notices_through` がこの `id` で指す |
| `cockpit/figures/<name>.svg` | メインだけ | 図。カードの `figure` から相対パスで指す |
| `cockpit/rulings.jsonl` | メインだけ（references/rulings.md の「いつ書くか」のコマンドで） | 決定・制約・許可・却下した案の元の記録。追記だけで、撤回も置き換えの行で書く。カードの相談と窓からの質問の返しから書いた行は `from_return`（return_id）を持つ |
| `cockpit/utterances.jsonl` | hook だけ | 深田の発言の原文。UserPromptSubmit が `id`（`u-<行番号>`）・`at`・`session`・`prompt` を追記する。カードの相談の中の発言は `card`（カード id）、窓からの質問の中の発言は `ask`（質問 id）も付く（窓口と同じロックと採番）。Orca の知らせ（「──── From: … ────」の見出しで始まる本文。`cockpit/notices.jsonl` に別に記録する）、Claude Code の背景の作業の知らせ（本文の全体が `<task-notification>` の塊）と、references/consult.md の「カードの相談」の書式の `【相談の知らせ】` は記録しない。依頼の帳簿の仕分けはこの `id` で発言を指す |
| `consult/<カード id>.md` | カードの相談（`consult --card` が立てたタブ）だけ | 相談のメモ（人が読むもの）。前提のカードの rev・決めたこと・新しく出た依頼・残っている論点。窓の詳細からリンクする。返しの採番・再送・回収には使わない。片付いても消さない |
| `consult/<カード id>.returns.jsonl` | `compaction-keep.py consult-return` だけ | カードの相談の返しの記録（正本）。相談が渡した返しに、道具が return_id（記録と判断の記録の `from_return` の最大の次）・`card`・`saved_at` を付けて 1 行ずつ記録する。同じ `replaces`・同じ `op`・道具が付ける欄を除いて中身が同じ返しは 1 行にする（鍵は compaction-keep.py の same_return）。切り替え前のメモの「窓口に返したもの」の返しは、`compaction-keep.py` が最初に読むときに 1 回だけ取り込み、印の行（`memo_imported`）を書く。窓口と state.ts は返しをここだけから読む |
| `consult/ask-<質問 id>.md` | `consult --ask`（先頭）と hook（質問と答え）だけ | 窓からの質問と答えの控え（表示専用）。先頭に、結んだカード（`- カード: d21`）とタスク（`- タスク: t50`）、写した窓口の会話を書く。続きに `### 質問 HH:MM（u-12）`・`### 答え HH:MM`・`### 知らせ HH:MM` の節を時刻順に足す。窓口はここから返しを探さない |
| `consult/ask-<質問 id>.returns.jsonl` | hook だけ | 窓からの質問の返しの記録。相手の最後の返事の末尾にある `【窓口への返し】` の JSON に、hook が return_id（カードの相談と同じ数え方）と `ask`・`saved_at`・`session`・`reply` を足して 1 行ずつ記録する。同じ返事・同じ `replaces`・同じ `op`・中身が同じ返しは 1 行にする。窓口と state.ts は返しをここだけから読む |
| `cockpit/main-session.json` | hook だけ | 窓からの質問が写す窓口の会話 `{ run_id, session_id, transcript_path, config_dir, cwd, at }`。Orca の今の Run が `main.run_id` と一致する窓口の発言のたびに置き換える（`config_dir` が空なら既定の席） |
| `cockpit/firstseen.json` | 常駐の窓だけ | `at` の無い開いたカードを最初に見つけた時刻（30 分の猶予を数える） |
| `cockpit/compactions.jsonl`・`keep.json`・`handoff.json` | hook と下のコマンドだけ | 圧縮の記録・再開の確認と引き継ぎの状態・引き継いだことの窓への知らせ。メインは手で書かない |

## 書く道具
`cockpit.json` は書く道具 `cockpit-write` だけで書く。Write・Edit・MultiEdit で書こうとすると hook が断る（`COCKPIT_LEDGER_GUARD=1` のとき）。Bash から別のスクリプトで書き換えても止まらないが、窓は形の誤ったカードを 1 枚ずつ「形の誤り」として出し、残りを描画する。形の誤ったカードが 1 枚あるだけで窓の描画が止まり、ほかのカードも押せなくなるのを防ぐため。

```bash
~/.config/agent-harness/orca/plugins/cockpit/bin/cockpit-write <ワークスペースの root> <<'JSON'
{"cards": [{"id": "v91", "rev": 2, ...カードの全部の欄}],
 "tasks": [{"id": "t72", ...}],
 "requests": [{"id": "r30", ...}],
 "streams": [], "owners": [],
 "intake": {"through": "u-171", "none": ["u-168", "u-170"]},
 "applied_ops": [812, 813]}
JSON
```

- 渡すのは変えるものだけ。`cards`・`tasks`・`requests`・`streams`・`owners` は id ごとの追加か置き換え（1 件の全部の欄を渡す）、`intake` は置き換え、`applied_ops` は足す op_id、`unaffected` は新しく済になったタスクを受けて見直し、関係ないと確かめたタスクの id（下の `tasks[]` の「済にしたら見直す」）。全体を置き換える手段は無い
- 道具は保存の前に、型（`evidence` は文字列の配列、など全部の欄）・参照（`stream`・`tasks`・`owner`・`request_id` の id があるか）・`rev`（中身を変えたカードは `rev` が 1 上がっているか）・仕分けの規則（下の「依頼の帳簿」）を検査する。通らなければ書かずに理由を返すので、直して渡し直す
- 操作の反映は、カード・タスク・依頼の変更と `applied_ops` を同じ 1 回で渡す（2 回に分けると、その間に読んだ画面と hook が同じ op を未反映と数える）
- 道具は一時ファイルに書いてから rename する（画面が書きかけを読まない）

## cockpit.json の形
`template.json` が全項目の例。必須は `version: 2`・`workspace.name`・`streams`・`tasks`・`cards`。窓と hook は版 2 だけを読み、版 1（`items`）のファイルには「移し替えが要る」と出す（references/setup.md の「移し替え」）。

- `workspace`: `name`（表示名。形は worktree-flow skill の references/sidebar.md の案件の行）、`milestones[]`（`date`・`label`）。「案件の今」に今日以降の節目を近い順に 3 件出す
- `main`: `{"agent": "claude", "terminal": "<自分の端末の term_…>", "run_id": "<窓口の Orca の Run の id>"}`。埋め方は references/setup.md の「最初に作るとき」。`run_id` は、窓の操作の知らせ（窓の郵便受けの端末から送る。R191）と、カードの相談と窓からの質問の返しの知らせの宛先（`--to run:<run_id>`）で、必須（無い帳簿は cockpit-write が断る）。hook が窓口の会話を `main-session.json` に書くときの照合にも使う（無いと質問のタブは立たない）
- `phases[]`: 工程。5 つの固定の並び `["調査", "決定", "作成", "確認", "反映"]`（R83・R135）で、案件ごとに変えない。今の窓は工程の並びをここから読むので書いておく。窓の版 3 は読まないので、新しい窓に入れ替えたあとは省いてよい
- `streams[]`: 仕事（`id`・`title`・`form`・`summary`・`sources[]`）。深田の案件の単位（管理表の行・顧客の指摘・依頼）でメインが決める。窓の「案件の今」は仕事ごとに 1 行（私待ち・止まっている・作業中・顧客待ち・出来事待ち・未着手・済と、次にやること・担当）を出し、Orca のサイドバーの表示名にもこの `title` を使う
  - `title`: 20 字以内の名詞句で、何の仕事かが先頭で分かる日本語（例「AWS 構成案」「配車画面の改修」）。超えると `checks.long_names` に出る。管理表の番号や指摘の日付は `summary` か `sources` に書く
  - `form`: 仕事の形。`delegate`（任せる）・`cowork`（一緒に作る）・`watch`（見張る）。決め方は SKILL.md の「仕事の形」。タスクは仕事の形を引き継ぐ（タスクに欄は無い）。書く道具は形の無い仕事を書かない（新しく作る仕事も、前からある仕事を書き直すときも渡す）。前からある形の無い仕事は `checks.no_form` に出て、窓の全体のタブの下に「形が書かれていない仕事」として並ぶ
  - `watch`: 見張る（`form: "watch"`）の仕事だけに書く。この仕事を受け持つ Orca の Bot（定期確認の automation）の設定 `{ "automation": "<orca automations の id>", "targets": ["<見張る対象の 1 行の名前>"], "to": "<気づいたことの送り先の 1 行>" }`。3 つとも必須で、`targets` は 1 件以上（例 `targets: ["管理表『運用保守対応』", "Slack 7 チャンネル"]`・`to: "Main · sample-app"`）。保ち方は SKILL.md の「仕事の形」（R152）
    - Bot の名前・頻度（rrule・timezone）・有効かどうか・次の実行・前回の実行・定期確認の名前は写さない。Orca の automation が持つ値で、写すと食い違うため。窓が `orca automations list --json` から引く
    - 前回の結果も書かない。窓が `orca automations runs --id <id> --limit 1 --json` の `status`・`scheduledFor`・`outputSnapshot.content`・`chatSessionId` から引く
    - `automation` の id が Orca に無いときは、窓が「Orca に設定が無い」と出す。Bot を終了したら、窓口が `watch` を消すか仕事を済にする
  - `summary`: 何ができたら終わりか 1〜2 行
  - `status`: 状況。窓の一覧の 3 行目にそのまま出る。前の流れを覚えていない人が初見で分かる 2〜3 行の文で、今どうなっていて次に何を待つかを書く（例「Bot の設計は決まった。各案件の窓口が見張る仕事を書き終えるのを待つ」）。100 字まで（前後の空白を除く。超えると cockpit-write が断る。柔らかい言い回しも断る）。無いと `checks.status_missing` に出る（見張る仕事は除く）。状況の文を書くのは仕事だけで、タスクには書かない（R204）
  - `status_basis`: 書く道具が書く。`status` を書いたときの元の事実（その仕事のタスクの判定と、閉じていないカードの状態と版。`"t3:wait:person:0/1:…"`・`"w1:waiting@2"` の形）。帳簿から写した値はそのまま渡してよいが、変えると断る
    - 書き込みのあとの帳簿で、ある仕事の元の事実が控えと違う（タスクが済んだ・待ちが解けた・カードが押された・日付が来た）のに、その書き込みにその仕事の行が無ければ、cockpit-write が「状況の文が古くなった」と断る。仕事の行を渡し、今の事実に合わせて `status` を書き直す。前に控えがあった仕事は、前と同じ文のままだと断る（同じ文を渡し直すだけで古い説明を確定させない。R204）
    - 窓は Orca の状態を含めずに同じ計算をして、控えと違う仕事は古い文を出さず「状況の文が古いので、窓口が書き直すまで事実だけを出しています。待ち 1・完了 2/3」のような事実の文に差し替える（hook は `checks.stale_status`）
  - `summary`・`status`・タスクの `goal` には、SHA・関数名・判断の番号・作業の経緯の羅列を書かない（経緯は `done[]` と作業メモ、次の手順は `next` に書く。`next` は右の詳細に出る）
  - 仕事の状態は、配下のタスクとカードから state.ts が決める。書く欄は無い
- `tasks[]`: `id`・`stream`・`phase`・`title`・`state`・`wait`・`after[]`・`goal`（何のため。窓の概要）・`next`（次にやること。右の詳細）・`done[]`・`sources[]`・`repo`・`worker`
  - タスクは 1 つの仕事に入れ、工程を 1 つ付ける。`stream` の無いタスクは `checks.loose_tasks`、5 つの工程に無い工程名は `checks.unknown_phase` に出る
  - `phase`: 工程は 5 つに固定する: `調査`・`決定`・`作成`・`確認`・`反映`（R83。名前は R135 で業務の漢語にした）。済は工程ではなく `state: "ok"`。窓は前からある名前も読み替える（調べる → 調査、決める・要件・設計 → 決定、作る・実装 → 作成、確かめる・確かめ・実地確認・見てもらう・見直し → 確認、入れる・push・switch 待ち → 反映）が、新しく書くときは 5 つの名前だけを使う。迷ったら、そのタスクが終わったときに何ができているかで選ぶ（分かったこと → 調査、決まったこと → 決定、動くもの・書いたもの → 作成、確認した結果 → 確認、main・本番・相手に届いたこと → 反映）。見張る（`form: watch`）の仕事のタスクは省いてよい
  - `title`: 20 字以内の名詞句（例「担当と協議が開かない」）。超えると `checks.long_names` に出る。worker の worktree の表示名にもなる（`orca-launch --cockpit-task`）
  - `state`: 手で書くのは `open`（済んでいない）と `ok`（完了）だけ（R204）。止まっている・作業中・待ち・未着手は、state.ts が事実（深田の操作・カード・worker の Orca の様子・`wait`・`after`・日付）から決める。決め方は下の「タスクの今の決まり方」。確認のカード（`review`）の「承認」で済になるタスクは、窓口が `ok` と書かなくても済と出る
  - `wait`: 外の理由で待つときだけに 1 つ書く（R193。決まりの本文は agents/common.md「判断」の「聞かずにやる」）。深田を待つものは書かず、頼むカードの `tasks` から指す（cockpit-write が `who` に深田とカードの id が入るのを断る）。種類は 4 つ:
    - `{ "kind": "person", "who": "先方の担当者", "what": "認証情報", "since": "2026-11-17", "where"?: "Slack #aoba" }`: 外の相手（顧客・他社・他のメンバー）の返事。窓は「先方の担当者の返事待ち（認証情報）」と出し、仕事の行は「顧客待ち」
    - `{ "kind": "event", "what": "Bot 3 体が次に知らせを送る", "since": "…", "need"?: 3 }`: 人の返事でない出来事。窓は「〜を待つ」と出し、仕事の行は「出来事待ち」（顧客待ちと呼ばない）。`need` は届く件数（既定 1）
    - `{ "kind": "date", "on": "2026-12-04", "what": "ログインが切れたときの通知が出たかを確かめる" }`: 日付が来ないと取れないデータ・起きない出来事を確かめる日（Asia/Tokyo）。その日の 0:00 に「着手できる」になり、要対応に 1 行出る（R171。放置の検出と同じ経路、R170）。日付は済の証拠にしない。月だけの日付や都合で決めた日付でタスクを寝かせない
    - `{ "kind": "slot", "why": "worker の上限（同時 4 体。compaction-keep.py の WORKER_LIMIT）" }`: 空き枠が無いあいだの順番待ち。窓口が外すまで「未着手」。空き枠があれば置かずに出す（SKILL.md「空いた枠に待ちの仕事を出す」）
    - `met[]`: person・event の待ちを解いた事実 `{ "by": "u-290" | "n-12" | "op:812" | "<議事録のパス>", "at": "…", "note"?: "届いた中身 1 行" }`。`by` の発言・知らせ・操作は記録にあるものだけ（cockpit-write が照合する）。`need` 件そろうと解ける。会議での返事は、議事録を取り込んだ窓口が議事録のパスで書く
    - 何を待つかが無い日付・期間だけの文（「12月」「来週」）と、都合での先送り（「落ち着いてから」）は cockpit-write が断る（`who`・`what`・`why`・`next` を `~/.claude/hooks/defer-guard.py` にかける）
  - `after[]`: 先に済ませる必要があるタスクの id（`["t104"]`）。どれかが済んでいなければ「前提待ち」（未着手）。`next`・`goal` に書いたタスクの id は、前提なら `after` に入れる
  - `worker`: `{ "run_id": "<Orca の Run の id>", "task_id": "<最初の Orca の Task の id>" }`。このタスクを進める worker を立てたときの受け取り（`orca-launch` の `runId`・`taskId`）をそのまま書き（担当の受け取りは `owners[].worker` に書き、ここには書かない。同じ受け取りを両方に書くと書く道具が断る）、あとから書き換えない（references/workers.md）。続きを `send` で頼むと Orca は Task も Dispatch も新しく作るが、state.ts が最初の Task から続き（`follow_up_of`）をたどって今の Dispatch を引く。`dispatch_id` は書かない（古い行にあれば読み込みで受け、移し替えで `run_id` を補う）。
  - Orca では今の Dispatch が済んで取り込まれたのに、`state` が `open` のままのタスクは `checks.stale_tasks` に出る
  - `reviewed_for[]`: 範囲・届け先・対象を変える判断（判断の記録の `affects` がこのタスクを挙げたもの）を受けて、このタスクを見直した判断の id（`R39`）。done_when を直したか、判断のカードに載せたら足す。足していないと `checks.affected_tasks` に出る
  - `next`: 次にやること。待つタスクには、待ちが解けたら何をするかを書く（例「届いたら、12/1 の週に検証環境へ入れる日程を確定する」）。待っていることを書き直さない（`wait` と 2 回並ぶ）。済にするタスクには新しく書かない（残りの確認は別のタスクにする。cockpit-write が断る）
  - `done[]`: 済んだ作業。`{ "text": "...", "at": "2026-11-17T16:10:00+09:00" }`
  - 済にしたら見直す: 書き込みのあとの帳簿で新しく済になったタスク（手書きの `ok` でも、確認のカードの承認でも）があれば、同じ仕事の開いたタスクと、`after`・`next`・`goal` でそのタスクを指す開いたタスクを、同じ書き込みで直して渡すか、関係ないと確かめて変更の `unaffected` に id を並べる。どちらも無ければ cockpit-write が断る（帳簿に書かれていない前提を見落とさないため。R204）
  - 古い欄（`status`・`waiting_on`・`waiting_since`・`check_on`）と、手書きの `run`・`wait`・`idle`・`stop` は cockpit-write が断る。読み込み（窓・hook・書く道具）は古い帳簿を次の規則で補って読む: `run`・`wait`・`idle`・`stop` は `open`、`waiting_on` が名前だけなら person・`idle` で「空き枠」なら slot・ほかは event、`idle` の `waiting_on` が指すタスクは `after`、`check_on` は date、タスクの `status` は無視する。帳簿そのものは `cockpit-write migrate-facts` で移す（下の「移し替え（migrate-facts）」）
  - `repo`: 本文の `#123` を GitHub の PR へのリンクにするリポジトリ（`owner/name`）。接頭辞で分けるなら `{ "BE": "owner/be", "FE": "owner/fe" }`
- `owners[]`: 仕事の担当（話し相手のエージェント）。`id`（`o1` から）・`title`（仕事の名前。20 字以内）・`stream`・`agent`・`session`（Orca のチャットのセッション id。`orca agent list --json` の `orcaSessionId`）・`terminal`（担当が端末で動くときの `term_…`。`worker-start --agent claude` が返す `terminal` は `structworker_…` というチャットの handle で端末ではないので、ここに書かず `session` を書く。書き違えると「担当と協議」が開かない）・`worker`（担当を立てたときの受け取り `{ run_id, task_id }`。`orca-launch --lead` が出した行をそのまま書く）・`state`（open / done）。開いた担当は `session` か `terminal` が要り、1 つの仕事に 1 人まで、形の無い仕事・見張る仕事には置けない。一緒に作る仕事に済んでいないタスクがあれば開いた担当が要る（書く道具が断る。t159）。カードの「担当と協議」は、カードの `owner`、無ければ仕事の担当、それも無ければ窓口を開く
- `routes[]`: 連絡を拾う経路（Slack・Teams・メール）。`id`・`label`（「Slack #aoba-dev」）・`read_at`（見張りが最後に読んだ時刻）・`error`・`stale_minutes`（既定 120）。更新が古い経路や失敗した経路は窓に「見ていない」と出て、hook も `checks.routes` で名指しする。見張りが書く欄で、メインは経路を足すときだけ書く。`streams[].watch` との違い: `routes[]` は経路ごとに最後に読んだ時刻を見張りが書き込む記録で、`watch` は Bot の設定への参照を窓口が保つ欄（前回の結果は Orca から引き、帳簿には書き込まない）
- `cards[]`: 深田さんの要対応の候補。形はこのファイルの「カード」、書き方は references/cards.md
- `applied_ops[]`: 反映済みの op_id の一覧。書く道具の `applied_ops` で足す
- `asks[]`: 窓からの質問のうち、返しを反映したもの（references/consult.md の「窓から質問する」）。`{ "id": "ask3", "card": "d21"?, "task": "t50"?, "stream": "s2"?, "memo": ".orca/consult/ask-ask3.md", "from_returns": ["ask3-1"], "held_returns": [], "notify": [{ "return_id": "ask3-1", "task": "t50", "message_id": "msg_…"? }] }`。`from_returns` に足すのが反映の最後の書き込み、`held_returns` は増えた判断で保留にした返し、`notify[]` は担当・worker に伝える返しで、送れたら `message_id` を書く。返しの記録にあって `from_returns` に無い返し・`held_returns` に残る返し・`message_id` の無い `notify` は `checks.unreflected_returns` に出る
- `notes_ref`: 任意。案件のメモの場所
- `requests[]`: 依頼の帳簿。形はこのファイルの「依頼の帳簿」
- `intake`: 発言と知らせの仕分けの位置。形はこのファイルの「依頼の帳簿」
- `facts_since`: 待ちと済を事実から決める形（R204）に移した時刻。`cockpit-write migrate-facts --write` と、初めて作る `cockpit-write init`（渡した状況の文の控えも押す）が書く。これがある帳簿だけ、cockpit-write が状況の文の古さと済にしたあとの見直しを検査する
- 版 1 の `items`・`summary`・`updated_at`・`items[].related`・`asked_at`・`decided`・`requests[].deliverables` は版 2 で使わない。`cockpit.talk.json` と `window/reply.ts`（話したいことへの回答）は無くなった

### タスクの今の決まり方
state.ts の `judgeTasks` が、上から順に最初に当たったもので決める（R204）。窓・パネル・hook・書く道具が同じ関数を通す。

1. 済: `state: "ok"`、または結んだカードの効果が「済」のカードが承認された（下のカードの効果）
2. 止まっている: 結んだ開いた停止（`stuck`）のカード
3. 深田さん待ち: 結んだ開いた要対応のカード（許可・判断・送信前・確認・相談）。worker が動いていても深田さん待ち。「担当と話す」を押したカードは「深田さんと協議中」
4. 止まっている: worker が Orca で止まった・見つからない
5. 取り込み待ち・作業中: worker が worker_done を返した・動いている
6. 修正中: 確認で「直しを伝える」を押したカード（深田さん待ちにしない）
7. 相手待ち: 送ったあと返事を待つカード（`state: "waiting"`）。「<awaiting.who>の返事待ち（<awaiting.what>）」
8. 待ち: 解けていない `wait`（person・event・date の日付の前）。slot は未着手（順番待ち）
9. 前提待ち: `after` のタスクが済んでいない（未着手）
10. 着手できる: 上のどれでもない。date の日付が来たタスクは「確かめる日が来た: <what>」

カードの効果（カードの種類の今の意味。cards.md の各カードの「押したあと」）: `review` の承認は結んだタスクを済にする。`report`・`inbox` は効果なし。ほかの種類（`decide`・`permit`・`send`・`stuck`・`consult`）は、閉じるとタスクの待ちが外れて着手できる。1 枚のカードに「済になるタスク」と「着手するタスク」が混ざるときだけ、カードの `effects` に結び付きごとの効果を書く（`{ "t65": "start", "t66": "done" }`。`done`・`start`・`none`）。`closes_tasks` の欄は無い。反映の前に取り消した承認は効かない（窓口はカードを開いたままにする）。反映のあとに取り消したものは、窓口が閉じたカードの結果を残し、取り消しの op を未反映の操作として扱う（ops.md の undo）

仕事の行の語（`jobs[].state` と `label`）:

| 仕事のタスクとカード | 仕事の行 | 例 |
|---|---|---|
| 開いた深田さんのカード | 私待ち | 「私待ち 2 件」 |
| 送ったカードの返事・person の待ち | 顧客待ち | 「田中さんの返事待ち（利用上限の回答）」 |
| event の待ち | 出来事待ち | 「Bot 3 体が次に知らせを送るを待つ（1/3 件届いた）」 |
| date の待ち（日付の前） | 出来事待ち | 「12/4 に確かめる: 通知が出たか」 |
| slot・after | 未着手 | 「前提待ち（t104「…」）」 |

### 移し替え（migrate-facts）
古い形（タスクの `status`・`waiting_on`・`waiting_since`・`check_on` と手書きの `run`・`wait`・`idle`・`stop`）の帳簿を、事実から決める形に移す。窓口だけが打つ。

1. 下見: `cockpit-write migrate-facts <root>`。帳簿を書かずに、読み替えの要約と「意味の変わる行（id・題｜前｜後｜理由）」を出す。【決める】の付いた行（待ちの文と確認日が両方あった行）と、`next` に日付がある行は、原文と証拠で照らして直す値を決める
2. 移す: `cockpit-write migrate-facts <root> --write`。元を `.orca/cockpit.v3.json` に残し（既にあって中身が違えば上書きせず、`cockpit.v3-<時刻>.json` に残す。どちらに残したかを要約の「元の控え」に出す）、タスクを読み替え、残りの確認らしい `next` を持つ済のタスク（下見で行に出たもの）の `next` を空にし、`facts_since` を書く。カードと操作の記録は変えない（`rev` を上げると、開いたカードに押された操作が古い版の扱いになる）。`status_basis` はまだ書かない
3. 最初の書き込み: 見張る仕事を除く全部の仕事の行を、照合した `status` で渡す（控えがここで押される）。1 で決めた直し（date の待ちなど）も同じ書き込みで渡す
4. 戻すとき: 要約の「元の控え」のファイル（ふつうは `.orca/cockpit.v3.json`）を `.orca/cockpit.json` に写す。窓と hook は古い形も読み込みで補って読むので、戻しても画面は止まらない

## カード
共通の欄:

| 欄 | 中身 |
|---|---|
| `id`・`rev` | id（種類ごとの頭文字に連番: `d21`・`w1` など）と版。中身（選択肢・対象・本文・期限）を変えたら `rev` を 1 上げる。古い版に押された操作は画面が断る |
| `kind` | 下の 8 種類。`talk`（協議中）は版 3 で無くなった（移し替えで開いた `talk` は `consult` になる）。新しく書かない |
| `title` | 「何を」「どうする」の 1 行 |
| `state` | `open`（深田か担当の手の中）・`waiting`（送ったあと顧客の返事を待つ。`awaiting` を持つ）・`done` |
| `at`・`due` | 出た時刻と期限（ISO 8601 の日時か日付）。`at` は必ず書く（必須の欄が欠けたまま 30 分たったかをここから数える。`created_at` は版 3 で使わない）。期限 24 時間を切ると朱、過ぎると「期限切れ」に並ぶ。メインを起こす仕組みは無いので、期限を過ぎて何をするかは `fallback` に書く |
| `stream`・`tasks[]`・`owner` | どの仕事・タスク・担当の話か。窓の「案件の今」の私待ち・顧客待ちに載るのは `stream` を書いたカードだけなので、仕事の話なら `tasks` だけで済ませず `stream` も書く。どれも無い開いたカードは `checks.orphan_cards` に出る（受信を除く） |
| `effects` | 任意。押したときの結んだタスクへの効果を結び付きごとに上書きする（`{ "t65": "start" }`。`done`・`start`・`none`）。1 枚に「済になるタスク」と「着手するタスク」が混ざるときだけ書く。既定は上の「タスクの今の決まり方」のカードの効果 |
| `purpose` | 何のため 1 行（例「構成案の図が決まり、送る版を作れる」）。窓は題の直下に出す |
| `fallback` | 返事が無いとき窓口が何をするか（references/cards.md） |
| `request_id` | このカードが応える依頼の帳簿の id（`r30`）。依頼の原文は `request`（確認）に、帳簿への参照はこちらに分ける |
| `tidy_op` | 窓の「整理・棚卸し」から届いた指示（`cockpit.user.json` の `type: "tidy"` の op_id）への結果の報告に書く数。書く道具は tidy の操作だけを受ける。窓は送った指示の行から、このカードへ移る（references/tidy.md） |
| `elements[]`・`element_map[]` | 判断・確認のカードで、承認してもらう中身の要素（`{ n, text }`）と、承認を取り込んだときの行き先（`{ n, task }`・`{ n, request: "r30#2" }`・`{ n, skip: "<理由>" }`）。書き方は references/cards.md の「承認の前に要素を固める」 |
| `links[]`・`quote`・`repo` | 資料（`{ "label", "href" }`）・原文・`#123` の解決先。出典として `links`・`quote`・`request`・`href`・`draft.href`・`from.href`・`background.quote` のどれか 1 つは要る |
| `awaiting` | `who`・`what`・`since`・`resumes`（返事で何を再開するか）・`remind_at`（催促する日時）。送ったあと `state: "waiting"` にして書く。催促の日を過ぎると朱になり、`checks.remind_due` に出る |
| `from_returns[]`・`held_returns[]` | このカードに反映し終えたカードの相談の返しの return_id（`d21-1`）と、そのうち選択と判断を保留にして相談の返し直しを待つもの。`from_returns` に足すのが反映の最後の書き込み。保留は、相談が `replaces` 付きで返し直したときに外す。返しの記録にあって `from_returns` に無い返しと、`held_returns` に残る返しは `checks.unreflected_returns` に出る（references/consult.md の「カードの相談」） |
| `resolved_by`・`resolved_at`・`resolved_option`・`resolved_text` | 片付けたとき。`resolved_by` は `user`（深田の操作）か `owner`（担当・窓口が片付けた）。`resolved_text` は別の回答の原文 |

種類ごとの欄:

| kind | 画面 | いつ出すか | 欄 |
|---|---|---|---|
| `stuck` | 停止 | 担当が質問・許可待ちで止まった | `reason`（原文）・`since`・`answerable`（深田が答えれば進むか）・`unblock`（何をすれば進むか）。Orca で止まった worker・担当は窓が自動で停止の票にするので、書くのは担当が質問で止まったときだけ |
| `permit` | 許可 | push・本番・データの変更など戻せない操作の前。深田の手でしか済まない操作（`manual`） | `target`（対象: commit の範囲・送る本文・書き換える行）・`effect`（影響）・`undo`（戻し方）・`scope`（「この案件では一任する」の単位。`push`・`本番` など）・`manual`（手作業: `where`・`command`・`steps[]`・`check`。references/cards.md「深田の手作業を頼む」）。選択肢を持たせると判断と同じ返答になる |
| `decide` | 判断 | 設計・要件・費用・言い方が分かれる | `why`・`context`（5 欄）・`options[]`・`fallback`・`figure`・`compare`・`background` |
| `send` | 送信前 | 顧客か社内へ出す文面ができた | `draft`（`to`・`via`・`format`（必須。`text` を書いた宛先の書式で `slack`・`teams`・`mail`。`via`・`href` の宛先と合わせる。cockpit-write が照合し、本文も検査して合わなければ書かない。断られたら理由の行を直して書き直す）・`text`（長さと敬語は reply-draft skill、書式は dev-standards の `rules/docs/message-formats.md` で書く。references/cards.md）・`href`）・`quote`（任意。返信なら相手が聞いたことの原文 1〜3 行）。文面の言い方を選ばせるなら `options` も |
| `review` | 確認 | 任せた仕事の出来上がり（references/cards.md の「「確認」を出す範囲」） | `request`（依頼の原文）・`request_id`・`look_for[]`（見てほしい点 1〜3）・`evidence[]`（確かめた結果。文字列の配列）・`href`・`diff`（任意。差分のある成果物なら差分を開くリンク）・`draft`（任意。`{ "to", "via", "format", "text" }`。貼った先で崩れないかを深田が確かめる見本。`format` は `text` を書いた宛先の書式で、送信前と同じく必須。窓に Slack・Teams・メールの書式でコピーするボタンが出る。`href` は見ない）。成果物は `href` か `draft.text` のどちらかで足りる |
| `consult` | 相談 | 案がまだ分かれていない。担当（か窓口）が深田と詰めたい | `issue`（論点。何を決めたいか 1 行）・`stance`（担当の今の考え）・`known[]`（分かっていること）・`undecided[]`（決めかねていること）・`owner` |
| `inbox` | 受信 | 顧客の連絡が拾われた | `from`（`who`・`via`・`at`・`href`）・`asked`（聞かれていること 1 行）・`routed`（どの担当が何を始めたか）・`reply`（`needed` / `none`）・`quote`（任意。届いた原文の抜粋）。窓の全体のタブの「見張る」に、件数に入れずに出る |
| `report` | 報告 | エージェントが決めた・済ませた | `done[]`（`what`・`why`（任意。どの候補から選んだかの 1 文）・`undo`・`task`）。項目ごとに「戻させる」が付く |

### 協議中と修正の状態（state.ts が決める。書く欄は無い）
深田の「担当と協議」と「直しを伝える」の操作（references/ops.md の `talk`）から、state.ts がカードの状態を決める。

| 深田の操作 | 窓の印 | 件数 | 終わるとき |
|---|---|---|---|
| 本文の無い `talk`（担当と協議・窓口と協議） | 協議中（state.ts の出力でカードに `talking: { since, with }`） | 変わらない（数える種類なら数えたまま） | 担当・窓口が話の結果でカードを書き直して `rev` を上げるか、片付けたとき |
| 本文つきの `talk`（直しを伝える）を窓口が反映する前 | 修正依頼済み（受領待ち） | 外れる | 窓口が op を `applied_ops` に足したとき |
| 同じ op を反映したあと、同じ `rev` のあいだ | 修正待ち | 外れる | 直した版を出して `rev` を上げたとき（要対応に戻る） |

受け取っただけでカードを書き換えて `rev` を上げると、直す前に要対応に戻る。受け取りは `applied_ops` に足すだけにする。

### 必須の欄
確認依頼のカードは、種類ごとの必須の欄がそろっているものだけを窓の要対応に出す。欠けたカードは state.ts の `checks.incomplete_cards`（`{ id, missing[] }`）に出て、hook が発言のたびに窓口に名指しする。`at` から 30 分たっても欠けたままなら、深田の窓の要対応の一番上「帳簿の未記入」に出る。

| 種類 | 必須の欄 |
|---|---|
| 共通（下の 6 種類） | `stream`・`purpose`・`why` か `due`・`fallback`・出典（`links`・`quote`・`request`・`href`・`draft.href`・`from.href`・`background.quote` のどれか） |
| `decide` | `context` の 5 欄・`options` 2 つ以上と各 `example`・`recommended` が 1 つ |
| `review` | `request`・`href` か `draft.text`・`look_for`・`evidence`。`draft` があるときは `draft.format` |
| `permit` | `target` か `context.what`・`effect` か `context.gain`・`undo`。`manual` があるときは代わりに `manual.where`・`manual.command` か `manual.steps`・`manual.check` と `purpose` だけ |
| `send` | `draft.to`・`draft.via`・`draft.format`・`draft.text`・`draft.href` |
| `consult` | `issue`・`stance` |
| `stuck` | `reason`・`unblock` |

- 確認の `diff`・送信前と受信の `quote`・報告の `done[].why` は任意の欄で、必須に数えない（書き方は references/cards.md）
- 窓の判定（agent-harness の `src/model.ts` の `missingFields`）と同じ。空の文字列・空白だけ・空の配列・中身が全部空のオブジェクトは無いものと数える（数と真偽は在るものと数える）。`recommended` は選択肢の `recommended: true` がちょうど 1 つ
- `incomplete_cards` の `missing[]` は、直す欄の名前（`why|due`・`links|quote|request|href`・`context.what`・`options`・`options.recommended`・`manual.command|steps` など。`|` はどれか 1 つ）

## 依頼の帳簿
深田の依頼を、受けた時点で `requests[]` に載せ、済の証拠がそろうまで消さない（R33）。受付の元の記録は発言の記録（`utterances.jsonl`）で、窓口がそのターンのうちに発言を仕分ける（references/intake.md の「受付と仕分け」）。済は窓口が書かず、state.ts が証拠から決める。

```json
"requests": [{
  "id": "r30", "at": "2026-11-22T10:05:00+09:00", "title": "<何をするか 1 行>",
  "utterances": [{ "id": "u-160", "quote": "<この依頼に当たる原文の範囲>" }],
  "kind": "work",
  "done_when": ["テンプレートの直しが main に入る", "FB の before/after のページを公開する"],
  "check": true,
  "tasks": ["t58"],
  "evidence": [
    { "when": 2, "kind": "url", "ref": "https://claude.ai/code/artifact/..." },
    { "when": 1, "kind": "commit", "ref": "e725dea" },
    { "when": 1, "kind": "op", "ref": "812", "card": "v91", "rev": 2 }
  ]
}],
"intake": { "through": "u-171", "none": ["u-161", "u-165"], "checked_through": "u-120" }
```

| 欄 | 中身 |
|---|---|
| `utterances[]` | 元の発言の `id` と引用（`quote`）。1 つの発言から 2 件の依頼を起こすときは、それぞれの引用の範囲を書く |
| `from_return` | カードの相談の返しから起こした依頼の return_id。同じ返しを 2 回処理しても依頼を 2 件にしないよう、書く前にこの欄と `utterances` の id で照らす |
| `source` | 発言の記録で結べない依頼の出典 `{ session, at, quote }`。発言の記録が始まる前（11/21 13:16 より前）の依頼と、窓口が自分で引き受けた仕事（`quote` に窓口の返事の原文）に使う |
| `ledger[]` | 依頼を起こした台帳の行の id（`B035`・`A006`）。省略可。照合と再生のため |
| `kind` | `work`（作業）・`question`（質問・調べもの）・`decide`（判断）・`send`（送る） |
| `done_when[]` | 完了条件 1〜3 行。どれにも証拠が要る |
| `evidence[]` | 証拠。`when` は `done_when` の番号（1 始まり）、`kind` は `commit`（main に入った commit）・`pr`（マージした PR）・`url`（公開したページ）・`answer`（結論と根拠を書いた回答の場所）・`op`（深田の操作。`ref` に op_id、`card` と `rev` に押したカードとその版）・`post`（見張りが読み取った、相手のスレッドへの投稿。`ref` に投稿の URL） |
| `check` | 深田の確認が要るか（references/cards.md の「「確認」を出す範囲」の 4 つ）。`true` なら、今のカードの `rev` に押された取り消されていない「承認」（`accept` の op）があるときだけ済 |
| `tasks[]` | この依頼のタスク |
| `legacy` | 版 3 の移し替えの前からある行。移し替えのコマンドだけが付ける。検査しない |
| `closed_without_review`・`resolved_at_inferred` | カードの欄。移し替えが、深田の操作が無いまま閉じた確認と、片付けた時刻を補ったカードに付ける。手で書かない |
| `state` | 書かない。state.ts が `受付`・`進行中`・`確認待ち`・`済` を決めて出力の `requests[]` に載せる |

- `legacy` の無い行は、`utterances` か `source` のどちらかと、`done_when` が無いと書く道具が断る。`source` の依頼も検査の対象になる（`legacy` にしない）
- 完了条件ごとに証拠が 1 つ以上要る。タスクが 0 件でも、空のまま済にはならない
- `send` は、「送信済みにする」の操作（`op`）か、見張りが相手のスレッドへの投稿を読み取ったもの（`post`）で済になる。見張りが読み取る仕組みはまだ無い
- `question` は、結論と根拠（読んだファイル・コマンドとその結果）を書いた回答の場所を `answer` で結べば済（R47）。「調べます」だけの返答は証拠にしない
- 成果物を改訂したら確認のカードの `rev` を上げる。古い版への「承認」は新しい版の証拠にならない
- タスクが 1 件も結ばれていない済んでいない依頼は、窓の全体のタブの一番下に「タスクの無い依頼 n 件」の 1 行で出る（開くと並ぶ。0 件なら出ない。R104）。タスクを起こして `tasks` に結ぶまで残る

### 台帳から依頼を取り込む
窓口や担当が会話の外に控えた台帳（`ledger-*.json`）の依頼を、帳簿に取り込む。新しい道具は作らず、書く道具の `requests` で渡す。`migrate-v3` のあとに行う。
1. 担当が、台帳の行のうち状態が「済」「取り消し」以外のものから、取り込む JSON（`{ "requests": [...] }`）を scratchpad の `ledger-import.json` に作る
   - 既存の依頼（`r1`〜）と同じ件なら、新しい依頼を作らずその依頼を置き換えて `legacy` を外し、`utterances` か `source` と `done_when` を足す
   - 既存のタスクと同じ件なら、依頼の `tasks[]` に結ぶ。複数の台帳の行が同じ仕事なら 1 件にまとめ、`ledger` に全部並べる
   - 発言の記録で結べない依頼は `source` に出典を書く
2. 担当が `cockpit-write --dry-run <root> < ledger-import.json` で検査に通ることを確かめ、ファイルのパスと、台帳の行と依頼の対応の一覧を窓口に渡す
3. 窓口が `cockpit-write <root> < ledger-import.json` で書き、state.ts の `requests[]` で件数を台帳と突き合わせる

`intake` は発言の仕分けの位置。
- `through`: ここまでは仕分けた、という発言の id。どの依頼にも `none` にも結ばれていない発言をまたいで進めると、書く道具が断る
- `none[]`: 依頼でない発言の id（相づち・「ok」・返答への短い返事）。1 件ずつ書かず、仕分けたときにまとめて足す
- `notices_through`: ここまでは仕分けた、という知らせの id（`n-12`）
- `no_wait[]`: どの待ちも解かないと照らした発言・知らせの id。開いた person・event の待ちがあるあいだに `through` か `notices_through` を進める書き込みは、またいだ発言・知らせ（待ちを始めた時刻より後のもの）を 1 件ずつ、どれかのタスクの `wait.met[].by` で指すか `no_wait` に入れないと cockpit-write が断る（口頭の返事と届いた知らせを見落とさない。R204）。待ちが無ければ求めない。照らしていない知らせは `checks.unsorted_notices` に出る
- `checked_through`: ここまでは検査済みという境界。移し替えのときと、`none` を畳む（14 日より古い id を消す）ときに書く道具が書く。`intake` を置き換えるときも、今の `checked_through` を消さずに渡す
- state.ts は、`through` より後の発言と、`through` 以前でどの依頼にも `none` にも結ばれていない発言（`checked_through` 以前を除く）を `checks.unsorted` に出す
- 相談・質問の返しで決まった発言は、`intake` に書かなくても仕分け済みになる: 返しの `decisions[].utterance` はその返しの `from_return` を持つ判断の記録の行があれば、`requests[].utterance` はその返しの `from_return` を持つ依頼があれば、`checks.unsorted` に出ない

## state.ts の出力
| 欄 | 中身 |
|---|---|
| `counts`・`mine`・`next`・`overdue` | 要対応の件数（停止・許可・判断・送信前・確認。相談は要対応に並ぶが数えない）・要対応のカードの急ぐ順の列・いちばん急ぐカード・期限切れ。深田の操作を重ね、Orca で止まった worker の停止を足したあとの数。協議中のカードは、数える種類なら数えたまま |
| `requests[]` | 依頼ごとの判定済みの `state`（受付・進行中・確認待ち・済） |
| `talking`・`waiting` | 協議中のカードと、顧客待ち（誰の何を・いつから・催促の日） |
| `jobs[]` | 仕事ごとの今（`state`・`label`・`next`）と、Orca のサイドバーに出す形 `orca`（`display_name`・`status`・`unread`） |
| `tasks[]`・`workers[]` | 画面に出るタスクの状態（`state`）と人が読む 1 行（`label`。例「田中さんの返事待ち（利用上限の回答）」「前提待ち（t104「…」）」）、その出どころ（`from`: 帳簿と操作・作業中・取り込み待ち・止まった・見つからない） |
| `checks` | hook がメインに直させること: `pending_ops`・`missing_context`・`local_deliverables`・`orphan_cards`・`remind_due`・`intake`（取り込み待ちの worker）・`missing_workers`・`push_check`・`plugin`・`routes`・`long_names`（仕事・担当・タスクの題）。版 3 で足したもの: `incomplete_cards`（必須の欄が欠けたカード）・`unsorted`（仕分けていない発言）・`unmapped_elements`（承認の op が来たのに `element_map` が欠けたカード `{ card, missing[] }`）・`unproven`（タスクは全部済なのに証拠の無い完了条件が残る依頼 `{ request, when[] }`）・`affected_tasks`（判断の `affects` に挙がったのに見直していないタスク `{ ruling, task }`）・`stale_tasks`（取り込まれたのに open のままのタスク）・`loose_tasks`（仕事に入っていないタスク）・`unknown_phase`（5 つの工程に無い工程名）・`no_form`（形の無い仕事）。カードの相談で足したもの: `unreflected_returns`（相談のメモにあって、判断の記録の `from_return` かカードの `from_returns` に無い返し `{ id: return_id, card, missing[] }`。`missing` は `判断の記録`・`帳簿`・`保留`（カードの `held_returns` に残っている）。窓からの質問の分は `card` の代わりに `ask` を持つ: `{ id: return_id, ask, missing[], tasks? }`（`missing` に `判断の記録`・`帳簿`（`asks[].from_returns`）・`保留`・`担当への通知`（`asks[].notify[]` の `message_id` の無い行。`tasks` にそのタスク））と、返しの無い「この答えを窓口に返す」 `{ id: null, ask, op, missing: ['返し'] }`（`ask_decide` の op に結ばれた返しが無く、op が `applied_ops` にも無い））・`stale_consults`（カードが片付いたのに残っている相談のタブ `{ id: カード id, terminal }`）。仕事の形で足したもの: `watch_missing`（`watch` の 3 欄が欠けた見張る仕事）・`watch_unknown`（`watch.automation` の Bot が Orca に無い見張る仕事）・`workspace_name`（形の合わない案件の名前 `{ name, message }`。形は `workspace` の行）・`idle_tasks`（線を越えて動いていないタスク `{ task, since, hours }`。`wait` の date の行）。事実から決める形で足したもの: `stale_status`（状況の文の元の事実が控えと違う仕事 `{ id, changes[] }`。`status_basis` の行）・`unsorted_notices`（開いた待ちがあるのに仕分けていない知らせ。`intake` の `no_wait` の行）。hook は深田の発言のターンに、未処理の要対応と重要な警告を 1 件ずつ、帳簿の形の直し（どれが当たるかは `claude/hooks/periodic-reminder.sh` の `LEDGER_FIXES`）を検査の名前と件数の 1 行で流す。直し方はこのファイルの各欄の行 |
| `overview`・`card` | hook が流す全体の 1 行・ワークスペースのカードのコメント |

## リンク（href）
`href`・`links[].href`・`draft.href`・`from.href`・`sources[]` には次のどれかを書く。画面は種類の印（Drive・PR・Slack・ページ・ファイル）を付けて開くボタンにする。
- ワークスペースからの相対パス（日本語の名前も可）。`docs/設計.md:12` のように `:行` を付けると、窓はその行で開く
- 窓口の worktree の子の worktree の中の絶対パス（worker のブランチの成果物）
- http(s) の URL（Google Drive・Docs・GitHub の PR・Slack のスレッド・claude.ai の artifact など）。既定のブラウザで開く

## 同じ内容を 2 か所に持たない
1 つの事実は 1 か所だけが持ち、ほかの場所はそこから出す。事実から決まることを手で書き写すと、書き忘れたときに画面とメインの認識が事実と食い違う。

| 事実 | 持つ場所 | ほかの場所 |
|---|---|---|
| タスクの状態 | 済は `tasks[].state: "ok"` か確認のカードの承認。ほかは深田の操作・カード・Orca の Dispatch・`wait`・`after`・日付 | 画面・hook・書く道具は state.ts の `judgeTasks` の判定。手で止まり・待ちを書かない |
| 仕事の状況の文 | `streams[].status`（窓口が書く人の文） | 元の事実が変わったら書き直す。窓は古い文の代わりに判定から作った事実の文を出す |
| 仕事の状態 | 配下のタスクとカード | 窓の案件の今と Orca のサイドバーは state.ts の `jobs[]` から |
| 深田を待っていること | 開いた要対応のカードの `tasks`・`stream` | 仕事の「私待ち」はそこから出る |
| 外の相手・出来事を待っていること | 送ったカードの `awaiting`、タスクの `wait`（person・event・date・slot） | 仕事の「顧客待ち」（人の返事）・「出来事待ち」（出来事・日付） |
| 待ちが解けたこと | タスクの `wait.met[]`（発言・知らせ・操作・議事録を指す） | 窓口の会話で「届いた」と言うだけにしない |
| 件数・期限・次の節目 | `cards[]`・`milestones[]` | 画面・hook の全体の 1 行・カードのコメントは state.ts から。要約の文は書かない |
| worker とタスク・担当と仕事の結び付き | `tasks[].worker`（worker）・`owners[].worker`（担当）。どちらも Orca の Run と最初の Task の id | 担当・worker の状態と知らせは Orca の orchestration が持つ（`worker-show`・`task-list`・`inbox`）。写しを作らない |
| 担当の話し相手の場所 | `owners[]` の `session`・`terminal` | カードは `owner` か `stream` で引く |
| 決めたあとの結果 | カードの `resolved_*` と、要ればカードの `why` の先頭の「結果:」 | タスクの `done[]` は、そのタスクで済んだ作業。同じ文を両方に書かない |
| 顧客に聞くこと | `project/questions.yaml` や Issue があればそちら | 送信前の `links` で指し、中身を書き写さない |
| 決定・制約・許可・却下した案と、それが影響するタスク（`affects`） | `.orca/cockpit/rulings.jsonl`（references/rulings.md） | 作業メモ・要約・窓口との会話は ID（R12）で指す。カードの文には番号を書かず、要る中身を平文で書く（窓から開けないため。references/cards.md）。撤回は置き換えの行 |
| カードの相談で決まったこと | 窓口が書いた判断の記録（`from_return`）と帳簿（カードの `from_returns`・依頼の `from_return`） | 返しの記録（`<カード id>.returns.jsonl`）は反映されるまでの回収元、相談のメモは人が読むもので、どちらも正にしない |
| 窓からの質問で決まったこと | 窓口が書いた判断の記録（`from_return`）と帳簿（`asks[].from_returns`・依頼の `from_return`） | 返しの記録（`ask-<質問 id>.returns.jsonl`）は反映されるまでの回収元、控え（`ask-<質問 id>.md`）は表示だけで、どちらも正にしない |
| 深田の発言の原文 | `.orca/cockpit/utterances.jsonl`（hook が書く） | 圧縮のあとに直近 10 件が流れる。依頼の帳簿は `utterances[].id` で指し、原文は引用の範囲だけを持つ |
| 依頼が済んだか | 依頼の `done_when` と `evidence`（state.ts が判定する） | 窓の「まだ済んでいない依頼」と hook は state.ts の出力から。`requests[].state` を手で書かない |
| 作業の細部（brief のパス・取り込みの条件・検証の結果） | `.orca/cockpit/state.md`（メインの作業メモ） | cockpit.json には書かない。cockpit.json にあるもの（担当・worker の task id・判断）は作業メモに書き写さない |
