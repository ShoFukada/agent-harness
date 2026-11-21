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
import { chatMain, type Op, type OpType } from '../src/model.ts'
import type { CockpitView, DispatchFact, NotifyResult, OpInput, WindowView, WsRow } from '../src/protocol.ts'
import { derive } from '../src/state.ts'
import { orcaAgents, orcaDispatches, PLUGIN_KEY, pluginProblem, SHORT, type PluginRow, type PsAgent, type PsRow, type WorkerShow } from './orca-state.ts'
export { jobOf, stopReason, type PluginRow, type PsAgent, type PsRow } from './orca-state.ts'
import { buildPrompt, claudeCli, FAILED_TEXT, parseAnswer, type Ask } from './assistant.ts'
import { appendOp, appendReply, emptyFiles, loadFiles, notifyMain, readNotified, signalPlan, splitLine, writeNotified, type Files } from '../src/store.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const SERVED = new Set(['window/page.ts', 'src/controller.ts', 'src/model.ts', 'src/morph.ts', 'src/nav.ts', 'src/sanitize.ts', 'src/state.ts', 'src/style.ts', 'src/view.ts', 'src/window-view.ts'])
const OP_TYPES: OpType[] = ['decide', 'ack', 'approve_ask', 'accept', 'talk', 'need_context', 'undo', 'revert', 'repeat']
/** ページが表示されている間に Orca の状態を確かめる間隔。プロセスが落ちた worker は Orca から知らせが来ないため。 */
const POLL_MS = 60_000
const REFRESH_GAP_MS = 5_000

export type TerminalRow = { handle: string; tabId: string; leafId: string }

export type Orca = {
  ps(): Promise<PsRow[]>
  terminals(): Promise<TerminalRow[]>
  plugins(): Promise<PluginRow[]>
  /** orchestration worker-show --full。Dispatch が Orca に無ければ null。 */
  show(dispatch: string): Promise<WorkerShow | null>
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
        let json: { ok?: boolean; result?: Record<string, unknown>; error?: { message?: string; code?: string } } | undefined
        try {
          json = JSON.parse(out)
        } catch {
          return reject(new Error(err?.message ?? 'orca の出力を読めません'))
        }
        if (err || json?.ok === false) return reject(Object.assign(new Error(json?.error?.message ?? err?.message ?? 'orca が失敗しました'), { code: json?.error?.code }))
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
    show: (dispatch) =>
      run(['orchestration', 'worker-show', '--dispatch', dispatch, '--full']).then(
        (r) => r as WorkerShow,
        (e: Error & { code?: string }) => {
          if (e.code === 'dispatch_not_found') return null
          throw e
        }
      ),
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
  /** アシスタントが答えている途中の talk の op_id。 */
  thinking?: Set<number>
}

type Focus = { path?: string; agents_at?: number }
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** ask: 話したいに答える関数（既定は手元の claude CLI）。null なら答えない。 */
export type Options = { port: number; dir: string; orca: Orca; host?: string; ask?: Ask | null }
/** これより古い発言には、起動し直したときに答え直さない（まとめて CLI を何本も起こさない）。 */
const ANSWER_WINDOW_MS = 10 * 60_000

export function createServer(opts: Options) {
  const token = randomBytes(24).toString('base64url')
  const { orca } = opts
  let port = opts.port
  const wss = new Map<string, Ws>()
  let ps: PsRow[] = []
  let terms = new Map<string, string>()
  /** ワークスペースの root → worker の記録の Dispatch の様子。まだ読んでいなければ無い。 */
  const facts = new Map<string, Record<string, DispatchFact | null>>()
  let orcaError: string | undefined
  let pluginNote: string | undefined
  let alerts: string[] = []
  let focus: Focus = {}
  let mode: WindowView['mode'] = 'follow'
  let manual: string | undefined
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
  const selected = () => (mode === 'manual' ? manual : followRoot())

  const agentsOf = (root: string, files: Files) => orcaAgents(root, ps, terms, files.cockpit, facts.get(root))
  const workersOf = (root: string, files: Files) => agentsOf(root, files).workers

  async function cockpitView(root: string | undefined): Promise<CockpitView> {
    const ws = root ? wss.get(root) : undefined
    const files = ws?.files ?? emptyFiles()
    return {
      state: !root ? 'no-workspace' : files.missing ? 'missing' : 'ok',
      root, cockpit: files.cockpit, log: files.log, archive: files.archive, figures: files.figures, errors: files.errors,
      workers: root ? workersOf(root, files) : [], dispatches: root ? facts.get(root) : undefined, notifiedOp: root ? await readNotified(opts.dir, root) : 0, signal: ws?.signal,
      replies: files.replies, thinking: ws?.thinking?.size ? [...ws.thinking] : undefined, handoff: files.handoff
    }
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

  function rows(): WsRow[] {
    const list: WsRow[] = []
    for (const ws of wss.values()) {
      const c = ws.files.cockpit
      if (!c) continue
      const workers = workersOf(ws.root, ws.files)
      const dispatches = facts.get(ws.root)
      const d = derive(c, ws.files.log, ws.files.archive, dispatches && { workers, dispatches })
      const next = d.open[0]
      list.push({
        root: ws.root, name: c.workspace.name, open: d.open.length, due: next?.due, counts: d.counts,
        next: next && { id: next.id, title: next.title }, workers: workers.length, stopped: workers.filter((a) => a.stop).length
      })
    }
    const hot = (r: WsRow) => r.open > 0 || r.stopped > 0
    const due = (r: WsRow) => (r.due ? new Date(r.due).getTime() || Infinity : Infinity)
    return list.sort((a, b) =>
      Number(hot(b)) - Number(hot(a)) || (hot(a) ? due(a) - due(b) : 0) || a.name.localeCompare(b.name, 'ja'))
  }

  async function windowView(): Promise<WindowView> {
    const live = ps.flatMap((r) => r.agents).filter((a) => a.hasLivePty === true || (a.hasLivePty !== false && a.state !== 'done')).length
    return { mode, focused: followRoot(), rows: rows(), live, view: await cockpitView(selected()), errors: [orcaError, pluginNote, ...alerts].filter((e): e is string => !!e) }
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
    answerPending(ws)
  }

  // ── 話したいへの回答 ──
  const ask = opts.ask === undefined ? claudeCli() : opts.ask
  /** 1 度答えに行った発言（root#op_id）。失敗しても同じ発言に何度も CLI を起こさない。 */
  const tried = new Set<string>()
  /** CLI は 1 本ずつ起こす（メモリを 1 回分に抑える）。 */
  let asking: Promise<void> = Promise.resolve()

  /** まだ回答の無い、最近の話したいの発言に答える。パネルが書いた発言もここで拾う。 */
  function answerPending(ws: Ws): void {
    const c = ws.files.cockpit
    if (!ask || !c) return
    const answered = new Set(ws.files.replies.map((r) => r.op_id))
    for (const o of ws.files.log.ops) {
      const key = `${ws.root}#${o.op_id}`
      if (o.type !== 'talk' || !o.text || o.to_main || answered.has(o.op_id) || tried.has(key)) continue
      if (Date.now() - Date.parse(o.at) > ANSWER_WINDOW_MS) continue
      tried.add(key)
      ;(ws.thinking ??= new Set()).add(o.op_id)
      asking = asking.then(() => answer(ws, o, ask))
    }
  }

  async function answer(ws: Ws, o: Op, run: Ask): Promise<void> {
    broadcast()
    let reply
    try {
      const a = parseAnswer(await run(buildPrompt(ws.files.cockpit!, o, ws.files.log.ops, ws.files.replies), ws.root))
      reply = { op_id: o.op_id, at: new Date().toISOString(), by: 'assistant' as const, text: a.text, ...(a.handoff ? { handoff: true } : {}) }
    } catch (e) {
      console.error(`answer ${ws.root}#${o.op_id}: ${(e as Error).message}`)
      reply = { op_id: o.op_id, at: new Date().toISOString(), by: 'assistant' as const, text: FAILED_TEXT, failed: true }
    }
    try {
      ws.files = { ...ws.files, replies: await appendReply(ws.root, reply) }
    } catch (e) {
      console.error(`reply ${ws.root}#${o.op_id}: ${(e as Error).message}`)
    }
    ws.thinking?.delete(o.op_id)
    broadcast()
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
    const sel = selected()
    if (sel) want.add(sel)
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
    }))
  }

  function refreshOrca(): Promise<void> {
    return (refreshing ??= (async () => {
      try {
        const [rowsNow, tl, plugins] = await Promise.all([orca.ps(), orca.terminals(), orca.plugins().catch(() => undefined)])
        pluginNote = plugins && pluginProblem(plugins)
        ps = rowsNow
        terms = new Map(tl.map((t) => [`${t.tabId}:${t.leafId}`, t.handle]))
        for (const ws of wss.values()) if (ws.files.cockpit) facts.set(ws.root, await orcaDispatches(ws.files.cockpit, orca.show))
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
    if (moved) {
      mode = 'follow'
      manual = undefined
      await sync()
      broadcast()
    }
    if (agents) {
      refreshSoon()
      // メインが作業中で合図を待たせていたら、入力待ちになったかを確かめて送る。
      for (const ws of wss.values()) if (ws.signal) void autoSignal(ws).then(broadcast, (e) => console.error(e))
    }
  }

  async function readAlerts(): Promise<void> {
    let next: string[] = []
    try {
      const d = JSON.parse(await fsp.readFile(path.join(opts.dir, 'alerts.json'), 'utf8')) as { alerts?: { text?: unknown }[] }
      next = (d.alerts ?? []).map((a) => a.text).filter((t): t is string => typeof t === 'string').map((t) => `止まっている: ${t}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return void console.error(`alerts.json: ${(e as Error).message}`)
    }
    if (next.join('\n') === alerts.join('\n')) return
    alerts = next
    broadcast()
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
        target: typeof b.target === 'number' ? b.target : undefined,
        text: typeof b.text === 'string' ? b.text : undefined, to_main: b.to_main === true ? true : undefined,
        handoff_of: typeof b.handoff_of === 'number' ? b.handoff_of : undefined
      }
      const log = await appendOp(ws.root, ws.files.cockpit, input)
      mine.add(`${ws.root}#${log.ops.at(-1)!.op_id}`)
      ws.files = { ...ws.files, log }
      answerPending(ws)
      broadcast()
      await autoSignal(ws)
      return { view: await cockpitView(ws.root) }
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
    async select(b) {
      if (b.root === undefined) {
        mode = 'follow'
        manual = undefined
      } else {
        mode = 'manual'
        manual = knownWs(b.root).root
      }
      await sync()
      broadcast()
      return { ok: true }
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
        if (name === 'alerts.json') return void readAlerts()
        if (name !== 'focus.json') return
        clearTimeout(focusTimer)
        focusTimer = setTimeout(() => void readFocus(), 30)
      })
      await readFocus()
      await readAlerts()
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
      await asking
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
