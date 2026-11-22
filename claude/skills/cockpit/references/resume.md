# セッションの開始・圧縮のあと

cockpit skill の SKILL.md から分けた手順。cwd に `.orca/cockpit.json` があるセッションの開始・再開・圧縮のあとに、ほかの作業の前に読む。

cwd に `.orca/cockpit.json` があれば、ほかの作業の前に次をやる（hook が「操縦席あり・未反映の操作 n 件」か「移し替えが要る」と知らせる）。

圧縮のあとは、hook が作業メモ・開いているカードと済んでいないタスク・有効な判断の原文・深田の直近の発言 10 件と、深田の最後の発言より後に Orca から届いた知らせの見出し（窓口の Run の受信箱）を流し直す。要約と食い違えば、流し直した記録を正とする。知らせが並んでいたら、本文を `orca orchestration inbox --terminal run:<run_id> --full` で読み、処理したかを確かめる（要約は圧縮の直前に届いた知らせを落とす）。

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
