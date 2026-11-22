// 11/21 の台帳（ledger-*.json）で抜けた 4 件を、版 3 の検査が名指しすることの再生（設計 9 章の受入）。台帳の中身は公開しないので、形だけを写す。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { failureOf, failuresOf, orcaAgents, resetAt, stopReason, type PsRow } from '../window/orca-state.ts'
import { orcaFacts } from '../window/state.ts'
import { dismissable, parseCockpit, unappliedOps, type Card, type Cockpit, type UserLog } from './model.ts'
import { derive, report } from './state.ts'
import { appendOp, parseRulings } from './store.ts'
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
  assert.match(applyChange(c, { cards: [{ ...v40, rev: 2, element_map: [{ n: 3, request: 'r99#1' }] }] }, [], log).errors.join('\n'), /依頼 r99 が無い/)
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
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW).checks.unproven, [{ request: 'r30', when: [1] }])
  c.requests[0]!.evidence = [{ when: 1, kind: 'commit', ref: '10628d2' }]
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW).checks.unproven, [])
  // source だけの依頼も検査の対象（legacy にしない）。発言も出典も無ければ欠けとして出す。
  delete c.requests[0]!.source
  assert.match(report(c, log, [], undefined, 'skipped', NOW).checks.incomplete_requests[0]!.missing.join(), /出典（source）/)
})

test('R39 と t50: R39 の affects に挙がった t50 に reviewed_for が無ければ checks.affected_tasks が名指しする', () => {
  const { c, log } = base()
  c.tasks.push({ id: 't50', stream: 's1', phase: '実装', title: '他の案件の操縦席', state: 'ok' }, { id: 't51', stream: 's1', phase: '実装', title: '移す手順', state: 'ok' })
  const rulings = parseRulings('{"id":"R38","text":"x"}\n{"id":"R39","at":"2026-11-21T19:04:39+09:00","affects":["t50","t51"]}\n{壊れた行\n')
  // 本文と日時も持つ（窓から質問するときに判断の記録を引くため）。
  assert.deepEqual(rulings, [{ id: 'R38', text: 'x' }, { id: 'R39', affects: ['t50', 't51'], at: '2026-11-21T19:04:39+09:00' }])
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW, undefined, { rulings }).checks.affected_tasks, [{ ruling: 'R39', task: 't50' }, { ruling: 'R39', task: 't51' }])
  c.tasks.find((t) => t.id === 't51')!.reviewed_for = ['R39']
  assert.deepEqual(report(c, log, [], undefined, 'skipped', NOW, undefined, { rulings }).checks.affected_tasks, [{ ruling: 'R39', task: 't50' }])
})

// 追加 7（11/21 21:11 の深田さんの指摘）: 担当のチャットが 5 時間の利用枠で止まり、直したあとも詰まりのカードが消えなかった。
test('追加 7: 今夜の担当（outcome failure・usageLimitReached）は「利用枠の上限（22:50 に戻る）」の詰まりになり、「済ませた」で消え、次の失敗でまた出る', async () => {
  const { c, log } = base()
  const failedAt = Date.parse('2026-11-21T21:05:00+09:00')
  const session = '8b03c250-2555-4b88-9253-aa8ab539e0a1'
  // orca orchestration inbox --full の escalation（payload は実物の写し）。
  const failures = failuresOf([{
    type: 'escalation', created_at: '2026-11-21T12:04:59Z',
    payload: JSON.stringify({ taskId: 'task_069cde9db38c', dispatchId: 'ctx_4afbfcc248e3', sessionId: session, agent: 'claude', turnOutcome: 'failure', failureKind: 'usageLimitReached', error: 'Claude hit its session limit.', detail: "You've hit your 5-hour limit · resets 10:50pm (Asia/Tokyo)" })
  }, { type: 'status', created_at: '2026-11-21T12:05:30Z', payload: null }])
  const lead = (since: number): PsRow => ({
    worktreeId: 'r::lead', path: '/ws/lead', parentWorktreeId: 'r::main', displayName: '窓の版 3（担当）',
    agents: [{ paneKey: `structured-agent-session-${session}:x`, orcaSessionId: session, state: 'done', stateStartedAt: since, lastAssistantMessage: null, mainAgent: { outcome: 'failure' } }]
  })
  const rows = (since: number): PsRow[] => [{ worktreeId: 'r::main', path: '/ws/main', parentWorktreeId: null, agents: [] }, lead(since)]
  const stuckOf = (since: number, l: UserLog) => {
    const { workers } = orcaAgents('/ws/main', rows(since), new Map(), c, {}, {}, failures)
    return derive(c, l, [], '/ws/main', { workers }, NOW).queue.filter((r) => r.card.kind === 'stuck')
  }
  const [row] = stuckOf(failedAt, log)
  assert.ok(row)
  assert.equal(row.card.title, '「窓の版 3（担当）」が利用枠の上限')
  assert.equal(row.card.reason, '利用枠の上限（22:50 に戻る）')
  assert.match(row.card.unblock!, /22:50 以降（アカウントを切り替えたなら今）、チャットを開いて「続ける」を押す/)
  assert.equal(row.card.rev, failedAt)
  // 「済ませた」は Orca から作った詰まりにだけ記録できる（帳簿の行が無いので、版は止まった時刻）。
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-dismiss-'))
  mkdirSync(path.join(root, '.orca'), { recursive: true })
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(c))
  const after = await appendOp(root, c, { root, item_id: row.card.id, item_rev: row.card.rev, type: 'dismiss' })
  await assert.rejects(appendOp(root, c, { root, item_id: c.cards[0]!.id, item_rev: c.cards[0]!.rev, type: 'dismiss' }), /Orca から作った詰まりだけ/)
  assert.deepEqual(unappliedOps(c, after), [], '窓口に反映させるものは無い')
  assert.deepEqual(stuckOf(failedAt, after), [])
  // 新しい失敗（止まった時刻が変わる）でまた出る。
  assert.equal(stuckOf(failedAt + 3_600_000, after).length, 1)
  // 取り消せば同じ失敗でもまた出る。
  const undo = await appendOp(root, c, { root, item_id: row.card.id, item_rev: row.card.rev, type: 'undo', undo_of: after.ops.at(-1)!.op_id })
  assert.equal(stuckOf(failedAt, undo).length, 1)
})

test('追加 7: 戻る時刻は 24 時間制で出し、読めなければ出さない。ログイン切れは failureKind か文で分かる', () => {
  assert.equal(resetAt("You've hit your 5-hour limit · resets 10:50pm (Asia/Tokyo)"), '22:50')
  assert.equal(resetAt("You've hit your weekly limit · resets Nov 23 at 4am"), '11/23 04:00')
  assert.equal(resetAt("You've hit your 5-hour limit · resets 12am"), '00:00')
  assert.equal(resetAt("You've reached your Fable limit."), undefined)
  const a = { paneKey: 'structured-agent-session-s:x', orcaSessionId: 's', state: 'done' as const, stateStartedAt: 0, mainAgent: { outcome: 'failure' } }
  assert.equal(stopReason(a, { kind: 'authenticationFailed', at: 0 }), 'auth')
  assert.equal(stopReason(a, { detail: 'Please run /login', at: 0 }), 'auth')
  assert.equal(stopReason(a), 'error')
  // 前の失敗の知らせ（止まった時刻より 5 分以上前）は使わない。
  assert.equal(failureOf({ ...a, stateStartedAt: 10 * 60_000 }, { s: { kind: 'usageLimitReached', at: 0 } }), undefined)
})

test('追加 7（Codex 2 回目）: 止まった時刻の取れない詰まりは隠させない。端末の行を済ませても、同じ停止を Dispatch の行で出し直さない。# の id は帳簿に書けない', async () => {
  const { c, log } = base()
  c.tasks.push({ id: 't9', stream: 's1', phase: '実装', title: 'x', state: 'run', worker: { task_id: 'task_9', run_id: 'run_9' } })
  const agent = { terminalId: 'term_9', title: 'w9', agent: 'claude', state: 'done' as const, since: Date.parse('2026-11-21T18:00:00+09:00'), stop: 'error' as const, task: 't9' }
  const facts = { workers: [agent], dispatches: { ctx_9: { state: 'failed' } }, current: { t9: 'ctx_9' } }
  const ids = (l: UserLog) => derive(c, l, [], '/r', facts, NOW).queue.filter((r) => r.card.kind === 'stuck' && r.card.id.endsWith('9')).map((r) => r.card.id)
  assert.deepEqual(ids(log), ['#agent:term_9'])
  const l2 = { ops: [...log.ops, { op_id: 900, at: '2026-11-21T10:00:00.000Z', item_id: '#agent:term_9', item_rev: agent.since, type: 'dismiss' as const }] }
  assert.deepEqual(ids(l2), [], '済ませた端末の行の代わりに Dispatch の行を出さない')
  // 止まった時刻（settledAt）の無い Dispatch の行は、済ませたを出さず、記録も断る。
  const only = derive(c, log, [], '/r', { workers: [], dispatches: { ctx_9: { state: 'failed' } }, current: { t9: 'ctx_9' } }, NOW).queue.find((r) => r.card.id === '#dispatch:t9')!
  assert.equal(only.card.rev, 0)
  assert.equal(dismissable(only.card), false)
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-dismiss0-'))
  mkdirSync(path.join(root, '.orca'), { recursive: true })
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(c))
  await assert.rejects(appendOp(root, c, { root, item_id: '#dispatch:t9', item_rev: 0, type: 'dismiss' }), /「済ませた」だけ/)
  // # で始まる id のカードは書く道具も読み込みも断る（Orca から作る行と取り違えない）。未反映から外すのは dismiss とその取り消しだけ。
  assert.match(applyChange(c, { cards: [{ id: '#agent:ops', rev: 1, kind: 'review', state: 'open', title: 'x' }] }).errors.join('\n'), /# で始まる/)
  const p: string[] = []
  parseCockpit(JSON.stringify({ ...c, cards: [...c.cards, { id: '#agent:ops', rev: 1, kind: 'review', state: 'open', title: 'x' }] }), p)
  assert.match(p.join('\n'), /カード #agent:ops（id が # で始まる/)
  const l3 = { ops: [...l2.ops, { op_id: 901, at: '2026-11-21T10:00:01.000Z', item_id: '#agent:term_9', item_rev: 0, type: 'undo' as const, undo_of: 900 }, { op_id: 902, at: '2026-11-21T10:00:02.000Z', item_id: 'd21', item_rev: 1, type: 'accept' as const }] }
  assert.deepEqual(unappliedOps({ ...c, applied_ops: log.ops.map((o) => o.op_id) }, l3).map((o) => o.op_id), [902])
})

test('追加 7（Codex 2 回目）: CLI は worker の記録が無くても worktree ps を読み、担当のチャットの停止を窓と同じく出す', async () => {
  const { c } = base()
  c.tasks = c.tasks.map((t) => ({ ...t, worker: undefined }))
  const rows: PsRow[] = [{ worktreeId: 'r::main', path: '/ws/main', parentWorktreeId: null, agents: [] }, {
    worktreeId: 'r::lead', path: '/ws/lead', parentWorktreeId: 'r::main', displayName: '窓の版 3（担当）',
    agents: [{ paneKey: 'structured-agent-session-s1:x', orcaSessionId: 's1', state: 'done', stateStartedAt: 1000, mainAgent: { outcome: 'failure' } }]
  }]
  let shown = 0
  const r = await orcaFacts('/ws/main', c, async () => rows, async () => [], async () => (shown++, null), undefined, async () => ({ s1: { kind: 'usageLimitReached', at: 2000 } }))
  assert.equal(r.state, 'ok')
  assert.equal(shown, 0, 'worker の記録が無ければ Dispatch は問い合わせない')
  assert.deepEqual(r.facts!.workers.map((w) => [w.stop, w.session]), [['limit', 's1']])
})
