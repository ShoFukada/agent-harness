// 操縦席の判定済みの状態を JSON で出す入口。hook（periodic-reminder.sh）とメインが、窓と同じ判定（src/state.ts）で状態を読む。
// 使い方: node <このファイル> <ワークスペースの root> [--files]（--files は Orca を読まない）
import path from 'node:path'
import type { Cockpit } from '../src/model.ts'
import type { OwnerLive } from '../src/protocol.ts'
import { coworkIdle, report, type OrcaFacts, type StateReport } from '../src/state.ts'
import { emptyFiles, loadFiles, type Files } from '../src/store.ts'
import { CHAT_HANDLE, chatHandles, coordinating, currentDispatches, readRuns, failuresOf, liveChats, orcaAgents, orcaDispatches, pluginProblem, type Chain, type Failure, type PluginRow, type PsRow, type RunPage, type RunWorker, type WorkerShow } from './orca-state.ts'
import { orcaCli, TERMINAL_LIMIT } from './server.ts'

/**
 * Dispatch の問い合わせは worker の記録がある済んでいないタスクがあるときだけにする（hook は発言のたびに走るので、要らない呼び出しを省く）。
 * worktree ps と端末の一覧は毎回読む（担当のチャットだけが止まった案件でも、窓と同じ詰まりを出すため）。
 */
export async function orcaFacts(root: string, c: Cockpit, ps: () => Promise<PsRow[]>, terminals: () => Promise<{ handle: string; leafId: string; tabId: string }[]>, show: (dispatch: string) => Promise<WorkerShow | null>, chain?: Chain, failures?: () => Promise<Record<string, Failure>>, chats?: { handles: string[]; open?: (handle: string) => Promise<boolean> }, ownersOf?: () => Promise<OwnerLive[]>, runs?: { list: (cursor?: string) => Promise<RunPage>; workers: (run: string) => Promise<RunWorker[]>; last?: (handle: string) => Promise<string | null> }): Promise<{ facts?: OrcaFacts; state: StateReport['orca'] }> {
  const workers = c.tasks.some((t) => t.worker && t.state !== 'ok')
  try {
    const { current, status } = chain && workers ? await currentDispatches(c, chain, new Map()) : { current: {}, status: {} }
    // 担当のチャットの様子（agent list）は窓と同じく読み、読めなければ無いまま渡す（放置の判定がチャットの担当のタスクを保留する）。
    const [rows, terms, dispatches, live, owners] = await Promise.all([ps(), terminals(), workers ? orcaDispatches(c, show, current, status) : {}, liveChats(chats?.handles ?? [], chats?.open), ownersOf?.().catch(() => undefined)])
    const byPane = new Map<string, string>()
    for (const t of terms) byPane.set(`${t.tabId}:${t.leafId}`, t.handle)
    // 失敗の理由（利用枠・ログイン切れ）は inbox にしかないので、失敗で止まったエージェントがいるときだけ読む（窓と同じ）。
    const fails = failures && rows.some((r) => r.agents.some((a) => a.mainAgent?.outcome === 'failure')) ? await failures().catch(() => ({})) : {}
    const agents = orcaAgents(root, rows, byPane, c, dispatches, current, fails).workers
    const facts: OrcaFacts = { workers: agents, dispatches, current, owners, terminals: [...terms.map((t) => t.handle), ...live], terminalsPartial: terms.length >= TERMINAL_LIMIT }
    // 一緒に作る仕事の担当が worker を待っているか（窓と同じ）。作業中でない担当がいるときだけ読み、読めなければ分からないまま渡す。
    const idle = runs ? coworkIdle(c, facts) : []
    if (runs && idle.length) {
      const cache = new Map<string, string | null>()
      facts.coordinating = await readRuns(runs.list, cache).then(() => coordinating(idle, cache, runs.workers, c.main?.run_id), () => undefined)
      // worker を待つ担当でも最後の段落が問いなら返事待ちにするので、その担当の最後の返事だけ読む（窓は全部の担当の分を読んでいる）。
      const asking = new Set(idle.filter((o) => o.session && facts.coordinating?.[o.id]?.length).map((o) => o.session!))
      if (runs.last && asking.size && owners)
        facts.owners = await Promise.all(owners.map(async (a) => {
          if (!asking.has(a.session) || a.state !== 'done') return a
          const last = await runs.last!(`${CHAT_HANDLE}${a.session}`).catch(() => null)
          return last ? { ...a, last } : a
        }))
    }
    return { facts, state: 'ok' }
  } catch {
    return { state: 'error' }
  }
}

export async function stateOf(root: string, orca = orcaCli(process.env.COCKPIT_ORCA ?? 'orca'), now = Date.now()): Promise<StateReport> {
  const files = await loadFiles(root, emptyFiles())
  if (!files.cockpit) throw new Error(files.errors[0] ?? `${root}/.orca/cockpit.json がありません`)
  // プラグインの状態は毎回見る（Orca に合わせた切り替えが止まったことを、メインが利用者に頼めるように）。読めなければ黙る。
  const [{ facts, state }, plugins] = await Promise.all([
    orcaFacts(root, files.cockpit, orca.ps, orca.terminals, orca.show, { tasks: orca.runTasks, link: orca.taskLink }, orca.inbox && (async () => failuresOf(await orca.inbox!())), { handles: chatHandles(files.log.ops), open: orca.chatOpen }, orca.agents, orca.runs && orca.runWorkers && { list: orca.runs, workers: orca.runWorkers, last: orca.chatLast }),
    orca.plugins().catch((): PluginRow[] | undefined => undefined)
  ])
  // 見張る仕事の automation が Orca にあるか（checks.watch_unknown）。読めなければ確かめない。
  if (facts && orca.automations && files.cockpit.streams.some((x) => x.form === 'watch' && x.watch))
    facts.automations = await orca.automations().then((xs) => xs.map(({ id, name }) => ({ id, name })), () => undefined)
  return report(files.cockpit, files.log, files.archive, facts, state, now, plugins && pluginProblem(plugins), fileOpts(files, root))
}

/**
 * Orca を読まず、.orca のファイルだけで判定する（orca は 'skipped'）。Orca の問い合わせは実際の案件で 3 秒ほどかかるので、
 * ファイルだけで決まる検査（checks.unreflected_returns）を読む道具（compaction-keep.py unreflected）はこちらを使う。Orca の事実に依る欄は当てにしない。
 */
export async function filesStateOf(root: string, now = Date.now()): Promise<StateReport> {
  const files = await loadFiles(root, emptyFiles())
  if (!files.cockpit) throw new Error(files.errors[0] ?? `${root}/.orca/cockpit.json がありません`)
  return report(files.cockpit, files.log, files.archive, undefined, 'skipped', now, undefined, fileOpts(files, root))
}

const fileOpts = (files: Files, root: string) => ({ utterances: files.utterances, notices: files.notices, firstSeen: files.firstSeen, taskSeen: files.taskSeen, rulings: files.rulings, consults: files.consults, marks: files.marks, asks: files.asks, askMarks: files.askMarks, root })

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = args.find((a) => a !== '--files')
  if (!root) {
    console.error('使い方: node state.ts <ワークスペースの root> [--files]')
    process.exit(2)
  }
  ;(args.includes('--files') ? filesStateOf : stateOf)(path.resolve(root)).then(
    (r) => console.log(JSON.stringify(r, null, 1)),
    (e: Error) => {
      console.error(e.message)
      process.exit(1)
    }
  )
}
