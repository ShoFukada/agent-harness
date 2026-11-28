// 窓から立てた質問のタブ（題「質問｜<案件名>｜<質問 id>」）の寿命。タブを探す・「返しを書いて」を届ける・届けられなかった分を送り直す・答えの済んだタブを閉じる（R180）。
// 同じ案件の質問の処理は、窓から聞く処理（server.ts の api.ask）と同じ順番（inQueue）に並べる。
import { promises as fsp } from 'node:fs'
import { askWords, escapeAskSections, type Op } from '../src/model.ts'
import { settledAsks, unreflectedAsks } from '../src/state.ts'
import { addAskSent, readAskSent, readAskTabs, writeAskTab, type Files } from '../src/store.ts'
import type { AskTabRow, Orca } from './server.ts'

/** 「これで決める」のあとに質問のタブへ送る知らせ（compaction-keep.py が深田さんの発言として記録しない書式）。 */
export const askNotice = (op: number) => `【相談の知らせ】返しを書いて（op ${op}）`
/**
 * 質問のタブに届ける 1 回分の入力。案を選んだ・書いて返したときは、深田さんの言葉を先に、改行して知らせを後に置く（nix-darwin の claude/roles/ask.md）。
 * compaction-keep.py は先頭が知らせの入力を発言として残さないので、逆の順にすると言葉が発言の記録に残らず、写しが utterance を引けない。
 * 2 回に分けて送ると、写しが働いている間に届いた 2 回目が別の入力になるので、1 回にまとめる。末尾の知らせの行は hook が発言から外す。
 */
export const askMessage = (o: Pick<Op, 'op_id' | 'choice' | 'text'>) => {
  const words = askWords(o)
  return words ? `${escapeAskSections(words)}\n${askNotice(o.op_id)}` : askNotice(o.op_id)
}
/** 質問のタブの名前（consult --ask の ask_title と同じ）。 */
export const askTitle = (workspace: string, id: string) => `質問｜${workspace.replace(/｜/g, ' ')}｜${id}`

/** 答えの済んだ質問のタブを閉じるまでの、最後の質問か答えからの時間（R180）。 */
const ASK_IDLE_MS = 60 * 60_000

/** 質問のタブの処理が見る案件の様子。askChecked は、タブを閉じるかを確かめた控えの最後の書き込みの時刻（質問 id → mtime）で、同じ時点では探し直さない。 */
export type AskWs = { root: string; files: Files; askChecked?: Map<string, number> }
export type AskTabsDeps<W extends AskWs> = {
  orca: Pick<Orca, 'tabs' | 'closeTerminal' | 'send'>
  /** 窓の置き場所（asktabs.json・asksent.json）。 */
  dir: string
  /** 見張っている案件（呼ぶたびに今の一覧を返す）。 */
  workspaces: () => Iterable<W>
  /** 同じ案件の質問の処理を 1 本の順番に並べる。 */
  inQueue: <T>(root: string, fn: () => Promise<T>) => Promise<T>
  /** 案件の帳簿・控え・返しを読み直す。 */
  reload: (ws: W) => Promise<void>
  broadcast: () => void
  /** 常駐のプロセスを閉じたあとか。Orca の返事を待っていた回が端末を閉じ・送りに進まないようにする。 */
  stopped: () => boolean
}
export type Delivered = { sent: true } | { sent: false; reason: string }

export function askTabs<W extends AskWs>(d: AskTabsDeps<W>) {
  const { orca, dir } = d

  /** 質問のタブの端末（題「質問｜<案件名>｜<質問 id>」の完全一致で探す。tabs を渡せば Orca に聞き直さない）。閉じていれば理由。 */
  async function find(ws: W, id: string, tabs?: AskTabRow[]): Promise<{ handle: string } | { reason: string }> {
    const closed = { reason: '写しの会話は閉じています。続けて聞くと、窓口の今の会話から写し直します' }
    if (!orca.tabs || !ws.files.cockpit) return closed
    const title = askTitle(ws.files.cockpit.workspace.name, id)
    const handle = (tabs ?? (await orca.tabs(ws.root))).find((t) => t.title === title && t.handles.length)?.handles[0]
    return handle ? { handle } : closed
  }

  /** 「返しを書いて（op n）」と深田さんの言葉を質問のタブに送り、届けた op を窓の置き場所に覚える。案件の順番（inQueue）の中で呼ぶ。 */
  async function deliver(ws: W, id: string, op: Op, tabs?: AskTabRow[]): Promise<Delivered> {
    const tab = await find(ws, id, tabs).catch((e: Error) => ({ reason: `タブを探せませんでした: ${e.message}` }))
    if ('reason' in tab) return { sent: false, reason: tab.reason }
    try {
      await orca.send(tab.handle, askMessage(op))
    } catch (e) {
      return { sent: false, reason: `写しの会話に送れませんでした: ${(e as Error).message}` }
    }
    // 覚えられなければ次の見回りでもう一度送る（知らせが 2 回届くだけで、返しは op ごとに 1 つ）。
    await addAskSent(dir, ws.root, op.op_id).catch((e: Error) => console.error(`asksent.json: ${e.message}`))
    return { sent: true }
  }

  /**
   * 返しの無い「窓口に返す」のうち、まだ質問のタブに届けていない op（state.ts の unreflected_returns の「返し」の行。取り消し・窓口が反映済みは入らない）。
   * 返した答えが今も最後の答えのものだけ。会話が先に進んだあとに「案 A で。」を届けると、相手が新しい答えの案と取り違えるので送らず、窓口が控えから拾う（Codex 1）。
   */
  function undelivered(ws: W, sent: readonly number[]): { id: string; op: Op }[] {
    const c = ws.files.cockpit
    if (!c) return []
    return unreflectedAsks({ root: ws.root, threads: ws.files.asks, marks: ws.files.askMarks, log: ws.files.log, applied: c.applied_ops ?? [] }, new Set()).flatMap((x) => {
      const op = x.id === null && typeof x.op === 'number' && !sent.includes(x.op) ? ws.files.log.ops.find((o) => o.op_id === x.op) : undefined
      const now = ws.files.asks.find((a) => a.id === x.ask)?.decide
      return op && now && now.n === op.answer?.n && now.at === op.answer.at ? [{ id: x.ask, op }] : []
    })
  }
  const sentOf = async (root: string) => (await readAskSent(dir))[root] ?? []

  /**
   * 届けられなかった「返しを書いて」を送り直す（Orca を開き直した直後でタブが見つからなかった、送るのに失敗した）。常駐のプロセスが POLL_MS ごとに呼ぶ。
   * 窓から聞く・窓口に返す・タブを閉じる処理と同じ案件の順番に並べ、順番が来たら控え・返し・操作と届けた記録を読み直す。
   */
  async function resend(): Promise<void> {
    if (!orca.tabs) return
    for (const ws of d.workspaces()) {
      if (!undelivered(ws, await sentOf(ws.root)).length) continue
      await d.inQueue(ws.root, async () => {
        await d.reload(ws)
        const due = undelivered(ws, await sentOf(ws.root))
        if (!due.length) return
        const tabs = await orca.tabs!(ws.root)
        let any = false
        for (const { id, op } of due) {
          if (d.stopped()) return
          if (!(await deliver(ws, id, op, tabs)).sent) continue
          any = true
          console.error(`返しを書いての知らせを送り直した: ${ws.root} ${id} op ${op.op_id}`)
        }
        if (any) d.broadcast()
      }).catch((e: Error) => console.error(`質問のタブへの送り直し: ${e.message}`))
    }
  }

  /**
   * 答えの済んだ質問のタブを閉じる（R180）。条件は state.ts の settledAsks と、控えの最後の書き込み（質問か答え）から 1 時間たったこと。
   * 閉じるのは、その案件の worktree の「質問｜…｜<質問 id>」の題のタブにある、窓が consult --ask で立てたと記録した端末だけ。控えと返しの記録は消さない。
   * 窓から聞く・続けて聞く処理と同じ案件の順番（inQueue）に並べ、閉じる直前に控え・返し・op を読み直して条件を見直す（その間に聞かれた・返されたものを閉じない）。
   * 窓のブラウザが開いていなくても、常駐のプロセスが POLL_MS ごとに見る。
   */
  async function sweep(now = Date.now()): Promise<void> {
    if (!orca.tabs || !orca.closeTerminal) return
    const idle = async (ws: W): Promise<{ id: string; at: number }[]> => {
      const c = ws.files.cockpit
      if (!c) return []
      const out: { id: string; at: number }[] = []
      for (const id of settledAsks({ root: ws.root, threads: ws.files.asks, marks: ws.files.askMarks, log: ws.files.log, applied: c.applied_ops ?? [] }, ws.files.rulings)) {
        const at = (await fsp.stat(ws.files.asks.find((x) => x.id === id)!.path).catch(() => undefined))?.mtimeMs
        if (at !== undefined && now - at >= ASK_IDLE_MS && ws.askChecked?.get(id) !== at) out.push({ id, at })
      }
      return out
    }
    for (const ws of d.workspaces()) {
      if (!(await idle(ws)).length) continue
      await d.inQueue(ws.root, async () => {
        await d.reload(ws)
        const due = await idle(ws)
        if (!due.length || !ws.files.cockpit) return
        const tabs = await orca.tabs!(ws.root)
        const mine = (await readAskTabs(dir))[ws.root] ?? {}
        for (const { id, at } of due) {
          const hit = tabs.filter((t) => t.title === askTitle(ws.files.cockpit!.workspace.name, id))
          const done = () => (ws.askChecked ??= new Map()).set(id, at)
          // タブが無い（もう閉じた）なら、控えが変わるまで探し直さない。題はあるが端末が繋がっていないときは、次の回にもう一度見る。
          // 端末の題から読んだとき（画面がまだその worktree を開いていない）は、題が書き換わっただけかもしれないので、次の回にもう一度見る。
          // 一覧が空のとき（開き直した直後で端末の一覧もまだ空）も、次の回にもう一度見る（Codex 6）。
          if (!hit.length) {
            if (tabs.length && !tabs.some((t) => t.loose)) done()
            continue
          }
          const handles = hit.flatMap((t) => t.handles)
          if (!handles.length) continue
          if (!mine[id]) {
            done()
            console.error(`質問のタブを閉じない（${id}）: 窓が立てた端末の記録が無い（${handles.join('、')}）`)
            continue
          }
          // 窓が立てた端末が見えない（同じ題のほかのタブだけが繋がっている）ときは、次の回にもう一度見る。
          if (!handles.includes(mine[id])) continue
          if (d.stopped()) return
          try {
            await orca.closeTerminal!(mine[id])
            done()
            await writeAskTab(dir, ws.root, id, null).catch((e: Error) => console.error(`asktabs.json: ${e.message}`))
            console.error(`質問のタブを閉じた: ${ws.root} ${id}`)
          } catch (e) {
            console.error(`質問のタブを閉じられない（${id}）: ${(e as Error).message}`)
          }
        }
      }).catch((e: Error) => console.error(`質問のタブ: ${e.message}`))
    }
  }

  return { find, deliver, undelivered, sentOf, resend, sweep }
}
