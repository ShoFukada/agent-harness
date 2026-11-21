import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import type { WindowView } from '../src/protocol.ts'
import { SIGNAL } from '../src/store.ts'
import type { Ask } from './assistant.ts'
import { createServer, stopReason, type Orca, type PluginRow, type PsAgent, type PsRow } from './server.ts'

const SAMPLE = readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8')
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p))

function workspace(name: string, files: Record<string, string> = {}): string {
  const root = tmp(`cockpit-${name}-`)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}
const cockpit = (name: string, over: Record<string, unknown> = {}) => {
  const c = JSON.parse(SAMPLE)
  c.workspace.name = name
  c.main = { agent: 'claude', terminal: 'term_main' }
  return JSON.stringify({ ...c, ...over })
}
const agent = (paneKey: string, over: Partial<PsAgent> = {}): PsAgent => ({ paneKey, state: 'working', stateStartedAt: 1, hasLivePty: true, ...over })

function fakeOrca(rows: PsRow[], plugins: PluginRow[] = [{ pluginKey: 'local.cockpit', status: 'running', needsReconsent: false, isDev: false }]) {
  const calls: string[][] = []
  const orca: Orca = {
    ps: async () => rows,
    terminals: async () => [
      { handle: 'term_main', tabId: 't', leafId: 'main' },
      { handle: 'term_w1', tabId: 't', leafId: 'w1' }
    ],
    plugins: async () => plugins,
    send: async (t, text) => void calls.push(['send', t, text]),
    activate: async (root) => void calls.push(['activate', root]),
    switchTerminal: async (t) => void calls.push(['switch', t]),
    openFile: async (root, abs, line) => void calls.push(line ? ['open', root, abs, String(line)] : ['open', root, abs]),
    openUrl: async (url) => void calls.push(['url', url])
  }
  return { orca, calls }
}

const servers: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function start(rows: PsRow[], focusPath?: string, ask: Ask | null = null, plugins?: PluginRow[]) {
  const dir = tmp('cockpit-dir-')
  const setFocus = (p: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ path: p, at: new Date().toISOString(), ...extra }))
  if (focusPath) setFocus(focusPath)
  const fake = fakeOrca(rows, plugins)
  // テストでは claude CLI を起こさない（ask を渡したテストだけ答える）。
  const s = createServer({ port: 0, dir, orca: fake.orca, ask })
  servers.push(s)
  const port = await s.listen()
  const origin = `http://127.0.0.1:${port}`
  const post = async (name: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${origin}/api/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-cockpit-token': s.token, ...headers },
      body: JSON.stringify(body)
    })
    return { status: r.status, body: await r.json() }
  }
  return { s, port, origin, post, setFocus, dir, calls: fake.calls }
}

function listen(port: number, token: string) {
  const got: WindowView[] = []
  let buf = ''
  const req = http.get({ host: '127.0.0.1', port, path: `/events?token=${token}` }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (line.startsWith('data: ')) got.push(JSON.parse(line.slice(6)))
      }
    })
  })
  servers.push({ close: async () => void req.destroy() })
  const until = async (ok: (v: WindowView) => boolean): Promise<WindowView> => {
    for (let n = 0; n < 150; n++) {
      const v = got.findLast(ok)
      if (v) return v
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`届きませんでした: ${JSON.stringify(got.at(-1)?.view.root)}`)
  }
  return { got, until }
}

function twoWorkspaces() {
  const a = workspace('a', { '.orca/cockpit.json': cockpit('案件A') })
  const b = workspace('b', { '.orca/cockpit.json': cockpit('案件B', { items: [] }) })
  const c = workspace('c', { '.orca/cockpit.json': cockpit('案件C', { items: [] }) })
  const child = workspace('a-w1')
  const rows: PsRow[] = [
    { worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main')] },
    { worktreeId: 'r::b', path: b, parentWorktreeId: null, agents: [] },
    { worktreeId: 'r::c', path: c, parentWorktreeId: null, agents: [agent('t:c')] },
    { worktreeId: 'r::c-w1', path: workspace('c-w1'), parentWorktreeId: 'r::c', agents: [agent('t:c1', { hasLivePty: false })] },
    { worktreeId: 'r::a-w1', path: child, parentWorktreeId: 'r::a', agents: [agent('t:w1', { state: 'blocked', conversationName: 'w1' })] }
  ]
  return { a, b, child, rows }
}

test('トークンが無い・Origin が違う・Host が違う書き込みを断る', async () => {
  const { a, rows } = twoWorkspaces()
  const { post, origin, port } = await start(rows, a)
  const op = { root: a, item_id: 'd1', item_rev: 1, type: 'ack' }
  assert.equal((await post('op', op, { 'x-cockpit-token': 'x' })).status, 403)
  assert.equal((await post('op', op, { origin: 'https://evil.example' })).status, 403)
  const rebound = await new Promise<number>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/op', method: 'POST', headers: { host: `evil.example:${port}`, origin } }, (res) => resolve(res.statusCode!))
    req.end('{}')
  })
  assert.equal(rebound, 403)
  assert.equal((await fetch(`${origin}/events?token=bad`)).status, 403)
  assert.throws(() => readFileSync(path.join(a, '.orca/cockpit.user.json')))
})

test('ページだけにトークンを埋め、TS は型を除いて配る。一覧に無いファイルは配らない', async () => {
  const { s, origin } = await start([])
  assert.match(await (await fetch(origin)).text(), new RegExp(`content="${s.token}"`))
  const js = await fetch(`${origin}/src/view.ts`)
  assert.match(js.headers.get('content-type') ?? '', /javascript/)
  assert.doesNotMatch(await js.text(), /: Ctx\b/)
  assert.equal((await fetch(`${origin}/src/store.ts`)).status, 404)
  assert.equal((await fetch(`${origin}/window/server.ts`)).status, 404)
})

test('ページが import でたどるファイルは全部配る', async () => {
  const { origin } = await start([])
  const seen = new Set<string>()
  const walk = async (p: string): Promise<void> => {
    if (seen.has(p)) return
    seen.add(p)
    const r = await fetch(`${origin}/${p}`)
    assert.equal(r.status, 200, `${p} を配っていない`)
    for (const [, rel] of (await r.text()).matchAll(/^import [^'"]*['"](\.[^'"]+)['"]/gm)) await walk(path.posix.join(path.posix.dirname(p), rel))
  }
  await walk('window/page.ts')
  assert.ok(seen.has('src/morph.ts'))
})

test('.orca の外へ出るパスとシンボリックリンクは読まず、開かない', async () => {
  const outside = workspace('outside', { 'secret.svg': '<svg>secret</svg>' })
  const c = JSON.parse(cockpit('案件A'))
  c.items[0].figure = '.orca/cockpit/figures/leak.svg'
  const a = workspace('a', { '.orca/cockpit.json': JSON.stringify(c), 'docs/x.md': 'x' })
  mkdirSync(path.join(a, '.orca/cockpit/figures'), { recursive: true })
  symlinkSync(path.join(outside, 'secret.svg'), path.join(a, '.orca/cockpit/figures/leak.svg'))
  const { s, port, post, calls } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const sse = listen(port, s.token)
  const v = await sse.until((w) => w.view.root === a && !!w.view.cockpit)
  assert.equal(v.view.figures['.orca/cockpit/figures/leak.svg'], undefined)
  assert.ok(v.view.errors.some((e) => /\.orca の外は読みません/.test(e)))
  assert.deepEqual((await post('open', { root: a, path: '../outside/secret.svg' })).body, { opened: false })
  assert.deepEqual((await post('open', { root: a, path: '/etc/passwd' })).body, { opened: false })
  assert.deepEqual((await post('open', { root: outside, path: 'secret.svg' })).status, 409)
  assert.deepEqual((await post('open', { root: a, path: 'docs/x.md' })).body, { opened: true })
  assert.equal(calls.filter((c) => c[0] === 'open').length, 1)
})

test('全ワークスペースの列を作り、worker は親の行に数える。前面が worker なら親の操縦席を出す', async () => {
  const { a, b, child, rows } = twoWorkspaces()
  const { s, port } = await start(rows, child)
  const sse = listen(port, s.token)
  const v = await sse.until((w) => w.rows.length === 3)
  assert.equal(v.view.root, a)
  assert.deepEqual(v.rows.map((r) => r.name), ['案件A', '案件C', '案件B'], '期限のある決の行、止まっているだけの行、何もない行の順')
  assert.equal(v.focused, a)
  const rowA = v.rows.find((r) => r.root === a)!
  assert.deepEqual([rowA.name, rowA.open, rowA.workers, rowA.stopped], ['案件A', 7, 1, 1])
  assert.deepEqual(rowA.counts, { dec: 4, ask: 1, rev: 2 }, '報告と依頼は数えない')
  assert.equal(rowA.next?.id, 'd4', '期限のいちばん近い項目')
  assert.equal(v.rows[0]!.root, a, '手当てが要る行が上')
  assert.equal(v.rows.find((r) => r.root === b)!.open, 0)
  assert.deepEqual(v.view.workers.map((w) => [w.terminalId, w.stop]), [['term_w1', 'blocked']])
  assert.equal(v.live, 3)
})

test('操縦席のプラグインが承認待ちなら、Orca に合わせた切り替えが止まっていることを上の帯に出す', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port } = await start(rows, a, null, [{ pluginKey: 'local.cockpit', status: 'pending', needsReconsent: true }])
  const sse = listen(port, s.token)
  const v = await sse.until((w) => w.errors.length > 0)
  assert.deepEqual(v.errors, ['Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています'])
})

test('見張りが alerts.json に書いた止まっているものを上の帯に出し、消えたら下げる', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, dir } = await start(rows, a)
  const sse = listen(port, s.token)
  const file = path.join(dir, 'alerts.json')
  writeFileSync(file, JSON.stringify({ alerts: [{ id: 'job:x', text: '定時ジョブ x が失敗した' }] }))
  const v = await sse.until((w) => w.errors.length > 0)
  assert.deepEqual(v.errors, ['止まっている: 定時ジョブ x が失敗した'])
  writeFileSync(file, JSON.stringify({ alerts: [] }))
  await sse.until((w) => w === sse.got.at(-1) && w.errors.length === 0)
})

test('ファイルの変更が SSE で届く', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port } = await start(rows, a)
  const sse = listen(port, s.token)
  await sse.until((w) => !!w.view.cockpit)
  writeFileSync(path.join(a, '.orca/cockpit.json'), cockpit('書き換えた'))
  const v = await sse.until((w) => w.view.cockpit?.workspace.name === '書き換えた')
  assert.equal(v.rows.find((r) => r.root === a)!.name, '書き換えた')
})

test('focus.json が変わったら出す操縦席を切り替え、手で選んだあとも前面が変わったら連動に戻る', async () => {
  const { a, b, rows } = twoWorkspaces()
  const { s, port, post, setFocus } = await start(rows, a)
  const sse = listen(port, s.token)
  await sse.until((w) => w.view.root === a && w.rows.length === 3)
  setFocus(b)
  await sse.until((w) => w.view.root === b && w.mode === 'follow')
  assert.equal((await post('select', { root: a })).status, 200)
  await sse.until((w) => w.view.root === a && w.mode === 'manual' && w.focused === b)
  setFocus(b, { agents_at: 5 })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(sse.got.at(-1)!.mode, 'manual', 'エージェントの知らせだけでは手の選択を解かない')
  setFocus(a)
  await sse.until((w) => w.view.root === a && w.mode === 'follow')
  setFocus(b)
  await sse.until((w) => w.view.root === b && w.mode === 'follow')
})

test('操作は共有の関数で cockpit.user.json に追記する。話したいは本文が要り、押した瞬間にはメインに送らない', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  const r = await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'talk', text: '偏りは？' })
  assert.equal(r.status, 200)
  assert.deepEqual(calls, [])
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { op_id: number; type: string; text?: string }) => [o.op_id, o.type, o.text]), [[1, 'talk', '偏りは？']])
  assert.equal((await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'talk', text: '  ' })).status, 400)
  assert.equal((await post('op', { root: a, item_id: 't5', item_rev: 0, type: 'talk', text: 'タスクにも話せる' })).status, 200)
  assert.equal((await post('op', { root: a, item_id: 't5', item_rev: 0, type: 'ack' })).status, 400, 'タスクに書けるのは話したいだけ')
  assert.equal((await post('op', { root: a, item_id: 'nope', item_rev: 1, type: 'ack' })).status, 400)
  assert.equal((await post('op', { root: '/elsewhere', item_id: 'd1', item_rev: 1, type: 'ack' })).status, 409)
})

test('帯の印は端末を前に出し、端末が無ければ worktree を開く。知らない端末と worktree は扱わない', async () => {
  const { a, child, rows } = twoWorkspaces()
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  assert.deepEqual((await post('focus', { terminalId: 'term_w1', worktree: child })).body, { focused: true })
  assert.deepEqual((await post('focus', { terminalId: '', worktree: child })).body, { focused: true })
  assert.deepEqual((await post('focus', { terminalId: 'term_x', worktree: '/etc' })).body, { focused: false })
  assert.deepEqual(calls, [['switch', 'term_w1'], ['activate', child]])
})

test('止まった理由: 許可待ち・返事待ち・落ちた・利用枠・ログイン切れ・エラー・中断。終わったものは止まっていない', () => {
  assert.equal(stopReason(agent('p', { state: 'blocked' })), 'blocked')
  assert.equal(stopReason(agent('p', { state: 'waiting' })), 'waiting')
  assert.equal(stopReason(agent('p', { hasLivePty: false })), 'dead')
  assert.equal(stopReason(agent('p', { state: 'done', hasLivePty: false, mainAgent: { outcome: 'success' } })), undefined)
  assert.equal(stopReason(agent('p', { state: 'done', lastAssistantMessage: "You've hit your usage limit · resets 5pm" })), 'limit')
  assert.equal(stopReason(agent('p', { state: 'done', lastAssistantMessage: 'Invalid API key · Please run /login' })), 'auth')
  assert.equal(stopReason(agent('p', { state: 'done', mainAgent: { outcome: 'failure' } })), 'error')
  assert.equal(stopReason(agent('p', { state: 'done', interrupted: true })), 'interrupted')
  assert.equal(stopReason(agent('p', { state: 'done', lastAssistantMessage: 'rate limit の設計を直しました。'.padEnd(500, '。') })), undefined)
  assert.equal(stopReason(agent('p', { state: 'done' })), undefined)
})

test('.orca の外を指すファイルがあっても起動し、そのワークスペースのエラーに出す', async () => {
  const outside = workspace('outside2', { 'a.json': '{"items":[]}' })
  const a = workspace('a', { '.orca/cockpit.json': cockpit('案件A') })
  symlinkSync(path.join(outside, 'a.json'), path.join(a, '.orca/cockpit.archive.json'))
  const { s, port } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const v = await listen(port, s.token).until((w) => !!w.view.cockpit)
  assert.ok(v.view.errors.some((e) => /cockpit.archive.json を読めません.*\.orca の外は読みません/.test(e)))
})

test('パネルと窓（別のプロセス）が同時に追記しても、両方の操作が残る', async () => {
  const other = (await import(new URL('../src/store.ts?other-process', import.meta.url).href)) as typeof import('../src/store.ts')
  const mine = await import('../src/store.ts')
  const a = workspace('a', { '.orca/cockpit.json': cockpit('案件A') })
  const c = JSON.parse(cockpit('案件A'))
  const op = (item_id: string) => ({ root: a, item_id, item_rev: 1, type: 'ack' as const })
  await Promise.all([mine.appendOp(a, c, op('d1')), other.appendOp(a, c, op('a2')), mine.appendOp(a, c, op('d3')), other.appendOp(a, c, op('d2'))])
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { op_id: number }) => o.op_id).sort(), [1, 2, 3, 4])
  assert.deepEqual(log.ops.map((o: { item_id: string }) => o.item_id).sort(), ['a2', 'd1', 'd2', 'd3'])
})

test('窓でも、取り消しの猶予が過ぎた操作はメインが入力待ちなら自動で合図を送り、送った記録はパネルと共有する', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const a = workspace('a', {
    '.orca/cockpit.json': cockpit('案件A'),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 1, at: old, item_id: 'd1', item_rev: 1, type: 'ack' }] })
  })
  const rows: PsRow[] = [{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main', { state: 'done' })] }]
  const { s, port, calls, dir } = await start(rows, a)
  const v = await listen(port, s.token).until((w) => w.view.notifiedOp === 1)
  assert.equal(v.view.signal, undefined)
  assert.deepEqual(calls, [['send', 'term_main', SIGNAL]])
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'notified.json'), 'utf8')), { [a]: 1 })
})

test('worker は操縦席の task に記録された worktree id で task に結び、仕事の名前は task の名前にする', async () => {
  const { a, child, rows } = twoWorkspaces()
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  c.tasks.find((t: { id: string }) => t.id === 't2').worker = { worktree_id: 'r::a-w1' }
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  rows.find((r) => r.path === child)!.displayName = 'notify｜表示名から推した名前'
  const { s, port } = await start(rows, a)
  const v = await listen(port, s.token).until((w) => w.view.workers.length === 1 && w.rows.length === 3)
  assert.deepEqual(v.view.workers.map((w) => [w.task, w.job]), [['t2', '通知の設計']])

  delete c.tasks.find((t: { id: string }) => t.id === 't2').worker
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  const v2 = await listen(port, s.token).until((w) => w.view.workers[0]?.task === undefined && w.view.workers.length === 1)
  assert.equal(v2.view.workers[0]!.job, '表示名から推した名前', '記録が無ければ今までどおり表示名から')
})

test('同じ worktree に複数のタスクがあれば、端末の記録 → 済んでいないタスク → 最後のタスクの順で結ぶ。生きている worktree を view に渡す', async () => {
  const { a, rows } = twoWorkspaces()
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  const task = (id: string) => c.tasks.find((t: { id: string }) => t.id === id)
  // t8（済み）が先に並び、t2（進行中）が後ろ。済んだ t8 に結ぶと、進行中の t2 が「動いていない」と出る（2026-11-16 の t1 と t25）
  task('t8').worker = { worktree_id: 'r::a-w1' }
  task('t2').worker = { worktree_id: 'r::a-w1' }
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  const { s, port } = await start(rows, a)
  const v = await listen(port, s.token).until((w) => w.view.workers.length === 1 && w.rows.length === 3)
  assert.deepEqual(v.view.workers.map((w) => w.task), ['t2'])
  assert.deepEqual(v.view.worktrees, ['r::a', 'r::a-w1'])

  task('t8').worker = { worktree_id: 'r::a-w1', terminal: 'term_w1' }
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  assert.deepEqual((await listen(port, s.token).until((w) => w.view.workers[0]?.task === 't8')).view.workers.map((w) => w.task), ['t8'], '端末の記録が先')
})

test('開けるのは本線と本線の子の worktree の中のファイルだけ。日本語の名前と path:行 も開く', async () => {
  const { a, child, rows } = twoWorkspaces()
  writeFileSync(path.join(a, '一覧画面.md'), 'x')
  writeFileSync(path.join(child, 'out.md'), 'x')
  const other = rows.find((r) => r.worktreeId === 'r::c-w1')!.path
  writeFileSync(path.join(other, 'secret.md'), 'x')
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  assert.deepEqual((await post('open', { root: a, path: '一覧画面.md:12' })).body, { opened: true })
  assert.deepEqual((await post('open', { root: a, path: path.join(child, 'out.md') })).body, { opened: true })
  assert.deepEqual((await post('open', { root: a, path: path.join(other, 'secret.md') })).body, { opened: false }, '別の本線の子は開かない')
  assert.deepEqual((await post('open', { root: a, path: 'nope.md' })).body, { opened: false })
  const real = (p: string) => realpathSync(p)
  assert.deepEqual(calls.filter((c) => c[0] === 'open'), [
    ['open', a, real(path.join(a, '一覧画面.md')), '12'],
    ['open', child, real(path.join(child, 'out.md'))]
  ])
})

test('URL は http と https だけを既定のブラウザで開く', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  assert.deepEqual((await post('openurl', { url: 'https://docs.google.com/document/d/x/edit' })).body, { opened: true })
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/a', 'not a url'])
    assert.equal((await post('openurl', { url })).body.opened, false, url)
  assert.equal((await post('openurl', { url: 'https://x.example' }, { 'x-cockpit-token': 'wrong' })).status, 403)
  assert.deepEqual(calls.filter((c) => c[0] === 'url'), [['url', 'https://docs.google.com/document/d/x/edit']])
})

test('見ての「これでよい」は accept として追記する', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  assert.equal((await post('op', { root: a, item_id: 'v1', item_rev: 2, type: 'accept' })).status, 200)
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { type: string; item_id: string }) => [o.type, o.item_id]), [['accept', 'v1']])
})

test('4000 字を超える文は切り詰めずに断り、ちょうど 4000 字は通す', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  const r = await post('op', { root: a, item_id: 'd5', item_rev: 1, type: 'decide', option_id: 'other', text: 'あ'.repeat(4000) + 'ただし、まだ送信しない' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /4000 字までです（今 4011 字）/)
  assert.equal((await post('op', { root: a, item_id: 'd5', item_rev: 1, type: 'decide', option_id: 'other', text: 'あ'.repeat(4000) })).status, 200)
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.equal(log.ops.length, 1)
  assert.equal(log.ops[0].text.length, 4000)
})

test('別の答えは decide・other・text として追記し、text の無いものは断る', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  assert.equal((await post('op', { root: a, item_id: 'v1', item_rev: 2, type: 'decide', option_id: 'other' })).status, 400)
  assert.equal((await post('op', { root: a, item_id: 'v1', item_rev: 2, type: 'decide', option_id: 'other', text: '先に通知の下書きを見たい' })).status, 200)
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { type: string; option_id?: string; text?: string }) => [o.type, o.option_id, o.text]), [['decide', 'other', '先に通知の下書きを見たい']])
})

test('「情報が足りない」は need_context として、知りたいことがあれば text と一緒に追記する', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  assert.equal((await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'need_context' })).status, 200)
  assert.equal((await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'need_context', text: '既存の 18 社はどうなる？' })).status, 200)
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { type: string; text?: string }) => [o.type, o.text]), [['need_context', undefined], ['need_context', '既存の 18 社はどうなる？']])
})

test('「前にも言った」は項目を持たない repeat として追記し、ほかの種類の空の項目は断る', async () => {
  const { a, rows } = twoWorkspaces()
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until((w) => w.rows.length === 3)
  assert.equal((await post('op', { root: a, item_id: '', item_rev: 0, type: 'repeat' })).status, 200)
  assert.notEqual((await post('op', { root: a, item_id: '', item_rev: 0, type: 'ack' })).status, 200)
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { type: string; item_id: string }) => [o.type, o.item_id]), [['repeat', '']])
})

test('話したいには、項目と関係するタスクとやり取りを渡してアシスタントが答え、cockpit.talk.json に追記する', async () => {
  const { a, rows } = twoWorkspaces()
  const prompts: { prompt: string; cwd: string }[] = []
  const ask: Ask = async (prompt, cwd) => {
    prompts.push({ prompt, cwd })
    return prompts.length === 1 ? '件数で均等に割るので偏りません。' : '変えるにはメインの判断が要ります。\n[メインに渡す]'
  }
  const { s, port, post } = await start(rows, a, ask)
  const sse = listen(port, s.token)
  await sse.until((w) => w.rows.length === 3)
  await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'talk', text: '自動だと偏らない？' })
  const v = await sse.until((w) => w.view.replies.length === 1)
  assert.deepEqual(v.view.replies.map((r) => [r.op_id, r.by, r.text, r.handoff]), [[1, 'assistant', '件数で均等に割るので偏りません。', undefined]])
  assert.equal(prompts[0]!.cwd, a)
  assert.match(prompts[0]!.prompt, /担当者の割り当て方を決める[^]*一覧画面の設計[^]*利用者（[^）]+）: 自動だと偏らない？/)
  assert.doesNotMatch(prompts[0]!.prompt, /<svg/, '図の中身は渡さない')

  await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'talk', text: '手で取る案に変えて' })
  const v2 = await sse.until((w) => w.view.replies.length === 2)
  assert.deepEqual(v2.view.replies.at(-1), { ...v2.view.replies.at(-1)!, text: '変えるにはメインの判断が要ります。', handoff: true })
  assert.match(prompts[1]!.prompt, /アシスタント: 件数で均等に割るので偏りません。\n利用者（[^）]+）: 手で取る案に変えて/)
  const saved = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.talk.json'), 'utf8'))
  assert.equal(saved.replies.length, 2)

  assert.equal((await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'talk', to_main: true })).status, 400, '引き継ぐ元の無い本文なしは断る')
  assert.equal((await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'talk', to_main: true, handoff_of: 99 })).status, 400)
  assert.equal((await post('op', { root: a, item_id: 'd1', item_rev: 1, type: 'talk', to_main: true, handoff_of: 2 })).status, 200)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(prompts.length, 2, 'メインに渡す操作には答えない')
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.at(-1), { ...log.ops.at(-1), type: 'talk', to_main: true, handoff_of: 2, text: '手で取る案に変えて' }, '元の発言を写して記録する')
})

test('アシスタントが失敗したら「回答できませんでした」を残し、同じ発言に何度も答えに行かない。パネルが書いた発言も拾う', async () => {
  const { a, rows } = twoWorkspaces()
  let calls = 0
  const ask: Ask = async () => {
    calls++
    throw new Error('Not logged in')
  }
  const { s, port } = await start(rows, a, ask)
  const sse = listen(port, s.token)
  await sse.until((w) => w.rows.length === 3)
  // パネル（別のプロセス）が書いた発言。ファイルの変更で拾う。
  writeFileSync(path.join(a, '.orca/cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 1, at: new Date().toISOString(), item_id: 'd1', item_rev: 1, type: 'talk', text: 'パネルから' }] }))
  const v = await sse.until((w) => w.view.replies.length === 1)
  assert.deepEqual(v.view.replies.map((r) => [r.text, r.failed]), [['回答できませんでした。メインが次に読みます', true]])
  writeFileSync(path.join(a, '.orca/x.txt'), 'touch')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(calls, 1)
})
