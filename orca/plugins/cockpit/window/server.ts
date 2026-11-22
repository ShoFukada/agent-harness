// 操縦席の窓の常駐のプロセス。127.0.0.1 だけで待ち受けてページを配り、focus.json（パネルの worker が書く）と、
// 操縦席のあるワークスペースの .orca/ を見張って、変わったらページに SSE で送る。launchd が起動する（configuration.nix）。
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, promises as fsp, watch, type FSWatcher } from 'node:fs'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASK_ID, askItem, chatMain, escapeAskSections, requestCards, OP_TYPES, overlay, textError, unanswered, type AskThread, type Card, type Cockpit, type ConsultMemo, type OpType } from '../src/model.ts'
import { clipDraft, isDraftFormat } from '../src/clip.ts'
import type { Ask, AskDecideResult, AskResult, ClipResult, CockpitView, DispatchFact, FocusResult, NotifyResult, OpenResult, OpInput, OwnerLive, QuestionFact, RulingHit, TalkResult, WindowView } from '../src/protocol.ts'
import { agentTitle, matchRulings, ownerOf } from '../src/state.ts'
import {
  currentDispatches, descendants, failuresOf, openQuestions, orcaAgents, orcaDispatches, PLUGIN_KEY, pluginProblem, questionFacts, screenAsk, SHORT, toolAsk,
  type Failure, type InboxMessage, type OpenQuestion, type PluginRow, type PsAgent, type PsRow, type RunTask, type TaskLink, type WorkerShow, CHAT_HANDLE, chatHandles, liveChats } from './orca-state.ts'
export { jobOf, stopReason, type PluginRow, type PsAgent, type PsRow } from './orca-state.ts'
import { appendOp, appendOpOnce, emptyFiles, lastAskDecide, loadFiles, readAsks, reserveAskId, notifyMain, readNotified, recordFirstSeen, signalPlan, splitLine, writeNotified, type Files } from '../src/store.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const SERVED = new Set(['window/page.ts', 'src/controller.ts', 'src/model.ts', 'src/morph.ts', 'src/sanitize.ts', 'src/state.ts', 'src/style.ts', 'src/view.ts', 'src/window-view.ts'])
/** カードの詳細に出す、相談で決まったことの件数（window-view.ts の consultHtml と同じ）。 */
const SHOWN_DECISIONS = 3
/** 窓に送る、質問 1 つの控えの節の数と 1 節の字数（長い答えを毎回の配信に載せない）。 */
const ASK_ENTRIES = 6
const ASK_TEXT = 6000
/** 「これで決める」のあとに質問のタブへ送る知らせ（compaction-keep.py が深田さんの発言として記録しない書式）。 */
export const askNotice = (op: number) => `【相談の知らせ】返しを書いて（op ${op}）`
/** 質問のタブの名前（consult --ask の ask_title と同じ）。 */
export const askTitle = (workspace: string, id: string) => `質問｜${workspace.replace(/｜/g, ' ')}｜${id}`
/** 窓に送る片付いたカードの日数。古いものは cockpit.archive.json に移っている。 */
const CLOSED_DAYS = 14
/** ページが表示されている間に Orca の状態を確かめる間隔。プロセスが落ちた worker は Orca から知らせが来ないため。 */
const POLL_MS = 60_000
const REFRESH_GAP_MS = 5_000

export type TerminalRow = { handle: string; tabId: string; leafId: string }
/** 端末の一覧を読む上限。上限まで返ったら一覧が切れているかもしれないので、無い handle を「閉じた」と言い切らない。 */
export const TERMINAL_LIMIT = 500

export type Orca = {
  ps(): Promise<PsRow[]>
  terminals(): Promise<TerminalRow[]>
  plugins(): Promise<PluginRow[]>
  /** チャットも含めた全エージェント（orca agent list）。担当の今を出す。 */
  agents(): Promise<OwnerLive[]>
  /** orchestration worker-show --full。Dispatch が Orca に無ければ null。 */
  show(dispatch: string): Promise<WorkerShow | null>
  /** orchestration task-list --run。Run のタスクと状態。 */
  runTasks(run: string): Promise<RunTask[]>
  /** orchestration dispatch-show --task。タスクの Dispatch と、それが何の続きか。 */
  taskLink(task: string): Promise<TaskLink>
  /** orchestration inbox の新しい 300 通。止まった理由（escalation の failureKind）と、答えの無い question を読む。 */
  inbox?(): Promise<InboxMessage[]>
  /** worktree のタブ（題と、その中の端末の handle）。窓からの質問のタブを題で探す（題は --title で付けたまま残る）。 */
  tabs?(root: string): Promise<{ title: string; handles: string[] }[]>
  /** チャットが Orca に開いているか（orca agent show の result.places が空でない）。無い session は false、読めなければ投げる。 */
  chatOpen?(handle: string): Promise<boolean>
  /** 端末の今の画面の行（terminal read --screen）。AskUserQuestion の問いは画面にしか無い。 */
  screen?(terminal: string): Promise<string[]>
  send(terminal: string, text: string): Promise<void>
  activate(root: string): Promise<void>
  switchTerminal(terminal: string): Promise<void>
  openFile(root: string, abs: string, line?: number): Promise<void>
  /** 既定のブラウザで開く。http(s) かどうかは呼ぶ側が確かめる。 */
  openUrl(url: string): Promise<void>
}

export function orcaCli(bin = 'orca'): Orca {
  const run = (args: string[]) =>
    new Promise<Record<string, unknown>>((resolve, reject) =>
      execFile(bin, [...args, '--json'], { timeout: 15_000, maxBuffer: 64 << 20 }, (err, out) => {
        let json: { ok?: boolean; result?: Record<string, unknown>; error?: { message?: string; code?: string } } | undefined
        try {
          json = JSON.parse(out)
        } catch {
          return reject(new Error(err?.message ?? 'orca の出力を読めません'))
        }
        if (err || json?.ok === false) return reject(Object.assign(new Error(json?.error?.message ?? err?.message ?? 'orca が失敗しました'), { code: json?.error?.code }))
        resolve(json?.result ?? {})
      })
    )
  return {
    ps: async () =>
      ((await run(['worktree', 'ps', '--limit', '500'])).worktrees as PsRow[]).map((r) => ({
        worktreeId: r.worktreeId, path: r.path, parentWorktreeId: r.parentWorktreeId, displayName: r.displayName, comment: r.comment,
        agents: r.agents.map((a) => ({
          paneKey: a.paneKey, state: a.state, agentType: a.agentType, conversationName: a.conversationName,
          displayName: a.displayName, taskTitle: a.taskTitle, stateStartedAt: a.stateStartedAt, interrupted: a.interrupted,
          hasLivePty: a.hasLivePty, mainAgent: a.mainAgent ? { outcome: a.mainAgent.outcome } : null, orcaSessionId: a.orcaSessionId ?? null,
          toolName: a.toolName ?? null, toolInput: a.toolInput ? a.toolInput.slice(0, SHORT) : null,
          lastAssistantMessage: (a.lastAssistantMessage ?? '').length <= SHORT ? a.lastAssistantMessage : null
        }))
      })),
    agents: async () => {
      type Listed = { orcaSessionId: string; kind: string; state: OwnerLive['state']; title?: string | null; worktreeId?: string; updatedAt?: number }
      return ((await run(['agent', 'list'])).agents as Listed[]).map((a) => ({
        session: a.orcaSessionId, kind: a.kind === 'chat' ? 'chat' : 'terminal', state: a.state, title: a.title ?? undefined,
        // worktreeId は「リポジトリの id::パス」の形。開くのはパス。
        worktree: a.worktreeId?.split('::').slice(1).join('::') || undefined, updatedAt: a.updatedAt
      }))
    },
    terminals: async () =>
      ((await run(['terminal', 'list', '--limit', String(TERMINAL_LIMIT)])).terminals as TerminalRow[]).map(({ handle, tabId, leafId }) => ({ handle, tabId, leafId })),
    plugins: async () => {
      type Listed = PluginRow & { source?: { kind?: string; reference?: string | null; contentHash?: string | null } | null }
      const rows = ((await run(['plugin', 'list'])).plugins as Listed[]).map(({ pluginKey, status, needsReconsent, isDev, source }) => ({
        pluginKey, status, needsReconsent, isDev, kind: source?.kind,
        source: source && { reference: source.reference, contentHash: source.contentHash }
      }))
      // フォルダから入れた操縦席だけ、今のフォルダの中身の hash を取る（入れた写しが古いかを見るため）。
      const mine = rows.find((r) => r.pluginKey === PLUGIN_KEY && !r.isDev && r.kind === 'local-path' && r.source?.reference)
      if (mine) mine.folderHash = ((await run(['plugin', 'inspect', mine.source!.reference!]).catch(() => ({}))) as { contentHash?: string }).contentHash ?? null
      return rows.map(({ kind: _kind, ...r }) => r)
    },
    show: (dispatch) =>
      run(['orchestration', 'worker-show', '--dispatch', dispatch, '--full']).then(
        (r) => r as WorkerShow,
        (e: Error & { code?: string }) => {
          if (e.code === 'dispatch_not_found') return null
          throw e
        }
      ),
    runTasks: async (runId) => ((await run(['orchestration', 'task-list', '--run', runId])).tasks as RunTask[]).map(({ id, status, dispatchId }) => ({ id, status, dispatchId })),
    taskLink: async (task) => {
      const d = (await run(['orchestration', 'dispatch-show', '--task', task])).dispatch as { id?: string; follow_up_of_dispatch_id?: string | null } | null
      return { dispatch: d?.id ?? null, followUpOf: d?.follow_up_of_dispatch_id ?? null }
    },
    inbox: async () => ((await run(['orchestration', 'inbox', '--full', '--limit', '300'])).messages ?? []) as InboxMessage[],
    tabs: async (root) => {
      const r = await run(['terminal', 'list', '--worktree', `path:${root}`, '--include-visual-layouts'])
      return tabsOf(r.visualLayouts, root)
    },
    chatOpen: (handle) =>
      run(['agent', 'show', handle]).then(
        (r) => Array.isArray(r.places) && r.places.length > 0,
        (e: Error & { code?: string }) => {
          if (e.code === 'agent_unknown') return false
          throw e
        }
      ),
    screen: async (terminal) => (((await run(['terminal', 'read', '--terminal', terminal, '--screen'])).terminal as { tail?: string[] } | undefined)?.tail ?? []),
    send: async (terminal, text) => void (await run(['terminal', 'send', '--terminal', terminal, '--text', text, '--enter'])),
    activate: async (root) => void (await run(['worktree', 'activate', '--worktree', `path:${root}`])),
    switchTerminal: async (terminal) => void (await run(['terminal', 'switch', '--terminal', terminal])),
    openFile: async (root, abs, line) =>
      void (await run(['file', 'open', abs, '--worktree', `path:${root}`, '--focus', ...(line ? ['--line', String(line)] : [])])),
    openUrl: (url) =>
      new Promise<void>((resolve, reject) => execFile('/usr/bin/open', [url], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve())))
  }
}

/** terminal list --include-visual-layouts の visualLayouts から、root の worktree のタブを抜く（consult の live_thread と同じ読み方）。 */
export function tabsOf(layouts: unknown, root: string): { title: string; handles: string[] }[] {
  const terms = (n: unknown): string[] =>
    Array.isArray(n) ? n.flatMap(terms) : typeof n === 'object' && n !== null
      ? [...((n as Record<string, unknown>).type === 'terminal' && typeof (n as Record<string, unknown>).handle === 'string' && (n as Record<string, unknown>).connected !== false ? [(n as Record<string, string>).handle] : []), ...Object.values(n).flatMap(terms)]
      : []
  const tabs = (n: unknown): Record<string, unknown>[] =>
    Array.isArray(n) ? n.flatMap(tabs) : typeof n === 'object' && n !== null
      ? [...(Array.isArray((n as Record<string, unknown>).tabs) ? ((n as Record<string, unknown>).tabs as Record<string, unknown>[]) : []), ...Object.values(n).flatMap(tabs)]
      : []
  const mine = (Array.isArray(layouts) ? layouts : []).filter((l) => typeof l === 'object' && l !== null && path.resolve(String((l as Record<string, unknown>).worktreePath ?? '/')) === path.resolve(root))
  return tabs(mine).filter((t) => typeof t.title === 'string').map((t) => ({ title: t.title as string, handles: [...new Set(terms(t.panes))] }))
}

type Ws = {
  root: string
  files: Files
  watcher?: FSWatcher
  timer?: ReturnType<typeof setTimeout>
  signal?: CockpitView['signal']
  signalTimer?: ReturnType<typeof setTimeout>
}

type Focus = { path?: string; agents_at?: number }
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * カードの相談のタブを立てる（開いていれば前に出す）道具。返すのはタブの端末の handle。失敗は理由を message に持つ例外。
 * 渡さなければ、担当のいないカードも今どおり窓口に回す。
 */
export type Consult = (root: string, card: string) => Promise<string>
/** 窓からの質問のタブを立てる（開いていれば前に出して質問を送る）道具。返すのはタブの端末の handle。 */
export type AskCmd = (root: string, id: string, o: { card?: string; task?: string; question?: string }) => Promise<string>
/**
 * clip はテストで差し替える（既定は clip-draft を呼ぶ）。tailnetHosts は tailscale serve が HTTPS で渡す Host（例: mac.tail1234.ts.net）で、
 * その Host と Origin（https://<Host>）も許す。待ち受けは 127.0.0.1 のまま（serve が Mac の中から繋ぐ）。
 */
export type Options = { port: number; dir: string; orca: Orca; host?: string; clip?: typeof clipDraft; consult?: Consult; ask?: AskCmd; tailnetHosts?: string[] }

/** COCKPIT_TAILNET_HOSTS（カンマ区切り）を読む。ホスト名[:ポート] の形でないものは捨てて理由を出す（ワイルドカードや URL を許す一覧に入れない）。 */
export function parseTailnetHosts(v: string | undefined): string[] {
  return (v ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).flatMap((h) => {
    const m = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)\.?(?::(\d{1,5}))?$/.exec(h)
    if (!m) {
      console.error(`COCKPIT_TAILNET_HOSTS: ホスト名の形でないので許さない: ${h}`)
      return []
    }
    // ブラウザは https の 443 を Host と Origin から省くので、設定の :443 も外す。
    return [m[5] && m[5] !== '443' ? `${m[1]}:${m[5]}` : m[1]!]
  })
}

/** nix-darwin の consult --card。標準出力の 1 行目が端末の handle、失敗は 0 以外の終了と標準エラーの理由。 */
export function consultCli(cmd: string): Consult {
  return (root, card) =>
    new Promise((resolve, reject) =>
      execFile(cmd, ['--card', root, card], { timeout: 60_000 }, (err, out, errOut) => {
        const handle = String(out).split('\n')[0]?.trim()
        if (!err && handle) return resolve(handle)
        const why = String(errOut).trim() || err?.message || 'consult が端末の handle を返しませんでした'
        reject(new Error(why.length > 300 ? `${why.slice(0, 300)}…` : why))
      })
    )
}

/** nix-darwin の consult --ask。標準出力の 1 行目が端末の handle、失敗は 0 以外の終了と標準エラーの理由（「窓口の会話が分かりません…」など）。 */
export function askCli(cmd: string): AskCmd {
  return (root, id, o) =>
    new Promise((resolve, reject) =>
      execFile(cmd, ['--ask', root, id, ...(o.card ? ['--on-card', o.card] : []), ...(o.task ? ['--on-task', o.task] : []), ...(o.question ? [`--question=${o.question}`] : [])], { timeout: 60_000 }, (err, out, errOut) => {
        const handle = String(out).split('\n')[0]?.trim()
        if (!err && handle) return resolve(handle)
        // consult の理由の頭の「consult: 」は深田さんに要らないので外す。
        const why = (String(errOut).trim() || err?.message || 'consult が端末の handle を返しませんでした').replace(/^consult: /, '')
        reject(new Error(why.length > 300 ? `${why.slice(0, 300)}…` : why))
      })
    )
}

/** 窓に送る質問。控えの節は新しいものから ASK_ENTRIES 個、返しは return_id・op・決まったことの文だけにする。 */
export function slimAsks(xs: AskThread[]): AskThread[] {
  return xs.map((a) => ({
    ...a,
    entries: a.entries.slice(-ASK_ENTRIES).map((e) => ({ ...e, text: e.text.length > ASK_TEXT ? `${e.text.slice(0, ASK_TEXT)}…` : e.text })),
    returns: a.returns.map((r) => ({
      return_id: r.return_id, ...(r.op !== undefined && { op: r.op }),
      decisions: (Array.isArray(r.decisions) ? r.decisions : []).filter((d) => typeof d?.text === 'string' && d.text.trim()).slice(0, 5).map((d) => ({ text: d.text }))
    }))
  }))
}

export function createServer(opts: Options) {
  const token = randomBytes(24).toString('base64url')
  const { orca } = opts
  let port = opts.port
  const wss = new Map<string, Ws>()
  let ps: PsRow[] = []
  let terms = new Map<string, string>()
  /** 開いているチャットの相談の handle と、閉じたと分かったもの（閉じたものは問い合わせ直さない）。 */
  let chats = new Set<string>()
  const closedChats = new Set<string>()
  let owners: OwnerLive[] = []
  /** orca agent list を読めなかった。チャットが「無い」と言い切らないために持つ。 */
  let ownersStale = false
  /** Orca が止まったチャットに残した理由（orca-state.ts の Failure）。 */
  let failures: Record<string, Failure> = {}
  /** 答えの無い orchestration の question（全案件）と、案件ごとに結んだもの。 */
  let questions: OpenQuestion[] = []
  const questionsBy = new Map<string, QuestionFact[]>()
  /** 案件ごとの、質問 id を採って consult --ask を呼ぶ順番（同じ id を 2 つの質問に付けない）。 */
  const asking = new Map<string, Promise<unknown>>()
  /** 端末の画面から読んだ問い（「handle@止まった時刻」→ 問い）。同じ停止のあいだは読み直さない。 */
  let screens = new Map<string, Ask>()
  let orcaError: string | undefined
  let pluginNote: string | undefined
  /** ワークスペースの root → worker の記録の Dispatch の様子。まだ読んでいなければ無い。 */
  const facts = new Map<string, Record<string, DispatchFact | null>>()
  /** ワークスペースの root → タスクの id → 今の Dispatch。 */
  const currents = new Map<string, Record<string, string>>()
  /** Orca のタスク → その Dispatch と、何の続きか（変わらないので覚えておく）。 */
  const links = new Map<string, TaskLink>()
  /** stallwatch が書く alerts.json の、Orca の監督の外で止まったもの。 */
  let alerts: string[] = []
  let focus: Focus = {}
  /** この常駐のプロセスが書いた操作（root#op_id）。合図は書いた側が先に送る（store.ts の signalPlan）。 */
  const mine = new Set<string>()
  const clients = new Set<http.ServerResponse>()
  let poll: ReturnType<typeof setInterval> | undefined
  let focusWatcher: FSWatcher | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let sendTimer: ReturnType<typeof setTimeout> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshing: Promise<void> | undefined
  let lastRefresh = 0
  const jsCache = new Map<string, { mtime: number; code: string }>()

  const hasCockpit = (root: string) => !!wss.get(root)?.files.cockpit || existsSync(path.join(root, '.orca', 'cockpit.json'))
  const rowOf = (root: string) => ps.find((r) => r.path === root)

  /** Orca の前面に当たる行。前面が担当や worker の worktree（窓口の子・孫）なら、操縦席のある祖先。 */
  function followRoot(): string | undefined {
    const p = focus.path
    if (!p) return undefined
    const owner = ps.find((r) => !r.parentWorktreeId && hasCockpit(r.path) && descendants(ps, r).some((x) => x.path === p))
    return owner?.path ?? p
  }

  const agentsOf = (root: string, files: Files) => orcaAgents(root, ps, terms, files.cockpit, facts.get(root), currents.get(root), failures)
  const workersOf = (root: string, files: Files) => agentsOf(root, files).workers

  async function cockpitView(root: string | undefined, slim = false): Promise<CockpitView> {
    const ws = root ? wss.get(root) : undefined
    const files = ws?.files ?? emptyFiles()
    const since = Date.now() - CLOSED_DAYS * 86_400_000
    // 依頼の今は証拠の「これでよい」が指すカードの版と、依頼に結ばれたカードで決めるので、表示の期間を過ぎても送る（CLI と窓で食い違わないように）。
    const proof = files.cockpit ? requestCards(files.cockpit, files.log) : new Set<string>()
    const recent = (x: Card) => x.state !== 'done' || !x.resolved_at || Date.parse(x.resolved_at) > since || proof.has(x.id)
    // 済んでいないタスクに結ばれたカードは、期間を過ぎても送る（タスクの詳細から開くため）。
    const live = new Set(files.cockpit?.tasks.filter((t) => t.state !== 'ok').map((t) => t.id))
    const tied = (x: Card) => !!x.tasks?.some((t) => live.has(t))
    const keep = (x: Card) => recent(x) || tied(x)
    const cockpit = slim && files.cockpit ? slimmed(files.cockpit, keep) : files.cockpit
    const archive = slim ? files.archive.filter((c) => Date.parse(c.resolved_at ?? '') > since || proof.has(c.id) || tied(c)) : files.archive
    return {
      state: !root ? 'no-workspace' : files.missing ? 'missing' : 'ok',
      root, cockpit, log: files.log, figures: files.figures, errors: files.errors,
      archive,
      workers: root ? workersOf(root, files) : [], dispatches: root ? facts.get(root) : undefined, current: root ? currents.get(root) : undefined, owners,
      notifiedOp: root ? await readNotified(opts.dir, root) : 0, signal: ws?.signal, handoff: files.handoff,
      // 仕分けの検査は intake の位置より後と結ばれていない行だけを見るので、本文は頭だけ送る。
      utterances: files.utterances.map((u) => ({ ...u, prompt: u.prompt?.slice(0, 80) })), firstSeen: files.firstSeen,
      terminals: lastRefresh && !orcaError ? [...terms.values(), ...chats] : undefined, terminalsPartial: terms.size >= TERMINAL_LIMIT || undefined,
      consults: consultsFor(files.consults, cockpit, archive), questions: root ? questionsBy.get(root) : undefined,
      asks: slimAsks(files.asks)
    }
  }

  /**
   * 窓に送る相談のメモ。送るカードのメモだけにし、返しは窓が出す分（新しい返しから、選んだ案と決まったことの文を 3 件まで）に絞る
   * （メモは相談スレッドが書くので、知らない欄や長い返しを毎回の配信に載せない）。
   */
  function consultsFor(memos: ConsultMemo[], c: Cockpit | undefined, archive: Card[]): ConsultMemo[] {
    const ids = new Set([...(c?.cards ?? []), ...archive].map((x) => x.id))
    return memos.filter((m) => ids.has(m.card)).map((m) => {
      const out: ConsultMemo['returns'] = []
      let left = SHOWN_DECISIONS
      for (const x of [...m.returns].reverse()) {
        if (left <= 0) break
        const choice = typeof x.choice === 'string' && x.choice ? x.choice : undefined
        if (choice) left--
        const decisions = (Array.isArray(x.decisions) ? x.decisions : []).filter((d) => typeof d?.text === 'string' && d.text.trim()).slice(0, Math.max(left, 0)).map((d) => ({ text: d.text }))
        left -= decisions.length
        if (choice || decisions.length) out.unshift({ return_id: x.return_id, ...(choice && { choice }), decisions })
      }
      return { ...m, returns: out }
    })
  }

  /** 窓に送る量を減らす。片付いて日のたったカードと、タスクの済んだ作業の記録は画面に出さない。 */
  function slimmed(c: NonNullable<Files['cockpit']>, keep: (x: Card) => boolean): NonNullable<Files['cockpit']> {
    return { ...c, cards: c.cards.filter(keep), tasks: c.tasks.map(({ done: _d, sources: _s, ...t }) => t) }
  }

  /**
   * 取り消しの猶予が過ぎた操作があれば、メインに合図を送る。入力中の文字と混ざらないよう、メインが作業中（working）の間は送らず、
   * エージェントの状態が変わった知らせ（focus.json の agents_at）でもう一度呼ぶ。
   */
  async function autoSignal(ws: Ws): Promise<void> {
    clearTimeout(ws.signalTimer)
    const c = ws.files.cockpit
    if (!c || chatMain(c)) return void (ws.signal = undefined)
    const plan = signalPlan(c, ws.files.log, await readNotified(opts.dir, ws.root), Date.now(), (o) => mine.has(`${ws.root}#${o.op_id}`))
    if (plan.nextAt !== undefined)
      ws.signalTimer = setTimeout(() => void autoSignal(ws).then(broadcast, (e) => console.error(e)), plan.nextAt - Date.now() + 50)
    if (!plan.due.length) return void (ws.signal = undefined)
    if (Date.now() - lastRefresh > REFRESH_GAP_MS) await refreshOrca()
    const main = agentsOf(ws.root, ws.files).main
    if (!main) return void (ws.signal = { state: 'failed', reason: 'メインのエージェントが見つかりません' })
    if (main.state === 'working') return void (ws.signal = { state: 'waiting' })
    const r = await notify(ws)
    ws.signal = r.sent ? undefined : { state: 'failed', reason: r.reason }
  }

  async function windowView(): Promise<WindowView> {
    const live = ps.flatMap((r) => r.agents).filter((a) => a.hasLivePty === true || (a.hasLivePty !== false && a.state !== 'done')).length
    const boards = await Promise.all([...wss.values()].filter((ws) => ws.files.cockpit || ws.files.errors.length).map((ws) => cockpitView(ws.root, true)))
    // Orca にある本線のうち、操縦席の無いもの（見ていない案件）。worker の worktree と、操縦席の窓のある本線は除く。
    const unseen = ps.filter((r) => !r.parentWorktreeId && !hasCockpit(r.path)).map((r) => ({ name: r.displayName?.trim() || path.basename(r.path), path: r.path }))
    return { focused: followRoot(), boards, unseen, live, errors: [orcaError, pluginNote, ...alerts].filter((e): e is string => !!e) }
  }

  function broadcast(): void {
    if (!clients.size) return
    clearTimeout(sendTimer)
    sendTimer = setTimeout(async () => {
      const data = `data: ${JSON.stringify(await windowView())}\n\n`
      for (const res of clients) res.write(data)
    }, 30)
  }

  async function reload(ws: Ws): Promise<void> {
    ws.files = await loadFiles(ws.root, ws.files)
    // at の無い開いたカードは、ここで最初に見つけた時刻を覚え、抜けの 30 分を数える（常駐のプロセスだけが書く）。
    ws.files.firstSeen = await recordFirstSeen(ws.root, ws.files, Date.now()).catch((e: Error) => (console.error(`firstseen.json: ${e.message}`), ws.files.firstSeen))
  }

  function watchWs(ws: Ws): void {
    if (ws.watcher) return
    try {
      ws.watcher = watch(path.join(ws.root, '.orca'), { recursive: true }, () => {
        clearTimeout(ws.timer)
        ws.timer = setTimeout(() => void reload(ws).then(() => autoSignal(ws)).then(broadcast, (e) => console.error(e)), 80)
      })
      ws.watcher.on('error', () => {
        ws.watcher?.close()
        ws.watcher = undefined
      })
    } catch {
      // .orca がまだ無い。次に Orca の状態を確かめたときにもう一度見張る。
    }
  }

  async function sync(): Promise<void> {
    const want = new Set(ps.filter((r) => !r.parentWorktreeId && hasCockpit(r.path)).map((r) => r.path))
    for (const [root, ws] of wss)
      if (!want.has(root)) {
        ws.watcher?.close()
        clearTimeout(ws.timer)
        clearTimeout(ws.signalTimer)
        wss.delete(root)
      }
    await Promise.all([...want].map(async (root) => {
      let ws = wss.get(root)
      if (ws?.watcher) return
      ws ??= { root, files: emptyFiles() }
      wss.set(root, ws)
      watchWs(ws)
      await reload(ws)
      // 見張り始めた案件にも、猶予の過ぎた未送の操作があれば合図を送る（起動し直したときに取りこぼさない）。
      void autoSignal(ws).then(broadcast, (e) => console.error(e))
    }))
  }

  async function readAlerts(): Promise<void> {
    let next: string[] = []
    try {
      const d = JSON.parse(await fsp.readFile(path.join(opts.dir, 'alerts.json'), 'utf8')) as { alerts?: { text?: unknown }[] }
      next = (d.alerts ?? []).map((a) => a.text).filter((t): t is string => typeof t === 'string').map((t) => `止まっている: ${t}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return void console.error(`alerts.json: ${(e as Error).message}`)
    }
    if (next.join('\n') === alerts.join('\n')) return
    alerts = next
    broadcast()
  }

  function refreshOrca(): Promise<void> {
    return (refreshing ??= (async () => {
      try {
        const [rowsNow, tl, plugins, ags] = await Promise.all([orca.ps(), orca.terminals(), orca.plugins().catch(() => undefined), orca.agents().catch(() => undefined)])
        // 窓には深田さんの手が要るもの（承認待ち・入っていない・止まった）だけを出す。写しの入れ直しと開発用の読み込みは窓口の仕事（初見 8）。
        pluginNote = plugins && pluginProblem(plugins, true)
        if (ags) owners = ags
        ownersStale = !ags
        ps = rowsNow
        terms = new Map(tl.map((t) => [`${t.tabId}:${t.leafId}`, t.handle]))
        chats = new Set(await liveChats([...new Set([...chats, ...chatHandles([...wss.values()].flatMap((ws) => ws.files.log.ops))])], orca.chatOpen, closedChats))
        // 失敗の理由と答えの無い question は inbox にしかない。読めなければ前のまま（失敗の理由は文から推す）。
        const inbox = await orca.inbox?.().catch((e: Error) => void console.error(`inbox: ${e.message}`))
        if (inbox) {
          failures = failuresOf(inbox)
          questions = openQuestions(inbox, questions)
        }
        await readScreens()
        orcaError = undefined
      } catch (e) {
        orcaError = 'Orca に繋がりません'
        console.error(`orca: ${(e as Error).message}`)
      }
      lastRefresh = Date.now()
      await sync()
      // 1 回の読み直しの中では、同じ Dispatch の worker-show を案件ごとに問い合わせ直さない。
      const shown = new Map<string, Promise<WorkerShow | null>>()
      const showOnce = (d: string) => shown.get(d) ?? (shown.set(d, orca.show(d)), shown.get(d)!)
      const termAt = new Map(ps.flatMap((r) => r.agents.map((a) => [terms.get(a.paneKey) ?? '', r.path] as const)).filter(([h]) => h))
      const ended = new Set<string>()
      if (!orcaError)
        for (const ws of wss.values()) {
          const c = ws.files.cockpit
          if (!c) continue
          try {
            const { current, status } = await currentDispatches(c, { tasks: orca.runTasks, link: orca.taskLink }, links)
            currents.set(ws.root, current)
            facts.set(ws.root, await orcaDispatches(c, showOnce, current, status))
            questionsBy.set(ws.root, await questionFacts(c, ws.root, ps, questions, facts.get(ws.root)!, current, owners, showOnce, termAt, ended))
          } catch (e) {
            console.error(`orchestration: ${(e as Error).message}`)
          }
        }
      if (ended.size) questions = questions.filter((q) => !ended.has(q.id))
      broadcast()
    })().finally(() => {
      refreshing = undefined
    }))
  }

  /**
   * 許可待ち・返事待ちの端末で、Orca の道具の欄から問いを読めないもの（AskUserQuestion）は、画面の末尾から読む。読めた問いは ps の行に足す
   * （orca-state.ts の toAgent が使う）。チャットは画面を読めないので、読めなかったと出す。
   */
  async function readScreens(): Promise<void> {
    const next = new Map<string, Ask>()
    // 毎回読み直す（AskUserQuestion の 2 問目に進んでも止まった時刻は変わらない）。読めなかった回は、同じ停止の前の問いを使う。
    // 端末ごとに並べて読み、1 本が 15 秒待たせても他の端末の分を待たせない。
    await Promise.all(ps.flatMap((r) => r.agents).map(async (a) => {
      const handle = terms.get(a.paneKey)
      if ((a.state !== 'blocked' && a.state !== 'waiting') || !handle || toolAsk(a) || !orca.screen) return
      const key = `${handle}@${a.stateStartedAt}`
      const ask = screenAsk(await orca.screen(handle).catch(() => []), a.state === 'blocked' ? 'permit' : 'question') ?? screens.get(key)
      if (ask) next.set(key, (a.screen = ask))
    }))
    screens = next
  }

  const background = () => void refreshOrca().catch((e) => console.error(`refresh: ${(e as Error).message}`))

  function refreshSoon(): void {
    if (!clients.size || refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      if (clients.size) background()
    }, Math.max(0, lastRefresh + REFRESH_GAP_MS - Date.now()))
  }

  async function readFocus(): Promise<void> {
    let next: Focus = {}
    try {
      next = JSON.parse(await fsp.readFile(path.join(opts.dir, 'focus.json'), 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`focus.json: ${(e as Error).message}`)
      return
    }
    const moved = next.path !== focus.path
    const agents = next.agents_at !== focus.agents_at
    focus = next
    if (moved) broadcast()
    if (agents) {
      refreshSoon()
      // メインが作業中で合図を待たせていたら、入力待ちになったかを確かめて送る。
      for (const ws of wss.values()) if (ws.signal) void autoSignal(ws).then(broadcast, (e) => console.error(e))
    }
  }

  function startPolling(): void {
    if (poll) return
    background()
    poll = setInterval(background, POLL_MS)
  }
  function stopPolling(): void {
    clearInterval(poll)
    clearTimeout(refreshTimer)
    poll = undefined
    refreshTimer = undefined
  }

  const tailnet = opts.tailnetHosts ?? []
  const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`, ...tailnet]
  const origins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...tailnet.map((h) => `https://${h}`)]
  const tokenOk = (got: unknown) =>
    typeof got === 'string' && got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token))

  function page(): string {
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="cockpit-token" content="${token}"><title>操縦席</title></head><body><script type="module" src="/window/page.ts"></script></body></html>`
  }

  async function js(rel: string): Promise<string> {
    const file = path.join(PLUGIN, rel)
    const mtime = (await fsp.stat(file)).mtimeMs
    const hit = jsCache.get(rel)
    if (hit?.mtime === mtime) return hit.code
    const code = stripTypeScriptTypes(await fsp.readFile(file, 'utf8'))
    jsCache.set(rel, { mtime, code })
    return code
  }

  async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 64 * 1024) throw new HttpError(413, '大きすぎます')
      chunks.push(c as Buffer)
    }
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'JSON のオブジェクトを送ってください')
    return v as Record<string, unknown>
  }

  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

  function knownWs(root: unknown): Ws {
    const ws = typeof root === 'string' ? wss.get(root) : undefined
    if (!ws) throw new HttpError(409, '表示中のワークスペースが変わりました。もう一度押してください')
    return ws
  }

  const send = async (terminal: string, text: string): Promise<NotifyResult> => {
    if (![...terms.values()].includes(terminal)) await refreshOrca()
    if (![...terms.values()].includes(terminal)) return { sent: false, reason: 'メインの端末が見つかりません' }
    await orca.send(terminal, text)
    return { sent: true }
  }

  async function notify(ws: Ws): Promise<NotifyResult> {
    const r = await notifyMain(ws.files.cockpit, ws.files.log, send)
    if (r.lastOp !== undefined) await writeNotified(opts.dir, ws.root, r.lastOp)
    return r.sent ? { sent: true } : { sent: false, reason: r.reason }
  }

  /** 質問のタブの端末（題で探す）。閉じていれば理由。 */
  async function askTab(ws: Ws, id: string): Promise<{ handle: string } | { reason: string }> {
    const closed = { reason: '写しの会話は閉じています。続けて聞くと、窓口の今の会話から写し直します' }
    if (!orca.tabs || !ws.files.cockpit) return closed
    const title = askTitle(ws.files.cockpit.workspace.name, id)
    const handle = (await orca.tabs(ws.root)).find((t) => t.title === title)?.handles[0]
    return handle ? { handle } : closed
  }

  const liveTerminal = (t: string | null | undefined): t is string => !!t && (t.startsWith(CHAT_HANDLE) ? chats.has(t) : [...terms.values()].includes(t))
  const wsName = (p: string) => `ワークスペース「${path.basename(p)}」`

  type Target = { terminal: string; how: string } | { worktree: string; how: string; tab?: string } | { how: string; reason: string }
  /**
   * 担当と話す先。端末の担当はその端末、チャットの担当はチャットのある worktree（Orca にはチャットのタブを前に出す手段が無い）、
   * 担当の無いカードは窓口。開けないときは理由を返す。
   */
  const ownerFor = (ws: Ws, c: Cockpit, card: Card) => ownerOf(c, card, { workers: workersOf(ws.root, ws.files), dispatches: facts.get(ws.root), owners, current: currents.get(ws.root) })
  function talkTarget(ws: Ws, c: Cockpit, card: Card): Target {
    const o = ownerFor(ws, c, card)
    if (o.how === 'main') {
      // cockpit.json の main が古い（開き直した）ときは、本線に 1 つだけいるエージェントの端末を使う。窓口がチャット（main.terminal が空）なら推さない。
      const t = o.terminal ? [o.terminal, agentsOf(ws.root, ws.files).main?.terminalId].find(liveTerminal) : undefined
      if (t) return { terminal: t, how: '窓口の端末' }
      // 窓口はチャット。本線を開き、本線で動いているチャット（済んでいないもの、新しいもの）の題を案内する。
      const chat = owners
        .filter((x) => x.kind === 'chat' && x.worktree === ws.root)
        .sort((x, y) => Number(x.state === 'done') - Number(y.state === 'done') || (y.updatedAt ?? 0) - (x.updatedAt ?? 0))[0]
      return { worktree: ws.root, how: wsName(ws.root), tab: chat?.title ?? '窓口' }
    }
    const who = `担当「${o.title}」`
    if (o.how === 'terminal') {
      if (liveTerminal(o.terminal)) return { terminal: o.terminal, how: `${o.title}の端末` }
      return { how: `${o.title}の端末`, reason: `${who}の端末（${o.terminal}）が Orca にありません。閉じたか、開き直して handle が変わりました。窓口に操縦席の担当の記録を直すよう頼んでください` }
    }
    if (!o.session)
      return { how: `${o.title}のチャット`, reason: `${who}のチャットが分かりません。操縦席の担当の記録に session が無く、記録の Dispatch からも引けません。窓口に担当の記録を直すよう頼んでください` }
    const chat = owners.find((x) => x.session === o.session)
    if (!chat)
      return { how: `${o.title}のチャット`, reason: ownersStale ? 'Orca からチャットの一覧を読めません。少し待ってもう一度押してください' : `${who}のチャットが Orca にありません。閉じられたようです` }
    if (!chat.worktree || !rowOf(chat.worktree))
      return { how: `${o.title}のチャット`, reason: `${who}のチャットの居場所の worktree${chat.worktree ? `（${path.basename(chat.worktree)}）` : ' '}が Orca にありません。片付けられたようです` }
    return { worktree: chat.worktree, how: wsName(chat.worktree), tab: chat.title ?? agentTitle(o.title, '担当') }
  }

  /**
   * 私の番で、まだ話し中の印が無いときだけ記録する（取り消したあとにもう一度押したときも記録する）。印が付いてもカードは私の番に残る。
   * カードの相談はタブの handle を残し、別のタブで話し中なら（閉じて立て直した）新しいタブで記録し直す。
   */
  async function markTalk(ws: Ws, c: Cockpit, card: Card, rev: unknown): Promise<void> {
    const now = overlay(c, ws.files.log, [], liveTerminal).find((v) => v.card.id === card.id)
    if (now?.status !== 'mine' || (now.talking && !now.talking.terminal) || card.kind === 'report' || rev !== card.rev) return
    await recordTalk(ws, c, { root: ws.root, item_id: card.id, item_rev: card.rev, type: 'talk' })
  }
  /**
   * 開いた相談のタブは、種類や状態（報告・修正待ち・片付いた）に関わらず handle を残す（片付いたあとに残るタブを stale_consults で探すため）。
   * 同じタブの記録の重なりは追記のロックの中で省く。古い版で押したなら版の食い違いとして断る。
   */
  async function markConsult(ws: Ws, c: Cockpit, card: Card, rev: unknown, terminal: string): Promise<void> {
    if (typeof rev !== 'number') throw new HttpError(400, '版がありません')
    await recordTalk(ws, c, { root: ws.root, item_id: card.id, item_rev: rev, type: 'talk', terminal })
  }
  async function recordTalk(ws: Ws, c: Cockpit, input: OpInput): Promise<void> {
    const { log, added } = await appendOpOnce(ws.root, c, input)
    ws.files = { ...ws.files, log }
    // 同じ協議の記録が既にあれば追記は省かれる。省かれた呼び出しは合図を送らない。
    if (!added) return
    mine.add(`${ws.root}#${added.op_id}`)
    broadcast()
    void autoSignal(ws).then(broadcast, (e) => console.error(e))
  }

  const api: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
    async op(b) {
      const ws = knownWs(b.root)
      if (!OP_TYPES.includes(b.type as OpType) || typeof b.item_id !== 'string' || typeof b.item_rev !== 'number')
        throw new HttpError(400, '操作の形が違います')
      // 「これで決める」は質問のタブへの知らせと組なので、askdecide からだけ受ける。
      if (b.type === 'ask_decide') throw new HttpError(400, '「これで決める」は質問の欄から押してください')
      const input: OpInput = {
        root: ws.root, item_id: b.item_id, item_rev: b.item_rev, type: b.type as OpType,
        option_id: str(b.option_id), undo_of: typeof b.undo_of === 'number' ? b.undo_of : undefined,
        target: typeof b.target === 'number' ? b.target : undefined, text: typeof b.text === 'string' ? b.text : undefined
      }
      const log = await appendOp(ws.root, ws.files.cockpit, input)
      mine.add(`${ws.root}#${log.ops.at(-1)!.op_id}`)
      ws.files = { ...ws.files, log }
      broadcast()
      await autoSignal(ws)
      return { view: await cockpitView(ws.root, true) }
    },
    /** 担当と話す。担当の端末かチャットのワークスペースを Orca で前に出し、開けたらカードに話し中の印を付ける（私の番に残す）。 */
    async talk(b): Promise<TalkResult> {
      const ws = knownWs(b.root)
      const c = ws.files.cockpit
      // 全体のタブの「担当と話す」は仕事（stream）で頼む。カードが無いので話し中の印は付けない。
      const card: Card | undefined = typeof b.stream === 'string'
        ? (c?.streams.some((x) => x.id === b.stream) ? { id: '', rev: 0, kind: 'consult', state: 'open', title: '', stream: b.stream } : undefined)
        : c?.cards.find((x) => x.id === b.item_id)
      if (!c || !card) throw new HttpError(409, typeof b.stream === 'string' ? '仕事が見つかりません。読み直してからもう一度押してください' : 'カードが見つかりません。読み直してからもう一度押してください')
      // 読み直しの途中（lastRefresh は Dispatch を読む前に進む）なら終わりを待つ。チャットの担当は Dispatch から引くため。
      if (refreshing || Date.now() - lastRefresh > REFRESH_GAP_MS) await refreshOrca()
      // 担当のいない帳簿のカードは、カードの相談のタブを立てる（2 回目は consult が同じタブを前に出す）。
      // 全体のタブの仕事の協議（id の空の仮のカード）は相談に分けない（設計 10.7 の 7）。
      let note: string | undefined
      if (card.id && opts.consult && ownerFor(ws, c, card).how === 'main') {
        let handle: string | undefined
        try {
          handle = await opts.consult(ws.root, card.id)
        } catch (e) {
          note = `相談のタブを開けませんでした（${(e as Error).message}）`
        }
        if (handle) {
          // 立てたタブを端末の一覧に入れる（入るまでは協議中の印が外れて見える）。チャットは consult が開いたばかりなので開いているとして持つ。
          if (handle.startsWith(CHAT_HANDLE)) {
            closedChats.delete(handle)
            chats.add(handle)
          }
          await refreshOrca()
          // タブは開いたので、記録できなくても窓口には回さない（版が変わったなど。開いたタブはそのまま使える）。
          return markConsult(ws, c, card, b.item_rev, handle).then(
            () => ({ opened: true, how: '相談のタブ' }),
            (e: Error) => ({ opened: true, how: '相談のタブ', reason: e.message, terminal: handle })
          )
        }
      }
      const to = talkTarget(ws, c, card)
      // 開けないのに話し中の印を付けると、誰とも話していないのに話し中に見える。
      if ('reason' in to) return { opened: false, how: to.how, reason: to.reason, ...(note && { note }) }
      // 前に出せてから記録する（調べた直後に端末が閉じられても、話し中にだけ移らないように）。
      try {
        if ('terminal' in to) await orca.switchTerminal(to.terminal)
        else await orca.activate(to.worktree)
      } catch (e) {
        return { opened: false, how: to.how, reason: `Orca が前に出せませんでした: ${(e as Error).message}`, ...(note && { note }) }
      }
      await markTalk(ws, c, card, b.item_rev)
      return { opened: true, how: to.how, ...('worktree' in to && { tab: to.tab }), ...(note && { note }) }
    },
    /** 窓から質問する。新しい質問は id を採って consult --ask で質問のタブを立て、続きは同じ id で開いているタブに送る。 */
    async ask(b): Promise<AskResult> {
      const ws = knownWs(b.root)
      const c = ws.files.cockpit
      if (!c) throw new HttpError(409, '操縦席がありません')
      const question = str(b.question)?.trim() && escapeAskSections(str(b.question)!.trim())
      if (!question) throw new HttpError(400, '質問を書いてください')
      const bad = textError(question)
      if (bad) throw new HttpError(400, bad)
      const cont = str(b.ask)
      if (cont !== undefined && !(ASK_ID.test(cont) && ws.files.asks.some((a) => a.id === cont))) throw new HttpError(409, `質問 ${cont} が見つかりません。読み直してからもう一度押してください`)
      const card = cont ? undefined : str(b.card)
      const task = cont ? undefined : str(b.task)
      if (card && !c.cards.some((x) => x.id === card)) throw new HttpError(409, 'カードが見つかりません。読み直してからもう一度押してください')
      if (task && !c.tasks.some((x) => x.id === task)) throw new HttpError(409, 'タスクが見つかりません。読み直してからもう一度押してください')
      if (!opts.ask) return { opened: false, reason: '質問の道具（consult --ask）が渡されていません' }
      const run = (asking.get(ws.root) ?? Promise.resolve()).then(async (): Promise<AskResult> => {
        // 新しい質問は id を予約し、consult が控えの頭を書くまでほかのプロセスにも採らせない。
        const r = cont ? undefined : await reserveAskId(ws.root)
        const id = cont ?? r!.id
        try {
          // 続きは順番が来た時点の控えで、前の質問の答えが届いているかを見る（別の窓・開き直した窓から重ねて送らない）。
          if (cont && unanswered((await readAsks(ws.root)).find((a) => a.id === cont)?.entries ?? [])) return { opened: false, ask: cont, reason: '前の質問の答えを待っています。答えが届いてから続けて聞いてください' }
          await opts.ask!(ws.root, id, { card, task, question })
        } catch (e) {
          return { opened: false, ask: cont, reason: (e as Error).message }
        } finally {
          await r?.release()
        }
        // consult が書いた控えの頭をすぐ読み、窓の「答えを待っています」を質問に結ぶ（見張りの知らせを待たない）。
        await reload(ws)
        broadcast()
        return { opened: true, ask: id }
      })
      asking.set(ws.root, run.catch(() => undefined))
      return run
    },
    /** 質問の前に、判断の記録から有効な判断を語で引く。 */
    async asklookup(b): Promise<{ hits: RulingHit[] }> {
      const ws = knownWs(b.root)
      const q = str(b.q) ?? ''
      return { hits: matchRulings(ws.files.rulings, q).map((r) => ({ id: r.id, at: r.at, kind: r.kind, text: r.text!, quote: r.quote })) }
    },
    /** 「これで決める」。op を先に書き、そのあと質問のタブに「返しを書いて」を送る（タブが閉じていても op は残り、窓口が拾う）。 */
    async askdecide(b): Promise<AskDecideResult> {
      const ws = knownWs(b.root)
      const id = str(b.ask)
      const a = ws.files.asks.find((x) => x.id === id)
      if (!id || !a) throw new HttpError(409, '質問が見つかりません。読み直してからもう一度押してください')
      const ans = b.answer as { at?: unknown; head?: unknown; n?: unknown } | undefined
      const answer = { at: str(ans?.at) ?? '', head: str(ans?.head) ?? '', n: typeof ans?.n === 'number' ? ans.n : 0 }
      const { log, added } = await appendOpOnce(ws.root, ws.files.cockpit, { root: ws.root, item_id: askItem(id), item_rev: 0, type: 'ask_decide', answer })
      if (!added) {
        ws.files = { ...ws.files, log }
        broadcast()
        return { op: lastAskDecide(log, askItem(id), answer)?.op_id ?? 0, sent: false, again: true }
      }
      const op = added.op_id
      mine.add(`${ws.root}#${op}`)
      ws.files = { ...ws.files, log }
      broadcast()
      const tab = await askTab(ws, id).catch((e: Error) => ({ reason: `タブを探せませんでした: ${e.message}` }))
      if ('reason' in tab) return { op, sent: false, reason: tab.reason }
      try {
        await orca.send(tab.handle, askNotice(op))
        return { op, sent: true }
      } catch (e) {
        return { op, sent: false, reason: `写しの会話に送れませんでした: ${(e as Error).message}` }
      }
    },
    /** 質問のタブを前に出す。閉じていれば立て直さずに理由を返す（立て直すと窓口の会話をもう一度読み込むため、続きを聞いたときだけ立てる）。 */
    async asktab(b): Promise<OpenResult> {
      const ws = knownWs(b.root)
      const id = str(b.ask)
      if (!id || !ws.files.asks.some((x) => x.id === id)) throw new HttpError(409, '質問が見つかりません。読み直してからもう一度押してください')
      const tab = await askTab(ws, id)
      if ('reason' in tab) return { opened: false, reason: tab.reason }
      await orca.switchTerminal(tab.handle)
      return { opened: true }
    },
    async notify(b) {
      const ws = knownWs(b.root)
      const r = await notify(ws)
      ws.signal = r.sent ? undefined : { state: 'failed', reason: r.reason }
      broadcast()
      return r
    },
    async open(b): Promise<OpenResult> {
      const ws = knownWs(b.root)
      const href = str(b.path)
      if (!href) return { opened: false, reason: '開く先がありません' }
      const { file, line } = splitLine(href.startsWith('file://') ? fileURLToPath(href) : href)
      // 開けるのは、操縦席のある本線と、orca worktree ps で本線の子孫（担当とその worker）と分かる worktree の中のファイルだけ。
      const row = rowOf(ws.root)
      const roots = row ? descendants(ps, row).map((r) => r.path) : [ws.root]
      const real = await fsp.realpath(path.resolve(ws.root, file)).catch(() => '')
      if (!real) return { opened: false, reason: `ファイルが見つかりません: ${file}` }
      for (const root of roots) {
        const base = await fsp.realpath(root).catch(() => '')
        if (base && real.startsWith(base + path.sep)) {
          if (!(await fsp.stat(real)).isFile()) return { opened: false, reason: `ファイルではありません（フォルダ）: ${file}` }
          await orca.openFile(root, real, line)
          return { opened: true }
        }
      }
      return { opened: false, reason: `ワークスペースと、その担当・worker の worktree の外のファイルは開かない: ${file}` }
    },
    async clip(b): Promise<ClipResult> {
      if (typeof b.text !== 'string' || !isDraftFormat(b.format)) throw new HttpError(400, '本文か書式の形が違います')
      return (opts.clip ?? clipDraft)(b.text, b.format)
    },
    async openurl(b) {
      const url = str(b.url)
      let u: URL | undefined
      try {
        u = url ? new URL(url) : undefined
      } catch {
        u = undefined
      }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return { opened: false, reason: 'http と https の URL だけ開きます' }
      await orca.openUrl(u.href)
      return { opened: true }
    },
    async activate(b) {
      const root = str(b.root)
      if (!root || !rowOf(root)) throw new HttpError(409, 'Orca にないワークスペースです')
      await orca.activate(root)
      return { ok: true }
    },
    async focus(b): Promise<FocusResult> {
      const terminal = str(b.terminalId)
      if (liveTerminal(terminal)) {
        await orca.switchTerminal(terminal)
        return { focused: true, how: '端末' }
      }
      const wt = str(b.worktree)
      if (wt && rowOf(wt)) {
        await orca.activate(wt)
        return { focused: true, how: wsName(wt) }
      }
      return { focused: false }
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, type: string, text: string) => {
      res.writeHead(status, {
        'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
      })
      res.end(text)
    }
    const json = (status: number, v: unknown) => reply(status, 'application/json; charset=utf-8', JSON.stringify(v))
    // 名前を 127.0.0.1 に向けた別のサイト（DNS rebinding）からの要求を断る。
    if (!hosts().includes(req.headers.host ?? '')) return json(403, { error: 'host が違います' })
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (req.method === 'GET') {
      if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', page())
      if (url.pathname === '/favicon.ico') return reply(204, 'image/x-icon', '')
      const rel = url.pathname.slice(1)
      if (SERVED.has(rel)) return reply(200, 'text/javascript; charset=utf-8', await js(rel))
      if (url.pathname === '/events') {
        if (!tokenOk(url.searchParams.get('token'))) return json(403, { error: 'トークンが違います' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        req.socket.setTimeout(0)
        clients.add(res)
        req.on('close', () => {
          clients.delete(res)
          if (!clients.size) stopPolling()
        })
        res.write(`data: ${JSON.stringify(await windowView())}\n\n`)
        startPolling()
        return
      }
      return json(404, { error: 'ありません' })
    }

    const name = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : ''
    if (req.method !== 'POST' || !Object.hasOwn(api, name)) return json(404, { error: 'ありません' })
    if (!origins().includes(req.headers.origin ?? '')) return json(403, { error: 'origin が違います' })
    if (!tokenOk(req.headers['x-cockpit-token'])) return json(403, { error: 'トークンが違います' })
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'JSON で送ってください' })
    try {
      return json(200, await api[name]!(await body(req)))
    } catch (e) {
      const err = e as Error & { code?: string; status?: number }
      const status = err instanceof HttpError ? err.status : err.code === 'conflict' ? 409 : err.code === 'invalid_params' ? 400 : err instanceof SyntaxError ? 400 : 500
      if (status === 500) console.error(err)
      return json(status, { error: err.message })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })

  return {
    token,
    async listen(): Promise<number> {
      await fsp.mkdir(opts.dir, { recursive: true })
      // focus.json は rename で置き換わるので、ファイルではなく置き場所を見張る。
      focusWatcher = watch(opts.dir, (_ev, name) => {
        if (name === 'alerts.json') return void readAlerts()
        if (name !== 'focus.json') return
        clearTimeout(focusTimer)
        focusTimer = setTimeout(() => void readFocus(), 30)
      })
      // 見張れないとき（ファイルの見張りの上限など）も、常駐のプロセスは落とさず、前面の切り替えだけを止める。
      focusWatcher.on('error', (e) => console.error(`focus.json を見張れません: ${e.message}`))
      await readFocus()
      await readAlerts()
      for (const ws of wss.values()) void autoSignal(ws).catch((e) => console.error(e))
      await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve))
      port = (server.address() as { port: number }).port
      return port
    },
    async close(): Promise<void> {
      stopPolling()
      focusWatcher?.close()
      for (const t of [focusTimer, sendTimer, refreshTimer]) clearTimeout(t)
      for (const ws of wss.values()) {
        ws.watcher?.close()
        clearTimeout(ws.timer)
        clearTimeout(ws.signalTimer)
      }
      for (const res of clients) res.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

if (import.meta.main) {
  const dir = process.env.COCKPIT_DIR ?? path.join(os.homedir(), 'Library/Application Support/cockpit')
  const port = Number(process.env.COCKPIT_PORT ?? 47231)
  const cmd = process.env.COCKPIT_CONSULT_CMD ?? path.join(os.homedir(), '.config/nix-darwin/claude/bin/consult')
  const tailnetHosts = parseTailnetHosts(process.env.COCKPIT_TAILNET_HOSTS)
  const s = createServer({ port, dir, orca: orcaCli(process.env.COCKPIT_ORCA ?? 'orca'), consult: consultCli(cmd), ask: askCli(cmd), tailnetHosts })
  s.listen().then((p) => console.error(`cockpit window: http://127.0.0.1:${p}${tailnetHosts.map((h) => `  https://${h}`).join('')}`))
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void s.close().then(() => process.exit(0)))
}
