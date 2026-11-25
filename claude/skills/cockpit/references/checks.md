# hook が名指しするものの扱い

`claude/hooks/periodic-reminder.sh` は、深田の発言のターンと開始・再開のときに、何が何件あるかという事実だけを `【操縦席】`・`【見張り】`・`【worktree】` の行で流す。扱いはこの表が持つ（hook の文を命令の形にすると、Claude Code が hook の文を prompt injection と見て弱く扱うことがあるため）。行の頭の語で引く。検査の名前は state.ts の `checks`（references/schema.md の「state.ts の出力」）。

| 行の頭の語 | 検査 | 扱い |
|---|---|---|
| 未反映の操作 | `pending_ops` | 返答の前に SKILL.md の「操作を反映する」で反映する |
| worker が終わったのに取り込んでいないタスク | `intake` | worker の結果を確かめて取り込み、タスクの `state` を `ok` にする。続きがあるなら `orca orchestration send --to dispatch:<id>` で次を頼む |
| 催促の日を過ぎた顧客待ち | `remind_due` | 担当（無ければメイン）が催促の下書きを送信前のカードにして出す |
| 連絡を拾えていない経路 | `routes` | 見張りが止まっていないか確かめる。直せないもの（ログイン切れなど）は、深田に頼む許可か判断のカードにする |
| 仕分けていない発言 | `unsorted` | そのターンのうちに、新しい依頼・既存の依頼への追記か返答・依頼でない、のどれかに仕分けて cockpit-write で書く（references/intake.md「受付と仕分け」） |
| 状況の文が古い仕事 | `stale_status` | 次の cockpit-write で、その仕事の `status` を今の事実に合わせて書き直す。同じ文を渡し直すと書く道具が断る |
| 開いた待ちと照らしていない知らせ | `unsorted_notices` | 待ちを解くなら、そのタスクの `wait.met` に `by` として書く。解かないなら `intake.no_wait` に足して `intake.notices_through` を進める |
| 線を越えて動いていないタスク | `idle_tasks` | 止まっている理由（worker・担当の今）を確かめ、今やれるなら次の手を打つ。止めてよいのは外の理由があるときだけ（agents/common.md「判断」の「聞かずにやる」）で、そのときはタスクの `wait`（相手・出来事・日付・空き枠）か `after` を書く。深田の判断が要るなら判断のカードにする。hook は同じタスクの同じ止まりを 1 回だけ出す |
| 要素の行き先（element_map）が欠けたカード | `unmapped_elements` | 要素の番号ごとに、タスク・依頼の完了条件・結ばない理由のどれかを書き、op の取り込みと同じ書き込みで渡す（references/cards.md「承認の前に要素を固める」） |
| 証拠の無い完了条件が残る依頼 | `unproven` | 条件ごとに証拠（commit・URL・回答・操作）を結ぶ。条件を変えて済ませたなら、判断のカードに回す |
| 見直していないタスク | `affected_tasks` | タスクの完了条件を直すか判断のカードに載せ、`reviewed_for` に判断の id を足す |
| 反映していないカードの相談の返し | `unreflected_returns` | references/consult.md「カードの相談」の手順で、同じ return_id が記録と帳簿に無いかを見てから反映する |
| 帳簿の直し | `periodic-reminder.sh` の `LEDGER_FIXES` | references/schema.md で検査の名前を引き、その欄の行のとおりに直す |
| プラグインの古い写し（「orca plugin update」を含む行） | `plugin` | メインが `orca plugin update local.cockpit` を打つ。権限が増えて `approval_required` になったら、承認を深田に頼む許可のカードを出す |
| プラグインの承認待ち・止まり（それ以外の `plugin` の行） | `plugin` | 深田に Orca で操縦席のプラグインを承認してもらう許可のカードを出す（開発用の読み込みが残っているだけなら `orca plugin dev unload <dir>`）。承認は深田が選ぶ |
| 【見張り】止まっているもの | stallwatch の `alerts.json` | 原因を確かめて直す。深田にしか直せないもの（ログイン・承認）は、許可か判断のカードにして窓に出す |
| ワークスペースの root に push していない commit・変更がある（一任あり） | `push_check`・`push_delegated` | 深田の変更も含めて中身を確かめ、窓口が commit・push して報告する。許可のカードは出さない |
| ワークスペースの root に push していない commit・変更がある（一任なし） | `push_check` | 深田の変更も含めて中身を確かめ、`scope: "push"` の許可のカードにして窓に出す。深田が選んでから commit・push する（references/cards.md「push の許可」）。今回だけの許可は一任に数えない |
| 【worktree】取り込むか捨てるかの判断が要る worktree | 夜の定期確認（bin/worktree-sweep）の `sweep.json` | 取り込むか捨てるかを決める。残すなら `orca worktree set --worktree path:<path> --workspace-status completed` |
| 判断材料が欠けている判断のカード | `missing_context` | references/cards.md「判断材料（context）」の 5 欄を埋める |
| cockpit.json が版 1 のまま（移し替えが要る） | — | 未反映の操作を反映してから、references/setup.md「移し替え」の手順で移す |

## 開始・再開のときに流す文が長いとき
hook の 1 つの出力は 10,000 字までで、超えると Claude Code は先頭 2,000 字だけを渡す。そこで `compaction-keep.py` が出力を約 9,500 字に収める。削った塊には `（長い行を N 字で切った。全文は …）` か `（N 字を省いた。全文は …）` が付くので、続きを進める前に全文をそのコマンドかファイルで読む。削る順は、開始・再開では作業メモと制約を同じ順で長い行から、圧縮のあとの組み直しでは発言・決定・制約と許可と却下の順（役割・件数・作業メモ・カードと再開の確かめは最後まで残す）。
