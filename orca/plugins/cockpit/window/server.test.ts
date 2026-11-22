import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { writeSample } from '../fixtures/demo.ts'
import { FAKE_LINT, OLD_M1 } from '../fixtures/drafts.ts'
import { sample } from '../fixtures/sample.ts'
import { draftLinter } from '../src/lint.ts'
import { boardsOf, keyOf, newUi, type Board } from '../src/view.ts'
import { renderWindow, todoGroups } from '../src/window-view.ts'
import type { AutomationRun, OwnerLive, WindowView } from '../src/protocol.ts'
import { SIGNAL } from '../src/store.ts'
import { askCli, askNotice, askTitle, automationFact, createServer, orcaCli, parseTailnetHosts, stopReason, tabsOf, type AskCmd, type Consult, type Options, type Orca, type PluginRow, type PsAgent, type PsRow } from './server.ts'
import type { WorkerShow } from './orca-state.ts'

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p))

function workspace(name: string, files: Record<string, string> = {}): string {
  const root = tmp(`cockpit-${name}-`)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}
/** 見本の青葉物流（架空）を、名前とメインの端末を替えて使う。 */
const cockpit = (name: string, over: Record<string, unknown> = {}) => {
  const c = structuredClone(sample()[0]!.cockpit) as unknown as Record<string, unknown>
  ;(c.workspace as { name: string }).name = name
  c.main = { agent: 'claude', terminal: 'term_main', run_id: 'run_main' }
  return JSON.stringify({ ...c, ...over })
}
const agent = (paneKey: string, over: Partial<PsAgent> = {}): PsAgent => ({ paneKey, state: 'working', stateStartedAt: 1, hasLivePty: true, ...over })

function fakeOrca(rows: PsRow[], plugins: PluginRow[] = [{ pluginKey: 'local.cockpit', status: 'running', needsReconsent: false, isDev: false }], owners: OwnerLive[] = [], shows: Record<string, WorkerShow> = {}, showDelay = 0, extraTerms: string[] = []) {
  const calls: string[][] = []
  const showCalls: string[] = []
  const boxes: string[] = []
  const orca: Orca = {
    ps: async () => rows,
    terminals: async () => [
      ...boxes.map((h) => ({ handle: h, tabId: 't', leafId: h })),
      { handle: 'term_main', tabId: 't', leafId: 'main' },
      { handle: 'term_w1', tabId: 't', leafId: 'w1' },
      { handle: 'term_aoba_w1', tabId: 't', leafId: 'aw1' },
      ...extraTerms.map((h) => ({ handle: h, tabId: 't', leafId: h }))
    ],
    plugins: async () => plugins,
    agents: async () => owners,
    show: async (dispatch) => {
      showCalls.push(dispatch)
      if (showDelay) await new Promise((r) => setTimeout(r, showDelay))
      return shows[dispatch] ?? null
    },
    send: async (t, text) => void calls.push(['send', t, text]),
    notifyRun: async (from, id, subject, body) => void calls.push(['run', from, id, subject, body]),
    mailbox: async (root) => {
      boxes.push(`term_box${boxes.length + 1}`)
      calls.push(['mailbox', root])
      return boxes.at(-1)!
    },
    activate: async (root) => void calls.push(['activate', root]),
    switchTerminal: async (t) => void calls.push(['switch', t]),
    closeTerminal: async (t) => void calls.push(['close', t]),
    openFile: async (root, abs, line) => void calls.push(line ? ['open', root, abs, String(line)] : ['open', root, abs]),
    openUrl: async (url) => void calls.push(['url', url]),
    runTasks: async () => [],
    taskLink: async () => ({ dispatch: null, followUpOf: null })
  }
  return { orca, calls, showCalls }
}

const servers: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function start(rows: PsRow[], focusPath?: string, plugins?: PluginRow[], owners?: OwnerLive[], shows?: Record<string, WorkerShow>, showDelay?: number, more: { consult?: Consult; terms?: string[]; ask?: AskCmd; tabs?: Orca['tabs']; chatOpen?: Orca['chatOpen']; chatLast?: Orca['chatLast']; notifyRun?: Orca['notifyRun']; mailbox?: Orca['mailbox']; mailboxFile?: string; tailnetHosts?: string[]; lint?: Options['lint'] } = {}) {
  const dir = tmp('cockpit-dir-')
  const setFocus = (p: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ path: p, at: new Date().toISOString(), ...extra }))
  if (focusPath) setFocus(focusPath)
  const fake = fakeOrca(rows, plugins, owners, shows, showDelay, more.terms)
  if (more.tabs) fake.orca.tabs = more.tabs
  if (more.chatOpen) fake.orca.chatOpen = more.chatOpen
  if (more.chatLast) fake.orca.chatLast = more.chatLast
  if (more.notifyRun) fake.orca.notifyRun = more.notifyRun
  if (more.mailbox) fake.orca.mailbox = more.mailbox
  if (more.mailboxFile) writeFileSync(path.join(dir, 'mailbox.json'), more.mailboxFile)
  const s = createServer({ port: 0, dir, orca: fake.orca, consult: more.consult, ask: more.ask, tailnetHosts: more.tailnetHosts, lint: more.lint })
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
  return { s, port, origin, post, setFocus, dir, orca: fake.orca, calls: fake.calls, showCalls: fake.showCalls }
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
  // 上限は回数でなく時刻で持ち、広く取る。待つ条件は出来事なので、通る回は速さが変わらず、重い機械（ほかの試験と同時）でだけ長く待つ（追加 43）。
  const until = async (ok: (v: WindowView) => boolean): Promise<WindowView> => {
    for (const end = Date.now() + 20_000; Date.now() < end; ) {
      const v = got.findLast(ok)
      if (v) return v
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`届きませんでした: ${JSON.stringify(got.at(-1)?.boards.map((b) => b.root))}`)
  }
  return { got, until }
}
const board = (v: WindowView, root: string) => v.boards.find((b) => b.root === root)

/** 操縦席のある本線 3 つ（a に worker の子）、操縦席の無い本線 1 つ。 */
function workspaces() {
  const a = workspace('a', { '.orca/cockpit.json': cockpit('案件A') })
  const b = workspace('b', { '.orca/cockpit.json': cockpit('案件B', { cards: [] }) })
  const c = workspace('c', { '.orca/cockpit.json': cockpit('案件C', { cards: [] }) })
  const bare = workspace('bare')
  const child = workspace('a-w1')
  const rows: PsRow[] = [
    { worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main')] },
    { worktreeId: 'r::b', path: b, parentWorktreeId: null, agents: [] },
    { worktreeId: 'r::c', path: c, parentWorktreeId: null, agents: [agent('t:c')] },
    { worktreeId: 'r::c-w1', path: workspace('c-w1'), parentWorktreeId: 'r::c', agents: [agent('t:c1', { hasLivePty: false })] },
    { worktreeId: 'r::a-w1', path: child, parentWorktreeId: 'r::a', agents: [agent('t:w1', { state: 'blocked', conversationName: 'w1' })] },
    { worktreeId: 'r::bare', path: bare, parentWorktreeId: null, displayName: '操縦席の無い案件', agents: [] }
  ]
  return { a, b, c, bare, child, rows }
}
const ready = (w: WindowView) => w.boards.length === 3

test('トークンが無い・Origin が違う・Host が違う書き込みを断る', async () => {
  const { a, rows } = workspaces()
  const { post, origin, port } = await start(rows, a)
  const op = { root: a, item_id: 'r5', item_rev: 1, type: 'accept' }
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

/** Host を指定して送る（fetch は Host を変えられない）。tailscale serve は元の Host のまま 127.0.0.1 に繋ぐ。 */
function viaHost(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        text += c
        // SSE は閉じないので、最初の 1 通で切る。
        if (res.headers['content-type']?.startsWith('text/event-stream') && text.includes('\n\n')) req.destroy(), resolve({ status: res.statusCode!, text })
      })
      res.on('end', () => resolve({ status: res.statusCode!, text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

test('tailnet のホスト名を渡さなければ、tailscale serve 経由の Host と Origin は今どおり断る', async () => {
  const { a, rows } = workspaces()
  const { s, port, post } = await start(rows, a)
  const ts = 'mac.tail1234.ts.net'
  assert.equal((await viaHost(port, 'GET', '/', { host: ts })).status, 403)
  assert.equal((await viaHost(port, 'GET', `/events?token=${s.token}`, { host: ts })).status, 403)
  assert.equal((await viaHost(port, 'POST', '/api/op', { host: ts, origin: `https://${ts}`, 'x-cockpit-token': s.token }, { root: a, item_id: 'r5', item_rev: 1, type: 'accept' })).status, 403)
  assert.equal((await post('op', { root: a, item_id: 'r5', item_rev: 1, type: 'accept' }, { origin: `https://${ts}` })).status, 403)
  assert.throws(() => readFileSync(path.join(a, '.orca/cockpit.user.json')))
})

test('渡した tailnet のホスト名は、https の Origin とトークンが合えば読み込みと操作を通し、ほかは断る', async () => {
  const { a, rows } = workspaces()
  const ts = 'mac.tail1234.ts.net'
  const { s, port, post } = await start(rows, a, undefined, undefined, undefined, undefined, { tailnetHosts: [ts] })
  const op = { root: a, item_id: 'r5', item_rev: 1, type: 'accept' }
  const page = await viaHost(port, 'GET', '/', { host: ts })
  assert.equal(page.status, 200)
  assert.match(page.text, new RegExp(`content="${s.token}"`))
  assert.equal((await viaHost(port, 'GET', '/window/page.ts', { host: ts })).status, 200)
  assert.equal((await viaHost(port, 'GET', `/events?token=${s.token}`, { host: ts })).status, 200)
  // 断るもの: 一覧に無い tailnet の名前・http の Origin・別の Origin・違うトークン・トークン無しの SSE
  assert.equal((await viaHost(port, 'GET', '/', { host: 'other.tail1234.ts.net' })).status, 403)
  assert.equal((await viaHost(port, 'POST', '/api/op', { host: 'other.tail1234.ts.net', origin: 'https://other.tail1234.ts.net', 'x-cockpit-token': s.token }, op)).status, 403)
  assert.equal((await viaHost(port, 'POST', '/api/op', { host: ts, origin: `http://${ts}`, 'x-cockpit-token': s.token }, op)).status, 403)
  assert.equal((await viaHost(port, 'POST', '/api/op', { host: ts, origin: 'https://evil.example', 'x-cockpit-token': s.token }, op)).status, 403)
  assert.equal((await viaHost(port, 'POST', '/api/op', { host: ts, origin: `https://${ts}`, 'x-cockpit-token': 'x' }, op)).status, 403)
  assert.equal((await viaHost(port, 'GET', '/events?token=bad', { host: ts })).status, 403)
  assert.throws(() => readFileSync(path.join(a, '.orca/cockpit.user.json')))
  const ok = await viaHost(port, 'POST', '/api/op', { host: ts, origin: `https://${ts}`, 'x-cockpit-token': s.token }, op)
  assert.equal(ok.status, 200, ok.text)
  assert.equal(JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8')).ops.at(-1).type, 'accept')
})

test('COCKPIT_TAILNET_HOSTS はホスト名[:ポート] だけを読み、空なら何も許さない', () => {
  assert.deepEqual(parseTailnetHosts(undefined), [])
  assert.deepEqual(parseTailnetHosts(''), [])
  assert.deepEqual(parseTailnetHosts(' Mac.Tail1234.ts.net. , mac.tail1234.ts.net:8443 '), ['mac.tail1234.ts.net', 'mac.tail1234.ts.net:8443'])
  assert.deepEqual(parseTailnetHosts('mac.tail1234.ts.net:443,mac.tail1234.ts.net.:443'), ['mac.tail1234.ts.net', 'mac.tail1234.ts.net'])
  assert.deepEqual(parseTailnetHosts('*.ts.net,https://mac.tail1234.ts.net,mac,a b.ts.net,mac.tail1234.ts.net:8443:443'), [])
})

test('ページだけにトークンを埋め、TS は型を除いて配る。一覧に無いファイルは配らない', async () => {
  const { s, origin } = await start([])
  assert.match(await (await fetch(origin)).text(), new RegExp(`content="${s.token}"`))
  const js = await fetch(`${origin}/src/view.ts`)
  assert.match(js.headers.get('content-type') ?? '', /javascript/)
  assert.doesNotMatch(await js.text(), /: Ui\b/)
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

test('全案件の操縦席を送る。操縦席の無い本線は「見ていない」、前面が worker なら親を Orca で表示中にする', async () => {
  const { a, b, c, bare, child, rows } = workspaces()
  const { s, port } = await start(rows, child)
  const v = await listen(port, s.token).until(ready)
  assert.deepEqual(v.boards.map((x) => x.root).sort(), [a, b, c].sort())
  assert.deepEqual(v.unseen, [{ name: '操縦席の無い案件', path: bare }])
  assert.equal(v.focused, a)
  assert.deepEqual(board(v, a)!.workers.map((w) => [w.terminalId, w.stop]), [['term_w1', 'blocked']])
  assert.equal(v.live, 3)
})

test('送る量を絞る: 14 日より前に片付いたカードと、タスクの済んだ作業の記録は送らない', async () => {
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
  const c = JSON.parse(cockpit('案件A'))
  c.cards.push({ id: 'old', rev: 1, kind: 'decide', title: '昔の判断', state: 'done', resolved_at: old })
  // 依頼の証拠の「これでよい」が指すカードは古くても送る（窓の済の判定が版を見るため。Codex 中 7）。
  c.cards.push({ id: 'proof', rev: 1, kind: 'review', title: '昔の見て', state: 'done', resolved_at: old })
  c.cards.push({ id: 'linked', rev: 1, kind: 'decide', title: '昔の決める', state: 'done', resolved_at: old, request_id: 'q2' })
  c.requests = [{ id: 'q1', at: old, title: '依頼', evidence: [{ when: 1, kind: 'op', ref: '1', card: 'proof' }] }, { id: 'q2', at: old, title: '依頼 2' }]
  c.tasks[0].done = ['長い作業の記録']
  const a = workspace('a', { '.orca/cockpit.json': JSON.stringify(c) })
  const { s, port } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const v = await listen(port, s.token).until((w) => !!board(w, a)?.cockpit)
  const got = board(v, a)!.cockpit!
  assert.ok(!got.cards.some((x) => x.id === 'old'))
  assert.ok(got.cards.some((x) => x.id === 'proof'))
  assert.ok(got.cards.some((x) => x.id === 'linked'), '依頼に結ばれたカードも送る（依頼の今の判定が読む）')
  assert.ok(got.cards.some((x) => x.id === 'd19'))
  assert.equal(got.tasks[0]!.done, undefined)
})

test('.orca の外へ出るパスとシンボリックリンクは読まず、開かない', async () => {
  const outside = workspace('outside', { 'secret.svg': '<svg>secret</svg>' })
  const c = JSON.parse(cockpit('案件A'))
  c.cards[0].figure = '.orca/cockpit/figures/leak.svg'
  const a = workspace('a', { '.orca/cockpit.json': JSON.stringify(c), 'docs/x.md': 'x' })
  mkdirSync(path.join(a, '.orca/cockpit/figures'), { recursive: true })
  symlinkSync(path.join(outside, 'secret.svg'), path.join(a, '.orca/cockpit/figures/leak.svg'))
  const { s, port, post, calls } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const v = await listen(port, s.token).until((w) => !!board(w, a)?.cockpit)
  assert.equal(board(v, a)!.figures['.orca/cockpit/figures/leak.svg'], undefined)
  assert.ok(board(v, a)!.errors.some((e) => /\.orca の外は読みません/.test(e)))
  assert.equal((await post('open', { root: a, path: '../outside/secret.svg' })).body.opened, false)
  assert.equal((await post('open', { root: a, path: '/etc/passwd' })).body.opened, false)
  assert.deepEqual((await post('open', { root: outside, path: 'secret.svg' })).status, 409)
  assert.deepEqual((await post('open', { root: a, path: 'docs/x.md' })).body, { opened: true })
  assert.equal(calls.filter((x) => x[0] === 'open').length, 1)
})

test('操縦席のプラグインが承認待ちなら、Orca に合わせた切り替えが止まっていることを上の帯に出す', async () => {
  const { a, rows } = workspaces()
  const { s, port } = await start(rows, a, [{ pluginKey: 'local.cockpit', status: 'pending', needsReconsent: true }])
  const v = await listen(port, s.token).until((w) => w.errors.length > 0)
  assert.deepEqual(v.errors, ['Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています'])
})

test('ファイルの変更と前面の切り替えが SSE で届く', async () => {
  const { a, b, rows } = workspaces()
  const { s, port, setFocus } = await start(rows, a)
  const sse = listen(port, s.token)
  await sse.until(ready)
  writeFileSync(path.join(a, '.orca/cockpit.json'), cockpit('書き換えた'))
  await sse.until((w) => board(w, a)?.cockpit?.workspace.name === '書き換えた')
  setFocus(b)
  await sse.until((w) => w.focused === b)
})

test('操作は共有の関数で cockpit.user.json に追記し、押した瞬間にはメインに送らない。知らないカード・別の本線・古い版は断る', async () => {
  const { a, rows } = workspaces()
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until(ready)
  assert.equal((await post('op', { root: a, item_id: 'r5', item_rev: 1, type: 'accept' })).status, 200)
  assert.deepEqual(calls, [])
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { op_id: number; type: string }) => [o.op_id, o.type]), [[1, 'accept']])
  assert.equal((await post('op', { root: a, item_id: 'nope', item_rev: 1, type: 'accept' })).status, 400)
  assert.equal((await post('op', { root: a, item_id: 'r5', item_rev: 1, type: 'need_context' })).status, 400, '版 1 の操作は受けない')
  assert.equal((await post('op', { root: '/elsewhere', item_id: 'r5', item_rev: 1, type: 'accept' })).status, 409)
  assert.equal((await post('op', { root: a, item_id: 'd22', item_rev: 1, type: 'sent' })).status, 409)
})

test('担当と話す: 話し中の操作を 1 度だけ記録し、担当の端末・チャットのワークスペース・窓口の端末を前に出す', async () => {
  const { a, child, rows } = workspaces()
  const owners: OwnerLive[] = [{ session: 'sess-aws', kind: 'chat', state: 'working', worktree: child }]
  const { s, port, post, calls } = await start(rows, a, undefined, owners)
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('talk', { root: a, item_id: 'r5', item_rev: 1 })).body, { opened: true, how: '配車画面の改修の端末' })
  assert.deepEqual((await post('talk', { root: a, item_id: 'r5', item_rev: 1 })).body.opened, true)
  assert.deepEqual((await post('talk', { root: a, item_id: 'd21', item_rev: 1 })).body, { opened: true, how: `ワークスペース「${path.basename(child)}」`, tab: 'AWS 構成案（担当）' })
  assert.deepEqual((await post('talk', { root: a, item_id: 'd22', item_rev: 2 })).body, { opened: true, how: '窓口の端末' })
  assert.deepEqual(calls.filter((x) => x[0] !== 'send'), [['switch', 'term_aoba_w1'], ['switch', 'term_aoba_w1'], ['activate', child], ['switch', 'term_main']])
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { item_id: string; type: string }) => `${o.item_id}:${o.type}`), ['r5:talk', 'd21:talk', 'd22:talk'])
  assert.equal((await post('talk', { root: a, item_id: 'nope' })).status, 409)
})

/** consult --card の代わり。立てたタブを Orca の端末の一覧に足し、呼ばれた (root, カード) を残す。fail なら理由で落ちる。 */
function fakeConsult(terms: string[], fail?: string) {
  const asked: string[][] = []
  const consult: Consult = async (root, card) => {
    asked.push([root, card])
    if (fail) throw new Error(fail)
    if (!terms.includes('term_consult')) terms.push('term_consult')
    return 'term_consult'
  }
  return { consult, asked }
}
const talkOps = (root: string) => JSON.parse(readFileSync(path.join(root, '.orca/cockpit.user.json'), 'utf8')).ops.map((o: { item_id: string; type: string; terminal?: string }) => [o.item_id, o.type, o.terminal ?? null])

test('担当と協議: 担当のいないカードはカードの相談のタブを立て、タブの handle を話し中の記録に残す。2 回目は consult が前に出すだけで記録を重ねない', async () => {
  const { a, rows } = workspaces()
  const terms: string[] = []
  const { consult, asked } = fakeConsult(terms)
  const { s, port, post, calls } = await start(rows, a, undefined, undefined, undefined, undefined, { consult, terms })
  const ev = listen(port, s.token)
  await ev.until(ready)
  assert.deepEqual((await post('talk', { root: a, item_id: 'd22', item_rev: 2 })).body, { opened: true, how: '相談のタブ' })
  assert.deepEqual((await post('talk', { root: a, item_id: 'd22', item_rev: 2 })).body, { opened: true, how: '相談のタブ' })
  // 連打（同じ読み直しを待つ 2 つの要求）でも、同じタブの記録は 1 つ（Codex 重大 1）。
  await Promise.all([post('talk', { root: a, item_id: 'd22', item_rev: 2 }), post('talk', { root: a, item_id: 'd22', item_rev: 2 })])
  assert.deepEqual(asked.length, 4)
  assert.deepEqual(calls.filter((x) => x[0] === 'switch' || x[0] === 'activate'), [], 'タブは consult が前に出す')
  assert.deepEqual(talkOps(a), [['d22', 'talk', 'term_consult']])
  const w = await ev.until((v) => !!board(v, a)?.terminals?.includes('term_consult'))
  assert.equal(board(w, a)?.terminals?.includes('term_main'), true)
  // 担当のいるカードと、全体のタブの仕事の協議（カードの無い talk）は相談にしない。
  assert.equal((await post('talk', { root: a, item_id: 'r5', item_rev: 1 })).body.how, '配車画面の改修の端末')
  assert.equal((await post('talk', { root: a, stream: 's4' })).body.how, '窓口の端末')
  assert.deepEqual(asked.length, 4)
})

test('担当と協議: consult がチャットで相談を立てたら（handle が orca_session_id:…）、チャットが開いているあいだ話し中を保つ（追加 30）', async () => {
  const { a, rows } = workspaces()
  const consult: Consult = async () => 'orca_session_id:c22'
  const { s, port, post } = await start(rows, a, undefined, undefined, undefined, undefined, { consult, chatOpen: async (h) => h === 'orca_session_id:c22' })
  const ev = listen(port, s.token)
  await ev.until(ready)
  assert.deepEqual((await post('talk', { root: a, item_id: 'd22', item_rev: 2 })).body, { opened: true, how: '相談のタブ' })
  assert.deepEqual(talkOps(a), [['d22', 'talk', 'orca_session_id:c22']])
  const w = await ev.until((v) => !!board(v, a)?.terminals?.includes('orca_session_id:c22'))
  assert.equal(board(w, a)?.terminals?.includes('term_main'), true, '端末の handle は今どおり')
})

test('一緒に作る仕事の担当がターンを終えたら、最後の返事を読んで担当の様子に載せる。ほかの担当と作業中の担当は読まない（追加 27）', async () => {
  const sample0 = JSON.parse(cockpit('案件A')) as { streams: { id: string; form?: string }[] }
  sample0.streams.find((x) => x.id === 's2')!.form = 'cowork'
  const a = workspace('a', { '.orca/cockpit.json': JSON.stringify(sample0) })
  const rows: PsRow[] = [{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main')] }]
  const asked: string[] = []
  const owners: OwnerLive[] = [{ session: 'sess-aws', kind: 'chat', state: 'done', updatedAt: 5 }, { session: 'sess-other', kind: 'chat', state: 'done', updatedAt: 5 }]
  const { s, port } = await start(rows, a, undefined, owners, undefined, undefined, { chatLast: async (h) => (asked.push(h), '下書きです。\n\n入口も描きますか？') })
  const w = await listen(port, s.token).until((v) => !!board(v, a)?.owners?.some((o) => o.last))
  assert.deepEqual(board(w, a)?.owners?.map((o) => [o.session, o.last]), [['sess-aws', '下書きです。\n\n入口も描きますか？'], ['sess-other', undefined]])
  assert.deepEqual([...new Set(asked)], ['orca_session_id:sess-aws'])
})

test('担当と協議: 最初の連打でも記録は 1 つ。相談に回すときも、consult が失敗して窓口に回すときも（Codex 2 回目 中 1・2）', async () => {
  for (const fail of [undefined, 'consult: 失敗']) {
    const { a, rows } = workspaces()
    const terms: string[] = []
    const { consult } = fakeConsult(terms, fail)
    const { s, port, post } = await start(rows, a, undefined, undefined, undefined, undefined, { consult, terms })
    await listen(port, s.token).until(ready)
    await Promise.all([post('talk', { root: a, item_id: 'd22', item_rev: 2 }), post('talk', { root: a, item_id: 'd22', item_rev: 2 }), post('talk', { root: a, item_id: 'd22', item_rev: 2 })])
    assert.deepEqual(talkOps(a), [['d22', 'talk', fail ? null : 'term_consult']])
  }
})

test('担当と協議: consult が失敗したら理由を返して窓口に回し、handle の無い話し中として記録する', async () => {
  const { a, rows } = workspaces()
  const { consult, asked } = fakeConsult([], 'consult: 操縦席が見つからない')
  const { s, port, post, calls } = await start(rows, a, undefined, undefined, undefined, undefined, { consult })
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('talk', { root: a, item_id: 'd22', item_rev: 2 })).body, { opened: true, how: '窓口の端末', note: '相談のタブを開けませんでした（consult: 操縦席が見つからない）' })
  assert.deepEqual(asked, [[a, 'd22']])
  assert.deepEqual(calls.filter((x) => x[0] === 'switch'), [['switch', 'term_main']])
  assert.deepEqual(talkOps(a), [['d22', 'talk', null]])
})

test('担当と協議: 相談のタブは報告のカードでも handle を残す。consult の間に版が変わったら窓口に回さず、記録できなかった理由だけ返す（Codex 重大 2・3）', async () => {
  const { a, rows } = workspaces()
  const file = path.join(a, '.orca/cockpit.json')
  const c = JSON.parse(readFileSync(file, 'utf8'))
  c.cards.push({ id: 'a9', rev: 1, kind: 'report', state: 'open', title: '議事録の置き場所を変えた', stream: 's4', done: [{ what: '置き場所を変えた' }] })
  writeFileSync(file, JSON.stringify(c))
  const terms: string[] = []
  const base = fakeConsult(terms)
  let bump = false
  const consult: Consult = async (root, card) => {
    const h = await base.consult(root, card)
    if (bump) {
      const now = JSON.parse(readFileSync(file, 'utf8'))
      now.cards.find((x: { id: string }) => x.id === 'd22').rev = 3
      writeFileSync(file, JSON.stringify(now))
    }
    return h
  }
  const { s, port, post, calls } = await start(rows, a, undefined, undefined, undefined, undefined, { consult, terms })
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('talk', { root: a, item_id: 'a9', item_rev: 1 })).body, { opened: true, how: '相談のタブ' })
  assert.deepEqual(talkOps(a), [['a9', 'talk', 'term_consult']])
  bump = true
  const r = (await post('talk', { root: a, item_id: 'd22', item_rev: 2 })).body
  assert.equal(r.opened, true)
  assert.equal(r.how, '相談のタブ')
  assert.match(r.reason, /書き換えました/)
  assert.equal(r.terminal, 'term_consult', '記録できなかったタブも呼び出し元が特定できる')
  assert.deepEqual(calls.filter((x) => x[0] === 'switch' || x[0] === 'activate'), [], '窓口に回さない')
  assert.deepEqual(talkOps(a), [['a9', 'talk', 'term_consult']])
})

test('相談のメモは送るカードのものだけを、表示に使う欄に絞って窓に送る（Codex 中 5）', async () => {
  const { a, rows } = workspaces()
  const block = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```\n'
  mkdirSync(path.join(a, '.orca/consult'), { recursive: true })
  writeFileSync(path.join(a, '.orca/consult/d22.md'), '## 窓口に返したもの\n' + block({ return_id: 'd22-1', choice: 'send', decisions: [{ text: '送る', quote: '長い原文'.repeat(50) }], open: ['x'], note: 'y'.repeat(5000) }))
  writeFileSync(path.join(a, '.orca/consult/gone.md'), '## 窓口に返したもの\n' + block({ return_id: 'gone-1' }))
  const { s, port } = await start(rows, a)
  const w = await listen(port, s.token).until((v) => ready(v) && !!board(v, a)?.consults)
  assert.deepEqual(board(w, a)!.consults, [{ card: 'd22', path: path.join(a, '.orca/consult/d22.md'), returns: [{ return_id: 'd22-1', choice: 'send', decisions: [{ text: '送る' }] }] }])
})

/**
 * consult --ask の代わり。控えの頭を書き（consult と同じ形）、呼ばれた (id・結び先・質問) を残す。fail なら理由で落ちる。
 * 立てるのに wait ミリ秒かかる（同時の 2 問が同じ id を採らないことを見る）。
 */
function fakeAsk(fail?: string, wait = 0) {
  const asked: [string, string, string | undefined, string | undefined, string | undefined][] = []
  const ask: AskCmd = async (root, id, o) => {
    asked.push([path.basename(root), id, o.card, o.task, o.question])
    await new Promise((r) => setTimeout(r, wait))
    if (fail) throw new Error(fail)
    const memo = path.join(root, '.orca/consult', `ask-${id}.md`)
    mkdirSync(path.dirname(memo), { recursive: true })
    try {
      readFileSync(memo)
    } catch {
      writeFileSync(memo, `# ${askTitle('案件A', id)}\n${o.card ? `- カード: ${o.card}\n` : ''}${o.task ? `- タスク: ${o.task}\n` : ''}- 写した窓口の会話: s1（窓口の会話 09:05 時点）\n\n`)
    }
    return `term_${id}`
  }
  return { ask, asked }
}

test('窓から質問する: 新しい質問は質問 id を 1 つずつ採って consult --ask に結び先と質問を渡し、続きは同じ id で送る。知らない質問・空の質問・知らない結び先は断る', async () => {
  const { a, rows } = workspaces()
  const { ask, asked } = fakeAsk(undefined, 30)
  const { s, port, post } = await start(rows, a, undefined, undefined, undefined, undefined, { ask })
  const ev = listen(port, s.token)
  await ev.until(ready)
  // 同時に押した 2 問は別の id になる（consult が控えを書くまで次の id を採らない）。
  const [one, two] = await Promise.all([post('ask', { root: a, question: '入口は 1 つ？', card: 'd21' }), post('ask', { root: a, question: '全体の質問', task: 't1' })])
  assert.deepEqual([one.body, two.body], [{ opened: true, ask: 'ask1' }, { opened: true, ask: 'ask2' }])
  assert.deepEqual(asked, [[path.basename(a), 'ask1', 'd21', undefined, '入口は 1 つ？'], [path.basename(a), 'ask2', undefined, 't1', '全体の質問']])
  assert.deepEqual((await post('ask', { root: a, ask: 'ask1', question: '  続き  ', card: 'd22' })).body, { opened: true, ask: 'ask1' })
  assert.deepEqual(asked.at(-1), [path.basename(a), 'ask1', undefined, undefined, '続き'], '続きは結び先を変えない')
  assert.equal((await post('ask', { root: a, ask: 'ask9', question: 'x' })).status, 409)
  assert.equal((await post('ask', { root: a, question: '   ' })).status, 400)
  assert.equal((await post('ask', { root: a, question: 'x', card: 'zz' })).status, 409)
  // 控えの頭は送った直後の配信に載る（待つ表示を質問に結ぶ）。
  const w = await ev.until((v) => (board(v, a)?.asks ?? []).length === 2)
  assert.deepEqual(board(w, a)!.asks!.map((x) => [x.id, x.card, x.task, x.at, x.answers]), [['ask1', 'd21', undefined, '09:05', 0], ['ask2', undefined, 't1', '09:05', 0]])
})

test('窓から質問する: 同じ案件を開く 2 つの常駐のプロセスでも、新しい質問の id は重ならない（Codex 重大 4）', async () => {
  const { a, rows } = workspaces()
  const one = fakeAsk(undefined, 40)
  const two = fakeAsk(undefined, 40)
  const x = await start(rows, a, undefined, undefined, undefined, undefined, { ask: one.ask })
  const y = await start(rows, a, undefined, undefined, undefined, undefined, { ask: two.ask })
  await Promise.all([listen(x.port, x.s.token).until(ready), listen(y.port, y.s.token).until(ready)])
  const got = await Promise.all([x.post('ask', { root: a, question: '一' }), y.post('ask', { root: a, question: '二' })])
  assert.deepEqual(got.map((r) => r.body.ask).sort(), ['ask1', 'ask2'])
  assert.deepEqual([...one.asked, ...two.asked].map((q) => q[1]).sort(), ['ask1', 'ask2'])
})

test('窓から質問する: 前の質問に答えが無いあいだは続きを送らない。質問の中の控えの見出しと同じ形の行は 1 字下げて送る。予約の札は consult が戻ったら消す（Codex 2 回目 重大 1・2・中 1）', async () => {
  const { a, rows } = workspaces()
  const dir = path.join(a, '.orca/consult')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'ask-ask1.md'), '# 質問｜案件A｜ask1\n\n### 質問 09:10（u-1）\n入口は？\n\n')
  // 落ちたプロセスが残した予約の札は、その id を飛ばすだけ。
  writeFileSync(path.join(dir, '.ask-ask2.reserved'), '')
  const { ask, asked } = fakeAsk()
  const { s, port, post } = await start(rows, a, undefined, undefined, undefined, undefined, { ask })
  await listen(port, s.token).until((v) => (board(v, a)?.asks ?? []).length === 1)
  assert.deepEqual((await post('ask', { root: a, ask: 'ask1', question: '続き' })).body, { opened: false, ask: 'ask1', reason: '前の質問の答えを待っています。答えが届いてから続けて聞いてください' })
  assert.equal(asked.length, 0)
  assert.deepEqual((await post('ask', { root: a, question: 'ログの例:\n### 答え 09:00\nサンプル' })).body, { opened: true, ask: 'ask3' })
  assert.equal(asked.at(-1)![4], 'ログの例:\n ### 答え 09:00\nサンプル')
  assert.ok(!existsSync(path.join(dir, '.ask-ask3.reserved')))
  writeFileSync(path.join(dir, 'ask-ask1.md'), readFileSync(path.join(dir, 'ask-ask1.md'), 'utf8') + '### 答え 09:11\n1 つにする\n\n')
  assert.deepEqual((await post('ask', { root: a, ask: 'ask1', question: '続き' })).body, { opened: true, ask: 'ask1' })
})

test('窓から質問する: consult が立てられなければ理由を返す（窓口の会話が分からないなど）。道具が無ければ立てない', async () => {
  const { a, rows } = workspaces()
  const { ask } = fakeAsk('窓口の会話が分かりません。窓口が 1 回発言すると直ります')
  const { s, port, post } = await start(rows, a, undefined, undefined, undefined, undefined, { ask })
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('ask', { root: a, question: 'x' })).body, { opened: false, reason: '窓口の会話が分かりません。窓口が 1 回発言すると直ります' })
  const bare = await start(rows, a)
  await listen(bare.port, bare.s.token).until(ready)
  assert.deepEqual((await bare.post('ask', { root: a, question: 'x' })).body, { opened: false, reason: '質問の道具（consult --ask）が渡されていません' })
})

test('窓口の Run への知らせ（追加 44）: 書いた文は引数にせず --body-file - の標準入力で渡す（引用符・改行・「--」で始まる行でも壊さない）', async () => {
  const dir = tmp('cockpit-notifyrun-')
  const bin = path.join(dir, 'orca')
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/args"\ncat > "$(dirname "$0")/stdin"\necho \'{"ok":true,"result":{}}\'\n')
  chmodSync(bin, 0o755)
  const body = '青葉物流 の操縦席の窓から: 【操縦席】未反映の操作があります\n\n書いた文（全文）:\n"引用"\n--to run:other --body x'
  await orcaCli(bin).notifyRun!('term_box', 'run_1', '【操縦席】未反映の操作があります', body)
  assert.deepEqual(readFileSync(path.join(dir, 'args'), 'utf8').trimEnd().split('\n'), ['orchestration', 'send', '--from', 'term_box', '--to', 'run:run_1', '--type', 'status', '--subject', '【操縦席】未反映の操作があります', '--body-file', '-', '--json'])
  assert.equal(readFileSync(path.join(dir, 'stdin'), 'utf8'), body)
})

test('郵便受けの端末は、その worktree に題を付けて AI を動かさないコマンドで作り、handle を返す（追加 44 の補足）', async () => {
  const dir = tmp('cockpit-mailbox-')
  const bin = path.join(dir, 'orca')
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/args"\necho \'{"ok":true,"result":{"terminal":{"handle":"term_box9"}}}\'\n')
  chmodSync(bin, 0o755)
  assert.equal(await orcaCli(bin).mailbox!('/ws/a'), 'term_box9')
  assert.deepEqual(readFileSync(path.join(dir, 'args'), 'utf8').trimEnd().split('\n'), ['terminal', 'create', '--worktree', 'path:/ws/a', '--title', '操縦席｜郵便受け', '--command', 'tail -f /dev/null', '--json'])
})

test('Run への知らせで orca が本文を読まずに終わっても、窓のプロセスは落ちずに失敗を返す（Codex 追加 44）', async () => {
  const dir = tmp('cockpit-notifyrun-epipe-')
  const bin = path.join(dir, 'orca')
  writeFileSync(bin, '#!/bin/sh\necho \'{"ok":false,"error":{"message":"Run run_x が見つかりません"}}\'\nexit 1\n')
  chmodSync(bin, 0o755)
  await assert.rejects(orcaCli(bin).notifyRun!('term_box', 'run_x', SIGNAL, 'あ'.repeat(1 << 20)), /Run run_x が見つかりません/)
})

test('窓から質問する: consult --ask の引数と、失敗の理由の頭の「consult: 」を外すこと', async () => {
  const dir = tmp('cockpit-askcli-')
  const ok = path.join(dir, 'ok')
  writeFileSync(ok, '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/args"\necho term_x\necho 立てた >&2\n')
  const ng = path.join(dir, 'ng')
  writeFileSync(ng, '#!/bin/sh\necho "consult: 窓口の会話が分かりません" >&2\nexit 1\n')
  chmodSync(ok, 0o755)
  chmodSync(ng, 0o755)
  // 質問が「--help」のようなオプション名でも、argparse が値として受け取れるよう 1 つの引数で渡す（Codex 軽微 1）。
  assert.equal(await askCli(ok)('/ws/a', 'ask3', { card: 'd21', question: '--help' }), 'term_x')
  assert.deepEqual(readFileSync(path.join(dir, 'args'), 'utf8').split('\n').slice(0, 6), ['--ask', '/ws/a', 'ask3', '--on-card', 'd21', '--question=--help'])
  await assert.rejects(askCli(ng)('/ws/a', 'ask3', {}), /^Error: 窓口の会話が分かりません$/)
})

test('窓から質問する: 判断の記録から撤回されていない判断を語で引いて、原文・番号・日時を返す', async () => {
  const { a, rows } = workspaces()
  mkdirSync(path.join(a, '.orca/cockpit'), { recursive: true })
  writeFileSync(path.join(a, '.orca/cockpit/rulings.jsonl'), [
    { id: 'R1', at: '2026-11-21T22:48:00+09:00', kind: 'decision', text: '窓から質問する欄は全体のタブの上に置く', quote: '質問する機能は割と良かった' },
    { id: 'R2', kind: 'decision', text: '質問の欄は置かない' }, { id: 'R3', kind: 'revoke', text: '撤回', supersedes: 'R2' }
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('asklookup', { root: a, q: '質問の欄はどこに置く？' })).body, { hits: [{ id: 'R1', at: '2026-11-21T22:48:00+09:00', kind: 'decision', text: '窓から質問する欄は全体のタブの上に置く', quote: '質問する機能は割と良かった' }] })
  assert.deepEqual((await post('asklookup', { root: a, q: 'どう？' })).body, { hits: [] })
})

test('これで決める: op を先に書き、題で探した質問のタブに「返しを書いて（op n）」を送る。タブが無ければ op だけ残し理由を返す。ふつうの操作では受けない', async () => {
  const { a, rows } = workspaces()
  const memo = path.join(a, '.orca/consult/ask-ask3.md')
  mkdirSync(path.dirname(memo), { recursive: true })
  writeFileSync(memo, '# 質問｜案件A｜ask3\n\n### 質問 09:10（u-1）\n入口は？\n\n### 答え 09:11\n1 つにする\n\n')
  writeFileSync(path.join(a, '.orca/consult/ask-ask4.md'), '# 質問｜案件A｜ask4\n\n### 質問 09:12（u-2）\nまだ答えが無い\n\n')
  let open = true
  const tabs: Orca['tabs'] = async (root) => (root === a && open ? [{ title: askTitle('案件A', 'ask3'), handles: ['term_ask3'] }, { title: 'ほか', handles: ['term_x'] }] : [])
  const { s, port, post, calls } = await start(rows, a, undefined, undefined, undefined, undefined, { tabs })
  const ev = listen(port, s.token)
  await ev.until((v) => (board(v, a)?.asks ?? []).length === 2)
  assert.equal((await post('askdecide', { root: a, ask: 'ask4', answer: { at: '09:12', head: 'x', n: 1 } })).status, 409, '答えの無い質問では決めない')
  assert.deepEqual(board(await ev.until((v) => !!board(v, a)?.asks?.find((x) => x.id === 'ask3')?.decide), a)!.asks!.find((x) => x.id === 'ask3')!.decide, { at: '09:11', head: '1 つにする', n: 1 }, '決める候補は常駐のプロセスが控えの全文から出す')
  const r = await post('askdecide', { root: a, ask: 'ask3', answer: { at: '09:11', head: '1 つにする', n: 1 } })
  assert.equal(r.status, 200)
  assert.equal(r.body.sent, true)
  const ops = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8')).ops
  assert.deepEqual({ ...ops.at(-1), at: undefined }, { op_id: r.body.op, at: undefined, item_id: '#ask:ask3', item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: '1 つにする', n: 1 } })
  assert.deepEqual(calls.filter((x) => x[0] === 'send'), [['send', 'term_ask3', askNotice(r.body.op)]])
  // 同じ答えへの 2 回目（連打・2 つの窓）は記録も知らせも足さない（Codex 中 1）。
  assert.deepEqual((await post('askdecide', { root: a, ask: 'ask3', answer: { at: '09:11', head: '1 つにする', n: 1 } })).body, { op: r.body.op, sent: false, again: true })
  assert.equal(JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8')).ops.length, ops.length)
  assert.equal(calls.filter((x) => x[0] === 'send').length, 1)
  // 画面を開いたあとに続きを聞いていたら、前の答えでは決めない（Codex 重大 3）。
  writeFileSync(memo, readFileSync(memo, 'utf8') + '### 質問 09:20（u-3）\n図は？\n\n')
  assert.equal((await post('askdecide', { root: a, ask: 'ask3', answer: { at: '09:11', head: '1 つにする', n: 1 } })).status, 409)
  // 同じ分に同じ書き出しの答えが続いても、通番で別の答えとして決める（Codex 2 回目 中 4）。
  writeFileSync(memo, readFileSync(memo, 'utf8') + '### 答え 09:11\n1 つにする\n\n')
  assert.equal((await post('askdecide', { root: a, ask: 'ask3', answer: { at: '09:11', head: '1 つにする', n: 1 } })).status, 409, '前の答えの通番では決めない')
  open = false
  const closed = await post('askdecide', { root: a, ask: 'ask3', answer: { at: '09:11', head: '1 つにする', n: 2 } })
  assert.deepEqual({ ...closed.body, op: 0 }, { op: 0, sent: false, reason: '写しの会話は閉じています。続けて聞くと、窓口の今の会話から写し直します' })
  assert.equal((await post('askdecide', { root: a, ask: 'ask3', answer: { at: '', head: 'x', n: 1 } })).status, 400, 'どの答えかの形が違えば書かない')
  assert.equal((await post('askdecide', { root: a, ask: 'ask3', answer: { at: '09:11', head: 'x' } })).status, 400, '通番が無ければ書かない')
  assert.equal((await post('op', { root: a, item_id: '#ask:ask3', item_rev: 0, type: 'ask_decide' })).status, 400)
  assert.deepEqual((await post('asktab', { root: a, ask: 'ask3' })).body, { opened: false, reason: '写しの会話は閉じています。続けて聞くと、窓口の今の会話から写し直します' })
  open = true
  assert.deepEqual((await post('asktab', { root: a, ask: 'ask3' })).body, { opened: true })
  assert.deepEqual(calls.at(-1), ['switch', 'term_ask3'])
})

test('質問のタブを自動で閉じる（R180）: 返しが全部反映され、返しの無い「窓口に返す」が無く、最後の質問に答えがあり、1 時間たったものだけ。窓が立てた端末だけを閉じる', async () => {
  const { a, b, rows } = workspaces()
  const dir = path.join(a, '.orca/consult')
  mkdirSync(dir, { recursive: true })
  const qa = (id: string, more = '') => writeFileSync(path.join(dir, `ask-${id}.md`), `# 質問｜案件A｜${id}\n\n### 質問 09:10（u-1）\n入口は？\n\n### 答え 09:11\n1 つにする\n\n${more}`)
  for (const id of ['ask1', 'ask2', 'ask3', 'ask5', 'ask6', 'ask7', 'ask8']) qa(id)
  qa('ask4', '### 質問 09:20（u-2）\n図は？\n\n')
  writeFileSync(path.join(dir, 'ask-ask2.returns.jsonl'), JSON.stringify({ return_id: 'ask2-1', ask: 'ask2', decisions: [{ text: '入口は 1 つ' }] }) + '\n')
  writeFileSync(path.join(dir, 'ask-ask6.returns.jsonl'), JSON.stringify({ return_id: 'ask6-1', ask: 'ask6', decisions: [{ text: '入口は 1 つ' }] }) + '\n')
  // ask6 の返しは判断の記録と帳簿の asks[] の両方に反映済み。ask3 は返しの無い「この答えを窓口に返す」が残る。
  mkdirSync(path.join(a, '.orca/cockpit'), { recursive: true })
  writeFileSync(path.join(a, '.orca/cockpit/rulings.jsonl'), JSON.stringify({ id: 'R1', at: '2026-11-21T09:12:00+09:00', kind: 'decision', text: '入口は 1 つ', from_return: 'ask6-1' }) + '\n')
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify({ ...c, asks: [{ id: 'ask6', from_returns: ['ask6-1'], held_returns: [] }] }))
  writeFileSync(path.join(a, '.orca/cockpit.user.json'), JSON.stringify({ ops: [{ op_id: 50, at: '2026-11-21T00:11:00.000Z', item_id: '#ask:ask3', item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: '1 つにする', n: 1 } }] }))
  const now = Date.now()
  const old = new Date(now - 2 * 3600_000)
  for (const id of ['ask1', 'ask2', 'ask3', 'ask4', 'ask6', 'ask7', 'ask8']) utimesSync(path.join(dir, `ask-${id}.md`), old, old)
  let connected = false
  const tabs: Orca['tabs'] = async (root) => root === a
    ? [
        ...['ask1', 'ask2', 'ask3', 'ask4', 'ask5', 'ask6'].map((id) => ({ title: askTitle('案件A', id), handles: [`term_${id}`] })),
        // ask7: 同じ題で人が開いたタブ（窓が立てた記録と端末が違う）。ask8: 窓が立てたタブの端末が一時的に繋がっていない。
        { title: askTitle('案件A', 'ask7'), handles: ['term_human'] },
        { title: askTitle('案件A', 'ask8'), handles: connected ? ['term_ask8'] : [] },
        { title: 'ほか', handles: ['term_x'] }
      ]
    : root === b ? [{ title: askTitle('案件A', 'ask1'), handles: ['term_b_ask1'] }] : []
  const { s, port, calls, post, orca, dir: wdir } = await start(rows, a, undefined, undefined, undefined, undefined, { tabs, ask: async (_root, id) => `term_${id}` })
  await listen(port, s.token).until((v) => (board(v, a)?.asks ?? []).length === 8)
  // 開いているタブに続きを送ったときは覚えない（consult は同じ題のタブを使い回すので、人のタブかもしれない）。新しく立てたタブの端末は覚える。
  assert.equal((await post('ask', { root: a, ask: 'ask7', question: '続き' })).body.opened, true)
  assert.ok(!existsSync(path.join(wdir, 'asktabs.json')), '開いているタブに送った分は覚えない')
  const fresh = await post('ask', { root: a, question: '新しい質問' })
  assert.deepEqual(JSON.parse(readFileSync(path.join(wdir, 'asktabs.json'), 'utf8')), { [a]: { [fresh.body.ask]: `term_${fresh.body.ask}` } })
  writeFileSync(path.join(wdir, 'asktabs.json'), JSON.stringify({ [a]: { ...Object.fromEntries(['ask1', 'ask2', 'ask3', 'ask4', 'ask5', 'ask6', 'ask8'].map((id) => [id, `term_${id}`])), ask7: 'term_ask7' } }))
  // 閉じる端末の 1 つ目は一度だけ失敗させる。
  let fail = true
  const close = orca.closeTerminal!
  orca.closeTerminal = async (t) => {
    if (fail) {
      fail = false
      throw new Error('一時的に失敗')
    }
    return close(t)
  }
  utimesSync(path.join(dir, 'ask-ask1.md'), old, old)
  await s.sweepAsks(now)
  // 閉じない: ask2（返しが帳簿に無い）・ask3（返しの無い決める）・ask4（答え待ち）・ask5（1 時間未満）・ask7（人のタブ）・ask8（繋がっていない）。
  // ask1 は閉じるのに失敗し、ask6 は閉じた。
  assert.deepEqual(calls.filter((x) => x[0] === 'close'), [['close', 'term_ask6']])
  // 失敗したもの・繋がっていなかったものは、次の回にもう一度見る。閉じたもの・人のタブは、控えが変わるまで見直さない。
  connected = true
  await s.sweepAsks(now)
  assert.deepEqual(calls.filter((x) => x[0] === 'close'), [['close', 'term_ask6'], ['close', 'term_ask1'], ['close', 'term_ask8']])
  await s.sweepAsks(now)
  assert.equal(calls.filter((x) => x[0] === 'close').length, 3)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(wdir, 'asktabs.json'), 'utf8'))[a]).sort(), ['ask2', 'ask3', 'ask4', 'ask5', 'ask7'], '閉じた端末の記録は消す')
  assert.ok(!calls.some((x) => x[0] === 'close' && ['term_x', 'term_b_ask1', 'term_human', 'term_ask7'].includes(x[1]!)), '別の題・別の案件・人のタブは閉じない')
  assert.ok(existsSync(path.join(dir, 'ask-ask1.md')) && existsSync(path.join(dir, 'ask-ask6.returns.jsonl')), '控えと返しの記録は消さない')
})

test('質問のタブを自動で閉じる（R180）: 閉じる直前に控えを読み直し、その間に続きを聞いたものは閉じない', async () => {
  const { a, rows } = workspaces()
  const dir = path.join(a, '.orca/consult')
  mkdirSync(dir, { recursive: true })
  const memo = path.join(dir, 'ask-ask1.md')
  writeFileSync(memo, '# 質問｜案件A｜ask1\n\n### 質問 09:10（u-1）\n入口は？\n\n### 答え 09:11\n1 つにする\n\n')
  const now = Date.now()
  const old = new Date(now - 2 * 3600_000)
  utimesSync(memo, old, old)
  const { s, port, calls, dir: wdir } = await start(rows, a, undefined, undefined, undefined, undefined, { tabs: async (root) => (root === a ? [{ title: askTitle('案件A', 'ask1'), handles: ['term_ask1'] }] : []) })
  writeFileSync(path.join(wdir, 'asktabs.json'), JSON.stringify({ [a]: { ask1: 'term_ask1' } }))
  await listen(port, s.token).until((v) => (board(v, a)?.asks ?? []).length === 1)
  // 見張りの知らせが届く前（窓の持つ控えは古いまま）に、続きの質問が書かれた。
  writeFileSync(memo, readFileSync(memo, 'utf8') + '### 質問 09:20（u-2）\n図は？\n\n')
  utimesSync(memo, old, old)
  await s.sweepAsks(now)
  assert.ok(!calls.some((x) => x[0] === 'close'), '答え待ちになった質問のタブは閉じない')
})

test('質問のタブを自動で閉じる（R180）: 「この答えを窓口に返す」と閉じる処理は同じ順番に並び、閉じたあとに知らせを送らない', async () => {
  const { a, rows } = workspaces()
  const dir = path.join(a, '.orca/consult')
  mkdirSync(dir, { recursive: true })
  const memo = path.join(dir, 'ask-ask1.md')
  writeFileSync(memo, '# 質問｜案件A｜ask1\n\n### 質問 09:10（u-1）\n入口は？\n\n### 答え 09:11\n1 つにする\n\n')
  const now = Date.now()
  utimesSync(memo, new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000))
  let gate!: () => void
  const held = new Promise<void>((r) => (gate = r))
  let closed = false
  let first = true
  const tabs: Orca['tabs'] = async (root) => {
    if (root !== a) return []
    if (first) {
      first = false
      await held
    }
    return closed ? [] : [{ title: askTitle('案件A', 'ask1'), handles: ['term_ask1'] }]
  }
  const { s, port, calls, post, orca, dir: wdir } = await start(rows, a, undefined, undefined, undefined, undefined, { tabs })
  const close = orca.closeTerminal!
  orca.closeTerminal = async (t) => ((closed = true), close(t))
  writeFileSync(path.join(wdir, 'asktabs.json'), JSON.stringify({ [a]: { ask1: 'term_ask1' } }))
  await listen(port, s.token).until((v) => (board(v, a)?.asks ?? []).length === 1)
  // 閉じる処理が Orca のタブの返事を待っている間に「この答えを窓口に返す」を押す。
  const sweep = s.sweepAsks(now)
  await new Promise((r) => setTimeout(r, 50))
  const decide = post('askdecide', { root: a, ask: 'ask1', answer: { at: '09:11', head: '1 つにする', n: 1 } })
  await new Promise((r) => setTimeout(r, 50))
  gate()
  await sweep
  const r = await decide
  // 先に閉じ、そのあとに記録した操作は、閉じたタブに知らせを送らずに理由を返す。
  assert.deepEqual(calls.filter((x) => x[0] === 'close' || x[0] === 'send'), [['close', 'term_ask1']])
  assert.equal(r.body.sent, false)
  assert.match(r.body.reason, /閉じています/)
})

test('質問のタブを自動で閉じる（R180）: 窓のブラウザが開いていなくても、Orca から案件を読んで閉じる', async () => {
  const { a, rows } = workspaces()
  const dir = path.join(a, '.orca/consult')
  mkdirSync(dir, { recursive: true })
  const memo = path.join(dir, 'ask-ask1.md')
  writeFileSync(memo, '# 質問｜案件A｜ask1\n\n### 質問 09:10（u-1）\n入口は？\n\n### 答え 09:11\n1 つにする\n\n')
  const now = Date.now()
  utimesSync(memo, new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000))
  const { s, calls, dir: wdir } = await start(rows, a, undefined, undefined, undefined, undefined, { tabs: async (root) => (root === a ? [{ title: askTitle('案件A', 'ask1'), handles: ['term_ask1'] }] : []) })
  writeFileSync(path.join(wdir, 'asktabs.json'), JSON.stringify({ [a]: { ask1: 'term_ask1' } }))
  await s.sweepAsks(now)
  assert.deepEqual(calls.filter((x) => x[0] === 'close'), [['close', 'term_ask1']])
})

test('質問のタブは、root の worktree のタブだけから、繋がっている端末を題で引く（consult の live_thread と同じ読み方）', () => {
  const layouts = [
    { worktreePath: '/ws/a', root: { type: 'split', children: [{ tabs: [{ title: '質問｜案件A｜ask1', panes: [{ type: 'terminal', handle: 'term_1' }, { type: 'terminal', handle: 'term_gone', connected: false }] }] }] } },
    { worktreePath: '/ws/b', tabs: [{ title: '質問｜案件A｜ask1', panes: [{ type: 'terminal', handle: 'term_b' }] }] }
  ]
  assert.deepEqual(tabsOf(layouts, '/ws/a'), [{ title: '質問｜案件A｜ask1', handles: ['term_1'] }])
  assert.deepEqual(askTitle('案件｜A', 'ask2'), '質問｜案件 A｜ask2')
})

test('窓に送る質問は、控えの新しい節と返しの表示に使う欄に絞る', async () => {
  const { a, rows } = workspaces()
  mkdirSync(path.join(a, '.orca/consult'), { recursive: true })
  const secs = Array.from({ length: 8 }, (_, i) => `### ${i % 2 ? '答え' : '質問'} 09:${String(10 + i)}\n${i === 7 ? 'あ'.repeat(7000) : `本文${i}`}\n\n`).join('')
  writeFileSync(path.join(a, '.orca/consult/ask-ask1.md'), `# 質問｜案件A｜ask1\n\n${secs}`)
  writeFileSync(path.join(a, '.orca/consult/ask-ask1.returns.jsonl'), JSON.stringify({ return_id: 'ask1-1', op: 5, decisions: [{ text: '1 つにする', quote: '長い'.repeat(100), utterance: 'u-1' }], requests: [{ quote: 'x' }], open: ['y'] }) + '\n')
  const { s, port } = await start(rows, a)
  const w = await listen(port, s.token).until((v) => (board(v, a)?.asks ?? []).length === 1)
  const x = board(w, a)!.asks![0]!
  assert.deepEqual(x.entries.map((e) => e.time), ['09:12', '09:13', '09:14', '09:15', '09:16', '09:17'])
  assert.equal(x.entries.at(-1)!.text.length, 6001)
  assert.equal(x.answers, 4)
  assert.deepEqual(x.returns, [{ return_id: 'ask1-1', op: 5, decisions: [{ text: '1 つにする' }] }])
})

/** 担当 o1 を、worker-start --agent で立てたチャットにする。窓口は受け取りの terminal（structworker_…）を terminal に書いた。 */
function chatOwner(chatWorktree: string | undefined) {
  const { a, child, rows } = workspaces()
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  c.owners[0] = { id: 'o1', title: '窓の版 3', stream: 's2', agent: 'claude', terminal: 'structworker_lead' }
  c.tasks[1].worker = { task_id: 'task_lead', dispatch_id: 'ctx_lead' }
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  const shows: Record<string, WorkerShow> = {
    ctx_lead: {
      projection: { stage: { worker: 'ready' }, liveness: { verdict: 'live' } }, terminal: null, observation: { agentWait: null },
      worker: { agentTerminalHandle: 'structworker_lead' }, terminalResource: { terminalHandle: 'structworker_lead', endpointIncarnation: 'structured:sess-lead' }
    }
  }
  const owners: OwnerLive[] = [{ session: 'sess-lead', kind: 'chat', state: 'done', title: '窓の版 3（担当）', worktree: chatWorktree ?? child }]
  return { a, child, rows, shows, owners }
}
const talkLog = (root: string) => {
  try {
    return JSON.parse(readFileSync(path.join(root, '.orca/cockpit.user.json'), 'utf8')).ops.map((o: { item_id: string; type: string }) => `${o.item_id}:${o.type}`)
  } catch {
    return []
  }
}

test('担当と話す: チャットの担当（terminal に structworker_ を書かれた）は、Dispatch からチャットを引き、その worktree を開いてチャットの題を案内する', async () => {
  const { a, child, rows, shows, owners } = chatOwner(undefined)
  const { s, port, post, calls } = await start(rows, a, undefined, owners, shows)
  await listen(port, s.token).until((w) => ready(w) && !!board(w, a)?.dispatches?.ctx_lead)
  assert.deepEqual((await post('talk', { root: a, item_id: 'd21', item_rev: 1 })).body, { opened: true, how: `ワークスペース「${path.basename(child)}」`, tab: '窓の版 3（担当）' })
  assert.deepEqual(calls.filter((x) => x[0] !== 'send'), [['activate', child]])
  assert.deepEqual(talkLog(a), ['d21:talk'])
})

test('担当と話す: 窓を開いた直後（Dispatch を読んでいる途中）に押しても、読み終わるのを待ってチャットの担当を開く', async () => {
  const { a, child, rows, shows, owners } = chatOwner(undefined)
  const { s, port, post } = await start(rows, a, undefined, owners, shows, 400)
  // 帳簿が読めた（カードが押せる）ことを出来事で待つ。409 を回数で押し直すと、重い機械では読み終わる前に回数が尽きる（追加 43）。
  await listen(port, s.token).until((w) => !!board(w, a)?.cockpit)
  const r = await post('talk', { root: a, item_id: 'd21', item_rev: 1 })
  assert.deepEqual(r.body, { opened: true, how: `ワークスペース「${path.basename(child)}」`, tab: '窓の版 3（担当）' })
})

test('担当と話す: 担当の worktree が消えた・チャットが閉じた・端末が閉じたときは、何も開かず理由を返し、カードを話し中にしない', async () => {
  const gone = chatOwner('/Users/x/orca/workspaces/nix/gone-lead')
  const one = await start(gone.rows, gone.a, undefined, gone.owners, gone.shows)
  await listen(one.port, one.s.token).until((w) => ready(w) && !!board(w, gone.a)?.dispatches?.ctx_lead)
  const r = (await one.post('talk', { root: gone.a, item_id: 'd21', item_rev: 1 })).body
  assert.equal(r.opened, false)
  assert.match(r.reason, /担当「窓の版 3」のチャットの居場所の worktree（gone-lead）が Orca にありません/)
  assert.deepEqual(one.calls.filter((x) => x[0] !== 'send'), [])
  assert.deepEqual(talkLog(gone.a), [])

  const closed = chatOwner(undefined)
  const two = await start(closed.rows, closed.a, undefined, [], closed.shows)
  await listen(two.port, two.s.token).until((w) => ready(w) && !!board(w, closed.a)?.dispatches?.ctx_lead)
  assert.match((await two.post('talk', { root: closed.a, item_id: 'd21', item_rev: 1 })).body.reason, /チャットが Orca にありません/)

  const { a, rows } = workspaces()
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  c.owners[1].terminal = 'term_closed'
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  const three = await start(rows, a)
  await listen(three.port, three.s.token).until(ready)
  const t = (await three.post('talk', { root: a, item_id: 'r5', item_rev: 1 })).body
  assert.equal(t.opened, false)
  assert.match(t.reason, /担当「配車画面の改修」の端末（term_closed）が Orca にありません/)
  assert.deepEqual(talkLog(a), [])
})

test('担当と話す: 取り消したあとにもう一度押せば、また話し中にする。前に出せなかったら記録しない', async () => {
  const { a, rows } = workspaces()
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until(ready)
  await post('talk', { root: a, item_id: 'r5', item_rev: 1 })
  await post('op', { root: a, item_id: 'r5', item_rev: 1, type: 'undo', undo_of: 1 })
  await post('talk', { root: a, item_id: 'r5', item_rev: 1 })
  assert.deepEqual(talkLog(a), ['r5:talk', 'r5:undo', 'r5:talk'])
})

test('担当と話す: 調べた直後に端末が閉じられて Orca が前に出せなければ、理由を返して記録しない', async () => {
  const { a, rows } = workspaces()
  const dir = tmp('cockpit-dir-')
  const fake = fakeOrca(rows)
  fake.orca.switchTerminal = async (t) => {
    throw new Error(`${t} is not a terminal`)
  }
  const s = createServer({ port: 0, dir, orca: fake.orca })
  servers.push(s)
  const port = await s.listen()
  const origin = `http://127.0.0.1:${port}`
  await listen(port, s.token).until(ready)
  const r = await fetch(`${origin}/api/talk`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-cockpit-token': s.token }, body: JSON.stringify({ root: a, item_id: 'r5', item_rev: 1 }) })
  assert.deepEqual(await r.json(), { opened: false, how: '配車画面の改修の端末', reason: 'Orca が前に出せませんでした: term_aoba_w1 is not a terminal' })
  assert.deepEqual(talkLog(a), [])
})

test('手作業の票（manual）には、決める・許す・任せるを記録しない', async () => {
  const c = JSON.parse(cockpit('案件A'))
  c.cards.push({ id: 'm1', rev: 1, kind: 'permit', state: 'open', title: 'switch を打つ', manual: { command: 'sudo darwin-rebuild switch' }, options: [{ id: 'a', label: 'A' }] })
  const a = workspace('a', { '.orca/cockpit.json': JSON.stringify(c) })
  const { s, port, post } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  await listen(port, s.token).until((w) => !!board(w, a)?.cockpit)
  for (const type of ['decide', 'accept', 'delegate']) assert.equal((await post('op', { root: a, item_id: 'm1', item_rev: 1, type, option_id: 'a' })).status, 400, type)
  assert.equal((await post('op', { root: a, item_id: 'm1', item_rev: 1, type: 'sent' })).status, 200)
})

test('担当と話す: 窓口がチャットなら本線を開き、本線で動いているチャットの題を案内する（済んだ古いチャットより先）', async () => {
  const { a, rows } = workspaces()
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  c.main = { agent: 'claude', terminal: '' }
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  rows[0]!.agents = []
  const owners: OwnerLive[] = [
    { session: 'old', kind: 'chat', state: 'done', title: '前の窓口', worktree: a, updatedAt: 9 },
    { session: 'now', kind: 'chat', state: 'working', title: '窓口（配車）', worktree: a, updatedAt: 5 }
  ]
  const { s, port, post, calls } = await start(rows, a, undefined, owners)
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('talk', { root: a, item_id: 'd22', item_rev: 2 })).body, { opened: true, how: `ワークスペース「${path.basename(a)}」`, tab: '窓口（配車）' })
  assert.deepEqual(calls, [['activate', a]])
})

test('帯の印は端末を前に出し、端末が無ければ worktree を開く。知らない端末と worktree は扱わない', async () => {
  const { a, child, rows } = workspaces()
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('focus', { terminalId: 'term_w1', worktree: child })).body, { focused: true, how: '端末' })
  assert.deepEqual((await post('focus', { terminalId: '', worktree: child })).body, { focused: true, how: `ワークスペース「${path.basename(child)}」` })
  assert.deepEqual((await post('focus', { terminalId: 'term_x', worktree: '/etc' })).body, { focused: false })
  assert.deepEqual(calls, [['switch', 'term_w1'], ['activate', child]])
})

test('止まった理由: 許可待ち・返事待ち・落ちた・利用枠・ログイン切れ・エラー・中断。終わったものは止まっていない', () => {
  assert.equal(stopReason(agent('p', { state: 'blocked' })), 'blocked')
  assert.equal(stopReason(agent('p', { state: 'waiting' })), 'waiting')
  assert.equal(stopReason(agent('p', { hasLivePty: false })), 'dead')
  assert.equal(stopReason(agent('p', { state: 'done', hasLivePty: false, mainAgent: { outcome: 'success' } })), undefined)
  assert.equal(stopReason(agent('p', { state: 'done', lastAssistantMessage: "You've hit your usage limit · resets 5pm" })), 'limit')
  // bin/stallwatch と同じ 3 行（短い 1 行なので SHORT の条件で落ちない）。
  for (const msg of ["You've hit your 5-hour limit · resets 4:40pm (Asia/Tokyo)", "You've reached your Fable limit.", "You've hit your weekly limit · resets Nov 23 at 4am"])
    assert.equal(stopReason(agent('p', { state: 'done', lastAssistantMessage: msg })), 'limit', msg)
  assert.equal(stopReason(agent('p', { state: 'done', lastAssistantMessage: 'Invalid API key · Please run /login' })), 'auth')
  assert.equal(stopReason(agent('p', { state: 'done', mainAgent: { outcome: 'failure' } })), 'error')
  assert.equal(stopReason(agent('p', { state: 'done', interrupted: true })), 'interrupted')
  assert.equal(stopReason(agent('p', { state: 'done', lastAssistantMessage: 'rate limit の設計を直しました。'.padEnd(500, '。') })), undefined)
  assert.equal(stopReason(agent('p', { state: 'done' })), undefined)
})

test('.orca の外を指すファイルがあっても起動し、そのワークスペースのエラーに出す', async () => {
  const outside = workspace('outside2', { 'a.json': '{"cards":[]}' })
  const a = workspace('a', { '.orca/cockpit.json': cockpit('案件A') })
  symlinkSync(path.join(outside, 'a.json'), path.join(a, '.orca/cockpit.archive.json'))
  const { s, port } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const v = await listen(port, s.token).until((w) => !!board(w, a)?.cockpit)
  assert.ok(board(v, a)!.errors.some((e) => /cockpit.archive.json を読めません.*\.orca の外は読みません/.test(e)))
})

test('版 1 の cockpit.json は読まず、移し替えの手順をそのワークスペースのエラーに出す', async () => {
  const a = workspace('a', { '.orca/cockpit.json': JSON.stringify({ workspace: { name: '古い' }, streams: [], tasks: [], items: [] }) })
  const { s, port } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const v = await listen(port, s.token).until((w) => !!board(w, a)?.errors.length)
  assert.match(board(v, a)!.errors[0]!, /古い形.*migrate\.ts/)
})

test('パネルと窓（別のプロセス）が同時に追記しても、両方の操作が残る', async () => {
  const other = (await import(new URL('../src/store.ts?other-process', import.meta.url).href)) as typeof import('../src/store.ts')
  const mine = await import('../src/store.ts')
  const a = workspace('a', { '.orca/cockpit.json': cockpit('案件A') })
  const c = JSON.parse(cockpit('案件A'))
  const op = (item_id: string, rev = 1) => ({ root: a, item_id, item_rev: rev, type: 'talk' as const })
  await Promise.all([mine.appendOp(a, c, op('d21')), other.appendOp(a, c, op('r5')), mine.appendOp(a, c, op('i3')), other.appendOp(a, c, op('d22', 2))])
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.deepEqual(log.ops.map((o: { op_id: number }) => o.op_id).sort(), [1, 2, 3, 4])
  assert.deepEqual(log.ops.map((o: { item_id: string }) => o.item_id).sort(), ['d21', 'd22', 'i3', 'r5'])
})

test('取り消しの猶予が過ぎた操作は、窓口が端末で動いていても端末に打たず、郵便受けから main.run_id に知らせる（R191）', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const a = workspace('a', {
    '.orca/cockpit.json': cockpit('案件A'),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 2, at: old, item_id: 'r5', item_rev: 1, type: 'accept' }] })
  })
  // 窓口は作業中でも待たない（Orca が手の空いたときに届ける）。
  const rows: PsRow[] = [{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main', { state: 'working' })] }]
  const { s, port, calls, dir } = await start(rows, a)
  const v = await listen(port, s.token).until((w) => board(w, a)?.notifiedOp === 2)
  assert.equal(board(v, a)!.signal, undefined)
  assert.deepEqual(calls.filter((c) => c[0] !== 'mailbox').map((c) => c.slice(0, 4)), [['run', 'term_box1', 'run_main', SIGNAL]])
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'notified.json'), 'utf8')), { [a]: 2 })
})

test('自動の合図と押した送り直しが重なっても、同じ操作は Run に 1 度だけ送る（Codex 追加 44）', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const a = workspace('a', {
    '.orca/cockpit.json': cockpit('案件A', { main: { agent: 'claude', terminal: '', run_id: 'run_m' } }),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 7, at: old, item_id: 'r5', item_rev: 1, type: 'accept' }] })
  })
  const sent: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { s, port, post } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a, undefined, undefined, undefined, undefined, {
    notifyRun: async (_from, id) => { sent.push(id); await gate }
  })
  await listen(port, s.token).until(() => sent.length === 1)
  const manual = post('notify', { root: a })
  // 押した送り直しがサーバーに届くまで、自動の送信を終わらせない（直列にしていなければ、ここで 2 通目が出る）。
  await new Promise((r) => setTimeout(r, 150))
  release()
  assert.deepEqual((await manual).body, { sent: true })
  assert.deepEqual(sent, ['run_m'])
})

test('窓口の Run の無い帳簿で猶予の過ぎた操作があれば、送らずに窓の上の帯に理由を出す（黙って届かないままにしない。Codex 追加 47）', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const a = workspace('a', {
    '.orca/cockpit.json': cockpit('案件A', { main: { agent: 'claude', terminal: 'term_main' } }),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 7, at: old, item_id: 'r5', item_rev: 1, type: 'accept' }] })
  })
  const { s, port, calls } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const v = await listen(port, s.token).until((w) => board(w, a)?.signal?.state === 'failed')
  assert.equal(board(v, a)!.signal!.reason, 'cockpit.json の main に run_id がありません')
  assert.deepEqual(calls.filter((c) => ['run', 'send', 'mailbox'].includes(c[0]!)), [])
})

test('郵便受け: 控えた端末が生きていれば使い回し、消えていれば作り直し、作れなければ帯に理由を出す（追加 44 の補足）', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const files = (name: string, op = 7) => ({
    '.orca/cockpit.json': cockpit(name, { main: { agent: 'claude', terminal: '', run_id: 'run_m' } }),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: op, at: old, item_id: 'r5', item_rev: 1, type: 'accept' }] })
  })
  const runs = (calls: string[][]) => calls.filter((c) => c[0] === 'run' || c[0] === 'mailbox').map((c) => c.slice(0, 3))
  // 生きている端末（term_main）を控えていれば作らずに使う。
  const a = workspace('a', files('案件A'))
  const live = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a, undefined, undefined, undefined, undefined, { mailboxFile: '{"handle":"term_main"}' })
  await listen(live.port, live.s.token).until((w) => board(w, a)?.notifiedOp === 7)
  assert.deepEqual(runs(live.calls), [['run', 'term_main', 'run_m']])
  // 2 つの案件が同時に送っても、郵便受けは 1 つだけ作る。消えた端末（term_gone）は作り直す。
  const b = workspace('b', files('案件B'))
  const c = workspace('c', files('案件C'))
  const rows = [b, c].map((p) => ({ worktreeId: `r::${path.basename(p)}`, path: p, parentWorktreeId: null, agents: [] }))
  const gone = await start(rows, b, undefined, undefined, undefined, undefined, { mailboxFile: '{"handle":"term_gone"}' })
  await listen(gone.port, gone.s.token).until((w) => board(w, b)?.notifiedOp === 7 && board(w, c)?.notifiedOp === 7)
  assert.equal(gone.calls.filter((x) => x[0] === 'mailbox').length, 1)
  assert.deepEqual(gone.calls.filter((x) => x[0] === 'run').map((x) => x[1]), ['term_box1', 'term_box1'])
  // 作れなければ送らず、理由を帯に出す。
  const d = workspace('d', files('案件D'))
  const broken = await start([{ worktreeId: 'r::d', path: d, parentWorktreeId: null, agents: [] }], d, undefined, undefined, undefined, undefined, {
    mailbox: async () => { throw new Error('郵便受けの端末を作れませんでした') }
  })
  const w = await listen(broken.port, broken.s.token).until((x) => board(x, d)?.signal?.state === 'failed')
  assert.equal(board(w, d)!.signal!.reason, '郵便受けの端末を作れませんでした')
  assert.deepEqual(runs(broken.calls), [])
})

test('窓口がチャットで端末が無く Run がある帳簿は、猶予が過ぎた操作を Run に知らせ、送れなければ理由を帯に出す（追加 44）', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const text = '"題"が消える\n--to run:other --body x'
  const files = (root: string) => ({
    '.orca/cockpit.json': cockpit(root, { main: { agent: 'claude', terminal: '', run_id: 'run_m' } }),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 7, at: old, item_id: 'r5', item_rev: 1, type: 'talk', text }] })
  })
  const a = workspace('a', files('案件A'))
  // 窓口のエージェントは Orca の端末の一覧に居ない（チャット）。手が空くのを待たずに送る。
  const { s, port, calls, dir } = await start([{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [] }], a)
  const v = await listen(port, s.token).until((w) => board(w, a)?.notifiedOp === 7)
  assert.equal(board(v, a)!.signal, undefined)
  // Orca の外のプロセスは送り手の端末が無いと断られるので、郵便受けの端末を作り、それを送り手にする（追加 44 の補足）。
  const [box, [kind, from, id, subject, body], ...rest] = calls.filter((c) => c[0] === 'run' || c[0] === 'send' || c[0] === 'mailbox')
  assert.deepEqual([box, kind, from, id, subject, rest], [['mailbox', a], 'run', 'term_box1', 'run_m', SIGNAL, []])
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'mailbox.json'), 'utf8')), { handle: 'term_box1' })
  assert.ok(body!.startsWith('案件A の操縦席の窓から: '), body)
  assert.ok(body!.endsWith(`${text}\n\n未反映の操作を cockpit skill の手順で反映してください。`), body)
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'notified.json'), 'utf8')), { [a]: 7 })

  const b = workspace('b', files('案件B'))
  const failed = await start([{ worktreeId: 'r::b', path: b, parentWorktreeId: null, agents: [] }], b, undefined, undefined, undefined, undefined, {
    notifyRun: async () => { throw new Error('orca orchestration send が失敗しました: Run run_m が見つかりません') }
  })
  const w = await listen(failed.port, failed.s.token).until((x) => board(x, b)?.signal?.state === 'failed')
  assert.match(board(w, b)!.signal!.reason!, /Run run_m が見つかりません/)
  assert.notEqual(board(w, b)!.notifiedOp, 7, '送れなかった操作は送った記録に残さない')
})

test('worker は操縦席の task に記録された Dispatch の端末で task に結び、仕事の名前は task の名前にする', async () => {
  const { a, child, rows } = workspaces()
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  c.tasks[0].worker = { task_id: 'task_w1', dispatch_id: 'ctx_w1' }
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  rows.find((r) => r.path === child)!.displayName = 'list｜表示名から推した名前'
  const shows = { ctx_w1: { projection: { stage: { worker: 'ready' }, liveness: { verdict: 'live' } }, terminal: { handle: 'term_w1' }, observation: { agentWait: null } } }
  const { s, port } = await start(rows, a, undefined, undefined, shows)
  const v = await listen(port, s.token).until((w) => ready(w) && board(w, a)!.workers.length === 1 && board(w, a)!.workers[0]!.task !== undefined)
  assert.deepEqual(board(v, a)!.workers.map((w) => [w.task, w.job]), [['t1', '一覧の並べ替えと絞り込み']])
  // view は JSON で届くので settledAt: undefined は欄ごと落ちる。
  assert.deepEqual(board(v, a)!.dispatches, { ctx_w1: { state: 'ready', liveness: 'live', terminal: 'term_w1', waiting: false } })
})

test('Orca に無い Dispatch は null で渡して詰まりの票にし、済んだタスクの Dispatch は問い合わせない', async () => {
  const { a, rows } = workspaces()
  const c = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.json'), 'utf8'))
  c.tasks[0].worker = { task_id: 'task_gone', dispatch_id: 'ctx_gone' }
  c.tasks.push({ ...c.tasks[0], id: 't_old', state: 'ok', worker: { task_id: 'task_old', dispatch_id: 'ctx_old' } })
  writeFileSync(path.join(a, '.orca/cockpit.json'), JSON.stringify(c))
  const { s, port, showCalls } = await start(rows, a)
  const v = await listen(port, s.token).until((w) => ready(w) && !!board(w, a)?.dispatches)
  assert.deepEqual(board(v, a)!.dispatches, { ctx_gone: null })
  assert.ok(showCalls.includes('ctx_gone') && !showCalls.includes('ctx_old'))
  // 見つからない worker の記録は、詰まりの票になる（落ちて端末が消えた worker も取りこぼさない）。
  assert.ok(board(v, a)!.cockpit!.tasks[0]!.worker)
})

test('開けるのは本線と、その子孫（担当とその worker）の worktree の中のファイルだけ。日本語の名前と path:行 も開く', async () => {
  const { a, child, rows } = workspaces()
  writeFileSync(path.join(a, '一覧画面.md'), 'x')
  mkdirSync(path.join(a, 'docs'))
  writeFileSync(path.join(child, 'out.md'), 'x')
  const other = rows.find((r) => r.worktreeId === 'r::c-w1')!.path
  writeFileSync(path.join(other, 'secret.md'), 'x')
  // 担当（窓口の子）の下に立った worker（窓口の孫）の成果物も開く。
  const grand = workspace('a-w1-w')
  writeFileSync(path.join(grand, 'diff.md'), 'x')
  const parent = rows.find((r) => r.path === child)!
  rows.push({ worktreeId: 'r::a-w1-w', path: grand, parentWorktreeId: parent.worktreeId, agents: [] })
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('open', { root: a, path: '一覧画面.md:12' })).body, { opened: true })
  assert.deepEqual((await post('open', { root: a, path: path.join(child, 'out.md') })).body, { opened: true })
  assert.deepEqual((await post('open', { root: a, path: path.join(grand, 'diff.md') })).body, { opened: true })
  assert.equal((await post('open', { root: a, path: path.join(other, 'secret.md') })).body.opened, false, '別の本線の子は開かない')
  // 開けないときは、画面に出す理由を返す（黙って何も起きないようにしない）。
  assert.match((await post('open', { root: a, path: path.join(other, 'secret.md') })).body.reason, /外のファイルは開かない/)
  assert.deepEqual((await post('open', { root: a, path: 'nope.md' })).body, { opened: false, reason: 'ファイルが見つかりません: nope.md' })
  assert.match((await post('open', { root: a, path: 'docs' })).body.reason, /フォルダ/)
  assert.deepEqual((await post('open', { root: a, path: `file://${path.join(a, '一覧画面.md')}` })).body, { opened: true }, 'file:// の URL もパスとして開く')
  const real = (p: string) => realpathSync(p)
  assert.deepEqual(calls.filter((x) => x[0] === 'open'), [
    ['open', a, real(path.join(a, '一覧画面.md')), '12'],
    ['open', child, real(path.join(child, 'out.md'))],
    ['open', grand, real(path.join(grand, 'diff.md'))],
    ['open', a, real(path.join(a, '一覧画面.md'))]
  ])
})

test('URL は http と https だけを既定のブラウザで開く', async () => {
  const { a, rows } = workspaces()
  const { s, port, post, calls } = await start(rows, a)
  await listen(port, s.token).until(ready)
  assert.deepEqual((await post('openurl', { url: 'https://docs.google.com/document/d/x/edit' })).body, { opened: true })
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/a', 'not a url'])
    assert.equal((await post('openurl', { url })).body.opened, false, url)
  assert.equal((await post('openurl', { url: 'https://x.example' }, { 'x-cockpit-token': 'wrong' })).status, 403)
  assert.deepEqual(calls.filter((x) => x[0] === 'url'), [['url', 'https://docs.google.com/document/d/x/edit']])
})

test('送る文面のコピーは本文と書式を clip-draft の呼び出しに渡し、書式の形が違えば断る', async () => {
  const got: unknown[][] = []
  const s = createServer({ port: 0, dir: tmp('cockpit-dir-'), orca: fakeOrca([]).orca, clip: async (text, format) => (got.push([text, format]), { copied: true, subject: '件名' }) })
  servers.push(s)
  const origin = `http://127.0.0.1:${await s.listen()}`
  const post = (body: unknown) =>
    fetch(`${origin}/api/clip`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-cockpit-token': s.token }, body: JSON.stringify(body) })
  const ok = await post({ text: '- **a**', format: 'teams' })
  assert.deepEqual([ok.status, await ok.json()], [200, { copied: true, subject: '件名' }])
  for (const bad of [{ text: 'a', format: 'line' }, { text: 1, format: 'slack' }]) assert.equal((await post(bad)).status, 400)
  assert.deepEqual(got, [['- **a**', 'teams']])
})

test('見ての「直してほしいこと」は本文つきの talk として記録し、合図の本文の頭に載せる', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const a = workspace('a', {
    '.orca/cockpit.json': cockpit('案件A'),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 5, at: old, item_id: 'r5', item_rev: 1, type: 'talk', text: '凡例を上に寄せ、色の意味を 1 行で書いてほしい' }] })
  })
  const rows: PsRow[] = [{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main', { state: 'done' })] }]
  const { s, port, calls, post } = await start(rows, a)
  await listen(port, s.token).until((w) => board(w, a)?.notifiedOp === 5)
  const body = calls.find((c) => c[0] === 'run')![4]!
  assert.ok(body.startsWith(`案件A の操縦席の窓から: ${SIGNAL}（直してほしい r5: 凡例を上に寄せ、色の意味を 1 行で書いてほしい）`), body)
  assert.ok(!calls.some((c) => c[0] === 'send'), '窓口の端末には打たない')
  assert.equal((await post('op', { root: a, item_id: 'r5', item_rev: 1, type: 'talk', text: 'あ'.repeat(4001) })).status, 400, '本文の上限は別の答えと同じ')
})

test('4000 字を超える別の答えは切り詰めずに断り、ちょうど 4000 字は通す。本文の無い別の答えも断る', async () => {
  const { a, rows } = workspaces()
  const { s, port, post } = await start(rows, a)
  await listen(port, s.token).until(ready)
  const r = await post('op', { root: a, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other', text: 'あ'.repeat(4000) + 'ただし、まだ送信しない' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /4000 字までです（今 4011 字）/)
  assert.equal((await post('op', { root: a, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other' })).status, 400)
  assert.equal((await post('op', { root: a, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other', text: 'あ'.repeat(4000) })).status, 200)
  const log = JSON.parse(readFileSync(path.join(a, '.orca/cockpit.user.json'), 'utf8'))
  assert.equal(log.ops.length, 1)
  assert.equal(log.ops[0].text.length, 4000)
})

test('止まった問いを要対応に 1 行で出す: 端末の AskUserQuestion は画面から、許可は道具の欄から、orchestration の question は inbox から（偽の Orca は fixtures/demo.ts）', async () => {
  const base = tmp('cockpit-asks-')
  const now = Date.now()
  const { roots, orca } = writeSample(base, now)
  const dir = tmp('cockpit-dir-')
  writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ path: roots.aoba, at: new Date().toISOString() }))
  const s = createServer({ port: 0, dir, orca })
  servers.push(s)
  const port = await s.listen()
  const v = await listen(port, s.token).until((x) => !!board(x, roots.aoba!)?.questions?.length)
  const m = { boards: boardsOf(v.boards, now), focused: roots.aoba, unseen: [], errors: [] }
  const lines = (b: Board) => todoGroups(b).flatMap(([, xs]) => xs).filter((r) => r.agent?.ask).map((r) => [r.card.title, r.agent!.ask!.from])
  const aoba = m.boards.find((b) => b.root === roots.aoba)!
  // 1 行目は問いそのもの、2 行目は誰が誰に聞いているか。
  assert.deepEqual(lines(aoba), [
    ['キャッシュを入れて直しますか、それとも原因の調査報告だけにしますか？', 'worker（朝の地図の遅さの調査）があなたに聞いている'],
    ['一覧の既定の並びを、配送日の降順にしますか、登録順のままにしますか', 'worker（一覧の並べ替えと絞り込み）が窓口に聞いたが、まだ答えが無い'],
    ['構成図は PowerPoint と draw.io のどちらで描きますか（田中さんが直すのは PowerPoint）', 'worker（AWS 構成案）が担当に聞いたが、まだ答えが無い']
  ])
  // 押すと宛先を前に出す: 地図の worker は自分の端末、窓口宛ては窓口の端末、担当宛ては担当のチャットのある worktree。
  const row = (t: string) => todoGroups(aoba).flatMap(([, xs]) => xs).find((r) => r.card.title.includes(t))!
  assert.deepEqual([row('キャッシュ').agent?.terminalId, row('既定の並び').agent?.terminalId, row('構成図').agent?.worktree], ['term_aoba_w2', 'term_aoba_main', path.join(base, 'aoba-aws')])
  // 詳細: 題に収まった問いは本文を重ねず、選択肢は番号を付けずにどこで選ぶかを添える。
  const h = renderWindow(m, { ...newUi(), sel: keyOf(row('既定の並び')) }, now, (x) => x)
  assert.doesNotMatch(h, /聞かれていること/)
  assert.match(h, /選択肢（窓口に伝える）<\/span><div><ul class="rich"><li>配送日の降順にする<\/li><li>登録順のままにする/)
  assert.match(h, /答え方.*窓口の端末を開いて答えを伝えれば、窓口がworker（一覧の並べ替えと絞り込み）に返す/s)
  assert.match(h, /聞いた日時.*>窓口の端末を開く</s)
  assert.match(renderWindow(m, { ...newUi(), sel: keyOf(row('キャッシュ')) }, now, (x) => x), /選択肢（端末で選ぶ）/)
  // 許可待ちは道具の欄から（ログ集計の見直し）。
  const harness = m.boards.find((b) => b.root === roots.harness)!
  assert.deepEqual(lines(harness), [['許可: Bash: git push origin feature/log-summary', 'worker（集計の分け方を直す）が許可を求めている']])
})

test('送る文面の書式の検査（R161・R162）: 状態を作るときに検査し、カードごとの結果を載せる。同じ本文は CLI を呼び直さない', async () => {
  const bin = path.join(tmp('cockpit-lint-'), 'draft-format-lint')
  writeFileSync(bin, FAKE_LINT)
  chmodSync(bin, 0o755)
  const c = JSON.parse(cockpit('案件A')) as { cards: Record<string, unknown>[] }
  c.cards.find((x) => x.id === 'd22')!.draft = OLD_M1
  const a = workspace('a', { '.orca/cockpit.json': JSON.stringify(c) })
  const rows: PsRow[] = [{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main')] }]
  const { s, port } = await start(rows, a, undefined, undefined, undefined, undefined, { lint: draftLinter({ bin }) })
  const v = await listen(port, s.token).until((x) => !!board(x, a)?.drafts)
  const d22 = board(v, a)!.drafts!.d22!
  assert.ok('violations' in d22)
  assert.deepEqual([d22.format, d22.violations.map((x) => x.line)], ['slack', [4, 5, 6, 7]])
  assert.equal(readFileSync(`${bin}.calls`, 'utf8').split('\n').filter(Boolean).length, 1)
})

test('見張る仕事の Bot（R152）: 帳簿の watch が指す automation を Orca から読んで案件ごとに載せ、最後の実行は Orca にある Bot の分だけ読む。実行のチャットは前に出せる（偽の Orca は fixtures/demo.ts）', async () => {
  const base = tmp('cockpit-watch-')
  const now = Date.now()
  const { roots, orca } = writeSample(base, now)
  const runCalls: string[] = []
  const automationRun = orca.automationRun!
  orca.automationRun = (id) => (runCalls.push(id), automationRun(id))
  const s = createServer({ port: 0, dir: tmp('cockpit-dir-'), orca })
  servers.push(s)
  const port = await s.listen()
  const v = await listen(port, s.token).until((x) => !!board(x, roots.aoba!)?.automations)
  assert.deepEqual(board(v, roots.aoba!)!.automations!.map((a) => [a.id, a.name, a.last?.status, a.last?.chat]), [['auto-aoba', '青葉の管理表・Slack 見回り', 'completed', 'orca_session_id:sess-bot']])
  // Orca に無い automation は name の無い行で載る（窓が「Orca に設定が無い」と出す）。
  assert.deepEqual(board(v, roots.harness!)!.automations, [{ id: 'auto-gone' }])
  const origin = `http://127.0.0.1:${port}`
  const focus = async (terminalId: string) => (await fetch(`${origin}/api/focus`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-cockpit-token': s.token }, body: JSON.stringify({ terminalId }) })).json()
  assert.deepEqual(await focus('orca_session_id:sess-bot'), { focused: true, how: 'Bot の実行のチャット' })
  assert.deepEqual(await focus('orca_session_id:sess-other'), { focused: false })
  // 実行の記録は、Orca にある Bot の分だけ読む（無い auto-gone は問い合わせない）。
  assert.deepEqual(runCalls, ['auto-aoba'])
})

test('見張る仕事の前回の結果: 読んだ実行が今の lastRunAt のものだけを前回として渡し、読み直せていなければ読めていない印を付ける（Codex 3）', () => {
  const row = { id: 'b1', name: '見回り', rrule: '0 9 * * *', enabled: true, lastRunAt: 200 }
  const runA: AutomationRun = { status: 'completed', at: 100, content: 'A', chat: 'orca_session_id:a' }
  assert.equal(automationFact('b1', row, { at: 200, run: runA }).last, runA)
  // lastRunAt が進んだのに読み直せていない（前の A が残っている・まだ一度も読めていない）。
  for (const cached of [{ at: 100, run: runA }, undefined]) {
    const f = automationFact('b1', row, cached)
    assert.deepEqual([f.last, f.lastUnread], [undefined, true])
  }
  // まだ実行していない Bot と、実行の記録が無い Bot には印を付けない。
  assert.equal(automationFact('b1', { ...row, lastRunAt: undefined }, undefined).lastUnread, undefined)
  assert.deepEqual(automationFact('b1', row, { at: 200, run: null }), { id: 'b1', name: '見回り', rrule: '0 9 * * *', timezone: undefined, enabled: true, nextRunAt: undefined, last: undefined })
  assert.deepEqual(automationFact('gone', undefined, undefined), { id: 'gone' })
})
