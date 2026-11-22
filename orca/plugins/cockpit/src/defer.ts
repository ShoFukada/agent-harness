// 待っているタスクの文に、都合での先送り（「落ち着いてから」「12 月に進める」など）が無いかを、defer-guard.py で検査する（R193）。
// 言い回しの判定は defer-guard.py だけが持ち、書く道具はこれを呼ぶだけにする。
import os from 'node:os'
import path from 'node:path'
import { runBin } from './clip.ts'

/** key はタスクの id と欄（t12.next）。 */
export type DeferItem = { key: string; text: string }
/** hit は当たった言い回し（前後を少し付けたもの）。error は検査できなかった理由（呼ぶ側は通さない）。 */
export type DeferCheck = { hit?: string; error?: string }
export type DeferOpts = { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export const deferBin = (o: DeferOpts = {}) => o.bin ?? (o.env ?? process.env).COCKPIT_DEFER_GUARD ?? path.join(os.homedir(), '.claude/hooks/defer-guard.py')

/**
 * 文ごとに `defer-guard.py --text` を呼ぶ。終わりのコードが 0 なら当たり無し、1 なら標準出力が当たり。
 * 無い・起動できない・期限切れ・ほかのコードは error にする（fail closed）。同じ文は 1 回だけ呼ぶ。
 */
export async function checkDefer(items: DeferItem[], o: DeferOpts = {}): Promise<Record<string, DeferCheck>> {
  const bin = deferBin(o)
  const texts = [...new Set(items.map((x) => x.text))]
  const results = new Map(await Promise.all(texts.map(async (text): Promise<[string, DeferCheck]> => {
    const out = await runBin(bin, ['--text', text], { env: o.env, timeoutMs: o.timeoutMs ?? 10_000 })
    if (out.timedOut) return [text, { error: `先送りの検査（${bin}）が時間内に終わらない` }]
    if (out.error) return [text, { error: `先送りの検査（${bin}）を起動できない: ${out.error.message}` }]
    if (out.code === 0) return [text, {}]
    if (out.code === 1 && out.stdout.trim()) return [text, { hit: out.stdout.trim().split('\n')[0]! }]
    return [text, { error: `先送りの検査（${bin}）が ${out.code} で終わった: ${(out.stderr.trim().split('\n')[0] ?? '').slice(0, 200)}` }]
  })))
  return Object.fromEntries(items.map((x) => [x.key, results.get(x.text)!]))
}
