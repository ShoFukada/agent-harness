import { TEXT_MAX, askItem, askWords, answerParts, unanswered, withoutChoices, type AskEntry, type AskReturn, type AskThread, type Op } from './model.ts'
import { fmtDate, nearDate } from './state.ts'
import { esc, keyOf, mono, note, type AskWait, type Board, type Ui } from './view.ts'
import { markdown } from './markdown.ts'
import { tag } from './window-parts.ts'
import type { RulingHit } from './protocol.ts'

export type AskScope = { kind: 'whole' } | { kind: 'card'; id: string } | { kind: 'task'; id: string } | { kind: 'stream'; id: string } | { kind: 'id'; id: string }
/** 欄の鍵は案件の root を頭に持つ（案件を切り替えても、前の案件の下書き・当たり・待ちを別の案件に出さない。Codex 重大 2）。 */
export const askKey = (root: string, s: AskScope) => `${root}#${s.kind === 'whole' ? 'whole' : `${s.kind}:${s.id}`}`
export function parseAskKey(key: string): { root: string; scope: AskScope } {
  const root = key.slice(0, key.lastIndexOf('#'))
  const s = key.slice(key.lastIndexOf('#') + 1)
  const i = s.indexOf(':')
  const [kind, id] = i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
  return { root, scope: kind === 'card' || kind === 'task' || kind === 'stream' || kind === 'id' ? { kind, id } : { kind: 'whole' } }
}
/** 鍵の root より後（入力欄の id に使う。窓は 1 案件だけを描くので id は重ならない）。 */
const scopeOf = (key: string) => key.slice(key.lastIndexOf('#') + 1)
export const askPending = (ui: Ui, root: string, id: string) => Object.entries(ui.askWait).find(([, w]) => w.root === root && w.ask === id && !w.error)
export const waitId = (key: string) => `wait:${key}`
const RULING_KIND: Record<string, string> = { decision: '決定', constraint: '制約', permission: '許可', rejection: '却下' }
/** 答えが 3 分届かなければ、待つ表示をやめてタブを見るよう伝える（1 問目は 10 秒前後。担当の測定）。 */
const ASK_STALE_MS = 180_000

const scopeOfThread = (a: AskThread): AskScope =>
  a.card ? { kind: 'card', id: a.card } : a.task ? { kind: 'task', id: a.task } : a.stream ? { kind: 'stream', id: a.stream } : { kind: 'whole' }

/** 置き場所に結んだ質問（新しい順）。consult が端末を立てられずに頭だけ残した控えは出さない（この窓で待っているものは出す。Codex 中 3）。 */
export function asksOf(b: Board, s: AskScope, ui: Ui): AskThread[] {
  const xs = (b.v.asks ?? []).filter((a) => {
    const t = scopeOfThread(a)
    return t.kind === s.kind && (t.kind === 'whole' || (s.kind !== 'whole' && t.id === s.id))
  })
  return xs.filter((a) => a.entries.length || a.returns.length || askPending(ui, b.root, a.id)).reverse()
}

/**
 * answered: 答えが届き、返していない。wait: 最後の質問に答えが無い。reflecting: 返した・返すよう押したが窓口がまだ反映していない
 * （写しに届いていないものも含む）。done: 返しが全部反映された。
 */
export type AskState = 'answered' | 'wait' | 'reflecting' | 'done'
export const ASK_STATE: Record<AskState, string> = { answered: '答えあり', wait: '答え待ち', reflecting: '反映待ち', done: '反映済み' }
const RANK: Record<AskState, number> = { answered: 0, wait: 1, reflecting: 2, done: 3 }

export function decideOps(b: Board, id: string): Op[] {
  const undone = new Set(b.v.log.ops.filter((o) => o.type === 'undo').map((o) => o.undo_of))
  return b.v.log.ops.filter((o) => o.type === 'ask_decide' && o.item_id === askItem(id) && !undone.has(o.op_id))
}
const retOf = (a: AskThread, o: Op) => a.returns.find((r) => String(r.op) === String(o.op_id))
/** 返しを窓口が帳簿に入れたか（asks[].from_returns）・保留にしたか（held_returns）。判断の記録は窓に送っていないので帳簿で見る。 */
function retState(b: Board, a: AskThread, rid: string): 'done' | 'held' | 'open' {
  const rec = b.v.cockpit!.asks?.find((x) => x.id === a.id)
  return rec?.held_returns?.includes(rid) ? 'held' : rec?.from_returns?.includes(rid) ? 'done' : 'open'
}
type OpPhase = 'done' | 'held' | 'returned' | 'unknown' | 'sent' | 'moved' | 'due'
function opPhase(b: Board, a: AskThread, o: Op): OpPhase {
  const ret = retOf(a, o)
  const applied = !!b.v.cockpit!.applied_ops?.includes(o.op_id)
  if (ret) {
    const s = retState(b, a, ret.return_id)
    return s === 'done' || applied ? 'done' : s === 'held' ? 'held' : 'returned'
  }
  if (applied) return 'done'
  if (!b.v.askSent) return 'unknown'
  if (b.v.askSent.includes(o.op_id)) return 'sent'
  // 会話が先に進んだ op は窓が送り直さない（server.ts の undelivered）。
  return a.decide?.n !== o.answer?.n || a.decide?.at !== o.answer?.at ? 'moved' : 'due'
}
const PHASE_TAG: Record<OpPhase, [string, string]> = {
  done: ['窓口が反映済み', ''], held: ['窓口が保留', 'wait'], returned: ['窓口の反映待ち', 'wait'], unknown: ['写しからの返し待ち', 'wait'],
  sent: ['写しに届けました・返し待ち', 'wait'], moved: ['写しに届いていない・会話が先に進んだので窓口が控えから拾います', 'miss'],
  due: ['写しに届いていない・届けられるようになったら窓が送り直します', 'miss']
}

export type AskStatus = { state: AskState; undelivered: boolean; at: number }

export function askStatus(b: Board, a: AskThread, ui: Ui): AskStatus {
  const ops = decideOps(b, a.id)
  const words = new Set(ops.map(askWords).filter(Boolean))
  const lastQ = a.entries.filter((e) => e.kind === 'q').at(-1)
  const pend = askPending(ui, b.root, a.id)
  // 窓口に返した言葉（hook が質問の節として控えに書く）が最後の質問なら、その答えは返しの受け取りで、新しい答えではない。
  const replied = !pend && !!lastQ && words.has(lastQ.text.trim())
  const phases = ops.map((o) => opPhase(b, a, o))
  const loose = a.returns.filter((r) => typeof r.return_id === 'string' && !ops.some((o) => String(o.op_id) === String(r.op)))
  const open = phases.some((p) => p !== 'done') || loose.some((r) => retState(b, a, r.return_id) !== 'done')
  const sameAnswer = ops.some((o) => o.answer?.n === a.decide?.n && o.answer?.at === a.decide?.at)
  const state: AskState = (pend || unanswered(a.entries)) && !replied ? 'wait'
    : a.decide && !replied && !sameAnswer ? 'answered'
    : open ? 'reflecting' : 'done'
  const at = Math.max(Date.parse(a.updated ?? '') || 0, ...ops.map((o) => Date.parse(o.at) || 0), pend?.[1].at ?? 0)
  return { state, undelivered: phases.some((p) => p === 'moved' || p === 'due'), at }
}

/** やりとりの一覧の 1 行。a が無いのは、送って consult が控えの頭を書く前の質問（id は waitId）。 */
export type AskRow = { id: string; a?: AskThread; scope: AskScope; title: string } & AskStatus

export function askRows(b: Board, ui: Ui): AskRow[] {
  const threads = (b.v.asks ?? []).filter((a) => a.entries.length || a.returns.length || askPending(ui, b.root, a.id))
  const rows: AskRow[] = threads.map((a) => ({ id: a.id, a, scope: scopeOfThread(a), title: a.first ?? askPending(ui, b.root, a.id)?.[1].q ?? '', ...askStatus(b, a, ui) }))
  for (const [key, w] of Object.entries(ui.askWait)) {
    const { root, scope } = parseAskKey(key)
    if (root !== b.root || w.error || scope.kind === 'id' || (w.ask && threads.some((a) => a.id === w.ask))) continue
    rows.push({ id: w.ask ?? waitId(key), scope, title: w.q, state: 'wait', undelivered: false, at: w.at })
  }
  return rows.sort((x, y) => RANK[x.state] - RANK[y.state] || y.at - x.at)
}
export const shownAskRows = (b: Board, ui: Ui) => askRows(b, ui).filter((r) => ui.askAll || r.state !== 'done')
export const answeredCount = (b: Board, ui: Ui) => askRows(b, ui).filter((r) => r.state === 'answered').length
export const askOrder = (b: Board | undefined, ui: Ui): string[] => (b ? shownAskRows(b, ui).map((r) => r.id) : [])

export function askStarted(ui: Ui, key: string, w: AskWait): void {
  ui.askWait[key] = w
  ui.tab = 'asks'
  ui.thread = w.ask ?? waitId(key)
}
export function askOpened(ui: Ui, key: string, res: { opened: boolean; ask?: string; reason?: string }): void {
  const w = ui.askWait[key]
  if (!w) return
  if (!res.opened) {
    w.error = res.reason ?? '理由が分かりません'
    return
  }
  w.ask = res.ask
  if (res.ask && ui.thread === waitId(key)) ui.thread = res.ask
}

function cardTitle(b: Board, id: string): string | undefined {
  return b.v.cockpit!.cards.find((c) => c.id === id)?.title ?? b.d.settled.find((r) => r.card.id === id)?.card.title
}
export function aboutText(b: Board, s: AskScope): string {
  const c = b.v.cockpit!
  switch (s.kind) {
    case 'stream': return `仕事「${c.streams.find((x) => x.id === s.id)?.title ?? s.id}」`
    case 'task': return `タスク「${c.tasks.find((x) => x.id === s.id)?.title ?? s.id}」`
    case 'card': return `カード「${cardTitle(b, s.id) ?? s.id}」`
    default: return '案件全体'
  }
}
function aboutLink(b: Board, s: AskScope): string {
  const text = esc(aboutText(b, s))
  if (s.kind === 'task' && b.v.cockpit!.tasks.some((x) => x.id === s.id)) return `<button type="button" class="alk" data-tab="whole" data-task="${esc(s.id)}">${text}</button>`
  if (s.kind === 'stream' && b.v.cockpit!.streams.some((x) => x.id === s.id)) return `<button type="button" class="alk" data-tab="whole" data-stream="${esc(s.id)}">${text}</button>`
  if (s.kind === 'card') {
    const listed = [...b.d.queue.filter((r) => r.card.kind !== 'inbox'), ...b.d.fixing, ...b.d.reports, ...b.d.settled].find((r) => r.card.id === s.id)
    if (listed) return `<button type="button" class="alk" data-jump="${esc(keyOf(listed))}">${text}</button>`
  }
  return `<span>${text}</span>`
}

function rowHtml(b: Board, r: AskRow, cur: string | undefined, now: number, compact = false): string {
  const sub = [
    compact ? '' : esc(aboutText(b, r.scope)),
    !compact && r.state === 'answered' && r.a?.choices?.length ? `選べる案 ${r.a.choices.length} つ` : ''
  ].filter(Boolean).join('・')
  return `<button type="button" class="arow" data-thread="${esc(r.id)}"${r.state === 'done' ? ' data-settled="1"' : ''} aria-current="${cur === r.id}">
    <span class="ast s-${r.state}">${ASK_STATE[r.state]}</span>
    <span class="at"><span class="ati">${esc(r.title)}</span>${sub ? `<span class="crumb">${sub}</span>` : ''}${r.undelivered ? '<span class="crumb miss">写しに届いていない</span>' : ''}</span>
    <span class="du">${esc(r.at ? nearDate(new Date(r.at).toISOString(), now) : '')}</span></button>`
}

function askWaitHtml(w: AskWait | undefined, now: number, key?: string, inThread = false): string {
  if (!w) return ''
  if (w.error) return `<div class="askst bad" role="alert"><b>窓口の写しを立てられませんでした</b><span>${esc(w.error)}</span><button class="btn quiet" type="button" data-ask="dismiss" data-scope="${esc(key ?? '')}">閉じる</button></div>`
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

const TARGET: Record<Exclude<AskScope['kind'], 'id'>, string> = { whole: '案件について質問する', card: 'このカードについて質問する', task: 'このタスクについて質問する', stream: 'この仕事について質問する' }

function askFormHtml(b: Board, s: Exclude<AskScope, { kind: 'id' }>, ui: Ui, extra = ''): string {
  const key = askKey(b.root, s)
  const w = ui.askWait[key]
  const busy = !!w && !w.error
  return `<div class="askin"><label class="lb" for="ask-${esc(scopeOf(key))}">${TARGET[s.kind]}</label>
      <textarea id="ask-${esc(scopeOf(key))}" data-askdraft="${esc(key)}" rows="3" maxlength="${TEXT_MAX}">${esc(ui.askDraft[key] ?? '')}</textarea>
      <div class="acts"><button class="btn${ui.askHits[key] ? '' : ' pri'}" type="button" data-ask="send" data-scope="${esc(key)}"${busy || !(ui.askDraft[key] ?? '').trim() ? ' disabled' : ''}>聞く</button>${extra}</div></div>
    ${askHitsHtml(key, ui.askHits[key])}`
}

const BOX_LABEL: Record<'card' | 'task' | 'stream', string> = { card: 'このカードのやりとり', task: 'このタスクのやりとり', stream: 'この仕事のやりとり' }

export function askBoxHtml(b: Board, s: { kind: 'card' | 'task' | 'stream'; id: string }, ui: Ui, now: number, extra = ''): string {
  const key = askKey(b.root, s)
  const ids = new Set(asksOf(b, s, ui).map((a) => a.id))
  const rows = askRows(b, ui).filter((r) => ids.has(r.id))
  const list = rows.length ? `<div class="lb">${BOX_LABEL[s.kind]}<span class="mut">${rows.length} 件</span></div><div class="arows">${rows.map((r) => rowHtml(b, r, undefined, now, true)).join('')}</div>` : ''
  const open = s.kind === 'stream' || !!ui.askDraft[key] || !!ui.askHits[key] || !!ui.open[`aski:${key}`]
  const form = open ? askFormHtml(b, s, ui, extra) : `<div class="acts"><button class="btn quiet" type="button" data-ask="open" data-scope="${esc(key)}">${TARGET[s.kind]}</button>${extra}</div>`
  return `<section class="ask" aria-label="やりとり">${list}${form}</section>`
}

/** 窓口に返したこと 1 つ（返し方・時刻・今の札と、返しの記録の決まったこと）。o が無いのは写しが自分で書いた返し。 */
function returnedHtml(b: Board, a: AskThread, o: Op | undefined, ret: AskReturn | undefined): string {
  const rec = b.v.cockpit!.asks?.find((x) => x.id === a.id)
  const words = o && askWords(o)
  const what = !o ? '窓口に返したこと' : o.choice ? `${esc(o.choice)} で返した` : words ? `「${esc(words.length > 40 ? `${words.slice(0, 40)}…` : words)}」と返した` : `${o.answer?.at ? `答え ${esc(o.answer.at)} を` : ''}窓口に返すよう依頼しました`
  const [label, cls] = o ? PHASE_TAG[opPhase(b, a, o)] : (({ done: ['窓口が反映済み', ''], held: ['窓口が保留', 'wait'], open: ['窓口の反映待ち', 'wait'] } as const)[retState(b, a, ret!.return_id)])
  const unsent = ret && rec?.notify?.some((n) => n.return_id === ret.return_id && !n.message_id) ? tag('担当へ未通知', 'wait') : ''
  const ds = (ret?.decisions ?? []).map((d) => d.text).filter((t): t is string => !!t)
  return `<div class="askdone"><p><b>${what}</b>${o ? `<span class="mut">${esc(fmtDate(o.at))}</span>` : ''}${tag(label, cls)}${unsent}</p>${ds.length ? `<ul class="rich">${ds.map((t) => `<li>${mono(note(t))}</li>`).join('')}</ul>` : ''}</div>`
}

function threadPane(b: Board, a: AskThread, ui: Ui, now: number): string {
  const st = askStatus(b, a, ui)
  const pend = askPending(ui, b.root, a.id)
  const ops = decideOps(b, a.id)
  const words = new Set(ops.map(askWords).filter(Boolean))
  const qs = a.entries.filter((e) => e.kind === 'q')
  const entries: AskEntry[] = pend && qs.at(-1)?.text.trim() !== pend[1].q ? [...a.entries, { kind: 'q', time: '', text: pend[1].q }] : a.entries
  // 窓に届く控えは新しい節だけなので、見えている最初の答えの通番は、全体の答えの数から見えている答えの数を引いて出す。
  let n = a.answers - a.entries.filter((e) => e.kind === 'a').length
  const repo = b.v.cockpit!.tasks.find((t) => t.id === a.task)?.repo
  const placed = new Set<string>()
  const body = entries.map((e) => {
    if (e.kind === 'n' || (e.kind === 'q' && e.time && words.has(e.text.trim()))) return ''
    if (e.kind === 'q') return `<div class="aq"><span class="mut">${e.time ? `質問 ${esc(e.time)}` : '送った質問'}</span><div class="verb">${esc(e.text)}</div></div>`
    n += 1
    const p = answerParts(e.text)
    const at = p.at ?? a.at
    const mine = ops.filter((o) => o.answer?.n === n)
    for (const o of mine) {
      const r = retOf(a, o)
      if (r) placed.add(r.return_id)
    }
    const body = n === a.decide?.n && a.choices?.length ? withoutChoices(p.body) : p.body
    return `<div class="aa"><span class="mut">答え ${esc(e.time)}${at ? `（窓口の ${esc(at)} までの会話から）` : ''}</span>${markdown(body, repo)}</div>${mine.map((o) => returnedHtml(b, a, o, retOf(a, o))).join('')}`
  }).join('')
  const rest = a.returns.filter((r) => typeof r.return_id === 'string' && !placed.has(r.return_id)).map((r) => returnedHtml(b, a, ops.find((o) => String(o.op_id) === String(r.op)), r)).join('')
  // 返せるのは最後の質問より後の答えだけ（続きの答えを待つあいだ、前の答えで返させない。Codex 重大 3）。控えの全文から常駐のプロセスが出す。
  const answer = pend ? undefined : a.decide
  const waiting = !!pend || unanswered(a.entries)
  const sameAnswer = ops.filter((o) => o.answer?.n === answer?.n && o.answer?.at === answer?.at)
  const fk = askKey(b.root, { kind: 'id', id: a.id })
  const fail = ui.askWait[fk]?.error ? ui.askWait[fk] : undefined
  const data = answer ? ` data-id="${esc(a.id)}" data-at="${esc(answer.at)}" data-head="${esc(answer.head)}" data-n="${answer.n}"` : ''
  const picks = answer && !waiting && a.choices?.length
    ? `<div class="askpick"><span class="lb">案を選んで窓口に返す</span><ul role="list">${a.choices.map((c) => `<li>${sameAnswer.some((o) => o.choice === c.key)
      ? `<span class="mut">${esc(c.key)} で返しました</span>`
      : `<button class="btn" type="button" data-ask="decide"${data} data-choice="${esc(c.key)}">${esc(c.key)} で返す</button>`}<span>${esc(c.title)}${c.pick ? tag('推し') : ''}</span></li>`).join('')}</ul></div>`
    : ''
  const draft = (ui.askDraft[fk] ?? '').trim()
  const input = waiting ? '' : `<div class="askin"><label class="lb" for="ask-${esc(scopeOf(fk))}">続けて聞く・書いたことを窓口に返す</label><textarea id="ask-${esc(scopeOf(fk))}" data-askdraft="${esc(fk)}" rows="3" maxlength="${TEXT_MAX}">${esc(ui.askDraft[fk] ?? '')}</textarea>
      <div class="acts"><button class="btn" type="button" data-ask="send" data-scope="${esc(fk)}"${draft ? '' : ' disabled'}>続けて聞く</button>${answer ? `<button class="btn" type="button" data-ask="reply" data-scope="${esc(fk)}"${data}${draft ? '' : ' disabled'}>書いたことを窓口に返す</button>` : ''}</div></div>`
  return `<div class="wdet athread">
    <div class="dh"><div class="crumbs">${aboutLink(b, scopeOfThread(a))}<button class="nxl" type="button" data-ask="tab" data-id="${esc(a.id)}">写しの会話を開く</button></div>
      <div class="kl"><span class="ast s-${st.state}">${ASK_STATE[st.state]}</span>${st.undelivered ? tag('写しに届いていない', 'miss') : ''}</div></div>
    <div class="ask conv">
    ${a.omitted ? `<p class="mut">これより前の ${a.omitted} 節は写しの会話で読めます</p>` : ''}
    ${body}${rest}${picks}
    ${askWaitHtml(pend?.[1] ?? fail, now, fk, true)}${waiting && !pend ? '<p class="mut">まだ答えが届いていません</p>' : ''}
    ${input}</div>
    <p class="rid">番号<code>${esc(a.id)}</code></p></div>`
}

function waitPane(b: Board, key: string, w: AskWait, now: number): string {
  return `<div class="wdet athread">
    <div class="dh"><div class="crumbs">${aboutLink(b, parseAskKey(key).scope)}</div><div class="kl"><span class="ast s-wait">${ASK_STATE.wait}</span></div></div>
    <div class="ask conv"><div class="aq"><span class="mut">送った質問</span><div class="verb">${esc(w.q)}</div></div>${askWaitHtml(w, now, key, true)}</div></div>`
}

export function viewAsks(b: Board, ui: Ui, now: number): string {
  const all = askRows(b, ui)
  const shown = all.filter((r) => ui.askAll || r.state !== 'done')
  const open = all.filter((r) => r.state !== 'done').length
  const failed = Object.entries(ui.askWait).filter(([k, w]) => w.error && w.root === b.root && parseAskKey(k).scope.kind !== 'id')
    .map(([k, w]) => `<div class="askfail">${askWaitHtml(w, now, k)}<div class="aq"><span class="mut">${esc(aboutText(b, parseAskKey(k).scope))}への質問</span><div class="verb">${esc(w.q)}</div></div></div>`).join('')
  const filter = `<div class="afil" role="group" aria-label="絞り込み"><button type="button" data-askall="0" aria-pressed="${!ui.askAll}">済んでいない ${open}</button><button type="button" data-askall="1" aria-pressed="${!!ui.askAll}">すべて ${all.length}</button></div>`
  const list = shown.length ? `<div class="arows">${shown.map((r) => rowHtml(b, r, ui.thread, now)).join('')}</div>`
    : `<div class="calm"><b>${all.length ? '済んでいないやりとり 0 件' : 'やりとり 0 件'}</b></div>`
  const cur = all.find((r) => r.id === ui.thread)
  const wait = !cur?.a && ui.thread?.startsWith('wait:') ? ui.askWait[ui.thread.slice(5)] : undefined
  const side = cur?.a ? threadPane(b, cur.a, ui, now)
    : cur && wait ? waitPane(b, ui.thread!.slice(5), wait, now)
    : cur ? waitPane(b, Object.entries(ui.askWait).find(([, w]) => w.ask === cur.id)?.[0] ?? '', Object.values(ui.askWait).find((w) => w.ask === cur.id)!, now)
    : ''
  return `<div class="wpane" aria-label="やりとり"><section class="ask">${askFormHtml(b, { kind: 'whole' }, ui)}</section>${failed}
    <section class="alist"><div class="ah"><h3>やりとり</h3>${filter}</div>${list}</section></div>
    <aside class="wside" aria-label="会話">${side}</aside>`
}
