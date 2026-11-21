import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { migrate, write } from '../window/write.ts'
import type { Card, Cockpit, Request } from './model.ts'
import { applyChange, migrateV3 } from './write.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const aoba = (): Cockpit => structuredClone(sample(NOW)[0]!.cockpit)
const card = (c: Cockpit, id: string) => structuredClone(c.cards.find((x) => x.id === id)!)
const utter = [{ id: 'u1', at: '2026-11-21T09:00:00+09:00' }, { id: 'u2', at: '2026-11-21T09:10:00+09:00' }, { id: 'u3', at: '2026-11-21T09:20:00+09:00' }]

test('書く道具: 全体の置き換え・知らない欄・形の違う欄・無い参照を断り、理由を返す', () => {
  const c = aoba()
  assert.match(applyChange(c, { version: 3 }).errors[0]!, /書けない欄: version/)
  assert.match(applyChange(c, { cards: { id: 'x' } }).errors[0]!, /cards は id のある行の配列/)
  const bad = { ...card(c, 'r5'), rev: 2, evidence: '確かめた' }
  assert.match(applyChange(c, { cards: [bad] }).errors.join('\n'), /カード r5: evidence の形が違う/)
  const ref = { ...card(c, 'r5'), rev: 2, stream: 's9', tasks: ['t9'], owner: 'o9', request_id: 'r9' }
  const errs = applyChange(c, { cards: [ref] }).errors.join('\n')
  for (const x of ['仕事 s9', 'タスク t9', '担当 o9', '依頼 r9']) assert.match(errs, new RegExp(x))
  assert.match(applyChange(c, { tasks: [{ id: 't1', stream: 's1', phase: '実装', title: 'x', state: 'going' }] }).errors[0]!, /state は/)
})

test('書く道具: 中身を変えたら rev を 1 上げる。片付けるだけなら rev はそのまま（「これでよい」の版の照合を保つ）', () => {
  const c = aoba()
  const edited = { ...card(c, 'd21'), title: '図を描き足すか' }
  assert.match(applyChange(c, { cards: [edited] }).errors[0]!, /rev を 2 にする/)
  assert.ok(applyChange(c, { cards: [{ ...edited, rev: 2 }] }).next)
  const closed: Card = { ...card(c, 'd21'), state: 'done', resolved_by: 'user', resolved_at: '2026-11-21T10:00:00+09:00', resolved_option: 'keep', why: '結果: 図はこのまま送った' }
  assert.ok(applyChange(c, { cards: [closed] }).next)
  assert.match(applyChange(c, { cards: [{ ...closed, rev: 2 }] }).errors[0]!, /片付けるだけなら rev は 1 のまま/)
  // 話し中を終えるために、開いたまま rev だけ上げるのは受ける。
  assert.ok(applyChange(c, { cards: [{ ...card(c, 'd21'), rev: 2 }] }).next)
})

test('書く道具: 必須の欄が欠けたカードは書くが名指しする。op の消し込みとカードの更新を 1 回で書く', () => {
  const c = aoba()
  const thin: Card = { id: 'd40', rev: 1, kind: 'decide', state: 'open', title: '新しい判断', stream: 's1' }
  const r = applyChange(c, { cards: [thin], applied_ops: [7, 8] })
  assert.ok(r.next)
  assert.match(r.warnings.join('\n'), /カード d40: 必須の欄が欠けている.*purpose/)
  assert.deepEqual(r.next!.applied_ops, [1, 7, 8])
  assert.equal(r.next!.cards.length, c.cards.length + 1)
})

test('書く道具: 新しい依頼は発言・済の条件・種類が要り、state と legacy は書けない。worker は run_id で書く', () => {
  const c = aoba()
  const base: Request = { id: 'q1', at: '2026-11-21T09:00:00+09:00', title: '一覧を直す' }
  const errs = applyChange(c, { requests: [{ ...base, state: 'open', legacy: true }] }, utter).errors.join('\n')
  assert.match(errs, /legacy は移し替え/)
  const errs2 = applyChange(c, { requests: [{ ...base, state: 'open' }] }, utter).errors.join('\n')
  for (const x of ['state は書かない', 'utterances', 'done_when', 'kind']) assert.match(errs2, new RegExp(x))
  assert.match(applyChange(c, { requests: [{ ...base, utterances: [{ id: 'u9', quote: 'x' }], kind: 'work', done_when: ['a'] }] }, utter).errors[0]!, /発言 u9 が発言の記録に無い/)
  assert.match(applyChange(c, { requests: [{ ...base, utterances: [{ id: 'u1', quote: 'x' }], kind: 'work', done_when: ['a'], evidence: [{ when: 1, kind: 'pr', ref: 'x' }] }] }, utter).errors[0]!, /when 1 に当たる済の条件が無い/)
  assert.ok(applyChange(c, { requests: [{ ...base, utterances: [{ id: 'u1', quote: 'x' }], kind: 'work', done_when: ['a'] }] }, utter).next)
  assert.match(applyChange(c, { tasks: [{ ...c.tasks[1]!, worker: { task_id: 'task_1', dispatch_id: 'ctx_1' } }] }).errors[0]!, /dispatch_id は書かない/)
  assert.ok(applyChange(c, { tasks: [{ ...c.tasks[1]!, worker: { task_id: 'task_1', run_id: 'run_1' } }] }).next)
})

test('書く道具: 結ばれていない発言をまたいで仕分けの位置（intake.through）を進めない', () => {
  const c = { ...aoba(), intake: { through: '', none: [] } }
  assert.match(applyChange(c, { intake: { through: 'u2' } }, utter).errors[0]!, /発言 u1・u2 を依頼か none に結ぶ/)
  assert.ok(applyChange(c, { intake: { through: 'u2', none: ['u2'] }, requests: [{ id: 'q1', at: '', title: 't', utterances: [{ id: 'u1', quote: '' }], kind: 'question', done_when: ['答える'] }] }, utter).next)
  assert.match(applyChange(c, { intake: { through: 'u9' } }, utter).errors[0]!, /u9 が発言の記録に無い/)
})

test('migrate-v3: 話し中 → 相談、run_id の補い、依頼に legacy と照合できたものの済、仕分けの位置、resolved_at の補い、確認なしで閉じた見て', () => {
  const c = aoba()
  c.tasks[0]!.state = 'ok'
  c.cards.find((x) => x.id === 'd19')!.tasks = ['t4']
  c.requests = [
    { id: 'r1', at: '', title: '済んだもの', state: 'open', tasks: ['t4'] },
    { id: 'r4', at: '', title: 'タスクは済だが返答が無い', state: 'open', tasks: ['t1'] },
    { id: 'r2', at: '', title: '進行中', state: 'open', tasks: ['t1', 't2'] },
    { id: 'r3', at: '', title: '前から済', state: 'done' }
  ]
  c.cards.push({ id: 'v1', rev: 1, kind: 'review', state: 'done', title: '見て（窓口が閉じた）', created_at: '2026-11-20T10:00:00+09:00' })
  c.cards.push({ id: 'v2', rev: 1, kind: 'review', state: 'done', title: '見て（これでよい）', resolved_at: '2026-11-20T11:00:00+09:00' })
  // v3 は前の版に「これでよい」を押したあと、窓口が rev を上げて閉じた（最後の版は誰も見ていない）。
  c.cards.push({ id: 'v3', rev: 2, kind: 'review', state: 'done', title: '見て（直したあと窓口が閉じた）', resolved_at: '2026-11-20T12:00:00+09:00' })
  const log = { ops: [
    { op_id: 1, at: '2026-11-20T11:00:00.000Z', item_id: 'v2', item_rev: 1, type: 'accept' as const },
    { op_id: 2, at: '2026-11-20T09:00:00.000Z', item_id: 'd19', item_rev: 1, type: 'decide' as const, option_id: 'text' },
    { op_id: 3, at: '2026-11-20T11:30:00.000Z', item_id: 'v3', item_rev: 1, type: 'accept' as const }
  ] }
  const r = migrateV3(c, log, utter, { ctx_aoba_list: 'run_aoba' }, NOW)
  const n = r.next
  assert.equal(n.cards.find((x) => x.id === 'c4')!.kind, 'consult')
  assert.deepEqual(n.tasks[0]!.worker, { run_id: 'run_aoba', task_id: 'task_aoba_list', dispatch_id: 'ctx_aoba_list' })
  assert.ok(n.requests!.every((x) => x.legacy))
  assert.equal(n.requests!.find((x) => x.id === 'r1')!.state, 'done')
  assert.deepEqual(r.sort.map((x) => x.id), ['r4', 'r2'])
  assert.deepEqual(n.intake, { through: 'u3', none: [] })
  const v1 = n.cards.find((x) => x.id === 'v1')!
  assert.equal(v1.resolved_at, '2026-11-20T10:00:00+09:00')
  assert.equal(v1.resolved_at_inferred, true)
  assert.equal(v1.closed_without_review, true)
  assert.equal(n.cards.find((x) => x.id === 'v2')!.closed_without_review, undefined)
  assert.equal(n.cards.find((x) => x.id === 'v3')!.closed_without_review, true)
  // 発言に id が無ければ、仕分けの位置は空。
  assert.deepEqual(migrateV3(c, log, [], {}, NOW).next.intake, { through: '', none: [] })
  // 元の中身は変えない。
  assert.equal(c.cards.find((x) => x.id === 'c4')!.kind, 'talk')
})

test('cockpit-write の CLI: 書く前と同じ形の誤りは邪魔せず、ロックの中で一時ファイルから書く。migrate-v3 は元を cockpit.v2.json に控え、2 回目は断る', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-write-'))
  mkdirSync(path.join(root, '.orca', 'cockpit'), { recursive: true })
  const c = aoba() as unknown as { cards: unknown[] }
  c.cards.push({ id: 'bad', rev: 1, kind: 'ask', title: 'x', state: 'open' })
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(c))
  writeFileSync(path.join(root, '.orca', 'cockpit', 'utterances.jsonl'), utter.map((u) => JSON.stringify(u)).join('\n') + '\n')
  const r = await write(root, { applied_ops: [5] })
  assert.deepEqual(r.errors, [])
  assert.match(r.warnings.join('\n'), /書く前からある: 形の誤り: .*カード bad/)
  const saved = JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')) as Cockpit
  assert.deepEqual(saved.applied_ops, [1, 5])
  assert.ok(saved.cards.some((x) => x.id === 'bad'), '形の誤りのカードも消さずに書き戻す')
  assert.equal((await write(root, { applied_ops: [6] }, true)).errors.length, 0)
  assert.deepEqual((JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')) as Cockpit).applied_ops, [1, 5], '--check は書かない')
  const m = await migrate(root, async (d) => (d === 'ctx_aoba_list' ? 'run_aoba' : undefined), true, NOW)
  assert.match(m.summary.join('\n'), /worker に run_id を補った: t1/)
  assert.ok(existsSync(path.join(root, '.orca', 'cockpit.v2.json')))
  await assert.rejects(migrate(root, async () => undefined, true, NOW), /すでに版 3/)
})
