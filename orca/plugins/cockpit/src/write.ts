// 帳簿（cockpit.json）を書く道具の中身。窓口は Write・Edit で cockpit.json を書かず、この検査を通した変更だけを書く（R47-1）。
// ファイルに触らない純粋な関数で、CLI（window/write.ts）が読み書きとロックを受け持つ。
import {
  badFields, cardHeadError, FORMS, INTAKE_SHAPE, missingFields, REQUEST_SHAPE, TASK_STATES, unmappedElements, upgradeCard, WORKER_SHAPE,
  type Card, type Cockpit, type Intake, type Op, type Owner, type Request, type Stream, type StreamForm, type Task, type TaskState, type UserLog, type Utterance
} from './model.ts'

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
}
const KEYS = ['cards', 'tasks', 'requests', 'streams', 'owners', 'intake', 'applied_ops']

export type WriteResult = { next?: Cockpit; errors: string[]; warnings: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** 片付ける・顧客待ちにする書き換えで動く欄。rev を上げずに書いてよい（上げると「これでよい」の版の照合から外れる）。 */
const CLOSING_FIELDS = new Set(['state', 'resolved_by', 'resolved_at', 'resolved_option', 'resolved_text', 'resolved_at_inferred', 'closed_without_review', 'awaiting', 'why', 'element_map'])
/** 承認を取り込むときに書く要素の行き先。承認した版の中身ではないので、開いたままでも rev を上げずに書ける（上げると承認が外れる）。 */
const INTAKE_FIELDS = new Set(['element_map'])

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
 */
export function applyChange(c: Cockpit, change: unknown, utterances: Utterance[] = [], log: UserLog = { ops: [] }): WriteResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObj(change)) return { errors: ['変更は JSON のオブジェクトで渡す'], warnings }
  const extra = Object.keys(change).filter((k) => !KEYS.includes(k))
  if (extra.length) errors.push(`書けない欄: ${extra.join('・')}（書けるのは ${KEYS.join('・')}）`)
  for (const k of ['cards', 'tasks', 'requests', 'streams', 'owners'])
    if (change[k] !== undefined && (!Array.isArray(change[k]) || (change[k] as unknown[]).some((x) => !isObj(x) || typeof x.id !== 'string' || !x.id)))
      errors.push(`${k} は id のある行の配列で渡す`)
  if (change.applied_ops !== undefined && !(Array.isArray(change.applied_ops) && change.applied_ops.every((n) => Number.isInteger(n) && n > 0)))
    errors.push('applied_ops は op_id（正の整数）の配列で渡す')
  if (change.intake !== undefined && !INTAKE_SHAPE(change.intake)) errors.push('intake は { through, none, checked_through } の形で渡す（none は発言の id の配列）')
  if (errors.length) return { errors, warnings }
  const ch = change as Change

  const streams = upsert(c.streams, ch.streams ?? [])
  const owners = upsert(c.owners ?? [], ch.owners ?? [])
  const tasks = upsert(c.tasks, ch.tasks ?? [])
  const requests = upsert(c.requests ?? [], ch.requests ?? [])
  const cards = upsert(c.cards, ch.cards ?? [])
  const has = <T extends { id: string }>(rows: T[], id: string | undefined) => id === undefined || rows.some((r) => r.id === id)

  for (const s of ch.streams ?? []) {
    if (typeof s.title !== 'string' || !s.title.trim()) errors.push(`仕事 ${s.id}: title が無い`)
    if (s.form !== undefined && !FORMS.includes(s.form as StreamForm)) errors.push(`仕事 ${s.id}: form は ${FORMS.join('・')} のどれか`)
    if (s.form === undefined) warnings.push(`仕事 ${s.id}: form（delegate・cowork・watch）が無い`)
  }
  for (const o of ch.owners ?? []) {
    if (typeof o.title !== 'string' || !o.title.trim()) errors.push(`担当 ${o.id}: title が無い`)
    if (!has(streams, o.stream)) errors.push(`担当 ${o.id}: 仕事 ${o.stream} が無い`)
  }
  for (const t of ch.tasks ?? []) {
    const old = c.tasks.find((x) => x.id === t.id)
    if (typeof t.title !== 'string' || !t.title.trim() || typeof t.phase !== 'string') errors.push(`タスク ${t.id}: title・phase が無い`)
    if (!TASK_STATES.includes(t.state as TaskState)) errors.push(`タスク ${t.id}: state は ${TASK_STATES.join('・')} のどれか`)
    if (!has(streams, t.stream)) errors.push(`タスク ${t.id}: 仕事 ${t.stream} が無い`)
    for (const k of ['next', 'goal', 'waiting_on', 'waiting_since'] as const) if (t[k] !== undefined && typeof t[k] !== 'string') errors.push(`タスク ${t.id}: ${k} は文字列`)
    if (t.reviewed_for !== undefined && !(Array.isArray(t.reviewed_for) && t.reviewed_for.every((x) => typeof x === 'string'))) errors.push(`タスク ${t.id}: reviewed_for は判断の id の配列`)
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
  for (const x of ch.cards ?? []) {
    const head = cardHeadError(x)
    if (head) {
      errors.push(`カード ${x.id}: ${head}`)
      continue
    }
    const card = upgradeCard(x)
    const bad = badFields(card)
    if (bad.length) errors.push(`カード ${card.id}: ${bad.join('・')} の形が違う`)
    if (!has(streams, card.stream)) errors.push(`カード ${card.id}: 仕事 ${card.stream} が無い`)
    for (const t of card.tasks ?? []) if (!has(tasks, t)) errors.push(`カード ${card.id}: タスク ${t} が無い`)
    if (!has(owners, card.owner)) errors.push(`カード ${card.id}: 担当 ${card.owner} が無い`)
    if (!has(requests, card.request_id)) errors.push(`カード ${card.id}: 依頼 ${card.request_id} が無い`)
    for (const e of card.elements ?? []) if (e.n < 1) errors.push(`カード ${card.id}: 要素の番号は 1 から（${e.n}）`)
    for (const m of card.element_map ?? []) {
      if (!card.elements?.some((e) => e.n === m.n)) errors.push(`カード ${card.id}: element_map の ${m.n} に当たる要素が無い`)
      if (m.task !== undefined && !has(tasks, m.task)) errors.push(`カード ${card.id}: 要素 ${m.n} の行き先のタスク ${m.task} が無い`)
      if (m.request !== undefined) {
        const [rid, w] = m.request.split('#')
        const req = requests.find((x) => x.id === rid)
        if (!req) errors.push(`カード ${card.id}: 要素 ${m.n} の行き先の依頼 ${rid} が無い`)
        else if (w !== undefined && !(Number.isInteger(Number(w)) && Number(w) >= 1 && Number(w) <= (req.done_when?.length ?? 0))) errors.push(`カード ${card.id}: 要素 ${m.n} の行き先 ${m.request} に当たる済の条件が無い`)
      }
    }
    const old = c.cards.find((y) => y.id === card.id)
    if (!old && card.rev < 1) errors.push(`カード ${card.id}: rev は 1 から`)
    if (old) {
      const strip = (y: Card) => Object.fromEntries(Object.entries(y).filter(([k]) => k !== 'rev' && !CLOSING_FIELDS.has(k)))
      // 開いたままなら全部の欄、片付ける・顧客待ちにするなら片付けで動く欄の外が「中身」。
      const body = (y: Card) => Object.fromEntries(Object.entries(y).filter(([k]) => k !== 'rev' && !INTAKE_FIELDS.has(k)))
      const changed = card.state === 'open' ? !same(body(old), body(card)) : !same(strip(old), strip(card))
      if (card.rev < old.rev) errors.push(`カード ${card.id}: rev を下げない（今 ${old.rev}）`)
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
    applied_ops: [...new Set([...(c.applied_ops ?? []), ...(ch.applied_ops ?? [])])]
  }
  return { next, errors, warnings }
}

export type SortRow = { id: string; title: string; tasks: string; last?: string }
export type MigrateV3 = { next: Cockpit; summary: string[]; /** 窓口が仕分ける古い依頼（済と照合できなかったもの）。 */ sort: SortRow[] }

/** 片付けた・済ませた・返事を決めた・話した・直しを頼んだ、の深田さんの操作。見てがこれ無しで閉じていたら「確認なしで閉じた」。 */
const USER_TOUCH = new Set(['decide', 'accept', 'sent', 'skip', 'delegate', 'talk', 'ack'])
/** 依頼を済と照合できる深田さんの返答。 */
const ANSWER = new Set(['decide', 'accept', 'sent', 'delegate'])

/**
 * 版 2 の帳簿を版 3 の形に移す（migrate-v3）。runOf は Dispatch → Run（Orca の worker-show で引いたもの）。
 * - 開いた talk を consult に、at の無いカードに created_at を写す（読み込みと同じ upgradeCard）
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
  const talk = c.cards.filter((x) => x.kind === 'talk' && x.state !== 'done').map((x) => x.id)
  const noAt = c.cards.filter((x) => !x.at && x.created_at).map((x) => x.id)
  for (const x of c.cards) upgradeCard(x)
  summary.push(`開いた話し中 → 相談: ${talk.join('・') || 'なし'}`, `at を created_at から補った: ${noAt.join('・') || 'なし'}`)

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
    const last = [...ts.flatMap((t) => (t.done ?? []).map((d) => (typeof d === 'string' ? undefined : d.at))), ...cards.map((x) => x.resolved_at ?? x.at)]
      .filter((x): x is string => !!x).sort().at(-1)
    sort.push({ id: r.id, title: r.title, tasks: ts.map((t) => `${t.id} ${t.state}`).join('・') || 'タスクなし', last })
  }
  summary.push(`依頼 ${(c.requests ?? []).length} 件に legacy を付けた。タスクとカードが全部済で深田さんの返答が残るので済にした: ${closedNow.join('・') || 'なし'}。窓口が仕分ける: ${sort.length} 件`)

  const ids = utterances.map((u) => u.id).filter((x): x is string => !!x)
  c.intake = { through: ids.at(-1) ?? '', none: [] }
  summary.push(ids.length ? `仕分けの位置: ${ids.at(-1)}（それまでの発言は仕分け済みとする）` : '発言の記録に id が無いので、仕分けの位置は空（id の付いた発言から検査する）')

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
