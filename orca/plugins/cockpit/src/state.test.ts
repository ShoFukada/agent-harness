import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { parseCockpit, type Cockpit, type Op } from './model.ts'
import type { AgentRow, CockpitView, DispatchFact, WsRow } from './protocol.ts'
import { NO_STREAM, derive, report, type StateReport } from './state.ts'
import { render, type Ui } from './view.ts'
import { renderWindow } from './window-view.ts'

const NOW = new Date('2026-11-16T12:00:00+09:00').getTime()
const sample = () => parseCockpit(readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8'))
const ui = (over: Partial<Ui> = {}): Ui => ({ tab: 'whole', pick: {}, showDone: {}, ...over })
const view = (c: Cockpit, over: Partial<CockpitView> = {}): CockpitView => ({
  state: 'ok', root: '/w', cockpit: c, log: { ops: [] }, archive: [], figures: {}, errors: [], workers: [], dispatches: {}, notifiedOp: 0, replies: [], ...over
})
const noMatch = (s: string, re: RegExp) => assert.ok(!re.test(s), `${re} に当たってはいけない`)
const working: DispatchFact = { state: 'ready', liveness: 'live' }
const settled = (ago: number): DispatchFact => ({ state: 'succeeded', liveness: 'unverifiable', settledAt: NOW - ago })
const agent = (o: Partial<AgentRow>): AgentRow => ({ terminalId: 'term_w', title: 'w', agent: 'claude', state: 'working', since: NOW - 60_000, worktree: '/w/w', ...o })

/** 全体のタブの未完了の依頼の行と、各大タスクの画面のタスクの行（完了も開く）の文。 */
function screen(v: CockpitView): { tasks: Record<string, string>; open: Record<string, string>; html: string } {
  const ids = [...v.cockpit!.streams.map((s) => s.id), NO_STREAM]
  const showDone = Object.fromEntries(ids.map((id) => [id, true]))
  const html = render(v, ui({ showDone }), NOW, (s) => s, true)
  const pages = ids.map((id) => render(v, ui({ showDone, curStream: id }), NOW, (s) => s, true)).join('')
  const tasks = Object.fromEntries([...pages.matchAll(/<button class="trow" data-task="([^"]+)"><span class="st[^>]*>[^<]*<\/span><span class="t">[^<]*<\/span><span class="tph mut">[^<]*<\/span><span class="ts [^"]*">([^<]*)<\/span>/g)].map((m) => [m[1]!, m[2]!]))
  const reqs = /<section class="side-sec reqs">[^]*?<\/ul><\/section>/.exec(html)?.[0] ?? ''
  const open = Object.fromEntries([...reqs.matchAll(/data-req="([^"]+)"[^]*?<span class="rs rs-\w+">([^<]*)<\/span>/g)].map((m) => [m[1]!, m[2]!]))
  return { tasks, open, html }
}
const stateOf = (v: CockpitView): StateReport =>
  report(v.cockpit!, v.log, v.archive, v.dispatches ? { workers: v.workers, dispatches: v.dispatches } : undefined, 'ok', NOW)

/** 窓の表示と、hook とメインが読む状態が、同じことを言っているか。 */
function sameEverywhere(v: CockpitView): StateReport {
  const s = stateOf(v)
  const { tasks, open } = screen(v)
  // 画面の行は状態の文に、待ち始めた日や待っている確認の題名を足したもの。頭は hook の文と同じ。
  for (const t of s.tasks) assert.ok(tasks[t.id]?.startsWith(t.label), `タスク ${t.id} の文: ${tasks[t.id]} は ${t.label} で始まる`)
  const live = s.requests.filter((r) => r.status !== 'done')
  assert.deepEqual(open, Object.fromEntries(live.map((r) => [r.id, r.label])), '未完了の依頼')
  assert.match(s.overview, new RegExp(`^全体: 依頼 ${live.length}`))
  assert.match(s.overview, new RegExp(`決めてほしいもの ${s.counts.total}・`))
  const running = s.tasks.filter((t) => t.from === 'working')
  assert.match(s.overview, new RegExp(`動いている worker ${running.length}`))
  for (const t of running) assert.ok(tasks[t.id]?.startsWith('進行中（worker が作業中）'))
  const idle = s.tasks.filter((t) => t.state === 'idle' && !v.cockpit!.tasks.find((x) => x.id === t.id)?.waiting_on?.trim())
  assert.match(s.overview, new RegExp(`・未着手 ${idle.length}`), '依頼に結び付かない未着手のタスクも全体の文に出る')
  const row: WsRow = { root: '/w', name: 'w', open: s.counts.total, counts: s.counts, workers: 0, stopped: 0 }
  const win = renderWindow({ mode: 'follow', rows: [row], live: 0, view: v, errors: [] }, v, ui(), NOW, (x) => x)
  assert.match(win, new RegExp(`要対応 <b class="num">${s.counts.total}</b> 件`))
  return s
}

test('タスクがすべて完了で見ても開いていない依頼は、state が open のままでも、窓・hook の全体の文・対応済みのタブで完了', () => {
  const c = sample()
  for (const t of c.tasks) if (['t1', 't2'].includes(t.id)) t.state = 'ok'
  c.items = c.items.filter((i) => i.kind !== 'rev')
  const v = view(c)
  const s = sameEverywhere(v)
  assert.equal(s.requests.find((r) => r.id === 'r1')!.status, 'done')
  noMatch(s.overview, /一覧画面の設計/)
  const arch = render(v, ui({ tab: 'arch' }), NOW, (x) => x)
  assert.match(arch, /data-areq="r1"[^]*<span class="t">一覧画面と通知の案を見たい<\/span><span class="s mut">完了<\/span>/)
  noMatch(screen(v).html, /data-req="r1"[^>]*>[^<]*<\/button><span class="rs rs-working">作業中/)
})

test('メインが done にしても、結び付いたタスクが済んでいない依頼は作業中。タスクの無い依頼だけ state で閉じる', () => {
  const c = sample()
  c.requests![1]!.state = 'done'
  c.requests!.push({ id: 'r9', at: '2026-11-15T10:00:00+09:00', title: 'タスクの無い依頼', quote: '調べて', state: 'done' })
  const s = sameEverywhere(view(c))
  assert.equal(s.requests.find((r) => r.id === 'r2')!.label, '作業中')
  assert.equal(s.requests.find((r) => r.id === 'r9')!.status, 'done')
})

test('見てが開いている依頼は確認待ち。利用者が承認を押したら（反映前でも）確認待ちを外す', () => {
  const c = sample()
  const s = sameEverywhere(view(c))
  assert.equal(s.requests.find((r) => r.id === 'r1')!.label, '確認待ち')
  const ops: Op[] = ['v1', 'v2'].map((id, n) => ({ op_id: n + 1, at: '2026-11-16T11:00:00+09:00', item_id: id, item_rev: c.items.find((i) => i.id === id)!.rev, type: 'accept' }))
  const after = sameEverywhere(view(c, { log: { ops } }))
  assert.equal(after.requests.find((r) => r.id === 'r1')!.label, '承認済み・反映待ち')
})

test('タスクの文は手書きの state_label ではなく事実から出す。利用者の番は項目の種類、外の相手は waiting_on から', () => {
  const c = sample()
  // 古い形の cockpit.json（state_label が state と食い違っている）
  Object.assign(c.tasks.find((t) => t.id === 't8')!, { state_label: '進行中' })
  Object.assign(c.tasks.find((t) => t.id === 't6')!, { state_label: 'あなたの判断待ち' })
  const asking = stateOf(view(c)).tasks.find((t) => t.id === 't6')!.label
  assert.equal(asking, '聞き方の承認待ち', '開いた聞くが指すあいだは利用者の番')
  Object.assign(c.items.find((i) => i.id === 'd2')!, { state: 'done', resolved_by: 'user' })
  const s = sameEverywhere(view(c))
  const label = (id: string) => s.tasks.find((t) => t.id === id)!.label
  assert.equal(label('t8'), '完了')
  assert.equal(label('t1'), 'あなたの判断待ち', '開いた決めるが指す')
  assert.equal(label('t6'), '顧客の返事待ち')
  assert.equal(label('t9'), '未着手')
  noMatch(screen(view(c)).html, /state_label|合意済み 10\/31/)
})

test('worker の状態は Orca から。窓のタスクの文・worker の数・hook の取り込み待ちと記録漏れが同じ判定', () => {
  const c = sample()
  // t2 は作業中、t5 は worker_done を返して 11 分
  const v = view(c, { dispatches: { ctx_a1: working, ctx_a2: settled(11 * 60_000) }, workers: [agent({ task: 't2', terminalId: 'term_a1' })] })
  const s = sameEverywhere(v)
  assert.equal(s.tasks.find((t) => t.id === 't5')!.label, 'メインの取り込み待ち')
  assert.deepEqual(s.checks.intake, ['t5'])
  // 終えて 5 分なら、窓は取り込み待ちと出すが hook はまだ促さない
  const soon = stateOf(view(c, { dispatches: { ctx_a1: working, ctx_a2: settled(5 * 60_000) } }))
  assert.ok(!soon.checks.intake.includes('t5'))
  // Dispatch が Orca に無い
  const gone = sameEverywhere(view(c, { dispatches: {} }))
  assert.equal(gone.tasks.find((t) => t.id === 't5')!.label, 'worker が見つかりません（メインの記録漏れ）')
  assert.ok(gone.checks.missing_workers.includes('t5'))
})

test('顧客への確認の一覧は、画面のタスクの状態で選ぶ。worker が作業中のタスクは回答待ちに出さない', () => {
  const c = sample()
  const ask = c.items.find((i) => i.id === 'd2')!
  Object.assign(ask, { state: 'done', resolved_by: 'user', resolved_at: '2026-11-15T10:00:00+09:00', related: [{ task: 't5' }] })
  c.tasks.find((t) => t.id === 't5')!.state = 'wait'
  const html = (fact?: DispatchFact) => render(view(c, { dispatches: fact ? { ctx_a2: fact } : {} }), ui(), NOW, (x) => x)
  noMatch(html(working), /顧客への確認 <span class="num">/)
  noMatch(html({ ...working, waiting: true }), /顧客への確認 <span class="num">/)
  delete c.tasks.find((t) => t.id === 't5')!.worker
  assert.match(html(), /顧客への確認 <span class="num">1<\/span> 件/, 'worker の記録が無い wait は顧客待ち')
})

test('hook の検査: 利用者の番でない止まり・待ちだけを名指しし、外の相手と Orca から決めたタスクは外す', () => {
  const c = sample()
  c.tasks.find((t) => t.id === 't9')!.state = 'stop'
  // パネルと同じく Orca の状態を持たない（worker のタスクもメインの書いた state のまま）
  const noOrca = () => view(c, { dispatches: undefined })
  const s = stateOf(noOrca())
  assert.deepEqual(s.checks.orphan_waits, ['t9'], 't1 は決めるが指す・t6 は顧客待ち')
  assert.equal(s.checks.push_check, false, '進行中のタスクがある')
  for (const t of c.tasks) if (t.state === 'run') t.state = 'ok'
  assert.equal(stateOf(noOrca()).checks.push_check, true)
  c.items.push({ id: 'p1', rev: 1, kind: 'dec', title: 'push する', state: 'open', topic: 'push' })
  assert.equal(stateOf(noOrca()).checks.push_check, false, 'push の dec が開いている')
})

test('古い形の cockpit.json（summary・next_milestone・state_label）も読み、要約の文はどこにも出さない', () => {
  const raw = JSON.parse(readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8'))
  raw.summary = '期限切れの項目は 0 件。他は予定どおり'
  raw.workspace.next_milestone = { date: '2026-11-21', label: '定例' }
  const c = parseCockpit(JSON.stringify(raw))
  const v = view(c)
  const s = sameEverywhere(v)
  const over = new Date('2026-11-19T09:00:00+09:00').getTime()
  assert.ok(report(c, v.log, [], undefined, 'skipped', over).overdue.length > 0)
  const row: WsRow = { root: '/x', name: 'x', open: s.counts.total, counts: s.counts, due: '2026-11-18T18:00:00+09:00', workers: 0, stopped: 0 }
  const other: WsRow = { ...row, root: '/w' }
  const win = renderWindow({ mode: 'follow', rows: [row, other], live: 0, view: v, errors: [] }, v, ui(), over, (x) => x)
  assert.match(win, /期限切れ/)
  noMatch(win, /期限切れの項目は 0 件|予定どおり/)
  noMatch(JSON.stringify(s), /予定どおり/)
})

test('件数・いちばん急ぐ項目・カードの文は、窓の要対応と同じ数え方', () => {
  const c = sample()
  const d = derive(c, { ops: [] }, [], undefined)
  const s = stateOf(view(c))
  assert.deepEqual(d.counts, { dec: s.counts.dec, ask: s.counts.ask, rev: s.counts.rev })
  assert.equal(s.next?.id, 'd4')
  assert.match(s.card, /^要対応 7 件（判断 4・質問 1・確認 2）・最短 11\/17\(火\) 10:00・依頼 2 件$/)
})

test('完了したタスクには「次の作業」を出さない。worker の取り込み待ちのタスクは顧客への確認の一覧に出さない', () => {
  const c = sample()
  Object.assign(c.tasks.find((t) => t.id === 't8')!, { next: '画面の案を作る' })
  Object.assign(c.tasks.find((t) => t.id === 't9')!, { next: '設計を合意する' })
  const detail = (id: string) => render(view(c), ui({ curTask: id }), NOW, (x) => x)
  noMatch(detail('t8'), /次の作業/)
  assert.match(detail('t9'), /次の作業<\/div>設計を合意する/)
  const ask = c.items.find((i) => i.id === 'd2')!
  Object.assign(ask, { state: 'done', resolved_by: 'user', resolved_at: '2026-11-15T10:00:00+09:00', related: [{ task: 't5' }, { task: 't6' }] })
  // t5 は worker が作業を終えた（画面は「メインの取り込み待ち」・状態は wait）、t6 は顧客待ち
  const v = view(c, { dispatches: { ctx_a2: settled(60_000) } })
  const html = render(v, ui(), NOW, (x) => x)
  assert.match(html, /顧客への確認 <span class="num">1<\/span> 件/)
  Object.assign(ask, { related: [{ task: 't5' }] })
  noMatch(render(v, ui(), NOW, (x) => x), /顧客への確認 <span class="num">/)
})
