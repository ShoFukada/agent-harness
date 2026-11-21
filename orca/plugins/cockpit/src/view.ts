// 表示の状態から HTML を作る（DOM に触らない）。窓とパネルが同じ関数を使う。
import { CONTEXT_FIELDS, COUNTED, KIND_LABEL, OTHER, TEXT_MAX, UNDO_GRACE_MS, chatMain, dismissable, type Card, type CardKind, type Repo } from './model.ts'
import type { CockpitView, TalkResult } from './protocol.ts'
import {
  BUCKET_LABEL, bucketOf, byUrgency, countsText, derive, dueAt, fmtDate, hhmm, isHot, localDay, nearDate, routeProblem, upcomingMilestones,
  type Bucket, type Derived, type JobView, type OrcaFacts, type OwnerRef, type Row
} from './state.ts'

export type Board = { root: string; v: CockpitView; d: Derived }
export type Model = {
  boards: Board[]
  focused?: string
  /** 見ていない本線。why があれば操縦席はあるが読めない（版 1 のままなど）。 */
  unseen: { name: string; path: string; why?: string }[]
  live?: number
  errors: string[]
  /** パネル（Orca の右のサイドバー、前面の案件 1 つ）。 */
  panel?: boolean
}
export type Theme = 'light' | 'dark' | 'auto'
export type Ui = {
  /** 案件で絞る（root）。無ければ全案件。 */
  filter?: string
  /** 開いている票（root#id）。 */
  sel?: string
  /** 選んだ選択肢（root#id → option id）。 */
  picked: Record<string, string>
  /** 別の答えの書きかけ（root#id → 文）。 */
  other: Record<string, string>
  otherOpen: Record<string, boolean>
  /** 右の列の畳み（名前 → 開いているか）。 */
  open: Record<string, boolean>
  toast?: { text: string; until: number }
  /** 直前の操作の取り消し（10 秒）。 */
  /** 取り消せる操作。続けて決めても前の操作を猶予の間は戻せるよう、操作ごとに持つ。 */
  undos: { root: string; opId: number; itemId: string; rev: number; text: string; until: number }[]
  /** 狭い幅で出す側（私の番か、案件の今と待ち）。広い幅では両方出す。 */
  pane?: 'queue' | 'side'
  /** 窓のタブ（要対応・全体・対応済み）。 */
  tab?: 'todo' | 'whole' | 'done'
  /** 窓の対応済みで開いている票（root#id）。要対応の sel と分けて持つ。 */
  doneSel?: string
  /** 窓の全体で開いている依頼の id。 */
  rq?: string
  theme: Theme
  dark: boolean
}
/** 票の中身を描くのに要る、その案件の図。 */
export type VRow = Row & { v?: CockpitView }
export const newUi = (): Ui => ({ picked: {}, other: {}, otherOpen: {}, open: {}, undos: [], theme: 'light', dark: false })

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
export const keyOf = (r: { root: string; card: { id: string } }) => `${r.root}#${r.card.id}`

export function boardsOf(views: CockpitView[], now: number): Board[] {
  return views
    .filter((v): v is CockpitView & { root: string; cockpit: NonNullable<CockpitView['cockpit']> } => !!v.root && !!v.cockpit)
    .map((v) => {
      const facts: OrcaFacts = { workers: v.workers, dispatches: v.dispatches, owners: v.owners, current: v.current }
      return { root: v.root, v, d: derive(v.cockpit, v.log, v.archive, v.root, facts, now, { utterances: v.utterances, firstSeen: v.firstSeen }) }
    })
}

/** 形でも種類が分かる印（色だけに頼らない）。 */
const GLYPH: Record<CardKind, string> = {
  inbox: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  send: '<path d="M6 1 11 6 6 11 1 6Z" fill="none" stroke="currentColor" stroke-width="2"/>',
  decide: '<rect x="1.5" y="1.5" width="9" height="9" fill="currentColor"/>',
  review: '<rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2"/>',
  permit: '<path d="M6 1 10.5 2.6V6c0 2.6-2 4.3-4.5 5C3.5 10.3 1.5 8.6 1.5 6V2.6Z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  stuck: '<path d="M4 1h4l3 3v4l-3 3H4L1 8V4Z" fill="currentColor"/>',
  consult: '<path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="6" r="1.4" fill="currentColor"/>',
  talk: '<path d="M6 1.5a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  report: '<path d="M2 3h8M2 6h8M2 9h5" stroke="currentColor" stroke-width="1.8"/>'
}
export const glyph = (k: CardKind) => `<svg class="glyph" viewBox="0 0 12 12" aria-hidden="true">${GLYPH[k]}</svg>`

/** リンクの種類の印。URL のドメインから決める。 */
export function linkKind(href: string): string {
  if (!/^https?:/.test(href)) return 'ファイル'
  if (/github\.com\/.+\/pull\//.test(href)) return 'PR'
  if (/github\.com/.test(href)) return 'GitHub'
  if (/docs\.google|drive\.google/.test(href)) return 'Drive'
  if (/slack\.com/.test(href)) return 'Slack'
  if (/teams\.microsoft/.test(href)) return 'Teams'
  if (/sharepoint\.com/.test(href)) return 'SharePoint'
  return 'ページ'
}
export const isWebUrl = (s: string) => /^https?:\/\//.test(s)
export const linkBtn = (label: string, href: string) =>
  `<button class="lk" type="button" ${isWebUrl(href) ? `data-url="${esc(href)}"` : `data-file="${esc(href)}"`}><i>${esc(linkKind(href))}</i><span>${esc(label)}</span></button>`

/** 本文の URL と #123（リポジトリが 1 つのとき）を押せる形にし、「- 」の行を箇条にする。 */
/** タグ ｜ `囲み` ｜ コミット（範囲も） ｜ スラッシュと数字を含むブランチ ｜ snake_case ｜ ADR-12 のような ID。 */
const CODE = /(<[^>]+>)|`([^`<]+)`|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?:\.\.[0-9a-f]{7,40})?\b|\b[A-Za-z][\w-]*\/[\w./-]*\d[\w./-]*|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z]{2,}-\d+\b/g

const monoPart = (m: string, tag?: string, quoted?: string) => (tag ? tag : `<span class="code">${quoted ?? m}</span>`)
/** HTML の中のコミット・ブランチ・識別子・ID を等幅にする（タグの中は触らない）。 */
export const mono = (html: string) => html.replace(CODE, monoPart)

const JA = String.raw`[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々〆、。「」『』（）・：？！…]`
const GAP = new RegExp(String.raw`(?<=${JA}) (?=[A-Za-z0-9])|(?<=[A-Za-z0-9]) (?=${JA})`, 'gu')
const VOID = /^(br|hr|img|input|wbr|meta|link|source)$/
/**
 * 日本語と英数字のあいだの半角の空白 1 つを、表示の HTML の文の部分から除く（R85。帳簿は書き換えない。間隔は CSS の text-autospace が付ける）。
 * pre・code・kbd・textarea と class に code・cmd・msg・verb を持つ要素の中（コマンド・パス・コード・送る文面・手作業の場所と手順・入力中の文）と、タグの属性は触らない。
 */
export function tighten(html: string): string {
  // 属性の値の中の > でタグを切らない（引用符の中は読み飛ばす）。
  const parts = html.split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>)/)
  const stack: boolean[] = []
  const skip: boolean[] = []
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i]!
    if (i % 2 === 1) {
      const m = /^<(\/)?([a-zA-Z][\w-]*)/.exec(t)
      if (!m) continue
      if (m[1]) stack.pop()
      else if (!VOID.test(m[2]!.toLowerCase()) && !t.endsWith('/>')) stack.push(/^(pre|code|kbd|textarea|script|style)$/i.test(m[2]!) || /class="[^"]*\b(code|cmd|msg|verb)\b/.test(t))
    } else skip[i] = stack.some(Boolean)
  }
  // 境目の判定にはタグをまたいだ前後の 1 文字を使う（「工程 <span>2/5</span> 決める」の空白も詰める）。
  const chars = (i: number, dir: 1 | -1): string => {
    for (let j = i + 2 * dir; j >= 0 && j < parts.length; j += 2 * dir) if (parts[j]) return dir === 1 ? parts[j]![0]! : parts[j]!.slice(-1)
    return ''
  }
  for (let i = 0; i < parts.length; i += 2) {
    if (skip[i] || !parts[i]!.includes(' ')) continue
    const prev = chars(i, -1)
    const next = chars(i, 1)
    parts[i] = (prev + parts[i] + next).replace(GAP, '').slice(prev.length, next ? -next.length : undefined)
  }
  return parts.join('')
}

export function rich(text: string | undefined, repo?: Repo): string {
  if (!text) return ''
  const inline = (s: string) =>
    esc(s)
      .replace(/https?:\/\/[^\s<>"'）)]+/g, (u) => `<button class="inl" type="button" data-url="${u}">${linkKind(u.replace(/&#38;/g, '&')) === 'PR' ? 'PR' : 'リンク'}</button>`)
      .replace(/(^|[\s（(、])#(\d+)\b/g, (m, pre, n) => (typeof repo === 'string' ? `${pre}<button class="inl" type="button" data-url="https://github.com/${esc(repo)}/pull/${n}">#${n}</button>` : m))
      .replace(CODE, monoPart)
      // コミット・ブランチ・識別子・ID は等幅にする（タグの中は触らない）。
  const lines = text.split('\n')
  const out: string[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`)
    list = []
  }
  for (const l of lines) {
    const m = /^\s*[-・]\s+(.*)$/.exec(l)
    if (m) list.push(m[1]!)
    else {
      flush()
      if (l.trim()) out.push(`<p>${inline(l)}</p>`)
    }
  }
  flush()
  return `<div class="rich">${out.join('')}</div>`
}

export function dueHtml(due: string | undefined, now: number): string {
  if (!due) return ''
  const t = dueAt(due)
  if (Number.isNaN(t)) return `<span class="due">${esc(due)}</span>`
  if (isHot(due, now)) {
    const h = Math.round((t - now) / 3_600_000)
    const tag = t < now ? '! 過ぎた' : h < 1 ? '! 1 時間以内' : `! あと ${h} 時間`
    return `<span class="due hot"><b>${tag}</b><span class="tm">${esc(nearDate(due, now))}</span></span>`
  }
  return `<span class="due">${esc(nearDate(due, now))}</span>`
}

export const ago = (iso: string | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ''
  const m = Math.max(0, Math.round((now - t) / 60_000))
  return m < 60 ? `${m} 分` : m < 60 * 48 ? `${Math.round(m / 60)} 時間` : `${Math.round(m / 1440)} 日`
}

export const OWNER_STATE: Record<string, string> = { working: '作業中', blocked: '許可待ち', waiting: '入力待ち', done: '待機' }
export function ownerHtml(o: OwnerRef): string {
  const where = o.how === 'main' ? '' : o.how === 'chat' ? 'チャット' : '端末'
  return `<span class="owner"><span>担当</span><b>${esc(o.title)}</b>${where ? `<span>${where}</span>` : ''}${o.state ? `<span class="dot ${esc(o.state)}"></span><span>${OWNER_STATE[o.state] ?? esc(o.state)}</span>` : ''}</span>`
}

/** 閉じた票に出す 1 行（HTML）。開くまで中身を読まなくても何の票かが分かるように。 */
function peek(c: Card, now: number): string {
  const pl = (label: string | undefined, text: string | undefined) => `${label ? `<b class="pl">${esc(label)}</b>` : ''}${esc(text ?? '')}`
  switch (c.kind) {
    case 'inbox': return pl(c.from?.who, c.asked)
    case 'send': return c.draft ? pl('宛先', c.draft.to) : ''
    case 'decide': {
      const rec = c.options?.find((o) => o.recommended)
      return rec ? pl('おすすめ', rec.label) : esc(c.purpose ?? '')
    }
    case 'review': return esc(c.look_for?.[0] ?? c.purpose ?? '')
    case 'permit': return c.manual?.command ? `<span class="code">${esc(c.manual.command)}</span>` : esc(c.target && c.target !== c.title ? c.target : c.effect ?? '')
    case 'stuck': return sp([esc(c.answerable ? '答えれば進む' : '私では直せない'), c.since && esc(`止まって ${ago(c.since, now)}`)])
    case 'consult': return esc(c.issue ?? '')
    case 'talk': return esc(c.next ?? c.last?.text ?? '')
    case 'report': return esc(c.done?.map((d) => d.what).join(' / ') ?? '')
  }
}

/** 補足の並び。「・」で繋がず、余白で区切る（html を受ける）。 */
export const sp = (xs: (string | false | undefined)[]) => xs.filter(Boolean).map((x) => `<span class="pt">${x}</span>`).join('')

export const fld = (label: string, html: string) => (html ? `<div class="fld"><span class="lb">${esc(label)}</span><div>${html}</div></div>` : '')

// 先に選んでおくのは決めるだけ。許す・詰まりは戻せない操作を含むので、利用者が選ぶまで押せない。
export const chosenOption = (r: Row, ui: Ui): string | undefined =>
  ui.picked[keyOf(r)] ?? (r.card.kind === 'decide' ? r.card.options?.find((o) => o.recommended)?.id : undefined)

export function optionsHtml(r: Row, ui: Ui): string {
  const c = r.card
  if (!c.options?.length) return ''
  const cur = chosenOption(r, ui)
  const k = keyOf(r)
  return `<div class="opts" role="radiogroup" aria-label="選択肢">${c.options.map((o, n) =>
    `<button class="opt" type="button" role="radio" aria-checked="${cur === o.id}" data-pick="${esc(o.id)}" data-key="${esc(k)}">
      <span class="key">${n + 1}</span><span><span class="lbl">${esc(o.label)}</span>${o.recommended ? '<span class="rec">おすすめ</span>' : ''}${o.example ? `<span class="ex">${esc(o.example)}</span>` : ''}</span></button>`
  ).join('')}</div>`
}

export function otherHtml(r: Row, ui: Ui): string {
  const k = keyOf(r)
  if (!ui.otherOpen[k]) return ''
  const text = ui.other[k] ?? ''
  const label = r.card.kind === 'review' ? '直してほしいこと（書いた文のまま担当か窓口に届きます）' : '別の答え（選択肢に無い答え・「もう手で済ませた」など）'
  return `<div class="other fld"><label class="lb" for="other-${esc(k)}">${label}</label>
    <textarea id="other-${esc(k)}" data-other="${esc(k)}" maxlength="${TEXT_MAX + 200}">${esc(text)}</textarea>
    <span class="cnt">あと ${TEXT_MAX - text.length} 字</span></div>`
}

/** 手作業の頼み。どこで → 打つコマンド（写すボタンつき）→ 手順 → 済ませたあと窓口が確かめること。 */
export function manualHtml(r: Row): string {
  const m = r.card.manual!
  return [
    // どこで・手順は利用者がそのまま打つ・開く値なので、表示で空白を詰めない（verb）。
    fld('どこで', m.where ? `<div class="verb">${esc(m.where)}</div>` : ''),
    m.command ? `<div class="fld"><span class="lb">打つコマンド</span><div class="cmd"><pre class="msg code">${esc(m.command)}</pre><button class="btn" type="button" data-act="copycmd" data-key="${esc(keyOf(r))}">コピー</button></div></div>` : '',
    m.steps?.length ? fld('手順', `<ol class="rich verb">${m.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`) : '',
    fld('済ませたあと', esc(m.check))
  ].join('')
}

/** いきさつ・比較・図・原文。パネルは「背景と比較」に畳み、窓は「詳しく」に入れる。 */
export function backgroundParts(r: Row, svg: (raw: string) => string, figures: Record<string, string>): string[] {
  const c = r.card
  const parts: string[] = []
  if (c.background) parts.push(fld('いきさつ', `${rich(c.background.text, c.repo)}${c.background.quote ? `<div class="quote">${esc(c.background.quote)}${c.background.date ? `（${esc(fmtDate(c.background.date))}）` : ''}</div>` : ''}`))
  if (c.compare && typeof c.compare !== 'string')
    parts.push(fld('選んだら起きること', `<div class="tblwrap"><table class="cmp"><tr>${c.compare.columns.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${c.compare.rows.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</table></div>`))
  const fig = c.figure ?? (typeof c.compare === 'string' ? c.compare : undefined)
  if (fig && figures[fig]) parts.push(`<div class="fig">${svg(figures[fig]!)}</div>`)
  if (c.quote) parts.push(fld('原文', `<div class="quote">${esc(c.quote)}</div>`))
  return parts
}

function detailsHtml(r: Row, svg: (raw: string) => string, figures: Record<string, string>): string {
  const parts = backgroundParts(r, svg, figures)
  if (!parts.length) return ''
  return `<details class="more"><summary>背景と比較</summary><div>${parts.join('')}</div></details>`
}

function bodyHtml(r: Row, ui: Ui, now: number, svg: (raw: string) => string, figures: Record<string, string>): string {
  const c = r.card
  const parts: string[] = []
  if (c.purpose) parts.push(`<div class="purpose"><b>何のため</b>　${esc(c.purpose)}</div>`)
  switch (c.kind) {
    case 'inbox':
      if (c.from) parts.push(fld('届いた連絡', `<span class="sp">${sp([esc(c.from.who), c.from.via && esc(c.from.via), c.from.at && esc(fmtDate(c.from.at))])}</span>`))
      parts.push(fld('聞かれていること', esc(c.asked)), fld('振り分け', esc(c.routed)))
      if (c.reply) parts.push(fld('返事', c.reply === 'needed' ? '要る（担当が下書きを作る）' : '要らない'))
      break
    case 'send':
      if (c.why) parts.push(fld('なぜ今', rich(c.why, c.repo)))
      if (c.draft)
        parts.push(`<div class="fld"><span class="lb">送る前の文面</span><div class="msg-to"><span class="sp">${sp([`宛先 <b>${esc(c.draft.to)}</b>`, c.draft.via && esc(c.draft.via)])}</span></div><div class="msg">${esc(c.draft.text)}</div></div>`)
      parts.push(optionsHtml(r, ui))
      break
    case 'decide':
      if (c.why) parts.push(fld('なぜ今決めるか', rich(c.why, c.repo)))
      parts.push(optionsHtml(r, ui))
      if (c.fallback) parts.push(fld('返事が無いとき', esc(c.fallback)))
      if (c.context && CONTEXT_FIELDS.some(([k]) => c.context?.[k]))
        parts.push(`<dl class="ctx">${CONTEXT_FIELDS.filter(([k]) => c.context?.[k]).map(([k, l]) => `<dt>${esc(l)}</dt><dd>${rich(c.context![k], c.repo)}</dd>`).join('')}</dl>`)
      if (c.draft) parts.push(`<div class="fld"><span class="lb">送る文面</span><div class="msg-to">宛先 <b>${esc(c.draft.to)}</b></div><div class="msg">${esc(c.draft.text)}</div></div>`)
      break
    case 'review':
      if (c.request) parts.push(fld('依頼の原文', `<div class="quote">${esc(c.request)}</div>`))
      if (c.look_for?.length) parts.push(fld('確認事項', `<ul class="rich">${c.look_for.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`))
      if (c.evidence?.length) parts.push(fld('確かめた結果', `<ul class="rich">${c.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`))
      if (r.fix) parts.push(fld('頼んだ直し', `<div class="quote">${esc(r.fix)}</div>`))
      break
    case 'permit':
      if (c.manual) {
        parts.push(manualHtml(r))
        break
      }
      parts.push(fld('対象', c.target ? `<span class="code">${esc(c.target)}</span>` : ''), fld('影響', rich(c.effect, c.repo)), fld('戻し方', esc(c.undo)))
      parts.push(optionsHtml(r, ui))
      break
    case 'stuck':
      parts.push(fld('理由', c.reason ? `<div class="quote code">${esc(c.reason)}</div>` : ''))
      if (c.since) parts.push(fld('止まってから', `${ago(c.since, now)}（${esc(fmtDate(c.since))}）`))
      parts.push(fld('私が答えれば進むか', `${c.answerable ? '進む' : '私では直せない'}${c.unblock ? `。${esc(c.unblock)}` : ''}`))
      parts.push(optionsHtml(r, ui))
      break
    case 'consult':
      parts.push(fld('論点', esc(c.issue)), fld('担当の今の考え', rich(c.stance, c.repo)))
      if (c.known?.length) parts.push(fld('分かっていること', `<ul class="rich">${c.known.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`))
      if (c.undecided?.length) parts.push(fld('決めかねていること', `<ul class="rich">${c.undecided.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`))
      break
    case 'talk':
      if (c.last) parts.push(fld('最後のやり取り', `<div class="quote">${esc(c.last.text)}</div>${c.last.at ? `<span class="mut">${esc(fmtDate(c.last.at))}</span>` : ''}`))
      parts.push(fld('次', esc(c.next)))
      break
    case 'report':
      parts.push(`<ul class="done-list">${(c.done ?? []).map((d, n) =>
        `<li><span>${esc(d.what)}</span><button class="btn quiet" type="button" data-act="revert" data-target="${n}" data-key="${esc(keyOf(r))}">戻して</button>${d.why || d.undo ? `<small>${[d.why && `理由: ${d.why}`, d.undo && `戻し方: ${d.undo}`].filter(Boolean).map(esc).join('　')}</small>` : ''}</li>`).join('')}</ul>`)
      break
  }
  const links = [
    ...(c.from?.href ? [{ label: '元の連絡', href: c.from.href }] : []),
    ...(c.draft?.href ? [{ label: '元のスレッド', href: c.draft.href }] : []),
    ...(c.href ? [{ label: c.kind === 'review' ? '成果物' : '開く', href: c.href }] : []),
    ...(c.diff ? [{ label: '差分', href: c.diff }] : []),
    ...(c.links ?? [])
  ]
  if (links.length) parts.push(`<div class="links">${links.map((l) => linkBtn(l.label, l.href)).join('')}</div>`)
  parts.push(detailsHtml(r, svg, figures))
  parts.push(`<div>${ownerHtml(r.owner)}</div>`)
  parts.push(otherHtml(r, ui))
  return parts.filter(Boolean).join('')
}

/** 送る前の「送った」のボタンの名前（コピーのあとの知らせもこれを案内する）。 */
export const SENT_LABEL = '送信済みにする'

/** 種類ごとの返答のボタン。押すと data-act の操作になる（controller.ts）。 */
export function actsHtml(r: Row, ui: Ui, win = false): string {
  const c = r.card
  const k = esc(keyOf(r))
  const b = (act: string, label: string, cls = '', extra = '') => `<button class="btn ${cls}" type="button" data-act="${act}" data-key="${k}" ${extra}>${esc(label)}</button>`
  // 窓は話す相手で名前を変える（担当の無い仕事のカードは窓口と話す）。
  const talk = (label = win && r.owner.how === 'main' ? '窓口と協議' : '担当と協議') => b('talk', label, 'talk')
  const picked = chosenOption(r, ui)
  const otherOpen = ui.otherOpen[keyOf(r)]
  const otherText = otherOpen && (ui.other[keyOf(r)] ?? '').trim()
  const decideLabel = otherOpen ? (c.kind === 'review' ? 'この修正を依頼' : '別の回答で決定') : !picked ? '選択肢を選択' : ui.picked[keyOf(r)] ? 'この案で決定' : '推奨案で決定'
  const ready = otherOpen ? otherText : picked
  const decideBtn = c.options?.length || otherOpen ? b('decide', decideLabel, 'pri', ready ? '' : 'disabled') : ''
  const other = b('other', otherOpen ? '別の回答を閉じる' : '別の回答', 'quiet')
  let btns: string[]
  // Orca から作った詰まり: 開いて直し、直したら「済ませた」で隠す（同じ失敗のあいだ。次に止まればまた出る）。
  const dismiss = dismissable(c) ? [b('dismiss', '対応済みにする', '', 'title="同じ停止のあいだは隠す。次に止まったときはまた出る"')] : []
  if (r.agent) btns = [b('focus', r.agent.chat ? 'チャットを開く' : '端末を開く', 'pri'), ...dismiss]
  else switch (c.kind) {
    case 'inbox': btns = [talk(), b('skip', '返信不要'), ...(c.from?.href ? [b('url', '元の連絡を開く', 'quiet', `data-url="${esc(c.from.href)}"`)] : [])]; break
    case 'send': btns = [b('copy', c.draft?.href ? 'コピーしてスレッドを開く' : '本文をコピー', 'pri'), b('sent', SENT_LABEL), talk('担当と修正'), b('skip', '送信しない', 'quiet'), ...(c.options?.length ? [decideBtn] : [])]; break
    case 'decide': btns = [decideBtn, talk(), other]; break
    case 'review': btns = [b('accept', '承認する', 'pri'), b('other', otherOpen ? '記入をやめる' : '修正点を記入'), ...(otherOpen ? [decideBtn] : []), talk('担当と修正を協議'), ...(c.href && !win ? [b('url', '開く', 'quiet', isWebUrl(c.href) ? `data-url="${esc(c.href)}"` : `data-file="${esc(c.href)}"`)] : [])]; break
    case 'permit': btns = c.manual ? [b('sent', '対応済みにする', 'pri'), talk()]
      : c.options?.length ? [decideBtn, talk(), other] : [b('accept', '許可する', 'pri'), b('delegate', `${c.scope ? `この案件の ${c.scope} は` : 'この案件では'}一任する`), b('skip', '却下', 'quiet'), talk()]; break
    case 'stuck': btns = [...(c.options?.length ? [decideBtn] : []), talk(c.options?.length ? '担当と協議' : '担当を開く'), ...dismiss, ...(dismiss.length ? [] : [other])]; break
    case 'consult': btns = [talk()]; break
    case 'talk': btns = [talk('協議を続ける')]; break
    case 'report': btns = [b('ack', '既読にする', 'pri'), talk()]; break
  }
  // 片付いた・顧客待ちの票には、片付ける操作を出さない（開いて読み返すだけ）。
  if (r.status === 'closed' || r.status === 'waiting') btns = btns.filter((x) => x.includes('data-act="url"'))
  if (r.status !== 'mine' && c.kind !== 'talk') btns = btns.filter((x) => !x.includes('data-act="talk"')).concat(talk('協議を続ける'))
  const hint = c.options?.length && btns.some((x) => x.includes('data-act="decide"')) ? `<span class="hint"><kbd>1</kbd>〜<kbd>${Math.min(9, c.options.length)}</kbd> で選び <kbd>Enter</kbd></span>` : ''
  return `<div class="acts">${btns.join('')}${hint}</div>`
}

export function stripHtml(r: VRow, ui: Ui, now: number, svg: (raw: string) => string, showWs: boolean): string {
  const c = r.card
  const k = keyOf(r)
  const open = ui.sel === k
  const fig = r.v?.figures ?? {}
  const meta = [
    `<span class="kind">${glyph(c.kind)}${KIND_LABEL[c.kind]}</span>`,
    showWs ? `<span class="ws">${esc(r.ws)}</span>` : '',
    r.stream && !c.title.includes(r.stream.title) ? `<span class="jobname">${esc(r.stream.title)}</span>` : '',
    r.status === 'fixing' ? `<span>${r.pending ? '修正依頼済み（受領待ち）' : '修正待ち'}</span>` : r.talking ? '<span>協議中</span>' : ''
  ].filter(Boolean).join('')
  return `<article class="strip k-${c.kind}${isHot(c.due, now) ? ' hot' : ''}" aria-expanded="${open}" data-strip="${esc(k)}" id="s-${esc(k)}">
    <button class="head" type="button" data-sel="${esc(k)}" aria-label="${esc(KIND_LABEL[c.kind])}: ${esc(c.title)}">
      <span class="meta">${meta}</span>${dueHtml(c.due, now)}<span class="title">${esc(c.title)}</span>${open ? '' : `<span class="peek sp">${mono(peek(c, now))}</span>`}
    </button>
    ${open ? `<div class="body">${bodyHtml(r, ui, now, svg, fig)}${actsHtml(r, ui)}</div>` : ''}
  </article>`
}

/** 1 列。期限の区切りを左の軸に置き、今の時刻の線を期限切れと今日の間に引く。 */
function queueHtml(rows: VRow[], m: Model, ui: Ui, now: number, svg: (raw: string) => string, unseen: string[], showWs: boolean): string {
  if (!rows.length) {
    // 見ていないものは、出している範囲（絞った案件ならその案件）に当てはまるものだけを挙げる。
    if (unseen.length)
      return `<div class="calm warn"><b>私の番はありません。ただし見ていないものがあります</b><ul>${unseen.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
    return `<div class="calm"><b>何もしなくてよい</b><p>担当が進めています。急ぐものが出たらここに並びます。</p></div>`
  }
  const lanes = new Map<Bucket, VRow[]>()
  for (const r of rows) {
    const b = bucketOf(r.card.due, now, r.card.kind)
    lanes.set(b, [...(lanes.get(b) ?? []), r])
  }
  const order: Bucket[] = ['stuck', 'over', 'today', 'tomorrow', 'week', 'later', 'none']
  const out: string[] = []
  let nowDrawn = false
  for (const b of order) {
    const list = lanes.get(b)
    if (b !== 'over' && b !== 'stuck' && !nowDrawn) {
      out.push(`<div class="now-line" aria-hidden="true"><span>今 ${hhmm(now)}</span><i></i></div>`)
      nowDrawn = true
    }
    if (!list) continue
    const sub = b === 'today' ? fmtDate(localDay(now)) : b === 'over' || b === 'stuck' ? `${list.length} 件` : ''
    out.push(`<section class="lane ${b}" aria-label="${BUCKET_LABEL[b]}"><div class="when">${BUCKET_LABEL[b]}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <div class="strips">${list.map((r) => stripHtml(r, ui, now, svg, showWs)).join('')}</div></section>`)
  }
  return out.join('')
}

function casesHtml(m: Model, ui: Ui, now: number): string {
  const total = m.boards.reduce((n, b) => n + b.d.total, 0)
  const row = (b: Board) => {
    const counted = b.d.queue.filter((r) => COUNTED.includes(r.card.kind))
    const over = counted.filter((r) => bucketOf(r.card.due, now, r.card.kind) === 'over').length
    const today = counted.filter((r) => bucketOf(r.card.due, now, r.card.kind) === 'today').length
    const sub = sp([
      b.d.counts.stuck && `止まっている ${b.d.counts.stuck}`,
      over && `<b class="hot">期限切れ ${over}</b>`,
      today && `今日 ${today}`,
      b.d.talking.length && `話し中 ${b.d.talking.length}`
    ].map((x) => x || undefined))
    return `<button class="case${b.d.total ? '' : ' zero'}" type="button" data-filter="${esc(b.root)}" aria-current="${ui.filter === b.root}">
      <span class="nm">${esc(b.v.cockpit!.workspace.name)}${m.focused === b.root ? '<span class="here" title="Orca で表示中"></span>' : ''}</span><span class="n">${b.d.total}</span>${sub ? `<span class="sub sp">${sub}</span>` : ''}</button>`
  }
  const sorted = [...m.boards].sort((a, b) => b.d.total - a.d.total || a.v.cockpit!.workspace.name.localeCompare(b.v.cockpit!.workspace.name, 'ja'))
  return `<nav class="cases" aria-label="案件で絞る"><h3>案件</h3>
    <button class="case" type="button" data-filter="" aria-current="${!ui.filter}"><span class="nm">全案件</span><span class="n">${total}</span></button>
    ${sorted.map(row).join('')}</nav>`
}

function unseenList(m: Model, now: number): string[] {
  return [
    ...m.unseen.map((u) => (u.why ? `${u.name}: ${u.why}` : `操縦席の無い案件: ${u.name}`)),
    ...m.boards.flatMap((b) => (b.v.cockpit?.routes ?? []).map((r) => routeProblem(r, now)).filter((x): x is string => !!x).map((x) => `${b.v.cockpit!.workspace.name}: ${x}`))
  ]
}

function jobsHtml(b: Board, now: number, label: string): string {
  const c = b.v.cockpit!
  const ms = upcomingMilestones(c.workspace.milestones, now).slice(0, 3)
  const live = b.d.jobs.filter((j) => j.state !== 'done')
  const done = b.d.jobs.length - live.length
  const ownerText = (j: JobView) => {
    const o = j.owner
    if (!o) return ''
    const st = o.state ? OWNER_STATE[o.state] ?? o.state : ''
    return o.title === j.title ? st : st ? `${o.title}（${st}）` : o.title
  }
  const job = (j: JobView) => {
    const who = ownerText(j)
    return `<li class="job ${j.state}"><span class="js" aria-hidden="true"></span><span class="t">${esc(j.title)}</span><span class="st">${esc(j.label)}${j.since ? `（${esc(fmtDate(j.since.slice(0, 10)))} から）` : ''}</span>
    ${j.next || who ? `<span class="nx sp">${sp([j.next && `<b class="pl">次</b>${mono(esc(j.next))}`, who && `<span class="nw"><b class="pl">担当</b>${esc(who)}</span>`])}</span>` : ''}</li>`
  }
  return `<section class="pane" aria-label="案件の今"><h2>${esc(c.workspace.name)} <small>${esc(label)}</small></h2>
    ${ms.length ? `<ul class="ms">${ms.map((x) => `<li><b>${x.left === 0 ? '今日' : `あと ${x.left} 日`}</b><span>${esc(x.label)}</span></li>`).join('')}</ul>` : ''}
    ${live.length ? `<ul class="jobs">${live.map(job).join('')}</ul>` : '<p class="mut">動いている仕事はありません</p>'}
    ${done ? `<p class="mut" style="margin:6px 0 0;font-size:var(--fs-xs)">済んだ仕事 ${done}</p>` : ''}</section>`
}

function miniList(name: string, title: string, rows: VRow[], ui: Ui, now: number, svg: (raw: string) => string, showWs: boolean, right: (r: Row) => string, openByDefault: boolean): string {
  if (!rows.length) return ''
  const open = ui.open[name] ?? openByDefault
  return `<section class="pane"><details data-fold="${name}" ${open ? 'open' : ''}><summary><h2>${esc(title)} <small>${rows.length}</small></h2></summary>
    <ul class="mini">${rows.map((r) => ui.sel === keyOf(r)
      ? `<li>${stripHtml(r, ui, now, svg, showWs)}</li>`
      : `<li><button class="row" type="button" data-sel="${esc(keyOf(r))}"><span class="t">${showWs ? `<i>${esc(r.ws)}</i>　` : ''}${esc(r.card.title)}</span>${right(r)}</button></li>`).join('')}</ul></details></section>`
}

export function render(m: Model, ui: Ui, now: number, svg: (raw: string) => string): string {
  const shown = ui.filter ? m.boards.filter((b) => b.root === ui.filter) : m.boards
  const showWs = !m.panel && !ui.filter && m.boards.length > 1
  const all = <K extends 'queue' | 'talking' | 'fixing' | 'waiting' | 'reports' | 'closed'>(k: K) => shown.flatMap((b) => b.d[k].map((r) => ({ ...r, v: b.v })))
  const queue = all('queue').sort(byUrgency)
  const counts = Object.fromEntries(COUNTED.map((k) => [k, shown.reduce((n, b) => n + b.d.counts[k], 0)])) as Record<CardKind, number>
  const total = COUNTED.reduce((n, k) => n + counts[k], 0)
  const inbox = shown.reduce((n, b) => n + b.d.counts.inbox, 0)
  const unseen = unseenList(m, now)
  const signal = m.panel ? signalHtml(shown[0]?.v) : ''
  const top = `<header class="top">
    <div class="tally"><b>${total}</b><span>${ui.filter ? `${esc(shown[0]?.v.cockpit?.workspace.name ?? '')} の` : m.panel ? '' : '全案件の'}私の番</span></div>
    <div class="kinds" aria-label="${esc(countsText({ ...counts, inbox, consult: 0, talk: 0, report: 0 }, total))}">${COUNTED.filter((k) => counts[k]).map((k) => `<span class="kc k-${k}">${glyph(k)}${KIND_LABEL[k]} <b>${counts[k]}</b></span>`).join('')}${inbox ? `<span class="kc ref k-inbox" title="届いたは私の番の数に入れない">${glyph('inbox')}届いた <b>${inbox}</b></span>` : ''}</div>
    <div class="flags">${unseen.length ? `<button class="flag warn" type="button" data-act="unseen" aria-expanded="${!!ui.open.unseen}">見ていない ${unseen.length}</button>` : ''}${m.live !== undefined ? `<span class="flag live">動いているエージェント ${m.live}</span>` : ''}${signal}${repeatHtml(m, ui, shown)}
      ${m.panel ? '' : `<span class="seg" role="group" aria-label="地の色">${(['light', 'dark', 'auto'] as Theme[]).map((t) => `<button type="button" data-theme="${t}" aria-pressed="${ui.theme === t}">${t === 'light' ? '明' : t === 'dark' ? '暗' : '自動'}</button>`).join('')}</span>`}</div>
  </header>`
  const late = all('waiting').filter((r) => r.card.awaiting?.remind_at && Date.parse(r.card.awaiting.remind_at) < now).length
  const sideCount = { talking: all('fixing').length, waiting: all('waiting').length, late }
  const errs = [...m.errors, ...shown.flatMap((b) => b.v.errors.map((e) => `${b.v.cockpit?.workspace.name ?? ''}: ${e}`))]
  const focusBoard = m.boards.find((b) => b.root === (ui.filter ?? m.focused)) ?? (m.panel ? m.boards[0] : undefined)
  const side = [
    focusBoard ? jobsHtml(focusBoard, now, ui.filter ? '案件の今' : m.panel ? '案件の今' : 'Orca で表示中') : '',
    miniList('fixing', '直し待ち', all('fixing'), ui, now, svg, showWs, (r) => `<span class="r${r.pending ? ' pend' : ''}">${r.pending ? '受領待ち' : '直し待ち'}</span>`, true),
    miniList('waiting', '顧客待ち', all('waiting'), ui, now, svg, showWs, (r) => {
      const a = r.card.awaiting
      const late = a?.remind_at && Date.parse(a.remind_at) < now
      return `<span class="r sp${late ? ' hot' : ''}">${a ? sp([esc(a.who), `${esc(fmtDate(a.since.slice(0, 10)))} から`, late && '催促の日を過ぎた']) : ''}</span>${a?.resumes ? `<small><b class="pl">返事で再開</b>${esc(a.resumes)}</small>` : ''}`
    }, true),
    miniList('reports', '報告', all('reports'), ui, now, svg, showWs, (r) => `<span class="r">${esc(nearDate(r.card.at, now))}</span>`, false),
    miniList('closed', '片付いた', all('closed').slice(0, 40), ui, now, svg, showWs, (r) => `<span class="r ${r.pending ? 'pend' : 'recv'}">${r.pending ? '受け取り待ち' : '受け取った'}</span><small class="sp">${sp([esc(r.how), r.when && esc(nearDate(r.when, now))])}</small>`, false)
  ].join('')
  const toast = toastsHtml(ui, now)
  const empty = !m.boards.length && !m.unseen.length
    ? `<div class="calm${m.panel ? '' : ' warn'}"><b>${m.panel ? 'この案件には操縦席がありません' : '操縦席のある案件がありません'}</b><p>メインに「操縦席を作って」と頼むと、ここに私の番が並びます。</p></div>`
    : queueHtml(queue, m, ui, now, svg, [
        ...shown.flatMap((b) => (b.v.cockpit?.routes ?? []).map((r) => routeProblem(r, now)).filter((x): x is string => !!x)),
        ...(ui.filter ? [] : m.unseen.map((u) => `${u.name}: ${u.why ?? '操縦席がない'}`))
      ], showWs)
  return `<div class="ck" data-theme="${ui.dark ? 'dark' : 'light'}">${top}
    ${paneSwitch(ui, total, sideCount)}
    <main class="board${m.panel ? ' panel' : ''}" data-pane="${ui.pane ?? 'queue'}">
      ${errs.length ? `<div class="errs" role="alert">${errs.map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
      ${unseen.length && ui.open.unseen ? `<div class="notes warn" role="status"><b>見ていないもの</b>${unseen.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : ''}
      ${handoffHtml(shown, now)}
      ${m.panel ? '' : casesHtml(m, ui, now)}
      <div class="queue" aria-label="私の番">${empty}</div>
      <aside class="side">${side}</aside>
    </main>${toast}</div>`
}

export function toastsHtml(ui: Ui, now: number): string {
  const msg = ui.toast && ui.toast.until > now ? `<div class="toast" role="status"><span>${esc(ui.toast.text)}</span></div>` : ''
  const undo = ui.undos
    .filter((u) => u.until > now)
    .map((u) => `<div class="toast undo" role="status"><span>${esc(u.text)}。担当に届けます</span><button type="button" data-act="undo" data-op="${u.opId}" data-root="${esc(u.root)}">元に戻す（${Math.max(1, Math.ceil((u.until - now) / 1000))}）</button></div>`)
    .join('')
  return msg || undo ? `<div class="toasts">${msg}${undo}</div>` : ''
}

/** 狭い幅で、私の番と「案件の今・待ち」を切り替える。広い幅では CSS で隠す。 */
function paneSwitch(ui: Ui, total: number, n: { talking: number; waiting: number; late: number }): string {
  const cur = ui.pane ?? 'queue'
  return `<div class="paneswitch" role="tablist" aria-label="出すもの">
    <button type="button" role="tab" data-pane="queue" aria-selected="${cur === 'queue'}">私の番 ${total}</button>
    <button type="button" role="tab" data-pane="side" aria-selected="${cur === 'side'}">案件の今・待ち ${n.talking + n.waiting}${n.late ? `<b>催促 ${n.late}</b>` : ''}</button></div>`
}

/** パネルで、メインに合図が届いていないとき。 */
/**
 * 「前にも言った」。前に伝えたことを窓口が落としたときに押す。案件ごとの合図なので、案件 1 つを出しているとき（パネル・絞り込み）だけ出す。
 * 窓口の hook が押下を数え、2 回で新しいチャットへの引き継ぎに使う。
 */
function repeatHtml(m: Model, ui: Ui, shown: Board[]): string {
  if (shown.length !== 1 || !(m.panel || ui.filter)) return ''
  return `<button class="flag repeat" type="button" data-act="repeat" data-root="${esc(shown[0]!.root)}" title="前に伝えたことを窓口が落としたときに押します。窓口が記録を読み直し、2 回押されると新しいチャットへ引き継ぎます">前にも言った</button>`
}

/** 窓口を新しいチャットに引き継いだ知らせ。古い知らせで今のチャットを取り違えないよう、1 日だけ出す。 */
function handoffHtml(shown: Board[], now: number): string {
  const lines = shown
    .filter((b) => b.v.handoff && now - Date.parse(b.v.handoff.at) < 86_400_000)
    .map((b) => `<div>${esc(b.v.cockpit?.workspace.name ?? '')}: 窓口を新しいチャットに引き継ぎました（${esc(fmtDate(b.v.handoff!.at))} ${esc(b.v.handoff!.reason)}）。Orca のチャットの一覧から新しいチャットを開いてください</div>`)
  return lines.length ? `<div class="notes" role="status">${lines.join('')}</div>` : ''
}

function signalHtml(v: CockpitView | undefined): string {
  if (!v?.cockpit) return ''
  if (chatMain(v.cockpit)) return ''
  if (v.signal?.state === 'failed') return `<button class="flag err" type="button" data-act="notify">メインに届いていません（${esc(v.signal.reason ?? '')}）。もう一度送る</button>`
  if (v.signal?.state === 'waiting') return '<span class="flag">メインの手が空いたら届けます</span>'
  return ''
}

export function talkMessage(res: TalkResult, copied: boolean): string {
  const where = res.opened ? `${res.how}を前に出しました。` : ''
  const paste = copied ? '書き出しをコピーしたので、貼って話してください' : '話してください'
  if (res.reason) return `開けませんでした: ${res.reason}`
  if (res.tab) return `${where}チャットの「${res.tab}」を開き、${paste}`
  return res.opened ? `${res.how}を開きました。${paste}` : `${res.how}を開けませんでした。Orca で開き、${paste}`
}

/** 担当のチャットに貼る書き出し。どのカードの話かを説明し直さずに済むように。 */
export function preface(r: Row): string {
  const c = r.card
  return [`【操縦席 ${c.id}・${KIND_LABEL[c.kind]}】${c.title}`, c.purpose ? `何のため: ${c.purpose}` : '', 'この件で: '].filter(Boolean).join('\n')
}

export { UNDO_GRACE_MS, OTHER }
