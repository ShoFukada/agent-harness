// 停止の行に窓から答えを届ける（R222・R223）。どこへ届けるか（AnswerPlan）は server.ts が Orca の様子から決め、ここは届けるだけ。
import type { Ask } from '../src/protocol.ts'
import { screenAsk } from './orca-state.ts'
import type { Orca } from './server.ts'

export type AnswerPlan =
  | { via: 'keys'; terminal: string; kind: Ask['kind']; how: string }
  | { via: 'reply'; id: string; copyTo: string; who: string; line: string; how: string }
  | { via: 'dispatch'; to: string; how: string }
export type AnswerIn = { text?: string; choice?: number; sig?: string }
export type Delivered = { sent: true; text: string; to: string[]; key?: number; note?: string } | { sent: false; reason: string }
export type AnswerDeps = {
  orca: Pick<Orca, 'keys' | 'reply' | 'sendTo' | 'screen'>
  /** 送り手の郵便受けの handle（Orca の外のプロセスは送り手の端末が要る。mail.ts）。 */
  from: () => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

/** Claude Code が番号のあとの入力を受けるまでの間と、送ったあとに画面が描き直されるまでの間。 */
const KEY_GAP_MS = 300
const SETTLE_MS = 1000
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Orca の注意書きのうち、利用者に伝えるもの。預かっただけ（相手がまだ入力を受け付けない）なら、届くのが遅れると書く。 */
const queuedNote = (warnings: string[]) =>
  warnings.some((w) => /^Queued\b/i.test(w)) ? '相手がすぐには受け取れない状態のため、Orca が預かっています。入力を受け付けると届きます' : undefined

/**
 * 同じ問い（問いの文と、自由入力のほかの選択肢の番号・文・説明が同じ）の自由入力の行（番号 free）に選んでいる印があり、typed を渡せばその行に打った文の頭が出ているか
 * （使い捨ての端末で見た画面の形。打った文は、その行の選択肢の文として読まれる）。
 */
function onFree(lines: string[], was: Ask, free: number, typed?: string): boolean {
  const now = screenAsk(lines, was.kind)
  const fixed = (a: Ask | undefined) => JSON.stringify((a?.choices ?? []).filter((c) => c.n !== free).map((c) => [c.n, c.label, c.note ?? '']))
  if (!now || now.text !== was.text || fixed(now) !== fixed(was)) return false
  const row = lines.slice(-60).map((l) => new RegExp(`^\\s*[❯›>]\\s*${free}[.)]\\s+(.+?)\\s*$`).exec(l)).find(Boolean)
  return !!row && (typed === undefined || row[1]!.startsWith(typed.slice(0, 10)))
}

export async function deliverAnswer(plan: AnswerPlan, input: AnswerIn, deps: AnswerDeps): Promise<Delivered> {
  const { orca } = deps
  const sleep = deps.sleep ?? wait
  const text = input.text?.trim()
  try {
    if (plan.via === 'keys') {
      if (!orca.screen || !orca.keys) return { sent: false, reason: 'Orca に端末の画面を読む口がありません' }
      // 送る直前に画面を読み直し、見ていた問いと同じときだけ送る（別の問いに進んでいたら、その問いに間違った番号を押してしまう）。
      const now = screenAsk(await orca.screen(plan.terminal), plan.kind)
      if (!now || now.sig !== input.sig) return { sent: false, reason: '端末の画面が変わりました。読み直してから、もう一度選んでください' }
      let said: string
      let key: number
      if (input.choice !== undefined) {
        const c = now.choices?.find((x) => x.n === input.choice)
        if (!c) return { sent: false, reason: `端末の選択肢に ${input.choice} 番がありません。読み直してから、もう一度選んでください` }
        // 番号のキーだけで選ばれる（Enter は要らない。使い捨ての端末で確かめた）。
        await orca.keys(plan.terminal, String(c.n))
        said = c.label
        key = c.n
      } else {
        if (!text) return { sent: false, reason: '答えを書いてください' }
        if (!now.free) return { sent: false, reason: 'この問いは書いて答えられません。選択肢から選んでください' }
        // 自由入力の番号で入力の欄に移り、文を打って Enter で送る。改行は欄では送信になるので空白にする。
        // 文と Enter の前に、同じ問いの自由入力の行に印（❯）があるかを確かめる。間に問いが閉じていたら、文と Enter がふつうの入力として送られてしまう。
        const line = text.replace(/\s*\n\s*/g, ' ')
        const closed = { sent: false as const, reason: '端末の問いが途中で閉じました。押し直さずに、端末を開いて入力欄を確かめてください' }
        await orca.keys(plan.terminal, String(now.free))
        await sleep(KEY_GAP_MS)
        if (!onFree(await orca.screen(plan.terminal), now, now.free)) return closed
        await orca.keys(plan.terminal, line)
        await sleep(KEY_GAP_MS)
        if (!onFree(await orca.screen(plan.terminal), now, now.free, line)) return closed
        await orca.keys(plan.terminal, '\r')
        said = text
        key = now.free
      }
      await sleep(SETTLE_MS)
      const read = await orca.screen(plan.terminal).then((x) => x, () => undefined)
      // 空の画面（Orca が tail を返さなかった）も、読めなかったものとして扱う。
      if (!read?.length) return { sent: false, reason: '端末にキーを送りましたが、画面を読み直せず届いたか確かめられません。押し直さずに、端末を開いて確かめてください' }
      const after = screenAsk(read, plan.kind)
      // 書いた答えは打った文で行の文が変わるので、印ではなく、入力欄に文が残っていないかで見る。
      if (after?.sig === now.sig || (input.choice === undefined && onFree(read, now, now.free!, said.replace(/\s*\n\s*/g, ' '))))
        return { sent: false, reason: '端末にキーを送りましたが、画面が変わりません。端末を開いて確かめてください' }
      return { sent: true, text: said, to: [plan.terminal], key }
    }
    if (!text) return { sent: false, reason: '答えを書いてください' }
    if (!orca.sendTo || (plan.via === 'reply' && !orca.reply)) return { sent: false, reason: 'Orca に送る口がありません' }
    const from = await deps.from()
    if (plan.via === 'dispatch') {
      const warnings = await orca.sendTo(from, plan.to, '深田さんの返事（操縦席の窓から）', text)
      const note = queuedNote(warnings)
      return { sent: true, text, to: [plan.to], ...(note && { note }) }
    }
    await orca.reply!(from, plan.id, text)
    const body = [`深田さんが操縦席の窓から、${plan.who}の問いに答えました。答えは orchestration reply で${plan.who}に届けてあります（届け直さない）。`, '', `問い: ${plan.line}`, '', '答え（原文）:', text].join('\n')
    try {
      await orca.sendTo(from, plan.copyTo, `窓から答えた: ${plan.line.slice(0, 40)}`, body)
      return { sent: true, text, to: [plan.id, plan.copyTo] }
    } catch (e) {
      return { sent: true, text, to: [plan.id], note: `${plan.who}には届けましたが、宛先への写しは送れませんでした: ${(e as Error).message}` }
    }
  } catch (e) {
    return { sent: false, reason: `届けられませんでした: ${(e as Error).message}` }
  }
}
