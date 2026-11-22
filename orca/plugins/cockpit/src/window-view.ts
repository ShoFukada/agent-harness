// 窓（常駐のプロセスが出すページ）の 3 タブ: 要対応・全体・対応済み。パネルは view.ts の render のまま。
import { actionVerb, COUNTED, COWORK_ID, STAGES, stageOf, FORMS, FORM_LABEL, KIND_LABEL, TEXT_MAX, askItem, answerParts, doneText, unanswered, isSynthetic, permitEffect, permitTarget, sentOps, timeOf, type AskEntry, type AskThread, type Card, type ConsultMemo, type OpType, type Sent, type StreamForm, type TaskState } from './model.ts'
import { REPLY_LABEL, STOP_LABEL, byUrgency, fmtDate, nearDate, routeProblem, upcomingMilestones, type JobState, type JobView, type Row, type TaskView } from './state.ts'
import {
  actsHtml, ago, backgroundParts, dueHtml, esc, fld, isSoft, keyOf, linkBtn, manualHtml, mono, note, optionsHtml, otherHtml, OWNER_STATE, ownerHtml, lintHtml, rich, choresHtml, sampleHtml, stripHtml, toastsHtml, rowIdHtml,
  type AskWait, type Board, type Model, type Theme, type Ui, type VRow
} from './view.ts'
import type { RulingHit } from './protocol.ts'

type Svg = (raw: string) => string
export type Tab = NonNullable<Ui['tab']>

/** 窓が描く案件。サイドバーで選んだ案件、選んでいなければ Orca の前面の案件、無ければ最初の案件（R39）。 */
export const boardOf = (m: Model, pick?: string): Board | undefined =>
  m.boards.find((b) => b.root === pick) ?? m.boards.find((b) => b.root === m.focused) ?? m.boards[0]

/**
 * 案件のサイドバー。名前の順に並べ、件数は私の番（要対応のタブと同じ数）を語つきで、0 件は出さない（R91）。
 * 名前は workspace.name のまま（命名の決まりは d167 で決める）。
 */
function casesSide(m: Model, b: Board, orcaBtns: string): string {
  const byName = [...m.boards].sort((x, y) => x.v.cockpit!.workspace.name.localeCompare(y.v.cockpit!.workspace.name, 'ja'))
  const row = (x: Board) => {
    const n = COUNTED.reduce((s, k) => s + x.d.counts[k], 0)
    return `<button class="wcase" type="button" data-filter="${esc(x.root)}" aria-current="${x.root === b.root}"><span class="nm">${esc(x.v.cockpit!.workspace.name)}</span>${n ? `<span class="n">私の番 ${n}</span>` : ''}${m.focused === x.root ? '<span class="here">Orca で表示中</span>' : ''}</button>`
  }
  return `<nav class="wcases" id="wcases" aria-label="案件">${byName.map(row).join('')}<div class="wcorca">${orcaBtns}</div></nav>`
}

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
/** 対応済みの仕事の畳みの鍵（明示的にカードを選んだら、その仕事を開くのに controller も使う）。 */
export const doneFold = (c: Card) => `done:${c.stream || '-'}`
export const doneOrder = (b: Board | undefined): string[] => (b ? closedGroups(b).flatMap(([, xs]) => xs.map(keyOf)) : [])

/** 種類は語だけで示す（記号を並べない。R101）。要対応の行は深田さんがすることの語（R115）、対応済みの行は種類の名前。 */
const kindName = (c: Card) => (c.manual ? '手作業' : c.id.startsWith(COWORK_ID) ? '共同作業' : KIND_LABEL[c.kind])
const leadWord = (r: Row, closed: boolean) => (closed || r.status !== 'mine' ? kindName(r.card) : actionVerb(r.card, r.agent?.ask?.kind))
const tag = (text: string, cls = '') => `<span class="tag${cls ? ` ${cls}` : ''}">${esc(text)}</span>`

/** 行の札。協議中と修正待ち。相談は見出しで別に数えるので札を付けない（初見 12）。 */
function tags(r: Row): string {
  return [
    r.talking && tag('協議中', 'talk'),
    // 返事待ちは全体の仕事とタスクの状態と同じ語・同じ色にする（Neon）。
    replyWait([r]) && tag(REPLY_LABEL, 'miss'),
    r.status === 'fixing' && (r.pending ? tag('修正依頼済み（受領待ち）', 'wait') : tag('修正待ち', 'wait'))
  ].filter(Boolean).join('')
}

/** 判断の一覧の 1 行に出すおすすめの案（一覧だけで決められるように。info-needs Q1）。 */
const recOf = (r: Row) => {
  const o = r.status === 'mine' && r.card.kind === 'decide' ? r.card.options?.find((x) => x.recommended) : undefined
  return o ? `<span class="recm">おすすめ: ${esc(o.label)}</span>` : ''
}

const taskOf = (b: Board, r: Row): TaskView | undefined => b.d.tasks.get(r.card.tasks?.[0] ?? '')

/**
 * 対応済みの行の右に出す結果の語。「決定: 〜」「許可: 〜」の値は題と詳細の「出した指示」に出るので重ねず（初見 2 巡目 5）、
 * 判断が決まったことは種類で分かるので「決定」も出さない。承認・却下・担当が完了のような語だけの結果は出す。
 */
const outcome = (how: string | undefined) => {
  const w = (how ?? '').split(/:\s/)[0]!.trim()
  return w === '決定' ? '' : w
}

function cardRow(b: Board, r: VRow, cur: string | undefined, now: number, closed = false): string {
  const c = r.card
  const t = taskOf(b, r)
  // 返した答えは 1 行で切り、全文は詳細で読む（長い別の回答で行が伸びないように）。
  const right = closed
    ? `${outcome(r.how) ? `<span class="how" title="${esc(r.how ?? '')}">${esc(outcome(r.how))}</span>` : ''}<span class="mut">${esc(nearDate(r.when, now))}${c.resolved_at_inferred ? '（推定）' : ''}</span>${c.closed_without_review ? tag('確認なしで閉じた', 'miss') : r.pending ? tag('受け取り待ち', 'wait') : ''}`
    : r.agent?.ask && c.since ? `<span class="mut">${esc(ago(c.since, now))}前</span>` : dueHtml(c.due, now)
  // 番号はどの行でも右の列の 2 段目に置く（時刻の無い行で、時刻の位置に番号だけが来ないように。Neon・初見の目）。
  // 止まった問いの 2 行目は、誰が誰に聞いているか（タスク名は「誰が」に入っている）。
  const sub = r.agent?.ask?.from ?? t?.task.title
  return `<button type="button" class="cardrow k-${c.kind}${closed ? ' cl' : ''}${replyWait([r]) ? ' reply' : ''}" data-${closed ? 'dsel' : 'sel'}="${esc(keyOf(r))}" aria-current="${cur === keyOf(r)}">
    <span class="kd">${leadWord(r, closed)}</span>
    <span class="tt"><span class="tl"><span class="ti">${esc(c.title)}</span>${tags(r)}</span>${recOf(r)}${sub ? `<span class="crumb">${esc(sub)}</span>` : ''}</span>
    <span class="du${closed ? ' cl' : ''}">${right}${closed || !rowIdHtml(r) ? '' : `${right ? '' : '<span aria-hidden="true">&nbsp;</span>'}${rowIdHtml(r)}`}</span></button>`
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
  const n = closed ? `対応済み ${xs.length} 件` : [counted && `要対応 ${counted} 件`, consult && `相談 ${consult} 件`, xs.length - counted - consult && `修正待ち ${xs.length - counted - consult} 件`].filter(Boolean).join('・')
  if (sid === ORCA) return `<div class="gh"><b>停止中のエージェント</b><span class="mut">${n}・Orca より</span></div>`
  if (!s) return `<div class="gh"><b>仕事の割り当てなし</b><span class="mut">${n}</span></div>`
  const ts = tasksOf(b, sid)
  const j = b.d.jobs.find((x) => x.id === sid)
  // 工程は仕事の名前の横に置き、右の列は行の期限・経過だけにする（右に工程と期限が混ざって右端がずれる。初見 2 巡目 2）。
  // 担当の名前が仕事の名前と同じなら出さない（初見 2 巡目 3）。
  const prog = phaseBar(ts, s.form, j?.state)
  return `<div class="gh f-${s.form ?? 'none'}">${formChip(s.form)}<b>${esc(s.title)}</b>${prog ? `<span class="prog">${prog}</span>` : ''}<span class="mut">${n}</span>${j?.owner && j.owner.title !== s.title ? `<span class="mut">担当: ${esc(j.owner.title)}</span>` : ''}</div>`
}

function viewTodo(b: Board, ui: Ui, now: number, svg: Svg): string {
  const groups = todoGroups(b)
  const reps = vrows(b, b.d.reports)
  const list = groups.length
    ? groups.map(([sid, xs]) => `<section class="sgrp">${groupHead(b, sid, xs)}<div class="rows">${xs.map((r) => cardRow(b, r, ui.sel, now)).join('')}</div></section>`).join('')
    : '<div class="calm"><b>要対応 0 件</b></div>'
  const rd = reps.length ? `<section class="sgrp readonly"><div class="subh">報告（参照のみ）${reps.length} 件</div><div class="rows">${reps.map((r) => cardRow(b, r, ui.sel, now)).join('')}</div></section>` : ''
  const order = todoOrder(b)
  const all = [...groups.flatMap(([, xs]) => xs), ...reps]
  const cur = all.find((r) => keyOf(r) === ui.sel)
  const next = cur ? order[order.indexOf(keyOf(cur)) + 1] : undefined
  return `<div class="wpane" aria-label="要対応">${list}${rd}</div><aside class="wside" aria-label="詳細">${cur ? detail(b, cur, ui, now, svg, next) : ''}</aside>`
}

/** 種類ごとの「最初に見える部分」。決めるのに要るものだけを出し、残りは「詳しく」に畳む。 */
function firstView(r: VRow, ui: Ui, svg: Svg, now: number): string {
  const c = r.card
  const list = (xs: string[] | undefined, ordered = false) => (xs?.length ? `<${ordered ? 'ol' : 'ul'} class="rich">${xs.map((x) => `<li>${mono(note(x))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : '')
  if (c.manual) return manualHtml(r)
  // 承認を求める要素（9.2）。これでよいは、この全部の要素への承認として受け取られる。
  const elements = c.elements?.length ? fld('承認する要素', `<ol class="rich">${c.elements.map((e) => `<li value="${e.n}">${mono(esc(e.text))}</li>`).join('')}</ol>`) : ''
  return elements + firstOfKind(r, ui, svg, list, now)
}

/** 開閉を再描画のあとも保つ畳み（data-fold で ui.open に残す）。 */
const fold = (ui: Ui, key: string, summary: string, body: string) =>
  `<details class="cont" data-fold="${esc(key)}"${ui.open[key] ? ' open' : ''}><summary>${summary}</summary>${body}</details>`

/** 依頼の原文は 2 行まで見せ、長ければ続きを畳む（info-needs 3.4）。key は開閉を覚える名前。 */
function clampQuote(text: string | undefined, ui: Ui, key: string): string {
  if (!text) return ''
  const head = text.split('\n').slice(0, 2).join('\n')
  if (head === text && text.length <= 140) return `<div class="quote verb">${esc(text)}</div>`
  return `<div class="quote verb">${esc(head.slice(0, 140))}…</div>${fold(ui, key, '続き', `<div class="quote verb">${esc(text)}</div>`)}`
}

/**
 * 見てほしい点。「1 …」と番号を書いた項目は番号付きの一覧にし（印と番号を二重にしない）、番号の無い項目（返し方の説明など）は一覧の下に添える。
 */
function points(xs: string[] | undefined): string {
  if (!xs?.length) return ''
  const NUM = /^\s*(\d+)(?:[\s.．、)）]\s*|(?=[「『（(]))/
  if (Number(NUM.exec(xs[0]!)?.[1]) !== 1) return `<ol class="rich">${xs.map((x) => `<li>${mono(note(x))}</li>`).join('')}</ol>`
  // 番号は 1 から順に続くものだけを番号と読む（「6 点ともおすすめなら」のような文の頭の数字を拾わない）。
  let next = 1
  const isNum = xs.map((x) => Number(NUM.exec(x)?.[1]) === next && ++next > 0)
  const num = xs.filter((_, i) => isNum[i])
  const rest = xs.filter((_, i) => !isNum[i])
  return `<ol class="rich">${num.map((x) => `<li value="${NUM.exec(x)![1]}">${mono(note(x.replace(NUM, '')))}</li>`).join('')}</ol>${rest.map((x) => `<p class="mut">${mono(note(x))}</p>`).join('')}`
}

/** 比べた表と図（判断では選択肢と並べて最初に見せる）。 */
const compareParts = (r: VRow, svg: Svg) => backgroundParts({ ...r, card: { ...r.card, background: undefined, quote: undefined } }, svg, r.v?.figures ?? {}).join('')

function firstOfKind(r: VRow, ui: Ui, svg: Svg, list: (xs: string[] | undefined, ordered?: boolean) => string, now: number): string {
  const c = r.card
  switch (c.kind) {
    case 'review': {
      // 頼んだ直しの原文は「出した指示」に出す（二重にしない）。依頼の原文は成果物と見比べるので最初に見せる。
      const links = [c.href && linkBtn('成果物を開く', c.href), c.diff && linkBtn('差分を開く', c.diff)].filter(Boolean).join('')
      // 見る対象（成果物・差分）は押す順に、ふつうのボタンの大きさで先頭に置く（初見 6）。
      return [links ? `<div class="links main">${links}</div>` : '', fld('確認事項', points(c.look_for)), fld('依頼の原文', clampQuote(c.request, ui, `cont:${keyOf(r)}`)), sampleHtml(r)].join('')
    }
    case 'decide':
      return [fld('これは何か', rich(c.context?.what, c.repo)), optionsHtml(r, ui), compareParts(r, svg), fld('得られること', rich(c.context?.gain, c.repo)), fld('失うこと', rich(c.context?.cost, c.repo))].join('')
    case 'permit':
      // 版 2 の許すは対象と影響を判断の材料（context）に書いたものがある。対象は本文の書体にし、` で囲んだ所と SHA・ブランチ名だけ等幅にする（追加 14）。
      return [fld('何が変わるか', rich(permitEffect(c), c.repo)), fld('対象', rich(permitTarget(c), c.repo, true)), fld('戻し方', esc(c.undo)), optionsHtml(r, ui)].join('')
    case 'send':
      // 何への返事かを開かずに分かるよう、相手の発言の原文を本文の上に置く（info-needs 3.5）。
      return fld('相手の発言', c.quote ? `<div class="quote verb">${esc(c.quote)}</div>` : '') + (c.draft ? `<div class="fld"><span class="lb">送る文面</span><div class="msg-to">宛先 <b>${esc(c.draft.to)}</b>${c.draft.via ? `　経路 ${esc(c.draft.via)}` : ''}</div><div class="msg">${esc(c.draft.text)}</div>${lintHtml(r)}</div>${optionsHtml(r, ui)}` : optionsHtml(r, ui))
    case 'stuck': {
      // 返事待ち・許可待ちは問いの本文と選択肢を先に出す（開かずに答えを決められるように）。読めなければ、読めなかったと書く。
      const a = r.agent
      const asking = a?.stop === 'waiting' || a?.stop === 'blocked'
      // 題に本文が全部出ている問いは本文を重ねない（初見 4）。件名が題のときと、長くて題で切ったときは本文を出す。選択肢は窓では選べないので、判断の押せる選択肢と見分けられるよう番号を付けず、どこで選ぶかを添える（初見 3）。
      const full = a?.ask && !c.title.endsWith(a.ask.text.trim()) ? clampQuote(a.ask.text, ui, `ask:${keyOf(r)}`) : ''
      const pick = c.id.startsWith('#ask:') ? `${r.owner.how === 'main' ? '窓口' : '担当'}に伝える` : `${a?.chat ? 'チャット' : '端末'}で選ぶ`
      const opts = a?.ask?.options?.length ? fld(`選択肢（${pick}）`, `<ul class="rich">${a.ask.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>`) : ''
      const unread = !a?.ask && asking ? `<p class="mut">${a.chat ? 'チャット' : '端末の画面'}から問いの本文を読めませんでした。開いて確認してください</p>` : ''
      return [fld(a?.ask?.kind === 'permit' ? '許可を求めていること' : '聞かれていること', full || unread), opts,
        a?.ask ? '' : fld('停止の理由', c.reason ? `<div class="quote code">${esc(c.reason)}</div>` : ''), c.since ? fld(a?.ask ? '聞いた日時' : '停止日時', esc(`${fmtDate(c.since)}${a?.ask ? `（${ago(c.since, now)}前）` : ''}`)) : '',
        fld(a?.ask ? '答え方' : '修正方法', esc(c.unblock ?? (c.answerable ? '答えれば進む' : ''))), optionsHtml(r, ui)].join('')
    }
    case 'consult':
      return [fld('論点', note(c.issue)), fld('担当の今の考え', rich(c.stance, c.repo)), fld('分かっていること', list(c.known)), fld('決めかねていること', list(c.undecided))].join('')
    case 'report':
      return `<ul class="done-list">${(c.done ?? []).map((d, n) =>
        `<li><span>${esc(d.what)}</span>${r.status === 'mine' ? `<button class="btn quiet" type="button" data-act="revert" data-target="${n}" data-key="${esc(keyOf(r))}">戻させる</button>` : ''}${d.why || d.undo ? `<small>${[d.why && `理由: ${d.why}`, d.undo && `戻し方: ${d.undo}`].filter(Boolean).map((x) => esc(x)).join('　')}</small>` : ''}</li>`).join('')}</ul>`
    case 'inbox':
      return [fld('届いた連絡', esc([c.from?.who, c.from?.via, c.from?.at && fmtDate(c.from.at)].filter(Boolean).join('　'))), fld('聞かれていること', esc(c.asked)), fld('振り分け', esc(c.routed))].join('')
    case 'talk':
      return [c.last ? fld('最後のやり取り', `<div class="quote">${esc(c.last.text)}</div>`) : '', fld('次', esc(c.next))].join('')
  }
}

/** 「詳細」に畳む欄（なぜ今・判断の材料の残り・確かめた結果・返事が無いとき・いきさつと出典）。最初に見せた欄は重ねない。 */
function moreView(r: VRow, svg: Svg): string {
  const c = r.card
  // 最初に見せた値は重ねない（判断のこれは何か・得失、許可で対象と影響の代わりに使った context の値）。
  const shown = c.kind === 'decide' ? ['what', 'gain', 'cost'] : c.kind === 'permit' ? [...(c.target?.trim() ? [] : ['what']), ...(c.effect?.trim() ? [] : ['gain'])] : []
  const ctxKeys = (['what', 'now', 'how', 'gain', 'cost'] as const).filter((k) => !shown.includes(k))
  const CTX: Record<string, string> = { what: 'これは何か', now: '今どうなっているか', how: '決めたらどうするか', gain: '得られること', cost: '失うこと' }
  const parts = [
    fld('なぜ今', c.why ? rich(c.why, c.repo) : ''),
    ...ctxKeys.map((k) => fld(CTX[k]!, rich(c.context?.[k], c.repo))),
    c.kind === 'review' && c.evidence?.length ? fld('確認した結果', `<ul class="rich">${c.evidence.map((x) => `<li>${mono(esc(x))}</li>`).join('')}</ul>`) : '',
    fld('返事が無いとき', note(c.fallback)),
    ...backgroundParts({ ...r, card: { ...c, ...(c.kind === 'decide' ? { compare: undefined, figure: undefined } : {}), ...(c.kind === 'send' ? { quote: undefined } : {}) } }, svg, r.v?.figures ?? {})
  ].filter(Boolean)
  const links = [
    ...(c.from?.href ? [{ label: '元の連絡', href: c.from.href }] : []),
    ...(c.draft?.href ? [{ label: '元のスレッド', href: c.draft.href }] : []),
    ...(c.href && c.kind !== 'review' ? [{ label: '開く', href: c.href }] : []),
    ...(c.diff && c.kind !== 'review' ? [{ label: '差分', href: c.diff }] : []),
    ...(c.links ?? [])
  ]
  if (links.length) parts.push(fld('資料', `<div class="links">${links.map((l) => linkBtn(l.label, l.href)).join('')}</div>`))
  return parts.join('')
}

/**
 * カードの相談のメモへのリンクと、相談で決まったこと（新しい返しから 3 件。info-needs 3.9）。返しごとに、窓口が帳簿に入れたか・保留かを札で出す。
 */
function consultHtml(memo: ConsultMemo | undefined, c: Card): string {
  if (!memo) return ''
  const state = (id: string) => (c.held_returns?.includes(id) ? tag('保留', 'wait') : c.from_returns?.includes(id) ? tag('反映済み') : tag('未反映', 'wait'))
  const got = [...memo.returns].reverse().flatMap((x) => [
    ...(typeof x.choice === 'string' && x.choice ? [{ text: `選んだ案: ${c.options?.find((o) => o.id === x.choice)?.label ?? x.choice}`, id: x.return_id }] : []),
    ...(Array.isArray(x.decisions) ? x.decisions : []).filter((d) => typeof d?.text === 'string' && d.text.trim()).map((d) => ({ text: d.text!, id: x.return_id }))
  ]).slice(0, 3)
  const link = `<div class="links">${linkBtn('相談のメモ', memo.path)}</div>`
  if (!got.length) return fld('相談のメモ', link)
  return fld('これまでに決まったこと', `<ul class="rich">${got.map((d) => `<li>${mono(note(d.text))}${state(d.id)}</li>`).join('')}</ul>${link}`)
}

// ── 窓から質問する（設計 11 章・R105。追加 24 の D） ──

/** 質問の欄の鍵。新しい質問は置き場所ごと（全体・カード・タスク）、続きは質問 id ごと。 */
export type AskScope = { kind: 'whole' } | { kind: 'card'; id: string } | { kind: 'task'; id: string } | { kind: 'id'; id: string }
/** 欄の鍵は案件の root を頭に持つ（案件を切り替えても、前の案件の下書き・当たり・待ちを別の案件に出さない。Codex 重大 2）。 */
export const askKey = (root: string, s: AskScope) => `${root}#${s.kind === 'whole' ? 'whole' : `${s.kind}:${s.id}`}`
/** 鍵の root より後（入力欄の id に使う。窓は 1 案件だけを描くので id は重ならない）。 */
const scopeOf = (key: string) => key.slice(key.lastIndexOf('#') + 1)
/** この案件のこの質問を待っているか（新しい質問の欄で送ったものも、続きの欄で送ったものも）。 */
export const askPending = (ui: Ui, root: string, id: string) => Object.entries(ui.askWait).find(([, w]) => w.root === root && w.ask === id && !w.error)
const RULING_KIND: Record<string, string> = { decision: '決定', constraint: '制約', permission: '許可', rejection: '却下' }
/** 答えが 3 分届かなければ、待つ表示をやめてタブを見るよう伝える（1 問目は 10 秒前後。担当の測定）。 */
const ASK_STALE_MS = 180_000

export function asksOf(b: Board, s: AskScope, ui: Ui): AskThread[] {
  const xs = (b.v.asks ?? []).filter((a) => (s.kind === 'whole' ? !a.card && !a.task : s.kind === 'card' ? a.card === s.id : a.task === s.id))
  // consult が端末を立てられずに頭だけ残した控えは出さない（この窓で待っているものは出す。Codex 中 3）。
  return xs.filter((a) => a.entries.length || a.returns.length || askPending(ui, b.root, a.id)).reverse()
}

function askWaitHtml(w: AskWait | undefined, now: number, id?: string, inThread = false): string {
  if (!w) return ''
  if (w.error) return `<div class="askst bad" role="alert"><b>窓口の写しを立てられませんでした</b><span>${esc(w.error)}</span><button class="btn quiet" type="button" data-ask="dismiss" data-scope="${esc(id ?? '')}">閉じる</button></div>`
  const sec = Math.max(0, Math.round((now - w.at) / 1000))
  if (now - w.at > ASK_STALE_MS && w.ask)
    return `<div class="askst" role="status"><b>3 分たっても答えが届いていません</b><span>写しの会話で止まっていないかを確認してください</span><button class="btn" type="button" data-ask="tab" data-id="${esc(w.ask)}">写しの会話を開く</button></div>`
  const what = w.ask ? `答えを待っています（${sec} 秒）` : `窓口の写しを立てています（${sec} 秒）`
  // 1 問目は 10 秒前後（担当の測定 7.6 秒）。30 秒を超えたら、開いて確かめる道を出す（初見 任意 1）。
  const slow = w.ask && now - w.at > 30_000
  const hint = slow ? '時間がかかっています' : w.ask && !w.answers ? '1 問目は 10 秒ほどかかります' : ''
  return `<div class="askst" role="status"><span class="spin" aria-hidden="true"></span><b>${what}</b>${hint ? `<span class="mut">${hint}</span>` : ''}${slow && !inThread ? `<button class="btn quiet" type="button" data-ask="tab" data-id="${esc(w.ask!)}">写しの会話を開く</button>` : ''}</div>`
}

function askHitsHtml(key: string, h: { q: string; hits: RulingHit[] } | undefined): string {
  if (!h) return ''
  return `<div class="hits"><div class="lb">判断の記録に当たりました（${h.hits.length} 件）<span class="mut">質問はまだ送っていません</span></div>
    <ul class="hl">${h.hits.map((x) => `<li><div class="hh"><span class="code">${esc(x.id)}</span><span class="mut">${esc([x.at && fmtDate(x.at), x.kind && RULING_KIND[x.kind]].filter(Boolean).join('・'))}</span></div><div class="ht">${esc(x.text)}</div>${x.quote ? `<div class="quote verb">${esc(x.quote)}</div>` : ''}</li>`).join('')}</ul>
    <div class="acts"><button class="btn pri" type="button" data-ask="go" data-scope="${esc(key)}">それでも窓口の写しに聞く</button><button class="btn quiet" type="button" data-ask="clear" data-scope="${esc(key)}">閉じる</button></div></div>`
}

/** 返しの札。窓口が帳簿に入れたか・保留か・担当にまだ伝えていないか（帳簿の asks[] で決める。判断の記録は窓に送っていない）。 */
function askReturnsHtml(b: Board, a: AskThread): string {
  const rec = b.v.cockpit!.asks?.find((x) => x.id === a.id)
  const state = (id: string) => [
    rec?.held_returns?.includes(id) ? tag('窓口が保留', 'wait') : rec?.from_returns?.includes(id) ? tag('窓口が反映済み') : tag('窓口の反映待ち', 'wait'),
    rec?.notify?.some((n) => n.return_id === id && !n.message_id) ? tag('担当へ未通知', 'wait') : ''
  ].join('')
  const rows = [...a.returns].reverse().map((r) => {
    const ds = (r.decisions ?? []).map((d) => d.text).filter((t): t is string => !!t)
    return ds.length ? ds.map((t) => `<li>${mono(note(t))}${state(r.return_id)}</li>`).join('') : `<li class="mut">決まったことなし${state(r.return_id)}</li>`
  })
  return rows.length ? fld('窓口に返したこと', `<ul class="rich">${rows.join('')}</ul>`) : ''
}

function askDecidedHtml(b: Board, a: AskThread): { html: string; n?: number } {
  const undone = new Set(b.v.log.ops.filter((o) => o.type === 'undo').map((o) => o.undo_of))
  const ops = b.v.log.ops.filter((o) => o.type === 'ask_decide' && o.item_id === askItem(a.id) && !undone.has(o.op_id))
  const o = ops.at(-1)
  if (!o) return { html: '' }
  // 窓に分かるのは返しの記録があるかだけ（知らせが届いたかは分からない。Codex 軽微 3）。
  const got = a.returns.some((r) => String(r.op) === String(o.op_id))
  return { html: `<p class="askdone"><b>${o.answer?.at ? `答え ${esc(o.answer.at)} を` : ''}窓口に返すよう依頼しました</b><span class="mut">${esc(fmtDate(o.at))}</span>${got ? tag('写しが返しました') : tag('写しからの返し待ち', 'wait')}</p>`, n: o.answer?.n }
}

function askThreadHtml(b: Board, a: AskThread, ui: Ui, now: number): string {
  const pend = askPending(ui, b.root, a.id)
  const qs = a.entries.filter((e) => e.kind === 'q')
  const entries: AskEntry[] = pend && qs.at(-1)?.text.trim() !== pend[1].q ? [...a.entries, { kind: 'q', time: '', text: pend[1].q }] : a.entries
  const last = entries.map((e, i) => (e.kind === 'q' ? i : -1)).filter((i) => i >= 0).at(-1) ?? 0
  const older = entries.slice(0, last).filter((e) => e.kind !== 'n')
  const olderQs = older.filter((e) => e.kind === 'q').length
  // 前の答えで決めた行は、その答えと一緒に畳んだ側へ置く（新しい質問の結果に見えないように。初見 2 巡目）。
  const done = askDecidedHtml(b, a)
  const recent = entries.slice(last)
  const entry = (e: AskEntry) => {
    if (e.kind === 'q') return `<div class="aq"><span class="mut">${e.time ? `質問 ${esc(e.time)}` : '送った質問'}</span><div class="verb">${esc(e.text)}</div></div>`
    if (e.kind === 'n') return ''
    const p = answerParts(e.text)
    const at = p.at ?? a.at
    return `<div class="aa"><span class="mut">答え ${esc(e.time)}${at ? `（窓口の ${esc(at)} までの会話から）` : ''}</span>${rich(p.body, b.v.cockpit!.tasks.find((t) => t.id === a.task)?.repo, true)}</div>`
  }
  // 決める候補は最後の質問より後の答えだけ（続きの答えを待つあいだ、前の答えで決めさせない。Codex 重大 3）。控えの全文から常駐のプロセスが出す。
  const answer = pend ? undefined : a.decide
  const undone = new Set(b.v.log.ops.filter((o) => o.type === 'undo').map((o) => o.undo_of))
  const decided = b.v.log.ops.some((o) => o.type === 'ask_decide' && o.item_id === askItem(a.id) && !undone.has(o.op_id) && o.answer?.n === answer?.n && o.answer?.at === answer?.at)
  // 開き直した窓・別の窓で送った質問も、答えが届くまで続きを送らせない（Codex 2 回目 中 1）。
  const waiting = !!pend || unanswered(a.entries)
  const doneHere = !waiting && done.n === a.decide?.n
  const fk = askKey(b.root, { kind: 'id', id: a.id })
  const fail = ui.askWait[fk]?.error ? ui.askWait[fk] : undefined
  // 答えを待つあいだは続きを送らせない（先の答えで両方の待ちが消えるため。Codex 中 4・Neon）。
  const follow = ui.open[`askf:${fk}`] && !waiting
    ? `<div class="askin"><label class="lb" for="ask-${esc(scopeOf(fk))}">同じ相手に続けて聞く</label><textarea id="ask-${esc(scopeOf(fk))}" data-askdraft="${esc(fk)}" rows="4" maxlength="${TEXT_MAX}">${esc(ui.askDraft[fk] ?? '')}</textarea>
      <div class="acts"><button class="btn pri" type="button" data-ask="send" data-scope="${esc(fk)}"${(ui.askDraft[fk] ?? '').trim() ? '' : ' disabled'}>送る</button><button class="btn quiet" type="button" data-ask="more" data-scope="${esc(fk)}" aria-expanded="true">閉じる</button></div></div>`
    : ''
  return `<li class="askt">
    ${older.length ? fold(ui, `asko:${fk}`, `前のやり取りを見る（${olderQs} 問）`, older.map(entry).join('') + (doneHere ? '' : done.html)) : doneHere ? '' : done.html}
    ${recent.map(entry).join('')}
    ${askWaitHtml(pend?.[1] ?? fail, now, fk, true)}${waiting && !pend ? '<p class="mut">まだ答えが届いていません</p>' : ''}
    ${askReturnsHtml(b, a)}${doneHere ? done.html : ''}
    <div class="acts">${answer && !decided ? `<button class="btn" type="button" data-ask="decide" data-id="${esc(a.id)}" data-at="${esc(answer.at)}" data-head="${esc(answer.head)}" data-n="${answer.n}">この答えを窓口に返す</button>` : ''}
      ${waiting || ui.open[`askf:${fk}`] ? '' : `<button class="btn quiet" type="button" data-ask="more" data-scope="${esc(fk)}" aria-expanded="${!!ui.open[`askf:${fk}`]}">続けて聞く</button>`}
      <button class="btn quiet" type="button" data-ask="tab" data-id="${esc(a.id)}">写しの会話を開く</button></div>
    ${follow}</li>`
}

export function askHtml(b: Board, s: AskScope, ui: Ui, now: number): string {
  const key = askKey(b.root, s)
  const xs = asksOf(b, s, ui)
  const w = ui.askWait[key]
  const busy = !!w && !w.error
  const target = s.kind === 'card' ? 'このカードについて質問する' : s.kind === 'task' ? 'このタスクについて質問する' : '案件について質問する'
  // 全体はこの窓で聞いた質問そのものを開き、残り（前の質問・別の窓の質問）を畳む（Codex 2 回目 軽微）。カード・タスクは新しい 3 つ。
  const top = s.kind === 'whole' ? xs.filter((a) => ui.askMine[`${b.root}#${a.id}`]) : xs.slice(0, 3)
  const rest = xs.filter((a) => !top.includes(a))
  const list = (ys: AskThread[]) => (ys.length ? `<ul class="asks" role="list">${ys.map((a) => askThreadHtml(b, a, ui, now)).join('')}</ul>` : '')
  const open = s.kind === 'whole' || xs.length > 0 || !!w || !!ui.askDraft[key] || !!ui.askHits[key] || !!ui.open[`aski:${key}`]
  if (!open) return `<section class="ask" aria-label="質問"><div class="acts"><button class="btn quiet" type="button" data-ask="open" data-scope="${esc(key)}">${target}</button></div></section>`
  return `<section class="ask" aria-label="質問">
    <div class="askin"><label class="lb" for="ask-${esc(scopeOf(key))}">${target}</label>
      <textarea id="ask-${esc(scopeOf(key))}" data-askdraft="${esc(key)}" rows="4" maxlength="${TEXT_MAX}">${esc(ui.askDraft[key] ?? '')}</textarea>
      <div class="acts"><button class="btn${ui.askHits[key] ? '' : ' pri'}" type="button" data-ask="send" data-scope="${esc(key)}"${busy || !(ui.askDraft[key] ?? '').trim() ? ' disabled' : ''}>送る</button></div></div>
    ${askHitsHtml(key, ui.askHits[key])}${w && !(w.ask && xs.some((a) => a.id === w.ask)) ? `${w.q ? `<div class="aq pend"><span class="mut">送った質問</span><div class="verb">${esc(w.q)}</div></div>` : ''}${askWaitHtml(w, now, key)}` : ''}
    ${list(top)}${rest.length ? fold(ui, `askold:${key}`, `ほかの質問を見る（${rest.length} 件）`, list(rest)) : ''}
  </section>`
}

function detail(b: Board, r: VRow, ui: Ui, now: number, svg: Svg, next?: string, closed = false): string {
  const c = r.card
  const s = r.stream
  const t = taskOf(b, r)
  const crumbs = [esc(b.v.cockpit!.workspace.name), esc(s?.title ?? '仕事の割り当てなし'), t && esc(t.task.title)].filter(Boolean) as string[]
  const notes = [
    r.talking ? `<div class="note wait"><b>協議中</b>　${esc(fmtDate(r.talking.since))} から・${esc(r.owner.how === 'main' ? '窓口' : `担当（${r.owner.title}）`)}</div>` : '',
    r.status === 'fixing' ? `<div class="note wait"><b>${r.pending ? '修正依頼済み（受領待ち）' : '修正待ち'}</b></div>` : '',
  ].join('')
  // 対応済みは返した答えが主役。頼んだ中身（手順・選択肢）は「詳しく」に畳む。
  const first = closed ? '' : firstView(r, ui, svg, now)
  const more = (closed ? firstView(r, ui, svg, now) : '') + moreView(r, svg)
  const moreOpen = ui.open['detail-more'] ?? false
  const acts = actsHtml(r, ui, true)
  // 「次へ」は一覧を進む操作なので、答える操作の帯ではなく詳細の上に置く（1280 で帯が折り返さないように）。
  const nextBtn = next ? `<button class="nxl" type="button" data-sel="${esc(next)}">次へ（j）</button>` : ''
  const ops = sentOps([c], b.v.log, b.v.cockpit!.applied_ops)
  const sent = sentHtml(ops)
  // 対応済みの返した答えは「出した指示」の 1 行で読む（囲みの箱で重ねない。初見 2 巡目 5）。閉じる操作の記録が無い閉じ方（担当が完了・協議のあと帳簿に記録など）だけ、結果の 1 行を出す。
  // 前の版への答えでは今の版の答えを読めないので、今の版を閉じた操作があるときだけ結果の行を省く。
  const result = closed && !ops.some((o) => !OPEN_ONLY.includes(o.op.type) && o.op.item_rev === c.rev)
    ? `<div class="first">${fld('結果', esc(`${r.how ?? ''}　${fmtDate(r.when)}${c.resolved_at_inferred ? '（時刻は推定）' : ''}${r.pending ? '・窓口の受け取り待ち' : c.resolved_by === 'user' ? '・深田さんの回答' : ''}${c.closed_without_review ? '・確認の返答なし' : ''}`))}</div>`
    : ''
  const consult = consultHtml(b.v.consults?.find((m) => m.card === c.id), c)
  return `<div class="wdet k-${c.kind}">
    <div class="dh"><div class="crumbs">${crumbs.map((x) => `<span>${x}</span>`).join('<i>›</i>')}${nextBtn}</div>
      <div class="kl"><span class="kd">${kindName(c)}</span>${dueHtml(c.due, now)}</div>
      <h2>${esc(c.title)}</h2><div>${r.agent?.ask?.from ? `<span class="owner">${esc(r.agent.ask.from)}</span>` : ownerHtml(r.owner, r.agent ? false : b.v.owners, s?.title)}</div></div>
    ${c.purpose ? `<p class="purp">${note(c.purpose)}</p>` : ''}${notes}${result}${first ? `<div class="first">${first}</div>` : ''}${consult ? `<div class="first">${consult}</div>` : ''}${sent}
    ${more ? `<details class="more-d" data-fold="detail-more"${moreOpen ? ' open' : ''}><summary>${closed ? '詳細（依頼内容・判断材料・出典）' : '詳細（判断材料・出典）'}</summary><div class="slots">${more}</div></details>` : ''}
    ${closed ? '' : otherHtml(r, ui)}
    ${c.id.startsWith('#') ? '' : askHtml(b, { kind: 'card', id: c.id }, ui, now)}
    ${c.id.startsWith('#') ? '' : ridHtml(c.id)}
    <div class="dbtn">${acts}</div></div>`
}

/** 出した指示のうち、カードを閉じない操作（協議の開始・修正の依頼・戻す依頼）。 */
const OPEN_ONLY: OpType[] = ['talk', 'revert']

/** 番号は一覧に出さず、詳細の下に小さく置く（深田さんが番号で指せるように。R67・初見 2）。 */
const ridHtml = (id: string) => `<p class="rid">番号<code>${esc(id)}</code></p>`

// ── 全体 ──
const tasksOf = (b: Board, sid: string) => [...b.d.tasks.values()].filter((t) => t.task.stream === sid)
const TSTATE: Record<TaskState, string> = { ok: '完了', run: '作業中', wait: '待機', stop: '停止', idle: '未着手' }
/**
 * 5 つの工程の語を並べ、今の段を太字にする（分数は何の段か読めない。R126）。済んだ段は薄く、まだの段は済んだ段より濃く（色は足さない。R91）。
 * short は一覧の行の幅が足りないときに出す、今の段の語だけの形（style.ts の .stg-now）。語だけだと仕事の名前の続きに読めるので「工程」を添える（初見）。
 */
export function stagesHtml(at: number, short = false): string {
  const words = STAGES.map((s, i) => (i < at ? `<span class="sd">${s}</span>` : i === at ? `<b class="sc">${s}</b>` : `<span class="sn">${s}</span>`))
  return `<span class="stg"><span class="stg-all">${words.join('<span class="sep">・</span>')}</span>${short ? `<span class="stg-now">工程 <b>${STAGES[at] ?? ''}</b></span>` : ''}</span>`
}

/**
 * 工程の進み。済んでいないタスクのうちいちばん前の段を今の段にし、それより前を済んだ段にする。
 * 段に寄せられない工程名の未完了タスクがあれば、段も完了の印も決めない（推測で入れない・先の段まで済んだように見せない）。
 * 「全工程 完了」は仕事そのものが済のときだけ。タスクが全部済でもカードが残る仕事は確認待ちと出す。見張る仕事は段を持たない。
 */
function phaseBar(ts: TaskView[], form?: StreamForm, job?: JobState): string {
  if (form === 'watch') return ''
  if (!ts.length) return '<span class="pbar mut">タスクなし</span>'
  const live = ts.filter((t) => t.state !== 'ok')
  const unsorted = live.some((t) => !stageOf(t.task.phase))
  const at = !live.length ? STAGES.length : unsorted ? -1 : Math.min(...live.map((t) => STAGES.indexOf(stageOf(t.task.phase)!)))
  const name = live.length ? (unsorted ? '工程の外あり' : stagesHtml(at, true))
    : job === 'done' ? '全工程 完了' : job === 'mine' ? 'タスク完了・確認待ち' : job === 'customer' ? 'タスク完了・顧客待ち' : 'タスク完了'
  return `<span class="pbar">${name}</span>`
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
  // viewWhole の並び（形のある仕事 → 形の無い仕事 → 結ばれていないタスク → 見張る）と同じにする。
  const of = (js: JobView[]) => js.flatMap((j) => stageGroups(tasksOf(b, j.id)).flatMap(([, xs]) => xs))
  const byForm = (f: StreamForm) => live.filter((j) => formOf(b, j.id) === f)
  return [...of(FORM_ORDER.filter((f) => f !== 'watch').flatMap(byForm)), ...of(live.filter((j) => !formOf(b, j.id))), ...looseTasks(b), ...of(byForm('watch'))].map((t) => t.task.id)
}

/**
 * 一覧と詳細に出すタスクの状態。帳簿が作業中でも、そのタスクのエージェントが停止（質問・許可待ちなど）で要対応に出ていれば停止と出す
 * （同じ行に「作業中」と「停止を開く」が並ぶと、止まっているものを読み違える。初見 2 巡目の追加）。
 */
const stateOf = (t: TaskView, rows: Row[]): TaskState => (t.state !== 'ok' && rows.some((r) => r.status === 'mine' && r.card.kind === 'stuck') ? 'stop' : t.state)

/** 一緒に作る仕事で担当が深田さんの返事を待っているタスク（R128）。状態は「返事待ち（あなた）」と出す。 */
const replyWait = (rows: Row[]) => rows.some((r) => r.card.id.startsWith(COWORK_ID) && !!r.agent?.ask)

function taskRow(t: TaskView, todo: Map<string, VRow[]>, cur: string | undefined): string {
  const st = stateOf(t, todo.get(t.task.id) ?? [])
  const reply = st !== 'ok' && replyWait(todo.get(t.task.id) ?? [])
  const chips = (todo.get(t.task.id) ?? []).map((r) => `<button type="button" class="chip kc k-${r.card.kind}" data-jump="${esc(keyOf(r))}" title="要対応で開く: ${esc(r.card.title)}">${kindName(r.card)}を開く</button>`).join('')
  const sub = t.task.waiting_on ? `待ち: ${t.task.waiting_on}` : t.task.next ? `次: ${t.task.next}` : ''
  const subHtml = sub && note(sub)
  // 協議のボタンはタスクの詳細（右）にだけ置く（行ごとに同じボタンを並べない。初見 1）。
  return `<div class="task"><button type="button" class="tsel" data-task="${esc(t.task.id)}" aria-current="${cur === t.task.id}"><span class="tst s-${reply ? 'stop' : st}">${reply ? REPLY_LABEL : TSTATE[st]}</span>
    <span class="tn"><span>${esc(t.task.title)}</span>${sub ? `<span class="nx">${mono(subHtml)}</span>` : ''}</span></button>
    <span class="wk">${chips}</span></div>`
}

const PILL: Record<JobState, string> = { mine: '要対応', stopped: '停止中', working: '作業中', customer: '顧客待ち', idle: '未着手', done: '完了' }

function streamBox(b: Board, j: JobView, ui: Ui, todo: Map<string, VRow[]>): string {
  const s = b.v.cockpit!.streams.find((x) => x.id === j.id)
  const ts = tasksOf(b, j.id)
  const done = ts.filter((t) => t.state === 'ok').length
  // 箱は閉じて置き、中（工程・タスク）は開いて取りに行く（R33・R81）。右に詳細を出しているタスクの箱は開いておく。
  const open = ui.open[`s:${j.id}`] ?? ts.some((t) => t.task.id === ui.task)
  // 要対応に停止で出ている worker は作業中に数えない（Neon 初見 2 巡目）。
  const halted = ts.filter((t) => t.why === 'working' && stateOf(t, todo.get(t.task.id) ?? []) === 'stop').length
  const working = ts.filter((t) => t.why === 'working').length - halted
  const label = j.state === 'mine' ? [j.reply && REPLY_LABEL, j.mine && `要対応 ${j.mine} 件`].filter(Boolean).join('・') : j.state === 'customer' ? j.label : PILL[j.state]
  const groups = stageGroups(ts)
  // 選べるタスクが無い仕事は右に詳細を出せないので、協議のボタンを箱の中に置く。
  const talk = groups.length ? '' : `<div class="acts"><button class="btn talk" type="button" data-talkstream="${esc(j.id)}">${j.owner ? '担当と協議' : '窓口と協議'}</button></div>`
  const inner = open
    ? groups.map(([ph, xs]) => `<div class="phase">${esc(ph)}${stageOf(ph) ? '' : tag('工程の外', 'wait')}</div>${xs.map((t) => taskRow(t, todo, ui.task)).join('')}`).join('')
      + (done ? `<div class="donebox">完了タスク ${done} 件</div>` : '') + talk
    : ''
  // 一覧の 1 行。状態は語 1 つ（色は要対応と停止だけ）、次にやることを工程より先に読ませる（初見 4・5）。協議は右の詳細から。
  const who = [j.owner && j.owner.title !== j.title && `担当: ${esc(j.owner.title)}`, working && `worker ${working} 件作業中`, halted && `worker ${halted} 件停止`].filter(Boolean).join('・')
  return `<div class="st f-${s?.form ?? 'none'}"><div class="sh">
    <button type="button" class="t" data-toggle="s:${esc(j.id)}" aria-expanded="${open}"><span class="nm">${esc(j.title)}</span><span class="pst ${j.state}${j.reply ? ' reply' : ''}">${esc(label)}</span></button>
    <span class="right"><span class="prog">${phaseBar(ts, s?.form, j.state)}</span></span>
    ${j.next && !open ? `<span class="nxt">次: ${mono(note(j.next))}</span>` : ''}${who ? `<span class="meta">${who}</span>` : ''}</div>
    ${open ? `<div class="inner${ts.some((t) => replyWait(todo.get(t.task.id) ?? [])) ? ' wide' : ''}">${inner || '<span class="mut">なし</span>'}</div>` : ''}</div>`
}

/** 出した指示（新しい順）。jump はどのカードへの指示かを頭に出すとき（タスクの詳細）の、カードを開けるか（開けるならその key）。 */
function sentHtml(xs: Sent[], jump?: (c: Card) => string | undefined): string {
  if (!xs.length) return ''
  const id = (c: Card) => {
    const k = jump?.(c)
    return k ? `<button type="button" class="code" data-jump="${esc(k)}">${esc(c.id)}</button>` : `<span class="code">${esc(c.id)}</span>`
  }
  return `<div class="sent fld"><span class="lb">出した指示</span><ol>${xs.map((s) => `<li><span class="sl"><span class="tm">${esc(fmtDate(s.op.at))}</span>${jump ? id(s.card) : ''}<b>${esc(s.label)}</b>${s.applied ? tag('反映済み') : tag('未反映', 'wait')}</span>${s.text ? `<div class="quote verb">${esc(s.text)}</div>` : ''}</li>`).join('')}</ol></div>`
}

const CARD_STATE = { mine: '要対応', fixing: '修正待ち', waiting: '顧客待ち', closed: '対応済み' } as const

/** 全体の右: 押したタスクの詳細（info-needs 4.2 の順）。開いたカードは要対応か対応済みの一覧にあれば押してそのカードへ移る。 */
function taskDetail(b: Board, t: TaskView, ui: Ui, nowMs: number): string {
  const c = b.v.cockpit!
  const task = t.task
  const s = c.streams.find((x) => x.id === task.stream)
  const st = stageOf(task.phase)
  const a = b.v.workers.find((w) => w.task === task.id)
  const owner = b.d.jobs.find((j) => j.id === task.stream)?.owner
  // 済んだカードは表示の 14 日を過ぎても対応済みのタブで開く（settled は期間外も持つ）。
  const listed = new Set([...todoOrder(b), ...b.d.reports.map(keyOf), ...b.d.settled.map(keyOf)])
  const cards = [...b.d.views.map((v) => ({ ...v, root: b.root })), ...b.d.queue.filter((r) => isSynthetic(r.card.id))].filter((v) => v.card.tasks?.includes(task.id))
  // 頼んでいることは済んでいないカードだけ（済んだものは「出した指示」で返答を読める）。
  const asking = cards.filter((v) => v.status !== 'closed')
  const cardLine = (v: (typeof cards)[number]) => {
    const k = keyOf(v)
    const state = v.card.kind === 'consult' ? '相談' : v.card.kind === 'report' ? '報告' : CARD_STATE[v.status]
    // 停止は一覧の行と同じく危険の色にする（Neon 追加 23）。
    const inner = `<span class="kd${v.card.kind === 'stuck' ? ' hotc' : ''}">${kindName(v.card)}</span><span class="ti">${esc(v.card.title)}</span><span class="${v.status === 'waiting' ? 'mut' : 'now'}">${esc(state)}</span>`
    return listed.has(k) ? `<button type="button" class="lc" data-jump="${esc(k)}">${inner}</button>` : `<div class="lc">${inner}</div>`
  }
  // 状態は一覧の行と同じ根拠（要対応の行）で決める。
  const shown = stateOf(t, b.d.queue.filter((r) => r.card.tasks?.includes(task.id)))
  const reply = shown !== 'ok' && replyWait(b.d.queue.filter((r) => r.card.tasks?.includes(task.id)))
  const reqs = b.d.requests.filter((r) => r.req.tasks?.includes(task.id))
  // 済の条件はチェックの形にする（「未」の 1 字で示さない。初見 13）。読み上げには語を渡す。
  const conds = reqs.flatMap((r) => (r.req.done_when ?? []).map((w, i) => `<li class="${r.covered[i] ? 'ok' : ''}"><span class="cb" role="img" aria-label="${r.covered[i] ? '済' : '未'}"></span>${esc(w)}</li>`))
  const origin = reqs.map((r) => {
    const quote = r.req.utterances?.map((u) => u.quote).join('\n') || r.req.quote || ''
    return `<div class="rqd"><div><span class="code">${esc(r.req.id)}</span>${esc(r.req.title)}<span class="rst">${esc(r.state)}</span></div>${clampQuote(quote, ui, `cont:${task.id}:${r.req.id}`)}</div>`
  }).join('')
  const now = task.waiting_on ? `待ち: ${task.waiting_on}${task.waiting_since ? `（${fmtDate(task.waiting_since)} から）` : ''}` : task.next ? task.next : ''
  const worker = task.worker
    ? `<div class="wk2"><span class="mut">worker</span><b>${esc(a?.title ?? task.title)}</b>${shown === 'stop' && t.why !== 'stopped' ? '<span class="chip bad">停止</span>' : `<span class="chip${t.why === 'working' ? ' live' : t.why === 'stopped' || t.why === 'missing' ? ' bad' : ''}">${esc(workerState(t))}</span>`}${a?.where ? `<span class="mut">今: ${esc(a.where)}</span>` : ''}${a ? `<button type="button" class="act" data-term="${esc(a.terminalId ?? '')}" data-wt="${esc(a.worktree ?? '')}">${a.chat ? 'チャットを開く' : '端末を開く'}</button>` : ''}</div>`
    : ''
  const who = [owner && (owner.title !== s?.title || owner.state) ? `<div class="wk2"><span class="mut">担当</span>${owner.title === s?.title ? '' : `<b>${esc(owner.title)}</b>`}${owner.state ? `<span class="chip">${esc(OWNER_STATE[owner.state] ?? owner.state)}</span>` : ''}</div>` : '', worker].join('')
  // 済んだ作業は新しい順に 3 件、残りは畳む（帳簿の done は書いた順に足していく）。
  const done = [...(task.done ?? [])].reverse().map((d) => `<li>${mono(esc(doneText(d)))}</li>`)
  const doneHtml = done.length ? `<ul class="rich">${done.slice(0, 3).join('')}</ul>${done.length > 3 ? fold(ui, `done:${task.id}`, `残り ${done.length - 3} 件`, `<ul class="rich">${done.slice(3).join('')}</ul>`) : ''}` : ''
  const srcs = (task.sources ?? []).filter((x) => /^(https?:\/\/|\/|~\/)/.test(x))
  const first = [
    fld('何のため', note(task.goal)),
    conds.length ? fld('済の条件', `<ol class="dw">${conds.join('')}</ol>`) : '',
    fld(task.waiting_on ? '待っているもの' : '次にやること', now ? mono(note(now)) : ''),
    fld('依頼していること', asking.map(cardLine).join('')),
    fld('依頼の原文', origin)
  ].join('')
  const second = [
    fld('進め手', who),
    fld('済んだこと', doneHtml),
    fld('資料', srcs.length ? `<div class="links">${srcs.map((x) => linkBtn(x.split('/').filter(Boolean).pop() ?? x, x)).join('')}</div>` : '')
  ].join('')
  const sent = sentHtml(sentOps(cards.map((v) => v.card).filter((x) => !isSynthetic(x.id)), b.v.log, c.applied_ops), (x) => (listed.has(keyOf({ root: b.root, card: x })) ? keyOf({ root: b.root, card: x }) : undefined))
  const talk = task.stream ? `<div class="acts"><button class="btn talk" type="button" data-talkstream="${esc(task.stream)}">${owner ? '担当と協議' : '窓口と協議'}</button></div>` : ''
  return `<div class="wdet">
    <div class="dh"><div class="crumbs">${[c.workspace.name, s?.title ?? '仕事の割り当てなし'].map((x) => `<span>${esc(x)}</span>`).join('<i>›</i>')}</div>
      <div class="kl"><span class="tst s-${reply ? 'stop' : shown}">${reply ? REPLY_LABEL : TSTATE[shown]}</span><span class="mut">${st ? `工程 ${stagesHtml(STAGES.indexOf(st))}` : esc(`工程の外（${task.phase}）`)}</span></div>
      <h2>${esc(task.title)}</h2></div>
    ${first ? `<div class="first facts">${first}</div>` : ''}${sent}${second ? `<div class="first facts">${second}</div>` : ''}
    ${askHtml(b, { kind: 'task', id: task.id }, ui, nowMs)}
    ${ridHtml(task.id)}
    ${talk ? `<div class="dbtn">${talk}</div>` : ''}</div>`
}

/** タスクの無い済んでいない依頼（info-needs Q3）。一番下に件数の 1 行、開くと並ぶ。0 件なら出さない。 */
function noTaskRequests(b: Board, ui: Ui): string {
  const xs = b.d.requests.filter((r) => r.state !== '済' && !r.tasks.length)
  if (!xs.length) return ''
  return `<details class="ntr" data-fold="notask"${ui.open.notask ? ' open' : ''}><summary>タスクの無い依頼 ${xs.length} 件</summary><ul>${xs.map((r) => `<li><span class="code">${esc(r.req.id)}</span>${esc(r.req.title)}<span class="rst">${esc(r.state)}</span></li>`).join('')}</ul></details>`
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
    return `<li class="rrow"><span>${esc(r.label)}</span>${p ? `<span class="hotc">${esc(p.slice(r.label.length + 2))}</span>` : r.read_at ? `<span class="mut at">最終確認 ${esc(nearDate(r.read_at, now))}</span>` : ''}</li>`
  })
  const sec = (f: StreamForm, extra = '') => {
    const xs = live.filter((j) => form(j) === f)
    return `<section class="fsec"><h3>${formChip(f)}<span class="mut">${esc(FORM_DESC[f])}</span>${xs.length ? `<span class="mut">${xs.length} 件</span>` : ''}</h3>${xs.map((j) => streamBox(b, j, ui, todo)).join('')}${extra}</section>`
  }
  // 中身の無い欄は出さない（初見 12）。
  const watchExtra = `<div class="watch">${routes.length ? `<div class="subh">見張っている経路</div><ul class="rows" role="list">${routes.join('')}</ul>` : ''}
    ${inbox.length ? `<div class="subh">届いた連絡 ${inbox.length} 件</div><div class="strips">${inbox.map((r) => stripHtml(r, ui, now, svg, false)).join('')}</div>` : ''}</div>`
  const noForm = live.filter((j) => !form(j))
  const loose = looseTasks(b)
  // 進行中の仕事のある置き場所を先に、空の置き場所は最後に 1 行でまとめる（見張るは経路と届いた連絡があれば空にしない）。
  const filled = (f: StreamForm) => live.some((j) => form(j) === f) || (f === 'watch' && (routes.length > 0 || inbox.length > 0))
  const ms = upcomingMilestones(c.workspace.milestones, now)[0]
  const main = askHtml(b, { kind: 'whole' }, ui, now) + (ms ? `<p class="mut">次の節目: ${esc(ms.label)}（${esc(fmtDate(ms.date))}）</p>` : '')
    // 仕事の一覧を先に、見張る（経路と届いた連絡）は最後に置く。空の置き場所は出さない。
    + FORM_ORDER.filter((f) => f !== 'watch' && filled(f)).map((f) => sec(f)).join('')
    + (noForm.length ? `<section class="fsec"><h3><span>進行中の仕事</span><span class="mut">${noForm.length} 件</span></h3>${noForm.map((j) => streamBox(b, j, ui, todo)).join('')}</section>` : '')
    + (loose.length ? `<section class="fsec"><h3><span>仕事に結ばれていないタスク</span><span class="mut">${loose.length} 件</span></h3><div class="st"><div class="inner">${loose.map((t) => taskRow(t, todo, ui.task)).join('')}</div></div></section>` : '')
    + (filled('watch') ? sec('watch', watchExtra) : '')
    + noTaskRequests(b, ui)
    + (done.length ? `<button type="button" class="wmore" data-toggle="done" aria-expanded="${!!ui.open.done}">${ui.open.done ? '完了した仕事を閉じる' : `完了した仕事 ${done.length} 件を表示`}</button>${ui.open.done ? done.map((j) => streamBox(b, j, ui, todo)).join('') : ''}` : '')
  const t = b.d.tasks.get(ui.task ?? '')
  return `<div class="wpane" aria-label="全体">${main}</div><aside class="wside" aria-label="タスクの詳細">${t ? taskDetail(b, t, ui, now) : ''}</aside>`
}

function viewDone(b: Board, ui: Ui, now: number, svg: Svg): string {
  const groups = closedGroups(b)
  // 仕事ごとに畳めるようにする（件数が多いと 1 本の長い一覧になるため。初見 10）。既定は選んでいるカードのある仕事と、先頭の仕事を開く。
  const list = groups.map(([sid, xs], i) => {
    const key = doneFold(xs[0]!.card)
    const open = ui.open[key] ?? (i === 0 || xs.some((r) => keyOf(r) === ui.doneSel))
    return `<details class="sgrp" data-fold="${esc(key)}"${open ? ' open' : ''}><summary>${groupHead(b, sid, xs, true)}</summary><div class="rows">${xs.map((r) => cardRow(b, r, ui.doneSel, now, true)).join('')}</div></details>`
  }).join('')
  // タスクの詳細から開いた期間外のカードは、一覧に無くても詳細を出す。
  const cur = vrows(b, b.d.settled).find((r) => keyOf(r) === ui.doneSel)
  return `<div class="wpane" aria-label="対応済み"><p class="mut">直近 14 日・新しい順</p>${list || '<div class="calm"><b>対応済み 0 件</b></div>'}</div>
    <aside class="wside" aria-label="詳細">${cur ? detail(b, cur, ui, now, svg, undefined, true) : ''}</aside>`
}

export function renderWindow(m: Model, ui: Ui, now: number, svg: Svg): string {
  const b = boardOf(m, ui.filter)
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
  // 要対応の件数だけを濃く出す。対応済みの件数は返すものではないので弱く出す。
  const tabBtn = (k: Tab, label: string, n?: number, quiet = false) =>
    `<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${n === undefined ? '' : `<span class="n${n && !quiet ? '' : ' z'}">${n}</span>`}</button>`
  const stuck = b.d.counts.stuck
  const total = COUNTED.reduce((n, k) => n + b.d.counts[k], 0)
  const body = tab === 'todo' ? viewTodo(b, ui, now, svg) : tab === 'whole' ? viewWhole(b, ui, now, svg) : viewDone(b, ui, now, svg)
  const open = ui.sideOpen !== false
  const front = m.boards.find((x) => x.root === m.focused)
  const orcaBtns = `<span class="orcab"><button class="btn quiet" type="button" data-orca="open">Orca で開く</button><button class="btn quiet" type="button" data-orca="sync"${!front || front.root === b.root ? ' disabled' : ''}>Orca に合わせる</button></span>`
  return `<div class="ck win${open ? ' side-open' : ''}" data-theme="${ui.dark ? 'dark' : 'light'}">
    <div class="wtop"><button class="sidebtn" type="button" data-side="toggle" aria-controls="wcases" aria-expanded="${open}">案件の一覧</button><span class="pj">${esc(b.v.cockpit!.workspace.name)}</span>
      <div class="tabs" role="tablist">${tabBtn('todo', '要対応', total)}${tabBtn('whole', '全体')}${tabBtn('done', '対応済み', b.d.closed.length, true)}</div>
      <div class="flags">${stuck ? `<span class="err">停止中 ${stuck} 件</span>` : ''}
        ${orcaBtns}${theme}</div></div>
    <div class="wmain">${open ? `${casesSide(m, b, orcaBtns)}<button class="wscrim" type="button" data-side="close" aria-label="案件の一覧を閉じる"></button>` : ''}<div class="wcol">
    ${hard.length ? `<div class="werrs" role="alert">${hard.map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
    ${choresHtml(b.d.gaps, soft.length, 'wnotes')}
    <main class="wbody split">${body}</main></div></div>${toastsHtml(ui, now, b.root)}</div>`
}
