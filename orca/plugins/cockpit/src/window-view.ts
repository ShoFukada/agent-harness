// 窓（常駐のプロセスが出すページ）の 3 タブ: 要対応・全体・対応済み。パネルは view.ts の render のまま。
import { COUNTED, DEFAULT_PHASES, FORMS, FORM_LABEL, KIND_LABEL, type Card, type CardKind, type Cockpit, type StreamForm, type TaskState } from './model.ts'
import { STOP_LABEL, byUrgency, fmtDate, isHot, nearDate, routeProblem, type JobState, type JobView, type RequestView, type Row, type TaskView } from './state.ts'
import {
  actsHtml, backgroundParts, dueHtml, esc, fld, glyph, keyOf, linkBtn, manualHtml, mono, optionsHtml, otherHtml, ownerHtml, rich, stripHtml, toastsHtml,
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
  for (const r of rows) m.set(r.card.stream ?? '', [...(m.get(r.card.stream ?? '') ?? []), r])
  return [...m.entries()].sort((a, b2) => Number(!a[0]) - Number(!b2[0]) || byUrgency(a[1][0]!, b2[1][0]!))
}
/** j・k と「次へ」で進む順（画面の上から）。 */
export const todoOrder = (b: Board | undefined): string[] => (b ? todoGroups(b).flatMap(([, xs]) => xs.map(keyOf)) : [])

function closedGroups(b: Board): [string, VRow[]][] {
  const m = new Map<string, VRow[]>()
  for (const r of vrows(b, b.d.closed)) m.set(r.card.stream ?? '', [...(m.get(r.card.stream ?? '') ?? []), r])
  return [...m.entries()].sort((a, b2) => (b2[1][0]!.when ?? '').localeCompare(a[1][0]!.when ?? ''))
}
export const doneOrder = (b: Board | undefined): string[] => (b ? closedGroups(b).flatMap(([, xs]) => xs.map(keyOf)) : [])

const MANUAL_GLYPH = '<svg class="glyph" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5 10.5 6 3 10.5Z" fill="currentColor"/></svg>'
const kindName = (c: Card) => (c.manual ? `${MANUAL_GLYPH}手作業` : `${glyph(c.kind)}${KIND_LABEL[c.kind]}`)
const tag = (text: string, cls = '') => `<span class="tag${cls ? ` ${cls}` : ''}">${esc(text)}</span>`

/** 行の札。手作業・話し中・直しを頼んだ・直し待ち・件数外（相談）。 */
function tags(r: Row): string {
  return [
    r.card.kind === 'consult' && tag('件数外'),
    r.talking && tag('話し中', 'talk'),
    r.status === 'fixing' && (r.pending ? tag('直し依頼済み（受領待ち）', 'wait') : tag('直し待ち', 'wait'))
  ].filter(Boolean).join('')
}

const taskOf = (b: Board, r: Row): TaskView | undefined => b.d.tasks.get(r.card.tasks?.[0] ?? '')

function cardRow(b: Board, r: VRow, cur: string | undefined, now: number, closed = false): string {
  const c = r.card
  const t = taskOf(b, r)
  const right = closed
    ? `<span>${esc(r.how ?? '')}</span><span class="mut">${esc(nearDate(r.when, now))}${c.resolved_at_inferred ? '（推定）' : ''}</span>${c.closed_without_review ? tag('確認なしで閉じた', 'miss') : !r.pending && c.resolved_by !== 'user' ? tag('窓口が片付けた') : ''}`
    : c.due ? `<span class="${isHot(c.due, now) ? 'hot' : ''}">${esc(nearDate(c.due, now))}</span>` : ''
  return `<button type="button" class="cardrow k-${c.kind}" data-${closed ? 'dsel' : 'sel'}="${esc(keyOf(r))}" aria-current="${cur === keyOf(r)}">
    <span class="kd">${kindName(c)}<small>${esc(c.id.startsWith('#') ? 'Orca' : c.id)}</small></span>
    <span class="tt"><span class="tl">${esc(c.title)}${tags(r)}</span>${t ? `<span class="crumb">${esc(`${t.task.id} ${t.task.title}`)}</span>` : ''}</span>
    <span class="du${closed ? ' cl' : ''}">${right}</span></button>`
}

const FORM_ORDER = FORMS
const FORM_DESC: Record<StreamForm, string> = { cowork: '話しながら進めているもの', delegate: '任せている作業の進み具合', watch: '届いたもの' }
const formChip = (f: StreamForm | undefined) => (f ? `<span class="fm f-${f}">${esc(FORM_LABEL[f])}</span>` : '')

function groupHead(b: Board, sid: string, n: number): string {
  const s = b.v.cockpit!.streams.find((x) => x.id === sid)
  if (!s) return `<div class="gh"><b class="hotc">仕事に結ばれていない</b><span class="mut">${n} 件</span></div>`
  const ts = tasksOf(b, sid)
  const j = b.d.jobs.find((x) => x.id === sid)
  return `<div class="gh f-${s.form ?? 'none'}">${formChip(s.form)}<b>${esc(s.title)}</b><span class="mut">${n} 件</span><span class="prog">${bar(ts)}${okOf(ts)}</span>${j?.owner ? `<span class="mut">担当: ${esc(j.owner.title)}</span>` : ''}</div>`
}

/** 帳簿の抜け（窓口が 30 分のうちに直さなかったもの）。R47。 */
function gapsHtml(b: Board): string {
  const gs = b.d.gaps
  if (!gs.length) return ''
  const what = { card: 'カード', request: '依頼', utterance: '発言' } as const
  return `<div class="gaps" role="status"><b>抜けている ${gs.length} 件</b><span class="mut">窓口が 30 分以内に埋めなかったものです。窓口と話して埋めさせてください</span>
    <ul>${gs.map((g) => `<li>${esc(what[g.kind])} <span class="code">${esc(g.id)}</span> ${esc(g.title)}<span class="mut">（欠け: ${esc(g.missing.join('・'))}）</span></li>`).join('')}</ul></div>`
}

function viewTodo(b: Board, ui: Ui, now: number, svg: Svg): string {
  const groups = todoGroups(b)
  const reps = vrows(b, b.d.reports)
  const list = groups.length
    ? groups.map(([sid, xs]) => `<section class="sgrp">${groupHead(b, sid, xs.length)}${xs.map((r) => cardRow(b, r, ui.sel, now)).join('')}</section>`).join('')
    : '<div class="calm"><b>要対応 0 件</b></div>'
  const rd = reps.length ? `<section class="sgrp readonly"><div class="subh">読むだけ（報告）${reps.length} 件・件数に入れない</div>${reps.map((r) => cardRow(b, r, ui.sel, now)).join('')}</section>` : ''
  const order = todoOrder(b)
  const all = [...groups.flatMap(([, xs]) => xs), ...reps]
  const cur = all.find((r) => keyOf(r) === ui.sel)
  const next = cur ? order[order.indexOf(keyOf(cur)) + 1] : undefined
  return `<div class="wpane" aria-label="要対応">${gapsHtml(b)}${list}${rd}</div><aside class="wside" aria-label="詳細">${cur ? detail(b, cur, ui, now, svg, next) : '<p class="mut pad">左の行を押すと、ここに中身が出ます。</p>'}</aside>`
}

/** 種類ごとの「最初に見える部分」。決めるのに要るものだけを出し、残りは「詳しく」に畳む。 */
function firstView(r: VRow, ui: Ui, now: number): string {
  const c = r.card
  const list = (xs: string[] | undefined, ordered = false) => (xs?.length ? `<${ordered ? 'ol' : 'ul'} class="rich">${xs.map((x) => `<li>${mono(esc(x))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : '')
  if (c.manual) return manualHtml(r)
  switch (c.kind) {
    case 'review':
      return [c.href ? `<div class="links">${linkBtn('成果物', c.href)}</div>` : '', fld('見てほしい点', list(c.look_for, true)), r.fix ? fld('頼んだ直し（原文）', `<div class="quote">${esc(r.fix)}</div>`) : ''].join('')
    case 'decide':
      return [optionsHtml(r, ui), fld('得られること', rich(c.context?.gain, c.repo)), fld('失うこと', rich(c.context?.cost, c.repo))].join('')
    case 'permit':
      return [fld('対象', c.target ? `<span class="code">${esc(c.target)}</span>` : ''), fld('何が変わるか', rich(c.effect, c.repo)), fld('戻し方', esc(c.undo)), optionsHtml(r, ui)].join('')
    case 'send':
      return c.draft ? `<div class="fld"><span class="lb">送る文面</span><div class="msg-to">宛先 <b>${esc(c.draft.to)}</b>${c.draft.via ? `　経路 ${esc(c.draft.via)}` : ''}</div><div class="msg">${esc(c.draft.text)}</div></div>${optionsHtml(r, ui)}` : optionsHtml(r, ui)
    case 'stuck':
      return [fld('止まっている理由', c.reason ? `<div class="quote code">${esc(c.reason)}</div>` : ''), c.since ? fld('止まってから', esc(fmtDate(c.since))) : '',
        fld('答えれば進むか', `${c.answerable ? '進む' : '答えても進まない'}${c.unblock ? `。${esc(c.unblock)}` : ''}`), optionsHtml(r, ui)].join('')
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
  const crumbs = [b.v.cockpit!.workspace.name, s?.title ?? '仕事に結ばれていない', t && `${t.task.id} ${t.task.title}`].filter(Boolean) as string[]
  const notes = [
    closed ? `<div class="note ok"><b>${esc(r.how ?? '')}</b>　${esc(fmtDate(r.when))}${c.resolved_at_inferred ? '（時刻は推定）' : ''}・${r.pending ? '窓口の受け取り待ち' : c.resolved_by === 'user' ? '深田さんの返答' : '窓口が片付けた'}${c.closed_without_review ? '。確認の返答が無いまま閉じたカードです' : ''}</div>` : '',
    r.talking ? `<div class="note wait"><b>話し中</b>　${esc(fmtDate(r.talking.since))} から${esc(r.owner.how === 'main' ? '窓口' : `担当（${r.owner.title}）`)}と話しています。相手がカードを書き直すまで要対応に残ります</div>` : '',
    r.status === 'fixing' ? `<div class="note wait"><b>${r.pending ? '直し依頼済み（受領待ち）' : '直し待ち'}</b>　直した版が届くと要対応に戻ります。件数には入れていません</div>` : '',
    c.kind === 'consult' ? '<div class="note">相談は件数に入れません。担当と話して結論を出し、担当がカードを閉じます</div>' : ''
  ].join('')
  const more = moreView(r, svg)
  const moreOpen = closed || (ui.open['detail-more'] ?? false)
  const acts = actsHtml(r, ui, true).replace('</div>', next ? `<button class="btn quiet nx" type="button" data-sel="${esc(next)}">次へ（j）</button></div>` : '</div>')
  return `<div class="wdet k-${c.kind}">
    <div class="dh"><div class="crumbs">${crumbs.map((x) => `<span>${esc(x)}</span>`).join('<i>›</i>')}</div>
      <div class="kl"><span class="kd">${kindName(c)}</span><span class="mut">${esc(c.id.startsWith('#') ? 'Orca から' : c.id)}</span>${c.due ? dueHtml(c.due, now) : ''}</div>
      <h2>${esc(c.title)}</h2><div>${ownerHtml(r.owner)}</div></div>
    ${notes}<div class="first">${firstView(r, ui, now) || '<span class="mut">中身はありません</span>'}</div>
    ${more ? `<details class="more-d" data-fold="detail-more"${moreOpen ? ' open' : ''}><summary>詳しく（何のため・判断の材料・出典）</summary><div class="slots">${more}</div></details>` : ''}
    ${closed ? '' : otherHtml(r, ui)}
    <div class="dbtn">${acts}</div></div>`
}

// ── 全体 ──
const tasksOf = (b: Board, sid: string) => [...b.d.tasks.values()].filter((t) => t.task.stream === sid)
const okOf = (ts: TaskView[]) => `${ts.filter((t) => t.state === 'ok').length}/${ts.length}`
const STATES: TaskState[] = ['ok', 'run', 'wait', 'stop', 'idle']
const TSTATE: Record<TaskState, string> = { ok: '済', run: '作業中', wait: '待ち', stop: '止まった', idle: '未着手' }
const bar = (ts: TaskView[]) =>
  `<span class="bar" aria-hidden="true">${STATES.map((s) => `<i class="s-${s}" style="width:${(ts.filter((t) => t.state === s).length / (ts.length || 1)) * 100}%"></i>`).join('')}</span>`

/** 工程の段。済んでいないタスクのうち、工程の並びで一番前を「今」とする。 */
function steps(c: Cockpit, ts: TaskView[]): string {
  const phases = c.phases ?? DEFAULT_PHASES
  const live = ts.filter((t) => t.state !== 'ok')
  const idx = live.map((t) => phases.indexOf(t.task.phase)).filter((i) => i >= 0)
  const out = [...new Set(live.filter((t) => !phases.includes(t.task.phase)).map((t) => t.task.phase))]
  const done = !live.length
  const at = done ? phases.length : idx.length ? Math.min(...idx) : -1
  const cells = phases.map((ph, i) => `<span class="s${done || i < at ? ' done' : i === at ? ' now' : ''}">${esc(ph)}</span>`).join('<span class="ar">›</span>')
  const pos = done ? '全工程 済' : at >= 0 ? `工程 ${at + 1}/${phases.length}` : '工程の外だけ'
  return `<span class="steps">${cells}${out.length && !done ? `<span class="ar">＋</span>${out.map((o) => `<span class="s out">${esc(o)}</span>`).join('')}` : ''}<span class="pos">${pos}</span></span>`
}

const WHY: Record<TaskView['why'], string> = { ok: '済', record: '記録のまま', working: '作業中', intake: '済・取り込み待ち', stopped: '止まった', missing: 'Orca に無い' }

function workerRow(b: Board, t: TaskView): string {
  if (!t.task.worker) return ''
  const a = b.v.workers.find((w) => w.task === t.task.id)
  const st = t.why === 'stopped' && t.stop ? `止まった（${STOP_LABEL[t.stop as keyof typeof STOP_LABEL] ?? t.stop}）` : WHY[t.why]
  return `<div class="wrow"><span class="mut">worker</span><span class="wn">${esc(t.task.title)}</span><span class="chip${t.why === 'working' ? ' live' : t.why === 'stopped' || t.why === 'missing' ? ' bad' : ''}">${esc(st)}</span>${a?.where ? `<span class="mut">今: ${esc(a.where)}</span>` : ''}
    ${a ? `<button type="button" class="act" data-term="${esc(a.terminalId ?? '')}" data-wt="${esc(a.worktree ?? '')}">端末を見る</button>` : ''}</div>`
}

function taskRow(b: Board, t: TaskView, todo: Map<string, VRow[]>, talkLabel: string): string {
  const chips = (todo.get(t.task.id) ?? []).map((r) => `<button type="button" class="chip kc k-${r.card.kind}" data-jump="${esc(keyOf(r))}" title="要対応で開く">${r.card.manual ? MANUAL_GLYPH : glyph(r.card.kind)}${esc(r.card.id)}</button>`).join('')
  const sub = t.task.waiting_on ? `待ち: ${t.task.waiting_on}` : t.task.next ? `次: ${t.task.next}` : ''
  return `<div class="task"><span class="tdot s-${t.state}" title="${TSTATE[t.state]}"></span>
    <span class="tn"><span><span class="id">${esc(t.task.id)}</span>${esc(t.task.title)}</span>${sub ? `<span class="nx">${mono(esc(sub))}</span>` : ''}</span>
    <span class="wk">${chips}${t.task.stream ? `<button type="button" class="act talk" data-talkstream="${esc(t.task.stream)}">${talkLabel}</button>` : ''}</span>
    ${workerRow(b, t)}</div>`
}

const PILL: Record<JobState, string> = { mine: '要対応', stopped: '止まっている', working: '作業中', customer: '顧客待ち', idle: '未着手', done: '済' }

function streamBox(b: Board, j: JobView, ui: Ui, todo: Map<string, VRow[]>): string {
  const c = b.v.cockpit!
  const s = c.streams.find((x) => x.id === j.id)
  const ts = tasksOf(b, j.id)
  const live = ts.filter((t) => t.state !== 'ok')
  const open = ui.open[`s:${j.id}`] ?? (j.state !== 'done' && j.state !== 'idle' && s?.form !== 'cowork')
  const phases = [...(c.phases ?? DEFAULT_PHASES), ...new Set(live.map((t) => t.task.phase).filter((p) => !(c.phases ?? DEFAULT_PHASES).includes(p)))]
  const talkLabel = j.owner ? '担当と話す' : '窓口と話す'
  const working = ts.filter((t) => t.why === 'working').length
  const label = j.state === 'mine' ? `要対応 ${j.mine}` : j.state === 'customer' ? j.label : PILL[j.state]
  const inner = open
    ? phases.map((ph) => [ph, live.filter((t) => t.task.phase === ph)] as const).filter(([, xs]) => xs.length)
        .map(([ph, xs]) => `<div class="phase">${esc(ph)}${(c.phases ?? DEFAULT_PHASES).includes(ph) ? '' : tag('工程の外', 'wait')}</div>${xs.map((t) => taskRow(b, t, todo, talkLabel)).join('')}`).join('')
      + (ts.length - live.length ? `<div class="donebox">済んだタスク ${ts.length - live.length}</div>` : '')
    : ''
  return `<div class="st f-${s?.form ?? 'none'}"><div class="sh">
    <button type="button" class="t" data-toggle="s:${esc(j.id)}" aria-expanded="${open}"><span class="tw">${open ? '▾' : '▸'}</span>${formChip(s?.form)}<span>${esc(j.title)}</span><span class="pill ${j.state}">${esc(label)}</span>${j.owner ? `<span class="tw">担当: ${esc(j.owner.title)}</span>` : ''}</button>
    <span class="right"><span class="prog">${bar(ts)}${okOf(ts)}</span><button type="button" class="act talk" data-talkstream="${esc(j.id)}">${talkLabel}</button></span>
    <span class="meta">${steps(c, ts)}${working ? `<span class="chip live">worker ${working} 作業中</span>` : ''}${j.next && !open ? `<span class="mut nxt">次: ${mono(esc(j.next))}</span>` : ''}</span></div>
    ${open ? `<div class="inner">${inner || '<span class="mut">開いているタスクはありません</span>'}</div>` : ''}</div>`
}

function requestsHtml(b: Board, ui: Ui, now: number): string {
  const c = b.v.cockpit!
  const open = b.d.requests.filter((r) => r.state !== '済').sort((x, y) => (x.req.at ?? '').localeCompare(y.req.at ?? ''))
  const row = (r: RequestView) => {
    const ts = r.tasks
    const on = ui.rq === r.req.id
    const quote = r.req.utterances?.map((u) => u.quote).join('\n') || r.req.quote || ''
    const trace = on ? `<div class="trace">
      <span class="l">原文</span><div class="q">${esc(quote.length > 300 ? `${quote.slice(0, 300)}…` : quote) || '—'}</div>
      ${r.req.done_when?.length ? `<span class="l">済の条件</span><div>${r.req.done_when.map((w, i) => `<div>${r.covered[i] ? '✓' : '・'} ${esc(w)}</div>`).join('')}</div>` : ''}
      <span class="l">仕事</span><div>${r.streams.map((x) => esc(c.streams.find((s) => s.id === x)?.title ?? x)).join('・') || '—'}</div>
      <span class="l">タスク</span><div>${ts.map((t) => `<div><span class="tdot s-${t.state}"></span> ${esc(t.task.id)} ${esc(t.task.title)}（${TSTATE[t.state]}）</div>`).join('') || '—'}</div>
      <span class="l">確認依頼</span><div>${r.cards.map((x) => `<div class="k-${x.kind}"><span class="kd">${glyph(x.kind)}</span> ${esc(x.id)} ${esc(x.title)}${x.state === 'done' ? '（済）' : ''}</div>`).join('') || '—'}</div></div>` : ''
    return `<div class="rq"><button type="button" data-rq="${esc(r.req.id)}" aria-expanded="${on}"><span class="rid">${esc(r.req.id)}</span><span class="rt">${esc(r.req.title)}</span>
      <span class="rs"><span>${esc(nearDate(r.req.at, now))}</span><span>${esc(r.state)}</span><span>${ts.length ? `タスク ${okOf(ts)} 済` : 'タスクなし'}</span>${r.missing.length ? tag(`欠け: ${r.missing.join('・')}`, 'miss') : ''}${r.legacy ? tag('移し替え前') : ''}</span></button>${trace}</div>`
  }
  const ms = c.workspace.milestones?.[0]
  return `<h3>まだ済んでいない依頼 <span class="mut">${open.length} 件・受けた順</span></h3>
    <p class="note">押すと、原文から済の条件・タスク・確認依頼までを開きます。${ms ? `次の節目: ${esc(ms.label)}（${esc(fmtDate(ms.date))}）` : ''}</p>${open.map(row).join('') || '<p class="note">ありません</p>'}`
}

function viewWhole(b: Board, ui: Ui, now: number, svg: Svg): string {
  const c = b.v.cockpit!
  const todo = new Map<string, VRow[]>()
  for (const [, xs] of todoGroups(b)) for (const r of xs) for (const t of r.card.tasks ?? []) todo.set(t, [...(todo.get(t) ?? []), r])
  const form = (j: JobView) => c.streams.find((s) => s.id === j.id)?.form
  const live = b.d.jobs.filter((j) => j.state !== 'done')
  const done = b.d.jobs.filter((j) => j.state === 'done')
  const inbox = vrows(b, b.d.queue.filter((r) => r.card.kind === 'inbox'))
  const routes = (c.routes ?? []).map((r) => {
    const p = routeProblem(r, now)
    return `<li>${esc(r.label)}${p ? `<span class="hotc">　${esc(p.slice(r.label.length + 2))}</span>` : r.read_at ? `<span class="mut">　${esc(nearDate(r.read_at, now))} に読んだ</span>` : ''}</li>`
  })
  const sec = (f: StreamForm, extra = '') => {
    const xs = live.filter((j) => form(j) === f)
    const nDone = done.filter((j) => form(j) === f).length
    return `<section class="fsec"><h3>${formChip(f)}<span>${esc(FORM_DESC[f])}</span><span class="mut">${xs.length} 件</span></h3>
      ${xs.length ? xs.map((j) => streamBox(b, j, ui, todo)).join('') : `<p class="mut">進行中の仕事はありません${nDone ? `（済んだ仕事 ${nDone} 件は下に畳んであります）` : ''}</p>`}${extra}</section>`
  }
  const watchExtra = `<div class="watch"><div class="subh">見張っている経路</div>${routes.length ? `<ul>${routes.join('')}</ul>` : '<p class="mut">登録がありません（routes）</p>'}
    <div class="subh">届いた連絡 ${inbox.length} 件・件数に入れない</div>${inbox.length ? `<div class="strips">${inbox.map((r) => stripHtml(r, ui, now, svg, false)).join('')}</div>` : '<p class="mut">ありません</p>'}</div>`
  const noForm = live.filter((j) => !form(j))
  const loose = [...b.d.tasks.values()].filter((t) => t.state !== 'ok' && !c.streams.some((s) => s.id === t.task.stream))
  const main = FORM_ORDER.map((f) => sec(f, f === 'watch' ? watchExtra : '')).join('')
    + (noForm.length ? `<section class="fsec"><h3><span class="hotc">形が書かれていない仕事</span><span class="mut">${noForm.length} 件</span></h3>${noForm.map((j) => streamBox(b, j, ui, todo)).join('')}</section>` : '')
    + (loose.length ? `<section class="fsec"><h3><span class="hotc">仕事に結ばれていないタスク</span><span class="mut">${loose.length} 件</span></h3><div class="st"><div class="inner">${loose.map((t) => taskRow(b, t, todo, '窓口と話す')).join('')}</div></div></section>` : '')
    + (done.length ? `<button type="button" class="wmore" data-toggle="done" aria-expanded="${!!ui.open.done}">${ui.open.done ? '▾ 済んだ仕事を閉じる' : `▸ 済んだ仕事 ${done.length} 件`}</button>${ui.open.done ? done.map((j) => streamBox(b, j, ui, todo)).join('') : ''}` : '')
  return `<div class="wpane" aria-label="全体">${main}</div><aside class="wside" aria-label="まだ済んでいない依頼">${requestsHtml(b, ui, now)}</aside>`
}

function viewDone(b: Board, ui: Ui, now: number, svg: Svg): string {
  const groups = closedGroups(b)
  const list = groups.map(([sid, xs]) => `<section class="sgrp">${groupHead(b, sid, xs.length)}${xs.map((r) => cardRow(b, r, ui.doneSel, now, true)).join('')}</section>`).join('')
  const cur = groups.flatMap(([, xs]) => xs).find((r) => keyOf(r) === ui.doneSel)
  return `<div class="wpane" aria-label="対応済み"><p class="mut">直近 14 日・新しい順。仕事ごとにまとめています。</p>${list || '<div class="calm"><b>対応済み 0 件</b></div>'}</div>
    <aside class="wside" aria-label="詳細">${cur ? detail(b, cur, ui, now, svg, undefined, true) : '<p class="mut pad">左の行を押すと、ここに中身が出ます。</p>'}</aside>`
}

const LEGEND_KINDS: CardKind[] = ['stuck', 'permit', 'decide', 'send', 'review', 'consult']
function keyline(tab: Tab): string {
  const k = (kind: CardKind) => `<span class="k k-${kind}"><span class="sw"></span>${glyph(kind)}${esc(KIND_LABEL[kind])}</span>`
  const kinds = LEGEND_KINDS.map(k).join('') + `<span class="k k-permit"><span class="sw"></span>${MANUAL_GLYPH}手作業</span>`
  if (tab === 'todo') return `<span class="cap">種類</span>${kinds}<span class="sep"></span><span class="k">期限が 1 日を切ったものは赤</span><span class="k">相談は件数に入れない</span>`
  if (tab === 'done') return `<span class="cap">種類</span>${kinds}${k('report')}<span class="sep"></span><span class="k">右に返した答え。窓口が片付けたもの・確認なしで閉じたものに印</span>`
  const dot = (s: TaskState) => `<span class="k"><span class="tdot s-${s}"></span>${TSTATE[s]}</span>`
  return `<span class="cap">形</span>${FORM_ORDER.map(formChip).join('')}<span class="sep"></span><span class="cap">工程</span><span class="steps"><span class="s done">済んだ</span><span class="s now">今</span><span class="s">まだ</span><span class="s out">工程の外</span></span>
    <span class="sep"></span><span class="cap">タスク</span>${STATES.map(dot).join('')}`
}

export function renderWindow(m: Model, ui: Ui, now: number, svg: Svg): string {
  const b = boardOf(m)
  const tab: Tab = ui.tab ?? 'todo'
  const errs = [...m.errors, ...(b?.v.errors ?? []), ...m.unseen.filter((u) => u.why).map((u) => `${u.name}: ${u.why}`)]
  const theme = `<span class="seg" role="group" aria-label="地の色">${(['light', 'dark', 'auto'] as Theme[]).map((t) => `<button type="button" data-theme="${t}" aria-pressed="${ui.theme === t}">${t === 'light' ? '明' : t === 'dark' ? '暗' : '自動'}</button>`).join('')}</span>`
  if (!b) {
    return `<div class="ck win" data-theme="${ui.dark ? 'dark' : 'light'}"><div class="wtop"><span class="pj">操縦席</span><div class="flags">${theme}</div></div>
      <div class="calm pad"><b>操縦席がありません</b><p>メインに「操縦席を作って」と頼むと、ここに要対応が並びます。</p>${errs.map((e) => `<p class="mut">${esc(e)}</p>`).join('')}</div>${toastsHtml(ui, now)}</div>`
  }
  const tabBtn = (k: Tab, label: string, n?: number) =>
    `<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${n === undefined ? '' : `<span class="n${n ? '' : ' z'}">${n}</span>`}</button>`
  const stuck = b.d.counts.stuck
  const total = COUNTED.reduce((n, k) => n + b.d.counts[k], 0)
  const body = tab === 'todo' ? viewTodo(b, ui, now, svg) : tab === 'whole' ? viewWhole(b, ui, now, svg) : viewDone(b, ui, now, svg)
  return `<div class="ck win" data-theme="${ui.dark ? 'dark' : 'light'}">
    <div class="wtop"><span class="pj">${esc(b.v.cockpit!.workspace.name)}</span>
      <div class="tabs" role="tablist">${tabBtn('todo', '要対応', total)}${tabBtn('whole', '全体')}${tabBtn('done', '対応済み', b.d.closed.length)}</div>
      <div class="flags"><span class="${stuck ? 'err' : 'mut'}">止まっている ${stuck}</span>${m.live !== undefined ? `<span class="mut">稼働中のエージェント ${m.live}</span>` : ''}
        <button class="flag repeat" type="button" data-act="repeat" data-root="${esc(b.root)}" title="前に伝えたことを窓口が落としたときに押します。窓口が記録を読み直し、2 回押されると新しいチャットへ引き継ぎます">前にも言った</button>${theme}</div></div>
    ${errs.length ? `<div class="werrs" role="alert">${errs.map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
    <div class="keyline" aria-label="凡例">${keyline(tab)}</div>
    <main class="wbody ${tab === 'whole' ? 'whole' : 'split'}">${body}</main>${toastsHtml(ui, now)}</div>`
}
