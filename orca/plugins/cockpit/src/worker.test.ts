import { afterEach, assert, mockHost, mountWorker as mountRaw, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sample } from '../fixtures/sample.ts'
import * as main from './worker.ts'
import { SIGNAL } from './worker.ts'

// focus.json を本物の ~/Library に書かない。
const FOCUS_DIR = mkdtempSync(path.join(tmpdir(), 'cockpit-focus-'))
process.env.COCKPIT_DIR = FOCUS_DIR

// 失敗したテストでも見張りを止め、テストの実行が終わらなくならないようにする。
const mounted: { deactivate(): Promise<void> | void }[] = []
const mountWorker: typeof mountRaw = async (...args) => {
  const w = await mountRaw(...args)
  mounted.push(w)
  return w
}
afterEach(async () => {
  for (const w of mounted.splice(0)) await w.deactivate()
})

const AOBA = sample()[0]!
const SAMPLE = JSON.stringify(AOBA.cockpit)
const WIRE = AOBA.figure!

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-test-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), text)
  }
  return root
}

function host(root: string, terminals = ['term_main']) {
  return mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'b', displayName: 'w', terminals: terminals.map((id) => ({ id })) },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'w', path: root, branch: 'b', hostId: 'local' }], truncated: false },
      'agents.list': {
        agents: [
          { terminalId: 'term_main', title: 'main', agent: 'claude', state: 'working', stateStartedAt: 1 },
          { terminalId: 'term_w', title: 'notify-draft', agent: 'claude', state: 'blocked', stateStartedAt: 2 }
        ]
      },
      'terminal.sendText': { accepted: true },
      'statusBar.update': { ok: true }
    }
  })
}

const withMain = (terminal: string) => {
  const c = JSON.parse(SAMPLE)
  c.main.terminal = terminal
  return JSON.stringify(c)
}

test('ファイルが無いワークスペースは missing を返す', async () => {
  const w = await mountWorker(main, { host: host(workspace()) })
  const v = await w.request('cockpit.get')
  assert.equal(v.state, 'missing')
  assert.equal(v.cockpit, undefined)
})

test('cockpit.json・操作ログ・図を読み、メインを worker の数から除く', async () => {
  const root = workspace({
    '.orca/cockpit.json': withMain('term_main'),
    '.orca/cockpit/figures/entry.svg': WIRE,
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 1, at: 'x', item_id: 'd21', item_rev: 1, type: 'talk' }] })
  })
  const w = await mountWorker(main, { host: host(root) })
  const v = await w.request('cockpit.get')
  assert.equal(v.state, 'ok')
  assert.equal(v.cockpit?.workspace.name, '青葉物流 配車アプリ')
  assert.equal(v.log.ops.length, 1)
  assert.match(v.figures['.orca/cockpit/figures/entry.svg'] ?? '', /<svg/)
  assert.deepEqual(v.workers.map((a) => a.terminalId), ['term_w'])
  assert.deepEqual(v.errors, [])
})

test('壊れた JSON に書き換わったら、前回の中身を保ってエラーを 1 行出す', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  await w.request('cockpit.get')
  writeFileSync(path.join(root, '.orca/cockpit.json'), '{ "workspace": ')
  const post = await waitFor(() => w.posts.at(-1)?.payload as { errors: string[]; cockpit?: unknown } | undefined, (p) => !!p?.errors.some((e) => e.startsWith('cockpit.json')))
  assert.ok(post!.errors.some((e) => /cockpit.json を読めません（前回の表示のまま）/.test(e)))
  assert.ok(post!.cockpit)
})

test('決定は版と連番つきで追記し、端末には何も送らない', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const h = host(root)
  const w = await mountWorker(main, { host: h })
  await w.request('cockpit.op', { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' })
  const res = await w.request('cockpit.op', { root, item_id: 'd21', item_rev: 1, type: 'undo', undo_of: 1 })
  const log = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { op_id: number; type: string; item_rev: number }) => [o.op_id, o.type, o.item_rev]), [[1, 'decide', 1], [2, 'undo', 1]])
  assert.equal(log.ops[1].undo_of, 1)
  assert.equal(res.view.log.ops.length, 2)
  assert.equal(h.callsOf('terminal.sendText').length, 0)
})

test('同時に押した操作は連番を分けて両方残す', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  await Promise.all([
    w.request('cockpit.op', { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' }),
    w.request('cockpit.op', { root, item_id: 'r5', item_rev: 1, type: 'accept' })
  ])
  const log = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { op_id: number; item_id: string }) => [o.op_id, o.item_id]).sort(), [[1, 'd21'], [2, 'r5']].sort())
})

test('切り替え前の画面から届いた操作は、いまのワークスペースに記録しない', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  const err = await w.request('cockpit.op', { root: '/other', item_id: 'r5', item_rev: 1, type: 'accept' }).then(() => null, (e: Error) => e)
  assert.match(err?.message ?? '', /表示中のワークスペースが変わりました/)
  assert.equal(existsSync(path.join(root, '.orca/cockpit.user.json')), false)
})

test('担当が書き換えたあとの古い版に押した操作は、記録せずに断る', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  await assert.rejects(w.request('cockpit.op', { root, item_id: 'd22', item_rev: 1, type: 'sent' }), /担当が書き換えました/)
  assert.equal(existsSync(path.join(root, '.orca/cockpit.user.json')), false)
})

test('担当と話す: カードを話し中にする操作を 1 度だけ記録し、担当の端末を前に出す。押した瞬間にはメインに送らない', async () => {
  const root = workspace({ '.orca/cockpit.json': withMain('term_main') })
  const h = host(root)
  h.respond('terminal.focus', { focused: true })
  const w = await mountWorker(main, { host: h })
  assert.deepEqual(await w.request('cockpit.talk', { root, item_id: 'r5', item_rev: 1 }), { opened: true, how: '配車画面の改修の端末' })
  await w.request('cockpit.talk', { root, item_id: 'r5', item_rev: 1 })
  const log = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { item_id: string; type: string }) => [o.item_id, o.type]), [['r5', 'talk']])
  assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 'term_aoba_w1' }, { terminalId: 'term_aoba_w1' }])
  assert.deepEqual(h.callsOf('terminal.sendText'), [])
  // 前面が変わったあとの要求は、別の案件の同じ id のカードに記録しない。
  await assert.rejects(w.request('cockpit.talk', { root: '/other', item_id: 'r5', item_rev: 1 }), /表示中のワークスペースが変わりました/)
  // 担当がチャットなら、パネルからは前に出せないので、どこで話すかを返す。
  assert.deepEqual(await w.request('cockpit.talk', { root, item_id: 'd21', item_rev: 1 }), { opened: false, how: 'このワークスペース', tab: 'AWS 構成案（担当）' })
  assert.deepEqual(await w.request('cockpit.notify'), { sent: true })
  assert.deepEqual(h.callsOf('terminal.sendText').at(-1), { terminalId: 'term_main', text: `${SIGNAL}（担当と話す d21）`, enter: true })
})

test('担当と話す: 担当の端末を前に出せなければ理由を返し、カードを話し中にしない（チャットの担当の structworker_ はパネルからは前に出せない）', async () => {
  const c = JSON.parse(withMain('term_main'))
  c.owners[1].terminal = 'structworker_lead'
  const root = workspace({ '.orca/cockpit.json': JSON.stringify(c) })
  const h = host(root)
  h.respond('terminal.focus', { focused: false })
  const w = await mountWorker(main, { host: h })
  const r = (await w.request('cockpit.talk', { root, item_id: 'r5', item_rev: 1 })) as { opened: boolean; reason?: string }
  assert.equal(r.opened, false)
  assert.match(r.reason ?? '', /担当「配車画面の改修」の端末を Orca が前に出せませんでした/)
  assert.equal(existsSync(path.join(root, '.orca/cockpit.user.json')), false)
})

test('Orca の下の帯に、前面の案件の私の番を出す。期限が 24 時間以内のものがあれば danger', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const h = host(root)
  const w = await mountWorker(main, { host: h })
  await w.emit('workspace.changed', { context: { workspaceId: 'w1', branch: 'b', displayName: 'w', terminals: [] } })
  const last = h.callsOf('statusBar.update').at(-1) as { text: string; tone: string; tooltip: string }
  // 許可待ちの worker（term_w）は詰まりとして数える。
  assert.equal(last.text, '私の番 4')
  assert.equal(last.tone, 'danger')
  assert.match(last.tooltip, /青葉物流 配車アプリ: 私の番 4 件（詰まり 1・決める 1・送る前 1・見て 1）/)
})

test('メインの端末がワークスペースに無ければ送らず、理由を返す', async () => {
  const root = workspace({ '.orca/cockpit.json': withMain('term_gone') })
  const h = host(root)
  const w = await mountWorker(main, { host: h })
  const res = await w.request('cockpit.notify')
  assert.deepEqual(res, { sent: false, reason: 'メインの端末が見つかりません' })
  assert.equal(h.callsOf('terminal.sendText').length, 0)
})

test('ワークスペースが切り替わったら、そのワークスペースのファイルを読み直して送る', async () => {
  const a = workspace({ '.orca/cockpit.json': SAMPLE })
  const b = workspace()
  const h = host(a)
  h.respond('workspace.list', {
    workspaces: [
      { id: 'w1', kind: 'worktree', name: 'a', path: a, branch: 'a', hostId: 'local' },
      { id: 'w2', kind: 'worktree', name: 'b', path: b, branch: 'b', hostId: 'local' }
    ],
    truncated: false
  })
  const w = await mountWorker(main, { host: h })
  assert.equal((await w.request('cockpit.get')).state, 'ok')
  await w.emit('workspace.changed', { context: { workspaceId: 'w2', branch: 'b', displayName: 'b', terminals: [] } })
  const last = w.posts.at(-1)?.payload as { state: string; root: string }
  assert.equal(last.state, 'missing')
  assert.equal(last.root, b)
})

test('前面のワークスペースが変わったら、パスとメインの端末を focus.json に書く', async () => {
  const a = workspace({ '.orca/cockpit.json': withMain('term_main') })
  const b = workspace()
  const h = host(a)
  h.respond('workspace.list', {
    workspaces: [
      { id: 'w1', kind: 'worktree', name: 'a', path: a, branch: 'a', hostId: 'local' },
      { id: 'w2', kind: 'worktree', name: 'b', path: b, branch: 'b', hostId: 'local' }
    ],
    truncated: false
  })
  const w = await mountWorker(main, { host: h })
  await w.request('cockpit.get')
  const focus = () => JSON.parse(readFileSync(path.join(FOCUS_DIR, 'focus.json'), 'utf8'))
  assert.deepEqual([focus().workspace_id, focus().path, focus().main_terminal], ['w1', a, 'term_main'])
  await w.emit('workspace.changed', { context: { workspaceId: 'w2', branch: 'b', displayName: 'b', terminals: [] } })
  assert.deepEqual([focus().workspace_id, focus().path, focus().main_terminal], ['w2', b, undefined])
  await w.emit('agent.status.changed', { workspaceId: 'w2', paneKey: 'p', state: 'blocked', receivedAt: 1 })
  assert.equal(typeof focus().agents_at, 'number')
})

test('止まっている worker には理由を付け、帯の印から端末を前に出せる', async () => {
  const root = workspace({ '.orca/cockpit.json': withMain('term_main') })
  const h = host(root)
  h.respond('terminal.focus', { focused: true })
  const w = await mountWorker(main, { host: h })
  const v = await w.request('cockpit.get')
  assert.deepEqual(v.workers.map((a) => a.stop), ['blocked'])
  assert.deepEqual(await w.request('cockpit.focus', { terminalId: 'term_w' }), { focused: true, how: '端末' })
  assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 'term_w' }])
})

async function waitFor<T>(get: () => T, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = get()
    if (ok(v)) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timed out')
}

test('メインがチャットなら、別の答えは記録だけして端末に送らない', async () => {
  const c = JSON.parse(SAMPLE)
  c.main = { agent: 'claude', terminal: '' }
  const root = workspace({ '.orca/cockpit.json': JSON.stringify(c) })
  const h = host(root)
  const w = await mountWorker(main, { host: h })
  const res = await w.request('cockpit.op', { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other', text: '偏りは？' })
  assert.equal(res.notify, undefined)
  assert.equal(res.view.log.ops.length, 1)
  assert.equal(h.callsOf('terminal.sendText').length, 0)
})

test('パネルも窓と同じ検証で、本文の無い別の答え・無い選択肢・上限を超える別の答えを切らずに断る', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  await assert.rejects(w.request('cockpit.op', { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other' }), /別の答えを書いてください/)
  await assert.rejects(w.request('cockpit.op', { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'nope' }), /選択肢 nope がありません/)
  await assert.rejects(
    w.request('cockpit.op', { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other', text: 'あ'.repeat(4001) }),
    /4000 字までです（今 4001 字）/
  )
  assert.equal(existsSync(path.join(root, '.orca/cockpit.user.json')), false)
})

test('取り消しの猶予が過ぎた操作は、メインが入力待ちになったら自動で合図を送る', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const root = workspace({
    '.orca/cockpit.json': withMain('term_main'),
    // 見本の applied_ops は [1] なので、未反映の操作は 2 から。
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 2, at: old, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' }] })
  })
  const h = host(root)
  const agents = (state: string) => ({ agents: [{ terminalId: 'term_main', title: 'main', agent: 'claude', state, stateStartedAt: 1 }] })
  h.respond('agents.list', agents('working'))
  const w = await mountWorker(main, { host: h })
  const busy = await w.request('cockpit.get')
  assert.deepEqual(busy.signal, { state: 'waiting' })
  assert.equal(h.callsOf('terminal.sendText').length, 0)
  h.respond('agents.list', agents('done'))
  await w.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 'term_main', state: 'done', receivedAt: 2 })
  assert.deepEqual(h.callsOf('terminal.sendText'), [{ terminalId: 'term_main', text: SIGNAL, enter: true }])
  const done = await w.request('cockpit.get')
  assert.equal(done.notifiedOp, 2)
  assert.equal(done.signal, undefined)
  await w.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 'term_main', state: 'done', receivedAt: 3 })
  assert.equal(h.callsOf('terminal.sendText').length, 1, '届けた操作には二度送らない')
})
