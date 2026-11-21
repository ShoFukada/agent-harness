// 操縦席の判定済みの状態を JSON で出す入口。hook（periodic-reminder.sh）とメインが、窓と同じ判定（src/state.ts）で状態を読む。
// 使い方: node <このファイル> <ワークスペースの root>
import path from 'node:path'
import type { Cockpit } from '../src/model.ts'
import { report, type OrcaFacts, type StateReport } from '../src/state.ts'
import { emptyFiles, loadFiles } from '../src/store.ts'
import { currentDispatches, orcaAgents, orcaDispatches, pluginProblem, type Chain, type PluginRow, type PsRow, type WorkerShow } from './orca-state.ts'
import { orcaCli } from './server.ts'

/** worker の記録がある済んでいないタスクがあるときだけ Orca を呼ぶ（hook は発言のたびに走るので、要らない呼び出しを省く）。 */
export async function orcaFacts(root: string, c: Cockpit, ps: () => Promise<PsRow[]>, terminals: () => Promise<{ handle: string; leafId: string; tabId: string }[]>, show: (dispatch: string) => Promise<WorkerShow | null>, chain?: Chain): Promise<{ facts?: OrcaFacts; state: StateReport['orca'] }> {
  if (!c.tasks.some((t) => t.worker && t.state !== 'ok')) return { state: 'skipped' }
  try {
    const { current, status } = chain ? await currentDispatches(c, chain, new Map()) : { current: {}, status: {} }
    const [rows, terms, dispatches] = await Promise.all([ps(), terminals(), orcaDispatches(c, show, current, status)])
    const byPane = new Map<string, string>()
    for (const t of terms) byPane.set(`${t.tabId}:${t.leafId}`, t.handle)
    const { workers } = orcaAgents(root, rows, byPane, c, dispatches, current)
    return { facts: { workers, dispatches, current }, state: 'ok' }
  } catch {
    return { state: 'error' }
  }
}

export async function stateOf(root: string, orca = orcaCli(process.env.COCKPIT_ORCA ?? 'orca'), now = Date.now()): Promise<StateReport> {
  const files = await loadFiles(root, emptyFiles())
  if (!files.cockpit) throw new Error(files.errors[0] ?? `${root}/.orca/cockpit.json がありません`)
  // プラグインの状態は毎回見る（Orca に合わせた切り替えが止まったことを、メインが利用者に頼めるように）。読めなければ黙る。
  const [{ facts, state }, plugins] = await Promise.all([
    orcaFacts(root, files.cockpit, orca.ps, orca.terminals, orca.show, { tasks: orca.runTasks, link: orca.taskLink }),
    orca.plugins().catch((): PluginRow[] | undefined => undefined)
  ])
  return report(files.cockpit, files.log, files.archive, facts, state, now, plugins && pluginProblem(plugins), { utterances: files.utterances, firstSeen: files.firstSeen, rulings: files.rulings })
}

if (import.meta.main) {
  const [root] = process.argv.slice(2)
  if (!root) {
    console.error('使い方: node state.ts <ワークスペースの root>')
    process.exit(2)
  }
  stateOf(path.resolve(root)).then(
    (r) => console.log(JSON.stringify(r, null, 1)),
    (e: Error) => {
      console.error(e.message)
      process.exit(1)
    }
  )
}
