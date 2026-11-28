import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { emptyFiles, loadFiles } from '../src/store.ts'
import { askNotice, askTabs, askTitle, type AskWs } from './ask-tabs.ts'
import type { AskTabRow, Orca } from './server.ts'

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p))
const HOUR = 3600_000

/** 案件A の帳簿と、答えの済んだ質問 ask1 の控え（窓の常駐のプロセスを立てずに、質問のタブの処理だけを試す）。 */
function workspace(ops: unknown[] = []) {
  const root = tmp('cockpit-asktabs-')
  const c = structuredClone(sample()[0]!.cockpit)
  c.workspace.name = '案件A'
  mkdirSync(path.join(root, '.orca/consult'), { recursive: true })
  writeFileSync(path.join(root, '.orca/cockpit.json'), JSON.stringify(c))
  if (ops.length) writeFileSync(path.join(root, '.orca/cockpit.user.json'), JSON.stringify({ ops }))
  const memo = path.join(root, '.orca/consult/ask-ask1.md')
  writeFileSync(memo, '# 質問｜案件A｜ask1\n\n### 質問 09:10（u-1）\n入口は？\n\n### 答え 09:11\n1 つにする\n\n')
  return { root, memo }
}

async function setup(root: string, orca: Pick<Orca, 'tabs' | 'closeTerminal' | 'send'>) {
  const dir = tmp('cockpit-asktabs-dir-')
  const ws: AskWs = { root, files: await loadFiles(root, emptyFiles()) }
  const asks = askTabs({
    orca, dir, workspaces: () => [ws], inQueue: (_root, fn) => fn(),
    reload: async (w) => void (w.files = await loadFiles(w.root, w.files)),
    broadcast: () => {}, stopped: () => false
  })
  return { ws, dir, asks }
}

test('質問のタブに送れなかった「返しを書いて」は届けた記録に残さず、次の見回りで送り直す', async () => {
  const { root } = workspace([{ op_id: 50, at: '2026-11-23T05:06:59.989Z', item_id: '#ask:ask1', item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: '1 つにする', n: 1 } }])
  const sent: string[][] = []
  let fail = true
  const tabs = async (): Promise<AskTabRow[]> => [{ title: askTitle('案件A', 'ask1'), handles: ['term_ask1'] }]
  const send = async (t: string, text: string) => {
    if (fail) throw new Error('端末が応えない')
    sent.push([t, text])
  }
  const { ws, asks } = await setup(root, { tabs, send })
  const op = ws.files.log.ops.find((o) => o.op_id === 50)!
  const r = await asks.deliver(ws, 'ask1', op)
  assert.deepEqual(r, { sent: false, reason: '写しの会話に送れませんでした: 端末が応えない' })
  assert.deepEqual(await asks.sentOf(root), [])
  assert.deepEqual(asks.undelivered(ws, []).map((x) => [x.id, x.op.op_id]), [['ask1', 50]])
  fail = false
  await asks.resend()
  assert.deepEqual(sent, [['term_ask1', askNotice(50)]])
  assert.deepEqual(await asks.sentOf(root), [50])
  await asks.resend()
  assert.equal(sent.length, 1, '届けた op は 2 回送らない')
})

test('窓が立てた端末の記録が無い質問のタブは閉じず、控えが書き換わるまで探し直さない（R180）', async () => {
  const { root, memo } = workspace()
  const now = Date.now()
  utimesSync(memo, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR))
  const closed: string[] = []
  let looked = 0
  const tabs = async (): Promise<AskTabRow[]> => (looked++, [{ title: askTitle('案件A', 'ask1'), handles: ['term_ask1'] }])
  const { ws, dir, asks } = await setup(root, { tabs, send: async () => {}, closeTerminal: async (t) => void closed.push(t) })
  await asks.sweep(now)
  assert.deepEqual(closed, [], '人が同じ題で開いたタブかもしれないので閉じない')
  assert.equal(looked, 1)
  // 記録を足しても、控えの最後の書き込みが同じあいだは Orca に聞き直さない。
  writeFileSync(path.join(dir, 'asktabs.json'), JSON.stringify({ [root]: { ask1: 'term_ask1' } }))
  await asks.sweep(now)
  assert.equal(looked, 1)
  utimesSync(memo, new Date(now - 90 * 60_000), new Date(now - 90 * 60_000))
  await asks.sweep(now)
  assert.deepEqual(closed, ['term_ask1'])
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'asktabs.json'), 'utf8')), { [root]: {} }, '閉じた端末の記録は消す')
  assert.ok(existsSync(memo) && ws.askChecked?.has('ask1'), '控えは消さない')
})
