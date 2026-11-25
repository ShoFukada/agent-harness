# 片付け

worktree-flow skill の SKILL.md から分けた詳細。worker や担当の結果を取り込んで worktree を消すときに読む。

取り込んだら、その場で次の手順で消す。取りこぼしは agent-harness の bin/worktree-sweep が毎晩 23:30 に拾い、消してよいものは消し、取り込むか捨てるかが要るものは窓口の開始時に【worktree】の行で出す。この定期確認は、作業中・completed・dispatch が生きている・開発用プラグインの読み込み元・会話が開いている worktree には触らない。gitignore された .env などがルートと違う worktree も消さない。
判断が要る worktree は、案件単位で、その worktree の窓口（`sweep.json` の `main`。親をたどって行き当たるワークスペース）だけが扱う。`worktree-sweep` の一覧を手で読んで出すときも `main` で絞り、別の案件の分を自分の操縦席に出さない（深田さんの指示「nix darwinはnixdarwinで出す」）。

1. その worktree を読み込み元にした Orca の開発用プラグイン（`orca plugin list --json` の `isDev` で、`source.reference` がその worktree の下にあるもの）を `orca plugin dev unload <dir>` で外す。外せなければ消さない
2. 未 commit の変更が無く、default ブランチに入っていない commit が無い（`git cherry -v main HEAD` に `+` が無い。squash merge で入れたものは中身を確かめる）ことを確かめる
3. `orca worktree rm --worktree path:<path> --delete-branch`。Orca は main に入ったと確認できないブランチを残すので、取り込まないと決めたブランチは `git branch -D` で消し、戻すための SHA を報告に書く
- 終わった worker の端末は、Orca が約 2 分後に自分で片付ける（`--keep-open` で立てたものを除く）。仕事を終えた担当は、窓口が worker_done を取り込んだあとに `orca orchestration worker-release --dispatch <id>` で片付け、担当の居場所の worktree も上の手順で消す
- stack が全部マージされる前など、worktree を残したいときは消さずに completed にする（夜の定期確認でも completed は消さない）
