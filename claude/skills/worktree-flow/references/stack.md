# stack に積む

worktree-flow skill の SKILL.md から分けた細部。1 つの機能を依存する複数の PR に分けるとき、既存の PR の上に積むとき、stack をレビューで直すときに読む。コマンドは gh-stack skill。

- 層（PR）の分け方は書き始める前に決め、worker の brief に層の一覧（下から順に、各層の範囲）を書く。分け方の基準は gh-stack skill の `references/stack-design.md`
- 1 つの stack は 1 つの worktree・1 人の worker で扱い、下の層から順に作る。層ごとに worktree や worker を分けて並列にしない（下の層が変わるたびに上の層がずれ、rebase が連鎖する）。同じ stack のブランチを他の worktree で checkout しない
- レビューで下の層を直すときは、その層を checkout して commit し、`gh stack rebase --upstack` で上の層に反映する。上の層に下の層の修正を混ぜない
- worktree のブランチを一番下の層にして `gh stack init <そのブランチ>` で取り込み、上の層は同じ worktree の中で `gh stack add <branch>` する。コマンドと非対話で叩くときの注意は gh-stack skill
- 既存の PR の上に積むときは、その worktree の worker に `orca orchestration send --to dispatch:<id>` で続きを渡す。worker がもういなければ、その worktree に `orca-launch` で立てる
- stack のマージは人間が `gh stack merge` で行う。stack が全部マージされるまで worktree を rm しない（stack のローカル状態が worktree と一緒に消える）
