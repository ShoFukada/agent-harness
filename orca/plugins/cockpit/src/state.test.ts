import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit, requestCards, stageOf, type Card, type Cockpit } from './model.ts'
import type { AgentRow } from './protocol.ts'
import { bucketOf, byUrgency, derive, NAME_MAX, ORCA_STATUS, report, routeProblem, type Row } from './state.ts'

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
  assert.deepEqual(hr.checks.orphan_cards, ['p9', 'd30', 'd28'])
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
  assert.deepEqual(d.incomplete.map((g) => g.id).sort(), ['d28', 'd30', 'p9', 'r8'])
  assert.deepEqual(d.gaps.map((g) => g.id).sort(), ['d30', 'p9', 'r8'])
  assert.ok(d.gaps.find((g) => g.id === 'r8')!.missing.includes('確かめた結果'))
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
  assert.deepEqual(r.checks.long_names, [`t8（${NAME_MAX + 1} 字）`])
  assert.deepEqual(r.checks.no_form.sort(), ['s2', 's3', 's4'])
  // 続きを引けていない（current に無い）run_id だけの記録は、Orca に見つからない扱い。
  assert.equal(report(c, w.log, [], { workers: [], dispatches: {} }, 'ok', NOW).tasks.find((t) => t.id === 't1')!.from, 'missing')
})

test('担当と話すを押したカードは私の番に残り、hook の talking に話し相手と押した時刻が出る', () => {
  const w = ws(0)
  const log = { ops: [...w.log.ops, { op_id: 5, at: '2026-11-21T09:50:00+09:00', item_id: 'd21', item_rev: 1, type: 'talk' as const }] }
  const r = report(w.cockpit, log, [], undefined, 'skipped', NOW)
  assert.ok(r.mine.some((x) => x.id === 'd21'))
  assert.deepEqual(r.talking, [{ id: 'd21', since: '2026-11-21T09:50:00+09:00', with: 'AWS 構成案' }])
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
  assert.deepEqual(real.map((p) => stageOf(p)), ['作る', '確かめる', '決める', '作る', '調べる', '確かめる', '調べる', '決める', '確かめる', '決める', '確かめる', '入れる', '作る', '作る', '入れる', '確かめる'])
  const w = ws(0)
  w.cockpit.tasks.push({ id: 't9', stream: 's1', phase: '受入', title: 'あ', state: 'idle' }, ...real.map((p, i) => ({ id: `r${i}`, stream: 's1', phase: p, title: 'あ', state: 'idle' as const })))
  assert.deepEqual(report(w.cockpit, w.log, [], undefined, 'skipped', NOW).checks.unknown_phase, ['t9（受入）'])
})
