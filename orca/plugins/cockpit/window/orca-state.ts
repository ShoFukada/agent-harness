// Orca の worktree ps と terminal list から、ワークスペースのメインと worker と worktree を決める。窓の常駐のプロセスと CLI（state.ts）が使う。
import path from 'node:path'
import { taskOfWorker, type Cockpit } from '../src/model.ts'
import type { AgentRow, StopReason } from '../src/protocol.ts'

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
}
export type PsRow = { worktreeId: string; path: string; parentWorktreeId: string | null; displayName?: string | null; comment?: string | null; agents: PsAgent[] }
// ログイン切れと利用枠は Orca が状態として持たないので、最後の発言の文から推す。
// 長い発言は作業の報告で、文中の「limit」などを拾わないよう短いものだけを見る。
export const SHORT = 400
const LIMIT = /usage limit|rate limit|limit reached|out of extra usage|上限に達/i
const AUTH = /\/login|not logged in|authentication_error|oauth token|invalid api key|\b401\b/i

export function stopReason(a: PsAgent): StopReason | undefined {
  const outcome = a.mainAgent?.outcome
  if (a.hasLivePty === false && (a.state !== 'done' || outcome !== 'success')) return 'dead'
  if (a.state === 'blocked' || a.state === 'waiting') return a.state
  if (a.state !== 'done') return undefined
  const msg = a.lastAssistantMessage ?? ''
  if (msg.length <= SHORT && LIMIT.test(msg)) return 'limit'
  if (msg.length <= SHORT && AUTH.test(msg)) return 'auth'
  if (outcome === 'failure') return 'error'
  if (a.interrupted || outcome === 'interruption') return 'interrupted'
  return undefined
}

/** worker の仕事が分かる 1 行。Orca の表示名は「ブランチ名｜仕事」の形が多いので、｜の後ろを優先する。 */
export function jobOf(row: PsRow): string | undefined {
  const name = row.displayName?.split('｜').slice(1).join('｜').trim() || row.displayName?.trim()
  return name || row.comment?.trim() || undefined
}
function toAgent(a: PsAgent, row: PsRow, terms: Map<string, string>, c: Cockpit | undefined): AgentRow {
  // どの task の worker かは、メインが worker を立てたときに記録した worktree id と端末で引く。記録が無ければ表示名・コメント。
  const terminalId = terms.get(a.paneKey) ?? null
  const task = c ? taskOfWorker(c.tasks, row.worktreeId, terminalId) : undefined
  return {
    terminalId,
    title: a.conversationName ?? a.displayName ?? a.taskTitle ?? path.basename(row.path),
    agent: a.agentType ?? null, state: a.state, since: a.stateStartedAt, stop: stopReason(a), worktree: row.path,
    job: task?.title ?? jobOf(row), task: task?.id
  }
}

/** terms は paneKey → 端末の handle。 */
export function orcaAgents(root: string, ps: PsRow[], terms: Map<string, string>, c: Cockpit | undefined): { main?: AgentRow; workers: AgentRow[] } {
  const row = ps.find((r) => r.path === root)
  if (!row) return { workers: [] }
  const kids = ps.filter((r) => r.parentWorktreeId === row.worktreeId)
  const all = [row, ...kids].flatMap((r) => r.agents.map((a) => toAgent(a, r, terms, c)))
  const own = all.filter((a) => a.worktree === root)
  const terminal = c?.main?.terminal
  // メインが端末を開き直して cockpit.json の main が古いときも、本線に 1 つだけいるエージェントはメインと見なす。
  const main = own.find((a) => a.terminalId && a.terminalId === terminal) ?? (own.length === 1 ? own[0] : undefined)
  return { main, workers: all.filter((a) => a !== main) }
}

/** 本線と子の worktree のうち、Orca に今ある worktree の id。 */
export function orcaWorktrees(root: string, ps: PsRow[]): string[] {
  const row = ps.find((r) => r.path === root)
  return row ? [row, ...ps.filter((r) => r.parentWorktreeId === row.worktreeId)].map((r) => r.worktreeId) : []
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
export function pluginProblem(plugins: PluginRow[]): string | undefined {
  const mine = plugins.filter((p) => p.pluginKey === PLUGIN_KEY)
  const dev = mine.find((p) => p.isDev)
  if (dev) return `Orca の操縦席のプラグインが開発用の読み込み（${dev.source?.reference ?? '場所不明'}）に置き換わっています。Orca に合わせた切り替えはその版が受け持ちます`
  const p = mine[0]
  if (!p) return 'Orca に操縦席のプラグインが入っていないため、Orca に合わせた切り替えが止まっています'
  if (p.status === 'pending' || p.needsReconsent) return 'Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています'
  if (p.status !== 'running' && p.status !== 'idle') return `Orca のプラグインが止まっている（${p.status}）ため、Orca に合わせた切り替えが止まっています`
  // Orca はフォルダではなく入れた時点の写しを動かす。main に直しを入れても写しは古いまま（2026-11-16 に 13:17 の写しが前面の知らせを書かなかった）。
  if (p.folderHash && p.source?.contentHash && p.folderHash !== p.source.contentHash)
    return 'Orca の操縦席のプラグインが、フォルダの今の中身より古い写しのまま動いています（orca plugin update local.cockpit で入れ直す）'
  return undefined
}
