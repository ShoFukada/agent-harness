# v0.1.0 の既知問題

公式 skill (SKILL.md と他の references) は gh-stack v0.1.0 リリース時点の内容で、
リリース後に報告された不具合は含まれていない。ここはこのリポジトリ側で足したもの。
gh-stack を更新したら、各 issue が閉じているか確認して古くなった項目を削ること。

## 終了コード 0 を成功と見なさない

`submit` / `sync` / `push` / `rebase` は失敗しても 0 を返し、成功メッセージまで出すことがある。

- 非対話の `sync` は divergence を検出すると何もせずに終了する (SKILL.md に記載あり)
- atomic push が失敗しても成功表示のまま 0 を返す ([issue #417](https://github.com/github/gh-stack/issues/417))。
  そもそも `push` はドキュメント上 atomic を謳うが実装は atomic を無効にして呼んでおり、
  複数ブランチの一部だけが反映されうる ([issue #216](https://github.com/github/gh-stack/issues/216))
- `push` は remote を解決できないと何も push せず成功表示で 0 を返す
  ([issue #412](https://github.com/github/gh-stack/issues/412))。`branch.autoSetupMerge=always`
  の環境で `git switch -c` したブランチは `branch.<name>.remote` が `.` になり該当する。
  SKILL.md の Setup にある `remote.pushDefault` の設定で防げる
- `origin` が rename 前の古いリポジトリ名を指していると、`submit` は push と PR 作成の成功を
  表示するが remote には何も作られず、表示された PR 番号も実在しない
  ([issue #461](https://github.com/github/gh-stack/issues/461))
- `rebase --upstack` は working tree が dirty で git rebase を開始できなくても「✓ Rebased」と
  表示して 0 を返し、ブランチは動いていない
  ([issue #440](https://github.com/github/gh-stack/issues/440)。main では修正済みだが v0.1.0
  リリースには未反映)。rebase 系を叩く前に `git status --short` が空であることを確認する

実行後は `gh stack view --json` と remote のブランチ SHA を確認して、意図した状態に
なっているか自分で確かめる。出力に `Sync aborted` や `⚠` があれば失敗として扱う。

## stack のブランチは単一 writer に保つ

`gh stack push` は、fetch した時点で remote にしか存在しなかったコミットを
`--force-with-lease` で巻き戻したうえ、成功扱いにすることがある
([issue #380](https://github.com/github/gh-stack/issues/380))。

単独開発でも、CI bot の自動コミット・GitHub Web UI での編集・別セッションのエージェントが
同じブランチに push していれば該当する。remote 側にだけ変更がありうるなら、push の前に
fetch して差分を確認する。

`gh stack checkout` の「Local stack matches remote」表示は保存済みメタデータ同士の比較で、
実際のローカルブランチ ref とは照合していない
([issue #413](https://github.com/github/gh-stack/issues/413))。この表示を「remote に
取りこぼしはない」の根拠にしない。

## 公開済み stack を組み替えたら push ではなく submit を使う

順序を変えた後、PR の base を更新する前に `gh stack push` すると、GitHub が空 diff を
merged と誤認して PR が復旧不能になる報告がある
([issue #411](https://github.com/github/gh-stack/issues/411))。

再構成後は途中で `push` せず、`submit --auto` でブランチの ancestry と PR base と stack を
まとめて更新する。

## `sync` が trunk に直接 push した報告がある

trunk が先行し、かつ下層を手動で rebase 済みの状態で `sync` すると、rebase ではなく merge が
走り、そのマージコミットが `origin/main` に直接 push された報告がある
([issue #442](https://github.com/github/gh-stack/issues/442))。警告なしの成功表示で、PR は
未マージのまま残る。確実な回避策は報告されていない。stack のブランチを手動で rebase して
から `sync` に任せる、という混ぜ方をしない。`sync` の後は `origin/<trunk>` の SHA が動いて
いないかも確認し、動いていたらそれ以上操作せずユーザーに報告する。

## 下層の変更は上層すべてに波及する

下層を1つ直すと、上のすべての層が cascade rebase → force-push → CI 再実行になる。
レビュー履歴も追いにくくなる ([issue #354](https://github.com/github/gh-stack/issues/354))。
揺れやすい設計判断を下層に置かない。

## `merge` の失敗を `gh pr merge` で救済しない

base PR が未マージの状態で `gh stack merge` が不明瞭なエラーで失敗した後、base PR だけを
手動でマージすると、依存 PR が force-push で rebase され、diff が変わらないのに approve が
全件 dismiss され CI も pending に戻る
([issue #446](https://github.com/github/gh-stack/issues/446))。マージは常に
`gh stack merge <PR番号|stack番号> --yes` の一括操作で下から行い、途中の PR を個別に
マージしない。

## ブランチ名を `git branch -m` で変えない

`init` 済みのブランチを `git branch -m` でリネームすると `.git/gh-stack` のメタデータが
旧名のまま残り、`view` も `checkout` もその stack を見つけられなくなる
([issue #423](https://github.com/github/gh-stack/issues/423))。改名したいときは
`unstack` → リネーム → `init` で作り直す。迷子になった後は、旧名に戻すのが最短。

## worktree 内で作った stack のローカル状態は worktree と共に消える

stack のローカル状態は `$GIT_DIR` 配下に置かれるため、worktree 内で `init` した stack は
`git worktree remove` で消える ([issue #459](https://github.com/github/gh-stack/issues/459))。
submit 済みなら `gh stack checkout <stack番号>` で復元できるが、未 submit の stack と、
remote にグルーピングが作られない単一ブランチの stack は復元手段がない。worktree を消す前に
submit 済みであることを確認する。

## push がハングして見えたら pre-push hook を疑う

`push` は hook の stdout を捨てて実行するため、対話式の pre-push hook があるとプロンプトが
表示されないまま入力待ちで止まる ([issue #420](https://github.com/github/gh-stack/issues/420))。
ハングに見えたら hook の有無を確認し (`ls .git/hooks/pre-push`、husky 等)、必要なら
`git push` を直接叩いて hook の出力を見る。

## 「Stacked PRs are not enabled for this repository」(exit 9) は権限エラーの可能性

gh に複数アカウントがログインしていて、アクティブアカウントが対象リポジトリへのアクセス権を
持たない場合も、このエラーが出る
([issue #394](https://github.com/github/gh-stack/issues/394))。exit 9 を見たら機能が無効と
断定してユーザーに報告する前に、`gh auth status` でアカウントを確認し、必要なら
`gh auth switch -u <アカウント>` して再試行する。
