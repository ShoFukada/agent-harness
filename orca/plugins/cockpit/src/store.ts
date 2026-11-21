// パネルの worker と窓の常駐のプロセス（window/server.ts）が同じ関数を使う。
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  KIND_LABEL, OTHER, nextOp, overlay, textError, parseArchive, parseCockpit, parseUserLog, unappliedOps, UNDO_GRACE_MS,
  type Card, type Cockpit, type Op, type UserLog
} from './model.ts'
import type { NotifyResult, OpInput } from './protocol.ts'

export const SIGNAL = '【操縦席】未反映の操作があります'

/** 合図の 1 行。別の答えと「担当と話す」があれば、どのカードかと本文の頭を載せる（端末に送るので改行は空白にする）。 */
export function signalText(ops: Op[]): string {
  const said = ops.filter((o) => o.type === 'talk' || (o.type === 'decide' && o.option_id === OTHER)).at(-1)
  if (!said) return SIGNAL
  const t = (said.text ?? '').replace(/\s+/g, ' ').trim()
  const what = said.type === 'talk' ? '担当と話す' : '別の答え'
  return `${SIGNAL}（${what} ${said.item_id}${t ? `: ${t.length > 60 ? t.slice(0, 60) + '…' : t}` : ''}）`
}

const FIGURE_PATH = /^\.orca\/cockpit\/figures\/[\w.-]+\.svg$/

export type Files = {
  cockpit?: Cockpit
  log: UserLog
  archive: Card[]
  figures: Record<string, string>
  errors: string[]
  missing: boolean
}

export const emptyFiles = (): Files => ({ log: { ops: [] }, archive: [], figures: {}, errors: [], missing: true })

const conflict = (msg: string) => Object.assign(new Error(msg), { code: 'conflict' })

async function readText(p: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(p, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** root/.orca の中のファイルだけを読む。`..` やシンボリックリンクで外へ出るものは断る。 */
export async function readInOrca(root: string, rel: string): Promise<string | undefined> {
  const dir = path.join(root, '.orca')
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(dir + path.sep)) throw new Error(`.orca の外は読みません: ${rel}`)
  let real: string, realDir: string
  try {
    ;[real, realDir] = await Promise.all([fsp.realpath(abs), fsp.realpath(dir)])
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  if (!real.startsWith(realDir + path.sep)) throw new Error(`.orca の外は読みません: ${rel}`)
  return readText(real)
}

/** 読めたファイルだけ差し替え、壊れたものは prev の中身を保ってエラーを 1 行残す。 */
export async function loadFiles(root: string, prev: Files): Promise<Files> {
  const next: Files = { cockpit: prev.cockpit, log: prev.log, archive: prev.archive, figures: {}, errors: [], missing: prev.missing }
  /** 読めない・形が違うファイルは、エラーを 1 行残して前回の中身のままにする。 */
  async function one(name: string, label: string, apply: (text: string | undefined) => void): Promise<void> {
    try {
      apply(await readInOrca(root, `.orca/${name}`))
    } catch (e) {
      next.errors.push(`${name} を読めません${label}: ${(e as Error).message}`)
    }
  }
  await one('cockpit.json', '（前回の表示のまま）', (text) => {
    next.missing = text === undefined
    next.cockpit = text === undefined ? undefined : parseCockpit(text)
  })
  await one('cockpit.user.json', '', (text) => {
    next.log = text === undefined ? { ops: [] } : parseUserLog(text)
  })
  await one('cockpit.archive.json', '', (text) => {
    next.archive = text === undefined ? [] : parseArchive(text).cards
  })
  const figures: Record<string, string> = {}
  const refs = [...(next.cockpit?.cards ?? []), ...next.archive]
    .map((x) => x.figure)
    .filter((f): f is string => !!f && FIGURE_PATH.test(f))
  for (const ref of new Set(refs)) {
    const svg = await readInOrca(root, ref).catch((e: Error) => {
      next.errors.push(e.message)
      return null
    })
    if (svg === undefined) next.errors.push(`図が見つかりません: ${ref}`)
    else if (svg !== null) figures[ref] = svg
  }
  next.figures = figures
  return next
}

/** 同じ保存先への追記は 1 つずつ行う（同じ op_id で片方を失わない）。 */
const writing = new Map<string, Promise<unknown>>()

/** 操作を cockpit.user.json に追記し、追記後のログを返す。cockpit は呼び出し側が表示していた中身。 */
export function appendOp(root: string, cockpit: Cockpit | undefined, input: OpInput): Promise<UserLog> {
  if (input.root !== root) return Promise.reject(conflict('表示中のワークスペースが変わりました。もう一度押してください'))
  const run = (writing.get(root) ?? Promise.resolve()).then(() => write(root, cockpit, input))
  writing.set(root, run.catch(() => undefined))
  return run
}

async function write(root: string, _shown: Cockpit | undefined, { root: _root, ...input }: OpInput): Promise<UserLog> {
  const release = await lockLog(root)
  try {
    // 画面が持つ中身は古いことがある（窓口が書き換えた直後・版 1 に戻した直後）。押した瞬間のファイルで確かめる。
    const cockpit = await readCockpit(root)
    const text = await readInOrca(root, '.orca/cockpit.user.json')
    const log = text === undefined ? { ops: [] } : parseUserLog(text)
    check(cockpit, log, input)
    log.ops.push(nextOp(log, { at: new Date().toISOString(), ...input }))
    await writeAtomic(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify(log, null, 2) + '\n')
    return log
  } finally {
    await release()
  }
}

async function readCockpit(root: string): Promise<Cockpit> {
  const text = await readInOrca(root, '.orca/cockpit.json')
  if (text === undefined) throw conflict('操縦席がありません')
  try {
    return parseCockpit(text)
  } catch (e) {
    throw conflict((e as Error).message)
  }
}

/** 片付ける操作。取り消し・戻して・担当と話すは、片付いたカードにも受ける。 */
const CLOSING = new Set(['decide', 'accept', 'sent', 'skip', 'delegate', 'ack'])

function check(cockpit: Cockpit, log: UserLog, input: Omit<OpInput, 'root'>): void {
  const invalid = (msg: string) => Object.assign(new Error(msg), { code: 'invalid_params' })
  const card = cockpit.cards.find((c) => c.id === input.item_id)
  if (!card) throw invalid(`カード ${input.item_id} がありません`)
  // 担当が書き換えたあとの古い画面で押した操作は、新しい版に効かせない。
  if (input.type !== 'undo' && card.rev !== input.item_rev) throw conflict(`「${card.title}」は担当が書き換えました。読み直してからもう一度押してください`)
  // 片付いた・顧客待ち・決めて受け取り待ちのカードに、もう一度片付ける操作を重ねない（ログと状態が食い違うため）。
  const status = overlay(cockpit, log).find((v) => v.card.id === card.id)?.status
  if (CLOSING.has(input.type) && (status === 'closed' || status === 'waiting')) throw conflict(`「${card.title}」はもう片付いています`)
  const bad = textError(input.text)
  if (bad) throw invalid(bad)
  if (input.type === 'decide' && input.option_id === OTHER && !input.text?.trim()) throw invalid('別の答えを書いてください')
  if (input.type === 'decide' && input.option_id !== OTHER && !card.options?.some((o) => o.id === input.option_id))
    throw invalid(`${KIND_LABEL[card.kind]}「${card.title}」に選択肢 ${String(input.option_id)} がありません`)
  if (input.type === 'revert' && (input.target === undefined || !card.done?.[input.target])) throw invalid('戻す項目がありません')
  if (input.type === 'undo' && input.undo_of === undefined) throw invalid('取り消す操作がありません')
}

/** cockpit.user.json への追記と、移し替え（window/migrate.ts）が同じロックを取る。 */
export const lockLog = (root: string) => lock(path.join(root, '.orca', 'cockpit.user.json.lock'))

/**
 * パネルの worker と窓の常駐のプロセスは別のプロセスなので、同じログへの追記をロックファイルで 1 つずつにする
 * （同時に読んで同じ op_id を付け、後の rename が先の操作を消すのを防ぐ）。落ちたプロセスが残したロックは 10 秒で外す。
 */
async function lock(file: string): Promise<() => Promise<void>> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      await (await fsp.open(file, 'wx')).close()
      return () => fsp.rm(file, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const age = Date.now() - ((await fsp.stat(file).catch(() => null))?.mtimeMs ?? Date.now())
      if (age > 10_000) await fsp.rm(file, { force: true })
      else if (i > 150) throw conflict('ほかの画面が記録中です。もう一度押してください')
      else await new Promise((r) => setTimeout(r, 20))
    }
  }
}

/** 端末に文字を送る。送れなければ理由を返す。パネルは Orca の host API、窓は orca CLI で送る。 */
export type SendText = (terminal: string, text: string) => Promise<NotifyResult>

/** メインの端末に合図の 1 行を送る。送れたら、合図に含めた最後の op_id を返す。 */
export async function notifyMain(cockpit: Cockpit | undefined, log: UserLog, send: SendText): Promise<NotifyResult & { lastOp?: number }> {
  const main = cockpit?.main
  if (!main?.terminal) return { sent: false, reason: 'cockpit.json に main がありません' }
  try {
    const r = await send(main.terminal, signalText(unappliedOps(cockpit, log)))
    if (!r.sent) return r
  } catch (e) {
    return { sent: false, reason: (e as Error).message }
  }
  return { sent: true, lastOp: log.ops.reduce((n, o) => Math.max(n, o.op_id), 0) }
}

let tmpSeq = 0
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`
  await fsp.writeFile(tmp, text)
  await fsp.rename(tmp, file)
}

/**
 * 自動で合図を送る操作と、次に送れるようになる時刻。取り消しの猶予が過ぎ、まだ知らせていない未反映の操作が対象。
 * 未反映どうしの取り消しの組は除く。話したいも同じく猶予のあとに送る（本文の頭を合図に載せる）。
 * パネルの worker と窓の常駐のプロセスが同じ操作に二重に送らないよう、自分が書いた操作（mine）は猶予だけ、
 * ほかの画面が書いた操作はその 3 倍待つ（書いた側が送れなかったときだけ拾う）。
 */
export function signalPlan(c: Cockpit, log: UserLog, notified: number, now: number, mine: (op: Op) => boolean): { due: Op[]; nextAt?: number } {
  const un = unappliedOps(c, log)
  const cancelled = new Set(un.filter((o) => o.type === 'undo' && un.some((x) => x.op_id === o.undo_of)).flatMap((o) => [o.op_id, o.undo_of!]))
  const due: Op[] = []
  let nextAt: number | undefined
  for (const o of un) {
    if (o.op_id <= notified || cancelled.has(o.op_id)) continue
    const at = Date.parse(o.at) + (mine(o) ? UNDO_GRACE_MS : UNDO_GRACE_MS * 3)
    if (at <= now) due.push(o)
    else nextAt = Math.min(nextAt ?? Infinity, at)
  }
  return { due, nextAt }
}

/** どの操作までメインに知らせたか。パネルと窓が共有する（~/Library/Application Support/cockpit/notified.json）。 */
export async function readNotified(dir: string, root: string): Promise<number> {
  try {
    const v = JSON.parse(await fsp.readFile(path.join(dir, 'notified.json'), 'utf8')) as Record<string, unknown>
    return typeof v[root] === 'number' ? v[root] : 0
  } catch {
    return 0
  }
}

export async function writeNotified(dir: string, root: string, op: number): Promise<void> {
  const file = path.join(dir, 'notified.json')
  let v: Record<string, number> = {}
  try {
    v = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    // 無い・壊れているときは作り直す（失うのは「どこまで知らせたか」だけで、もう一度合図が届くだけ）。
  }
  v[root] = Math.max(v[root] ?? 0, op)
  await writeAtomic(file, JSON.stringify(v) + '\n')
}

/** 「path:12」を ファイルと行に分ける。行の無いパスと、名前に : を含むだけのパスはそのまま。 */
export function splitLine(href: string): { file: string; line?: number } {
  const m = /^(.*\S):(\d+)$/.exec(href)
  return m ? { file: m[1]!, line: Number(m[2]) } : { file: href }
}
