import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit } from './model.ts'
import type { CockpitView } from './protocol.ts'
import { copyMessage } from './controller.ts'
import { boardsOf, newUi, render, SENT_LABEL, tighten, type Model, type Ui } from './view.ts'
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

test('要対応: 仕事ごとにまとめ、先頭の詳細を右に開く。届いたは出さず、相談は「件数外」の札で件数に入れない', () => {
  const m = aoba()
  const h = page(m)
  const t = text(h)
  assert.match(h, /data-tab="todo" aria-selected="true">要対応<span class="n">3<\/span>/)
  assert.ok(!/data-sel="\/ws\/aoba#i3"/.test(h), '届いたは要対応に出さない')
  assert.match(h, /data-sel="\/ws\/aoba#c4"[\s\S]*?件数外/)
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

test('全体: 一緒に作る → 任せる → 見張る → 形の無い仕事 の順に置き、見張るに届いた連絡を件数外で並べる。右に未対応の一覧を出さない（R91）', () => {
  const m = aoba((v) => {
    const s = v.cockpit!.streams
    s[0]!.form = 'delegate'
    s[1]!.form = 'cowork'
    s[2]!.form = 'watch'
    v.cockpit!.requests = [{ id: 'r1', at: '2026-11-21T09:00:00+09:00', title: '配車画面を直す', tasks: ['t1'], legacy: true }]
  })
  const t = text(page(m, { tab: 'whole' }))
  const order = ['一緒に作る 話しながら', '任せる 任せている', '見張る 届いたもの', '形が書かれていない仕事'].map((x) => t.indexOf(x))
  assert.ok(order.every((n) => n >= 0), t)
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.match(t, /届いた連絡 1 件・件数外/)
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
  assert.match(h, /class="task" aria-current="true"><button type="button" class="tsel" data-task="t1"/)
  assert.match(h, /data-toggle="s:s1" aria-expanded="true"/)
  for (const x of ['工程 3/5 作る（実装）', '状態 作業中', '何のため 配車の一覧で探す手間を減らす', '次にやること レビューの指摘を直して stg に出す', '済んだこと 並べ替えを入れた', '一覧の改修（worker）', '今: テストを直している', '一覧で探しにくい'])
    assert.ok(t.includes(x), x)
  assert.match(side, /data-jump="\/ws\/aoba#r5"/)
  assert.match(side, /<li class=""><span aria-label="証拠なし">・<\/span>並べ替えができる<\/li>/)
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
  assert.match(h, /<summary>帳簿の形式不備 1 件<\/summary>/)
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
  assert.match(box.slice(0, box.indexOf('</span></span></span>') + 30), /全工程 完了/)
})

test('Codex v3 4・5: 属性の値の中の > でタグを切らず、コピーのあとの知らせは今の「送った」ボタンの名前を案内する', () => {
  assert.equal(tighten('<div title="x > 資料 A">文 A</div>'), '<div title="x > 資料 A">文A</div>')
  assert.match(page(aoba(), { sel: '/ws/aoba#d22' }), new RegExp(`data-act="sent"[^>]*>${SENT_LABEL}<`))
  assert.match(copyMessage({ opened: true }), new RegExp(`「${SENT_LABEL}」を押して`))
})

test('追加 14: 許可の対象は本文の書体にし、` で囲んだ所と SHA だけを等幅にする（窓とパネル）', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.push({ id: 'p9', rev: 1, kind: 'permit', state: 'open', at: '2026-11-21T09:00:00+09:00', stream: 's1', title: '本番に流す', purpose: '一覧を出す', target: '本番の DB に `migrate 0042` を流す（a1b2c3d）', effect: '一覧の列が増える', undo: '0041 に戻す', why: '今日出す', fallback: '待つ', quote: '出して' })
  })
  const h = page(m, { sel: '/ws/aoba#p9' })
  const f = h.slice(h.indexOf('>対象<'), h.indexOf('>何が変わるか<'))
  assert.match(f, /<p>本番の DB に <span class="code">migrate 0042<\/span> を流す（<span class="code">a1b2c3d<\/span>）<\/p>/)
  assert.doesNotMatch(f, /<div><span class="code">本番/)
  const panel = render({ ...m, panel: true }, { ...newUi(), sel: '/ws/aoba#p9' }, NOW, (x) => x)
  assert.match(panel, /<span class="lb">対象<\/span><div><div class="rich"><p>本番の DB に <span class="code">migrate 0042<\/span>/)
})
