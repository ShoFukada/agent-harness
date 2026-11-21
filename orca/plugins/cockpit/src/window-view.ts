// 窓（常駐のプロセスが出すページ）の 3 タブ: 要対応・全体・対応済み。パネルは view.ts の render のまま。
import { COUNTED, STAGES, stageOf, FORMS, FORM_LABEL, KIND_LABEL, doneText, isSynthetic, sentOps, timeOf, type Card, type Sent, type StreamForm, type TaskState } from './model.ts'
import { STOP_LABEL, byUrgency, fmtDate, isHot, nearDate, routeProblem, upcomingMilestones, type JobState, type JobView, type Row, type TaskView } from './state.ts'
import {
  actsHtml, backgroundParts, dueHtml, esc, fld, isSoft, keyOf, linkBtn, manualHtml, mono, optionsHtml, otherHtml, ownerHtml, rich, softHtml, stripHtml, toastsHtml,
  type Board, type Model, type Theme, type Ui, type VRow
} from './view.ts'

type Svg = (raw: string) => string
export type Tab = NonNullable<Ui['tab']>

/** 窓が描く案件。前面の案件、無ければ最初の案件（操縦席はハーネスだけ。R39）。 */
export const boardOf = (m: Model): Board | undefined => m.boards.find((b) => b.root === m.focused) ?? m.boards[0]

const vrows = (b: Board, rows: Row[]): VRow[] => rows.map((r) => ({ ...r, v: b.v }))

/** 要対応の行（届いたは全体の「見張る」に出す）と、直しを頼んだ・直し待ちの行。仕事ごとにまとめ、仕事は期限の近い順。 */
export function todoGroups(b: Board): [string, VRow[]][] {
  const rows = vrows(b, [...b.d.queue.filter((r) => r.card.kind !== 'inbox'), ...b.d.fixing]).sort(byUrgency)
  const m = new Map<string, VRow[]>()
  // Orca から作った詰まり（仕事に結べないエージェントの停止）は、一番急ぐので仕事の外の先頭にまとめる。
  const key = (r: VRow) => r.card.stream ?? (isSynthetic(r.card.id) ? ORCA : '')
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r])
  const rank = (k: string) => (k === ORCA ? 0 : k ? 1 : 2)
  return [...m.entries()].sort((a, b2) => rank(a[0]) - rank(b2[0]) || byUrgency(a[1][0]!, b2[1][0]!))
}
const ORCA = '#orca'
/** j・k と「次へ」で進む順（画面の上から）。 */
export const todoOrder = (b: Board | undefined): string[] => (b ? todoGroups(b).flatMap(([, xs]) => xs.map(keyOf)) : [])

function closedGroups(b: Board): [string, VRow[]][] {
  const m = new Map<string, VRow[]>()
  for (const r of vrows(b, b.d.closed)) m.set(r.card.stream ?? '', [...(m.get(r.card.stream ?? '') ?? []), r])
  return [...m.entries()].sort((a, b2) => timeOf(b2[1][0]!.when) - timeOf(a[1][0]!.when))
}
export const doneOrder = (b: Board | undefined): string[] => (b ? closedGroups(b).flatMap(([, xs]) => xs.map(keyOf)) : [])

/** 種類は語だけで示す（記号を並べない。R101）。 */
const kindName = (c: Card) => (c.manual ? '手作業' : KIND_LABEL[c.kind])
const tag = (text: string, cls = '') => `<span class="tag${cls ? ` ${cls}` : ''}">${esc(text)}</span>`

/** 行の札。手作業・話し中・直しを頼んだ・直し待ち・件数外（相談）。 */
function tags(r: Row): string {
  return [
    r.card.kind === 'consult' && tag('件数外'),
    r.talking && tag('協議中', 'talk'),
    r.status === 'fixing' && (r.pending ? tag('修正依頼済み（受領待ち）', 'wait') : tag('修正待ち', 'wait'))
  ].filter(Boolean).join('')
}

const taskOf = (b: Board, r: Row): TaskView | undefined => b.d.tasks.get(r.card.tasks?.[0] ?? '')

function cardRow(b: Board, r: VRow, cur: string | undefined, now: number, closed = false): string {
  const c = r.card
  const t = taskOf(b, r)
  const right = closed
    ? `<span>${esc(r.how ?? '')}</span><span class="mut">${esc(nearDate(r.when, now))}${c.resolved_at_inferred ? '（推定）' : ''}</span>${c.closed_without_review ? tag('確認なしで閉じた', 'miss') : r.pending ? tag('受け取り待ち', 'wait') : ''}`
    : c.due ? `<span class="${isHot(c.due, now) ? 'hot' : ''}">${esc(nearDate(c.due, now))}</span>` : ''
  return `<button type="button" class="cardrow k-${c.kind}${closed ? ' cl' : ''}" data-${closed ? 'dsel' : 'sel'}="${esc(keyOf(r))}" aria-current="${cur === keyOf(r)}">
    <span class="kd">${kindName(c)}<small>${esc(c.id.startsWith('#') ? 'Orca' : c.id)}</small></span>
    <span class="tt"><span class="tl"><span class="ti">${esc(c.title)}</span>${tags(r)}</span>${t ? `<span class="crumb">${esc(`${t.task.id} ${t.task.title}`)}</span>` : ''}</span>
    <span class="du${closed ? ' cl' : ''}">${right}</span></button>`
}

const FORM_ORDER = FORMS
const FORM_DESC: Record<StreamForm, string> = { cowork: '話しながら進めているもの', delegate: '任せている作業の進み具合', watch: '届いたもの' }
const formChip = (f: StreamForm | undefined) => (f ? `<span class="fm f-${f}">${esc(FORM_LABEL[f])}</span>` : '')

/** 仕事の見出し。件数はタブの要対応と同じ数え方（相談・報告は別に書く）にし、進み具合は右にそろえる。 */
function groupHead(b: Board, sid: string, xs: VRow[], closed = false): string {
  const s = b.v.cockpit!.streams.find((x) => x.id === sid)
  // 修正待ち（fixing）はタブの要対応に数えないので、見出しでも要対応に入れない。
  const counted = xs.filter((r) => r.status === 'mine' && COUNTED.includes(r.card.kind)).length
  const consult = xs.filter((r) => r.status === 'mine' && r.card.kind === 'consult').length
  const n = closed ? `対応済み ${xs.length} 件` : [counted && `要対応 ${counted}`, consult && `相談 ${consult}`, xs.length - counted - consult && `修正待ち ${xs.length - counted - consult}`].filter(Boolean).join('・')
  if (sid === ORCA) return `<div class="gh"><b>停止中のエージェント</b><span class="mut">${n}・Orca より</span></div>`
  if (!s) return `<div class="gh"><b>仕事の割り当てなし</b><span class="mut">${n}</span></div>`
  const ts = tasksOf(b, sid)
  const j = b.d.jobs.find((x) => x.id === sid)
  return `<div class="gh f-${s.form ?? 'none'}">${formChip(s.form)}<b>${esc(s.title)}</b><span class="mut">${n}</span>${j?.owner ? `<span class="mut">担当: ${esc(j.owner.title)}</span>` : ''}<span class="prog">${phaseBar(ts, s.form, j?.state)}</span></div>`
}

/** 帳簿の抜け（窓口が 30 分のうちに直さなかったもの）。R47。 */
function gapsHtml(b: Board): string {
  const gs = b.d.gaps
  if (!gs.length) return ''
  const what = { card: 'カード', request: '依頼', utterance: '発言' } as const
  return `<div class="gaps" role="status"><b>帳簿の未記入 ${gs.length} 件</b><span class="mut">30 分超過</span>
    <ul>${gs.map((g) => `<li>${esc(what[g.kind])} <span class="code">${esc(g.id)}</span> ${esc(g.title)}<span class="mut">（欠け: ${esc(g.missing.join('・'))}）</span></li>`).join('')}</ul></div>`
}

function viewTodo(b: Board, ui: Ui, now: number, svg: Svg): string {
  const groups = todoGroups(b)
  const reps = vrows(b, b.d.reports)
  const list = groups.length
    ? groups.map(([sid, xs]) => `<section class="sgrp">${groupHead(b, sid, xs)}<div class="rows">${xs.map((r) => cardRow(b, r, ui.sel, now)).join('')}</div></section>`).join('')
    : '<div class="calm"><b>要対応 0 件</b></div>'
  const rd = reps.length ? `<section class="sgrp readonly"><div class="subh">報告（参照のみ）${reps.length} 件・件数外</div><div class="rows">${reps.map((r) => cardRow(b, r, ui.sel, now)).join('')}</div></section>` : ''
  const order = todoOrder(b)
  const all = [...groups.flatMap(([, xs]) => xs), ...reps]
  const cur = all.find((r) => keyOf(r) === ui.sel)
  const next = cur ? order[order.indexOf(keyOf(cur)) + 1] : undefined
  return `<div class="wpane" aria-label="要対応">${gapsHtml(b)}${list}${rd}</div><aside class="wside" aria-label="詳細">${cur ? detail(b, cur, ui, now, svg, next) : ''}</aside>`
}

/** 種類ごとの「最初に見える部分」。決めるのに要るものだけを出し、残りは「詳しく」に畳む。 */
function firstView(r: VRow, ui: Ui, now: number): string {
  const c = r.card
  const list = (xs: string[] | undefined, ordered = false) => (xs?.length ? `<${ordered ? 'ol' : 'ul'} class="rich">${xs.map((x) => `<li>${mono(esc(x))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : '')
  if (c.manual) return manualHtml(r)
  // 承認を求める要素（9.2）。これでよいは、この全部の要素への承認として受け取られる。
  const elements = c.elements?.length ? fld('承認する要素', `<ol class="rich">${c.elements.map((e) => `<li value="${e.n}">${mono(esc(e.text))}</li>`).join('')}</ol>`) : ''
  return elements + firstOfKind(r, ui, list)
}

/**
 * 見てほしい点。「1 …」と番号を書いた項目は番号付きの一覧にし（印と番号を二重にしない）、番号の無い項目（返し方の説明など）は一覧の下に添える。
 */
function points(xs: string[] | undefined): string {
  if (!xs?.length) return ''
  const NUM = /^\s*(\d+)(?:[\s.．、)）]\s*|(?=[「『（(]))/
  if (Number(NUM.exec(xs[0]!)?.[1]) !== 1) return `<ol class="rich">${xs.map((x) => `<li>${mono(esc(x))}</li>`).join('')}</ol>`
  // 番号は 1 から順に続くものだけを番号と読む（「6 点ともおすすめなら」のような文の頭の数字を拾わない）。
  let next = 1
  const isNum = xs.map((x) => Number(NUM.exec(x)?.[1]) === next && ++next > 0)
  const num = xs.filter((_, i) => isNum[i])
  const rest = xs.filter((_, i) => !isNum[i])
  return `<ol class="rich">${num.map((x) => `<li value="${NUM.exec(x)![1]}">${mono(esc(x.replace(NUM, '')))}</li>`).join('')}</ol>${rest.map((x) => `<p class="mut">${mono(esc(x))}</p>`).join('')}`
}

function firstOfKind(r: VRow, ui: Ui, list: (xs: string[] | undefined, ordered?: boolean) => string): string {
  const c = r.card
  switch (c.kind) {
    case 'review':
      // 頼んだ直しの原文は「出した指示」に出す（二重にしない）。
      return [c.href ? `<div class="links">${linkBtn('成果物を開く', c.href)}</div>` : '', fld('確認事項', points(c.look_for))].join('')
    case 'decide':
      return [optionsHtml(r, ui), fld('得られること', rich(c.context?.gain, c.repo)), fld('失うこと', rich(c.context?.cost, c.repo))].join('')
    case 'permit':
      // 版 2 の許すは対象と影響を判断の材料（context）に書いたものがある。対象は本文の書体にし、` で囲んだ所と SHA・ブランチ名だけ等幅にする（追加 14）。
      return [fld('対象', rich(c.target ?? c.context?.what, c.repo)), fld('何が変わるか', rich(c.effect ?? c.context?.gain, c.repo)), fld('戻し方', esc(c.undo)), optionsHtml(r, ui)].join('')
    case 'send':
      return c.draft ? `<div class="fld"><span class="lb">送る文面</span><div class="msg-to">宛先 <b>${esc(c.draft.to)}</b>${c.draft.via ? `　経路 ${esc(c.draft.via)}` : ''}</div><div class="msg">${esc(c.draft.text)}</div></div>${optionsHtml(r, ui)}` : optionsHtml(r, ui)
    case 'stuck':
      return [fld('停止の理由', c.reason ? `<div class="quote code">${esc(c.reason)}</div>` : ''), c.since ? fld('停止日時', esc(fmtDate(c.since))) : '',
        fld('直し方', esc(c.unblock ?? (c.answerable ? '答えれば進む' : ''))), optionsHtml(r, ui)].join('')
    case 'consult':
      return [fld('論点', esc(c.issue)), fld('担当の今の考え', rich(c.stance, c.repo)), fld('分かっていること', list(c.known)), fld('決めかねていること', list(c.undecided))].join('')
    case 'report':
      return `<ul class="done-list">${(c.done ?? []).map((d, n) =>
        `<li><span>${esc(d.what)}</span>${r.status === 'mine' ? `<button class="btn quiet" type="button" data-act="revert" data-target="${n}" data-key="${esc(keyOf(r))}">戻させる</button>` : ''}${d.why || d.undo ? `<small>${[d.why && `理由: ${d.why}`, d.undo && `戻し方: ${d.undo}`].filter(Boolean).map((x) => esc(x)).join('　')}</small>` : ''}</li>`).join('')}</ul>`
    case 'inbox':
      return [fld('届いた連絡', esc([c.from?.who, c.from?.via, c.from?.at && fmtDate(c.from.at)].filter(Boolean).join('　'))), fld('聞かれていること', esc(c.asked)), fld('振り分け', esc(c.routed))].join('')
    case 'talk':
      return [c.last ? fld('最後のやり取り', `<div class="quote">${esc(c.last.text)}</div>`) : '', fld('次', esc(c.next))].join('')
  }
}

/** 「詳しく」に畳む欄（何のため・なぜ今・判断の材料・依頼の原文・確かめた結果・返事が無いとき・いきさつと出典）。 */
function moreView(r: VRow, svg: Svg): string {
  const c = r.card
  const ctxKeys = (c.kind === 'decide' ? ['what', 'now', 'how'] : ['what', 'now', 'how', 'gain', 'cost']) as (keyof NonNullable<Card['context']>)[]
  const CTX: Record<string, string> = { what: 'これは何か', now: '今どうなっているか', how: '決めたらどうするか', gain: '得られること', cost: '失うこと' }
  const parts = [
    fld('何のため', esc(c.purpose)),
    fld('なぜ今', c.why ? rich(c.why, c.repo) : ''),
    ...ctxKeys.map((k) => fld(CTX[k]!, rich(c.context?.[k], c.repo))),
    c.kind === 'review' ? fld('依頼の原文', c.request ? `<div class="quote">${esc(c.request)}</div>` : '') : '',
    c.kind === 'review' && c.evidence?.length ? fld('確かめた結果', `<ul class="rich">${c.evidence.map((x) => `<li>${mono(esc(x))}</li>`).join('')}</ul>`) : '',
    fld('返事が無いとき', esc(c.fallback)),
    ...backgroundParts(r, svg, r.v?.figures ?? {})
  ].filter(Boolean)
  const links = [
    ...(c.from?.href ? [{ label: '元の連絡', href: c.from.href }] : []),
    ...(c.draft?.href ? [{ label: '元のスレッド', href: c.draft.href }] : []),
    ...(c.href && c.kind !== 'review' ? [{ label: '開く', href: c.href }] : []),
    ...(c.diff ? [{ label: '差分', href: c.diff }] : []),
    ...(c.links ?? [])
  ]
  if (links.length) parts.push(fld('資料', `<div class="links">${links.map((l) => linkBtn(l.label, l.href)).join('')}</div>`))
  return parts.join('')
}

function detail(b: Board, r: VRow, ui: Ui, now: number, svg: Svg, next?: string, closed = false): string {
  const c = r.card
  const s = r.stream
  const t = taskOf(b, r)
  const crumbs = [b.v.cockpit!.workspace.name, s?.title ?? '仕事の割り当てなし', t && `${t.task.id} ${t.task.title}`].filter(Boolean) as string[]
  const notes = [
    closed ? `<div class="note ok"><b>${esc(r.how ?? '')}</b>　${esc(fmtDate(r.when))}${c.resolved_at_inferred ? '（時刻は推定）' : ''}${r.pending ? '・窓口の受け取り待ち' : c.resolved_by === 'user' ? '・深田さんの回答' : ''}${c.closed_without_review ? '・確認の返答なし' : ''}</div>` : '',
    r.talking ? `<div class="note wait"><b>協議中</b>　${esc(fmtDate(r.talking.since))} から・${esc(r.owner.how === 'main' ? '窓口' : `担当（${r.owner.title}）`)}</div>` : '',
    r.status === 'fixing' ? `<div class="note wait"><b>${r.pending ? '修正依頼済み（受領待ち）' : '修正待ち'}</b></div>` : '',
  ].join('')
  // 対応済みは返した答えが主役。頼んだ中身（手順・選択肢）は「詳しく」に畳む。
  const first = closed ? '' : firstView(r, ui, now)
  const more = (closed ? firstView(r, ui, now) : '') + moreView(r, svg)
  const moreOpen = ui.open['detail-more'] ?? false
  const acts = actsHtml(r, ui, true).replace('</div>', next ? `<button class="btn quiet nx" type="button" data-sel="${esc(next)}">次へ（j）</button></div>` : '</div>')
  const sent = sentHtml(sentOps([c], b.v.log, b.v.cockpit!.applied_ops))
  return `<div class="wdet k-${c.kind}">
    <div class="dh"><div class="crumbs">${crumbs.map((x) => `<span>${esc(x)}</span>`).join('<i>›</i>')}</div>
      <div class="kl"><span class="kd">${kindName(c)}</span><span class="mut">${esc(c.id.startsWith('#') ? 'Orca から' : c.id)}</span>${c.due ? dueHtml(c.due, now) : ''}</div>
      <h2>${esc(c.title)}</h2><div>${ownerHtml(r.owner)}</div></div>
    ${notes}${first ? `<div class="first">${first}</div>` : ''}${sent}
    ${more ? `<details class="more-d" data-fold="detail-more"${moreOpen ? ' open' : ''}><summary>${closed ? '詳細（依頼内容・目的・出典）' : '詳細（目的・判断材料・出典）'}</summary><div class="slots">${more}</div></details>` : ''}
    ${closed ? '' : otherHtml(r, ui)}
    <div class="dbtn">${acts}</div></div>`
}

// ── 全体 ──
const tasksOf = (b: Board, sid: string) => [...b.d.tasks.values()].filter((t) => t.task.stream === sid)
const TSTATE: Record<TaskState, string> = { ok: '完了', run: '作業中', wait: '待機', stop: '停止', idle: '未着手' }
/**
 * 工程の進み（前の窓の「工程 n/5」の形）。済んでいないタスクのうちいちばん前の段を今の段にし、それより前を済んだ段にする。
 * 段に寄せられない工程名の未完了タスクがあれば、段も完了の印も決めない（推測で入れない・先の段まで済んだように見せない）。
 * 「全工程 完了」は仕事そのものが済のときだけ。タスクが全部済でもカードが残る仕事は確認待ちと出す。見張る仕事は段を持たない。
 */
function phaseBar(ts: TaskView[], form?: StreamForm, job?: JobState): string {
  if (form === 'watch') return ''
  if (!ts.length) return '<span class="pbar mut">タスクなし</span>'
  const live = ts.filter((t) => t.state !== 'ok')
  const unsorted = live.some((t) => !stageOf(t.task.phase))
  const at = !live.length ? STAGES.length : unsorted ? -1 : Math.min(...live.map((t) => STAGES.indexOf(stageOf(t.task.phase)!)))
  const name = live.length ? (unsorted ? '工程 未分類あり' : `工程 <span class="num">${at + 1}/${STAGES.length}</span> ${STAGES[at]}`)
    : job === 'done' ? '全工程 完了' : job === 'mine' ? 'タスク完了・確認待ち' : job === 'customer' ? 'タスク完了・顧客待ち' : 'タスク完了'
  // 5 つの印は並べない（語だけで読める。R101）。
  return `<span class="pbar" title="${STAGES.join(' › ')}">${name}</span>`
}

const WHY: Record<TaskView['why'], string> = { ok: '済', record: '', working: '作業中', intake: '完了・取り込み待ち', stopped: '停止', missing: 'Orca に無し' }
/** worker の状態の語。記録のまま（Orca の Dispatch を読めていない）は、窓口が書いたタスクの状態をそのまま出す。 */
const workerState = (t: TaskView) =>
  t.why === 'stopped' && t.stop ? `停止（${STOP_LABEL[t.stop as keyof typeof STOP_LABEL] ?? t.stop}）` : t.why === 'record' ? TSTATE[t.state] : WHY[t.why]

/** 箱の中の順（段の順。どの段にも寄せられない工程名は元の名前のまま後ろ）。済んだタスクは入れない。 */
function stageGroups(ts: TaskView[]): (readonly [string, TaskView[]])[] {
  const live = ts.filter((t) => t.state !== 'ok')
  return [...STAGES.map((st) => [st, live.filter((t) => stageOf(t.task.phase) === st)] as const),
    ...[...new Set(live.map((t) => t.task.phase).filter((p) => !stageOf(p)))].map((p) => [p, live.filter((t) => t.task.phase === p)] as const)]
    .filter(([, xs]) => xs.length)
}

const formOf = (b: Board, sid: string) => b.v.cockpit!.streams.find((s) => s.id === sid)?.form
const looseTasks = (b: Board) => [...b.d.tasks.values()].filter((t) => t.state !== 'ok' && !b.v.cockpit!.streams.some((s) => s.id === t.task.stream))

/** 全体で j・k が進む順と、何も選んでいないときに右に出すタスク（画面の上から）。 */
export function taskOrder(b: Board | undefined): string[] {
  if (!b) return []
  const live = b.d.jobs.filter((j) => j.state !== 'done')
  const jobs = [...FORM_ORDER.flatMap((f) => live.filter((j) => formOf(b, j.id) === f)), ...live.filter((j) => !formOf(b, j.id))]
  return [...jobs.flatMap((j) => stageGroups(tasksOf(b, j.id)).flatMap(([, xs]) => xs)), ...looseTasks(b)].map((t) => t.task.id)
}

function taskRow(t: TaskView, todo: Map<string, VRow[]>, talkLabel: string, cur: string | undefined): string {
  const chips = (todo.get(t.task.id) ?? []).map((r) => `<button type="button" class="chip kc k-${r.card.kind}" data-jump="${esc(keyOf(r))}" title="要対応で開く">${kindName(r.card)} ${esc(r.card.id)}</button>`).join('')
  const sub = t.task.waiting_on ? `待ち: ${t.task.waiting_on}` : t.task.next ? `次: ${t.task.next}` : ''
  return `<div class="task" aria-current="${cur === t.task.id}"><button type="button" class="tsel" data-task="${esc(t.task.id)}"><span class="tst s-${t.state}">${TSTATE[t.state]}</span>
    <span class="tn"><span><span class="id">${esc(t.task.id)}</span>${esc(t.task.title)}</span>${sub ? `<span class="nx">${mono(esc(sub))}</span>` : ''}</span></button>
    <span class="wk">${chips}${t.task.stream ? `<button type="button" class="act talk" data-talkstream="${esc(t.task.stream)}">${talkLabel}</button>` : ''}</span></div>`
}

const PILL: Record<JobState, string> = { mine: '要対応', stopped: '停止中', working: '作業中', customer: '顧客待ち', idle: '未着手', done: '完了' }

function streamBox(b: Board, j: JobView, ui: Ui, todo: Map<string, VRow[]>): string {
  const s = b.v.cockpit!.streams.find((x) => x.id === j.id)
  const ts = tasksOf(b, j.id)
  const done = ts.filter((t) => t.state === 'ok').length
  // 箱は閉じて置き、中（工程・タスク）は開いて取りに行く（R33・R81）。右に詳細を出しているタスクの箱は開いておく。
  const open = ui.open[`s:${j.id}`] ?? ts.some((t) => t.task.id === ui.task)
  const talkLabel = j.owner ? '担当と協議' : '窓口と協議'
  const working = ts.filter((t) => t.why === 'working').length
  const label = j.state === 'mine' ? `要対応 ${j.mine}` : j.state === 'customer' ? j.label : PILL[j.state]
  const inner = open
    ? stageGroups(ts).map(([ph, xs]) => `<div class="phase">${esc(ph)}${stageOf(ph) ? '' : tag('工程の外', 'wait')}</div>${xs.map((t) => taskRow(t, todo, talkLabel, ui.task)).join('')}`).join('')
      + (done ? `<div class="donebox">完了タスク ${done} 件</div>` : '')
    : ''
  return `<div class="st f-${s?.form ?? 'none'}"><div class="sh">
    <button type="button" class="t" data-toggle="s:${esc(j.id)}" aria-expanded="${open}"><span>${esc(j.title)}</span><span class="pill ${j.state}">${esc(label)}</span>${j.owner ? `<span class="tw">担当: ${esc(j.owner.title)}</span>` : ''}</button>
    <span class="right"><span class="prog">${phaseBar(ts, s?.form, j.state)}</span><button type="button" class="act talk" data-talkstream="${esc(j.id)}">${talkLabel}</button></span>
    <span class="meta">${working ? `<span class="chip live">worker ${working} 作業中</span>` : ''}${j.next && !open ? `<span class="mut nxt">次: ${mono(esc(j.next))}</span>` : ''}</span></div>
    ${open ? `<div class="inner">${inner || '<span class="mut">なし</span>'}</div>` : ''}</div>`
}

/** 出した指示（新しい順）。withCard はどのカードへの指示かを頭に出す（タスクの詳細）。 */
function sentHtml(xs: Sent[], withCard = false): string {
  if (!xs.length) return ''
  return `<div class="sent fld"><span class="lb">出した指示</span><ol>${xs.map((s) => `<li><span class="sl"><span class="tm">${esc(fmtDate(s.op.at))}</span>${withCard ? `<span class="code">${esc(s.card.id)}</span>` : ''}<b>${esc(s.label)}</b>${s.applied ? tag('反映済み') : tag('未反映', 'wait')}</span>${s.text ? `<div class="quote">${esc(s.text)}</div>` : ''}</li>`).join('')}</ol></div>`
}

const CARD_STATE = { mine: '要対応', fixing: '修正待ち', waiting: '顧客待ち', closed: '対応済み' } as const

/** 全体の右: 押したタスクの詳細。結ばれたカードは、要対応か対応済みの一覧にあれば押してそのカードへ移る。 */
function taskDetail(b: Board, t: TaskView): string {
  const c = b.v.cockpit!
  const task = t.task
  const s = c.streams.find((x) => x.id === task.stream)
  const st = stageOf(task.phase)
  const a = b.v.workers.find((w) => w.task === task.id)
  const listed = new Set([...todoOrder(b), ...b.d.reports.map(keyOf), ...doneOrder(b)])
  const cards = [...b.d.views.map((v) => ({ ...v, root: b.root })), ...b.d.queue.filter((r) => isSynthetic(r.card.id))].filter((v) => v.card.tasks?.includes(task.id))
  const cardLine = (v: (typeof cards)[number]) => {
    const k = keyOf(v)
    const state = v.status === 'closed' ? v.how ?? CARD_STATE.closed : v.card.kind === 'consult' ? '相談' : v.card.kind === 'report' ? '報告' : CARD_STATE[v.status]
    const inner = `<span class="kd">${kindName(v.card)}</span><span class="code">${esc(v.card.id.startsWith('#') ? 'Orca' : v.card.id)}</span><span class="ti">${esc(v.card.title)}</span><span class="${v.status === 'mine' || v.status === 'fixing' ? 'now' : 'mut'}">${esc(state)}</span>`
    const cls = `lc${v.status === 'closed' || v.status === 'waiting' ? ' cl' : ''}`
    return listed.has(k) ? `<button type="button" class="${cls}" data-jump="${esc(k)}">${inner}</button>` : `<div class="${cls}">${inner}</div>`
  }
  const reqs = b.d.requests.filter((r) => r.req.tasks?.includes(task.id))
  const reqHtml = reqs.map((r) => {
    const quote = r.req.utterances?.map((u) => u.quote).join('\n') || r.req.quote || ''
    return `<div class="rqd"><div><span class="code">${esc(r.req.id)}</span> ${esc(r.req.title)}<span class="rst">${esc(r.state)}</span></div>
      ${quote ? `<div class="quote">${esc(quote)}</div>` : ''}
      ${r.req.done_when?.length ? `<ol class="dw">${r.req.done_when.map((w, i) => `<li class="${r.covered[i] ? 'ok' : ''}"><span>${r.covered[i] ? '済' : '未'}</span>${esc(w)}</li>`).join('')}</ol>` : ''}</div>`
  }).join('')
  const worker = task.worker
    ? `<div class="wk2"><b>${esc(a?.title ?? task.title)}</b><span class="chip${t.why === 'working' ? ' live' : t.why === 'stopped' || t.why === 'missing' ? ' bad' : ''}">${esc(workerState(t))}</span>${a?.where ? `<span class="mut">今: ${esc(a.where)}</span>` : ''}${a ? `<button type="button" class="act" data-term="${esc(a.terminalId ?? '')}" data-wt="${esc(a.worktree ?? '')}">${a.chat ? 'チャットを開く' : '端末を開く'}</button>` : ''}</div>`
    : ''
  const fields = [
    fld('工程', esc(`${st ? `${STAGES.indexOf(st) + 1}/${STAGES.length} ${st}` : '工程の外'}${task.phase !== st ? `（${task.phase}）` : ''}`)),
    fld('状態', esc([TSTATE[t.state], task.waiting_on && `待ち: ${task.waiting_on}`].filter(Boolean).join('・'))),
    fld('何のため', esc(task.goal)),
    fld('次にやること', task.next ? mono(esc(task.next)) : ''),
    task.done?.length ? fld('済んだこと', `<ul class="rich">${task.done.map((d) => `<li>${mono(esc(doneText(d)))}</li>`).join('')}</ul>`) : '',
    fld('worker', worker),
    fld('確認依頼', cards.map(cardLine).join('')),
    fld('依頼', reqHtml)
  ].join('')
  const sent = sentHtml(sentOps(cards.map((v) => v.card).filter((x) => !isSynthetic(x.id)), b.v.log, c.applied_ops), true)
  const talk = task.stream ? `<div class="acts"><button class="btn talk" type="button" data-talkstream="${esc(task.stream)}">${b.d.jobs.find((j) => j.id === task.stream)?.owner ? '担当と協議' : '窓口と協議'}</button></div>` : ''
  return `<div class="wdet">
    <div class="dh"><div class="crumbs">${[c.workspace.name, s?.title ?? '仕事の割り当てなし'].map((x) => `<span>${esc(x)}</span>`).join('<i>›</i>')}</div>
      <div class="kl"><span class="code mut">${esc(task.id)}</span></div>
      <h2>${esc(task.title)}</h2></div>
    <div class="first facts">${fields}</div>${sent}
    ${talk ? `<div class="dbtn">${talk}</div>` : ''}</div>`
}

function viewWhole(b: Board, ui: Ui, now: number, svg: Svg): string {
  const c = b.v.cockpit!
  const todo = new Map<string, VRow[]>()
  for (const [, xs] of todoGroups(b)) for (const r of xs) for (const t of r.card.tasks ?? []) todo.set(t, [...(todo.get(t) ?? []), r])
  const form = (j: JobView) => formOf(b, j.id)
  const live = b.d.jobs.filter((j) => j.state !== 'done')
  const done = b.d.jobs.filter((j) => j.state === 'done')
  const inbox = vrows(b, b.d.queue.filter((r) => r.card.kind === 'inbox'))
  const routes = (c.routes ?? []).map((r) => {
    const p = routeProblem(r, now)
    return `<li>${esc(r.label)}${p ? `<span class="hotc">　${esc(p.slice(r.label.length + 2))}</span>` : r.read_at ? `<span class="mut">　${esc(nearDate(r.read_at, now))} に読んだ</span>` : ''}</li>`
  })
  const sec = (f: StreamForm, extra = '') => {
    const xs = live.filter((j) => form(j) === f)
    return `<section class="fsec"><h3>${formChip(f)}<span>${esc(FORM_DESC[f])}</span><span class="mut">${xs.length} 件</span></h3>${xs.map((j) => streamBox(b, j, ui, todo)).join('')}${extra}</section>`
  }
  const watchExtra = `<div class="watch"><div class="subh">見張っている経路</div>${routes.length ? `<ul>${routes.join('')}</ul>` : '<p class="mut">なし</p>'}
    <div class="subh">届いた連絡 ${inbox.length} 件・件数外</div>${inbox.length ? `<div class="strips">${inbox.map((r) => stripHtml(r, ui, now, svg, false)).join('')}</div>` : '<p class="mut">なし</p>'}</div>`
  const noForm = live.filter((j) => !form(j))
  const loose = looseTasks(b)
  // 進行中の仕事のある置き場所を先に、空の置き場所は最後に 1 行でまとめる（見張るは経路と届いた連絡があれば空にしない）。
  const filled = (f: StreamForm) => live.some((j) => form(j) === f) || (f === 'watch' && (routes.length > 0 || inbox.length > 0))
  const empty = FORM_ORDER.filter((f) => !filled(f))
  const ms = upcomingMilestones(c.workspace.milestones, now)[0]
  const main = (ms ? `<p class="mut">次の節目: ${esc(ms.label)}（${esc(fmtDate(ms.date))}）</p>` : '')
    + FORM_ORDER.filter(filled).map((f) => sec(f, f === 'watch' ? watchExtra : '')).join('')
    + (empty.length ? `<p class="mut">進行中の仕事なし: ${empty.map((f) => esc(FORM_LABEL[f])).join('・')}</p>` : '')
    + (noForm.length ? `<section class="fsec"><h3><span class="hotc">形が書かれていない仕事</span><span class="mut">${noForm.length} 件</span></h3>${noForm.map((j) => streamBox(b, j, ui, todo)).join('')}</section>` : '')
    + (loose.length ? `<section class="fsec"><h3><span class="hotc">仕事に結ばれていないタスク</span><span class="mut">${loose.length} 件</span></h3><div class="st"><div class="inner">${loose.map((t) => taskRow(t, todo, '窓口と協議', ui.task)).join('')}</div></div></section>` : '')
    + (done.length ? `<button type="button" class="wmore" data-toggle="done" aria-expanded="${!!ui.open.done}">${ui.open.done ? '完了した仕事を閉じる' : `完了した仕事 ${done.length} 件を表示`}</button>${ui.open.done ? done.map((j) => streamBox(b, j, ui, todo)).join('') : ''}` : '')
  const t = b.d.tasks.get(ui.task ?? '')
  return `<div class="wpane" aria-label="全体">${main}</div><aside class="wside" aria-label="タスクの詳細">${t ? taskDetail(b, t) : ''}</aside>`
}

function viewDone(b: Board, ui: Ui, now: number, svg: Svg): string {
  const groups = closedGroups(b)
  const list = groups.map(([sid, xs]) => `<section class="sgrp">${groupHead(b, sid, xs, true)}<div class="rows">${xs.map((r) => cardRow(b, r, ui.doneSel, now, true)).join('')}</div></section>`).join('')
  const cur = groups.flatMap(([, xs]) => xs).find((r) => keyOf(r) === ui.doneSel)
  return `<div class="wpane" aria-label="対応済み"><p class="mut">直近 14 日・新しい順</p>${list || '<div class="calm"><b>対応済み 0 件</b></div>'}</div>
    <aside class="wside" aria-label="詳細">${cur ? detail(b, cur, ui, now, svg, undefined, true) : ''}</aside>`
}

export function renderWindow(m: Model, ui: Ui, now: number, svg: Svg): string {
  const b = boardOf(m)
  const tab: Tab = ui.tab ?? 'todo'
  const errs = [...m.errors, ...(b?.v.errors ?? []), ...m.unseen.filter((u) => u.why).map((u) => `${u.name}: ${u.why}`)]
  // 欄を外して読めたもの（1 枚のカードの書き間違い）は 1 行に畳み、読めない・繋がらないものだけを赤で出す。
  const soft = errs.filter(isSoft)
  const hard = errs.filter((e) => !soft.includes(e))
  const theme = `<span class="seg" role="group" aria-label="地の色">${(['light', 'dark', 'auto'] as Theme[]).map((t) => `<button type="button" data-theme="${t}" aria-pressed="${ui.theme === t}">${t === 'light' ? '明' : t === 'dark' ? '暗' : '自動'}</button>`).join('')}</span>`
  if (!b) {
    return `<div class="ck win" data-theme="${ui.dark ? 'dark' : 'light'}"><div class="wtop"><span class="pj">操縦席</span><div class="flags">${theme}</div></div>
      <div class="calm pad"><b>操縦席がありません</b>${errs.map((e) => `<p class="mut">${esc(e)}</p>`).join('')}</div>${toastsHtml(ui, now)}</div>`
  }
  // 要対応の件数だけを黒い札にする。対応済みの件数は返すものではないので弱く出す。
  const tabBtn = (k: Tab, label: string, n?: number, quiet = false) =>
    `<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${n === undefined ? '' : `<span class="n${n && !quiet ? '' : ' z'}">${n}</span>`}</button>`
  const stuck = b.d.counts.stuck
  const total = COUNTED.reduce((n, k) => n + b.d.counts[k], 0)
  const body = tab === 'todo' ? viewTodo(b, ui, now, svg) : tab === 'whole' ? viewWhole(b, ui, now, svg) : viewDone(b, ui, now, svg)
  return `<div class="ck win" data-theme="${ui.dark ? 'dark' : 'light'}">
    <div class="wtop"><span class="pj">${esc(b.v.cockpit!.workspace.name)}</span>
      <div class="tabs" role="tablist">${tabBtn('todo', '要対応', total)}${tabBtn('whole', '全体')}${tabBtn('done', '対応済み', b.d.closed.length, true)}</div>
      <div class="flags"><span class="${stuck ? 'err' : 'mut'}">停止中 ${stuck} 件</span>${m.live !== undefined ? `<span class="mut">稼働中のエージェント ${m.live}</span>` : ''}
        <button class="flag repeat" type="button" data-act="repeat" data-root="${esc(b.root)}" title="前に伝えたことを窓口が落としたときに押します。窓口が記録を読み直し、2 回押されると新しいチャットへ引き継ぎます">記録の再読を依頼</button>${theme}</div></div>
    ${hard.length ? `<div class="werrs" role="alert">${hard.map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
    ${softHtml(soft, ui, 'wnotes')}
    <main class="wbody split">${body}</main>${toastsHtml(ui, now)}</div>`
}
