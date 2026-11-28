// 窓口に届いていない知らせを窓の上の帯に出す（t178）。Orca の Run の受け取り手は run-use したチャットのままで、人がそれを閉じると
// 新しいチャットに知らせが届かない（2026-11-25 に fitf で 58 通が 3 日残った）。引き継ぎは hook がする（compaction-keep.py の bind_main）。
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { Cockpit } from '../src/model.ts'

/** 窓口の Run の受信箱を読む上限（新しい順）。全体の最新 300 通（inbox）からは数えない（fitf の 58 通のうち 23 通しか入っていなかった）。 */
export const RUN_INBOX_LIMIT = 1000
/** 届いていない知らせを帯に出すまでの時間。窓口が作業中でも Orca は 1 ターンの区切りで届けるので、それより長く残ったものだけを出す。 */
export const STUCK_AFTER_MS = 10 * 60_000

/** orca orchestration inbox --terminal run:<id> --full の 1 通（使う欄だけ）。 */
export type RunMail = { read?: number | boolean; delivered_at?: string | null; created_at?: string }
export type Stuck = { count: number; oldest: number; partial: boolean }
/** hook が、自分の Run を持つチャットに話しかけられて引き継がなかったときに残す印（.orca/cockpit/run-takeover.json）。 */
export type Refusal = { own_run?: string; ledger_run?: string }

/** 誰にも届いていない知らせ（read が 0 かつ delivered_at が空）の数と最古の時刻。無ければ undefined。欄の無い行があれば投げる（Orca の形が変わった）。 */
export function stuckOf(messages: RunMail[], limit = RUN_INBOX_LIMIT): Stuck | undefined {
  if (messages.some((m) => !m || typeof m !== 'object' || !('read' in m) || !('delivered_at' in m))) throw new Error('inbox の行に read・delivered_at が無い')
  const at = messages.filter((m) => !m.read && !m.delivered_at).map((m) => Date.parse(m.created_at ?? ''))
  if (at.some((t) => Number.isNaN(t))) throw new Error('届いていない知らせに created_at が無い')
  return at.length ? { count: at.length, oldest: Math.min(...at), partial: messages.length >= limit } : undefined
}

const ago = (ms: number) => (ms < 3_600_000 ? `${Math.floor(ms / 60_000)}分前` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}時間前` : `${Math.floor(ms / 86_400_000)}日前`)

/**
 * 帯の 1 行。最古の未配達が STUCK_AFTER_MS より古いときだけ出す。refusal は帳簿の今の Run について引き継がなかった印、
 * warnings は窓が最後に送った合図への Orca の注意書き（受け取りが遅れるなど）で、帯の補足に出す。
 */
export function stuckBand(name: string, run: string, s: Stuck | undefined, now: number, refusal?: Refusal, warnings: string[] = []): string | undefined {
  if (!s || now - s.oldest <= STUCK_AFTER_MS) return undefined
  const hint = refusal?.ledger_run === run && refusal.own_run
    ? `最後に話しかけた本線のチャットは自分の Run（${refusal.own_run}）を持つため引き継いでいません。Run を持たない本線のチャットに話しかけると引き継ぐ`
    : '窓口のチャットに話しかけると引き継ぐ'
  const note = warnings.length ? `（窓からの合図への Orca の注意: ${warnings.join(' / ')}）` : ''
  return `${name}: 窓口に届いていない知らせ ${s.count}${s.partial ? ' 件以上' : ' 件'}（最古 ${ago(now - s.oldest)}）。${hint}${note}`
}

export type BandDeps = { runInbox: (run: string) => Promise<RunMail[]> }
/** 最後に出したエラー（案件の root → 文）。同じエラーを読み直しのたびにログへ出さない。 */
const logged = new Map<string, string>()

/** 案件の帯の 1 行を Orca から読んで決める。読めないときは帯を出さず、窓のログに 1 行出す。 */
export async function readStuckBand(o: BandDeps, root: string, c: Cockpit | undefined, now: number, warnings?: string[]): Promise<string | undefined> {
  const run = c?.main?.run_id
  if (!c || !run) return undefined
  try {
    const s = stuckOf(await o.runInbox(run))
    logged.delete(root)
    if (!s) return undefined
    const refusal = await fsp.readFile(path.join(root, '.orca', 'cockpit', 'run-takeover.json'), 'utf8').then((t) => JSON.parse(t) as Refusal, () => undefined)
    return stuckBand(c.workspace.name, run, s, now, refusal, warnings)
  } catch (e) {
    const why = `窓口に届いていない知らせを数えられない（${root}、run:${run}）: ${(e as Error).message}`
    if (logged.get(root) !== why) console.error(why)
    logged.set(root, why)
    return undefined
  }
}
