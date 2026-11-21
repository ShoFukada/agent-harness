// .orca/cockpit.json（メインが書く）と .orca/cockpit.user.json（パネルが書く操作ログ）の形と、
// その 2 つを重ねて表示の状態を作る純粋な関数。worker とパネルの両方が使う。

export type TaskState = 'stop' | 'run' | 'wait' | 'idle' | 'ok'
/** dec: 決める、ask: 顧客に聞く、rev: 成果物を見て承認する、ack: 読めば済む報告。 */
export type ItemKind = 'dec' | 'ask' | 'rev' | 'ack'

export type Milestone = { date: string; label: string }
export type Repo = string | Record<string, string>
export type Task = {
  id: string
  stream: string
  phase: string
  title: string
  state: TaskState
  /** wait で外の相手（顧客・他社）を待つときの相手の名前。利用者を待つタスクには書かない。 */
  waiting_on?: string
  /** waiting_on の相手を待ち始めた日（ISO 8601）。画面は「（11/17 から）」と出す。 */
  waiting_since?: string
  goal?: string
  next?: string
  /** 済んだ作業。日時（at）のあるものは大タスクの経過に並ぶ。古い形の文字列だけの行も読む。 */
  done?: DoneEntry[]
  figure?: string
  sources?: string[]
  /** 本文の #123 を PR へのリンクにするリポジトリ（owner/name）。前置きごとに分けるなら { "BE": "owner/be" }。 */
  repo?: Repo
  /** このタスクを進める worker。メインが worker を立てたときに Orca の worktree id を記録する。 */
  /** terminal は worker の端末の handle（term_…）。同じ worktree に複数のタスクがあるとき、どれを進めているかを決める。 */
  worker?: { worktree_id: string; terminal?: string }
}
export type DoneEntry = string | { text: string; at?: string }
export const doneText = (d: DoneEntry) => (typeof d === 'string' ? d : d.text)
export const doneAt = (d: DoneEntry) => (typeof d === 'string' ? undefined : d.at)
export type Option = {
  id: string
  label: string
  recommended?: boolean
  body?: string
  quote?: string
  /** 選んだら何が起きるかの短い 1 行（例「30 件 → 5 人に 6 件ずつ」）。狭い窓でも選択肢のそばで読めるように。 */
  example?: string
}
export type Item = {
  id: string
  rev: number
  kind: ItemKind
  title: string
  due?: string
  state: 'open' | 'done'
  /** "push": ワークスペースの root を push するかの dec（hook が出させる）。 */
  topic?: string
  related?: { task: string; effect?: string }[]
  /** dec: なぜ今決めるか（1〜2 行）。ask・ack: この判断で変わること・報告の本文。 */
  why?: string
  /** dec: 決めるための情報。5 欄とも必須（欠けると窓に「決めるための情報が足りません」と出す）。 */
  context?: DecisionContext
  quote?: string
  figure?: string
  options?: Option[]
  fallback?: string
  decided?: { what: string; why?: string; task?: string }[]
  source?: string
  /** いきさつ 2〜3 行。原文と日付を添えられる。既定では閉じた詳細の欄に出す。 */
  background?: Background
  /** 選択肢ごとの影響の比較。表か、図のパス（figure と同じ書き方）。 */
  compare?: { columns: string[]; rows: string[][] } | string
  /** 外に送る文面（Slack・メール・顧客への返信）。送る前に利用者が本文そのものを読めるようにする。 */
  draft?: { to: string; text: string; href?: string }
  /** 詳細の上に並べる資料（PR・Drive・設計書など）。 */
  links?: { label: string; href: string }[]
  /** 本文の #123 を PR へのリンクにするリポジトリ。task の repo より優先する。 */
  repo?: Repo
  /** 成果物へのリンク（完成の報告の ack に付ける。ファイルは .orca の外でもワークスペースの中なら開ける）。 */
  href?: string
  /** rev: どの依頼のどの成果物の、どのバージョンを見てほしいか。 */
  request?: string
  deliverable?: string
  deliverable_version?: number
  /** ask: メインが実際に顧客に聞いた日時。聞き方を承認しただけのあいだは無い。 */
  asked_at?: string
  resolved_by?: 'user' | 'main'
  resolved_at?: string
  resolved_option?: string
  /** resolved_option が other のとき、利用者が書いた答えの原文。 */
  resolved_text?: string
}
/** いきさつ 2〜3 行と、原文・日付。項目と大タスクで同じ形にする。 */
export type Background = { text: string; quote?: string; date?: string }
/** 大タスク（元の案件）。summary・background・sources は任意（無ければ画面が依頼の原文と出典を出す）。 */
export type Stream = {
  id: string
  title: string
  /** 何ができたら終わりか 1〜2 行。 */
  summary?: string
  background?: Background
  sources?: string[]
}
/** 決めるための情報。利用者がその話題を初めて聞く前提で書く。どれも文字列（改行と「- 」の箇条を使ってよい）。 */
export type DecisionContext = { what?: string; now?: string; how?: string; gain?: string; cost?: string }
export const CONTEXT_FIELDS: [keyof DecisionContext, string][] = [
  ['what', '概要'], ['now', '現状'], ['how', '対応案'], ['gain', '効果'], ['cost', '懸念点']
]
/** dec で空の欄（dec 以外は空）。 */
export const missingFields = (i: Item): (keyof DecisionContext)[] =>
  i.kind !== 'dec' ? [] : CONTEXT_FIELDS.filter(([k]) => !String(i.context?.[k] ?? '').trim()).map(([k]) => k)
/** dec で空の欄の画面の見出し。 */
export const missingContext = (i: Item): string[] => missingFields(i).map((k) => CONTEXT_FIELDS.find(([f]) => f === k)![1])

/** 成果物。href はワークスペースからの相対パス（path:行 も可）・子の worktree の絶対パス・http(s) の URL。diff は差分（PR）の URL。 */
export type Deliverable = { id: string; label: string; href?: string; diff?: string; version?: number; look_for?: string[] }
/** 利用者からの依頼 1 件。原文のまま残し、タスクと成果物に結ぶ。 */
export type Request = {
  id: string
  at: string
  title: string
  quote: string
  /** タスクの無い依頼だけを閉じる。タスクのある依頼の済みはタスクから決める（state.ts の requestStatus）。 */
  state: 'open' | 'done'
  done_at?: string
  tasks?: string[]
  deliverables?: Deliverable[]
}
export type Cockpit = {
  version?: number
  workspace: { name: string; milestones?: Milestone[] }
  main?: { agent: string; terminal: string }
  phases?: string[]
  streams: Stream[]
  tasks: Task[]
  items: Item[]
  requests?: Request[]
  /** メインの作業メモ（チャットを切り替えたときの再開先）。 */
  notes_ref?: string
  applied_ops?: number[]
}

export type OpType = 'decide' | 'ack' | 'approve_ask' | 'accept' | 'talk' | 'need_context' | 'undo' | 'revert'
export type Op = {
  op_id: number
  at: string
  item_id: string
  item_rev: number
  type: OpType
  option_id?: string
  undo_of?: number
  /** revert: 戻してほしい decided の何番目か（0 始まり）。 */
  target?: number
  /** talk: 利用者の発言。item_id は項目かタスクの id。need_context: 何が知りたいか（任意）。 */
  text?: string
  /** talk: アシスタントでは答えられない話を、メインに渡す。 */
  to_main?: boolean
  /** talk: 「メインに渡す」で引き継いだ元の発言の op_id。text は元の発言の写し（記録する側が埋める）。 */
  handoff_of?: number
}
/** .orca/cockpit.talk.json の 1 件。talk の op_id への回答。書くのは窓の常駐のプロセス（assistant）とメイン（main）だけ。 */
export type Reply = { op_id: number; at: string; by: 'assistant' | 'main'; text: string; handoff?: boolean; failed?: boolean }
export type TalkLog = { replies: Reply[] }
export const TALK_MAX = 4000
/** 利用者が書いた文の検証。切り詰めずに断る（末尾の条件が落ちた文を決定として扱わないため）。パネルと窓が同じ関数を使う。 */
export function textError(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  if (typeof text !== 'string') return '文の形が違います'
  if (text.length > TALK_MAX) return `${TALK_MAX} 字までです（今 ${text.length} 字）。分けて送ってください`
  return undefined
}
export type UserLog = { ops: Op[] }
export type Archive = { items: Item[] }

const TASK_STATES: TaskState[] = ['stop', 'run', 'wait', 'idle', 'ok']
const ITEM_KINDS: ItemKind[] = ['dec', 'ask', 'rev', 'ack']
export const DEFAULT_PHASES = ['要件', '設計', '実装', '受入']
export const UNDO_GRACE_MS = 10_000

/** メインが Orca のチャットで動いていて、合図を送る端末が無い。Orca の CLI にもチャットへ文を送る手段が無い。 */
export const chatMain = (c: Cockpit | undefined) => !c?.main?.terminal

/** 「あなたの番」の件数といちばん急ぐ 1 件は、決める・聞く・見てだけで数える。報告（ack）と依頼そのものは数えない。 */
export const isYours = (i: Item) => i.kind !== 'ack'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 壊れた JSON や形の違うファイルは例外にし、呼び出し側が前回の表示を保てるようにする。 */
export function parseCockpit(text: string): Cockpit {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !isObj(v.workspace) || !Array.isArray(v.items) || !Array.isArray(v.tasks) || !Array.isArray(v.streams))
    throw new Error('cockpit.json に workspace・streams・tasks・items がありません')
  // 列挙値はパネルで class 名や印に使うので、知らない値は読み込みの時点で断る。
  for (const t of v.tasks as Record<string, unknown>[]) {
    if (!TASK_STATES.includes(t?.state as TaskState)) throw new Error(`tasks の state が不正です: ${String(t?.id)}`)
    const done = t.done
    if (done !== undefined && (!Array.isArray(done) || done.some((d) => typeof d !== 'string' && !(isObj(d) && typeof d.text === 'string' && (d.at === undefined || typeof d.at === 'string')))))
      throw new Error(`tasks の done の形が不正です（文字列か { text, at }）: ${String(t.id)}`)
  }
  for (const i of v.items as Record<string, unknown>[]) {
    if (!ITEM_KINDS.includes(i?.kind as ItemKind)) throw new Error(`items の kind が不正です: ${String(i?.id)}`)
    if (i.state !== 'open' && i.state !== 'done') throw new Error(`items の state が不正です: ${String(i.id)}`)
  }
  // 大タスクの説明は任意。書かれていれば形を確かめる（画面が文字列として描くため）。
  for (const s of v.streams as Record<string, unknown>[]) {
    const bg = s?.background as Record<string, unknown> | undefined
    if (
      (s?.summary !== undefined && typeof s.summary !== 'string') ||
      (bg !== undefined && (!isObj(bg) || typeof bg.text !== 'string')) ||
      (s?.sources !== undefined && (!Array.isArray(s.sources) || s.sources.some((x) => typeof x !== 'string')))
    )
      throw new Error(`streams の summary・background・sources の形が不正です: ${String(s?.id)}`)
  }
  if (v.requests !== undefined) {
    if (!Array.isArray(v.requests)) throw new Error('cockpit.json の requests が配列ではありません')
    for (const r of v.requests as Record<string, unknown>[])
      if (!isObj(r) || typeof r.id !== 'string' || (r.state !== 'open' && r.state !== 'done')) throw new Error(`requests の形が不正です: ${String(r?.id)}`)
  }
  return v as unknown as Cockpit
}

export function parseUserLog(text: string): UserLog {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !Array.isArray(v.ops)) throw new Error('cockpit.user.json に ops がありません')
  return v as unknown as UserLog
}

export function parseTalk(text: string): TalkLog {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !Array.isArray(v.replies)) throw new Error('cockpit.talk.json に replies がありません')
  return v as unknown as TalkLog
}

export function parseArchive(text: string): Archive {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !Array.isArray(v.items)) throw new Error('cockpit.archive.json に items がありません')
  return v as unknown as Archive
}

export function nextOp(log: UserLog, op: Omit<Op, 'op_id'>): Op {
  const last = log.ops.reduce((n, o) => Math.max(n, o.op_id), 0)
  return { op_id: last + 1, ...op }
}

export type ItemView = {
  item: Item
  /** 片付け済みのタブに入るか。 */
  closed: boolean
  /** 片付け済みの理由（「あなたが決定「…」」など）。 */
  how: string
  when?: string
  /** 利用者の操作がまだメインに反映されていない。 */
  pending: boolean
  /** 「要対応に戻す」「元に戻す」で取り消す操作。メインが片付けた項目には無い。 */
  reopenOp?: Op
  /** 片付けたあと利用者が取り消し、メインの再判断を待っている。 */
  rejudge: boolean
  /** 選んだ選択肢（決定済みのとき）。 */
  chosen?: Option
}

const CLOSING: OpType[] = ['decide', 'ack', 'approve_ask', 'accept']
/** 選択肢に無い答え。どの種類の項目でも decide・option_id "other"・text で送る。 */
export const OTHER = 'other'
/** 項目の種類ごとに、利用者が片付けるときの操作。 */
export const CLOSE_OP: Record<ItemKind, OpType> = { dec: 'decide', ask: 'approve_ask', rev: 'accept', ack: 'ack' }

function closedLabel(type: OpType | 'main', option?: Option): string {
  if (type === 'decide') return `あなたが決定「${option?.label ?? '?'}」`
  if (type === 'approve_ask') return 'あなたが聞き方を承認'
  if (type === 'ack') return 'あなたが確認'
  if (type === 'accept') return 'あなたが承認'
  return 'メインが片付け'
}

function doneLabel(item: Item, chosen?: Option): string {
  if (item.resolved_option === OTHER) return `あなたの答え: ${item.resolved_text ?? ''}`
  return item.resolved_by === 'user' ? closedLabel(CLOSE_OP[item.kind], chosen) : closedLabel('main')
}

/** cockpit.json の状態に、操作ログのうち効いている操作を重ねる。 */
export function overlay(c: Cockpit, log: UserLog, archive: Item[] = []): ItemView[] {
  const applied = new Set(c.applied_ops ?? [])
  const byId = new Map(log.ops.map((o) => [o.op_id, o]))
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  const views: ItemView[] = []

  for (const item of c.items) {
    const ops = log.ops.filter((o) => o.item_id === item.id)
    // 重ねるのは未反映の操作だけで、反映後は cockpit.json を正にする（メインが出し直した項目を古い操作で閉じない）。
    // 古い版の項目に押した未反映の操作も、メインが出し直すので効かせない。
    const live = (o: Op) => CLOSING.includes(o.type) && !undone.has(o.op_id)
    const act = ops.filter((o) => live(o) && !applied.has(o.op_id) && o.item_rev === item.rev).at(-1)
    const option = (id?: string) => item.options?.find((x) => x.id === id)
    if (act) {
      const chosen = option(act.option_id)
      const pending = !applied.has(act.op_id)
      const how = act.option_id === OTHER
        ? `送った答え: ${act.text ?? ''}${pending ? '（メインが反映待ち）' : ''}`
        : closedLabel(act.type, chosen) + (pending ? '・反映待ち' : '')
      views.push({ item, closed: true, chosen, pending, reopenOp: act, rejudge: false, when: act.at, how })
      continue
    }
    const undoOfApplied = ops.some(
      (o) => o.type === 'undo' && !applied.has(o.op_id) && applied.has(o.undo_of ?? -1) && byId.get(o.undo_of!)?.item_id === item.id
    )
    if (item.state === 'done' && !undoOfApplied) {
      const chosen = option(item.resolved_option)
      const how = doneLabel(item, chosen)
      const reopenOp = item.resolved_by === 'user' ? ops.filter((o) => live(o) && applied.has(o.op_id)).at(-1) : undefined
      views.push({ item, closed: true, how, chosen, reopenOp, pending: false, rejudge: false, when: item.resolved_at })
      continue
    }
    const pendingUndo = ops.some((o) => o.type === 'undo' && !applied.has(o.op_id))
    views.push({ item, closed: false, how: '', pending: pendingUndo, rejudge: undoOfApplied })
  }
  for (const item of archive) {
    const chosen = item.options?.find((x) => x.id === item.resolved_option)
    const how = doneLabel(item, chosen)
    views.push({ item, closed: true, how, chosen, pending: false, rejudge: false, when: item.resolved_at })
  }
  return views
}

/** 「情報が足りない」を今の版に押したか（メインが context を埋めて rev を上げると外れる）。 */
export function contextAsked(i: Item, log: UserLog): boolean {
  const undone = new Set(log.ops.filter((o) => o.type === 'undo').map((o) => o.undo_of))
  return log.ops.some((o) => o.type === 'need_context' && o.item_id === i.id && o.item_rev === i.rev && !undone.has(o.op_id))
}

/** メインにまだ反映されていない操作。 */
export function unappliedOps(c: Cockpit | undefined, log: UserLog): Op[] {
  const applied = new Set(c?.applied_ops ?? [])
  return log.ops.filter((o) => !applied.has(o.op_id))
}

const SEV: Record<TaskState, number> = { stop: 0, run: 1, wait: 2, idle: 3, ok: 4 }
/** 全体の表の工程のマスと大タスクの状態に出す、一番手当てが要る状態。 */
export function worstState(states: TaskState[]): TaskState | undefined {
  return [...states].sort((a, b) => SEV[a] - SEV[b])[0]
}

/**
 * 動いている worker が進めているタスク。① 端末の記録が一致するもの ② 同じ worktree の済んでいないもの ③ 同じ worktree の最後のもの。
 * 同じ worktree で済んだタスクを先に拾うと、進行中のタスクが「動いていない」と出るため（2026-11-16 に t1 と t25）。
 */
export function taskOfWorker(tasks: Task[], worktreeId: string, terminalId: string | null): Task | undefined {
  const same = tasks.filter((t) => t.worker?.worktree_id === worktreeId)
  return (terminalId ? tasks.find((t) => t.worker?.terminal === terminalId) : undefined) ?? same.find((t) => t.state !== 'ok') ?? same.at(-1)
}

/** タスクの状態を、どこから決めたか。ラベルの文は画面（view.ts）が持つ。 */
export type ShownWhy = 'ok' | 'yours' | 'record' | 'working' | 'intake' | 'stopped' | 'missing'
export type TaskShown = { state: TaskState; why: ShownWhy; stop?: string }
/** 結び付いたエージェントの Orca の状態（AgentRow の一部）。stop は止まった理由（返事待ち waiting も含む）。 */
export type LiveAgent = { state: string; stop?: string }

/**
 * 画面に出すタスクの状態。worker の記録があるタスクは、メインの書いた state ではなく Orca の状態から決める
 * （メインが書き忘れると「worker が作業中なのに動いていない」のような矛盾が出たため、2026-11-16）。
 * 表のマス・一覧・詳しい欄は、すべてこれを通す。
 * - state が ok なら完了（worker の記録は履歴として残る）
 * - 利用者の番の stop・wait（開いた決める・聞く・見てが指す）は、メインの書いた state のまま
 * - 作業中のエージェントがいれば進行中。許可待ち・落ちた・利用枠などで止まっていれば止まっている
 * - 作業を終えた・入力待ち、または worktree はあるがエージェントがいなければ、メインの取り込み待ち
 * - 端末も worktree も見つからなければ、worker が見つからない（メインの記録漏れ）
 */
export function shownTask(t: Task, linked: LiveAgent[], worktreeAlive: boolean | undefined, yours: Set<string>): TaskShown {
  if (t.state === 'ok') return { state: 'ok', why: 'ok' }
  if ((t.state === 'stop' || t.state === 'wait') && yours.has(t.id)) return { state: t.state, why: 'yours' }
  // パネルは worktree の一覧を持たない（Orca の状態が分からない）ので、メインの書いた state のまま。
  if (!t.worker || worktreeAlive === undefined) return { state: t.state, why: 'record' }
  if (linked.some((a) => a.state === 'working' && !a.stop)) return { state: 'run', why: 'working' }
  const stopped = linked.find((a) => a.stop && a.stop !== 'waiting')
  if (stopped) return { state: 'stop', why: 'stopped', stop: stopped.stop }
  if (linked.length || worktreeAlive) return { state: 'wait', why: 'intake' }
  return { state: 'stop', why: 'missing' }
}
