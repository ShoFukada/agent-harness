/**
 * Orca の外のプロセス（窓・launchd のジョブ）から窓口の Run に知らせる送り口（R191）。窓と bin/cockpit-mail が同じ郵便受けを使う。
 *
 *   cockpit-mail <root> --subject <件名> [--body-file <path|->]
 *
 * root の .orca/cockpit.json の main.run_id に、郵便受けの端末を送り手にして orchestration send で送る。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUN_ID } from '../src/model.ts'
import { lockMailbox, readInOrca, writeAtomic } from '../src/store.ts'
import type { Orca } from './server.ts'

export type MailOrca = Pick<Orca, 'terminals'> & Required<Pick<Orca, 'mailbox' | 'notifyRun'>>

/**
 * 郵便受け（AI を動かさない端末）の handle。dir/mailbox.json に控え、生きていれば使い回し、無いか消えていれば root の worktree に作り直す。
 * Orca の外のプロセスは送り手の端末が無いと orchestration send を断られる（no_active_sender_terminal）。チャットの窓口の名は
 * 送り手に使えない（session_caller_chat_not_declarable）。窓と cockpit-mail が同時に作って 2 つにならないよう、ロックの中で決める。
 */
export async function mailboxOf(orca: MailOrca, dir: string, root: string): Promise<string> {
  const file = path.join(dir, 'mailbox.json')
  const release = await lockMailbox(dir)
  try {
    const saved = await fsp.readFile(file, 'utf8').then((t) => (JSON.parse(t) as { handle?: string }).handle, () => undefined)
    if (saved && (await orca.terminals()).some((t) => t.handle === saved)) return saved
    const handle = await orca.mailbox(root)
    await writeAtomic(file, JSON.stringify({ handle }) + '\n')
    return handle
  } finally {
    await release()
  }
}

/** 郵便受けから runId に送る。 */
export async function sendFromMailbox(orca: MailOrca, dir: string, root: string, runId: string, subject: string, body: string): Promise<string> {
  const from = await mailboxOf(orca, dir, root)
  await orca.notifyRun(from, runId, subject, body)
  return from
}

/** root の帳簿の窓口（main.run_id）に送る。run_id が無ければ投げる。 */
export async function mail(orca: MailOrca, dir: string, root: string, subject: string, body: string): Promise<{ run: string; from: string }> {
  const text = await readInOrca(root, '.orca/cockpit.json')
  if (text === undefined) throw new Error(`${root}/.orca/cockpit.json がない`)
  const run = (JSON.parse(text) as { main?: { run_id?: unknown } }).main?.run_id
  if (!RUN_ID(run)) throw new Error(`${root}/.orca/cockpit.json の main に run_id が無い（窓口の Run に送れない）`)
  return { run, from: await sendFromMailbox(orca, dir, root, run, subject, body) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const opt = (k: string) => {
    const i = args.indexOf(k)
    return i >= 0 ? args[i + 1] : undefined
  }
  const root = args[0]
  const subject = opt('--subject')
  const bodyFile = opt('--body-file') ?? '-'
  if (!root || root.startsWith('--') || !subject) {
    console.error('使い方: cockpit-mail <root> --subject <件名> [--body-file <path|->]')
    process.exit(2)
  }
  // server.ts はこのファイルを読み込むので、静的に読み込むと循環する。トップレベルで待つと読み込みが終わらない。
  const readBody = () => bodyFile === '-' ? new Promise<string>((resolve) => {
    let s = ''
    process.stdin.setEncoding('utf8').on('data', (d) => (s += d)).on('end', () => resolve(s))
  }) : fsp.readFile(bodyFile, 'utf8')
  Promise.all([import('./server.ts'), readBody()])
    .then(([{ orcaCli }, body]) => mail(orcaCli(process.env.COCKPIT_ORCA ?? 'orca') as MailOrca, process.env.COCKPIT_DIR ?? path.join(os.homedir(), 'Library/Application Support/cockpit'), path.resolve(root), subject, body))
    .then(
      (r) => console.log(JSON.stringify({ sent: true, ...r })),
      (e: Error) => {
        console.error(e.message)
        process.exit(1)
      }
    )
}
