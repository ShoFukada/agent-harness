// 見本のデータ（sample.ts）で窓を手元に立てる。Orca には繋がず、決まった応答を返す偽の Orca を使う。
// 使い方: COCKPIT_PORT=47299 node --disable-warning=ExperimentalWarning fixtures/demo.ts [置き場所]
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { askTitle, createServer, type AskCmd, type Orca, type PsRow } from '../window/server.ts'
import type { InboxMessage } from '../window/orca-state.ts'
import { taskSig, type Task, type Wait } from '../src/model.ts'
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
  '      原因と直し方の見積もりを田中さんに出す',
  '   3. Type something.',
  '────────────────────────────────────────',
  '   4. Chat about this',
  '',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel'
]

/** 端末の許可の確認の画面（Claude Code が枠の中に道具・説明・コマンドの全文と、端末の選択肢を出す）。 */
export const PERMIT_SCREEN = [
  '⏺ 集計の分け方を直したので、ブランチを push します。',
  '  ⎿  $ git push origin feature/log-summary',
  '────────────────────────────────────────',
  ' Bash command',
  ' Push feature/log-summary to origin',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' git push origin feature/log-summary',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for git push commands in /w/harness",
  '   3. No',
  ' Esc to cancel · Tab to amend'
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
    q('msg_q2', 'ctx_aws_fig', 'run_aws', 45, '構成図は PowerPoint と draw.io のどちらで描きますか（田中さんが直すのは PowerPoint）', ['PowerPoint', 'draw.io']),
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
  aobaC.tasks.push({ id: 't5', stream: 's1', phase: '調査', title: '朝の地図の遅さの調査', state: 'open', next: '地図の読み込みを測って原因を絞る', worker: { task_id: 'task_aoba_map', dispatch_id: 'ctx_aoba_map' } })
  // 見張る仕事（R152）。青葉物流は Orca に Bot があり、ハーネスは Orca に無い automation を指す（「Orca に設定が無い」の見本）。
  aobaC.streams.push({ id: 's5', title: '管理表と Slack の見回り', form: 'watch', watch: { automation: 'auto-aoba', targets: ['青葉の管理表', 'Slack #aoba-dev'], to: '青葉物流の窓口' } })
  ws.find((w) => w.dir === 'harness')!.cockpit.streams.push({ id: 'h3', title: '朝の定期確認', form: 'watch', watch: { automation: 'auto-gone', targets: ['全案件の操縦席'], to: 'ハーネスの窓口' } })
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
  const answered = new Set<string>()
  const orca: Orca = {
    ps: async () => rows,
    terminals: async () => Object.entries(handles).map(([pane, handle]) => {
      const [tabId, leafId] = pane.split(':') as [string, string]
      return { handle, tabId, leafId }
    }),
    plugins: async () => [{ pluginKey: 'local.cockpit', status: 'running', needsReconsent: false, isDev: false }],
    automations: async () => [{ id: 'auto-aoba', name: '青葉の管理表・Slack 見回り', rrule: '0,30 9-19 * * *', timezone: 'Asia/Tokyo', enabled: true, nextRunAt: now + 20 * 60_000, lastRunAt: now - 10 * 60_000 }],
    automationRun: async (id) => (id === 'auto-aoba'
      ? { status: 'completed', at: now - 10 * 60_000, chat: 'orca_session_id:sess-bot', content: '新着は 2 件です（管理表 2 件・Slack 0 件）。返事が要るものはありません。\n\n- **管理表**: No.12（配車の締め時刻）・No.13（地図の表示）は担当に回しました' }
      : null),
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
    screen: async (terminal) => (answered.has(terminal) ? ['⏺ 答えを受けて続けます。', '❯ '] : terminal === 'term_aoba_w2' ? ASK_SCREEN : terminal === 'term_h_w1' ? PERMIT_SCREEN : []),
    send: async (t, text) => void calls.push(['send', t, text]),
    keys: async (t, text) => {
      calls.push(['keys', t, text])
      answered.add(t)
    },
    reply: async (from, id, body) => void calls.push(['reply', from, id, body]),
    sendTo: async (from, to, subject, body) => (calls.push(['sendTo', from, to, subject, body]), []),
    mailbox: async () => 'term_mailbox',
    activate: async (root) => void calls.push(['activate', root]),
    switchTerminal: async (t) => void calls.push(['switch', t]),
    openFile: async (root, abs, line) => void calls.push(['open', root, abs, String(line ?? '')]),
    openUrl: async (url) => void calls.push(['url', url]),
    runTasks: async () => [],
    taskLink: async () => ({ dispatch: null, followUpOf: null })
  }
  return { roots, orca, calls }
}

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5)

export function writeAskSample(root: string, now = Date.now()): void {
  const at = (min: number) => new Date(now - min * 60_000).toISOString()
  mkdirSync(path.join(root, '.orca', 'consult'), { recursive: true })
  writeFileSync(path.join(root, '.orca', 'cockpit', 'rulings.jsonl'), [
    { id: 'R31', at: at(900), kind: 'decision', text: '配車画面の一覧は、配送日の降順を既定の並びにする', quote: '一覧は配送日が新しい順でいい', dec: 'd12' },
    { id: 'R32', at: at(600), kind: 'constraint', text: '田中さんに送る文面は、送る前に深田さんが見る（送信前のカードにする）', quote: '先方に出すものは必ず見せて' },
    { id: 'R33', at: at(300), kind: 'decision', text: 'AWS 構成案の本番の図は、社内向けの入口を描き足さず本文で説明する', quote: '図はこのままでいい、本文で書いて', dec: 'd21' }
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  writeFileSync(path.join(root, '.orca', 'consult', 'ask-ask1.md'), `# ${askTitle('青葉物流 配車アプリ', 'ask1')}\n- 写した窓口の会話: s1（窓口の会話 ${hhmm(now - 40 * 60_000)} 時点）\n\n`
    + `### 質問 ${hhmm(now - 35 * 60_000)}（u-41）\n定例の前に、田中さんに先に送っておくべきものはある？\n\n`
    + `### 答え ${hhmm(now - 34 * 60_000)}\n窓口の会話 ${hhmm(now - 40 * 60_000)} 時点（それより後に決まったことは知らない）\n## 結論\n**2 つ**あります。どちらも定例の前日までに送ります。\n\n| 送るもの | 置き場所 | 状態 |\n|---|---|---|\n| 構成案 | Drive（[構成案](https://example.com/aws-plan)） | 本文は済、図の確認待ち |\n| 議事録の共有のお願い | 送信前のカード | 期限切れのまま |\n\n### 次の手\n1. 構成案の図を \`t2\` で直す\n2. 議事録のカードを送る\n\n`)
  writeFileSync(path.join(root, '.orca', 'consult', 'ask-ask1.returns.jsonl'), JSON.stringify({ return_id: 'ask1-1', rulings_seen: 'R33', decisions: [{ text: '構成案は定例の前日までに田中さんへ共有する', quote: 'じゃあ構成案は前日までに送っておいて', utterance: 'u-42' }], requests: [], open: [], affects: [], ask: 'ask1' }) + '\n')
  writeFileSync(path.join(root, '.orca', 'consult', 'ask-ask2.md'), `# ${askTitle('青葉物流 配車アプリ', 'ask2')}\n- カード: d21\n- 写した窓口の会話: s1（窓口の会話 ${hhmm(now - 20 * 60_000)} 時点）\n\n`
    + `### 質問 ${hhmm(now - 15 * 60_000)}（u-44）\n社内向けの入口を図に描かないと、田中さんは困る？\n\n`
    + `### 答え ${hhmm(now - 14 * 60_000)}\n窓口の会話 ${hhmm(now - 20 * 60_000)} 時点（それより後に決まったことは知らない）\n困らない見込みです。田中さんが図で確かめたいのは本番の経路だけで、社内向けの入口は運用の説明で足ります（11/19 の定例の発言）。\n\n【選べる案】\n- A: 図は今のまま、入口は本文で説明する（推し）\n- B: 社内向けの入口を図に描き足す\n- C: 定例で田中さんに聞いてから決める\n\n`)
  const memo = (id: string, bind: string, mins: number, body: string) =>
    writeFileSync(path.join(root, '.orca', 'consult', `ask-${id}.md`), `# ${askTitle('青葉物流 配車アプリ', id)}\n${bind}- 写した窓口の会話: s1（窓口の会話 ${hhmm(now - mins * 60_000)} 時点）\n\n${body}`)
  const head = (min: number) => `窓口の会話 ${hhmm(now - min * 60_000)} 時点（それより後に決まったことは知らない）`
  memo('ask3', '- タスク: t5\n', 10, `### 質問 ${hhmm(now - 8 * 60_000)}（u-46）\nキャッシュで直すか、調査報告だけにするか、どちらがいい？\n\n`
    + `### 答え ${hhmm(now - 7 * 60_000)}\n${head(10)}\n朝 8 時台だけ地図の読み込みに 10 秒かかります。原因は地図のタイルを毎回取りに行くことで、ほかの時間帯は 1 秒以内です。\n\n| 案 | すること | かかる日数 |\n|---|---|---|\n| A | 地図のタイルを 1 日分ためる | stg で 2 日 |\n| B | 原因と直し方の見積もりを田中さんに出す | 半日 |\n\n推しは A です。定例（11/25）の前に stg で見せられます。\n\n【選べる案】\n- A: 地図のタイルを 1 日分ためる（推し）\n- B: 原因と直し方の見積もりを田中さんに出す\n\n`)
  memo('ask4', '- 仕事: s2\n', 3, `### 質問 ${hhmm(now - 2 * 60_000)}（u-47）\n構成図に本番の入口を描くか、方針を相談したい\n\n`)
  memo('ask5', '- タスク: t1\n', 300, `### 質問 ${hhmm(now - 290 * 60_000)}（u-30）\n一覧の既定の並びは、配送日の降順でいい？\n\n### 答え ${hhmm(now - 289 * 60_000)}\n${head(300)}\n降順がよい見込みです。配車の担当は当日と翌日の便から見ます。\n\n【選べる案】\n- A: 配送日の降順（推し）\n- B: 登録順のまま\n\n`
    + `### 質問 ${hhmm(now - 288 * 60_000)}（u-31）\n案 A で。\n\n### 答え ${hhmm(now - 288 * 60_000)}\n${head(300)}\n配送日の降順で窓口に返します。\n\n`)
  writeFileSync(path.join(root, '.orca', 'consult', 'ask-ask5.returns.jsonl'), JSON.stringify({ return_id: 'ask5-1', op: 9001, rulings_seen: 'R31', decisions: [{ text: '一覧の既定の並びは配送日の降順', quote: '案 A で。', utterance: 'u-31' }], requests: [], open: [], affects: ['t1'], ask: 'ask5' }) + '\n')
  appendFileSync(path.join(root, '.orca', 'consult', 'ask-ask1.md'), `### 質問 ${hhmm(now - 33 * 60_000)}（u-42）\nじゃあ構成案は前日までに送っておいて\n\n### 答え ${hhmm(now - 33 * 60_000)}\n${head(40)}\n構成案は定例の前日までに田中さんへ共有する。\n返しの案を書いた（窓口が反映すると効く）。\n\n`)
  writeFileSync(path.join(root, '.orca', 'consult', 'ask-ask1.returns.jsonl'), JSON.stringify({ return_id: 'ask1-1', op: 9000, rulings_seen: 'R33', decisions: [{ text: '構成案は定例の前日までに田中さんへ共有する', quote: 'じゃあ構成案は前日までに送っておいて', utterance: 'u-42' }], requests: [], open: [], affects: [], ask: 'ask1' }) + '\n')
  const log = path.join(root, '.orca', 'cockpit.user.json')
  const ops = (JSON.parse(readFileSync(log, 'utf8')) as { ops: unknown[] }).ops
  const decide = (op: number, id: string, min: number, n: number, ansMin: number, how: object) =>
    ({ op_id: op, at: at(min), item_id: `#ask:${id}`, item_rev: 0, type: 'ask_decide', answer: { at: hhmm(now - ansMin * 60_000), head: '', n }, ...how })
  writeFileSync(log, JSON.stringify({ ops: [...ops, decide(9000, 'ask1', 33, 1, 34, { text: 'じゃあ構成案は前日までに送っておいて' }), decide(9001, 'ask5', 288, 1, 289, { choice: 'A' })] }, null, 2))
  // 一覧の時刻は控えと返しの記録を最後に書いた時刻なので、見本の時刻に合わせる。
  for (const [id, min] of [['ask1', 33], ['ask2', 14], ['ask3', 7], ['ask4', 2], ['ask5', 288]] as const)
    for (const f of [`ask-${id}.md`, `ask-${id}.returns.jsonl`]) {
      const p = path.join(root, '.orca', 'consult', f)
      if (existsSync(p)) utimesSync(p, new Date(now - min * 60_000), new Date(now - min * 60_000))
    }
}

/**
 * consult --ask の代わり。控えの頭を書き、2 秒後に質問、8 秒後に答えを控えに足す（hook が書く形。1 問目は 7.6 秒の担当の測定に合わせる）。
 */
export function demoAsk(): AskCmd {
  return async (root, id, o) => {
    const memo = path.join(root, '.orca', 'consult', `ask-${id}.md`)
    if (!existsSync(memo)) writeFileSync(memo, `# ${askTitle('青葉物流 配車アプリ', id)}\n${o.card ? `- カード: ${o.card}\n` : ''}${o.task ? `- タスク: ${o.task}\n` : ''}${o.stream ? `- 仕事: ${o.stream}\n` : ''}- 写した窓口の会話: s1（窓口の会話 ${hhmm(Date.now())} 時点）\n\n`)
    setTimeout(() => appendFileSync(memo, `### 質問 ${hhmm(Date.now())}（u-50）\n${o.question ?? ''}\n\n`), 2000)
    setTimeout(() => appendFileSync(memo, `### 答え ${hhmm(Date.now())}\n窓口の会話 ${hhmm(Date.now())} 時点（それより後に決まったことは知らない）\n見本の答えです。\n\n`), 8000)
    return `term_${id}`
  }
}

if (import.meta.main) {
  const base = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'cockpit-demo-'))
  const dir = path.join(base, '.app')
  mkdirSync(dir, { recursive: true })
  const { roots, orca, calls } = writeSample(base)
  writeAskSample(roots.aoba!)
  // 一緒に作る仕事の見本（R145）: AWS 構成案を一緒に作る仕事にし、担当がターンを終えて深田さんの返事を待っている形にする。
  // 試験（writeSample を使う）には入れない。止まった問いの行の数を変えないため。
  const file = path.join(roots.aoba!, '.orca', 'cockpit.json')
  const aoba = JSON.parse(readFileSync(file, 'utf8')) as { streams: { id: string; title: string; form?: string; summary?: string }[]; tasks: { id: string; wait?: Wait }[]; asks?: unknown[] }
  aoba.asks = [{ id: 'ask5', task: 't1', memo: '.orca/consult/ask-ask5.md', from_returns: ['ask5-1'] }]
  for (const [id, form] of [['s1', 'delegate'], ['s2', 'cowork']]) aoba.streams.find((x) => x.id === id)!.form = form
  // 長い題（追加 38・42。題が数文字で切れた・待ちの文に場所を取られて消えた）と、人でない待ちの見本。
  aoba.streams.find((x) => x.id === 's3')!.title = 'CrowdStrike の検知ルールの見直しと保守契約の更新に向けた事前の確認'
  aoba.tasks.find((x) => x.id === 't3')!.wait = { kind: 'person', who: '岩田さん', what: '日程案への返事と認証情報', since: new Date(Date.now() - 2 * 86_400_000).toISOString() }
  for (const [id, summary] of [['s1', '配車画面の一覧と地図の遅さを直し、stg で見てもらう'], ['s2', 'AWS の構成図と説明の本文を作り、定例で説明する']]) aoba.streams.find((x) => x.id === id)!.summary = summary
  // 状況の文（status、R188）の見本。s2 は上限に近い長さ（3 行に収まるかを見る）。s3・s4 は書いていない仕事の見本。
  const said: [string, string][] = [
    ['s1', '一覧の並べ替えは stg に出した。地図の遅さは原因を調べていて、直し方を深田さんに決めてもらうのを待っている。'],
    ['s2', '構成図の下書きは Drive に置いた。本番の入口を図に描き足すかを深田さんに決めてもらい、決まったら説明の本文を仕上げて、来週の定例の前日までに田中さんへ送る。費用の見積もりは本文の最後に付ける。']
  ]
  for (const [id, status] of said) (aoba.streams.find((x) => x.id === id) as { status?: string }).status = status
  // 確認日の見本（R142・R171・R204 の date の待ち）: 構成案の図は今日が確かめる日（要対応に 1 行）。t3 は岩田さんの返事待ち（上）。
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toLocaleDateString('sv-SE')
  aoba.tasks.find((x) => x.id === 't2')!.wait = { kind: 'date', on: day(0), what: '入口の描き方が決まったかを確かめる' }
  writeFileSync(file, JSON.stringify(aoba, null, 2))
  // 窓が t2 を昨日から見ている形にする（今日の 0:00 より前から動いていない）。
  writeFileSync(path.join(roots.aoba!, '.orca', 'cockpit', 'taskseen.json'), JSON.stringify({ t2: { sig: taskSig(aoba.tasks.find((x) => x.id === 't2') as Task), at: new Date(Date.now() - 86_400_000).toISOString() } }))
  orca.agents = async () => [{ session: 'sess-aws', kind: 'chat', state: 'done', title: '一緒に｜AWS 構成案', worktree: path.join(base, 'aoba-aws'), updatedAt: Date.now() - 4 * 60_000 }]
  orca.chatLast = async () => '構成案の下書きを Drive に置きました。本番の経路は図に、運用の説明は本文に分けています。\n\n定例では、費用の見積もりを先に説明しますか、それとも構成図から説明しますか？'
  orca.tabs = async (root) => (root === roots.aoba ? ['ask1', 'ask2', 'ask3', 'ask4', 'ask5'].map((id) => ({ title: askTitle('青葉物流 配車アプリ', id), handles: [`term_${id}`] })) : [])
  writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ path: roots.aoba, at: new Date().toISOString() }))
  const s = createServer({ port: Number(process.env.COCKPIT_PORT ?? 47299), dir, orca, ask: demoAsk() })
  s.listen().then((p) => console.error(`demo: http://127.0.0.1:${p}  （データ: ${base}）`))
  setInterval(() => calls.length && console.error(JSON.stringify(calls.splice(0))), 1000)
}
