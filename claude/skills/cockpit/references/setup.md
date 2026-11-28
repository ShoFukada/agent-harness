# 最初に作るときと、版 1 からの移し替え

cockpit skill の SKILL.md から分けた細部。ワークスペースに操縦席を初めて作るとき、hook が「移し替えが要る」と出したときに読む。

## 最初に作るとき
1. `template.json` を作業用のファイル（例 `$TMPDIR/cockpit.json`）に写し、案件の docs・WBS・Issue・確認事項から埋める（`version: 2` は消さない）。`.orca/cockpit.json` には直接写さない
   - `workspace.name` は「<顧客>｜<案件>」（社内は「社内｜<案件>」）の形で書く（worktree-flow skill の references/sidebar.md の案件の行）。リポジトリ名をそのまま書かない（窓のサイドバーに案件の名前として並ぶ）
2. `main` を埋める: `{"agent": "claude", "terminal": "<自分の端末の handle。チャットなら空>", "run_id": "<窓口の Run の id>"}`
   - `run_id` は必ず書く。値は `orca orchestration run-current --json` の `runId`。深田が窓で操作すると、窓は郵便受けの端末（タブ名「操縦席｜郵便受け」。AI を動かさない端末を窓が窓口の worktree に作る）を送り主にして、この Run に知らせを送る（端末の窓口にもチャットの窓口にも同じ経路。経路の決まりは worktree-flow skill の「知らせの経路」）。カードの相談と窓からの質問の返しも、この Run に届く（references/consult.md）。Run が取れないうちは init しない（`run_id` の無い帳簿は cockpit-write が断る）
   - `terminal`: Orca の端末で動いていれば環境変数 `ORCA_TERMINAL_HANDLE`（`term_…`）の値を書く。Orca のチャットで動いていれば端末が無いので空にする（Claude のチャットと、環境変数 `ORCA_STRUCTURED_SESSION=1` が付く Gemini のチャット。同じ worktree の Claude の端末はカードの相談なので引かない）。端末の Gemini（agy）の run_command には `ORCA_TERMINAL_HANDLE` が渡らないので、`orca terminal list --worktree path:<root> --json` で `agentIdentity` が `antigravity` で `orphaned` でない行が 1 つだけならその `handle` を使う。0 か複数なら空で埋めず、深田にどの端末が窓口かを聞く。Gemini（agy）なら `agent` を `antigravity`、codex なら `codex` にする
   - 書けたら `cockpit-write init <root> --dry-run < 作業用のファイル` で検査を通し、`cockpit-write init <root> < 作業用のファイル` で `.orca/cockpit.json` を作る。形の合わない案件名・`run_id` の無い帳簿・既にある帳簿・待ちの書き方（R193）に合わないタスクは、理由を返して断られる
   - Gemini の窓口は、作ったあとに `compaction-keep.py switch <root> --agent antigravity` を 1 回打つ（hook は窓口の種類を知らないので、打たないと窓からの質問が Gemini の会話を Claude の会話とみなして写そうとし、失敗する）
3. ワークスペースのメインの題を「<案件の役割> 窓口」にする: チャットなら `orca chat rename --name "<役割> 窓口"`、端末なら `orca terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "<役割> 窓口"`
4. 画面が見えているかを深田に聞かない
5. 0 から作り直すと頼まれたときは、前の cockpit.json を下敷きにせず、Slack・Teams・議事録・管理表の一連を読み直して今の状態から組む

## 移し替え（版 1 → 版 2、案件ごとに 1 回）
hook が「cockpit.json が版 1 のままで、状態を読めない。移し替えが要る」と出したら、ほかの作業の前に行う。

1. 未反映の操作をすべて反映する（版 1 の項目に押した操作は、移したあと適用されない。残っているとコマンドが断る）
2. `node ~/.config/agent-harness/orca/plugins/cockpit/window/migrate.ts <root>` で、何が何になるかを確かめる
3. `--write` を付けて書き換える。元は `cockpit.v1.json`（と `cockpit.archive.v1.json`）に残る
4. 移したあと、次を見直す
   - 送信前・許可に分かれたカードの中身（`draft.to`・`target`・`scope`）。版 1 の「聞く」は宛先が「顧客」の送信前になっている
   - 仕事の `title`（20 字以内）と、担当がいれば `owners[]`
5. `node ~/.config/agent-harness/orca/plugins/cockpit/window/state.ts <root>` が通り、件数が窓と合うことを確かめる

## 版 3 の欄に移す（案件ごとに 1 回）
版 3 の窓・パネル・hook（相談・依頼の帳簿・worker の `run_id`）に合わせて、帳簿を書く道具で移す。設計の順番（6 章の 7）を崩さない。古いパネルは `consult` と `dispatch_id` の無い worker を読めず、帳簿を丸ごと読めなくなるため。
1. 窓・パネル・hook の CLI が新旧両方の形を読めるものに入れ替わり、Orca のプラグインを入れ直したことを確かめる（読み込まれたパネル・常駐の窓・`state.ts` の 3 つで今の帳簿が読める）
2. 書く道具 `cockpit-write` で、手元の写しに小さな変更を書いて検査が通ることを確かめる
3. 未反映の操作をすべて反映してから、`cockpit-write migrate-v3 <root>` で移す。元は `cockpit.v2.json` に残る。移し替えは次をする
   - 開いた `talk` のカードを `consult` にする
   - `tasks[].worker` に `run_id` を補う
   - `at` の無いカードに `created_at` を写す
   - 今ある依頼の行に `legacy: true` を付ける（古い行は検査しない。新しい依頼から欄を必須にする）
   - `intake.through` と `intake.checked_through` の両方に、発言の記録の最後の行の id を書く（それより前の発言は仕分け済みとして扱う。`through` だけだと、古い発言がすべて未仕分けに戻る）
   - `legacy` の行のうち、結ばれたタスクが全部済のものは、証拠を照合できたものだけ済にする。それ以外は、窓口が仕分ける一覧（id・題・タスクの状態・最後の更新）が出るので、1 件ずつ `done_when` と `evidence` を書くか、そのまま残す
   - `resolved_at` の無い閉じたカードに、op の時刻 → 更新の時刻 → `created_at` → `at` の順で補う（どれも無ければ移し替えの時刻にし、`resolved_at_inferred: true` を付ける）
   - 深田の操作が無いまま閉じた確認に `closed_without_review: true` を付ける（対応済みのタブで「確認なしで閉じた」と出る）
4. 窓口が版 3 の前に別に控えた依頼の台帳（`ledger-*.json`）があれば、そこから起こした依頼を `cockpit-write` で `legacy` の無い行として足し、元の台帳の件数・id と、足した `requests[]` を突き合わせて取りこぼしが無いかを確かめる
5. `state.ts <root>` が通り、件数と `checks` が窓と合うことを確かめる。`incomplete_cards` に出た開いたカードは、必須の欄を埋める
6. 帳簿の直書きを止める hook と、仕分けていない発言の Stop を入れる: `~/.config/nix-darwin/claude/settings.json` の `env` の `COCKPIT_LEDGER_GUARD` を `"1"` にする（次に開いたセッションから効く）。設定は全案件に共通だが、hook は版 3 の帳簿（`intake` の欄がある）だけで動くので、まだ移していない案件には効かない（R195。`cockpit-write init` で作った帳簿には移し替えの控えが無いので、控えでは見分けない）。戻すときは `"0"` に戻す

## 窓が Orca の前面に合わせて切り替わらないとき
- Orca の操縦席のプラグインが承認待ち・止まっていると、窓が Orca の前面に合わせて切り替わらない。窓の上の帯に理由が出て、hook も名指しする。承認を深田に頼む許可のカードを出す（開発用の読み込みが残っているだけなら `orca plugin dev unload <dir>` で外す）

## 版 3 の道具が入るまで
この skill は版 3（相談・依頼の帳簿・書く道具・worker の `run_id`）の形で書いてある。ワークスペースの帳簿を `cockpit-write migrate-v3` で移すまで（帳簿に `intake` が無い間）は、古い窓・パネルが新しい形を読めず、帳簿を丸ごと読めなくなる。それまでは次のとおりにする。
- `cockpit-write` が無ければ、これまでどおり一時ファイルに書いてから rename する
- `consult` のカードを書かない（相談は判断か確認で出す）。新しく作る操縦席では `template.json` の `consult` のカードを消す
- worker には受け取りの `task_id` と `dispatch_id` を書く（`run_id` も書いてよい）。続きで新しい `dispatchId` が出たら `dispatch_id` を書き換える
- `orca-launch` に `--cockpit-task` が無ければ `--title` で立て、表示名と comment を references/workers.md の形に手でそろえる
- 依頼の帳簿と仕分けは、移したあとから始める（移す手順は references/setup.md の「版 3 の欄に移す」）
