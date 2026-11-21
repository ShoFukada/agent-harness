// 操縦席の窓の常駐のプロセス。127.0.0.1 だけで待ち受けてページを配り、focus.json（パネルの worker が書く）と、
// 操縦席のあるワークスペースの .orca/ を見張って、変わったらページに SSE で送る。launchd が起動する（configuration.nix）。
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, promises as fsp, watch, type FSWatcher } from 'node:fs'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatMain, OP_TYPES, type Card, type OpType } from '../src/model.ts'
import type { CockpitView, NotifyResult, OpInput, OwnerLive, TalkResult, WindowView } from '../src/protocol.ts'
import { ownerOf } from '../src/state.ts'
import { orcaAgents, orcaWorktrees, PLUGIN_KEY, pluginProblem, SHORT, type PluginRow, type PsAgent, type PsRow } from './orca-state.ts'
export { jobOf, stopReason, type PluginRow, type PsAgent, type PsRow } from './orca-state.ts'
import { appendOp, emptyFiles, loadFiles, notifyMain, readNotified, signalPlan, splitLine, writeNotified, type Files } from '../src/store.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const SERVED = new Set(['window/page.ts', 'src/controller.ts', 'src/model.ts', 'src/morph.ts', 'src/sanitize.ts', 'src/state.ts', 'src/style.ts', 'src/view.ts'])
/** 窓に送る片付いたカードの日数。古いものは cockpit.archive.json に移っている。 */
const CLOSED_DAYS = 14
/** ページが表示されている間に Orca の状態を確かめる間隔。プロセスが落ちた worker は Orca から知らせが来ないため。 */
const POLL_MS = 60_000
const REFRESH_GAP_MS = 5_000

export type TerminalRow = { handle: string; tabId: string; leafId: string }

export type Orca = {
  ps(): Promise<PsRow[]>
  terminals(): Promise<TerminalRow[]>
  plugins(): Promise<PluginRow[]>
  /** チャットも含めた全エージェント（orca agent list）。担当の今を出す。 */
  agents(): Promise<OwnerLive[]>
  send(terminal: string, text: string): Promise<void>
  activate(root: string): Promise<void>
  switchTerminal(terminal: string): Promise<void>
  openFile(root: string, abs: string, line?: number): Promise<void>
  /** 既定のブラウザで開く。http(s) かどうかは呼ぶ側が確かめる。 */
  openUrl(url: string): Promise<void>
}

export function orcaCli(bin = 'orca'): Orca {
  const run = (args: string[]) =>
    new Promise<Record<string, unknown>>((resolve, reject) =>
      execFile(bin, [...args, '--json'], { timeout: 15_000, maxBuffer: 64 << 20 }, (err, out) => {
        let json: { ok?: boolean; result?: Record<string, unknown>; error?: { message?: string } } | undefined
        try {
          json = JSON.parse(out)
        } catch {
          return reject(new Error(err?.message ?? 'orca の出力を読めません'))
        }
        if (err || json?.ok === false) return reject(new Error(json?.error?.message ?? err?.message ?? 'orca が失敗しました'))
        resolve(json?.result ?? {})
      })
    )
  return {
    ps: async () =>
      ((await run(['worktree', 'ps', '--limit', '500'])).worktrees as PsRow[]).map((r) => ({
        worktreeId: r.worktreeId, path: r.path, parentWorktreeId: r.parentWorktreeId, displayName: r.displayName, comment: r.comment,
        agents: r.agents.map((a) => ({
          paneKey: a.paneKey, state: a.state, agentType: a.agentType, conversationName: a.conversationName,
          displayName: a.displayName, taskTitle: a.taskTitle, stateStartedAt: a.stateStartedAt, interrupted: a.interrupted,
          hasLivePty: a.hasLivePty, mainAgent: a.mainAgent ? { outcome: a.mainAgent.outcome } : null,
          lastAssistantMessage: (a.lastAssistantMessage ?? '').length <= SHORT ? a.lastAssistantMessage : null
        }))
      })),
    agents: async () => {
      type Listed = { orcaSessionId: string; kind: string; state: OwnerLive['state']; title?: string | null; worktreeId?: string; updatedAt?: number }
      return ((await run(['agent', 'list'])).agents as Listed[]).map((a) => ({
        session: a.orcaSessionId, kind: a.kind === 'chat' ? 'chat' : 'terminal', state: a.state, title: a.title ?? undefined,
        // worktreeId は「リポジトリの id::パス」の形。開くのはパス。
        worktree: a.worktreeId?.split('::').slice(1).join('::') || undefined, updatedAt: a.updatedAt
      }))
    },
    terminals: async () =>
      ((await run(['terminal', 'list', '--limit', '500'])).terminals as TerminalRow[]).map(({ handle, tabId, leafId }) => ({ handle, tabId, leafId })),
    plugins: async () => {
      type Listed = PluginRow & { source?: { kind?: string; reference?: string | null; contentHash?: string | null } | null }
      const rows = ((await run(['plugin', 'list'])).plugins as Listed[]).map(({ pluginKey, status, needsReconsent, isDev, source }) => ({
        pluginKey, status, needsReconsent, isDev, kind: source?.kind,
        source: source && { reference: source.reference, contentHash: source.contentHash }
      }))
      // フォルダから入れた操縦席だけ、今のフォルダの中身の hash を取る（入れた写しが古いかを見るため）。
      const mine = rows.find((r) => r.pluginKey === PLUGIN_KEY && !r.isDev && r.kind === 'local-path' && r.source?.reference)
      if (mine) mine.folderHash = ((await run(['plugin', 'inspect', mine.source!.reference!]).catch(() => ({}))) as { contentHash?: string }).contentHash ?? null
      return rows.map(({ kind: _kind, ...r }) => r)
    },
    send: async (terminal, text) => void (await run(['terminal', 'send', '--terminal', terminal, '--text', text, '--enter'])),
    activate: async (root) => void (await run(['worktree', 'activate', '--worktree', `path:${root}`])),
    switchTerminal: async (terminal) => void (await run(['terminal', 'switch', '--terminal', terminal])),
    openFile: async (root, abs, line) =>
      void (await run(['file', 'open', abs, '--worktree', `path:${root}`, '--focus', ...(line ? ['--line', String(line)] : [])])),
    openUrl: (url) =>
      new Promise<void>((resolve, reject) => execFile('/usr/bin/open', [url], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve())))
  }
}

type Ws = {
  root: string
  files: Files
  watcher?: FSWatcher
  timer?: ReturnType<typeof setTimeout>
  signal?: CockpitView['signal']
  signalTimer?: ReturnType<typeof setTimeout>
}

type Focus = { path?: string; agents_at?: number }
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Options = { port: number; dir: string; orca: Orca; host?: string }

export function createServer(opts: Options) {
  const token = randomBytes(24).toString('base64url')
  const { orca } = opts
  let port = opts.port
  const wss = new Map<string, Ws>()
  let ps: PsRow[] = []
  let terms = new Map<string, string>()
  let owners: OwnerLive[] = []
  let orcaError: string | undefined
  let pluginNote: string | undefined
  let focus: Focus = {}
  /** この常駐のプロセスが書いた操作（root#op_id）。合図は書いた側が先に送る（store.ts の signalPlan）。 */
  const mine = new Set<string>()
  const clients = new Set<http.ServerResponse>()
  let poll: ReturnType<typeof setInterval> | undefined
  let focusWatcher: FSWatcher | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let sendTimer: ReturnType<typeof setTimeout> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshing: Promise<void> | undefined
  let lastRefresh = 0
  const jsCache = new Map<string, { mtime: number; code: string }>()

  const hasCockpit = (root: string) => !!wss.get(root)?.files.cockpit || existsSync(path.join(root, '.orca', 'cockpit.json'))
  const rowOf = (root: string) => ps.find((r) => r.path === root)

  /** Orca の前面に当たる行。前面が worker の worktree なら、操縦席のある親。 */
  function followRoot(): string | undefined {
    const p = focus.path
    if (!p) return undefined
    const parentId = rowOf(p)?.parentWorktreeId
    const parent = parentId ? ps.find((r) => r.worktreeId === parentId) : undefined
    return parent && hasCockpit(parent.path) ? parent.path : p
  }

  const agentsOf = (root: string, files: Files) => orcaAgents(root, ps, terms, files.cockpit)
  const workersOf = (root: string, files: Files) => agentsOf(root, files).workers
  const worktreesOf = (root: string) => orcaWorktrees(root, ps)

  async function cockpitView(root: string | undefined, slim = false): Promise<CockpitView> {
    const ws = root ? wss.get(root) : undefined
    const files = ws?.files ?? emptyFiles()
    const cockpit = slim && files.cockpit ? slimmed(files.cockpit) : files.cockpit
    const since = Date.now() - CLOSED_DAYS * 86_400_000
    return {
      state: !root ? 'no-workspace' : files.missing ? 'missing' : 'ok',
      root, cockpit, log: files.log, figures: files.figures, errors: files.errors,
      archive: slim ? files.archive.filter((c) => Date.parse(c.resolved_at ?? '') > since) : files.archive,
      workers: root ? workersOf(root, files) : [], worktrees: root ? worktreesOf(root) : [], owners,
      notifiedOp: root ? await readNotified(opts.dir, root) : 0, signal: ws?.signal
    }
  }

  /** 窓に送る量を減らす。片付いて日のたったカードと、タスクの済んだ作業の記録は画面に出さない。 */
  function slimmed(c: NonNullable<Files['cockpit']>): NonNullable<Files['cockpit']> {
    const since = Date.now() - CLOSED_DAYS * 86_400_000
    const keep = (x: Card) => x.state !== 'done' || !x.resolved_at || Date.parse(x.resolved_at) > since
    return { ...c, cards: c.cards.filter(keep), tasks: c.tasks.map(({ done: _d, sources: _s, ...t }) => t) }
  }

  /**
   * 取り消しの猶予が過ぎた操作があれば、メインに合図を送る。入力中の文字と混ざらないよう、メインが作業中（working）の間は送らず、
   * エージェントの状態が変わった知らせ（focus.json の agents_at）でもう一度呼ぶ。
   */
  async function autoSignal(ws: Ws): Promise<void> {
    clearTimeout(ws.signalTimer)
    const c = ws.files.cockpit
    if (!c || chatMain(c)) return void (ws.signal = undefined)
    const plan = signalPlan(c, ws.files.log, await readNotified(opts.dir, ws.root), Date.now(), (o) => mine.has(`${ws.root}#${o.op_id}`))
    if (plan.nextAt !== undefined)
      ws.signalTimer = setTimeout(() => void autoSignal(ws).then(broadcast, (e) => console.error(e)), plan.nextAt - Date.now() + 50)
    if (!plan.due.length) return void (ws.signal = undefined)
    if (Date.now() - lastRefresh > REFRESH_GAP_MS) await refreshOrca()
    const main = agentsOf(ws.root, ws.files).main
    if (!main) return void (ws.signal = { state: 'failed', reason: 'メインのエージェントが見つかりません' })
    if (main.state === 'working') return void (ws.signal = { state: 'waiting' })
    const r = await notify(ws)
    ws.signal = r.sent ? undefined : { state: 'failed', reason: r.reason }
  }

  async function windowView(): Promise<WindowView> {
    const live = ps.flatMap((r) => r.agents).filter((a) => a.hasLivePty === true || (a.hasLivePty !== false && a.state !== 'done')).length
    const boards = await Promise.all([...wss.values()].filter((ws) => ws.files.cockpit || ws.files.errors.length).map((ws) => cockpitView(ws.root, true)))
    // Orca にある本線のうち、操縦席の無いもの（見ていない案件）。worker の worktree と、操縦席の窓のある本線は除く。
    const unseen = ps.filter((r) => !r.parentWorktreeId && !hasCockpit(r.path)).map((r) => ({ name: r.displayName?.trim() || path.basename(r.path), path: r.path }))
    return { focused: followRoot(), boards, unseen, live, errors: [orcaError, pluginNote].filter((e): e is string => !!e) }
  }

  function broadcast(): void {
    if (!clients.size) return
    clearTimeout(sendTimer)
    sendTimer = setTimeout(async () => {
      const data = `data: ${JSON.stringify(await windowView())}\n\n`
      for (const res of clients) res.write(data)
    }, 30)
  }

  async function reload(ws: Ws): Promise<void> {
    ws.files = await loadFiles(ws.root, ws.files)
  }

  function watchWs(ws: Ws): void {
    if (ws.watcher) return
    try {
      ws.watcher = watch(path.join(ws.root, '.orca'), { recursive: true }, () => {
        clearTimeout(ws.timer)
        ws.timer = setTimeout(() => void reload(ws).then(() => autoSignal(ws)).then(broadcast, (e) => console.error(e)), 80)
      })
      ws.watcher.on('error', () => {
        ws.watcher?.close()
        ws.watcher = undefined
      })
    } catch {
      // .orca がまだ無い。次に Orca の状態を確かめたときにもう一度見張る。
    }
  }

  async function sync(): Promise<void> {
    const want = new Set(ps.filter((r) => !r.parentWorktreeId && hasCockpit(r.path)).map((r) => r.path))
    for (const [root, ws] of wss)
      if (!want.has(root)) {
        ws.watcher?.close()
        clearTimeout(ws.timer)
        clearTimeout(ws.signalTimer)
        wss.delete(root)
      }
    await Promise.all([...want].map(async (root) => {
      let ws = wss.get(root)
      if (ws?.watcher) return
      ws ??= { root, files: emptyFiles() }
      wss.set(root, ws)
      watchWs(ws)
      await reload(ws)
      // 見張り始めた案件にも、猶予の過ぎた未送の操作があれば合図を送る（起動し直したときに取りこぼさない）。
      void autoSignal(ws).then(broadcast, (e) => console.error(e))
    }))
  }

  function refreshOrca(): Promise<void> {
    return (refreshing ??= (async () => {
      try {
        const [rowsNow, tl, plugins, ags] = await Promise.all([orca.ps(), orca.terminals(), orca.plugins().catch(() => undefined), orca.agents().catch(() => undefined)])
        pluginNote = plugins && pluginProblem(plugins)
        if (ags) owners = ags
        ps = rowsNow
        terms = new Map(tl.map((t) => [`${t.tabId}:${t.leafId}`, t.handle]))
        orcaError = undefined
      } catch (e) {
        orcaError = 'Orca に繋がりません'
        console.error(`orca: ${(e as Error).message}`)
      }
      lastRefresh = Date.now()
      await sync()
      broadcast()
    })().finally(() => {
      refreshing = undefined
    }))
  }

  const background = () => void refreshOrca().catch((e) => console.error(`refresh: ${(e as Error).message}`))

  function refreshSoon(): void {
    if (!clients.size || refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      if (clients.size) background()
    }, Math.max(0, lastRefresh + REFRESH_GAP_MS - Date.now()))
  }

  async function readFocus(): Promise<void> {
    let next: Focus = {}
    try {
      next = JSON.parse(await fsp.readFile(path.join(opts.dir, 'focus.json'), 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`focus.json: ${(e as Error).message}`)
      return
    }
    const moved = next.path !== focus.path
    const agents = next.agents_at !== focus.agents_at
    focus = next
    if (moved) broadcast()
    if (agents) {
      refreshSoon()
      // メインが作業中で合図を待たせていたら、入力待ちになったかを確かめて送る。
      for (const ws of wss.values()) if (ws.signal) void autoSignal(ws).then(broadcast, (e) => console.error(e))
    }
  }

  function startPolling(): void {
    if (poll) return
    background()
    poll = setInterval(background, POLL_MS)
  }
  function stopPolling(): void {
    clearInterval(poll)
    clearTimeout(refreshTimer)
    poll = undefined
    refreshTimer = undefined
  }

  const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`]
  const tokenOk = (got: unknown) =>
    typeof got === 'string' && got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token))

  function page(): string {
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="cockpit-token" content="${token}"><title>操縦席</title></head><body><script type="module" src="/window/page.ts"></script></body></html>`
  }

  async function js(rel: string): Promise<string> {
    const file = path.join(PLUGIN, rel)
    const mtime = (await fsp.stat(file)).mtimeMs
    const hit = jsCache.get(rel)
    if (hit?.mtime === mtime) return hit.code
    const code = stripTypeScriptTypes(await fsp.readFile(file, 'utf8'))
    jsCache.set(rel, { mtime, code })
    return code
  }

  async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 64 * 1024) throw new HttpError(413, '大きすぎます')
      chunks.push(c as Buffer)
    }
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'JSON のオブジェクトを送ってください')
    return v as Record<string, unknown>
  }

  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

  function knownWs(root: unknown): Ws {
    const ws = typeof root === 'string' ? wss.get(root) : undefined
    if (!ws) throw new HttpError(409, '表示中のワークスペースが変わりました。もう一度押してください')
    return ws
  }

  const send = async (terminal: string, text: string): Promise<NotifyResult> => {
    if (![...terms.values()].includes(terminal)) await refreshOrca()
    if (![...terms.values()].includes(terminal)) return { sent: false, reason: 'メインの端末が見つかりません' }
    await orca.send(terminal, text)
    return { sent: true }
  }

  async function notify(ws: Ws): Promise<NotifyResult> {
    const r = await notifyMain(ws.files.cockpit, ws.files.log, send)
    if (r.lastOp !== undefined) await writeNotified(opts.dir, ws.root, r.lastOp)
    return r.sent ? { sent: true } : { sent: false, reason: r.reason }
  }

  const api: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
    async op(b) {
      const ws = knownWs(b.root)
      if (!OP_TYPES.includes(b.type as OpType) || typeof b.item_id !== 'string' || typeof b.item_rev !== 'number')
        throw new HttpError(400, '操作の形が違います')
      const input: OpInput = {
        root: ws.root, item_id: b.item_id, item_rev: b.item_rev, type: b.type as OpType,
        option_id: str(b.option_id), undo_of: typeof b.undo_of === 'number' ? b.undo_of : undefined,
        target: typeof b.target === 'number' ? b.target : undefined, text: typeof b.text === 'string' ? b.text : undefined
      }
      const log = await appendOp(ws.root, ws.files.cockpit, input)
      mine.add(`${ws.root}#${log.ops.at(-1)!.op_id}`)
      ws.files = { ...ws.files, log }
      broadcast()
      await autoSignal(ws)
      return { view: await cockpitView(ws.root, true) }
    },
    /** 担当と話す。カードを話し中にし（件数から外す）、担当の端末かチャットのワークスペースを Orca で前に出す。 */
    async talk(b): Promise<TalkResult> {
      const ws = knownWs(b.root)
      const c = ws.files.cockpit
      const card = c?.cards.find((x) => x.id === b.item_id)
      if (!c || !card) throw new HttpError(409, 'カードが見つかりません。読み直してからもう一度押してください')
      if (card.state === 'open' && card.kind !== 'talk' && card.kind !== 'report' && typeof b.item_rev === 'number' && b.item_rev === card.rev) {
        const already = ws.files.log.ops.some((o) => o.type === 'talk' && o.item_id === card.id && o.item_rev === card.rev)
        if (!already) {
          ws.files = { ...ws.files, log: await appendOp(ws.root, c, { root: ws.root, item_id: card.id, item_rev: card.rev, type: 'talk' }) }
          mine.add(`${ws.root}#${ws.files.log.ops.at(-1)!.op_id}`)
          broadcast()
          void autoSignal(ws).then(broadcast, (e) => console.error(e))
        }
      }
      if (Date.now() - lastRefresh > REFRESH_GAP_MS) await refreshOrca()
      const o = ownerOf(c, card, { workers: workersOf(ws.root, ws.files), owners })
      const name = o.how === 'main' ? '窓口' : o.title
      if (o.terminal && [...terms.values()].includes(o.terminal)) {
        await orca.switchTerminal(o.terminal)
        return { opened: true, how: `${name}の端末` }
      }
      // Orca にはチャットを前に出す手段が無いので、チャットのあるワークスペースを開く（チャットはそのタブにある）。
      const chat = o.owner?.session ? owners.find((x) => x.session === o.owner!.session) : undefined
      const where = chat?.worktree && rowOf(chat.worktree) ? chat.worktree : ws.root
      await orca.activate(where)
      return { opened: true, how: `${name}のいるワークスペース（${path.basename(where)}）` }
    },
    async notify(b) {
      const ws = knownWs(b.root)
      const r = await notify(ws)
      ws.signal = r.sent ? undefined : { state: 'failed', reason: r.reason }
      broadcast()
      return r
    },
    async open(b) {
      const ws = knownWs(b.root)
      const href = str(b.path)
      if (!href) return { opened: false }
      const { file, line } = splitLine(href)
      // 開けるのは、操縦席のある本線と、orca worktree ps で本線の子と分かる worktree の中のファイルだけ。
      const row = rowOf(ws.root)
      const roots = [ws.root, ...ps.filter((r) => row && r.parentWorktreeId === row.worktreeId).map((r) => r.path)]
      const real = await fsp.realpath(path.resolve(ws.root, file)).catch(() => '')
      if (!real) return { opened: false }
      for (const root of roots) {
        const base = await fsp.realpath(root).catch(() => '')
        if (base && real.startsWith(base + path.sep) && (await fsp.stat(real)).isFile()) {
          await orca.openFile(root, real, line)
          return { opened: true }
        }
      }
      return { opened: false }
    },
    async openurl(b) {
      const url = str(b.url)
      let u: URL | undefined
      try {
        u = url ? new URL(url) : undefined
      } catch {
        u = undefined
      }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return { opened: false, reason: 'http と https の URL だけ開きます' }
      await orca.openUrl(u.href)
      return { opened: true }
    },
    async activate(b) {
      const root = str(b.root)
      if (!root || !rowOf(root)) throw new HttpError(409, 'Orca にないワークスペースです')
      await orca.activate(root)
      return { ok: true }
    },
    async focus(b) {
      const terminal = str(b.terminalId)
      if (terminal && [...terms.values()].includes(terminal)) {
        await orca.switchTerminal(terminal)
        return { focused: true }
      }
      const wt = str(b.worktree)
      if (wt && rowOf(wt)) {
        await orca.activate(wt)
        return { focused: true }
      }
      return { focused: false }
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, type: string, text: string) => {
      res.writeHead(status, {
        'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
      })
      res.end(text)
    }
    const json = (status: number, v: unknown) => reply(status, 'application/json; charset=utf-8', JSON.stringify(v))
    // 名前を 127.0.0.1 に向けた別のサイト（DNS rebinding）からの要求を断る。
    if (!hosts().includes(req.headers.host ?? '')) return json(403, { error: 'host が違います' })
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (req.method === 'GET') {
      if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', page())
      if (url.pathname === '/favicon.ico') return reply(204, 'image/x-icon', '')
      const rel = url.pathname.slice(1)
      if (SERVED.has(rel)) return reply(200, 'text/javascript; charset=utf-8', await js(rel))
      if (url.pathname === '/events') {
        if (!tokenOk(url.searchParams.get('token'))) return json(403, { error: 'トークンが違います' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        req.socket.setTimeout(0)
        clients.add(res)
        req.on('close', () => {
          clients.delete(res)
          if (!clients.size) stopPolling()
        })
        res.write(`data: ${JSON.stringify(await windowView())}\n\n`)
        startPolling()
        return
      }
      return json(404, { error: 'ありません' })
    }

    const name = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : ''
    if (req.method !== 'POST' || !Object.hasOwn(api, name)) return json(404, { error: 'ありません' })
    if (!hosts().map((h) => `http://${h}`).includes(req.headers.origin ?? '')) return json(403, { error: 'origin が違います' })
    if (!tokenOk(req.headers['x-cockpit-token'])) return json(403, { error: 'トークンが違います' })
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'JSON で送ってください' })
    try {
      return json(200, await api[name]!(await body(req)))
    } catch (e) {
      const err = e as Error & { code?: string; status?: number }
      const status = err instanceof HttpError ? err.status : err.code === 'conflict' ? 409 : err.code === 'invalid_params' ? 400 : err instanceof SyntaxError ? 400 : 500
      if (status === 500) console.error(err)
      return json(status, { error: err.message })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })

  return {
    token,
    async listen(): Promise<number> {
      await fsp.mkdir(opts.dir, { recursive: true })
      // focus.json は rename で置き換わるので、ファイルではなく置き場所を見張る。
      focusWatcher = watch(opts.dir, (_ev, name) => {
        if (name !== 'focus.json') return
        clearTimeout(focusTimer)
        focusTimer = setTimeout(() => void readFocus(), 30)
      })
      // 見張れないとき（ファイルの見張りの上限など）も、常駐のプロセスは落とさず、前面の切り替えだけを止める。
      focusWatcher.on('error', (e) => console.error(`focus.json を見張れません: ${e.message}`))
      await readFocus()
      for (const ws of wss.values()) void autoSignal(ws).catch((e) => console.error(e))
      await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve))
      port = (server.address() as { port: number }).port
      return port
    },
    async close(): Promise<void> {
      stopPolling()
      focusWatcher?.close()
      for (const t of [focusTimer, sendTimer, refreshTimer]) clearTimeout(t)
      for (const ws of wss.values()) {
        ws.watcher?.close()
        clearTimeout(ws.timer)
        clearTimeout(ws.signalTimer)
      }
      for (const res of clients) res.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

if (import.meta.main) {
  const dir = process.env.COCKPIT_DIR ?? path.join(os.homedir(), 'Library/Application Support/cockpit')
  const port = Number(process.env.COCKPIT_PORT ?? 47231)
  const s = createServer({ port, dir, orca: orcaCli(process.env.COCKPIT_ORCA ?? 'orca') })
  s.listen().then((p) => console.error(`cockpit window: http://127.0.0.1:${p}`))
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void s.close().then(() => process.exit(0)))
}
