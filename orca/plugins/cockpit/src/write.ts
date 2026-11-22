// 帳簿（cockpit.json）を書く道具の中身。窓口は Write・Edit で cockpit.json を書かず、この検査を通した変更だけを書く（R47-1）。
// ファイルに触らない純粋な関数で、CLI（window/write.ts）が読み書きとロックを受け持つ。
import {
  ASK_ID, badFields, CARD_SHAPE, returnId, cardHeadError, DRAFT_FORMATS, draftRoute, FORMAT_LABEL, FORMS, INTAKE_SHAPE, missingFields, REQUEST_SHAPE, RUN_ID, STATUS_MAX, TASK_SHAPE, TASK_STATES, timeOf, unmappedElements, upgradeCard, WATCH_SHAPE, WORKER_SHAPE,
  type AskRecord, type Card, type Cockpit, type DraftCheck, type DraftFormat, type Intake, type Op, type Owner, type Request, type Stream, type StreamForm, type Task, type TaskState, type UserLog, type Utterance
} from './model.ts'
import type { DeferCheck, DeferItem } from './defer.ts'
import { workspaceNameCheck } from './state.ts'

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
  /** 窓口の Run だけを置き換える。main のほかの欄（agent・terminal）は今の値を保つ。Run は消せない（書いた結果に Run が要る）。 */
  main?: { run_id: string | null }
  /** 窓からの質問の返しを反映した印（質問 id ごとの追加と置き換え。cockpit skill の「窓から質問する」）。 */
  asks?: AskRecord[]
  /** 案件の名前だけを置き換える（「顧客｜案件」の形のものだけ。R165）。milestones は今の値を保つ。 */
  workspace?: { name: string }
}
const KEYS = ['cards', 'tasks', 'requests', 'streams', 'owners', 'intake', 'applied_ops', 'main', 'asks', 'workspace']

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
const TASK_KEYS: Keys = { top: ['id', 'title', 'phase', 'state', 'worker', ...Object.keys(TASK_SHAPE)], nested: { worker: ['task_id', 'run_id', 'dispatch_id'], done: ['text', 'at'] } }
const REQUEST_KEYS: Keys = {
  top: ['id', 'deliverables', ...Object.keys(REQUEST_SHAPE)],
  nested: { utterances: ['id', 'quote'], evidence: ['when', 'kind', 'ref', 'card', 'rev'], source: ['session', 'at', 'quote'] }
}
const STREAM_KEYS: Keys = { top: ['id', 'title', 'summary', 'status', 'sources', 'form', 'watch'], nested: { watch: ['automation', 'targets', 'to'] } }
const OWNER_KEYS: Keys = { top: ['id', 'title', 'stream', 'agent', 'session', 'terminal', 'state'], nested: {} }
const INTAKE_KEYS: Keys = { top: ['through', 'none', 'checked_through'], nested: {} }
const ASK_KEYS: Keys = { top: ['id', 'card', 'task', 'memo', 'from_returns', 'held_returns', 'notify'], nested: { notify: ['return_id', 'task', 'message_id'] } }

/** asks[] の 1 行の形の誤り。返しの id はその質問のもの（ask3-1）だけを受ける（compaction-keep.py の照合で別の質問の返しと取り違えないため）。 */
function askErrors(a: Record<string, unknown>): string[] {
  const id = String(a.id)
  const own = (v: unknown) => typeof v === 'string' && returnId(v) && v.slice(0, v.lastIndexOf('-')) === id
  const errs: string[] = []
  if (!ASK_ID.test(id)) errs.push('id は ask<数>')
  for (const k of ['card', 'task', 'memo'] as const) if (a[k] !== undefined && (typeof a[k] !== 'string' || !a[k])) errs.push(`${k} は文字列`)
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
const TASK_PROSE: Keys = { top: ['title', 'goal', 'status', 'next', 'done'], nested: { done: ['text'] } }
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

/** 待ちの状態。先送りの言い回しはこの状態のタスクの文だけを見る（R193）。 */
const WAITING = new Set(['idle', 'wait'])
/** 待ちの理由を書く欄。先送りの検査はこの欄を見る。 */
const DEFER_FIELDS = ['waiting_on', 'next', 'status'] as const
/**
 * 日付・期間だけの waiting_on（何を待つかが無い）。日まで決まった日付も、出来事が無ければ同じく断る。
 * 全角の数字と、数字と単位のあいだの空白（「１２月」「12 月」）を均してから当てる。
 */
const DATE_ONLY = /^(?:(?:\d{4}[-/年])?\d{1,2}(?:月(?:\d{1,2}日)?|[-/]\d{1,2}日?)|\d{4}[-/年]\d{1,2}月?|今週末|来週末|週末|来週|再来週|来月|再来月|月末|月初|週明け|年明け|年末)(?:上旬|中旬|下旬|ごろ|頃|以降|まで|中|の?うち)?$/
const dateOnly = (s: string) => DATE_ONLY.test(s.normalize('NFKC').replace(/\s+/g, ''))
/** waiting_on が指すタスクの id。 */
const TASK_REF = /\bt\d+\b/g

/**
 * 先送りの検査（defer-guard.py）にかける文: 変更のうち、待ちの状態（idle・wait）のタスクの waiting_on・next・status。
 * 元の行にそのままある文も含める（どれを断るかは applyChange が元の行と比べて決める）。
 */
export function deferToCheck(change: unknown): DeferItem[] {
  const tasks = isObj(change) && Array.isArray(change.tasks) ? change.tasks : []
  const last = new Map(tasks.filter((x: unknown) => isObj(x) && typeof x.id === 'string').map((x: Record<string, unknown>) => [x.id as string, x]))
  return [...last.values()].filter((t) => WAITING.has(t.state as string)).flatMap((t) =>
    DEFER_FIELDS.flatMap((f) => (typeof t[f] === 'string' && (t[f] as string).trim() ? [{ key: `${t.id as string}.${f}`, text: t[f] as string }] : [])))
}

/**
 * 待ちの書き方の断り（R193）。元の行と同じ値で、待ちの状態も前から続くものは見ない（書く道具を通らずに残った古い行は state.ts の checks が拾う）。
 * defer は defer-guard.py の結果（key は id.欄）。無いか error なら、検査できなかったとして断る（fail closed）。
 */
function waitErrors(t: Task, old: Task | undefined, tasks: Task[], defer: Record<string, DeferCheck>): string[] {
  const out: string[] = []
  const wasWaiting = !!old && WAITING.has(old.state)
  const fresh = (f: (typeof DEFER_FIELDS)[number]) => !(wasWaiting && (old![f] ?? '') === (t[f] ?? ''))
  const why = typeof t.waiting_on === 'string' ? t.waiting_on.trim() : ''
  // idle に変えたときは、前の待ち（wait）の waiting_on をそのまま持ち越しても見る（Codex 48 必須 1）。
  if (t.state === 'idle' && (old?.state !== 'idle' || fresh('waiting_on'))) {
    if (!why) out.push(`タスク ${t.id}: idle は空き枠が無いあいだの順番待ちだけ。waiting_on に「空き枠」か、先に進める進行中のタスクと理由を書く。今やれるなら run にして出す（R193、schema.md の tasks[].state）`)
    for (const id of new Set(why.match(TASK_REF) ?? [])) {
      const ahead = tasks.find((x) => x.id === id)
      if (!ahead || (ahead.state !== 'run' && ahead.state !== 'stop'))
        out.push(`タスク ${t.id}: 順番待ちの先 ${id} が${ahead ? ` ${ahead.state} で` : '無く、'}動いていない。先のタスクが済んだ・止めたなら、このタスクを run にして出す（R193）`)
    }
  }
  if (why && dateOnly(why) && (old?.waiting_on ?? '') !== (t.waiting_on ?? ''))
    out.push(`タスク ${t.id}.waiting_on: 日付・期間だけ（「${why}」）では何を待つかが分からない。待つ出来事を書き、日付で確かめるなら check_on と next に書く（R193）`)
  if (WAITING.has(t.state))
    for (const f of DEFER_FIELDS) {
      if (!(typeof t[f] === 'string' && t[f]!.trim()) || !fresh(f)) continue
      const d = defer[`${t.id}.${f}`]
      if (!d || d.error) out.push(`タスク ${t.id}.${f}: 都合での先送りかを確かめられない（${d?.error ?? '先送りの検査をしていない'}）`)
      else if (d.hit) out.push(`タスク ${t.id}.${f}: 都合での先送り「${d.hit}」。外の理由（人の返事・承認、日付で初めて取れるデータ・出来事、利用枠）を書くか、今進める（R193）`)
    }
  return out
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
 * lint は draftsToLint の文面を書式の検査にかけた結果（カード id ごと）、defer は deferToCheck の文を先送りの検査にかけた結果（id.欄ごと）。
 * 検査は入出力の境界（window/write.ts）が行い、ここは結果だけを見る。
 */
export function applyChange(c: Cockpit, change: unknown, utterances: Utterance[] = [], log: UserLog = { ops: [] }, lint: Record<string, DraftCheck> = {}, defer: Record<string, DeferCheck> = {}): WriteResult {
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
  if (change.main !== undefined && !(isObj(change.main) && Object.keys(change.main).join() === 'run_id' && (change.main.run_id === null || RUN_ID(change.main.run_id))))
    errors.push('main は { run_id } だけを渡す（run_id は run_ で始まる文字列）')
  if (change.workspace !== undefined) {
    if (!(isObj(change.workspace) && Object.keys(change.workspace).join() === 'name')) errors.push('workspace は { name } だけを渡す')
    else {
      const bad = workspaceNameCheck(change.workspace.name)
      if (bad) errors.push(bad.message)
    }
  }
  if (change.intake !== undefined && !INTAKE_SHAPE(change.intake)) errors.push('intake は { through, none, checked_through } の形で渡す（none は発言の id の配列）')
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
    if (s.form !== undefined && !FORMS.includes(s.form as StreamForm)) errors.push(`仕事 ${s.id}: form は ${FORMS.join('・')} のどれか`)
    if (s.form === undefined) warnings.push(`仕事 ${s.id}: form（delegate・cowork・watch）が無い`)
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
  }
  for (const t of ch.tasks ?? []) {
    const old = c.tasks.find((x) => x.id === t.id)
    if (typeof t.title !== 'string' || !t.title.trim() || typeof t.phase !== 'string') errors.push(`タスク ${t.id}: title・phase が無い`)
    if (!TASK_STATES.includes(t.state as TaskState)) errors.push(`タスク ${t.id}: state は ${TASK_STATES.join('・')} のどれか`)
    if (!has(streams, t.stream)) errors.push(`タスク ${t.id}: 仕事 ${t.stream} が無い`)
    const soft = softError(`タスク ${t.id}`, t, old, TASK_PROSE)
    if (soft) errors.push(soft)
    const long = statusError(`タスク ${t.id}`, t.status)
    if (long) errors.push(long)
    errors.push(...waitErrors(t, old, tasks, defer))
    const rec = t as unknown as Record<string, unknown>
    // null は、その行に元から null で書かれていた欄だけ書き戻してよい（読み込みは null の欄を無いものとして読む）。
    const was = old as unknown as Record<string, unknown> | undefined
    const bad = Object.keys(TASK_SHAPE).filter((k) => rec[k] !== undefined && !(rec[k] === null && was?.[k] === null) && !TASK_SHAPE[k]!(rec[k]))
    if (bad.length) errors.push(`タスク ${t.id}: ${bad.join('・')} の形が違う（done は文字列か { text, at } の配列、reviewed_for・sources は文字列の配列、check_on は YYYY-MM-DD の日付、ほかは文字列）`)
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

  if (errors.length) return { errors, warnings }
  const next: Cockpit = {
    ...c, streams, tasks, cards, ...(c.owners || ch.owners ? { owners } : {}), ...(c.requests || ch.requests ? { requests } : {}),
    ...(intake ? { intake } : {}),
    ...(ch.main ? { main: withRun(c.main, ch.main.run_id) } : {}),
    ...(ch.workspace ? { workspace: { ...c.workspace, name: ch.workspace.name } } : {}),
    ...(c.asks || ch.asks ? { asks: upsert(c.asks ?? [], ch.asks ?? []) } : {}),
    applied_ops: [...new Set([...(c.applied_ops ?? []), ...(ch.applied_ops ?? [])])]
  }
  // Run だけの main を消したら、空の main を残さない（main の無い帳簿に戻す）。
  if (next.main && !Object.keys(next.main).length) delete next.main
  // 窓の合図は窓口の Run にだけ送る（R191）。Run の無い帳簿は、窓で押しても窓口に届かない。
  if (!RUN_ID(next.main?.run_id)) return { errors: ['main.run_id が無い。窓口の Run を { "main": { "run_id": "run_…" } } で一緒に書く（窓の合図は窓口の Run にだけ送る）'], warnings }
  // 形の外れた古い名前は、ほかの書き込みを止めずに名指しする（名前は見出しで、合図の届き先と違い、外れても知らせは失われない）。
  // ただし intake を初めて付ける書き込みは版 3 への移し替えに当たるので、migrate-v3 と同じく断る（Codex 43 必須 1）。
  const name = workspaceNameCheck(next.workspace?.name)
  if (name && !c.intake && next.intake) return { errors: [name.message], warnings }
  if (name) warnings.push(name.message)
  return { next, errors, warnings }
}

function withRun(main: Cockpit['main'], run: string | null): NonNullable<Cockpit['main']> {
  const { run_id: _, ...rest } = main ?? {}
  return run === null ? rest : { ...rest, run_id: run }
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
