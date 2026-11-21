import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orcaAgents, pluginProblem, type PluginRow, type PsAgent, type PsRow } from './orca-state.ts'

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
