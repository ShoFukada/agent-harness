import { afterEach, assert, mockHost, mountWorker as mountRaw, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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

const SAMPLE = readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8')
const WIRE = readFileSync(new URL('../fixtures/figures/list-wire.svg', import.meta.url), 'utf8')

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
      'terminal.sendText': { accepted: true }
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
    '.orca/cockpit/figures/list-wire.svg': WIRE,
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 1, at: 'x', item_id: 'd1', item_rev: 1, type: 'talk' }] })
  })
  const w = await mountWorker(main, { host: host(root) })
  const v = await w.request('cockpit.get')
  assert.equal(v.state, 'ok')
  assert.equal(v.cockpit?.workspace.name, '問い合わせ管理システム')
  assert.equal(v.log.ops.length, 1)
  assert.match(v.figures['.orca/cockpit/figures/list-wire.svg'] ?? '', /<svg/)
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
  await w.request('cockpit.op', { root, item_id: 'd1', item_rev: 1, type: 'decide', option_id: 'auto' })
  const res = await w.request('cockpit.op', { root, item_id: 'd1', item_rev: 1, type: 'undo', undo_of: 1 })
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
    w.request('cockpit.op', { root, item_id: 'd1', item_rev: 1, type: 'decide', option_id: 'auto' }),
    w.request('cockpit.op', { root, item_id: 'a2', item_rev: 1, type: 'ack' })
  ])
  const log = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { op_id: number; item_id: string }) => [o.op_id, o.item_id]).sort(), [[1, 'd1'], [2, 'a2']].sort())
})

test('切り替え前の画面から届いた操作は、いまのワークスペースに記録しない', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  const err = await w.request('cockpit.op', { root: '/other', item_id: 'd1', item_rev: 1, type: 'ack' }).then(() => null, (e: Error) => e)
  assert.match(err?.message ?? '', /表示中のワークスペースが変わりました/)
  assert.equal(existsSync(path.join(root, '.orca/cockpit.user.json')), false)
})

test('記録する版は、パネルが表示していた版', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  await w.request('cockpit.op', { root, item_id: 'd1', item_rev: 0, type: 'ack' })
  const log = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.user.json'), 'utf8'))
  assert.equal(log.ops[0].item_rev, 0)
})

test('知らせるは、メインの端末に合図の 1 行だけを Enter つきで送る。話したいは押した瞬間には送らない', async () => {
  const root = workspace({ '.orca/cockpit.json': withMain('term_main') })
  const h = host(root)
  const w = await mountWorker(main, { host: h })
  const res = await w.request('cockpit.op', { root, item_id: 'd1', item_rev: 1, type: 'talk', text: '自動の割り当ては偏らないか' })
  assert.equal(res.notify, undefined)
  assert.deepEqual(h.callsOf('terminal.sendText'), [])
  assert.deepEqual(await w.request('cockpit.notify'), { sent: true })
  assert.deepEqual(h.callsOf('terminal.sendText'), [{ terminalId: 'term_main', text: `${SIGNAL}（話したい d1: 自動の割り当ては偏らないか）`, enter: true }])
  assert.equal((await w.request('cockpit.get')).notifiedOp, 1)
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
  assert.deepEqual(await w.request('cockpit.focus', { terminalId: 'term_w' }), { focused: true })
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

test('メインがチャットなら、話したいは記録だけして端末に送らない', async () => {
  const c = JSON.parse(SAMPLE)
  c.main = { agent: 'claude', terminal: '' }
  const root = workspace({ '.orca/cockpit.json': JSON.stringify(c) })
  const h = host(root)
  const w = await mountWorker(main, { host: h })
  const res = await w.request('cockpit.op', { root, item_id: 'd1', item_rev: 1, type: 'talk', text: '偏りは？' })
  assert.equal(res.notify, undefined)
  assert.equal(res.view.log.ops.length, 1)
  assert.equal(h.callsOf('terminal.sendText').length, 0)
})

test('パネルも窓と同じ検証で、本文の無い話したいと上限を超える別の答えを切らずに断る', async () => {
  const root = workspace({ '.orca/cockpit.json': SAMPLE })
  const w = await mountWorker(main, { host: host(root) })
  await assert.rejects(w.request('cockpit.op', { root, item_id: 'd1', item_rev: 1, type: 'talk' }), /話したいことを書いてください/)
  await assert.rejects(
    w.request('cockpit.op', { root, item_id: 'd5', item_rev: 1, type: 'decide', option_id: 'other', text: 'あ'.repeat(4001) }),
    /4000 字までです（今 4001 字）/
  )
  assert.equal(existsSync(path.join(root, '.orca/cockpit.user.json')), false)
})

test('取り消しの猶予が過ぎた操作は、メインが入力待ちになったら自動で合図を送る', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const root = workspace({
    '.orca/cockpit.json': withMain('term_main'),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 1, at: old, item_id: 'd1', item_rev: 1, type: 'decide', option_id: 'auto' }] })
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
  assert.equal(done.notifiedOp, 1)
  assert.equal(done.signal, undefined)
  await w.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 'term_main', state: 'done', receivedAt: 3 })
  assert.equal(h.callsOf('terminal.sendText').length, 1, '届けた操作には二度送らない')
})
