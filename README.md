# agent-harness

Orca で複数のコーディングエージェントを並べて動かすときの、人とエージェントのやり取りの仕組み。いまは次の 2 つが入っている。

- **操縦席**（`orca/plugins/cockpit`）: 各ワークスペースのメインのエージェントが書く `.orca/cockpit.json` を、人が決めること・顧客に聞くこと・見て承認する成果物に絞って出す画面。Orca の右のサイドバーのパネルと、別のディスプレイに置くブラウザの窓の 2 か所に出す。押した操作は `.orca/cockpit.user.json` に残り、メインが読んで反映する
- **workerctl**（`bin/workerctl`）: メインが worker（別の worktree の端末で動く Claude Code や Codex）を立てて指示を送り、止まった・質問した・許可を待っている・端末が消えた、を知らせとして受け取るコマンド。Claude Code の hook からも呼ばれ、未処理の知らせをメインに差し込む

## 2 枚のディスプレイでの使い方

![2 枚のディスプレイでの使い方](docs/two-displays.svg)

主のディスプレイに Orca を置き、メインのエージェントが worker を立てて作業を進める。左のディスプレイの上半分に操縦席の窓を置き、操縦席のある全ワークスペースの判断待ちを 1 か所で見る。窓は Orca の前面のワークスペースに合わせて切り替わる。人が窓で決めると、その操作がメインの端末に 1 行の合図として届き、メインが `cockpit.json` に反映する。

## 入っているもの

| 場所 | 中身 |
|---|---|
| `orca/plugins/cockpit/` | Orca のプラグイン（パネルと worker）と、窓の常駐のプロセス（`window/server.ts`）。仕組みは同じ場所の README、画面が満たすことは `docs/user-stories.md` |
| `bin/workerctl` | worker の一覧と知らせの記録。置き場所は `~/Library/Application Support/orca-worker-watch/`（`WORKERCTL_HOME` で差し替え） |
| `bin/workerctl_test.py` | workerctl のテスト |

## 入れ方

macOS、Orca 1.4.248 以降、Node 24 以降、Python 3.9 以降を前提にする。

1. 置き場所に clone する。以下の例は `~/.config/agent-harness`
   ```sh
   git clone https://github.com/<owner>/agent-harness ~/.config/agent-harness
   ```
2. `workerctl` を PATH に通す
   ```sh
   ln -s ~/.config/agent-harness/bin/workerctl ~/.local/bin/workerctl
   ```
3. 操縦席のプラグインをフォルダから入れる。権限の確認が出たら、表示された `--approve <fingerprint>` を付けて打ち直す
   ```sh
   orca plugin install ~/.config/agent-harness/orca/plugins/cockpit
   ```
4. 窓の常駐のプロセスを launchd で動かす。`~/Library/LaunchAgents/` に置く plist の主な欄は次のとおり
   ```xml
   <key>ProgramArguments</key>
   <array>
     <string>/path/to/node</string>
     <string>--disable-warning=ExperimentalWarning</string>
     <string>/Users/you/.config/agent-harness/orca/plugins/cockpit/window/server.ts</string>
   </array>
   <key>EnvironmentVariables</key>
   <dict>
     <!-- orca CLI を呼ぶので Orca.app の bin を入れる -->
     <key>PATH</key><string>/Applications/Orca.app/Contents/Resources/bin:/usr/bin:/bin</string>
     <!-- 話したいことへの回答で claude -p を呼ぶ。USER が無いと Keychain の認証を読めない -->
     <key>USER</key><string>you</string>
   </dict>
   <key>RunAtLoad</key><true/>
   <key>KeepAlive</key><true/>
   ```
   窓はブラウザで `http://127.0.0.1:47231` を開く
5. Claude Code の hook に workerctl をつなぐ。メインの settings.json には `workerctl hook main-pretool`（PreToolUse）・`main-context`（UserPromptSubmit と SessionStart）・`main-stop`（Stop）を、worker の settings.json には `workerctl hook worker`（Stop・UserPromptSubmit・PreToolUse の AskUserQuestion・Notification）を登録する

### 設定のリポジトリから参照するとき

作者は nix-darwin（home-manager）の設定から、このリポジトリの clone を `mkOutOfStoreSymlink` で指している。手で直した内容が switch なしですぐ使われることを優先したためで、次の 2 点で flake input にしなかった。

- flake input にすると、ファイルが読み取り専用の `/nix/store` に入る。1 行直して確かめるたびに、commit・push・`nix flake update`・switch が要る
- Orca は操縦席をフォルダから入れ、launchd は `server.ts` をそのまま動かす。どちらも書き換えられる実体のパスを指す必要がある

代わりに、home-manager の activation で clone が無いときだけ clone する。どのコミットで動いているかは clone の `git log` で分かるが、flake.lock のようには固定されない。

```nix
home.activation.agentHarness = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
  if [ ! -e "$HOME/.config/agent-harness" ] && [[ ! -v DRY_RUN ]]; then
    ${pkgs.git}/bin/git clone https://github.com/<owner>/agent-harness "$HOME/.config/agent-harness" || true
  fi
'';
home.file.".local/bin/workerctl".source =
  config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agent-harness/bin/workerctl";
```

## 操縦席の JSON の形

メインのエージェントが `.orca/cockpit.json` を書く。型の全体は `orca/plugins/cockpit/src/model.ts`、全部の欄を使った例は `orca/plugins/cockpit/fixtures/sample.json` にある。最小の例は次のとおり。

```json
{
  "version": 1,
  "workspace": { "name": "問い合わせ管理システム", "milestones": [{ "date": "2026-11-21", "label": "定例" }] },
  "main": { "agent": "claude", "terminal": "term_abc" },
  "phases": ["設計", "実装", "確認"],
  "streams": [{ "id": "s1", "title": "一覧画面", "summary": "担当者が自分の残りを一覧で見られる" }],
  "tasks": [
    { "id": "t1", "stream": "s1", "phase": "設計", "title": "一覧画面の設計", "state": "stop",
      "worker": { "worktree_id": "wt_123", "terminal": "term_def" } }
  ],
  "items": [
    { "id": "d1", "rev": 1, "kind": "dec", "title": "担当者の割り当て方を決める", "state": "open",
      "due": "2026-11-18T18:00:00+09:00",
      "related": [{ "task": "t1", "effect": "これが決まるまで止まる" }],
      "why": "11/21 の定例で画面の案を見せるには、11/18 までに決める必要がある",
      "context": { "what": "…", "now": "…", "how": "…", "gain": "…", "cost": "…" },
      "options": [
        { "id": "a", "label": "システムが自動で割り当てる", "recommended": true, "example": "30 件 → 5 人に 6 件ずつ" },
        { "id": "b", "label": "担当者が自分で取る" }
      ] }
  ],
  "requests": [
    { "id": "r1", "at": "2026-11-14T10:00:00+09:00", "title": "一覧画面の案", "quote": "定例の前に一覧画面の案を見せてほしい",
      "state": "open", "tasks": ["t1"] }
  ],
  "applied_ops": []
}
```

| 欄 | 中身 |
|---|---|
| `streams` | 大タスク（元の案件）。全体のタブの最上層に並ぶ |
| `tasks` | 大タスクの下の作業。`state` は `stop`・`run`・`wait`・`idle`・`ok`。`worker` があれば状態は Orca から取る |
| `items` | 人に返してほしいもの。`kind` は `dec`（決める）・`ask`（顧客に聞く）・`rev`（成果物を見て承認する）・`ack`（読めば済む報告） |
| `requests` | 人からの依頼の原文。タスクと成果物に結ぶ |
| `applied_ops` | メインが反映し終えた操作の `op_id` |

人が押した操作は `.orca/cockpit.user.json` に `{ "ops": [{ "op_id": 1, "at": "…", "item_id": "d1", "item_rev": 1, "type": "decide", "option_id": "a" }] }` の形で追記される。判定済みの状態は `node orca/plugins/cockpit/window/state.ts <ワークスペースの root>` で JSON として読める。

## テスト

```sh
(cd orca/plugins/cockpit && orca plugin test .)
python3 bin/workerctl_test.py
```

## ライセンス

MIT（`LICENSE`）
