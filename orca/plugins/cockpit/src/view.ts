// 表示の状態から HTML の文字列を作る。DOM に触らないので Node のテストで中身を確かめられる。
import {
  CONTEXT_FIELDS, DEFAULT_PHASES, doneAt, doneText, TALK_MAX, UNDO_GRACE_MS, textError, chatMain, contextAsked, missingContext, unappliedOps,
  type Cockpit, type Deliverable, type Item, type ItemKind, type ItemView, type Repo, type Request, type Task, type TaskState
} from './model.ts'
import type { AgentRow, CockpitView, StopReason } from './protocol.ts'
import {
  NO_STREAM, ST_LABEL, STOP_LABEL, derive, streamTimeline, dueAt, fmtDate, isOver, itemStreams, itemTaskIds, upcomingMilestones,
  type Counts, type Derived, type RequestView, type StreamEvent, type StreamView, type TaskView
} from './state.ts'

export type Tab = 'todo' | 'whole' | 'arch'
export type Ui = {
  tab: Tab
  cur?: string
  /** 片付け済みで選んだ項目。完了した依頼は `req:<id>`。 */
  curArch?: string
  curTask?: string
  /** 全体で選んだ依頼。タスクを選ぶと外れる。 */
  curReq?: string
  /** 全体で開いている大タスク（NO_STREAM はつながりなし）。curTask・curReq も無ければ全体の表を出す。 */
  curStream?: string
  /** 確認から大タスクへ上がったときの戻り先。1 つだけ持ち、戻ったとき・要対応で別の項目を選んだときに消す。 */
  back?: Back
  /** 決で数字キーやクリックで選んだ、まだ確定していない選択肢の id。キーは pickKey。 */
  pick: Record<string, string>
  showDone: Record<string, boolean>
  /** 項目ごとの「詳細」の欄の開閉。描き直しで閉じないよう、画面の状態として持つ。 */
  more?: Record<string, boolean>
  /** 決めるための情報の欄を閉じた項目（既定は開いている）。 */
  ctxShut?: Record<string, boolean>
  /** 話したいの入力欄を開いている項目（またはタスク）の id と、書きかけの文。描き直しで消えないよう画面の状態として持つ。 */
  chat?: string
  /** 項目（またはタスク）ごとの書きかけ。別の項目に移っても混ざらないよう id ごとに持つ。 */
  chatDraft?: Record<string, string>
  /** 「別の答えで決める」の書きかけ（項目ごと）。 */
  otherDraft?: Record<string, string>
  /** 「直してほしい」で入力欄を開いた項目の id。送るとメインに渡す（アシスタントは直せない）。 */
  fix?: string
  /** 「?」で出すキーの一覧。 */
  keys?: boolean
  /** 窓の列で、要対応なし案件を開いているか。 */
  showIdle?: boolean
  /** 全体で、4 件目からの節目を開いているか。 */
  showMs?: boolean
  toast?: { msg: string; undo?: { item_id: string; op_id: number } }
  /** 合図を送れなかった理由など、1 行の知らせ。 */
  notice?: string
}

/** 戻り先の確認と、上がった時点の欄のスクロール位置（controller が測って戻す）。 */
export type Back = { tab: 'todo' | 'arch'; item: string; scroll: Record<string, number> }
/** 全体の表で、完了した大タスクの畳みの開閉に使う showDone のキー。 */
export const DONE_STREAMS = '#streams'

/** 選択は項目の版に結び付け、メインが項目を出し直したら解ける。 */
export const pickKey = (i: Item) => `${i.id}@${i.rev}`

export const KIND: Record<ItemKind, [string, string]> = {
  dec: ['判断', '判断'],
  ask: ['質問', '顧客への確認'],
  rev: ['確認', '成果物の確認'],
  ack: ['報告', 'エージェントからの報告']
}
const ST_GLYPH: Record<TaskState, string> = { stop: '■', run: '●', wait: '◆', idle: '○', ok: '✓' }
const DAY = 86_400_000

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const st = (s: TaskState, label = ST_LABEL[s]) => `<span class="st s-${s}" title="${esc(label)}" aria-label="${esc(label)}">${ST_GLYPH[s]}</span>`

/** 期限が 24 時間以内か過ぎている。朱で示すのはこれだけ。 */
export const isSoon = (iso: string | undefined, now: number) => {
  if (!iso) return false
  const t = dueAt(iso)
  return !Number.isNaN(t) && t - now < DAY
}
export function dueHtml(iso: string | undefined, now: number): string {
  if (!iso) return ''
  if (isOver(iso, now)) return `<span class="over">! 期限切れ ${esc(fmtDate(iso))}</span>`
  if (isSoon(iso, now)) return `<span class="over">! あと ${Math.max(1, Math.ceil((dueAt(iso) - now) / 3_600_000))} 時間 ${esc(fmtDate(iso))}</span>`
  return esc(fmtDate(iso))
}

/** 項目の印。墨色の文字で種類を示し、期限が近いものだけ朱で塗る（色・形・文字の 3 つ）。 */
function kind(k: ItemKind, hot = false): string {
  return `<span class="kind k-${k}${hot ? ' hot' : ''}" title="${KIND[k][1]}${hot ? '・期限が近い' : ''}">${KIND[k][0]}</span>`
}

type Ctx = {
  v: CockpitView
  c: Cockpit
  ui: Ui
  now: number
  views: ItemView[]
  tasks: Map<string, Task>
  svg: (raw: string) => string
  /** 判定済みの状態（state.ts の derive）。タスク・依頼・件数はすべてこれを通す。 */
  d: Derived
  /** タスクの画面上の状態と文。 */
  shown: (t: Task) => TaskView
  /** 窓では件数と worker の数を上の帯と左の列に出すので、案件の帯に重ねて出さない。 */
  inWindow: boolean
}

/**
 * 図を描く幅。図の中のいちばん小さい字が 14px（注記の大きさ）になる幅にし、詳細の欄より広ければ欄の幅に収める。
 * viewBox や字の大きさが読めない図は欄の幅いっぱいにする。
 */
export function figureWidth(raw: string): number | undefined {
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(raw)
  const sizes = [...raw.matchAll(/font-size\s*[=:]\s*["']?([\d.]+)/gi)].map((m) => Number(m[1])).filter((n) => n > 0)
  if (!vb || !sizes.length) return undefined
  return Math.round((Number(vb[1]) * 14) / Math.min(...sizes))
}

function figure(ctx: Ctx, ref: string | undefined): string {
  if (!ref) return ''
  const raw = ref.trimStart().startsWith('<') ? ref : ctx.v.figures[ref]
  if (!raw) return ''
  // 詳細の欄の幅いっぱいに描く。字が小さく描かれる図は、controller が押すと拡大できる印を付ける（data-w は字が 14px になる幅）。
  const w = figureWidth(raw)
  // 字が注記の大きさ（14px）を超えて大きく描かれないよう、その幅を上限にする。
  return `<div class="fig"${w ? ` data-w="${w}" style="max-width:${w}px"` : ''}>${ctx.svg(raw)}</div>`
}

// ── リンク ──────────────────────────────────────────────
export type LinkKind = 'Drive' | 'PR' | 'ページ' | 'ファイル'
/** リンクの種類の印。URL はドメインから、それ以外はファイル。 */
export function linkKind(href: string): LinkKind {
  if (!isWebUrl(href)) return 'ファイル'
  const u = new URL(href)
  if (/(^|\.)(drive|docs|sheets|slides)\.google\.com$/.test(u.hostname)) return 'Drive'
  if (u.hostname === 'github.com' && /\/pull\/\d+/.test(u.pathname)) return 'PR'
  return 'ページ'
}
export const isWebUrl = (href: string) => {
  try {
    const u = new URL(href)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
/** ファイルはワークスペースからの相対パスか絶対パス（開けるかは開く側が確かめる）。http(s) 以外の URL は開かない。 */
const openable = (href: string) => isWebUrl(href) || (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !/[\n\r]/.test(href))
function shortHref(href: string): string {
  if (isWebUrl(href)) {
    const u = new URL(href)
    // 同じ形の URL が並ぶと見分けられないので、PR は番号、表は行で名前を付ける（design-review の指摘、2026-11-17）。
    const pr = u.hostname === 'github.com' ? /^\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(u.pathname) : null
    if (pr) return `${pr[1]} #${pr[2]}`
    const range = /(?:^|[#&?])range=([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)/.exec(u.hash + u.search)?.[1]
    if (/(^|\.)docs\.google\.com$/.test(u.hostname) && u.pathname.startsWith('/spreadsheets/') && range) return `スプレッドシート ${range} 行`
    const p = u.pathname.replace(/\/$/, '')
    return u.hostname.replace(/^www\./, '') + (p.length > 28 ? p.slice(0, 28) + '…' : p)
  }
  return href.split('/').slice(-2).join('/')
}
/** 開くボタン。primary は「見て」の主ボタン。 */
export function linkHtml(href: string, label?: string, primary = false): string {
  if (!openable(href)) return esc(label ?? href)
  const k = linkKind(href)
  const text = label ?? shortHref(href)
  return `<button class="${primary ? 'btn open' : 'lnk'}" data-href="${esc(href)}" title="${esc(href)}"><span class="lk">${k}</span><span class="${k === 'ファイル' && !label ? 'mono' : ''}">${esc(text)}</span></button>`
}

/** 話したいの回答の差出人。誰が何をするかを名前の横に出す。 */
const AI_WHO = 'すぐの回答<span class="mut">（読むだけ・作業はしない）</span>'
const MAIN_WHO = 'メイン<span class="mut">（作業と操縦席の更新もする）</span>'

// ── 説明の文 ────────────────────────────────────────────
/**
 * 文中の Markdown（`コード`・[文字](リンク)・**太字**・*斜体*）と、URL・「#123」（repo があれば PR）を描く。
 * 文字はすべてエスケープし、開けないリンク（http(s) とファイル以外）は文字だけにする。
 */
export function inline(text: string, repo?: Repo, links = true): string {
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(?=\S)(.+?)\*\*|\*(?=[^\s*])([^*\n]+?)\*|(https?:\/\/[^\s<>「」（）()、。]+)|(?:\b([A-Za-z][\w-]*) )?#(\d+)\b/g
  let out = '', last = 0
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const [all, code, label, href, bold, em, url, prefix, num] = m
    let h: string
    if (code !== undefined) h = `<code>${esc(code)}</code>`
    // ボタンの中（選択肢）では開くボタンを入れ子にしない。入れ子のボタンは HTML の解析で外側が閉じられ、詳細の欄が崩れる。
    else if (!links && (label !== undefined || url)) h = esc(label ?? shortHref(url!))
    else if (label !== undefined) h = openable(href!) ? `<button class="ilnk" data-href="${esc(href)}" title="${esc(href)}">${esc(label)}</button>` : esc(label)
    else if (bold !== undefined) h = `<strong>${inline(bold, repo, links)}</strong>`
    else if (em !== undefined) h = `<em>${inline(em, repo, links)}</em>`
    else if (url) h = `<button class="ilnk" data-href="${esc(url)}" title="${esc(url)}">${esc(shortHref(url))}</button>`
    else {
      const target = typeof repo === 'string' ? repo : repo?.[prefix ?? ''] ?? repo?.['*']
      if (!target || !links) continue
      h = `${prefix ? esc(prefix) + ' ' : ''}<button class="ilnk" data-href="https://github.com/${esc(target)}/pull/${num}" title="${esc(target)} #${num}">#${num}</button>`
    }
    out += esc(text.slice(last, m.index)) + h
    last = m.index + all.length
  }
  return out + esc(text.slice(last))
}

const BLOCK = /^\s*(?:[-*]\s|・|\d+[.)]\s|#{1,3}\s|>|```)/

/**
 * why・body・context・話したいの回答を Markdown として描く。見出し・箇条（入れ子は 1 段）・番号付き・引用・コードブロックと、
 * 行の中は inline。1 行の改行はそのまま行を分ける（メインもアシスタントも改行で区切って書くため）。
 */
export function richText(text: string | undefined, repo?: Repo): string {
  if (!text) return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length === 1 && !BLOCK.test(text)) return inline(text, repo)
  let h = ''
  const open: ('ul' | 'ol')[] = []
  const closeTo = (depth: number) => {
    while (open.length > depth) h += `</li></${open.pop()}>`
  }
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!
    const line = raw.trim()
    if (line.startsWith('```')) {
      closeTo(0)
      const code: string[] = []
      while (++n < lines.length && !lines[n]!.trim().startsWith('```')) code.push(lines[n]!)
      h += `<pre class="rtcode"><code>${esc(code.join('\n'))}</code></pre>`
      continue
    }
    if (line.startsWith('>')) {
      closeTo(0)
      const quote = [line]
      while (lines[n + 1]?.trim().startsWith('>')) quote.push(lines[++n]!.trim())
      h += `<blockquote class="rtq">${quote.map((q) => inline(q.replace(/^>\s?/, ''), repo)).join('<br>')}</blockquote>`
      continue
    }
    const item = /^(\s*)(?:([-*]\s|・)|(\d+[.)]\s))\s*(.*)$/.exec(raw)
    if (item) {
      const kind = item[3] ? 'ol' : 'ul'
      const depth = Math.min(item[1]!.replace(/\t/g, '  ').length >= 2 ? 1 : 0, open.length)
      closeTo(depth + 1)
      if (open.length === depth + 1 && open[depth] !== kind) closeTo(depth)
      if (open.length === depth + 1) h += '</li><li>'
      else {
        h += `<${kind} class="rt"><li>`
        open.push(kind)
      }
      h += inline(item[4]!, repo)
      continue
    }
    closeTo(0)
    const head = /^#{1,3}\s+(.*)$/.exec(line)
    if (head) h += `<div class="rth">${inline(head[1]!, repo)}</div>`
    else if (line) h += `<p class="rtp">${inline(line, repo)}</p>`
  }
  closeTo(0)
  return `<div class="rt-box">${h}</div>`
}

const shownLabel = (ctx: Ctx, t: Task) => ctx.shown(t).label
/** 状態の印と文。記録漏れだけは警告の色にする。 */
const shownHtml = (ctx: Ctx, t: Task, cls = 'mut') =>
  `${st(ctx.shown(t).state)}<span class="${ctx.shown(t).why === 'missing' ? 'warn' : cls}">${esc(shownLabel(ctx, t))}</span>`

const taskLink = (ctx: Ctx, tid: string) =>
  `<button class="tlink" data-task="${esc(tid)}">${esc(ctx.tasks.get(tid)?.title ?? tid)}</button>`

/** 手を入れないと戻らない止まり方は赤い ■、利用者の返事で動くものは黄の ◆。 */
const HARD_STOP: StopReason[] = ['error', 'dead', 'auth', 'limit']
export const isHardStop = (r: StopReason) => HARD_STOP.includes(r)

function elapsed(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60000))
  return m < 60 ? `${m}分` : m < 1440 ? `${Math.floor(m / 60)}時間` : `${Math.floor(m / 1440)}日`
}

/** 止まった worker を仕事の名前で出す。「端末を開く」でその端末を Orca で前に出す（端末が無ければ worktree を開く）。 */
function stopChip(w: AgentRow, now: number): string {
  const r = w.stop!
  return `<span class="chip bad ${isHardStop(r) ? 'hard' : ''}">${st(isHardStop(r) ? 'stop' : 'wait')}<span class="job">${esc(w.job ?? w.title ?? w.agent ?? '?')}</span><b>${STOP_LABEL[r]}</b><span class="num">${elapsed(w.since, now)}</span><button class="link" data-agent="${esc(w.terminalId ?? '')}" data-wt="${esc(w.worktree ?? '')}">端末を開く</button></span>`
}

// ── 件数 ────────────────────────────────────────────────
/** 「あなたの番 15 件（決める 9・聞く 4・見て 2）」。0 件の種類は書かない。 */
export function countsHtml(n: Counts): string {
  const total = n.dec + n.ask + n.rev
  const parts = (['dec', 'ask', 'rev'] as const).filter((k) => n[k]).map((k) => `${KIND[k][0]} <span class="num">${n[k]}</span> 件`)
  return `要対応 <b class="num">${total}</b> 件${parts.length ? `<span class="brk">（${parts.join('・')}）</span>` : ''}`
}

// ── 上の帯 ──────────────────────────────────────────────
function bar(ctx: Ctx): string {
  const { v, now, d } = ctx
  const due = d.open.find((i) => i.due)?.due
  const bad = v.workers.filter((w) => w.stop)
  // 案件の名前・次の節目・要約・更新の時刻は、利用者が判断に使わないので出さない。
  const parts = [
    ctx.inWindow ? '' : `<span class="cnt">${countsHtml(d.counts)}${due ? `　最短 ${dueHtml(due, now)}` : ''}</span>`,
    v.workers.length && !ctx.inWindow ? `<span class="chip">worker ${v.workers.length} 件</span>` : '',
    ...bad.map((w) => stopChip(w, now))
  ].filter(Boolean)
  return parts.length ? `<div class="bar"><div class="l3">${parts.join('')}</div></div>` : ''
}

// 件数は上の帯（窓は全案件の帯と左の列）にだけ出し、タブには出さない。
function tabs(ctx: Ctx): string {
  const t = (id: Tab, label: string) =>
    `<button class="tab" role="tab" data-tab="${id}" aria-selected="${ctx.ui.tab === id}">${label}</button>`
  const keys = ctx.ui.keys
    ? '<span class="keys mut"><kbd>j</kbd><kbd>k</kbd> 移動 <kbd>1</kbd>-<kbd>9</kbd> 選択 <kbd>Enter</kbd> 決定 <kbd>e</kbd> 確認 <kbd>z</kbd> 取り消し</span>'
    : ''
  return `<div class="tabs" role="tablist">
    ${t('todo', '要対応')}${t('whole', '全体')}${t('arch', '対応済み')}
    ${keys}<button class="keyhint" data-keys title="キーの一覧" aria-pressed="${!!ctx.ui.keys}">?</button>
  </div>`
}

function notes(ctx: Ctx): string {
  const { v, ui, now } = ctx
  const lines = v.errors.map((e) => `<div class="err">${esc(e)}</div>`)
  if (ui.notice) lines.push(`<div class="err">${esc(ui.notice)}</div>`)
  const unapplied = unappliedOps(v.cockpit, v.log).filter((o) => now - new Date(o.at).getTime() >= UNDO_GRACE_MS)
  if (unapplied.length && chatMain(v.cockpit))
    lines.push(`<div class="row2"><span class="mut">未反映の操作 ${unapplied.length} 件。メインはチャットのため、次に話しかけたときに反映されます</span></div>`)
  else if (v.signal?.state === 'failed')
    lines.push(`<div class="row2"><span class="warn">メインに届いていません: ${esc(v.signal.reason ?? '')}</span><button class="btn sm" data-notify>もう一度送る</button></div>`)
  else if (v.signal?.state === 'waiting')
    lines.push(`<div class="row2"><span class="mut">メインの作業が一区切りしたら届けます</span></div>`)
  else if (unapplied.length && unapplied.every((o) => o.op_id <= v.notifiedOp))
    lines.push(`<div class="row2"><span class="mut">${OK} メインに届けました（反映待ち ${unapplied.length} 件）</span></div>`)
  return lines.length ? `<div class="notes">${lines.join('')}</div>` : ''
}

/** 何のための判断かが書かれていない（どのタスクにもつながらない）。メインが直す合図。 */
const isLoose = (i: Item) => (i.kind === 'dec' || i.kind === 'ask') && !i.related?.length
const LOOSE = '<span class="tag loose" title="関係するタスクがありません">つながりなし</span>'
const LACK = '<span class="tag lack">判断材料不足</span>'

const OK = '<span class="s-ok" aria-hidden="true">✓</span>'

// ── あなたの番 ──────────────────────────────────────────
/** 大タスクの中の並び。決める・見て・聞くの順、同じ種類は期限の近い順。 */
const RANK: Record<ItemKind, number> = { dec: 0, rev: 1, ask: 2, ack: 3 }
const dueKey = (i: Item) => (i.due ? dueAt(i.due) || Infinity : Infinity)
const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)

const streamLink = (ctx: Ctx, id: string) =>
  `<button class="tlink" data-stream="${esc(id)}">${esc(ctx.d.streams.find((s) => s.id === id)?.title ?? id)}</button>`
const crumbNav = (parts: string[]) =>
  `<nav class="crumbs" aria-label="たどり">${parts.join('<span class="sep" aria-hidden="true">›</span>')}</nav>`
const WHOLE_LINK = '<button class="tlink" data-whole>全体</button>'

const reqOf = (ctx: Ctx, id?: string) => ctx.c.requests?.find((r) => r.id === id)
const repoOf = (ctx: Ctx, i: Item): Repo | undefined => i.repo ?? i.related?.map((r) => ctx.tasks.get(r.task)?.repo).find(Boolean)

function itemRow(ctx: Ctx, x: ItemView, cur: string | undefined): string {
  const i = x.item
  const rel = i.kind === 'rev' ? reqOf(ctx, i.request)?.title ?? '' : (i.related ?? []).map((r) => ctx.tasks.get(r.task)?.title ?? r.task).join('、')
  const loose = isLoose(i) ? LOOSE : ''
  const lack = !x.closed && missingContext(i).length ? LACK : ''
  const tag = loose + lack + (x.rejudge ? '<span class="tag">再判断待ち</span>' : x.pending && !x.closed ? '<span class="tag">取り消し・反映待ち</span>' : '')
  // 期限は種類の印と同じ 1 行目に置き、題名と説明に行の幅を残す（右の列に置くと、狭い一覧で題名が 1 行数文字に折れた）。
  const due = i.due ? `<span class="due mut num">${dueHtml(i.due, ctx.now)}</span>` : ''
  return `<button class="row irow" data-id="${esc(i.id)}" aria-current="${i.id === cur}">
    <span class="rhead">${kind(i.kind, isSoon(i.due, ctx.now))}${due}</span><span><span class="t">${esc(i.title)}</span> ${tag}</span>${rel ? `<span class="s mut" title="${esc(rel)}">${esc(rel)}</span>` : ''}</button>`
}

/**
 * 要対応の一覧のまとまり（大タスクごと）。1 つの確認は代表の大タスク（itemStreams の先頭）に 1 回だけ並ぶ。
 * エージェントからの報告も同じ大タスクに入れ、まとまりの中では 判断 → 確認 → 質問 → 報告 の順。
 * まとまりは、要対応のあるものが先でその中は近い期限の順、報告だけのものが後、つながりなしは最後。
 */
export function openGroups(c: Cockpit, views: ItemView[]): { id: string; items: ItemView[] }[] {
  const groups = new Map<string, ItemView[]>()
  for (const x of views) {
    if (x.closed) continue
    const id = itemStreams(c, x.item)[0] ?? NO_STREAM
    groups.set(id, [...(groups.get(id) ?? []), x])
  }
  const work = (xs: ItemView[]) => xs.filter((x) => x.item.kind !== 'ack')
  const first = (xs: ItemView[]) => Math.min(...work(xs).map((x) => dueKey(x.item)), Infinity)
  return [...groups]
    .map(([id, xs]) => ({ id, items: xs.sort((a, b) => RANK[a.item.kind] - RANK[b.item.kind] || cmp(dueKey(a.item), dueKey(b.item))) }))
    .sort((a, b) => Number(a.id === NO_STREAM) - Number(b.id === NO_STREAM) || Number(!work(a.items).length) - Number(!work(b.items).length) || cmp(first(a.items), first(b.items)))
}

/** 一覧に並ぶ順の残（j/k もこの順）。報告も大タスクの中に並ぶ。 */
export function openItems(c: Cockpit, views: ItemView[]): ItemView[] {
  return openGroups(c, views).flatMap((g) => g.items)
}

/** 開いたときに選ぶ項目。報告を除いて期限がいちばん近いもの（同じなら並びの先、期限が無ければ先頭）。報告しか無ければ先頭の報告。 */
export function firstItem(items: ItemView[]): ItemView | undefined {
  const work = items.filter((x) => x.item.kind !== 'ack')
  return work.reduce<ItemView | undefined>((best, x) => (!best || dueKey(x.item) < dueKey(best.item) ? x : best), undefined) ?? items[0]
}

/** 一覧の大タスクの見出し。名前と今の状態を出し、押すと大タスクの画面へ上がる。 */
function groupHead(ctx: Ctx, id: string, past = false): string {
  const sv = ctx.d.streams.find((s) => s.id === id)
  if (id === NO_STREAM || !sv)
    return `<div class="shead loose"><span class="shn">大タスクにつながらない項目</span>${past ? '' : '<span class="shs mut">メインが大タスクに結び付けます</span>'}</div>`
  return `<button class="shead" data-stream="${esc(id)}"><span class="shn">${esc(sv.title)}</span><span class="go">大タスクを見る ›</span><span class="shs">${st(sv.state, sv.label)}<span class="mut">${esc(sv.now)}</span></span></button>`
}

function todo(ctx: Ctx): string {
  const groups = openGroups(ctx.c, ctx.views)
  const items = groups.flatMap((g) => g.items)
  if (!items.length) return `<div class="empty"><div class="big">${OK} 要対応なし</div><div class="mut">判断・確認・質問・報告はありません</div></div>`
  const cur = items.find((x) => x.item.id === ctx.ui.cur) ?? firstItem(items)
  const list = groups.map((g) => `<section class="sgrp">${groupHead(ctx, g.id)}${g.items.map((x) => itemRow(ctx, x, cur?.item.id)).join('')}</section>`).join('')
  return `<div class="split"><div class="list">${list}</div><div class="detail">${cur ? itemDetail(ctx, cur, false) : ''}</div></div>`
}

function related(ctx: Ctx, i: Item): string {
  if (!i.related?.length || i.decided) return ''
  return `<div class="sec"><div class="h">関係するタスク</div><ul class="rel">${i.related
    .map((r) => {
      const t = ctx.tasks.get(r.task)
      const stream = ctx.c.streams.find((s) => s.id === t?.stream)?.title ?? ''
      return `<li>${t ? st(ctx.shown(t).state) : ''}${taskLink(ctx, r.task)}<span class="mut">　${esc(stream)}</span>${r.effect ? `<span class="eff">${esc(r.effect)}</span>` : ''}</li>`
    })
    .join('')}</ul></div>`
}

function compareHtml(ctx: Ctx, i: Item): string {
  const cmp = i.compare
  if (cmp && typeof cmp === 'object')
    return `<table class="cmp"><thead><tr>${cmp.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${cmp.rows
      .map((r) => `<tr>${r.map((cell, n) => (n === 0 ? `<th>${esc(cell)}</th>` : `<td>${esc(cell)}</td>`)).join('')}</tr>`)
      .join('')}</tbody></table>${figure(ctx, i.figure)}`
  return figure(ctx, typeof cmp === 'string' ? cmp : i.figure)
}

/** 詳細の欄にある、選択肢の 1 行では足りないときに読むもの。返答の列のボタン名にも使う（「背景と比較を開く」）。 */
function moreWhat(ctx: Ctx, i: Item): string {
  return [i.background && '背景', compareHtml(ctx, i) && '比較'].filter(Boolean).join('と')
}

/** 既定では閉じた「詳細」の欄。背景・選択肢ごとの影響・選択肢の理由・この判断で変わること・関係するタスク。 */
function moreHtml(ctx: Ctx, i: Item): string {
  const parts: string[] = []
  if (i.background)
    parts.push(`<div class="sec"><div class="h">背景</div>${richText(i.background.text, repoOf(ctx, i))}${i.background.quote ? `<blockquote>${esc(i.background.quote)}${i.background.date ? `<span class="num">　${esc(fmtDate(i.background.date))}</span>` : ''}</blockquote>` : ''}</div>`)
  const cmp = compareHtml(ctx, i)
  if (cmp) parts.push(`<div class="sec"><div class="h">選択肢ごとの影響</div>${cmp}</div>`)
  const reasons = (i.options ?? []).filter((o) => (o.example && o.body) || o.quote)
  if (reasons.length)
    parts.push(`<div class="sec"><div class="h">選択肢の理由</div><ul class="plain">${reasons
      .map((o) => `<li><b>${esc(o.label)}</b>${o.example && o.body ? `　${inline(o.body, repoOf(ctx, i))}` : ''}${o.quote ? `<blockquote>${esc(o.quote)}</blockquote>` : ''}</li>`)
      .join('')}</ul></div>`)
  if ((i.why || i.quote) && i.kind !== 'dec')
    parts.push(`<div class="sec"><div class="h">判断による影響</div>${richText(i.why, repoOf(ctx, i))}${i.quote ? `<blockquote>${esc(i.quote)}</blockquote>` : ''}</div>`)
  if (!isLoose(i)) parts.push(related(ctx, i))
  const body = parts.filter(Boolean).join('')
  if (!body) return ''
  const open = !!ctx.ui.more?.[i.id]
  const what = [i.background && '背景', cmp && '比較', (i.why || i.quote) && i.kind !== 'dec' && '変わること', i.related?.length && 'タスク'].filter(Boolean).join('・')
  return `<div class="morebox" id="ck-more"><button class="morebtn" data-more="${esc(i.id)}" aria-expanded="${open}"><span class="tri" aria-hidden="true">${open ? '▾' : '▸'}</span>詳細<span class="mut">（${what}）</span></button>${open ? `<div class="morebody">${body}</div>` : ''}</div>`
}

function deliverablesOf(ctx: Ctx, i: Item): Deliverable[] {
  const all = reqOf(ctx, i.request)?.deliverables ?? []
  const picked = i.deliverable ? all.filter((d) => d.id === i.deliverable) : all
  return picked.length ? picked : i.href ? [{ id: i.id, label: '成果物', href: i.href }] : []
}

/** 「見て」の中身: 何の依頼か → 見てほしい点 → 開くボタン（PR があれば差分も）。 */
function reviewHtml(ctx: Ctx, i: Item, readOnly: boolean): string {
  const r = reqOf(ctx, i.request)
  let h = ''
  if (r) h += `<div class="ask1"><span class="mut">依頼</span>「${esc(r.quote)}」<span class="mut num">${esc(fmtDate(r.at))}</span></div>`
  const ds = deliverablesOf(ctx, i)
  const looks = ds.flatMap((d) => d.look_for ?? []).slice(0, 3)
  if (looks.length) h += `<div class="sec"><div class="h">確認の観点</div><ol class="look">${looks.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div>`
  // 開くボタンは返答の列に置く（低い窓でも「これでよい」と並んで見える）。片付け済みでは返答の列が無いので本文に置く。
  if (readOnly) h += opensHtml(ctx, i)
  return h
}

/** 成果物を開くボタン（PR があれば差分も）。 */
function opensHtml(ctx: Ctx, i: Item): string {
  const ds = deliverablesOf(ctx, i)
  if (!ds.length) return ''
  return `<div class="sec opens">${ds
      .map((d) => {
        const stale = i.deliverable_version !== undefined && d.version !== undefined && d.version !== i.deliverable_version
        return `<div class="dl">${d.href ? linkHtml(d.href, `${d.label}を開く`, true) : `<b>${esc(d.label)}</b><span class="mut">（リンクなし）</span>`}${d.diff ? linkHtml(d.diff, '差分') : ''}${d.version !== undefined ? `<span class="mut num">バージョン ${d.version}</span>` : ''}${stale ? '<span class="tag">差し替え済み・メインの更新待ち</span>' : ''}</div>`
      })
      .join('')}</div>`
}

/**
 * 決の、決めるための情報。なぜ今決めるか（why）→ 5 欄。決めるのにまず要るので、送る文面と選択肢より上に開いた状態で出す。
 * 欄が欠けていれば名指しで出す（決めるボタンは押せるまま）。
 */
function contextHtml(ctx: Ctx, x: ItemView, readOnly: boolean): string {
  const i = x.item
  const repo = repoOf(ctx, i)
  let h = ''
  if (i.why || i.quote)
    h += `<div class="sec whynow"><div class="h">${readOnly ? '理由と結果' : '今決める理由'}</div>${richText(i.why, repo)}${i.quote ? `<blockquote>${esc(i.quote)}</blockquote>` : ''}</div>`
  const lack = missingContext(i)
  if (lack.length && !readOnly) h += `<div class="lackbox">判断材料が足りません（無い欄: ${lack.join('・')}）</div>`
  const filled = CONTEXT_FIELDS.filter(([k]) => i.context?.[k]?.trim())
  if (!filled.length) return h
  const open = !ctx.ui.ctxShut?.[i.id]
  h += `<div class="ctxbox"><button class="morebtn" data-ctx="${esc(i.id)}" aria-expanded="${open}"><span class="tri" aria-hidden="true">${open ? '▾' : '▸'}</span>判断材料</button>${
    open ? `<div class="ctxbody">${filled.map(([k, label]) => `<div class="sec"><div class="h">${label}</div>${richText(i.context![k], repo)}</div>`).join('')}</div>` : ''
  }</div>`
  return h
}

/** 送れる書きかけか（空でなく、上限以内）。 */
export const sendable = (text: string) => !!text.trim() && !textError(text)
/** 字数と上限。超えたら送れないことを出す（切り詰めない）。controller が入力のたびに同じ文で差し替える。 */
export function countText(text: string): { text: string; over: boolean } {
  const over = text.length > TALK_MAX
  return { text: over ? `${text.length} / ${TALK_MAX} 字。${text.length - TALK_MAX} 字多いので送れません` : `残り ${TALK_MAX - text.length} 字`, over }
}
function countHtml(kind: 'chat' | 'other', id: string, text: string): string {
  const c = countText(text)
  return `<span class="count${c.over ? ' over-limit' : ''}" data-count="${kind}:${esc(id)}">${esc(c.text)}</span>`
}

/**
 * 選択肢に無い答えや、もう済んだことを書いて送る欄。どの種類の項目にも常に出す。
 * 送ると decide・option_id "other"・text になる。質問（話したい）とは見出しと説明で分ける。
 */
function otherHtml(ctx: Ctx, i: Item): string {
  const draft = ctx.ui.otherDraft?.[i.id] ?? ''
  // 選択肢を持つのは決めるだけなので、ほかの種類では「選択肢」と書かない。
  const head = i.kind === 'dec' ? '選択肢以外で決める<span class="mut">　選択肢に無い答えや、もう済んだことを書いて送る</span>' : '別の返事を書く<span class="mut">　ほかの返事や、もう済んだことを書いて送る</span>'
  return `<div class="sec other"><div class="h">${head}</div>
    <div class="otherin"><textarea data-otherbox="${esc(i.id)}" rows="1" placeholder="例: もう手で送った／A 案で、ただし期限は金曜" aria-label="別の答え">${esc(draft)}</textarea><button class="btn sm" data-other="${esc(i.id)}"${sendable(draft) ? '' : ' disabled'}>この答えで送る</button></div>${countHtml('other', i.id, draft)}</div>`
}

/** 外に送る文面。送る見た目に近い枠（宛先の行と、改行を保った本文）で、選択肢の前に出す。 */
function draftHtml(i: Item): string {
  const d = i.draft!
  return `<div class="sec draft"><div class="h">送る文面</div><div class="dbox"><div class="dto"><span class="mut">宛先</span>${esc(d.to)}</div><div class="dtext">${esc(d.text)}</div></div>
    <div class="dacts"><button class="btn sm" data-copydraft="${esc(i.id)}">本文をコピー</button>${d.href ? linkHtml(d.href, '下書きを開く') : ''}</div></div>`
}

const hm = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 項目（またはタスク）ごとのやり取り。利用者の発言は操作ログの talk、回答は cockpit.talk.json。
 * 入力欄は「話したい」を押したときだけ開き、やり取りがあればいつも出す。
 */
function talkHtml(ctx: Ctx, id: string, repo?: Repo): string {
  const ops = ctx.v.log.ops.filter((o) => o.type === 'talk' && o.item_id === id && (o.text || o.to_main))
  const open = ctx.ui.chat === id
  if (!ops.length && !open) return ''
  const thinking = new Set(ctx.v.thinking ?? [])
  let h = ''
  for (const o of ops) {
    // 引き継ぎ（と本文の無い古い引き継ぎ）は、元の発言を繰り返さずに 1 行で出し、メインの回答はその下に出す。
    const handoff = o.handoff_of !== undefined || (o.to_main && !o.text?.trim())
    if (handoff) h += `<div class="msg sys"><span class="mut">${esc(hm(o.at))}</span> メインに渡しました。メインが次に読みます</div>`
    else h += `<div class="msg me"><div class="who">あなた${o.to_main ? '（メインに渡す）' : ''}<span class="mut num">${esc(hm(o.at))}</span></div><div class="txt">${richText(o.text, repo)}</div></div>`
    const rs = ctx.v.replies.filter((r) => r.op_id === o.op_id)
    for (const r of rs) {
      const handed = ctx.v.log.ops.some(
        (x) => x.type === 'talk' && x.item_id === id && (x.handoff_of === o.op_id || (x.to_main && !x.text?.trim() && x.op_id > o.op_id))
      )
      h += `<div class="msg ${r.by === 'main' ? 'main' : 'ai'}${r.failed ? ' failed' : ''}"><div class="who">${r.by === 'main' ? MAIN_WHO : AI_WHO}<span class="mut num">${esc(hm(r.at))}</span></div><div class="txt">${richText(r.text, repo)}</div>${
        r.handoff && !handed ? `<div class="msgacts"><span class="mut">判断・作業・変更が要る話です</span><button class="btn sm" data-handoff="${esc(id)}" data-of="${o.op_id}">メインに渡す</button><span class="mut">押すと同じ質問をメインに回し、メインが作業や判断の変更まで受け持ちます</span></div>` : ''
      }</div>`
    }
    if (!rs.length && !o.to_main)
      h += thinking.has(o.op_id)
        ? `<div class="msg ai wait"><div class="who">${AI_WHO}</div><div class="txt mut">関係するファイルを読んでいます…</div></div>`
        : `<div class="msg ai wait"><div class="txt mut">回答待ち（窓の常駐のプロセスが答えます。メインも次に読みます）</div></div>`
  }
  const fix = ctx.ui.fix === id
  const draft = ctx.ui.chatDraft?.[id] ?? ''
  const input = open
    ? `<div class="chatin">${fix ? '<div class="fixhint"><b>どこを直すかを書いて送ってください。</b><span class="mut">メインに渡します（すぐの回答では直せません）</span></div>' : ''}<textarea data-chatbox="${esc(id)}" rows="3" placeholder="聞きたいこと・気になることを書いてください" aria-label="話したいこと">${esc(draft)}</textarea>
        <div class="chatacts"><span class="mut">⌘Enter で送る。すぐの回答は読むだけで、判断や作業はメインに渡します</span>${countHtml('chat', id, draft)}<button class="btn pri sm" data-send="${esc(id)}"${sendable(draft) ? '' : ' disabled'}>${fix ? 'メインに送る' : '送る'}</button></div></div>`
    : ''
  return `<div class="sec talk"><div class="h">質問・相談<span class="mut">　決める前に聞く。すぐの回答（読むだけ）か、メインが答える</span></div>${h}${input}</div>`
}


/**
 * 確認の詳細の上のたどり「全体 › 代表の大タスク › タスク」と、ほかに関係する大タスク。どれも押せる。
 * どの大タスクにも結び付かない報告には出さない。
 */
function itemCrumbs(ctx: Ctx, i: Item): string {
  const ss = itemStreams(ctx.c, i)
  if (!ss.length && i.kind === 'ack') return ''
  const home = ss[0] ?? NO_STREAM
  const tid = itemTaskIds(ctx.c, i).find((id) => ss.length && ctx.tasks.get(id)?.stream === home)
  const parts = [WHOLE_LINK, ctx.d.streams.some((s) => s.id === home) ? streamLink(ctx, home) : LOOSE]
  if (tid) parts.push(`<button class="tlink" data-task="${esc(tid)}">${esc(ctx.tasks.get(tid)!.title)}</button>`)
  const others = ss.slice(1)
  return crumbNav(parts) + (others.length ? `<div class="also">ほかに関係する大タスク ${others.map((id) => streamLink(ctx, id)).join('')}</div>` : '')
}

/** 残の詳細と、片付け済みの読み取り専用の詳細。最初に見えるのは たどり → 何のため → 選択肢 → 返答のボタン。 */
function itemDetail(ctx: Ctx, x: ItemView, readOnly: boolean): string {
  const i = x.item
  const opts = i.options ?? []
  const picked = ctx.ui.pick[pickKey(i)]
  const first = ctx.tasks.get(i.related?.[0]?.task ?? '')
  // 期限は左の一覧の行と同じなので出さない。たどりは上の大タスクへ 1 クリックで上がるために出す（S15）。
  let h = itemCrumbs(ctx, i) + `<div class="meta mut">${kind(i.kind, !readOnly && isSoon(i.due, ctx.now))}</div>`
  if (first?.goal) h += `<div class="goal"><span class="lbl">目的</span>${esc(first.goal)}</div>`
  // 題名は左の一覧で選んでいる行と同じなので、画面には出さず、読み上げの見出しにだけ残す。
  h += `<h2 class="vh">${esc(i.title)}</h2>`
  if (readOnly) h += `<div class="meta">${esc(x.how)}${x.when ? `<span class="mut">　${esc(fmtDate(x.when))}</span>` : ''}</div>`
  if (x.rejudge) h += `<div class="fallback">対応済みにしたあとに取り消しました。メインが作業を戻すかを決め直します。</div>`
  if (isLoose(i)) h += `<div class="sec">${LOOSE}</div>`
  if (i.kind === 'dec') h += contextHtml(ctx, x, readOnly)
  if (i.kind === 'rev') h += reviewHtml(ctx, i, readOnly)
  if (i.decided?.length) {
    const asked = new Set(
      unappliedOps(ctx.c, ctx.v.log).filter((o) => o.type === 'revert' && o.item_id === i.id && o.item_rev === i.rev).map((o) => o.target)
    )
    const back = (n: number) =>
      readOnly ? '' : asked.has(n) ? '<span class="tag">戻す依頼・反映待ち</span>' : `<button class="link" data-revert="${n}">戻して</button>`
    h += `<div class="sec"><table class="mini">${i.decided
      .map((d, n) => `<tr><td>${inline(d.what, repoOf(ctx, i))}${d.task ? `<div>${taskLink(ctx, d.task)}</div>` : ''}</td><td class="mut">${inline(d.why ?? '', repoOf(ctx, i))}</td><td>${back(n)}</td></tr>`)
      .join('')}</table></div>`
  }
  if (i.kind === 'ack' && (i.why || i.href)) h += `<div class="sec">${richText(i.why, repoOf(ctx, i))}${i.href ? `<div class="opens">${linkHtml(i.href, '成果物を開く', true)}</div>` : ''}</div>`
  if (i.draft) h += draftHtml(i)
  if (opts.length && (i.kind === 'dec' || i.kind === 'ask')) {
    h += `<div class="sec"><div class="h">${i.kind === 'ask' ? '聞き方' : '選択肢'}</div>` + opts
      .map((o, n) => {
        const took = x.chosen?.id === o.id
        const line = o.example ?? o.body
        const inner = `<span class="key">${i.kind === 'dec' ? n + 1 : '・'}</span><div><b>${esc(o.label)}</b>${o.recommended ? '<span class="badge b-rec">おすすめ</span>' : ''}${took ? '<span class="badge b-took">採用</span>' : ''}
          ${line ? `<div class="ex">${o.example ? '<span class="exl">例</span>' : ''}${inline(line, repoOf(ctx, i), readOnly || i.kind !== 'dec')}</div>` : ''}</div>`
        return readOnly || i.kind !== 'dec'
          ? `<div class="opt ${o.recommended ? 'rec' : ''}">${inner}</div>`
          : `<button class="opt ${o.recommended ? 'rec' : ''}" data-pick="${esc(o.id)}" aria-pressed="${picked === o.id}">${inner}</button>`
      })
      .join('') + `</div>`
  }
  if (!readOnly) h += otherHtml(ctx, i)
  if (i.links?.length) h += `<div class="links">${i.links.map((l) => linkHtml(l.href, l.label)).join('')}</div>`
  if (i.kind !== 'ack') h += moreHtml(ctx, i)
  h += talkHtml(ctx, i.id, repoOf(ctx, i))
  if (readOnly) {
    if (x.reopenOp) h += `<div class="acts"><button class="btn" data-reopen="${esc(i.id)}">要対応に戻す</button></div>`
  } else {
    let main = ''
    if (i.kind === 'dec') {
      const o = opts.find((x) => x.id === picked)
      main = o ? `<button class="btn pri" data-decide title="「${esc(o.label)}」で決める">この案で決める</button>` : `<button class="btn pri" data-decide disabled>選択肢を選ぶ</button>`
    } else if (i.kind === 'ask') main = `<button class="btn pri" data-approve>この聞き方でよい</button>`
    else if (i.kind === 'rev') main = `${opensHtml(ctx, i)}<button class="btn pri" data-accept>これでよい</button><button class="btn" data-fix>直してほしい</button>`
    else main = `<button class="btn pri" data-ack>確認した</button>`
    const talk = `<button class="btn" data-talk="${esc(i.id)}" aria-expanded="${ctx.ui.chat === i.id}">質問する</button>${
      i.kind !== 'dec' ? '' : contextAsked(i, ctx.v.log) ? '<span class="tag">判断材料を依頼済み</span>' : `<button class="btn" data-needctx="${esc(i.id)}" title="質問の欄に書きかけがあれば、何が知りたいかとして一緒に渡します">判断材料を求める</button>`
    }`
    // 詳細の欄が画面の外にあるときだけ見せる（controller が描いたあとに確かめて隠す）。
    const what = i.kind === 'ack' || ctx.ui.more?.[i.id] ? '' : moreWhat(ctx, i)
    const jump = what ? `<button class="link jump" data-jump="${esc(i.id)}">${what}を開く</button>` : ''
    // 回答が無い場合の注記は本文に置き、下端に留める返答の列を 1 行に収める（高さ 500px の窓で本文が読める高さを残す）。
    if (i.fallback) h += `<div class="fbline mut">回答が無い場合: ${esc(i.fallback)}</div>`
    h += `<div class="acts">${main}${talk}${jump}</div>`
  }
  if (i.source) h += `<div class="src mut">出典 ${linkHtml(i.source)}</div>`
  return h
}

// ── 全体 ────────────────────────────────────────────────
/** 次の節目を近い順に 3 件。残りは「ほか n 件」で畳む（日付の位置に並べた線は、近い節目が重なって読めなかった）。 */
function milestones(ctx: Ctx): string {
  const ms = upcomingMilestones(ctx.c.workspace.milestones, ctx.now)
  if (!ms.length) return ''
  const all = !!ctx.ui.showMs
  const shown = all ? ms : ms.slice(0, 3)
  const li = (m: (typeof ms)[number]) =>
    `<li><span class="num">${esc(fmtDate(m.date.slice(0, 10)))}</span><span class="msd${m.left === 0 ? ' today' : ''}">${m.left === 0 ? '今日' : `あと <span class="num">${m.left}</span> 日`}</span><span>${esc(m.label)}</span></li>`
  const more = ms.length > 3 ? `<button class="more" data-ms aria-expanded="${all}">${all ? '畳む' : `ほか ${ms.length - 3} 件`}</button>` : ''
  return `<section class="side-sec"><h3 class="h">次の節目</h3><ul class="msl">${shown.map(li).join('')}</ul>${more}</section>`
}

/**
 * 工程の進み。済んだ工程・今の工程・まだの工程を印の列で見せ、今の工程の名前を添える。
 * 工程ごとのタスクの数は出さない（どこまで進んだかだけが分かればよい）。
 */
function phaseBar(sv: StreamView, names = false): string {
  const phases = sv.phases
  if (!sv.tasks.length) return '<span class="pbar mut">タスクなし</span>'
  const done = sv.state === 'ok'
  const at = done ? phases.length - 1 : sv.phaseAt
  const pips = phases.map((p, n) => `<i class="pp${n < at ? ' on' : n === at ? ' cur' : ''}" title="${esc(p)}"></i>`).join('')
  const step = `工程 <span class="num">${at + 1}/${phases.length}</span>`
  const name = done ? '全工程 完了' : at < 0 ? `${step} 未着手` : `${step} ${esc(sv.phase ?? '')}`
  // 大タスクの画面では工程の名前を全部並べ、今の工程を太字にする（全体の行では印と今の工程だけ）。
  const list = names
    ? `<span class="ppl">${phases.map((p, n) => (n === at && !done ? `<b>${esc(p)}</b>` : `<span class="${n < at || done ? '' : 'mut'}">${esc(p)}</span>`)).join('<span class="mut" aria-hidden="true"> › </span>')}</span>`
    : ''
  return `<span class="pbar" title="${esc(phases.join(' › '))}"><span class="pps" aria-hidden="true">${pips}</span><span class="ppn">${name}</span>${list}</span>`
}

/** 全体の大タスクのまとまり。利用者の手当ての要る順に並べ、各大タスクは 1 か所だけに出す。 */
const BUCKETS: { key: string; label: string; of: (s: StreamView) => boolean }[] = [
  { key: 'yours', label: '要対応あり', of: (s) => s.home.length > 0 },
  { key: 'stop', label: '止まっている', of: (s) => s.state === 'stop' },
  { key: 'wait', label: '外部待ち', of: (s) => s.state === 'wait' },
  { key: 'run', label: '進行中', of: (s) => s.state === 'run' },
  { key: 'idle', label: '未着手', of: (s) => s.state === 'idle' },
  { key: 'ok', label: '完了', of: (s) => s.state === 'ok' }
]
export function streamBuckets(ss: StreamView[]): { key: string; label: string; streams: StreamView[] }[] {
  const due = (s: StreamView) => (s.due ? dueAt(s.due) || Infinity : Infinity)
  const left = [...ss]
  return BUCKETS.map((b) => {
    const mine = left.filter(b.of).sort((a, z) => Number(a.id === NO_STREAM) - Number(z.id === NO_STREAM) || cmp(due(a), due(z)))
    for (const s of mine) left.splice(left.indexOf(s), 1)
    return { key: b.key, label: b.label, streams: mine }
  }).filter((b) => b.streams.length)
}

/** 全体の大タスクの 1 行。行ごと押せて、名前・今の状況・工程・要対応と期限を 1 行に並べる。 */
function streamRow(ctx: Ctx, s: StreamView): string {
  const name = s.id === NO_STREAM ? '大タスクにつながらないタスク' : s.title
  const todo = s.home.length
    ? `<span class="ovt"><b>要対応 <span class="num">${s.home.length}</span> 件</b>${s.due ? ` ${dueHtml(s.due, ctx.now)}` : ''}</span>`
    : '<span class="ovt"></span>'
  return `<li><button class="ovr" data-stream="${esc(s.id)}">
    <span class="ovn">${st(s.state, s.label)}<span class="t">${esc(name)}</span></span>
    ${todo}<span class="ovsub"><span class="ovnow">${esc(s.detail)}</span>${phaseBar(s)}</span></button></li>`
}

function overview(ctx: Ctx): string {
  const buckets = streamBuckets(ctx.d.streams)
  if (!buckets.length) return '<div class="mut">大タスクはまだありません</div>'
  const showDone = !!ctx.ui.showDone[DONE_STREAMS]
  return buckets
    .map((b) => {
      const fold = b.key === 'ok'
      const head = fold
        ? `<button class="ovh more-h" data-done="${DONE_STREAMS}" aria-expanded="${showDone}"><span class="tri" aria-hidden="true">${showDone ? '▾' : '▸'}</span>${b.label} <span class="num">${b.streams.length}</span> 件</button>`
        : `<h3 class="ovh">${b.label} <span class="num">${b.streams.length}</span> 件</h3>`
      return `<section class="ovsec ov-${b.key}">${head}${!fold || showDone ? `<ul class="ovl">${b.streams.map((s) => streamRow(ctx, s)).join('')}</ul>` : ''}</section>`
    })
    .join('')
}

/** 大タスクの画面で j/k が動くタスク。済んでいないもの、完了は開いているときだけ。 */
export function streamTasks(c: Cockpit, ui: Ui, id: string): Task[] {
  const known = new Set(c.streams.map((s) => s.id))
  const ts = c.tasks.filter((t) => (id === NO_STREAM ? !known.has(t.stream) : t.stream === id))
  return [...ts.filter((t) => t.state !== 'ok'), ...(ui.showDone[id] ? ts.filter((t) => t.state === 'ok') : [])]
}

/** タスクの大タスク（どの大タスクにも入らなければ NO_STREAM）。 */
export const taskStream = (c: Cockpit, t: Task) => (c.streams.some((s) => s.id === t.stream) ? t.stream : NO_STREAM)

/** 済んでいない依頼（先週以前でも残す）。古いものから並べ、放置に気付けるようにする。 */
export function openRequests(d: Derived): RequestView[] {
  return d.requests.filter((r) => r.status !== 'done').sort((a, b) => new Date(a.request.at).getTime() - new Date(b.request.at).getTime())
}
const requestOf = (ctx: Ctx, r: Request) => ctx.d.requests.find((x) => x.request === r)!

function requestsTop(ctx: Ctx): string {
  const rs = openRequests(ctx.d)
  if (!rs.length) return ''
  return `<section class="side-sec reqs"><h3 class="h">まだ済んでいない依頼 <span class="num">${rs.length}</span> 件</h3><ul class="rel">${rs
    .map(({ request: r, status, label }) =>
      `<li><button class="tlink" data-req="${esc(r.id)}" aria-current="${ctx.ui.curReq === r.id}">${esc(r.title)}</button><span class="rs rs-${status}">${label}</span><span class="mut num">依頼 ${esc(fmtDate(r.at))}</span></li>`)
    .join('')}</ul></section>`
}

/**
 * 全体のタブ。何も選んでいなければ全体（大タスクを手当ての要る順にまとめたものと、横に節目・顧客への確認・依頼）、
 * 選んでいれば大タスク・タスク・依頼の画面。どの画面も上にたどりを置き、1 クリックで全体へ戻れる。
 */
function whole(ctx: Ctx): string {
  const { c, ui } = ctx
  const req = ui.curReq ? c.requests?.find((r) => r.id === ui.curReq) : undefined
  const task = !req && ui.curTask ? ctx.tasks.get(ui.curTask) : undefined
  const sv = !req && !task && ui.curStream !== undefined ? ctx.d.streams.find((s) => s.id === ui.curStream) : undefined
  const page = (crumbs: string[], body: string) => `<div class="whole-top wpage"><div class="detail">${backBar(ctx)}${crumbNav(crumbs)}${body}</div></div>`
  if (req) return page([WHOLE_LINK, '<span class="here">依頼</span>'], requestDetail(ctx, req, false))
  if (task) {
    const sid = taskStream(c, task)
    return page([WHOLE_LINK, sid === NO_STREAM ? `<button class="tlink" data-stream="${NO_STREAM}">${LOOSE}</button>` : streamLink(ctx, sid), `<span class="here">${esc(task.title)}</span>`], taskDetail(ctx, task))
  }
  if (sv) return page([WHOLE_LINK, `<span class="here">${sv.id === NO_STREAM ? LOOSE : esc(sv.title)}</span>`], streamPage(ctx, sv))
  const side = `${milestones(ctx)}${awaiting(ctx)}${requestsTop(ctx)}`
  return `<div class="whole-top ov"><div class="ovmain"><h2 class="vh">大タスク</h2>${overview(ctx)}</div>${side ? `<aside class="ovside">${side}</aside>` : ''}</div>`
}

/** 確認から上がってきたときだけ出す「確認『○○』に戻る」。戻る先が無くなっていれば出さない。 */
function backBar(ctx: Ctx): string {
  const b = ctx.ui.back
  const x = b && ctx.views.find((v) => v.item.id === b.item && v.closed === (b.tab === 'arch'))
  if (!x) return ''
  return `<div class="backbar"><button class="btn sm" data-back>‹ ${KIND[x.item.kind][0]}「${esc(x.item.title)}」に戻る</button></div>`
}

const EVENT: Record<StreamEvent['kind'], string> = {
  start: '発端', req: '依頼', reqdone: '依頼が完了', dec: '判断', ask: '聞き方を承認', asked: '顧客に確認', rev: '成果物を確認', ack: '報告を確認', done: '作業', wait: '外部待ち'
}
/** 経過で最初から見せる件数。古いものは畳む。 */
const TL_SHOWN = 6

/**
 * 大タスクの経過。日付のある出来事を古い順に並べ、最後に「今」（済んでいないタスクの様子）と「次」（タスクの次の作業）を置く。
 * 出来事は state.ts の streamTimeline が事実から決める。
 */
function timeline(ctx: Ctx, sv: StreamView): string {
  const ev = streamTimeline(ctx.c, sv, ctx.d.tasks)
  const key = `${sv.id}#tl`
  const all = !!ctx.ui.showDone[key]
  const shown = all ? ev : ev.slice(-TL_SHOWN)
  const li = (e: StreamEvent) => {
    const text = e.item ? `<button class="tlink" data-goarch="${esc(e.item)}">${esc(e.text)}</button>` : e.req ? `<button class="tlink" data-req="${esc(e.req)}">${esc(e.text)}</button>` : `<span>${esc(e.text)}</span>`
    return `<li class="tle"><span class="tld num">${esc(fmtDate(e.at))}</span><span class="tlk">${EVENT[e.kind]}</span><span class="tlt">${text}${e.note ? `<span class="tln mut">${esc(e.note)}</span>` : ''}</span></li>`
  }
  const live = sv.tasks.filter((t) => ctx.shown(t).state !== 'ok')
  const nowLines = live.length
    ? live.map((t) => `<div class="tlnow">${st(ctx.shown(t).state)}<span>${esc(ctx.shown(t).situation)}</span><span class="tln mut">${esc(t.title)}</span></div>`).join('')
    : `<div class="tlnow">${st(sv.state, sv.label)}<span>${esc(sv.detail)}</span></div>`
  const nexts = live.filter((t) => t.next?.trim() && ctx.shown(t).why !== 'yours')
  const shared = sv.open.length - sv.home.length
  const reply = [sv.home.length && `あなたの対応 ${sv.home.length} 件`, shared && `ほかの大タスクと共通の ${shared} 件`].filter(Boolean).join('と、')
  const nextLines = [
    ...(reply ? [`<div class="tlnow"><span>${reply}への返事</span></div>`] : []),
    ...nexts.map((t) => `<div class="tlnow"><span>${esc(t.next!.trim())}</span><span class="tln mut">${esc(t.title)}</span></div>`)
  ]
  const more = ev.length > TL_SHOWN ? `<button class="more" data-done="${esc(key)}" aria-expanded="${all}">${all ? '古い出来事を畳む' : `それより前の ${ev.length - TL_SHOWN} 件を表示`}</button>` : ''
  return `<section class="sec epsec"><h3 class="h">経過</h3>${more}<ol class="tl">${shown.map(li).join('')}${
    ev.length ? '' : '<li class="tle"><span class="tld"></span><span class="tlk"></span><span class="tlt mut">日付のある記録はまだありません</span></li>'
  }<li class="tle now"><span class="tld">今</span><span class="tlk">いまの状態</span><div class="tlt">${nowLines}</div></li>${
    nextLines.length ? `<li class="tle next"><span class="tld">次</span><span class="tlk">次に起きること</span><div class="tlt">${nextLines.join('')}</div></li>` : ''
  }</ol></section>`
}

/** 大タスクの画面の、利用者のする確認と読むだけの報告の行。 */
function mineRow(ctx: Ctx, i: Item): string {
  return `<li><button class="mrow" data-goto="${esc(i.id)}">${kind(i.kind, i.kind !== 'ack' && isSoon(i.due, ctx.now))}<span class="t">${esc(i.title)}</span>${i.due && i.kind !== 'ack' ? `<span class="mut num">${dueHtml(i.due, ctx.now)}</span>` : ''}</button></li>`
}

/**
 * 大タスクの画面。上から、今どうなっているか（状態・工程・ゴール）→ あなたの対応 → 経過（出来事・今・次）→ タスク → 背景と資料。
 * 対応済みの確認は経過の中に日付つきで並ぶ。
 * 利用者が開いて最初に知りたい「今どうなっていて、自分は何をするか」を上に置き、経緯は判断に迷ったときに読む場所として下にまとめる。
 * 説明（summary・background）が無くても、依頼の原文と出典はいつも出す。
 */
function streamPage(ctx: Ctx, sv: StreamView): string {
  const s = sv.stream
  const repo = sv.tasks.map((t) => t.repo).find(Boolean)
  let h = `<header class="ephead"><h2 class="eph">${sv.id === NO_STREAM ? '大タスクにつながらないタスク' : esc(sv.title)}</h2>`
  h += `<div class="epstat"><span class="epst">${st(sv.state, sv.label)}<b>${esc(sv.label)}</b></span>${phaseBar(sv, true)}</div><p class="epnow">${esc(sv.detail)}</p>`
  if (s?.summary) h += `<p class="lead"><span class="lbl">ゴール</span>${inline(s.summary, repo)}</p>`
  h += '</header>'

  // 件数は要対応の一覧でこの大タスクに並ぶもの（全体の件数と同じ）。ほかの大タスクに並ぶ関係する確認は、下に分けて出す。
  const byDue = (xs: Item[]) => [...xs].sort((a, b) => cmp(dueKey(a), dueKey(b)))
  const mine = byDue(sv.home)
  const shared = byDue(sv.open.filter((i) => !sv.home.includes(i)))
  const list = (xs: Item[]) => `<ul class="mlist">${xs.map((i) => mineRow(ctx, i)).join('')}</ul>`
  h += `<section class="epbox${mine.length ? ' hot' : ''}"><h3 class="h">あなたの対応 <span class="num">${mine.length}</span> 件</h3>${
    mine.length ? list(mine) : `<p class="mut">${OK} 今はありません</p>`
  }${shared.length ? `<div class="subh">ほかの大タスクと共通の要対応 <span class="num">${shared.length}</span> 件</div>${list(shared)}` : ''}${
    sv.reports.length ? `<div class="subh">エージェントからの報告</div>${list(sv.reports)}` : ''
  }</section>`

  h += timeline(ctx, sv)
  const live = sv.tasks.filter((t) => t.state !== 'ok'), done = sv.tasks.filter((t) => t.state === 'ok')
  const showDone = !!ctx.ui.showDone[sv.id]
  const taskLi = (t: Task) => {
    const sh = ctx.shown(t)
    return `<li><button class="trow" data-task="${esc(t.id)}">${st(sh.state)}<span class="t">${esc(t.title)}</span><span class="tph mut">${esc(t.phase)}</span><span class="ts ${sh.why === 'missing' ? 'warn' : 'mut'}">${esc(sh.situation)}</span></button></li>`
  }
  h += `<section class="sec epsec"><h3 class="h">タスク 残り <span class="num">${live.length}</span> 件${done.length ? `<span class="mut">（完了 <span class="num">${done.length}</span> 件）</span>` : ''}</h3><ul class="tlist">${[...live, ...(showDone ? done : [])].map(taskLi).join('')}</ul>${
    done.length ? `<button class="more" data-done="${esc(sv.id)}" aria-expanded="${showDone}">${showDone ? '完了したタスクを畳む' : `完了したタスク ${done.length} 件を表示`}</button>` : ''
  }</section>`

  const bg = s?.background
  const ids = new Set(sv.tasks.map((t) => t.id))
  const reqs = (ctx.c.requests ?? []).filter((r) => r.tasks?.some((id) => ids.has(id)))
  const srcs = [...new Set([...(s?.sources ?? []), ...sv.tasks.flatMap((t) => t.sources ?? [])])]
  let story = ''
  if (bg)
    story += `<div class="bgp"><div class="lbl2">いきさつ</div>${richText(bg.text, repo)}${
      bg.quote ? `<blockquote>${esc(bg.quote)}${bg.date ? `<span class="num">　${esc(fmtDate(bg.date))}</span>` : ''}</blockquote>` : bg.date ? `<div class="mut num note">${esc(fmtDate(bg.date))}</div>` : ''
    }</div>`
  if (sv.id !== NO_STREAM && !s?.summary?.trim() && !bg?.text?.trim())
    story += `<div class="nodesc"><span class="tag">ゴールといきさつが未記入</span></div>`
  if (reqs.length)
    story += `<div class="bgp"><div class="lbl2">あなたの依頼（原文）</div><ul class="rel reqq">${reqs
      .map((r) => `<li><button class="tlink" data-req="${esc(r.id)}">${esc(r.title)}</button><span class="mut num">${esc(fmtDate(r.at))}</span><blockquote class="orig">${esc(r.quote)}</blockquote></li>`)
      .join('')}</ul></div>`
  if (srcs.length) story += `<div class="bgp"><div class="lbl2">出典</div><div class="srcs">${srcs.map((u) => linkHtml(u)).join('')}</div></div>`
  if (story) h += `<section class="sec epsec story"><h3 class="h">背景と資料</h3>${story}</section>`

  return h
}

function workerChip(w: AgentRow, now: number): string {
  if (w.stop) return stopChip(w, now)
  return `<span class="chip">${st(w.state === 'working' ? 'run' : 'idle')}worker ${w.state === 'working' ? '作業中' : '入力待ち'}<button class="link" data-agent="${esc(w.terminalId ?? '')}" data-wt="${esc(w.worktree ?? '')}">端末を開く</button></span>`
}

/** 依頼 1 件: 原文・状態・タスク・成果物・見ての項目。 */
function requestDetail(ctx: Ctx, r: Request, readOnly: boolean): string {
  const { status, label } = requestOf(ctx, r)
  let h = `<div class="meta mut"><span class="kind k-req">依頼</span><span class="num">${esc(fmtDate(r.at))}</span><span class="rs rs-${status}">${label}</span></div><h2>${esc(r.title)}</h2>`
  h += `<blockquote class="orig">${esc(r.quote)}</blockquote>`
  if (r.tasks?.length)
    h += `<div class="sec"><div class="h">タスク</div><ul class="rel">${r.tasks
      .map((tid) => {
        const t = ctx.tasks.get(tid)
        const ws = ctx.v.workers.filter((w) => w.task === tid)
        return `<li>${t ? st(ctx.shown(t).state) : ''}${taskLink(ctx, tid)}${t ? `<span class="${ctx.shown(t).why === 'missing' ? 'warn' : 'mut'}">${esc(shownLabel(ctx, t))}</span>` : ''}${ws.map((w) => workerChip(w, ctx.now)).join('')}</li>`
      })
      .join('')}</ul></div>`
  if (r.deliverables?.length)
    h += `<div class="sec"><div class="h">成果物</div><ul class="rel">${r.deliverables
      .map((d) => {
        const rev = ctx.views.find((x) => x.item.kind === 'rev' && x.item.request === r.id && x.item.deliverable === d.id)
        const state = rev
          ? rev.closed ? `<span class="rs rs-done">${esc(rev.how)}</span>` : `<button class="tlink" data-goto="${esc(rev.item.id)}">確認（要対応）</button>`
          : '<span class="mut">報告のみ</span>'
        return `<li>${d.href ? linkHtml(d.href, d.label) : `<b>${esc(d.label)}</b>`}${d.diff ? linkHtml(d.diff, '差分') : ''}${d.version !== undefined ? `<span class="mut num">バージョン ${d.version}</span>` : ''}${state}</li>`
      })
      .join('')}</ul></div>`
  if (readOnly && r.done_at) h += `<div class="src mut">完了 ${esc(fmtDate(r.done_at))}</div>`
  return h
}

/** 聞き方を承認した問い（関係するタスクが外部待ち）。メインが実際に聞いた（asked_at がある）ものだけを回答待ちと呼ぶ。 */
function awaiting(ctx: Ctx): string {
  const rows = ctx.views.filter((x) =>
    x.closed && x.item.kind === 'ask' && x.item.related?.some((r) => {
      // 外の相手を待つのは、メインの書いた wait だけ（利用者の番の wait と、worker の取り込み待ちは除く）
      const t = ctx.d.tasks.get(r.task)
      return t?.why === 'record' && t.state === 'wait'
    }))
  if (!rows.length) return ''
  const meeting = (due?: string) => {
    const m = ctx.c.workspace.milestones?.find((k) => due && k.date.slice(0, 10) === due.slice(0, 10))
    return due ? `${fmtDate(due.slice(0, 10))}${m ? ` ${m.label}` : ''}` : ''
  }
  const day = (iso?: string) => (iso ? esc(fmtDate(iso.slice(0, 10))) : '')
  const asked = rows.filter((x) => x.item.asked_at).length
  return `<section class="side-sec await"><h3 class="h">顧客への確認 <span class="num">${rows.length}</span> 件<span class="mut">（回答待ち ${asked} 件・確認予定 ${rows.length - asked} 件）</span></h3><ul class="rel">${rows
    .map((x) => `<li>${kind('ask')}<button class="tlink" data-goarch="${esc(x.item.id)}">${esc(x.item.title)}</button>${
      x.item.asked_at
        ? `<span class="eff">回答待ち（<span class="num">${day(x.item.asked_at)}</span> から）</span>`
        : `<span class="eff">確認予定</span><span class="mut num">（聞き方を承認 ${day(x.when)}）</span>${x.item.due ? `<span class="mut num">聞く ${esc(meeting(x.item.due))}</span>` : ''}`
    }</li>`)
    .join('')}</ul></section>`
}

function taskDetail(ctx: Ctx, t: Task): string {
  const decs = ctx.views.filter((x) => x.item.related?.some((r) => r.task === t.id) || x.item.decided?.some((d) => d.task === t.id))
  const reqs = (ctx.c.requests ?? []).filter((r) => r.tasks?.includes(t.id))
  // 大タスクは上のたどりに出すので、ここには工程だけを出す。
  let h = `<div class="meta mut">${esc(t.phase)}</div><h2>${esc(t.title)} <span class="stb">${shownHtml(ctx, t, '')}</span></h2>`
  if (t.goal) h += `<div class="sec"><div class="h">目的</div>${esc(t.goal)}</div>`
  // 完了したタスクに残った「次の作業」は、状態の「完了」と食い違うので出さない。
  if (t.next && t.state !== 'ok') h += `<div class="sec"><div class="h">次の作業</div>${esc(t.next)}</div>`
  // 選んだ直後に出どころ（議事録・設計書・画面の案）といまの案が見えるよう、何のため・次にやることの直後に置く。
  if (t.sources?.length) h += `<div class="src mut">出典 ${t.sources.map((s) => linkHtml(s)).join('')}</div>`
  const fig = figure(ctx, t.figure)
  if (fig) h += `<div class="sec"><div class="h">現在の案</div>${fig}</div>`
  // パネルは worker とタスクを結べない（Orca の worktree の一覧を持たない）ので、worker の欄は窓だけに出す。
  if (t.worker && ctx.v.worktrees) {
    const ws = ctx.v.workers.filter((w) => w.task === t.id)
    const why = ctx.shown(t).why
    const note = why === 'ok' ? '<span class="mut">終了（取り込み済み）</span>'
      : why === 'intake' ? '<span class="mut">作業を終えています。メインの取り込み待ち</span>'
      : why === 'missing' ? '<span class="warn">worker が見つかりません（メインの記録漏れ）</span>'
      : '<span class="mut">動いていません</span>'
    h += `<div class="sec"><div class="h">worker</div>${ws.length ? ws.map((w) => workerChip(w, ctx.now)).join('') : note}</div>`
  }
  if (reqs.length)
    h += `<div class="sec"><div class="h">依頼</div><ul class="rel">${reqs.map((r) => `<li><button class="tlink" data-req="${esc(r.id)}">${esc(r.title)}</button><span class="mut">「${esc(r.quote)}」</span></li>`).join('')}</ul></div>`
  if (decs.length)
    h += `<div class="sec"><div class="h">関係する判断</div><ul class="rel">${decs
      .map((x) => `<li>${kind(x.item.kind)}<button class="tlink" data-${x.closed ? 'goarch' : 'goto'}="${esc(x.item.id)}">${esc(x.item.title)}</button><span class="${x.closed ? 'mut' : 'eff'}">${x.closed ? '　対応済み' : '要対応'}</span></li>`)
      .join('')}</ul></div>`
  if (t.done?.length) h += `<div class="sec"><div class="h">完了した作業</div><ul class="plain">${t.done.map((d) => `<li>${doneAt(d) ? `<span class="mut num">${esc(fmtDate(doneAt(d)))}</span>　` : ''}${esc(doneText(d))}</li>`).join('')}</ul></div>`
  h += talkHtml(ctx, t.id, t.repo)
  if (ctx.ui.chat !== t.id) h += `<div class="acts"><button class="btn" data-talk="${esc(t.id)}">質問する</button></div>`
  return h
}

// ── 片付け済み ──────────────────────────────────────────
export function closedItems(views: ItemView[]): ItemView[] {
  const t = (x: ItemView) => (x.when ? new Date(x.when).getTime() || 0 : 0)
  return views.filter((x) => x.closed).sort((a, b) => t(b) - t(a))
}

function dayLabel(iso: string | undefined, now: number): string {
  if (!iso) return '日付なし'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '日付なし'
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const diff = Math.round((day(new Date(now)) - day(d)) / DAY)
  return diff === 0 ? '今日' : diff === 1 ? '昨日' : fmtDate(iso.slice(0, 10))
}

/** 対応済みの 1 行。項目か、完了した依頼（キーは `req:<id>`）。 */
export type ArchRow = { key: string; when?: string; x?: ItemView; r?: Request }

/**
 * 対応済みのまとまり（大タスクごと）。要対応と同じく、項目は代表の大タスクに、依頼は最初のタスクの大タスクに入る。
 * まとまりの中は新しい順、まとまりはいちばん新しい対応の順で、つながりなしは最後。
 */
export function archGroups(c: Cockpit, views: ItemView[], doneReqs: Request[]): { id: string; rows: ArchRow[] }[] {
  const known = new Set(c.streams.map((s) => s.id))
  const groups = new Map<string, ArchRow[]>()
  const add = (id: string, row: ArchRow) => groups.set(id, [...(groups.get(id) ?? []), row])
  for (const x of views) if (x.closed) add(itemStreams(c, x.item)[0] ?? NO_STREAM, { key: x.item.id, when: x.when, x })
  for (const r of doneReqs) {
    const sid = (r.tasks ?? []).map((id) => c.tasks.find((t) => t.id === id)?.stream).find((s) => s && known.has(s))
    add(sid ?? NO_STREAM, { key: `req:${r.id}`, when: r.done_at, r })
  }
  const t = (row: ArchRow) => (row.when ? new Date(row.when).getTime() || 0 : 0)
  return [...groups]
    .map(([id, rows]) => ({ id, rows: rows.sort((a, b) => t(b) - t(a)) }))
    .sort((a, b) => Number(a.id === NO_STREAM) - Number(b.id === NO_STREAM) || t(b.rows[0]!) - t(a.rows[0]!))
}

/** 対応済みで j/k が動く順（一覧に並ぶ順）。 */
export const archKeys = (c: Cockpit, views: ItemView[], doneReqs: Request[]) => archGroups(c, views, doneReqs).flatMap((g) => g.rows.map((r) => r.key))

function archRow(ctx: Ctx, row: ArchRow, cur: string | undefined): string {
  const when = row.when ? `<span class="due mut num">${esc(whenLabel(row.when, ctx.now))}</span>` : ''
  if (row.r)
    return `<button class="row irow" data-areq="${esc(row.r.id)}" aria-current="${row.key === cur}"><span class="rhead"><span class="kind k-req">依頼</span>${when}</span><span class="t">${esc(row.r.title)}</span><span class="s mut">完了</span></button>`
  const x = row.x!
  return `<button class="row irow" data-id="${esc(x.item.id)}" aria-current="${row.key === cur}"><span class="rhead">${kind(x.item.kind)}${when}</span><span class="t">${esc(x.item.title)}</span><span class="s mut">${esc(x.how)}</span></button>`
}

/** 対応した日時。今日と昨日は「今日 16:15」、それより前は日付だけ。 */
function whenLabel(iso: string, now: number): string {
  const label = dayLabel(iso, now)
  return label === '今日' || label === '昨日' ? `${label} ${hm(iso).split(' ')[1] ?? ''}`.trim() : label
}

function arch(ctx: Ctx): string {
  const done = ctx.d.requests.filter((r) => r.status === 'done').map((r) => r.request)
  const groups = archGroups(ctx.c, ctx.views, done)
  const rows = groups.flatMap((g) => g.rows)
  if (!rows.length) return `<div class="empty"><div class="big">対応済みはまだありません</div></div>`
  const cur = rows.find((r) => r.key === ctx.ui.curArch) ?? rows[0]!
  const list = groups.map((g) => `<section class="sgrp">${groupHead(ctx, g.id, true)}${g.rows.map((r) => archRow(ctx, r, cur.key)).join('')}</section>`).join('')
  const detail = cur.r ? requestDetail(ctx, cur.r, true) : itemDetail(ctx, cur.x!, true)
  return `<div class="split"><div class="list">${list}</div><div class="detail">${detail}</div></div>`
}

// ── 全体の組み立て ──────────────────────────────────────
export function render(v: CockpitView | null, ui: Ui, now: number, svg: (raw: string) => string, inWindow = false): string {
  if (!v) return `<div class="empty mut">読み込み中</div>`
  if (v.state === 'no-workspace') return `<div class="empty"><div class="big">ワークスペースが開かれていません</div></div>`
  if (!v.cockpit) {
    const err = v.errors.length ? `<div class="notes">${v.errors.map((e) => `<div class="err">${esc(e)}</div>`).join('')}</div>` : ''
    return `${err}<div class="empty"><div class="big">このワークスペースには操縦席がありません</div>
      <div class="mut" style="margin-top:8px">メインのエージェントに <code>cockpit skill で操縦席を作って</code> と頼むと作られます。</div></div>`
  }
  const c = v.cockpit
  const d = derive(c, v.log, v.archive, v.worktrees ? { workers: v.workers, worktrees: v.worktrees } : undefined)
  const ctx: Ctx = { v, c, ui, now, views: d.views, d, tasks: new Map(c.tasks.map((t) => [t.id, t])), svg, inWindow, shown: (t) => d.tasks.get(t.id)! }
  const body = ui.tab === 'todo' ? todo(ctx) : ui.tab === 'whole' ? whole(ctx) : arch(ctx)
  const toast = ui.toast
    ? `<div class="toast" role="status"><span>${esc(ui.toast.msg)}</span>${ui.toast.undo ? '<button data-undo>元に戻す</button>' : ''}</div>`
    : ''
  return `${bar(ctx)}${tabs(ctx)}${notes(ctx)}${body}${toast}`
}
