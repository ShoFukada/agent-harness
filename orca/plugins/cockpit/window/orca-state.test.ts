import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentDispatches, orcaAgents, pluginProblem, type PluginRow, type PsAgent, type PsRow, type TaskLink } from './orca-state.ts'

const row = (o: Partial<PluginRow>): PluginRow => ({ pluginKey: 'local.cockpit', status: 'running', needsReconsent: false, isDev: false, ...o })

test('操縦席のプラグインが承認待ち・止まっている・無い・開発用に置き換わっているときだけ、切り替えが止まる理由を出す', () => {
  assert.equal(pluginProblem([row({}), row({ pluginKey: 'other', status: 'invalid' })]), undefined)
  assert.equal(pluginProblem([row({ status: 'idle' })]), undefined)
  assert.equal(pluginProblem([row({ status: 'pending', needsReconsent: true })]), 'Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています')
  assert.equal(pluginProblem([row({ needsReconsent: true })]), 'Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています')
  assert.equal(pluginProblem([row({ status: 'errored' })]), 'Orca のプラグインが止まっている（errored）ため、Orca に合わせた切り替えが止まっています')
  // Orca は入れた時点の写しを動かすので、フォルダの中身と hash が違えば入れ直しを促す
  assert.match(pluginProblem([row({ source: { reference: '/x', contentHash: 'old' }, folderHash: 'new' })]) ?? '', /古い写しのまま.*orca plugin update local\.cockpit/)
  assert.equal(pluginProblem([row({ source: { reference: '/x', contentHash: 'same' }, folderHash: 'same' })]), undefined)
  assert.equal(pluginProblem([row({ source: { reference: '/x', contentHash: 'old' }, folderHash: null })]), undefined)
  assert.equal(pluginProblem([]), 'Orca に操縦席のプラグインが入っていないため、Orca に合わせた切り替えが止まっています')
  assert.match(pluginProblem([row({}), row({ isDev: true, source: { reference: '/w/cockpit-window/orca/plugins/cockpit' } })])!, /開発用の読み込み（\/w\/cockpit-window\/orca\/plugins\/cockpit）に置き換わっています/)
})

const agent = (paneKey: string, over: Partial<PsAgent> = {}): PsAgent => ({ paneKey, state: 'working', stateStartedAt: 1, hasLivePty: true, ...over })

test('窓口の子の担当と、担当の子（窓口の孫）の worker を拾い、ほかの木の worker は拾わない', () => {
  const ps: PsRow[] = [
    { worktreeId: 'r::main', path: '/w/main', parentWorktreeId: null, agents: [agent('t:main')] },
    { worktreeId: 'r::lead', path: '/w/lead', parentWorktreeId: 'r::main', agents: [agent('t:lead')] },
    { worktreeId: 'r::w1', path: '/w/w1', parentWorktreeId: 'r::lead', agents: [agent('t:w1', { state: 'blocked' })] },
    { worktreeId: 'r::other', path: '/w/other', parentWorktreeId: null, agents: [agent('t:o')] },
    { worktreeId: 'r::ow', path: '/w/ow', parentWorktreeId: 'r::other', agents: [agent('t:ow')] }
  ]
  const { main, workers } = orcaAgents('/w/main', ps, new Map(), undefined)
  assert.equal(main?.worktree, '/w/main')
  assert.deepEqual(workers.map((w) => w.worktree), ['/w/lead', '/w/w1'])
})

test('今の Dispatch: Run のタスクの Dispatch を follow_up_of でつなぎ、最初の Task から最後の続きまでたどる。follow_up_of は覚えて問い合わせ直さない', async () => {
  const c = {
    version: 2, workspace: { name: 'x' }, streams: [], cards: [],
    tasks: [
      { id: 't1', stream: 's', phase: '実装', title: 'a', state: 'run', worker: { run_id: 'run_1', task_id: 'task_a' } },
      { id: 't2', stream: 's', phase: '実装', title: 'b', state: 'run', worker: { run_id: 'run_1', task_id: 'task_x' } },
      { id: 't3', stream: 's', phase: '実装', title: 'c', state: 'ok', worker: { run_id: 'run_2', task_id: 'task_z' } }
    ]
  } as const
  const linkOf: Record<string, TaskLink> = {
    task_a: { dispatch: 'ctx_a', followUpOf: null },
    task_b: { dispatch: 'ctx_b', followUpOf: 'ctx_a' },
    task_c: { dispatch: 'ctx_c', followUpOf: 'ctx_b' },
    task_x: { dispatch: 'ctx_x', followUpOf: null },
    task_new: { dispatch: null, followUpOf: null }
  }
  const asked: string[] = []
  const chain = {
    tasks: async (run: string) => {
      asked.push(run)
      return ['task_a', 'task_b', 'task_c', 'task_x', 'task_new'].map((id) => ({ id, status: id === 'task_c' ? 'completed' : 'dispatched' }))
    },
    link: async (task: string) => {
      asked.push(task)
      return linkOf[task]!
    }
  }
  const cache = new Map<string, TaskLink>()
  const r = await currentDispatches(c as never, chain, cache)
  assert.deepEqual(r.current, { t1: 'ctx_c', t2: 'ctx_x' })
  assert.equal(r.status.ctx_c, 'completed')
  assert.deepEqual(asked, ['run_1', 'task_a', 'task_b', 'task_c', 'task_x', 'task_new'], '済んだタスクの Run は問い合わせない')
  asked.length = 0
  await currentDispatches(c as never, chain, cache)
  assert.deepEqual(asked, ['run_1', 'task_new'], 'Dispatch のまだ無いタスクだけ問い合わせ直す')
})
