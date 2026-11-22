# 見せる・マージする・片付ける

worktree-flow skill の SKILL.md から分けた手順。人間に差分を見せるとき、worker の完了を報告するとき、マージと片付けのときに読む。

- main が進んだだけでは rebase しない。rebase するのは、GitHub が PR を `CONFLICTING` と表示したときと、マージの直前に最新化が要るとき（ff-only でマージするリポジトリ、ruleset が最新化を要求するリポジトリ）だけ。stack は `gh stack sync` でまとめて main に合わせる
- 人間に差分を見せるときは `orca file open-changed --mode diff --worktree <selector>`。単一ファイルなら `orca file diff <path> --worktree <selector>`。人間に見てほしいものは、チャットにパスだけ書いて開かせず `orca file open` で Orca に開く。深田に見てほしい HTML のページ（比較・説明・報告のページ）は Artifact で公開し、伝えるときと操縦席のカードには URL を書く。手元のファイルのパスだけで渡さない（深田は手元のパスを開けない）
- worker の報告をページにするときは、外部の読み込みに頼らない 1 つの HTML ファイルにして、そのパスを worker_done に書く。公開は窓口がする（worker は公開しない。担当は一緒に作る仕事でだけ自分で公開する。roles/lead.md）
- マージは人間の承認を待つのが既定。worker が完遂したら worktree を in-review・`--unread` にし、diff を開いて報告し、そこで止まる。「マージして」と言われてから `git merge --ff-only` → 片付けまで畳む。依頼の時点で「マージまで」と明示されていた場合だけ承認を省略できる。マージを任されても、本番（prod）への反映は深田の指示を待つ
- 完了報告（worker から担当・窓口、担当から窓口、窓口から人間）には、要約より先に「確かめたコマンドとその出力」を置き、「決めたこと・置いた仮定」の一覧を付ける（読み手が、確かめた事実と推し量りを分けて読めるようにするため）。worker の brief の期待出力にもそう書く。深田が重要と言った PR には、変更の理解を確かめる 3 問を付ける（答えは `<details>` に畳む。マージの条件にはしない）
- マージの前に、その worktree の worker が止まっていること（`orca orchestration worker-show --dispatch <id>` が作業中でない、`orca worktree ps --json` の `agents[].state` が `working` でない）を確かめる。検証とレビューを済ませた commit の SHA を控えて `git merge --ff-only <その SHA>` でマージする。ブランチ名で merge すると、レビューのあとに worker が積んだ未検証の commit まで入る。マージ後は `git rev-parse main` がその SHA と一致することを読み直してから報告する
- レビュー指摘の手直しは新 worker を立てず、同じ worker に `orca orchestration send --to dispatch:<id>` で続ける
- 片付け: 取り込んだら、その worktree を消す。開発用のプラグインを外す → 未 commit と main に無い commit が無いことを確かめる → `orca worktree rm --worktree path:<path> --delete-branch`、の順で、手順の細部と担当の片付け方は [cleanup.md](cleanup.md)
- 取りこぼしは夜の見回り（agent-harness の bin/worktree-sweep、launchd で 23:30）が拾う。開始時に【worktree】の行が出たら、取り込むか捨てるかを決めて消すか completed にする。今すぐ一覧を見るなら `worktree-sweep`（`--apply` なしは一覧だけ）。溜まったブランチの掃除は tidy-branches skill
