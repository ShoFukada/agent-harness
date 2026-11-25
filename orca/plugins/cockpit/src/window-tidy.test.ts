import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit, type Card, type Op } from './model.ts'
import type { CockpitView } from './protocol.ts'
import { boardsOf, newUi, type Model, type Ui } from './view.ts'
import { renderWindow } from './window-view.ts'
import { TIDY_TEXT, tidyDraftFor, tidyRows } from './window-tidy.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const R = '/ws/aoba'
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const tidy = (op_id: number, min: number, option_id: string | undefined, body: string): Op =>
  ({ op_id, at: new Date(NOW - min * 60_000).toISOString(), item_id: '', item_rev: 0, type: 'tidy', ...(option_id && { option_id }), text: body })
/** 4 件の指示: 1 は完了（結果の報告あり）、2 は取り消し、3 は合図を送った（実行中）、5 は猶予の中（送信待ち）。 */
function model(edit: (v: CockpitView) => void = () => {}): Model {
  const w = sample(NOW)[0]!
  const c = parseCockpit(JSON.stringify(w.cockpit))
  const report: Card = { id: 'x1', rev: 1, kind: 'report', state: 'open', at: new Date(NOW - 50 * 60_000).toISOString(), stream: c.streams[0]!.id, title: 'workerとworktreeを整理した', done: [{ what: 'worktreeを2件削除', why: '取り込み済み', undo: 'ブランチから作り直す' }], tidy_op: 1 }
  c.cards.push(report)
  c.applied_ops = [1]
  const log = { ops: [
    tidy(1, 90, 'workers', TIDY_TEXT.workers),
    tidy(2, 80, 'cockpit', TIDY_TEXT.cockpit),
    { op_id: 4, at: new Date(NOW - 79 * 60_000).toISOString(), item_id: '', item_rev: 0, type: 'undo', undo_of: 2 } as Op,
    tidy(3, 30, undefined, '#pj-xxx と docs/ を見て、未対応の依頼を棚卸しして'),
    tidy(5, 0, 'inventory', TIDY_TEXT.inventory)
  ] }
  const v: CockpitView = { state: 'ok', root: R, cockpit: c, log, archive: [], figures: {}, errors: [], workers: [], notifiedOp: 4 }
  edit(v)
  return { boards: boardsOf([v], NOW), focused: R, unseen: [], errors: [] }
}
const whole = (m: Model, over: Partial<Ui> = {}) => renderWindow(m, { ...newUi(), tab: 'whole', ...over }, NOW, (s) => s)

test('整理・棚卸し: 送った指示は新しい順。合図の前は送信待ち、合図のあとは実行中、窓口が反映したら完了で、結果は tidy_op の報告。取り消した指示は出さない', () => {
  const rows = tidyRows(model().boards[0]!)
  assert.deepEqual(rows.map((r) => [r.op.op_id, r.state, r.results.map((c) => c.id)]), [[5, 'queued', []], [3, 'running', []], [1, 'done', ['x1']]])
})

test('整理・棚卸し: 結果のカードは控え（cockpit.archive.json）に移ったあとも引く', () => {
  const m = model((v) => {
    const x = v.cockpit!.cards.pop()!
    v.archive = [{ ...x, state: 'done' }]
  })
  assert.deepEqual(tidyRows(m.boards[0]!).at(-1)!.results.map((c) => c.id), ['x1'])
})

test('整理・棚卸し: 全体のタブの先頭に既定の指示 3 つと自由に書くボタンを置き、済んでいない指示と最後の指示を行で出す（完了の古い指示は右の欄だけ）', () => {
  const h = whole(model())
  const head = h.slice(h.indexOf('<section class="fsec tidy"'), h.indexOf('</section>', h.indexOf('<section class="fsec tidy"')))
  assert.ok(h.indexOf('class="fsec tidy"') < h.indexOf('class="st '), '仕事の一覧より上に置く')
  for (const [k, label] of [['workers', 'workerとworktreeの整理'], ['cockpit', '操縦席の整理'], ['inventory', '棚卸し'], ['free', '自由に書く']])
    assert.match(head, new RegExp(`data-tidy="${k}" aria-pressed="false">${label}</button>`))
  const t = text(head)
  assert.match(t, /送信待ち 棚卸し Slack・関連ファイル/)
  assert.match(t, /実行中 自由な指示 #pj-xxx と docs\/ を見て/)
  assert.doesNotMatch(t, /完了/, '完了した古い指示は先頭の欄に出さない')
  assert.doesNotMatch(t, /操縦席を整理する/, '取り消した指示は出さない')
})

test('整理・棚卸し: 指示が無ければ先頭の欄はボタンだけ。完了が最後の指示なら 1 行だけ出す', () => {
  assert.doesNotMatch(whole(model((v) => (v.log = { ops: [] }))), /data-tidy="open"/)
  const h = whole(model((v) => (v.log = { ops: v.log.ops.filter((o) => o.op_id === 1) })))
  assert.equal(h.match(/data-tidy="open"/g)?.length, 1)
  assert.match(text(h), /完了 workerとworktreeの整理/)
})

test('整理・棚卸し: 欄を開くと右に種類・指示の文・送るボタンと送った指示の一覧を出し、タスクの詳細と入れ替わる。結果の報告は押して要対応のカードへ移れる', () => {
  const h = whole(model(), { tidy: true, tidyKind: { [R]: 'cockpit', '/ws/other': 'workers' }, task: 't1', tidyDraft: { [R]: '操縦席を整理する。s3の古い状況も直す' } })
  const side = h.slice(h.indexOf('<aside class="wside" aria-label="整理・棚卸し"'))
  assert.match(side, /<button type="button" data-tidy="cockpit" aria-pressed="true">操縦席の整理<\/button>/)
  assert.match(side, /<textarea id="tidy-text" data-tidydraft="\/ws\/aoba" rows="4" maxlength="4000">操縦席を整理する。s3の古い状況も直す<\/textarea>/)
  assert.match(side, /<button class="btn pri" type="button" data-tidy="send">窓口に送る<\/button>/)
  assert.match(side, /<button type="button" class="alk" data-jump="\/ws\/aoba#x1">workerとworktreeを整理した<\/button>/)
  const t = text(side)
  assert.ok(t.indexOf('送信待ち') < t.indexOf('実行中') && t.indexOf('実行中') < t.indexOf('完了'), '新しい順')
  assert.doesNotMatch(side, /data-talkstream/, 'タスクの詳細は出さない')
})

test('整理・棚卸し: 文が空のあいだと送っているあいだは「窓口に送る」を押させない。結果のカードの無い完了は、その旨を出す', () => {
  assert.match(whole(model(), { tidy: true }), /data-tidy="send" disabled>窓口に送る/)
  assert.match(whole(model(), { tidy: true }), /data-tidy="free" aria-pressed="true">自由な指示/, '種類を選んでいなければ自由な指示')
  assert.match(whole(model(), { tidy: true, tidyDraft: { [R]: 'x' }, tidySending: R }), /data-tidy="send" disabled>窓口に送る/)
  const h = whole(model((v) => (v.cockpit!.cards = v.cockpit!.cards.filter((c) => c.id !== 'x1'))), { tidy: true })
  assert.match(text(h), /完了 .*結果のカードなし/)
})

test('整理・棚卸し: 種類を選ぶと既定の文を入れる。自由な指示に切り替えると、既定の文のままなら空にし、書き換えた文は残す', () => {
  assert.equal(tidyDraftFor('workers', '書きかけ'), TIDY_TEXT.workers)
  assert.equal(tidyDraftFor('free', TIDY_TEXT.cockpit), '')
  assert.equal(tidyDraftFor('free', '#pj-xxx を見て'), '#pj-xxx を見て')
})
