// 送る文面が宛先の書式に合うかを、dev-standards の draft-format-lint で検査する。決まり（規則と直し方）は dev-standards だけが持ち、
// 操縦席は出口（書く道具・窓とパネルのコピー）でこれを呼ぶだけにする（R161・R162）。
import os from 'node:os'
import path from 'node:path'
import { runBin } from './clip.ts'
import { draftFormat, type Card, type DraftCheck, type DraftFormat, type LintViolation } from './model.ts'

export type LintItem = { id: string; to: DraftFormat; text: string }
export type LintOpts = { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export const lintBin = (o: LintOpts = {}) =>
  o.bin ?? (o.env ?? process.env).COCKPIT_DRAFT_LINT ?? path.join(os.homedir(), '.claude/plugins/marketplaces/medurance-dev-standards/scripts/draft-format-lint')

const isViolation = (v: unknown): v is LintViolation & { id: string } => {
  const x = v as Record<string, unknown>
  return typeof x === 'object' && x !== null && typeof x.id === 'string' && Number.isInteger(x.line) && typeof x.rule === 'string' && typeof x.text === 'string' && typeof x.fix === 'string'
}

/**
 * 文面をまとめて 1 回で検査し、id ごとの結果を返す。CLI が無い・起動できない・期限切れ・終了コードが 0 と 1 以外・出力が読めないときは、
 * 全部の id を error にする（呼ぶ側は error を通さない。fail closed）。
 */
export async function checkDrafts(items: LintItem[], o: LintOpts = {}): Promise<Record<string, DraftCheck>> {
  if (!items.length) return {}
  const bin = lintBin(o)
  const out = await runBin(bin, ['--json'], { env: o.env, timeoutMs: o.timeoutMs ?? 10_000, input: JSON.stringify(items) })
  let error: string | undefined
  let found: (LintViolation & { id: string })[] = []
  if (out.timedOut) error = `書式の検査（${bin}）が時間内に終わらない`
  else if (out.error) error = `書式の検査（${bin}）を起動できない: ${out.error.message}`
  else if (out.code !== 0 && out.code !== 1) error = `書式の検査（${bin}）が ${out.code} で終わった: ${out.stderr.trim().split('\n')[0] ?? ''}`
  else {
    try {
      const v: unknown = JSON.parse(out.stdout)
      if (!Array.isArray(v) || !v.every(isViolation) || (out.code === 1) !== v.length > 0) throw new Error('違反の一覧の形が違う')
      // 渡していない id の違反は、どの文面のものか分からない（取りこぼすと違反のある文面を通す）。
      const ids = new Set(items.map((x) => x.id))
      if (v.some((x) => !ids.has(x.id))) throw new Error('渡していない id の違反がある')
      found = v
    } catch (e) {
      error = `書式の検査（${bin}）の出力を読めない: ${(e as Error).message}`
    }
  }
  return Object.fromEntries(items.map((x) => [x.id, error !== undefined ? { format: x.to, error: error.slice(0, 300) }
    : { format: x.to, violations: found.filter((v) => v.id === x.id).map(({ id: _, ...v }) => v) }]))
}

/** 窓・パネルで検査するカード: 閉じていない、宛先の書式の決まる文面のあるもの。見てのボタンもカードの書式で検査する。 */
export const lintTargets = (cards: Card[]): LintItem[] =>
  cards.flatMap((c) => {
    const f = c.state !== 'done' && c.draft && typeof c.draft.text === 'string' ? draftFormat(c.draft) : undefined
    return f ? [{ id: c.id, to: f, text: c.draft!.text }] : []
  })

/**
 * 窓・パネルの状態を作るたびに使う検査。結果は書式と本文の組みで覚え、同じ文面には CLI を呼び直さない。
 * 検査できなかった結果は 1 分だけ覚える（CLI が無いあいだ状態を作るたびに起こさない。入れたら 1 分で効く）。
 * 呼んだその場で文面を取り出すので、await の前の帳簿の文面を検査する。
 */
export function draftLinter(o: LintOpts = {}, now = () => Date.now()) {
  type Entry = { p: Promise<DraftCheck>; failedAt?: number }
  const memo = new Map<string, Entry>()
  return async (cards: Card[]): Promise<Record<string, DraftCheck>> => {
    const items = lintTargets(cards)
    const keyOf = (x: LintItem) => `${x.to}\n${x.text}`
    // この回に使う結果は手元に持つ（上限で覚えを捨てても、この回の結果は落とさない）。
    const mine = new Map<string, Entry>()
    const fresh = new Map<string, LintItem>()
    for (const x of items) {
      const e = memo.get(keyOf(x))
      if (e && !(e.failedAt !== undefined && now() - e.failedAt > 60_000)) mine.set(keyOf(x), e)
      else fresh.set(keyOf(x), x)
    }
    if (fresh.size) {
      // 覚える量の上限。古い文面を全部捨てても、次に作るときに検査し直すだけ。
      if (memo.size + fresh.size > 500) memo.clear()
      const list = [...fresh.values()]
      const batch = checkDrafts(list.map((x, i) => ({ ...x, id: String(i) })), o)
      list.forEach((x, i) => {
        const e: Entry = { p: batch.then((r) => r[String(i)]!) }
        void e.p.then((r) => void ('error' in r && (e.failedAt = now())))
        mine.set(keyOf(x), e)
        memo.set(keyOf(x), e)
      })
    }
    return Object.fromEntries(await Promise.all(items.map(async (x) => [x.id, await mine.get(keyOf(x))!.p] as const)))
  }
}
