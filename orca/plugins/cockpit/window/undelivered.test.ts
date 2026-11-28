import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Cockpit } from '../src/model.ts'
import { emptyFiles } from '../src/store.ts'
import { signals, type SignalWs } from './notify.ts'
import type { Orca } from './server.ts'
import { readStuckBand, STUCK_AFTER_MS, stuckBand, stuckOf } from './undelivered.ts'

const NOW = Date.parse('2026-11-28T06:00:00Z')
const at = (min: number) => new Date(NOW - min * 60_000).toISOString()

test('誰にも届いていない知らせは read が 0 かつ delivered_at が空のものだけ。届いたが読んでいない・読んだものは数えない', () => {
  const s = stuckOf([
    { read: 0, delivered_at: null, created_at: at(30) },
    { read: 0, delivered_at: null, created_at: at(3 * 24 * 60) },
    { read: 0, delivered_at: at(10), created_at: at(20) },
    { read: 1, delivered_at: at(10), created_at: at(4 * 24 * 60) }
  ])
  assert.deepEqual(s, { count: 2, oldest: NOW - 3 * 86_400_000, partial: false })
  assert.equal(stuckOf([{ read: 1, delivered_at: at(1), created_at: at(1) }]), undefined)
  assert.equal(stuckOf([{ read: 0, delivered_at: null, created_at: at(1) }], 1)?.partial, true)
  // Orca の形が変わって欄が無ければ、届いたと読まずに投げる
  assert.throws(() => stuckOf([{ created_at: at(1) }]), /read・delivered_at が無い/)
  assert.throws(() => stuckOf([{ read: 0, delivered_at: null }]), /created_at が無い/)
})

test('帯は最古の未配達が 10 分より古いときだけ出し、引き継がなかった印と合図への注意書きを添える', () => {
  const s = (min: number) => ({ count: 3, oldest: NOW - min * 60_000, partial: false })
  assert.equal(stuckBand('案件A', 'run_m', s(9), NOW), undefined)
  assert.equal(stuckBand('案件A', 'run_m', undefined, NOW), undefined)
  assert.equal(stuckBand('案件A', 'run_m', s(STUCK_AFTER_MS / 60_000), NOW), undefined)
  assert.equal(
    stuckBand('案件A', 'run_m', { ...s(STUCK_AFTER_MS / 60_000), oldest: NOW - STUCK_AFTER_MS - 1 }, NOW),
    '案件A: 窓口に届いていない知らせ 3 件（最古 10分前）。窓口のチャットに話しかけると引き継ぐ'
  )
  assert.match(stuckBand('案件A', 'run_m', s(3 * 24 * 60 + 5), NOW)!, /最古 3日前/)
  assert.match(stuckBand('案件A', 'run_m', { ...s(30), partial: true }, NOW)!, /3 件以上/)
  assert.equal(
    stuckBand('案件A', 'run_m', s(30), NOW, { own_run: 'run_o', ledger_run: 'run_m' }, ['the recipient is not live']),
    '案件A: 窓口に届いていない知らせ 3 件（最古 30分前）。最後に話しかけた本線のチャットは自分の Run（run_o）を持つため引き継いでいません。Run を持たない本線のチャットに話しかけると引き継ぐ（窓からの合図への Orca の注意: the recipient is not live）'
  )
  // 帳簿が別の Run に付け替わったあとの古い印は使わない
  assert.match(stuckBand('案件A', 'run_new', s(30), NOW, { own_run: 'run_o', ledger_run: 'run_m' })!, /窓口のチャットに話しかけると引き継ぐ$/)
})

test('readStuckBand: 帳簿の Run の受信箱を読み、hook の印を添える。読めなければ帯を出さず、同じ理由はログに 1 回だけ出す', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-stuck-'))
  const c = { workspace: { name: '案件A' }, main: { agent: 'claude', run_id: 'run_m' } } as unknown as Cockpit
  const asked: string[] = []
  const mail = [{ read: 0, delivered_at: null, created_at: new Date(Date.now() - 50 * 60_000).toISOString() }]
  assert.match((await readStuckBand({ runInbox: async (r) => (asked.push(r), mail) }, root, c, Date.now()))!, /^案件A: 窓口に届いていない知らせ 1 件（最古 50分前）。窓口のチャット/)
  assert.deepEqual(asked, ['run_m'])
  mkdirSync(path.join(root, '.orca/cockpit'), { recursive: true })
  writeFileSync(path.join(root, '.orca/cockpit/run-takeover.json'), JSON.stringify({ own_run: 'run_o', ledger_run: 'run_m' }))
  assert.match((await readStuckBand({ runInbox: async () => mail }, root, c, Date.now()))!, /自分の Run（run_o）/)
  assert.equal(await readStuckBand({ runInbox: async () => [] }, root, c, Date.now()), undefined)
  assert.equal(await readStuckBand({ runInbox: async () => mail }, root, { ...c, main: { agent: 'claude' } } as Cockpit, Date.now()), undefined)
  const logs: string[] = []
  const orig = console.error
  console.error = (m: string) => void logs.push(m)
  try {
    for (let i = 0; i < 2; i++) assert.equal(await readStuckBand({ runInbox: async () => { throw new Error('orca に繋がらない') } }, root, c, Date.now()), undefined)
  } finally {
    console.error = orig
  }
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /数えられない.*run:run_m.*orca に繋がらない/)
})

test('窓の合図が送れたら、Orca の注意書きを案件に覚える（届かない知らせの帯の補足）。次に注意書きなしで送れたら消す', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-warn-'))
  const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-warn-dir-'))
  let warnings = ['recipient run run_m has no live coordinator']
  const orca = {
    terminals: async () => [{ handle: 'term_box', tabId: 't', leafId: 'b' }],
    mailbox: async () => 'term_box',
    notifyRun: async () => warnings
  } as unknown as Orca
  const files = emptyFiles()
  files.cockpit = { version: 2, workspace: { name: '案件A' }, main: { agent: 'claude', run_id: 'run_m' }, streams: [], tasks: [], cards: [] } as unknown as Cockpit
  files.log = { ops: [{ op_id: 1, at: new Date(0).toISOString(), item_id: 'r1', item_rev: 1, type: 'accept' }] } as never
  const ws: SignalWs = { root, files }
  const sig = signals({ orca, dir, broadcast: () => {} })
  const orig = console.error
  console.error = () => {}
  try {
    assert.deepEqual(await sig.notify(ws), { sent: true })
    assert.deepEqual(ws.warnings, ['recipient run run_m has no live coordinator'])
    warnings = []
    files.log = { ops: [...files.log.ops, { op_id: 2, at: new Date(0).toISOString(), item_id: 'r1', item_rev: 1, type: 'accept' }] } as never
    await sig.notify(ws)
    assert.deepEqual(ws.warnings, [])
  } finally {
    console.error = orig
  }
})
