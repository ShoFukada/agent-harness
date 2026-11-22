# worktree に gitignore されたものをそろえる

worktree-flow skill の SKILL.md から分けた細部。worktree を作った直後に、.env や node_modules をそろえるときに読む。

- gitignore されていて worktree に付いてこないものを揃える。`.direnv` はコピーしない

```bash
mkdir -p <worktree>/.claude
cp -n .envrc .env .env.local <worktree>/ 2>/dev/null || true
cp -n .claude/settings.local.json <worktree>/.claude/ 2>/dev/null || true
(cd <worktree> && direnv allow)
```

- `node_modules` は pnpm なら `pnpm install`。npm / bun なら `cp -Rc <main>/node_modules <worktree>/` で複製してから install を 1 回走らせる（`-c` は APFS の clonefile）。symlink で共有しない（`.cache` / `.vite` / `.prisma` が書き込み先で、並列ビルドで混線する）
