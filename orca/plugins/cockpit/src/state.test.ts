import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit, requestCards, stageOf, taskSig, type Card, type Cockpit, type Ruling, type TaskSeen } from './model.ts'
import type { AgentRow, OwnerLive, QuestionFact } from './protocol.ts'
import { bucketOf, byUrgency, coworkSessions, derive, fmtDate, lastParagraph, lookupTerms, tokyoDay, tokyoStart, waitLabel, matchRulings, NAME_MAX, ownerName, streamName, workerName, ORCA_STATUS, report, routeProblem, unreflectedReturns, workspaceNameOk, WORKSPACE_NAME_FORM, type Row } from './state.ts'
import { emptyFiles, loadFiles, parseAskMemo, parseRulings } from './store.ts'
import { chatHandles, liveChats } from '../window/orca-state.ts'
import { orcaFacts } from '../window/state.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const ws = (n: number) => {
  const w = structuredClone(sample(NOW)[n]!)
  w.cockpit = parseCockpit(JSON.stringify(w.cockpit))
  return w
}
const agent = (over: Partial<AgentRow>): AgentRow => ({ terminalId: 'term_x', title: 'x', agent: 'claude', state: 'working', since: NOW - 25 * 60_000, ...over })

test('私の番は期限順の 1 列。件数は送る前・決める・見て・許す・詰まりの 5 種類だけで、相談は並べるが数えず、届いた・報告も数えない', () => {
  const w = ws(0)
  const d = derive(w.cockpit, w.log, [], '/a', undefined, NOW)
  assert.deepEqual(d.queue.map((r) => r.card.id), ['d22', 'd21', 'r5', 'c4', 'i3'])
  assert.equal(d.total, 3)
  assert.equal(d.counts.consult, 1)
  assert.equal(d.counts.inbox, 1)
  assert.deepEqual(d.talking.map((r) => r.card.id), [])
  assert.deepEqual(d.waiting.map((r) => r.card.id), ['w1'])
  assert.deepEqual(d.closed.map((r) => r.card.id), ['d19'])
})

test('期限の区切り: 詰まりは期限に関係なく先頭、過ぎたら期限切れ、今日・明日・今週・それより先・期限なし', () => {
  const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString()
  assert.equal(bucketOf(at(-1), NOW, 'stuck'), 'stuck')
  assert.equal(bucketOf(at(-1), NOW), 'over')
  assert.equal(bucketOf(at(2), NOW), 'today')
  assert.equal(bucketOf(at(24), NOW), 'tomorrow')
  assert.equal(bucketOf(at(72), NOW), 'week')
  assert.equal(bucketOf(at(24 * 10), NOW), 'later')
  assert.equal(bucketOf(undefined, NOW), 'none')
})

test('Orca で止まった worker は詰まりの行になり、仕事の名前（サイドバーと同じ）・理由・答えれば進むかを出す', () => {
  const w = ws(2)
  const d = derive(w.cockpit, w.log, [], '/h', { workers: [agent({ terminalId: 'term_h_w1', state: 'blocked', stop: 'blocked', task: 'u1' })] }, NOW)
  const stuck = d.queue[0]!
  assert.equal(stuck.card.kind, 'stuck')
  assert.equal(stuck.card.title, '「ログ集計の見直し」が許可待ち')
  assert.equal(stuck.card.answerable, true)
  assert.equal(stuck.agent?.terminalId, 'term_h_w1')
  assert.equal(d.counts.stuck, 1)
  const dead = derive(w.cockpit, w.log, [], '/h', { workers: [agent({ stop: 'dead', task: 'u1' })] }, NOW).queue[0]!
  assert.equal(dead.card.answerable, false)
})

test('担当が書いた詰まりと同じ仕事の worker は、詰まりを 2 つ出さない（タスクでも担当の端末でも引く）', () => {
  const w = ws(1)
  const d = derive(w.cockpit, w.log, [], '/k', { workers: [agent({ terminalId: 'term_konan_w2', state: 'waiting', stop: 'waiting' })] }, NOW)
  assert.deepEqual(d.queue.filter((r) => r.card.kind === 'stuck').map((r) => r.card.id), ['k9'])
})

test('話す相手: カードの仕事に担当がいれば担当（チャットか端末）、いなければ案件の窓口', () => {
  const w = ws(0)
  const d = derive(w.cockpit, w.log, [], '/a', { workers: [], owners: [{ session: 'sess-aws', kind: 'chat', state: 'working' }] }, NOW)
  const by = (id: string) => [...d.queue, ...d.talking].find((r) => r.card.id === id)!.owner
  assert.deepEqual([by('d21').title, by('d21').how, by('d21').state], ['AWS 構成案', 'chat', 'working'])
  assert.deepEqual([by('r5').title, by('r5').how, by('r5').terminal], ['配車画面の改修', 'terminal', 'term_aoba_w1'])
  assert.deepEqual([by('d22').title, by('d22').how, by('d22').terminal], ['窓口', 'main', 'term_aoba_main'])
})

test('案件の今: 仕事ごとに 私待ち・止まっている・作業中・顧客待ち・未着手・済 を決め、私待ちを先にする', () => {
  const w = ws(0)
  const d = derive(w.cockpit, w.log, [], '/a', undefined, NOW)
  assert.deepEqual(d.jobs.map((j) => [j.title, j.state]), [['配車画面の改修', 'mine'], ['AWS 構成案', 'mine'], ['定例と議事録', 'mine'], ['外部 API の繋ぎ込み', 'customer']])
  assert.equal(d.jobs[3]!.label, '森さんの返事待ち')
  assert.equal(d.jobs[0]!.next, 'レビューの指摘を直して stg に出す')
})

test('サイドバーの状態は案件の今と同じ判定: 私待ちは in-review と未読の印、作業中は in-progress、済は completed', () => {
  assert.equal(ORCA_STATUS.mine, 'in-review')
  assert.equal(ORCA_STATUS.working, 'in-progress')
  assert.equal(ORCA_STATUS.done, 'completed')
  const w = ws(0)
  const r = report(w.cockpit, w.log, [], undefined, 'skipped', NOW)
  assert.deepEqual(r.jobs[0]!.orca, { display_name: '配車画面の改修', status: 'in-review', unread: true })
  assert.deepEqual(r.jobs[3]!.orca, { display_name: '外部 API の繋ぎ込み', status: 'in-progress', unread: false })
})

test('hook が読む全体の 1 行と検査: 催促の日を過ぎた顧客待ち・つながらないカード・長すぎる名前・push の確認', () => {
  const w = ws(0)
  const c: Cockpit = { ...w.cockpit, streams: [...w.cockpit.streams, { id: 's9', title: 'あ'.repeat(NAME_MAX + 1) }], tasks: [...w.cockpit.tasks, { id: 't9', stream: 's9', phase: '実装', title: 'x', state: 'run' }] }
  const r = report(c, w.log, [], undefined, 'skipped', NOW)
  assert.equal(r.overview, '全体: 私の番 3 件（判断 1・送信前 1・確認 1）・話し中 0・顧客待ち 1・動いている worker 0')
  assert.deepEqual(r.checks.remind_due, ['w1'])
  assert.deepEqual(r.checks.long_names, [`s9（${NAME_MAX + 1} 字）`])
  assert.equal(r.next?.id, 'd22')
  assert.deepEqual(r.overdue, ['d22'])
  const h = ws(2)
  for (const x of h.cockpit.cards) if (x.id !== 'r8') delete x.stream
  const hr = report(h.cockpit, h.log, [], undefined, 'skipped', NOW)
  assert.deepEqual(hr.checks.orphan_cards, ['p9', 'r9', 'd30', 'd28'])
  assert.equal(hr.checks.push_check, false)
})

test('経路が読めていない: 失敗・まだ読んでいない・既定 2 時間より古い', () => {
  assert.equal(routeProblem({ id: 's', label: 'Slack', read_at: new Date(NOW - 60_000).toISOString() }, NOW), undefined)
  assert.match(routeProblem({ id: 't', label: 'Teams', read_at: new Date(NOW - 5 * 3_600_000).toISOString() }, NOW)!, /から読めていない/)
  assert.equal(routeProblem({ id: 'm', label: 'メール' }, NOW), 'メール: まだ読んでいない')
  assert.equal(routeProblem({ id: 'm', label: 'メール', error: 'ログイン切れ' }, NOW), 'メール: ログイン切れ')
})

test('Dispatch で落ちた・Orca に見つからない worker は、端末が消えていても詰まりの票にする。worker_done を返したら取り込み待ち', () => {
  const w = ws(0)
  const dead = derive(w.cockpit, w.log, [], '/a', { workers: [], dispatches: { ctx_aoba_list: { state: 'dispatched', liveness: 'exited' } } }, NOW)
  const s = dead.queue.find((r) => r.card.id === '#dispatch:t1')!
  assert.equal(s.card.title, '「配車画面の改修」が落ちた')
  assert.equal(s.card.answerable, false)
  const gone = derive(w.cockpit, w.log, [], '/a', { workers: [], dispatches: {} }, NOW)
  assert.equal(gone.queue.find((r) => r.card.id === '#dispatch:t1')!.card.title, '「配車画面の改修」が Orca に見つからない')
  const done = derive(w.cockpit, w.log, [], '/a', { workers: [], dispatches: { ctx_aoba_list: { state: 'succeeded', settledAt: NOW - 60_000 } } }, NOW)
  assert.equal(done.tasks.get('t1')!.why, 'intake')
  assert.ok(!done.queue.some((r) => r.card.kind === 'stuck'))
})

test('hook が読む検査: 一時フォルダのままの成果物と、どのカードも外の相手も指さない止まったタスク', () => {
  const c: Cockpit = {
    version: 2, workspace: { name: 'x' }, streams: [{ id: 's1', title: '仕事' }],
    tasks: [
      { id: 't1', stream: 's1', phase: '実装', title: 'a', state: 'stop' },
      { id: 't2', stream: 's1', phase: '実装', title: 'b', state: 'stop' },
      { id: 't3', stream: 's1', phase: '実装', title: 'c', state: 'wait', waiting_on: '顧客' },
      { id: 't4', stream: 's1', phase: '実装', title: 'd', state: 'wait' },
      { id: 't5', stream: 's1', phase: '実装', title: 'e', state: 'run' },
      { id: 't6', stream: 's1', phase: '実装', title: 'f', state: 'wait' },
      { id: 't7', stream: 's1', phase: '実装', title: 'g', state: 'stop' }
    ],
    cards: [
      { id: 'd1', rev: 1, kind: 'decide', title: 'd1', state: 'open', stream: 's1', tasks: ['t2'] },
      { id: 'd0', rev: 1, kind: 'decide', title: 'd0', state: 'done', stream: 's1', tasks: ['t1'] },
      { id: 'a1', rev: 1, kind: 'report', title: 'a1', state: 'open', stream: 's1', tasks: ['t4'], href: '/private/tmp/claude-501/x/page.html' },
      { id: 'a2', rev: 1, kind: 'review', title: 'a2', state: 'open', stream: 's1', links: [{ label: '比較', href: 'file:///tmp/cmp.html' }] },
      { id: 'a3', rev: 1, kind: 'review', title: 'a3', state: 'open', stream: 's1', href: 'https://claude.ai/artifact/abc' },
      { id: 'a4', rev: 1, kind: 'review', title: 'a4', state: 'done', stream: 's1', href: '/tmp/old.html' },
      // 送ったあと顧客の返事を待つカードが指すタスクは、外の相手を待っているので名指ししない
      { id: 'w1', rev: 1, kind: 'send', title: 'w1', state: 'waiting', stream: 's1', tasks: ['t6'], awaiting: { who: '森さん', what: '回答', since: '2026-11-20T10:00:00+09:00' } },
      // 担当と話し始めたカードも私の番に残る（R46）ので、それが指すタスクは名指ししない
      { id: 'd2', rev: 1, kind: 'decide', title: 'd2', state: 'open', stream: 's1', tasks: ['t7'] }
    ]
  }
  const r = report(c, { ops: [{ op_id: 1, at: '2026-11-21T09:00:00+09:00', item_id: 'd2', item_rev: 1, type: 'talk' }] }, [], undefined, 'skipped', NOW)
  assert.deepEqual(r.checks.local_deliverables, ['a1', 'a2'])
  assert.deepEqual(r.checks.orphan_waits, ['t1', 't4'])
  // 必須の欄が欠けたカードは私の番に出さず、窓口に名指しする。
  assert.deepEqual(r.mine, [])
  assert.deepEqual(r.checks.incomplete_cards.map((x) => x.id), ['d1', 'a2', 'a3', 'd2'])
  assert.ok(r.checks.incomplete_cards[0]!.missing.includes('context.what'))
})

test('checks: 手作業を頼むのに、打つコマンドも手順も書いていない許す（manual）を名指しする', () => {
  const w = ws(1)
  const p7 = w.cockpit.cards.find((c) => c.id === 'p7')!
  p7.manual = { where: 'ターミナル', steps: [' '] }
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.empty_manual, ['p7'])
  p7.manual = { command: 'sudo darwin-rebuild switch --flake ~/.config/nix-darwin' }
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.empty_manual, [])
})

test('必須の欄が欠けたカードは要対応に出さず、出てから 30 分たっても欠けたままなら「抜けている」に出す（at が無ければ最初に見つけた時刻）', () => {
  const h = ws(2)
  const at = (min: number) => new Date(NOW - min * 60_000).toISOString()
  for (const x of h.cockpit.cards) delete x.fallback
  delete h.cockpit.cards.find((x) => x.id === 'r8')!.evidence
  h.cockpit.cards.find((x) => x.id === 'd28')!.at = at(10)
  delete h.cockpit.cards.find((x) => x.id === 'p9')!.at
  const d = derive(h.cockpit, h.log, [], '/h', undefined, NOW, { firstSeen: { p9: at(45) } })
  assert.deepEqual(d.queue.map((r) => r.card.id), [])
  assert.deepEqual(d.incomplete.map((g) => g.id).sort(), ['d28', 'd30', 'p9', 'r8', 'r9'])
  assert.deepEqual(d.gaps.map((g) => g.id).sort(), ['d30', 'p9', 'r8', 'r9'])
  assert.ok(d.gaps.find((g) => g.id === 'r8')!.missing.includes('確認した結果'))
})

test('依頼の帳簿: 移し替えの前は全部古い行。古い行は書かれた state、新しい行は済の条件と証拠から 受付・進行中・確認待ち・済 を決める', () => {
  const w = ws(0)
  const base = { at: '2026-11-21T09:00:00+09:00', title: '依頼' }
  w.cockpit.requests = [
    { id: 'r1', ...base, state: 'done', tasks: ['t4'] },
    { id: 'r2', ...base, state: 'open', tasks: ['t1'] }
  ]
  assert.deepEqual(derive(w.cockpit, w.log, [], '/a', undefined, NOW).requests.map((r) => [r.req.id, r.state, r.legacy]), [['r1', '済', true], ['r2', '進行中', true]])
  // 移し替えたあと（intake がある）は、legacy の無い行に発言と済の条件が要る。
  w.cockpit.intake = { through: '' }
  const u = [{ id: 'u1', quote: '一覧を直して' }]
  w.cockpit.requests = [
    { id: 'r1', ...base, legacy: true, state: 'open' },
    { id: 'r3', ...base },
    { id: 'r4', ...base, utterances: u, kind: 'work', done_when: ['PR がマージされる'] },
    { id: 'r5', ...base, utterances: u, kind: 'work', done_when: ['PR がマージされる'], tasks: ['t1'] },
    { id: 'r6', ...base, utterances: u, kind: 'work', done_when: ['PR がマージされる'], evidence: [{ when: 1, kind: 'pr', ref: 'https://github.com/x/y/pull/1' }] },
    { id: 'r7', ...base, utterances: u, kind: 'work', done_when: ['見てもらう'], check: true, evidence: [{ when: 1, kind: 'url', ref: 'https://example.com' }] },
    { id: 'r8', ...base, utterances: u, kind: 'work', done_when: ['見てもらう'], check: true, evidence: [{ when: 1, kind: 'url', ref: 'https://example.com' }, { when: 1, kind: 'op', ref: '7', card: 'r5', rev: 1 }] },
    { id: 'r9', ...base, utterances: u, kind: 'question', done_when: ['答える'], evidence: [{ when: 1, kind: 'url', ref: 'https://example.com' }] }
  ]
  const log = { ops: [...w.log.ops, { op_id: 7, at: '2026-11-21T09:30:00+09:00', item_id: 'r5', item_rev: 1, type: 'accept' as const }] }
  const states = () => Object.fromEntries(derive(w.cockpit, log, [], '/a', undefined, NOW).requests.map((r) => [r.req.id, r.state]))
  assert.deepEqual(states(), { r1: '受付', r3: '受付', r4: '受付', r5: '進行中', r6: '済', r7: '確認待ち', r8: '済', r9: '進行中' })
  // 成果物を改訂して見てのカードの rev を上げたら、古い版への「これでよい」は効かない。
  w.cockpit.cards.find((x) => x.id === 'r5')!.rev = 2
  assert.equal(states().r8, '確認待ち')
  // 「これでよい」を取り消しても効かない。
  w.cockpit.cards.find((x) => x.id === 'r5')!.rev = 1
  log.ops.push({ op_id: 8, at: '2026-11-21T09:31:00+09:00', item_id: 'r5', item_rev: 1, type: 'undo', undo_of: 7 } as never)
  assert.equal(states().r8, '確認待ち')
  const r = report(w.cockpit, log, [], undefined, 'skipped', NOW)
  assert.deepEqual(r.checks.incomplete_requests, [{ id: 'r3', missing: ['発言（utterances）か出典（source）', '済の条件（done_when）', '種類（kind）'] }])
})

test('発言の仕分け: through より後の発言と、checked_through より後で依頼にも none にも結ばれていない発言を出す。id の無い行は見ない', () => {
  const w = ws(0)
  const u = (id: string | undefined, min: number) => ({ id, at: new Date(NOW - min * 60_000).toISOString(), prompt: `発言 ${id}` })
  const utterances = [u(undefined, 300), u('u1', 120), u('u2', 90), u('u3', 60), u('u4', 5)]
  assert.deepEqual(derive(w.cockpit, w.log, [], '/a', undefined, NOW, { utterances }).unsorted, [])
  w.cockpit.intake = { through: 'u3', none: ['u2'], checked_through: 'u1' }
  w.cockpit.requests = []
  const d = derive(w.cockpit, w.log, [], '/a', undefined, NOW, { utterances })
  assert.deepEqual(d.unsorted.map((g) => g.id), ['u3', 'u4'])
  // 30 分の猶予を過ぎたもの（u3）だけが「抜けている」に出る。
  assert.deepEqual(d.gaps.map((g) => g.id), ['u3'])
  w.cockpit.requests = [{ id: 'q1', at: '', title: '', utterances: [{ id: 'u3', quote: '' }], kind: 'work', done_when: ['x'] }]
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW, undefined, { utterances }).checks.unsorted, ['u4'])
})

test('発言の仕分け: 相談・質問の返しで反映された発言（判断の記録の from_return・依頼の from_return）は仕分け済み。反映されていない返しの発言は残す（追加 32）', () => {
  const w = ws(0)
  const u = (id: string) => ({ id, at: new Date(NOW - 60 * 60_000).toISOString(), prompt: `発言 ${id}` })
  const utterances = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map(u)
  w.cockpit.intake = { through: 'u1', none: ['u1'] }
  w.cockpit.requests = [{ id: 'q1', at: '', title: '', from_return: 'd1-2', source: { at: '', quote: '' }, kind: 'work', done_when: ['x'] }]
  const consults = [{ card: 'd1', path: '/a/.orca/consult/d1.md', returns: [
    { return_id: 'd1-1', decisions: [{ text: '図はこのまま', quote: 'このままで', utterance: 'u2' }], requests: [{ quote: '資料も直して', utterance: 'u3' }] },
    { return_id: 'd1-2', requests: [{ quote: '一覧も', utterance: 'u4' }] },
    { return_id: 'd1-3', decisions: [{ text: 'まだ', quote: 'まだ', utterance: 'u5' }] }
  ] }]
  const asks = [{ id: 'ask1', path: '', returnsPath: '', entries: [], answers: 1, returns: [{ return_id: 'ask1-1', decisions: [{ text: '本番は来週', utterance: 'u6' }] }] }]
  const rulings = [{ id: 'R1', from_return: 'd1-1' }, { id: 'R2', from_return: 'ask1-1' }]
  const opts = { utterances, rulings, consults, asks }
  assert.deepEqual(derive(w.cockpit, w.log, [], '/a', undefined, NOW, opts).unsorted.map((g) => g.id), ['u3', 'u5'])
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW, undefined, opts).checks.unsorted, ['u3', 'u5'])
  assert.deepEqual(derive(w.cockpit, w.log, [], '/a', undefined, NOW, { utterances, returned: ['u2', 'u3', 'u4', 'u5', 'u6'] }).unsorted, [])
})

test('タスクの今の Dispatch は Run の続きをたどった先（current）。手書きの run のまま Orca のタスクが終わったもの・仕事の無いもの・工程の外・長い題・形の無い仕事を名指しする', () => {
  const w = ws(0)
  const c = w.cockpit
  c.tasks[0]!.worker = { task_id: 'task_a', run_id: 'run_a' }
  c.tasks.push({ id: 't8', stream: 'sX', phase: '受入', title: 'あ'.repeat(NAME_MAX + 1), state: 'idle' })
  c.streams[0]!.form = 'delegate'
  const facts = { workers: [], dispatches: { ctx_2: { state: 'succeeded', settledAt: NOW - 3_600_000, taskStatus: 'completed' } }, current: { t1: 'ctx_2' } }
  const r = report(c, w.log, [], facts, 'ok', NOW)
  assert.equal(r.tasks.find((t) => t.id === 't1')!.from, 'intake')
  assert.equal(r.tasks.find((t) => t.id === 't1')!.dispatch, 'ctx_2')
  assert.equal(r.tasks.find((t) => t.id === 't8')!.dispatch, null)
  assert.deepEqual(r.checks.stale_tasks, ['t1'])
  assert.deepEqual(r.checks.loose_tasks, ['t8'])
  assert.deepEqual(r.checks.unknown_phase, ['t8（受入）'])
  assert.deepEqual(r.checks.long_names, [`t8（${NAME_MAX + 4} 字）`], 'worker の名前は「作業｜」も数える（R146）')
  assert.deepEqual(r.checks.no_form.sort(), ['s2', 's3', 's4'])
  // 続きを引けていない（current に無い）run_id だけの記録は、Orca に見つからない扱い。
  assert.equal(report(c, w.log, [], { workers: [], dispatches: {} }, 'ok', NOW).tasks.find((t) => t.id === 't1')!.from, 'missing')
})

test('カードの相談がチャット（orca_session_id:…）でも、開いているあいだ話し中、閉じたら外す。片付いたカードに残るチャットを stale_consults に出す（追加 30）', async () => {
  const w = ws(0)
  const talk = (op_id: number, item_id: string, item_rev: number, terminal: string) => ({ op_id, at: '2026-11-21T09:50:00+09:00', item_id, item_rev, type: 'talk' as const, terminal })
  const log = { ops: [...w.log.ops, talk(5, 'd22', 2, 'orca_session_id:c22'), talk(6, 'd19', 1, 'orca_session_id:c19'), talk(7, 'd21', 1, 'term_c21')] }
  const asked: string[] = []
  const open = (alive: string[], broken: string[] = []) => async (h: string) => {
    asked.push(h)
    if (broken.includes(h)) throw new Error('orca が失敗しました')
    return alive.includes(h)
  }
  const factsOf = async (alive: string[], broken: string[] = []) =>
    (await orcaFacts('/ws', w.cockpit, async () => [], async () => [{ handle: 'term_c21', tabId: 't', leafId: 'c21' }], async () => null, undefined, undefined, { handles: chatHandles(log.ops), open: open(alive, broken) })).facts
  const live = report(w.cockpit, log, [], await factsOf(['orca_session_id:c22', 'orca_session_id:c19']), 'ok', NOW)
  assert.deepEqual(live.talking.map((x) => [x.id, x.with]), [['d22', 'カードの相談'], ['d21', 'カードの相談']])
  assert.deepEqual(live.checks.stale_consults, [{ id: 'd19', terminal: 'orca_session_id:c19' }])
  const closed = report(w.cockpit, log, [], await factsOf([]), 'ok', NOW)
  assert.deepEqual(closed.talking.map((x) => x.id), ['d21'], 'チャットが閉じたら話し中を外す。端末の相談は今どおり')
  assert.deepEqual(closed.checks.stale_consults, [])
  // 確かめられなかったチャットは閉じたと言い切らない。
  const unknown = report(w.cockpit, log, [], await factsOf([], ['orca_session_id:c22']), 'ok', NOW)
  assert.deepEqual(unknown.talking.map((x) => x.id), ['d22', 'd21'])
  // 閉じたと分かったチャットは問い合わせ直さない。
  const gone = new Set<string>()
  asked.length = 0
  assert.deepEqual(await liveChats(['orca_session_id:c22', 'orca_session_id:c19'], open(['orca_session_id:c22']), gone), ['orca_session_id:c22'])
  assert.deepEqual(await liveChats(['orca_session_id:c22', 'orca_session_id:c19'], open(['orca_session_id:c22']), gone), ['orca_session_id:c22'])
  assert.deepEqual(asked, ['orca_session_id:c22', 'orca_session_id:c19', 'orca_session_id:c22'])
  assert.deepEqual(chatHandles([{ type: 'talk', terminal: 'term_x' }, { type: 'talk', terminal: 'orca_session_id:a' }, { type: 'talk', terminal: 'orca_session_id:a' }, { type: 'decide' }]), ['orca_session_id:a'])
})

test('担当と話すを押したカードは私の番に残り、hook の talking に話し相手と押した時刻が出る', () => {
  const w = ws(0)
  const log = { ops: [...w.log.ops, { op_id: 5, at: '2026-11-21T09:50:00+09:00', item_id: 'd21', item_rev: 1, type: 'talk' as const }] }
  const r = report(w.cockpit, log, [], undefined, 'skipped', NOW)
  assert.ok(r.mine.some((x) => x.id === 'd21'))
  assert.deepEqual(r.talking, [{ id: 'd21', since: '2026-11-21T09:50:00+09:00', with: 'AWS 構成案' }])
})

test('カードの相談: タブ（talk の terminal）が Orca にある間だけ話し中。端末の一覧を読めていなければ外さない。片付いたカードに残るタブを stale_consults に出す', () => {
  const w = ws(0)
  const talk = (op_id: number, item_id: string, item_rev: number, terminal: string) => ({ op_id, at: '2026-11-21T09:50:00+09:00', item_id, item_rev, type: 'talk' as const, terminal })
  const log = { ops: [...w.log.ops, talk(5, 'd22', 2, 'term_c22'), talk(6, 'd19', 1, 'term_c19'), talk(7, 'd19', 1, 'term_gone'), talk(8, 'zz', 1, 'term_zz'), talk(9, 'd19', 1, 'term_undone'), { op_id: 10, at: '2026-11-21T09:51:00+09:00', item_id: 'd19', item_rev: 1, type: 'undo' as const, undo_of: 9 }] }
  const facts = (terminals?: string[]) => ({ workers: [], terminals })
  const live = report(w.cockpit, log, [], facts(['term_c22', 'term_c19', 'term_zz', 'term_undone']), 'ok', NOW)
  assert.deepEqual(live.talking, [{ id: 'd22', since: '2026-11-21T09:50:00+09:00', with: 'カードの相談' }])
  // 協議を取り消してもタブは閉じないので、取り消した記録のタブも名指しする。
  assert.deepEqual(live.checks.stale_consults, [{ id: 'd19', terminal: 'term_c19' }, { id: 'zz', terminal: 'term_zz' }, { id: 'd19', terminal: 'term_undone' }])
  const closed = report(w.cockpit, log, [], facts([]), 'ok', NOW)
  assert.deepEqual(closed.talking, [], 'タブが閉じたら話し中を外す')
  assert.deepEqual(closed.checks.stale_consults, [])
  // 一覧が上限で切れているかもしれないときは、無い handle を閉じたと言い切らず、ある handle は stale に使う（Codex 2 回目 中 4）。
  const partial = report(w.cockpit, log, [], { workers: [], terminals: ['term_c19'], terminalsPartial: true }, 'ok', NOW)
  assert.deepEqual(partial.talking.map((x) => x.id), ['d22'])
  assert.deepEqual(partial.checks.stale_consults, [{ id: 'd19', terminal: 'term_c19' }])
  const unknown = report(w.cockpit, log, [], undefined, 'error', NOW)
  assert.deepEqual(unknown.talking.map((x) => x.id), ['d22'])
  assert.deepEqual(unknown.checks.stale_consults, [])
  // 最新の協議の相談タブが閉じたら、前に窓口へ回した協議の印を戻さない（Codex 中 1）。
  const back = { ops: [...w.log.ops, { op_id: 5, at: '2026-11-21T09:40:00+09:00', item_id: 'd22', item_rev: 2, type: 'talk' as const }, talk(6, 'd22', 2, 'term_c22')] }
  assert.deepEqual(report(w.cockpit, back, [], facts([]), 'ok', NOW).talking, [])
})

/** 相談の返しの照合を試す操縦席。d21 は反映済み・帳簿だけ抜け・保留、d22 はメモの塊に card が無い。片付けて移したカードの保留はメモに無い。 */
function consultRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-consult-'))
  const w = ws(0)
  const c = structuredClone(w.cockpit) as Cockpit
  c.cards.find((x) => x.id === 'd21')!.from_returns = ['d21-1', 'typo']
  c.cards.find((x) => x.id === 'd21')!.held_returns = ['d21-3']
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  // 題の無いカードは画面から外すが、保留の照合には数える（Codex 2 回目 重大 1）。
  put('.orca/cockpit.json', JSON.stringify({ ...c, cards: [...c.cards, { id: 'd1', rev: 1, kind: 'decide', state: 'open', held_returns: ['d1-1'] }] }))
  put('.orca/cockpit.archive.json', JSON.stringify({ cards: [{ id: 'x9', rev: 1, kind: 'decide', state: 'done', title: '移したカード', held_returns: ['x9-1'] }] }))
  put('.orca/cockpit/rulings.jsonl', [{ id: 'R1', from_return: 'd21-1' }, { from_return: 'd21-2' }, { id: 'R3', from_return: 'd22-1' }, { id: 'R4' }].map((x) => JSON.stringify(x)).join('\n') + '\n')
  const block = (v: unknown) => '```json\n' + JSON.stringify(v, null, 1) + '\n```\n'
  put('.orca/consult/d21.md', ['# 相談｜案件A｜d21\n', '## 決めたこと\n', block({ return_id: 'd21-8', card: 'd21' }), '## 窓口に返したもの（時刻・message id）\n',
    block({ return_id: 'd21-1', card: 'd21', rev: 1, decisions: [{ text: '入口は 1 つにする' }] }), block({ return_id: 'd21-2', card: 'd21', rev: 1 }), block({ return_id: 'd21-2', card: 'x' }),
    '```json\n{ 書きかけ\n```\n', block({ card: 'd21' }), block({ return_id: 'd21-3', card: 'd21', rev: 1 }), '## 残っている論点\n', block({ return_id: 'd21-9', card: 'd21' })].join(''))
  // 改行が CRLF のメモ・card が空の配列の塊・全角数字の連番も python と同じに読む（Codex 重大 4・軽微）。
  put('.orca/consult/d22.md', ('## 窓口に返したもの\n' + block({ return_id: 'd22-1', rev: 2 }) + block({ return_id: 'd22-２', card: [] })).replace(/\n/g, '\r\n'))
  put('.orca/consult/c4.md', '# 返しはまだ無い\n')
  return root
}

test('相談の返し: メモにあって判断の記録か帳簿に無いものと保留を名指しする（同じ id は先の塊、節の外の塊と書きかけは読まない）', async () => {
  const root = consultRoot()
  const f = await loadFiles(root, emptyFiles())
  const memo = (card: string) => path.join(root, '.orca', 'consult', `${card}.md`)
  assert.deepEqual(unreflectedReturns(f.marks, f.rulings, f.consults), [
    { id: 'd21-2', card: 'd21', missing: ['帳簿'], memo: memo('d21') },
    { id: 'd21-3', card: 'd21', missing: ['判断の記録', '帳簿', '保留'], memo: memo('d21') },
    { id: 'd22-1', card: 'd22', missing: ['帳簿'], memo: memo('d22') },
    { id: 'd22-２', card: 'd22', missing: ['判断の記録', '帳簿'], memo: memo('d22') },
    { id: 'd1-1', card: 'd1', missing: ['保留'], memo: null },
    { id: 'x9-1', card: 'x9', missing: ['保留'], memo: null }
  ])
})

// nix-darwin の hook（compaction-keep.py unreflected）と同じ結果になること。hook の無い手元では飛ばす。
const KEEP = path.join(os.homedir(), '.config/nix-darwin/claude/hooks/compaction-keep.py')
test('相談の返し: compaction-keep.py unreflected <root> --json と同じ結果', { skip: !existsSync(KEEP) && 'compaction-keep.py が無い' }, async () => {
  const root = consultRoot()
  const f = await loadFiles(root, emptyFiles())
  const py = JSON.parse(execFileSync('python3', [KEEP, 'unreflected', root, '--json'], { encoding: 'utf8', env: { ...process.env, CONSULT_THREAD: '' } }))
  assert.deepEqual(unreflectedReturns(f.marks, f.rulings, f.consults), py)
})

/**
 * 窓からの質問の返しも照合する操縦席（consultRoot に足す）。ask1 は反映済み・帳簿だけ抜け・op に結ばれた返し、ask2 は返しの記録だけで保留、
 * 移した帳簿の ask3 は返しの記録の無い保留。担当への通知の漏れと、返しの無い・反映した・取り消した「これで決める」。
 */
function askRoot(): string {
  const root = consultRoot()
  const put = (rel: string, text: string) => writeFileSync(path.join(root, rel), text)
  const c = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.json'), 'utf8')) as Cockpit
  c.asks = [
    { id: 'ask1', card: 'd21', memo: '.orca/consult/ask-ask1.md', from_returns: ['ask1-1'], notify: [{ return_id: 'ask1-1', task: 't1' }, { return_id: 'ask1-3', task: 't2', message_id: 'msg_1' }] },
    { id: 'ask2', from_returns: [], held_returns: ['ask2-1'] }
  ]
  c.applied_ops = [...(c.applied_ops ?? []), 9]
  put('.orca/cockpit.json', JSON.stringify(c))
  const archive = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.archive.json'), 'utf8')) as { cards: unknown[] }
  put('.orca/cockpit.archive.json', JSON.stringify({ ...archive, asks: [{ id: 'ask3', held_returns: ['ask3-9'] }, { title: 'id の無い行' }] }))
  put('.orca/cockpit/rulings.jsonl', readFileSync(path.join(root, '.orca/cockpit/rulings.jsonl'), 'utf8') + [{ id: 'R5', from_return: 'ask1-1' }, { id: 'R6', from_return: 'ask1-2' }].map((x) => JSON.stringify(x)).join('\n') + '\n')
  put('.orca/consult/ask-ask1.md', '# 質問｜案件A｜ask1\n- カード: d21\n- 写した窓口の会話: s1（窓口の会話 22:40 時点）\n\n### 質問 22:41（u-3）\n入口はどうする？\n\n### 答え 22:42\n窓口の会話 22:40 時点（それより後に決まったことは知らない）\n1 つにする\n\n')
  put('.orca/consult/ask-ask1.returns.jsonl', [{ return_id: 'ask1-1' }, { return_id: 'ask1-2' }, { return_id: 'ask1-3', op: 7 }].map((x) => JSON.stringify(x)).join('\n') + '\n')
  put('.orca/consult/ask-ask2.returns.jsonl', [JSON.stringify({ return_id: 'ask2-1' }), '{ 書きかけ', JSON.stringify({ return_id: 'bad id' }), JSON.stringify(['配列'])].join('\n') + '\n')
  const op = (op_id: number, ask: string, type = 'ask_decide', undo_of?: number) => ({ op_id, at: '2026-11-21T22:43:00+09:00', item_id: `#ask:${ask}`, item_rev: 0, type, ...(undo_of && { undo_of }), ...(type === 'ask_decide' && { answer: { at: '22:42', head: '1 つにする' } }) })
  put('.orca/cockpit.user.json', JSON.stringify({ ops: [op(7, 'ask1'), op(8, 'ask2'), op(9, 'ask2'), op(10, 'ask1'), op(11, 'ask1', 'undo', 10)] }))
  return root
}

test('質問の返し: 帳簿・判断の記録・保留・担当への通知の漏れと、返しの無い「これで決める」を名指しし、控えを読む', async () => {
  const root = askRoot()
  const f = await loadFiles(root, emptyFiles())
  const side = { root, threads: f.asks, marks: f.askMarks, log: f.log, applied: f.cockpit!.applied_ops ?? [] }
  const memo = (id: string) => path.join(root, '.orca', 'consult', `ask-${id}.md`)
  const rets = (id: string) => path.join(root, '.orca', 'consult', `ask-${id}.returns.jsonl`)
  assert.deepEqual(unreflectedReturns(f.marks, f.rulings, f.consults, side).filter((x) => 'ask' in x), [
    { id: 'ask1-1', ask: 'ask1', missing: ['担当への通知'], memo: memo('ask1'), returns: rets('ask1'), tasks: ['t1'] },
    { id: 'ask1-2', ask: 'ask1', missing: ['帳簿'], memo: memo('ask1'), returns: rets('ask1') },
    { id: 'ask1-3', ask: 'ask1', missing: ['判断の記録', '帳簿'], memo: memo('ask1'), returns: rets('ask1') },
    { id: 'ask2-1', ask: 'ask2', missing: ['判断の記録', '帳簿', '保留'], memo: memo('ask2'), returns: rets('ask2') },
    { id: 'ask3-9', ask: 'ask3', missing: ['保留'], memo: memo('ask3'), returns: null },
    { id: null, ask: 'ask2', op: 8, missing: ['返し'], memo: memo('ask2') }
  ])
  const a1 = f.asks.find((a) => a.id === 'ask1')!
  assert.equal(a1.card, 'd21')
  assert.equal(a1.at, '22:40')
  assert.deepEqual(a1.entries.map((e) => [e.kind, e.time, e.utterance]), [['q', '22:41', 'u-3'], ['a', '22:42', undefined]])
  assert.equal(a1.answers, 1)
})

test('質問の返し: compaction-keep.py unreflected <root> --json と同じ結果', { skip: !existsSync(KEEP) && 'compaction-keep.py が無い' }, async () => {
  const root = askRoot()
  const f = await loadFiles(root, emptyFiles())
  const py = JSON.parse(execFileSync('python3', [KEEP, 'unreflected', root, '--json'], { encoding: 'utf8', env: { ...process.env, CONSULT_THREAD: '' } }))
  assert.ok(py.some((x: { ask?: string }) => x.ask), 'python が質問の分を出す版であること')
  assert.deepEqual(unreflectedReturns(f.marks, f.rulings, f.consults, { root, threads: f.asks, marks: f.askMarks, log: f.log, applied: f.cockpit!.applied_ops ?? [] }), py)
})

test('質問の控え: 閉じたコードフェンスの中の「### 答え」は節にしない。閉じていないフェンスでは後の本物の答えを隠さない（Codex 中 2）', () => {
  const fenced = parseAskMemo('# 頭\n\n### 質問 09:00（u-1）\nログの例:\n```\n### 答え 09:00\nサンプル\n```\n\n### 答え 09:01\n本物\n')
  assert.deepEqual(fenced.entries.map((e) => [e.kind, e.time]), [['q', '09:00'], ['a', '09:01']])
  const open = parseAskMemo('### 質問 09:00\n```\n\n### 答え 09:01\n本物\n')
  assert.deepEqual(open.entries.map((e) => [e.kind, e.text]), [['q', '```'], ['a', '本物']])
})

test('判断の記録を語で引く: 撤回・置き換え・残す判断の無い記録は引かず、当たりの多い順・番号の指定', () => {
  // hook（compaction-keep.py rule）が書く形のまま読む。supersedes は配列（Codex 重大 1）。
  const rows = parseRulings([
    { id: 'R1', kind: 'decision', text: '窓から質問する欄は全体のタブの上に置く' },
    { id: 'R2', kind: 'decision', text: '質問の欄は詳細の下に置く' },
    { id: 'R3', kind: 'revoke', text: '撤回: 質問の欄は置かない', supersedes: ['R2'] },
    { id: 'R4', kind: 'none', text: '質問の欄の確認をした' },
    { id: 'R5', kind: 'constraint', text: '入力欄は 3 行より広くする', quote: '質問の入力欄が狭い' },
    { id: 'R6', kind: 'permission', text: '本番に入れてよい' },
    { id: 'R7', kind: 'revoke', text: '本番は待つ', supersedes: ['R6'] }
  ].map((r) => JSON.stringify(r)).join('\n'))
  assert.deepEqual(matchRulings(rows, '質問の欄はどこに置くんだっけ').map((r) => r.id), ['R5', 'R1'])
  assert.deepEqual(matchRulings(rows, '質問の入力欄は？').map((r) => r.id), ['R5'])
  assert.deepEqual(matchRulings(rows, 'R5 ってなんだっけ').map((r) => r.id), ['R5'])
  assert.deepEqual(matchRulings(rows, 'これはどう？'), [])
  assert.deepEqual(matchRulings(rows, 'R6 の本番は？'), [], '撤回した判断は番号でも引かない')
  assert.deepEqual(matchRulings(rows, '本番に入れてよい？'), [])
  assert.deepEqual(lookupTerms('HTTP Error404 の扱い'), ['http', 'error404'], '英数字の語の中の R404 は番号にしない')
  assert.deepEqual(lookupTerms('窓口の会話をStateに'), ['窓口', '会話', 'state'])
})

test('片付いたものは時刻で新しい順に並べる（操作の UTC の時刻と、窓口が書いた +09:00 の時刻が混ざっても）', () => {
  const w = ws(0)
  const c = w.cockpit
  c.cards.push({ id: 'v7', rev: 1, kind: 'review', state: 'done', title: '窓口が閉じた', resolved_at: '2026-11-21T09:40:00+09:00' })
  const log = { ops: [...w.log.ops, { op_id: 9, at: '2026-11-21T00:50:00.000Z', item_id: 'd21', item_rev: 1, type: 'decide' as const, option_id: c.cards.find((x) => x.id === 'd21')!.options![0]!.id }] }
  const d = derive(c, log, [], '', undefined, NOW)
  const ids = d.closed.map((r) => r.card.id)
  assert.ok(ids.indexOf('d21') < ids.indexOf('v7'), ids.join())
})

test('題の無いタスク 1 件で CLI 全体を落とさない。そのタスクだけ外して名指しする（Codex 高 2）', () => {
  const w = ws(0)
  const raw = structuredClone(sample(NOW)[0]!.cockpit) as unknown as { tasks: unknown[] }
  raw.tasks.push({ id: 't', state: 'run' }, { id: 't8', stream: 's1', phase: '実装', title: 'x', state: 'run', done: 3 })
  const problems: string[] = []
  const c = parseCockpit(JSON.stringify(raw), problems)
  assert.ok(!c.tasks.some((t) => t.id === 't'))
  assert.equal(c.tasks.find((t) => t.id === 't8')!.done, undefined)
  assert.match(problems.join('\n'), /タスク t（title・phase を読めない）/)
  assert.match(problems.join('\n'), /タスク t8 の done の形が違う/)
  assert.ok(report(c, w.log, [], undefined, 'skipped', NOW).checks)
})

test('依頼の済: 古い版への「これでよい」は済の条件を埋めない。check があれば今の版の承認が要る（Codex 高 3）', () => {
  const w = ws(0)
  const c = w.cockpit
  c.intake = { through: '', none: [] }
  const v = c.cards.find((x) => x.id === 'r5')!
  v.rev = 2
  const log = { ops: [...w.log.ops, { op_id: 50, at: '2026-11-21T00:30:00.000Z', item_id: 'r5', item_rev: 1, type: 'accept' as const }] }
  const req = { id: 'q1', at: '2026-11-21T09:00:00+09:00', title: '一覧', utterances: [{ id: 'u1', quote: 'x' }], kind: 'work' as const, done_when: ['見てで承認'] }
  c.requests = [{ ...req, evidence: [{ when: 1, kind: 'op', ref: '50' }] }]
  const old = derive(c, log, [], '/a', undefined, NOW).requests[0]!
  assert.deepEqual(old.covered, [false])
  assert.notEqual(old.state, '済')
  // check: true で、別の条件に今の版の承認が 1 つあっても、古い承認で残りの条件を埋めない。
  log.ops.push({ op_id: 51, at: '2026-11-21T00:40:00.000Z', item_id: 'r5', item_rev: 2, type: 'accept' })
  c.requests = [{ ...req, check: true, done_when: ['a', 'b'], evidence: [{ when: 1, kind: 'op', ref: '51' }, { when: 2, kind: 'op', ref: '50' }] }]
  const r = derive(c, log, [], '/a', undefined, NOW).requests[0]!
  assert.deepEqual(r.covered, [true, false])
  assert.notEqual(r.state, '済')
  c.requests = [{ ...req, evidence: [{ when: 1, kind: 'op', ref: '51' }] }]
  assert.equal(derive(c, log, [], '/a', undefined, NOW).requests[0]!.state, '済')
})

test('依頼の証拠の操作が指すカードは、表示の期間（14 日）を過ぎても窓に送る（窓と CLI の済が食い違わない。Codex 中 7）', () => {
  const w = ws(0)
  const c = w.cockpit
  c.requests = [{ id: 'q1', at: '', title: 't', evidence: [{ when: 1, kind: 'op', ref: '50', card: 'v0' }, { when: 1, kind: 'op', ref: '1' }, { when: 1, kind: 'pr', ref: 'x' }] }]
  assert.deepEqual([...requestCards(c, w.log)].sort(), [...new Set(['v0', ...w.log.ops.filter((o) => o.op_id === 1).map((o) => o.item_id)])].sort())
})

test('同じ順位の要対応・顧客待ち・報告は時刻で並べる（+09:00 と Z が混ざっても。Codex 中 11）', () => {
  const w = ws(0)
  const c = w.cockpit
  const mk = (id: string, at: string): Card => ({ id, rev: 1, kind: 'report', state: 'open', title: id, at, done: [{ what: 'x' }] })
  // 10:00+09:00 は 01:00Z。02:00Z より前。
  c.cards.push(mk('ra', '2026-11-21T10:00:00+09:00'), mk('rb', '2026-11-21T02:00:00Z'))
  assert.deepEqual(derive(c, w.log, [], '/a', undefined, NOW).reports.filter((r) => r.card.id.startsWith('r') && r.card.id.length === 2).map((r) => r.card.id), ['rb', 'ra'])
  const a = { card: mk('x', '2026-11-21T10:00:00+09:00') } as Row
  const b = { card: mk('y', '2026-11-21T02:00:00Z') } as Row
  assert.ok(byUrgency(a, b) < 0)
})

test('工程は 5 段に寄せる。実データ（nix-darwin の帳簿、11/21 21:55 の写し）の工程名はすべて段に入り、対応に無い名前だけが unknown_phase に出る', () => {
  // 帳簿の tasks[].phase に出てくる名前の写し（帳簿そのものは書き換えない）。
  const real = ['実装', '確認', '設計', '作る', '調査', '見直し', '調べる', '決める', '確かめ', '要件', '実地確認', 'push', '2 周目（Neon）', '作成', 'switch 待ち', '見てもらう']
  assert.deepEqual(real.filter((p) => !stageOf(p)), [])
  assert.deepEqual(real.map((p) => stageOf(p)), ['作成', '確認', '決定', '作成', '調査', '確認', '調査', '決定', '確認', '決定', '確認', '反映', '作成', '作成', '反映', '確認'])
  const w = ws(0)
  w.cockpit.tasks.push({ id: 't9', stream: 's1', phase: '受入', title: 'あ', state: 'idle' }, ...real.map((p, i) => ({ id: `r${i}`, stream: 's1', phase: p, title: 'あ', state: 'idle' as const })))
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.unknown_phase, ['t9（受入）'])
})

test('答えの無い question は、窓口宛ては 5 分・担当宛ては 30 分たってから出す。窓口が問いのあとに同じタスクのカードを書いたら、そちらだけを出す。対応済みで隠せる', () => {
  const w = ws(0)
  const q = (over: Partial<QuestionFact>): QuestionFact => ({ id: 'm1', at: NOW - 6 * 60_000, line: '並びを変えるか', text: '並びを変えるか', to: 'main', task: 't1', ...over })
  const asks = (questions: QuestionFact[], c = w.cockpit, log = w.log) => derive(c, log, [], '/a', { workers: [], questions }, NOW).queue.filter((r) => r.card.id.startsWith('#ask:')).map((r) => r.agent!.ask!.from)
  assert.deepEqual(asks([q({}), q({ id: 'm2', at: NOW - 4 * 60_000 }), q({ id: 'm3', to: 'owner', at: NOW - 20 * 60_000 }), q({ id: 'm4', to: 'owner', at: NOW - 31 * 60_000, task: undefined, stream: 's2', asker: '構成図' })]), [
    'worker（一覧の並べ替えと絞り込み）が窓口に聞いたが、まだ答えが無い',
    'worker（AWS 構成案）が担当に聞いたが、まだ答えが無い'
  ])
  // 担当の Run 宛てでも担当を引けなければ、窓口を開くと書く（担当を開くように見せない）。
  const lost = derive(w.cockpit, w.log, [], '/a', { workers: [], questions: [q({ to: 'owner', at: NOW - 31 * 60_000, task: undefined })] }, NOW).queue.find((r) => r.card.id === '#ask:m1')!
  assert.equal(lost.card.unblock, '宛先の担当を引けないため、窓口の端末を開いて伝える')
  const carded = structuredClone(w.cockpit)
  carded.cards.push({ id: 'd30', rev: 1, kind: 'decide', state: 'open', at: new Date(NOW - 60_000).toISOString(), title: '一覧の既定の並び', tasks: ['t1'] })
  assert.deepEqual(asks([q({})], carded), [])
  const log = { ops: [{ op_id: 1, at: new Date(NOW).toISOString(), item_id: '#ask:m1', item_rev: NOW - 6 * 60_000, type: 'dismiss' as const }] }
  assert.deepEqual(asks([q({})], w.cockpit, log), [])
})

test('一緒に作る仕事は、カードの有無に関わらず要対応に「共同作業中」の 1 行で出す。担当がターンを終えたら同じ行を返事待ちにし、返事のあと作業に戻れば返事待ちを外す（R128・R145）', () => {
  const w = ws(0)
  w.cockpit.streams.find((x) => x.id === 's2')!.form = 'cowork'
  w.cockpit.cards = w.cockpit.cards.filter((x) => x.stream !== 's2')
  const last = '下書きができました。\n\n| 番号 | 見出し |\n\n次の 3 点を教えてください。**表紙の題**はこのままでよいですか？'
  const facts = (state: AgentRow['state'], more: Partial<{ last: string; workers: AgentRow[] }> = {}) =>
    ({ workers: more.workers ?? [], owners: [{ session: 'sess-aws', kind: 'chat' as const, state, worktree: '/ws/aoba-aws', updatedAt: NOW - 60_000, ...(more.last && { last: more.last }) }] })
  const row = (d: ReturnType<typeof derive>) => d.queue.filter((r) => r.card.id.startsWith('#cowork:'))
  const job = (d: ReturnType<typeof derive>) => d.jobs.find((j) => j.id === 's2')!

  const working = derive(w.cockpit, w.log, [], '/a', facts('working'), NOW)
  assert.deepEqual(row(working).map((r) => [r.card.id, r.card.title, r.agent?.ask, r.agent?.chat, r.agent?.worktree]), [['#cowork:s2', '共同作業中（担当は作業中）', undefined, true, '/ws/aoba-aws']])
  assert.equal(working.total, derive(w.cockpit, w.log, [], '/a', undefined, NOW).total, '件数（判断・送信前・確認・許可・停止）には数えない')

  const asked = derive(w.cockpit, w.log, [], '/a', facts('done', { last }), NOW)
  const r = row(asked)[0]!
  assert.equal(r.card.title, '次の 3 点を教えてください。表紙の題はこのままでよいですか？', '題は返事の最後の段落')
  assert.deepEqual([r.agent?.ask?.kind, r.card.last?.text, r.card.next], ['question', '下書きができました。\n\n| 番号 | 見出し |', undefined], '最後のやり取りには題にした段落より前だけを出す')
  assert.deepEqual([job(asked).state, job(asked).label], ['mine', '返事待ち（あなた）'])
  assert.equal(report(w.cockpit, w.log, [], facts('done', { last }), 'ok', NOW).jobs.find((j) => j.id === 's2')!.orca.status, ORCA_STATUS.mine)
  // 本文を読めなかったときは、担当が待っていることだけを題にし、チャットで確かめるよう書く。
  const unread = row(derive(w.cockpit, w.log, [], '/a', facts('done'), NOW))[0]!
  assert.deepEqual([unread.card.title, unread.card.next], ['担当「AWS 構成案」が返事を待っている', 'チャットから返事の本文を読めませんでした。開いて確認してください'])

  // 返事を送って担当が作業に戻ったら、返事待ちは消える（行は共同作業中として残る）。
  const back = derive(w.cockpit, w.log, [], '/a', facts('working', { last }), NOW)
  assert.deepEqual(row(back).map((x) => [x.card.title, x.agent?.ask]), [['共同作業中（担当は作業中）', undefined]])
  assert.notEqual(job(back).label, '返事待ち（あなた）')

  // 同じチャットの問いの停止と、仕事の話し中のカードはこの行に寄せる（2 行にしない）。
  const stuck = derive(w.cockpit, w.log, [], '/a', facts('waiting', { workers: [agent({ terminalId: null, chat: true, session: 'sess-aws', state: 'waiting', stop: 'waiting', ask: { kind: 'question', text: 'A と B のどちらにしますか？' } })] }), NOW)
  assert.deepEqual(stuck.queue.filter((x) => x.card.kind === 'stuck').map((x) => x.card.id), [])
  assert.deepEqual(row(stuck).map((x) => [x.card.title, x.agent?.ask?.kind]), [['A と B のどちらにしますか？', 'question']])
  const talk: Card = { id: 'k2', rev: 1, kind: 'talk', state: 'open', at: new Date(NOW - 600_000).toISOString(), stream: 's2', title: '入口の描き方を相談したい', purpose: 'x', fallback: 'x', due: new Date(NOW + 3_600_000).toISOString(), links: [{ label: 'x', href: 'https://example.com' }], last: { text: '入口はどう描きますか', by: '担当' } }
  const c2 = { ...w.cockpit, cards: [...w.cockpit.cards, talk] }
  assert.deepEqual(derive(c2, w.log, [], '/a', facts('working'), NOW).queue.filter((x) => x.card.stream === 's2' && x.card.kind === 'talk').map((x) => [x.card.id, x.card.title]), [['#cowork:s2', '共同作業中（担当は作業中）']])
  assert.deepEqual(row(derive(c2, w.log, [], '/a', facts('blocked'), NOW)).map((x) => [x.card.title, x.card.last?.text]), [['入口はどう描きますか', undefined]], '話し中のカードの最後の発言を題にする（同じ文を詳細に重ねない）')
  // 話し中のカードが 2 枚でも 1 行に寄せる。
  const c3 = { ...c2, cards: [...c2.cards, { ...talk, id: 'k3', title: '別の話し中' }] }
  assert.deepEqual(derive(c3, w.log, [], '/a', facts('blocked'), NOW).queue.filter((x) => x.card.stream === 's2').map((x) => x.card.id), ['#cowork:s2'])
  // 協議中のほかの種類のカード（承認が要る）は残し、担当が作業中でなければ返事待ちにする。
  const review: Card = { ...talk, id: 'r2', kind: 'review', title: '構成図の確認', request: 'x', href: 'https://example.com/r2', look_for: ['x'], evidence: ['x'] }
  const log2 = { ops: [...w.log.ops, { op_id: 9, at: new Date(NOW - 60_000).toISOString(), item_id: 'r2', item_rev: 1, type: 'talk' as const }] }
  const both = derive({ ...w.cockpit, cards: [...w.cockpit.cards, review] }, log2, [], '/a', facts('blocked'), NOW)
  assert.deepEqual(both.queue.filter((x) => x.card.stream === 's2').map((x) => [x.card.id, !!x.agent?.ask]).sort(), [['#cowork:s2', true], ['r2', false]])
  assert.deepEqual([job(both).label], ['返事待ち（あなた）・私待ち 1 件'], '返事待ちと件数を両方出す')
  // 最後の段落が 2 行でも、2 行目の問いを落とさない。
  assert.equal(row(derive(w.cockpit, w.log, [], '/a', facts('done', { last: '下書きです。\n\n表紙は直しました。\n題はこのままでよいですか？' }), NOW))[0]!.card.title, '表紙は直しました。 題はこのままでよいですか？')
  // 利用枠で止まった担当は、止まった行を残し、ターンを終えていても返事待ちにしない。
  const limited = derive(w.cockpit, w.log, [], '/a', facts('done', { last, workers: [agent({ terminalId: null, chat: true, session: 'sess-aws', state: 'done', stop: 'limit' })] }), NOW)
  assert.deepEqual(limited.queue.filter((x) => x.card.kind === 'stuck').map((x) => x.card.id), ['#agent:sess-aws'])
  assert.deepEqual(row(limited).map((x) => [x.card.title, x.agent?.ask]), [['共同作業中（担当は待機）', undefined]])
  // 利用枠の停止を「対応済みにする」で隠しても、止まっているあいだは返事待ちにしない（Codex 2 巡目 1）。
  const dlog = { ops: [...w.log.ops, { op_id: 20, at: new Date(NOW).toISOString(), item_id: '#agent:sess-aws', item_rev: NOW - 25 * 60_000, type: 'dismiss' as const }] }
  const hidden = derive(w.cockpit, dlog, [], '/a', facts('done', { last, workers: [agent({ terminalId: null, chat: true, session: 'sess-aws', state: 'done', stop: 'limit' })] }), NOW)
  assert.deepEqual(hidden.queue.filter((x) => x.card.kind === 'stuck').map((x) => x.card.id), [])
  assert.equal(row(hidden)[0]!.agent?.ask, undefined)
  // 報告のカードで担当と協議していて、担当が作業中でなければ返事待ち（Codex 2 巡目 2）。
  const rep: Card = { ...talk, id: 'p2', kind: 'report', title: '構成図の報告', done: [{ what: 'x' }] }
  const rlog = { ops: [...w.log.ops, { op_id: 21, at: new Date(NOW - 60_000).toISOString(), item_id: 'p2', item_rev: 1, type: 'talk' as const }] }
  assert.equal(!!row(derive({ ...w.cockpit, cards: [...w.cockpit.cards, rep] }, rlog, [], '/a', facts('waiting'), NOW))[0]!.agent?.ask, true)
  // 端末の担当は端末を開く。
  const term = structuredClone(w.cockpit)
  term.owners = [{ id: 'o1', title: 'AWS 構成案', stream: 's2', agent: 'claude', terminal: 'term_aws' }]
  const t = row(derive(term, w.log, [], '/a', { workers: [agent({ terminalId: 'term_aws', state: 'done' })], owners: [] }, NOW))[0]!
  assert.deepEqual([t.agent?.terminalId, t.agent?.chat, !!t.agent?.ask, t.card.next], ['term_aws', undefined, true, '端末から返事の本文を読めませんでした。開いて確認してください'])
  // 担当宛てに届いた worker の question は、担当自身の問いとして取り込まない（Codex 2 巡目 3）。
  const q: QuestionFact = { id: 'q1', at: NOW - 40 * 60_000, to: 'owner', text: 'A と B のどちらですか', line: 'A と B のどちらですか', stream: 's2', byOwner: false }
  const qd = derive(term, w.log, [], '/a', { workers: [agent({ terminalId: 'term_aws', state: 'working' })], owners: [], questions: [q] }, NOW)
  assert.deepEqual(qd.queue.filter((x) => x.card.id.startsWith('#ask:')).map((x) => x.card.id), ['#ask:q1'])
  assert.equal(row(qd)[0]!.agent?.ask, undefined)

  // 任せる・見張るの担当はターンを終えても出さない。担当の様子を読めない場所（パネル・hook）でも出さない。
  w.cockpit.streams.find((x) => x.id === 's2')!.form = 'delegate'
  assert.deepEqual(row(derive(w.cockpit, w.log, [], '/a', facts('done', { last }), NOW)), [])
  w.cockpit.streams.find((x) => x.id === 's2')!.form = 'cowork'
  assert.deepEqual(row(derive(w.cockpit, w.log, [], '/a', { workers: [] }, NOW)), [])
  assert.deepEqual(coworkSessions(w.cockpit), ['sess-aws'])
  assert.equal(lastParagraph('a\n\n  \n\nb\nc\n'), 'b c')
})

test('Orca の名前（R146）: 仕事と担当は頭に形（一緒に｜・任せる｜・見張る｜）、worker は 作業｜。20 字の上限は頭の語も含めて数える', () => {
  const w = ws(0)
  const form = (id: string, f: 'cowork' | 'delegate' | 'watch') => (w.cockpit.streams.find((x) => x.id === id)!.form = f)
  form('s1', 'delegate')
  form('s2', 'cowork')
  form('s3', 'watch')
  const r = report(w.cockpit, w.log, [], undefined, 'skipped', NOW)
  assert.deepEqual(Object.fromEntries(r.jobs.map((j) => [j.id, j.orca.display_name])), { s1: '任せる｜配車画面の改修', s2: '一緒に｜AWS 構成案', s3: '見張る｜外部 API の繋ぎ込み', s4: '定例と議事録' })
  assert.deepEqual([ownerName(w.cockpit, w.cockpit.owners![0]!), ownerName({ streams: [] }, { title: '調査', stream: 'x' }), workerName('一覧の改修')], ['一緒に｜AWS 構成案', '調査（担当）', '作業｜一覧の改修'])
  // 題は 17 字でも、頭の 4 字を足すと 21 字になって切れる。
  w.cockpit.streams.push({ id: 's9', title: 'あ'.repeat(NAME_MAX - 3), form: 'cowork' })
  w.cockpit.tasks.push({ id: 't9', stream: 's9', phase: '実装', title: 'x', state: 'run' })
  assert.equal([...streamName(w.cockpit.streams.at(-1)!)].length, NAME_MAX + 1)
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.long_names, [`s9（${NAME_MAX + 1} 字）`])
})

test('checks.status_missing（R188）: 済んでいない仕事・タスクで状況の文（status）が無いものの id を出す。済んだものと書いたものは出さない', () => {
  const w = ws(0)
  const c = w.cockpit
  const open = c.tasks.filter((t) => t.state !== 'ok').map((t) => t.id)
  const missing = () => report(c, w.log, [], undefined, 'skipped', NOW).checks.status_missing
  const before = missing()
  for (const id of open) assert.ok(before.includes(id), id)
  for (const t of c.tasks.filter((x) => x.state === 'ok')) assert.ok(!before.includes(t.id), t.id)
  for (const x of [...c.streams, ...c.tasks]) x.status = '今どうなっていて次に何を待つか'
  assert.deepEqual(missing(), [])
  c.streams[0]!.status = '  '
  assert.deepEqual(missing(), [c.streams[0]!.id])
  // 見張る仕事は出さない（状況は Bot の前回の結果を窓が Orca から読む）。
  c.streams[0]!.form = 'watch'
  assert.deepEqual(missing(), [])
  // 文字列でない status は読み込みで外し、ほかの仕事の報告は止めない（Codex）。
  const problems: string[] = []
  const raw = JSON.parse(JSON.stringify(c))
  raw.streams[1].status = 3
  const parsed = parseCockpit(JSON.stringify(raw), problems)
  assert.equal(parsed.streams[1]!.status, undefined)
  assert.ok(problems.some((p) => p.includes(`仕事 ${raw.streams[1].id} の status が文字列でない`)), problems.join('\n'))
  assert.deepEqual(report(parsed, w.log, [], undefined, 'skipped', NOW).checks.status_missing, [raw.streams[1].id])
})

test('案件の名前の形（R165・R181）: 全角の｜でちょうど 2 つに分かれ、両方が空でない名前だけを通し、外れた名前と窓口に流す 1 文を checks.workspace_name に出す。形の言い方は state.ts の 1 か所', () => {
  assert.deepEqual(
    ['青葉物流｜配車アプリ', ' 社内 ｜ ハーネス ', 'dev-standards', '社内|ハーネス', '社内｜', '｜ハーネス', '社内｜ ', 'A｜B｜C', ''].map(workspaceNameOk),
    [true, true, false, false, false, false, false, false, false]
  )
  const w = ws(0)
  w.cockpit.workspace.name = '青葉物流｜配車アプリ'
  assert.equal(report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.workspace_name, null)
  w.cockpit.workspace.name = 'dev-standards'
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.workspace_name, {
    name: 'dev-standards', message: '案件の名前「dev-standards」が「<顧客>｜<案件>」（社内は「社内｜<案件>」）の形になっていない。cockpit.json の workspace.name を直す（R165）'
  })
  // 名前の欄が無くても検査で落ちず、無いことを名指しする（Codex 4）。
  delete (w.cockpit.workspace as { name?: string }).name
  const none = report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.workspace_name!
  assert.equal(none.name, '')
  assert.ok(none.message.includes(WORKSPACE_NAME_FORM))
  // 形の言い方の写しを置かない（R181）。state.ts で形を書くのは WORKSPACE_NAME_FORM の 1 か所だけ。
  const src = readFileSync(new URL('./state.ts', import.meta.url), 'utf8')
  assert.equal(src.split('<顧客>').length - 1, 1)
})

test('待ちの語（追加 42）: 相手が人や相手方の名前だけなら「〜の返事待ち」、出来事・作業は「〜を待つ」（動詞で終われば「〜のを待つ」）', () => {
  assert.equal(waitLabel('森さん'), '森さんの返事待ち')
  assert.equal(waitLabel('先方'), '先方の返事待ち')
  assert.equal(waitLabel('岩田さん（日程案への返事と認証情報）'), '岩田さんの返事待ち（日程案への返事と認証情報）')
  assert.equal(waitLabel('BW の担当'), 'BW の担当の返事待ち')
  assert.equal(waitLabel('次に上限に当たったときの本物の席の切り替え'), '次に上限に当たったときの本物の席の切り替えを待つ')
  assert.equal(waitLabel('深田さんのスマホでの Orca Mobile の撮影'), '深田さんのスマホでの Orca Mobile の撮影を待つ')
  assert.equal(waitLabel('深田さんが窓で、カードの詳細に要る情報が出ているかを使いながら確かめる（r67 の3）'), '深田さんが窓で、カードの詳細に要る情報が出ているかを使いながら確かめるのを待つ（r67 の3）')
  assert.equal(waitLabel('深田さんが確かめる'), '深田さんが確かめるのを待つ')
  // 仕事の状態の語に使う（顧客待ちの仕事）。
  const w = ws(0)
  const s = w.cockpit.streams[0]!.id
  w.cockpit.tasks = [{ id: 'k1', stream: s, phase: '確認', title: '撮影を待つ', state: 'wait', waiting_on: '深田さんのスマホでの撮影' }]
  w.cockpit.cards = w.cockpit.cards.filter((c) => c.stream !== s)
  assert.equal(derive(w.cockpit, w.log, [], '/a', undefined, NOW).jobs.find((j) => j.id === s)!.label, '深田さんのスマホでの撮影を待つ')
})

test('push の一任（R95・R173）: 有効な permission（scope push・allow true）があれば push の許すを出させず、窓口が自分で push する印を出す。置き換えられた一任は数えない', () => {
  const w = ws(2)
  for (const t of w.cockpit.tasks) t.state = 'ok'
  w.cockpit.cards = w.cockpit.cards.filter((x) => !(x.kind === 'permit' && x.scope === 'push'))
  const checks = (rulings: Ruling[]) => report(w.cockpit, w.log, [], undefined, 'skipped', NOW, undefined, { rulings }).checks
  assert.deepEqual([checks([]).push_check, checks([]).push_delegated], [true, false])
  const given: Ruling = { id: 'R9', kind: 'permission', scope: 'push', allow: true, text: 'この案件の push は窓口に任せる' }
  assert.deepEqual([checks([given]).push_check, checks([given]).push_delegated], [false, true])
  // 撤回（supersedes）された一任・禁止・別の単位は一任に数えない。
  assert.equal(checks([given, { id: 'R10', kind: 'revoke', supersedes: ['R9'] }]).push_check, true)
  assert.equal(checks([{ ...given, allow: false }]).push_check, true)
  assert.equal(checks([{ ...given, scope: '本番' }]).push_check, true)
  // push_delegated は push_check と同じ時機の印（hook が「今 push する」と読む）。作業中のタスクがあるあいだは、一任があっても出さない。
  w.cockpit.tasks[0]!.state = 'run'
  assert.deepEqual([checks([given]).push_check, checks([given]).push_delegated], [false, false])
  // 判断の記録の行から scope と allow を読む。
  assert.deepEqual(parseRulings('{"id":"R9","kind":"permission","scope":"push","allow":true}\n').map((r) => [r.scope, r.allow]), [['push', true]])
})

test('確認日（R142・R171）: 日付が来た済んでいないタスクは、その日の 0:00 より後に動いていなければ待つ相手があっても 1 行出す。日付の前と、動いたあとは出さない', () => {
  const w = ws(0)
  const s = w.cockpit.streams[0]!.id
  w.cockpit.owners = []
  const today = tokyoDay(NOW)
  w.cockpit.tasks = [
    { id: 'k1', stream: s, phase: '確認', title: '先方の返事を確かめる', state: 'wait', waiting_on: '森さん', check_on: today },
    { id: 'k2', stream: s, phase: '確認', title: '来週見直す', state: 'wait', check_on: '2026-11-30' },
    { id: 'k3', stream: s, phase: '確認', title: '済んだもの', state: 'ok', check_on: today }
  ]
  const start = tokyoStart(today)
  const seen = (at: number): TaskSeen => Object.fromEntries(w.cockpit.tasks.map((t) => [t.id, { sig: taskSig(t), at: new Date(at).toISOString() }]))
  const facts = { workers: [], terminals: [] as string[] }
  const d = derive(w.cockpit, w.log, [], '/a', facts, NOW, { taskSeen: seen(start - 3_600_000) })
  assert.deepEqual(d.idle.map((x) => [x.task, x.check, x.since]), [['k1', today, new Date(start).toISOString()]])
  assert.equal(d.queue.find((r) => r.card.id === '#idle:k1')!.card.title, '「先方の返事を確かめる」の確認日が来た')
  // その日に窓口がタスクを動かしたら出さない。0:00 ちょうどの動きは「0:00 より後」ではないので出す（Codex 2）。
  assert.deepEqual(derive(w.cockpit, w.log, [], '/a', facts, NOW, { taskSeen: seen(start + 60_000) }).idle, [])
  assert.deepEqual(derive(w.cockpit, w.log, [], '/a', facts, NOW, { taskSeen: seen(start) }).idle.map((x) => x.task), ['k1'])
  // 手元の時計が UTC でも、東京の 0:01 には確認日が来ている（Codex 2）。
  const tz = process.env.TZ
  try {
    process.env.TZ = 'UTC'
    const at = start + 60_000
    assert.deepEqual(derive(w.cockpit, w.log, [], '/a', facts, at, { taskSeen: seen(start - 3_600_000) }).idle.map((x) => x.task), ['k1'])
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
  // hook は task@since で 1 回だけ流す。同じ日のあいだは since が変わらない。
  const r = (now: number) => report(w.cockpit, w.log, [], facts, 'ok', now, undefined, { taskSeen: seen(start - 3_600_000) }).checks.idle_tasks.map((x) => `${x.task}@${x.since}`)
  assert.deepEqual(r(NOW), r(NOW + 3_600_000))
})

test('見張る仕事の検査（R152）: watch の無い見張る仕事と、Orca に無い automation を名指しする。Orca を読めなければ有無は言わない', () => {
  const w = ws(0)
  w.cockpit.streams.push(
    { id: 'v1', title: '見回り', form: 'watch', watch: { automation: 'auto-1', targets: ['管理表'], to: '窓口' } },
    { id: 'v2', title: '書きかけ', form: 'watch' },
    { id: 'v3', title: '消えた Bot', form: 'watch', watch: { automation: 'auto-gone', targets: ['Slack'], to: '窓口' } }
  )
  const checks = (automations?: { id: string; name: string }[]) => report(w.cockpit, w.log, [], { workers: [], automations }, 'ok', NOW).checks
  assert.deepEqual(checks([{ id: 'auto-1', name: '見回り' }]).watch_missing, ['v2'])
  assert.deepEqual(checks([{ id: 'auto-1', name: '見回り' }]).watch_unknown, ['v3（auto-gone）'])
  assert.deepEqual(checks(undefined).watch_unknown, [])
})

test('放置の検出（R170）: worker も担当も動いていない作業中は 2 時間、未着手・待機は 24 時間で 1 行。待つ相手・確認日の前は拾わず、checks は動くたびに起点が変わる', async () => {
  const w = ws(0)
  const s = w.cockpit.streams[0]!.id
  w.cockpit.owners = []
  w.cockpit.tasks = [
    { id: 'k1', stream: s, phase: '作成', title: '一覧を作る', state: 'run' },
    { id: 'k2', stream: s, phase: '調査', title: '前提を調べる', state: 'idle' },
    { id: 'k3', stream: s, phase: '確認', title: '先方の返事を待つ', state: 'wait', waiting_on: '森さん' },
    { id: 'k4', stream: s, phase: '確認', title: '来週見直す', state: 'wait', check_on: '2026-11-30' }
  ]
  const at = (min: number) => new Date(NOW - min * 60_000).toISOString()
  const seen = (mins: Record<string, number>): TaskSeen => Object.fromEntries(w.cockpit.tasks.map((t) => [t.id, { sig: taskSig(t), at: at(mins[t.id] ?? 0) }]))
  const facts = { workers: [], terminals: [] as string[] }
  const idle = (mins: Record<string, number>, f: typeof facts | undefined) => derive(w.cockpit, w.log, [], '/a', f, NOW, { taskSeen: seen(mins) }).idle.map((x) => x.task)
  assert.deepEqual(idle({ k1: 119, k2: 1439, k3: 9999, k4: 9999 }, facts), [])
  assert.deepEqual(idle({ k1: 120, k2: 1440, k3: 9999, k4: 9999 }, facts), ['k1', 'k2'])
  // Orca を読めていないと、作業中が動いているか分からないので拾わない（未着手は拾う）。窓は端末の一覧が無いことで分かる。
  assert.deepEqual(idle({ k1: 300, k2: 1440 }, undefined), ['k2'])
  assert.deepEqual(idle({ k1: 300, k2: 1440 }, { workers: [] } as unknown as typeof facts), ['k2'])
  // チャットの担当が結ばれた作業中は、担当の様子（agent list）を読めていなければ保留し、読めて作業中でなければ拾う。
  w.cockpit.owners = [{ id: 'o1', title: '一覧の担当', stream: s, session: 'sess-1' }]
  assert.deepEqual(idle({ k1: 300, k2: 1440 }, facts), ['k2'])
  assert.deepEqual(idle({ k1: 300, k2: 1440 }, { ...facts, owners: [{ session: 'sess-1', kind: 'chat', state: 'working' }] } as typeof facts), ['k2'])
  assert.deepEqual(idle({ k1: 300, k2: 1440 }, { ...facts, owners: [{ session: 'sess-1', kind: 'chat', state: 'done' }] } as typeof facts), ['k1', 'k2'])
  // 窓で agent list だけを読めなかった回は、前の値（初回は空）が残っていても保留する（Codex 2 巡目）。
  assert.deepEqual(idle({ k1: 300, k2: 1440 }, { ...facts, owners: [], ownersStale: true } as typeof facts), ['k2'])
  // hook の CLI（orcaFacts）も担当の様子を読み、読めなければ無いまま渡す（窓と同じ判定にするため。Codex 1）。
  const cli = (agents?: () => Promise<OwnerLive[]>) => orcaFacts('/ws', w.cockpit, async () => [], async () => [], async () => null, undefined, undefined, undefined, agents).then((x) => x.facts!)
  const live: OwnerLive[] = [{ session: 'sess-1', kind: 'chat', state: 'working' }]
  assert.deepEqual((await cli(async () => live)).owners, live)
  assert.equal((await cli(async () => { throw new Error('orca が無い') })).owners, undefined)
  assert.deepEqual(idle({ k1: 300, k2: 1440 }, (await cli(async () => live)) as typeof facts), ['k2'])
  w.cockpit.owners = []
  const d = derive(w.cockpit, w.log, [], '/a', facts, NOW, { taskSeen: seen({ k1: 150 }) })
  const row = d.queue.find((r) => r.card.id === '#idle:k1')!
  assert.equal(row.card.title, '「一覧を作る」が2時間動いていない')
  assert.equal(row.idle!.from, '帳簿の更新')
  assert.equal(d.total, derive(w.cockpit, w.log, [], '/a', facts, NOW).total, '件数（5 種類）には数えない')
  // 窓が覚えた印と中身が違う（まだ覚えていない変化）なら、今動いたとみなす。
  const changed = seen({ k1: 300 })
  w.cockpit.tasks[0]!.next = '並べ替えを足す'
  assert.deepEqual(derive(w.cockpit, w.log, [], '/a', facts, NOW, { taskSeen: changed }).idle.map((x) => x.task), [])
  // checks は「task@since」で 1 回だけ流す前提: 同じあいだは since が変わらず、動いたあとまた越えると since が変わる。
  const r1 = report(w.cockpit, w.log, [], facts, 'ok', NOW, undefined, { taskSeen: seen({ k1: 130 }) }).checks.idle_tasks
  const r2 = report(w.cockpit, w.log, [], facts, 'ok', NOW + 30 * 60_000, undefined, { taskSeen: seen({ k1: 130 }) }).checks.idle_tasks
  assert.deepEqual(r1.map((x) => `${x.task}@${x.since}`), r2.map((x) => `${x.task}@${x.since}`))
  const r3 = report(w.cockpit, w.log, [], facts, 'ok', NOW, undefined, { taskSeen: seen({ k1: 125 }) }).checks.idle_tasks
  assert.notEqual(r3[0]!.since, r1[0]!.since)
})

test('放置の検出の起点: 常駐のプロセスがタスクの中身の変わった時刻を taskseen.json に覚え、変わらなければ書き換えず、済んだタスクは消す', async () => {
  const { loadFiles, recordTaskSeen, emptyFiles } = await import('./store.ts')
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-seen-'))
  mkdirSync(path.join(root, '.orca', 'cockpit'), { recursive: true })
  const w = ws(0)
  w.cockpit.tasks = [{ id: 'k1', stream: w.cockpit.streams[0]!.id, phase: '作成', title: 'a', state: 'run' }, { id: 'k2', stream: w.cockpit.streams[0]!.id, phase: '作成', title: 'b', state: 'ok' }]
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(w.cockpit))
  let files = await loadFiles(root, emptyFiles())
  files.taskSeen = await recordTaskSeen(root, files, NOW)
  assert.deepEqual(Object.keys(files.taskSeen), ['k1'])
  assert.equal(files.taskSeen.k1!.at, new Date(NOW).toISOString())
  files = await loadFiles(root, files)
  assert.equal((await recordTaskSeen(root, files, NOW + 60_000)).k1!.at, new Date(NOW).toISOString(), '中身が同じなら起点を動かさない')
  w.cockpit.tasks[0]!.phase = '確認'
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(w.cockpit))
  files = await loadFiles(root, files)
  assert.equal((await recordTaskSeen(root, files, NOW + 60_000)).k1!.at, new Date(NOW + 60_000).toISOString())
  assert.equal(JSON.parse(readFileSync(path.join(root, '.orca', 'cockpit', 'taskseen.json'), 'utf8')).k1.at, new Date(NOW + 60_000).toISOString())
  // 時刻の読めない項目は捨てて初めて見たものとして記録し直す（判定全体が例外で止まらない。Codex 3）。
  writeFileSync(path.join(root, '.orca', 'cockpit', 'taskseen.json'), JSON.stringify({ k1: { sig: taskSig(w.cockpit.tasks[0]!), at: 'broken' } }))
  files = await loadFiles(root, files)
  assert.deepEqual(files.taskSeen, {})
  assert.equal((await recordTaskSeen(root, files, NOW + 120_000)).k1!.at, new Date(NOW + 120_000).toISOString())
})
