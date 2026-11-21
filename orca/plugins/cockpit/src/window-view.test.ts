import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit, type DraftFormat } from './model.ts'
import type { ClipResult, CockpitView } from './protocol.ts'
import { copyDraft, copyMessage } from './controller.ts'
import { boardsOf, dropRulings, newUi, render, SENT_LABEL, tighten, type Model, type Ui } from './view.ts'
import { CSS } from './style.ts'
import { renderWindow, taskOrder, todoOrder } from './window-view.ts'

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
  for (const x of ['作業中 工程 3/5 作る', '何のため 配車の一覧で探す手間を減らす', '済の条件 並べ替えができる 絞り込みができる', '次にやること レビューの指摘を直して stg に出す', '済んだこと 並べ替えを入れた', '一覧の改修（worker）', '今: テストを直している', '一覧で探しにくい'])
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

test('欄の形の違いの知らせは 1 行に畳み、読めない・繋がらない知らせだけを赤の帯に出す', () => {
  const m = aoba((v) => {
    v.errors = ['cockpit.json のカード v1「x」の evidence の形が違うので、その欄を出さずに表示しています']
  })
  m.errors = ['常駐のプロセスに繋がりません']
  const h = page(m)
  assert.match(h, /<div class="werrs" role="alert"><div>常駐のプロセスに繋がりません<\/div><\/div>/)
  assert.match(h, /<summary>帳簿の形式不備 1 件<\/summary><ul><li><span class="code">v1<\/span>・evidence<\/li><\/ul>/)
  // パネルも 1 行ずつ並べず件数に畳む（追加 15）。
  const panel = render({ ...m, panel: true }, newUi(), NOW, (x) => x)
  assert.match(panel, /<summary>帳簿の形式不備 1 件<\/summary>/)
  assert.doesNotMatch(panel, /<div>[^<]*evidence の形が違う/)
  // 仕事の見出しには工程 n/5（5 段で固定）と今の段の名前を出し、凡例の帯は出さない（R82）。
  assert.match(h, /工程 <span class="num">2\/5<\/span> 決める/)
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

test('Codex v3 2: 段に寄せられない工程名の未完了タスクがあれば、段番号も完了の印も出さず「工程 未分類あり」', () => {
  const h = page(aoba((v) => {
    v.cockpit!.tasks.push({ id: 't9', stream: 's1', phase: '受入', title: '受け入れ', state: 'run' }, { id: 't10', stream: 's1', phase: 'push', title: '出す', state: 'idle' })
  }))
  const head = h.slice(h.indexOf('<b>配車画面の改修</b>'), h.indexOf('</div>', h.indexOf('<b>配車画面の改修</b>')))
  assert.match(head, /工程 未分類あり/)
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
  assert.equal(failed.said.at(-1), '本文をSlackの書式に直せませんでした: swift が無い。クリップボードの中身を確かめられないので、もう一度押して素の文字列でコピーしてください')
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
  assert.equal(d.match(/class="dnext soon"/g)?.length, 2, '一覧と詳細の 2 か所')
  assert.match(text(d), /期限切れ 08:00/)
})

test('詳細の担当の行は、端末・チャットを前に出すボタンにする（チャットは居場所の worktree が分かるときだけ）', () => {
  const m = aoba((v) => {
    v.owners = [{ session: 'sess-aws', kind: 'chat', state: 'working', worktree: '/ws/aoba-aws' }]
  })
  assert.match(page(m, { sel: '/ws/aoba#d21' }), /<span class="owner"><span>担当<\/span><b>AWS.?構成案<\/b>(<span>[^<]*<\/span>)?<button type="button" class="act" data-term="" data-wt="\/ws\/aoba-aws">チャットを開く<\/button>/)
  assert.match(page(m, { sel: '/ws/aoba#r5' }), /<button type="button" class="act" data-term="term_aoba_w1" data-wt="">端末を開く<\/button>/)
  assert.match(page(aoba(), { sel: '/ws/aoba#d21' }), /<b>AWS.?構成案<\/b><span>チャット<\/span>/)
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
