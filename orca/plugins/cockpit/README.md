# 操縦席（cockpit）

案件の窓口のエージェント（ワークスペースのメイン）が書いた確認依頼（カード）を並べ、人が決める・許す・送る・見るをその場で返す画面です。迷うカードは「担当と話す」で、その仕事の担当のチャットへ渡します。

画面は 2 か所に出ます。

- **窓**: 左のディスプレイに置くブラウザのタブ（`http://127.0.0.1:47231`）。Orca で前面の案件 1 つを、要対応・全体・対応済みの 3 タブで出す
- **パネル**: Orca の右のサイドバー。前面の案件 1 つを期限順の 1 列で出す。Orca の下の帯にも前面の案件の「私の番 n」が出て、押すとパネルが開く

![操縦席の窓（幅 1440、架空の案件）](docs/window.png)

## 毎日の使い方

| 場面 | 見るところ | 押すもの |
|---|---|---|
| 朝に全体を見る | 窓の「要対応」。仕事ごとにまとまり、見出しに仕事の形・進み具合・担当が出る。先頭のカードの詳細が右に開いている | 右の返答のボタン。押すと次のカードが開く。`j`・`k` か「次へ」で進む |
| worker の結果を見る | 「見て」の詳細（成果物・見てほしい点・確認した結果）。行の先頭は深田さんがすること（承認・決める・送る・答える など） | 「成果物を開く」で開いて「承認」。直したいときは「直しを伝える」で文を書いて伝える（担当と話す画面も開ける） |
| 手作業を頼まれる | 「▶ 手作業」の詳細（どこで・打つコマンド・手順） | 「コピー」で写して打ち、「対応済みにする」 |
| 相談しながら作る | 「相談」の詳細（論点・担当の今の考え）。件数には入れない | 「担当と協議」。カードは要対応に残り「協議中」の札が付く |
| 一緒に作る | 一緒に作る仕事（`form: cowork`）は、カードが無くても要対応に 1 行で出る。担当が作業中なら先頭が「確認」で「共同作業中」、担当がターンを終えて返事を待っていれば先頭が「答える」で、題は担当の返事の最後の段落。全体の仕事とタスクの状態も「返事待ち（あなた）」。件数には入れない | 「担当のチャットを開く」 |
| 仕事の今を見る | 窓の「全体」。一緒に作る・任せる・見張るの形ごとに仕事の箱が並び、工程の段・タスク・worker が入れ子で出る。右に済んでいない依頼 | タスクの札（□ v89 など）で要対応のそのカードへ、「担当と話す」「端末を見る」 |
| 振り返る | 窓の「対応済み」。仕事ごと・新しい順に、返した答えと片付けた人 | 行を押すと中身。確認の返答が無いまま閉じた見てには赤い札 |

操作してから 10 秒の間は「元に戻す」が残り、窓口が受け取るまで「受け取り待ち」と出ます。

## 画面の見方

- 上の帯: 案件名、3 つのタブ（要対応の数は詰まり・許す・決める・送る前・見ての合計）、止まっている数、稼働中のエージェントの数、「読み直させる」（前に伝えたことを窓口が落としたときの合図）、明・暗・自動
- 凡例: タブごとに、見えているものの意味だけを 1 行で出す。要対応・対応済みはカードの種類、全体は仕事の形の 3 色（任せる＝青・一緒に作る＝黄土・見張る＝緑）・工程の段・タスクの点の色
- 帳簿の欄の形が違うカードは、その欄を外して表示し、上に「帳簿の欄の形の違い n 件」の 1 行を畳んで出す。読めない・繋がらないものだけを赤の帯で出す
- 必須の欄が欠けた確認依頼は窓に出さない。窓口が 30 分以内に埋めなかったものは、要対応の上に「帳簿の抜け」として出す
- 前に見たときからの変化（追加24、`src/since.ts`）: 窓が前に出たとき、描いている案件の要対応の行（鍵・版・題・タブの要対応に数えたか）とタスク（済かどうかと、題・目的・状況・放置の検出の印）を、そのブラウザの localStorage（`cockpit.seen:<案件の root>`）に控える。隠れていた窓は配信が切れていたので、前に出たあとの最初の配信で控える（配信が来なければ 2 秒後）。次に前に出ると、前の控えを比べる元に固定し、控えより後に出た要対応の行とタスクに「新規」、版か題の変わった行と中身の変わったタスクに「更新」の印を付け、上に「08:31 以降 済 n 件・新しい要対応 n 件・更新 n 件」の 1 行を出す（時刻は前の控えを取った、窓が前に出た時刻）。済はその後に済んだカード（済んだ時刻で数え、留守の間に出て済んだものも入れる）とタスク、新しい要対応はその後にタブの要対応に入った行（修正待ちから戻ったものも入れる）、更新は版か題の変わった要対応の行。0 の語は出さず、全部 0 なら帯を出さない。窓の中で案件を切り替えると、その案件も見たことにする。描いていない案件は控えない（見ていない案件の変化を既読にしない）。控えは帳簿にも常駐のプロセスにも書かない（見たかどうかは人と端末ごとに違うため、ブラウザごとに持つ）。控えの無いブラウザ（初めて開いた・保存できない）では印も帯も出さない。窓口や担当がカードを書き直すと版が上がるので「更新」が付く

幅 900 未満では、一覧と詳細を縦に並べます。パネルは版 2 の 1 列のままで、色・期限の出し方・ボタンは窓にそろえます（期限は文字色で、赤は期限切れだけ）。幅 760 未満では上の 1 段の切り替えで「私の番」と「案件の今・待ち」を出し分けます。

## カード

| 種類 | いつ出るか | 押すもの | 件数 |
|---|---|---|---|
| 停止 | 担当が質問・許可待ち・停止（Orca の状態からも作る） | 担当と協議・チャットか端末を開く・対応済みにする（Orca から作ったもの） | 数える |
| 許可 | push・本番・データの変更の前。手作業（switch・承認・ログイン）を頼むときは `manual` | 許可する・この案件では一任する・却下。`manual` があれば 対応済みにする・担当と協議 | 数える |
| 判断 | 設計・要件・費用・言い方が分かれる | 推奨案で決定・この案で決定・別の回答 | 数える |
| 送信前 | 顧客か社内へ出す文面ができた | コピーしてスレッドを開く・送信済みにする・担当と修正を協議・送信しない | 数える |
| 確認 | 任せた仕事の出来上がり | 承認する・修正点を記入・担当と修正を協議 | 数える |
| 相談 | 案がまだ分かれていない。担当が詰めたい（`issue`・`stance`・`known`・`undecided`） | 担当と話す | 数えない |
| 受信 | 顧客の連絡が拾われた。窓では全体の「見張る」に出す | 担当と協議・返信不要 | 数えない |
| 報告 | エージェントが決めた・済ませた。要対応の下の「報告（参照のみ）」 | 戻させる・既読にする | 数えない |

止まった問いは、「誰が・何を聞いているか」を停止の 1 行に出し、詳細に本文と選択肢を出します。

| 止まり方 | 本文の取り方 | 出すまで | 押すと前に出すもの |
|---|---|---|---|
| 端末の AskUserQuestion | 端末の画面の末尾（`orca terminal read --screen`）。Orca の道具の欄には問いが入らない | すぐ | その端末 |
| 許可の確認 | Orca の道具の欄（`toolName`・`toolInput`） | すぐ | その端末かチャット |
| orchestration の question（窓口宛て） | inbox の `payload.question`・`options`（無ければ件名と本文） | 5 分答えが無ければ | 窓口の端末かチャット |
| orchestration の question（担当宛て） | 同上 | 30 分答えが無ければ | 担当の端末かチャット |

チャットの AskUserQuestion は本文を読めないので、「読めませんでした」と出します。question は、thread に返事が付いたとき・聞いた側がそのあと何か送ったとき・聞いた worker が終わったときに消え、窓口が問いのあとに同じタスクのカードを書いたらカードのほうだけを出します。

版 2 の開いた `talk` は、読み込みのときに相談として読みます（論点に `next`、担当の考えに `last`）。「担当と協議」を押したカードは要対応に残り、「協議中」の札が付きます。数える種類なら数えたままです。担当のいない帳簿のカードは、窓が `consult --card <root> <カード id>`（場所は `COCKPIT_CONSULT_CMD`、既定は `~/.config/nix-darwin/claude/bin/consult`）でカードの相談のタブを立て、`talk` の操作の `terminal` にタブの handle を残します。consult が Orca のチャット画面で相談を立てたときの handle は `orca_session_id:<id>` で、生死は `orca agent show` の `result.places` が空でないかで見ます（consult の `live_chats` と同じ。閉じたと分かったチャットは問い合わせ直さず、確かめられなければ閉じたと言い切りません）。タブやチャットが Orca から消えると「協議中」は外れます。consult が失敗したら、理由を知らせて窓口に回します。全体のタブの仕事の協議は相談に分けません。カードの詳細には、相談のメモ（`.orca/consult/<カード id>.md`）へのリンクと、メモの「窓口に返したもの」から決まったことを出します。

### 窓から質問する
全体のタブの右の欄・カードの詳細・タスクの詳細に質問の欄があります（設計 11 章、R105・R166）。全体のタブの右の欄は、上の切り替え「タスクの詳細｜案件への質問」で、選んだタスク・見張る仕事の詳細と、案件全体の質問の欄とやりとりを切り替えます。タスクを選んでいなければ案件への質問を出し、タスクか見張る仕事を選ぶと（要対応の「タスクの詳細を開く」からも）タスクの詳細に戻します。カード・タスクの詳細は、質問が無ければ「このカードについて質問する」などのボタンだけを出します。「送る」を押すと、まず判断の記録（`.orca/cockpit/rulings.jsonl`）から撤回・置き換え（`supersedes` の配列）されていない判断を語の一致で引き（`state.ts` の `matchRulings`。埋め込みや LLM は使わない）、当たれば原文・番号・日時をすぐ出します。「それでも窓口の写しに聞く」か、当たらなかったときは、窓が質問 id（`ask<数>`。控えと返しの記録の最大の数に 1 を足す）を採って `consult --ask <root> <質問 id> [--on-card <カード>] [--on-task <タスク>] --question=<文>` を呼び、窓口の会話を写した相手（窓口の写し）を窓口の worktree のタブに立てます。採った id は consult が戻るまで予約の札（`.orca/consult/.ask-<質問 id>.reserved`）を排他で作って押さえ、同じ案件を開く 2 つの常駐のプロセスが同じ id を採らないようにします。質問の中の、控えの節の見出しと同じ形の行（`### 答え 09:00` など）は 1 字下げて送ります（hook が本文をそのまま控えに書くため）。続きは同じ質問 id で送ります（開いているタブに consult が送る）。前の質問の答えが控えに届くまでは、窓でも常駐のプロセスでも続きを送らせません。

答えは hook が書く控え（`.orca/consult/ask-<質問 id>.md`）から出し、答えの頭に写した窓口の会話の時点を出します。答えと見張る仕事の出力は Markdown として描きます（`src/markdown.ts`、R167。依存は足さない）。描くのは見出し（窓の見出しより下の段にする）・表・太字・箇条書き（番号付きも）・引用・区切り線・行内と囲みのコード・リンクで、本文は先にエスケープし、生の HTML は文字のまま出します。リンクは http・https だけを押せるボタンにし、ほか（`javascript:` など）は文字だけを残します。閉じたコードフェンスの中の `### 答え` の行は節にしません。consult が端末を立てられずに頭だけ残した控えは、この窓で待っているもの以外は出しません。返しの記録（`ask-<質問 id>.returns.jsonl`）の決まったことには、帳簿の `asks[]` から「窓口が反映済み」「窓口が保留」「窓口の反映待ち」「担当へ未通知」の札を付けます。

窓口に返す（設計の語では「これで決める」）入口は、最後の質問より後の答えにだけ出します。答えの末尾に写しが書いた `【選べる案】` の行（`- A: 題`、推しは末尾に `（推し）`。2〜5行）があれば、案ごとに「Aで返す」のボタンと題（推しは語で「推し」）を並べます（`model.ts` の `askChoices`。答えの中で最後の印から続く、この形の行だけを読み、閉じたコードフェンスの中は読みません。文章から案を推し量りません）。会話の下の入力欄は1つで、「続けて聞く」と「書いたことを窓口に返す」のボタンで分けます。「Aで返す」は `案 A で。` と書いて返したのと同じです。

押すと先に `ask_decide` の操作（`item_id: "#ask:<質問 id>"`・`item_rev: 0`・`answer: { at, head, n }`。nは控えの中の答えの通番。選んだ案は `choice`、書いた文は `text`）を書き、題「質問｜<案件名>｜<質問 id>」で探したタブに、深田さんの言葉と、改行して `【相談の知らせ】返しを書いて（op <op_id>）` を1回の入力で送ります（`server.ts` の `askMessage`）。hook（`claude/hooks/compaction-keep.py`）は先頭が知らせで始まる入力を発言として残さないので、言葉を先に置きます。hookは言葉を `ask` 付きの発言と控えの質問の節に残し、末尾の知らせの行は外します。写しは言葉を返しの `quote` と `utterance` に引きます。記録するときはログのロックの中で控えを読み直し、答えが変わっていれば（言葉が控えに入って答え待ちになったときも）409で断り、答えに無い案も409で断ります。同じ答えに同じ返し方（同じ案・同じ文）の取り消されていない記録があれば、足さず知らせも送りません。違う案・違う文は新しいopにします。`choice` も `text` も無い前の形のopもそのまま読み、知らせだけを送ります。返した言葉が控えの最後の質問になったら、返した答えを畳まずに開いたまま、その下に「Aで返した」の行を出します。答えを待つあいだは入力欄を出しません。`ask_decide` は返しが届いてから窓口が反映するので、窓口の本線に自動の合図は送りません（`pending_ops` には数えます）。

タブは `orca terminal list --worktree path:<root> --include-visual-layouts` の `visualLayouts` のタブ名で探します。Orcaを開き直したあと、画面がまだそのworktreeを開いていないと `visualLayouts` にそのworktreeが出ないので、そのときだけ `terminals[]` の同じworktreeの端末の題で探します（`server.ts` の `tabsOf`。端末の題は中のプログラムが書き換えうるので、layoutsがあればそちらだけを見ます）。題はどちらも完全一致です。

知らせを届けたopは窓の置き場所の `asksent.json`（案件ごとの op_id の並び）に覚えます。届けられなかったとき（タブが見つからない・送るのに失敗した）は、「窓口に返す記録はしました。写しの会話に届けられなかったので、届けられるようになったら窓が送り直します」と理由を出し、常駐のプロセスが1分ごとの見回りで送り直します。送り直すのは、`unreflected_returns` の「返し」の行（取り消されておらず、`applied_ops` に無く、返しの記録にそのopの返しが無い）のうち `asksent.json` に無く、返した答えが今も最後の答えのopだけです。会話が先に進んだあとに `案 A で。` を届けると、相手が新しい答えの案と取り違えるので送らず、窓口が控えから拾います（質問の行に「写しに届いていません・会話が先に進んだので窓口が控えから拾います」と出します）。届いていないopがある質問で「続けて聞く」を押すと、続きより先にそのopを届け、届けたら続きは送らずに、その答えを待ってから聞くよう理由を返します。タブが閉じて届けられなければ、続きを送ってconsultにタブを立て直させます（そのopは会話が先に進んだものになります）。同じ案件の処理の順番に並べ、送る直前に控え・返し・操作と届けた記録を読み直します。質問の行には、押した答えの状態を「写しにまだ届いていません・届けられるようになったら窓が送り直します」「写しに届けました・返し待ち」「窓口の反映待ち」（返しが届いた）「窓口が反映済み」の語で出します（届けた記録を読めない窓は「写しからの返し待ち」）。

質問のタブは、窓から送った直後も続けて聞いた直後も前に出しません（R172。答えは窓の右の欄で読む）。前に出すのは「写しの会話を開く」を押したときだけです。

答えの済んだ質問のタブは、窓の常駐のプロセスが自動で閉じます（R180）。閉じるのは、返しが全部帳簿と判断の記録に反映され（`unreflected_returns` に無い）、返しの無い「この答えを窓口に返す」が無く、最後の質問に答えが届き、控えの最後の書き込みから1時間たった質問のタブだけです（`state.ts` の `settledAsks` と控えの更新時刻）。閉じる対象は、その案件のworktreeの題「質問｜<案件名>｜<質問 id>」のタブにある、窓が `consult --ask` で新しく立てた端末（窓の置き場所の `asktabs.json` に覚えたhandle）に限り、同じ題で人が開いたタブや、記録の無い前からのタブは閉じません。タブを `terminals[]` の題で探したとき（画面がまだworktreeを開いていないとき）も同じ照合で、Orcaを開き直してhandleが変わった端末は閉じません。そのときは題が見つからなくても、端末の題が書き換わっただけかもしれないので、次の回にもう一度見ます。窓のブラウザが開いていなくても1分ごとにOrcaから案件を読んで見ます。窓から聞く・続けて聞く・窓口に返す処理と同じ案件ごとの順番に並べ、閉じる直前に控え・返し・操作を読み直します。控えと返しの記録は消さず、続きを聞けばconsultが立て直します。閉じたあとの質問の行は「写しの会話は閉じています。続けて聞くと、窓口の今の会話から写し直します」に戻ります。

欄の下書き・当たり・待ちは案件ごと（鍵は `<root>#whole`・`<root>#card:<id>`・`<root>#task:<id>`・`<root>#id:<質問 id>`）に持ち、案件を切り替えても前の案件のものを出しません。窓は質問の道具を常駐の起動（`import.meta.main`）だけで渡し、試験は偽の道具で受けます。

「確認」などのカードの「直しを伝える」は、書いた文を本文つきの `talk` の操作（`text` に原文）として記録します。カードは件数から外れて「修正依頼済み（受領待ち）」、窓口が受け取ると「修正待ち」になり、直したものを窓口が書き換えて `rev` を上げると要対応に戻ります。

送信前の「本文をコピー」「コピーしてスレッドを開く」は、宛先の書式で本文をクリップボードに入れます。書式の変換と書き込みは reply-draft の `clip-draft`（`~/.local/bin/clip-draft`、`COCKPIT_CLIP_DRAFT` で差し替え）に任せ、窓は常駐のプロセス、パネルはworkerから呼びます（`src/clip.ts`）。

| 宛先 | 決め方 | クリップボードに入るもの |
|---|---|---|
| Slack | `draft.format: "slack"`、無ければ `via` か `href` のホストにSlack | Markdownのテキストのまま |
| Teams | `draft.format: "teams"`、無ければ `via` か `href` のホストにTeams | HTML（pandocで変換）とテキストの両方 |
| メール | `draft.format: "mail"`、無ければ `via` に「メール」・mail・Outlookか、`href` がmailtoかメールのホスト | テキスト。先頭の「件名: 」行は本文から外し、件名を知らせに出す |

押すとまず素の文字列を入れてスレッドを開き始め（ブラウザとOrcaが押した操作の中でしか許さないため）、書式の決まる宛先はそのあと `clip-draft` が書式つきで上書きします。決まらない宛先（LINEなど）は素の文字列のままです。`clip-draft` が失敗したときはクリップボードの中身を確かめられない（空にしてから書くため）ので、知らせに理由を出し、もう一度押すと素の文字列だけを入れ直します。書式に変換している間は次のコピーを受けません。見本の文面は `fixtures/drafts.ts`、中身の固定は `src/clip.test.ts`。

コピーの前に、本文を宛先の書式で検査します（書く道具と同じ dev-standards の `draft-format-lint`。`src/lint.ts`）。窓の常駐のプロセスとパネルのworkerが、状態を作るときに閉じていないカードの文面を検査して `drafts`（カードid → 書式と違反）に載せ、結果は書式と本文の組みで覚えます（同じ文面にはCLIを呼び直さない。検査できなかった結果は1分で捨てる）。違反のある文面・検査の結果が無い文面・検査できなかった文面は、ボタンを押しても素の本文を含めて何も入れず、知らせに理由を出します（押し直しても入れない）。違反はカードの文面の下に「書式の確認」として、行番号・該当の行・直し方・規則を出します。書式の決まらない宛先（LINEなど）は検査しません。

見て（`review`）のカードに `draft`（`{ to, via?, text, format }`）を持たせると、詳細に「コピーの見本」と「Slackの書式でコピー」「Teamsの書式でコピー」「メールの書式でコピー」の3つのボタンが出ます。貼った先で崩れないかを確かめるためのもので、押したボタンの書式で同じ `clip-draft` を通します（`href` は見ず、スレッドは開きません）。書式の検査は、押したボタンの書式ではなくカードの書式（`format`、無ければ `via`・`href` から推したもの）で行います（メールの書式で写すときにMarkdownの記号を外すのは `clip-draft` の役目）。見てのカードの成果物は `href` か `draft.text` のどちらかで足ります。

手作業を頼む「許す」は `manual: { "where": "どこで", "command": "打つコマンド", "steps": ["手順"], "check": "済ませたあと窓口が確かめること" }` を書きます。

カードには種類ごとに必須の欄があります（共通: どの仕事の話か・何のため・なぜ今か期限・返事が無いとき・出典。`src/model.ts` の `missingFields`）。欠けたカードは窓にもパネルにも出さず、`checks.incomplete_cards` で窓口に名指しします。

決める・見てのカードは、承認を求める要素を `elements: [{ "n": 1, "text": "…" }]` で持てます。「承認する」を取り込む前に、窓口は全部の要素の行き先を `element_map: [{ "n": 1, "task": "t12" } | { "n": 2, "request": "r30#1" } | { "n": 3, "skip": "理由" }]` に書きます（書く道具が欠けた番号を返して断る）。

![カードの移り変わり](docs/card-states.svg)

## キーボード

| キー | 動き |
|---|---|
| `j`・`k` | 次・前のカードを開く（窓は要対応の上から） |
| `1`〜`9` | 選択肢を選ぶ |
| `Enter` | 選んだ選択肢で決める（おすすめを選んだままの状態では決めない。続けて押して 2 枚決めてしまわないように） |
| `t` | 担当と話す |
| `u` | 最後の操作を元に戻す |
| `Esc` | カードを閉じる（窓の要対応では先頭のカードに戻る） |

## 窓ではできないこと

- 担当のチャットのタブそのものを前に出すこと。Orca に既存のチャットを前に出す手段が無いので、チャットのあるワークスペースを前に出し、知らせにタブの名前を出す
- 「18 時まで本番も任せる」のような期限つきの任せ方。窓口が期限を持つ形が決まっていない
- 今日終わるはずの仕事が動いていないことの検知。終わる見込みをデータに持っていない

画面が満たす条件と、採らなかった案は [docs/user-stories.md](docs/user-stories.md) にあります。

## 仕組み

ここから下は、窓口のエージェントを作る人と、このプラグインを直す人向けです。

### 窓口とのやり取り

![窓口と窓のやり取り](docs/loop.svg)

窓口が `.orca/cockpit.json` にカードを書き、窓とパネルが読んで出します。人の操作は `.orca/cockpit.user.json` に追記され、窓口には中身を送らず `【操縦席】未反映の操作があります` の 1 行だけを送ります。窓口は操作を読んで `cockpit.json` に反映し、反映し終えた操作の `op_id` を `applied_ops` に書きます。

カードの今の状態は、`cockpit.json` の `state` に操作ログを重ねて決めます（`src/model.ts` の `overlay`）。窓口がカードを書き換えてバージョン（`rev`）が上がると、古いバージョンへの操作は反映されず、カードはもう一度私の番に出ます。

### ファイルの形（version 2 のまま欄を足した版 3）

型の全体は `src/model.ts`、全部の種類のカードを使った例は `fixtures/sample.ts` にあります。最小の例は次のとおりです。

```json
{
  "version": 2,
  "workspace": { "name": "問い合わせ管理システム", "milestones": [{ "date": "2026-11-24", "label": "定例" }] },
  "main": { "agent": "claude", "terminal": "term_abc" },
  "streams": [{ "id": "s1", "title": "一覧画面の改修", "form": "delegate" }],
  "tasks": [
    { "id": "t1", "stream": "s1", "phase": "実装", "title": "並べ替えと絞り込み", "state": "open",
      "worker": { "run_id": "run_123", "task_id": "task_456" } }
  ],
  "owners": [{ "id": "o1", "title": "一覧画面の改修", "stream": "s1", "agent": "claude", "session": "sess_789" }],
  "cards": [
    { "id": "d1", "rev": 1, "kind": "decide", "state": "open", "stream": "s1",
      "title": "担当者の割り当て方を決める", "due": "2026-11-22T18:00:00+09:00",
      "purpose": "定例で画面の案を見せられる",
      "options": [
        { "id": "a", "label": "システムが自動で割り当てる", "recommended": true, "example": "30 件 → 5 人に 6 件ずつ" },
        { "id": "b", "label": "担当者が自分で取る" }
      ] }
  ],
  "requests": [
    { "id": "r1", "at": "2026-11-21T09:00:00+09:00", "title": "一覧に並べ替えを足す", "kind": "work", "tasks": ["t1"],
      "utterances": [{ "id": "u-12", "quote": "一覧に並べ替えを足して" }], "done_when": ["並べ替えが PR でマージされる"] }
  ],
  "intake": { "through": "u-12", "none": [] },
  "applied_ops": []
}
```

| 欄 | 中身 |
|---|---|
| `streams` | 仕事（大タスク）。担当のチャットは仕事ごとに 1 つまで。`form` は仕事の形（`delegate` 任せる・`cowork` 一緒に作る・`watch` 見張る）。無ければ `checks.no_form` に出る |
| `tasks` | 仕事の下の作業。`state` は `stop`・`run`・`wait`・`idle`・`ok`。`worker` は Orca の orchestration の受け取りの `run_id`・`task_id`。窓は Run の Task の続き（follow_up_of）をたどって今の Dispatch を引き、状態をその様子から取る（版 2 の `dispatch_id` も読む）。`reviewed_for` は見直した判断の id |
| `owners` | 仕事の担当（Orca のチャットか端末）。カードの「担当と話す」の相手。チャットは `session`（orcaSessionId）、端末は `terminal`（`term_…`）。担当の無い仕事のカードは窓口と話す |
| `routes` | 連絡を拾う経路（Slack・Teams・メール）と、見張りが読んだ時刻。古いと「見ていない」に出る |
| `cards` | 人に返してほしいもの。`kind` は `stuck`・`permit`・`decide`・`send`・`review`・`consult`・`inbox`・`report`（版 2 の `talk` も読む）。`request` は依頼の原文、`request_id` は帳簿の依頼の id |
| `requests` | 依頼の帳簿。`utterances`（発言の記録の id と引用）か `source`（`session`・`at`・`quote`）、`done_when`（済の条件 1〜3）、`kind`、`evidence`（`{ when, kind, ref }`、`when` は済の条件の 1 始まりの番号）。済は `state` を書かず、証拠から `src/state.ts` が決める。`legacy` は移し替えの時点にあった行の印 |
| `intake` | 発言の仕分けの位置（`through` までの発言は依頼か `none` に結んである）。相談・質問の返しで決まった発言は、その返しを判断の記録（`from_return`）か依頼（`from_return`）に入れれば仕分け済みとみなす。仕分けていない発言は、30分を過ぎると窓の上に「窓口の未処理: 発言の仕分けn件（30分超過）」の1行で出る |
| `applied_ops` | 窓口が反映し終えた操作の `op_id` |

帳簿は Write・Edit で書かず、下の「書く道具」を通します。人の操作は `.orca/cockpit.user.json` に `{ "ops": [{ "op_id": 1, "at": "…", "item_id": "d1", "item_rev": 1, "type": "decide", "option_id": "a" }] }` の形で追記されます。窓と同じ判定済みの状態は `node window/state.ts <ワークスペースの root>` で JSON として読めます。hook と窓口はこの出力の `overview`・`mine`・`jobs`・`tasks`（`from` と今の Dispatch の `dispatch`）・`checks` を読みます。`checks` の版 3 の検査は `incomplete_cards`・`incomplete_requests`・`unsorted`・`stale_tasks`・`loose_tasks`・`unknown_phase`・`no_form`・`unmapped_elements`・`unproven`・`affected_tasks`・`unreflected_returns`（相談のメモにあって判断の記録の `from_return` か帳簿のカードの `from_returns` に無い返しと、カードの `held_returns` に残る返し。`compaction-keep.py unreflected` と同じ判定）・`stale_consults`（カードが片付いたのに Orca に残る相談のタブとチャット）・`stale_status`（状況の文の元の事実が控えと違う仕事 `{ id, changes }`。R204）・`unsorted_notices`（開いた待ちがあるのに仕分けていない知らせ。R204）です。`unreflected_returns` には窓からの質問の分も `ask` 付きで並びます（`{ id: return_id, ask, missing, memo, returns, tasks? }` と、返しの無い「これで決める」 `{ id: null, ask, op, missing: ['返し'], memo }`。`compaction-keep.py unreflected` の `unreflected_asks` と同じ判定）。

### 書く道具（cockpit-write）

```sh
bin/cockpit-write <root> < change.json            # 検査して書く（一時ファイルに書いて rename）
bin/cockpit-write --dry-run <root> < change.json  # 書かずに検査だけ（ロックファイルも作らない）
bin/cockpit-write migrate-v3 [<root>] [--write]   # 版 3 へ移す（--write が無ければ結果を出すだけ）
bin/cockpit-write migrate-facts [<root>] [--write]  # 待ちと済を事実から決める形へ移す（R204。--write が無ければ意味の変わる行を出すだけ。元は cockpit.v3.json）
bin/cockpit-write init <root> < cockpit.json      # 操縦席を初めて作る（帳簿が既にあれば断る。--dry-run は検査だけ）
```

- 変更は `{ "cards": [...], "tasks": [...], "requests": [...], "streams": [...], "owners": [...], "intake": {...}, "applied_ops": [...], "unaffected": ["t5"], "main": { "run_id": "run_..." }, "asks": [...], "workspace": { "name": "顧客｜案件" } }` を id 単位で足すか置き換える。全体を置き換える入口は無い。`main` は窓口の Run（`run_id`）だけを置き換える（agent・terminal は今の値を保つ）。Run の無い帳簿は書けない（窓の合図は窓口の Run にだけ送る。R191）ので、消すことはできず、無い帳簿には Run を一緒に書く。カードの `from_returns`・`held_returns`（相談の返しの `return_id`）は `rev` を上げずに書ける。依頼の `from_return` も受ける
- 案件の名前（R165）: `workspace` は `name` だけを置き換える（milestones は今の値を保つ）。「顧客｜案件」の形（`src/state.ts` の `workspaceNameOk`）に合わない名前は、`checks.workspace_name` と同じ 1 文で断る。移した帳簿に形の外れた名前が残っていれば、ほかの書き込みは止めずに注意で名指しする。`intake` を初めて付ける書き込み（版 3 への移し替えに当たる）は、名前が外れていれば断る
- init: 版・案件の名前の形・`main.run_id`・読み込みの形の誤りと、タスクを普通の書き込みと同じ検査（待ちの書き方・言い回し・worker の形など）にかけ、通ったものだけを `.orca/cockpit.json` に書く。migrate-v3 の `--write` と版 1 からの移し替え（`window/migrate.ts --write`）も、案件の名前が形から外れていれば書かずに断る
- `asks` は窓からの質問の返しを反映した印（`{ id: "ask3", card?, task?, memo?, from_returns: ["ask3-1"], held_returns: [], notify: [{ return_id, task?, message_id? }] }`）を質問 id ごとに足すか置き換える。返しの id はその質問のもの（`ask3-<数>`）だけを受ける
- 検査: 欄の形・参照（仕事・タスク・担当・依頼の id）・`rev`（開いたカードの中身を変えたら 1 上げる。片付けるだけ・要素の行き先を書くだけなら据え置き）・依頼の欄・仕分けの位置・要素の行き先。通らなければ書かずに理由を返す
- 語調: カードとタスクと仕事の人が読む欄（title・purpose・why・next・`last.text`・`look_for`・`options` の label と body・タスクの `done`・`wait` の文・仕事の `status` など）に柔らかい言い回し（ておきました・ですね・ますね・ですよね・かも・しちゃ・ちゃいました・ちゃった）があれば、欄と語を名指しして断る（R84）。draft・quote・request・reason・`background.quote`・深田さんの `last`（by が 私）と、元の行にそのままある文は見ない
- 送る文面の書式（R161・R162）: 開いたカードの `draft`（送る前・決める・見てを問わない）のうち、新しい・開き直した・本文か宛先（`format`・`via`・`href`）を変えたものは、次を通したものだけを書く。返しの反映（`from_returns`・`held_returns`）・片付け・ほかの欄だけの書き換えは、前からある文面（`format` の無い版や決まりより前の書き方）でも止めない
  - `draft.format`（`slack`・`teams`・`mail`）が要る。無ければ、`via`・`href` から推した候補を添えて断る
  - `via`（優先）と `href`（補完）から推した宛先と `format` が食い違えば断る（`format` が `mail` で `via` が Slack など）。推せない経路（LINE・GitHub の Issue など）は `format` をそのまま使う
  - 本文を dev-standards の `draft-format-lint --json`（既定は `~/.claude/plugins/marketplaces/medurance-dev-standards/scripts/draft-format-lint`、`COCKPIT_DRAFT_LINT` で差し替え）で `format` の書式として検査し、違反があればカード・行番号・規則・該当の行・直し方を名指しして断る。決まりと規則は dev-standards（`rules/docs/message-formats.md`）だけが持つ
  - CLI が無い・起動できない・出力が読めないときは、その文面を含む変更を断る（fail closed）。検査は `window/write.ts` が行い、`applyChange` には結果を渡す
- タスクの形（R204）: `state` は `open` か `ok` だけ。古い欄（`status`・`waiting_on`・`waiting_since`・`check_on`）は廃止の文で断る（読み込みは古い帳簿を補って読む）。止まり・待ち・未着手は `src/state.ts` の `judgeTasks` が事実から決める
  - `wait` は種類ごとに要る欄（person: who・what、event: what、date: on・what、slot: why）がそろったものだけ。`who` の深田さんと、文の中のカードの id は断る（カードの `tasks` から決まる）
  - `wait.met[].by` の発言（`u-…`）・知らせ（`n-…`）・操作（`op:…`）は記録に在るものだけ。`after` は在るタスクだけで、自分は指せない
  - 済のタスクに `wait` と新しい `next` は書けない（残りの確認は別のタスク）
  - `wait` の文が日付・期間だけ（`12月`・`12/4`・`来週`・`月末まで` など）なら断る。日付で確かめるなら `kind: date` の `on` と `what` に書く
  - 待つタスク（`wait` のある `open`）の `wait.who`・`wait.what`・`wait.why`・`next` を `~/.claude/hooks/defer-guard.py --text`（`COCKPIT_DEFER_GUARD` で差し替え）にかけ、都合での先送りの言い回しが当たれば断る。元から待っていた行の同じ文は見ない。言い回しの判定は defer-guard.py だけが持つ。無い・起動できない・期限切れ・0 と 1 以外で終わったときは、その文を含む変更を断る（fail closed）
- 事実に追いつかない書き込み（R204。`facts_since` のある帳簿だけ）:
  - 状況の文: 書いたあとの帳簿で、仕事の元の事実（`streamBasis`）が控え（`status_basis`）と違う仕事は、同じ書き込みで行を渡して `status` を書き直す。前に控えがあれば、前と同じ文は断る。控えは道具が押す
  - 済にしたら見直す: 新しく済になったタスクがあれば、同じ仕事の開いたタスクと、`after`・`next`・`goal` で指す開いたタスクを、直して渡すか `unaffected` に並べる
  - 仕分けと待ち: 開いた person・event の待ちがあるあいだに `intake.through`・`intake.notices_through` を進めるなら、またいだ発言・知らせを `wait.met[].by` で指すか `intake.no_wait` に入れる
- migrate-facts: タスクを読み込みと同じ規則で読み替え、残りの確認らしい `next` を持つ済のタスクの `next` を空にし、`facts_since` を書く。カードは触らず、`status_basis` は押さない（移したあとの最初の書き込みで、窓口が全部の仕事の status を照合して渡す）。元は `cockpit.v3.json` に控える
- 必須の欄が欠けたカードは書くが、注意で名指しする（窓には出ない）
- migrate-v3: 開いた `talk` を `consult` に、`created_at` を `at` に写し、worker に `run_id` を補う。今ある依頼に `legacy` を付け、タスクとカードが全部済で深田さんの返答が残るものだけ済にし、ほかは窓口が仕分ける一覧に出す。閉じたカードの `resolved_at` を補い（`resolved_at_inferred`）、深田さんの操作の無いまま閉じた見てに `closed_without_review` を付ける。元は `cockpit.v2.json` に控える
- 台帳の取り込み: 取り込む依頼を `{ "requests": [...] }` の変更にして、`--dry-run` で通ることを確かめてから書く。既存の依頼と同じ件はその id で置き換え、`legacy` を外して `utterances` か `source`・`done_when` を足す

### 構成

| ファイル | 役割 |
|---|---|
| `src/model.ts` | ファイルの形（バージョン 2）と、cockpit.json に操作ログを重ねる処理 |
| `src/migrate.ts` | バージョン 1（`items`）からバージョン 2（`cards`）への移し替え |
| `src/state.ts` | 期限の区切り・私の番の 1 列・案件の今・話す相手・Orca のサイドバーの状態をまとめて決める。画面と `window/state.ts` はここを通す |
| `src/store.ts` | `.orca/` のファイルを読む・操作を追記する（バージョンと選択肢を確かめる）・窓口への合図を組む。パネルの worker と窓の常駐プロセスが共有する |
| `window/mail.ts` | 郵便受けの端末から窓口の Run に送る口。窓と `bin/cockpit-mail` が使う |
| `src/view.ts` | パネルの描画（表示の状態から HTML を作る。DOM に触らない）と、窓と共有する部品 |
| `src/window-view.ts` | 窓の 3 タブ（要対応・全体・対応済み）の描画 |
| `src/write.ts`・`window/write.ts`・`bin/cockpit-write` | 帳簿を書く道具と、版 3 への移し替え（migrate-v3） |
| `src/lint.ts` | 送る文面の書式の検査（dev-standards の `draft-format-lint` を呼ぶ）。書く道具・窓の常駐プロセス・パネルの worker が使う |
| `src/style.ts` | CSS（明暗のトークン、container query で 1440・760 未満・520 未満を切り替える） |
| `src/controller.ts` | クリックやキーボード入力を操作につなぐ。パネルと窓のページが共有する |
| `src/worker.ts` | パネルの worker。前面のワークスペースのファイルを見張ってパネルに送り、下の帯を更新し、前面が変わるたびに `focus.json` を書く |
| `src/panel.ts` | パネル（controller の送り先を worker にする） |
| `window/server.ts` | 窓の常駐プロセス（launchd） |
| `window/page.ts` | 窓のページ（controller の送り先を常駐プロセスにする） |
| `window/migrate.ts` | 移し替えのコマンド |
| `window/state.ts` | 判定済みの状態を JSON で出すコマンド |
| `window/orca-state.ts` | `orca worktree ps`・`terminal list`・`orchestration worker-show`・`task-list`・`dispatch-show` からメイン・worker・worktree と、タスクの今の Dispatch を決める |
| `fixtures/sample.ts`・`fixtures/demo.ts` | 架空の 4 案件の見本と、偽の Orca で窓を手元で動かす道具 |

<details>
<summary>移し替え（バージョン 1 → バージョン 2）</summary>

```sh
node window/migrate.ts <ワークスペースの root>          # 移した結果を出すだけ
node window/migrate.ts <ワークスペースの root> --write  # 書き換える
```

- 未反映の操作が残っていれば書かずに断る。先に窓口に反映させる
- 元のファイルは `cockpit.v1.json`・`cockpit.archive.v1.json` に残す
- `dec` は中身で分ける（`topic: push` は「許す」、`draft` があれば「送る前」、ほかは「決める」）。`ask` は「送る前」、`rev` は「見て」、`ack` は「報告」。どのカードも `rev` を 1 つ上げるので、古いバージョンへの操作は通らない
- `tasks[].worker` は orchestration の形（`{ task_id, dispatch_id }`）だけを写す。workerctl の頃の形（`{ worktree_id, terminal }`）は指す先が無いので外し、済んでいないタスクの id を結果に出す（続けるなら立て直して書く）
- `summary`・`cockpit.talk.json` は移さない（依頼の `deliverables` は残す）。窓はバージョン 1 のファイルを読まず、移し替えのコマンドを添えて断る

</details>

<details>
<summary>Orca のサイドバーとそろえる</summary>

窓のカードと Orca のサイドバーで、同じ仕事が同じ名前・同じ状態で出るようにします。`node window/state.ts <root>` の `jobs[].orca` に、仕事ごとの表示名（20 字まで）・状態・未読の印が出るので、窓口はそれに合わせて `orca worktree set --display-name / --workspace-status / --unread` を打ちます。

| 案件の今 | Orca の状態 |
|---|---|
| 私待ち | `in-review`（未読の印を付ける） |
| 止まっている・作業中・顧客待ち | `in-progress` |
| 未着手 | `todo` |
| 済 | `completed`（取り込んだら消す） |

タブと作業場所の名前は、頭に仕事の形を付けて成果物の名前を続けます（R146）。一緒に作る仕事と担当は `一緒に｜<題>`、任せるは `任せる｜<題>`、見張るは `見張る｜<題>`、worker は `作業｜<題>`（`bin/orca-launch` が付ける）、形の無い仕事の担当は `<題>（担当）`、窓口は `窓口（<案件の役割>）` です。`jobs[].orca.display_name` もこの形で出ます。「担当と話す」の知らせは、この名前でタブを案内します。頭の語も含めて `NAME_MAX`（`src/state.ts`）を超える名前は `checks.long_names` に出ます。orca-launch は同じ `WORKER_HEAD`・`NAME_MAX` を state.ts から読み、超える名前では worker を立てずに断ります。

</details>

<details>
<summary>窓の常駐プロセスと Orca の状態</summary>

```
Orca ──workspace.changed / agent.status.changed──▶ パネルの worker
                                                     │ focus.json（前面のパス・メインの端末・エージェントの変化の時刻）
                                                     ▼  ~/Library/Application Support/cockpit/
   各ワークスペースの .orca/ ──fs.watch──▶ 常駐のプロセス（127.0.0.1:47231）──SSE──▶ 窓のページ
                                          │  orca worktree ps / terminal list / agent list / orchestration worker-show
                                          └─ 操作の追記・orca orchestration send（郵便受けから窓口の Run へ）/ terminal send（質問のタブへ）/ switch / worktree activate / file open
```

- 起動は launchd などの常駐の仕組みに任せる。ブラウザ向けの TS は、配るときに Node の `module.stripTypeScriptTypes` で型を除く。ビルドの手順は無い。配るのは `window/server.ts` の `SERVED` に書いたファイルだけ
- 窓は前面の案件だけを描き、操縦席の無いワークスペースは並べない。読めていない連絡の経路（`routes`）は全体の「見張る」に出す
- worker の記録: 窓口が担当や worker を Orca の orchestration で立てたら、タスクの `worker` に受け取った `run_id`・`task_id` を書く（`bin/orca-launch --cockpit-task <task id>` で立てると、題・comment・親の worktree をタスクから決め、依頼の済の条件と、依頼に結んだ深田さんの発言の原文（`utterances.jsonl` の全文。「深田（u-12）:」のラベル付き、新しい順に 8000 字まで）を brief に足す）。窓は Run の Task の続きをたどって今の Dispatch を引き、`orca orchestration worker-show --dispatch <id> --full` で様子を読む。Dispatch の端末で worker とタスクを結ぶ。worker_done を返したら取り込み待ち、起動できない・落ちた・人の確認待ちは詰まり、Orca に無ければ「Orca に見つからない」の詰まりになる
- Orca の監視外で止まったもの（`bin/stallwatch` が書く `alerts.json`）は、窓の上にエラーの行で出す
- 前面のワークスペースは、パネルの worker が書く `focus.json` を見張って取る（ポーリングしない）
- Orca を呼ぶのは窓が表示されている間だけで、(1) 接続したとき、(2) `focus.json` にあるエージェントの変化時刻が変わったとき（5 秒に 1 回まで）、(3) 60 秒ごと
- 止まった worker は詰まりのカードになる。題は「「仕事の名前」が許可待ち」の形で、窓口が書いた詰まりと同じ仕事（タスクか担当の端末）なら重ねて出さない。許可待ち・返事待ちは「答えれば進む」、落ちた・ログイン切れは「私では直せない」と分ける

メモリ（2026-11-16 に測った値）: 常駐プロセスは窓 1 枚が接続して 60 秒ごとに確かめている状態で物理フットプリント 51〜61 MB（RSS 75〜95 MB）、窓 1 枚（Chrome のアプリ表示）で増える renderer は 35 MB。常駐プロセスのメモリの大半は、Node が `.ts` を読むときに読み込まれる型除去の WebAssembly です。

</details>

<details>
<summary>窓口への合図</summary>

窓口には、端末の窓口にもチャットの窓口にも、帳簿の `main.run_id` の Run への orchestration の知らせ 1 本で送ります（R191）。件名は `【操縦席】未反映の操作があります`、本文の頭に「<案件名> の操縦席の窓から: <合図の 1 行>」を置き、「担当と話す」「別の答え」「直してほしい」（見ての直しの指示）はカードの id と本文の頭を載せ、書いた文の全文を続けます。

- 送るのは窓の常駐のプロセスだけ。パネルは host API しか持たず Run に送れないので送らない
- 取り消しの猶予（10 秒）が過ぎたら送る。窓口が作業中でも待たない（Orca が窓口の手の空いたときに届ける）。どこまで送ったかは `~/Library/Application Support/cockpit/notified.json` に案件ごとに持つ
- 窓は Orca の外のプロセスなので、送り手の端末が無いと Orca が断る（`no_active_sender_terminal`）。窓は AI を動かさない「郵便受け」の端末（題「操縦席｜郵便受け」、`tail -f /dev/null`）を 1 つ持ち、それを `--from` にする。handle は `~/Library/Application Support/cockpit/mailbox.json` に控え、消えていれば作り直す
- 送り口は `window/mail.ts` の 1 か所。Orca の外のほかのプロセス（`bin/stallwatch` など）は `bin/cockpit-mail <root> --subject <件名> [--body-file <path|->]` で同じ郵便受けから送る
- 帳簿に `main.run_id` が無いと送れないので、cockpit-write は Run の無い帳簿を断る。送れなかったときは、窓の上の赤い帯に案件名と理由と「もう一度送る」を出す

</details>

<details>
<summary>読み直させる（前にも言った）・引き継ぎ</summary>

- 窓とパネルの上の帯に「読み直させる」（パネルは「前にも言った」）がある。押すと、カードを持たない `repeat`（`item_id` は空）を追記する。前に伝えたことを窓口が落としたという合図で、窓口の hook が押した回数を数え、新しいチャットへの引き継ぎに使う
- hook が引き継いだときに書く `.orca/cockpit/handoff.json`（`at`・`reason`）を読み、1 日だけ「窓口を新しいチャットに引き継ぎました」と出す

</details>

<details>
<summary>成果物と資料を開く</summary>

`href`・`links` は種類の印（Drive・PR・Slack・ページ・ファイル）を付けたボタンで出します。

- http(s) の URL: 窓は常駐プロセスが macOS の `open` で既定のブラウザに渡す（http と https 以外は断る）。パネルは Orca の `shell.openExternal` で開く
- ファイル: ワークスペースからの相対パスと、本線の子 worktree 内にある絶対パスだけを開く。`path:行` は窓では `orca file open --line` でその行を開く
- 一時フォルダ（`/tmp`・`/private/tmp`・`/var/folders`）のファイルを指す「見て」「報告」のカードは、`window/state.ts` の `checks.local_deliverables` に出る。窓口は artifact にして URL で渡し直す

</details>

<details>
<summary>セキュリティ</summary>

- 待ち受けは 127.0.0.1 だけ。Host が `127.0.0.1:<port>`・`localhost:<port>` 以外の要求は断る（DNS rebinding）
- 書き込みと送信（`/api/*`）は、起動のたびに作るトークン（配るページにだけ埋める）と Origin の両方が合うものだけ受ける。SSE もトークンが要る
- スマホからは `tailscale serve`（tailnetの中だけ。Funnelは使わない）で開く。serveは元のHostのまま127.0.0.1に繋ぐので、環境変数 `COCKPIT_TAILNET_HOSTS`（カンマ区切りの `ホスト名[:ポート]`）に入れた名前だけをHostとして、`https://<名前>` だけをOriginとして足す。空なら今までどおり。tailnetの端末は誰でもページ（とトークン）を受け取れるので、tailnetに他の人の端末を入れない。スマホから押した「開く」「端末に切り替え」はMacの上で動く
- 読むファイルは `.orca/` の中だけで、`..` とシンボリックリンクで外へ出るものは読まない（`src/store.ts` の `readInOrca`）。開くファイルもワークスペースの中だけ
- figure の SVG は、パネルと同じように script・外部参照・イベント属性を取り除いてから描く

</details>

### 書体

IBM Plex Sans JP（Mac に入れておく）を第一に、無ければヒラギノを使います。パネルは Orca のサンドボックスで Web フォントを読めないので、Mac に入れた書体を名前で指定します。

### 開発

```sh
orca plugin test .          # model・migrate・state・view・worker と、窓の常駐のプロセスのテスト
orca plugin check . && orca plugin validate .
COCKPIT_PORT=47299 node --disable-warning=ExperimentalWarning fixtures/demo.ts $TMPDIR/ckdemo   # 架空の 4 案件で窓を手元で動かす
node window/state.ts <ワークスペースの root>   # hook と窓口が読む判定済みの状態
```

- `orca plugin dev load .` は本物の `local.cockpit` を置き換える。worktree で触るときは、上のテストと別のポートの窓で確かめ、読み込んだら報告の前に `orca plugin dev unload <dir>` で外す
- `local.cockpit` が承認待ち・止まっている・開発用に置き換わっているときは、窓の上の帯に理由を出す（`window/orca-state.ts` の `pluginProblem`）
- HTML パネルは `orca plugin shot --act` で操作できないので、操作の流れは窓のページ（同じ controller）をブラウザで確かめる
- worker と窓の常駐プロセスのテストは `fs.watch` を使う。ファイルの見張りを止める sandbox の中では EMFILE で落ちるので、sandbox の外で回す
