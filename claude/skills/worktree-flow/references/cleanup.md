# 片付け

worktree-flow skillのSKILL.mdから分けた詳細。workerや担当の結果を取り込んでworktreeを消すときに読む。

片付けは3段階で行う。文章の指示だけに頼らず、ツールが書き込みを止めて取りこぼしを拾う。

| 段階 | いつ | 何が起きるか |
|---|---|---|
| 1. 取り込んだその場 | 窓口・担当がworker_doneを取り込んだとき | 下の手順でworktreeを消す |
| 2. 済にする書き込み | 操縦席のあるワークスペースで、タスクを `ok` にするとき | cockpit-writeが、workerや担当が残っていれば書き込みを断り、片付けの手順を返す |
| 3. 毎晩の見回り | 毎晩23:30（agent-harnessのbin/worktree-sweep） | 1で取りこぼしたworktreeのうち、消してよいものを消す |

## 1. 取り込んだその場で消す

1. そのworktreeを読み込み元にしたOrcaの開発用プラグイン（`orca plugin list --json` の `isDev` で、`source.reference` がそのworktreeの下にあるもの）を `orca plugin dev unload <dir>` で外す。外せなければworktreeを消さない
2. 未commitの変更がなく、defaultブランチに入っていないcommitがないことを確かめる（入っていないcommitは `git cherry -v main HEAD` に `+` がないかで確認する。squash mergeで入れたものは中身を確かめる）
3. `orca worktree rm --worktree path:<path> --delete-branch` を実行する。Orcaはmainに入ったと確認できないブランチを残すので、取り込まないと決めたブランチは `git branch -D` で消し、戻すためのSHAを報告に書く

- Orcaが自分で作ったworkerの端末は、Orcaがworker_doneを受けてから約2分後に自動で片付ける（`--keep-open` で立てたものを除く）
- orca-launchで立てたworkerの端末は、Orcaからは外の端末に見えるので、worker_doneのあとでも、`worker-stop` でも閉じない（2026-11-28に、報告を済ませたworkerの端末が `running` のまま残った）。取り込んだあとも、worker_doneを返さないworkerを止めるときも、`orca-launch --stop <Dispatch>` で止めて端末を閉じる
  - `orca-launch --stop` は `worker-stop` を呼び、Orcaが端末を閉じなかったとき（`stop_unknown: The worker terminal is external`、または報告済みの `alreadySettled`）にその端末を `terminal close` で閉じる。端末がもうなければ閉じたものとして扱う
  - 同じ端末で続きのDispatchが動いているときと、外の端末でないときは閉じず、`closed: false` と理由（`terminal_in_use`・`terminal_not_external`）を出す
- 仕事を終えた担当は、`orca orchestration worker-release --dispatch <担当の今の Dispatch>` で片付ける。worker_doneを返さずにチャットを閉じた担当（Dispatchが `ready` のまま）は `worker-stop` で止める。担当の居場所のworktreeも上の手順で消す
- stackが全部マージされる前など、worktreeを残したいときは消さずにcompletedにする（毎晩の見回りでもcompletedは消さない）

## 2. 済にする書き込みを断る条件

cockpit-writeは、タスクを `ok` にする書き込みでOrcaの今のDispatch（RunのTaskの続きとやり直しをたどった先）を読み、次の場合は書き込まず、片付けの手順を返す（R240）。

- タスクに紐づくworkerのDispatchがまだ動いている（worker_doneを返しておらず、端末も消えていない）: worker_doneを待って取り込むか、`orca-launch --stop` で止める（worker_doneのあとも、orca-launchで立てたworkerの端末は `orca-launch --stop` で閉じる）
- その書き込みで仕事のタスクが全部済になるのに、担当が開いたまま: 担当を `worker-release`（または `worker-stop`）で片付け、同じ書き込みで担当の `state` を `done` にする。`done` にした担当でも、Dispatchが動いているか、worker_doneのあとも端末が残っている（`worker-release` していない）場合は断る
- 済にしないままタスクや担当の `worker` を外したり、別の受け取りに替えたりする書き込みも、前のDispatchが動いていれば断る（記録を外してから済にしてチェックをすり抜けないようにするため）

終わったworkerの記録（タスクの `worker` 欄）は履歴として残したまま済にできる。毎晩の見回りは、この記録でworktreeと帳簿を紐づける。

## 3. 毎晩の見回り（worktree-sweep）

見回りでは `消してよい` だけを消し、取り込むか捨てるかを人が決めるもの（`判断が要る`）は窓口の開始時に【worktree】の行で出す。消してよいのは、次の条件を全部満たすworktree。

- 使ったworker・担当が終わっている: Dispatchが `succeeded`・`failed`・`stopped` などで、端末も終わっている。worker_doneを返さずに端末が `exited` になったDispatchは、窓口の帳簿（`.orca/cockpit.json`）にそのDispatch自身か、続き・やり直しの元をたどった先と紐づく行があり、紐づく行が全部済（タスクは `ok`、担当は `done`）なら終わったものとして扱う（Orcaの再起動で確かめられないだけの `unverifiable` は含めない）。または、ブランチのPRがdefaultブランチにマージ済み
- 未commitの変更がなく、defaultブランチに入っていないcommitがない（PRがマージ済みで、そのあとに積んだcommitがないものを含む）
- gitignoreされた `.env` などがルートと同じで、固有のデータ（`postgres_data` など）を持たない
- 作られてから24時間たっている

worktreeのうち、作業中やcompletedのもの、端末が生きているDispatchがあるもの、開発用プラグインの読み込み元になっているもの、会話が開いているものには触らない。

判断が要るworktreeは、案件単位で、そのworktreeの窓口（`sweep.json` の `main`。親をたどって行き当たるワークスペース）だけが扱う。`worktree-sweep` の一覧を手動で読んで出すときも `main` で絞り、別の案件の分を自分の操縦席に出さない（深田さんの指示「nix darwinはnixdarwinで出す」）。
