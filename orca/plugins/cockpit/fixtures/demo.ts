// 見本のデータ（sample.ts）で窓を手元に立てる。Orca には繋がず、決まった応答を返す偽の Orca を使う。
// 使い方: COCKPIT_PORT=47299 node --disable-warning=ExperimentalWarning fixtures/demo.ts [置き場所]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type Orca, type PsRow } from '../window/server.ts'
import { sample, UNSEEN } from './sample.ts'

export function writeSample(base: string, now = Date.now()): { roots: Record<string, string>; orca: Orca; calls: string[][] } {
  const roots: Record<string, string> = {}
  const ws = sample(now)
  for (const w of ws) {
    const root = path.join(base, w.dir)
    mkdirSync(path.join(root, '.orca', 'cockpit', 'figures'), { recursive: true })
    writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(w.cockpit, null, 2))
    writeFileSync(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify(w.log, null, 2))
    if (w.figure) writeFileSync(path.join(root, '.orca', 'cockpit', 'figures', 'entry.svg'), w.figure)
    roots[w.dir] = root
  }
  for (const u of UNSEEN) mkdirSync((roots[u.dir] = path.join(base, u.dir)), { recursive: true })
  const at = (min: number) => now - min * 60_000
  const main = (dir: string) => ({ paneKey: `p:${dir}-main`, state: 'waiting' as const, agentType: 'claude', displayName: '窓口', stateStartedAt: at(5), hasLivePty: true })
  const rows: PsRow[] = [
    ...ws.map((w) => ({ worktreeId: `wt-${w.dir}`, path: roots[w.dir]!, parentWorktreeId: null, displayName: w.cockpit.workspace.name, agents: [main(w.dir)] })),
    { worktreeId: 'wt-aoba-list', path: path.join(base, 'aoba-list'), parentWorktreeId: 'wt-aoba', displayName: '配車画面の改修', agents: [{ paneKey: 'p:aoba-w1', state: 'working', agentType: 'claude', stateStartedAt: at(30), hasLivePty: true }] },
    { worktreeId: 'wt-h-log', path: path.join(base, 'h-log'), parentWorktreeId: 'wt-harness', displayName: 'ログ集計の見直し', agents: [{ paneKey: 'p:h-w1', state: 'blocked', agentType: 'claude', stateStartedAt: at(25), hasLivePty: true }] },
    { worktreeId: 'wt-konan-115', path: path.join(base, 'konan-115'), parentWorktreeId: 'wt-konan', displayName: 'No.115 stg の調査', agents: [{ paneKey: 'p:konan-w2', state: 'waiting', agentType: 'claude', stateStartedAt: at(180), hasLivePty: true }] },
    ...UNSEEN.map((u) => ({ worktreeId: `wt-${u.dir}`, path: roots[u.dir]!, parentWorktreeId: null, displayName: u.name, agents: [] }))
  ]
  const handles: Record<string, string> = { 'p:aoba-w1': 'term_aoba_w1', 'p:h-w1': 'term_h_w1', 'p:konan-w2': 'term_konan_w2' }
  for (const w of ws) handles[`p:${w.dir}-main`] = w.cockpit.main?.terminal || `term_${w.dir}_chat`
  const calls: string[][] = []
  const orca: Orca = {
    ps: async () => rows,
    terminals: async () => Object.entries(handles).map(([pane, handle]) => {
      const [tabId, leafId] = pane.split(':') as [string, string]
      return { handle, tabId, leafId }
    }),
    plugins: async () => [{ pluginKey: 'local.cockpit', status: 'running', needsReconsent: false, isDev: false }],
    agents: async () => [{ session: 'sess-aws', kind: 'chat', state: 'working', title: 'AWS 構成案（担当）', worktree: roots.aoba }],
    // 見本の worker の記録（sample.ts の tasks[].worker）の Dispatch。端末でタスクと結ぶ。
    show: async (dispatch) =>
      ({
        ctx_aoba_list: { projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' } }, terminal: { handle: 'term_aoba_w1' }, observation: { agentWait: null } },
        ctx_h_log: { projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' } }, terminal: { handle: 'term_h_w1' }, observation: { agentWait: { kind: 'permission' } } }
      })[dispatch] ?? null,
    send: async (t, text) => void calls.push(['send', t, text]),
    activate: async (root) => void calls.push(['activate', root]),
    switchTerminal: async (t) => void calls.push(['switch', t]),
    openFile: async (root, abs, line) => void calls.push(['open', root, abs, String(line ?? '')]),
    openUrl: async (url) => void calls.push(['url', url]),
    runTasks: async () => [],
    taskLink: async () => ({ dispatch: null, followUpOf: null })
  }
  return { roots, orca, calls }
}

if (import.meta.main) {
  const base = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'cockpit-demo-'))
  const dir = path.join(base, '.app')
  mkdirSync(dir, { recursive: true })
  const { roots, orca, calls } = writeSample(base)
  writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ path: roots.aoba, at: new Date().toISOString() }))
  const s = createServer({ port: Number(process.env.COCKPIT_PORT ?? 47299), dir, orca })
  s.listen().then((p) => console.error(`demo: http://127.0.0.1:${p}  （データ: ${base}）`))
  setInterval(() => calls.length && console.error(JSON.stringify(calls.splice(0))), 1000)
}
