import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit, type Card, type Op } from './model.ts'
import type { CockpitView } from './protocol.ts'
import { boardsOf, newUi, type Model, type Ui } from './view.ts'
import { renderWindow } from './window-view.ts'
import { pendingSame, TIDY_TEXT, tidyDraftFor, tidyRows } from './window-tidy.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const R = '/ws/aoba'
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const tidy = (op_id: number, min: number, option_id: string | undefined, body: string): Op =>
  ({ op_id, at: new Date(NOW - min * 60_000).toISOString(), item_id: '', item_rev: 0, type: 'tidy', ...(option_id && { option_id }), text: body })
/** 4 件の指示: 1 は窓口が反映した（結果の報告あり）、2 は取り消し、3 は合図を送った（反映待ち）、5 は猶予の中（送信待ち）。 */
function model(edit: (v: CockpitView) => void = () => {}): Model {
  const w = sample(NOW)[0]!
  const c = parseCockpit(JSON.stringify(w.cockpit))
  const report: Card = { id: 'x1', rev: 1, kind: 'report', state: 'open', at: new Date(NOW - 50 * 60_000).toISOString(), stream: c.streams[0]!.id, title: 'workerとworktreeを整理した', done: [{ what: 'worktreeを2件削除', why: '取り込み済み', undo: 'ブランチから作り直す' }], tidy_ops: [1] }
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

test('整理・棚卸し: 窓口が反映していない指示だけを新しい順に出す。合図の前は送信待ち、合図のあとは反映待ち。反映した指示と取り消した指示は出さない（t163）', () => {
  const rows = tidyRows(model().boards[0]!)
  assert.deepEqual(rows.map((r) => [r.op.op_id, r.state]), [[5, 'queued'], [3, 'waiting']])
})

test('整理・棚卸し: 全体のタブの先頭に既定の指示 3 つと自由に書くボタンを置き、反映待ちの指示を、送ってからの時間と一緒に行で出す。「実行中」「完了」とは出さない', () => {
  const h = whole(model())
  const head = h.slice(h.indexOf('<section class="fsec tidy"'), h.indexOf('</section>', h.indexOf('<section class="fsec tidy"')))
  assert.ok(h.indexOf('class="fsec tidy"') < h.indexOf('class="st '), '仕事の一覧より上に置く')
  for (const [k, label] of [['workers', 'workerとworktreeの整理'], ['cockpit', '操縦席の整理'], ['inventory', '棚卸し'], ['free', '自由な指示']])
    assert.match(head, new RegExp(`<button class="btn" type="button" data-tidy="${k}">${label}</button>`), '入口なので選んだ印は付けない')
  const t = text(head)
  assert.match(t, /送信待ち 棚卸し Slack・関連ファイル.* たった今/)
  assert.match(t, /反映待ち 自由な指示 #pj-xxx と docs\/ を見て、未対応の依頼を棚卸しして 30 分前から/)
  assert.doesNotMatch(t, /実行中|完了/, '窓口が受け取ったかは窓から分からず、反映した指示は消える')
  assert.doesNotMatch(t, /workerとworktreeを整理する/, '反映した指示は出さない')
  assert.doesNotMatch(t, /操縦席を整理する/, '取り消した指示は出さない')
})

test('整理・棚卸し: 全部の指示を窓口が反映したら、先頭の欄はボタンだけになる', () => {
  assert.doesNotMatch(whole(model((v) => (v.log = { ops: [] }))), /data-tidy="open"/)
  assert.doesNotMatch(whole(model((v) => (v.cockpit!.applied_ops = [1, 2, 3, 4, 5]))), /data-tidy="open"/)
})

test('整理・棚卸し: 欄を開くと右に種類・指示の文・送るボタンと反映待ちの指示の一覧を出し、タスクの詳細と入れ替わる', () => {
  const h = whole(model(), { tidy: true, tidyKind: { [R]: 'cockpit', '/ws/other': 'workers' }, task: 't1', tidyDraft: { [R]: '操縦席を整理する。s3の古い状況も直す' } })
  const side = h.slice(h.indexOf('<aside class="wside" aria-label="整理・棚卸し"'))
  assert.match(side, /<button type="button" data-tidy="cockpit" aria-pressed="true">操縦席の整理<\/button>/)
  assert.match(side, /<textarea id="tidy-text" data-tidydraft="\/ws\/aoba" rows="4" maxlength="4000">操縦席を整理する。s3の古い状況も直す<\/textarea>/)
  assert.match(side, /<button class="btn pri" type="button" data-tidy="send">窓口に送る<\/button>/)
  assert.match(side, /<p class="mut" data-tidysame hidden>/, '違う指示なら添え書きは隠す')
  const t = text(side)
  assert.match(t, /反映待ちの指示 送信待ち 11\/21\(土\) 10:00に送った・たった今 棚卸し .* 反映待ち 11\/21\(土\) 09:30に送った・30 分前から 自由な指示/, '新しい順')
  assert.doesNotMatch(t, /完了/)
  assert.doesNotMatch(side, /data-jump/, '反映した指示の結果は報告の列で読む')
  assert.doesNotMatch(side, /data-talkstream/, 'タスクの詳細は出さない')
  const opened = whole(model(), { tidy: true, tidyOp: 3 })
  assert.match(opened, /<button type="button" class="cardrow" data-tidy="open" data-op="3" aria-current="true">/, '先頭の行から開いた指示に印')
  assert.match(opened, /<li aria-current="true" data-tidyitem="3">/, '右の一覧のその指示にも印')
})

test('整理・棚卸し: 文が空のあいだ・送っているあいだ・同じ種類と文の指示が反映待ちのあいだは「窓口に送る」を押させない（t163）', () => {
  assert.match(whole(model(), { tidy: true }), /data-tidy="send" disabled>窓口に送る/)
  assert.match(whole(model(), { tidy: true }), /data-tidy="free" aria-pressed="true">自由な指示/, '種類を選んでいなければ自由な指示')
  assert.match(whole(model(), { tidy: true, tidyDraft: { [R]: 'x' }, tidySending: R }), /data-tidy="send" disabled>窓口に送る/)
  const same = whole(model(), { tidy: true, tidyKind: { [R]: 'inventory' }, tidyDraft: { [R]: TIDY_TEXT.inventory } })
  assert.match(same, /data-tidy="send" disabled>窓口に送る/)
  assert.match(same, /<p class="mut" data-tidysame>同じ指示が反映待ちです/)
  const b = model().boards[0]!
  assert.equal(pendingSame(b, 'free', '  #pj-xxx と docs/ を見て、未対応の依頼を棚卸しして\n')?.op_id, 3, '前後の空白は比べない')
  assert.equal(pendingSame(b, 'inventory', '#pj-xxx と docs/ を見て、未対応の依頼を棚卸しして'), undefined, '種類が違えば別の指示')
  assert.equal(pendingSame(b, 'workers', TIDY_TEXT.workers), undefined, '反映した指示と同じ文は送れる')
  assert.equal(pendingSame(b, 'cockpit', TIDY_TEXT.cockpit), undefined, '取り消した指示と同じ文は送れる')
})

test('整理・棚卸し: 種類を選ぶと既定の文を入れる。自由な指示に切り替えると、既定の文のままなら空にし、書き換えた文は残す', () => {
  assert.equal(tidyDraftFor('workers', '書きかけ'), TIDY_TEXT.workers)
  assert.equal(tidyDraftFor('free', TIDY_TEXT.cockpit), '')
  assert.equal(tidyDraftFor('free', '#pj-xxx を見て'), '#pj-xxx を見て')
})
