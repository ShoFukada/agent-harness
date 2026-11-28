// カードの状態・私の番の並び・件数・案件の今（仕事ごとの状態）を決める 1 か所。窓・パネル・hook とメインが読む CLI（window/state.ts）はここを通す。
// 手書きの値を事実の代わりに出すと、画面とメインの認識が事実と食い違ったため（2026-11-16）。
import {
  COUNTED, COWORK_ID, KIND_LABEL, RETURN_ID, isSynthetic, taskSig, unanswered, missingFields, stageOf, overlay, shownTask, timeOf, unappliedOps, openTidyOps, UNDO_GRACE_MS, unmappedElements, metCount, waitMet, worstState,
  type AskMark, type AskThread, type Card, type CardEffect, type CardKind, type CardView, type Cockpit, type ConsultMemo, type Milestone, type ReturnMark, type Owner, type Request, type Ruling, type ShownWhy, type Stream, type StreamForm, type Task, type TaskSeen, type TaskShown, type TaskState, type UserLog, type Utterance, type Wait, type WaitKind
} from './model.ts'
import type { AgentRow, Ask, DispatchFact, OwnerLive, QuestionFact, StopReason } from './protocol.ts'

export const STOP_LABEL: Record<StopReason, string> = {
  blocked: '許可待ち', waiting: '返事待ち', interrupted: '中断', error: 'エラー', dead: '落ちた', auth: 'ログイン切れ', limit: '利用枠の上限'
}
/** 私が答えれば進むか。進まないものは私では直せない（立て直し・待つ）。 */
const STOP_UNBLOCK: Record<StopReason, [boolean, string]> = {
  blocked: [true, '端末で許可すれば進む'],
  waiting: [true, '質問に答えれば進む'],
  auth: [true, 'ログインし直せば進む'],
  dead: [false, 'プロセスが落ちた。担当が再起動する'],
  limit: [false, '利用枠が戻るまで止まる'],
  error: [false, '担当が再確認する'],
  interrupted: [false, '担当が再確認する']
}

const WEEK = '日月火水木金土'
/** ISO 8601 の日付・日時を「11/19(水) 18:00」にする。読めなければそのまま出す。 */
/** 手元の時計での今日の YYYY-MM-DD（toISOString は UTC の日付になり、日本時間の朝 9 時前は前日になる）。 */
export const localDay = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 東京の暦日の YYYY-MM-DD と、その日の 0:00 の時刻。確認日（R171）は手元の時計に依らず東京の日付で決める。 */
export const tokyoDay = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10)
export const tokyoStart = (day: string) => Date.parse(`${day}T00:00:00+09:00`)
export function fmtDate(iso: string | undefined): string {
  if (!iso) return ''
  // 日付だけの値は手元の 0 時として読む（new Date('YYYY-MM-DD') は UTC の 0 時になる）。
  const d = new Date(iso.length > 10 ? iso : `${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  const day = `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`
  return iso.length > 10 ? `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : day
}
export function nearDate(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const t = new Date(iso.length > 10 ? iso : `${iso}T00:00:00`).getTime()
  if (Number.isNaN(t)) return iso
  const days = Math.round((dayOf(t) - dayOf(now)) / DAY)
  if (days < -1 || days > 1) return fmtDate(iso)
  const word = days === -1 ? '昨日' : days === 1 ? '明日' : '今日'
  if (iso.length <= 10) return `${word}中`
  return days === 0 ? hhmm(t) : `${word} ${hhmm(t)}`
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

/**
 * Orca から分かること。パネルは orchestration を読まないので dispatches が無い（タスクはメインの書いた state のまま）。null は Orca に無い。
 * current はタスクの id → 今の Dispatch（Run の Task の続きをたどった先）。無ければ worker の記録の dispatch_id（版 2）を使う。
 */
/**
 * terminals は Orca にある端末の handle（読めていなければ無い。カードの相談のタブの生死に使う）。terminalsPartial は一覧が上限で切れているかもしれない印で、
 * そのときは一覧に無い handle を「閉じた」と言い切らない（一覧にある handle は生きていると使える）。
 */
/**
 * coordinating は一緒に作る仕事の担当（帳簿の owners の id）→ その担当が自分の Run で動かしている、終わっていない worker の Dispatch。
 * 読めた担当だけが入る（読めなかった担当は、worker を待っているか分からないものとして扱う）。
 */
export type OrcaFacts = { automations?: { id: string; name: string }[]; workers: AgentRow[]; dispatches?: Record<string, DispatchFact | null>; owners?: OwnerLive[]; ownersStale?: boolean; current?: Record<string, string>; terminals?: string[]; terminalsPartial?: boolean; questions?: QuestionFact[]; coordinating?: Record<string, string[]> }

/** タスクの今の Dispatch。run_id だけの記録で続きを引けていなければ undefined。 */
export const currentDispatch = (t: Task, facts: OrcaFacts | undefined): string | undefined => (t.worker ? facts?.current?.[t.id] ?? t.worker.dispatch_id : undefined)

/** Orca から作った詰まりの行の id。チャットはセッション、端末は handle で引く（同じ worktree の別のチャットと混ぜない）。 */
export const agentCardId = (a: Pick<AgentRow, 'session' | 'terminalId' | 'worktree' | 'title'>) => `#agent:${a.session ?? a.terminalId ?? a.worktree ?? a.title}`

/** カードの話し相手。担当が無い仕事は案件の窓口（main）。 */
export type OwnerRef = {
  title: string
  how: 'chat' | 'terminal' | 'main'
  owner?: Owner
  /** Orca での今（作業中・入力待ち など）。分からなければ無い。 */
  state?: AgentRow['state']
  terminal?: string
  /** 担当がチャットなら、そのチャットの orcaSessionId。 */
  session?: string
}

/** 1 列の 1 行。Orca から作った詰まり（synthetic）は cockpit.json に無い。 */
export type Row = CardView & {
  root: string
  ws: string
  owner: OwnerRef
  stream?: Stream
  agent?: AgentRow
}

/**
 * タスクが今何を待っているか（state.ts が事実から決める。R204）。label は人が読む 1 行、key は状況の文の古さを見る印（streamBasis）。
 * card・talking・fixing・reply はカードの tasks から、intake・worker は Orca から、person・event・date・slot は tasks[].wait から、after は前提のタスクから。
 */
export type Hold = { kind: 'card' | 'talking' | 'fixing' | 'reply' | 'stuck' | 'intake' | 'worker' | WaitKind | 'after'; label: string; key: string; card?: string; since?: string }
/** done は済の出どころ（hand: 窓口が ok と書いた、card: 確認の承認など、カードの効果で済になった）。label は状態の 1 行（人が読む文）。 */
export type TaskView = TaskShown & { task: Task; settledAt?: number; label: string; done?: 'hand' | 'card'; hold?: Hold }
/** 案件の今の 1 行（仕事ごと）。 */
/**
 * customer は人の返事待ち（送ったカードの awaiting と、wait の person）。outside は人でない外の待ち（wait の event・date）で、顧客待ちとは呼ばない
 * （s2 のように顧客のいない仕事が「顧客待ち」と出たため。t122 の照合）。
 */
export type JobState = 'mine' | 'stopped' | 'working' | 'customer' | 'outside' | 'idle' | 'done'
export const JOB_LABEL: Record<JobState, string> = { mine: '私待ち', stopped: '止まっている', working: '作業中', customer: '顧客待ち', outside: '出来事待ち', idle: '未着手', done: '済' }
/** 一緒に作る仕事で担当が深田さんの返事を待っているときの、仕事とタスクの状態の語（R128）。 */
export const REPLY_LABEL = '返事待ち（あなた）'
/**
 * Orca のサイドバーの作業場所の状態。窓の「案件の今」と同じ判定から決め、窓口が orca worktree set でそろえる
 * （窓とサイドバーで同じ仕事が違う状態に見えないように）。私待ちは in-review にし、未読の印も付ける。
 */
export type OrcaStatus = 'todo' | 'in-progress' | 'in-review' | 'completed'
export const ORCA_STATUS: Record<JobState, OrcaStatus> = { mine: 'in-review', stopped: 'in-progress', working: 'in-progress', customer: 'in-progress', outside: 'in-progress', idle: 'todo', done: 'completed' }
/** サイドバーは 20 文字ほどで切れる。仕事の名前はこれ以内にし、何の仕事かを先頭に置く。bin/orca-launch がこの行と WORKER_HEAD の行を文字列で読むので、1 行の形を変えない。 */
export const NAME_MAX = 20
/**
 * Orca のタブと worktree の名前の頭（R146）。仕事の形を付けて成果物の名前を続ける。見張るは R146 に無いので、ほかと同じ形で「見張る」を頭にする。
 * 形の無い仕事の担当は、今までどおり「<題>（担当）」。worker は「作業｜<題>」（bin/orca-launch が付ける）。窓口は「<案件の役割> 窓口」（R146）。
 */
export const NAME_HEAD: Record<StreamForm, string> = { cowork: '一緒に', delegate: '任せる', watch: '見張る' }
export const WORKER_HEAD = '作業'
const headed = (head: string, title: string) => `${head}｜${title}`
/** 仕事（worktree の表示名）の名前。形の無い仕事は題のまま。 */
export const streamName = (s: Pick<Stream, 'title' | 'form'>) => (s.form ? headed(NAME_HEAD[s.form], s.title) : s.title)
/** 担当のタブの名前。 */
export const ownerName = (c: Pick<Cockpit, 'streams'>, o: Pick<Owner, 'title' | 'stream'>) => {
  const form = c.streams.find((s) => s.id === o.stream)?.form
  return form ? headed(NAME_HEAD[form], o.title) : `${o.title}（担当）`
}
export const workerName = (title: string) => headed(WORKER_HEAD, title)

export type JobView = { id: string; title: string; state: JobState; label: string; next?: string; mine: number; owner?: OwnerRef; since?: string; reply?: boolean }

export type Counts = Record<CardKind, number>
/** 帳簿の不備（必須の欄が欠けたカード・欄の欠けた依頼・仕分けていない発言）。since は数え始めた時刻。 */
export type Gap = { kind: 'card' | 'request' | 'utterance'; id: string; title: string; missing: string[]; since?: string }
export type RequestState = '受付' | '進行中' | '確認待ち' | '済'
export type RequestView = {
  req: Request
  state: RequestState
  legacy: boolean
  tasks: TaskView[]
  /** 結ばれた確認依頼（request_id か、タスクを共有するカード）。 */
  cards: Card[]
  streams: string[]
  /** 欠けた欄（legacy ではない行の utterances・done_when・kind）。 */
  missing: string[]
  /** 済の条件ごとに証拠があるか。 */
  covered: boolean[]
}
export type DeriveOpts = { utterances?: Utterance[]; notices?: Utterance[]; returned?: string[]; firstSeen?: Record<string, string>; taskSeen?: TaskSeen; rulings?: Ruling[]; consults?: ConsultMemo[]; marks?: ReturnMark[]; asks?: AskThread[]; askMarks?: AskMark[]; root?: string }
/** 帳簿の不備を窓口に直させる猶予。過ぎても欠けたままなら、窓の要対応の上に「抜けている」として出す（R47）。 */
export const GAP_GRACE_MS = 30 * 60_000

export type Derived = {
  views: CardView[]
  /** 私の番（届いたも含む）。期限順。必須の欄が欠けたカードは入れない。 */
  queue: Row[]
  /** 頼むカードがあるので queue に入れず、要対応のその仕事の見出しに担当の様子と開くボタンを出す「共同作業中」の行（R259）。 */
  heads: Row[]
  /** 「担当と話す」を押して、同じ版のまま私の番に残っているカード。 */
  talking: Row[]
  /** 見てで直しを頼んだカード（件数から外す）。 */
  fixing: Row[]
  waiting: Row[]
  reports: Row[]
  /** 片付いたもの（新しい順）。 */
  closed: Row[]
  /** 片付いたもの全部（表示の 14 日を過ぎたものも）。タスクの詳細から開く。 */
  settled: Row[]
  counts: Counts
  total: number
  tasks: Map<string, TaskView>
  jobs: JobView[]
  /** 必須の欄が欠けて要対応に出していないカード（猶予の内も外も）。 */
  incomplete: Gap[]
  /** 仕分けていない発言（intake の位置より後か、どの依頼にも none にも結ばれていない）。 */
  unsorted: Gap[]
  requests: RequestView[]
  /** 猶予の 30 分を過ぎても直っていない帳簿の不備。窓の要対応の上に出す。 */
  gaps: Gap[]
  /** 線を越えて動いていないタスク（R170）。 */
  idle: IdleTask[]
  leftover: AgentRow[]
  /** 状況の文（status）が、書いたときの元の事実（status_basis）と食い違う仕事（R204）。窓は文の代わりに statusFallback を出す。 */
  stale: Map<string, StaleStatus>
}
export type StaleStatus = { basis: string[]; was?: string[] }

export const countedRow = (r: Pick<Row, 'card' | 'agent'>) => COUNTED.includes(r.card.kind) || (r.card.id.startsWith(COWORK_ID) && !!r.agent?.ask)

const RANK: Record<CardKind, number> = { stuck: 0, permit: 1, decide: 2, send: 3, review: 4, consult: 5, inbox: 6, talk: 7, report: 8 }
const dueKey = (r: Row) => (r.card.kind === 'stuck' ? -Infinity : r.card.due ? dueAt(r.card.due) || Infinity : Infinity)
export const byUrgency = (a: Row, b: Row) => dueKey(a) - dueKey(b) || RANK[a.card.kind] - RANK[b.card.kind] || timeOf(a.card.at) - timeOf(b.card.at)

export function ownerOf(c: Cockpit, card: Pick<Card, 'owner' | 'stream'>, facts?: OrcaFacts): OwnerRef {
  const own = c.owners?.find((o) => o.id === card.owner) ?? c.owners?.find((o) => o.stream && o.stream === card.stream && o.state !== 'done')
  if (own) {
    const term = own.terminal ? facts?.workers.find((w) => w.terminalId === own.terminal) : undefined
    // worker-start --agent で立てたチャットの担当は、受け取りの terminal（structworker_…）を terminal に書かれがち。端末の一覧に無いので、
    // その handle の Dispatch からチャットを引く（2026-11-21 に「担当と話す」が何も開かなかった）。
    const session = own.session || (own.terminal && !term ? Object.values(facts?.dispatches ?? {}).find((f) => f?.terminal === own.terminal)?.session : undefined)
    const live = session ? facts?.owners?.find((x) => x.session === session) : undefined
    if (session && !term) return { title: own.title, how: 'chat', owner: own, state: live?.state, session }
    return { title: own.title, how: own.terminal ? 'terminal' : 'chat', owner: own, state: term?.state ?? live?.state, terminal: own.terminal }
  }
  return { title: '窓口', how: 'main', terminal: c.main?.terminal || undefined }
}

/**
 * 深田さんが直し方の「済ませた」を押した、Orca から作った詰まり（「id@版」）。版はその失敗が始まった時刻なので、
 * 同じ失敗のあいだは出さず、新しい失敗（時刻が変わる）でまた出す（追加 7）。
 */
export function dismissedStuck(log: UserLog): Set<string> {
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  return new Set(log.ops.filter((o) => o.type === 'dismiss' && !undone.has(o.op_id)).map((o) => `${o.item_id}@${o.item_rev}`))
}

/**
 * 直し方。深田さんが押すものを書く。チャットは CLI から続けられない（Orca は自動の続きが切ってあると、人がチャットで続けるまで配達を止める）ので、
 * 開いて「続ける」を押す。
 */
export function stopUnblock(stop: StopReason, a: Pick<AgentRow, 'chat' | 'reset' | 'ask'>): [boolean, string] {
  const open = a.chat ? 'チャットを開いて「続ける」を押す' : '端末を開いて「続けて」と送る'
  if ((stop === 'blocked' || stop === 'waiting') && a.ask) return [true, `${a.chat ? 'チャット' : '端末'}を開いて、${a.ask.kind === 'permit' ? '許可するかを選ぶ' : '選択肢を選ぶか答えを書く'}`]
  if (stop === 'limit') return [false, `${a.reset ? `${a.reset} 以降` : '利用枠が戻ってから'}（アカウントを切り替えたなら今）、${open}`]
  if (stop === 'auth') return [true, `再ログインしてから、${open}`]
  if (stop === 'error' || stop === 'interrupted') return [false, a.chat ? 'チャットを開いて最後の発言を確認し、「続ける」を押す' : '端末を開いて最後の出力を確認し、続きを依頼する']
  return STOP_UNBLOCK[stop]
}

/** Orca で止まっている worker を、詰まりの行にする。メインが同じタスクの詰まりを書いていれば、そちらを出す。版（rev）は止まった時刻。 */
function stuckRows(c: Cockpit, root: string, workers: AgentRow[], written: Set<string>): Row[] {
  return workers
    .filter((a) => {
      if (!a.stop) return false
      // メインが書いた詰まりと同じ仕事（タスクか、担当の端末で引く）なら、そちらを出す。
      const stream = c.tasks.find((t) => t.id === a.task)?.stream ?? c.owners?.find((o) => o.terminal && o.terminal === a.terminalId)?.stream
      return !(a.task && written.has(a.task)) && !(stream && written.has(stream))
    })
    .map((a) => {
      const [answerable, unblock] = stopUnblock(a.stop!, a)
      const task = c.tasks.find((t) => t.id === a.task)
      const ownStream = c.owners?.find((o) => o.terminal && o.terminal === a.terminalId)?.stream
      // 仕事の名前は Orca のサイドバーと同じもの（仕事の題）を先にする。
      const name = c.streams.find((s) => s.id === (task?.stream ?? ownStream))?.title ?? a.job ?? a.title ?? 'worker'
      // 問いが読めたら、題は問いそのものにし、誰が聞いているかは 2 行目に回す（行の頭が問いで始まり、切れても何を聞かれたか分かるように。初見 1）。
      const role = c.owners?.some((o) => (o.terminal && o.terminal === a.terminalId) || (o.session && o.session === a.session)) ? '担当' : 'worker'
      // 2 行目で、どこで止まっているか（端末かチャット）と何を待っているかを語で言う（先頭の語の色で許可のカードと分けない。R91）。
      const ask = a.ask && { ...a.ask, from: `${role}（${task?.title ?? name}）が${a.chat ? 'チャット' : '端末'}で${a.ask.kind === 'permit' ? '許可' : '答え'}を待っている` }
      const card: Card = {
        id: agentCardId(a), rev: a.since, kind: 'stuck', state: 'open',
        title: ask ? askLine(ask.kind === 'permit' ? permitTitle(ask) : ask.text) : `「${name}」が${STOP_LABEL[a.stop!]}`, since: new Date(a.since).toISOString(),
        reason: `${STOP_LABEL[a.stop!]}${a.reset ? `（${a.reset} に戻る）` : ''}`, answerable, unblock, stream: task?.stream, tasks: task ? [task.id] : undefined
      }
      return { card, status: 'mine' as const, pending: false, root, ws: c.workspace.name, owner: { title: name, how: a.chat ? 'chat' as const : 'terminal' as const, state: a.state, terminal: a.terminalId ?? undefined, session: a.session }, stream: c.streams.find((s) => s.id === task?.stream), agent: ask ? { ...a, ask } : a }
    })
}

/** 一緒に作る仕事の、済んでいない担当。 */
const coworkOwners = (c: Cockpit) => (c.owners ?? []).filter((o) => o.state !== 'done' && c.streams.some((s) => s.id === o.stream && s.form === 'cowork'))

/**
 * 一緒に作る仕事の担当のチャットのセッション（窓の常駐のプロセスが最後の返事を読みに行く先）。
 * 行を作る側（coworkRows）と同じく ownerOf で引く（帳簿に session が無く、Dispatch から引く担当もいる）。
 */
export const coworkSessions = (c: Cockpit | undefined, facts?: OrcaFacts) =>
  c ? coworkOwners(c).map((o) => ownerOf(c, { owner: o.id, stream: o.stream }, facts).session).filter((x): x is string => !!x) : []

/**
 * 担当が worker を立てるときの自分の handle（Orca の Run の coordinator_handle）。端末の担当は端末の handle、worker-start --agent で立てたチャットの担当は
 * 受け取りの handle（structworker_…）。帳簿に無ければ、済んでいないタスクの Dispatch から session で引く（引けなければ読む側が窓口の Run から引く）。
 */
const coordinatorOf = (owner: OwnerRef, facts: OrcaFacts | undefined) =>
  owner.owner?.terminal || (owner.session ? Object.values(facts?.dispatches ?? {}).find((f) => f?.session === owner.session)?.terminal : undefined) || undefined

const coworkState = (owner: OwnerRef, facts: OrcaFacts | undefined) =>
  owner.how === 'terminal' ? owner.state : owner.session ? facts?.owners?.find((x) => x.session === owner.session)?.state : undefined

export type IdleOwner = { id: string; session?: string; handle?: string }
/** 作業中の担当は返事待ちにならないので、作業中でない担当だけを返す。 */
export const coworkIdle = (c: Cockpit | undefined, facts?: OrcaFacts): IdleOwner[] =>
  c ? coworkOwners(c).flatMap((o) => {
    const owner = ownerOf(c, { owner: o.id, stream: o.stream }, facts)
    if (coworkState(owner, facts) === 'working') return []
    const handle = coordinatorOf(owner, facts)
    return [{ id: o.id, ...(owner.session && { session: owner.session }), ...(handle && { handle }) }]
  }) : []

/** 返事の最後の段落（担当が深田さんに返した問いの本文）。空行で区切った最後のまとまりを、改行を空白にして 1 行にする。 */
export const lastParagraph = (text: string | undefined) =>
  (text ?? '').split(/\n\s*\n/).map((p) => p.replace(/\*\*/g, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).at(-1)

/**
 * 一緒に作る仕事（cowork）を、カードの有無に関わらず 1 行作る（R128・R145）。頼むカードがある仕事の返事待ちでない行は、derive が要対応の見出しに回す（R259）。開くボタンは担当のチャットか端末を前に出す（詰まりの行と同じ経路）。
 * 深田さんの返事待ちは同じ行で示す: 担当がターンを終えて開いたまま（orca agent list の state が done）、担当の問いの詰まり（AskUserQuestion・許可の確認）、
 * または仕事の話し中のカード・協議中のカード（担当が作業に戻っていないもの）。問いの詰まりと話し中のカード（kind talk）はこの行に寄せて 2 行にしない。
 * 協議中のほかの種類のカードは承認などの返答が要るので残す。利用枠・ログイン切れ・エラーで止まった担当は、その詰まりの行を残し、返事待ちにしない。
 * 担当が自分の Run で立てた worker が終わっていないあいだは、ターンの終わりも話し中のカードも返事待ちにせず「worker の作業待ち」と出す（問いの停止は除く）。
 * 任せる・見張るの担当は出さない（担当は窓口に status や worker_done を返してターンを終えるので、ターンの終わりが深田さんの番ではない）。
 * 担当の様子を読めない場所（パネル・hook の state）では作らない。absorbed はこの行に寄せた行。
 */
function coworkRows(c: Cockpit, root: string, facts: OrcaFacts | undefined, queue: Row[], all: Row[]): { rows: Row[]; absorbed: Set<Row> } {
  const absorbed = new Set<Row>()
  if (!facts?.owners) return { rows: [], absorbed }
  const rows = coworkOwners(c).flatMap((o): Row[] => {
    const s = c.streams.find((x) => x.id === o.stream)!
    if (queue.some((r) => r.card.id === `${COWORK_ID}${s.id}`)) return []
    const owner = ownerOf(c, { owner: o.id, stream: s.id }, facts)
    const live = owner.session ? facts.owners!.find((x) => x.session === owner.session) : undefined
    const state = coworkState(owner, facts)
    const self = (a: Pick<AgentRow, 'session' | 'terminalId'>) => (!!owner.session && a.session === owner.session) || (!!owner.terminal && a.terminalId === owner.terminal)
    // 担当自身の停止（Orca の端末・チャットから作った行）だけを見る。担当宛てに届いた worker の question の行は、宛先の handle を持つが担当の問いではない。
    const asked = queue.find((r) => r.card.id.startsWith('#agent:') && !!r.agent?.ask && self(r.agent))
    // 「対応済みにする」で隠した停止も、止まっているあいだは返事待ちにしない。
    const failed = facts.workers.some((a) => !!a.stop && !a.ask && self(a))
    const talks = queue.filter((r) => r.card.stream === s.id && r.card.kind === 'talk')
    const talking = all.some((r) => r.card.stream === s.id && r.status === 'mine' && !!r.talking)
    for (const r of [asked, ...talks]) if (r) absorbed.add(r)
    const busy = !!facts.coordinating?.[o.id]?.length
    const text = asked?.agent?.ask?.text ?? (state === 'done' ? live?.last : undefined) ?? talks.find((r) => r.card.last?.text)?.card.last?.text
    const question = lastParagraph(text)
    // worker を待っていても、ターンの最後の段落が問い・回答の依頼なら深田さんの番（R128。worker を送りつつ別のことを聞いて止まる担当がいる）。
    // 見分けは文末の形だけで行う。外れたときに返事待ちへ倒れる向きに広く取る（worker 宛ての指示の引用も問いと読む）。
    const asksBack = !!question && (ASKS_BACK.test(question) || /【選べる案】/.test(text ?? ''))
    // ターンを終えたチャットの担当の返事を読めなければ、問いで終わったかが分からないので返事待ちに倒す。
    const unread = state === 'done' && owner.how !== 'terminal' && !text
    const waiting = !failed && (!!asked || ((!busy || asksBack || unread) && (state === 'done' || ((talks.length > 0 || talking) && state !== 'working'))))
    // 詳細の「最後のやり取り」には、題にした最後の段落より前だけを出す（同じ文を 2 度出さない。Neon）。題で切れた長い問いは全文を残す。
    const paras = (text ?? '').split(/\n\s*\n/).filter((p) => p.trim())
    const context = waiting && question && question.length <= 120 ? paras.slice(0, -1).join('\n\n') : text
    const at = asked?.card.since ?? (live?.updatedAt ? new Date(live.updatedAt).toISOString() : undefined)
    const card: Card = {
      id: `${COWORK_ID}${s.id}`, rev: live?.updatedAt ?? 0, kind: 'talk', state: 'open', stream: s.id,
      ...(waiting && at && { since: at }),
      title: !waiting ? `共同作業中（担当は${state === 'working' ? '作業中' : busy && !failed ? ' worker の作業待ち' : state ? (OWNER_WORD[state] ?? '入力待ち') : '状態不明'}）`
        : asked?.agent?.ask?.kind === 'permit' ? asked.card.title : question ? askLine(question) : talks[0]?.card.title ?? `担当「${owner.title}」が返事を待っている`,
      tasks: [...new Set(c.tasks.filter((t) => t.stream === s.id && t.state !== 'ok').map((t) => t.id))],
      ...(context && { last: { text: context, by: '担当', ...(at && { at }) } }),
      // 返事の本文が読めたときは、開くボタンで足りるので「次」を書かない（Neon）。
      next: !waiting ? (failed ? '担当が止まっている。止まった行の直し方を確認する'
        : busy && state !== 'working' ? '担当は worker の報告を待っている。報告が届くと担当が続ける' : '担当が作業中。開くと途中の様子を確認できる')
        : text || talks.length ? undefined : `${owner.how === 'terminal' ? '端末' : 'チャット'}から返事の本文を読めませんでした。開いて確認してください`
    }
    const agent: AgentRow = asked?.agent ?? {
      terminalId: owner.how === 'terminal' ? owner.terminal ?? null : null, title: owner.title, agent: null, state: state ?? 'working', since: live?.updatedAt ?? 0,
      worktree: live?.worktree, ...(owner.how !== 'terminal' && { chat: true }), session: owner.session,
      ...(waiting && { ask: { kind: 'question' as const, text: text ?? card.title, from: `担当（${owner.title}）があなたの返事を待っている` } })
    }
    return [{ card, status: 'mine', pending: false, root, ws: c.workspace.name, owner, stream: s, agent }]
  })
  return { rows, absorbed }
}
const OWNER_WORD: Partial<Record<AgentRow['state'], string>> = { blocked: '許可待ち', waiting: '入力待ち', done: '待機' }
const ASKS_BACK = /(?:[？?]|ください|下さい|お願いします|お願いいたします|ますか|ですか|でしょうか)[。.」』）)\s]*$/

/**
 * 許可の確認の題。何をするかが初見で分かる文にする（git push は「<ブランチ> を <リモート> に push する」、Bash は「<コマンド> を実行する」、
 * ファイルの書き換えは「<パス> を書き換える」）。作れなければコマンドかパスだけ。全文は詳細の「許可を求めていること」に出す。
 */
export function permitTitle(a: Pick<Ask, 'text' | 'body'>): string {
  const tool = a.body?.[0] ?? /^(\w+): /.exec(a.text)?.[1] ?? ''
  const target = (a.body?.length ? a.text : a.text.replace(/^\w+: /, '')).trim()
  // 文にするのは、1 行でブランチを送るだけの形（-u は付いてよい）。削除・強制・refspec・改行で続く別のコマンドは、文にすると取り違えるのでコマンドのまま出す。
  const push = /^git push[ \t]+(?:(?:-u|--set-upstream)[ \t]+)?(\w[\w./-]*)[ \t]+(\w[\w./-]*)$/.exec(target)
  if (push) return `${push[2]} を ${push[1]} に push する`
  // 一覧の題は 1 行目だけを出すので、複数行のコマンドは 1 行目と残りの行数にする。
  const lines = target.split('\n').filter((l) => l.trim())
  if (/bash/i.test(tool)) return lines.length > 1 ? `${lines[0]!.trim()} ほか ${lines.length - 1} 行を実行する` : `${target} を実行する`
  if (/edit|write|create/i.test(tool)) return `${target} を書き換える`
  return target
}

/** 問いの 1 行目を、一覧の行に収まる長さにする（全文は詳細に出す）。 */
export const askLine = (text: string) => {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

/** 答えの無い orchestration の question を出すまでの猶予。窓口宛ては窓口が自分で答える間、担当宛ては担当が答える間だけ待つ。 */
export const ASK_GRACE_MS = { main: 5 * 60_000, owner: 30 * 60_000 } as const

/**
 * 答えの無い orchestration の question を、詰まりの行にする。押すと宛先（窓口か担当）の端末かチャットを前に出す（答えはそこに伝える）。
 * 窓口が問いのあとに同じタスクのカードを書いていれば、そちらを出す（同じ問いを 2 行にしない）。
 */
function questionRows(c: Cockpit, root: string, facts: OrcaFacts | undefined, now: number): Row[] {
  return (facts?.questions ?? [])
    .filter((q) => now - q.at >= ASK_GRACE_MS[q.to] && !(q.task && c.cards.some((x) => x.state === 'open' && x.tasks?.includes(q.task!) && timeOf(x.at) >= q.at)))
    .map((q) => {
      const task = c.tasks.find((t) => t.id === q.task)
      const stream = c.streams.find((s) => s.id === (task?.stream ?? q.stream))
      const who = q.byOwner ? `担当（${stream?.title ?? q.asker ?? '名前不明'}）` : `worker（${task?.title ?? stream?.title ?? q.asker ?? '名前不明'}）`
      const card: Card = {
        id: `#ask:${q.id}`, rev: q.at, kind: 'stuck', state: 'open', title: askLine(q.line),
        since: new Date(q.at).toISOString(), reason: STOP_LABEL.waiting, answerable: true, stream: stream?.id, tasks: task ? [task.id] : undefined
      }
      const owner: OwnerRef = q.to === 'main' ? { title: '窓口', how: 'main', terminal: c.main?.terminal || undefined } : ownerOf(c, card, facts)
      const live = owner.session ? facts?.owners?.find((x) => x.session === owner.session) : undefined
      // 開く先は宛先のエージェント。チャットは Orca がタブを前に出せないので、居場所の worktree を開く。
      const chat = owner.how === 'chat' || !owner.terminal
      const agent: AgentRow = {
        terminalId: chat ? null : owner.terminal!, title: owner.title, agent: null, state: 'waiting', since: q.at, stop: 'waiting',
        worktree: live?.worktree ?? root, ...(chat && { chat: true }),
        // 窓口・担当が答えずに回ってきたことを、誰が誰に聞いたかと一緒に出す（初見 2。経った時間は一覧の右と詳細の日時に出す）。
        ask: { kind: 'question', text: q.text, ...(q.options && { options: q.options }), from: `${who}が${q.to === 'main' ? '窓口' : '担当'}に聞いたが、まだ答えが無い` }
      }
      const where = chat ? 'チャット' : '端末'
      // 担当の Run 宛てでも担当を引けなければ窓口を開くので、そう書く（担当を開くように見せない）。
      card.unblock = owner.how !== 'main' ? `担当（${owner.title}）の${where}を開いて答えを伝えれば、担当が${who}に返す`
        : q.to === 'main' ? `窓口の${where}を開いて答えを伝えれば、窓口が${who}に返す` : `宛先の担当を引けないため、窓口の${where}を開いて伝える`
      return { card, status: 'mine' as const, pending: false, root, ws: c.workspace.name, owner, stream, agent }
    })
}

/**
 * Dispatch で止まった・Orca に見つからないタスクのうち、端末のエージェントからは詰まりの行にならなかったもの
 * （落ちて端末が消えた worker は worktree ps に出ないため）。
 */
function dispatchStuck(c: Cockpit, root: string, tasks: Map<string, TaskView>, written: Set<string>, covered: Set<string>, dismissed: Set<string>): Row[] {
  return [...tasks.values()]
    .filter((t) => (t.why === 'stopped' || t.why === 'missing') && !covered.has(t.task.id) && !written.has(t.task.id) && !written.has(t.task.stream)
      && !(t.settledAt && dismissed.has(`#dispatch:${t.task.id}@${t.settledAt}`)))
    .map((t) => {
      const stop = (t.stop ?? 'dead') as StopReason
      const [answerable, unblock] = t.why === 'missing' ? [false, '窓口が再起動するか、記録を修正する'] as const : STOP_UNBLOCK[stop]
      const reason = t.why === 'missing' ? 'Orca に見つからない' : STOP_LABEL[stop]
      const name = c.streams.find((s) => s.id === t.task.stream)?.title ?? t.task.title
      const card: Card = {
        id: `#dispatch:${t.task.id}`, rev: t.settledAt ?? 0, kind: 'stuck', state: 'open', title: `「${name}」が${t.why === 'missing' ? ' ' : ''}${reason}`,
        since: t.settledAt ? new Date(t.settledAt).toISOString() : undefined, reason, answerable, unblock, stream: t.task.stream, tasks: [t.task.id]
      }
      return { card, status: 'mine' as const, pending: false, root, ws: c.workspace.name, owner: ownerOf(c, card), stream: c.streams.find((s) => s.id === t.task.stream) }
    })
}

const CLOSED_DAYS = 14

export function derive(c: Cockpit, log: UserLog, archive: Card[], root: string, facts: OrcaFacts | undefined, now: number, opts: DeriveOpts = {}): Derived {
  const terms = facts?.terminals && new Set(facts.terminals)
  const views = overlay(c, log, archive, terms ? (t) => terms.has(t) || !!facts?.terminalsPartial : undefined)
  const row = (v: CardView): Row => ({ ...v, root, ws: c.workspace.name, owner: ownerOf(c, v.card, facts), stream: c.streams.find((s) => s.id === v.card.stream) })
  const rows = views.map(row)
  const written = new Set(c.cards.filter((x) => x.kind === 'stuck' && x.state === 'open').flatMap((x) => [...(x.tasks ?? []), ...(x.stream ? [x.stream] : [])]))
  const tasks = judgeTasks(c, log, views, facts, now)
  // 状況の文の古さは、書く道具と同じく帳簿と操作だけから決める（Orca の様子を入れると、書き直しても窓だけが食い違い続ける。Astra 3 の小 1）。
  // 協議のタブの生死（端末の有無）も書く道具は知らないので、控えと比べるカードの状態は端末を見ない overlay で作る（Astra 4 の中 1）。
  const plain = overlay(c, log, archive)
  const stale = staleStreams(c, judgeTasks(c, log, plain, undefined, now), plain)
  const incomplete: Gap[] = []
  const complete = (r: Row) => {
    if (r.status !== 'mine' || r.card.state !== 'open') return true
    const miss = missingFields(r.card)
    if (miss.length) incomplete.push({ kind: 'card', id: r.card.id, title: r.card.title, missing: miss.map((m) => m.label), since: r.card.at ?? opts.firstSeen?.[r.card.id] })
    return !miss.length
  }
  const mine = rows.filter((r) => r.status === 'mine' && r.card.kind !== 'report' && complete(r))
  const dismissed = dismissedStuck(log)
  const leftover = leftoverWorkers(c, root, tasks, facts)
  // 同じ停止を端末の行と Dispatch の行で二重に出さない判定は、「済ませた」を当てる前の行で行う（済ませた端末の行の代わりに Dispatch の行が出ないように）。
  const fromAgents = stuckRows(c, root, (facts?.workers ?? []).filter((a) => !leftover.includes(a)), written)
  const fromDispatch = dispatchStuck(c, root, tasks, written, new Set(fromAgents.flatMap((r) => r.card.tasks ?? [])), dismissed)
  const found = [...mine, ...[...fromAgents, ...questionRows(c, root, facts, now)].filter((r) => !dismissed.has(`${r.card.id}@${r.card.rev}`)), ...fromDispatch]
  const cowork = coworkRows(c, root, facts, found, rows)
  const idle = idleTasks(c, tasks, facts, opts.taskSeen, now)
  const rest = found.filter((r) => !cowork.absorbed.has(r))
  // 深田さんに頼むカードがある仕事の「共同作業中」の行は、要対応のその仕事の見出しにまとめ、一緒に進めているに同じ仕事を重ねない（R259）。
  const asking = new Set(rest.filter(countedRow).map((r) => r.card.stream))
  const heads = cowork.rows.filter((r) => !r.agent?.ask && asking.has(r.card.stream))
  const queue = [...rest, ...cowork.rows.filter((r) => !heads.includes(r))].sort(byUrgency)
  const counts = Object.fromEntries(Object.keys(RANK).map((k) => [k, 0])) as Counts
  for (const r of queue) counts[r.card.kind]++
  const total = queue.filter(countedRow).length
  const recent = (r: Row) => !r.when || now - Date.parse(r.when) < CLOSED_DAYS * DAY
  // when は操作の時刻（UTC の Z）と窓口が書いた時刻（+09:00）が混ざるので、文字列ではなく時刻で比べる。
  const settled = rows.filter((r) => r.status === 'closed').sort((a, b) => timeOf(b.when) - timeOf(a.when))
  const closed = settled.filter(recent)
  const requests = requestViews(c, log, archive, tasks)
  const unsorted = unsortedOf(c, opts.utterances ?? [], new Set(opts.returned ?? returnedUtterances(c, opts.rulings ?? [], opts.consults ?? [], opts.asks ?? [])))
  const late = (g: Gap) => !!g.since && now - Date.parse(g.since) >= GAP_GRACE_MS
  const reqGaps = requests.filter((r) => r.missing.length).map((r): Gap => ({ kind: 'request', id: r.req.id, title: r.req.title, missing: r.missing, since: r.req.at }))

  return {
    views, queue, heads, counts, total, tasks, closed, settled, incomplete, unsorted, requests, idle, leftover, stale,
    talking: queue.filter((r) => r.talking),
    fixing: rows.filter((r) => r.status === 'fixing').sort(byUrgency),
    waiting: rows.filter((r) => r.status === 'waiting').sort((a, b) => timeOf(a.card.awaiting?.since) - timeOf(b.card.awaiting?.since)),
    reports: rows.filter((r) => r.status === 'mine' && r.card.kind === 'report').sort((a, b) => timeOf(b.card.at) - timeOf(a.card.at)),
    jobs: jobViews(c, tasks, queue, rows, facts),
    gaps: [...incomplete, ...reqGaps, ...unsorted].filter(late)
  }
}

/** 移し替え（intake のある帳簿）の前は、どの依頼も古い行として扱う（読み手を入れてから移すまでの間に、25 件を不備と出さないため）。 */
const isLegacy = (c: Cockpit, r: Request) => r.legacy === true || !c.intake

/**
 * 依頼の今。済は証拠から決める（R33）: 済の条件ごとに証拠が 1 つ以上あり、check なら、今の版のカードに押した取り消されていない
 * 「これでよい」の操作が証拠にあるときだけ済。question は回答（answer）の証拠も要る。古い行は書かれた state のまま。
 */
export function requestViews(c: Cockpit, log: UserLog, archive: Card[], tasks: Map<string, TaskView>): RequestView[] {
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  const cardById = new Map([...archive, ...c.cards].map((x) => [x.id, x]))
  const liveOp = (ref: string) => log.ops.find((o) => String(o.op_id) === ref && !undone.has(o.op_id))
  return (c.requests ?? []).map((r): RequestView => {
    const legacy = isLegacy(c, r)
    const ts = (r.tasks ?? []).map((id) => tasks.get(id)).filter((t): t is TaskView => !!t)
    const cards = c.cards.filter((x) => x.request_id === r.id || (x.tasks ?? []).some((t) => r.tasks?.includes(t)))
    const streams = [...new Set([...ts.map((t) => t.task.stream), ...cards.map((x) => x.stream).filter((x): x is string => !!x)])]
    // 操作の証拠は取り消されていないものだけ。「これでよい」は、押した版が今のカードの版と同じときだけ効く
    // （同じ URL を改訂したら rev を上げるので、古い承認は外れる）。済の条件を埋める段で照合し、古い承認で条件を埋めない。
    const ev = (r.evidence ?? []).filter((e) => {
      if (e.kind !== 'op') return true
      const o = liveOp(e.ref)
      if (!o || (e.card !== undefined && o.item_id !== e.card)) return false
      if (o.type !== 'accept') return true
      const card = cardById.get(o.item_id)
      return !!card && o.item_rev === card.rev && (e.rev === undefined || e.rev === card.rev)
    })
    // 済の条件の番号（evidence の when・element_map の「r30#2」）は、人がカードで読む番号と同じ 1 始まり。
    const covered = (r.done_when ?? []).map((_, i) => ev.some((e) => e.when === i + 1))
    if (legacy) {
      return { req: r, legacy, tasks: ts, cards, streams, missing: [], covered, state: r.state === 'done' ? '済' : ts.length ? '進行中' : '受付' }
    }
    const missing = [!r.utterances?.length && !r.source && '発言（utterances）か出典（source）', !r.done_when?.length && '済の条件（done_when）', !r.kind && '種類（kind）'].filter((x): x is string => !!x)
    const accepted = ev.some((e) => e.kind === 'op' && liveOp(e.ref)?.type === 'accept')
    const all = covered.length > 0 && covered.every(Boolean) && (r.kind !== 'question' || ev.some((e) => e.kind === 'answer'))
    const reviewing = cards.some((x) => x.kind === 'review' && x.state === 'open')
    const state: RequestState = all && (!r.check || accepted) ? '済' : (all && r.check) || reviewing ? '確認待ち' : ts.length || ev.length || cards.length ? '進行中' : '受付'
    return { req: r, legacy, tasks: ts, cards, streams, missing, covered, state }
  })
}

/**
 * 仕分けていない発言。intake の through より後の発言と、checked_through より後で through 以前のうち、どの依頼にも none にも結ばれていないもの。
 * id の無い行（発言に id を付ける前の記録）は結べないので見ない。intake の無い帳簿（移し替えの前）は検査しない。
 */
export function unsortedOf(c: Cockpit, utterances: Utterance[], returned: ReadonlySet<string> = new Set()): Gap[] {
  if (!c.intake) return []
  const ids = utterances.filter((u): u is Utterance & { id: string } => !!u.id)
  const at = (id: string | undefined) => (id ? ids.findIndex((u) => u.id === id) : -1)
  const through = at(c.intake.through)
  const checked = at(c.intake.checked_through)
  const bound = new Set([...(c.intake.none ?? []), ...(c.requests ?? []).flatMap((r) => (r.utterances ?? []).map((u) => u.id))])
  return ids
    .filter((u, i) => !returned.has(u.id) && (i > through || (i > checked && !bound.has(u.id))))
    .map((u) => ({ kind: 'utterance', id: u.id, title: (u.prompt ?? '').replace(/\s+/g, ' ').slice(0, 60), missing: ['仕分け'], since: u.at }))
}

/**
 * 相談・質問の返しで反映された発言の id。決まったこと（decisions[].utterance）は判断の記録にその返しの from_return があれば、
 * 依頼（requests[].utterance）は帳簿の依頼にその返しの from_return があれば、仕分け済みとみなす（追加 32）。
 */
export function returnedUtterances(c: Cockpit, rulings: Ruling[], memos: ConsultMemo[], asks: AskThread[]): string[] {
  const inRulings = new Set(rulings.map((r) => r.from_return).filter(Boolean))
  const inRequests = new Set((c.requests ?? []).map((r) => r.from_return).filter(Boolean))
  const rets = [...memos.flatMap((m) => m.returns), ...asks.flatMap((a) => a.returns)]
  const ids = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => x?.utterance).filter((x): x is string => typeof x === 'string') : [])
  return [...new Set(rets.flatMap((r) => [...(inRulings.has(r.return_id) ? ids(r.decisions) : []), ...(inRequests.has(r.return_id) ? ids(r.requests) : [])]))]
}

/** 案件の名前の区切りと形の言い方（R165）。hook は checks.workspace_name.message を流すだけにし、形をここ 1 か所に持つ（R181）。 */
export const WORKSPACE_NAME_SEP = '｜'
export const WORKSPACE_NAME_FORM = `「<顧客>${WORKSPACE_NAME_SEP}<案件>」（社内は「社内${WORKSPACE_NAME_SEP}<案件>」）`
/** 案件の名前が「顧客｜案件」の形か（R165）。全角の｜でちょうど 2 つに分かれ、前後の空白を外して両方が空でないこと。 */
export const workspaceNameOk = (name: string) => {
  const parts = name.trim().split(WORKSPACE_NAME_SEP)
  return parts.length === 2 && parts.every((p) => p.trim() !== '')
}
/** 直し方は書く道具で示す。移し替えたあとの帳簿の直書きは hook が断るため（監査 13:50 の重大 1）。 */
const WORKSPACE_NAME_FIX = 'cockpit-write に { "workspace": { "name": "…" } } を渡して直す（R165）'
export const workspaceNameCheck = (name: unknown, fix = WORKSPACE_NAME_FIX): { name: string; message: string } | null =>
  typeof name !== 'string' || !name.trim()
    ? { name: '', message: `案件の名前（cockpit.json の workspace.name）が無い。${WORKSPACE_NAME_FORM}の形で、${fix}` }
    : workspaceNameOk(name) ? null
    : { name, message: `案件の名前「${name}」が${WORKSPACE_NAME_FORM}の形になっていない。${fix}` }

/**
 * その案件で一任された許可の単位（R95・R173）。深田が「この案件では一任する」を押して窓口が記録した、有効な（置き換えられていない）
 * permission の判断（allow が true）の scope。cockpit skill の cards.md の N1 と同じ見分け方。
 */
export const delegatedScopes = (rulings: Ruling[]): Set<string> => {
  const replaced = new Set(rulings.flatMap((r) => r.supersedes ?? []))
  return new Set(rulings.filter((r) => !replaced.has(r.id) && r.kind === 'permission' && r.allow === true && typeof r.scope === 'string').map((r) => r.scope!.trim()))
}

/** 放置の線（R169・R170）。worker も担当も動いていない作業中は 2 時間、未着手・待機は 24 時間。 */
export const IDLE_HOURS: Partial<Record<TaskState, number>> = { run: 2, idle: 24, wait: 24 }
/**
 * 線を越えたタスク。since は最後に動いた時刻で、from はその出どころ（帳簿の更新・済んだことの記録・worker の最後の動き）。
 * check は確認日（check_on）が来て出したときのその日付で、since はその日の 0:00（R171）。
 */
export type IdleTask = { task: string; since: string; hours: number; line: number; from: string; worker: string; check?: string }

/**
 * 線を越えて動いていないタスク（R170）。待つ相手（waiting_on）のあるタスクと、確認日（check_on）の前のタスクは拾わない。
 * 確認日の来た済んでいないタスクは、その日の 0:00 より後に動いていなければ、待つ相手があっても線を越えたものとして出す（R171）。
 * 作業中は、worker が動いている・担当が作業中のものと、Orca を読めていない（動いているか分からない）ものを除く。
 * 一緒に作る仕事で担当がターンを終えたものは、返事待ちの行（R128）が出るので除く。未着手・待機は帳簿のままのもの（worker の取り込み待ちは checks.intake）。
 */
export function idleTasks(c: Cockpit, tasks: Map<string, TaskView>, facts: OrcaFacts | undefined, seen: TaskSeen | undefined, now: number): IdleTask[] {
  const today = tokyoDay(now)
  return [...tasks.values()].flatMap((t): IdleTask[] => {
    const task = t.task
    const line = IDLE_HOURS[t.state]
    // 外の待ち（相手・出来事・日付の前）は線で拾わない。日付の待ちは、その日が来たら確認日として出す（R171）。
    const outside = !!t.hold && ['person', 'event', 'date'].includes(t.hold.kind)
    const day = task.wait?.kind === 'date' ? task.wait.on : undefined
    const due = !!day && today >= day && t.state !== 'ok' && t.why === 'record'
    if (!due && (!line || t.why !== 'record' || outside)) return []
    const owner = ownerOf(c, { stream: task.stream }, facts)
    if (t.state === 'run') {
      // Orca を読めていない（窓は端末の一覧が無い・hook の CLI は facts が無い）か、チャットの担当の様子を読めていないと、動いているか分からないので保留する。
      if (!facts?.terminals || (task.worker && !facts.dispatches) || (owner.how === 'chat' && (!facts.owners || facts.ownersStale)) || owner.state === 'working') return []
      if (owner.state === 'done' && c.streams.find((s) => s.id === task.stream)?.form === 'cowork') return []
    }
    // 窓が覚えた印と今の中身が違えば、まだ覚えていない変化なので今動いたとみなす（常駐のプロセスが止まっていても誤って出さない）。
    const mark = seen?.[task.id]
    const marks: [number, string][] = [
      [mark?.sig === taskSig(task) ? Date.parse(mark.at) : now, '帳簿の更新'],
      [Math.max(0, ...(task.done ?? []).map((d) => (typeof d === 'string' ? 0 : timeOf(d.at)))), '済んだことの記録'],
      [timeOf(task.wait?.since), '帳簿の更新'],
      [t.settledAt ?? 0, 'worker の最後の動き']
    ]
    const [at, from] = marks.reduce((a, b) => (b[0] > a[0] ? b : a))
    const worker = task.worker ? (t.state === 'run' ? 'worker の記録はあるが Orca に動きなし' : 'worker の記録あり') : 'worker なし'
    const who = owner.how === 'main' ? '担当を立てず窓口が受け持つ' : `担当「${owner.title}」は${owner.state === 'working' ? '作業中' : owner.state === 'done' ? '待機' : owner.state ? '止まっている' : '状態不明'}`
    const start = due ? tokyoStart(day!) : 0
    if (due && at <= start)
      return [{ task: task.id, since: new Date(start).toISOString(), hours: Math.floor((now - start) / 3_600_000), line: 0, from, worker: `${worker}・${who}`, check: day }]
    if (!line || outside || now - at < line * 3_600_000) return []
    return [{ task: task.id, since: new Date(at).toISOString(), hours: Math.floor((now - at) / 3_600_000), line, from, worker: `${worker}・${who}` }]
  })
}

/** タスクに結ばれず止まったものは残っている worker に数えず、詰まりの行に残す（利用枠などは深田さんが直す）。 */
export function leftoverWorkers(c: Cockpit, root: string, tasks: Map<string, TaskView>, facts: OrcaFacts | undefined): AgentRow[] {
  const owners = (c.owners ?? []).filter((o) => o.state !== 'done').flatMap((o) => {
    const ref = ownerOf(c, { owner: o.id, stream: o.stream }, facts)
    return [o.session, o.terminal, ref.session, ref.terminal].filter((x): x is string => !!x)
  })
  return (facts?.workers ?? []).filter((a) => {
    if (!a.worktree || a.worktree === root) return false
    if ((a.session && owners.includes(a.session)) || (a.terminalId && owners.includes(a.terminalId))) return false
    const t = a.task ? tasks.get(a.task) : undefined
    // 確認のカードが開いていると judgeTasks はカード待ちを先に返すので、Dispatch が終わったかは事実で見る（Astra）。
    if (t) return t.task.state === 'ok' || t.why === 'ok' || t.why === 'intake' || !!facts?.dispatches?.[currentDispatch(t.task, facts) ?? '']?.settledAt
    return a.state === 'done' && !a.stop
  })
}

/** カードの種類ごとの、深田さんを待っている語。 */
const ASK_WORD: Record<CardKind, string> = { review: '確認', permit: '許可', decide: '判断', send: '送る前の確認', stuck: '回答', consult: '相談', talk: '協議', inbox: '返信', report: '既読' }
/** 外の待ちの 1 行（人が読む文）。who・what は窓口が書いた語をそのまま使う（R203）。 */
export function waitLabel(w: Wait): string {
  const got = w.need && w.need > 1 ? `（${metCount(w)}/${w.need} 件届いた）` : ''
  if (w.kind === 'person') return `${w.who}の返事待ち（${w.what}）${got}`
  if (w.kind === 'event') return `${w.what}${/待[つち]$/.test(w.what ?? '') ? '' : 'を待つ'}${got}`
  if (w.kind === 'date') return `${fmtDate(w.on)} に確かめる: ${w.what}`
  return `空き枠の順番待ち（${w.why}）`
}
/** 印の短い要約（状況の文の古さを、待ちの中身が変わったときにも見るため。Astra 3 の重大 1）。 */
const digest = (v: unknown) => {
  let h = 5381
  for (const ch of JSON.stringify(v)) h = ((h << 5) + h + ch.codePointAt(0)!) | 0
  return (h >>> 0).toString(36).slice(0, 6)
}

/**
 * カードを押したときに、結んだタスクに起きること（R204。closes_tasks の欄は足さない）。effects があればそれ、無ければ種類の今の意味:
 * 確認（review）の承認は済、許可・判断・送る前・停止・相談は、そのカードの待ちが解けて着手できる（却下・別の回答でも、解けるのはそのカードの待ちだけ）、
 * 報告・受信は何も起きない。
 */
export const cardEffect = (x: Pick<Card, 'kind' | 'effects'>, task: string): CardEffect =>
  x.effects?.[task] ?? (x.kind === 'review' ? 'done' : x.kind === 'report' || x.kind === 'inbox' ? 'none' : 'start')

/**
 * 承認（accept）でカードが済になったか。窓口がまだ反映していない、今の版への取り消されていない承認か、窓口が深田さんの操作で閉じたカードの今の版への承認。
 * 反映前に取り消した承認は、窓口がカードを開いたままにするので済にならない。反映後に取り消したものは、窓口が閉じたカードの結果を残し、
 * 取り消しの op（未反映の操作に出る）で戻すかを判断にする（ops.md の undo。Astra 3 の重大 4）。
 */
function accepted(v: CardView, log: UserLog): boolean {
  if (v.status === 'closed' && v.pending) return v.undoOp?.type === 'accept'
  if (v.card.state !== 'done' || v.card.resolved_by !== 'user') return false
  // 今の版に押された、取り消されていない最後の操作で決める（許可 → 反映前に取消 → 却下、で過去の承認を拾わない。Astra 4 の重大 1）。
  // 閉じた（resolved_at）あとの取り消しは数えない。反映後の取り消しは結果を残し、窓口の再判断で戻す（ops.md の undo。Astra 5 の重大）。
  const closed = timeOf(v.card.resolved_at) || Infinity
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null && timeOf(o.at) <= closed).map((o) => o.undo_of))
  const last = log.ops.filter((o) => o.item_id === v.card.id && o.item_rev === v.card.rev && o.type !== 'undo' && !undone.has(o.op_id)).at(-1)
  return last?.type === 'accept'
}

/** 開いている（解けていない）外の待ちか。date は東京の日付がその日に来るまで。 */
export const waitOpen = (w: Wait | undefined, today: string): w is Wait =>
  !!w && (w.kind === 'slot' || (w.kind === 'date' ? today < (w.on ?? '') : !waitMet(w)))

/**
 * タスクの worker の記録が、同じ仕事の開いた担当のものか（t159）。担当の受け取りは owners[].worker に書く決まりだが、それより前の帳簿は
 * タスクの worker に担当の受け取りがある。担当がターンを終えると Dispatch は exited になり、worker の停止と読むと窓が「落ちた」と出し、
 * 整理が担当を片付けうるので、担当の受け取り（task_id）か、Dispatch のチャットが担当の session と同じなら worker として判定しない。
 */
function leadOf(c: Cockpit, t: Task, facts: OrcaFacts | undefined): Owner | undefined {
  if (!t.worker) return undefined
  const own = (c.owners ?? []).filter((o) => o.stream === t.stream && o.state !== 'done')
  const did = currentDispatch(t, facts)
  const session = did ? facts?.dispatches?.[did]?.session : undefined
  return own.find((o) => o.worker?.task_id === t.worker!.task_id || (!!session && o.session === session))
}

/**
 * タスクの今を事実から決める（R204）。窓・パネル・hook・書く道具が同じこの関数を通す。上が勝つ:
 * 1. 済: 窓口が ok と書いたか、カードの効果（cardEffect）が済のカードが承認された
 * 2. 止まり: 開いた停止のカード
 * 3. 深田さん待ち: 開いた私の番のカード（協議中も深田さん待ちのまま。worker が動いていても・終わっていても、行動するのは深田さん。Astra 3 の中 1）
 * 4. 止まり: worker が Orca で止まった・見つからない
 * 5. worker の取り込み待ち・作業中（直しを伝えたカードがあれば修正中と出す）
 * 6. 修正中: 「直しを伝える」を押したカード（深田さん待ちにしない。Astra 2 の 2）
 * 7. 相手待ち: 送ったあと返事を待つカード
 * 8. 外の待ち（wait）: 相手・出来事・日付の前は待ち、空き枠は順番待ち
 * 9. 前提待ち: after のタスクが済んでいない
 * 10. 着手できる（日付の待ちは、その日が来てもここ。済の証拠にしない）
 * facts が無い（書く道具・パネル）と worker の様子は入れない。
 */
export function judgeTasks(c: Cockpit, log: UserLog, views: CardView[], facts: OrcaFacts | undefined, now: number): Map<string, TaskView> {
  const byTask = new Map<string, CardView[]>()
  for (const v of views) {
    if (isSynthetic(v.card.id)) continue
    for (const id of v.card.tasks ?? []) byTask.set(id, [...(byTask.get(id) ?? []), v])
  }
  const done = new Map<string, 'hand' | 'card'>()
  for (const t of c.tasks) {
    if (t.state === 'ok') done.set(t.id, 'hand')
    else if ((byTask.get(t.id) ?? []).some((v) => cardEffect(v.card, t.id) === 'done' && accepted(v, log))) done.set(t.id, 'card')
  }
  const title = new Map(c.tasks.map((t) => [t.id, t.title]))
  const today = tokyoDay(now)
  const out = new Map<string, TaskView>()
  for (const t of c.tasks) {
    const lead = leadOf(c, t, facts)
    const did = lead ? undefined : currentDispatch(t, facts)
    const fact = facts?.dispatches && t.worker && !lead ? (did ? facts.dispatches[did] ?? null : null) : undefined
    const base = { task: t, settledAt: fact?.settledAt }
    const how = done.get(t.id)
    if (how) {
      out.set(t.id, { ...base, state: 'ok', why: 'ok', label: '完了', done: how })
      continue
    }
    const set = (state: TaskState, why: ShownWhy, hold: Hold | undefined, label = hold?.label ?? '', stop?: string) =>
      out.set(t.id, { ...base, state, why, label, ...(hold && { hold }), ...(stop && { stop }) })
    const w = shownTask(t, fact)
    const live = (byTask.get(t.id) ?? []).filter((v) => v.status !== 'closed' && cardEffect(v.card, t.id) !== 'none' && v.card.kind !== 'report' && v.card.kind !== 'inbox')
    const mine = live.filter((v) => v.status === 'mine')
    const stuck = mine.find((v) => v.card.kind === 'stuck')
    const ask = mine.find((v) => v.card.kind !== 'stuck')
    const fixing = live.find((v) => v.status === 'fixing')
    const reply = live.find((v) => v.status === 'waiting')
    const cardHold = (v: CardView, kind: Hold['kind'], label: string): Hold => ({ kind, label, key: `${kind}:${v.card.id}@${v.card.rev}`, card: v.card.id, since: v.when ?? v.card.at })
    const fix = fixing && cardHold(fixing, 'fixing', `修正中（${fixing.card.id} の直し）`)
    if (stuck) set('stop', 'record', cardHold(stuck, 'stuck', `止まっている（${stuck.card.id}）`))
    else if (ask) set('wait', 'record', ask.talking ? cardHold(ask, 'talking', `深田さんと協議中（${ask.card.id}）`) : cardHold(ask, 'card', `深田さんの${ASK_WORD[ask.card.kind]}待ち（${ask.card.id}）`))
    else if (w && (w.why === 'stopped' || w.why === 'missing'))
      set('stop', w.why, { kind: 'worker', key: 'worker', label: w.why === 'missing' ? 'worker が Orca に見つからない' : `worker が止まった（${STOP_LABEL[w.stop as StopReason] ?? w.stop}）` }, undefined, w.stop)
    else if (w?.why === 'intake') set('wait', 'intake', { kind: 'intake', key: 'intake', label: 'worker の結果の取り込み待ち' })
    else if (w?.why === 'working') set('run', 'working', fix, fix ? `worker が${fix.label}` : 'worker が作業中')
    else if (fix) set('run', 'record', fix)
    else if (reply) set('wait', 'record', cardHold(reply, 'reply', `${reply.card.awaiting?.who ?? '相手'}の返事待ち（${reply.card.awaiting?.what ?? reply.card.title}）`))
    else if (waitOpen(t.wait, today)) {
      const x = t.wait
      set(x.kind === 'slot' ? 'idle' : 'wait', 'record', {
        kind: x.kind, label: waitLabel(x), since: x.since,
        key: `${x.kind}:${x.kind === 'date' ? x.on : x.kind === 'slot' ? '' : `${metCount(x)}/${x.need ?? 1}`}:${digest([x.who, x.what, x.why, x.on])}`
      })
    } else {
      const ahead = (t.after ?? []).filter((id) => !done.has(id))
      if (ahead.length) set('idle', 'record', { kind: 'after', key: `after:${ahead.join(',')}`, label: `前提待ち（${ahead.map((id) => (title.has(id) ? `${id}「${title.get(id)}」` : `${id}（帳簿に無い）`)).join('・')}）` })
      else {
        const came = t.wait?.kind === 'date' ? `確かめる日が来た: ${t.wait.what}` : undefined
        // 担当の名前を出すのは、担当の受け取りと照合できたタスクか、worker の記録の無いタスクだけ（担当の子の worker のタスクを担当と言わない）。
        const own = lead ?? (t.worker ? undefined : c.owners?.find((o) => o.stream === t.stream && o.state !== 'done'))
        set('run', 'record', undefined, came ?? (own ? `担当「${own.title}」が受け持つ` : t.worker && !facts ? 'worker に任せている' : '着手できる'))
      }
    }
  }
  return out
}

/**
 * 仕事の状況の文の元になる事実（R204）: その仕事のタスクの判定（済も含む。新しく済になったタスクを見つけるため）と、閉じていないカードの状態と版。
 * 書く道具は書いたときにこれを status_basis に控え、窓と書く道具は今の値と比べて状況の文の古さを決める。帳簿と操作だけから作る（Orca の様子は入れない）。
 */
export function streamBasis(c: Cockpit, tasks: Map<string, TaskView>, views: CardView[], stream: string): string[] {
  const mine = new Set(c.tasks.filter((t) => t.stream === stream).map((t) => t.id))
  const rows = [...mine].map((id) => {
    const t = tasks.get(id)
    return t ? `${id}:${t.state}${t.hold ? `:${t.hold.key}` : ''}` : `${id}:?`
  })
  for (const v of views)
    if (v.status !== 'closed' && !isSynthetic(v.card.id) && (v.card.stream === stream || (v.card.tasks ?? []).some((id) => mine.has(id))))
      rows.push(`${v.card.id}:${v.status}@${v.card.rev}`)
  return [...new Set(rows)].sort()
}

const sameList = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i])

/** 状況の文が古い仕事。移し替え（facts_since）の前の帳簿と、見張る仕事（状況は Bot の前回の結果）は見ない。 */
export function staleStreams(c: Cockpit, tasks: Map<string, TaskView>, views: CardView[]): Map<string, StaleStatus> {
  const out = new Map<string, StaleStatus>()
  if (!c.facts_since) return out
  for (const s of c.streams) {
    if (s.form === 'watch') continue
    const basis = streamBasis(c, tasks, views, s.id)
    if (!sameList(s.status_basis, basis)) out.set(s.id, { basis, ...(s.status_basis && { was: s.status_basis }) })
  }
  return out
}

/** 控えた事実と今の事実の違いを、人が読む 1 行ずつにする（書く道具の断りの文と窓の詳細）。 */
export function basisChanges(was: string[] | undefined, now: string[], tasks: Map<string, TaskView>): string[] {
  if (!was) return ['状況の文を、事実から決める形にしてからまだ書き直していない']
  const head = (x: string) => x.split(':')[0]!
  const before = new Map(was.map((x) => [head(x), x]))
  const after = new Map(now.map((x) => [head(x), x]))
  const word = (id: string) => {
    const t = tasks.get(id)
    return t ? `${id}「${t.task.title}」: ${t.label}` : id
  }
  const out: string[] = []
  for (const [id, x] of after) if (before.get(id) !== x) out.push(before.has(id) ? `${word(id)}（前: ${before.get(id)!.slice(id.length + 1)}）` : `${word(id)}（新しい）`)
  for (const id of before.keys()) if (!after.has(id)) out.push(`${id}: 閉じた・無くなった`)
  return out
}

/** 古くなった状況の文の代わりに窓が出す、計算の短い文。 */
export function statusFallback(tasks: TaskView[]): string {
  const live = tasks.filter((t) => t.state !== 'ok')
  const n = (f: (t: TaskView) => boolean) => live.filter(f).length
  const parts = [
    n((t) => t.state === 'stop') && `止まっている ${n((t) => t.state === 'stop')}`,
    n((t) => t.hold?.kind === 'card' || t.hold?.kind === 'talking') && `深田さん待ち ${n((t) => t.hold?.kind === 'card' || t.hold?.kind === 'talking')}`,
    n((t) => t.state === 'run') && `作業中・着手できる ${n((t) => t.state === 'run')}`,
    n((t) => t.state === 'wait' && !['card', 'talking'].includes(t.hold?.kind ?? '')) && `待ち ${n((t) => t.state === 'wait' && !['card', 'talking'].includes(t.hold?.kind ?? ''))}`,
    n((t) => t.state === 'idle') && `順番・前提待ち ${n((t) => t.state === 'idle')}`
  ].filter(Boolean)
  return `状況の文が古いので、窓口が書き直すまで事実だけを出しています。${parts.length ? `${parts.join('・')}、` : ''}完了 ${tasks.length - live.length}/${tasks.length}`
}

/** 仕事ごとの今。済んだ仕事は後ろに回す。メインの書いた要約は使わず、タスクとカードから決める。 */
function jobViews(c: Cockpit, tasks: Map<string, TaskView>, queue: Row[], rows: Row[], facts: OrcaFacts | undefined): JobView[] {
  const order: Record<JobState, number> = { mine: 0, stopped: 1, working: 2, customer: 3, outside: 4, idle: 5, done: 6 }
  return c.streams
    .map((s): JobView => {
      const ts = [...tasks.values()].filter((t) => t.task.stream === s.id)
      const mine = queue.filter((r) => r.card.stream === s.id && COUNTED.includes(r.card.kind)).length
      // 一緒に作る仕事で担当が返事を待っていれば、件数に数えるカードが無くても私の番にする（R128）。
      const reply = queue.some((r) => r.card.id === `${COWORK_ID}${s.id}` && !!r.agent?.ask)
      const waiting = rows.find((r) => r.status === 'waiting' && r.card.stream === s.id)
      const live = ts.filter((t) => t.state !== 'ok')
      const worst: TaskState | undefined = worstState(live.map((t) => t.state))
      const person = live.find((t) => t.state === 'wait' && t.hold?.kind === 'person')
      const ext = person ?? live.find((t) => t.state === 'wait' && ['event', 'date'].includes(t.hold?.kind ?? ''))
      const state: JobState = mine || reply ? 'mine'
        : worst === 'stop' ? 'stopped'
        : worst === 'run' ? 'working'
        : waiting || person ? 'customer'
        : ext ? 'outside'
        : worst === 'idle' || worst === 'wait' ? 'idle'
        : 'done'
      const label = state === 'customer' && waiting?.card.awaiting?.who ? `${waiting.card.awaiting.who}の返事待ち`
        : (state === 'customer' || state === 'outside') && ext ? ext.label
        : state === 'mine' ? [reply && REPLY_LABEL, mine && `私待ち ${mine} 件`].filter(Boolean).join('・') : JOB_LABEL[state]
      const nextTask = live.find((t) => t.state === worst) ?? live[0]
      return {
        id: s.id, title: s.title, state, label, mine, ...(reply && { reply }),
        next: state === 'done' ? undefined : nextTask?.task.next?.trim() || nextTask?.task.title,
        owner: c.owners?.some((o) => o.stream === s.id && o.state !== 'done') ? ownerOf(c, { stream: s.id }, facts) : undefined,
        since: waiting?.card.awaiting?.since ?? ext?.hold?.since
      }
    })
    .sort((a, b) => order[a.state] - order[b.state])
}

export function countsText(n: Counts, total: number): string {
  if (!total) return '私の番はありません'
  const reply = total - COUNTED.reduce((s, k) => s + n[k], 0)
  const parts = [...COUNTED.filter((k) => n[k]).map((k) => `${KIND_LABEL[k]} ${n[k]}`), ...(reply > 0 ? [`返事 ${reply}`] : [])]
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
  /** 私の番のカード（件数に数えるもの）を急ぐ順に。操作を重ね、Orca で止まった worker の詰まりを足したあと。desk の朝の見回りが読む。 */
  mine: { id: string; kind: CardKind; title: string; due?: string }[]
  overdue: string[]
  /** 「担当と話す」を押して、同じ版のまま私の番に残っているカード（with は話し相手）。 */
  talking: { id: string; since: string; with: string }[]
  /** 見てで直しを頼み、直した版を待っているカード。 */
  fixing: string[]
  waiting: { id: string; who: string; what: string; since: string; remind_at?: string }[]
  /** orca は Orca のサイドバーに出す形（表示名・状態・未読の印）。担当の作業場所に当てる。 */
  jobs: { id: string; title: string; state: JobState; label: string; next?: string; orca: { display_name: string; status: OrcaStatus; unread: boolean } }[]
  /** dispatch は今の Dispatch の id（最初の Task から続きをたどった先。worker の無いタスクは null）。担当と hook はこれで今の Dispatch を引く。 */
  tasks: { id: string; title: string; state: TaskState; label: string; from: TaskShown['why']; dispatch: string | null }[]
  /** 依頼の帳簿の今（受けた順）。state は証拠から決めたもの。 */
  requests: { id: string; title: string; state: RequestState; legacy: boolean }[]
  workers: { task?: string; job?: string; state: string; stop?: StopReason }[]
  checks: {
    pending_ops: number
    /** 取り消しの猶予を過ぎ、窓口がまだ反映していない整理・棚卸しの指示の op_id。Stop の hook が、残したままターンを終えないよう差し戻す（t163）。 */
    unapplied_tidy: number[]
    /** 決めるのに「これは何か」など 5 欄が欠けたカード。 */
    missing_context: string[]
    /** 手作業を頼むのに、打つコマンドも手順も書いていない許す（manual）。 */
    empty_manual: string[]
    /** 催促の日を過ぎた顧客待ち（担当が「送る前」に催促の下書きを出す）。 */
    remind_due: string[]
    /** 仕事にも担当にもつながらない開いたカード。 */
    orphan_cards: string[]
    /** 成果物（href・links）が一時フォルダのファイルのままの、開いた見て・報告（artifact の URL か ~/orca-pages の HTML にして渡す）。 */
    local_deliverables: string[]
    intake: string[]
    missing_workers: string[]
    /** 進行中のタスクが無く、push の許すも開いておらず、push も一任されていない（hook が git を見て、残りがあれば push の許すを出させる）。 */
    push_check: boolean
    /** 進行中のタスクが無く、この案件の push が一任されている（hook が git を見て、残りがあれば窓口に自分で push させる。許すは出さない）。 */
    push_delegated: boolean
    plugin: string | null
    /** 「顧客｜案件」の形になっていない案件の名前（workspace.name、R165）と、窓口に流す 1 文。形が合っていれば null。hook は message をそのまま流す。 */
    workspace_name: { name: string; message: string } | null
    /** 済んでいない仕事で、状況の文（status、R188）が無いものの id。見張る仕事は除く（状況は Bot の前回の結果を窓が Orca から読む）。 */
    status_missing: string[]
    /** 状況の文が、書いたときの元の事実（status_basis）と食い違う仕事（R204）。changes は変わった事実（人が読む 1 行ずつ）。次の書き込みで書き直す。 */
    stale_status: { id: string; changes: string[] }[]
    /** 開いた相手・出来事の待ちがあるのに、待ちと照らしていない Orca の知らせ（notices.jsonl の n-…。待ちを始めた時刻より後のもの。R204）。 */
    unsorted_notices: string[]
    /** 読めていない経路。 */
    routes: string[]
    /** サイドバーで切れる長さの仕事・担当・タスクの名前（NAME_MAX を超える）。 */
    long_names: string[]
    /** 必須の欄が欠けて窓に出していない確認依頼（R46-4）。窓口が埋める。30 分を過ぎると窓の「抜けている」に出る。 */
    incomplete_cards: { id: string; missing: string[] }[]
    /** 発言と済の条件の欠けた依頼（移し替えのあとに受けた行）。 */
    incomplete_requests: { id: string; missing: string[] }[]
    /** 仕分けていない発言の id（R33）。窓口がそのターンのうちに依頼か none に結ぶ。 */
    unsorted: string[]
    /** 今の Dispatch が済んで Orca のタスクも終わったのに、手書きの state が run のままのタスク。 */
    stale_tasks: string[]
    /** 線を越えて動いていないタスク（R170）。hook は「task@since」ごとに最初の 1 回だけ窓口に流す（since は動くたびに変わる）。 */
    idle_tasks: { task: string; since: string; hours: number }[]
    /** 仕事（streams）に入っていない、済んでいないタスク。 */
    loose_tasks: string[]
    /** 5 段（STAGES）のどれにも寄せられない工程名の、済んでいないタスク（「t12（作る）」の形）。 */
    unknown_phase: string[]
    /** 形（form: delegate・cowork・watch）の書かれていない、済んでいない仕事（R51）。 */
    no_form: string[]
    /** watch（{ automation, targets, to }）の書かれていない見張る仕事（R152）。 */
    watch_missing: string[]
    /** watch の automation が Orca の automations に無い見張る仕事（「s3（4f1ce9db…）」の形）。Orca を読めなかったときは空。 */
    watch_unknown: string[]
    /** 「これでよい」の op が来ているのに、要素（elements）の行き先（element_map）が欠けたカードと欠けた番号（9.2）。 */
    unmapped_elements: { card: string; missing: number[] }[]
    /** 結ばれたタスクが全部済なのに、証拠の無い済の条件（done_when の番号、1 始まり）が残る依頼（9.4）。 */
    unproven: { request: string; when: number[] }[]
    /** 判断（rulings.jsonl）の affects に挙がったのに、reviewed_for にその判断の無いタスク（9.5）。 */
    affected_tasks: { ruling: string; task: string }[]
    /** カードの相談と質問の返しの記録にあって判断の記録か帳簿に入っていない返しと、保留の返し（設計 10.7 の 1）。 */
    unreflected_returns: (Unreflected | AskUnreflected)[]
    /** カードが片付いたのに Orca に残っている相談のタブ（10.7 の 8）。 */
    stale_consults: { id: string; terminal: string }[]
  }
  /** 全体の 1 行（hook が発言のたびにメインに流す）。 */
  overview: string
  /** ワークスペースのカードのコメント（orca worktree set --comment）。 */
  card: string
}

/** conflict_of は、切り替え前のメモで同じ番号の別の返しとぶつかったため compaction-keep.py が取り込むときに新しい番号を付けた返しの元の番号（反映し終えるまで missing に「番号の衝突」）。 */
export type Unreflected = { id: string; card: unknown; missing: ('判断の記録' | '帳簿' | '保留' | '番号の衝突')[]; memo: string | null; returns: string | null; conflict_of?: string }
/**
 * 窓からの質問の返しの未反映。id のある行は返し、id が null の行は返しの無い「これで決める」。
 * missing は 判断の記録・帳簿（asks[].from_returns）・保留（asks[].held_returns）・担当への通知（asks[].notify[] の message_id の無い行）・返し。
 */
export type AskUnreflected = { id: string | null; ask: string; op?: unknown; missing: string[]; memo: string; returns?: string | null; tasks?: unknown[] }

/**
 * カードの相談の返しの記録にあって、判断の記録の from_return か帳簿のカード（片付けて移したものも）の from_returns のどちらかに無い返しと、
 * カードの held_returns に残る返し。返しの未反映の判定はここだけに置く。compaction-keep.py（unreflected と、開始・圧縮のあとの組み直し）も
 * window/state.ts の出力の checks.unreflected_returns を読む。
 */
export function unreflectedReturns(cards: ReturnMark[], rulings: Ruling[], memos: ConsultMemo[], asks?: AskSide): (Unreflected | AskUnreflected)[] {
  const inRulings = new Set<unknown>(rulings.map((r) => r.from_return))
  const inLedger = new Set(cards.flatMap((x) => x.from_returns ?? []))
  const held = new Map<unknown, unknown>()
  for (const x of cards) for (const id of x.held_returns ?? []) held.set(id, x.id)
  const out: Unreflected[] = []
  for (const m of memos)
    for (const v of m.returns) {
      const missing: Unreflected['missing'] = [...(inRulings.has(v.return_id) ? [] : ['判断の記録' as const]), ...(inLedger.has(v.return_id) ? [] : ['帳簿' as const]), ...(held.has(v.return_id) ? ['保留' as const] : [])]
      const clash = typeof v.conflict_of === 'string' && v.conflict_of ? v.conflict_of : undefined
      if (missing.length) out.push({ id: v.return_id, card: typeof v.card === 'string' && v.card ? v.card : m.card, missing: clash ? [...missing, '番号の衝突'] : missing, memo: m.path, returns: m.returnsPath, ...(clash && { conflict_of: clash }) })
    }
  // 返しの記録に無い返しでも、保留にしたものは相談が返し直すまで名指しする。
  const named = new Set(out.map((x) => x.id))
  const rest = [...held].filter(([id]) => !named.has(id as string)).sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
  return [...out, ...rest.map(([id, card]): Unreflected => ({ id: id as string, card, missing: ['保留'], memo: null, returns: null })), ...(asks ? unreflectedAsks(asks, inRulings) : [])]
}

/**
 * 写しのタブを閉じてよい質問（R180）: 返しが全部帳簿に反映され（unreflected_returns に無い）、返しの無い「この答えを窓口に返す」も無く、
 * 最後の質問に答えが届いているもの。返しが 1 件も無い質問も、ほかの条件を満たせば入る。時間の条件（最後の質問か答えから 1 時間）は呼ぶ側が見る。
 */
export function settledAsks(s: AskSide, rulings: Ruling[]): string[] {
  const open = new Set(unreflectedAsks(s, new Set(rulings.map((r) => r.from_return))).map((x) => x.ask))
  return s.threads.filter((a) => !open.has(a.id) && a.entries.some((e) => e.kind === 'q') && !unanswered(a.entries)).map((a) => a.id)
}

/** 質問の返しの照合に要るもの。root は控えと返しの記録の絶対パスを作るのに使う。 */
export type AskSide = { root: string; threads: AskThread[]; marks: AskMark[]; log: UserLog; applied: number[] }

const strArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * 質問の返しのうち、窓口が反映し終えていないもの: 返しの記録にあって判断の記録か帳簿（asks[].from_returns）に無い返し・保留（asks[].held_returns）・
 * 担当への通知（asks[].notify[] の message_id の無い行）と、返しの無い「この答えを窓口に返す」（ask_decide の op。取り消し・applied_ops のものは除く）。
 */
export function unreflectedAsks(s: AskSide, inRulings: Set<unknown>): AskUnreflected[] {
  const memo = (id: string) => `${s.root}/.orca/consult/ask-${id}.md`
  const asks = new Map<string, AskMark>()
  for (const a of s.marks) asks.set(a.id, a)
  const reflected = new Set([...asks.values()].flatMap((a) => strArr(a.from_returns).filter((x) => typeof x === 'string')))
  const held = new Map<string, string>()
  for (const a of asks.values()) for (const x of strArr(a.held_returns)) if (typeof x === 'string') held.set(x, a.id)
  const found = new Map<string, AskUnreflected>()
  const bound = new Set<string>()
  for (const t of s.threads)
    for (const v of t.returns) {
      const rid = v.return_id
      if (!(typeof rid === 'string' && RETURN_ID.test(rid))) continue
      if (v.op !== undefined && v.op !== null) bound.add(`${t.id}\n${opKey(v.op)}`)
      const missing = [...(inRulings.has(rid) ? [] : ['判断の記録']), ...(reflected.has(rid) ? [] : ['帳簿'])]
      const x = found.get(rid) ?? { id: rid, ask: t.id, missing: [], memo: memo(t.id), returns: t.returnsPath }
      x.missing = missing
      found.set(rid, x)
    }
  for (const [rid, id] of held) {
    const x = found.get(rid) ?? { id: rid, ask: id, missing: [], memo: memo(id), returns: null }
    x.missing.push('保留')
    found.set(rid, x)
  }
  // 窓口が担当・worker に伝え損ねた返し（帳簿の notify[] の message_id の有無で見る）。
  for (const a of asks.values())
    for (const n of strArr(a.notify) as Record<string, unknown>[]) {
      if (!(typeof n === 'object' && n !== null && !Array.isArray(n) && typeof n.return_id === 'string' && !n.message_id)) continue
      const x = found.get(n.return_id) ?? { id: n.return_id, ask: a.id, missing: [], memo: memo(a.id), returns: null }
      if (!x.missing.includes('担当への通知')) x.missing.push('担当への通知')
      ;(x.tasks ??= []).push(n.task ?? null)
      found.set(n.return_id, x)
    }
  const out = [...found.values()].filter((x) => x.missing.length)
  const applied = new Set(s.applied.map(opKey))
  const undone = new Set(s.log.ops.filter((o) => o?.type === 'undo').map((o) => opKey(o.undo_of)))
  for (const o of s.log.ops) {
    if (!(o && o.type === 'ask_decide' && String(o.item_id ?? '').startsWith('#ask:'))) continue
    const op = opKey(o.op_id)
    const id = o.item_id.slice('#ask:'.length)
    if (!bound.has(`${id}\n${op}`) && !applied.has(op) && !undone.has(op)) out.push({ id: null, ask: id, op: o.op_id ?? null, missing: ['返し'], memo: memo(id) })
  }
  return out
}

/** op の id を比べる鍵。返しの記録・操作のログ・applied_ops は同じ op を数でも文字列でも書くので、文字列にそろえる。 */
const opKey = (v: unknown) => String(v ?? '')

/** 引かない種類（撤回そのものと、残す判断の無いカードの記録）。 */
const NO_LOOKUP = new Set(['revoke', 'none'])

/**
 * 質問の語の候補: 漢字の続き（3 字以上は 2 字ずつにも割る）・カタカナの続き・英数字の語（2 字以上）・判断の番号（R12）。
 * ひらがなは助詞や語尾なので語にしない。
 */
export function lookupTerms(q: string, split = true): string[] {
  const out = new Set<string>()
  for (const m of q.matchAll(/(?<![A-Za-z0-9])R\d+(?![A-Za-z0-9])/gi)) out.add(m[0].toUpperCase())
  for (const m of q.matchAll(/[\p{Script=Han}々]{2,}/gu)) {
    out.add(m[0])
    if (split && m[0].length > 2) for (let i = 0; i + 2 <= m[0].length; i++) out.add(m[0].slice(i, i + 2))
  }
  for (const m of q.matchAll(/[\p{Script=Katakana}ー]{2,}/gu)) out.add(m[0])
  for (const m of q.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]+/g)) if (!/^R\d+$/i.test(m[0])) out.add(m[0].toLowerCase())
  return [...out]
}

/**
 * 判断の記録から、質問の語を含む有効な判断（撤回・置き換えされていないもの）を引く。埋め込みや LLM は使わない（担当の指示）。
 * 番号を書いた質問はその番号を、それ以外は当たった語が 2 つ以上（語が 1 つしか無い質問は 1 つ）のものを、当たりの多い順・新しい順に max 件。
 */
export function matchRulings(rows: Ruling[], q: string, max = 3): Ruling[] {
  const terms = lookupTerms(q)
  if (!terms.length) return []
  const gone = new Set(rows.flatMap((r) => r.supersedes ?? []))
  const live = rows.filter((r) => r.id && r.text && !gone.has(r.id) && !NO_LOOKUP.has(r.kind ?? ''))
  const ids = terms.filter((t) => /^R\d+$/.test(t))
  if (ids.length) return live.filter((r) => ids.includes(r.id)).slice(0, max)
  // 割った 2 字の語は数えず、質問の語の続きが 1 つなら 1 つ当たればよい。
  const need = lookupTerms(q, false).length === 1 ? 1 : 2
  return live
    .map((r) => {
      const hay = [r.text, r.quote, r.dec].filter(Boolean).join('\n').toLowerCase()
      // 2 字に割った語は、元の続きが当たったら重ねて数えない。
      const hit = terms.filter((t) => hay.includes(t))
      const score = hit.filter((t) => !hit.some((u) => u !== t && u.length > t.length && u.includes(t))).length
      return { r, score }
    })
    .filter((x) => x.score >= need)
    .sort((a, b) => b.score - a.score || ruleNum(b.r.id) - ruleNum(a.r.id))
    .slice(0, max)
    .map((x) => x.r)
}
const ruleNum = (id: string) => Number(/\d+/.exec(id)?.[0] ?? 0)

/** カードが片付いた（帳簿から消えたものも）のに、Orca に残っている相談のタブ。端末の一覧を読めていなければ言い切らない。 */
export function staleConsults(views: CardView[], log: UserLog, terminals: string[] | undefined): { id: string; terminal: string }[] {
  if (!terminals) return []
  const live = new Set(terminals)
  // 協議を取り消してもタブは閉じないので、取り消した記録の handle も探す。
  const status = new Map(views.map((v) => [v.card.id, v.status]))
  const out = new Map<string, { id: string; terminal: string }>()
  for (const o of log.ops)
    if (o.type === 'talk' && o.terminal && live.has(o.terminal) && (status.get(o.item_id) ?? 'closed') === 'closed')
      out.set(`${o.item_id}\n${o.terminal}`, { id: o.item_id, terminal: o.terminal })
  return [...out.values()]
}

/**
 * 開いた相手・出来事の待ち（解けていない person・event）。since の無い古い待ちは、いつから照らすかが分からないので 0 から。
 * 書く道具（発言と知らせの仕分け）と checks.unsorted_notices が使う。
 */
export const openOutsideWaits = (c: Cockpit, done: Set<string> = new Set()) =>
  c.tasks.filter((t) => t.state !== 'ok' && !done.has(t.id) && t.wait && (t.wait.kind === 'person' || t.wait.kind === 'event') && !waitMet(t.wait)).map((t) => ({ task: t.id, wait: t.wait!, from: timeOf(t.wait!.since) }))

/** 発言・知らせの id のうち、待ちと照らした（no_wait か、どれかの待ちの met が指す）もの。 */
export const sortedForWaits = (c: Cockpit) => new Set([...(c.intake?.no_wait ?? []), ...c.tasks.flatMap((t) => (t.wait?.met ?? []).map((m) => m.by))])

/** 開いた相手・出来事の待ちがあるのに、まだ照らしていない知らせ（待ちを始めた時刻より後で、notices_through より後のもの）。待ちが無ければ空（Astra 3 の小 2）。 */
export function unsortedNotices(c: Cockpit, notices: Utterance[], done: Set<string>): string[] {
  const waits = openOutsideWaits(c, done)
  if (!waits.length) return []
  const from = Math.min(...waits.map((w) => w.from))
  const at = notices.findIndex((n) => n.id === c.intake?.notices_through)
  const seen = sortedForWaits(c)
  return notices.filter((n, i) => i > at && n.id && timeOf(n.at) >= from && !seen.has(n.id)).map((n) => n.id!)
}

const INTAKE_GRACE_MS = 10 * 60_000
const PUSH_LATER_MS = 12 * 3_600_000
const CONTEXT_KEYS = ['what', 'now', 'how', 'gain', 'cost'] as const
const TMP = /^(file:\/\/)?(\/private)?\/(tmp|var\/folders)\//

export function report(c: Cockpit, log: UserLog, archive: Card[], facts: OrcaFacts | undefined, orcaState: StateReport['orca'], now: number, plugin?: string, opts: DeriveOpts = {}): StateReport {
  const d = derive(c, log, archive, '', facts, now, opts)
  const tasks = [...d.tasks.values()]
  const running = tasks.filter((t) => t.why === 'working')
  const names = (xs: string[]) => (xs.length ? `（${xs.join(' / ')}）` : '')
  const mine = d.queue.filter(countedRow)
  const next = mine[0]
  const intake = tasks.filter((t) => t.why === 'intake' && now - (t.settledAt ?? 0) >= INTAKE_GRACE_MS)
  const pushDelegated = delegatedScopes(opts.rulings ?? []).has('push')
  // 見張る仕事はタスクを持たないことが多く、仕事の今は「完了」になるので、済んだかでは絞らない。
  const watching = c.streams.filter((s) => s.form === 'watch')
  const pushOpen = c.cards.some((x) => x.kind === 'permit' && x.scope === 'push' && (x.state === 'open' || (x.resolved_option === 'later' && now - Date.parse(x.resolved_at ?? '0') < PUSH_LATER_MS)))
  const open = c.cards.filter((x) => x.state === 'open')
  const live = c.tasks.filter((t) => d.tasks.get(t.id)?.state !== 'ok')
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  return {
    workspace: c.workspace.name,
    orca: orcaState,
    counts: { ...d.counts, total: d.total },
    next: next && { id: next.card.id, kind: next.card.kind, title: next.card.title, due: next.card.due },
    mine: mine.map((r) => ({ id: r.card.id, kind: r.card.kind, title: r.card.title, due: r.card.due })),
    overdue: d.queue.filter((r) => isOver(r.card.due, now)).map((r) => r.card.id),
    talking: d.talking.map((r) => ({ id: r.card.id, since: r.talking!.since, with: r.talking!.terminal ? 'カードの相談' : r.owner.title })),
    fixing: d.fixing.map((r) => r.card.id),
    waiting: d.waiting.map((r) => ({ id: r.card.id, who: r.card.awaiting?.who ?? '', what: r.card.awaiting?.what ?? r.card.title, since: r.card.awaiting?.since ?? '', remind_at: r.card.awaiting?.remind_at })),
    jobs: d.jobs.map((j) => ({ id: j.id, title: j.title, state: j.state, label: j.label, next: j.next, orca: { display_name: streamName({ title: j.title, form: c.streams.find((s) => s.id === j.id)?.form }), status: ORCA_STATUS[j.state], unread: j.state === 'mine' } })),
    tasks: tasks.map((t) => ({ id: t.task.id, title: t.task.title, state: t.state, label: t.label, from: t.why, dispatch: currentDispatch(t.task, facts) ?? null })),
    requests: d.requests.map((r) => ({ id: r.req.id, title: r.req.title, state: r.state, legacy: r.legacy })),
    workers: (facts?.workers ?? []).map((w) => ({ task: w.task, job: w.job, state: w.state, stop: w.stop })),
    checks: {
      pending_ops: unappliedOps(c, log).length,
      unapplied_tidy: openTidyOps(c, log).filter((o) => Date.parse(o.at) + UNDO_GRACE_MS <= now).map((o) => o.op_id),
      missing_context: open.filter((x) => x.kind === 'decide' && CONTEXT_KEYS.some((k) => !String(x.context?.[k] ?? '').trim())).map((x) => x.id),
      empty_manual: open.filter((x) => x.manual && !x.manual.command?.trim() && !x.manual.steps?.some((s) => s.trim())).map((x) => x.id),
      remind_due: d.waiting.filter((r) => r.card.awaiting?.remind_at && Date.parse(r.card.awaiting.remind_at) < now).map((r) => r.card.id),
      orphan_cards: open.filter((x) => x.kind !== 'inbox' && !x.stream && !x.owner && !x.tasks?.length).map((x) => x.id),
      local_deliverables: open.filter((x) => (x.kind === 'review' || x.kind === 'report') && [x.href, ...(x.links ?? []).map((l) => l.href)].some((h) => h && TMP.test(h))).map((x) => x.id),
      intake: intake.map((t) => t.task.id),
      missing_workers: tasks.filter((t) => t.why === 'missing').map((t) => t.task.id),
      push_check: !tasks.some((t) => t.state === 'run') && !pushOpen && !pushDelegated,
      push_delegated: !tasks.some((t) => t.state === 'run') && pushDelegated,
      plugin: plugin ?? null,
      workspace_name: workspaceNameCheck(c.workspace.name),
      status_missing: c.streams.filter((x) => x.form !== 'watch' && !x.status?.trim() && d.jobs.find((j) => j.id === x.id)?.state !== 'done').map((x) => x.id),
      stale_status: [...d.stale].map(([id, x]) => ({ id, changes: basisChanges(x.was, x.basis, d.tasks) })),
      unsorted_notices: unsortedNotices(c, opts.notices ?? [], new Set(tasks.filter((t) => t.state === 'ok').map((t) => t.task.id))),
      routes: (c.routes ?? []).map((r) => routeProblem(r, now)).filter((x): x is string => !!x),
      // 頭の語（一緒に｜・任せる｜・作業｜ など。R146）も含めて数える。サイドバーに出るのはその名前のため。
      long_names: [
        ...c.streams.filter((x) => !d.jobs.find((j) => j.id === x.id && j.state === 'done')).map((x) => [x.id, streamName(x)] as const),
        ...(c.owners ?? []).filter((o) => o.state !== 'done').map((o) => [o.id, ownerName(c, o)] as const),
        ...live.map((t) => [t.id, workerName(t.title)] as const)
      ].filter(([, name]) => [...name].length > NAME_MAX).map(([id, name]) => `${id}（${[...name].length} 字）`),
      incomplete_cards: d.incomplete.map((g) => ({ id: g.id, missing: missingFields(c.cards.find((x) => x.id === g.id)!).map((m) => m.key) })),
      incomplete_requests: d.requests.filter((r) => r.missing.length).map((r) => ({ id: r.req.id, missing: r.missing })),
      unsorted: d.unsorted.map((g) => g.id),
      idle_tasks: d.idle.map((x) => ({ task: x.task, since: x.since, hours: x.hours })),
      stale_tasks: tasks.filter((t) => t.task.state !== 'ok' && t.why === 'intake' && facts?.dispatches?.[currentDispatch(t.task, facts) ?? '']?.taskStatus === 'completed').map((t) => t.task.id),
      loose_tasks: live.filter((t) => !c.streams.some((s) => s.id === t.stream)).map((t) => t.id),
      unknown_phase: live.filter((t) => !stageOf(t.phase)).map((t) => `${t.id}（${t.phase}）`),
      no_form: d.jobs.filter((j) => j.state !== 'done' && !c.streams.find((s) => s.id === j.id)?.form).map((j) => j.id),
      watch_missing: watching.filter((s) => !s.watch).map((s) => s.id),
      watch_unknown: facts?.automations ? watching.filter((s) => s.watch && !facts.automations!.some((a) => a.id === s.watch!.automation)).map((s) => `${s.id}（${s.watch!.automation}）`) : [],
      unmapped_elements: c.cards
        .filter((x) => x.elements?.length && log.ops.some((o) => o.type === 'accept' && o.item_id === x.id && o.item_rev === x.rev && !undone.has(o.op_id)))
        .map((x) => ({ card: x.id, missing: unmappedElements(x) }))
        .filter((x) => x.missing.length),
      unproven: d.requests
        .filter((r) => r.state !== '済' && r.tasks.length && r.tasks.every((t) => t.state === 'ok') && r.covered.some((x) => !x))
        .map((r) => ({ request: r.req.id, when: r.covered.flatMap((x, i) => (x ? [] : [i + 1])) })),
      affected_tasks: (opts.rulings ?? []).flatMap((ru) => (ru.affects ?? [])
        .filter((id) => c.tasks.some((t) => t.id === id && !t.reviewed_for?.includes(ru.id)))
        .map((task) => ({ ruling: ru.id, task }))),
      unreflected_returns: unreflectedReturns(opts.marks ?? [...c.cards, ...archive], opts.rulings ?? [], opts.consults ?? [],
        opts.root ? { root: opts.root, threads: opts.asks ?? [], marks: opts.askMarks ?? [], log, applied: c.applied_ops ?? [] } : undefined),
      stale_consults: staleConsults(d.views, log, facts?.terminals)
    },
    overview: `全体: ${countsText(d.counts, d.total)}・話し中 ${d.talking.length}・顧客待ち ${d.waiting.length}・動いている worker ${running.length}${names(running.map((t) => t.task.title))}`,
    card: `${countsText(d.counts, d.total)}${next?.card.due ? `・最短 ${fmtDate(next.card.due)}` : ''}`
  }
}
