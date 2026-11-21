import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nextOp, shownTask, taskOfWorker, overlay, parseCockpit, unappliedOps, worstState, type Cockpit, type Op, type Task } from './model.ts'
import { harness } from '../fixtures/harness.ts'
import { derive } from './state.ts'

/** 開いている決める・聞く・見てが指すタスク（state.ts の derive）。 */
const yourTasks = (c: Cockpit, log: { ops: Op[] }) => new Set(derive(c, log, [], undefined).yours.keys())

const sample = (): Cockpit => parseCockpit(readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8'))
const op = (o: Partial<Op> & Pick<Op, 'op_id' | 'item_id' | 'type'>): Op => ({ at: '2026-11-16T12:00:00+09:00', item_rev: 1, ...o })
const viewOf = (c: Cockpit, ops: Op[], id: string) => overlay(c, { ops }).find((x) => x.item.id === id)!

test('操作が無ければ cockpit.json のとおりに残と片付け済みに分かれる', () => {
  const views = overlay(sample(), { ops: [] })
  assert.deepEqual(views.filter((x) => !x.closed).map((x) => x.item.id), ['d1', 'd3', 'd4', 'd5', 'v1', 'v2', 'd2', 'a2', 'a3', 'a4'])
  assert.equal(views.find((x) => x.item.id === 'x1')!.how, 'メインが片付け')
  assert.equal(views.find((x) => x.item.id === 'x2')!.how, 'あなたが決定「Entra ID」')
})

test('未反映の決定は「反映待ち」で片付け済みに入り、反映されると印が消える', () => {
  const c = sample()
  const ops = [op({ op_id: 1, item_id: 'd1', type: 'decide', option_id: 'auto' })]
  const pending = viewOf(c, ops, 'd1')
  assert.equal(pending.closed, true)
  assert.equal(pending.how, 'あなたが決定「システムが自動で割り当てる」・反映待ち')
  assert.equal(pending.reopenOp?.op_id, 1)

  c.applied_ops = [1]
  Object.assign(c.items.find((i) => i.id === 'd1')!, { state: 'done', resolved_by: 'user', resolved_option: 'auto' })
  const applied = viewOf(c, ops, 'd1')
  assert.equal(applied.how, 'あなたが決定「システムが自動で割り当てる」')
  assert.equal(applied.pending, false)
})

test('未反映の決定を取り消すと残に戻り、取り消しが反映待ちになる', () => {
  const ops = [op({ op_id: 1, item_id: 'd1', type: 'decide', option_id: 'auto' }), op({ op_id: 2, item_id: 'd1', type: 'undo', undo_of: 1 })]
  const v = viewOf(sample(), ops, 'd1')
  assert.equal(v.closed, false)
  assert.equal(v.pending, true)
  assert.equal(v.rejudge, false)
})

test('反映済みの決定を取り消すと、メインの再判断待ちとして残に戻る', () => {
  const c = sample()
  c.applied_ops = [1]
  Object.assign(c.items.find((i) => i.id === 'd1')!, { state: 'done', resolved_by: 'user', resolved_option: 'auto' })
  const ops = [op({ op_id: 1, item_id: 'd1', type: 'decide', option_id: 'auto' }), op({ op_id: 2, item_id: 'd1', type: 'undo', undo_of: 1 })]
  const v = viewOf(c, ops, 'd1')
  assert.equal(v.closed, false)
  assert.equal(v.rejudge, true)
})

test('古い版の項目に押した未反映の操作は効かせない（メインが出し直す）', () => {
  const c = sample()
  c.items.find((i) => i.id === 'd1')!.rev = 2
  const v = viewOf(c, [op({ op_id: 1, item_id: 'd1', item_rev: 1, type: 'decide', option_id: 'auto' })], 'd1')
  assert.equal(v.closed, false)
})

test('メインが古い版の決定を却下して出し直した項目は、反映済みの古い操作で閉じない', () => {
  const c = sample()
  c.applied_ops = [1]
  c.items.find((i) => i.id === 'd1')!.rev = 3
  const v = viewOf(c, [op({ op_id: 1, item_id: 'd1', item_rev: 1, type: 'decide', option_id: 'auto' })], 'd1')
  assert.equal(v.closed, false)
})

test('あなたが決めて反映済みの項目は、反映した操作を残に戻せる', () => {
  const c = sample()
  c.applied_ops = [1]
  Object.assign(c.items.find((i) => i.id === 'd1')!, { state: 'done', resolved_by: 'user', resolved_option: 'auto' })
  const v = viewOf(c, [op({ op_id: 1, item_id: 'd1', type: 'decide', option_id: 'auto' })], 'd1')
  assert.equal(v.reopenOp?.op_id, 1)
  assert.equal(viewOf(c, [], 'x1').reopenOp, undefined)
})

test('archive の項目は片付け済みに入る', () => {
  const c = sample()
  const archived = { ...c.items[0]!, id: 'old', state: 'done' as const, resolved_by: 'main' as const }
  const v = overlay(c, { ops: [] }, [archived]).find((x) => x.item.id === 'old')!
  assert.equal(v.closed, true)
  assert.equal(v.reopenOp, undefined)
})

test('未反映の操作と次の op_id', () => {
  const c = sample()
  c.applied_ops = [1]
  const log = { ops: [op({ op_id: 1, item_id: 'd1', type: 'talk' }), op({ op_id: 2, item_id: 'd2', type: 'approve_ask' })] }
  assert.deepEqual(unappliedOps(c, log).map((o) => o.op_id), [2])
  assert.equal(nextOp(log, { at: 'x', item_id: 'a2', item_rev: 1, type: 'ack' }).op_id, 3)
})

test('大タスクの状態は一番手当てが要るタスクの状態で、外部待ちは未着手より先', () => {
  assert.equal(worstState(['ok', 'idle', 'wait']), 'wait')
  assert.equal(worstState(['run', 'stop']), 'stop')
  assert.equal(worstState([]), undefined)
})

test('利用者の番のタスクは、開いている決める・聞く・見てから指されたものだけ。決めたあとは外れる', () => {
  const c = harness()
  assert.deepEqual([...yourTasks(c, { ops: [] })], ['調査-wait-0'])
  assert.deepEqual([...yourTasks(c, { ops: [op({ op_id: 1, item_id: 'd1', type: 'decide', option_id: 'auto' })] })], [])
})

test('形の違う cockpit.json は例外にする', () => {
  assert.throws(() => parseCockpit('{"items": []}'))
  assert.throws(() => parseCockpit('{ broken'))
  const c = JSON.parse(readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8'))
  c.tasks[0].state = '"><img src=x onerror=alert(1)>'
  assert.throws(() => parseCockpit(JSON.stringify(c)), /state が不正/)
})

test('合図の対象: 自分が書いた操作は猶予の 10 秒、ほかの画面の操作は 30 秒で。未反映の取り消しの組は除き、話したいも同じ猶予で送る', async () => {
  const { signalPlan } = await import('./store.ts')
  const t0 = Date.parse('2026-11-16T12:00:00+09:00')
  const at = (sec: number) => new Date(t0 + sec * 1000).toISOString()
  const ops: Op[] = [
    op({ op_id: 1, item_id: 'd1', type: 'decide', option_id: 'auto', at: at(0) }),
    op({ op_id: 2, item_id: 'a2', type: 'ack', at: at(0) }),
    op({ op_id: 3, item_id: 'd3', type: 'talk', text: 'CSV は来期でよいか', at: at(0) }),
    op({ op_id: 4, item_id: 'd3', type: 'decide', at: at(0) }),
    op({ op_id: 5, item_id: 'd3', type: 'undo', undo_of: 4, at: at(0) })
  ]
  const mine = (o: Op) => o.op_id === 1
  const plan = (sec: number, notified = 0) => signalPlan(sample(), { ops }, notified, t0 + sec * 1000, mine)
  assert.deepEqual(plan(5).due, [])
  assert.equal(plan(5).nextAt, t0 + 10_000)
  assert.deepEqual(plan(11).due.map((o) => o.op_id), [1])
  assert.equal(plan(11).nextAt, t0 + 30_000)
  assert.deepEqual(plan(31).due.map((o) => o.op_id), [1, 2, 3])
  assert.deepEqual(plan(31, 3).due, [])
})

test('同じ瞬間に同じファイルを何度書いても、一時ファイルが取り違えられず全部書ける', async () => {
  const { writeAtomic } = await import('./store.ts')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cockpit-atomic-'))
  const f = path.join(dir, 'focus.json')
  const r = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => writeAtomic(f, String(i))))
  assert.deepEqual(r.filter((x) => x.status === 'rejected'), [])
  rmSync(dir, { recursive: true, force: true })
})

test('見ては accept で片付き、古い版に押した accept は効かない（成果物を差し替えたら出し直す）', () => {
  const c = sample()
  const ok = viewOf(c, [op({ op_id: 1, item_id: 'v1', type: 'accept', item_rev: 2 })], 'v1')
  assert.equal(ok.closed, true)
  assert.equal(ok.how, 'あなたが承認・反映待ち')
  assert.equal(viewOf(c, [op({ op_id: 1, item_id: 'v1', type: 'accept', item_rev: 1 })], 'v1').closed, false)
})

test('requests の形が違う cockpit.json は読み込みで断る', () => {
  const text = (requests: unknown) => JSON.stringify({ ...sample(), requests })
  assert.throws(() => parseCockpit(text({ id: 'r1' })), /requests が配列ではありません/)
  assert.throws(() => parseCockpit(text([{ id: 'r1', state: 'doing' }])), /requests の形が不正です: r1/)
  assert.equal(parseCockpit(text(undefined)).requests, undefined)
})

test('path:行 をファイルと行に分ける', async () => {
  const { splitLine } = await import('./store.ts')
  assert.deepEqual(splitLine('docs/一覧画面.md:12'), { file: 'docs/一覧画面.md', line: 12 })
  assert.deepEqual(splitLine('docs/a.md'), { file: 'docs/a.md' })
  assert.deepEqual(splitLine('/abs/x:y.md'), { file: '/abs/x:y.md' })
})

test('合図の 1 行に、話したいの発言の頭を改行を詰めて載せる', async () => {
  const { signalText, SIGNAL } = await import('./store.ts')
  assert.equal(signalText([op({ op_id: 1, item_id: 'd1', type: 'decide' })]), SIGNAL)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd3', type: 'talk', text: 'CSV は\n来期でよいか' })]), `${SIGNAL}（話したい d3: CSV は 来期でよいか）`)
  assert.equal(signalText([op({ op_id: 1, item_id: 'v1', type: 'talk', to_main: true, text: 'あ'.repeat(70) })]), `${SIGNAL}（メインに渡す v1: ${'あ'.repeat(60)}…）`)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd1', type: 'need_context' })]), `${SIGNAL}（情報が足りない d1）`)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd5', type: 'decide', option_id: 'other', text: 'もう手で送った' })]), `${SIGNAL}（別の答え d5: もう手で送った）`)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd1', type: 'need_context', text: '既存の\n18 社は？' })]), `${SIGNAL}（情報が足りない d1: 既存の 18 社は？）`)
})

test('worker が進めるタスクは、端末の記録 → 同じ worktree の済んでいないもの → 同じ worktree の最後のもの', () => {
  const t = (id: string, state: Task['state'], worker?: Task['worker']): Task => ({ id, stream: 's', phase: 'p', title: id, state, worker })
  const tasks = [t('t1', 'ok', { worktree_id: 'w' }), t('t2', 'ok', { worktree_id: 'w' }), t('t25', 'run', { worktree_id: 'w' }), t('t30', 'ok', { worktree_id: 'w', terminal: 'term_x' })]
  assert.equal(taskOfWorker(tasks, 'w', 'term_x')?.id, 't30')
  assert.equal(taskOfWorker(tasks, 'w', 'term_y')?.id, 't25')
  assert.equal(taskOfWorker(tasks.filter((x) => x.state === 'ok'), 'w', null)?.id, 't30')
  assert.equal(taskOfWorker(tasks, 'other', null), undefined)
})

test('worker の記録があるタスクの状態は Orca の状態から決め、済み・利用者の番・記録の無いタスクはメインの state のまま', () => {
  const t = (state: Task['state'], worker = true): Task => ({ id: 'x', stream: 's', phase: 'p', title: 'x', state, worker: worker ? { worktree_id: 'w' } : undefined })
  const none = new Set<string>()
  assert.deepEqual(shownTask(t('ok'), [{ state: 'working' }], true, none), { state: 'ok', why: 'ok' })
  assert.deepEqual(shownTask(t('wait'), [], true, new Set(['x'])), { state: 'wait', why: 'yours' })
  assert.deepEqual(shownTask(t('run', false), [], true, none), { state: 'run', why: 'record' })
  assert.deepEqual(shownTask(t('ok'), [], undefined, none), { state: 'ok', why: 'ok' })
  assert.deepEqual(shownTask(t('run'), [], undefined, none), { state: 'run', why: 'record' }, 'パネルは Orca の状態が分からない')
  assert.deepEqual(shownTask(t('idle'), [{ state: 'working' }], true, none), { state: 'run', why: 'working' }, 'メインが idle のまま書き忘れても進行中')
  assert.deepEqual(shownTask(t('run'), [{ state: 'blocked', stop: 'blocked' }], true, none), { state: 'stop', why: 'stopped', stop: 'blocked' })
  assert.deepEqual(shownTask(t('run'), [{ state: 'waiting', stop: 'waiting' }], true, none), { state: 'wait', why: 'intake' })
  assert.deepEqual(shownTask(t('run'), [{ state: 'done' }], true, none), { state: 'wait', why: 'intake' })
  assert.deepEqual(shownTask(t('run'), [], true, none), { state: 'wait', why: 'intake' }, 'worktree はあるが端末を閉じた')
  assert.deepEqual(shownTask(t('run'), [], false, none), { state: 'stop', why: 'missing' })
})
