---
name: tidy-branches
description: マージ済みのローカルブランチと git worktree を掃除するときに使う。「ブランチ片付けて」「とっ散らかってる」「worktree 掃除して」「マージ済みブランチ消して」で発動する。取り込んだ直後の worktree の片付けには使わない（worktree-flow skill）。
metadata:
  language: ja
---

# ブランチ・worktree の掃除

前提の仕組み（これが無いリポジトリでは判定できない）:

- リポジトリの `delete_branch_on_merge` が有効であること（merge が remote ブランチを消す → ローカルの upstream が `[gone]` になる、というシグナル鎖の起点。無効なら `gh api -X PATCH repos/{owner}/{repo} -f delete_branch_on_merge=true` を提案する）
- `fetch.prune` は global git config で有効化済み（fetch のたびに remote-tracking が掃除され、`[gone]` の状態が最新になる）

## 削除してよい条件（全部満たすものだけ。曖昧なら消さずに報告）

1. upstream が `[gone]`（`git fetch --prune` 直後の `git branch -vv` で判定）
2. ローカルの tip が、そのブランチを head とする**マージ済み PR の headRefOid の ancestor**である（`git merge-base --is-ancestor <tip> <mergedOid>`。= ローカルの全コミットがマージに含まれる。一致だけでなく「ローカルが PR の最終形より古い」— レビュー修正が別セッションから push された — ケースも安全に拾える。squash merge では `--merged` 判定が使えないため、これが「内容は main に入っている」ことの証明になる）
3. worktree にチェックアウトされている場合は、その worktree の `git status --short` が空

**絶対に触らないもの**: default ブランチ（main）/ upstream を持たないローカルブランチ（未 push の作業）/ locked worktree / `git status` が空でない worktree。これらは一覧にして理由付きで報告し、ユーザーに判断を任せる。

**upstream が生きているブランチも即「作業中」と断定しない**: `delete_branch_on_merge` の有効化**より前**にマージされたブランチは remote が残り続けるため、upstream 生存でもマージ済みのことがある。`gh pr list --state merged --head <branch>` でマージ済み PR が見つかり、ローカル tip と **remote の現在の tip（`git rev-parse origin/<branch>`）の両方**が条件2（ancestor）を満たすなら、remote ごと削除してよい（remote 側だけ先に進んでいれば同名ブランチが再利用されている）（`gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/<branch>"`）。見つからなければ未マージの作業として残す。

補足: 日本語などの非 ASCII パスを検索するときは `git ls-files` の八進エスケープ（core.quotepath）に注意。`git -c core.quotepath=false ls-files` で素の文字列比較ができる。「ファイルが無い」と判定する前にこれを疑う。

## 手順

```bash
git fetch --prune --quiet

# gone なブランチ一覧
git branch -vv | awk '/: gone\]/ {sub(/^[+*]? */,""); print $1}'

# 各ブランチについて: マージ済み PR の headRefOid とローカル tip を突き合わせる
gh pr list --state merged --head "$branch" --limit 1 --json headRefOid --jq '.[0].headRefOid'
git rev-parse "$branch"

# worktree に載っているブランチ（branch -vv の行頭 + が目印）は先に worktree を外す。
# Orca 管理の worktree は orca-cli skill の `orca worktree rm` で外す（生の git worktree remove は Orca 側の状態とずれる）
git -C <worktreeのパス> status --short   # 空であることを確認してから
orca worktree rm --worktree <selector>

# 条件を満たしたものだけ削除（squash merge 運用では -d は通らないので -D。
# 条件2で内容が main に入っていることは確認済み、reflog にも残る）
git branch -D "$branch"
```

## 報告の型

- 削除したブランチ数・worktree 数
- **残したものは全件、理由付きで列挙**（未 push / upstream あり / tip 不一致（マージ後のコミットあり）/ locked / dirty）。残した側にこそユーザーの判断材料がある
- tip 不一致のものは `git log <mergedOid>..<branch> --oneline` で「マージに入っていないコミット」を添える
