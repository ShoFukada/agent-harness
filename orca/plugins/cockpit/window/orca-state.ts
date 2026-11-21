// Orca の worktree ps・terminal list・orchestration worker-show から、ワークスペースのメインと worker と、worker の記録の様子を決める。
// 窓の常駐のプロセスと CLI（state.ts）が使う。
import path from 'node:path'
import type { Cockpit } from '../src/model.ts'
import type { AgentRow, DispatchFact, StopReason } from '../src/protocol.ts'

export type PsAgent = {
  paneKey: string
  state: AgentRow['state']
  agentType?: string | null
  conversationName?: string | null
  displayName?: string | null
  taskTitle?: string | null
  stateStartedAt: number
  interrupted?: boolean
  hasLivePty?: boolean
  lastAssistantMessage?: string | null
  mainAgent?: { outcome?: string } | null
  /** チャット（structured-agent-session）なら Orca のセッション。止まった理由（failureKind）をこれで引く。 */
  orcaSessionId?: string | null
}
/**
 * Orca が止まったエージェントについて残した理由（orchestration の escalation の payload の failureKind・detail）。
 * worktree ps・worker-show・dispatch-show には無く、inbox の知らせにだけある（2026-11-21 に確かめた）。session → いちばん新しいもの。
 */
export type Failure = { kind?: string; detail?: string; at: number }
/** orca orchestration inbox --full の 1 通（使う欄だけ）。payload は JSON の文字列。 */
export type InboxMessage = { type?: string; payload?: string | null; created_at?: string }
export function failuresOf(messages: InboxMessage[]): Record<string, Failure> {
  const out: Record<string, Failure> = {}
  for (const m of messages) {
    if (m.type !== 'escalation' || !m.payload?.includes('failureKind')) continue
    let p: { sessionId?: unknown; failureKind?: unknown; detail?: unknown }
    try {
      p = JSON.parse(m.payload)
    } catch {
      continue
    }
    const at = Date.parse(m.created_at ?? '')
    if (typeof p.sessionId !== 'string' || Number.isNaN(at) || at <= (out[p.sessionId]?.at ?? 0)) continue
    out[p.sessionId] = { kind: typeof p.failureKind === 'string' ? p.failureKind : undefined, detail: typeof p.detail === 'string' ? p.detail : undefined, at }
  }
  return out
}
export type PsRow = { worktreeId: string; path: string; parentWorktreeId: string | null; displayName?: string | null; comment?: string | null; agents: PsAgent[] }
// ログイン切れと利用枠は Orca が状態として持たないので、最後の発言の文から推す。
// 長い発言は作業の報告で、文中の「limit」などを拾わないよう短いものだけを見る。
export const SHORT = 400
// bin/stallwatch の LIMIT と同じ形にそろえる（Claude Code の上限の 1 行は「You've hit your 5-hour limit · resets …」「You've reached your Fable limit.」）。
const LIMIT = /usage limit|rate limit|limit reached|out of extra usage|上限に達|hit your [\w -]*limit|reached your [\w -]*limit/i
const AUTH = /\/login|not logged in|authentication_error|oauth token|invalid api key|\b401\b/i

/** 止まった失敗に当たる Orca の知らせ。知らせは失敗のすぐあとに出るので、失敗が始まった時刻の 5 分前より新しいものだけを使う。 */
export const failureOf = (a: PsAgent, failures: Record<string, Failure> = {}): Failure | undefined => {
  const f = a.orcaSessionId ? failures[a.orcaSessionId] : undefined
  return f && f.at >= a.stateStartedAt - 5 * 60_000 ? f : undefined
}

export function stopReason(a: PsAgent, f?: Failure): StopReason | undefined {
  const outcome = a.mainAgent?.outcome
  if (a.hasLivePty === false && (a.state !== 'done' || outcome !== 'success')) return 'dead'
  if (a.state === 'blocked' || a.state === 'waiting') return a.state
  if (a.state !== 'done') return undefined
  // Orca の failureKind（usageLimitReached など）を先に見て、無ければ最後の発言と知らせの detail の文から推す。
  if (outcome === 'failure' && f?.kind && /limit/i.test(f.kind)) return 'limit'
  if (outcome === 'failure' && f?.kind && /auth|login|credential|unauthori/i.test(f.kind)) return 'auth'
  for (const msg of [a.lastAssistantMessage ?? '', outcome === 'failure' ? f?.detail ?? '' : '']) {
    if (msg.length <= SHORT && LIMIT.test(msg)) return 'limit'
    if (msg.length <= SHORT && AUTH.test(msg)) return 'auth'
  }
  if (outcome === 'failure') return 'error'
  if (a.interrupted || outcome === 'interruption') return 'interrupted'
  return undefined
}

/** worker の仕事が分かる 1 行。Orca の表示名は「ブランチ名｜仕事」の形が多いので、｜の後ろを優先する。 */
export function jobOf(row: PsRow): string | undefined {
  const name = row.displayName?.split('｜').slice(1).join('｜').trim() || row.displayName?.trim()
  return name || row.comment?.trim() || undefined
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/**
 * 上限の 1 行の「resets 10:50pm (Asia/Tokyo)」「resets Nov 23 at 4am」から、戻る時刻を 24 時間制で返す（「22:50」「11/23 04:00」）。
 * 読めなければ undefined（時刻を出さない）。
 */
export function resetAt(text: string | null | undefined): string | undefined {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text ?? '')
  if (!m) return undefined
  const h = (Number(m[3]) % 12) + (m[5]!.toLowerCase() === 'pm' ? 12 : 0)
  const mon = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0
  const time = `${String(h).padStart(2, '0')}:${m[4] ?? '00'}`
  return mon ? `${mon}/${Number(m[2])} ${time}` : time
}

function toAgent(a: PsAgent, row: PsRow, terms: Map<string, string>, c: Cockpit | undefined, byTerminal: Map<string, string>, failures?: Record<string, Failure>): AgentRow {
  // どの task の worker かは、メインが記録した Dispatch の端末で引く。記録が無ければ表示名・コメント。
  const terminalId = terms.get(a.paneKey) ?? null
  const taskId = terminalId ? byTerminal.get(terminalId) : undefined
  const task = taskId ? c?.tasks.find((t) => t.id === taskId) : undefined
  const f = failureOf(a, failures)
  const stop = stopReason(a, f)
  const reset = stop === 'limit' ? resetAt(a.lastAssistantMessage) ?? resetAt(f?.detail) : undefined
  return {
    terminalId,
    title: a.conversationName ?? a.displayName ?? a.taskTitle ?? path.basename(row.path),
    agent: a.agentType ?? null, state: a.state, since: a.stateStartedAt, stop, worktree: row.path,
    ...(a.paneKey.startsWith('structured-') && { chat: true }), ...(a.orcaSessionId && { session: a.orcaSessionId }), ...(reset && { reset }),
    job: task?.title ?? jobOf(row), task: task?.id, where: row.comment?.split('｜').slice(1).join('｜').trim() || undefined
  }
}

/** row と、その子孫の worktree（担当の worker は担当の worktree の子＝窓口の孫に立つ）。前面の追従とファイルを開く許可が使う。 */
export function descendants(ps: PsRow[], row: PsRow): PsRow[] {
  const tree = [row]
  for (let i = 0; i < tree.length; i++) tree.push(...ps.filter((r) => r.parentWorktreeId === tree[i]!.worktreeId && !tree.includes(r)))
  return tree
}

/** terms は paneKey → 端末の handle。dispatches は worker の記録の Dispatch の様子（タスクと端末を結ぶ）。 */
export function orcaAgents(root: string, ps: PsRow[], terms: Map<string, string>, c: Cockpit | undefined, dispatches: Record<string, DispatchFact | null> = {}, current: Record<string, string> = {}, failures: Record<string, Failure> = {}): { main?: AgentRow; workers: AgentRow[] } {
  const row = ps.find((r) => r.path === root)
  if (!row) return { workers: [] }
  const byTerminal = new Map<string, string>()
  for (const t of c?.tasks ?? []) {
    const id = t.worker && (current[t.id] ?? t.worker.dispatch_id)
    const term = id && dispatches[id]?.terminal
    if (term) byTerminal.set(term, t.id)
  }
  const tree = descendants(ps, row)
  const all = tree.flatMap((r) => r.agents.map((a) => toAgent(a, r, terms, c, byTerminal, failures)))
  const own = all.filter((a) => a.worktree === root)
  const terminal = c?.main?.terminal
  // メインが端末を開き直して cockpit.json の main が古いときも、本線に 1 つだけいるエージェントはメインと見なす。
  const main = own.find((a) => a.terminalId && a.terminalId === terminal) ?? (own.length === 1 ? own[0] : undefined)
  return { main, workers: all.filter((a) => a !== main) }
}

/** orca orchestration worker-show --full の、使う欄だけ。 */
export type WorkerShow = {
  dispatch?: { completedAt?: string | null; runId?: string | null } | null
  projection?: { stage?: { worker?: string } | null; liveness?: { verdict?: string } | null } | null
  terminal?: { handle?: string | null } | null
  /** チャットの worker は terminal が null で、handle はここにある。 */
  worker?: { agentTerminalHandle?: string | null } | null
  /** endpointIncarnation はチャットの worker なら「structured:<orcaSessionId>」。 */
  terminalResource?: { terminalHandle?: string | null; endpointIncarnation?: string | null } | null
  observation?: { agentWait?: unknown } | null
}

export function dispatchFact(r: WorkerShow): DispatchFact {
  const done = r.dispatch?.completedAt ? Date.parse(r.dispatch.completedAt) : NaN
  const inc = r.terminalResource?.endpointIncarnation
  return {
    state: r.projection?.stage?.worker ?? 'unknown', liveness: r.projection?.liveness?.verdict,
    terminal: r.terminal?.handle ?? r.worker?.agentTerminalHandle ?? r.terminalResource?.terminalHandle ?? null,
    session: inc?.startsWith('structured:') ? inc.slice('structured:'.length) : undefined,
    // agentWait が null なら Orca が見て待っていない。欄が無いのは見ていないだけなので、待っている扱いにしない。
    waiting: !!r.observation?.agentWait, settledAt: Number.isNaN(done) ? undefined : done
  }
}

/** orca orchestration task-list --run の 1 行（使う欄だけ）。終わったタスクは dispatchId を持たない。 */
export type RunTask = { id: string; status: string; dispatchId?: string }
/** orca orchestration dispatch-show --task の、タスクの Dispatch と、それが何の続きか（follow_up_of_dispatch_id）。どちらも変わらない。 */
export type TaskLink = { dispatch: string | null; followUpOf: string | null }
export type Chain = { tasks(run: string): Promise<RunTask[]>; link(task: string): Promise<TaskLink> }

/**
 * worker の記録（run_id と最初の Task）から、今の Dispatch を引く。Run のタスクの Dispatch を follow_up_of で逆向きにつなぎ、
 * 最初の Task の Dispatch から最後の続きまでたどる。follow_up_of は変わらないので cache に覚え、新しいタスクだけを問い合わせる。
 * 返すのは、タスクの id → 今の Dispatch と、Dispatch → Orca のタスクの状態。
 */
export async function currentDispatches(c: Cockpit | undefined, chain: Chain, cache: Map<string, TaskLink>): Promise<{ current: Record<string, string>; status: Record<string, string> }> {
  const live = (c?.tasks ?? []).filter((t) => t.worker?.run_id && t.state !== 'ok')
  const current: Record<string, string> = {}
  const status: Record<string, string> = {}
  for (const run of new Set(live.map((t) => t.worker!.run_id!))) {
    const rows = await chain.tasks(run)
    const links = await Promise.all(rows.map(async (r) => {
      let l = cache.get(r.id)
      if (!l) {
        l = await chain.link(r.id)
        if (l.dispatch) cache.set(r.id, l)
      }
      return [r, l] as const
    }))
    const next = new Map<string, string>()
    const ofTask = new Map<string, string>()
    for (const [r, l] of links) {
      if (!l.dispatch) continue
      ofTask.set(r.id, l.dispatch)
      status[l.dispatch] = r.status
      if (l.followUpOf) next.set(l.followUpOf, l.dispatch)
    }
    for (const t of live.filter((x) => x.worker!.run_id === run)) {
      let d = ofTask.get(t.worker!.task_id)
      for (let n = 0; d && next.has(d) && n < 1000; n++) d = next.get(d)
      if (d) current[t.id] = d
    }
  }
  return { current, status }
}

/** 済んでいないタスクの今の Dispatch を、Orca に問い合わせる。show は Orca に無ければ null を返す。current が無いタスクは版 2 の dispatch_id を使う。 */
export async function orcaDispatches(c: Cockpit | undefined, show: (dispatch: string) => Promise<WorkerShow | null>, current: Record<string, string> = {}, status: Record<string, string> = {}): Promise<Record<string, DispatchFact | null>> {
  const ids = [...new Set((c?.tasks ?? []).filter((t) => t.worker && t.state !== 'ok').map((t) => current[t.id] ?? t.worker!.dispatch_id).filter((x): x is string => !!x))]
  const rows = await Promise.all(ids.map(async (id) => [id, await show(id)] as const))
  return Object.fromEntries(rows.map(([id, r]) => [id, r ? { ...dispatchFact(r), ...(status[id] && { taskStatus: status[id] }) } : null]))
}

/** orca plugin list の 1 行（使う欄だけ）。 */
export type PluginRow = {
  pluginKey: string; status: string; needsReconsent?: boolean; isDev?: boolean
  source?: { reference?: string | null; contentHash?: string | null } | null
  /** フォルダから入れたプラグインの、今のフォルダの中身の hash（orca plugin inspect）。入れた写しの contentHash と比べる。 */
  folderHash?: string | null
}
export const PLUGIN_KEY = 'local.cockpit'

/**
 * 操縦席のプラグインが動いていないときの理由。Orca に合わせた切り替え（focus.json）はプラグインの worker が書くので、止まると窓が前面に追いつかない
 * （2026-11-16 に、開発用の読み込みを消したあと承認待ちになり、理由が分からないまま切り替わらなくなった）。
 */
export function pluginProblem(plugins: PluginRow[], forUser = false): string | undefined {
  const mine = plugins.filter((p) => p.pluginKey === PLUGIN_KEY)
  const dev = mine.find((p) => p.isDev)
  if (dev && forUser) return undefined
  if (dev) return `Orca の操縦席のプラグインが開発用の読み込み（${dev.source?.reference ?? '場所不明'}）に置き換わっています。Orca に合わせた切り替えはその版が受け持ちます`
  const p = mine[0]
  if (!p) return 'Orca に操縦席のプラグインが入っていないため、Orca に合わせた切り替えが止まっています'
  if (p.status === 'pending' || p.needsReconsent) return 'Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています'
  if (p.status !== 'running' && p.status !== 'idle') return `Orca のプラグインが止まっている（${p.status}）ため、Orca に合わせた切り替えが止まっています`
  // Orca はフォルダではなく入れた時点の写しを動かす。main に直しを入れても写しは古いまま（2026-11-16 に 13:17 の写しが前面の知らせを書かなかった）。
  if (!forUser && p.folderHash && p.source?.contentHash && p.folderHash !== p.source.contentHash)
    return 'Orca の操縦席のプラグインが、フォルダの今の中身より古い写しのまま動いています（orca plugin update local.cockpit で入れ直す）'
  return undefined
}
