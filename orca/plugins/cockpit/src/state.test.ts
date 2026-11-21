import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import type { Cockpit } from './model.ts'
import type { AgentRow } from './protocol.ts'
import { bucketOf, derive, NAME_MAX, ORCA_STATUS, report, routeProblem } from './state.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const ws = (n: number) => structuredClone(sample(NOW)[n]!)
const agent = (over: Partial<AgentRow>): AgentRow => ({ terminalId: 'term_x', title: 'x', agent: 'claude', state: 'working', since: NOW - 25 * 60_000, ...over })

test('私の番は期限順の 1 列。件数は送る前・決める・見て・許す・詰まりの 5 種類だけで、届いた・話し中・報告は数えない', () => {
  const w = ws(0)
  const d = derive(w.cockpit, w.log, [], '/a', undefined, NOW)
  assert.deepEqual(d.queue.map((r) => r.card.id), ['d22', 'd21', 'r5', 'i3'])
  assert.equal(d.total, 3)
  assert.equal(d.counts.inbox, 1)
  assert.deepEqual(d.talking.map((r) => r.card.id), ['c4'])
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
  assert.equal(stuck.card.title, 'ログ集計の見直し が許可待ち')
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
  assert.equal(r.overview, '全体: 私の番 3 件（決める 1・送る前 1・見て 1）・話し中 1・顧客待ち 1・動いている worker 0')
  assert.deepEqual(r.checks.remind_due, ['w1'])
  assert.deepEqual(r.checks.long_names, [`s9（${NAME_MAX + 1} 字）`])
  assert.equal(r.next?.id, 'd22')
  assert.deepEqual(r.overdue, ['d22'])
  const h = ws(2)
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
