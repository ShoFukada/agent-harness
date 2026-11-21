// 話したいへのすぐの回答。窓の常駐のプロセスが、手元の `claude -p`（利用者のサブスクの CLI。従量課金の API ではない）を 1 回呼ぶ。
// 読むだけの道具（Read・Grep・Glob）に絞り、ファイルを変えない。判断・作業・変更が要る話は「メインに渡す」に回す。
import { spawn } from 'node:child_process'
import type { Cockpit, Op, Reply } from '../src/model.ts'

export const ASK_TIMEOUT_MS = 90_000
/** SIGTERM で終わらないとき、これだけ待って SIGKILL する。 */
export const KILL_GRACE_MS = 5_000
export const FAILED_TEXT = '回答できませんでした。メインが次に読みます'
const HANDOFF = '[メインに渡す]'

/** 回答を作る関数。テストでは差し替える。cwd はワークスペースの root。 */
export type Ask = (prompt: string, cwd: string) => Promise<string>

/** 項目（またはタスク）・関係するタスク・依頼・それまでのやり取りを渡す。図の SVG は長いので渡さない（パスだけ）。 */
export function buildPrompt(c: Cockpit, op: Op, ops: Op[], replies: Reply[]): string {
  const item = c.items.find((i) => i.id === op.item_id)
  const task = c.tasks.find((t) => t.id === op.item_id)
  const strip = <T extends object>(x: T) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'figure' && typeof v === 'string' && v.trimStart().startsWith('<') ? '（図）' : v)))
  const relatedIds = new Set([...(item?.related ?? []).map((r) => r.task), ...(task ? [task.id] : [])])
  const tasks = c.tasks.filter((t) => relatedIds.has(t.id))
  const reqs = (c.requests ?? []).filter((r) => r.id === item?.request || r.tasks?.some((t) => relatedIds.has(t)))
  const thread = ops
    .filter((o) => o.type === 'talk' && o.item_id === op.item_id && o.text && o.handoff_of === undefined && o.op_id <= op.op_id)
    .flatMap((o) => [
      `利用者（${o.at}）: ${o.text}`,
      ...replies.filter((r) => r.op_id === o.op_id).map((r) => `${r.by === 'main' ? 'メイン' : 'アシスタント'}: ${r.text}`)
    ])
  return [
    'あなたは「操縦席」の画面で利用者の質問に答えるアシスタントです。読むだけの道具（Read・Grep・Glob）しか使えず、ファイルの変更・コマンドの実行・判断の変更はできません。',
    '作業ディレクトリはこの案件のワークスペースです。下の項目の出どころ（source・sources・href）にあるファイルは読んで確かめてから答えてください。',
    '答え方: 日本語の丁寧語で、結論を先に 10 行以内。並びのある説明は改行と「- 」の箇条で書く。分からないことは分からないと書く。',
    `判断を変える・作業を頼む・ファイルを変える必要がある話なら、答えの最後の行に「${HANDOFF}」とだけ書いてください（利用者がメインのエージェントに渡せるボタンが出ます）。`,
    '',
    `## ${item ? '項目' : 'タスク'}`,
    JSON.stringify(strip(item ?? task ?? { id: op.item_id }), null, 1),
    tasks.length ? `## 関係するタスク\n${JSON.stringify(strip(tasks), null, 1)}` : '',
    reqs.length ? `## 依頼\n${JSON.stringify(reqs, null, 1)}` : '',
    `## やり取り（最後が今の質問）\n${thread.join('\n')}`
  ].filter(Boolean).join('\n')
}

/** 回答の最後の「[メインに渡す]」を外し、ボタンを出すかを返す。 */
export function parseAnswer(text: string): { text: string; handoff: boolean } {
  const t = text.trim()
  const handoff = t.endsWith(HANDOFF)
  return { text: handoff ? t.slice(0, -HANDOFF.length).trim() : t, handoff }
}

/**
 * 手元の claude CLI を 1 回呼ぶ。launchd の環境には CLAUDE_CONFIG_DIR と USER が無いことがあるので、プロセスの環境から渡す
 * （USER が無いと Keychain の認証を読めず「Not logged in」になる）。
 * 読むだけに保つため、道具を Read・Grep・Glob に絞り、hook を止める（disableAllHooks）。--setting-sources project だけでは
 * そのリポジトリの .claude/settings.json の hook が動き、ファイルを書けることを 2026-11-16 に確かめた。--bare は hook を止めるが
 * Keychain の認証を読まないので使えない。Orca が管理する plugin の hook は disableAllHooks でも動く。
 */
export const CLI_ARGS = [
  '-p', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence',
  '--setting-sources', 'project', '--settings', '{"disableAllHooks":true}', '--output-format', 'text'
]

export function claudeCli(bin = 'claude', timeoutMs = ASK_TIMEOUT_MS): Ask {
  return (prompt, cwd) =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        HOME: process.env.HOME, USER: process.env.USER ?? process.env.LOGNAME, LOGNAME: process.env.LOGNAME ?? process.env.USER,
        PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, LANG: process.env.LANG ?? 'ja_JP.UTF-8'
      }
      const child = spawn(bin, CLI_ARGS, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = ''
      let killer: NodeJS.Timeout | undefined
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      }, timeoutMs)
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
      child.on('error', (e) => {
        clearTimeout(timer)
        clearTimeout(killer)
        reject(e)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        clearTimeout(killer)
        if (code === 0 && out.trim()) resolve(out)
        else reject(new Error(signal ? `${Math.round(timeoutMs / 1000)} 秒で打ち切りました` : (err || out).trim().slice(0, 300) || `終了コード ${code}`))
      })
      child.stdin.end(prompt)
    })
}
