// 11/21 の台帳（ledger-*.json）で抜けた 4 件を、版 3 の検査が名指しすることの再生（設計 9 章の受入）。台帳の中身は公開しないので、形だけを写す。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit, type Card, type Cockpit, type UserLog } from './model.ts'
import { report } from './state.ts'
import { parseRulings } from './store.ts'
import { applyChange } from './write.ts'

const NOW = Date.parse('2026-11-21T19:00:00+09:00')
const base = (): { c: Cockpit; log: UserLog } => {
  const w = structuredClone(sample(NOW)[0]!)
  return { c: parseCockpit(JSON.stringify(w.cockpit)), log: w.log }
}

test('B035: 18:41 の発言が依頼にも none にも結ばれていなければ checks.unsorted が名指しする', () => {
  const { c, log } = base()
  const utterances = [{ id: 'u-1', at: '2026-11-21T18:00:00+09:00', prompt: '一覧を直して' }, { id: 'u-2', at: '2026-11-21T18:41:00+09:00', prompt: '依頼を受けた時点で帳簿に載せる' }]
  c.requests = [{ id: 'r30', at: '2026-11-21T18:00:00+09:00', title: '一覧を直す', utterances: [{ id: 'u-1', quote: '一覧を直して' }], kind: 'work', done_when: ['一覧が直っている'] }]
  c.intake = { through: 'u-1', none: [] }
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW, undefined, { utterances }).checks.unsorted, ['u-2'])
  // 仕分けの位置より前でも、検査済みの境界より後で結ばれていなければ名指しする。
  c.intake = { through: 'u-2', none: [], checked_through: 'u-1' }
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW, undefined, { utterances }).checks.unsorted, ['u-2'])
  c.intake.none = ['u-2']
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW, undefined, { utterances }).checks.unsorted, [])
})

test('A006: 要素に「Teams の見張り」を持つ v40 へのこれでよいは、element_map に Teams の番号が無いと cockpit-write が断り、番号を返す', () => {
  const { c, log } = base()
  const v40: Card = {
    id: 'v40', rev: 1, kind: 'review', state: 'open', title: '組み直しの提案', stream: 's1',
    elements: [{ n: 1, text: '任せる・一緒に作る・見張るの 3 つの形' }, { n: 2, text: 'Slack の見張り' }, { n: 3, text: 'Teams の見張り' }],
    element_map: [{ n: 1, task: 't1' }, { n: 2, task: 't2' }]
  }
  c.cards.push(v40)
  log.ops.push({ op_id: 40, at: '2026-11-21T10:18:00+09:00', item_id: 'v40', item_rev: 1, type: 'accept' })
  const r = applyChange(c, { applied_ops: [40] }, [], log)
  assert.equal(r.next, undefined)
  assert.match(r.errors.join('\n'), /カード v40: 「これでよい」の op 40 を取り込む前に、要素 3 の行き先/)
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW).checks.unmapped_elements, [{ card: 'v40', missing: [3] }])
  // 行き先を書いて片付けるのと op の取り込みは 1 回で書ける。行き先は承認した版の中身に入らないので rev は 1 のまま。
  const mapped: Card = { ...v40, state: 'done', resolved_by: 'user', resolved_at: '2026-11-21T10:20:00+09:00', element_map: [...v40.element_map!, { n: 3, skip: 'BW の Slack から始めると決めた（d64）。Teams は別の依頼にする' }] }
  const ok = applyChange(c, { cards: [mapped], applied_ops: [40] }, [], log)
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(applyChange(c, { cards: [{ ...v40, element_map: mapped.element_map }] }, [], log).errors, [], '開いたまま行き先だけ書くのも rev は 1 のまま')
  // 行き先の参照も検査する。
  assert.match(applyChange(c, { cards: [{ ...v40, rev: 2, element_map: [{ n: 3, request: 'r99#0' }] }] }, [], log).errors.join('\n'), /依頼 r99 が無い/)
})

test('B025: t65 に結んだ依頼の done_when に証拠が無いままタスクが済になったら checks.unproven が名指しする', () => {
  const { c, log } = base()
  c.tasks.push({ id: 't65', stream: 's1', phase: '実装', title: '窓の版 3', state: 'ok' })
  c.intake = { through: '', none: [] }
  c.requests = [{
    id: 'r30', at: '2026-11-21T18:32:00+09:00', title: '止まっている判定を上限の文言に合わせる', tasks: ['t65'], kind: 'work',
    source: { at: '2026-11-21T18:32:00+09:00', quote: '窓の側にも同じ判定の漏れがあり、利用枠の上限の文言に当たりません' },
    done_when: ['orca-state.ts の LIMIT が 3 行の上限の文言に当たる']
  }]
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW).checks.unproven, [{ request: 'r30', when: [0] }])
  c.requests[0]!.evidence = [{ when: 0, kind: 'commit', ref: '10628d2' }]
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW).checks.unproven, [])
  // source だけの依頼も検査の対象（legacy にしない）。発言も出典も無ければ欠けとして出す。
  delete c.requests[0]!.source
  assert.match(report(c, log, [], undefined, 'skipped', NOW).checks.incomplete_requests[0]!.missing.join(), /出典（source）/)
})

test('R39 と t50: R39 の affects に挙がった t50 に reviewed_for が無ければ checks.affected_tasks が名指しする', () => {
  const { c, log } = base()
  c.tasks.push({ id: 't50', stream: 's1', phase: '実装', title: '他の案件の操縦席', state: 'ok' }, { id: 't51', stream: 's1', phase: '実装', title: '移す手順', state: 'ok' })
  const rulings = parseRulings('{"id":"R38","text":"x"}\n{"id":"R39","at":"2026-11-21T19:04:39+09:00","affects":["t50","t51"]}\n{壊れた行\n')
  assert.deepEqual(rulings, [{ id: 'R38' }, { id: 'R39', affects: ['t50', 't51'] }])
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW, undefined, { rulings }).checks.affected_tasks, [{ ruling: 'R39', task: 't50' }, { ruling: 'R39', task: 't51' }])
  c.tasks.find((t) => t.id === 't51')!.reviewed_for = ['R39']
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW, undefined, { rulings }).checks.affected_tasks, [{ ruling: 'R39', task: 't50' }])
})
