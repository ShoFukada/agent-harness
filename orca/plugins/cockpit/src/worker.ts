// 開いているワークスペースの .orca/cockpit*.json を読んで見張り、パネルに送る。
// パネルからの操作は cockpit.user.json に追記し、取り消しの猶予が過ぎてメインが入力待ちのときに合図を送る。
// 前面のワークスペースが変わるたびに focus.json を書き、窓の常駐のプロセス（window/server.ts）に知らせる。
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { chatMain, COUNTED, overlay } from './model.ts'
import type { AgentRow, CockpitView, NotifyResult, TalkResult } from './protocol.ts'
import { agentTitle, countsText, derive, isHot, ownerOf } from './state.ts'
import { appendOp, emptyFiles, loadFiles, notifyMain, readNotified, signalPlan, splitLine, writeAtomic, writeNotified, type Files } from './store.ts'

export { SIGNAL } from './store.ts'

/** 窓の常駐のプロセスと共有する場所。テストでは COCKPIT_DIR で差し替える。 */
export const cockpitDir = () => process.env.COCKPIT_DIR ?? path.join(os.homedir(), 'Library/Application Support/cockpit')

/** focus.json の形。window/server.ts が読む。 */
export type Focus = { workspace_id?: string; path?: string; main_terminal?: string; at: string; agents_at?: number }

type State = Files & {
  workspaceId?: string
  root?: string
  agents: AgentRow[]
  watcher?: FSWatcher
  watchingDir?: boolean
  timer?: ReturnType<typeof setTimeout>
  signal?: CockpitView['signal']
  signalTimer?: ReturnType<typeof setTimeout>
}

/** このパネルが書いた操作（root#op_id）。合図は書いた側が先に送る（store.ts の signalPlan）。 */
const mine = new Set<string>()

let orca: OrcaWorkerApi
let s: State = fresh()

function fresh(): State {
  return { ...emptyFiles(), agents: [] }
}

async function load(): Promise<void> {
  // 読んでいる間にワークスペースが切り替わっても、新しい状態に古い中身を混ぜない。
  const st = s
  if (!st.root) return
  Object.assign(st, await loadFiles(st.root, st))
}


async function view(): Promise<CockpitView> {
  const main = s.cockpit?.main?.terminal
  // Orca は undefined を含む値を JSON として受け付けないので、JSON にしたときの形に揃える。
  return structuredJson({
    state: !s.root ? 'no-workspace' : s.missing ? 'missing' : 'ok',
    root: s.root,
    cockpit: s.cockpit,
    log: s.log,
    archive: s.archive,
    figures: s.figures,
    errors: s.errors,
    workers: s.agents.filter((a) => a.terminalId !== main),
    notifiedOp: s.root ? await readNotified(cockpitDir(), s.root) : 0,
    signal: s.signal,
    handoff: s.handoff
  })
}

const structuredJson = <T>(x: T): T => JSON.parse(JSON.stringify(x))

async function publish(): Promise<void> {
  const v = await view()
  orca.panels.post('cockpit.changed', v)
  await status(v)
}

/** Orca の下の帯に、前面の案件の私の番を出す。パネルを開いていなくても、急ぐものがあると分かるように。 */
async function status(v: CockpitView): Promise<void> {
  try {
    if (!v.cockpit || !v.root) return void (await orca.host.call('statusBar.update', { id: 'mine', visible: false }))
    const now = Date.now()
    const d = derive(v.cockpit, v.log, v.archive, v.root, { workers: v.workers }, now)
    const hot = d.queue.some((r) => COUNTED.includes(r.card.kind) && isHot(r.card.due, now))
    await orca.host.call('statusBar.update', {
      id: 'mine', visible: true, text: d.total ? `私の番 ${d.total}` : '私の番なし',
      tone: hot ? 'danger' : d.total ? 'warning' : 'neutral', tooltip: `${v.cockpit.workspace.name}: ${countsText(d.counts, d.total)}`
    })
  } catch (e) {
    orca.log(`statusBar.update failed: ${(e as Error).message}`)
  }
}

let agentsAt: number | undefined
async function writeFocus(): Promise<void> {
  const focus: Focus = { workspace_id: s.workspaceId, path: s.root, main_terminal: s.cockpit?.main?.terminal, at: new Date().toISOString(), agents_at: agentsAt }
  try {
    await writeAtomic(path.join(cockpitDir(), 'focus.json'), JSON.stringify(focus) + '\n')
  } catch (e) {
    orca.log(`focus.json を書けません: ${(e as Error).message}`)
  }
}

function watchRoot(): void {
  s.watcher?.close()
  s.watcher = undefined
  if (!s.root) return
  const root = s.root
  const changed = () => {
    clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      if (s.root !== root) return
      // .orca が後から作られたら、見張る先を .orca に移す。
      if (!s.watchingDir) watchRoot()
      void load().then(autoSignal).then(publish).catch((e) => orca.log(`load failed: ${e}`))
    }, 80)
  }
  try {
    s.watcher = watch(path.join(root, '.orca'), { recursive: true }, changed)
    s.watchingDir = true
  } catch {
    s.watcher = watch(root, (_ev, name) => name === '.orca' && changed())
    s.watchingDir = false
  }
  // 見張れないとき（見張りの上限など）も worker は落とさない。表示は次の切り替えか操作で読み直す。
  s.watcher.on('error', (e: Error) => orca.log(`.orca を見張れません: ${e.message}`))
}

async function refreshAgents(): Promise<void> {
  try {
    const { agents } = await orca.host.call('agents.list')
    s.agents = agents.map((a) => ({
      terminalId: a.terminalId, title: a.title, agent: a.agent, state: a.state, since: a.stateStartedAt,
      stop: a.state === 'blocked' || a.state === 'waiting' ? a.state : undefined
    }))
  } catch (e) {
    orca.log(`agents.list failed: ${(e as Error).message}`)
  }
}

async function focus(workspaceId: string | undefined): Promise<void> {
  if (workspaceId === s.workspaceId && s.root) return
  s.watcher?.close()
  clearTimeout(s.timer)
  clearTimeout(s.signalTimer)
  const st = (s = fresh())
  st.workspaceId = workspaceId
  if (workspaceId) {
    const { workspaces } = await orca.host.call('workspace.list')
    st.root = workspaces.find((w) => w.id === workspaceId)?.path
    if (!st.root) orca.log(`workspace ${workspaceId} が workspace.list にありません`)
  }
  await Promise.all([load(), refreshAgents()])
  // 待つ間に別のワークスペースへ切り替わっていたら、その切り替えに任せる。
  if (s === st) {
    watchRoot()
    await autoSignal()
    await writeFocus()
  }
}

/**
 * 取り消しの猶予が過ぎた操作があれば、メインに合図を送る。入力中の文字と混ざらないよう、メインが作業中（working）の間は送らず、
 * agent.status.changed で入力待ちになったときにもう一度呼ばれる。
 */
async function autoSignal(): Promise<void> {
  const st = s
  clearTimeout(st.signalTimer)
  if (!st.root || !st.cockpit || chatMain(st.cockpit)) return void (st.signal = undefined)
  const root = st.root
  const plan = signalPlan(st.cockpit, st.log, await readNotified(cockpitDir(), root), Date.now(), (o) => mine.has(`${root}#${o.op_id}`))
  if (plan.nextAt !== undefined)
    st.signalTimer = setTimeout(() => void autoSignal().then(publish).catch((e) => orca.log(`signal failed: ${e}`)), plan.nextAt - Date.now() + 50)
  if (!plan.due.length) return void (st.signal = undefined)
  const main = st.agents.find((a) => a.terminalId === st.cockpit?.main?.terminal)
  if (!main) return void (st.signal = { state: 'failed', reason: 'メインのエージェントが見つかりません' })
  if (main.state === 'working') return void (st.signal = { state: 'waiting' })
  const r = await notify()
  st.signal = r.sent ? undefined : { state: 'failed', reason: r.reason }
}

async function notify(): Promise<NotifyResult> {
  const st = s
  const result = await notifyMain(st.cockpit, st.log, async (terminal, text) => {
    const ctx = await orca.host.call('workspace.readContext')
    if (!ctx?.terminals.some((t) => t.id === terminal)) return { sent: false, reason: 'メインの端末が見つかりません' }
    const { accepted } = await orca.host.call('terminal.sendText', { terminalId: terminal, text, enter: true })
    return accepted ? { sent: true } : { sent: false, reason: 'メインの端末が受け取りませんでした' }
  })
  if (result.lastOp !== undefined && st.root) await writeNotified(cockpitDir(), st.root, result.lastOp)
  return result.sent ? { sent: true } : { sent: false, reason: result.reason }
}

export default function activate(api: OrcaWorkerApi): void {
  orca = api
  s = fresh()
  let ready: Promise<void> | undefined
  const ensure = () =>
    (ready ??= orca.host.call('workspace.readContext').then((ctx) => focus(ctx?.workspaceId)))

  orca.events.on('workspace.changed', async ({ context }) => {
    ready = focus(context?.workspaceId)
    await ready
    await publish()
  })
  orca.events.on('agent.status.changed', async () => {
    await ensure()
    await refreshAgents()
    await autoSignal()
    await publish()
    // 窓は agents_at の変化を見て、全ワークスペースのエージェントを読み直す。
    agentsAt = Date.now()
    await writeFocus()
  })

  orca.panels.handle('cockpit.get', async () => {
    await ensure()
    return view()
  })
  orca.panels.handle('cockpit.op', async (input) => {
    await ensure()
    const st = s
    if (!st.root) throw Object.assign(new Error('表示中のワークスペースが変わりました。もう一度押してください'), { code: 'conflict' })
    st.log = await appendOp(st.root, st.cockpit, input)
    mine.add(`${st.root}#${st.log.ops.at(-1)!.op_id}`)
    await autoSignal()
    const v = await view()
    orca.panels.post('cockpit.changed', v)
    return { view: v }
  })
  orca.panels.handle('cockpit.notify', async () => {
    await ensure()
    const result = await notify()
    s.signal = result.sent ? undefined : { state: 'failed', reason: result.reason }
    await publish()
    return result
  })
  orca.panels.handle('cockpit.open', async ({ path: href }) => {
    await ensure()
    if (!s.workspaceId || !s.root) return { opened: false, reason: '表示中のワークスペースが分かりません' }
    // パネルの editor.open は行を受けないので、path:行 の行は捨ててファイルだけ開く。
    const target = await resolveOpen(s.root, s.workspaceId, href)
    if (!target) return { opened: false, reason: `ワークスペースの中にファイルが見つかりません: ${href}` }
    await orca.host.call('editor.open', target)
    return { opened: true }
  })
  orca.panels.handle('cockpit.talk', async ({ root, item_id, item_rev }) => {
    await ensure()
    const st = s
    const conflict = (msg: string) => Object.assign(new Error(msg), { code: 'conflict' })
    if (st.root !== root) throw conflict('表示中のワークスペースが変わりました。もう一度押してください')
    const card = st.cockpit?.cards.find((c) => c.id === item_id)
    if (!st.root || !st.cockpit || !card) throw conflict('カードが見つかりません')
    if (card.rev !== item_rev) throw conflict(`「${card.title}」は担当が書き換えました。読み直してからもう一度押してください`)
    const o = ownerOf(st.cockpit, card, { workers: st.agents })
    const name = o.how === 'main' ? '窓口' : o.title
    let res: TalkResult
    if (o.terminal) {
      const { focused } = await orca.host.call('terminal.focus', { terminalId: o.terminal }).catch(() => ({ focused: false }))
      // パネルは Dispatch を読まないので、チャットの担当の handle（structworker_…）は端末として前に出せない。
      res = focused ? { opened: true, how: `${name}の端末` }
        : { opened: false, how: `${name}の端末`, reason: `${o.how === 'main' ? '窓口' : `担当「${name}」`}の端末を Orca が前に出せませんでした。窓の「担当と話す」か、Orca のサイドバーから開いてください` }
    } else {
      // Orca にはチャットを前に出す手段が無い。パネルは前面のワークスペースにいるので、チャットはそのタブにある。
      res = { opened: false, how: 'このワークスペース', tab: o.how === 'main' ? '窓口' : agentTitle(o.title, '担当') }
    }
    // 開けないのに話し中の印を付けると、誰とも話していないのに話し中に見える。
    const now = overlay(st.cockpit, st.log).find((v) => v.card.id === card.id)
    if (!res.reason && now?.status === 'mine' && !now.talking && card.kind !== 'report') {
      st.log = await appendOp(st.root, st.cockpit, { root: st.root, item_id: card.id, item_rev: card.rev, type: 'talk' })
      mine.add(`${st.root}#${st.log.ops.at(-1)!.op_id}`)
      await autoSignal()
      await publish()
    }
    return res
  })
  orca.panels.handle('cockpit.focus', async ({ terminalId }) => {
    const { focused } = await orca.host.call('terminal.focus', { terminalId }).catch(() => ({ focused: false }))
    return { focused, how: '端末' }
  })
}

/**
 * 開いてよいファイルか確かめ、開くワークスペースを決める。相対パスは表示中のワークスペースから。絶対パスは、
 * 表示中のワークスペースか、同じリポジトリ（projectId）の worktree の中だけ（worker のブランチの成果物）。
 */
async function resolveOpen(root: string, workspaceId: string, href: string): Promise<{ workspaceId: string; path: string } | undefined> {
  const file = splitLine(href.startsWith('file://') ? fileURLToPath(href) : href).file
  const candidates: { id: string; path: string }[] = [{ id: workspaceId, path: root }]
  if (path.isAbsolute(file)) {
    const { workspaces } = await orca.host.call('workspace.list')
    const project = workspaces.find((w) => w.id === workspaceId)?.projectId
    if (project) candidates.push(...workspaces.filter((w) => w.projectId === project && w.kind === 'worktree' && w.id !== workspaceId))
  }
  const real = await fsp.realpath(path.resolve(root, file)).catch(() => '')
  if (!real) return undefined
  for (const w of candidates) {
    const base = await fsp.realpath(w.path).catch(() => '')
    if (base && real.startsWith(base + path.sep) && (await fsp.stat(real)).isFile()) return { workspaceId: w.id, path: real }
  }
  return undefined
}


export function deactivate(): void {
  s.watcher?.close()
  clearTimeout(s.timer)
  clearTimeout(s.signalTimer)
}
