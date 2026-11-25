# サイドバーの出し方

worktree-flow skill の SKILL.md から分けた細部。worker と担当を立てる・終えるときに、Orca のサイドバーの表示名・題・状態・親子関係・comment をそろえるために読む。

人間はサイドバーの名前・状態・印で仕事を追う。操縦席の窓の全体のタブ（案件 → 仕事 → タスク → worker）と Orca のサイドバーを、同じ階層・同じ名前でそろえる（R46）。立てる・終えるたびに、いつも同じ形にする。

## 階層と題
| 階層 | 操縦席（cockpit.json） | 題の形 | Orca での名前と置き場所 | 実例（ハーネス） |
|---|---|---|---|---|
| 案件 | `workspace.name` | 「<顧客>｜<案件>」。社内の案件の顧客は「社内」（R165） | 窓口の worktree。窓口のチャットの題は「<案件の役割> 窓口」 | 社内｜ハーネス／A社｜予約管理AI |
| 仕事 | `streams[].title` | 名詞句、20 字まで | 担当がいれば担当の worktree。表示名とチャットの題は、頭に仕事の形を付けて「一緒に｜<成果物>」（一緒に作る）か「任せる｜<成果物>」（任せる）。見張る仕事のタブは「見張る｜<題>」（R163）。担当の頭は `orca-launch --lead` が仕事の形から付ける。あとで形を変えたら、同じターンで担当の表示名（`orca worktree set --display-name`）とチャットの題（`orca chat rename`）も新しい頭にする | 任せる｜窓の版3／一緒に｜操縦席の説明スライド |
| タスク | `tasks[].title`・`phase` | 名詞句、20 字まで。工程は cockpit skill の references/schema.md の `tasks[].phase` から選ぶ | worker の worktree。表示名は「作業｜<タスクの題>」。親は仕事の担当の worktree（いなければ窓口の worktree） | 作業｜協議をチャットで開く（作成） |
| worker | `tasks[].worker`（`run_id` と最初の Task の `task_id`） | 端末の題「作業｜<タスクの題>」 | worktree の comment を「<仕事の題> › <タスク id>｜<現在地>」にする | 操縦席の窓 › t69｜worker が作業中 |

- Orca のタブと worktree の名前は、頭に仕事の形（一緒に・任せる・見張る・作業）を付け、成果物の名前を続ける（R146。深田は一緒に作る仕事をよく開くので、名前で「あ、これか」と分かるようにする）。窓口は「ハーネス 窓口」のまま。20 字の上限は頭の語も含める。worker の名前が上限を超えると orca-launch が受け付けない（この上限値は、コードでは cockpit の state.ts の `NAME_MAX` だけが持つ）
- 題は、何の話かが先頭で分かる日本語の名詞句にする。管理表の番号や日付は題に入れず、仕事の `summary` に書く
- 20 字を超える仕事・担当・タスクの題、仕事に入っていないタスク、5 つの工程に無い工程名は、操縦席の hook が `checks.long_names`・`loose_tasks`・`unknown_phase` で窓口に名指しする
- 確認依頼（カード）は必ずどれかの仕事に入れる

## worker を立てるとき
操縦席のあるワークスペースの窓口は、worker を `orca-launch --cockpit-task <タスクの id>` で立てる。担当は帳簿を持たないので、SKILL.md の「worker を立てる（窓口か担当）」にある担当の書き方（`--title "<タスクの題>"`・`--run`）で立てる。

```bash
orca-launch --worktree id:<worktree id> --cockpit-task t69 --spec-file <brief>
```

- 道具がワークスペースの `.orca/cockpit.json` からタスクを引き、表示名を「作業｜<タスクの題>」に、comment を「<仕事の題> › <タスク id>｜worker が作業中」に、親の worktree を仕事の担当の worktree（いなければ窓口の worktree）にする。端末の題も「作業｜<タスクの題>」にする
- 道具は cockpit.json を書かない。受け取った `runId`・`taskId` は、窓口が `cockpit-write` （書く道具）でタスクの `worker` に書き込む（cockpit skill の references/workers.md）
- 窓口は名前を手で付けない。窓口が `--title` を使うのは操縦席の無いワークスペースのときだけ
- worker の作業段階が変わったら（判定 → 書く道具 → 窓、レビュー中、報告の前など）、comment の `｜` の後ろを書き換える: `orca worktree set --worktree path:<worktree の絶対パス> --comment "<仕事の題> › <タスク id>｜<今していること 1 行>"`。brief にもこの形を書く

## 状態と片付け
| 対象 | 形 | 誰が・いつ |
|---|---|---|
| 状態 | 作業中は in-progress。深田の確認待ちは in-review にし、同時に `--unread` で印を付ける。取り込んだら worktree を消す（残すなら completed） | `orca worktree set --worktree <selector> --workspace-status <状態> [--unread]` |
| 担当のチャットの題 | 「一緒に｜<仕事の題>」か「任せる｜<仕事の題>」 | `orca-launch --lead` が仕事の形と題から付ける |
| 窓口の題 | 「<案件の役割> 窓口」 | 窓口が自分で（`orca chat rename --name` か `orca terminal rename --title`） |
| 試し用の子 | 窓口の worktree の子 | `worktree create --parent-worktree`。試しが終わったら消す |

- 取り込み済み・使い終わった worktree を残さない（ベルの印が残り、人間にとって見づらくなる）

操縦席のあるワークスペースでは、窓のカードとサイドバーで同じ仕事が同じ名前・同じ状態で表示されるようにする。そのため、窓口がカードや仕事の状態を変えたら、判定済みの状態（`node ~/.config/agent-harness/orca/plugins/cockpit/window/state.ts <root>` の `jobs[]`）に合わせて、その仕事の担当の worktree に次のコマンドを打つ。`jobs[].orca` は仕事単位の名前と状態なので、worker の worktree には打たない（worker は上の「worker を立てるとき」の表示名のまま、comment だけを書き換える）。

```bash
orca worktree set --worktree <id> --display-name "<jobs[].orca.display_name>" --workspace-status <jobs[].orca.status> --unread   # unread が false なら --read
```

| 案件の今の状態 | `status` |
|---|---|
| 私待ち | `in-review`（未読の印を付ける） |
| 止まっている・作業中・顧客待ち | `in-progress` |
| 未着手 | `todo` |
| 済 | `completed` |

- 更新したら、ワークスペースのカードのコメントを判定済みの状態から設定する: `orca worktree set --worktree active --comment "$(node ~/.config/agent-harness/orca/plugins/cockpit/window/state.ts "$PWD" | jq -r .card)"`（例「私の番 3 件（判断 2・確認 1）・最短 11/17(火) 12:00」）
