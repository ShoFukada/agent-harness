// カードの状態・私の番の並び・件数・案件の今（仕事ごとの状態）を決める 1 か所。窓・パネル・hook とメインが読む CLI（window/state.ts）はここを通す。
// 手書きの値を事実の代わりに出すと、画面とメインの認識が事実と食い違ったため（2026-11-16）。
import {
  COUNTED, KIND_LABEL, overlay, shownTask, unappliedOps, worstState,
  type Card, type CardKind, type CardView, type Cockpit, type Milestone, type Owner, type Stream, type Task, type TaskShown, type TaskState, type UserLog
} from './model.ts'
import type { AgentRow, OwnerLive, StopReason } from './protocol.ts'

export const STOP_LABEL: Record<StopReason, string> = {
  blocked: '許可待ち', waiting: '返事待ち', interrupted: '中断', error: 'エラー', dead: '落ちた', auth: 'ログイン切れ', limit: '利用枠切れ'
}
/** 私が答えれば進むか。進まないものは私では直せない（立て直し・待つ）。 */
const STOP_UNBLOCK: Record<StopReason, [boolean, string]> = {
  blocked: [true, '端末で許可すれば進む'],
  waiting: [true, '質問に答えれば進む'],
  auth: [true, 'ログインし直せば進む'],
  dead: [false, 'プロセスが落ちた。担当が立て直す'],
  limit: [false, '利用枠が戻るまで止まる'],
  error: [false, '担当が見直す'],
  interrupted: [false, '担当が見直す']
}

const WEEK = '日月火水木金土'
/** ISO 8601 の日付・日時を「11/19(水) 18:00」にする。読めなければそのまま出す。 */
export function fmtDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const day = `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`
  return iso.length > 10 ? `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : day
}
export const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export const dueAt = (iso: string) => new Date(iso.length > 10 ? iso : `${iso}T23:59:59`).getTime()
export const isOver = (iso: string | undefined, now: number) => {
  if (!iso) return false
  const t = dueAt(iso)
  return !Number.isNaN(t) && t < now
}
const dayOf = (t: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
const DAY = 86_400_000

/** 今日以降の節目を近い順に。left は今日からの日数（0 が今日）。 */
export function upcomingMilestones(ms: Milestone[] | undefined, now: number): (Milestone & { left: number })[] {
  return (ms ?? [])
    .map((m) => ({ ...m, t: new Date(m.date.length > 10 ? m.date : `${m.date}T00:00:00`).getTime() }))
    .filter((m) => !Number.isNaN(m.t) && dayOf(m.t) >= dayOf(now))
    .sort((a, b) => a.t - b.t)
    .map(({ t, ...m }) => ({ ...m, left: Math.round((dayOf(t) - dayOf(now)) / DAY) }))
}

/** 期限の区切り。1 列の見出しになる。止まっているもの（詰まり）は期限に関係なく先頭に置く。 */
export type Bucket = 'stuck' | 'over' | 'today' | 'tomorrow' | 'week' | 'later' | 'none'
export const BUCKET_LABEL: Record<Bucket, string> = { stuck: '止まっている', over: '期限切れ', today: '今日', tomorrow: '明日', week: '今週', later: 'それより先', none: '期限なし' }
export function bucketOf(due: string | undefined, now: number, kind?: CardKind): Bucket {
  if (kind === 'stuck') return 'stuck'
  if (!due) return 'none'
  const t = dueAt(due)
  if (Number.isNaN(t)) return 'none'
  if (t < now) return 'over'
  const days = Math.round((dayOf(t) - dayOf(now)) / DAY)
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' : days < 7 ? 'week' : 'later'
}
/** 期限まで 24 時間を切ったか過ぎた。朱で出すのはこれだけ。 */
export const isHot = (due: string | undefined, now: number) => !!due && !Number.isNaN(dueAt(due)) && dueAt(due) - now < DAY

/** Orca から分かること。パネルは worktree の一覧と担当の今を持たない。 */
export type OrcaFacts = { workers: AgentRow[]; worktrees?: string[]; owners?: OwnerLive[] }

/** カードの話し相手。担当が無い仕事は案件の窓口（main）。 */
export type OwnerRef = {
  title: string
  how: 'chat' | 'terminal' | 'main'
  owner?: Owner
  /** Orca での今（作業中・入力待ち など）。分からなければ無い。 */
  state?: AgentRow['state']
  terminal?: string
}

/** 1 列の 1 行。Orca から作った詰まり（synthetic）は cockpit.json に無い。 */
export type Row = CardView & {
  root: string
  ws: string
  owner: OwnerRef
  stream?: Stream
  agent?: AgentRow
}

export type TaskView = TaskShown & { task: Task }
/** 案件の今の 1 行（仕事ごと）。 */
export type JobState = 'mine' | 'stopped' | 'working' | 'customer' | 'idle' | 'done'
export const JOB_LABEL: Record<JobState, string> = { mine: '私待ち', stopped: '止まっている', working: '作業中', customer: '顧客待ち', idle: '未着手', done: '済' }
/**
 * Orca のサイドバーの作業場所の状態。窓の「案件の今」と同じ判定から決め、窓口が orca worktree set でそろえる
 * （窓とサイドバーで同じ仕事が違う状態に見えないように）。私待ちは in-review にし、未読の印も付ける。
 */
export type OrcaStatus = 'todo' | 'in-progress' | 'in-review' | 'completed'
export const ORCA_STATUS: Record<JobState, OrcaStatus> = { mine: 'in-review', stopped: 'in-progress', working: 'in-progress', customer: 'in-progress', idle: 'todo', done: 'completed' }
/** サイドバーは 20 文字ほどで切れる。仕事の名前はこれ以内にし、何の仕事かを先頭に置く。 */
export const NAME_MAX = 20
/** 端末とチャットの題。窓口は「窓口（<案件の役割>）」。 */
export const agentTitle = (name: string, role: 'worker' | '担当') => `${name}（${role}）`

export type JobView = { id: string; title: string; state: JobState; label: string; next?: string; mine: number; owner?: OwnerRef; since?: string }

export type Counts = Record<CardKind, number>
export type Derived = {
  views: CardView[]
  /** 私の番（届いたも含む）。期限順。 */
  queue: Row[]
  talking: Row[]
  waiting: Row[]
  reports: Row[]
  /** 片付いたもの（新しい順）。 */
  closed: Row[]
  counts: Counts
  /** 件数に数える 5 種類の合計。 */
  total: number
  tasks: Map<string, TaskView>
  jobs: JobView[]
}

const RANK: Record<CardKind, number> = { stuck: 0, permit: 1, decide: 2, send: 3, review: 4, inbox: 5, talk: 6, report: 7 }
const dueKey = (r: Row) => (r.card.kind === 'stuck' ? -Infinity : r.card.due ? dueAt(r.card.due) || Infinity : Infinity)
export const byUrgency = (a: Row, b: Row) => dueKey(a) - dueKey(b) || RANK[a.card.kind] - RANK[b.card.kind] || (a.card.at ?? '').localeCompare(b.card.at ?? '')

export function ownerOf(c: Cockpit, card: Pick<Card, 'owner' | 'stream'>, facts?: OrcaFacts): OwnerRef {
  const own = c.owners?.find((o) => o.id === card.owner) ?? c.owners?.find((o) => o.stream && o.stream === card.stream && o.state !== 'done')
  if (own) {
    const live = own.session ? facts?.owners?.find((x) => x.session === own.session) : undefined
    const term = own.terminal ? facts?.workers.find((w) => w.terminalId === own.terminal) : undefined
    return { title: own.title, how: own.terminal ? 'terminal' : 'chat', owner: own, state: term?.state ?? live?.state, terminal: own.terminal }
  }
  return { title: '窓口', how: 'main', terminal: c.main?.terminal || undefined }
}

/** Orca で止まっている worker を、詰まりの行にする。メインが同じタスクの詰まりを書いていれば、そちらを出す。 */
function stuckRows(c: Cockpit, root: string, facts: OrcaFacts | undefined, written: Set<string>): Row[] {
  return (facts?.workers ?? [])
    .filter((a) => {
      if (!a.stop) return false
      // メインが書いた詰まりと同じ仕事（タスクか、担当の端末で引く）なら、そちらを出す。
      const stream = c.tasks.find((t) => t.id === a.task)?.stream ?? c.owners?.find((o) => o.terminal && o.terminal === a.terminalId)?.stream
      return !(a.task && written.has(a.task)) && !(stream && written.has(stream))
    })
    .map((a) => {
      const [answerable, unblock] = STOP_UNBLOCK[a.stop!]
      const task = c.tasks.find((t) => t.id === a.task)
      const ownStream = c.owners?.find((o) => o.terminal && o.terminal === a.terminalId)?.stream
      // 仕事の名前は Orca のサイドバーと同じもの（仕事の題）を先にする。
      const name = c.streams.find((s) => s.id === (task?.stream ?? ownStream))?.title ?? a.job ?? a.title ?? 'worker'
      const card: Card = {
        id: `#agent:${a.terminalId ?? a.worktree ?? a.title}`, rev: 0, kind: 'stuck', state: 'open',
        title: `${name} が${STOP_LABEL[a.stop!]}`, since: new Date(a.since).toISOString(),
        reason: STOP_LABEL[a.stop!], answerable, unblock, stream: task?.stream, tasks: task ? [task.id] : undefined
      }
      return { card, status: 'mine' as const, pending: false, root, ws: c.workspace.name, owner: { title: name, how: 'terminal' as const, state: a.state, terminal: a.terminalId ?? undefined }, stream: c.streams.find((s) => s.id === task?.stream), agent: a }
    })
}

const CLOSED_DAYS = 14

export function derive(c: Cockpit, log: UserLog, archive: Card[], root: string, facts: OrcaFacts | undefined, now: number): Derived {
  const views = overlay(c, log, archive)
  const row = (v: CardView): Row => ({ ...v, root, ws: c.workspace.name, owner: ownerOf(c, v.card, facts), stream: c.streams.find((s) => s.id === v.card.stream) })
  const rows = views.map(row)
  const written = new Set(c.cards.filter((x) => x.kind === 'stuck' && x.state === 'open').flatMap((x) => [...(x.tasks ?? []), ...(x.stream ? [x.stream] : [])]))
  const mine = rows.filter((r) => r.status === 'mine' && r.card.kind !== 'report')
  const queue = [...mine, ...stuckRows(c, root, facts, written)].sort(byUrgency)
  const counts = Object.fromEntries(Object.keys(RANK).map((k) => [k, 0])) as Counts
  for (const r of queue) counts[r.card.kind]++
  const total = COUNTED.reduce((n, k) => n + counts[k], 0)
  const recent = (r: Row) => !r.when || now - Date.parse(r.when) < CLOSED_DAYS * DAY
  const closed = rows.filter((r) => r.status === 'closed' && recent(r)).sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''))

  const alive = facts?.worktrees && new Set(facts.worktrees)
  const tasks = new Map<string, TaskView>()
  for (const t of c.tasks) {
    const agents = (facts?.workers ?? []).filter((w) => w.task === t.id)
    tasks.set(t.id, { ...shownTask(t, agents, alive && !!t.worker && alive.has(t.worker.worktree_id)), task: t })
  }
  return {
    views, queue, counts, total, tasks, closed,
    talking: rows.filter((r) => r.status === 'talking').sort(byUrgency),
    waiting: rows.filter((r) => r.status === 'waiting').sort((a, b) => (a.card.awaiting?.since ?? '').localeCompare(b.card.awaiting?.since ?? '')),
    reports: rows.filter((r) => r.status === 'mine' && r.card.kind === 'report').sort((a, b) => (b.card.at ?? '').localeCompare(a.card.at ?? '')),
    jobs: jobViews(c, tasks, queue, rows, facts)
  }
}

/** 仕事ごとの今。済んだ仕事は後ろに回す。メインの書いた要約は使わず、タスクとカードから決める。 */
function jobViews(c: Cockpit, tasks: Map<string, TaskView>, queue: Row[], rows: Row[], facts: OrcaFacts | undefined): JobView[] {
  const order: Record<JobState, number> = { mine: 0, stopped: 1, working: 2, customer: 3, idle: 4, done: 5 }
  return c.streams
    .map((s): JobView => {
      const ts = [...tasks.values()].filter((t) => t.task.stream === s.id)
      const mine = queue.filter((r) => r.card.stream === s.id && COUNTED.includes(r.card.kind)).length
      const waiting = rows.find((r) => r.status === 'waiting' && r.card.stream === s.id)
      const live = ts.filter((t) => t.state !== 'ok')
      const worst: TaskState | undefined = worstState(live.map((t) => t.state))
      const ext = live.find((t) => t.state === 'wait' && t.task.waiting_on?.trim())
      const state: JobState = mine ? 'mine'
        : worst === 'stop' ? 'stopped'
        : worst === 'run' ? 'working'
        : waiting || ext ? 'customer'
        : worst === 'idle' || worst === 'wait' ? 'idle'
        : 'done'
      const who = waiting?.card.awaiting?.who ?? ext?.task.waiting_on
      const label = state === 'customer' && who ? `${who}の返事待ち` : state === 'mine' ? `私待ち ${mine} 件` : JOB_LABEL[state]
      const nextTask = live.find((t) => t.state === worst) ?? live[0]
      return {
        id: s.id, title: s.title, state, label, mine,
        next: state === 'done' ? undefined : nextTask?.task.next?.trim() || nextTask?.task.title,
        owner: c.owners?.some((o) => o.stream === s.id && o.state !== 'done') ? ownerOf(c, { stream: s.id }, facts) : undefined,
        since: waiting?.card.awaiting?.since ?? ext?.task.waiting_since
      }
    })
    .sort((a, b) => order[a.state] - order[b.state])
}

export function countsText(n: Counts, total: number): string {
  if (!total) return '私の番はありません'
  const parts = COUNTED.filter((k) => n[k]).map((k) => `${KIND_LABEL[k]} ${n[k]}`)
  return `私の番 ${total} 件（${parts.join('・')}）`
}

/** 経路（Slack・Teams・メール）が読めていないか。見張りが書いた時刻が古い・失敗している。 */
export function routeProblem(r: NonNullable<Cockpit['routes']>[number], now: number): string | undefined {
  if (r.error) return `${r.label}: ${r.error}`
  if (!r.read_at) return `${r.label}: まだ読んでいない`
  const t = Date.parse(r.read_at)
  if (Number.isNaN(t) || now - t > (r.stale_minutes ?? 120) * 60_000) return `${r.label}: ${fmtDate(r.read_at)} から読めていない`
  return undefined
}

/** 状態の CLI（window/state.ts）の出力。hook（periodic-reminder.sh）は workspace・overview・checks を読む。 */
export type StateReport = {
  workspace: string
  orca: 'ok' | 'skipped' | 'error'
  counts: Counts & { total: number }
  next?: { id: string; kind: CardKind; title: string; due?: string }
  overdue: string[]
  talking: string[]
  waiting: { id: string; who: string; what: string; since: string; remind_at?: string }[]
  /** orca は Orca のサイドバーに出す形（表示名・状態・未読の印）。担当の作業場所に当てる。 */
  jobs: { id: string; title: string; state: JobState; label: string; next?: string; orca: { display_name: string; status: OrcaStatus; unread: boolean } }[]
  tasks: { id: string; title: string; state: TaskState; from: TaskShown['why'] }[]
  workers: { task?: string; job?: string; state: string; stop?: StopReason }[]
  checks: {
    pending_ops: number
    /** 決めるのに「これは何か」など 5 欄が欠けたカード。 */
    missing_context: string[]
    /** 催促の日を過ぎた顧客待ち（担当が「送る前」に催促の下書きを出す）。 */
    remind_due: string[]
    /** 仕事にも担当にもつながらない開いたカード。 */
    orphan_cards: string[]
    intake: string[]
    missing_workers: string[]
    /** 進行中のタスクが無く、push の許すも開いていない（hook が git を見て、残りがあれば push を聞かせる）。 */
    push_check: boolean
    plugin: string | null
    /** 読めていない経路。 */
    routes: string[]
    /** サイドバーで切れる長さの仕事・担当の名前（NAME_MAX を超える）。 */
    long_names: string[]
  }
  /** 全体の 1 行（hook が発言のたびにメインに流す）。 */
  overview: string
  /** ワークスペースのカードのコメント（orca worktree set --comment）。 */
  card: string
}

const INTAKE_GRACE_MS = 10 * 60_000
const PUSH_LATER_MS = 12 * 3_600_000
const CONTEXT_KEYS = ['what', 'now', 'how', 'gain', 'cost'] as const

export function report(c: Cockpit, log: UserLog, archive: Card[], facts: OrcaFacts | undefined, orcaState: StateReport['orca'], now: number, plugin?: string): StateReport {
  const d = derive(c, log, archive, '', facts, now)
  const tasks = [...d.tasks.values()]
  const running = tasks.filter((t) => t.why === 'working')
  const names = (xs: string[]) => (xs.length ? `（${xs.join(' / ')}）` : '')
  const next = d.queue.find((r) => COUNTED.includes(r.card.kind))
  const intake = tasks.filter((t) => t.why === 'intake' && (() => {
    const ags = (facts?.workers ?? []).filter((w) => w.task === t.task.id)
    return !ags.length || now - Math.max(...ags.map((a) => a.since)) >= INTAKE_GRACE_MS
  })())
  const pushOpen = c.cards.some((x) => x.kind === 'permit' && x.scope === 'push' && (x.state === 'open' || (x.resolved_option === 'later' && now - Date.parse(x.resolved_at ?? '0') < PUSH_LATER_MS)))
  const open = c.cards.filter((x) => x.state === 'open')
  return {
    workspace: c.workspace.name,
    orca: orcaState,
    counts: { ...d.counts, total: d.total },
    next: next && { id: next.card.id, kind: next.card.kind, title: next.card.title, due: next.card.due },
    overdue: d.queue.filter((r) => isOver(r.card.due, now)).map((r) => r.card.id),
    talking: d.talking.map((r) => r.card.id),
    waiting: d.waiting.map((r) => ({ id: r.card.id, who: r.card.awaiting?.who ?? '', what: r.card.awaiting?.what ?? r.card.title, since: r.card.awaiting?.since ?? '', remind_at: r.card.awaiting?.remind_at })),
    jobs: d.jobs.map((j) => ({ id: j.id, title: j.title, state: j.state, label: j.label, next: j.next, orca: { display_name: j.title, status: ORCA_STATUS[j.state], unread: j.state === 'mine' } })),
    tasks: tasks.map((t) => ({ id: t.task.id, title: t.task.title, state: t.state, from: t.why })),
    workers: (facts?.workers ?? []).map((w) => ({ task: w.task, job: w.job, state: w.state, stop: w.stop })),
    checks: {
      pending_ops: unappliedOps(c, log).length,
      missing_context: open.filter((x) => x.kind === 'decide' && CONTEXT_KEYS.some((k) => !String(x.context?.[k] ?? '').trim())).map((x) => x.id),
      remind_due: d.waiting.filter((r) => r.card.awaiting?.remind_at && Date.parse(r.card.awaiting.remind_at) < now).map((r) => r.card.id),
      orphan_cards: open.filter((x) => x.kind !== 'inbox' && !x.stream && !x.owner && !x.tasks?.length).map((x) => x.id),
      intake: intake.map((t) => t.task.id),
      missing_workers: tasks.filter((t) => t.why === 'missing').map((t) => t.task.id),
      push_check: !tasks.some((t) => t.state === 'run') && !pushOpen,
      plugin: plugin ?? null,
      routes: (c.routes ?? []).map((r) => routeProblem(r, now)).filter((x): x is string => !!x),
      long_names: [...c.streams.filter((x) => !d.jobs.find((j) => j.id === x.id && j.state === 'done')), ...(c.owners ?? []).filter((o) => o.state !== 'done')]
        .filter((x) => [...x.title].length > NAME_MAX).map((x) => `${x.id}（${[...x.title].length} 字）`)
    },
    overview: `全体: ${countsText(d.counts, d.total)}・話し中 ${d.talking.length}・顧客待ち ${d.waiting.length}・動いている worker ${running.length}${names(running.map((t) => t.task.title))}`,
    card: `${countsText(d.counts, d.total)}${next?.card.due ? `・最短 ${fmtDate(next.card.due)}` : ''}`
  }
}
