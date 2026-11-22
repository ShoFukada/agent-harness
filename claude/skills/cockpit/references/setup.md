# 最初に作るときと、版 1 からの移し替え

cockpit skill の SKILL.md から分けた細部。ワークスペースに操縦席を初めて作るとき、hook が「移し替えが要る」と出したときに読む。

## 最初に作るとき
1. `template.json` を `.orca/cockpit.json` に写し、案件の docs・WBS・Issue・確認事項から埋める（`version: 2` は消さない）
   - `workspace.name` は worktree-flow skill の references/sidebar.md の案件の行の形で書く。リポジトリ名をそのまま書かない（窓のサイドバーに案件の名前として並ぶ）
2. `main` を埋める: `{"agent": "claude", "terminal": "<$ORCA_TERMINAL_HANDLE の値>"}`。Orca の端末で動いていれば環境変数 `ORCA_TERMINAL_HANDLE`（`term_…`）が自分の端末の値。無ければ `orca terminal list --worktree active --json` で `agentIdentity` が自分の種類の行の `handle` を使う。codex なら agent を `codex` にする。深田が操作して 10 秒たつと、パネルと窓はこの端末に合図の 1 行を自動で送る（作業中は送らず、入力待ちになってから送る）
   - 自分が Orca のチャット（端末ではない）で動いていて `ORCA_TERMINAL_HANDLE` も一覧の行も無いときは、`{"agent": "claude", "terminal": ""}` と空にし、下の `main.run_id` を必ず書く。窓は Orca の外のプロセスで、送り主の端末が無いと `orchestration send` を断られる（2026-11-21 に確かめた）ので、AI を動かさない郵便受けの端末（タブ名「操縦席｜郵便受け」。窓が窓口の worktree に作る）を送り主にして、深田の操作を窓口の Run に知らせる（経路の決まりは worktree-flow skill の「知らせの経路」）。`main.run_id` が無いと知らせは届かないので、深田に話しかけられたターンの最初に `cockpit.user.json` の未反映の操作を処理して拾う
   - `main.run_id` に窓口の Orca の Run の id を書く: `orca orchestration run-current --json` の `runId`。カードの相談が返しをここへ送る（references/consult.md の「カードの相談」）。`null` なら空のまま置き、返しは相談のメモから拾う
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
6. 帳簿の直書きを止める hook と、仕分けていない発言の Stop を入れる: `~/.config/nix-darwin/claude/settings.json` の `env` の `COCKPIT_LEDGER_GUARD` を `"1"` にする（次に開いたセッションから効く）。設定は全案件に共通だが、hook は移し替えの控え `.orca/cockpit.v2.json` のある案件だけで動くので、まだ移していない案件には効かない。戻すときは `"0"` に戻す

## 窓が Orca の前面に合わせて切り替わらないとき
- Orca の操縦席のプラグインが承認待ち・止まっていると、窓が Orca の前面に合わせて切り替わらない。窓の上の帯に理由が出て、hook も名指しする。承認を深田に頼む許可のカードを出す（開発用の読み込みが残っているだけなら `orca plugin dev unload <dir>` で外す）

## 版 3 の道具が入るまで
この skill は版 3（相談・依頼の帳簿・書く道具・worker の `run_id`）の形で書いてある。ワークスペースの帳簿を `cockpit-write migrate-v3` で移すまで（`.orca/cockpit.v2.json` が無い間）は、古い窓・パネルが新しい形を読めず、帳簿を丸ごと読めなくなる。それまでは次のとおりにする。
- `cockpit-write` が無ければ、これまでどおり一時ファイルに書いてから rename する
- `consult` のカードを書かない（相談は判断か確認で出す）。新しく作る操縦席では `template.json` の `consult` のカードを消す
- worker には受け取りの `task_id` と `dispatch_id` を書く（`run_id` も書いてよい）。続きで新しい `dispatchId` が出たら `dispatch_id` を書き換える
- `orca-launch` に `--cockpit-task` が無ければ `--title` で立て、表示名と comment を references/workers.md の形に手でそろえる
- 依頼の帳簿と仕分けは、移したあとから始める（移す手順は references/setup.md の「版 3 の欄に移す」）
