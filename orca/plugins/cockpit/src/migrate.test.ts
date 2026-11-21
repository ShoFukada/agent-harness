import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { plan, write } from '../window/migrate.ts'
import { migrate, oldWorkers, type V1 } from './migrate.ts'
import { overlay, parseCockpit } from './model.ts'

/** 版 1 の形（架空の案件）。実際の案件にある項目の書き方をひと通り含める。 */
const v1 = (): V1 => ({
  version: 1,
  workspace: { name: '見本の案件' },
  main: { agent: 'claude', terminal: 'term_main' },
  summary: '古い要約',
  streams: [{ id: 's1', title: '画面の改修' }],
  tasks: [
    { id: 't1', stream: 's1', phase: '実装', title: '一覧', state: 'run', worker: { task_id: 'task_1', dispatch_id: 'ctx_1' } },
    { id: 't2', stream: 's1', phase: '実装', title: '絞り込み', state: 'run', worker: { worktree_id: 'wt2', terminal: 'term_w2' } },
    { id: 't3', stream: 's1', phase: '実装', title: '最初の画面', state: 'ok', worker: { worktree_id: 'wt3' } }
  ] as unknown as V1['tasks'],
  requests: [{ id: 'r1', at: '2026-11-20', title: '一覧を直して', quote: '一覧で並べ替えたい', state: 'open', tasks: ['t1'], deliverables: [{ id: 'pr', label: 'PR', href: 'https://github.com/example/a/pull/1', look_for: ['並べ替え'] }] }],
  items: [
    { id: 'd1', rev: 1, kind: 'dec', title: '図を描き足すか', state: 'open', related: [{ task: 't1', effect: '図が決まる' }], why: '明日送る', context: { what: 'w' }, options: [{ id: 'a', label: 'A' }] },
    { id: 'd2', rev: 2, kind: 'dec', title: '返信を送る', state: 'open', draft: { to: '森さん', text: '本文' }, options: [{ id: 'posted', label: '投稿した' }] },
    { id: 'd3', rev: 1, kind: 'dec', topic: 'push', title: 'main を push する', why: '直しが入る', state: 'done', resolved_by: 'main', resolved_at: '2026-11-20T10:00:00Z' },
    { id: 'q1', rev: 1, kind: 'ask', title: '上限を聞く', quote: '上限はいくつですか', state: 'open' },
    { id: 'v1', rev: 1, kind: 'rev', title: '一覧の PR', state: 'open', request: 'r1', deliverable: 'pr' },
    { id: 'k1', rev: 1, kind: 'ack', title: '夜の作業', state: 'open', decided: [{ what: 'stg に出した', why: '朝から試験するため', task: 't1' }] },
    { id: 'k2', rev: 1, kind: 'ack', title: '片付けた', why: 'ブランチを消した', state: 'done', resolved_by: 'user', resolved_at: '2026-11-19T10:00:00Z' }
  ],
  applied_ops: [1]
})

test('dec は中身で分ける: push は許す、送る文面があれば送る前、ほかは決める。ask は送る前、rev は見て、ack は報告', () => {
  const c = migrate(v1())
  assert.deepEqual(c.cards.map((x) => [x.id, x.kind]), [['d1', 'decide'], ['d2', 'send'], ['d3', 'permit'], ['q1', 'send'], ['v1', 'review'], ['k1', 'report'], ['k2', 'report']])
})

test('移し替えた中身: 仕事・何のため・依頼の原文と見てほしい点・報告の理由・聞く文面、片付けた人', () => {
  const c = migrate(v1())
  const card = (id: string) => c.cards.find((x) => x.id === id)!
  assert.equal(card('d1').stream, 's1')
  assert.equal(card('d1').purpose, '図が決まる')
  assert.equal(card('v1').request, '一覧で並べ替えたい')
  assert.deepEqual(card('v1').look_for, ['並べ替え'])
  assert.equal(card('v1').href, 'https://github.com/example/a/pull/1')
  assert.deepEqual(card('k1').done, [{ what: 'stg に出した', why: '朝から試験するため', task: 't1' }])
  assert.deepEqual(card('k2').done, [{ what: 'ブランチを消した' }])
  assert.deepEqual(card('q1').draft, { to: '顧客', text: '上限はいくつですか' })
  assert.equal(card('d3').resolved_by, 'owner')
  assert.equal(card('d3').scope, 'push')
})

test('版を 1 つ上げ（古い版の操作を効かせない）、tasks を写す。worker の記録は orchestration の形だけを残し、workerctl の形は外す。要約と items は残さない', () => {
  const c = migrate(v1())
  assert.equal(c.version, 2)
  assert.equal(c.cards.find((x) => x.id === 'd2')!.rev, 3)
  assert.deepEqual(c.tasks.map((t) => [t.id, t.worker]), [['t1', { task_id: 'task_1', dispatch_id: 'ctx_1' }], ['t2', undefined], ['t3', undefined]])
  assert.deepEqual(oldWorkers(v1()), ['t2'])
  assert.equal((c as unknown as Record<string, unknown>).items, undefined)
  assert.equal((c as unknown as Record<string, unknown>).summary, undefined)
  assert.doesNotThrow(() => parseCockpit(JSON.stringify(c)))
  // 移した直後は、古い版に押した話したいが新しいカードを話し中にしない。
  const views = overlay(c, { ops: [{ op_id: 2, at: '', item_id: 'd1', item_rev: 1, type: 'talk' }] })
  assert.equal(views.find((x) => x.card.id === 'd1')!.status, 'mine')
})

test('移し替えの入口: 書くと元を cockpit.v1.json に残し、未反映の操作があれば書かずに断る', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-mig-'))
  mkdirSync(path.join(root, '.orca'))
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(v1()))
  writeFileSync(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 1 }, { op_id: 2, item_id: 'd1', type: 'decide' }] }))
  writeFileSync(path.join(root, '.orca', 'cockpit.archive.json'), JSON.stringify({ items: [v1().items[6]] }))
  const r = await plan(root)
  assert.deepEqual(r.unapplied, [2])
  await assert.rejects(write(root, r), /未反映の操作/)
  assert.equal(JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')).version, 1)
  writeFileSync(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 1 }] }))
  await write(root, await plan(root))
  assert.equal(JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')).version, 2)
  assert.equal(JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.v1.json'), 'utf8')).version, 1)
  assert.equal(JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.archive.json'), 'utf8')).cards[0].kind, 'report')
  await assert.rejects(plan(root), /すでに版 2/)
})

test('移し替えのやり直し: 途中で止まったら残りだけを移し、元の cockpit.v1.json は上書きしない。依頼の成果物も残す', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-mig2-'))
  const dir = path.join(root, '.orca')
  mkdirSync(dir)
  const orig = JSON.stringify(v1())
  writeFileSync(path.join(dir, 'cockpit.json'), orig)
  writeFileSync(path.join(dir, 'cockpit.archive.json'), JSON.stringify({ items: [v1().items[6]] }))
  // archive を書いたところで止まった、を作る: cockpit は版 2・archive は版 1 のまま・元は残っている。
  const r = await plan(root)
  writeFileSync(path.join(dir, 'cockpit.v1.json'), orig)
  writeFileSync(path.join(dir, 'cockpit.json'), JSON.stringify(r.cockpit))
  const rest = await plan(root)
  assert.equal(rest.cockpit, undefined)
  assert.equal(rest.archive?.cards[0]?.kind, 'report')
  await write(root, rest)
  assert.equal(readFileSync(path.join(dir, 'cockpit.v1.json'), 'utf8'), orig)
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'cockpit.archive.json'), 'utf8')).cards.length, 1)
  await assert.rejects(plan(root), /すでに版 2/)
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'cockpit.json'), 'utf8')).requests[0].deliverables[0].id, 'pr')
})

test('plan のあとに押された操作があれば、書く直前に確かめ直して断る', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-mig3-'))
  const dir = path.join(root, '.orca')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'cockpit.json'), JSON.stringify(v1()))
  const r = await plan(root)
  writeFileSync(path.join(dir, 'cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 1 }, { op_id: 2, item_id: 'd1', type: 'decide' }] }))
  await assert.rejects(write(root, r), /未反映の操作/)
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'cockpit.json'), 'utf8')).version, 1)
})

test('plan のあとに窓口が反映した結果を、古い中身で書き戻さない（書くときに作り直す）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-mig4-'))
  const dir = path.join(root, '.orca')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'cockpit.json'), JSON.stringify(v1()))
  const r = await plan(root)
  const applied = { ...v1(), applied_ops: [1, 2], items: v1().items.map((i) => (i.id === 'd1' ? { ...i, state: 'done', resolved_by: 'user', resolved_option: 'a' } : i)) }
  writeFileSync(path.join(dir, 'cockpit.json'), JSON.stringify(applied))
  writeFileSync(path.join(dir, 'cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 1 }, { op_id: 2, item_id: 'd1', type: 'decide' }] }))
  await write(root, r)
  const c = JSON.parse(readFileSync(path.join(dir, 'cockpit.json'), 'utf8'))
  assert.deepEqual(c.applied_ops, [1, 2])
  assert.equal(c.cards.find((x: { id: string }) => x.id === 'd1').resolved_option, 'a')
})
