# agent-harness

Orca で複数のコーディングエージェントを並べて動かすときに、人が判断にだけ頭を使えるようにする道具の集まりです。案件ごとの窓口のエージェント（各ワークスペースのメイン）が作業を進め、人は「自分の番」のものだけを 1 か所で片付けます。

| 道具 | できること |
|---|---|
| 操縦席（`orca/plugins/cockpit`） | 全案件で自分が決める・許す・送る・見るものを、期限順の 1 列に並べる画面。押した操作は窓口に届き、迷うものは仕事の担当のチャットへ渡せる |
| orca-launch（`bin/orca-launch`） | worker（別の worktree の端末で動く Claude Code や Codex）を、呼んだエージェントと同じアカウントと worker 用の設定で立ち上げ、指示を Orca の orchestration の Task として渡す |
| stallwatch（`bin/stallwatch`） | Orca の監視外で止まったもの（Orca そのもの・各ワークスペースのメイン・操縦席の窓・launchd の定時ジョブ）を数分おきに見て、macOS の通知と操縦席の窓の上の帯に出す。モデルは呼ばない |

## 毎日の使い方

![2 枚のディスプレイでの使い方](docs/two-displays.svg)

左のディスプレイに操縦席の窓を置き、主のディスプレイに Orca を置きます。

1. 朝は窓の上の帯で全案件の「私の番」の数を見て、1 列を上から片付けます。決めるカードはおすすめを選んだ状態で開くので、よければボタンを 1 回押すだけで次のカードに進みます
2. 迷うカードは「担当と話す」を押します。カードの書き出しがクリップボードに入り、Orca でその仕事の担当のいるワークスペースが前に出るので、知らせに出たタブを開いて貼ります。決まったことは担当がカードに書き戻します
3. Slack や Teams の連絡は、見張りの Bot（このリポジトリの外）が拾って「届いた」に出し、返事が要るものは担当が「送る前」の文面にします。人はコピーして送り、「送った」を押します
4. worker の結果は「見て」に出ます。止まった worker は、窓口が書かなくても 1 列の先頭の「止まっている」に出ます
5. 夕方は右の列の報告・顧客待ち・片付いたを見て、残りを確かめます

画面の見方、カードの種類、キーボードの操作は [操縦席の README](orca/plugins/cockpit/README.md) にあります。

## 入れ方

macOS、Orca 1.4.259 以降、Node 24 以降、Python 3.9 以降を前提とします。

1. 置き場所に clone する。以下の例は `~/.config/agent-harness`
   ```sh
   git clone https://github.com/<owner>/agent-harness ~/.config/agent-harness
   ```
2. `orca-launch` を PATH に通し、worker に付ける Claude Code 設定のパスを `ORCA_WORKER_SETTINGS` に入れる（無ければ設定を付けずに起動する）
   ```sh
   ln -s ~/.config/agent-harness/bin/orca-launch ~/.local/bin/orca-launch
   export ORCA_WORKER_SETTINGS=~/.claude/settings.worker.json
   ```
3. 操縦席のプラグインをフォルダから入れる。権限の確認が出たら、表示された `--approve <fingerprint>` を付けて打ち直す
   ```sh
   orca plugin install ~/.config/agent-harness/orca/plugins/cockpit
   ```
4. 窓の常駐プロセスを launchd で動かす。`~/Library/LaunchAgents/` に置く plist の主な項目は次のとおり。窓はブラウザで `http://127.0.0.1:47231` を開いて表示する
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
   </dict>
   <key>RunAtLoad</key><true/>
   <key>KeepAlive</key><true/>
   ```
5. 見張り（stallwatch）を launchd で 5 分おきに動かす。Orca の更新や再起動でメインと一緒に止まらないよう、Orca の automations ではなく launchd に置く。PATH には orca CLI のある Orca.app の bin を入れる
   ```xml
   <key>ProgramArguments</key>
   <array>
     <string>/usr/bin/python3</string>
     <string>/Users/you/.config/agent-harness/bin/stallwatch</string>
     <string>--window-log</string><string>/Users/you/Library/Logs/cockpit-window.log</string>
     <string>--service</string><string>com.example.cockpit-window</string>
     <string>--job</string><string>com.example.nightly=/Users/you/Library/Logs/nightly.log</string>
   </array>
   <key>StartInterval</key><integer>300</integer>
   ```
   `--job` は終了コードとログの最後の行を見る（失敗した実行のあとでも launchctl が終了コード 0 を返したことがあるので、ログにだけ残った失敗も拾う）。`--service` は動いているかを見る。知らせは macOS の通知と窓の上の帯だけに出し、会話の中へは送らない（worker の完了と停止でメインを起こすのは Orca の orchestration。launchd から `orca orchestration send` を打つと送り主が決まらず断られる）

窓口のエージェントには、`.orca/cockpit.json` にカードを書かせます。ファイルの形と最小の例は [操縦席の README の「ファイルの形」](orca/plugins/cockpit/README.md#ファイルの形バージョン-2) にあります。

<details>
<summary>設定のリポジトリ（nix-darwin）から参照するとき</summary>

作者は nix-darwin（home-manager）の設定から、このリポジトリの clone を `mkOutOfStoreSymlink` で指しています。手で直した内容を switch なしですぐ使えるようにすることを優先し、次の 2 点から flake input にはしませんでした。

- flake input にすると、ファイルが読み取り専用の `/nix/store` に入る。1 行直して確かめるたびに、commit・push・`nix flake update`・switch が要る
- Orca は操縦席をフォルダから入れ、launchd は `server.ts` をそのまま動かす。どちらも書き換えられる実体のパスを指す必要がある

代わりに、home-manager の activation で clone が無いときだけ clone します。どのコミットで動いているかは clone の `git log` で分かりますが、flake.lock のようには固定されません。

```nix
home.activation.agentHarness = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
  if [ ! -e "$HOME/.config/agent-harness" ] && [[ ! -v DRY_RUN ]]; then
    ${pkgs.git}/bin/git clone https://github.com/<owner>/agent-harness "$HOME/.config/agent-harness" || true
  fi
'';
home.file.".local/bin/orca-launch".source =
  config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agent-harness/bin/orca-launch";
```

</details>

## 入っているもの

| 場所 | 中身 |
|---|---|
| `orca/plugins/cockpit/` | Orca のプラグイン（パネルと worker）と、窓の常駐プロセス（`window/server.ts`）。使い方と仕組みは同じ場所の README、画面が満たす条件は `docs/user-stories.md` |
| `bin/orca-launch`・`bin/orca_launch_test.py` | worker の起動（端末の作成・確認画面の検出・Task の受け渡し・サイドバーの表示名と状態）とそのテスト |
| `bin/stallwatch`・`bin/stallwatch_test.py` | 止まったものの見張りとそのテスト。記録先は `~/Library/Application Support/stallwatch/`（`STALLWATCH_HOME`）、見つけたものの書き出し先は窓が読む `~/Library/Application Support/cockpit/alerts.json`（`COCKPIT_DIR`） |

## テスト

```sh
(cd orca/plugins/cockpit && orca plugin test .)
python3 bin/orca_launch_test.py
python3 bin/stallwatch_test.py
```

## ライセンス

MIT（`LICENSE`）
