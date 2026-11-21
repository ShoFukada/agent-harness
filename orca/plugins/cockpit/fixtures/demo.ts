// 見本のデータ（sample.ts）で窓を手元に立てる。Orca には繋がず、決まった応答を返す偽の Orca を使う。
// 使い方: COCKPIT_PORT=47299 node --disable-warning=ExperimentalWarning fixtures/demo.ts [置き場所]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type Orca, type PsRow } from '../window/server.ts'
import type { InboxMessage } from '../window/orca-state.ts'
import { sample, UNSEEN } from './sample.ts'

/**
 * Claude Code の AskUserQuestion の画面（terminal read --screen の末尾）。問いの文の下に「❯ 1. …」の選択肢が並び、
 * 最後に自由入力（Type something）と相談（Chat about this）の行が付く。
 */
export const ASK_SCREEN = [
  '⏺ 地図の遅さを測りました。朝 8 時台だけ 10 秒かかります。',
  '',
  '────────────────────────────────────────',
  ' ☐ 対応の範囲',
  '',
  ' キャッシュを入れて直しますか、それとも原因の調査報告だけに',
  ' しますか？',
  '',
  ' ❯ 1. キャッシュを入れて直す',
  '      地図のタイルを 1 日分ためる（stg で 2 日）',
  '   2. 調査報告だけにする',
  '      原因と直し方の見積もりを森さんに出す',
  '   3. Type something.',
  '────────────────────────────────────────',
  '   4. Chat about this',
  '',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel'
]

/**
 * orchestration inbox の見本。窓口宛て（12 分前）と担当宛て（45 分前）の答えの無い問い、答えの付いた問い、ほかの案件の問い。
 * 窓口の Run は run_aoba、AWS 構成案の担当の Run は run_aws。
 */
export function sampleInbox(now: number): InboxMessage[] {
  const at = (min: number) => new Date(now - min * 60_000).toISOString()
  const q = (id: string, dispatch: string, run: string, min: number, question: string, options: string[]): InboxMessage => ({
    id, type: 'question', from_handle: `dispatch:${dispatch}`, to_handle: `run:${run}`, subject: 'Question', body: question, thread_id: id, created_at: at(min),
    payload: JSON.stringify({ taskId: `task_${dispatch}`, dispatchId: dispatch, question, options })
  })
  return [
    q('msg_q1', 'ctx_aoba_list', 'run_aoba', 12, '一覧の既定の並びを、配送日の降順にしますか、登録順のままにしますか', ['配送日の降順にする', '登録順のままにする']),
    q('msg_q2', 'ctx_aws_fig', 'run_aws', 45, '構成図は PowerPoint と draw.io のどちらで描きますか（森さんが直すのは PowerPoint）', ['PowerPoint', 'draw.io']),
    q('msg_q3', 'ctx_aoba_list', 'run_aoba', 120, '絞り込みの地区は、営業所の区分でよいですか', []),
    { id: 'msg_r3', type: 'status', from_handle: 'run:run_aoba', to_handle: 'dispatch:ctx_aoba_list', thread_id: 'msg_q3', subject: 'Re: Question', body: '営業所の区分で', created_at: at(118) },
    q('msg_q4', 'ctx_other', 'run_other', 50, 'ほかの案件の問い', [])
  ]
}

export function writeSample(base: string, now = Date.now()): { roots: Record<string, string>; orca: Orca; calls: string[][] } {
  const roots: Record<string, string> = {}
  const ws = sample(now)
  // 青葉物流に、窓口の Run と、AskUserQuestion で止まった地図の調査の worker を足す（止まった問いの見本）。
  const aobaC = ws.find((w) => w.dir === 'aoba')!.cockpit
  aobaC.main = { ...aobaC.main, run_id: 'run_aoba' }
  aobaC.tasks.push({ id: 't5', stream: 's1', phase: '調査', title: '朝の地図の遅さの調査', state: 'run', next: '地図の読み込みを測って原因を絞る', worker: { task_id: 'task_aoba_map', dispatch_id: 'ctx_aoba_map' } })
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
    { worktreeId: 'wt-aoba-map', path: path.join(base, 'aoba-map'), parentWorktreeId: 'wt-aoba', displayName: '地図の調査', agents: [{ paneKey: 'p:aoba-w2', state: 'waiting', agentType: 'claude', stateStartedAt: at(8), hasLivePty: true, toolName: 'AskUserQuestion', toolInput: null }] },
    // AWS 構成案の担当（チャット）と、その担当が立てた構成図の worker（orchestration ask で担当に聞いて待っている）。
    { worktreeId: 'wt-aoba-aws', path: path.join(base, 'aoba-aws'), parentWorktreeId: 'wt-aoba', displayName: 'AWS 構成案', agents: [{ paneKey: 'structured-agent-session-sess-aws', state: 'working', agentType: 'claude', stateStartedAt: at(60), hasLivePty: true, orcaSessionId: 'sess-aws' }] },
    { worktreeId: 'wt-aoba-aws-fig', path: path.join(base, 'aoba-aws-fig'), parentWorktreeId: 'wt-aoba-aws', displayName: '構成図', agents: [{ paneKey: 'p:aoba-aws-w1', state: 'working', agentType: 'claude', stateStartedAt: at(50), hasLivePty: true, toolName: 'Bash', toolInput: 'orca orchestration ask --question "構成図は…"' }] },
    { worktreeId: 'wt-h-log', path: path.join(base, 'h-log'), parentWorktreeId: 'wt-harness', displayName: 'ログ集計の見直し', agents: [{ paneKey: 'p:h-w1', state: 'blocked', agentType: 'claude', stateStartedAt: at(25), hasLivePty: true, toolName: 'Bash', toolInput: 'git push origin feature/log-summary' }] },
    { worktreeId: 'wt-konan-115', path: path.join(base, 'konan-115'), parentWorktreeId: 'wt-konan', displayName: 'No.115 stg の調査', agents: [{ paneKey: 'p:konan-w2', state: 'waiting', agentType: 'claude', stateStartedAt: at(180), hasLivePty: true }] },
    ...UNSEEN.map((u) => ({ worktreeId: `wt-${u.dir}`, path: roots[u.dir]!, parentWorktreeId: null, displayName: u.name, agents: [] }))
  ]
  const handles: Record<string, string> = { 'p:aoba-w1': 'term_aoba_w1', 'p:aoba-w2': 'term_aoba_w2', 'p:aoba-aws-w1': 'term_aoba_aws_w1', 'p:h-w1': 'term_h_w1', 'p:konan-w2': 'term_konan_w2' }
  for (const w of ws) handles[`p:${w.dir}-main`] = w.cockpit.main?.terminal || `term_${w.dir}_chat`
  const calls: string[][] = []
  const orca: Orca = {
    ps: async () => rows,
    terminals: async () => Object.entries(handles).map(([pane, handle]) => {
      const [tabId, leafId] = pane.split(':') as [string, string]
      return { handle, tabId, leafId }
    }),
    plugins: async () => [{ pluginKey: 'local.cockpit', status: 'running', needsReconsent: false, isDev: false }],
    agents: async () => [{ session: 'sess-aws', kind: 'chat', state: 'working', title: 'AWS 構成案（担当）', worktree: path.join(base, 'aoba-aws') }],
    // 見本の worker の記録（sample.ts の tasks[].worker）の Dispatch。端末でタスクと結ぶ。
    show: async (dispatch) =>
      ({
        ctx_aoba_list: { projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' } }, terminal: { handle: 'term_aoba_w1' }, observation: { agentWait: null } },
        ctx_h_log: { projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' } }, terminal: { handle: 'term_h_w1' }, observation: { agentWait: { kind: 'permission' } } },
        ctx_aoba_map: { projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' }, workspace: { id: `repo::${path.join(base, 'aoba-map')}` } }, terminal: { handle: 'term_aoba_w2' }, observation: { agentWait: null } },
        ctx_aws_fig: { projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' }, workspace: { id: `repo::${path.join(base, 'aoba-aws-fig')}` } }, terminal: { handle: 'term_aoba_aws_w1' }, observation: { agentWait: null } },
        ctx_other: { projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' }, workspace: { id: 'repo::/elsewhere/other-w1' } }, terminal: { handle: 'term_other' }, observation: { agentWait: null } }
      })[dispatch] ?? null,
    inbox: async () => sampleInbox(now),
    screen: async (terminal) => (terminal === 'term_aoba_w2' ? ASK_SCREEN : []),
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
