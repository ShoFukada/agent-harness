// Orca の worktree ps・terminal list・orchestration worker-show から、ワークスペースのメインと worker と、worker の記録の様子を決める。
// 窓の常駐のプロセスと CLI（state.ts）が使う。
import path from 'node:path'
import { busyDispatch, type Cockpit } from '../src/model.ts'
import type { IdleOwner } from '../src/state.ts'
import type { AgentRow, Ask, DispatchFact, OwnerLive, QuestionFact, StopReason } from '../src/protocol.ts'

export type PsAgent = {
  paneKey: string
  state: AgentRow['state']
  agentType?: string | null
  conversationName?: string | null
  displayName?: string | null
  taskTitle?: string | null
  stateStartedAt: number
  interrupted?: boolean
  hasLivePty?: boolean
  lastAssistantMessage?: string | null
  mainAgent?: { outcome?: string } | null
  /** チャット（structured-agent-session）なら Orca のセッション。止まった理由（failureKind）をこれで引く。 */
  orcaSessionId?: string | null
  /** 最後に呼んだ・許可を待っている道具と、その入力の 1 行（Bash ならコマンド）。AskUserQuestion の問いは入らない（Orca が questions の配列を 1 行にしない）。 */
  toolName?: string | null
  toolInput?: string | null
  /** 端末の画面から読んだ問い（常駐のプロセスが足す）。 */
  screen?: Ask
}
/**
 * Orca が止まったエージェントについて残した理由（orchestration の escalation の payload の failureKind・detail）。
 * worktree ps・worker-show・dispatch-show には無く、inbox の知らせにだけある（2026-11-21 に確かめた）。session → いちばん新しいもの。
 */
export type Failure = { kind?: string; detail?: string; at: number }
/** orca orchestration inbox --full の 1 通（使う欄だけ）。payload は JSON の文字列。 */
export type InboxMessage = {
  id?: string; type?: string; payload?: string | null; created_at?: string
  from_handle?: string | null; to_handle?: string | null; thread_id?: string | null; subject?: string | null; body?: string | null
}
/** consult --card が Orca のチャット画面で立てた相談の handle の頭（端末の handle は term_…）。 */
export const CHAT_HANDLE = 'orca_session_id:'

/** 協議の記録（talk の op）に残ったチャットの相談の handle。 */
export const chatHandles = (ops: { type: string; terminal?: string | null }[]) =>
  [...new Set(ops.filter((o) => o.type === 'talk' && o.terminal?.startsWith(CHAT_HANDLE)).map((o) => o.terminal!))]

/**
 * チャットの相談のうち、Orca に開いているもの（orca agent show の result.places が空でない。consult の live_chats と同じ判定）。
 * 閉じたと分かったものは closed に入れて次から問い合わせない（閉じたチャットは開き直らない）。確かめられなかったものは閉じたと言い切らず、開いているとして返す。
 */
export async function liveChats(handles: string[], open: ((handle: string) => Promise<boolean>) | undefined, closed = new Set<string>()): Promise<string[]> {
  if (!open) return []
  const out: string[] = []
  for (const h of handles) {
    if (closed.has(h)) continue
    const live = await open(h).catch(() => true)
    if (live) out.push(h)
    else closed.add(h)
  }
  return out
}

export function failuresOf(messages: InboxMessage[]): Record<string, Failure> {
  const out: Record<string, Failure> = {}
  for (const m of messages) {
    if (m.type !== 'escalation' || !m.payload?.includes('failureKind')) continue
    let p: { sessionId?: unknown; failureKind?: unknown; detail?: unknown }
    try {
      p = JSON.parse(m.payload)
    } catch {
      continue
    }
    const at = Date.parse(m.created_at ?? '')
    if (typeof p.sessionId !== 'string' || Number.isNaN(at) || at <= (out[p.sessionId]?.at ?? 0)) continue
    out[p.sessionId] = { kind: typeof p.failureKind === 'string' ? p.failureKind : undefined, detail: typeof p.detail === 'string' ? p.detail : undefined, at }
  }
  return out
}

/** 答えの無い orchestration の question（どの案件のものかは questionFacts が決める）。 */
export type OpenQuestion = { id: string; run: string; from: string; dispatch?: string; at: number; line: string; text: string; options?: string[] }
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
/**
 * inbox から、答えを待っている question を拾う。thread に返事が付いたもの、聞いた側がそのあと question 以外を送ったもの
 * （返事を別の送り方で受けて動いた）は除く。同じ送り主の次の question では消さない（2 問を続けて聞くことがある）。
 * 宛先が Run の受け口（run:…）でないものは、窓口・担当への問いではないので拾わない。
 * carry は前回まで答えの無かった問い。inbox は新しい 300 通しか読めないので、古くなって外れた問いも、返事か送信が届くまで持ち越す。
 */
export function openQuestions(messages: InboxMessage[], carry: OpenQuestion[] = []): OpenQuestion[] {
  const answered = (q: { id: string; from: string; at: number }) =>
    messages.some((m) => m.id !== q.id && (m.thread_id === q.id || (!!q.from && m.from_handle === q.from && Date.parse(m.created_at ?? '') > q.at)) && !(m.type === 'question' && m.from_handle === q.from))
  const seen = new Set(messages.map((m) => m.id))
  const out: OpenQuestion[] = carry.filter((q) => !seen.has(q.id) && !answered(q))
  for (const q of messages) {
    if (q.type !== 'question' || !q.id || !q.to_handle?.startsWith('run:')) continue
    const at = Date.parse(q.created_at ?? '')
    if (Number.isNaN(at) || answered({ id: q.id, from: q.from_handle ?? '', at })) continue
    let p: { question?: unknown; options?: unknown; dispatchId?: unknown } = {}
    try {
      const v: unknown = JSON.parse(q.payload || '{}')
      if (v && typeof v === 'object') p = v
    } catch {
      // payload の無い send --type question は本文だけで読む。
    }
    const text = str(p.question) ?? str(q.body) ?? str(q.subject)
    if (!text) continue
    const options = (Array.isArray(p.options) ? p.options : []).map((o: unknown) => str(o) ?? str((o as { label?: unknown } | null)?.label)).filter((o): o is string => !!o)
    const subject = str(q.subject)
    const from = q.from_handle ?? ''
    out.push({
      id: q.id, run: q.to_handle.slice('run:'.length), from, at, text,
      line: subject && subject !== 'Question' ? subject : text.split('\n').find((l) => l.trim())!.replace(/^#+\s*/, '').trim(),
      dispatch: str(p.dispatchId) ?? (from.startsWith('dispatch:') ? from.slice('dispatch:'.length) : undefined),
      ...(options.length && { options })
    })
  }
  return out
}

/**
 * question を案件に結ぶ。窓口の Run（cockpit.json の main.run_id）宛ては窓口宛て。それ以外は担当の Run 宛てで、聞いた worker の worktree が
 * この案件の本線の子孫にあるものだけを拾う。聞いた Dispatch が終わった・落ちたものは、もう答えを待っていないので除く。
 * show は Orca に無ければ null を返す（dispatches に無い Dispatch だけを問い合わせる）。
 */
export async function questionFacts(
  c: Cockpit, root: string, ps: PsRow[], questions: OpenQuestion[], dispatches: Record<string, DispatchFact | null>, current: Record<string, string>, owners: OwnerLive[],
  show: (dispatch: string) => Promise<WorkerShow | null>, termAt: Map<string, string> = new Map(), ended?: Set<string>
): Promise<QuestionFact[]> {
  const row = ps.find((r) => r.path === root)
  if (!row || !questions.length) return []
  const paths = new Set(descendants(ps, row).map((r) => r.path))
  // 担当のいる worktree → 担当の仕事。担当の worker は担当の worktree の子に立つので、聞いた worker の先祖をたどって引く。
  // チャットの担当は orca agent list の居場所、端末の担当は termAt（端末の handle → worktree）で引く。
  const ownerAt = new Map<string, string>()
  for (const o of c.owners ?? []) {
    if (o.state === 'done' || !o.stream) continue
    const wt = (o.session ? owners.find((x) => x.session === o.session)?.worktree : undefined) ?? (o.terminal ? termAt.get(o.terminal) : undefined)
    if (wt) ownerAt.set(wt, o.stream)
  }
  // 問い合わせは並べて行う（1 本が 15 秒待たせても、ほかの問いの分を待たせない）。
  const looked = await Promise.all(questions.map(async (q) => {
    // 担当（チャットの worker）は payload を付けずに送るので、送り主の handle を Dispatch の受け口と突き合わせる。
    const d = q.dispatch ?? Object.entries(dispatches).find(([, f]) => f?.terminal === q.from)?.[0]
    const f = d ? (d in dispatches ? dispatches[d]! : await show(d).then((r) => (r ? dispatchFact(r) : null), () => undefined)) : undefined
    return [q, d, f] as const
  }))
  const out: QuestionFact[] = []
  for (const [q, d, f] of looked) {
    const to = q.run === c.main?.run_id ? 'main' : 'owner'
    // 終わった・Orca に無い Dispatch の問いは、もう答えを待っていない。ended に入れて持ち越しから外させる（照会の失敗は undefined で、次に問い直す）。
    if (f === null || f?.settledAt || f?.liveness === 'exited') {
      ended?.add(q.id)
      continue
    }
    if (to === 'owner' && !(f?.worktree && paths.has(f.worktree))) continue
    const task = d ? c.tasks.find((t) => t.worker && (current[t.id] ?? t.worker.dispatch_id) === d) : undefined
    let stream = task?.stream
    for (let r = ps.find((x) => x.path === f?.worktree); r && !stream; r = ps.find((x) => x.worktreeId === r!.parentWorktreeId)) stream = ownerAt.get(r.path)
    const byOwner = !!f?.session && !!c.owners?.some((o) => o.session === f.session)
    const at = f?.worktree ? ps.find((r) => r.path === f.worktree) : undefined
    out.push({
      id: q.id, at: q.at, line: q.line, text: q.text, to, ...(q.options && { options: q.options }), ...(task && { task: task.id }), ...(stream && { stream }),
      ...(byOwner && { byOwner }), ...(at && jobOf(at) && { asker: jobOf(at) })
    })
  }
  return out
}

const ASK_TOOL = /^(AskUserQuestion|ask_user_question|askUserQuestion|AskUser|ask_user|ask_question)$/
/** Orca の toolName・toolInput から読める問い。AskUserQuestion は本文が入らないので、画面から読む（screenAsk）。 */
export function toolAsk(a: Pick<PsAgent, 'state' | 'toolName' | 'toolInput'>): Ask | undefined {
  if ((a.state !== 'blocked' && a.state !== 'waiting') || !a.toolName) return undefined
  if (ASK_TOOL.test(a.toolName)) return a.toolInput?.trim() ? { kind: 'question', text: a.toolInput.trim() } : undefined
  // 返事待ちに残った別の道具の名前は、前に使ったものかもしれないので許可の問いと読まない。
  if (a.state !== 'blocked') return undefined
  return { kind: 'permit', text: a.toolInput?.trim() ? `${a.toolName}: ${a.toolInput.trim()}` : a.toolName }
}

const OPTION = /^\s*([❯›>]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/
const BORDER = /^[\s─━═│┃╭╮╰╯┌┐└┘├┤╌┄☐☒✔·•-]*$/
// 枠の上の線（Claude Code は問いの画面を ─ の線で囲む）。
const TOP = /^[─━]{8,}$/
// Claude Code が選択肢の下に足す、自由入力と相談の行。選択肢としては出さない。
const FREE = /^Type something/i
const CHAT = /^Chat about this/i
// 画面の下の操作の案内。選択肢の説明として読まない。
const FOOTER = /^(Enter to (select|confirm)|Esc to cancel|↑\/↓)/
/**
 * 端末の画面の末尾から、選択肢の付いた問いを読む（Claude Code の AskUserQuestion と許可の確認は、問いの文の下に「❯ 1. …」の行が並ぶ）。
 * 問いは、いちばん下の「1.」の上の、空行か枠で区切られた塊。折り返しは繋ぐ。読めなければ undefined。
 * 選択肢の番号・文・下の説明、自由入力の番号、枠の上の段落（エージェントの最後の発言）、枠の中で問いより上の行（見出し・許可の道具と全文）も読む。
 */
export function screenAsk(lines: string[], kind: Ask['kind'] = 'question'): Ask | undefined {
  const tail = lines.slice(-60).map((l) => l.replace(/[│┃]/g, ''))
  let first = -1
  for (let i = tail.length - 1; i >= 0; i--) if (OPTION.exec(tail[i]!)?.[2] === '1') { first = i; break }
  if (first < 0) return undefined
  const choices: { n: number; label: string; note?: string }[] = []
  let free: number | undefined
  // 選んでいる選択肢の印（❯）が無い番号の並びは、エージェントの出力の箇条書きなので問いと読まない。
  let cursor = false
  let last: { n: number; label: string; note?: string } | undefined
  for (let i = first, n = 1; i < tail.length; i++) {
    const line = tail[i]!.trim()
    const m = OPTION.exec(tail[i]!)
    if (m && Number(m[2]) === n) {
      n++
      cursor ||= !!m[1]
      const label = m[3]!.replace(/\s*\(esc\)$/, '')
      last = undefined
      if (FREE.test(label)) free = Number(m[2])
      else if (!CHAT.test(label)) choices.push((last = { n: Number(m[2]), label }) as { n: number; label: string })
    } else if (FOOTER.test(line)) break
    else if (last && line && !BORDER.test(line)) last.note = last.note ? `${last.note} ${line}` : line
  }
  if (!cursor) return undefined
  // 問いの文。見出し（☐ 対応の範囲）は問いに混ぜず、枠の中の行に回す。
  let qTop = first
  const block: string[] = []
  for (let i = first - 1; i >= 0 && first - i <= 12; i--) {
    const l = tail[i]!.trim()
    if (!l || BORDER.test(l) || /^[☐☒✔]/.test(l)) {
      if (block.length) break
      continue
    }
    block.unshift(l)
    qTop = i
  }
  // 英字どうしの折り返しは語の間の空白が落ちるので、空白で繋ぐ。和文はそのまま繋ぐ。
  const question = block.reduce((s, l) => (s && /[A-Za-z0-9,]$/.test(s) && /^[A-Za-z0-9]/.test(l) ? `${s} ${l}` : s + l), '')
  if (!question) return undefined
  let top = -1
  for (let i = qTop - 1; i >= 0 && qTop - i <= 40; i--) if (TOP.test(tail[i]!.trim())) { top = i; break }
  // 枠の中で問いより上の行。許可の確認は道具の名前・説明・コマンドの全文（端末を見ずに許すので切らない）。案内の行（Tip:）は外す。
  const body = (top >= 0 ? tail.slice(top + 1, qTop) : []).map((l) => l.trim()).filter((l) => l && !BORDER.test(l.replace(/^[☐☒✔]\s*/, '')) || /^[☐☒✔]\s*\S/.test(l)).filter((l) => !/^Tip:/.test(l))
  // 枠の上の段落（エージェントの最後の発言。「⏺」で始まる行から）。
  const before: string[] = []
  for (let i = top - 1; i >= 0; i--) {
    const l = tail[i]!.trim()
    if (!l) {
      if (before.length) break
      continue
    }
    // 利用者の入力（❯ の行と、その折り返し）に当たったら、そこまでに拾った行は入力の続きなので捨てる。
    if (/^❯/.test(l)) {
      before.length = 0
      break
    }
    if (TOP.test(l)) break
    before.unshift(l)
    if (/^⏺/.test(l)) break
  }
  // 許可の確認の題は、道具の名前のあとの最後の行（コマンド・パス）。読めなければ問いの文。
  const text = kind === 'permit' && body.length >= 2 ? body.at(-1)! : question
  const ask: Ask = {
    kind, text, ...(choices.length && { options: choices.map((c) => c.label), choices }), ...(free && { free }),
    ...(before.length && top >= 0 && { before: before.map((l) => l.replace(/^[⏺⎿]\s*/, '')).join('\n') }), ...(body.length && { body }), ...(kind === 'permit' && text !== question && { question })
  }
  // 許す中身（枠の中の行）が読めない許可の確認は、コマンドが変わっても印が同じになるので、窓から答えさせない（印を付けない）。
  return kind === 'permit' && !body.length ? ask : { ...ask, sig: screenSig(ask) }
}

/** 画面の問いの印。問いの文・枠の中の行・選択肢の番号と文・自由入力の番号が同じなら同じ印（枠の上の段落は描き直しで変わりうるので入れない）。 */
export const screenSig = (a: Pick<Ask, 'kind' | 'text' | 'body' | 'choices' | 'free'>) =>
  JSON.stringify([a.kind, a.text, a.body ?? [], (a.choices ?? []).map((c) => [c.n, c.label, c.note ?? '']), a.free ?? 0])

export type PsRow = { worktreeId: string; path: string; parentWorktreeId: string | null; displayName?: string | null; comment?: string | null; agents: PsAgent[] }
// ログイン切れと利用枠は Orca が状態として持たないので、最後の発言の文から推す。
// 長い発言は作業の報告で、文中の「limit」などを拾わないよう短いものだけを見る。
export const SHORT = 400
// bin/stallwatch の LIMIT と同じ形にそろえる（Claude Code の上限の 1 行は「You've hit your 5-hour limit · resets …」「You've reached your Fable limit.」）。
const LIMIT = /usage limit|rate limit|limit reached|out of extra usage|上限に達|hit your [\w -]*limit|reached your [\w -]*limit/i
const AUTH = /\/login|not logged in|authentication_error|oauth token|invalid api key|\b401\b/i

/** 止まった失敗に当たる Orca の知らせ。知らせは失敗のすぐあとに出るので、失敗が始まった時刻の 5 分前より新しいものだけを使う。 */
export const failureOf = (a: PsAgent, failures: Record<string, Failure> = {}): Failure | undefined => {
  const f = a.orcaSessionId ? failures[a.orcaSessionId] : undefined
  return f && f.at >= a.stateStartedAt - 5 * 60_000 ? f : undefined
}

export function stopReason(a: PsAgent, f?: Failure): StopReason | undefined {
  const outcome = a.mainAgent?.outcome
  if (a.hasLivePty === false && (a.state !== 'done' || outcome !== 'success')) return 'dead'
  if (a.state === 'blocked' || a.state === 'waiting') return a.state
  if (a.state !== 'done') return undefined
  // Orca の failureKind（usageLimitReached など）を先に見て、無ければ最後の発言と知らせの detail の文から推す。
  if (outcome === 'failure' && f?.kind && /limit/i.test(f.kind)) return 'limit'
  if (outcome === 'failure' && f?.kind && /auth|login|credential|unauthori/i.test(f.kind)) return 'auth'
  for (const msg of [a.lastAssistantMessage ?? '', outcome === 'failure' ? f?.detail ?? '' : '']) {
    if (msg.length <= SHORT && LIMIT.test(msg)) return 'limit'
    if (msg.length <= SHORT && AUTH.test(msg)) return 'auth'
  }
  if (outcome === 'failure') return 'error'
  if (a.interrupted || outcome === 'interruption') return 'interrupted'
  return undefined
}

/** worker の仕事が分かる 1 行。Orca の表示名は「ブランチ名｜仕事」の形が多いので、｜の後ろを優先する。 */
export function jobOf(row: PsRow): string | undefined {
  const name = row.displayName?.split('｜').slice(1).join('｜').trim() || row.displayName?.trim()
  return name || row.comment?.trim() || undefined
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/**
 * 上限の 1 行の「resets 10:50pm (Asia/Tokyo)」「resets Nov 23 at 4am」から、戻る時刻を 24 時間制で返す（「22:50」「11/23 04:00」）。
 * 読めなければ undefined（時刻を出さない）。
 */
export function resetAt(text: string | null | undefined): string | undefined {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text ?? '')
  if (!m) return undefined
  const h = (Number(m[3]) % 12) + (m[5]!.toLowerCase() === 'pm' ? 12 : 0)
  const mon = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0
  const time = `${String(h).padStart(2, '0')}:${m[4] ?? '00'}`
  return mon ? `${mon}/${Number(m[2])} ${time}` : time
}

function toAgent(a: PsAgent, row: PsRow, terms: Map<string, string>, c: Cockpit | undefined, byTerminal: Map<string, string>, failures?: Record<string, Failure>): AgentRow {
  // どの task の worker かは、メインが記録した Dispatch の端末で引く。記録が無ければ表示名・コメント。
  const terminalId = terms.get(a.paneKey) ?? null
  const taskId = terminalId ? byTerminal.get(terminalId) : undefined
  const task = taskId ? c?.tasks.find((t) => t.id === taskId) : undefined
  const f = failureOf(a, failures)
  const stop = stopReason(a, f)
  const reset = stop === 'limit' ? resetAt(a.lastAssistantMessage) ?? resetAt(f?.detail) : undefined
  // 画面から読めた問いを先に使う（選択肢の番号と文があり、窓から答えられる）。許可の確認を枠の無い画面から読んだときは、題を道具の欄の文（道具とコマンド）にする。
  const tool = stop === 'blocked' || stop === 'waiting' ? toolAsk(a) : undefined
  const ask = stop === 'blocked' || stop === 'waiting' ? (a.screen?.kind === 'permit' && tool && !a.screen.body?.length ? { ...a.screen, text: tool.text } : a.screen ?? tool) : undefined
  return {
    terminalId,
    title: a.conversationName ?? a.displayName ?? a.taskTitle ?? path.basename(row.path),
    agent: a.agentType ?? null, state: a.state, since: a.stateStartedAt, stop, worktree: row.path,
    ...(a.paneKey.startsWith('structured-') && { chat: true }), ...(a.orcaSessionId && { session: a.orcaSessionId }), ...(reset && { reset }), ...(ask && { ask }),
    job: task?.title ?? jobOf(row), task: task?.id, where: row.comment?.split('｜').slice(1).join('｜').trim() || undefined
  }
}

/** row と、その子孫の worktree（担当の worker は担当の worktree の子＝窓口の孫に立つ）。前面の追従とファイルを開く許可が使う。 */
export function descendants(ps: PsRow[], row: PsRow): PsRow[] {
  const tree = [row]
  for (let i = 0; i < tree.length; i++) tree.push(...ps.filter((r) => r.parentWorktreeId === tree[i]!.worktreeId && !tree.includes(r)))
  return tree
}

/** terms は paneKey → 端末の handle。dispatches は worker の記録の Dispatch の様子（タスクと端末を結ぶ）。 */
export function orcaAgents(root: string, ps: PsRow[], terms: Map<string, string>, c: Cockpit | undefined, dispatches: Record<string, DispatchFact | null> = {}, current: Record<string, string> = {}, failures: Record<string, Failure> = {}): { main?: AgentRow; workers: AgentRow[] } {
  const row = ps.find((r) => r.path === root)
  if (!row) return { workers: [] }
  const byTerminal = new Map<string, string>()
  for (const t of c?.tasks ?? []) {
    const id = t.worker && (current[t.id] ?? t.worker.dispatch_id)
    const term = id && dispatches[id]?.terminal
    if (term) byTerminal.set(term, t.id)
  }
  const tree = descendants(ps, row)
  const all = tree.flatMap((r) => r.agents.map((a) => toAgent(a, r, terms, c, byTerminal, failures)))
  const own = all.filter((a) => a.worktree === root)
  const terminal = c?.main?.terminal
  // メインが端末を開き直して cockpit.json の main が古いときも、本線に 1 つだけいるエージェントはメインと見なす。
  const main = own.find((a) => a.terminalId && a.terminalId === terminal) ?? (own.length === 1 ? own[0] : undefined)
  return { main, workers: all.filter((a) => a !== main) }
}

/** orca orchestration worker-show --full の、使う欄だけ。 */
export type WorkerShow = {
  dispatch?: { completedAt?: string | null; runId?: string | null } | null
  /** workspace.id は「リポジトリの id::worktree のパス」。 */
  projection?: { stage?: { worker?: string } | null; liveness?: { verdict?: string } | null; workspace?: { id?: string | null } | null } | null
  terminal?: { handle?: string | null } | null
  /** チャットの worker は terminal が null で、handle はここにある。 */
  worker?: { agentTerminalHandle?: string | null } | null
  /** endpointIncarnation はチャットの worker なら「structured:<orcaSessionId>」。 */
  terminalResource?: { terminalHandle?: string | null; endpointIncarnation?: string | null } | null
  observation?: { agentWait?: unknown } | null
}

export function dispatchFact(r: WorkerShow): DispatchFact {
  const done = r.dispatch?.completedAt ? Date.parse(r.dispatch.completedAt) : NaN
  const inc = r.terminalResource?.endpointIncarnation
  return {
    state: r.projection?.stage?.worker ?? 'unknown', liveness: r.projection?.liveness?.verdict,
    terminal: r.terminal?.handle ?? r.worker?.agentTerminalHandle ?? r.terminalResource?.terminalHandle ?? null,
    session: inc?.startsWith('structured:') ? inc.slice('structured:'.length) : undefined,
    // agentWait が null なら Orca が見て待っていない。欄が無いのは見ていないだけなので、待っている扱いにしない。
    waiting: !!r.observation?.agentWait, settledAt: Number.isNaN(done) ? undefined : done,
    worktree: r.projection?.workspace?.id?.split('::').slice(1).join('::') || undefined
  }
}

/** orca orchestration task-list --run の 1 行（使う欄だけ）。終わったタスクは dispatchId を持たない。 */
export type RunTask = { id: string; status: string; dispatchId?: string }
/** orca orchestration dispatch-show --task の、タスクの Dispatch と、それが何の続きか（follow_up_of_dispatch_id）。どちらも変わらない。 */
export type TaskLink = { dispatch: string | null; followUpOf: string | null }
export type Chain = { tasks(run: string): Promise<RunTask[]>; link(task: string): Promise<TaskLink> }

/**
 * worker の記録（run_id と最初の Task）から、今の Dispatch を引く。Run のタスクの Dispatch を follow_up_of で逆向きにつなぎ、
 * 最初の Task の Dispatch から最後の続きまでたどる。follow_up_of は変わらないので cache に覚え、新しいタスクだけを問い合わせる。
 * 返すのは、タスクの id → 今の Dispatch と、Dispatch → Orca のタスクの状態。
 */
export async function currentDispatches(c: Cockpit | undefined, chain: Chain, cache: Map<string, TaskLink>): Promise<{ current: Record<string, string>; status: Record<string, string> }> {
  const live = (c?.tasks ?? []).filter((t) => t.worker?.run_id && t.state !== 'ok')
  const current: Record<string, string> = {}
  const status: Record<string, string> = {}
  for (const run of new Set(live.map((t) => t.worker!.run_id!))) {
    const rows = await chain.tasks(run)
    const links = await Promise.all(rows.map(async (r) => {
      let l = cache.get(r.id)
      if (!l) {
        l = await chain.link(r.id)
        if (l.dispatch) cache.set(r.id, l)
      }
      return [r, l] as const
    }))
    const next = new Map<string, string>()
    const ofTask = new Map<string, string>()
    for (const [r, l] of links) {
      if (!l.dispatch) continue
      ofTask.set(r.id, l.dispatch)
      status[l.dispatch] = r.status
      if (l.followUpOf) next.set(l.followUpOf, l.dispatch)
    }
    for (const t of live.filter((x) => x.worker!.run_id === run)) {
      let d = ofTask.get(t.worker!.task_id)
      for (let n = 0; d && next.has(d) && n < 1000; n++) d = next.get(d)
      if (d) current[t.id] = d
    }
  }
  return { current, status }
}

/** 済んでいないタスクの今の Dispatch を、Orca に問い合わせる。show は Orca に無ければ null を返す。current が無いタスクは版 2 の dispatch_id を使う。 */
export async function orcaDispatches(c: Cockpit | undefined, show: (dispatch: string) => Promise<WorkerShow | null>, current: Record<string, string> = {}, status: Record<string, string> = {}): Promise<Record<string, DispatchFact | null>> {
  const ids = [...new Set((c?.tasks ?? []).filter((t) => t.worker && t.state !== 'ok').map((t) => current[t.id] ?? t.worker!.dispatch_id).filter((x): x is string => !!x))]
  const rows = await Promise.all(ids.map(async (id) => [id, await show(id)] as const))
  return Object.fromEntries(rows.map(([id, r]) => [id, r ? { ...dispatchFact(r), ...(status[id] && { taskStatus: status[id] }) } : null]))
}

/**
 * 読み直した agent list の行に、同じターン（session と updatedAt）の前の最後の返事を写す。最後の返事は読み直しの終わりに読み直すので、
 * 写さないとその間に届いた配信だけ返事の無い行になり、窓の一緒に作る行の題が返事の段落と「返事を待っている」の間で入れ替わった（2026-11-23）。
 */
export const carryLast = (next: OwnerLive[], prev: OwnerLive[]): OwnerLive[] =>
  next.map((a) => {
    if (a.last || a.state !== 'done' || a.updatedAt === undefined) return a
    const last = prev.find((p) => p.session === a.session && p.state === 'done' && p.updatedAt === a.updatedAt)?.last
    return last ? { ...a, last } : a
  })

/** orca orchestration run-list --full の 1 行（使う欄だけ）。coordinator は Run を作った担当の handle（窓口が作った Run は null）。 */
export type RunRow = { id: string; coordinator: string | null }
export type RunPage = { runs: RunRow[]; next?: string }
/** orca orchestration worker-list --run --full の 1 行（使う欄だけ）。handle は worker の受け口、session はチャットの worker のセッション。 */
export type RunWorker = { dispatchId: string; state: string; liveness?: string; handle?: string; session?: string }
export const busyWorker = (w: RunWorker) => busyDispatch(w)

/**
 * Run の coordinator は変わらず、run-list は新しい順なので、知っている Run が出たページで止める。
 * 途中のページで失敗したか上限で終わらなければ何も覚えない（覚えた 1 ページ目で次から止まり、その先を読み直さなくなるため）。
 */
export async function readRuns(list: (cursor?: string) => Promise<RunPage>, cache: Map<string, string | null>, pages = 50): Promise<void> {
  const got: RunRow[] = []
  let cursor: string | undefined
  for (let i = 0; ; i++) {
    if (i >= pages) throw new Error(`run-list が ${pages} ページで終わらない`)
    const page = await list(cursor)
    got.push(...page.runs)
    if (page.runs.some((r) => cache.has(r.id)) || !page.next) break
    cursor = page.next
  }
  for (const r of got) cache.set(r.id, r.coordinator)
}

/**
 * 一緒に作る仕事の担当（id）→ その担当の Run で終わっていない worker の Dispatch。読めなかった担当は入れない（分からないものを「待っていない」と言い切らない）。
 * handle の引けないチャットの担当は、窓口の Run（mainRun）の worker から session で引く（担当は窓口の Run の worker として立つ。
 * 帳簿のタスクが済になると担当の Dispatch を読まなくなるため）。
 */
export async function coordinating(owners: IdleOwner[], runs: Map<string, string | null>, workers: (run: string) => Promise<RunWorker[]>, mainRun?: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  const read = new Map<string, Promise<RunWorker[] | undefined>>()
  const once = (run: string) => read.get(run) ?? (read.set(run, workers(run).catch(() => undefined)), read.get(run)!)
  const main = mainRun && owners.some((o) => !o.handle && o.session) ? await once(mainRun) : undefined
  await Promise.all(owners.map(async (o) => {
    const h = o.handle ?? main?.find((w) => !!o.session && w.session === o.session)?.handle
    if (!h) return
    const got = await Promise.all([...runs].filter(([, c]) => c === h).map(([id]) => once(id)))
    if (got.some((x) => !x)) return
    out[o.id] = got.flatMap((x) => x!.filter(busyWorker).map((w) => w.dispatchId))
  }))
  return out
}

/** orca plugin list の 1 行（使う欄だけ）。 */
export type PluginRow = {
  pluginKey: string; status: string; needsReconsent?: boolean; isDev?: boolean
  source?: { reference?: string | null; contentHash?: string | null } | null
  /** フォルダから入れたプラグインの、今のフォルダの中身の hash（orca plugin inspect）。入れた写しの contentHash と比べる。 */
  folderHash?: string | null
}
export const PLUGIN_KEY = 'local.cockpit'

/**
 * 操縦席のプラグインが動いていないときの理由。Orca に合わせた切り替え（focus.json）はプラグインの worker が書くので、止まると窓が前面に追いつかない
 * （2026-11-16 に、開発用の読み込みを消したあと承認待ちになり、理由が分からないまま切り替わらなくなった）。
 */
export function pluginProblem(plugins: PluginRow[], forUser = false): string | undefined {
  const mine = plugins.filter((p) => p.pluginKey === PLUGIN_KEY)
  const dev = mine.find((p) => p.isDev)
  // 動いている版（開発用の読み込みがあればそちら）の承認待ち・停止は、利用者向けでも出す。
  const p = dev ?? mine[0]
  if (!p) return 'Orca に操縦席のプラグインが入っていないため、Orca に合わせた切り替えが止まっています'
  if (p.status === 'pending' || p.needsReconsent) return 'Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています'
  if (p.status !== 'running' && p.status !== 'idle') return `Orca のプラグインが止まっている（${p.status}）ため、Orca に合わせた切り替えが止まっています`
  if (dev) return forUser ? undefined : `Orca の操縦席のプラグインが開発用の読み込み（${dev.source?.reference ?? '場所不明'}）に置き換わっています。Orca に合わせた切り替えはその版が受け持ちます`
  // Orca はフォルダではなく入れた時点の写しを動かす。main に直しを入れても写しは古いまま（2026-11-16 に 13:17 の写しが前面の知らせを書かなかった）。
  if (!forUser && p.folderHash && p.source?.contentHash && p.folderHash !== p.source.contentHash)
    return 'Orca の操縦席のプラグインが、フォルダの今の中身より古い写しのまま動いています（orca plugin update local.cockpit で入れ直す）'
  return undefined
}
