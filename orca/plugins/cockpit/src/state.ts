// 依頼・タスク・worker・利用者の番・期限を決める 1 か所。窓・パネル・hook とメインが読む CLI（window/state.ts）はここを通す。
// 手書きの値を事実の代わりに出すと、画面とメインの認識が事実と食い違ったため（2026-11-16）。
import {
  DEFAULT_PHASES, doneAt, doneText, isYours, missingFields, overlay, shownTask, unappliedOps, worstState,
  type Cockpit, type Item, type ItemKind, type Milestone, type ItemView, type Request, type Stream, type Task, type TaskShown, type TaskState, type UserLog
} from './model.ts'
import type { AgentRow, DispatchFact, StopReason } from './protocol.ts'

export const ST_LABEL: Record<TaskState, string> = { stop: '止まっている', run: '進行中', wait: '外部待ち', idle: '未着手', ok: '完了' }
export const STOP_LABEL: Record<StopReason, string> = {
  blocked: '許可待ち', waiting: '返事待ち', interrupted: '中断', error: 'エラー', dead: '落ちた', auth: 'ログイン切れ', limit: '利用枠切れ'
}
/** 利用者の番のタスクの文。どの種類の項目を待っているかは、開いた項目の related から決める。 */
const YOURS_LABEL: Record<Exclude<ItemKind, 'ack'>, string> = { dec: 'あなたの判断待ち', rev: 'あなたの確認待ち', ask: '聞き方の承認待ち' }
/** worker が作業を終えてから、hook がメインに取り込みを促すまでの猶予。 */
export const INTAKE_GRACE_MS = 10 * 60_000
/** 「今は push しない」を選んでから、hook が push を聞き直さない間。 */
const PUSH_LATER_MS = 12 * 3_600_000

/** 依頼の状態。見ての承認がそろっても、タスク（タスクの無い依頼は state）が済むまでは「承認済み・反映待ち」にとどめる。 */
export type RequestStatus = 'working' | 'review' | 'accepted' | 'done'
export const REQUEST_LABEL: Record<RequestStatus, string> = { working: '作業中', review: '確認待ち', accepted: '承認済み・反映待ち', done: '完了' }

const WEEK = '日月火水木金土'
/** ISO 8601 の日付・日時を「11/19(水) 18:00」にする。読めなければそのまま出す。 */
export function fmtDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const day = `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`
  return iso.length > 10 ? `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : day
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
/** 今日以降の節目を近い順に。left は今日からの日数（0 が今日）。過ぎた節目と読めない日付は出さない。 */
export function upcomingMilestones(ms: Milestone[] | undefined, now: number): (Milestone & { left: number })[] {
  return (ms ?? [])
    .map((m) => ({ ...m, t: new Date(m.date.length > 10 ? m.date : `${m.date}T00:00:00`).getTime() }))
    .filter((m) => !Number.isNaN(m.t) && dayOf(m.t) >= dayOf(now))
    .sort((a, b) => a.t - b.t)
    .map(({ t, ...m }) => ({ ...m, left: Math.round((dayOf(t) - dayOf(now)) / 86_400_000) }))
}

/** Orca から分かること。パネルは orchestration を読まないので undefined（タスクはメインの書いた state のまま）。dispatches の null は Orca に無い。 */
export type OrcaFacts = { workers: AgentRow[]; dispatches: Record<string, DispatchFact | null> }

/**
 * label は一覧に出す短い状態の文。situation は誰の・何を待っていて・いつからかまで入れた今の様子、
 * detail は situation に次の作業（「次: …」）を足した 1 行。
 */
export type TaskView = TaskShown & { task: Task; label: string; situation: string; detail: string; since?: string; agents: AgentRow[]; settledAt?: number }
export type RequestView = { request: Request; status: RequestStatus; label: string }
export type Counts = { dec: number; ask: number; rev: number }

/** どの大タスクにも入らないタスクと確認の置き場所。cockpit.json の id は # で始めない前提。 */
export const NO_STREAM = '#loose'

/** 確認が指すタスク。related の全部と、見て（rev）なら依頼のタスク、報告（ack）なら決めたことのタスク。 */
export function itemTaskIds(c: Cockpit, i: Item): string[] {
  const viaRequest = i.kind === 'rev' ? c.requests?.find((r) => r.id === i.request)?.tasks ?? [] : []
  const viaDecided = i.kind === 'ack' ? (i.decided ?? []).map((d) => d.task).filter((t): t is string => !!t) : []
  return [...(i.related ?? []).map((r) => r.task), ...viaRequest, ...viaDecided]
}

/**
 * 確認が関係する大タスク（重なりを除き、指すタスクの順）。先頭が代表で、一覧の置き場所とたどりに使う。
 * どの大タスクにも決まらなければ空（画面では「つながりなし」）。
 */
export function itemStreams(c: Cockpit, i: Item): string[] {
  const known = new Set(c.streams.map((s) => s.id))
  const out: string[] = []
  for (const id of itemTaskIds(c, i)) {
    const s = c.tasks.find((t) => t.id === id)?.stream
    if (s && known.has(s) && !out.includes(s)) out.push(s)
  }
  return out
}

/** 大タスクの判定済みの状態。NO_STREAM はどの大タスクにも入らないタスクと確認をまとめたもの。 */
export type StreamView = {
  id: string
  title: string
  stream?: Stream
  /** 画面上の状態。済んでいないタスクのいちばん手当てが要る状態。全タスク完了でも開いた確認があれば wait（あなたの確認待ち）。 */
  state: TaskState
  label: string
  /** 今どうなっているかの文。state と同じ状態のタスクの文（「鈴木さんの返事待ち」）を 2 つまで。 */
  now: string
  /** 全体の 1 行に出す、今の様子と次の作業（「佐藤さん（顧客のシステム部）の返事待ち（11/17 から）。次: …」）。 */
  detail: string
  /** 案件の工程の並び（phases、無ければ既定）。 */
  phases: string[]
  /** 手を付けたタスクのいちばん先の工程と、その工程の順番（phases の中の位置。どれも未着手なら -1）。 */
  phase?: string
  phaseAt: number
  tasks: Task[]
  /** 関係する開いた決める・聞く・見て（2 つ以上の大タスクに関係する確認は、どの大タスクにも入る）。 */
  open: Item[]
  /** open のうち、要対応の一覧でこの大タスクに並ぶもの（代表の大タスクがこれ）。 */
  home: Item[]
  /** 関係する開いた報告（ack）。要対応には数えない。 */
  reports: Item[]
  /** 関係する片付け済みの項目。 */
  closed: ItemView[]
  due?: string
}

export type Derived = {
  views: ItemView[]
  /** 開いた決める・聞く・見てが指すタスクと、その項目の種類（最初の 1 つ）。 */
  yours: Map<string, ItemKind>
  tasks: Map<string, TaskView>
  requests: RequestView[]
  /** 利用者の番（開いた決める・聞く・見て）。期限の近い順、同じなら決める・見て・聞くの順。 */
  open: Item[]
  counts: Counts
  workers: AgentRow[]
  /** cockpit.json の streams の順。どの大タスクにも入らないタスクか確認があれば、最後に NO_STREAM。 */
  streams: StreamView[]
}

const RANK: Record<ItemKind, number> = { dec: 0, rev: 1, ask: 2, ack: 3 }
const dueKey = (i: Item) => (i.due ? dueAt(i.due) || Infinity : Infinity)

function taskLabel(s: TaskShown, t: Task, yours: ItemKind | undefined): string {
  if (s.why === 'ok') return ST_LABEL.ok
  if (s.why === 'yours') return YOURS_LABEL[yours as Exclude<ItemKind, 'ack'>] ?? ST_LABEL[s.state]
  if (s.why === 'working') return '進行中（worker が作業中）'
  if (s.why === 'intake') return 'メインの取り込み待ち'
  if (s.why === 'stopped') return `worker が${STOP_LABEL[s.stop as StopReason] ?? '止まっています'}`
  if (s.why === 'missing') return 'worker が見つかりません（メインの記録漏れ）'
  if (s.state === 'wait' && t.waiting_on?.trim()) return `${t.waiting_on.trim()}の返事待ち`
  return ST_LABEL[s.state]
}

/**
 * 外の相手を待ち始めた日。メインの書いた waiting_since、無ければこのタスクのために顧客に聞いた日（閉じた ask の asked_at の最後）。
 * 推し量りで日付を作らないので、どちらも無ければ出さない。
 */
function waitSince(t: Task, s: TaskShown, views: ItemView[]): string | undefined {
  if (s.state !== 'wait' || s.why !== 'record' || !t.waiting_on?.trim()) return undefined
  if (t.waiting_since) return t.waiting_since
  return views
    .filter((x) => x.closed && x.item.kind === 'ask' && x.item.asked_at && x.item.related?.some((r) => r.task === t.id))
    .map((x) => x.item.asked_at!)
    .sort()
    .at(-1)
}

/**
 * 依頼の状態。開いた見てがあれば確認待ち。結び付いたタスクがあれば、タスクがすべて完了なら完了で、
 * メインの書いた state は見ない（タスクと依頼の済みを 2 か所で持たない）。タスクの無い依頼だけ state で閉じる。
 */
export function requestStatus(r: Request, views: ItemView[], tasks: Map<string, { state: TaskState }>): RequestStatus {
  const revs = views.filter((x) => x.item.kind === 'rev' && x.item.request === r.id)
  if (revs.some((x) => !x.closed)) return 'review'
  const ids = r.tasks ?? []
  if (ids.length ? ids.every((id) => tasks.get(id)?.state === 'ok') : r.state === 'done') return 'done'
  return revs.length && (r.deliverables ?? []).every((d) => revs.some((x) => x.item.deliverable === d.id)) ? 'accepted' : 'working'
}

export function derive(c: Cockpit, log: UserLog, archive: Item[], orca: OrcaFacts | undefined): Derived {
  const views = overlay(c, log, archive)
  const open = views.filter((x) => !x.closed && isYours(x.item)).map((x) => x.item).sort((a, b) => dueKey(a) - dueKey(b) || RANK[a.kind] - RANK[b.kind])
  const yours = new Map<string, ItemKind>()
  for (const i of open) for (const r of i.related ?? []) if (!yours.has(r.task)) yours.set(r.task, i.kind)
  const workers = orca?.workers ?? []
  const tasks = new Map<string, TaskView>()
  for (const t of c.tasks) {
    const agents = workers.filter((w) => w.task === t.id)
    const fact = orca && t.worker ? orca.dispatches[t.worker.dispatch_id] ?? null : undefined
    const s = shownTask(t, fact, new Set(yours.keys()))
    const label = taskLabel(s, t, yours.get(t.id))
    const since = waitSince(t, s, views)
    let situation = label
    if (s.why === 'yours') {
      const i = open.find((x) => x.related?.some((r) => r.task === t.id))
      if (i) situation += `「${i.title}」`
    } else if (since) situation += `（${fmtDate(since.slice(0, 10))} から）`
    const next = s.state !== 'ok' && s.why !== 'yours' ? t.next?.trim() : undefined
    tasks.set(t.id, { ...s, task: t, label, situation, detail: next ? `${situation}。次: ${next}` : situation, since, agents, settledAt: fact?.settledAt })
  }
  const requests = (c.requests ?? []).map((r) => {
    const status = requestStatus(r, views, tasks)
    // 作業中のうち、済んでいないタスクが全部待ちなら、何を待っているかを状態の名前にする（大タスクの「外部待ち」と食い違わないように）。
    const waits = (r.tasks ?? []).map((id) => tasks.get(id)).filter((t): t is TaskView => !!t && t.state !== 'ok')
    const label = status === 'working' && waits.length && waits.every((t) => t.state === 'wait')
      ? waits.some((t) => t.why === 'yours') ? 'あなたの返事待ち' : '外部待ち'
      : REQUEST_LABEL[status]
    return { request: r, status, label }
  })
  const n = (k: ItemKind) => open.filter((i) => i.kind === k).length
  return { views, yours, tasks, requests, open, counts: { dec: n('dec'), ask: n('ask'), rev: n('rev') }, workers, streams: streamViews(c, views, open, tasks) }
}

/**
 * 大タスクの状態。済んでいないタスクがあればその状態、全タスク完了でも開いた確認があれば確認待ち、
 * 「全タスク完了かつ開いた確認なし」のときだけ完了。全体の表の印・畳み・大タスクの画面が同じ判定を使う。
 */
function streamViews(c: Cockpit, views: ItemView[], open: Item[], tasks: Map<string, TaskView>): StreamView[] {
  const known = new Set(c.streams.map((s) => s.id))
  const phases = c.phases?.length ? c.phases : DEFAULT_PHASES
  const of = new Map(views.map((x) => [x.item.id, itemStreams(c, x.item)]))
  const has = (i: Item, id: string) => {
    const ss = of.get(i.id) ?? []
    return id === NO_STREAM ? !ss.length : ss.includes(id)
  }
  const make = (id: string, title: string, stream?: Stream): StreamView => {
    const ts = c.tasks.filter((t) => (id === NO_STREAM ? !known.has(t.stream) : t.stream === id))
    const mine = open.filter((i) => has(i, id))
    const liveTs = ts.filter((t) => tasks.get(t.id)!.state !== 'ok')
    const live = liveTs.map((t) => tasks.get(t.id)!.state)
    const state: TaskState = live.length ? worstState(live)! : mine.length ? 'wait' : ts.length ? 'ok' : 'idle'
    const label = !live.length && mine.length ? YOURS_LABEL.rev : ST_LABEL[state]
    const words = [...new Set(liveTs.filter((t) => tasks.get(t.id)!.state === state).map((t) => tasks.get(t.id)!.label))]
    const now = words.length ? words.slice(0, 2).join('・') + (words.length > 2 ? ` ほか ${words.length - 2} 件` : '') : label
    // 一覧（要対応タブ）でこの大タスクに並ぶ確認。全体の件数はこれで数え、上の帯の件数と合計が合うようにする。
    const home = mine.filter((i) => (id === NO_STREAM ? !(of.get(i.id) ?? []).length : (of.get(i.id) ?? [])[0] === id))
    // 全体の 1 行。この大タスクに並ぶ確認があれば、いちばん急ぐその確認（ほかの大タスクの確認を引かない）。
    // 無ければ、いちばん手当ての要る状態のタスクの様子と次の作業。状態の名前だけの様子（「進行中」）は、まとまりの名前と重なるので次の作業だけにする。
    const worst = liveTs.filter((t) => tasks.get(t.id)!.state === state)
    const first = [...home].sort((a, b) => dueKey(a) - dueKey(b) || RANK[a.kind] - RANK[b.kind])[0]
    const tv = worst[0] && tasks.get(worst[0].id)!
    const plain = tv && tv.situation === ST_LABEL[tv.state] && tv.detail !== tv.situation
    const detail = first
      ? `${YOURS_LABEL[first.kind as Exclude<ItemKind, 'ack'>]}「${first.title}」`
      : tv
        ? (plain ? tv.detail.slice(tv.situation.length + 1) : tv.detail) + (worst.length > 1 ? `（ほか ${worst.length - 1} 件）` : '')
        : mine.length ? `${label}「${mine[0]!.title}」` : label
    // 工程は、手を付けた（未着手でない）タスクのいちばん先。どれも未着手なら工程に入っていない（-1）。
    const at = (xs: Task[]) => xs.map((t) => phases.indexOf(t.phase)).filter((n) => n >= 0)
    const started = at(ts.filter((t) => tasks.get(t.id)!.state !== 'idle'))
    const phaseAt = started.length ? Math.max(...started) : -1
    return {
      id, title, stream, state, tasks: ts, open: mine, home, label, now, detail,
      phase: phaseAt >= 0 ? phases[phaseAt] : undefined,
      phaseAt, phases,
      // 報告（ack）は大タスクの確認に数えない。片付け済みは種類を問わず読み返せるようにする。
      reports: views.filter((x) => !x.closed && x.item.kind === 'ack' && has(x.item, id)).map((x) => x.item),
      closed: views.filter((x) => x.closed && has(x.item, id)),
      due: home.map((i) => i.due).filter((d): d is string => !!d).sort((a, b) => dueAt(a) - dueAt(b))[0]
    }
  }
  const out = c.streams.map((s) => make(s.id, s.title, s))
  const loose = make(NO_STREAM, 'つながりなし')
  if (loose.tasks.length || loose.open.length || loose.reports.length) out.push(loose)
  return out
}

/** 大タスクの経過の 1 件。at は ISO 8601 の日付か日時。 */
export type StreamEvent = {
  at: string
  kind: 'start' | 'req' | 'reqdone' | 'dec' | 'ask' | 'asked' | 'rev' | 'ack' | 'done' | 'wait'
  text: string
  /** 補足（決めた答え・どのタスクの作業か）。 */
  note?: string
  item?: string
  req?: string
}

const timeOf = (iso: string) => new Date(iso.length > 10 ? iso : `${iso}T00:00:00`).getTime()

/**
 * 大タスクの経過。日付を持つ事実だけを古い順に並べる: 発端（background.date）・依頼を受けた・依頼が済んだ・
 * 片付けた確認（resolved_at）・顧客に聞いた（asked_at）・日時のある済んだ作業（done[].at）・外部待ちになった（waiting_since）。
 * 日付の無い記録は並べない（推し量りで日付を作らない）。
 */
export function streamTimeline(c: Cockpit, sv: StreamView, tasks: Map<string, TaskView>): StreamEvent[] {
  const ev: StreamEvent[] = []
  const bg = sv.stream?.background
  if (bg?.date) ev.push({ at: bg.date, kind: 'start', text: bg.text.split(/(?<=。)/)[0]!.trim() })
  const ids = new Set(sv.tasks.map((t) => t.id))
  for (const r of c.requests ?? []) {
    if (!r.tasks?.some((id) => ids.has(id))) continue
    ev.push({ at: r.at, kind: 'req', text: r.title, req: r.id })
    if (r.done_at) ev.push({ at: r.done_at, kind: 'reqdone', text: r.title, req: r.id })
  }
  for (const x of sv.closed) {
    if (x.item.kind === 'ask' && x.item.asked_at) ev.push({ at: x.item.asked_at, kind: 'asked', text: x.item.title, item: x.item.id })
    if (x.when) ev.push({ at: x.when, kind: x.item.kind, text: x.item.title, note: x.how, item: x.item.id })
  }
  for (const t of sv.tasks) {
    for (const d of t.done ?? []) {
      const at = doneAt(d)
      if (at) ev.push({ at, kind: 'done', text: doneText(d), note: t.title })
    }
    const since = tasks.get(t.id)?.since
    if (since) ev.push({ at: since, kind: 'wait', text: `${t.waiting_on!.trim()}の返事待ちになった`, note: t.title })
  }
  return ev.filter((e) => !Number.isNaN(timeOf(e.at))).sort((a, b) => timeOf(a.at) - timeOf(b.at))
}

/** 「要対応 3 件（判断 2・確認 1）」。0 件の種類は書かない。 */
export function countsText(n: Counts): string {
  const parts = (['dec', 'ask', 'rev'] as const).filter((k) => n[k]).map((k) => `${({ dec: '判断', ask: '質問', rev: '確認' })[k]} ${n[k]}`)
  return `要対応 ${n.dec + n.ask + n.rev} 件${parts.length ? `（${parts.join('・')}）` : ''}`
}

/** hook とメインが読む、判定済みの状態。画面と同じ derive から作る。 */
export type StateReport = {
  workspace: string
  /** Orca の状態を読めたか。読めなければ worker の記録があるタスクはメインの書いた state のまま。 */
  orca: 'ok' | 'skipped' | 'error'
  counts: Counts & { total: number }
  /** いちばん急ぐ利用者の番。 */
  next?: { id: string; kind: ItemKind; title: string; due?: string }
  overdue: string[]
  requests: { id: string; title: string; status: RequestStatus; label: string }[]
  tasks: { id: string; title: string; state: TaskState; label: string; from: TaskShown['why'] }[]
  workers: { task?: string; job?: string; state: string; stop?: StopReason }[]
  /** hook がメインに直させること。どれも画面に出る状態と同じ判定から出す。 */
  checks: {
    pending_ops: number
    missing_context: string[]
    local_deliverables: string[]
    orphan_waits: string[]
    intake: string[]
    missing_workers: string[]
    /** 進行中のタスクが無く、push の dec も開いていない（hook が git を見て、残りがあれば push を聞かせる）。 */
    push_check: boolean
    /** 操縦席のプラグインが動いていない理由（窓の上の帯と同じ文）。動いていれば null。 */
    plugin: string | null
  }
  /** 全体の 1 行（hook が発言のたびにメインに流す）。 */
  overview: string
  /** ワークスペースのカードのコメント（orca worktree set --comment）。 */
  card: string
}

const TMP = /^(file:\/\/)?(\/private)?\/(tmp|var\/folders)\//

export function report(c: Cockpit, log: UserLog, archive: Item[], orca: OrcaFacts | undefined, orcaState: StateReport['orca'], now: number, plugin?: string): StateReport {
  const d = derive(c, log, archive, orca)
  const tasks = [...d.tasks.values()]
  const live = d.requests.filter((r) => r.status !== 'done')
  const running = tasks.filter((t) => t.why === 'working')
  const idle = tasks.filter((t) => t.state === 'idle' && !t.task.waiting_on?.trim())
  const names = (xs: string[]) => (xs.length ? `（${xs.join(' / ')}）` : '')
  const total = d.counts.dec + d.counts.ask + d.counts.rev
  const next = d.open[0]
  const intake = tasks.filter((t) => t.why === 'intake' && now - (t.settledAt ?? 0) >= INTAKE_GRACE_MS)
  const pushOpen = c.items.some((i) => i.topic === 'push' && (i.state === 'open' || (i.resolved_option === 'later' && now - new Date(i.resolved_at ?? 0).getTime() < PUSH_LATER_MS)))
  const openItems = d.views.filter((x) => !x.closed).map((x) => x.item)
  return {
    workspace: c.workspace.name,
    orca: orcaState,
    counts: { ...d.counts, total },
    next: next && { id: next.id, kind: next.kind, title: next.title, due: next.due },
    overdue: d.open.filter((i) => isOver(i.due, now)).map((i) => i.id),
    requests: d.requests.map((r) => ({ id: r.request.id, title: r.request.title, status: r.status, label: r.label })),
    tasks: tasks.map((t) => ({ id: t.task.id, title: t.task.title, state: t.state, label: t.label, from: t.why })),
    workers: d.workers.map((w) => ({ task: w.task, job: w.job, state: w.state, stop: w.stop })),
    checks: {
      pending_ops: unappliedOps(c, log).length,
      missing_context: openItems.filter((i) => missingFields(i).length).map((i) => `${i.id}（${missingFields(i).join('・')}）`),
      local_deliverables: openItems.filter((i) => (i.kind === 'ack' || i.kind === 'rev') && [i.href, ...(i.links ?? []).map((l) => l.href)].some((h) => h && TMP.test(h))).map((i) => i.id),
      orphan_waits: tasks.filter((t) => t.why === 'record' && (t.state === 'stop' || t.state === 'wait') && !t.task.waiting_on?.trim()).map((t) => t.task.id),
      intake: intake.map((t) => t.task.id),
      missing_workers: tasks.filter((t) => t.why === 'missing').map((t) => t.task.id),
      push_check: !tasks.some((t) => t.state === 'run') && !pushOpen,
      plugin: plugin ?? null
    },
    // 依頼に結び付かない未着手のタスクも数える。依頼 0 だけを見て「全部終わった」と誤認した（2026-11-17、d9 で決めた t24 が残っていた）。外の相手を待つもの（waiting_on）は除く。
    overview: `全体: 依頼 ${live.length}${names(live.map((r) => r.request.title))}・決めてほしいもの ${total}・動いている worker ${running.length}${names(running.map((t) => t.task.title))}・未着手 ${idle.length}${names(idle.map((t) => t.task.title))}`,
    card: `${countsText(d.counts)}${next?.due ? `・最短 ${fmtDate(next.due)}` : ''}${live.length ? `・依頼 ${live.length} 件` : ''}`
  }
}
