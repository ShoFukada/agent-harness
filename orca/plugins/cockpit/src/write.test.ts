import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { migrate, write } from '../window/write.ts'
import { parseCockpit, type Card, type Cockpit, type Request } from './model.ts'
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
  assert.match(applyChange(c, { cards: [{ ...closed, rev: 2 }] }).errors[0]!, /片付けるときは rev を 1 のまま/)
  // 話し中を終えるために、開いたまま rev だけ上げるのは受ける。
  assert.ok(applyChange(c, { cards: [{ ...card(c, 'd21'), rev: 2 }] }).next)
})

test('書く道具: 必須の欄が欠けたカードは書くが名指しする。op の消し込みとカードの更新を 1 回で書く', () => {
  const c = aoba()
  const thin: Card = { id: 'd40', rev: 1, kind: 'decide', state: 'open', title: '新しい判断', stream: 's1' }
  const log = { ops: [7, 8].map((op_id) => ({ op_id, at: '2026-11-21T01:00:00.000Z', item_id: 'd21', item_rev: 1, type: 'talk' as const })) }
  const r = applyChange(c, { cards: [thin], applied_ops: [7, 8] }, [], log)
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
  assert.match(applyChange(c, { requests: [{ ...base, utterances: [{ id: 'u1', quote: 'x' }], kind: 'work', done_when: ['a'], evidence: [{ when: 0, kind: 'pr', ref: 'x' }] }] }, utter).errors[0]!, /when 0 に当たる済の条件が無い（番号は 1 から）/)
  assert.ok(applyChange(c, { requests: [{ ...base, utterances: [{ id: 'u1', quote: 'x' }], kind: 'work', done_when: ['a'], evidence: [{ when: 1, kind: 'pr', ref: 'x' }] }] }, utter).next)
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
  // 開いた talk は帳簿では talk のまま（版 2 のパネルが読める）。読み込みで相談になる。
  assert.equal(n.cards.find((x) => x.id === 'c4')!.kind, 'talk')
  assert.equal(parseCockpit(JSON.stringify(n)).cards.find((x) => x.id === 'c4')!.kind, 'consult')
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
  writeFileSync(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify({ ops: [5, 6].map((op_id) => ({ op_id, at: '2026-11-21T01:00:00.000Z', item_id: 'd21', item_rev: 1, type: 'talk' })) }))
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

// 版 2 のパネル（main 3ee7c74 の model.ts）が帳簿全体を断る条件。移し替えのあとも、入れ直す前のパネルが読めるようにする（Codex 高 1）。
const V2_KINDS = ['inbox', 'send', 'decide', 'review', 'permit', 'stuck', 'talk', 'report']
test('migrate-v3 のあとの帳簿は、版 2 のパネルが断る形（consult・dispatch_id の無い worker）を作らない', () => {
  const c = aoba()
  const n = migrateV3(c, { ops: [] }, utter, { ctx_aoba_list: 'run_aoba' }, NOW).next
  assert.deepEqual(n.cards.filter((x) => !V2_KINDS.includes(x.kind)).map((x) => x.id), [])
  assert.ok(n.tasks.every((t) => !t.worker || typeof t.worker.dispatch_id === 'string'))
  // 移したあとの talk を書く道具で閉じるとき、読み込みの consult と同じ中身として比べる（rev を上げずに閉じられる）。
  const talk = n.cards.find((x) => x.id === 'c4')!
  const r = applyChange(n, { cards: [{ ...talk, state: 'done', resolved_by: 'owner', resolved_at: '2026-11-21T10:00:00+09:00' }] })
  assert.deepEqual(r.errors, [])
})

test('書く道具: 開いたカードを閉じるときに中身を変える・rev を上げるのを断る（Codex 中 6）', () => {
  const c = aoba()
  const closing: Card = { ...card(c, 'd21'), title: '図を描き足すか（直した）', state: 'done', rev: 2, resolved_by: 'owner', resolved_at: '2026-11-21T10:00:00+09:00' }
  assert.match(applyChange(c, { cards: [closing] }).errors.join('\n'), /カード d21: 片付けるときは rev を 1 のまま、中身を変えない（中身を直すなら/)
  assert.match(applyChange(c, { cards: [{ ...closing, rev: 1 }] }).errors.join('\n'), /片付けるときは rev を 1 のまま/)
})

test('書く道具: 無い op を applied_ops に書かない（あとで押された操作がその番号で消し込まれるため。Codex 高 4）', () => {
  const c = aoba()
  assert.match(applyChange(c, { applied_ops: [1] }).errors[0]!, /applied_ops の 1 は cockpit.user.json に無い操作/)
})

test('書く道具: 入れ子の知らない欄と、形の違うタスクの欄を断る（Codex 中 8）', () => {
  const c = { ...aoba(), intake: { through: '', none: [] } }
  assert.match(applyChange(c, { intake: { throug: 'u1' } as never }, utter).errors.join('\n'), /intake: 書けない欄 throug/)
  assert.match(applyChange(c, { tasks: [{ ...c.tasks[0]!, done: 3 as never }] }).errors.join('\n'), /タスク t1: done の形が違う/)
  assert.match(applyChange(c, { tasks: [{ ...c.tasks[0]!, owner: 'o1' } as never] }).errors.join('\n'), /タスク t1: 書けない欄 owner/)
  const d = card(c, 'd21')
  assert.match(applyChange(c, { cards: [{ ...d, rev: 2, draft: { to: 'a', text: 'b', cc: 'c' } as never }] }).errors.join('\n'), /カード d21: 書けない欄 draft.cc/)
  assert.deepEqual(applyChange(c, { cards: [{ ...d, rev: 2, draft: { to: 'a', text: 'b', format: 'teams' } }] }).errors, [])
  assert.match(applyChange(c, { cards: [{ ...d, rev: 2, draft: { to: 'a', text: 'b', format: 'line' } as never }] }).errors.join('\n'), /カード d21: draft の形が違う/)
  assert.match(applyChange(c, { cards: [{ ...d, rev: 2, options: [{ id: 'a', label: 'A', recomended: true } as never] }] }).errors.join('\n'), /options\[0\]\.recomended/)
  assert.match(applyChange(c, { requests: [{ id: 'q1', at: '', title: 't', utterances: [{ id: 'u1', quote: '' }], kind: 'work', done_when: ['a'], evidence: [{ when: 1, kind: 'pr', ref: 'x', note: 'y' } as never] }] }, utter).errors.join('\n'), /依頼 q1: 書けない欄 evidence\[0\]\.note/)
  // 行に元からある欄（版 2 の仕事の background など）は書き戻せる。足すのは断る。
  const s1 = { ...c.streams[0]!, background: '経緯' } as never
  const withBg = { ...c, streams: [s1, ...c.streams.slice(1)] }
  assert.deepEqual(applyChange(withBg, { streams: [{ ...(s1 as object), title: '新しい題' } as never] }).errors, [])
  assert.match(applyChange(c, { streams: [s1] }).errors.join('\n'), /仕事 s1: 書けない欄 background/)
})

test('書く道具: 依頼の済の条件を減らして、既にあるカードの行き先（r1#2）を宙に浮かせない（Codex 中 9）', () => {
  const c = aoba()
  c.requests = [{ id: 'r1', at: '2026-11-21T09:00:00+09:00', title: '一覧', utterances: [{ id: 'u1', quote: 'x' }], kind: 'work', done_when: ['a', 'b'] }]
  c.cards.push({ id: 'v9', rev: 1, kind: 'review', state: 'done', title: '見て', elements: [{ n: 1, text: 'x' }], element_map: [{ n: 1, request: 'r1#2' }] })
  const r = applyChange(c, { requests: [{ ...c.requests[0]!, done_when: ['a'] }] }, utter)
  assert.match(r.errors.join('\n'), /カード v9: 要素 1 の行き先 r1#2 の済の条件が無くなる（依頼の書き換えで外れる）/)
  assert.deepEqual(applyChange(c, { requests: [{ ...c.requests[0]!, done_when: ['a', 'b', 'c'] }] }, utter).errors, [], '後ろに足すのは受ける')
})

test('migrate-v3: 書かない（--dry-run）ときはロックを取らない。Orca への問い合わせはロックの外で済ませ、その間の書き込みを消さない（Codex 高 5・中 10）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-mig-'))
  mkdirSync(path.join(root, '.orca'), { recursive: true })
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(aoba()))
  writeFileSync(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 9, at: '2026-11-21T01:00:00.000Z', item_id: 'd21', item_rev: 1, type: 'talk' }] }))
  // 別のプロセスがロックを持っていても、書かない移し替えは待たずに終わる。
  writeFileSync(path.join(root, '.orca', 'cockpit.json.lock'), '')
  const t0 = Date.now()
  await migrate(root, async () => 'run_x', false, NOW)
  assert.ok(Date.now() - t0 < 1000, '書かない移し替えはロックを待たない')
  rmSync(path.join(root, '.orca', 'cockpit.json.lock'))
  // 問い合わせの最中に書いた変更は、移し替えの書き込みで消えない。
  await migrate(root, async () => {
    assert.deepEqual((await write(root, { applied_ops: [9] })).errors, [])
    return 'run_x'
  }, true, NOW)
  const saved = JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')) as Cockpit
  assert.deepEqual(saved.applied_ops, [1, 9])
  assert.equal(saved.tasks[0]!.worker!.run_id, 'run_x')
})

test('migrate-v3: 仕分けの一覧の最後の更新は時刻で比べる（+09:00 と Z が混ざっても。Codex 中 11）', () => {
  const c = aoba()
  c.tasks[0]!.done = [{ text: 'a', at: '2026-11-21T10:00:00+09:00' }, { text: 'b', at: '2026-11-21T02:00:00Z' }]
  c.requests = [{ id: 'r1', at: '', title: '進行中', state: 'open', tasks: ['t1'] }]
  assert.equal(migrateV3(c, { ops: [] }, [], {}, NOW).sort[0]!.last, '2026-11-21T02:00:00Z')
})

test('書く道具（Codex 2 回目）: 欄の順だけ違う閉じ方は中身の変更にしない。null は元から null の欄だけ。条件を削って番号の中身が変わる依頼の書き換えを断る', () => {
  const c = aoba()
  const d = card(c, 'd21')
  const reversed = Object.fromEntries(Object.entries({ ...d, state: 'done', resolved_by: 'owner', resolved_at: '2026-11-21T10:00:00+09:00' }).reverse()) as Card
  assert.deepEqual(applyChange(c, { cards: [reversed] }).errors, [])
  assert.match(applyChange(c, { tasks: [{ ...c.tasks[0]!, sources: null as never }] }).errors.join('\n'), /タスク t1: sources の形が違う/)
  const withNull = { ...c, tasks: [{ ...c.tasks[0]!, waiting_on: null as never }, ...c.tasks.slice(1)] }
  assert.deepEqual(applyChange(withNull, { tasks: [{ ...withNull.tasks[0]!, title: '題を直した' }] }).errors, [])
  c.requests = [{ id: 'r1', at: '2026-11-21T09:00:00+09:00', title: '一覧', utterances: [{ id: 'u1', quote: 'x' }], kind: 'work', done_when: ['A', 'B', 'C'] }]
  c.cards.push({ id: 'v9', rev: 1, kind: 'review', state: 'done', title: '見て', elements: [{ n: 1, text: 'x' }], element_map: [{ n: 1, request: 'r1#2' }] })
  assert.match(applyChange(c, { requests: [{ ...c.requests[0]!, done_when: ['A', 'C'] }] }, utter).errors.join('\n'), /カード v9: 要素 1 の行き先 r1#2 の済の条件が変わる/)
  assert.deepEqual(applyChange(c, { requests: [{ ...c.requests[0]!, done_when: ['A', 'B', 'C2'] }] }, utter).errors, [])
})

test('相談の返し: カードの from_returns・held_returns は rev を上げずに書け（開いたままでも、片付けるときも）、依頼の from_return も受ける。return_id の形が違えば断る', () => {
  const c = aoba()
  const d21 = card(c, 'd21')
  const held = applyChange(c, { cards: [{ ...d21, held_returns: ['d21-2'] }] })
  assert.deepEqual(held.errors, [])
  assert.equal(held.next!.cards.find((x) => x.id === 'd21')!.rev, d21.rev)
  const closed = applyChange(held.next!, { cards: [{ ...d21, held_returns: [], from_returns: ['d21-2'], state: 'done', resolved_by: 'user', resolved_option: d21.options![0]!.id, resolved_at: '2026-11-21T10:00:00+09:00' }] })
  assert.deepEqual(closed.errors, [])
  assert.deepEqual(closed.next!.cards.find((x) => x.id === 'd21')!.from_returns, ['d21-2'])
  assert.match(applyChange(c, { cards: [{ ...d21, from_returns: ['d21'] }] }).errors.join(), /from_returns の形が違う/)
  const req: Request = { id: 'r90', at: '2026-11-21T09:30:00+09:00', title: '相談で出た依頼', kind: 'work', done_when: ['図を直す'], utterances: [{ id: 'u1', quote: '図を直して' }], from_return: 'd21-2' }
  const withReq = applyChange(c, { requests: [req] }, utter)
  assert.deepEqual(withReq.errors, [])
  assert.equal(withReq.next!.requests!.find((x) => x.id === 'r90')!.from_return, 'd21-2')
  assert.match(applyChange(c, { requests: [{ ...req, from_return: "x" }] }, utter).errors.join(), /from_return/)
  const problems: string[] = []
  assert.deepEqual(parseCockpit(JSON.stringify(closed.next), problems).cards.find((x) => x.id === 'd21')!.from_returns, ['d21-2'])
  assert.deepEqual(problems, [])
})

test('main.run_id: 窓口の Run だけを置き換え、ほかの欄は保つ。null で消し、run_ で始まらない値・ほかの欄は断る。読み込みも受ける', () => {
  const c = aoba()
  c.main = { agent: 'claude', terminal: 'term_main' }
  const r = applyChange(c, { main: { run_id: 'run_abc123' } })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.next!.main, { agent: 'claude', terminal: 'term_main', run_id: 'run_abc123' })
  assert.deepEqual(applyChange(r.next!, { main: { run_id: null } }).next!.main, { agent: 'claude', terminal: 'term_main' })
  assert.match(applyChange(c, { main: { run_id: 'ctx_1' } }).errors.join(), /main は \{ run_id \} だけ/)
  assert.match(applyChange(c, { main: { run_id: 'run_1', terminal: 'x' } }).errors.join(), /main は \{ run_id \} だけ/)
  assert.equal(applyChange({ ...c, main: undefined }, { main: { run_id: null } }).next!.main, undefined)
  // main の無い帳簿に Run を書いて消すと、main の無い帳簿に戻る（空の main を残さない。Codex 17 軽微）。
  const set = applyChange({ ...c, main: undefined }, { main: { run_id: 'run_1' } }).next!
  assert.deepEqual(set.main, { run_id: 'run_1' })
  assert.ok(!('main' in applyChange(set, { main: { run_id: null } }).next!))
  const problems: string[] = []
  assert.equal(parseCockpit(JSON.stringify(r.next), problems).main?.run_id, 'run_abc123')
  assert.equal(parseCockpit(JSON.stringify({ ...c, main: { ...c.main, run_id: 3 } }), problems).main?.run_id, undefined)
  assert.match(problems.join(), /main\.run_id（3）の形が違う/)
})

test('書く道具: カードとタスクの人が読む欄の柔らかい言い回しを、欄と語を名指しして断る。draft・quote・深田さんの last と、元からある文は見ない（R84）', () => {
  const c = aoba()
  const soft = { ...card(c, 'd21'), rev: 2, purpose: '図を足すかも', last: { text: '送っておきました', by: '担当' }, options: [{ id: 'a', label: 'このままですね' }] }
  const err = applyChange(c, { cards: [soft] }).errors.join('\n')
  assert.match(err, /カード d21: 柔らかい言い回し purpose「かも」・last\.text「ておきました」・options\[0\]\.label「ですね」/)
  // 相手と深田さんの言葉（draft の本文・quote・深田さんの last）は原文のまま書ける。
  const quoted = { ...card(c, 'd21'), rev: 2, quote: '任せてもいいかも', draft: { to: '森さん', text: '送っておきましたね' }, last: { text: '決める感じですね', by: '私' } }
  assert.ok(applyChange(c, { cards: [quoted] }).next)
  // 元からある文の書き戻し（片付けるだけ）は止めない。
  const old = aoba()
  old.cards.find((x) => x.id === 'd21')!.purpose = '図を足すかも'
  assert.ok(applyChange(old, { cards: [{ ...card(old, 'd21'), state: 'done', resolved_by: 'user', resolved_at: '2026-11-21T10:00:00+09:00', resolved_option: 'keep' }] }).next)
  // 推量でない「かも」（〜するかも記録する）は通す。選択肢の具体例と比較表は窓口の文なので見る（Codex 高 1・中 3）。
  assert.ok(applyChange(c, { cards: [{ ...card(c, 'd21'), rev: 2, purpose: '誰が承認するかも記録する' }] }).next)
  const ex = { ...card(c, 'd21'), rev: 2, options: [{ id: 'a', label: '直す', example: '直しておきました' }], compare: { columns: ['案'], rows: [['送るかも']] } }
  assert.match(applyChange(c, { cards: [ex] }).errors.join('\n'), /options\[0\]\.example「ておきました」・compare\.rows\[0\]\[0\]「かも」/)
  // 版 2 の talk は深田さんの last を読み込みで stance に写す。写した文は窓口の文として断らない（Codex 中 2）。
  const talk: Card = { id: 'k9', rev: 1, kind: 'talk', state: 'open', title: '話の続き', stream: 's1', last: { text: '明日かも', by: '私' } }
  assert.ok(applyChange(c, { cards: [structuredClone(talk)] }).next)
  // 読み込みで consult になった形（stance を写したもの）で閉じる書き戻しも止めない（Codex 再レビュー 高 1）。
  const withTalk = aoba()
  withTalk.cards.push(structuredClone(talk))
  const closing = { ...talk, kind: 'consult', stance: '明日かも', state: 'done', resolved_by: 'user', resolved_at: '2026-11-21T10:00:00+09:00' } as Card
  assert.deepEqual(applyChange(withTalk, { cards: [closing] }).errors.filter((e) => e.includes('柔らかい')), [])
  assert.match(applyChange(c, { cards: [{ ...card(c, 'd21'), rev: 2, purpose: '延期かも、先方に確かめる' }] }).errors.join('\n'), /purpose「かも」/)
  const task = { ...c.tasks[0]!, next: '直しちゃいます', done: [{ text: '出しておきました', at: '2026-11-21T09:00:00+09:00' }] }
  assert.match(applyChange(c, { tasks: [task] }).errors.join('\n'), /タスク t1: 柔らかい言い回し next「しちゃ」・done\[0\]\.text「ておきました」/)
})
