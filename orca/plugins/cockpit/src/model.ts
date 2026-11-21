// .orca/cockpit.json（メインが書く、形の版 2）と .orca/cockpit.user.json（画面が書く操作ログ）の形と、
// その 2 つを重ねてカードの今の状態を決める純粋な関数。窓・パネル・hook が使う。

import type { DispatchFact } from './protocol.ts'

export const VERSION = 2

export type TaskState = 'stop' | 'run' | 'wait' | 'idle' | 'ok'
/**
 * カードの種類。利用者の手で進むのは send・decide・review・permit・stuck の 5 種類で、件数はこれだけを数える。
 * inbox は振り分けが済むまで、talk と report は件数に入れない。
 */
export type CardKind = 'inbox' | 'send' | 'decide' | 'review' | 'permit' | 'stuck' | 'talk' | 'report'
export const KINDS: CardKind[] = ['inbox', 'send', 'decide', 'review', 'permit', 'stuck', 'talk', 'report']
export const COUNTED: CardKind[] = ['stuck', 'permit', 'decide', 'send', 'review']
export const KIND_LABEL: Record<CardKind, string> = {
  inbox: '届いた', send: '送る前', decide: '決める', review: '見て', permit: '許す', stuck: '詰まり', talk: '話し中', report: '報告'
}

export type Milestone = { date: string; label: string }
export type Repo = string | Record<string, string>
export type DoneEntry = string | { text: string; at?: string }
export const doneText = (d: DoneEntry) => (typeof d === 'string' ? d : d.text)

export type Task = {
  id: string
  stream: string
  phase: string
  title: string
  state: TaskState
  /** wait で外の相手（顧客・他社）を待つときの相手。 */
  waiting_on?: string
  waiting_since?: string
  goal?: string
  next?: string
  done?: DoneEntry[]
  sources?: string[]
  repo?: Repo
  /**
   * このタスクを進める担当か worker の、Orca の orchestration の Task と Dispatch（worker-start・send の受け取りの taskId・dispatchId）。
   * 続きを send して Dispatch が変わったら書き換える。窓はこの Dispatch の様子で状態を出す。
   */
  worker?: { task_id: string; dispatch_id: string }
}
/** 仕事（大タスク）。担当のチャットは仕事ごとに 1 つまで。 */
export type Stream = { id: string; title: string; summary?: string; sources?: string[] }

/**
 * 仕事の担当。仕事が終わるまで残る、話し相手のエージェント（Orca のチャットか端末）。
 * 担当が無い仕事のカードは、案件の窓口（main）と話す。
 */
export type Owner = {
  id: string
  /** 仕事の名前。サイドバーと画面にこの名前で出る。 */
  title: string
  /** 担当の仕事（streams の id）。 */
  stream?: string
  agent?: string
  /** Orca のチャットのセッション ID（orca agent list の orcaSessionId）。 */
  session?: string
  /** 担当が端末で動くときの handle（term_…）。 */
  terminal?: string
  state?: 'open' | 'done'
}

/** 連絡を拾う経路（Slack・Teams・メール）。見張りが読んだ時刻を書く。止まっていれば画面が「見ていない」と出す。 */
export type Route = { id: string; label: string; read_at?: string; error?: string; stale_minutes?: number }

/** 利用者に頼む手作業。command か steps のどちらかは書く（state.ts の checks が名指しする）。 */
export type Manual = { where?: string; command?: string; steps?: string[]; check?: string }
export type Option = { id: string; label: string; recommended?: boolean; example?: string; body?: string }
export type Link = { label: string; href: string }
export type DecisionContext = { what?: string; now?: string; how?: string; gain?: string; cost?: string }
export const CONTEXT_FIELDS: [keyof DecisionContext, string][] = [
  ['what', 'これは何か'], ['now', '今どうなっているか'], ['how', '入れるならどうするか'], ['gain', '得られること'], ['cost', '失うこと']
]

export type Card = {
  id: string
  rev: number
  kind: CardKind
  title: string
  /** open: 担当か利用者の手の中、waiting: 送ったあと顧客の返事を待つ、done: 済み。 */
  state: 'open' | 'waiting' | 'done'
  /** 出た時刻（ISO 8601）。 */
  at?: string
  due?: string
  /** 仕事（streams の id）。担当と、案件の今の行に結ぶ。 */
  stream?: string
  tasks?: string[]
  /** 担当（owners の id）。無ければ仕事の担当、それも無ければ窓口。 */
  owner?: string
  /** 何のため 1 行。 */
  purpose?: string

  /** inbox: 送り主・場所・時刻と、元の連絡へのリンク。 */
  from?: { who: string; via?: string; at?: string; href?: string }
  /** inbox: 聞かれていること 1 行。 */
  asked?: string
  /** inbox: 振り分け（どの担当が何を始めたか）。 */
  routed?: string
  /** inbox: 返事が要るか。 */
  reply?: 'needed' | 'none'

  /** send（と、送る文面のある decide）: 宛先と本文。href は元のスレッド。 */
  draft?: { to: string; via?: string; text: string; href?: string }

  /** decide: なぜ今決めるか。 */
  why?: string
  context?: DecisionContext
  options?: Option[]
  /** 返事が無いときにどうするか。 */
  fallback?: string
  figure?: string
  compare?: { columns: string[]; rows: string[][] } | string
  background?: { text: string; quote?: string; date?: string }

  /** review: 依頼の原文。 */
  request?: string
  look_for?: string[]
  /** review: 見れば判断できる証拠（確かめた結果・変わったところ）。 */
  evidence?: string[]
  href?: string
  diff?: string

  /** permit: 許す対象（commit の範囲・送る本文・書き換える行）。 */
  target?: string
  effect?: string
  undo?: string
  /** permit: 繰り返す許可の種類（push など）。「この案件では任せる」の単位。 */
  scope?: string
  /**
   * permit: 利用者の手作業を頼むカード（darwin-rebuild switch・プラグインの承認・ログインなど）。どこで・打つコマンド・手順・窓口の確かめ方を、
   * そのまま写せる形で書く。ボタンは「済ませた」（sent の操作）と担当と話すだけにする。
   */
  manual?: Manual

  /** stuck: 止まった理由（原文）と、止まった時刻。 */
  reason?: string
  since?: string
  /** stuck: 私が答えれば進むか。 */
  answerable?: boolean
  unblock?: string

  /** talk: 最後のやり取りと、次に待つもの。 */
  last?: { text: string; at?: string; by?: string }
  next?: string

  /** report: したこと。理由と戻し方つき。 */
  done?: { what: string; why?: string; undo?: string; task?: string }[]

  /** waiting: 何の返事を待ち、いつから、返事で何を再開し、いつ催促するか。 */
  awaiting?: { who: string; what: string; since: string; resumes?: string; remind_at?: string }

  links?: Link[]
  quote?: string
  repo?: Repo

  resolved_by?: 'user' | 'owner'
  resolved_at?: string
  resolved_option?: string
  resolved_text?: string
}

/** deliverables は版 1 から写した成果物の記録。画面は読まない。 */
export type Request = { id: string; at: string; title: string; quote: string; state: 'open' | 'done'; tasks?: string[]; deliverables?: unknown[] }

export type Cockpit = {
  version: 2
  workspace: { name: string; milestones?: Milestone[] }
  main?: { agent: string; terminal: string }
  phases?: string[]
  streams: Stream[]
  tasks: Task[]
  owners?: Owner[]
  routes?: Route[]
  cards: Card[]
  requests?: Request[]
  notes_ref?: string
  applied_ops?: number[]
}

/**
 * talk に text があれば、見ての「直してほしいことを書く」で書いた直しの指示（原文）。カードは話し中（直し待ち）になる。
 * 利用者の操作。decide は選択肢（option_id）か別の答え（option_id "other" と text）、accept は見ての「これでよい」、
 * sent は送った・済ませた、skip は送らない・返事は要らない・止める、delegate は「この案件では任せる」（許したうえで以後を任せる）、
 * talk は担当と話し始めた（カードは話し中になる）、ack は報告を読んだ、revert は報告の n 番目を戻して、undo は取り消し。
 */
/** repeat: 「前にも言った」。前に伝えたことをメインが落としたという合図で、item_id は空。メイン側の hook が押下を数え、新しいチャットへの引き継ぎに使う。 */
export type OpType = 'decide' | 'accept' | 'sent' | 'skip' | 'delegate' | 'talk' | 'ack' | 'revert' | 'undo' | 'repeat'
export const OP_TYPES: OpType[] = ['decide', 'accept', 'sent', 'skip', 'delegate', 'talk', 'ack', 'revert', 'undo', 'repeat']
export type Op = {
  op_id: number
  at: string
  item_id: string
  item_rev: number
  type: OpType
  option_id?: string
  undo_of?: number
  target?: number
  text?: string
}
export type UserLog = { ops: Op[] }
export type Archive = { cards: Card[] }
/** .orca/cockpit/handoff.json。メイン側の hook が、メインを新しいチャットに引き継いだときに書く。 */
export type Handoff = { at: string; reason: string }
export function parseHandoff(text: string): Handoff | undefined {
  const v = JSON.parse(text) as Partial<Handoff>
  return typeof v?.at === 'string' && typeof v.reason === 'string' ? { at: v.at, reason: v.reason } : undefined
}

export const OTHER = 'other'
export const TEXT_MAX = 4000
export const UNDO_GRACE_MS = 10_000
export const DEFAULT_PHASES = ['要件', '設計', '実装', '受入']

/** 利用者が書いた文の検証。切り詰めずに断る（末尾の条件が落ちた文を決定として扱わないため）。 */
export function textError(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  if (typeof text !== 'string') return '文の形が違います'
  if (text.length > TEXT_MAX) return `${TEXT_MAX} 字までです（今 ${text.length} 字）。分けて送ってください`
  return undefined
}

/** メインが Orca のチャットで動いていて、合図を送る端末が無い。 */
export const chatMain = (c: Cockpit | undefined) => !c?.main?.terminal

const TASK_STATES: TaskState[] = ['stop', 'run', 'wait', 'idle', 'ok']
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type Shape = (v: unknown) => boolean
const str: Shape = (v) => typeof v === 'string'
const strs: Shape = (v) => Array.isArray(v) && v.every(str)
/** オブジェクトで、need の欄が文字列、opt の欄が無いか文字列。 */
const obj = (need: string[], opt: string[] = []): Shape => (v) =>
  isObj(v) && need.every((k) => str(v[k])) && opt.every((k) => v[k] === undefined || str(v[k]))
const list = (one: Shape): Shape => (v) => Array.isArray(v) && v.every(one)
/** 画面と状態の計算が読むカードの欄の形。種類・状態・id は parseCockpit が先に断る。 */
const CARD_SHAPE: Record<string, Shape> = {
  ...Object.fromEntries(['at', 'due', 'stream', 'owner', 'purpose', 'asked', 'routed', 'why', 'fallback', 'figure', 'request', 'href', 'diff', 'target', 'effect', 'undo',
    'scope', 'reason', 'since', 'unblock', 'next', 'quote', 'resolved_at', 'resolved_option', 'resolved_text'].map((k) => [k, str])),
  reply: (v) => v === 'needed' || v === 'none',
  resolved_by: (v) => v === 'user' || v === 'owner',
  answerable: (v) => typeof v === 'boolean',
  manual: (v) => obj([], ['where', 'command', 'check'])(v) && ((v as Manual).steps === undefined || strs((v as Manual).steps)),
  tasks: strs, look_for: strs, evidence: strs,
  from: obj(['who'], ['via', 'at', 'href']),
  draft: obj(['to', 'text'], ['via', 'href']),
  context: obj([], CONTEXT_FIELDS.map(([k]) => k)),
  options: list((v) => obj(['id', 'label'], ['example', 'body'])(v) && ((v as { recommended?: unknown }).recommended === undefined || typeof (v as { recommended?: unknown }).recommended === 'boolean')),
  compare: (v) => str(v) || (isObj(v) && strs(v.columns) && list(strs)(v.rows)),
  background: obj(['text'], ['quote', 'date']),
  last: obj(['text'], ['at', 'by']),
  done: list(obj(['what'], ['why', 'undo', 'task'])),
  awaiting: obj(['who', 'what', 'since'], ['resumes', 'remind_at']),
  links: list(obj(['label', 'href'])),
  repo: (v) => str(v) || (isObj(v) && Object.values(v).every(str))
}

/**
 * 形の違う欄を外し、外したことを 1 行ずつ返す。カードは窓口（エージェント）が書くので、1 枚の欄の書き間違い（evidence を文字列で書くなど）で
 * 窓全体の描画を止めず、そのカードを名指しして欄を出さずに表示する（2026-11-21 に v88・v89 の evidence で見てのカードが押せなくなった）。
 */
export function dropBadFields(cards: Card[], where: string): string[] {
  const out: string[] = []
  for (const c of cards) {
    const rec = c as unknown as Record<string, unknown>
    const bad = Object.keys(CARD_SHAPE).filter((k) => rec[k] !== undefined && rec[k] !== null && !CARD_SHAPE[k]!(rec[k]))
    for (const k of Object.keys(CARD_SHAPE)) if (rec[k] === null) delete rec[k]
    // 手作業の頼みは、形が違っても「済ませた」で返す票のままにする（消すと許す・任せるが押せてしまう）。正しい下の欄だけを残す。
    const m = rec.manual
    for (const k of bad) delete rec[k]
    if (bad.includes('manual'))
      rec.manual = isObj(m) ? Object.fromEntries(Object.entries(m).filter(([k, x]) => (k === 'steps' ? strs(x) : ['where', 'command', 'check'].includes(k) && str(x)))) : {}
    if (bad.length) out.push(`${where}のカード ${c.id}「${c.title}」の ${bad.join('・')} の形が違うので、その欄を出さずに表示しています`)
  }
  return out
}

/** 壊れた JSON・形の違うファイル・古い版は例外にし、呼び出し側が前回の表示を保てるようにする。problems には外した欄を足す。 */
export function parseCockpit(text: string, problems: string[] = []): Cockpit {
  const v: unknown = JSON.parse(text)
  if (!isObj(v)) throw new Error('cockpit.json がオブジェクトではありません')
  if (v.version !== VERSION)
    throw new Error(`cockpit.json が古い形（version ${String(v.version ?? 1)}）です。node window/migrate.ts <ワークスペースの root> --write で移し替えてください`)
  if (!isObj(v.workspace) || !Array.isArray(v.cards) || !Array.isArray(v.tasks) || !Array.isArray(v.streams))
    throw new Error('cockpit.json に workspace・streams・tasks・cards がありません')
  for (const t of v.tasks as Record<string, unknown>[]) {
    if (!TASK_STATES.includes(t?.state as TaskState)) throw new Error(`tasks の state が不正です: ${String(t?.id)}`)
    const w = t.worker
    if (w !== undefined && !(isObj(w) && typeof w.task_id === 'string' && typeof w.dispatch_id === 'string'))
      throw new Error(`tasks の worker の形が不正です（{ task_id, dispatch_id }。workerctl の頃の { worktree_id, terminal } は書き換える）: ${String(t.id)}`)
    const bad = ['next', 'waiting_on', 'waiting_since'].filter((k) => t[k] != null && !str(t[k]))
    for (const k of bad) delete t[k]
    if (bad.length) problems.push(`cockpit.json のタスク ${String(t.id)} の ${bad.join('・')} の形が違うので、その欄を出さずに表示しています`)
  }
  // 列挙値は画面で class 名や印に使うので、知らない値は読み込みの時点で断る。
  for (const c of v.cards as Record<string, unknown>[]) {
    if (typeof c?.id !== 'string' || typeof c.title !== 'string' || typeof c.rev !== 'number') throw new Error(`cards の id・title・rev が不正です: ${String(c?.id)}`)
    if (!KINDS.includes(c.kind as CardKind)) throw new Error(`cards の kind が不正です: ${c.id}`)
    if (c.state !== 'open' && c.state !== 'waiting' && c.state !== 'done') throw new Error(`cards の state が不正です: ${c.id}`)
  }
  for (const key of ['owners', 'routes', 'requests'] as const)
    if (v[key] !== undefined && (!Array.isArray(v[key]) || (v[key] as unknown[]).some((x) => !isObj(x) || typeof x.id !== 'string')))
      throw new Error(`cockpit.json の ${key} の形が不正です`)
  problems.push(...dropBadFields(v.cards as Card[], 'cockpit.json '))
  return v as unknown as Cockpit
}

export function parseUserLog(text: string): UserLog {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !Array.isArray(v.ops)) throw new Error('cockpit.user.json に ops がありません')
  return v as unknown as UserLog
}

export function parseArchive(text: string, problems: string[] = []): Archive {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !Array.isArray(v.cards)) throw new Error('cockpit.archive.json に cards がありません（古い形なら migrate.ts で移し替えてください）')
  // 片付いたの列も同じ描画を通るので、id・題・種類が読めないカードは外し、欄の形も確かめる。
  const cards = (v.cards as Record<string, unknown>[]).filter((c) => isObj(c) && str(c.id) && str(c.title) && KINDS.includes(c.kind as CardKind))
  if (cards.length < v.cards.length) problems.push(`cockpit.archive.json の id・title・kind が読めないカード ${v.cards.length - cards.length} 枚を出していません`)
  problems.push(...dropBadFields(cards as unknown as Card[], 'cockpit.archive.json '))
  return { cards: cards as unknown as Card[] }
}

export function nextOp(log: UserLog, op: Omit<Op, 'op_id'>): Op {
  const last = log.ops.reduce((n, o) => Math.max(n, o.op_id), 0)
  return { op_id: last + 1, ...op }
}

/**
 * カードの今。
 * - mine: 私の番（件数に数える種類なら数える）
 * - talking: 担当と話している（件数から外す。担当がカードを書き換えて rev が上がると mine に戻る）
 * - waiting: 送ったあと顧客の返事を待っている
 * - closed: 済み。pending は担当がまだ受け取っていない（受け取り待ち）
 */
export type Status = 'mine' | 'talking' | 'waiting' | 'closed'
export type CardView = {
  card: Card
  status: Status
  /** 利用者の操作を担当がまだ受け取っていない。 */
  pending: boolean
  /** 取り消せる操作（10 秒の間と、担当が受け取る前）。 */
  undoOp?: Op
  /** 済んだ理由（「決めた: …」）。 */
  how?: string
  when?: string
  chosen?: Option
  /** 見ての「直してほしいことを書く」で頼んだ直し（本文つきの talk の操作の text）。 */
  fix?: string
}

const CLOSING: OpType[] = ['decide', 'accept', 'sent', 'skip', 'delegate', 'ack']

function closedLabel(c: Card, type: OpType | undefined, option?: Option, text?: string): string {
  if (type === 'decide' && option?.id === OTHER) return `別の答え: ${text ?? ''}`
  if (type === 'decide' || (!type && option)) return `${c.kind === 'permit' ? '許した' : '決めた'}: ${option?.label ?? text ?? '?'}`
  if (type === 'accept') return c.kind === 'permit' ? '許した' : 'これでよい'
  if (type === 'sent') return c.kind === 'send' ? '送った' : '済ませた'
  if (type === 'skip') return c.kind === 'send' ? '送らない' : c.kind === 'inbox' ? '返事は要らない' : c.kind === 'permit' ? '止めた' : '見送った'
  if (type === 'delegate') return '許して、以後は任せた'
  if (type === 'ack') return '読んだ'
  return '担当が片付けた'
}

/** cockpit.json の状態に、操作ログのうち効いている操作を重ねる。 */
export function overlay(c: Cockpit, log: UserLog, archive: Card[] = []): CardView[] {
  const applied = new Set(c.applied_ops ?? [])
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  const byCard = new Map<string, Op[]>()
  for (const o of log.ops) byCard.set(o.item_id, [...(byCard.get(o.item_id) ?? []), o])
  const out: CardView[] = []
  for (const card of c.cards) {
    const ops = (byCard.get(card.id) ?? []).filter((o) => !undone.has(o.op_id) && o.type !== 'undo')
    const option = (id?: string) => (id === OTHER ? { id: OTHER, label: '別の答え' } : card.options?.find((x) => x.id === id))
    // 重ねるのは今の版に押した未反映の操作だけ。反映後と、担当が書き換えた後は cockpit.json を正にする。
    const act = ops.filter((o) => CLOSING.includes(o.type) && o.item_rev === card.rev && !applied.has(o.op_id)).at(-1)
    if (act && card.state === 'open') {
      const chosen = option(act.option_id)
      out.push({ card, status: 'closed', pending: true, undoOp: act, how: closedLabel(card, act.type, chosen, act.text), when: act.at, chosen })
      continue
    }
    if (card.state === 'done') {
      const chosen = option(card.resolved_option)
      const how = card.resolved_by === 'user' ? closedLabel(card, undefined, chosen, card.resolved_text) || '済んだ' : closedLabel(card, undefined)
      out.push({ card, status: 'closed', pending: false, how: card.resolved_option === OTHER ? `別の答え: ${card.resolved_text ?? ''}` : how, when: card.resolved_at, chosen })
      continue
    }
    if (card.state === 'waiting') {
      out.push({ card, status: 'waiting', pending: false, when: card.awaiting?.since })
      continue
    }
    const talk = ops.filter((o) => o.type === 'talk' && o.item_rev === card.rev).at(-1)
    if (card.kind === 'talk' || talk)
      out.push({ card, status: 'talking', pending: !!talk && !applied.has(talk.op_id), undoOp: talk && !applied.has(talk.op_id) ? talk : undefined, when: talk?.at ?? card.last?.at, fix: talk?.text })
    else out.push({ card, status: 'mine', pending: false })
  }
  for (const card of archive) {
    const chosen = card.options?.find((x) => x.id === card.resolved_option)
    out.push({ card, status: 'closed', pending: false, how: closedLabel(card, undefined, chosen, card.resolved_text), when: card.resolved_at, chosen })
  }
  return out
}

/** メインにまだ反映されていない操作。 */
export function unappliedOps(c: Cockpit | undefined, log: UserLog): Op[] {
  const applied = new Set(c?.applied_ops ?? [])
  return log.ops.filter((o) => !applied.has(o.op_id))
}

const SEV: Record<TaskState, number> = { stop: 0, run: 1, wait: 2, idle: 3, ok: 4 }
export function worstState(states: TaskState[]): TaskState | undefined {
  return [...states].sort((a, b) => SEV[a] - SEV[b])[0]
}

export type ShownWhy = 'ok' | 'record' | 'working' | 'intake' | 'stopped' | 'missing'
export type TaskShown = { state: TaskState; why: ShownWhy; stop?: string }

/**
 * 画面に出すタスクの状態。worker の記録があるタスクは、メインの書いた state ではなく Orca の Dispatch の様子から決める
 * （メインが書き忘れると「worker が作業中なのに動いていない」のような矛盾が出たため、2026-11-16）。
 * fact は undefined なら Orca を読んでいない（パネル）、null なら Orca に無い。
 * - state が ok なら完了、wait（外の相手を待つ）はメインの書いた state のまま
 * - worker_done を返していれば、メインの取り込み待ち
 * - 起動できない・落ちた・端末が消えた・人の確認待ちなら、止まっている
 * - それ以外は進行中（担当が利用者と話している間や worker を待つ間も、Dispatch は開いたまま）
 */
export function shownTask(t: Task, fact: DispatchFact | null | undefined): TaskShown {
  if (t.state === 'ok') return { state: 'ok', why: 'ok' }
  if (!t.worker || fact === undefined || t.state === 'wait') return { state: t.state, why: 'record' }
  if (fact === null) return { state: 'stop', why: 'missing' }
  if (fact.state === 'succeeded') return { state: 'wait', why: 'intake' }
  if (fact.state === 'failed' || fact.liveness === 'exited') return { state: 'stop', why: 'stopped', stop: fact.liveness === 'exited' ? 'dead' : 'error' }
  if (fact.waiting) return { state: 'stop', why: 'stopped', stop: 'blocked' }
  return { state: 'run', why: 'working' }
}
