// 窓口への合図。取り消しの猶予が過ぎた操作を、窓の郵便受けから窓口の Run に知らせる（R191）。送る中身と時機は store.ts の signalPlan・notifyMain が決める。
import type { CockpitView, NotifyResult } from '../src/protocol.ts'
import { notifyMain, readNotified, signalPlan, writeNotified, type Files, type SendRun } from '../src/store.ts'
import { sendFromMailbox, type MailOrca } from './mail.ts'
import type { Orca } from './server.ts'

/**
 * 合図が見る案件の様子。signal は窓の上の帯に出す送れなかった理由、signalTimer は次に猶予が過ぎる時刻の見張り、
 * sending は送っている最中の合図（notify を案件ごとに 1 つずつにする）。
 */
export type SignalWs = { root: string; files: Files; signal?: CockpitView['signal']; signalTimer?: ReturnType<typeof setTimeout>; sending?: Promise<unknown> }
export type SignalDeps = {
  orca: Orca
  /** 窓の置き場所（notified.json・mailbox.json）。 */
  dir: string
  broadcast: () => void
}

export function signals(d: SignalDeps) {
  const { orca, dir } = d

  const sendRun = (root: string): SendRun | undefined => {
    if (!orca.notifyRun || !orca.mailbox) return undefined
    const box = orca as MailOrca
    return async (runId, subject, body) => (await sendFromMailbox(box, dir, root, runId, subject, body), { sent: true })
  }

  /**
   * now は送る時機を決める時刻。押して送り直すときは Infinity（猶予中の操作も送る）。
   * 自動と押した送り直しが重なっても同じ操作を 2 度送らないよう、案件ごとに 1 つずつ送り、送る直前に送った位置を読み直す。
   */
  function notify(ws: SignalWs, now = Infinity): Promise<NotifyResult> {
    const run = async (): Promise<NotifyResult> => {
      const c = ws.files.cockpit
      if (!c) return { sent: false, reason: 'cockpit.json に main がありません' }
      const { due } = signalPlan(c, ws.files.log, await readNotified(dir, ws.root), now)
      if (!due.length) return { sent: true }
      // run_id の無い帳簿は notifyMain が理由を返す（窓の上の帯に出し、押した操作が黙って届かないままにしない）。
      const r = await notifyMain(c, due, sendRun(ws.root) ?? (async () => ({ sent: false, reason: 'Orca に送る口がありません' })))
      if (r.lastOp !== undefined) await writeNotified(dir, ws.root, r.lastOp)
      return r.sent ? { sent: true } : { sent: false, reason: r.reason }
    }
    const p = (ws.sending ?? Promise.resolve()).then(run, run)
    ws.sending = p.catch(() => {})
    return p
  }

  /** 取り消しの猶予が過ぎた操作があれば、窓口の Run に合図を送る（Orca が窓口の手が空いたときに届ける。R191）。 */
  async function auto(ws: SignalWs): Promise<void> {
    clearTimeout(ws.signalTimer)
    const c = ws.files.cockpit
    if (!c) return void (ws.signal = undefined)
    const plan = signalPlan(c, ws.files.log, await readNotified(dir, ws.root), Date.now())
    if (plan.nextAt !== undefined) ws.signalTimer = setTimeout(() => soon(ws), plan.nextAt - Date.now() + 50)
    if (!plan.due.length) return void (ws.signal = undefined)
    const r = await notify(ws, Date.now())
    ws.signal = r.sent ? undefined : { state: 'failed', reason: r.reason }
  }

  /** auto を待たずに走らせ、終わったら窓に送り直す。 */
  function soon(ws: SignalWs): void {
    void auto(ws).then(d.broadcast, (e) => console.error(e))
  }

  return { notify, auto, soon }
}
