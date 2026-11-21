import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { parseCockpit } from './model.ts'
import { navigate, restore, scrollResets } from './nav.ts'
import type { Ui } from './view.ts'

const c = parseCockpit(readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8'))
const ui = (over: Partial<Ui> = {}): Ui => ({ tab: 'todo', pick: {}, showDone: {}, ...over })
const at = (n: number) => () => ({ '.list': n, '.detail': n * 2, page: n * 3 })

test('確認の詳細のたどりの「全体」で、全体のタブの全体の表へ移り、読んでいた確認を戻り先に持つ', () => {
  // 2026-11-17 に、タブが要対応のまま変わらなかった（Codex の指摘）
  const u = ui({ cur: 'd1', curStream: 's1' })
  assert.equal(navigate(u, { whole: '' }, c, 'd1', at(10)), 'moved')
  assert.equal(u.tab, 'whole')
  assert.equal(u.curStream, undefined)
  assert.deepEqual(u.back, { tab: 'todo', item: 'd1', scroll: { '.list': 10, '.detail': 20, page: 30 } })
  const arch = ui({ tab: 'arch', curArch: 'x2' })
  navigate(arch, { whole: '' }, c, undefined, at(1))
  assert.equal(arch.tab, 'whole')
  assert.equal(arch.back?.item, 'x2')
})

test('大タスクの「あなたの番」から別の確認へ下りたら戻り先を消し、上がってきた確認へ下りるときだけ戻る', () => {
  const u = ui({ cur: 'd1' })
  navigate(u, { stream: 's1' }, c, 'd1', at(5))
  assert.equal(u.back?.item, 'd1')
  // 上がってきた確認へは、戻ると同じ（位置を戻す）
  assert.equal(navigate(ui({ ...u }), { goto: 'd1' }, c, 'd1', at(0)), 'back')
  // 別の確認 B へ下りたら、そのあと全体 → 大タスクへ進んでも A への戻る帯を出さない（2026-11-17 に A が残った）
  assert.equal(navigate(u, { goto: 'd3' }, c, 'd1', at(0)), 'moved')
  assert.equal(u.back, undefined)
  assert.equal(u.cur, 'd3')
  navigate(u, { tab: 'whole' }, c, 'd3', at(0))
  navigate(u, { stream: 's1' }, c, 'd3', at(0))
  assert.equal(u.back, undefined, '全体のタブから大タスクへ移っただけでは戻り先を作らない')
  // 対応済みへ下りるときも同じ
  const a = ui({ cur: 'd1' })
  navigate(a, { stream: 's1' }, c, 'd1', at(0))
  navigate(a, { goarch: 'x2' }, c, 'd1', at(0))
  assert.equal(a.back, undefined)
})

test('戻ると上がった時点の確認とタブを開き、測った位置を返す。戻り先は 1 回で消える', () => {
  const u = ui({ cur: 'd5' })
  navigate(u, { task: 't1' }, c, 'd5', at(7))
  assert.deepEqual([u.tab, u.curStream, u.curTask], ['whole', 's1', 't1'])
  assert.equal(navigate(u, { back: '' }, c, undefined, at(0)), 'back')
  assert.deepEqual(restore(u), { '.list': 7, '.detail': 14, page: 21 })
  assert.deepEqual([u.tab, u.cur, u.back], ['todo', 'd5', undefined])
  assert.equal(navigate(u, { back: '' }, c, 'd5', at(0)), 'none')
})

test('パネルではページごと動くので、全体のタブで画面を移ったらページも先頭に戻す。要対応で項目を移ったときは一覧を残す', () => {
  // 2026-11-17 に、パネルで下へ送ってから大タスクへ上がると途中から表示された（Codex の指摘）
  assert.ok(scrollResets(true, true, 'whole').includes('page'))
  assert.ok(scrollResets(false, true, 'whole').includes('page'))
  assert.deepEqual(scrollResets(false, true, 'todo'), ['.detail'])
  assert.deepEqual(scrollResets(false, false, 'whole'), [])
})
