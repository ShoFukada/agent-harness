import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { FAKE_LINT, FIXED_M1, OLD_M1, REAL_SENDS } from '../fixtures/drafts.ts'
import { sample } from '../fixtures/sample.ts'
import { init, migrate, migrateToFacts, write } from '../window/write.ts'
import type { DeferCheck } from './defer.ts'
import { parseCockpit, STATUS_MAX, type Card, type Cockpit, type Request, type Task } from './model.ts'
import { workspaceNameCheck } from './state.ts'
import { applyChange, deferToCheck, draftsToLint, migrateFacts, migrateV3 } from './write.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
/** 仕事には形が要る（t159）。見本の AWS 構成案は担当と一緒に作り、ほかは任せる。 */
const FORMS: Record<string, 'delegate' | 'cowork'> = { s1: 'delegate', s2: 'cowork', s3: 'delegate', s4: 'delegate' }
const aoba = (): Cockpit => {
  const c = structuredClone(sample(NOW)[0]!.cockpit)
  c.streams = c.streams.map((s) => ({ ...s, form: FORMS[s.id] ?? 'delegate' }))
  return c
}
/** 移し替え（migrate-v3 --write）は「顧客｜案件」の形の名前だけを通すので、見本の名前を形に合わせる。 */
const aobaNamed = (): Cockpit => ({ ...aoba(), workspace: { ...aoba().workspace, name: '青葉物流｜配車アプリ' } })
/** 初めて作る帳簿の見本。init は今の形（worker は run_id と task_id）を求めるので、版 2 の dispatch_id の worker を今の形にする。 */
const freshLedger = (): Cockpit => ({ ...aobaNamed(), main: { agent: 'claude', terminal: '', run_id: 'run_m' }, tasks: aobaNamed().tasks.map((t) => (t.worker ? { ...t, worker: { run_id: 'run_w', task_id: t.worker.task_id } } : t)) })
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

test('書く道具: 結果の報告の tidy_op は、cockpit.user.json の整理・棚卸しの指示（tidy の操作）だけを指せる（r132）', () => {
  const c = aoba()
  const log = { ops: [
    { op_id: 3, at: '2026-11-21T01:00:00.000Z', item_id: '', item_rev: 0, type: 'tidy' as const, option_id: 'workers', text: 'workerとworktreeを整理する' },
    { op_id: 4, at: '2026-11-21T01:00:00.000Z', item_id: 'd21', item_rev: 1, type: 'talk' as const }
  ] }
  const report = (tidy_op: unknown) => ({ id: 'x1', rev: 1, kind: 'report', state: 'open', at: '2026-11-21T02:00:00+09:00', stream: c.streams[0]!.id, title: 'workerとworktreeを整理した', done: [{ what: '済んだ worker の worktree を 2 件削除', why: '取り込み済み', undo: 'ブランチから worktree を作り直す' }], tidy_op })
  assert.deepEqual(applyChange(c, { cards: [report(3)], applied_ops: [3] }, [], log).errors, [])
  assert.match(applyChange(c, { cards: [report(4)] }, [], log).errors.join('\n'), /カード x1: tidy_op 4 は cockpit.user.json の整理・棚卸しの指示/)
  assert.match(applyChange(c, { cards: [report(9)] }, [], log).errors.join('\n'), /tidy_op 9/)
  assert.match(applyChange(c, { cards: [report('3')] }, [], log).errors.join('\n'), /カード x1: tidy_op の形が違う/)
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
  assert.match(applyChange(c, { intake: { through: 'u2' } }, utter).errors.join('\n'), /発言 u1・u2 を依頼か none に結ぶ/)
  const bound = { through: 'u2', none: ['u2'] }
  const q1 = { id: 'q1', at: '', title: 't', utterances: [{ id: 'u1', quote: '' }], kind: 'question' as const, done_when: ['答える'] }
  // 見本の t3 は田中さんの返事を待っているので、またいだ発言は待ちと照らしたこと（met か no_wait）も要る（R204）。
  assert.match(applyChange(c, { intake: bound, requests: [q1] }, utter).errors.join('\n'), /開いた待ち t3（田中さん: 利用上限の回答） と照らしていない発言・知らせがある: u1.*u2/)
  assert.ok(applyChange(c, { intake: { ...bound, no_wait: ['u1', 'u2'] }, requests: [q1] }, utter).next)
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
  // 窓口の Run が無い帳簿は、移したあとに書く手順を知らせる（Run が無いと窓の合図が届かず、cockpit-write が断る。R191）。
  assert.ok(!migrateV3(c, log, [], {}, NOW).summary.some((x) => x.includes('main.run_id が無い')))
  assert.ok(migrateV3({ ...c, main: { agent: 'claude', terminal: 'term_main' } }, log, [], {}, NOW).summary.some((x) => x.includes('main.run_id が無い')))
  // 元の中身は変えない。
  assert.equal(c.cards.find((x) => x.id === 'c4')!.kind, 'talk')
})

test('cockpit-write の CLI: 書く前と同じ形の誤りは邪魔せず、ロックの中で一時ファイルから書く。migrate-v3 は元を cockpit.v2.json に控え、2 回目は断る', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-write-'))
  mkdirSync(path.join(root, '.orca', 'cockpit'), { recursive: true })
  const c = aobaNamed() as unknown as { cards: unknown[] }
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
  assert.deepEqual(applyChange(c, { cards: [{ ...d, rev: 2, draft: { to: 'a', text: 'b', format: 'teams' } }] }, [], undefined, { d21: { format: 'teams', violations: [] } }).errors, [])
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
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(aobaNamed()))
  writeFileSync(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 9, at: '2026-11-21T01:00:00.000Z', item_id: 'd21', item_rev: 1, type: 'talk' }] }))
  // 別のプロセスがロックを持っていても、書かない移し替えはロックに触れずに終わる（取りに行けば「ほかの画面が記録中」で断られる）。
  // かかった時間では見ない。重い機械では待たなくても 1 秒を超えうる（追加 43）。
  const held = path.join(root, '.orca', 'cockpit.json.lock')
  writeFileSync(held, 'other')
  await migrate(root, async () => 'run_x', false, NOW)
  assert.equal(readFileSync(held, 'utf8'), 'other', '書かない移し替えはロックを取らない・消さない')
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
  const withNull = { ...c, tasks: [{ ...c.tasks[0]!, goal: null as never }, ...c.tasks.slice(1)] }
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

test('質問の返し: asks[] を質問 id ごとに足し・置き換え、その質問の返しの id だけを受ける。読み込みは id の無い行を外す', () => {
  const c = aoba()
  const row = { id: 'ask3', card: 'd21', memo: '.orca/consult/ask-ask3.md', from_returns: ['ask3-1'], held_returns: [], notify: [{ return_id: 'ask3-1', task: 't1' }] }
  const r = applyChange(c, { asks: [row] })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.next!.asks, [row])
  const sent = applyChange(r.next!, { asks: [{ ...row, notify: [{ return_id: 'ask3-1', task: 't1', message_id: 'msg_1' }] }] }).next!
  assert.deepEqual(sent.asks!.map((a) => a.notify), [[{ return_id: 'ask3-1', task: 't1', message_id: 'msg_1' }]])
  assert.match(applyChange(c, { asks: [{ id: 'q3' }] }).errors.join(), /質問 q3: id は ask<数>/)
  assert.match(applyChange(c, { asks: [{ id: 'ask3', from_returns: ['ask4-1'] }] }).errors.join(), /from_returns は ask3-<数> の配列/)
  assert.match(applyChange(c, { asks: [{ id: 'ask3', notify: [{ return_id: 'ask3-1', message_id: '' }] }] }).errors.join(), /notify は/)
  assert.match(applyChange(c, { asks: [{ id: 'ask3', note: 'x' }] }).errors.join(), /書けない欄 note/)
  assert.deepEqual(applyChange(c, { asks: [{ id: 'ask4', stream: 's2', from_returns: ['ask4-1'] }] }).next!.asks!.find((x) => x.id === 'ask4'), { id: 'ask4', stream: 's2', from_returns: ['ask4-1'] })
  assert.match(applyChange(c, { asks: [{ id: 'ask4', stream: 3 as never }] }).errors.join(), /stream は文字列/)
  assert.ok(!('asks' in applyChange(c, { cards: [] }).next!), '質問の無い帳簿に空の asks を足さない')
  const problems: string[] = []
  assert.deepEqual(parseCockpit(JSON.stringify({ ...c, asks: [row, { title: 'id なし' }] }), problems).asks, [row])
  assert.match(parseCockpit(JSON.stringify({ ...c, asks: {} }), problems) && problems.join(), /asks が配列ではない/)
})

test('main.run_id: 窓口の Run だけを置き換え、ほかの欄は保つ。run_ で始まらない値・ほかの欄は断る。Run の無い帳簿は書けず、Run を一緒に書けば通る（R191）。読み込みも受ける', () => {
  const c = aoba()
  c.main = { agent: 'claude', terminal: 'term_main', run_id: 'run_old' }
  const r = applyChange(c, { main: { run_id: 'run_abc123' } })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.next!.main, { agent: 'claude', terminal: 'term_main', run_id: 'run_abc123' })
  assert.match(applyChange(c, { main: { run_id: 'ctx_1' } }).errors.join(), /main は \{ run_id \} だけ/)
  assert.match(applyChange(c, { main: { run_id: 'run_1', terminal: 'x' } }).errors.join(), /main は \{ run_id \} だけ/)
  // 窓の合図は窓口の Run にだけ送るので、Run を消す・Run の無い帳簿に書くのは断る。
  const noRun = /main\.run_id が無い/
  assert.match(applyChange(c, { main: { run_id: null } }).errors.join(), noRun)
  const bare = { ...c, main: { agent: 'claude', terminal: 'term_main' } }
  const touch = { streams: [structuredClone(c.streams[0]!)] }
  assert.match(applyChange(bare, touch).errors.join(), noRun)
  assert.match(applyChange({ ...c, main: undefined }, touch).errors.join(), noRun)
  assert.deepEqual(applyChange(bare, { ...touch, main: { run_id: 'run_1' } }).errors, [])
  assert.deepEqual(applyChange({ ...c, main: undefined }, { main: { run_id: 'run_1' } }).next!.main, { run_id: 'run_1' })
  // 担当の session の空文字は断る（分からなければ欄ごと書かない）。
  const o = { id: 'o9', title: '担当', stream: 's1' }
  assert.match(applyChange(c, { owners: [{ ...o, session: '' }] }).errors.join(), /担当 o9: session が空/)
  // 開いた担当は居場所（session か terminal）が要る。片付けた担当の行は居場所なしで書ける（t159）。
  assert.match(applyChange(c, { owners: [{ ...o, stream: 's3' }] }).errors.join(), /担当 o9: session（チャットの担当）か terminal/)
  assert.deepEqual(applyChange(c, { owners: [{ ...o, state: 'done' }] }).errors, [])
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
  const quoted = { ...card(c, 'd21'), rev: 2, quote: '任せてもいいかも', draft: { to: '田中さん', text: '送っておきましたね', format: 'mail' as const }, last: { text: '決める感じですね', by: '私' } }
  assert.ok(applyChange(c, { cards: [quoted] }, [], undefined, { d21: { format: 'mail', violations: [] } }).next)
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

const lintDir = mkdtempSync(path.join(tmpdir(), 'cockpit-write-lint-'))
const FAKE = path.join(lintDir, 'draft-format-lint')
writeFileSync(FAKE, FAKE_LINT)
chmodSync(FAKE, 0o755)
const ok = (format: 'slack' | 'teams' | 'mail') => ({ format, violations: [] })
/** 見本の青葉物流に、送る前のカード（m1）を足した帳簿。draft は旧 m1（format の無い、メールの書式の Slack 宛て）。 */
const withOldM1 = (): Cockpit => {
  const c = aoba()
  c.cards.push({ ...card(c, 'd22'), id: 'm1', rev: 2, draft: structuredClone(OLD_M1) })
  return c
}

test('書く道具（R161・R162）: 新しい・開き直した・本文か宛先を変えた送る文面は、draft.format が要り、宛先（via・href）と合い、書式の検査を通ったものだけを書く', () => {
  const c = aoba()
  const m1 = (draft: Card['draft']): Card => ({ ...card(c, 'd22'), id: 'm1', rev: 1, draft })
  // format が無い: via から推した候補を添えて断る。
  assert.deepEqual(applyChange(c, { cards: [m1(OLD_M1)] }).errors, ['カード m1: draft.format が無い。draft.format を slack・teams・mail のどれかで書く（via から推した候補: slack）'])
  assert.match(applyChange(c, { cards: [m1({ to: 'a', href: 'https://acme.slack.com/x', text: 't' })] }).errors[0]!, /（href から推した候補: slack）/)
  assert.match(applyChange(c, { cards: [m1({ to: 'a', via: 'LINE', text: 't' })] }).errors[0]!, /のどれかで書く$/)
  // 宛先と食い違う: format が mail で via が Slack。
  assert.deepEqual(applyChange(c, { cards: [m1({ ...OLD_M1, format: 'mail' })] }, [], undefined, { m1: ok('mail') }).errors,
    ['カード m1: draft.format は mail だが、宛先（via・href）は slack。宛先に合わせて format か via・href を修正する'])
  // 書式の違反: カード・行番号・規則・該当の行・直し方を名指しする。
  const bad = { m1: { format: 'slack' as const, violations: [4, 5].map((line) => ({ line, rule: 'bullet-symbol', text: OLD_M1.text.split('\n')[line - 1]!, fix: '箇条書きは「- 」にする' })) } }
  assert.deepEqual(applyChange(c, { cards: [m1({ ...OLD_M1, format: 'slack' })] }, [], undefined, bad).errors,
    ['カード m1: Slackの書式に合わない行 4 行目「■ 必要なクォータ」・5 行目「・① Global cross-region model inference t…」（bullet-symbol: 箇条書きは「- 」にする）。宛先の書式（dev-standards の message-formats.md）に修正する'])
  // 検査していない・検査できない（CLI が無い）は書かない。
  assert.match(applyChange(c, { cards: [m1(FIXED_M1)] }).errors[0]!, /カード m1: 文面の書式を検査していない/)
  assert.match(applyChange(c, { cards: [m1(FIXED_M1)] }, [], undefined, { m1: { format: 'slack', error: '書式の検査（/x）を起動できない: ENOENT' } }).errors[0]!, /起動できない: ENOENT。書式を確認できないので書かない/)
  assert.ok(applyChange(c, { cards: [m1(FIXED_M1)] }, [], undefined, { m1: ok('slack') }).next)
  // 推せない経路（LINE・GitHub の Issue）は format をそのまま使う。
  assert.ok(applyChange(c, { cards: [m1({ to: 'a', via: 'LINE', text: 't', format: 'slack' })] }, [], undefined, { m1: ok('slack') }).next)
  assert.ok(applyChange(c, { cards: [m1({ to: 'a', href: 'https://github.com/o/r/issues/1', text: 't', format: 'mail' })] }, [], undefined, { m1: ok('mail') }).next)
  // 見て（review）の draft も同じく検査する。
  const r5 = { ...card(c, 'r5'), rev: 2, draft: { to: '見本', text: 'x' } }
  assert.match(applyChange(c, { cards: [r5] }).errors.join('\n'), /カード r5: draft.format が無い/)
  assert.ok(applyChange(c, { cards: [{ ...r5, draft: { ...r5.draft, format: 'teams' as const } }] }, [], undefined, { r5: ok('teams') }).next)
})

test('書く道具（R161・R162）: 返しの反映・片付け・ほかの欄だけの書き換えは、前からある文面（旧 m1）を検査しない', () => {
  const c = withOldM1()
  const m1 = card(c, 'm1')
  // 返しの反映だけ（rev を上げない）
  assert.deepEqual(applyChange(c, { cards: [{ ...m1, from_returns: ['m1-1'], held_returns: ['m1-2'] }] }).errors, [])
  // 片付け
  assert.deepEqual(applyChange(c, { cards: [{ ...m1, state: 'done', resolved_by: 'user', resolved_at: '2026-11-21T10:00:00+09:00' }] }).errors, [])
  // 題だけ直す（文面の本文と宛先は同じ）
  assert.deepEqual(applyChange(c, { cards: [{ ...m1, rev: 3, title: '議事録の共有を依頼する' }] }).errors, [])
  // 片付けたカードを開き直す・本文を変える・宛先を変えるときは検査する。
  const closed = withOldM1()
  closed.cards.find((x) => x.id === 'm1')!.state = 'done'
  assert.match(applyChange(closed, { cards: [{ ...m1, rev: 3 }] }).errors.join('\n'), /カード m1: draft.format が無い/)
  assert.match(applyChange(c, { cards: [{ ...m1, rev: 3, draft: { ...m1.draft!, text: `${m1.draft!.text}\n追記` } }] }).errors.join('\n'), /draft.format が無い/)
  assert.match(applyChange(c, { cards: [{ ...m1, rev: 3, draft: { ...m1.draft!, href: 'https://acme.slack.com/y' } }] }).errors.join('\n'), /draft.format が無い/)
  // 検査に渡す文面は変更の中身だけで決める（帳簿のロックの外で検査するため）。開いていて format が書式の名前の draft だけ。変更の形がどんなでも落ちない。
  const closedM1 = { ...m1, id: 'm4', state: 'done' as const, draft: FIXED_M1 }
  assert.deepEqual(draftsToLint({ cards: [m1, { ...m1, id: 'm2', draft: FIXED_M1 }, closedM1] }), [{ id: 'm2', to: 'slack', text: FIXED_M1.text }])
  assert.deepEqual(draftsToLint({ cards: [{ ...m1, draft: { ...OLD_M1, format: 'slack' } }, { ...m1, rev: 3, draft: FIXED_M1 }] }), [{ id: 'm1', to: 'slack', text: FIXED_M1.text }], '同じ id は後の行（書く行）だけ')
  for (const x of [null, 3, { cards: 'x' }, { cards: [null, { id: 1 }, { id: 'z', state: 'open', draft: 'x' }] }]) assert.deepEqual(draftsToLint(x), [])
  // 検査しない文面（返しの反映だけ）は、検査できなかった結果を渡されても止めない。
  const fmt = withOldM1()
  fmt.cards.find((x) => x.id === 'm1')!.draft!.format = 'slack'
  assert.deepEqual(applyChange(fmt, { cards: [{ ...card(fmt, 'm1'), from_returns: ['m1-1'] }] }, [], undefined, { m1: { format: 'slack', error: 'CLI が無い' } }).errors, [])
})

test('cockpit-write（R161・R162）: 書く前に CLI で検査する。旧 m1 は行を名指しして断り、実例（直した m1・s163〜s165）は通す。CLI が無ければ文面を含む変更だけを断る（fail closed）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-write-lint-ws-'))
  mkdirSync(path.join(root, '.orca'), { recursive: true })
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(withOldM1()))
  const c = withOldM1()
  const m1 = card(c, 'm1')
  const fake = { bin: FAKE }
  const old = await write(root, { cards: [{ ...m1, rev: 3, draft: { ...OLD_M1, format: 'slack' } }] }, true, fake)
  assert.equal(old.errors.length, 1)
  assert.match(old.errors[0]!, /^カード m1: Slackの書式に合わない行 4 行目「■ 必要なクォータ」・5 行目「・① .*」・6 行目「・② .*」・7 行目「・対象は 3 アカウント.*」（bullet-symbol: /)
  const real = [{ ...m1, rev: 3, draft: FIXED_M1 }, ...Object.entries(REAL_SENDS).map(([id, d]) => ({ ...card(c, 'd22'), id, rev: 1, draft: d }))]
  assert.deepEqual((await write(root, { cards: real }, true, fake)).errors, [])
  const none = { bin: path.join(lintDir, 'none') }
  assert.match((await write(root, { cards: [{ ...m1, rev: 3, draft: FIXED_M1 }] }, true, none)).errors[0]!, /カード m1: 書式の検査（.*none）を起動できない: .*ENOENT.*。書式を確認できないので書かない/)
  assert.deepEqual((await write(root, { cards: [{ ...m1, from_returns: ['m1-1'] }] }, true, none)).errors, [], '返しの反映は CLI が無くても書ける')
  assert.deepEqual((await write(root, { applied_ops: [] }, true, none)).errors, [])
})

test('見張る仕事の watch と確認日の欄（追加 31）: 書ける欄にし、形が違えば断る。watch は見張る仕事だけで、その仕事には要る', () => {
  const c = aoba()
  const watch = { automation: 'auto-1', targets: ['管理表', 'Slack #dev'], to: '窓口' }
  const stream = (over: object) => ({ id: 'v1', title: '見回り', form: 'watch', ...over })
  assert.deepEqual(applyChange(c, { streams: [stream({ watch })] }).errors, [])
  assert.match(applyChange(c, { streams: [stream({})] }).errors.join('\n'), /仕事 v1: 見張る仕事は watch を/)
  assert.match(applyChange(c, { streams: [stream({ watch: { ...watch, targets: [] } })] }).errors.join('\n'), /仕事 v1: 見張る仕事は watch を/)
  assert.match(applyChange(c, { streams: [stream({ form: 'delegate', watch })] }).errors.join('\n'), /仕事 v1: watch は見張る仕事（form: watch）だけに書く/)
  assert.match(applyChange(c, { streams: [stream({ watch: { ...watch, every: '30m' } })] }).errors.join('\n'), /仕事 v1: 書けない欄 watch\.every/)
  const task = { ...structuredClone(c.tasks[1]!) }
  const date = (on: string) => ({ kind: 'date' as const, on, what: '回答が届いたかを確かめる' })
  const dated = { tasks: [{ ...task, wait: date('2026-11-24') }] }
  assert.deepEqual(applyChange(c, dated, [], { ops: [] }, {}, deferOf(dated)).errors, [])
  for (const bad of ['2026/11/24', '2026-02-30', '2026-13-01', '2026-11-00', '11-24'])
    assert.match(applyChange(c, { tasks: [{ ...task, wait: date(bad) }] }).errors.join('\n'), /wait の形が違う/)
  // 読み込みは、見張る仕事でない watch と形の違う watch を外して名指しする。
  const problems: string[] = []
  const raw = {
    ...c,
    streams: [...c.streams, stream({ form: 'cowork', watch }), { ...stream({ watch: { automation: '' } }), id: 'v2' }, { ...stream({ watch: { ...watch, every: '30m' } }), id: 'v3' }],
    tasks: [...c.tasks, { ...task, id: 'k13', wait: date('2026-13-01') }]
  }
  // 月 13 の確認日で読み込みが止まらない（Codex 1）。読み書きで余分な欄の扱いをそろえる（Codex 任意）。
  const read = parseCockpit(JSON.stringify(raw), problems)
  assert.deepEqual(read.streams.filter((s) => s.watch).length, 0)
  assert.match(problems.join('\n'), /仕事 v3 の watch の形が違う/)
  assert.match(problems.join('\n'), /k13/)
  assert.match(problems.join('\n'), /仕事 v1 の watch は見張る仕事（form: watch）だけが持つ/)
  assert.match(problems.join('\n'), /仕事 v2 の watch の形が違う/)
})

test('状況の文（status、R188・R204）: 仕事にだけ書け、文字列で STATUS_MAX 字まで。超えたら切らずに断り、柔らかい言い回しも断る。タスクの status は廃止', () => {
  const c = aoba()
  const s1 = structuredClone(c.streams[0]!)
  const t1 = structuredClone(c.tasks.find((x) => x.id === 't1')!)
  const ok = applyChange(c, { streams: [{ ...s1, status: 'stg に出した。田中さんの返事を待っている' }] })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.next!.streams[0]!.status, 'stg に出した。田中さんの返事を待っている')
  assert.match(applyChange(c, { tasks: [{ ...t1, status: '並べ替えは済み' } as Task] }).errors.join('\n'), /タスク t1: status は廃止した（R204）/)
  const long = 'あ'.repeat(STATUS_MAX + 1)
  assert.match(applyChange(c, { streams: [{ ...s1, status: long }] }).errors.join('\n'), new RegExp(`仕事 ${s1.id}: status は ${STATUS_MAX} 字まで（今 ${STATUS_MAX + 1} 字）`))
  assert.deepEqual(applyChange(c, { streams: [{ ...s1, status: 'あ'.repeat(STATUS_MAX) }] }).errors, [])
  // 字はサロゲートも 1 字に数える（😀 は 2 つの UTF-16 の単位）。
  assert.deepEqual(applyChange(c, { streams: [{ ...s1, status: '😀'.repeat(STATUS_MAX) }] }).errors, [])
  assert.match(applyChange(c, { streams: [{ ...s1, status: '😀'.repeat(STATUS_MAX + 1) }] }).errors.join('\n'), /status は/)
  assert.match(applyChange(c, { streams: [{ ...s1, status: 3 as unknown as string }] }).errors.join('\n'), /summary・status は文字列/)
  assert.match(applyChange(c, { streams: [{ ...s1, status: '直しておきました' }] }).errors.join('\n'), /仕事 s1: 柔らかい言い回し status「ておきました」/)
})

test('案件の名前（追加 43・R165）: cockpit-write で workspace.name だけを書け、形の合う名前は通し、外れた名前は state.ts の 1 文で断る。古い外れた名前は止めずに名指しする', () => {
  const c = { ...aoba(), main: { run_id: 'run_m' } }
  const r = applyChange(c, { workspace: { name: '青葉物流｜配車アプリ' } })
  assert.deepEqual(r.errors, [])
  assert.equal(r.next!.workspace.name, '青葉物流｜配車アプリ')
  assert.deepEqual(r.next!.workspace.milestones, c.workspace.milestones, 'milestones は今の値を保つ')
  assert.deepEqual(r.warnings.filter((w) => w.includes('案件の名前')), [])
  for (const bad of ['dev-standards', '社内|ハーネス', 'A｜B｜C', ''])
    assert.deepEqual(applyChange(c, { workspace: { name: bad } }).errors, [workspaceNameCheck(bad)!.message])
  assert.match(applyChange(c, { workspace: { name: '社内｜x', milestones: [] } }).errors.join(), /workspace は \{ name \} だけ/)
  // 移した帳簿に形の外れた名前が残っていても、ほかの書き込みは通し、直し方を名指しする。
  const other = applyChange(c, { streams: [structuredClone(c.streams[0]!)] })
  assert.deepEqual(other.errors, [])
  assert.ok(other.warnings.includes(workspaceNameCheck(c.workspace.name)!.message))
  assert.match(workspaceNameCheck('x')!.message, /cockpit-write に \{ "workspace": \{ "name": "…" \} \}/)
  // intake を初めて付ける書き込みは版 3 への移し替えに当たるので、migrate-v3 と同じく外れた名前を断り、同じ回に直せば通す（Codex 43 必須 1）。
  const v2 = { ...c, intake: undefined }
  const first = { intake: { through: '', none: [] } }
  assert.deepEqual(applyChange(v2, first).errors, [workspaceNameCheck(c.workspace.name)!.message])
  assert.deepEqual(applyChange(v2, { ...first, workspace: { name: '青葉物流｜配車アプリ' } }).errors, [])
})

test('cockpit-write init（追加 43）: 初めて作る帳簿は、版・案件の名前の形・窓口の Run が揃ったものだけを書き、既にあれば上書きしない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-init-'))
  const ledger = freshLedger()
  const file = path.join(root, '.orca', 'cockpit.json')
  // 見本の待ちのタスク（t2・t3）の文は、当たりの無い偽の先送りの検査にかける（本物の defer-guard.py に頼らない）。
  const guard = path.join(mkdtempSync(path.join(tmpdir(), 'cockpit-guard-')), 'defer-guard')
  writeFileSync(guard, '#!/bin/sh\ncase "$2" in *落ち着いてから*) echo 落ち着いてから; exit 1 ;; esac\nexit 0\n')
  chmodSync(guard, 0o755)
  const g = { bin: guard }
  assert.deepEqual(await init(root, { ...ledger, workspace: { name: 'agent-harness' } }, false, g), [workspaceNameCheck('agent-harness', '渡す帳簿の workspace.name を直して init し直す（R165）')!.message])
  assert.match((await init(root, { ...ledger, main: { agent: 'claude' } }, false, g)).join(), /main\.run_id が無い/)
  assert.match((await init(root, { ...ledger, version: 1 }, false, g)).join(), /version は 2/)
  assert.match((await init(root, [], false, g)).join(), /オブジェクト/)
  assert.ok(!existsSync(file), '断ったら何も書かない')
  assert.deepEqual(await init(root, ledger, true, g), [])
  assert.ok(!existsSync(path.join(root, '.orca')), '検査だけ（--dry-run）は .orca も作らない')
  // CLI でも --dry-run は作らない（Codex 43 必須 2）。
  const cli = path.join(import.meta.dirname, '../bin/cockpit-write')
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile(cli, ['--dry-run', 'init', root], { env: { ...process.env, COCKPIT_DEFER_GUARD: guard } }, (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout)))
    child.stdin?.end(JSON.stringify(ledger))
  })
  assert.match(out, /検査を通った（作っていない）/)
  assert.ok(!existsSync(file))
  assert.deepEqual(await init(root, ledger, false, g), [])
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as Cockpit).workspace.name, '青葉物流｜配車アプリ')
  assert.match((await init(root, { ...ledger, workspace: { name: '社内｜別' } }, false, g)).join(), /既にある/)
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as Cockpit).workspace.name, '青葉物流｜配車アプリ', '既にある帳簿は上書きしない')
})

test('migrate-v3（追加 43）: 案件の名前が形から外れていれば、--write は書かずに断り、書かない確かめでは名指しする', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-mig-name-'))
  mkdirSync(path.join(root, '.orca'), { recursive: true })
  const file = path.join(root, '.orca', 'cockpit.json')
  writeFileSync(file, JSON.stringify({ ...aoba(), workspace: { name: 'agent-harness' } }))
  const dry = await migrate(root, async () => 'run_x', false, NOW)
  assert.match(dry.summary[0]!, /案件の名前「agent-harness」.*--write は直すまで断る/)
  await assert.rejects(migrate(root, async () => 'run_x', true, NOW), /移し替えていない: 案件の名前「agent-harness」/)
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as Cockpit).intake, undefined)
  assert.ok(!existsSync(path.join(root, '.orca', 'cockpit.v2.json')))
})

/** 先送りの検査の結果の見本。text に「落ち着いてから」があれば当たり（本物の判定は defer-guard.py。ここでは結果の扱いだけを見る）。 */
const deferOf = (change: unknown): Record<string, DeferCheck> =>
  Object.fromEntries(deferToCheck(change).map((x) => [x.key, x.text.includes('落ち着いてから') ? { hit: '落ち着いてから' } : {}]))
const put = (c: Cockpit, rows: Partial<Task>[]) => {
  const ch = { tasks: rows.map((r) => ({ stream: 's1', phase: '作成', title: 'x', ...r })) }
  return applyChange(c, ch, [], { ops: [] }, {}, deferOf(ch)).errors
}

test('待ちの書き方（追加 48・R193・R204）: 古い欄と open・ok 以外の state を断る。wait は種類ごとの欄が要り、日付だけの文・深田さん・カードの id を書けない。after は在るタスクだけ。待つタスクの文の先送りを断る', () => {
  const c = { ...aobaNamed(), main: { run_id: 'run_m' } }
  c.tasks = [...c.tasks, { id: 't80', stream: 's1', phase: '作成', title: '先', state: 'open' }, { id: 't81', stream: 's1', phase: '作成', title: '済', state: 'ok' }]
  // 古い欄と古い state は書けない（読み込みだけが補う）。
  assert.match(put(c, [{ id: 't90', state: 'idle' as never }]).join(), /タスク t90: state は open か ok/)
  assert.match(put(c, [{ id: 't90', state: 'open', waiting_on: '田中さんの回答' } as Partial<Task>]).join(), /タスク t90: waiting_on は廃止した（R204）/)
  // 種類ごとに要る欄（slot は why、person は who と what、date は on と what）。
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'slot' } as never }]).join(), /タスク t90: wait の形が違う/)
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'person', what: '回答' } as never }]).join(), /wait の形が違う/)
  assert.deepEqual(put(c, [{ id: 't90', state: 'open', wait: { kind: 'slot', why: 'worker の上限' } }]), [])
  // 深田さんを待つものと、カードを待つものはカードから決まる。
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'person', who: '深田さん', what: '承認' } }]).join(), /深田さんを待つものは書かない/)
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'event', what: 'd21 の答え' } }]).join(), /カード d21 を待ちに書かない/)
  // 日付・期間だけ（全角・単位の前の空白も。Codex 48 必須 3）。日付で確かめるなら date に確かめることを書く。
  for (const w of ['12月', '12 月', '１２月', '12/4', '2026-12-04', '2026-12', '12月4日以降', '12月中旬', '来週', '来週末', '月末まで', '年明け'])
    assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'event', what: w } }]).join(), /日付・期間だけ/, w)
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'date', on: '2026-12-04', what: '12月' } }]).join(), /日付・期間だけ/)
  assert.deepEqual(put(c, [{ id: 't90', state: 'open', wait: { kind: 'date', on: '2026-12-04', what: '定例で田中さんが決めたかを確かめる' } }]), [])
  // 前提は在るタスクだけ。自分は指せない。
  assert.deepEqual(put(c, [{ id: 't90', state: 'open', after: ['t80'] }]), [])
  assert.match(put(c, [{ id: 't90', state: 'open', after: ['t99'] }]).join(), /t90\.after: タスク t99 が無い/)
  assert.match(put(c, [{ id: 't90', state: 'open', after: ['t90'] }]).join(), /自分自身を前提にしない/)
  // 解いた事実は記録に在るものだけ（発言 u-…・知らせ n-…・操作 op:…）。
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答', met: [{ by: 'u-9', at: '2026-11-21T09:00:00+09:00' }] } }]).join(), /u-9 が発言・知らせ・操作の記録に無い/)
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'event', what: '知らせ', need: 2, met: [{ by: 'x', at: '' }, { by: 'x', at: '' }] } }]).join(), /同じ証拠を 2 回書かない/)
  // 済のタスクに待ちと新しい next は書かない（残りの確認は別のタスク）。
  assert.match(put(c, [{ id: 't81', state: 'ok', wait: { kind: 'event', what: '届く' } }]).join(), /済のタスクに待ちは書かない/)
  assert.match(put(c, [{ id: 't81', state: 'ok', next: '届いたかを見る' }]).join(), /済にするタスクに next を書かない/)
  // 待つタスクの文の先送り。待ちの無いタスクは見ない。
  assert.match(put(c, [{ id: 't90', state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答' }, next: '落ち着いてから進める' }]).join(), /タスク t90\.next: 都合での先送り「落ち着いてから」/)
  assert.deepEqual(put(c, [{ id: 't90', state: 'open', next: '落ち着いてから進める' }]), [])
  // 検査の結果が無い・検査できないときは通さない（fail closed）
  const ch = { tasks: [{ id: 't90', stream: 's1', phase: '作成', title: 'x', state: 'open' as const, wait: { kind: 'person' as const, who: '田中さん', what: '回答' } }] }
  assert.match(applyChange(c, ch).errors.join(), /t90\.wait\.who: 都合での先送りかを確かめられない（先送りの検査をしていない）/)
  assert.match(applyChange(c, ch, [], { ops: [] }, {}, { 't90.wait.who': {}, 't90.wait.what': { error: 'CLI が無い' } }).errors.join(), /確かめられない（CLI が無い）/)
})

test('待ちの書き方（追加 48）: 元から待っていた行の同じ文は断らない。待ちを新しく書いた行の持ち越した文と、書き換えた文は断る', () => {
  const c = { ...aobaNamed(), main: { run_id: 'run_m' } }
  c.tasks = [...c.tasks,
    { id: 't92', stream: 's1', phase: '作成', title: '古い待ち', state: 'open', wait: { kind: 'event', what: '来週' }, next: '落ち着いてから進める' },
    { id: 't93', stream: 's1', phase: '作成', title: '動いている', state: 'open', next: '落ち着いてから進める' }]
  const row = (id: string) => structuredClone(c.tasks.find((t) => t.id === id)!)
  assert.deepEqual(put(c, [{ ...row('t92'), title: '題だけ直す' }]), [])
  assert.match(put(c, [{ ...row('t92'), next: 'まだ落ち着いてから' }]).join(), /t92\.next: 都合での先送り/)
  assert.match(put(c, [{ ...row('t93'), wait: { kind: 'person', who: '田中さん', what: '回答' } }]).join(), /t93\.next: 都合での先送り/)
})

test('cockpit-write（追加 48）: 待つタスクの文を defer-guard.py（差し替えた偽のスクリプト）で検査し、当たり・起動できないときは書かない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-defer-'))
  mkdirSync(path.join(root, '.orca'), { recursive: true })
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify({ ...aobaNamed(), main: { run_id: 'run_m' } }))
  const guard = path.join(root, 'defer-guard')
  // 本物と同じ入口（--text の文。当たれば標準出力に当たりを出して 1）。
  writeFileSync(guard, '#!/bin/sh\ncase "$2" in *落ち着いてから*) echo 落ち着いてから; exit 1 ;; *壊れた*) exit 3 ;; esac\nexit 0\n')
  chmodSync(guard, 0o755)
  const task = (next: string) => ({ tasks: [{ id: 't90', stream: 's1', phase: '作成', title: 'x', state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答' }, next }] })
  assert.match((await write(root, task('落ち着いてから進める'), false, {}, { bin: guard })).errors.join(), /t90\.next: 都合での先送り「落ち着いてから」/)
  assert.match((await write(root, task('壊れた'), false, {}, { bin: guard })).errors.join(), /t90\.next: 都合での先送りかを確かめられない（先送りの検査（.*）が 3 で終わった/)
  assert.match((await write(root, task('x'), false, {}, { bin: path.join(root, 'missing') })).errors.join(), /確かめられない（先送りの検査（.*）を起動できない/)
  // 当たりの印（終わりのコード 1）なのに当たりの文が無いのは、検査できなかったとして扱う。
  const mute = path.join(root, 'mute-guard')
  writeFileSync(mute, '#!/bin/sh\nexit 1\n')
  chmodSync(mute, 0o755)
  assert.match((await write(root, task('x'), false, {}, { bin: mute })).errors.join(), /確かめられない（先送りの検査（.*）が 1 で終わった/)
  assert.deepEqual((await write(root, task('回答を受けて一覧を直す'), false, {}, { bin: guard })).errors, [])
  assert.equal((JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')) as Cockpit).tasks.find((t) => t.id === 't90')!.next, '回答を受けて一覧を直す')
  // 検査できなくても、待ちの文を変えない書き換え（題だけ）は止めない。
  const now = (JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')) as Cockpit).tasks.find((t) => t.id === 't90')!
  assert.deepEqual((await write(root, { tasks: [{ ...now, title: '題だけ直す' }] }, false, {}, { bin: path.join(root, 'missing') })).errors, [])
})

test('cockpit-write init（追加 48）: 初めて作る帳簿のタスクも、普通の書き込みと同じく待ちの書き方を検査する', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-init-wait-'))
  const guard = path.join(root, 'defer-guard')
  writeFileSync(guard, '#!/bin/sh\ncase "$2" in *落ち着いてから*) echo 落ち着いてから; exit 1 ;; esac\nexit 0\n')
  chmodSync(guard, 0o755)
  const base = freshLedger()
  const withTask = (t: Partial<Task>) => ({ ...base, tasks: [...base.tasks, { id: 't90', stream: 's1', phase: '作成', title: 'x', ...t }] })
  assert.match((await init(root, withTask({ state: 'idle' as never }), true, { bin: guard })).join(), /タスク t90: state は open か ok/)
  assert.match((await init(root, withTask({ state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答' }, next: '落ち着いてから進める' }), true, { bin: guard })).join(), /t90\.next: 都合での先送り/)
  assert.match((await init(root, withTask({ state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答' } }), true, { bin: path.join(root, 'missing') })).join(), /確かめられない/)
  assert.deepEqual(await init(root, withTask({ state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答' } }), true, { bin: guard }), [])
  // 同じ id の行が重なると、先の行が後の行の検査結果で通ってしまうので、重なりごと断る（Codex 48 の 2 巡目）。
  const twice = withTask({ state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答' }, next: '落ち着いてから進める' })
  twice.tasks.push({ id: 't90', stream: 's1', phase: '作成', title: 'x', state: 'open', wait: { kind: 'person', who: '田中さん', what: '回答' }, next: '承認を確かめる' })
  assert.match((await init(root, twice, true, { bin: guard })).join(), /tasks に同じ id の行が重なっている: t90/)
})

/** 移し替えのあと（facts_since あり）で、仕事の状況の文を一度照合して控え（status_basis）を押した帳簿。s1 に開いたタスク t5 を足す。 */
const factsLedger = (): Cockpit => {
  const c = { ...aoba(), facts_since: '2026-11-21T00:00:00.000Z' }
  c.tasks.push({ id: 't5', stream: 's1', phase: '実装', title: '一覧の件数表示', state: 'open', next: 't1 の並べ替えに合わせて件数を出す' })
  const first = applyChange(c, { streams: c.streams.map((s) => ({ ...s, status: `${s.title}を進めている` })) })
  assert.deepEqual(first.errors, [])
  assert.ok(first.next!.streams.every((s) => s.status_basis?.length))
  return first.next!
}

test('状況の文の古さ（R204・Astra 3 の重大 1）: 元の事実が変わった仕事は、同じ書き込みで status を別の文に書き直す。渡さない・同じ文は断り、書き直せば控えを押し直す', () => {
  const c = factsLedger()
  const t3 = structuredClone(c.tasks.find((t) => t.id === 't3')!)
  const met = { ...t3, wait: { ...t3.wait!, met: [{ by: 'u1', at: '2026-11-21T09:00:00+09:00', note: '上限は 1 日 1 万件' }] } }
  assert.match(applyChange(c, { tasks: [met] }).errors.join('\n'), /仕事 s3「.+」の状況の文が古くなった（.*t3.*）。この書き込みで仕事の行を渡し/)
  const s3 = structuredClone(c.streams.find((s) => s.id === 's3')!)
  assert.match(applyChange(c, { tasks: [met], streams: [s3] }).errors.join('\n'), /仕事 s3「.+」: status が前と同じ文/)
  const ok = applyChange(c, { tasks: [met], streams: [{ ...s3, status: '田中さんから上限の回答が届いた。見積もりに入る' }] })
  assert.deepEqual(ok.errors, [])
  assert.notDeepEqual(ok.next!.streams.find((s) => s.id === 's3')!.status_basis, s3.status_basis)
  assert.match(applyChange(c, { tasks: [met], streams: [{ ...s3, status: '回答が届いた', status_basis: [] }] }).errors.join('\n'), /status_basis は書く道具が書く/)
  // 控えを省いた仕事の行（題だけの直し）でも控えは消えない（Astra 4 の重大 3）。
  const renamed = applyChange(c, { streams: [{ id: 's3', title: '利用上限', form: s3.form, status: s3.status } as never] })
  assert.deepEqual(renamed.errors, [])
  assert.deepEqual(renamed.next!.streams.find((s) => s.id === 's3')!.status_basis, s3.status_basis)
  // 事実の変わらない書き込み（題だけ）は仕事の行を求めない。
  assert.deepEqual(applyChange(c, { tasks: [{ ...structuredClone(c.tasks.find((t) => t.id === 't2')!), title: '構成案の図' }] }).errors, [])
})

test('済にしたら同じ仕事を見直す（R204・Astra 3 の重大 2）: 新しく済になったタスクと同じ仕事の開いたタスクは、直すか unaffected に並べる', () => {
  const c = factsLedger()
  const t1 = { ...structuredClone(c.tasks.find((t) => t.id === 't1')!), state: 'ok' as const, next: '' }
  const s1 = { ...structuredClone(c.streams.find((s) => s.id === 's1')!), status: '並べ替えと絞り込みは済んだ。件数表示に入る' }
  assert.match(applyChange(c, { tasks: [t1], streams: [s1] }).errors.join('\n'), /t1「.+」が済になった。前提が変わったかを見直す: t5「一覧の件数表示」（次: t1 の並べ替えに合わせて件数を出す）/)
  assert.deepEqual(applyChange(c, { tasks: [t1], streams: [s1], unaffected: ['t5'] }).errors, [])
  const t5 = { ...structuredClone(c.tasks.find((t) => t.id === 't5')!), next: '並べ替えの結果の件数を出す' }
  assert.deepEqual(applyChange(c, { tasks: [t1, t5], streams: [s1] }).errors, [])
})

test('migrate-facts（R204）: 古い欄を読み込みと同じ規則で読み替え、済のタスクの next を空にし、facts_since を書く。カードは触らず控えは押さない。--write は元を cockpit.v3.json に残す', async () => {
  const raw = aoba() as unknown as Record<string, unknown> & Cockpit
  raw.tasks = [
    { id: 't1', stream: 's1', phase: '実装', title: '一覧', state: 'run', status: '作っている' },
    { id: 't6', stream: 's3', phase: '設計', title: '返事', state: 'wait', waiting_on: '田中さん', check_on: '2026-11-25' },
    { id: 't7', stream: 's3', phase: '設計', title: '日付', state: 'wait', check_on: '2026-11-25', next: '11/25 に届いたかを見る' },
    { id: 't4', stream: 's4', phase: '要件', title: '議事録', state: 'ok', next: '次の定例で確かめる' },
    { id: 't8', stream: 's4', phase: '要件', title: '済んだ', state: 'ok', next: '送る版を作る' }
  ] as never
  const r = migrateFacts(raw, { ops: [] }, [], NOW)
  const t = (id: string) => r.next.tasks.find((x) => x.id === id)!
  assert.equal(r.next.facts_since, new Date(NOW).toISOString())
  assert.deepEqual([t('t1').state, (t('t1') as unknown as Record<string, unknown>).status], ['open', undefined])
  assert.deepEqual(t('t6').wait, { kind: 'person', who: '田中さん', what: '返事' })
  assert.deepEqual(t('t7').wait, { kind: 'date', on: '2026-11-25', what: '11/25 に届いたかを見る' })
  assert.equal(t('t4').next, '')
  assert.equal(t('t8').next, '送る版を作る', '残りの確認らしくない済のタスクの next は残す')
  assert.deepEqual(r.next.cards, raw.cards)
  assert.ok(r.next.streams.every((s) => !s.status_basis))
  assert.ok(r.rows.find((x) => x.id === 't6')!.conflict)
  assert.match(r.rows.find((x) => x.id === 't4')!.why, /next を空にする/)
  assert.throws(() => migrateFacts(r.next, { ops: [] }, [], NOW), /すでに事実から決める形/)

  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-facts-'))
  mkdirSync(path.join(root, '.orca'), { recursive: true })
  const file = path.join(root, '.orca', 'cockpit.json')
  writeFileSync(file, JSON.stringify(raw))
  await migrateToFacts(root, false, NOW)
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(raw), '下見は書かない')
  await migrateToFacts(root, true, NOW)
  assert.equal(readFileSync(path.join(root, '.orca', 'cockpit.v3.json'), 'utf8'), JSON.stringify(raw))
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as Cockpit).facts_since, new Date(NOW).toISOString())
  // 戻して直した帳簿をもう一度移すと、前の控えは残し、時刻つきの別の控えを作る（Astra 4 の中 3）。
  const edited = JSON.stringify({ ...raw, workspace: { ...raw.workspace, name: '直した' } })
  writeFileSync(file, edited)
  const again = await migrateToFacts(root, true, NOW + 1000)
  const other = again.summary.find((x) => x.startsWith('元の控え'))!.match(/cockpit\.v3-\d{8}T\d{6}Z\.json/)![0]
  assert.equal(readFileSync(path.join(root, '.orca', other), 'utf8'), edited)
  assert.equal(readFileSync(path.join(root, '.orca', 'cockpit.v3.json'), 'utf8'), JSON.stringify(raw))
  rmSync(root, { recursive: true })
})

test('cockpit-write init（R204・Astra 4 の重大 4）: 初めて作る帳簿は facts_since と状況の文の控えを押す', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-init-facts-'))
  const guard = path.join(root, 'defer-guard')
  writeFileSync(guard, '#!/bin/sh\nexit 0\n')
  chmodSync(guard, 0o755)
  assert.deepEqual(await init(root, freshLedger(), false, { bin: guard }), [])
  const saved = JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit.json'), 'utf8')) as Cockpit
  assert.ok(saved.facts_since)
  assert.ok(saved.streams.every((s) => s.status_basis?.length))
  rmSync(root, { recursive: true })
})

test('仕分けと待ち（Astra 4 の中 2）: 確認の承認で済になったタスクの待ちには、仕分けを求めない', () => {
  const c = { ...aoba(), intake: { through: '', none: [] } }
  c.cards.push({ id: 'v9', rev: 1, kind: 'review', state: 'done', resolved_by: 'user', resolved_at: '2026-11-21T09:30:00+09:00', title: '見て', tasks: ['t3'] })
  const log = { ops: [{ op_id: 9, at: '2026-11-21T00:30:00.000Z', item_id: 'v9', item_rev: 1, type: 'accept' as const }] }
  const ch = { intake: { through: 'u2', none: ['u1', 'u2'] } }
  assert.match(applyChange(c, ch, utter).errors.join('\n'), /開いた待ち t3/)
  assert.deepEqual(applyChange(c, ch, utter, log).errors, [])
})

test('仕事の形と担当・worker（t159）: 形の無い仕事は書けず、形を決める前にタスク・担当を結べない。一緒に作る仕事は担当なしで残せず、担当の受け取りをタスクの worker に書けない', () => {
  const c = aoba()
  const s1 = c.streams.find((x) => x.id === 's1')!
  const s2 = c.streams.find((x) => x.id === 's2')!
  const t2 = c.tasks.find((x) => x.id === 't2')!
  const o1 = c.owners!.find((x) => x.id === 'o1')!
  // 形を書かない仕事は断る（前は警告だけで書けた）。
  assert.match(applyChange(c, { streams: [{ id: 's9', title: '議事録' }] }).errors.join('\n'), /仕事 s9: form（delegate・cowork・watch）が無い/)
  // 形の無い古い仕事に、タスクも担当も結べない（自由な指示の整理で、形を決めずにタスクを起こしたのを止める）。
  const old = { ...c, streams: [...c.streams, { id: 's9', title: '議事録' }] }
  const t9 = { id: 't9', stream: 's9', phase: '作成', title: '電話の議事録', state: 'open' as const }
  assert.match(applyChange(old, { tasks: [t9] }).errors.join('\n'), /仕事 s9: 形（form）が無いので、タスクを結べない/)
  assert.deepEqual(applyChange(old, { tasks: [t9], streams: [{ id: 's9', title: '議事録', form: 'delegate' }] }).errors, [])
  assert.match(applyChange(old, { owners: [{ id: 'o9', title: '議事録', stream: 's9', session: 'sess-9' }] }).errors.join('\n'), /仕事 s9: 形（form）が無いので、担当を置けない/)
  // 見張る仕事に担当は置かない。1 つの仕事に開いた担当は 1 人。
  const watch = { automation: 'a1', targets: ['Slack #x'], to: 'main' }
  assert.match(applyChange(c, { streams: [{ id: 'w1', title: '見張り', form: 'watch', watch }], owners: [{ id: 'o9', title: '見張り', stream: 'w1', session: 'sess-9' }] }).errors.join('\n'), /仕事 w1: 見張る仕事に担当（o9）は置かない/)
  assert.match(applyChange(c, { owners: [{ id: 'o9', title: '別の担当', stream: 's2', session: 'sess-9' }] }).errors.join('\n'), /仕事 s2: 開いた担当が o1・o9 の 2 人いる/)
  // 一緒に作る仕事の担当だけを外すと、共同作業中の行が消えるので断る。形を任せるに変えるか、タスクを済ませれば外せる。
  assert.match(applyChange(c, { owners: [{ ...o1, state: 'done' }] }).errors.join('\n'), /仕事 s2: 一緒に作る仕事に済んでいないタスク（t2）があるのに、開いた担当がいない/)
  assert.deepEqual(applyChange(c, { owners: [{ ...o1, state: 'done' }], streams: [{ ...s2, form: 'delegate' }] }).errors, [])
  // 担当のいない仕事を一緒に作る形に変えるなら、担当の行を同じ書き込みで足す（担当を立ててから 25 分、行が無かった INTLOOP の s6）。
  const lead = { id: 'o9', title: '配車画面の改修', stream: 's1', session: 'sess-9', worker: { run_id: 'run_l', task_id: 'task_lead' } }
  const noOwner = { ...c, owners: c.owners!.filter((o) => o.stream !== 's1') }
  assert.match(applyChange(noOwner, { streams: [{ ...s1, form: 'cowork' }] }).errors.join('\n'), /仕事 s1: 一緒に作る仕事に済んでいないタスク（t1）があるのに/)
  assert.deepEqual(applyChange(noOwner, { streams: [{ ...s1, form: 'cowork' }], owners: [lead] }).errors, [])
  // 担当の受け取りは owners[].worker だけに書く。タスクの worker に同じ受け取りを書くと断る（窓が担当を worker の停止と読まないため）。
  const both = applyChange(noOwner, { streams: [{ ...s1, form: 'cowork' }], owners: [lead], tasks: [{ ...t2, stream: 's1', worker: { run_id: 'run_l', task_id: 'task_lead' } }] })
  assert.match(both.errors.join('\n'), /タスク t2: worker が担当 o9 の受け取りと同じ/)
  assert.match(applyChange(c, { owners: [{ ...o1, worker: { task_id: 'task_x' } as never }] }).errors.join('\n'), /担当 o1: worker は \{ run_id, task_id \}/)
  // 担当を別の仕事に移すときは、移す前の一緒に作る仕事も見る（Astra 中 1）。交代は片付けと新しい担当を同じ書き込みで書けば通る。
  assert.match(applyChange(c, { owners: [{ ...o1, stream: 's3' }] }).errors.join('\n'), /仕事 s2: 一緒に作る仕事に済んでいないタスク（t2）があるのに、開いた担当がいない/)
  assert.deepEqual(applyChange(c, { owners: [{ ...o1, state: 'done' }, { ...lead, id: 'o9', stream: 's2' }] }).errors, [])
})
