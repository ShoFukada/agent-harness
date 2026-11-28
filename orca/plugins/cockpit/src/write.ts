// 帳簿（cockpit.json）を書く道具の中身。窓口は Write・Edit で cockpit.json を書かず、この検査を通した変更だけを書く（R47-1）。
// ファイルに触らない純粋な関数で、CLI（window/write.ts）が読み書きとロックを受け持つ。
import {
  ASK_ID, badFields, busyDispatch, CARD_SHAPE, returnId, tidyOpsOf, cardHeadError, DRAFT_FORMATS, draftRoute, FORMAT_LABEL, FORMS, INTAKE_SHAPE, LEGACY_TASK_KEYS, missingFields, overlay, parseCockpit, REQUEST_SHAPE, RUN_ID, STATUS_MAX, TASK_MARKS, TASK_SHAPE, timeOf, unmappedElements, upgradeCard, upgradeTask, WATCH_SHAPE, WORKER_SHAPE,
  type AskRecord, type Card, type Cockpit, type DraftCheck, type DraftFormat, type Intake, type Op, type Owner, type Request, type Stream, type StreamForm, type Task, type TaskMark, type TaskWorker, type UserLog, type Utterance
} from './model.ts'
import type { DispatchFact } from './protocol.ts'
import type { DeferCheck, DeferItem } from './defer.ts'
import { basisChanges, judgeTasks, openOutsideWaits, sortedForWaits, streamBasis, workspaceNameCheck } from './state.ts'

/**
 * 書く変更。どの欄も id 単位の追加と置き換えで、全体を置き換える入口は作らない（ほかの行を書き間違いで消さないため）。
 * applied_ops は足すだけ。intake は渡した欄だけを置き換える。
 */
export type Change = {
  cards?: Card[]
  tasks?: Task[]
  requests?: Request[]
  streams?: Stream[]
  owners?: Owner[]
  intake?: Intake
  applied_ops?: number[]
  /**
   * 窓口の Run・種類・端末を、渡した欄だけ置き換える（渡さない欄は今の値を保つ）。Run は消せない（書いた結果に Run が要る）。
   * 種類と端末は窓口を替える道具（compaction-keep.py switch）が書く。terminal の空文字はチャットの窓口（端末が無い）。
   */
  main?: { run_id?: string | null; agent?: string; terminal?: string }
  /** 窓からの質問の返しを反映した印（質問 id ごとの追加と置き換え。cockpit skill の「窓から質問する」）。 */
  asks?: AskRecord[]
  /** 案件の名前だけを置き換える（「顧客｜案件」の形のものだけ。R165）。milestones は今の値を保つ。 */
  workspace?: { name: string }
  /**
   * 済になったタスクの見直しで「関係ない」と確かめたタスクの id（R204。保存しない）。同じ仕事の開いたタスクと、after・next・goal で済になったタスクを指すタスクは、
   * この書き込みで直す（行を渡して中身を変える）か、ここに並べる。
   */
  unaffected?: string[]
}
const KEYS = ['cards', 'tasks', 'requests', 'streams', 'owners', 'intake', 'applied_ops', 'main', 'asks', 'workspace', 'unaffected']

export type WriteResult = { next?: Cockpit; errors: string[]; warnings: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** 欄の順に依らずに同じ中身か（窓口が欄の順を変えて書き戻しても、中身を変えたことにしない）。 */
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
/** 片付ける・顧客待ちにする書き換えで動く欄。rev を上げずに書いてよい（上げると「これでよい」の版の照合から外れる）。 */
const CLOSING_FIELDS = new Set(['state', 'resolved_by', 'resolved_at', 'resolved_option', 'resolved_text', 'resolved_at_inferred', 'closed_without_review', 'awaiting', 'why', 'element_map', 'from_returns', 'held_returns'])
/**
 * 承認を取り込むときに書く要素の行き先と、カードの相談の返しを反映した・保留にした印。承認した版の中身ではないので、開いたままでも rev を上げずに書ける
 * （上げると承認が外れ、相談が前提にした版とも食い違う）。
 */
const INTAKE_FIELDS = new Set(['element_map', 'from_returns', 'held_returns'])

/**
 * 書ける欄の名前。読み込みは知らない欄を読み飛ばすので、書き間違い（through を throug と書くなど）は黙って効かなくなる。書く道具は変更の行だけを検査し、
 * 既にある行はそのまま保つ。nested は入れ子のオブジェクト（配列ならその要素）の欄。
 */
type Keys = { top: string[]; nested: Record<string, string[]> }
const CARD_KEYS: Keys = {
  top: ['id', 'rev', 'kind', 'title', 'state', ...Object.keys(CARD_SHAPE)],
  nested: {
    from: ['who', 'via', 'at', 'href'], draft: ['to', 'via', 'text', 'href', 'format'], context: ['what', 'now', 'how', 'gain', 'cost'],
    options: ['id', 'label', 'recommended', 'example', 'body'], compare: ['columns', 'rows'], background: ['text', 'quote', 'date'],
    last: ['text', 'at', 'by'], done: ['what', 'why', 'undo', 'task'], awaiting: ['who', 'what', 'since', 'resumes', 'remind_at'],
    links: ['label', 'href'], manual: ['where', 'command', 'steps', 'check'], elements: ['n', 'text'], element_map: ['n', 'task', 'request', 'skip']
  }
}
// 廃止した欄は「書けない欄」でなく taskErrors の廃止の文で断る（何に書き換えるかを返すため）。
const TASK_KEYS: Keys = { top: ['id', 'title', 'phase', 'state', 'worker', ...Object.keys(TASK_SHAPE), ...LEGACY_TASK_KEYS], nested: { worker: ['task_id', 'run_id', 'dispatch_id'], done: ['text', 'at'], wait: ['kind', 'who', 'what', 'where', 'since', 'on', 'why', 'probe', 'need', 'met'] } }
const REQUEST_KEYS: Keys = {
  top: ['id', 'deliverables', ...Object.keys(REQUEST_SHAPE)],
  nested: { utterances: ['id', 'quote'], evidence: ['when', 'kind', 'ref', 'card', 'rev'], source: ['session', 'at', 'quote'] }
}
const STREAM_KEYS: Keys = { top: ['id', 'title', 'summary', 'status', 'status_basis', 'sources', 'form', 'watch'], nested: { watch: ['automation', 'targets', 'to'] } }
const OWNER_KEYS: Keys = { top: ['id', 'title', 'stream', 'agent', 'session', 'terminal', 'worker', 'state'], nested: { worker: ['task_id', 'run_id'] } }
const INTAKE_KEYS: Keys = { top: ['through', 'none', 'checked_through', 'notices_through', 'no_wait'], nested: {} }
const ASK_KEYS: Keys = { top: ['id', 'card', 'task', 'stream', 'memo', 'from_returns', 'held_returns', 'notify'], nested: { notify: ['return_id', 'task', 'message_id'] } }

/** asks[] の 1 行の形の誤り。返しの id はその質問のもの（ask3-1）だけを受ける（compaction-keep.py の照合で別の質問の返しと取り違えないため）。 */
function askErrors(a: Record<string, unknown>): string[] {
  const id = String(a.id)
  const own = (v: unknown) => typeof v === 'string' && returnId(v) && v.slice(0, v.lastIndexOf('-')) === id
  const errs: string[] = []
  if (!ASK_ID.test(id)) errs.push('id は ask<数>')
  for (const k of ['card', 'task', 'stream', 'memo'] as const) if (a[k] !== undefined && (typeof a[k] !== 'string' || !a[k])) errs.push(`${k} は文字列`)
  for (const k of ['from_returns', 'held_returns'] as const) if (a[k] !== undefined && !(Array.isArray(a[k]) && (a[k] as unknown[]).every(own))) errs.push(`${k} は ${id}-<数> の配列`)
  if (a.notify !== undefined && !(Array.isArray(a.notify) && a.notify.every((n) => isObj(n) && own(n.return_id) && (n.task === undefined || typeof n.task === 'string') && (n.message_id === undefined || (typeof n.message_id === 'string' && n.message_id)))))
    errs.push(`notify は { return_id: ${id}-<数>, task?, message_id? } の配列`)
  return errs
}

function strayKeys(row: object, spec: Keys): string[] {
  const rec = row as Record<string, unknown>
  const out = Object.keys(rec).filter((k) => !spec.top.includes(k))
  for (const [k, keys] of Object.entries(spec.nested)) {
    const v = rec[k]
    const items: [string, unknown][] = Array.isArray(v) ? v.map((x, i) => [`${k}[${i}]`, x]) : [[k, v]]
    for (const [at, x] of items) if (isObj(x)) out.push(...Object.keys(x).filter((j) => !keys.includes(j)).map((j) => `${at}.${j}`))
  }
  return out
}

/**
 * 窓口・担当が書く人の読む欄で断る柔らかい言い回し（R84。カードと報告は業務文書の語調にする）。
 * draft の本文・quote・request・reason・background.quote・深田さんの last は相手か深田さんの言葉なので見ない。
 */
const SOFT: [string, RegExp][] = [
  ...['ておきました', 'でおきました', 'ですね', 'ますね', 'ですよね', 'しちゃ', 'ちゃいました', 'ちゃった'].map((w): [string, RegExp] => [w, new RegExp(w)]),
  // 「誰が承認するかも記録する」の「かも」は推量ではないので、文末・「かもしれ」「かもです」の形だけを見る。
  ['かも', /かも(?=しれ|です|ね|$|[。、！!？?\s」）)])/]
]
const CARD_PROSE: Keys = {
  top: ['title', 'purpose', 'asked', 'routed', 'why', 'fallback', 'look_for', 'evidence', 'effect', 'undo', 'unblock', 'issue', 'stance', 'known', 'undecided', 'next', 'compare'],
  nested: {
    last: ['text'], context: ['what', 'now', 'how', 'gain', 'cost'], options: ['label', 'body', 'example'], compare: ['columns', 'rows'], done: ['what', 'why', 'undo'], awaiting: ['what', 'resumes'],
    background: ['text'], elements: ['text'], manual: ['steps', 'check']
  }
}
const TASK_PROSE: Keys = { top: ['title', 'goal', 'next', 'done'], nested: { done: ['text'], wait: ['who', 'what', 'why'] } }
/** status が長すぎるときの断りの文。窓では切らないので、書き直してもらう。 */
const statusError = (who: string, v: unknown) =>
  typeof v === 'string' && [...v.trim()].length > STATUS_MAX ? `${who}: status は ${STATUS_MAX} 字まで（今 ${[...v.trim()].length} 字）。窓では切らずに出すので、今どうなっていて次に何を待つかに絞って書き直す` : undefined
const USER_BY = new Set(['私', '深田', 'user'])

function prose(row: object, spec: Keys): Map<string, string> {
  const rec = row as Record<string, unknown>
  const out = new Map<string, string>()
  const put = (at: string, v: unknown) => {
    if (typeof v === 'string') out.set(at, v)
    else if (Array.isArray(v)) v.forEach((x, i) => put(`${at}[${i}]`, x))
  }
  for (const k of spec.top) put(k, rec[k])
  for (const [k, keys] of Object.entries(spec.nested)) {
    const v = rec[k]
    if (k === 'last' && isObj(v) && USER_BY.has(String(v.by))) continue
    const items: [string, unknown][] = Array.isArray(v) ? v.map((x, i) => [`${k}[${i}]`, x]) : [[k, v]]
    for (const [at, x] of items) if (isObj(x)) for (const j of keys) put(`${at}.${j}`, x[j])
  }
  return out
}

/** 新しく書く・書き換える文に柔らかい言い回しがあれば、欄と語を並べた理由を返す。元の行にそのままある文は断らない（片付けるだけの書き戻しを止めないため）。 */
function softError(name: string, row: object, old: object | undefined, spec: Keys): string | undefined {
  const before = old ? prose(old, spec) : new Map<string, string>()
  const hits = [...prose(row, spec)].filter(([at, s]) => before.get(at) !== s).flatMap(([at, s]) => SOFT.filter(([, re]) => re.test(s)).map(([w]) => `${at}「${w}」`))
  return hits.length ? `${name}: 柔らかい言い回し ${hits.join('・')}。業務文書の語調（体言止め・短い動詞）に直す（R84）` : undefined
}

/**
 * 書式を検査する文面か: 開いたカードの draft のうち、新しい・開き直した・本文か宛先（format・via・href）を変えたもの。
 * 返しの反映や片付けだけの書き戻しは、前からある文面（format の無い版や、決まりより前の書き方）でも止めない。
 */
function draftTouched(x: Record<string, unknown>, prev: Card | undefined): boolean {
  if (x.state !== 'open' || !isObj(x.draft)) return false
  if (!prev || prev.state !== 'open' || !prev.draft) return true
  const d = x.draft
  return (['text', 'format', 'via', 'href'] as const).some((k) => d[k] !== prev.draft![k])
}

/**
 * 書く前に書式の検査（draft-format-lint）に渡す文面: 変更のカードのうち、開いていて format が書式の名前の draft。帳簿を読まずに決める
 * （検査を帳簿のロックの外で済ませるため）。前と同じ文面も渡すが、applyChange は検査する文面（draftTouched）の結果だけを見る。
 * 変更の形は検査の前なので、どんな値でも落ちない。
 */
export function draftsToLint(change: unknown): { id: string; to: DraftFormat; text: string }[] {
  const cards = isObj(change) && Array.isArray(change.cards) ? change.cards : []
  // 同じ id の行が並べば、書くのは後の行（upsert）なので、後の行の文面だけを検査する。
  const last = new Map(cards.filter((x: unknown) => isObj(x) && typeof x.id === 'string').map((x: Record<string, unknown>) => [x.id as string, x]))
  return [...last.values()].flatMap((x) => {
    if (x.state !== 'open' || !isObj(x.draft)) return []
    const d = x.draft
    return typeof d.text === 'string' && DRAFT_FORMATS.includes(d.format as DraftFormat) ? [{ id: x.id as string, to: d.format as DraftFormat, text: d.text }] : []
  })
}

/**
 * 片付けを確かめる worker・担当の Dispatch の様子（書く道具が Orca から読む）。キーは受け取りの workerKey（受け取りを替えた書き込みが、
 * 前の受け取りを読んだ結果を使わないため）。dispatch は今の Dispatch（Run の Task の続きをたどった先）、fact が null なら Orca に無い。error は Orca を読めなかった理由。
 */
export type CloseCheck = { dispatch?: string; fact: DispatchFact | null } | { error: string }
export type CloseTarget = { key: string; worker: TaskWorker }
export const workerKey = (w: TaskWorker) => `${w.run_id ?? w.dispatch_id ?? ''}/${w.task_id}`

/** 受け取りの並びから、形の合うものを重ねずに取り出す。 */
const workersOf = (...ws: unknown[]): TaskWorker[] =>
  [...new Map(ws.filter((w): w is TaskWorker => WORKER_SHAPE(w)).map((w) => [workerKey(w), w])).values()]

/**
 * 変更のタスクの行（同じ id は後の行）のうち、片付けを確かめるもの。
 * - closing: 新しく済になる（元の行が済でなく、変更の行が済）。済の行を初めて足すのは過去の記録の書き写しなので含めない。変更の行と元の行の両方の worker を見る
 * - 外す・替える: 済にしないが、元の行の worker を消すか別の受け取りに替える（先に記録を外してから済にして、検査を抜けさせない）。元の行の worker を見る
 */
function closingRows(c: Cockpit, tasks: unknown): { row: Record<string, unknown>; old: Task; closing: boolean; workers: TaskWorker[] }[] {
  const rows = Array.isArray(tasks) ? tasks.filter((x): x is Record<string, unknown> => isObj(x) && typeof x.id === 'string') : []
  return [...new Map(rows.map((x) => [x.id as string, x])).values()].flatMap((row) => {
    const old = c.tasks.find((t) => t.id === row.id)
    if (!old || old.state === 'ok') return []
    if (row.state === 'ok') return [{ row, old, closing: true, workers: workersOf(row.worker, old.worker) }]
    const was = workersOf(old.worker)
    return was.length && !same(row.worker, old.worker) ? [{ row, old, closing: false, workers: was }] : []
  })
}

/** 新しく済になるタスクの仕事（行を別の仕事に移したなら、移す前の仕事も）。 */
const closedStreams = (rows: ReturnType<typeof closingRows>) =>
  new Set(rows.filter((x) => x.closing).flatMap(({ row, old }) => [typeof row.stream === 'string' ? row.stream : old.stream, old.stream]))

/** 変更の担当の行（同じ id は後の行）のうち、元の行の受け取りを消すか別の受け取りに替えるもの（先に受け取りを外してから済にして、検査を抜けさせない）。 */
function unboundOwners(c: Cockpit, owners: unknown): { o: Owner; workers: TaskWorker[] }[] {
  const rows = Array.isArray(owners) ? owners.filter((x): x is Owner => isObj(x) && typeof x.id === 'string') : []
  return [...new Map(rows.map((x) => [x.id, x])).values()].flatMap((o) => {
    const was = c.owners?.find((x) => x.id === o.id)
    const ws = workersOf(was?.worker)
    return ws.length && !same(o.worker, was!.worker) ? [{ o, workers: ws }] : []
  })
}

/** 仕事の担当（変更の行と元の行）。変更の行が受け取りを省いても、元の行の受け取りを見る。 */
const ownersIn = (c: Cockpit, incoming: Owner[], streams: Set<string>) =>
  upsert(c.owners ?? [], incoming).filter((o) => o.stream && streams.has(o.stream)).map((o) => ({ o, workers: workersOf(o.worker, c.owners?.find((x) => x.id === o.id)?.worker) }))

/**
 * 済にする前に Orca で様子を確かめる受け取り: closingRows の worker と、新しく済になるタスクの仕事の担当の受け取り。帳簿はロックの外で読んだものでよい
 * （書くときに足りない・替わったものは applyChange が「確かめていない」で断る）。変更の形は検査の前なので、どんな値でも落ちない。
 */
export function closeTargets(c: Cockpit, change: unknown): CloseTarget[] {
  const ch = isObj(change) ? change : {}
  const rows = closingRows(c, ch.tasks)
  const incoming = Array.isArray(ch.owners) ? ch.owners.filter((x): x is Owner => isObj(x) && typeof x.id === 'string') : []
  const ws = workersOf(...rows.flatMap((x) => x.workers), ...ownersIn(c, incoming, closedStreams(rows)).flatMap((x) => x.workers), ...unboundOwners(c, ch.owners).flatMap((x) => x.workers))
  return ws.map((worker) => ({ key: workerKey(worker), worker }))
}

const releaseHint = (d: string | undefined, w: TaskWorker | undefined) =>
  d ? `orca orchestration worker-release --dispatch ${d}（worker_done を返していなければ worker-stop --dispatch ${d}）で片付け`
    : w ? `受け取り ${w.task_id} の Dispatch（orca orchestration dispatch-show --task ${w.task_id} で引く）を worker-release（worker_done を返していなければ worker-stop）で片付け`
      : '担当のチャットか端末を閉じて片付け'

/**
 * 済んだ仕事に worker と担当を残さない（R240・t168）:
 * - 新しく済にするタスクの worker、記録を外す・替えるタスクの元の worker の Dispatch がまだ動いていれば断る（worker_done を待つか止める）
 * - 担当の受け取りを外す・替えるなら、元の受け取りの Dispatch が動いているか端末が残っていれば断る
 * - 新しく済にするタスクで仕事のタスクが全部済になるなら、開いた担当を断る（片付けて state を done にする）。done の担当でも、Dispatch が動いているか
 *   端末が生きている（worker_done のあと worker-release していない）なら断る
 * 終わった worker の記録（task の worker 欄）は履歴として残したまま済にしてよい。
 */
function closeErrors(c: Cockpit, next: Cockpit, ch: Change, log: UserLog, archive: Card[], now: number, checks: Record<string, CloseCheck>): string[] {
  const rows = closingRows(c, ch.tasks)
  const unbound = unboundOwners(c, ch.owners)
  if (!rows.length && !unbound.length) return []
  const errors: string[] = []
  const look = (w: TaskWorker, what: string): { dispatch?: string; fact: DispatchFact | null } | string => {
    const x = checks[workerKey(w)]
    if (!x) return `${what}: Dispatch が動いているかを確かめていない（cockpit-write を通して書き直す）`
    return 'error' in x ? `${what}: Dispatch が動いているかを確かめられない（${x.error}）` : x
  }
  const state = (f: DispatchFact) => [f.state, f.liveness].filter(Boolean).join('・')
  for (const { old, closing, workers } of rows)
    for (const w of workers) {
      const x = look(w, `タスク ${old.id}`)
      if (typeof x === 'string') errors.push(x)
      else if (x.fact && busyDispatch(x.fact))
        errors.push(`タスク ${old.id}: worker の Dispatch ${x.dispatch} がまだ動いている（${state(x.fact)}）。worker_done を待って取り込むか、止めるなら orca-launch --stop ${x.dispatch}（worker-stop と、Orca が閉じない端末の片付け）で止めてから${closing ? '済にする（済んだ仕事に worker を残さない）' : 'worker の記録を外す・替える'}`)
    }
  for (const { o, workers } of unbound)
    for (const w of workers) {
      const x = look(w, `担当 ${o.id}`)
      if (typeof x === 'string') errors.push(x)
      else if (x.fact && (busyDispatch(x.fact) || x.fact.liveness === 'live'))
        errors.push(`担当 ${o.id}「${o.title}」: 外す受け取りの Dispatch ${x.dispatch} が${busyDispatch(x.fact) ? 'まだ動いている' : '終わったが端末が残っている'}（${state(x.fact)}）。${releaseHint(x.dispatch, w)}てから受け取りを外す・替える`)
    }
  if (!rows.length) return errors
  const read = asRead(next)
  const judged = judgeTasks(read, log, overlay(read, log, archive), undefined, now)
  const streams = [...closedStreams(rows)].filter((id) => !next.tasks.some((t) => t.stream === id && judged.get(t.id)?.state !== 'ok'))
  for (const { o, workers } of ownersIn(c, ch.owners ?? [], new Set(streams))) {
    const facts = workers.map((w) => look(w, `担当 ${o.id}`))
    if (o.state !== 'done') {
      const d = facts.map((x) => (typeof x === 'string' ? undefined : x.dispatch)).find(Boolean)
      const title = next.streams.find((s) => s.id === o.stream)?.title ?? ''
      errors.push(`仕事 ${o.stream}「${title}」: この書き込みでタスクが全部済になるが、担当 ${o.id}「${o.title}」が開いたまま。${releaseHint(d, workers[0])}、同じ書き込みで担当の state を done にする（済んだ仕事に担当を残さない）`)
      continue
    }
    for (const x of facts) {
      if (typeof x === 'string') errors.push(x)
      else if (x.fact && (busyDispatch(x.fact) || x.fact.liveness === 'live'))
        errors.push(`担当 ${o.id}「${o.title}」: Dispatch ${x.dispatch} が${busyDispatch(x.fact) ? 'まだ動いている' : '終わったが端末が残っている'}（${state(x.fact)}）。${releaseHint(x.dispatch, o.worker)}てから済にする`)
    }
  }
  return errors
}

/** 待ちの理由を書く欄。先送りの検査は、開いた待ちのあるタスクのこの欄を見る（R193）。 */
const DEFER_FIELDS = ['wait.who', 'wait.what', 'wait.why', 'next'] as const
const field = (t: Record<string, unknown>, f: string): unknown => f.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), t)
/**
 * 日付・期間だけの待ちの文（何を待つかが無い）。日まで決まった日付も、出来事が無ければ同じく断る。
 * 全角の数字と、数字と単位のあいだの空白（「１２月」「12 月」）を均してから当てる。
 */
const DATE_ONLY = /^(?:(?:\d{4}[-/年])?\d{1,2}(?:月(?:\d{1,2}日)?|[-/]\d{1,2}日?)|\d{4}[-/年]\d{1,2}月?|今週末|来週末|週末|来週|再来週|来月|再来月|月末|月初|週明け|年明け|年末)(?:上旬|中旬|下旬|ごろ|頃|以降|まで|中|の?うち)?$/
const dateOnly = (s: string) => DATE_ONLY.test(s.normalize('NFKC').replace(/\s+/g, ''))
const TASK_REF = /\bt\d+\b/g
/** 深田さんを指す語。深田さんを待つものはカードから決まるので、待ちの相手には書かない。 */
const USER_NAME = /深田|^私$|^user$/

/**
 * 先送りの検査（defer-guard.py）にかける文: 変更のうち、待ち（wait）のある開いたタスクの wait.who・what・why と next。
 * 元の行にそのままある文も含める（どれを断るかは applyChange が元の行と比べて決める）。
 */
export function deferToCheck(change: unknown): DeferItem[] {
  const tasks = isObj(change) && Array.isArray(change.tasks) ? change.tasks : []
  const last = new Map(tasks.filter((x: unknown) => isObj(x) && typeof x.id === 'string').map((x: Record<string, unknown>) => [x.id as string, x]))
  return [...last.values()].filter((t) => t.state !== 'ok' && isObj(t.wait)).flatMap((t) =>
    DEFER_FIELDS.flatMap((f) => {
      const v = field(t, f)
      return typeof v === 'string' && v.trim() ? [{ key: `${t.id as string}.${f}`, text: v }] : []
    }))
}

/**
 * タスクの書き方の断り（R193・R204）。古い欄・state・済のタスクの待ちと次・待ちの相手と文・前提・解いた事実の出どころを見る。
 * 元の行と同じ文は先送りの検査にかけない（書く道具を通らずに残った古い行は state.ts の checks が拾う）。
 */
function taskErrors(t: Task, old: Task | undefined, ctx: { tasks: Task[]; cards: Card[]; utterances: Utterance[]; notices: Utterance[]; log: UserLog }, defer: Record<string, DeferCheck>): string[] {
  const out: string[] = []
  const rec = t as unknown as Record<string, unknown>
  const legacy = LEGACY_TASK_KEYS.filter((k) => rec[k] !== undefined)
  if (legacy.length) out.push(`タスク ${t.id}: ${legacy.join('・')} は廃止した（R204）。外の待ちは wait（person・event・date・slot）、前提は after、状況は仕事の status に書く。深田さんの待ちはカードの tasks から決まる`)
  if (!TASK_MARKS.includes(t.state as TaskMark)) out.push(`タスク ${t.id}: state は open か ok（動いている・待ち・止まりは state.ts が事実から決める。R204）`)
  const w = t.wait
  if (t.state === 'ok' && w) out.push(`タスク ${t.id}: 済のタスクに待ちは書かない。残りの確認があるなら別のタスクにする（R204）`)
  if (t.state === 'ok' && t.next?.trim() && (old?.next ?? '') !== t.next)
    out.push(`タスク ${t.id}: 済にするタスクに next を書かない。済んだことは done[] に、残りの確認は別のタスクにする（R204）`)
  if (w) {
    if (w.who && USER_NAME.test(w.who.trim())) out.push(`タスク ${t.id}.wait.who: 深田さんを待つものは書かない。頼むカードを作り、カードの tasks から指す`)
    const cardIds = new Set(ctx.cards.map((x) => x.id))
    const named = [w.who, w.what, w.why].flatMap((x) => (x ?? '').match(/\b[a-z]\d+\b/g) ?? []).filter((x) => cardIds.has(x))
    if (named.length) out.push(`タスク ${t.id}.wait: カード ${named.join('・')} を待ちに書かない。カードを待つものはカードの tasks から決まる（同じ事実を 2 か所に書かない）`)
    const what = (w.what ?? w.why ?? '').trim()
    if (what && dateOnly(what) && JSON.stringify(old?.wait ?? null) !== JSON.stringify(w))
      out.push(`タスク ${t.id}.wait: 日付・期間だけ（「${what}」）では何を待つかが分からない。日付で確かめるなら kind: date の on と what に確かめることを書く（R193）`)
    const by = (w.met ?? []).map((m) => m.by)
    if (new Set(by).size !== by.length) out.push(`タスク ${t.id}.wait.met: 同じ証拠を 2 回書かない（届いた件数は証拠の数で数える）`)
    for (const m of w.met ?? []) {
      const ok = /^u-/.test(m.by) ? ctx.utterances.some((u) => u.id === m.by) : /^n-/.test(m.by) ? ctx.notices.some((u) => u.id === m.by)
        : /^op:/.test(m.by) ? ctx.log.ops.some((o) => `op:${o.op_id}` === m.by) : true
      if (!ok) out.push(`タスク ${t.id}.wait.met: ${m.by} が発言・知らせ・操作の記録に無い`)
    }
  }
  for (const id of t.after ?? []) if (id === t.id || !ctx.tasks.some((x) => x.id === id)) out.push(`タスク ${t.id}.after: ${id === t.id ? '自分自身を前提にしない' : `タスク ${id} が無い`}`)
  // 元の行も待っていて同じ文なら見ない。待ちを新しく書いた行は、持ち越した next も見る（追加 48 の Codex 必須 1）。
  const wasWaiting = !!old && old.state !== 'ok' && !!old.wait
  if (t.state !== 'ok' && w)
    for (const f of DEFER_FIELDS) {
      const v = field(rec, f)
      if (!(typeof v === 'string' && v.trim()) || (wasWaiting && field(old as unknown as Record<string, unknown>, f) === v)) continue
      const d = defer[`${t.id}.${f}`]
      if (!d || d.error) out.push(`タスク ${t.id}.${f}: 都合での先送りかを確かめられない（${d?.error ?? '先送りの検査をしていない'}）`)
      else if (d.hit) out.push(`タスク ${t.id}.${f}: 都合での先送り「${d.hit}」。外の理由（人の返事・承認、日付で初めて取れるデータ・出来事、利用枠）を書くか、今進める（R193）`)
    }
  return out
}

/** 読み込みと同じ形（古い欄の読み替え・形の誤りの除外）にした帳簿。書く道具の判定は窓・hook と同じこの形で行う。 */
const asRead = (c: Cockpit) => parseCockpit(JSON.stringify(c))

/**
 * 事実の変化に追いつかない書き込みを断る（R204）。c は書く前、next は書いたあとの帳簿（どちらも生の形）。
 * - 仕事の状況の文: 元の事実（streamBasis）が控え（status_basis）と違う仕事は、この書き込みで status を書き直す。前に控えがあれば文も変える
 *   （同じ文を渡し直すだけで古い説明を確定させない。Astra 3 の重大 1）。控えが無い（移し替えのあと初めて）なら、照合した同じ文でもよい
 * - 新しく済になったタスク（控えで済でなかったか、控えのあとにできて済のもの。カードの承認で済になったものも）があれば、同じ仕事の開いたタスクと、
 *   after・next・goal で済になったタスクを指す開いたタスクを、この書き込みで直すか unaffected に並べる（Astra 3 の重大 2・小 3）
 * 書いたあとの帳簿に、控えを書き直した status_basis を返す。facts_since の無い帳簿（移し替えの前）は何もしない。
 */
/**
 * 仕事の形と担当・worker の食い違い（t159）。書いたあとの帳簿で、この書き込みが触れた仕事（渡した仕事、渡したタスク・担当の仕事）だけを見る。
 * - 形の無い仕事のタスク・担当は書かない（形を先に決める）。見張る仕事に担当は置かない
 * - 1 つの仕事に開いた担当は 1 人まで
 * - 担当の受け取り（owners[].worker）をタスクの worker に書かない（タスクの worker は worker だけ。担当を worker の停止・取り込み・片付けに数えないため）
 * - 一緒に作る仕事に済んでいないタスクがあれば、開いた担当を置く（R145 の「共同作業中」の行は担当から作る。担当なしで worker を立てる・担当だけ外すと行が消える）
 * 済は窓と同じ判定で決める（確認の承認で済になったタスクは数えない）。
 */
function formErrors(before: Cockpit, next: Cockpit, ch: Change, log: UserLog, archive: Card[], now: number): string[] {
  // 行を別の仕事に移したときは、移す前の仕事も見る（担当だけ移して、元の一緒に作る仕事から担当が消えるのを止める）。
  const was = [...(ch.owners ?? []).map((o) => before.owners?.find((x) => x.id === o.id)?.stream), ...(ch.tasks ?? []).map((t) => before.tasks.find((x) => x.id === t.id)?.stream)]
  const touched = new Set<string>([...(ch.streams ?? []).map((s) => s.id), ...(ch.tasks ?? []).map((t) => t.stream), ...(ch.owners ?? []).flatMap((o) => (o.stream ? [o.stream] : [])), ...was.filter((x): x is string => !!x)])
  if (!touched.size) return []
  const read = asRead(next)
  const judged = judgeTasks(read, log, overlay(read, log, archive), undefined, now)
  const owners = next.owners ?? []
  const errors: string[] = []
  for (const id of touched) {
    const s = next.streams.find((x) => x.id === id)
    if (!s) continue
    const open = owners.filter((o) => o.stream === id && o.state !== 'done')
    const left = next.tasks.filter((t) => t.stream === id && judged.get(t.id)?.state !== 'ok')
    if (!s.form && (ch.tasks ?? []).some((t) => t.stream === id && judged.get(t.id)?.state !== 'ok'))
      errors.push(`仕事 ${id}: 形（form）が無いので、タスクを結べない。先に仕事の form を delegate・cowork・watch から決めて同じ書き込みで渡す`)
    if (!s.form && open.length) errors.push(`仕事 ${id}: 形（form）が無いので、担当を置けない。先に仕事の form を決める`)
    if (s.form === 'watch' && open.length) errors.push(`仕事 ${id}: 見張る仕事に担当（${open.map((o) => o.id).join('・')}）は置かない。担当が要るなら任せるか一緒に作る仕事を別に作る`)
    if (open.length > 1) errors.push(`仕事 ${id}: 開いた担当が ${open.map((o) => o.id).join('・')} の ${open.length} 人いる。1 つの仕事の担当は 1 人にし、前の担当は state を done にする`)
    if (s.form === 'cowork' && left.length && !open.length)
      errors.push(`仕事 ${id}: 一緒に作る仕事に済んでいないタスク（${left.map((t) => t.id).join('・')}）があるのに、開いた担当がいない。orca-launch --lead ${id} で担当を立てて受け取りを同じ書き込みで owners に足すか、form を delegate に変える（worker を直接立てない）`)
  }
  const leads = new Map(owners.flatMap((o) => (o.worker?.task_id ? [[o.worker.task_id, o.id] as const] : [])))
  const shared = next.tasks.filter((t) => t.worker && leads.has(t.worker.task_id) && ((ch.tasks ?? []).some((x) => x.id === t.id) || (ch.owners ?? []).some((o) => o.id === leads.get(t.worker!.task_id))))
  for (const t of shared) errors.push(`タスク ${t.id}: worker が担当 ${leads.get(t.worker!.task_id)} の受け取りと同じ。担当の受け取りは owners[].worker だけに書き、タスクの worker は消す`)
  return errors
}

function basisErrors(c: Cockpit, next: Cockpit, ch: Change, log: UserLog, archive: Card[], now: number): { errors: string[]; streams: Stream[] } {
  if (!next.facts_since) return { errors: [], streams: next.streams }
  const read = asRead(next)
  const views = overlay(read, log, archive)
  const judged = judgeTasks(read, log, views, undefined, now)
  const errors: string[] = []
  const passed = new Set((ch.streams ?? []).map((s) => s.id))
  const changedTask = (id: string) => {
    const row = ch.tasks?.find((x) => x.id === id)
    const old = c.tasks.find((x) => x.id === id)
    return !!row && (!old || JSON.stringify(stable(upgradeTask(structuredClone(old)))) !== JSON.stringify(stable(row)))
  }
  const unaffected = new Set(ch.unaffected ?? [])
  const streams = next.streams.map((s) => {
    const basis = streamBasis(read, judged, views, s.id)
    const was = c.streams.find((x) => x.id === s.id)
    const stored = was?.status_basis
    // 控えを省いて渡した行（題だけの直しなど）でも、保存済みの控えを戻す（行の置き換えで控えが消えると、次の書き込みが初回扱いになる。Astra 4 の重大 3）。
    if (stored && stored.length === basis.length && stored.every((x, i) => x === basis[i])) return { ...s, status_basis: stored }
    // 新しく済になったタスク。控えの無い仕事は、どれが新しいか分からないので見ない（移し替えのあとの最初の書き直しで控える）。
    const doneNow = basis.filter((x) => /^t[^:]*:ok$/.test(x)).map((x) => x.split(':')[0]!)
    const fresh = stored ? doneNow.filter((id) => !stored.includes(`${id}:ok`)) : []
    for (const id of fresh) {
      const mention = new RegExp(`\\b${id}\\b`)
      const targets = [...judged.values()].filter((t) => t.state !== 'ok' && t.task.id !== id
        && (t.task.stream === s.id || t.task.after?.includes(id) || mention.test(`${t.task.next ?? ''}\n${t.task.goal ?? ''}`)))
      const missed = targets.filter((t) => !changedTask(t.task.id) && !unaffected.has(t.task.id))
      if (missed.length) errors.push(`${id}「${judged.get(id)?.task.title ?? ''}」が済になった。前提が変わったかを見直す: ${missed.map((t) => `${t.task.id}「${t.task.title}」（次: ${t.task.next?.trim() || '—'}）`).join('・')}。直すなら行を渡して next などを書き換え、関係ないなら unaffected に id を並べる（R204）`)
    }
    if (s.form === 'watch') return { ...s, status_basis: basis }
    const changes = basisChanges(stored, basis, judged).join('／')
    if (!passed.has(s.id)) {
      errors.push(`仕事 ${s.id}「${s.title}」の状況の文が古くなった（${changes}）。この書き込みで仕事の行を渡し、status を今の事実に合わせて書き直す（R204）`)
      return s
    }
    if (stored && (was?.status ?? '').trim() === (s.status ?? '').trim())
      errors.push(`仕事 ${s.id}「${s.title}」: status が前と同じ文。元の事実が変わったので（${changes}）、今どうなっていて次に何を待つかを書き直す（R204）`)
    else if (!s.status?.trim()) errors.push(`仕事 ${s.id}「${s.title}」: status が無い。今どうなっていて次に何を待つかを書く（R204）`)
    return { ...s, status_basis: basis }
  })
  return { errors, streams }
}

/**
 * 発言と知らせの仕分けで待ちを解く（R204）。intake.through か notices_through を進める書き込みで、開いた相手・出来事の待ちがあれば、
 * 越えた発言・知らせ（待ちを始めた時刻より後のもの）を 1 件ずつ、どれかの待ちの met.by で指すか、intake.no_wait に入れる（Astra 3 の重大 3）。
 */
function waitSortErrors(c: Cockpit, next: Cockpit, utterances: Utterance[], notices: Utterance[], done: Set<string>): string[] {
  const waits = openOutsideWaits(c, done)
  if (!waits.length) return []
  const from = Math.min(...waits.map((w) => w.from))
  const crossed = (list: Utterance[], was: string | undefined, now: string | undefined) => {
    const at = (id: string | undefined) => (id ? list.findIndex((u) => u.id === id) : -1)
    return at(now) > at(was) ? list.slice(at(was) + 1, at(now) + 1).filter((u) => u.id && timeOf(u.at) >= from) : []
  }
  const seen = sortedForWaits(next)
  const loose = [...crossed(utterances, c.intake?.through, next.intake?.through), ...crossed(notices, c.intake?.notices_through, next.intake?.notices_through)].filter((u) => !seen.has(u.id!))
  if (!loose.length) return []
  const open = waits.map((w) => `${w.task}（${w.wait.kind === 'person' ? `${w.wait.who}: ${w.wait.what}` : w.wait.what}）`).join('・')
  return [`開いた待ち ${open} と照らしていない発言・知らせがある: ${loose.map((u) => `${u.id}「${(u.prompt ?? '').replace(/\s+/g, ' ').slice(0, 40)}」`).join('・')}。待ちを解くなら、そのタスクの wait.met に { by: <id>, at, note } を足す。どの待ちも解かないなら intake.no_wait に id を足す（R204）`]
}

const QUOTE_MAX = 40
const clip = (s: string) => (s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX)}…` : s)

/** 検査する文面の format・宛先との食い違い・書式の違反。check は書く道具が CLI で検査した結果（無ければ検査できなかったとして断る）。 */
function draftErrors(x: Card, prev: Card | undefined, check: DraftCheck | undefined): string[] {
  if (!x.draft || !draftTouched(x as unknown as Record<string, unknown>, prev)) return []
  const d = x.draft
  const route = draftRoute(d)
  if (!d.format) {
    const hint = route ? `（${draftRoute({ via: d.via }) ? 'via' : 'href'} から推した候補: ${route}）` : ''
    return [`カード ${x.id}: draft.format が無い。draft.format を ${DRAFT_FORMATS.join('・')} のどれかで書く${hint}`]
  }
  // 書式の名前でない format は形の検査（badFields）が断る。
  if (!DRAFT_FORMATS.includes(d.format)) return []
  if (route && route !== d.format) return [`カード ${x.id}: draft.format は ${d.format} だが、宛先（via・href）は ${route}。宛先に合わせて format か via・href を修正する`]
  if (!check || check.format !== d.format) return [`カード ${x.id}: 文面の書式を検査していない（書く道具の検査を通して書く）`]
  if ('error' in check) return [`カード ${x.id}: ${check.error}。書式を確認できないので書かない（draft-format-lint を入れるか、COCKPIT_DRAFT_LINT で場所を指す）`]
  if (!check.violations.length) return []
  const rules = [...new Map(check.violations.map((v) => [v.rule, v.fix])).entries()]
  const hits = rules.map(([rule, fix]) => `${check.violations.filter((v) => v.rule === rule).map((v) => `${v.line} 行目「${clip(v.text)}」`).join('・')}（${rule}: ${fix}）`)
  return [`カード ${x.id}: ${FORMAT_LABEL[d.format]}の書式に合わない行 ${hits.join('／')}。宛先の書式（dev-standards の message-formats.md）に修正する`]
}

/** 版 2 の talk と、読み込みで直した consult を同じ中身として比べる（移し替えはディスクの talk を残すため）。 */
function canon(y: Card): Card {
  const z = structuredClone(y)
  const state = z.state
  z.state = 'open'
  upgradeCard(z)
  z.state = state
  return z
}

function upsert<T extends { id: string }>(rows: T[], incoming: T[]): T[] {
  const out = [...rows]
  for (const x of incoming) {
    const i = out.findIndex((r) => r.id === x.id)
    if (i >= 0) out[i] = x
    else out.push(x)
  }
  return out
}

/**
 * 変更を検査して、書いたあとの帳簿を返す。形・参照・版・依頼の欄・仕分けの位置のどれかが通らなければ next を返さず、理由を errors に並べる。
 * 必須の欄が欠けた確認依頼は書く（窓には出ず、窓口が 30 分のうちに埋める）が、warnings で名指しする。
 * lint は draftsToLint の文面を書式の検査にかけた結果（カード id ごと）、defer は deferToCheck の文を先送りの検査にかけた結果（id.欄ごと）、
 * more.close は closeTargets の Dispatch を Orca で読んだ結果（task:<id>・owner:<id> ごと）。
 * 検査は入出力の境界（window/write.ts）が行い、ここは結果だけを見る。
 */
export function applyChange(c: Cockpit, change: unknown, utterances: Utterance[] = [], log: UserLog = { ops: [] }, lint: Record<string, DraftCheck> = {}, defer: Record<string, DeferCheck> = {}, more: { notices?: Utterance[]; archive?: Card[]; now?: number; close?: Record<string, CloseCheck> } = {}): WriteResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObj(change)) return { errors: ['変更は JSON のオブジェクトで渡す'], warnings }
  const extra = Object.keys(change).filter((k) => !KEYS.includes(k))
  if (extra.length) errors.push(`書けない欄: ${extra.join('・')}（書けるのは ${KEYS.join('・')}）`)
  for (const k of ['cards', 'tasks', 'requests', 'streams', 'owners', 'asks'])
    if (change[k] !== undefined && (!Array.isArray(change[k]) || (change[k] as unknown[]).some((x) => !isObj(x) || typeof x.id !== 'string' || !x.id)))
      errors.push(`${k} は id のある行の配列で渡す`)
  if (change.applied_ops !== undefined && !(Array.isArray(change.applied_ops) && change.applied_ops.every((n) => Number.isInteger(n) && n > 0)))
    errors.push('applied_ops は op_id（正の整数）の配列で渡す')
  if (change.main !== undefined && !mainShape(change.main))
    errors.push(`main は { run_id・agent・terminal } のうち変える欄だけを渡す（run_id は run_ で始まる文字列、agent は ${MAIN_AGENTS.join('・')}、terminal は term_ で始まる handle かチャットなら空文字）`)
  if (change.workspace !== undefined) {
    if (!(isObj(change.workspace) && Object.keys(change.workspace).join() === 'name')) errors.push('workspace は { name } だけを渡す')
    else {
      const bad = workspaceNameCheck(change.workspace.name)
      if (bad) errors.push(bad.message)
    }
  }
  if (change.intake !== undefined && !INTAKE_SHAPE(change.intake)) errors.push('intake は { through, none, checked_through, notices_through, no_wait } の形で渡す（none・no_wait は id の配列）')
  if (change.unaffected !== undefined && !(Array.isArray(change.unaffected) && change.unaffected.every((x) => typeof x === 'string'))) errors.push('unaffected はタスクの id の配列で渡す')
  // 帳簿から写した行の控えはそのまま受ける（書いたあとに道具が押し直す）。控えを手で変えて古さの検査を抜けるのは断る。
  for (const s of Array.isArray(change.streams) ? change.streams : [])
    if (isObj(s) && s.status_basis !== undefined && JSON.stringify(s.status_basis) !== JSON.stringify(c.streams.find((x) => x.id === s.id)?.status_basis))
      errors.push(`仕事 ${String(s.id)}: status_basis は書く道具が書く。帳簿の値から変えない`)
  if (errors.length) return { errors, warnings }
  const ch = change as Change
  const NAMES = { cards: ['カード', CARD_KEYS], tasks: ['タスク', TASK_KEYS], requests: ['依頼', REQUEST_KEYS], streams: ['仕事', STREAM_KEYS], owners: ['担当', OWNER_KEYS] } as const
  for (const [k, [name, spec]] of Object.entries(NAMES))
    for (const row of (ch[k as keyof typeof NAMES] ?? []) as { id: string }[]) {
      // その行に元からある欄（版 2 の仕事の background・担当の note など）は書き戻してよい。新しく足す知らない欄だけを断る。
      const old = ((c as unknown as Record<string, { id: string }[] | undefined>)[k] ?? []).find((x) => x.id === row.id)
      const had = new Set(old ? strayKeys(old, spec) : [])
      const stray = strayKeys(row, spec).filter((x) => !had.has(x))
      if (stray.length) errors.push(`${name} ${row.id}: 書けない欄 ${stray.join('・')}`)
    }
  for (const a of ch.asks ?? []) {
    const stray = strayKeys(a, ASK_KEYS)
    const errs = [...askErrors(a as unknown as Record<string, unknown>), ...(stray.length ? [`書けない欄 ${stray.join('・')}`] : [])]
    if (errs.length) errors.push(`質問 ${a.id}: ${errs.join('・')}`)
  }
  if (ch.intake) {
    const stray = strayKeys(ch.intake, INTAKE_KEYS).filter((x) => !(c.intake && strayKeys(c.intake, INTAKE_KEYS).includes(x)))
    if (stray.length) errors.push(`intake: 書けない欄 ${stray.join('・')}`)
  }
  if (errors.length) return { errors, warnings }

  const streams = upsert(c.streams, ch.streams ?? [])
  const owners = upsert(c.owners ?? [], ch.owners ?? [])
  const tasks = upsert(c.tasks, ch.tasks ?? [])
  const requests = upsert(c.requests ?? [], ch.requests ?? [])
  const cards = upsert(c.cards, ch.cards ?? [])
  const has = <T extends { id: string }>(rows: T[], id: string | undefined) => id === undefined || rows.some((r) => r.id === id)

  for (const s of ch.streams ?? []) {
    if (typeof s.title !== 'string' || !s.title.trim()) errors.push(`仕事 ${s.id}: title が無い`)
    if ((s.summary !== undefined && typeof s.summary !== 'string') || (s.status !== undefined && typeof s.status !== 'string') || (s.sources !== undefined && !(Array.isArray(s.sources) && s.sources.every((x) => typeof x === 'string'))))
      errors.push(`仕事 ${s.id}: summary・status は文字列、sources は文字列の配列`)
    const long = statusError(`仕事 ${s.id}`, s.status)
    if (long) errors.push(long)
    // 状況の文は仕事にだけ書くので、タスクの status で見ていた語調も仕事で見る（R84・R204）。
    const soft = softError(`仕事 ${s.id}`, s, c.streams.find((x) => x.id === s.id), { top: ['status'], nested: {} })
    if (soft) errors.push(soft)
    if (s.form !== undefined && !FORMS.includes(s.form as StreamForm)) errors.push(`仕事 ${s.id}: form は ${FORMS.join('・')} のどれか`)
    // 形を決めずに仕事を書かせない（R51）。形の無い仕事に担当・worker を立てると、窓とサイドバーが別々の形を言い出す（t159）。
    if (s.form === undefined) errors.push(`仕事 ${s.id}: form（delegate・cowork・watch）が無い。先に形を決めて書く（cockpit skill の「仕事の形」）`)
    if (s.form === 'watch' ? !WATCH_SHAPE(s.watch) : s.watch !== undefined)
      errors.push(`仕事 ${s.id}: ${s.form === 'watch' ? '見張る仕事は watch を { automation（orca automations の id）, targets（見張る対象の名前の配列、1 件以上）, to（送り先） } で書く' : 'watch は見張る仕事（form: watch）だけに書く'}`)
  }
  for (const o of ch.owners ?? []) {
    if (typeof o.title !== 'string' || !o.title.trim()) errors.push(`担当 ${o.id}: title が無い`)
    if (['stream', 'agent', 'session', 'terminal'].some((k) => o[k as keyof Owner] !== undefined && typeof o[k as keyof Owner] !== 'string') || (o.state !== undefined && o.state !== 'open' && o.state !== 'done'))
      errors.push(`担当 ${o.id}: stream・agent・session・terminal は文字列、state は open か done`)
    if (!has(streams, o.stream)) errors.push(`担当 ${o.id}: 仕事 ${o.stream} が無い`)
    // 空の session は「チャットの担当だが session が分からない」と区別できず、窓が Dispatch から引き直す道も塞ぐ。
    if (o.session === '') errors.push(`担当 ${o.id}: session が空。分からなければ session の欄ごと書かない`)
    // チャットか端末の居場所が無い担当は、窓の「共同作業中」の行も「担当と協議」も開けない。orca-launch --lead が session を出す。
    if (o.state !== 'done' && !o.session && !o.terminal) errors.push(`担当 ${o.id}: session（チャットの担当）か terminal（端末の担当）が無い。orca-launch --lead が出した担当の行をそのまま書く`)
    if (o.worker !== undefined && !(WORKER_SHAPE(o.worker) && typeof o.worker.run_id === 'string')) errors.push(`担当 ${o.id}: worker は { run_id, task_id }（orca-launch --lead の受け取り）`)
  }
  for (const t of ch.tasks ?? []) {
    const old = c.tasks.find((x) => x.id === t.id)
    if (typeof t.title !== 'string' || !t.title.trim() || typeof t.phase !== 'string') errors.push(`タスク ${t.id}: title・phase が無い`)
    if (!has(streams, t.stream)) errors.push(`タスク ${t.id}: 仕事 ${t.stream} が無い`)
    const soft = softError(`タスク ${t.id}`, t, old, TASK_PROSE)
    if (soft) errors.push(soft)
    errors.push(...taskErrors(t, old, { tasks, cards, utterances, notices: more.notices ?? [], log }, defer))
    const rec = t as unknown as Record<string, unknown>
    // null は、その行に元から null で書かれていた欄だけ書き戻してよい（読み込みは null の欄を無いものとして読む）。
    const was = old as unknown as Record<string, unknown> | undefined
    const bad = Object.keys(TASK_SHAPE).filter((k) => rec[k] !== undefined && !(rec[k] === null && was?.[k] === null) && !TASK_SHAPE[k]!(rec[k]))
    if (bad.length) errors.push(`タスク ${t.id}: ${bad.join('・')} の形が違う（done は文字列か { text, at } の配列、reviewed_for・sources・after は文字列の配列、wait は { kind: person（who・what）・event（what）・date（on: YYYY-MM-DD・what）・slot（why）, since?, where?, probe?, need?, met?: [{ by, at, note? }] }、ほかは文字列）`)
    if (t.worker !== undefined) {
      if (!WORKER_SHAPE(t.worker)) errors.push(`タスク ${t.id}: worker は { run_id, task_id }`)
      // 今の Dispatch は窓が Run の続きから引く。dispatch_id は版 2 の記録をそのまま持ち越すときだけ受ける。
      else if (!t.worker.run_id && !same(t.worker, old?.worker)) errors.push(`タスク ${t.id}: worker は { run_id, task_id } で書く（dispatch_id は書かない。今の Dispatch は窓が引く）`)
    }
  }
  const ids = utterances.map((u) => u.id).filter((x): x is string => !!x)
  for (const r of ch.requests ?? []) {
    const old = c.requests?.find((x) => x.id === r.id)
    const rec = r as unknown as Record<string, unknown>
    const bad = Object.keys(REQUEST_SHAPE).filter((k) => rec[k] !== undefined && !REQUEST_SHAPE[k]!(rec[k]))
    if (bad.length) errors.push(`依頼 ${r.id}: ${bad.join('・')} の形が違う`)
    if (typeof r.title !== 'string' || typeof r.at !== 'string') errors.push(`依頼 ${r.id}: title・at が無い`)
    for (const t of r.tasks ?? []) if (!has(tasks, t)) errors.push(`依頼 ${r.id}: タスク ${t} が無い`)
    if (r.legacy && !old?.legacy) errors.push(`依頼 ${r.id}: legacy は移し替え（migrate-v3）だけが付ける`)
    if (r.legacy) continue
    if (r.state !== undefined) errors.push(`依頼 ${r.id}: state は書かない（state.ts が証拠から決める）`)
    if (!r.utterances?.length && !r.source) errors.push(`依頼 ${r.id}: utterances（発言の id と引用）か source（session・at・quote）が無い`)
    if (!r.done_when?.length) errors.push(`依頼 ${r.id}: done_when（済の条件 1〜3）が無い`)
    else if (r.done_when.length > 3) errors.push(`依頼 ${r.id}: done_when は 3 つまで`)
    if (!r.kind) errors.push(`依頼 ${r.id}: kind（work・question・decide・send）が無い`)
    for (const u of r.utterances ?? []) if (ids.length && !ids.includes(u.id)) errors.push(`依頼 ${r.id}: 発言 ${u.id} が発言の記録に無い`)
    for (const e of r.evidence ?? []) {
      if (e.when < 1 || e.when > (r.done_when?.length ?? 0)) errors.push(`依頼 ${r.id}: 証拠の when ${e.when} に当たる済の条件が無い（番号は 1 から）`)
      if (e.kind === 'op') {
        const o: Op | undefined = log.ops.find((x) => String(x.op_id) === e.ref)
        if (!o) errors.push(`依頼 ${r.id}: 証拠の操作 ${e.ref} が cockpit.user.json に無い`)
        else if (e.card !== undefined && (o.item_id !== e.card || (e.rev !== undefined && o.item_rev !== e.rev))) errors.push(`依頼 ${r.id}: 証拠の操作 ${e.ref} はカード ${o.item_id} の版 ${o.item_rev} に押したもの`)
      }
    }
  }
  /** 要素の行き先（element_map）が、書いたあとの帳簿のタスク・依頼の済の条件を指しているか。 */
  const mapErrors = (card: Card): string[] => (card.element_map ?? []).flatMap((m) => {
    const out: string[] = []
    if (!card.elements?.some((e) => e.n === m.n)) out.push(`カード ${card.id}: element_map の ${m.n} に当たる要素が無い`)
    if (m.task !== undefined && !has(tasks, m.task)) out.push(`カード ${card.id}: 要素 ${m.n} の行き先のタスク ${m.task} が無い`)
    if (m.request !== undefined) {
      const [rid, w] = m.request.split('#')
      const req = requests.find((x) => x.id === rid)
      if (!req) out.push(`カード ${card.id}: 要素 ${m.n} の行き先の依頼 ${rid} が無い`)
      else if (w !== undefined && !(Number.isInteger(Number(w)) && Number(w) >= 1 && Number(w) <= (req.done_when?.length ?? 0))) out.push(`カード ${card.id}: 要素 ${m.n} の行き先 ${m.request} に当たる済の条件が無い`)
    }
    return out
  })
  // 依頼を書き換えたら、その依頼を指す既にあるカードの行き先も確かめる（済の条件を減らして「r1#2」を宙に浮かせない）。
  const touched = new Set((ch.requests ?? []).map((r) => r.id))
  const incomingCards = new Set((ch.cards ?? []).map((x) => x.id))
  for (const x of c.cards) {
    if (incomingCards.has(x.id) || !Array.isArray(x.element_map)) continue
    for (const m of x.element_map) {
      const [rid, w] = String(m?.request ?? '').split('#')
      if (!touched.has(rid!) || w === undefined) continue
      const before = c.requests?.find((r) => r.id === rid)?.done_when?.[Number(w) - 1]
      const after = requests.find((r) => r.id === rid)?.done_when?.[Number(w) - 1]
      // 番号は同じでも中身が変われば（条件を削って後ろが詰まったなど）、カードの行き先は黙って別の条件を指す。
      if (before !== after) errors.push(`カード ${x.id}: 要素 ${m.n} の行き先 ${m.request} の済の条件が${after === undefined ? '無くなる' : '変わる'}（依頼の書き換えで外れる）。同じ変更でカードの element_map も書き直す`)
    }
  }
  for (const x of ch.cards ?? []) {
    const head = cardHeadError(x)
    if (head) {
      errors.push(`カード ${x.id}: ${head}`)
      continue
    }
    // 読み込みで直す前の形を、読み込みで直した元の行と比べる（upgradeCard は版 2 の talk の深田さんの last を stance に写す。写した文を窓口の文として断らない）。
    const prev = c.cards.find((y) => y.id === x.id)
    const soft = softError(`カード ${x.id}`, x, prev && canon(prev), CARD_PROSE)
    if (soft) errors.push(soft)
    errors.push(...draftErrors(x, prev, lint[x.id]))
    const card = upgradeCard(x)
    // 返しの印は読むときは配列なら受ける（python の照合と同じ）が、書くときは return_id の形だけにする。
    const bad = [...badFields(card), ...(['from_returns', 'held_returns'] as const).filter((k) => Array.isArray(card[k]) && !card[k]!.every(returnId))]
    if (bad.length) errors.push(`カード ${card.id}: ${bad.join('・')} の形が違う`)
    if (!has(streams, card.stream)) errors.push(`カード ${card.id}: 仕事 ${card.stream} が無い`)
    for (const t of card.tasks ?? []) if (!has(tasks, t)) errors.push(`カード ${card.id}: タスク ${t} が無い`)
    if (!has(owners, card.owner)) errors.push(`カード ${card.id}: 担当 ${card.owner} が無い`)
    if (!has(requests, card.request_id)) errors.push(`カード ${card.id}: 依頼 ${card.request_id} が無い`)
    // 前の形（tidy_op）は、帳簿にある値のまま書き戻すときだけ受ける（閉じる・既読にする）。新しく書くなら tidy_ops に並べる。
    if (card.tidy_op !== undefined && prev?.tidy_op !== card.tidy_op) errors.push(`カード ${card.id}: tidy_op は前の形。tidy_ops: [${card.tidy_op}] で書く`)
    for (const n of tidyOpsOf(card))
      if (!log.ops.some((o) => o.op_id === n && o.type === 'tidy')) errors.push(`カード ${card.id}: tidy_ops の ${n} は cockpit.user.json の整理・棚卸しの指示（type が tidy の操作）に無い`)
    if (tidyOpsOf(card).length && card.kind !== 'report') errors.push(`カード ${card.id}: tidy_ops は結果の報告（kind: report）にだけ書く`)
    for (const e of card.elements ?? []) if (e.n < 1) errors.push(`カード ${card.id}: 要素の番号は 1 から（${e.n}）`)
    errors.push(...mapErrors(card))
    const raw = c.cards.find((y) => y.id === card.id)
    if (!raw && card.rev < 1) errors.push(`カード ${card.id}: rev は 1 から`)
    if (raw) {
      const old = canon(raw)
      const now = canon(card)
      const strip = (y: Card) => Object.fromEntries(Object.entries(y).filter(([k]) => k !== 'rev' && !CLOSING_FIELDS.has(k)))
      // 開いたままなら全部の欄、片付ける・顧客待ちにするなら片付けで動く欄の外が「中身」。
      const body = (y: Card) => Object.fromEntries(Object.entries(y).filter(([k]) => k !== 'rev' && !INTAKE_FIELDS.has(k)))
      const changed = card.state === 'open' ? !same(body(old), body(now)) : !same(strip(old), strip(now))
      if (card.rev < old.rev) errors.push(`カード ${card.id}: rev を下げない（今 ${old.rev}）`)
      // 開いたカードを閉じるときは版を動かさない（承認した版のまま閉じる）。中身も直すなら、先に rev を上げて書き、別に閉じる。
      else if (old.state === 'open' && card.state !== 'open' && (changed || card.rev !== old.rev))
        errors.push(`カード ${card.id}: 片付けるときは rev を ${old.rev} のまま、中身を変えない${changed ? '（中身を直すなら、開いたまま rev を上げて書いてから片付ける）' : '（上げると「これでよい」の版の照合から外れる）'}`)
      else if (changed && card.rev !== old.rev + 1) errors.push(`カード ${card.id}: 中身を変えたら rev を ${old.rev + 1} にする（古い版に押された操作を効かせないため）`)
      else if (!changed && card.rev > old.rev + 1) errors.push(`カード ${card.id}: rev は 1 ずつ上げる（今 ${old.rev}）`)
      else if (!changed && card.rev !== old.rev && card.state !== 'open') errors.push(`カード ${card.id}: 片付けるだけなら rev は ${old.rev} のまま（上げると「これでよい」の版の照合から外れる）`)
    }
    if (card.state === 'open') {
      const miss = missingFields(card)
      if (miss.length) warnings.push(`カード ${card.id}: 必須の欄が欠けているので窓に出ない（${miss.map((m) => m.key).join('・')}）。30 分のうちに埋める`)
    }
  }

  // 要素のあるカードへの「これでよい」は、全部の要素に行き先を書いてから取り込む（一部だけタスクにして通るのを防ぐ。9.2）。
  for (const id of ch.applied_ops ?? []) {
    const o = log.ops.find((x) => x.op_id === id)
    // 無い op を先に消し込むと、あとで押された操作にその番号が付き、未反映の知らせから消える。
    if (!o) {
      errors.push(`applied_ops の ${id} は cockpit.user.json に無い操作`)
      continue
    }
    const card = o?.type === 'accept' ? cards.find((x) => x.id === o.item_id) : undefined
    const miss = card ? unmappedElements(card) : []
    if (miss.length) errors.push(`カード ${card!.id}: 「これでよい」の op ${id} を取り込む前に、要素 ${miss.join('・')} の行き先を element_map に書く（task・request・skip のどれか）`)
  }

  // 整理・棚卸しの指示は、報告のカードと反映済みの印（applied_ops）を同じ書き込みで持たせる（t163）。報告に並べた番号はこの書き込みで反映済みにし、
  // 報告の無い番号を反映済みにする書き込みと、反映済みの指示の報告を書き換えで無くす書き込みを断る。取り消した指示は報告なしで反映済みにしてよい。
  const applied = [...new Set([...(c.applied_ops ?? []), ...(ch.applied_ops ?? []), ...(ch.cards ?? []).flatMap((x) => tidyOpsOf(x as Card))])]
  {
    const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
    // 指示とその取り消しは組で反映済みにする（片方だけ残ると、窓の合図が残った方を取り消しの組と見ずに窓口へ送る）。
    // 窓は猶予の 10 秒のうちしか指示を取り消させないので、組は必ず窓口が実行する前のもの。
    const undos = log.ops.filter((u) => u.type === 'undo' && log.ops.some((o) => o.op_id === u.undo_of && o.type === 'tidy'))
    const paired = new Set(undos.filter((u) => applied.includes(u.op_id) || applied.includes(u.undo_of!)).map((u) => u.undo_of!))
    for (const id of [...paired, ...undos.filter((u) => paired.has(u.undo_of!)).map((u) => u.op_id)]) if (!applied.includes(id)) applied.push(id)
    const reported = (xs: Card[]) => new Set([...xs, ...(more.archive ?? [])].filter((x) => x.kind === 'report').flatMap(tidyOpsOf))
    const [before, after] = [reported(c.cards), reported(cards)]
    const was = new Set(c.applied_ops ?? [])
    for (const id of applied) {
      if (after.has(id) || undone.has(id) || log.ops.find((o) => o.op_id === id)?.type !== 'tidy') continue
      if (!was.has(id)) errors.push(`applied_ops の ${id} は整理・棚卸しの指示。結果の報告のカード（kind: report、tidy_ops に ${id}）を同じ書き込みで書く（何も無かったときも「見つけたもの 0 件」の報告。cockpit skill の references/tidy.md）`)
      else if (before.has(id)) errors.push(`整理・棚卸しの指示 ${id} の報告がこの書き込みで無くなる。報告のカードの tidy_ops に ${id} を残す`)
    }
  }

  let intake = c.intake
  if (ch.intake) {
    intake = { ...c.intake, ...ch.intake }
    const bound = new Set([...(intake.none ?? []), ...requests.flatMap((r) => (r.utterances ?? []).map((u) => u.id))])
    const at = (id: string | undefined) => (id ? ids.indexOf(id) : -1)
    if (intake.through && at(intake.through) < 0) errors.push(`intake.through ${intake.through} が発言の記録に無い`)
    else {
      // 結ばれていない発言をまたいで仕分けの位置を進めない（またぐと、その発言が仕分けの検査から消える）。
      const skipped = ids.slice(at(c.intake?.through) + 1, at(intake.through) + 1).filter((id) => !bound.has(id))
      if (skipped.length) errors.push(`intake.through を進める前に、発言 ${skipped.join('・')} を依頼か none に結ぶ`)
    }
  }

  for (const id of ch.unaffected ?? []) if (!tasks.some((t) => t.id === id)) errors.push(`unaffected: タスク ${id} が無い`)
  if (ch.intake?.notices_through && !(more.notices ?? []).some((n) => n.id === ch.intake!.notices_through)) errors.push(`intake.notices_through ${ch.intake.notices_through} が知らせの記録に無い`)

  if (errors.length) return { errors, warnings }
  const next: Cockpit = {
    ...c, streams, tasks, cards, ...(c.owners || ch.owners ? { owners } : {}), ...(c.requests || ch.requests ? { requests } : {}),
    ...(intake ? { intake } : {}),
    ...(ch.main ? { main: withMain(c.main, ch.main) } : {}),
    ...(ch.workspace ? { workspace: { ...c.workspace, name: ch.workspace.name } } : {}),
    ...(c.asks || ch.asks ? { asks: upsert(c.asks ?? [], ch.asks ?? []) } : {}),
    applied_ops: applied
  }
  // Run だけの main を消したら、空の main を残さない（main の無い帳簿に戻す）。
  if (next.main && !Object.keys(next.main).length) delete next.main
  const before = asRead(c)
  // カードの承認で済になったタスクの待ちは、もう仕分けを求めない（窓と同じ判定。Astra 4 の中 2）。
  const doneBefore = new Set([...judgeTasks(before, log, overlay(before, log, more.archive ?? []), undefined, more.now ?? Date.now()).values()].filter((t) => t.state === 'ok').map((t) => t.task.id))
  errors.push(...waitSortErrors(before, asRead(next), utterances, more.notices ?? [], doneBefore))
  errors.push(...formErrors(c, next, ch, log, more.archive ?? [], more.now ?? Date.now()))
  errors.push(...closeErrors(c, next, ch, log, more.archive ?? [], more.now ?? Date.now(), more.close ?? {}))
  const basis = basisErrors(c, next, ch, log, more.archive ?? [], more.now ?? Date.now())
  errors.push(...basis.errors)
  if (errors.length) return { errors, warnings }
  next.streams = basis.streams
  // 窓の合図は窓口の Run にだけ送る（R191）。Run の無い帳簿は、窓で押しても窓口に届かない。
  if (!RUN_ID(next.main?.run_id)) return { errors: ['main.run_id が無い。窓口の Run を { "main": { "run_id": "run_…" } } で一緒に書く（窓の合図は窓口の Run にだけ送る）'], warnings }
  // 形の外れた古い名前は、ほかの書き込みを止めずに名指しする（名前は見出しで、合図の届き先と違い、外れても知らせは失われない）。
  // ただし intake を初めて付ける書き込みは版 3 への移し替えに当たるので、migrate-v3 と同じく断る（Codex 43 必須 1）。
  const name = workspaceNameCheck(next.workspace?.name)
  if (name && !c.intake && next.intake) return { errors: [name.message], warnings }
  if (name) warnings.push(name.message)
  return { next, errors, warnings }
}

/** 窓口の種類。Orca の agent launch の --agent の名前（窓口を替える道具と、引き継ぎで新しい窓口を起こす hook が読む）。 */
export const MAIN_AGENTS = ['claude', 'antigravity', 'codex']
const MAIN_KEYS = ['run_id', 'agent', 'terminal']

function mainShape(v: unknown): boolean {
  if (!isObj(v) || !Object.keys(v).length || Object.keys(v).some((k) => !MAIN_KEYS.includes(k))) return false
  if (v.run_id !== undefined && !(v.run_id === null || RUN_ID(v.run_id))) return false
  if (v.agent !== undefined && !MAIN_AGENTS.includes(v.agent as string)) return false
  return v.terminal === undefined || v.terminal === '' || (typeof v.terminal === 'string' && /^term_\S+$/.test(v.terminal))
}

function withMain(main: Cockpit['main'], ch: NonNullable<Change['main']>): NonNullable<Cockpit['main']> {
  const { run_id: _, ...rest } = main ?? {}
  const run = ch.run_id === undefined ? main?.run_id : ch.run_id
  return { ...rest, ...(ch.agent !== undefined && { agent: ch.agent }), ...(ch.terminal !== undefined && { terminal: ch.terminal }), ...(run != null && { run_id: run }) }
}

export type SortRow = { id: string; title: string; tasks: string; last?: string }
export type MigrateV3 = { next: Cockpit; summary: string[]; /** 窓口が仕分ける古い依頼（済と照合できなかったもの）。 */ sort: SortRow[] }

/** 片付けた・済ませた・返事を決めた・話した・直しを頼んだ、の深田さんの操作。見てがこれ無しで閉じていたら「確認なしで閉じた」。 */
const USER_TOUCH = new Set(['decide', 'accept', 'sent', 'skip', 'delegate', 'talk', 'ack'])
/** 依頼を済と照合できる深田さんの返答。 */
const ANSWER = new Set(['decide', 'accept', 'sent', 'delegate'])

/**
 * 版 2 の帳簿を版 3 の形に移す（migrate-v3）。runOf は Dispatch → Run（Orca の worker-show で引いたもの）。
 * - at の無いカードに created_at を写す。開いた talk は書き換えない（読み込みが consult として扱う。版 2 のパネルが読めるように）
 * - worker に run_id を補う（dispatch_id は残す。古いパネルが移し替えのあとも読めるように）
 * - 今ある依頼に legacy: true。結ばれたタスクが全部済で、結ばれたカードも全部閉じ、そのうち 1 枚以上に深田さんの返答
 *   （これでよい・決めた・済ませた・許して任せた、か resolved_by: user）が残るものだけ state を done にする（照合できたものだけ）。
 *   ほかは窓口が仕分ける一覧に出す
 * - intake.through: 発言に id があれば最後の行、無ければ空（id の無い行は仕分けの検査に入らない）
 * - resolved_at の無い閉じたカードに、操作 → created_at → at → 移し替えの時刻の順で補い、resolved_at_inferred を付ける
 * - 深田さんが片付けた印（resolved_by: user）も最後の版への操作も無いまま閉じた見てに closed_without_review を付ける
 *   （前の版に「これでよい」を押したあと、窓口が直して rev を上げ、そのまま閉じたものを含む）
 */
export function migrateV3(raw: Cockpit, log: UserLog, utterances: Utterance[], runOf: Record<string, string>, now: number): MigrateV3 {
  const c = structuredClone(raw)
  const summary: string[] = []
  // 開いた talk はディスクでは talk のまま残し、読み込み（upgradeCard）で相談として扱う。版 2 のパネルは consult を知らず、
  // 1 枚あるだけで帳簿全体を読めなくなるため（入れ直す前のパネルが残っていても読めるように）。
  const talk = c.cards.filter((x) => x.kind === 'talk' && x.state !== 'done').map((x) => x.id)
  const noAt = c.cards.filter((x) => !x.at && x.created_at)
  for (const x of noAt) x.at = x.created_at
  summary.push(`開いた話し中（読み込みで相談として扱う。帳簿は talk のまま）: ${talk.join('・') || 'なし'}`, `at を created_at から補った: ${noAt.map((x) => x.id).join('・') || 'なし'}`)

  const filled: string[] = []
  const missingRun: string[] = []
  for (const t of c.tasks) {
    if (!t.worker || t.worker.run_id || !t.worker.dispatch_id) continue
    const run = runOf[t.worker.dispatch_id]
    if (run) {
      t.worker = { run_id: run, task_id: t.worker.task_id, dispatch_id: t.worker.dispatch_id }
      filled.push(t.id)
    } else missingRun.push(`${t.id}（${t.worker.dispatch_id}）`)
  }
  summary.push(`worker に run_id を補った: ${filled.join('・') || 'なし'}`)
  if (missingRun.length) summary.push(`Run を引けなかった worker（dispatch_id のまま読む）: ${missingRun.join('・')}`)

  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  const opsOf = (x: Card) => log.ops.filter((o) => o.item_id === x.id && o.item_rev === x.rev && !undone.has(o.op_id) && o.type !== 'undo')
  // 版 2 の窓口は返答を反映するときに rev を上げていたので、返答はどの版に押したものでも数える。
  const answered = (x: Card) => x.resolved_by === 'user' || log.ops.some((o) => o.item_id === x.id && ANSWER.has(o.type) && !undone.has(o.op_id))
  const byId = new Map(c.tasks.map((t) => [t.id, t]))
  const closedNow: string[] = []
  const sort: SortRow[] = []
  for (const r of c.requests ?? []) {
    r.legacy = true
    if (r.state === 'done') continue
    const ts = (r.tasks ?? []).map((id) => byId.get(id)).filter((t): t is Task => !!t)
    const cards = c.cards.filter((x) => (x.tasks ?? []).some((t) => r.tasks?.includes(t)))
    if (ts.length && ts.every((t) => t.state === 'ok') && cards.every((x) => x.state === 'done') && cards.some(answered)) {
      r.state = 'done'
      closedNow.push(r.id)
      continue
    }
    // 移し替えは読み込みを通す前の中身を扱うので、Bash で書かれた形の違う done（数など）も通す。
    const last = [...ts.flatMap((t) => (Array.isArray(t.done) ? t.done : []).map((d) => (typeof d === 'string' ? undefined : d?.at))), ...cards.map((x) => x.resolved_at ?? x.at)]
      .filter((x): x is string => !!x).sort((a, b) => timeOf(a) - timeOf(b)).at(-1)
    sort.push({ id: r.id, title: r.title, tasks: ts.map((t) => `${t.id} ${t.state}`).join('・') || 'タスクなし', last })
  }
  summary.push(`依頼 ${(c.requests ?? []).length} 件に legacy を付けた。タスクとカードが全部済で深田さんの返答が残るので済にした: ${closedNow.join('・') || 'なし'}。窓口が仕分ける: ${sort.length} 件`)

  const ids = utterances.map((u) => u.id).filter((x): x is string => !!x)
  c.intake = { through: ids.at(-1) ?? '', none: [] }
  summary.push(ids.length ? `仕分けの位置: ${ids.at(-1)}（それまでの発言は仕分け済みとする）` : '発言の記録に id が無いので、仕分けの位置は空（id の付いた発言から検査する）')
  if (!RUN_ID(c.main?.run_id)) summary.push('main.run_id が無い。窓口の Run を cockpit-write の { "main": { "run_id": "run_…" } } で書く（Run が無いと窓の合図が届かず、cockpit-write はほかの書き込みも断る）')

  const inferred: string[] = []
  const unreviewed: string[] = []
  for (const x of c.cards) {
    if (x.state !== 'done') continue
    if (!x.resolved_at) {
      x.resolved_at = log.ops.filter((o) => o.item_id === x.id && USER_TOUCH.has(o.type) && !undone.has(o.op_id)).at(-1)?.at ?? x.created_at ?? x.at ?? new Date(now).toISOString()
      x.resolved_at_inferred = true
      inferred.push(x.id)
    }
    if (x.kind === 'review' && x.resolved_by !== 'user' && !opsOf(x).some((o) => USER_TOUCH.has(o.type))) {
      x.closed_without_review = true
      unreviewed.push(x.id)
    }
  }
  summary.push(`resolved_at を補った閉じたカード: ${inferred.length} 件`, `深田さんの操作の無いまま閉じた見て: ${unreviewed.join('・') || 'なし'}`)
  return { next: c, summary, sort }
}

/** 移し替え（migrate-facts）で意味の変わる行: 古い手書きの状態と待ちの文、新しい判定と待ちの 1 行、なぜ変わるか。conflict は窓口が 1 件ずつ決める行。 */
export type FactsRow = { id: string; title: string; before: string; after: string; why: string; conflict?: boolean }
export type MigrateFacts = { next: Cockpit; rows: FactsRow[]; summary: string[] }

/** 帳簿の今の事実で、全部の仕事の状況の文の控え（status_basis）を押す。初めて作る帳簿（init）が使う。 */
export function withBasis(c: Cockpit, log: UserLog, archive: Card[], now: number): Cockpit {
  const read = asRead(c)
  const views = overlay(read, log, archive)
  const judged = judgeTasks(read, log, views, undefined, now)
  return { ...c, streams: c.streams.map((s) => ({ ...s, status_basis: streamBasis(read, judged, views, s.id) })) }
}

/** 済のタスクの next のうち、残りの確認らしい文。 */
const LEFTOVER = /確か|見る|待つ|次の/

/**
 * 帳簿を、待ちと済を事実から決める形（R204）に移す（migrate-facts）。タスクの古い欄を読み込みと同じ規則（upgradeTask）で読み替え、facts_since を書く。
 * カードは触らない（rev を上げると開いたカードに押された操作が旧版扱いになる。Astra 2 の 4）。仕事の status_basis は書かない
 * （照合する前の状況の文に控えを押さない。移し替えのあとの最初の書き込みで、窓口が文を照合して書き直す。Astra 3 の中 3）。
 * rows は、同じ操作の記録で、古い手書きの状態と新しい判定（Orca の様子は入れない）の意味が変わる行。
 */
export function migrateFacts(raw: Cockpit, log: UserLog, archive: Card[], now: number): MigrateFacts {
  if (raw.facts_since) throw new Error(`すでに事実から決める形（facts_since: ${raw.facts_since}）`)
  const next = structuredClone(raw)
  for (const t of next.tasks) upgradeTask(t)
  // 残りの確認らしい next を持つ済のタスクは next を空にする（残りの確認は別のタスクに移っていることを窓口が照合した。t122 の照合 2）。
  // ほかの済のタスクの next は残す（窓は済のタスクの next を出さない）。元の文は cockpit.v3.json に残る。
  const cleared = next.tasks.filter((t) => t.state === 'ok' && t.next?.trim() && LEFTOVER.test(t.next))
  for (const t of cleared) t.next = ''
  next.facts_since = new Date(now).toISOString()
  const read = asRead(next)
  const judged = judgeTasks(read, log, overlay(read, log, archive), undefined, now)
  const WORD: Record<string, string> = { stop: '止まっている', run: '作業中', wait: '待ち', idle: '未着手', ok: '完了', open: '開いている' }
  const rows: FactsRow[] = []
  for (const t of raw.tasks) {
    const r = t as unknown as Record<string, unknown>
    const j = judged.get(t.id)
    if (!j) continue
    const on = typeof r.waiting_on === 'string' ? r.waiting_on.trim() : ''
    const check = typeof r.check_on === 'string' ? r.check_on : ''
    const before = [WORD[String(r.state)] ?? String(r.state), on && `待ち「${on}」`, check && `確認日 ${check}`, typeof r.status === 'string' && r.status.trim() && `状況「${r.status.trim()}」`].filter(Boolean).join('・')
    const after = `${WORD[j.state]}・${j.label}${j.done === 'card' ? '（カードの承認で済）' : ''}`
    const why: string[] = []
    const oldState = String(r.state)
    if (oldState !== j.state && !(oldState === 'ok' && j.state === 'ok')) why.push(`手書きの ${oldState} が、事実から ${j.state} になる`)
    if (oldState === 'ok' && (on || check)) why.push('済のタスクに残っていた待ちを捨てる')
    if (on && check) why.push('待ちの文と確認日が両方ある。待ちの文を採り、確認日は捨てる（日付を解ける条件にすると、返事が無いまま着手できると出るため）。どちらで待つかを決める')
    if (oldState !== 'ok' && on) why.push(`待ちの文を ${j.task.wait?.kind ?? (j.task.after?.length ? 'after' : '—')} に読み替えた（${j.task.wait ? JSON.stringify(j.task.wait) : `after ${j.task.after?.join('・')}`}）。種類と文を確かめる`)
    if (oldState !== 'ok' && !on && check) why.push(`確認日を date の待ちにした（${check}）`)
    const day = oldState !== 'ok' && !check && typeof r.next === 'string' ? /(\d{1,2})\/(\d{1,2})/.exec(r.next) : null
    if (day) why.push(`next に日付（${day[0]}）がある。その日にならないと確かめられないなら kind: date（on: ${new Date(now).getFullYear()}-${day[1]!.padStart(2, '0')}-${day[2]!.padStart(2, '0')}・what に確かめること）にする`)
    if (oldState === 'ok' && typeof r.next === 'string' && r.next.trim() && LEFTOVER.test(r.next)) why.push('済のタスクの next に残りの確認らしい文がある。移し替えで next を空にする（残っている確認があれば別のタスクにする）')
    if (j.done === 'card' && oldState !== 'ok') why.push('結んだ確認のカードが承認されているので済になる')
    if (!why.length) continue
    rows.push({ id: t.id, title: t.title, before, after, why: why.join('。'), ...(on && check && { conflict: true }) })
  }
  const live = judged.size - [...judged.values()].filter((x) => x.state === 'ok').length
  const summary = [
    `タスク ${raw.tasks.length} 件（済んでいない ${live} 件）を読み替えた。意味の変わる行 ${rows.length} 件（決める行 ${rows.filter((x) => x.conflict).length} 件）`,
    `仕事 ${raw.streams.filter((s) => s.form !== 'watch').length} 件の状況の文は、移し替えのあとの最初の書き込みで照合して書き直す（status_basis はまだ書かない）`,
    `済のタスク ${cleared.length} 件の next を空にした（済んだ事実は done[] に残る）`,
    'カードと操作の記録は変えていない（rev はそのまま）'
  ]
  return { next, rows, summary }
}
