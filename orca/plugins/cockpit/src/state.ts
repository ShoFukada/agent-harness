// カードの状態・私の番の並び・件数・案件の今（仕事ごとの状態）を決める 1 か所。窓・パネル・hook とメインが読む CLI（window/state.ts）はここを通す。
// 手書きの値を事実の代わりに出すと、画面とメインの認識が事実と食い違ったため（2026-11-16）。
import {
  COUNTED, COWORK_ID, IDLE_ID, KIND_LABEL, taskSig, missingFields, stageOf, overlay, shownTask, timeOf, unappliedOps, unmappedElements, worstState,
  type AskMark, type AskThread, type Card, type CardKind, type CardView, type Cockpit, type ConsultMemo, type Milestone, type ReturnMark, type Owner, type Request, type Ruling, type Stream, type StreamForm, type Task, type TaskSeen, type TaskShown, type TaskState, type UserLog, type Utterance
} from './model.ts'
import type { AgentRow, DispatchFact, OwnerLive, QuestionFact, StopReason } from './protocol.ts'

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
export type OrcaFacts = { automations?: { id: string; name: string }[]; workers: AgentRow[]; dispatches?: Record<string, DispatchFact | null>; owners?: OwnerLive[]; ownersStale?: boolean; current?: Record<string, string>; terminals?: string[]; terminalsPartial?: boolean; questions?: QuestionFact[] }

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
  /** 線を越えて動いていないタスクの行（追加 35）の手がかり。 */
  idle?: IdleTask
}

export type TaskView = TaskShown & { task: Task; settledAt?: number }
/** 案件の今の 1 行（仕事ごと）。 */
export type JobState = 'mine' | 'stopped' | 'working' | 'customer' | 'idle' | 'done'
export const JOB_LABEL: Record<JobState, string> = { mine: '私待ち', stopped: '止まっている', working: '作業中', customer: '顧客待ち', idle: '未着手', done: '済' }
/** 一緒に作る仕事で担当が深田さんの返事を待っているときの、仕事とタスクの状態の語（R128）。 */
export const REPLY_LABEL = '返事待ち（あなた）'
/**
 * Orca のサイドバーの作業場所の状態。窓の「案件の今」と同じ判定から決め、窓口が orca worktree set でそろえる
 * （窓とサイドバーで同じ仕事が違う状態に見えないように）。私待ちは in-review にし、未読の印も付ける。
 */
export type OrcaStatus = 'todo' | 'in-progress' | 'in-review' | 'completed'
export const ORCA_STATUS: Record<JobState, OrcaStatus> = { mine: 'in-review', stopped: 'in-progress', working: 'in-progress', customer: 'in-progress', idle: 'todo', done: 'completed' }
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
export type DeriveOpts = { utterances?: Utterance[]; returned?: string[]; firstSeen?: Record<string, string>; taskSeen?: TaskSeen; rulings?: Ruling[]; consults?: ConsultMemo[]; marks?: ReturnMark[]; asks?: AskThread[]; askMarks?: AskMark[]; root?: string }
/** 帳簿の不備を窓口に直させる猶予。過ぎても欠けたままなら、窓の要対応の上に「抜けている」として出す（R47）。 */
export const GAP_GRACE_MS = 30 * 60_000

export type Derived = {
  views: CardView[]
  /** 私の番（届いたも含む）。期限順。必須の欄が欠けたカードは入れない。 */
  queue: Row[]
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
  /** 件数に数える 5 種類の合計。 */
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
}

const RANK: Record<CardKind, number> = { stuck: 0, permit: 1, decide: 2, send: 3, review: 4, consult: 5, inbox: 6, talk: 7, report: 8 }
const dueKey = (r: Row) => (r.card.kind === 'stuck' ? -Infinity : r.card.due ? dueAt(r.card.due) || Infinity : Infinity)
export const byUrgency = (a: Row, b: Row) => dueKey(a) - dueKey(b) || RANK[a.card.kind] - RANK[b.card.kind] || timeOf(a.card.at) - timeOf(b.card.at)

export function ownerOf(c: Cockpit, card: Pick<Card, 'owner' | 'stream'>, facts?: OrcaFacts): OwnerRef {
  const own = c.owners?.find((o) => o.id === card.owner) ?? c.owners?.find((o) => o.stream && o.stream === card.stream && o.state !== 'done')
  if (own) {
    const term = own.terminal ? facts?.workers.find((w) => w.terminalId === own.terminal) : undefined
    // worker-start --agent で立てたチャットの担当は、受け取りの terminal（structworker_…）を terminal に書かれがち。端末の一覧に無いので、
    // その handle の Dispatch からチャットを引く（2026-11-21 に「担当と話す」が何も開かなかった）。
    const session = own.session ?? (own.terminal && !term ? Object.values(facts?.dispatches ?? {}).find((f) => f?.terminal === own.terminal)?.session : undefined)
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
function stuckRows(c: Cockpit, root: string, facts: OrcaFacts | undefined, written: Set<string>): Row[] {
  return (facts?.workers ?? [])
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
      const ask = a.ask && { ...a.ask, from: `${role}（${task?.title ?? name}）が${a.ask.kind === 'permit' ? '許可を求めている' : 'あなたに聞いている'}` }
      const card: Card = {
        id: agentCardId(a), rev: a.since, kind: 'stuck', state: 'open',
        title: ask ? `${ask.kind === 'permit' ? '許可: ' : ''}${askLine(ask.text)}` : `「${name}」が${STOP_LABEL[a.stop!]}`, since: new Date(a.since).toISOString(),
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

/** 返事の最後の段落（担当が深田さんに返した問いの本文）。空行で区切った最後のまとまりを、改行を空白にして 1 行にする。 */
export const lastParagraph = (text: string | undefined) =>
  (text ?? '').split(/\n\s*\n/).map((p) => p.replace(/\*\*/g, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).at(-1)

/**
 * 一緒に作る仕事（cowork）を、カードの有無に関わらず要対応に 1 行で出す（R128・R145）。開くボタンは担当のチャットか端末を前に出す（詰まりの行と同じ経路）。
 * 深田さんの返事待ちは同じ行で示す: 担当がターンを終えて開いたまま（orca agent list の state が done）、担当の問いの詰まり（AskUserQuestion・許可の確認）、
 * または仕事の話し中のカード・協議中のカード（担当が作業に戻っていないもの）。問いの詰まりと話し中のカード（kind talk）はこの行に寄せて 2 行にしない。
 * 協議中のほかの種類のカードは承認などの返答が要るので残す。利用枠・ログイン切れ・エラーで止まった担当は、その詰まりの行を残し、返事待ちにしない。
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
    const state = owner.how === 'terminal' ? owner.state : live?.state
    const self = (a: Pick<AgentRow, 'session' | 'terminalId'>) => (!!owner.session && a.session === owner.session) || (!!owner.terminal && a.terminalId === owner.terminal)
    // 担当自身の停止（Orca の端末・チャットから作った行）だけを見る。担当宛てに届いた worker の question の行は、宛先の handle を持つが担当の問いではない。
    const asked = queue.find((r) => r.card.id.startsWith('#agent:') && !!r.agent?.ask && self(r.agent))
    // 「対応済みにする」で隠した停止も、止まっているあいだは返事待ちにしない。
    const failed = facts.workers.some((a) => !!a.stop && !a.ask && self(a))
    const talks = queue.filter((r) => r.card.stream === s.id && r.card.kind === 'talk')
    const talking = all.some((r) => r.card.stream === s.id && r.status === 'mine' && !!r.talking)
    for (const r of [asked, ...talks]) if (r) absorbed.add(r)
    const waiting = !failed && (state === 'done' || !!asked || ((talks.length > 0 || talking) && state !== 'working'))
    const text = asked?.agent?.ask?.text ?? (state === 'done' ? live?.last : undefined) ?? talks.find((r) => r.card.last?.text)?.card.last?.text
    const question = lastParagraph(text)
    // 詳細の「最後のやり取り」には、題にした最後の段落より前だけを出す（同じ文を 2 度出さない。Neon）。題で切れた長い問いは全文を残す。
    const paras = (text ?? '').split(/\n\s*\n/).filter((p) => p.trim())
    const context = question && question.length <= 120 ? paras.slice(0, -1).join('\n\n') : text
    const at = asked?.card.since ?? (live?.updatedAt ? new Date(live.updatedAt).toISOString() : undefined)
    const card: Card = {
      id: `${COWORK_ID}${s.id}`, rev: live?.updatedAt ?? 0, kind: 'talk', state: 'open', stream: s.id,
      ...(waiting && at && { since: at }),
      title: !waiting ? `共同作業中（担当は${state === 'working' ? '作業中' : state ? (OWNER_WORD[state] ?? '入力待ち') : '状態不明'}）`
        : question ? askLine(question) : talks[0]?.card.title ?? `担当「${owner.title}」が返事を待っている`,
      tasks: [...new Set(c.tasks.filter((t) => t.stream === s.id && t.state !== 'ok').map((t) => t.id))],
      ...(context && { last: { text: context, by: '担当', ...(at && { at }) } }),
      // 返事の本文が読めたときは、開くボタンで足りるので「次」を書かない（Neon）。
      next: !waiting ? (failed ? '担当が止まっている。止まった行の直し方を確認する' : '担当が作業中。開くと途中の様子を確認できる')
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
  const tasks = new Map<string, TaskView>()
  for (const t of c.tasks) {
    const id = currentDispatch(t, facts)
    const fact = facts?.dispatches && t.worker ? (id ? facts.dispatches[id] ?? null : null) : undefined
    tasks.set(t.id, { ...shownTask(t, fact), task: t, settledAt: fact?.settledAt })
  }
  const incomplete: Gap[] = []
  const complete = (r: Row) => {
    if (r.status !== 'mine' || r.card.state !== 'open') return true
    const miss = missingFields(r.card)
    if (miss.length) incomplete.push({ kind: 'card', id: r.card.id, title: r.card.title, missing: miss.map((m) => m.label), since: r.card.at ?? opts.firstSeen?.[r.card.id] })
    return !miss.length
  }
  const mine = rows.filter((r) => r.status === 'mine' && r.card.kind !== 'report' && complete(r))
  const dismissed = dismissedStuck(log)
  // 同じ停止を端末の行と Dispatch の行で二重に出さない判定は、「済ませた」を当てる前の行で行う（済ませた端末の行の代わりに Dispatch の行が出ないように）。
  const fromAgents = stuckRows(c, root, facts, written)
  const fromDispatch = dispatchStuck(c, root, tasks, written, new Set(fromAgents.flatMap((r) => r.card.tasks ?? [])), dismissed)
  const found = [...mine, ...[...fromAgents, ...questionRows(c, root, facts, now)].filter((r) => !dismissed.has(`${r.card.id}@${r.card.rev}`)), ...fromDispatch]
  const cowork = coworkRows(c, root, facts, found, rows)
  const idle = idleTasks(c, tasks, facts, opts.taskSeen, now)
  const idleRows = idle.map((x): Row => {
    const t = tasks.get(x.task)!.task
    const card: Card = { id: `${IDLE_ID}${t.id}`, rev: Date.parse(x.since), kind: 'talk', state: 'open', stream: t.stream, tasks: [t.id], since: x.since, title: x.check ? `「${t.title}」の確認日が来た` : `「${t.title}」が${x.hours}時間動いていない`, next: t.next }
    return { card, status: 'mine', pending: false, root, ws: c.workspace.name, owner: ownerOf(c, { stream: t.stream }, facts), stream: c.streams.find((s) => s.id === t.stream), idle: x }
  })
  const queue = [...found.filter((r) => !cowork.absorbed.has(r)), ...cowork.rows, ...idleRows].sort(byUrgency)
  const counts = Object.fromEntries(Object.keys(RANK).map((k) => [k, 0])) as Counts
  for (const r of queue) counts[r.card.kind]++
  const total = COUNTED.reduce((n, k) => n + counts[k], 0)
  const recent = (r: Row) => !r.when || now - Date.parse(r.when) < CLOSED_DAYS * DAY
  // when は操作の時刻（UTC の Z）と窓口が書いた時刻（+09:00）が混ざるので、文字列ではなく時刻で比べる。
  const settled = rows.filter((r) => r.status === 'closed').sort((a, b) => timeOf(b.when) - timeOf(a.when))
  const closed = settled.filter(recent)
  const requests = requestViews(c, log, archive, tasks)
  const unsorted = unsortedOf(c, opts.utterances ?? [], new Set(opts.returned ?? returnedUtterances(c, opts.rulings ?? [], opts.consults ?? [], opts.asks ?? [])))
  const late = (g: Gap) => !!g.since && now - Date.parse(g.since) >= GAP_GRACE_MS
  const reqGaps = requests.filter((r) => r.missing.length).map((r): Gap => ({ kind: 'request', id: r.req.id, title: r.req.title, missing: r.missing, since: r.req.at }))

  return {
    views, queue, counts, total, tasks, closed, settled, incomplete, unsorted, requests, idle,
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
export const workspaceNameCheck = (name: unknown): { name: string; message: string } | null =>
  typeof name !== 'string' || !name.trim()
    ? { name: '', message: `案件の名前（cockpit.json の workspace.name）が無い。${WORKSPACE_NAME_FORM}の形で書く（R165）` }
    : workspaceNameOk(name) ? null
    : { name, message: `案件の名前「${name}」が${WORKSPACE_NAME_FORM}の形になっていない。cockpit.json の workspace.name を直す（R165）` }

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
    const due = !!task.check_on && today >= task.check_on && t.state !== 'ok' && t.why === 'record'
    if (!due && (!line || t.why !== 'record' || task.waiting_on?.trim() || (task.check_on && today < task.check_on))) return []
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
      [timeOf(task.waiting_since), '帳簿の更新'],
      [t.settledAt ?? 0, 'worker の最後の動き']
    ]
    const [at, from] = marks.reduce((a, b) => (b[0] > a[0] ? b : a))
    const worker = task.worker ? (t.state === 'run' ? 'worker の記録はあるが Orca に動きなし' : 'worker の記録あり') : 'worker なし'
    const who = owner.how === 'main' ? '担当を立てず窓口が受け持つ' : `担当「${owner.title}」は${owner.state === 'working' ? '作業中' : owner.state === 'done' ? '待機' : owner.state ? '止まっている' : '状態不明'}`
    const start = due ? tokyoStart(task.check_on!) : 0
    if (due && at <= start)
      return [{ task: task.id, since: new Date(start).toISOString(), hours: Math.floor((now - start) / 3_600_000), line: 0, from, worker: `${worker}・${who}`, check: task.check_on }]
    if (!line || task.waiting_on?.trim() || now - at < line * 3_600_000) return []
    return [{ task: task.id, since: new Date(at).toISOString(), hours: Math.floor((now - at) / 3_600_000), line, from, worker: `${worker}・${who}` }]
  })
}

/**
 * タスクの待ち（waiting_on）の語（追加 42）。帳簿の waiting_on は自由な文で、相手の種類の欄が無いので語で見分ける。
 * 人や相手方の名前だけ（「森さん」「先方」「BW の担当」など。括弧の中は見ない）なら「〜の返事待ち」、
 * 出来事・作業・時間（「深田さんのスマホでの撮影」「次に上限に当たったときの席の切り替え」）は「〜を待つ」。動詞で終われば「〜のを待つ」。
 */
export function waitLabel(on: string): string {
  // 末尾の括弧は状態の語の後ろへ回す（「岩田さんの返事待ち（日程案への返事と認証情報）」。誰・何を待つかを先に読ませる。Codex）。
  const [, body, note] = /^(.*?)\s*((?:（[^）]*）|\([^)]*\))?)$/.exec(on)!
  const bare = body!.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
  if (/^[^のがを]{0,20}(さん|様|氏|先方|顧客|担当|窓口|チーム|部)$/.test(bare) || /^[^がを]{0,20}の(担当|窓口|チーム)$/.test(bare)) return `${body}の返事待ち${note}`
  return `${body}${/[うくぐすつぬぶむる]$/.test(bare) ? 'の' : ''}を待つ${note}`
}

/** 仕事ごとの今。済んだ仕事は後ろに回す。メインの書いた要約は使わず、タスクとカードから決める。 */
function jobViews(c: Cockpit, tasks: Map<string, TaskView>, queue: Row[], rows: Row[], facts: OrcaFacts | undefined): JobView[] {
  const order: Record<JobState, number> = { mine: 0, stopped: 1, working: 2, customer: 3, idle: 4, done: 5 }
  return c.streams
    .map((s): JobView => {
      const ts = [...tasks.values()].filter((t) => t.task.stream === s.id)
      const mine = queue.filter((r) => r.card.stream === s.id && COUNTED.includes(r.card.kind)).length
      // 一緒に作る仕事で担当が返事を待っていれば、件数に数えるカードが無くても私の番にする（R128）。
      const reply = queue.some((r) => r.card.id === `${COWORK_ID}${s.id}` && !!r.agent?.ask)
      const waiting = rows.find((r) => r.status === 'waiting' && r.card.stream === s.id)
      const live = ts.filter((t) => t.state !== 'ok')
      const worst: TaskState | undefined = worstState(live.map((t) => t.state))
      const ext = live.find((t) => t.state === 'wait' && t.task.waiting_on?.trim())
      const state: JobState = mine || reply ? 'mine'
        : worst === 'stop' ? 'stopped'
        : worst === 'run' ? 'working'
        : waiting || ext ? 'customer'
        : worst === 'idle' || worst === 'wait' ? 'idle'
        : 'done'
      const label = state === 'customer' && waiting?.card.awaiting?.who ? `${waiting.card.awaiting.who}の返事待ち`
        : state === 'customer' && ext ? waitLabel(ext.task.waiting_on!.trim())
        : state === 'mine' ? [reply && REPLY_LABEL, mine && `私待ち ${mine} 件`].filter(Boolean).join('・') : JOB_LABEL[state]
      const nextTask = live.find((t) => t.state === worst) ?? live[0]
      return {
        id: s.id, title: s.title, state, label, mine, ...(reply && { reply }),
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
  tasks: { id: string; title: string; state: TaskState; from: TaskShown['why']; dispatch: string | null }[]
  /** 依頼の帳簿の今（受けた順）。state は証拠から決めたもの。 */
  requests: { id: string; title: string; state: RequestState; legacy: boolean }[]
  workers: { task?: string; job?: string; state: string; stop?: StopReason }[]
  checks: {
    pending_ops: number
    /** 決めるのに「これは何か」など 5 欄が欠けたカード。 */
    missing_context: string[]
    /** 手作業を頼むのに、打つコマンドも手順も書いていない許す（manual）。 */
    empty_manual: string[]
    /** 催促の日を過ぎた顧客待ち（担当が「送る前」に催促の下書きを出す）。 */
    remind_due: string[]
    /** 仕事にも担当にもつながらない開いたカード。 */
    orphan_cards: string[]
    /** 成果物（href・links）が一時フォルダのファイルのままの、開いた見て・報告（artifact にして URL で渡す）。 */
    local_deliverables: string[]
    /** 手書きの state が止まっている・待っているのに、外の相手（waiting_on）も、私の番のカードも、顧客待ちのカードも指していないタスク。 */
    orphan_waits: string[]
    intake: string[]
    missing_workers: string[]
    /** 進行中のタスクが無く、push の許すも開いておらず、push も一任されていない（hook が git を見て、残りがあれば push の許すを出させる）。 */
    push_check: boolean
    /** 進行中のタスクが無く、この案件の push が一任されている（hook が git を見て、残りがあれば窓口に自分で push させる。許すは出さない）。 */
    push_delegated: boolean
    plugin: string | null
    /** 「顧客｜案件」の形になっていない案件の名前（workspace.name、R165）と、窓口に流す 1 文。形が合っていれば null。hook は message をそのまま流す。 */
    workspace_name: { name: string; message: string } | null
    /** 済んでいない仕事・タスクで、状況の文（status、R188）が無いものの id。窓の一覧は status が無いと状態の語だけを出す。見張る仕事は除く（状況は Bot の前回の結果を窓が Orca から読む）。 */
    status_missing: string[]
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
    /** 相談のメモにあって判断の記録か帳簿に入っていない返しと、保留の返し（設計 10.7 の 1）。 */
    unreflected_returns: (Unreflected | AskUnreflected)[]
    /** カードが片付いたのに Orca に残っている相談のタブ（10.7 の 8）。 */
    stale_consults: { id: string; terminal: string }[]
  }
  /** 全体の 1 行（hook が発言のたびにメインに流す）。 */
  overview: string
  /** ワークスペースのカードのコメント（orca worktree set --comment）。 */
  card: string
}

export type Unreflected = { id: string; card: unknown; missing: ('判断の記録' | '帳簿' | '保留')[]; memo: string | null }
/**
 * 窓からの質問の返しの未反映（compaction-keep.py の unreflected_asks と同じ形）。id のある行は返し、id が null の行は返しの無い「これで決める」。
 * missing は 判断の記録・帳簿（asks[].from_returns）・保留（asks[].held_returns）・担当への通知（asks[].notify[] の message_id の無い行）・返し。
 */
export type AskUnreflected = { id: string | null; ask: string; op?: unknown; missing: string[]; memo: string; returns?: string | null; tasks?: unknown[] }

/**
 * 相談のメモにあって、判断の記録の from_return か帳簿のカード（片付けて移したものも）の from_returns のどちらかに無い返しと、
 * カードの held_returns に残る返し。compaction-keep.py の unreflected と同じ判定・同じ並び（window/state.test.ts で突き合わせる）。
 */
export function unreflectedReturns(cards: ReturnMark[], rulings: Ruling[], memos: ConsultMemo[], asks?: AskSide): (Unreflected | AskUnreflected)[] {
  const inRulings = new Set<unknown>(rulings.map((r) => r.from_return))
  const inLedger = new Set(cards.flatMap((x) => x.from_returns ?? []))
  const held = new Map<unknown, unknown>()
  for (const x of cards) for (const id of x.held_returns ?? []) held.set(id, x.id)
  const out: Unreflected[] = []
  for (const m of memos)
    for (const v of m.returns) {
      const missing = [...(inRulings.has(v.return_id) ? [] : ['判断の記録' as const]), ...(inLedger.has(v.return_id) ? [] : ['帳簿' as const]), ...(held.has(v.return_id) ? ['保留' as const] : [])]
      if (missing.length) out.push({ id: v.return_id, card: pyFalsy(v.card) ? m.card : v.card, missing, memo: m.path })
    }
  // メモに書き損ねた返しでも、保留にしたものは相談が返し直すまで名指しする。
  const named = new Set(out.map((x) => x.id))
  const rest = [...held].filter(([id]) => !named.has(id as string)).sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
  return [...out, ...rest.map(([id, card]): Unreflected => ({ id: id as string, card, missing: ['保留'], memo: null })), ...(asks ? unreflectedAsks(asks, inRulings) : [])]
}

/** 質問の返しの照合に要るもの。root は控えと返しの記録のパスを作るのに使う（python と同じ絶対パス）。 */
export type AskSide = { root: string; threads: AskThread[]; marks: AskMark[]; log: UserLog; applied: number[] }

const strArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** compaction-keep.py の unreflected_asks と同じ判定・同じ並び（src/state.test.ts で突き合わせる）。 */
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
      if (!(typeof rid === 'string' && RETURN_ID_PY.test(rid))) continue
      if (v.op !== undefined && v.op !== null) bound.add(`${t.id}\n${pyStr(v.op)}`)
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
      if (!(typeof n === 'object' && n !== null && !Array.isArray(n) && typeof n.return_id === 'string' && pyFalsy(n.message_id))) continue
      const x = found.get(n.return_id) ?? { id: n.return_id, ask: a.id, missing: [], memo: memo(a.id), returns: null }
      if (!x.missing.includes('担当への通知')) x.missing.push('担当への通知')
      ;(x.tasks ??= []).push(n.task ?? null)
      found.set(n.return_id, x)
    }
  const out = [...found.values()].filter((x) => x.missing.length)
  const applied = new Set(s.applied.map(pyStr))
  const undone = new Set(s.log.ops.filter((o) => o?.type === 'undo').map((o) => pyStr(o.undo_of ?? null)))
  for (const o of s.log.ops) {
    if (!(o && o.type === 'ask_decide' && String(o.item_id ?? '').startsWith('#ask:'))) continue
    const op = pyStr(o.op_id ?? null)
    const id = o.item_id.slice('#ask:'.length)
    if (!bound.has(`${id}\n${op}`) && !applied.has(op) && !undone.has(op)) out.push({ id: null, ask: id, op: o.op_id ?? null, missing: ['返し'], memo: memo(id) })
  }
  return out
}

/** python の re.fullmatch(r"[A-Za-z0-9_]+-\d+") と同じ（\d は Unicode の数字）。 */
const RETURN_ID_PY = /^[A-Za-z0-9_]+-\p{Nd}+$/u
/** python の str()（None → "None"、真偽 → "True"/"False"）。op の照合で python と同じ文字列にそろえる。 */
const pyStr = (v: unknown) => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v))

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

/** python の `x or 既定値` の偽（None・False・0・空の文字列・空の配列と辞書）。 */
const pyFalsy = (v: unknown) =>
  v == null || v === false || v === 0 || v === '' || (Array.isArray(v) ? !v.length : typeof v === 'object' && !Object.keys(v as object).length)

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

const INTAKE_GRACE_MS = 10 * 60_000
const PUSH_LATER_MS = 12 * 3_600_000
const CONTEXT_KEYS = ['what', 'now', 'how', 'gain', 'cost'] as const
const TMP = /^(file:\/\/)?(\/private)?\/(tmp|var\/folders)\//

export function report(c: Cockpit, log: UserLog, archive: Card[], facts: OrcaFacts | undefined, orcaState: StateReport['orca'], now: number, plugin?: string, opts: DeriveOpts = {}): StateReport {
  const d = derive(c, log, archive, '', facts, now, opts)
  const tasks = [...d.tasks.values()]
  const running = tasks.filter((t) => t.why === 'working')
  const names = (xs: string[]) => (xs.length ? `（${xs.join(' / ')}）` : '')
  const mine = d.queue.filter((r) => COUNTED.includes(r.card.kind))
  const next = mine[0]
  const intake = tasks.filter((t) => t.why === 'intake' && now - (t.settledAt ?? 0) >= INTAKE_GRACE_MS)
  const pushDelegated = delegatedScopes(opts.rulings ?? []).has('push')
  // 見張る仕事はタスクを持たないことが多く、仕事の今は「完了」になるので、済んだかでは絞らない。
  const watching = c.streams.filter((s) => s.form === 'watch')
  const pushOpen = c.cards.some((x) => x.kind === 'permit' && x.scope === 'push' && (x.state === 'open' || (x.resolved_option === 'later' && now - Date.parse(x.resolved_at ?? '0') < PUSH_LATER_MS)))
  const open = c.cards.filter((x) => x.state === 'open')
  // 欠けた欄を窓口が埋めている途中のカードも、そのタスクを指している（checks.incomplete_cards と二重に名指ししない）。
  const pointed = new Set([...mine.map((r) => r.card), ...d.waiting.map((r) => r.card), ...d.incomplete.map((g) => c.cards.find((x) => x.id === g.id)!)].flatMap((x) => x.tasks ?? []))
  const live = c.tasks.filter((t) => t.state !== 'ok')
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
    tasks: tasks.map((t) => ({ id: t.task.id, title: t.task.title, state: t.state, from: t.why, dispatch: currentDispatch(t.task, facts) ?? null })),
    requests: d.requests.map((r) => ({ id: r.req.id, title: r.req.title, state: r.state, legacy: r.legacy })),
    workers: (facts?.workers ?? []).map((w) => ({ task: w.task, job: w.job, state: w.state, stop: w.stop })),
    checks: {
      pending_ops: unappliedOps(c, log).length,
      missing_context: open.filter((x) => x.kind === 'decide' && CONTEXT_KEYS.some((k) => !String(x.context?.[k] ?? '').trim())).map((x) => x.id),
      empty_manual: open.filter((x) => x.manual && !x.manual.command?.trim() && !x.manual.steps?.some((s) => s.trim())).map((x) => x.id),
      remind_due: d.waiting.filter((r) => r.card.awaiting?.remind_at && Date.parse(r.card.awaiting.remind_at) < now).map((r) => r.card.id),
      orphan_cards: open.filter((x) => x.kind !== 'inbox' && !x.stream && !x.owner && !x.tasks?.length).map((x) => x.id),
      local_deliverables: open.filter((x) => (x.kind === 'review' || x.kind === 'report') && [x.href, ...(x.links ?? []).map((l) => l.href)].some((h) => h && TMP.test(h))).map((x) => x.id),
      orphan_waits: tasks.filter((t) => t.why === 'record' && (t.state === 'stop' || t.state === 'wait') && !t.task.waiting_on?.trim() && !pointed.has(t.task.id)).map((t) => t.task.id),
      intake: intake.map((t) => t.task.id),
      missing_workers: tasks.filter((t) => t.why === 'missing').map((t) => t.task.id),
      push_check: !tasks.some((t) => t.state === 'run') && !pushOpen && !pushDelegated,
      push_delegated: !tasks.some((t) => t.state === 'run') && pushDelegated,
      plugin: plugin ?? null,
      workspace_name: workspaceNameCheck(c.workspace.name),
      status_missing: [
        ...c.streams.filter((x) => x.form !== 'watch' && !x.status?.trim() && d.jobs.find((j) => j.id === x.id)?.state !== 'done').map((x) => x.id),
        ...tasks.filter((t) => t.state !== 'ok' && !t.task.status?.trim()).map((t) => t.task.id)
      ],
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
      stale_tasks: tasks.filter((t) => t.task.state === 'run' && t.why === 'intake' && facts?.dispatches?.[currentDispatch(t.task, facts) ?? '']?.taskStatus === 'completed').map((t) => t.task.id),
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
        .filter((r) => r.state !== '済' && r.tasks.length && r.tasks.every((t) => t.task.state === 'ok') && r.covered.some((x) => !x))
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
