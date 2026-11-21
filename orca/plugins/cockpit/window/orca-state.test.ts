import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentDispatches, openQuestions, orcaAgents, pluginProblem, questionFacts, screenAsk, toolAsk, type PluginRow, type PsAgent, type PsRow, type TaskLink, type WorkerShow } from './orca-state.ts'

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
  // 窓（利用者向け）: 動いている開発用の読み込みと写しの古さは出さず、開発用の読み込みの停止・承認待ちは出す。
  assert.equal(pluginProblem([row({}), row({ isDev: true })], true), undefined)
  assert.equal(pluginProblem([row({ source: { reference: '/x', contentHash: 'old' }, folderHash: 'new' })], true), undefined)
  assert.equal(pluginProblem([row({}), row({ isDev: true, status: 'errored' })], true), 'Orca のプラグインが止まっている（errored）ため、Orca に合わせた切り替えが止まっています')
  assert.equal(pluginProblem([row({ isDev: true, status: 'pending' })], true), 'Orca のプラグインが承認待ちのため、Orca に合わせた切り替えが止まっています')
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

test('答えの無い orchestration の question だけを拾う（thread の返事・聞いた側のその後の送信・Run 宛てでないものは除く）', async () => {
  const { sampleInbox } = await import('../fixtures/demo.ts')
  const now = Date.parse('2026-11-22T01:00:00+09:00')
  const qs = openQuestions(sampleInbox(now))
  assert.deepEqual(qs.map((q) => q.id), ['msg_q1', 'msg_q2', 'msg_q4'])
  assert.deepEqual(qs[0], {
    id: 'msg_q1', run: 'run_aoba', from: 'dispatch:ctx_aoba_list', dispatch: 'ctx_aoba_list', at: now - 12 * 60_000,
    line: '一覧の既定の並びを、配送日の降順にしますか、登録順のままにしますか', text: '一覧の既定の並びを、配送日の降順にしますか、登録順のままにしますか', options: ['配送日の降順にする', '登録順のままにする']
  })
  // 担当が payload なしで送った問い（件名が題）。そのあと担当が別の知らせを送っていれば、答えを受けて動いたので拾わない。
  const fromLead = { id: 'm1', type: 'question', from_handle: 'structworker_x', to_handle: 'run:run_main', subject: '確認: 1 回だけ測ってよいか', body: '# 確認\n\n測り方の案…', created_at: '2026-11-21T14:14:47Z' }
  assert.deepEqual(openQuestions([fromLead]).map((q) => [q.line, q.dispatch]), [['確認: 1 回だけ測ってよいか', undefined]])
  assert.deepEqual(openQuestions([fromLead, { id: 'm2', type: 'status', from_handle: 'structworker_x', to_handle: 'run:run_main', created_at: '2026-11-21T14:16:02Z' }]), [])
  assert.deepEqual(openQuestions([{ ...fromLead, to_handle: 'dispatch:ctx_a' }]), [])
})

test('Orca の道具の欄から許可の問いを読み、AskUserQuestion は画面から読む。返事待ちに残った別の道具は許可と読まない', () => {
  assert.deepEqual(toolAsk({ state: 'blocked', toolName: 'Bash', toolInput: 'git push origin main' }), { kind: 'permit', text: 'Bash: git push origin main' })
  assert.equal(toolAsk({ state: 'waiting', toolName: 'AskUserQuestion', toolInput: null }), undefined)
  assert.equal(toolAsk({ state: 'waiting', toolName: 'Bash', toolInput: 'ls' }), undefined)
  assert.equal(toolAsk({ state: 'working', toolName: 'Bash', toolInput: 'ls' }), undefined)
})

test('端末の画面の末尾から、選択肢の付いた問いを読む（折り返しを繋ぎ、自由入力と相談の行は選択肢にしない）', async () => {
  const { ASK_SCREEN } = await import('../fixtures/demo.ts')
  assert.deepEqual(screenAsk(ASK_SCREEN), { kind: 'question', text: 'キャッシュを入れて直しますか、それとも原因の調査報告だけにしますか？', options: ['キャッシュを入れて直す', '調査報告だけにする'] })
  // Claude Code の許可の確認。英字の折り返しは空白で繋ぐ。
  const permit = [' Bash command', '', '   git push origin main', '', ' Do you want to', ' proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for git push", '   3. No, and tell Claude what to do differently (esc)']
  assert.deepEqual(screenAsk(permit, 'permit'), { kind: 'permit', text: 'Do you want to proceed?', options: ['Yes', "Yes, and don't ask again for git push", 'No, and tell Claude what to do differently'] })
  assert.equal(screenAsk(['❯ ', '  ctx 17%']), undefined)
  // 返事待ちの画面に残ったエージェントの箇条書き（選んでいる印が無い）は問いと読まない。
  assert.equal(screenAsk(['直したこと:', '1. 一覧の並び', '2. 絞り込み', '', '❯ ']), undefined)
})

test('question を案件に結ぶ: 窓口の Run 宛てと、案件の木の中の担当宛てだけ。終わった Dispatch の問いは除く', async () => {
  const { sampleInbox } = await import('../fixtures/demo.ts')
  const now = Date.parse('2026-11-22T01:00:00+09:00')
  const ps: PsRow[] = [
    { worktreeId: 'w-main', path: '/w/aoba', parentWorktreeId: null, agents: [] },
    { worktreeId: 'w-aws', path: '/w/aoba-aws', parentWorktreeId: 'w-main', agents: [] },
    { worktreeId: 'w-fig', path: '/w/aoba-aws-fig', parentWorktreeId: 'w-aws', displayName: '構成図', agents: [] }
  ]
  const c = {
    main: { run_id: 'run_aoba' }, cards: [], streams: [{ id: 's1', title: '配車画面の改修' }, { id: 's2', title: 'AWS 構成案' }],
    tasks: [{ id: 't1', stream: 's1', title: '一覧の並べ替えと絞り込み', state: 'run', worker: { task_id: 'x', dispatch_id: 'ctx_aoba_list' } }],
    owners: [{ id: 'o1', title: 'AWS 構成案', stream: 's2', session: 'sess-aws' }]
  } as unknown as Parameters<typeof questionFacts>[0]
  const live = (wt: string): WorkerShow => ({ projection: { stage: { worker: 'dispatched' }, liveness: { verdict: 'live' }, workspace: { id: `r::${wt}` } } })
  const shows: Record<string, WorkerShow> = { ctx_aws_fig: live('/w/aoba-aws-fig'), ctx_other: live('/elsewhere') }
  const owners = [{ session: 'sess-aws', kind: 'chat' as const, state: 'working' as const, worktree: '/w/aoba-aws' }]
  const facts = await questionFacts(c, '/w/aoba', ps, openQuestions(sampleInbox(now)), { ctx_aoba_list: { state: 'dispatched' } }, {}, owners, async (d) => shows[d] ?? null)
  assert.deepEqual(facts.map((q) => [q.id, q.to, q.task, q.stream, q.asker]), [['msg_q1', 'main', 't1', 's1', undefined], ['msg_q2', 'owner', undefined, 's2', '構成図']])
  // 聞いた worker が終わっていれば、もう答えを待っていない。
  const done = await questionFacts(c, '/w/aoba', ps, openQuestions(sampleInbox(now)), { ctx_aoba_list: { state: 'succeeded', settledAt: now } }, {}, owners, async (d) => shows[d] ?? null)
  assert.deepEqual(done.map((q) => q.id), ['msg_q2'])
})

test('question の持ち越しと閉じ方: 2 問目では 1 問目を消さない。300 通から外れても返事か別の送信まで残す。payload が null でも本文で読む', () => {
  const at = (m: number) => new Date(Date.parse('2026-11-22T00:00:00Z') + m * 60_000).toISOString()
  const q = (id: string, m: number) => ({ id, type: 'question', from_handle: 'structworker_x', to_handle: 'run:r', subject: `問い ${id}`, body: id, created_at: at(m) })
  assert.deepEqual(openQuestions([q('a', 0), q('b', 1)]).map((x) => x.id), ['a', 'b'])
  const carried = openQuestions([q('a', 0)])
  // a が新しい 300 通から外れた。返事も送信も無ければ残し、聞いた側が status を送ったら閉じる。
  assert.deepEqual(openQuestions([q('b', 1)], carried).map((x) => x.id), ['a', 'b'])
  assert.deepEqual(openQuestions([{ id: 's', type: 'status', from_handle: 'structworker_x', to_handle: 'run:r', created_at: at(2) }], carried), [])
  assert.deepEqual(openQuestions([{ ...q('n', 0), payload: 'null' }]).map((x) => x.text), ['n'])
})

test('端末で動く担当の worker の問いも、担当の仕事に結ぶ（端末の handle から担当の worktree を引く）', async () => {
  const ps: PsRow[] = [
    { worktreeId: 'w-main', path: '/w/main', parentWorktreeId: null, agents: [] },
    { worktreeId: 'w-lead', path: '/w/lead', parentWorktreeId: 'w-main', agents: [] },
    { worktreeId: 'w-kid', path: '/w/kid', parentWorktreeId: 'w-lead', agents: [] }
  ]
  const c = { main: { run_id: 'run_main' }, cards: [], tasks: [], streams: [{ id: 's9', title: '調査' }], owners: [{ id: 'o9', title: '調査', stream: 's9', terminal: 'term_lead' }] } as unknown as Parameters<typeof questionFacts>[0]
  const qs = openQuestions([{ id: 'q', type: 'question', from_handle: 'dispatch:ctx_kid', to_handle: 'run:run_lead', body: 'どちらにしますか', created_at: '2026-11-22T00:00:00Z', payload: JSON.stringify({ dispatchId: 'ctx_kid', question: 'どちらにしますか' }) }])
  const show = async (): Promise<WorkerShow> => ({ projection: { liveness: { verdict: 'live' }, workspace: { id: 'r::/w/kid' } } })
  const facts = await questionFacts(c, '/w/main', ps, qs, {}, {}, [], show, new Map([['term_lead', '/w/lead']]))
  assert.deepEqual(facts.map((f) => [f.to, f.stream]), [['owner', 's9']])
})
