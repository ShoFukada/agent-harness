# セッションの開始・圧縮のあと

cockpit skill の SKILL.md から分けた手順。cwd に `.orca/cockpit.json` があるセッションの開始・再開・圧縮のあとに、ほかの作業の前に読む。窓口を Claude と Gemini で乗り換えるときは、末尾の「窓口を替える」も読む。

cwd に `.orca/cockpit.json` があれば、ほかの作業の前に次をやる（hook が「操縦席あり・未反映の操作 n 件」か「移し替えが要る」と知らせる）。

圧縮のあとは、hook が作業メモ・開いているカードと済んでいないタスク・有効な判断の原文・深田の直近の発言 10 件と、深田の最後の発言より後に Orca から届いた知らせの見出し（窓口の Run の受信箱）を流し直す。要約と食い違えば、流し直した記録を正とする。流し直す文は hook の上限に収めるため、長いと発言・決定・制約と許可と却下の順に削られ、`全文は …` の案内が付く。付いていたら、再開の確かめに答える前にそのコマンドかファイルで全文を読む（references/checks.md の「開始・再開のときに流す文が長いとき」）。知らせが並んでいたら、本文を `orca orchestration inbox --terminal run:<run_id> --full` で読み、処理したかを確かめる（要約は圧縮の直前に届いた知らせを落とす）。

1. 圧縮のあとと、引き継いだ新しいチャットでは、まず再開の確かめに答える。流し直した記録を読んだうえで、次の JSON を渡す。通るまで worker・担当への新しい指示（`orca orchestration send`・`worker-start`・`orca-launch`）は hook が止める
   ```bash
   ~/.claude/hooks/compaction-keep.py resume <ワークスペースの root> <<'JSON'
   {"next": "t3 のテストを足して dev に入れる",
    "rulings": ["R1", "R5"],
    "permissions": [{"id": "R4", "scope": "dev への反映", "allow": true}],
    "workers": ["task_808adbc9c9af"],
    "paths": ["/Users/.../claude/hooks/compaction-keep.py"]}
   JSON
   ```
   - `rulings` と `permissions` で、有効な判断の ID を漏れなく挙げる。許可・禁止は `permissions` に対象と値を記録のとおりに書く
   - `workers` は済んでいないタスクに結んだ担当・worker の最初の Task の id（`tasks[].worker.task_id`）を全部。`paths` は圧縮のときに編集の途中だったファイル（hook が求めるのは、直前の区切りで Edit したか 2 回以上 Write したもので、そのあと artifact への公開も、パスを挙げた commit も成功していないもの。1 回 Write しただけの brief は求めない）
   - hook は、撤回・置き換え済みの ID・許可の対象や値の食い違い・`next` に出てきた却下した案・落ちた worker とパスを指摘する。ID が合っても対象と値が違えば通らない。指摘の箇所を記録と操縦席で読み直して出し直す
   - 2 回続けて合わないか、窓の「記録の再読を依頼」（パネルの「前にも言った」）が 2 回押されると、hook が次の日の最初の発言を受けた時点で同じワークスペースに新しいチャットを起こして引き継ぐ（元のチャットではその発言を止め、新しいチャットに渡す）。新しいチャットは同じ組み直しを受け取り、同じ確かめに答える。窓には引き継いだことが 1 日出る
2. 判定済みの状態（SKILL.md の「状態を読む」のコマンド）・`cockpit.json`・`cockpit.user.json`・作業メモ `.orca/cockpit/state.md`・正の記録（questions.yaml・Issue・docs）を読み、食い違いを探す
3. 未反映の操作を SKILL.md の「操作を反映する」で処理する
4. 片付けて 14 日を過ぎたカードを `cockpit.archive.json`（`{ "cards": [...] }`）に移す

## 窓口を替える
窓口は、深田が Claude と Gemini（agy）のどちらでも立てられ、途中で乗り換えてもよい（R245）。操縦席・作業メモ・判断の記録・発言の記録（`.orca/` の中）はどちらの窓口も同じファイルを読む。替えるのは Orca の Run との結び付きと、窓口の種類・会話の記録だけで、それを次の道具が 1 回で行う。

1. 前の窓口: 作業メモ（`.orca/cockpit/state.md`）を今の状態に書き直してから閉じる。閉じずに残った前の窓口が発言しても、記録は新しい窓口のまま変わらず、前の窓口からの worker・担当への指示は hook が止める
2. 深田: Orca で同じワークスペースに新しい窓口を開く。Gemini は端末のタブで開く（Orca は agy をチャットで開けない）。開始の hook が、記録の窓口と違う会話に次の道具を案内する
3. 新しい窓口: 会話の中で次を 1 回打つ。Claude は `--agent` を付けない。Gemini は agy の run_command から打つ
   ```bash
   ~/.claude/hooks/compaction-keep.py switch <ワークスペースの root> --agent antigravity
   ```
   - 帳簿の `main.run_id` が指す Run を `orca orchestration run-use` で引き継ぐ。担当・worker からの知らせは同じ Run に届く
   - 窓口の種類と会話 id を `.orca/cockpit/main-session.json` に書く（窓からの質問が写す元）。帳簿の `main.agent`・`main.terminal` も書き換える
   - 受信箱を `orca orchestration check` で読み直し、届いていた知らせを出す
   - 再開の確かめを始め、組み直しの記録（作業メモ・開いているカード・有効な判断・直近の発言）と確かめの形を出す
   - 失敗すると理由を出して止まる。直してから打ち直す（打ち直しても同じ値を書き直すだけ）
4. 新しい窓口: 再開の確かめ（「セッションの開始・圧縮のあと」の 1）を `compaction-keep.py resume` で通す。通るまで worker・担当への新しい指示は hook が止める。出た知らせは処理したかを確かめる

自動の引き継ぎ（「セッションの開始・圧縮のあと」の 1 の「2 回続けて合わない」とき）も、帳簿の `main.agent` と同じ種類の窓口を起こす（Gemini なら端末のタブで、Gemini のモデルで）。起こされた窓口は、最初のメッセージの案内に従って同じ道具を打つ。

