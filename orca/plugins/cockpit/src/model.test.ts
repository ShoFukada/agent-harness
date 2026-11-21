import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { nextOp, overlay, parseCockpit, shownTask, taskOfWorker, unappliedOps, type Cockpit, type Op, type UserLog } from './model.ts'
import { SIGNAL, signalPlan, signalText, splitLine, writeAtomic } from './store.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const aoba = (): Cockpit => structuredClone(sample(NOW)[0]!.cockpit)
const op = (o: Partial<Op> & Pick<Op, 'op_id' | 'item_id' | 'type'>): Op => ({ at: new Date(NOW).toISOString(), item_rev: 1, ...o })
const statusOf = (c: Cockpit, log: UserLog, id: string) => overlay(c, log).find((v) => v.card.id === id)!

test('操作が無ければ、開いたカードは私の番、話し中のカードは話し中、送ったものは顧客待ち、済んだものは片付いた', () => {
  const c = aoba()
  const log = { ops: [] }
  assert.equal(statusOf(c, log, 'd21').status, 'mine')
  assert.equal(statusOf(c, log, 'c4').status, 'talking')
  assert.equal(statusOf(c, log, 'w1').status, 'waiting')
  assert.equal(statusOf(c, log, 'd19').status, 'closed')
})

test('決めた操作は担当が受け取るまで「受け取り待ち」で片付いたに入り、受け取ると印が消える', () => {
  const c = aoba()
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'decide', option_id: 'keep' })] }
  const v = statusOf(c, log, 'd21')
  assert.equal(v.status, 'closed')
  assert.equal(v.pending, true)
  assert.equal(v.how, '決めた: 図はこのまま、本文で説明する')
  assert.equal(v.undoOp?.op_id, 2)
  // 担当が反映すると cockpit.json の state が正になる。
  c.applied_ops = [1, 2]
  c.cards.find((x) => x.id === 'd21')!.state = 'done'
  Object.assign(c.cards.find((x) => x.id === 'd21')!, { resolved_by: 'user', resolved_option: 'keep' })
  assert.equal(statusOf(c, log, 'd21').pending, false)
})

test('取り消した操作は効かず、カードは私の番に戻る', () => {
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'decide', option_id: 'keep' }), op({ op_id: 3, item_id: 'd21', type: 'undo', undo_of: 2 })] }
  assert.equal(statusOf(aoba(), log, 'd21').status, 'mine')
})

test('古い版に押した操作は効かない（担当が書き換えたら、もう一度私の番になる）', () => {
  const c = aoba()
  c.cards.find((x) => x.id === 'd21')!.rev = 2
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'decide', option_id: 'keep' }), op({ op_id: 3, item_id: 'd21', type: 'talk' })] }
  assert.equal(statusOf(c, log, 'd21').status, 'mine')
})

test('「担当と話す」を押すと話し中になり、担当が書き換えて版が上がると私の番に戻る', () => {
  const c = aoba()
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'talk' })] }
  const v = statusOf(c, log, 'd21')
  assert.equal(v.status, 'talking')
  assert.equal(v.pending, true)
  c.cards.find((x) => x.id === 'd21')!.rev = 2
  assert.equal(statusOf(c, log, 'd21').status, 'mine')
})

test('種類ごとの片付けの言葉: 許すは「許した」、送る前の送ったは「送った」、別の答えは本文', () => {
  const c = sample(NOW)[1]!.cockpit
  const log = { ops: [op({ op_id: 1, item_id: 'p7', type: 'accept' }), op({ op_id: 2, item_id: 'k9', type: 'decide', option_id: 'other', text: '情報部に聞いてから' })] }
  assert.equal(statusOf(c, log, 'p7').how, '許した')
  assert.equal(statusOf(c, log, 'k9').how, '別の答え: 情報部に聞いてから')
  const a = aoba()
  assert.equal(statusOf(a, { ops: [op({ op_id: 2, item_id: 'd22', item_rev: 2, type: 'sent' })] }, 'd22').how, '送った')
})

test('cockpit.json は版 2 だけを読み、版 1 は移し替えの手順を添えて断る', () => {
  assert.doesNotThrow(() => parseCockpit(JSON.stringify(aoba())))
  assert.throws(() => parseCockpit(JSON.stringify({ workspace: { name: 'x' }, streams: [], tasks: [], items: [] })), /migrate\.ts/)
  const bad = { ...aoba(), cards: [{ id: 'x', rev: 1, kind: 'ask', title: 't', state: 'open' }] }
  assert.throws(() => parseCockpit(JSON.stringify(bad)), /kind が不正/)
  assert.throws(() => parseCockpit(JSON.stringify({ ...aoba(), owners: [{ title: 'x' }] })), /owners/)
})

test('未反映の操作と次の op_id', () => {
  const c = aoba()
  const log = { ops: [op({ op_id: 1, item_id: 'd19', type: 'decide' }), op({ op_id: 4, item_id: 'd21', type: 'talk' })] }
  assert.deepEqual(unappliedOps(c, log).map((o) => o.op_id), [4])
  assert.equal(nextOp(log, { at: '', item_id: 'x', item_rev: 1, type: 'ack' }).op_id, 5)
})

test('合図の対象: 自分が書いた操作は 10 秒、ほかの画面の操作は 30 秒。未反映の取り消しの組は除く', () => {
  const c = aoba()
  const at = (s: number) => new Date(NOW - s * 1000).toISOString()
  const log = { ops: [
    { op_id: 2, at: at(12), item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' },
    { op_id: 3, at: at(12), item_id: 'r5', item_rev: 1, type: 'accept' },
    { op_id: 4, at: at(11), item_id: 'r5', item_rev: 1, type: 'undo', undo_of: 3 },
    { op_id: 5, at: at(12), item_id: 'd22', item_rev: 2, type: 'sent' }
  ] as Op[] }
  const plan = signalPlan(c, log, 0, NOW, (o) => o.op_id !== 5)
  assert.deepEqual(plan.due.map((o) => o.op_id), [2])
  assert.equal(plan.nextAt, Date.parse(at(12)) + 30_000)
})

test('合図の 1 行に、担当と話すと別の答えのカードと本文の頭を載せる', () => {
  assert.equal(signalText([op({ op_id: 1, item_id: 'd21', type: 'decide', option_id: 'keep' })]), SIGNAL)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd21', type: 'talk' })]), `${SIGNAL}（担当と話す d21）`)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd21', type: 'decide', option_id: 'other', text: '図は\n描き足す' })]), `${SIGNAL}（別の答え d21: 図は 描き足す）`)
})

test('同じ瞬間に同じファイルを何度書いても、一時ファイルが取り違えられず全部書ける', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cockpit-atomic-')), 'a.json')
  await Promise.all(Array.from({ length: 20 }, (_, n) => writeAtomic(file, String(n))))
  assert.match(readFileSync(file, 'utf8'), /^\d+$/)
})

test('path:行 をファイルと行に分ける', () => {
  assert.deepEqual(splitLine('docs/設計.md:12'), { file: 'docs/設計.md', line: 12 })
  assert.deepEqual(splitLine('docs/a:b.md'), { file: 'docs/a:b.md' })
})

test('worker が進めるタスクは、端末の記録 → 同じ worktree の済んでいないもの → 同じ worktree の最後のもの', () => {
  const t = (id: string, state: 'ok' | 'run', terminal?: string) => ({ id, stream: 's', phase: 'p', title: id, state, worker: { worktree_id: 'w', terminal } })
  const tasks = [t('a', 'ok', 'term_a'), t('b', 'run'), t('c', 'ok')]
  assert.equal(taskOfWorker(tasks, 'w', 'term_a')?.id, 'a')
  assert.equal(taskOfWorker(tasks, 'w', null)?.id, 'b')
  assert.equal(taskOfWorker([tasks[0]!, tasks[2]!], 'w', null)?.id, 'c')
})

test('worker の記録があるタスクは Orca の状態から、外の相手を待つタスクと記録の無いタスクはメインの state のまま', () => {
  const t = { id: 't', stream: 's', phase: 'p', title: 't', state: 'idle' as const, worker: { worktree_id: 'w' } }
  assert.deepEqual(shownTask(t, [{ state: 'working' }], true), { state: 'run', why: 'working' })
  assert.deepEqual(shownTask(t, [{ state: 'done', stop: 'dead' }], true), { state: 'stop', why: 'stopped', stop: 'dead' })
  assert.deepEqual(shownTask(t, [], true), { state: 'wait', why: 'intake' })
  assert.deepEqual(shownTask(t, [], false), { state: 'stop', why: 'missing' })
  assert.deepEqual(shownTask(t, [], undefined), { state: 'idle', why: 'record' })
  assert.deepEqual(shownTask({ ...t, state: 'wait' }, [{ state: 'working' }], true), { state: 'wait', why: 'record' })
})
