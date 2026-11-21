import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { writeSample } from '../fixtures/demo.ts'
import { sample } from '../fixtures/sample.ts'
import { boardsOf, keyOf, newUi, type Board } from '../src/view.ts'
import { renderWindow, todoGroups } from '../src/window-view.ts'
import type { OwnerLive, WindowView } from '../src/protocol.ts'
import { SIGNAL } from '../src/store.ts'
import { createServer, stopReason, type Consult, type Orca, type PluginRow, type PsAgent, type PsRow } from './server.ts'
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
  c.main = { agent: 'claude', terminal: 'term_main' }
  return JSON.stringify({ ...c, ...over })
}
const agent = (paneKey: string, over: Partial<PsAgent> = {}): PsAgent => ({ paneKey, state: 'working', stateStartedAt: 1, hasLivePty: true, ...over })

function fakeOrca(rows: PsRow[], plugins: PluginRow[] = [{ pluginKey: 'local.cockpit', status: 'running', needsReconsent: false, isDev: false }], owners: OwnerLive[] = [], shows: Record<string, WorkerShow> = {}, showDelay = 0, extraTerms: string[] = []) {
  const calls: string[][] = []
  const showCalls: string[] = []
  const orca: Orca = {
    ps: async () => rows,
    terminals: async () => [
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
    activate: async (root) => void calls.push(['activate', root]),
    switchTerminal: async (t) => void calls.push(['switch', t]),
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

async function start(rows: PsRow[], focusPath?: string, plugins?: PluginRow[], owners?: OwnerLive[], shows?: Record<string, WorkerShow>, showDelay?: number, more: { consult?: Consult; terms?: string[] } = {}) {
  const dir = tmp('cockpit-dir-')
  const setFocus = (p: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ path: p, at: new Date().toISOString(), ...extra }))
  if (focusPath) setFocus(focusPath)
  const fake = fakeOrca(rows, plugins, owners, shows, showDelay, more.terms)
  const s = createServer({ port: 0, dir, orca: fake.orca, consult: more.consult })
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
  return { s, port, origin, post, setFocus, dir, calls: fake.calls, showCalls: fake.showCalls }
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
  listen(port, s.token)
  let r = await post('talk', { root: a, item_id: 'd21', item_rev: 1 })
  for (let n = 0; r.status === 409 && n < 200; n++) r = await post('talk', { root: a, item_id: 'd21', item_rev: 1 })
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

test('取り消しの猶予が過ぎた操作は、メインが入力待ちなら自動で合図を送り、送った記録はパネルと共有する', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const a = workspace('a', {
    '.orca/cockpit.json': cockpit('案件A'),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 2, at: old, item_id: 'r5', item_rev: 1, type: 'accept' }] })
  })
  const rows: PsRow[] = [{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main', { state: 'done' })] }]
  const { s, port, calls, dir } = await start(rows, a)
  const v = await listen(port, s.token).until((w) => board(w, a)?.notifiedOp === 2)
  assert.equal(board(v, a)!.signal, undefined)
  assert.deepEqual(calls, [['send', 'term_main', SIGNAL]])
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'notified.json'), 'utf8')), { [a]: 2 })
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

test('見ての「直してほしいこと」は本文つきの talk として記録し、合図の 1 行に本文の頭を載せる', async () => {
  const old = new Date(Date.now() - 60_000).toISOString()
  const a = workspace('a', {
    '.orca/cockpit.json': cockpit('案件A'),
    '.orca/cockpit.user.json': JSON.stringify({ ops: [{ op_id: 5, at: old, item_id: 'r5', item_rev: 1, type: 'talk', text: '凡例を上に寄せ、色の意味を 1 行で書いてほしい' }] })
  })
  const rows: PsRow[] = [{ worktreeId: 'r::a', path: a, parentWorktreeId: null, agents: [agent('t:main', { state: 'done' })] }]
  const { s, port, calls, post } = await start(rows, a)
  await listen(port, s.token).until((w) => board(w, a)?.notifiedOp === 5)
  assert.deepEqual(calls, [['send', 'term_main', `${SIGNAL}（直してほしい r5: 凡例を上に寄せ、色の意味を 1 行で書いてほしい）`]])
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
    ['一覧の既定の並びを、配送日の降順にしますか、登録順のままにしますか', 'worker（一覧の並べ替えと絞り込み）が窓口に聞いて、12 分答えが無い'],
    ['構成図は PowerPoint と draw.io のどちらで描きますか（森さんが直すのは PowerPoint）', 'worker（AWS 構成案）が担当に聞いて、45 分答えが無い']
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
