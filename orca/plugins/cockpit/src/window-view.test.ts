import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { answerParts, parseCockpit, STAGES, stageOf, type DraftFormat } from './model.ts'
import type { ClipResult, CockpitView } from './protocol.ts'
import { copyDraft, copyMessage, copyTarget } from './controller.ts'
import { boardsOf, dropRulings, newUi, render, SENT_LABEL, tighten, type Model, type Ui } from './view.ts'
import { CSS } from './style.ts'
import { renderWindow, stagesHtml, taskOrder, todoOrder } from './window-view.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

function aoba(edit: (v: CockpitView) => void = () => {}): Model {
  const w = sample(NOW)[0]!
  const v: CockpitView = { state: 'ok', root: '/ws/aoba', cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }
  edit(v)
  return { boards: boardsOf([v], NOW), focused: '/ws/aoba', unseen: [], errors: [] }
}
const page = (m: Model, over: Partial<Ui> = {}) => {
  const ui = { ...newUi(), ...over }
  ui.sel ??= todoOrder(m.boards[0])[0]
  return renderWindow(m, ui, NOW, (s) => s)
}

test('要対応: 仕事ごとにまとめ、先頭の詳細を右に開く。届いたは出さず、相談は見出しで別に数え、「件数外」の札は付けない（初見 12）', () => {
  const m = aoba()
  const h = page(m)
  const t = text(h)
  assert.match(h, /data-tab="todo" aria-selected="true">要対応<span class="n">3<\/span>/)
  assert.ok(!/data-sel="\/ws\/aoba#i3"/.test(h), '届いたは要対応に出さない')
  assert.doesNotMatch(h, /件数外/)
  assert.match(h, /class="wdet k-/)
  assert.match(t, /配車画面の改修|AWS 構成案/)
})

test('見てほしい点の「1 …」の番号は一覧の番号にし（二重にしない）、続かない数字の文は一覧の下に添える', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.find((x) => x.id === 'r5')!.look_for = ['1 一覧の幅', '2「担当と話す」の位置', '6 点ともおすすめなら「これでよい」']
  })
  const h = page(m, { sel: '/ws/aoba#r5' })
  assert.match(h, /<li value="1">一覧の幅<\/li><li value="2">「担当と話す」の位置<\/li><\/ol><p class="mut">6 点ともおすすめなら「これでよい」<\/p>/)
})

test('全体: 一緒に作る → 任せる → 形の無い仕事（進行中の仕事） → 見張る の順に置き（仕事を先に）、見張るに届いた連絡を並べる。右に未対応の一覧を出さない（R91）', () => {
  const m = aoba((v) => {
    const s = v.cockpit!.streams
    s[0]!.form = 'delegate'
    s[1]!.form = 'cowork'
    s[2]!.form = 'watch'
    v.cockpit!.requests = [{ id: 'r1', at: '2026-11-21T09:00:00+09:00', title: '配車画面を直す', tasks: ['t1'], legacy: true }]
  })
  const t = text(page(m, { tab: 'whole' }))
  const order = ['一緒に作る 話しながら', '任せる 任せている', '進行中の仕事 1 件', '見張る 届いたもの'].map((x) => t.indexOf(x))
  assert.ok(order.every((n) => n >= 0), t)
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.match(t, /届いた連絡 1 件/)
  assert.doesNotMatch(t, /件数外/, '意味の伝わらない語は出さない（初見 12）')
  assert.doesNotMatch(t, /未完了の依頼/)
})

test('全体: タスクを押すと右に詳細（工程・状態・goal・next・done・worker・結ばれたカード・依頼の原文と済の条件・出した指示）を出し、その箱を開く', () => {
  const m = aoba((v) => {
    const t1 = v.cockpit!.tasks.find((x) => x.id === 't1')!
    t1.goal = '配車の一覧で探す手間を減らす'
    t1.done = ['並べ替えを入れた']
    v.cockpit!.cards.find((x) => x.id === 'r5')!.tasks = ['t1']
    v.cockpit!.requests = [{ id: 'q7', at: '2026-11-21T09:00:00+09:00', title: '一覧を直す', tasks: ['t1'], kind: 'work', utterances: [{ id: 'u1', quote: '一覧で探しにくい' }], done_when: ['並べ替えができる', '絞り込みができる'] }]
    v.workers = [{ terminalId: 'term_w', title: '一覧の改修（worker）', agent: 'claude', state: 'working', since: NOW, task: 't1', where: 'テストを直している' }]
    v.log.ops.push({ op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'r5', item_rev: 1, type: 'talk', text: '幅を 1280 でも崩れないように' })
  })
  const h = page(m, { tab: 'whole', task: 't1' })
  // j・k と何も選んでいないときの順は、箱を全部開いたときの画面の上からの順と同じ。
  const all = page(m, { tab: 'whole', open: { 's:s1': true, 's:s2': true, 's:s3': true } })
  assert.deepEqual(taskOrder(m.boards[0]), [...all.matchAll(/data-task="(\w+)"/g)].map((x) => x[1]))
  const side = h.slice(h.indexOf('aria-label="タスクの詳細"'))
  const t = text(side)
  assert.match(h, /class="task"><button type="button" class="tsel" data-task="t1" aria-current="true"/)
  assert.match(h, /data-toggle="s:s1" aria-expanded="true"/)
  for (const x of ['作業中 工程 調査 ・ 決定 ・ 作成 ・ 確認 ・ 反映', '何のため 配車の一覧で探す手間を減らす', '済の条件 並べ替えができる 絞り込みができる', '次にやること レビューの指摘を直して stg に出す', '済んだこと 並べ替えを入れた', '一覧の改修（worker）', '今: テストを直している', '一覧で探しにくい'])
    assert.ok(t.includes(x), x)
  assert.match(side, /data-jump="\/ws\/aoba#r5"/)
  assert.match(side, /<span class="cb" role="img" aria-label="未"><\/span>並べ替えができる/)
  // 番号は一覧の行に出さず、詳細の下に小さく置く（初見 2）。
  assert.doesNotMatch(all, /class="id"/)
  assert.match(side, /<p class="rid">番号<code>t1<\/code><\/p>/)
  assert.match(t, /出した指示 .*r5 修正を依頼 未反映 幅を 1280 でも崩れないように/)
  assert.doesNotMatch(h, /data-rq=/)
})

test('出した指示: カードの詳細に、本文と時刻を新しい順に出し、反映済み・未反映を分ける。取り消した操作は出さない', () => {
  const m = aoba((v) => {
    v.log.ops.push(
      { op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'd21', item_rev: 1, type: 'talk' },
      { op_id: 3, at: '2026-11-21T09:50:00+09:00', item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'draw' },
      { op_id: 4, at: '2026-11-21T09:50:05+09:00', item_id: 'd21', item_rev: 1, type: 'undo', undo_of: 3 },
      { op_id: 5, at: '2026-11-21T09:55:00+09:00', item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other', text: '社内向けは別の図にする' })
  })
  const closed = text(page(m, { tab: 'done', doneSel: '/ws/aoba#d21' }))
  assert.match(closed, /出した指示 11\/21\(土\) 09:55 別の回答 未反映 社内向けは別の図にする 11\/21\(土\) 09:40 協議を開始 未反映/)
  assert.doesNotMatch(closed, /図に社内向けの入口を描き足す 未反映/)
  // 窓口が反映した操作（applied_ops）は反映済み。
  assert.match(text(page(aoba(), { tab: 'done', doneSel: '/ws/aoba#d19' })), /出した指示 .* 決定: 議題だけテキストで送る 反映済み/)
})

test('相談: カードの詳細に相談のメモへのリンクと、新しい返しから決まったことを 3 件まで出し、窓口が帳簿に入れたか・保留かを札で分ける', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.find((x) => x.id === 'd21')!.from_returns = ['d21-1']
    v.cockpit!.cards.find((x) => x.id === 'd21')!.held_returns = ['d21-3']
    v.consults = [
      { card: 'd21', path: '/ws/aoba/.orca/consult/d21.md', returns: [
        { return_id: 'd21-1', decisions: [{ text: '入口は 1 つにする' }, { text: '古い決定' }] },
        { return_id: 'd21-2', choice: 'draw', decisions: [{ text: '社内向けは別の図にする' }] },
        { return_id: 'd21-3', decisions: [] }
      ] },
      { card: 'c4', path: '/ws/aoba/.orca/consult/c4.md', returns: [] }
    ]
  })
  const d21 = page(m, { sel: '/ws/aoba#d21' })
  const label = m.boards[0]!.v.cockpit!.cards.find((x) => x.id === 'd21')!.options!.find((o) => o.id === 'draw')!.label
  assert.ok(text(d21).includes(`これまでに決まったこと 選んだ案: ${label} 未反映 社内向けは別の図にする 未反映 入口は 1 つにする 反映済み ファイル 相談のメモ`), text(d21))
  assert.doesNotMatch(text(d21), /古い決定/)
  assert.match(d21, /data-file="\/ws\/aoba\/\.orca\/consult\/d21\.md"/)
  const c4 = text(page(m, { sel: '/ws/aoba#c4' }))
  assert.match(c4, /相談のメモ/)
  assert.doesNotMatch(c4, /これまでに決まったこと/)
  assert.doesNotMatch(text(page(m, { sel: '/ws/aoba#r5' })), /相談のメモ/)
})

test('Codex 13-6: 表示の 14 日を過ぎた済んだカードも、タスクの詳細の出した指示から対応済みのタブで開ける', () => {
  const m = aoba((v) => {
    const d19 = v.cockpit!.cards.find((x) => x.id === 'd19')!
    d19.tasks = ['t1']
    d19.resolved_at = new Date(NOW - 20 * 86_400_000).toISOString()
  })
  assert.ok(!m.boards[0]!.d.closed.some((r) => r.card.id === 'd19'), '対応済みの一覧には出さない')
  const side = page(m, { tab: 'whole', task: 't1' })
  assert.match(side, /<button type="button" class="code" data-jump="\/ws\/aoba#d19">d19<\/button>/)
  const done = page(m, { tab: 'done', doneSel: '/ws/aoba#d19' })
  assert.match(text(done.slice(done.indexOf('aria-label="詳細"'))), /定例の資料は作らず、議題だけテキストで送る/)
})

test('対応済み: 確認の返答が無いまま閉じた見てに札を付け、詳細に返した答えと片付けた人を出す', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.push({ id: 'v9', rev: 1, kind: 'review', state: 'done', title: '窓口が閉じた見て', resolved_at: '2026-11-21T09:30:00+09:00', closed_without_review: true })
  })
  const h = page(m, { tab: 'done', doneSel: '/ws/aoba#v9' })
  assert.match(h, /data-dsel="\/ws\/aoba#v9"[\s\S]*?確認なしで閉じた/)
  assert.match(text(h), /担当が完了 11\/21\(土\) 09:30・確認の返答なし/)
})

test('窓口の未処理: 30 分を過ぎた未仕分けの発言は 1 件ずつ並べず件数の 1 行にし、返しで反映された発言は数えない（追加 32）', () => {
  const said = (i: number) => ({ id: `u${i}`, at: new Date(NOW - (60 + i) * 60_000).toISOString(), prompt: `発言の本文 ${i}` })
  const m = aoba((v) => {
    v.cockpit!.intake = { through: 'u0' }
    v.utterances = Array.from({ length: 14 }, (_, i) => said(i))
    v.returned = ['u12', 'u13']
  })
  const h = page(m)
  assert.match(h, /<div class="wnotes" role="status"><b>窓口の未処理<\/b>発言の仕分け 12 件（30 分超過）<span class="by">窓口が対応します（操作は不要）<\/span><\/div>/)
  assert.doesNotMatch(h, /発言の本文/)
  assert.doesNotMatch(h, /帳簿の未記入/)
  assert.match(page(m, { tab: 'whole' }), /<b>窓口の未処理<\/b>発言の仕分け 12 件/)
})

test('欄の形の違いの知らせは 1 行に畳み、読めない・繋がらない知らせだけを赤の帯に出す', () => {
  const m = aoba((v) => {
    v.errors = ['cockpit.json のカード v1「x」の evidence の形が違うので、その欄を出さずに表示しています']
  })
  m.errors = ['常駐のプロセスに繋がりません']
  const h = page(m)
  assert.match(h, /<div class="werrs" role="alert"><div>常駐のプロセスに繋がりません<\/div><\/div>/)
  assert.match(h, /<div class="wnotes" role="status"><b>窓口の未処理<\/b>帳簿の形式不備 1 件<span class="by">窓口が対応します（操作は不要）<\/span><\/div>/)
  assert.doesNotMatch(h, /evidence/)
  const panel = render({ ...m, panel: true }, newUi(), NOW, (x) => x)
  assert.match(panel, /<div class="chores" role="status"><b>窓口の未処理<\/b>帳簿の形式不備 1 件<span class="by">窓口が対応します（操作は不要）<\/span><\/div>/)
  assert.doesNotMatch(panel, /evidence/)
  // 仕事の見出しには工程 n/5（5 段で固定）と今の段の名前を出し、凡例の帯は出さない（R82）。
  assert.match(h, /<span class="stg"><span class="stg-all"><span class="sd">調査<\/span><span class="sep">・<\/span><b class="sc">決定<\/b><span class="sep">・<\/span><span class="sn">作成<\/span>/)
  assert.doesNotMatch(h, /class="keyline"/)
})

test('Codex v3 1: 送る文面と手作業の場所・手順は表示でも空白を詰めない（コピーする値と画面を食い違わせない）', () => {
  const draft = tighten(page(aoba((v) => { v.cockpit!.cards.find((c) => c.id === 'd22')!.draft!.text = 'cd 資料 を 開く' }), { sel: '/ws/aoba#d22' }))
  assert.match(draft, /<div class="msg">cd 資料 を 開く<\/div>/)
  const manual = tighten(page(aoba((v) => {
    v.cockpit!.cards.find((c) => c.id === 'd22')!.manual = { where: '/tmp/資料 A', command: 'cd 資料', steps: ['Finder で 資料 A を開く'], check: '開けた 2 件を確かめる' }
  }), { sel: '/ws/aoba#d22' }))
  assert.match(manual, /<div class="verb">\/tmp\/資料 A<\/div>/)
  assert.match(manual, /<pre class="msg code">cd 資料<\/pre>/)
  assert.match(manual, /<li>Finder で 資料 A を開く<\/li>/)
  // 利用者がそのまま使う値でない欄（済ませたあと）は詰める。
  assert.match(manual, /開けた2件を確かめる/)
})

test('Codex v3 2: 段に寄せられない工程名の未完了タスクがあれば、今の段も済んだ段も出さず「工程の外あり」', () => {
  const h = page(aoba((v) => {
    v.cockpit!.tasks.push({ id: 't9', stream: 's1', phase: '受入', title: '受け入れ', state: 'run' }, { id: 't10', stream: 's1', phase: 'push', title: '出す', state: 'idle' })
  }))
  const head = h.slice(h.indexOf('<b>配車画面の改修</b>'), h.indexOf('</div>', h.indexOf('<b>配車画面の改修</b>')))
  assert.match(head, /工程の外あり/)
  assert.doesNotMatch(head, /pp on|pp cur|5\/5/)
})

test('Codex v3 3: タスクが全部済でもカードが残る仕事は「タスク完了・確認待ち」。「全工程 完了」は仕事が済のときだけ', () => {
  const h = page(aoba())
  const head = h.slice(h.indexOf('<b>定例と議事録</b>'), h.indexOf('</div>', h.indexOf('<b>定例と議事録</b>')))
  assert.match(head, /タスク完了・確認待ち/)
  assert.doesNotMatch(head, /全工程 完了/)
  const whole = page(aoba((v) => { for (const c of v.cockpit!.cards) if (c.stream === 's4') c.state = 'done' }), { tab: 'whole', open: { done: true } })
  const box = whole.slice(whole.indexOf('定例と議事録'))
  assert.match(box.slice(0, box.indexOf('data-talkstream')), /<span class="pbar"[^>]*>全工程 完了<\/span>/)
})

test('Codex v3 4・5: 属性の値の中の > でタグを切らず、コピーのあとの知らせは今の「送った」ボタンの名前を案内する', () => {
  assert.equal(tighten('<div title="x > 資料 A">文 A</div>'), '<div title="x > 資料 A">文A</div>')
  assert.match(page(aoba(), { sel: '/ws/aoba#d22' }), new RegExp(`data-act="sent"[^>]*>${SENT_LABEL}<`))
  assert.match(copyMessage({ opened: true }), new RegExp(`「${SENT_LABEL}」を押して`))
})

test('追加 20: コピーは素の文字列とスレッドを押したその場で始め、書式の決まる宛先だけ clip-draft で上書きする', async () => {
  const run = async (d: Parameters<typeof copyDraft>[0], o: { clip?: ClipResult | Error; write?: Error; plainOnly?: boolean } = {}) => {
    const log: string[] = []
    const said: string[] = []
    const t = {
      openUrl: async (url: string) => (log.push(`open ${url}`), { opened: true }),
      clip: async (text: string, format: DraftFormat) => {
        log.push(`clip ${format}`)
        if (o.clip instanceof Error) throw o.clip
        return o.clip ?? { copied: true }
      }
    }
    const done = copyDraft(d, t, async (text) => {
      log.push(`write ${text}`)
      if (o.write) throw o.write
    }, (x) => said.push(x), o.plainOnly)
    // await の前に、素の文字列の書き込みとスレッドを開くのが始まっている。
    const sync = [...log]
    const ret = await done
    return { sync, log, said, ret }
  }
  const teams = await run({ to: 'a', via: 'Teams', text: '- **a**', href: 'https://teams.microsoft.com/l/1' })
  assert.deepEqual(teams.sync, ['write - **a**', 'open https://teams.microsoft.com/l/1'])
  assert.deepEqual(teams.log, [...teams.sync, 'clip teams'])
  assert.match(teams.said.at(-1)!, /^本文をTeamsの書式でコピーし、スレッドを開きました/)
  // 書式の決まらない宛先は clip-draft を呼ばない。
  const line = await run({ to: 'a', via: 'LINE', text: 't', href: 'https://line.me/x' })
  assert.deepEqual([line.sync, line.log, line.said], [['write t', 'open https://line.me/x'], ['write t', 'open https://line.me/x'], [copyMessage({ opened: true })]])
  // clip-draft はクリップボードを空にしてから書くので、失敗したら中身を確かめられない。押し直しは素の文字列だけを入れ、スレッドは開き直さない。
  const failed = await run({ to: 'a', via: 'Slack', text: 't', href: 'https://acme.slack.com/x' }, { clip: new Error('swift が無い') })
  assert.equal(failed.ret, true)
  assert.equal(failed.said.at(-1), '本文をSlackの書式に変換できませんでした: swift が無い。クリップボードの中身を確認できないので、もう一度押して素の文字列でコピーしてください')
  const again = await run({ to: 'a', via: 'Slack', text: 't', href: 'https://acme.slack.com/x' }, { plainOnly: true })
  assert.deepEqual([again.ret, again.log, again.said], [false, ['write t'], ['本文を素の文字列でコピーしました']])
  const refused = await run({ to: 'a', via: 'LINE', text: 't' }, { write: new Error('Document is not focused') })
  assert.deepEqual([refused.ret, refused.said], [false, ['本文をコピーできませんでした: Document is not focused。もう一度押してください']])
  // 素の文字列を断られても、書式つきで入れば成功として知らせる。
  const blocked = await run({ to: 'a', via: 'メール', text: '件名: x\n\n本文' }, { clip: { copied: true, subject: 'x' }, write: new Error('Document is not focused') })
  assert.equal(blocked.said.at(-1), '本文をメールの書式でコピーしました。件名は「x」です（本文からは外しました）')
})

test('追加 20: コピーの知らせは宛先の書式・メールの件名を添える', () => {
  assert.equal(copyMessage(undefined, { copied: true, format: 'teams' }), '本文をTeamsの書式でコピーしました')
  assert.equal(copyMessage({ opened: false, reason: 'x' }, { copied: true, format: 'slack' }), '本文をSlackの書式でコピーしましたが、スレッドを開けませんでした: x')
  assert.equal(copyMessage({ opened: true }, { copied: true, subject: '【ご確認】手順書', format: 'mail' }),
    `本文をメールの書式でコピーし、スレッドを開きました。送ったら「${SENT_LABEL}」を押してください。件名は「【ご確認】手順書」です（本文からは外しました）`)
})

test('追加 14: 許可の対象は本文の書体にし、` で囲んだ所と SHA だけを等幅にする（窓とパネル）', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.push({ id: 'p9', rev: 1, kind: 'permit', state: 'open', at: '2026-11-21T09:00:00+09:00', stream: 's1', title: '本番に流す', purpose: '一覧を出す', target: '本番の DB に `migrate 0042` を流す（a1b2c3d）', effect: '一覧の列が増える', undo: '0041 に戻す', why: '今日出す', fallback: '待つ', quote: '出して' })
  })
  const h = page(m, { sel: '/ws/aoba#p9' })
  const f = h.slice(h.indexOf('>対象<'), h.indexOf('>戻し方<'))
  assert.match(f, /<p>本番の DB に <span class="code">migrate 0042<\/span> を流す（<span class="code">a1b2c3d<\/span>）<\/p>/)
  assert.doesNotMatch(f, /<div><span class="code">本番/)
  const panel = render({ ...m, panel: true }, { ...newUi(), sel: '/ws/aoba#p9' }, NOW, (x) => x)
  assert.match(panel, /<span class="lb">対象<\/span><div><div class="rich"><p>本番の DB に <span class="code">migrate 0042<\/span>/)
})

test('仕事の見出しの要対応は、タブと同じく修正待ちを数えない', () => {
  const h = page(aoba((v) => {
    v.log.ops.push({ op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'r5', item_rev: 1, type: 'talk', text: '幅を直して' })
  }))
  const head = h.slice(h.indexOf('<b>配車画面の改修</b>'), h.indexOf('</div>', h.indexOf('<b>配車画面の改修</b>')))
  assert.match(head, /修正待ち 1/)
  assert.doesNotMatch(head, /要対応/)
})

test('Codex 13-4・5: 出した指示の本文は空白を詰めず、古い版への返答は今の選択肢の文言で読み替えない', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.find((x) => x.id === 'd21')!.rev = 2
    v.log.ops.push(
      { op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' },
      { op_id: 3, at: '2026-11-21T09:50:00+09:00', item_id: 'd21', item_rev: 2, type: 'talk', text: 'cd 資料 を 開く' })
  })
  const h = tighten(page(m, { sel: '/ws/aoba#d21' }))
  assert.match(h, /<div class="quote verb">cd 資料 を 開く<\/div>/)
  assert.match(text(h), /決定: keep（版1） 未反映/)
})

test('info-needs Q1・Q2: 判断の一覧の行の 2 行目におすすめの案を出し、本文の判断の記録の番号の括弧は表示から除く', () => {
  assert.match(page(aoba()), /<span class="ti">構成案の本番の図に、社内向けの入口を描き足すか<\/span><\/span><span class="recm">おすすめ: 図はこのまま、本文で説明する<\/span>/)
  assert.equal(dropRulings('<p>窓の版 3（R46・R47、R83）を入れる（2 件）</p>'), '<p>窓の版 3を入れる（2 件）</p>')
  assert.equal(dropRulings('止めないため（21:40 の依頼、R79）。（R12、11/20）'), '止めないため（21:40 の依頼）。（11/20）')
})

test('Codex 17-1・2: 判断の記録の番号を除くのは説明の文だけ。送る文面・コマンド・対象・リンクの値は帳簿のまま（窓とパネル）', () => {
  const m = aoba((v) => {
    const d = v.cockpit!.cards.find((x) => x.id === 'd22')!
    d.purpose = '議事録をそろえる（R46・R47）'
    d.draft!.text = '対象機種（R2、R3）を交換します'
    const r = v.cockpit!.cards.find((x) => x.id === 'r5')!
    r.href = '/tmp/仕様(R2).pdf'
  })
  const send = tighten(page(m, { sel: '/ws/aoba#d22' }))
  assert.match(send, /<div class="msg">対象機種（R2、R3）を交換します<\/div>/)
  assert.match(send, /<p class="purp">議事録をそろえる<\/p>/)
  assert.match(page(m, { sel: '/ws/aoba#r5' }), /data-file="\/tmp\/仕様\(R2\)\.pdf"/)
  const panel = render({ ...m, panel: true }, { ...newUi(), sel: '/ws/aoba#d22' }, NOW, (x) => x)
  assert.match(panel, /対象機種（R2、R3）を交換します/)
  assert.doesNotMatch(panel, /（R46・R47）/)
  const manual = page(aoba((v) => { v.cockpit!.cards.find((c) => c.id === 'd22')!.manual = { where: 'x', command: "tool '部品(R2)'", check: 'y' } }), { sel: '/ws/aoba#d22' })
  assert.match(manual, /tool &#39;部品\(R2\)&#39;/)
})

test('Codex 17-3: 旧形式の許可（context.what・context.gain）も、パネルと窓で対象と影響を出し、窓の詳細で重ねない', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.push({ id: 'p8', rev: 1, kind: 'permit', state: 'open', at: '2026-11-21T09:00:00+09:00', stream: 's1', title: '旧テーブルを消す', purpose: 'p', why: 'w', fallback: 'f', quote: 'q', undo: '戻せない', context: { what: '本番 DB', gain: '旧テーブルを削除' } })
  })
  const panel = render({ ...m, panel: true }, { ...newUi(), sel: '/ws/aoba#p8' }, NOW, (x) => x)
  assert.match(text(panel), /影響 旧テーブルを削除 対象 本番 DB/)
  const win = text(page(m, { sel: '/ws/aoba#p8' }))
  assert.match(win, /何が変わるか 旧テーブルを削除 対象 本番 DB/)
  assert.equal(win.match(/本番 DB/g)!.length, 1)
})

test('Codex 17-4: 依頼の原文の「続き」と済んだことの残りは、開いた状態を再描画のあとも保つ', () => {
  const m = aoba((v) => { v.cockpit!.cards.find((x) => x.id === 'r5')!.request = '1 行目\n2 行目\n3 行目' })
  assert.match(page(m, { sel: '/ws/aoba#r5' }), /<details class="cont" data-fold="cont:\/ws\/aoba#r5"><summary>続き/)
  assert.match(page(m, { sel: '/ws/aoba#r5', open: { 'cont:/ws/aoba#r5': true } }), /data-fold="cont:\/ws\/aoba#r5" open>/)
  const t = aoba((v) => { v.cockpit!.tasks.find((x) => x.id === 't1')!.done = ['a', 'b', 'c', 'd'] })
  assert.match(page(t, { tab: 'whole', task: 't1', open: { 'done:t1': true } }), /data-fold="done:t1" open><summary>残り 1 件/)
})

test('追加 22 の Codex: 全体の j・k の順は見張るを最後にした画面の順と同じ。選べるタスクの無い仕事は箱の中で協議できる。期限は一覧と詳細で同じ語と色', () => {
  const m = aoba((v) => { v.cockpit!.streams[2]!.form = 'watch' })
  const all = page(m, { tab: 'whole', open: { 's:s1': true, 's:s2': true, 's:s3': true } })
  const order = taskOrder(m.boards[0])
  assert.deepEqual(order, [...all.matchAll(/data-task="(\w+)"/g)].map((x) => x[1]))
  assert.equal(order.at(-1), 't3', '見張る仕事（s3）のタスクは最後')
  // s4 のタスクは済んだ t4 だけなので、右に詳細を出せない。協議は箱の中から。
  assert.match(page(aoba(), { tab: 'whole', open: { 's:s4': true, done: true } }), /data-talkstream="s4"/)
  // d21 は 3 時間後、d22 は 2 時間前が期限。赤は期限切れだけで、詳細もパネルの「あと n 時間」の赤い札にしない。
  const d = page(aoba(), { sel: '/ws/aoba#d21' })
  assert.doesNotMatch(d, /due hot/)
  assert.equal(d.match(/class="due dnext soon"/g)?.length, 2, '一覧と詳細の 2 か所')
  assert.match(text(d), /期限切れ 08:00/)
})

test('詳細の担当の行は、端末・チャットを前に出すボタンにする（チャットは居場所の worktree が分かるときだけ）', () => {
  const m = aoba((v) => {
    v.owners = [{ session: 'sess-aws', kind: 'chat', state: 'working', worktree: '/ws/aoba-aws' }]
  })
  // 担当の名前が仕事の名前（AWS 構成案）と同じなら名前を重ねない（初見 2 巡目 3）。
  assert.match(page(m, { sel: '/ws/aoba#d21' }), /<span class="owner"><span>担当<\/span>(<span>[^<]*<\/span>)?<button type="button" class="act" data-term="" data-wt="\/ws\/aoba-aws">チャットを開く<\/button>/)
  assert.match(page(m, { sel: '/ws/aoba#r5' }), /<button type="button" class="act" data-term="term_aoba_w1" data-wt="">端末を開く<\/button>/)
  // 前に出せないときは「チャット」を押せない語として並べない。
  assert.doesNotMatch(page(aoba(), { sel: '/ws/aoba#d21' }), /<span>チャット<\/span>/)
})

test('補助の文字・危険・仕事の形の色は、明暗どちらの地でも WCAG AA（4.5:1）を満たし、押せるものの枠は 3:1 を満たす', () => {
  const vars = (sel: string) => Object.fromEntries([...CSS.split(sel)[1]!.split('}')[0]!.matchAll(/--([\w-]+):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))
  const light = vars('.ck { color-scheme: light;')
  const dark = { ...light, ...vars('.ck[data-theme="dark"] { color-scheme: dark;') }
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
  }
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  for (const t of [light, dark])
    for (const bg of ['bg', 'surface', 'sunk', 'hot-bg']) {
      for (const fg of ['ink', 'ink2', 'ink3', 'focus', 'hot', 'f-delegate', 'f-cowork', 'f-watch']) assert.ok(ratio(t[fg]!, t[bg]!) >= 4.5, `${fg} / ${bg}: ${ratio(t[fg]!, t[bg]!).toFixed(2)}`)
    }
  assert.match(CSS, /\.ck \.btn \{[^}]*border:1px solid var\(--ink3\)/)
  assert.match(CSS, /\.ck\.win \.act \{[^}]*border:1px solid var\(--ink3\)/)
})

test('問いの件名が題のときは、詳細に本文も出す', () => {
  const m = aoba((v) => {
    v.questions = [{ id: 'q1', at: NOW - 10 * 60_000, line: '仕様確認', text: '端数は切り上げますか？', to: 'main', task: 't1' }]
  })
  assert.match(page(m, { sel: '/ws/aoba##ask:q1' }), /聞かれていること.*端数は切り上げますか？/s)
})

test('初見 2 巡目: 仕事の見出しは工程を名前の横に置き、右の列は行の期限だけ。担当が仕事と同じ名前なら出さない', () => {
  const h = page(aoba(), {})
  const head = h.slice(h.indexOf('<div class="gh f-'), h.indexOf('</div>', h.indexOf('<div class="gh f-')))
  // 名前 → 工程 → 件数の順（工程が右端に寄らない）。
  assert.match(head, /<b>[^<]+<\/b><span class="prog"><span class="pbar"[^>]*>[^<]*(工程|タスク完了)/)
  const all = [...h.matchAll(/<div class="gh f-[^"]*">([\s\S]*?)<\/div>/g)].map((x) => text(x[1]!))
  assert.ok(all.every((x) => !/担当: (配車画面の改修|AWS 構成案)/.test(x)), all.join('\n'))
})

test('初見 2 巡目: 対応済みは答えを「出した指示」の 1 行で読み、囲みの箱と行の右の「決定: 〜」を出さない', () => {
  const h = page(aoba(), { tab: 'done', doneSel: '/ws/aoba#d19' })
  assert.doesNotMatch(h, /class="note ok"/)
  const row = h.slice(h.indexOf('data-dsel="/ws/aoba#d19"'), h.indexOf('</button>', h.indexOf('data-dsel="/ws/aoba#d19"')))
  assert.doesNotMatch(text(row), /決定/)
  // 畳んだ「詳細」の中（頼んだ選択肢）は数えない。
  const shown = h.replace(/<details class="more-d"[\s\S]*?<\/details>/, '')
  assert.equal(text(shown).match(/議題だけテキストで送る/g)?.length, 3, '行の題・詳細の題・出した指示')
})

test('Codex 初見 2 巡目: 協議の開始だけが記録され、答えは帳簿で閉じたカードは、結果の 1 行で答えを出す', () => {
  const m = aoba((v) => {
    v.log.ops = v.log.ops.filter((o) => o.item_id !== 'd19')
    v.log.ops.push({ op_id: 90, at: new Date(NOW - 40 * 3_600_000).toISOString(), item_id: 'd19', item_rev: 1, type: 'talk' })
  })
  const t = text(page(m, { tab: 'done', doneSel: '/ws/aoba#d19' }))
  assert.match(t, /出した指示 .*協議を開始/)
  assert.match(t, /結果 決定: 議題だけテキストで送る/)
})

test('Codex 初見 2 巡目 2: 前の版への答えしか記録が無ければ、今の版の答えを結果の 1 行で出す', () => {
  const m = aoba((v) => {
    const d19 = v.cockpit!.cards.find((x) => x.id === 'd19')!
    d19.rev = 2
  })
  const t = text(page(m, { tab: 'done', doneSel: '/ws/aoba#d19' }))
  assert.match(t, /出した指示 .*（版 1）/)
  assert.match(t, /結果 決定: 議題だけテキストで送る/)
})

test('初見 2 巡目: 見張るの経路は線の一覧で「最終確認 hh:mm」。詳細の操作の帯はいつも下端（縦の flex）', () => {
  const t = text(page(aoba(), { tab: 'whole' }))
  assert.match(t, /Slack #aoba-dev 最終確認 /)
  assert.doesNotMatch(t, /に読んだ/)
  assert.match(CSS, /\.ck\.win \.wdet \{ display:flex; flex-direction:column; min-height:100%; \}/)
  assert.match(CSS, /\.ck\.win \.dbtn \{ margin-top:auto;/)
})

test('初見 2 巡目: タスクのエージェントが停止で要対応に出ていれば、全体の行と詳細の状態も停止と出す（作業中と「停止を開く」を並べない）', () => {
  const m = aoba((v) => {
    v.questions = [{ id: 'q1', at: NOW - 10 * 60_000, line: '仕様確認', text: '端数は切り上げますか？', to: 'main', task: 't1' }]
  })
  const h = page(m, { tab: 'whole', task: 't1' })
  const row = h.slice(h.indexOf('data-task="t1"'), h.indexOf('</div>', h.indexOf('data-task="t1"')))
  assert.match(row, /<span class="tst s-stop">停止<\/span>/)
  assert.match(row, /停止を開く/)
  assert.match(h, /<div class="kl"><span class="tst s-stop">停止<\/span>/)
  // 進め手の worker と仕事の行の件数も停止にそろえる。
  assert.match(h, /<span class="mut">worker<\/span><b>[^<]*<\/b><span class="chip bad">停止<\/span>/)

  // 停止の無いときは帳簿のまま。
  assert.match(page(aoba(), { tab: 'whole', task: 't1' }), /<div class="kl"><span class="tst s-run">作業中<\/span>/)
})

// ── 窓から質問する（R105・追加 24 の D） ──
const askMemo = (id: string, over: Partial<NonNullable<CockpitView['asks']>[number]> = {}) => ({
  id, path: `/ws/aoba/.orca/consult/ask-${id}.md`, returnsPath: `/ws/aoba/.orca/consult/ask-${id}.returns.jsonl`, at: '09:05', answers: 0, entries: [], returns: [], ...over
})

test('質問: 全体の上・カードの詳細・タスクの詳細に 4 行の入力欄を置き、結んだ質問だけをそれぞれに出す', () => {
  const m = aoba((v) => {
    v.asks = [askMemo('ask1', { entries: [{ kind: 'q', time: '09:10', text: '全体の質問' }] }), askMemo('ask2', { card: 'd21', entries: [{ kind: 'q', time: '09:11', text: 'カードの質問' }] }), askMemo('ask3', { task: 't1', entries: [{ kind: 'q', time: '09:12', text: 'タスクの質問' }] })]
  })
  const whole = page(m, { tab: 'whole', task: 't1', askMine: { '/ws/aoba#ask1': true } })
  assert.match(whole, /<textarea id="ask-whole" data-askdraft="\/ws\/aoba#whole" rows="4"/)
  assert.match(text(whole), /全体の質問/)
  assert.match(whole, /data-askdraft="\/ws\/aoba#task:t1"/)
  assert.match(text(whole), /タスクの質問/)
  assert.doesNotMatch(text(whole), /カードの質問/)
  const card = page(m, { sel: '/ws/aoba#d21' })
  assert.match(card, /data-askdraft="\/ws\/aoba#card:d21"/)
  assert.match(text(card), /カードの質問/)
  assert.doesNotMatch(text(card), /全体の質問|タスクの質問/)
  // 質問の無いカード・タスクの詳細は、欄を開くボタンだけ（全体の上の欄と並ばないように）。この窓で聞いていない全体の質問は畳む。
  const bare = page(m, { sel: '/ws/aoba#r5' })
  assert.match(bare, /data-ask="open" data-scope="\/ws\/aoba#card:r5">このカードについて質問する</)
  assert.doesNotMatch(bare, /data-askdraft="\/ws\/aoba#card:r5"/)
  assert.match(page(m, { tab: 'whole' }), /<details class="cont" data-fold="askold:\/ws\/aoba#whole"><summary>ほかの質問を見る（1 件）/)
})

test('質問の答え: 頭の時点の行を見出しに移し、末尾の窓口への返しの塊と太字の印を本文から外す。時点の行が無ければ控えの頭の時点を出す', () => {
  assert.deepEqual(answerParts('窓口の会話 22:40 時点（それより後に決まったことは知らない）\n**1 つ**にする\n\n【窓口への返し】\n```json\n{}\n```'), { at: '22:40', body: '1 つにする' })
  assert.deepEqual(answerParts('時点の行が無い答え'), { body: '時点の行が無い答え' })
  const m = aoba((v) => {
    v.asks = [askMemo('ask1', { answers: 1, entries: [{ kind: 'q', time: '09:10', text: '入口は？' }, { kind: 'a', time: '09:11', text: '1 つにする' }] })]
  })
  assert.match(text(page(m, { tab: 'whole', askMine: { '/ws/aoba#ask1': true } })), /答え 09:11（窓口の 09:05 までの会話から） 1 つにする/)
})

test('質問を送ったあと: タブを立てる間と答えを待つ間を秒で出し、1 問目は時間がかかると添える。3 分で止め、立てられなければ理由を出す', () => {
  const m = aoba((v) => {
    v.asks = [askMemo('ask1')]
  })
  const at = NOW - 4000
  assert.match(text(page(m, { tab: 'whole', askWait: { '/ws/aoba#whole': { root: '/ws/aoba', at, q: '入口は？', answers: 0 } } })), /送った質問 入口は？ 窓口の写しを立てています（4 秒）/)
  const wait = text(page(m, { tab: 'whole', askWait: { '/ws/aoba#whole': { root: '/ws/aoba', at, q: '入口は？', ask: 'ask1', answers: 0 } } }))
  assert.match(wait, /答えを待っています（4 秒） 1 問目は 10 秒ほどかかります/)
  assert.match(page(m, { tab: 'whole', askWait: { '/ws/aoba#whole': { root: '/ws/aoba', at, q: 'x', ask: 'ask1', answers: 0 } } }), /data-ask="send" data-scope="\/ws\/aoba#whole" disabled/)
  assert.match(text(page(m, { tab: 'whole', askWait: { '/ws/aoba#whole': { root: '/ws/aoba', at: NOW - 200_000, q: 'x', ask: 'ask1', answers: 0 } } })), /3 分たっても答えが届いていません/)
  assert.match(text(page(m, { tab: 'whole', askWait: { '/ws/aoba#whole': { root: '/ws/aoba', at, q: 'x', answers: 0, error: '窓口の会話が分かりません' } } })), /窓口の写しを立てられませんでした 窓口の会話が分かりません/)
})

test('判断の記録の当たり: 原文・番号・日時・種類をすぐ出し、「足りなければ質問する」で質問に回す', () => {
  const m = aoba()
  const h = page(m, { tab: 'whole', askHits: { '/ws/aoba#whole': { q: '入口は？', hits: [{ id: 'R12', at: '2026-11-21T22:48:00+09:00', kind: 'decision', text: '入口は 1 つにする', quote: '1 つでいい' }] } } })
  assert.match(text(h), /判断の記録に当たりました（1 件） 質問はまだ送っていません R12 11\/21\(土\) 22:48・決定 入口は 1 つにする 1 つでいい それでも窓口の写しに聞く/)
  assert.match(h, /class="btn pri" type="button" data-ask="go" data-scope="\/ws\/aoba#whole"/, "当たっているあいだは「それでも窓口の写しに聞く」を主に")
  assert.match(h, /class="btn" type="button" data-ask="send" data-scope="\/ws\/aoba#whole"/)
})

test('返しの札と「これで決める」: 帳簿の asks[] で反映済み・保留・未反映・担当へ未通知を出し、押したあとは返しが届いたかを出す', () => {
  const m = aoba((v) => {
    v.cockpit!.asks = [{ id: 'ask1', from_returns: ['ask1-1'], held_returns: ['ask1-2'], notify: [{ return_id: 'ask1-1', task: 't1' }] }]
    v.asks = [askMemo('ask1', {
      answers: 1, entries: [{ kind: 'q', time: '09:10', text: '入口は？' }, { kind: 'a', time: '09:11', text: '1 つにする' }], decide: { at: '09:11', head: '1 つにする', n: 1 },
      returns: [{ return_id: 'ask1-1', decisions: [{ text: '入口は 1 つ' }] }, { return_id: 'ask1-2', decisions: [{ text: '図は描き足さない' }] }, { return_id: 'ask1-3', op: 9, decisions: [] }]
    })]
    v.log.ops.push({ op_id: 9, at: '2026-11-21T09:12:00+09:00', item_id: '#ask:ask1', item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: '1 つにする', n: 1 } })
  })
  const t = text(page(m, { tab: 'whole', askMine: { '/ws/aoba#ask1': true } }))
  assert.match(t, /窓口に返したこと 決まったことなし 窓口の反映待ち 図は描き足さない 窓口が保留 入口は 1 つ 窓口が反映済み 担当へ未通知/)
  assert.match(t, /答え 09:11 を窓口に返すよう依頼しました 11\/21\(土\) 09:12 写しが返しました/)
  assert.doesNotMatch(page(m, { tab: 'whole', askMine: { '/ws/aoba#ask1': true } }), /data-ask="decide"/, '同じ答えでもう決めたら、ボタンを出さない')
  m.boards[0]!.v.log.ops.pop()
  assert.match(page(m, { tab: 'whole', askMine: { '/ws/aoba#ask1': true } }), /data-ask="decide" data-id="ask1" data-at="09:11" data-head="1 つにする" data-n="1"/)
  // 押したが返しがまだ無ければ、返し待ちとだけ出す（知らせが届いたかは窓に分からない）。
  m.boards[0]!.v.log.ops.push({ op_id: 10, at: '2026-11-21T09:13:00+09:00', item_id: '#ask:ask1', item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: '1 つにする', n: 1 } })
  assert.match(text(page(m, { tab: 'whole', askMine: { '/ws/aoba#ask1': true } })), /答え 09:11 を窓口に返すよう依頼しました 11\/21\(土\) 09:13 写しからの返し待ち/)
})

test('質問の欄は案件ごと: 別の案件の下書き・当たり・待ちを出さない（Codex 重大 2）', () => {
  const m = aoba((v) => {
    v.asks = [askMemo('ask1', { entries: [{ kind: 'q', time: '09:10', text: '入口は？' }] })]
  })
  const h = page(m, { tab: 'whole', askDraft: { '/ws/other#whole': 'A の下書き' }, askHits: { '/ws/other#whole': { q: 'A', hits: [{ id: 'R1', text: 'A の判断' }] } }, askWait: { '/ws/other#id:ask1': { root: '/ws/other', at: NOW, q: 'A の続き', ask: 'ask1', answers: 0 } }, askMine: { '/ws/other#ask1': true } })
  assert.doesNotMatch(text(h), /A の下書き|A の判断|A の続き|答えを待っています/)
  assert.match(h, /data-fold="askold:\/ws\/aoba#whole"/, '別の案件で聞いた ask1 は、この案件の自分の質問として開かない')
  assert.match(h, /data-ask="send" data-scope="\/ws\/aoba#whole" disabled>送る/, '空の欄では送れない')
  assert.match(page(m, { tab: 'whole', askDraft: { '/ws/aoba#whole': '入口は？' } }), /data-ask="send" data-scope="\/ws\/aoba#whole">送る/)
})

test('全体の上はこの窓で聞いた質問そのものを開き、別の窓の新しい質問は畳む（Codex 2 回目 軽微）', () => {
  const m = aoba((v) => {
    v.asks = [askMemo('ask1', { entries: [{ kind: 'q', time: '09:10', text: '自分の質問' }] }), askMemo('ask2', { entries: [{ kind: 'q', time: '09:20', text: '別の窓の質問' }] })]
  })
  const h = page(m, { tab: 'whole', askMine: { '/ws/aoba#ask1': true } })
  const open = h.slice(0, h.indexOf('data-fold="askold:'))
  assert.match(open, /自分の質問/)
  assert.doesNotMatch(open, /別の窓の質問/)
})

test('続きの答えを待つあいだ: 前の答えで決めさせず、続けて聞かせない。頭だけの控えは出さない（Codex 重大 3・中 3・中 4）', () => {
  const qa = [{ kind: 'q' as const, time: '09:10', text: '入口は？' }, { kind: 'a' as const, time: '09:11', text: '1 つにする' }]
  const m = aoba((v) => {
    v.asks = [askMemo('ask1', { answers: 1, entries: [...qa, { kind: 'q', time: '09:20', text: '図は？' }] }), askMemo('ask2')]
  })
  const mine = { '/ws/aoba#ask1': true, '/ws/aoba#ask2': true }
  // 窓を開き直して待ちが消えても、控えの最後が質問なら決めさせない。
  const h = page(m, { tab: 'whole', askMine: mine })
  assert.doesNotMatch(h, /data-ask="decide"/)
  assert.ok(h.indexOf('data-fold="asko:') >= 0)
  // 前の答えで決めた行は、新しい質問の下に出さず、畳んだ前のやり取りの側に置く（初見 2 巡目）。
  const decided = page(aoba((v) => {
    v.asks = [askMemo('ask1', { answers: 1, entries: [...qa, { kind: 'q', time: '09:20', text: '図は？' }] })]
    v.log.ops.push({ op_id: 9, at: '2026-11-21T09:12:00+09:00', item_id: '#ask:ask1', item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: '1 つにする', n: 1 } })
  }), { tab: 'whole', askMine: mine })
  const fold = decided.slice(decided.indexOf('data-fold="asko:'), decided.indexOf('</details>', decided.indexOf('data-fold="asko:')))
  assert.match(fold, /答え 09:11 を窓口に返すよう依頼しました/)
  assert.equal((decided.match(/窓口に返すよう依頼しました/g) ?? []).length, 1)
  assert.doesNotMatch(h, /data-ask="more"/, '開き直した窓でも、控えの最後の質問に答えが無ければ続けて聞かせない（Codex 2 回目 中 1）')
  assert.match(text(h), /まだ答えが届いていません/)
  assert.equal((h.match(/<li class="askt">/g) ?? []).length, 1, '節も返しも無い ask2 は出さない')
  // この窓で答えを待っていれば、続けて聞くを出さず、頭だけの ask2 も待つ表示つきで出す。
  const w = page(m, { tab: 'whole', askMine: mine, askWait: { '/ws/aoba#id:ask1': { root: '/ws/aoba', at: NOW, q: '図は？', ask: 'ask1', answers: 1 }, '/ws/aoba#whole': { root: '/ws/aoba', at: NOW, q: '別の質問', ask: 'ask2', answers: 0 } } })
  assert.doesNotMatch(w, /data-ask="more"/)
  assert.equal((w.match(/<li class="askt">/g) ?? []).length, 2)
})

test('工程は 5 つの語を並べて今の段を太字にする（R126・R135）。前の和語の名前の帳簿もそのまま同じ段に寄せ、5 つの外は名指しする', () => {
  assert.deepEqual([...STAGES], ['調査', '決定', '作成', '確認', '反映'])
  for (const [old, now] of [['調べる', '調査'], ['決める', '決定'], ['要件', '決定'], ['作る', '作成'], ['実装', '作成'], ['確かめる', '確認'], ['見てもらう', '確認'], ['入れる', '反映'], ['push', '反映']] as const) assert.equal(stageOf(old), now)
  assert.equal(stageOf('調整'), undefined)
  const h = stagesHtml(2, true)
  assert.match(h, /<span class="sd">調査<\/span>.*<span class="sd">決定<\/span>.*<b class="sc">作成<\/b>.*<span class="sn">確認<\/span>.*<span class="sn">反映<\/span>/)
  assert.match(h, /<span class="stg-now">工程 <b>作成<\/b><\/span>/, '一覧の行の狭い形は今の段の語だけ（「工程」を添える）')
  assert.doesNotMatch(stagesHtml(2), /stg-now/, '詳細はいつも 5 語')
  assert.match(CSS, /\.ck \.stg \.sd \{ color:var\(--ink3\); \}/)
  assert.match(CSS, /\.ck \.stg \.sn \{ color:var\(--ink2\); \}/)
  assert.match(CSS, /@media \(max-width: 1100px\) \{\n  \.ck\.win \.pbar \.stg-all \{ display:none; \}/)
  const t = text(page(aoba((v) => { v.cockpit!.tasks.find((x) => x.id === 't1')!.phase = '調整' }), { tab: 'whole', task: 't1' }))
  assert.match(t, /工程の外（調整）/)
})

test('追加 25: 見てのカードに見本（draft）があれば、窓とパネルの詳細に宛先ごとの書式でコピーする 3 つのボタンを出す。押すと素の文字列を入れてからその書式で上書きし、スレッドは開かない', async () => {
  const w = sample(NOW)[2]!
  const v: CockpitView = { state: 'ok', root: '/ws/harness', cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }
  const m: Model = { boards: boardsOf([v], NOW), focused: '/ws/harness', unseen: [], errors: [] }
  const copies = (h: string) => [...h.matchAll(/data-act="copyas" data-format="(\w+)" data-key="\/ws\/harness#r9">([^<]+)</g)].map((x) => `${x[1]}:${x[2]}`)
  const want = ['slack:Slackの書式でコピー', 'teams:Teamsの書式でコピー', 'mail:メールの書式でコピー']
  assert.deepEqual(copies(page(m, { sel: '/ws/harness#r9' })), want)
  assert.deepEqual(copies(render(m, { ...newUi(), sel: '/ws/harness#r9' }, NOW, (x) => x)), want)
  assert.deepEqual(copies(page(m, { sel: '/ws/harness#r8' })), [], '見本の無い見ては出さない')
  for (const f of ['slack', 'teams', 'mail'] as const) {
    const log: string[] = []
    const d = copyTarget({ ...v.cockpit!.cards.find((x) => x.id === 'r9')!.draft!, href: 'https://example.slack.com/x' }, f)
    await copyDraft(d, { openUrl: async (u) => (log.push(`open ${u}`), { opened: true }), clip: async (_t, g) => (log.push(`clip ${g}`), { copied: true }) }, async () => void log.push('write'), () => {})
    assert.deepEqual(log, ['write', `clip ${f}`])
  }
})

test('追加 27・29: 一緒に作る仕事は要対応に 1 行。返事待ちなら先頭が「答える」で札が付き、開くボタンは担当のチャット。全体の仕事とタスクの状態も「返事待ち（あなた）」', () => {
  const m = (state: 'working' | 'done') => aoba((v) => {
    v.cockpit!.streams.find((x) => x.id === 's2')!.form = 'cowork'
    v.cockpit!.cards = v.cockpit!.cards.filter((x) => x.stream !== 's2')
    v.owners = [{ session: 'sess-aws', kind: 'chat', state, worktree: '/ws/aoba-aws', updatedAt: NOW - 60_000, last: '構成案の下書きです。\n\n入口は社内向けにも描きますか？' }]
  })
  const asked = page(m('done'), { sel: '/ws/aoba##cowork:s2' })
  const rowOf = (h: string) => h.match(/<[^>]*data-sel="\/ws\/aoba##cowork:s2"[\s\S]*?<\/button>/)?.[0] ?? ''
  assert.match(rowOf(asked), /<span class="kd">答える<\/span>/)
  assert.match(text(rowOf(asked)), /入口は社内向けにも描きますか？/)
  assert.match(rowOf(asked), /class="tag miss">返事待ち（あなた）</)
  assert.match(asked, /data-act="focus"[^>]*>担当のチャットを開く</)
  const whole = text(page(m('done'), { tab: 'whole', open: { 's:s2': true } }))
  assert.match(whole, /AWS 構成案 返事待ち（あなた）/)
  assert.match(whole, /返事待ち（あなた） 構成案の図と本文/)
  const calm = page(m('working'), { sel: '/ws/aoba##cowork:s2' })
  assert.match(rowOf(calm), /<span class="kd">確認<\/span>/)
  assert.match(text(rowOf(calm)), /共同作業中（担当は作業中）/)
  assert.doesNotMatch(rowOf(calm), /返事待ち/)
})
