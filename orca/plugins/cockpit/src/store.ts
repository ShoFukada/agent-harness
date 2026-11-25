// パネルの worker と窓の常駐のプロセス（window/server.ts）が同じ関数を使う。
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  dismissable, isSynthetic, KIND_LABEL, OTHER, TIDY_KINDS, TIDY_LABEL, type TidyKind, nextOp, overlay, parseHandoff, textError, parseArchive, parseCockpit, parseUserLog, unappliedOps, UNDO_GRACE_MS,
  ANSWER_VIA, ASK_ID, isAnswerItem, isAskItem, latestAnswer, latestChoices, RETURN_ID, taskSig, type TaskSeen, type AskAnswer, type AskEntry, type AskMark, type AskReturn, type AskThread, type ReturnMark, type Card, type Cockpit, type ConsultMemo, type ConsultReturn, type Handoff, type Op, type Ruling, type UserLog, type Utterance
} from './model.ts'
import type { NotifyResult, OpInput } from './protocol.ts'

export const SIGNAL = '【操縦席】未反映の操作があります'

/** 深田さんが文を書いた（か選んだ）操作。合図にどのカードかと本文の頭を載せる。 */
const saidOp = (o: Op) => o.type === 'talk' || o.type === 'repeat' || o.type === 'answer' || o.type === 'tidy' || (o.type === 'decide' && o.option_id === OTHER)

/** 合図の 1 行。別の答えと「担当と話す」があれば、どのカードかと本文の頭を載せる（端末に送るので改行は空白にする）。 */
export function signalText(ops: Op[]): string {
  const said = ops.filter(saidOp).at(-1)
  if (!said) return SIGNAL
  const t = (said.text ?? '').replace(/\s+/g, ' ').trim()
  const what = said.type === 'talk' ? (t ? '直してほしい' : '担当と話す') : said.type === 'repeat' ? '前にも言った' : said.type === 'answer' ? '窓から答えた'
    : said.type === 'tidy' ? `整理・棚卸し（${TIDY_LABEL[said.option_id as TidyKind] ?? '自由な指示'}）op ${said.op_id}` : '別の答え'
  return `${SIGNAL}（${what}${said.item_id ? ` ${said.item_id}` : ''}${t ? `: ${t.length > 60 ? t.slice(0, 60) + '…' : t}` : ''}）`
}

const FIGURE_PATH = /^\.orca\/cockpit\/figures\/[\w.-]+\.svg$/

export type Files = {
  cockpit?: Cockpit
  log: UserLog
  archive: Card[]
  figures: Record<string, string>
  errors: string[]
  missing: boolean
  handoff?: Handoff
  /** 発言の記録（.orca/cockpit/utterances.jsonl）のうち id のある行。仕分けの検査に使うので、本文は頭だけ持つ。 */
  utterances: Utterance[]
  /** Orca の知らせの記録（.orca/cockpit/notices.jsonl、hook が書く n-…）。開いた待ちと照らしていない知らせの検査に使う（R204）。 */
  notices: Utterance[]
  /** at の無い開いたカードを、窓の常駐のプロセスが最初に見つけた時刻（.orca/cockpit/firstseen.json）。抜けの 30 分を数える。 */
  firstSeen: Record<string, string>
  /** 済んでいないタスクの中身が最後に変わった時刻（.orca/cockpit/taskseen.json）。放置の検出の起点に使う。 */
  taskSeen: TaskSeen
  /** 判断の記録（.orca/cockpit/rulings.jsonl）の id と affects。見直していないタスクの検査に使う。 */
  rulings: Ruling[]
  /** カードの相談のメモ（.orca/consult/*.md）と、その中の窓口への返し。 */
  consults: ConsultMemo[]
  /** cockpit.json と cockpit.archive.json の生のカードの返しの印（形の崩れたカードも数える）。 */
  marks: ReturnMark[]
  asks: AskThread[]
  /** cockpit.json と cockpit.archive.json の生の asks[]（compaction-keep.py の ledger_asks と同じ順）。 */
  askMarks: AskMark[]
}

export const emptyFiles = (): Files => ({ log: { ops: [] }, archive: [], figures: {}, errors: [], missing: true, utterances: [], notices: [], firstSeen: {}, taskSeen: {}, rulings: [], consults: [], marks: [], asks: [], askMarks: [] })

/** ファイルの生の欄（cards・asks）。読めなければ無い（python の read_json の既定と同じ）。 */
function rawList(text: string | undefined, key: 'cards' | 'asks'): unknown {
  let v: unknown
  try {
    v = JSON.parse(text ?? '')
  } catch {
    return undefined
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[key] : undefined
}

/** ファイルの生の asks[] のうち、id が文字列の行（compaction-keep.py の ledger_asks と同じ）。 */
function askMarks(text: string | undefined): AskMark[] {
  const xs = rawList(text, 'asks')
  return (Array.isArray(xs) ? xs : []).filter((x): x is AskMark => typeof x === 'object' && x !== null && !Array.isArray(x) && typeof (x as AskMark).id === 'string')
}

/** ファイルの生のカードから返しの印を抜く。読めなければ空（python の read_json の既定と同じ）。 */
function returnMarks(text: string | undefined): ReturnMark[] {
  const cards = rawList(text, 'cards')
  return (Array.isArray(cards) ? cards : [])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x))
    .map((x) => ({ id: x.id, ...(Array.isArray(x.from_returns) && { from_returns: x.from_returns }), ...(Array.isArray(x.held_returns) && { held_returns: x.held_returns }) }))
}

/**
 * 相談のメモの「## 窓口に返したもの」の節にある ```json の塊のうち、return_id を持つもの（同じ id は先のもの）。
 * 読み方は compaction-keep.py の memo_returns と同じにする（checks.unreflected_returns を python と食い違わせないため）。
 */
export function memoReturns(raw: string): ConsultReturn[] {
  // python はテキストの読み込みで改行を \n にそろえる。
  const text = raw.replace(/\r\n?/g, '\n')
  const head = /^## 窓口に返したもの[^\n]*\n/m.exec(text)
  if (!head) return []
  const rest = text.slice(head.index + head[0].length)
  const end = /^## /m.exec(rest)
  const out = new Map<string, ConsultReturn>()
  for (const m of (end ? rest.slice(0, end.index) : rest).matchAll(/```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g)) {
    try {
      const v = JSON.parse(m[1]!) as unknown
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as ConsultReturn).return_id === 'string' && RETURN_ID.test((v as ConsultReturn).return_id) && !out.has((v as ConsultReturn).return_id))
        out.set((v as ConsultReturn).return_id, v as ConsultReturn)
    } catch {
      // 書きかけの塊。
    }
  }
  return [...out.values()]
}

/** .orca/consult/*.md を名前の順に読む。置き場所が無ければ空。 */
async function readConsults(root: string): Promise<ConsultMemo[]> {
  const dir = path.join(root, '.orca', 'consult')
  let names: string[]
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md')).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: ConsultMemo[] = []
  for (const name of names) {
    const text = await readInOrca(root, `.orca/consult/${name}`).catch(() => undefined)
    if (text !== undefined) out.push({ card: name.slice(0, -3), path: path.join(dir, name), returns: memoReturns(text) })
  }
  return out
}

const ASK_SECTION = /^### (質問|答え|知らせ) (\d{1,2}:\d{2})(?:（(u-\d+)）)?[ \t]*$/gm
const ASK_KIND = { 質問: 'q', 答え: 'a', 知らせ: 'n' } as const

/**
 * 質問と答えの控え（consult --ask が頭を、hook が「### 質問 HH:MM（u-12）」「### 答え HH:MM」「### 知らせ HH:MM」の節を書く）。
 * 頭の「- カード:」「- タスク:」「- 仕事:」は compaction-keep.py の ask_binding と同じ形で読む。
 */
export function parseAskMemo(raw: string): Pick<AskThread, 'card' | 'task' | 'stream' | 'at' | 'entries'> {
  const text = raw.replace(/\r\n?/g, '\n')
  // 閉じていないフェンスは見ない（hook が後に書いた本物の答えまで隠すため）。
  const fenced: [number, number][] = []
  for (let m, re = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm; (m = re.exec(text)); ) fenced.push([m.index, m.index + m[0].length])
  const heads = [...text.matchAll(ASK_SECTION)].filter((m) => !fenced.some(([a, b]) => m.index! > a && m.index! < b))
  const head = text.slice(0, heads[0]?.index ?? text.length).split('\n###', 1)[0]!
  const bound = Object.fromEntries([...head.matchAll(/^- (カード|タスク|仕事): ([A-Za-z0-9_]+)$/gm)].map((m) => [m[1], m[2]]))
  const at = /（窓口の会話 ([^）]+) 時点）/.exec(head)?.[1]
  const entries: AskEntry[] = heads.map((m, i) => ({
    kind: ASK_KIND[m[1] as keyof typeof ASK_KIND],
    time: m[2]!,
    text: text.slice(m.index! + m[0].length, heads[i + 1]?.index ?? text.length).trim(),
    ...(m[3] && { utterance: m[3] })
  }))
  return { ...(bound['カード'] && { card: bound['カード'] }), ...(bound['タスク'] && { task: bound['タスク'] }), ...(bound['仕事'] && { stream: bound['仕事'] }), ...(at && { at }), entries }
}

/** 質問の返しの記録の行（compaction-keep.py の read_jsonl と同じく、壊れた行とオブジェクトでない行は飛ばす）。 */
export function parseAskReturns(text: string): AskReturn[] {
  const out: AskReturn[] = []
  for (const line of text.split('\n')) {
    try {
      const v = JSON.parse(line) as unknown
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) out.push(v as AskReturn)
    } catch {
      // 書きかけの行。
    }
  }
  return out
}

/** .orca/consult/ の ask-<id>.md と ask-<id>.returns.jsonl を、質問 id の数の順に読む（compaction-keep.py の ask_ids と同じ）。 */
export async function readAsks(root: string): Promise<AskThread[]> {
  const dir = path.join(root, '.orca', 'consult')
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const ids = [...new Set(names.map((n) => /^ask-(ask\d+)\.(?:md|returns\.jsonl)$/.exec(n)?.[1]).filter((x): x is string => !!x && ASK_ID.test(x)))]
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
  return Promise.all(ids.map(async (id): Promise<AskThread> => {
    const memo = await readInOrca(root, `.orca/consult/ask-${id}.md`).catch(() => undefined)
    const rets = await readInOrca(root, `.orca/consult/ask-${id}.returns.jsonl`).catch(() => undefined)
    const m = parseAskMemo(memo ?? '')
    const decide = latestAnswer(m.entries)
    const choices = decide ? latestChoices(m.entries) : []
    const first = m.entries.find((e) => e.kind === 'q')?.text
    // 一覧の時刻と並びは、控えか返しの記録を最後に書いた時刻（控えの節は時刻だけで日付を持たないため）。
    const times = await Promise.all([`ask-${id}.md`, `ask-${id}.returns.jsonl`].map((n) => fsp.stat(path.join(dir, n)).then((x) => x.mtimeMs, () => 0)))
    const updated = Math.max(...times)
    return {
      id, path: path.join(dir, `ask-${id}.md`), returnsPath: path.join(dir, `ask-${id}.returns.jsonl`), ...m, answers: m.entries.filter((e) => e.kind === 'a').length,
      ...(decide && { decide }), ...(choices.length && { choices }), ...(first && { first }), ...(updated && { updated: new Date(updated).toISOString() }), returns: parseAskReturns(rets ?? '')
    }
  }))
}

/**
 * 同じ案件を開く 2 つの常駐のプロセスが同じ id を採らない（Codex 重大 4）。古いロックを外す待ち合わせは、2 つが同時に外すと両方が取れるので使わない（Codex 2 回目 重大 2）。
 * 札は consult が戻ったら release で消す（控えの頭ができていれば次はそれで数える）。落ちて残った札はその id を飛ばすだけ。
 */
export async function reserveAskId(root: string): Promise<{ id: string; release: () => Promise<void> }> {
  const dir = path.join(root, '.orca', 'consult')
  await fsp.mkdir(dir, { recursive: true })
  for (;;) {
    const names = await fsp.readdir(dir)
    const n = names.reduce((m, x) => Math.max(m, Number(/^\.?ask-ask(\d+)\.(?:md|returns\.jsonl|reserved)$/.exec(x)?.[1] ?? 0)), 0)
    const id = `ask${n + 1}`
    const file = path.join(dir, `.ask-${id}.reserved`)
    try {
      await (await fsp.open(file, 'wx')).close()
      return { id, release: () => fsp.rm(file, { force: true }) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

/** 判断の記録の 1 行ずつ。壊れた行と id の無い行は飛ばす。 */
export function parseRulings(text: string): Ruling[] {
  const out: Ruling[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as Record<string, unknown>
      const from = typeof v.from_return === 'string' ? { from_return: v.from_return } : {}
      // id の無い行も、相談の返しの照合（from_return）には数える（compaction-keep.py の unreflected と同じ）。
      if (typeof v.id !== 'string' || !v.id) {
        if (from.from_return) out.push({ id: '', ...from })
        continue
      }
      const affects = Array.isArray(v.affects) ? v.affects.filter((x): x is string => typeof x === 'string') : undefined
      // 窓から質問するときに引く本文（窓には送らず、常駐のプロセスが引いた行だけを返す）。
      const texts = Object.fromEntries((['at', 'kind', 'text', 'quote', 'dec'] as const).filter((k) => typeof v[k] === 'string').map((k) => [k, v[k] as string]))
      // hook は配列で書く（compaction-keep.py の rule）。手で書いた文字列 1 つも受ける。
      const sup = Array.isArray(v.supersedes) ? v.supersedes.filter((x): x is string => typeof x === 'string') : typeof v.supersedes === 'string' ? [v.supersedes] : []
      out.push({ id: v.id, ...(affects && { affects }), ...from, ...texts, ...(sup.length && { supersedes: sup }), ...(typeof v.scope === 'string' && { scope: v.scope }), ...(typeof v.allow === 'boolean' && { allow: v.allow }) })
    } catch {
      // 書きかけの行。
    }
  }
  return out
}

/** 発言の記録の 1 行ずつ。壊れた行は飛ばす（hook が追記の途中で落ちても、ほかの行の仕分けは見る）。 */
export function parseUtterances(text: string): Utterance[] {
  const out: Utterance[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as Partial<Utterance>
      if (typeof v.id === 'string' && v.id && typeof v.at === 'string') out.push({ id: v.id, at: v.at, prompt: typeof v.prompt === 'string' ? v.prompt.slice(0, 200) : undefined })
    } catch {
      // 書きかけの最後の行など。次に読むときに拾う。
    }
  }
  return out
}

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
  const next: Files = {
    cockpit: prev.cockpit, log: prev.log, archive: prev.archive, figures: {}, errors: [], missing: prev.missing, handoff: prev.handoff,
    utterances: prev.utterances, notices: prev.notices, firstSeen: prev.firstSeen, taskSeen: prev.taskSeen, rulings: prev.rulings, consults: prev.consults, marks: [], asks: prev.asks, askMarks: []
  }
  const asked: AskMark[][] = [[], []]
  const marks: ReturnMark[][] = [[], []]
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
    marks[0] = returnMarks(text)
    asked[0] = askMarks(text)
    next.cockpit = text === undefined ? undefined : parseCockpit(text, next.errors)
  })
  await one('cockpit.user.json', '', (text) => {
    next.log = text === undefined ? { ops: [] } : parseUserLog(text)
  })
  await one('cockpit.archive.json', '', (text) => {
    marks[1] = returnMarks(text)
    asked[1] = askMarks(text)
    next.archive = text === undefined ? [] : parseArchive(text, next.errors).cards
  })
  await one('cockpit/handoff.json', '', (text) => {
    next.handoff = text === undefined ? undefined : parseHandoff(text)
  })
  await one('cockpit/utterances.jsonl', '', (text) => {
    next.utterances = text === undefined ? [] : parseUtterances(text)
  })
  await one('cockpit/notices.jsonl', '', (text) => {
    next.notices = text === undefined ? [] : parseUtterances(text)
  })
  await one('cockpit/rulings.jsonl', '', (text) => {
    next.rulings = text === undefined ? [] : parseRulings(text)
  })
  next.marks = marks.flat()
  next.askMarks = asked.flat()
  try {
    next.consults = await readConsults(root)
    next.asks = await readAsks(root)
  } catch (e) {
    next.errors.push(`consult を読めません: ${(e as Error).message}`)
  }
  await one('cockpit/firstseen.json', '', (text) => {
    const v: unknown = text === undefined ? {} : JSON.parse(text)
    next.firstSeen = typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === 'string')) as Record<string, string> : {}
  })
  await one('cockpit/taskseen.json', '', (text) => {
    next.taskSeen = text === undefined ? {} : parseTaskSeen(JSON.parse(text))
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
  return appendOpOnce(root, cockpit, input).then((r) => r.log)
}

/** 追記して、追記した操作を返す。同じ協議の重なりで追記を省いたときは added が無い（合図を送るのは追記した呼び出しだけ）。 */
export function appendOpOnce(root: string, cockpit: Cockpit | undefined, input: OpInput): Promise<{ log: UserLog; added?: Op }> {
  if (input.root !== root) return Promise.reject(conflict('表示中のワークスペースが変わりました。もう一度押してください'))
  const run = (writing.get(root) ?? Promise.resolve()).then(() => write(root, cockpit, input))
  writing.set(root, run.catch(() => undefined))
  return run
}

async function write(root: string, _shown: Cockpit | undefined, { root: _root, ...input }: OpInput): Promise<{ log: UserLog; added?: Op }> {
  const release = await lockLog(root)
  try {
    // 画面が持つ中身は古いことがある（窓口が書き換えた直後・版 1 に戻した直後）。押した瞬間のファイルで確かめる。
    const cockpit = await readCockpit(root)
    const text = await readInOrca(root, '.orca/cockpit.user.json')
    const log = text === undefined ? { ops: [] } : parseUserLog(text)
    check(cockpit, log, input)
    // 同じ相手（同じタブか、どちらも窓口・担当）との本文の無い協議は 1 回だけ記録する（連打や、consult が開いているタブを前に出した 2 回目）。
    // ロックの中の最新のログで見る。本文つきの修正依頼は別の操作として残す。
    if (input.type === 'talk' && !input.text?.trim()) {
      const last = lastTalk(log, input.item_id, input.item_rev)
      if (last && !last.text?.trim() && last.terminal === input.terminal) return { log }
    }
    if (input.type === 'ask_decide') {
      const memo = await readInOrca(root, `.orca/consult/ask-${input.item_id.slice('#ask:'.length)}.md`).catch(() => undefined)
      const entries = parseAskMemo(memo ?? '').entries
      const ans = latestAnswer(entries)
      if (!ans || ans.n !== input.answer?.n || ans.at !== input.answer.at || ans.head !== input.answer.head) throw conflict('答えが変わりました。読み直してからもう一度押してください')
      if (input.choice !== undefined && !latestChoices(entries).some((c) => c.key === input.choice)) throw conflict(`この答えに案 ${input.choice} がありません。読み直してからもう一度押してください`)
      if (lastAskDecide(log, input.item_id, input.answer, input)) return { log }
    }
    const added = nextOp(log, { at: new Date().toISOString(), ...input })
    log.ops.push(added)
    await writeAtomic(path.join(root, '.orca', 'cockpit.user.json'), JSON.stringify(log, null, 2) + '\n')
    return { log, added }
  } finally {
    await release()
  }
}

/** 同じ答えに同じ返し方（同じ案・同じ文、どちらも無い古い形）で返した、取り消されていない最後の op。違う案・違う文は別の op にする。 */
export function lastAskDecide(log: UserLog, item: string, answer: AskAnswer, how: Pick<Op, 'choice' | 'text'> = {}): Op | undefined {
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  return log.ops.filter((o) => o.type === 'ask_decide' && o.item_id === item && !undone.has(o.op_id) && o.answer?.n === answer.n && o.answer?.at === answer.at
    && (o.choice ?? null) === (how.choice ?? null) && (o.text?.trim() || null) === (how.text?.trim() || null)).at(-1)
}

/** カードのその版への、取り消されていない最新の協議。 */
function lastTalk(log: UserLog, item: string, rev: number): Op | undefined {
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  return log.ops.filter((o) => o.type === 'talk' && o.item_id === item && o.item_rev === rev && !undone.has(o.op_id)).at(-1)
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
  // 「前にも言った」はワークスペース全体への合図で、カードを持たない。
  if (input.type === 'repeat') {
    if (input.item_id !== '') throw invalid('「前にも言った」はカードに付けません')
    return
  }
  // 整理・棚卸しの指示（r132）もカードを持たない。種類は既定の 3 つか無し（自由な指示）で、文は必ず要る。
  if (input.type === 'tidy') {
    if (input.item_id !== '' || input.item_rev !== 0) throw invalid('整理・棚卸しの指示はカードに付けません')
    if (input.option_id !== undefined && !TIDY_KINDS.includes(input.option_id as TidyKind)) throw invalid('整理・棚卸しの種類の形が違います')
    if (!(typeof input.text === 'string' && input.text.trim())) throw invalid('指示の文を書いてください')
    const bad = textError(input.text)
    if (bad) throw invalid(bad)
    return
  }
  const tidy = input.type === 'undo' && input.item_id === '' ? log.ops.find((o) => o.op_id === input.undo_of && o.type === 'tidy') : undefined
  if (tidy) {
    // 猶予を過ぎた指示は窓口が実行しているかもしれないので、取り消した印だけを残さない（cockpit skill の references/tidy.md）。
    if (Date.now() > Date.parse(tidy.at) + UNDO_GRACE_MS) throw conflict('窓口に送った指示は取り消せません。止めるなら窓口に伝えてください')
    return
  }
  if (input.type === 'answer') {
    if (!isAnswerItem(input.item_id) || !Number.isInteger(input.item_rev)) throw invalid('窓から答えられるのは停止の行と一緒に作る仕事の行だけです')
    if (!(typeof input.text === 'string' && input.text.trim())) throw invalid('答えの文がありません')
    if (!ANSWER_VIA.includes(input.via!)) throw invalid('届け方の形が違います')
    if (!Array.isArray(input.to) || !input.to.length || !input.to.every((x) => typeof x === 'string' && x)) throw invalid('届け先の形が違います')
    if (input.key !== undefined && !(Number.isInteger(input.key) && input.key > 0)) throw invalid('端末に送った番号の形が違います')
    const bad = textError(input.text)
    if (bad) throw invalid(bad)
    return
  }
  if (input.type === 'ask_decide' || isAskItem(input.item_id)) {
    if (input.type === 'undo' && log.ops.some((o) => o.op_id === input.undo_of && o.type === 'ask_decide' && o.item_id === input.item_id)) return
    if (input.type !== 'ask_decide' || !isAskItem(input.item_id) || input.item_rev !== 0) throw invalid('窓からの質問に返せるのは「これで決める」だけです')
    const a = input.answer
    if (!a || typeof a.at !== 'string' || !/^\d{1,2}:\d{2}$/.test(a.at) || typeof a.head !== 'string' || a.head.length > 80 || !Number.isInteger(a.n) || a.n < 1) throw invalid('どの答えで決めるかの形が違います')
    if (input.choice !== undefined && !(typeof input.choice === 'string' && /^[A-Z]$/.test(input.choice))) throw invalid('案の記号の形が違います')
    if (input.choice !== undefined && input.text !== undefined) throw invalid('案を選ぶか文を書くかのどちらかで返してください')
    if (input.text !== undefined && !(typeof input.text === 'string' && input.text.trim())) throw invalid('窓口に返す文を書いてください')
    const bad = textError(input.text)
    if (bad) throw invalid(bad)
    return
  }
  // Orca から作った詰まりは帳簿に無い。受けるのは「済ませた」（版は止まった時刻）と、その取り消しだけ。
  if (isSynthetic(input.item_id)) {
    if (input.type === 'dismiss' && dismissable({ id: input.item_id, rev: input.item_rev }) && Number.isInteger(input.item_rev)) return
    if (input.type === 'undo' && log.ops.some((o) => o.op_id === input.undo_of && o.type === 'dismiss' && o.item_id === input.item_id)) return
    throw invalid('Orca から作った詰まりに返せるのは「済ませた」だけです')
  }
  if (input.type === 'dismiss') throw invalid('「済ませた」で隠せるのは Orca から作った詰まりだけです')
  const card = cockpit.cards.find((c) => c.id === input.item_id)
  if (!card) throw invalid(`カード ${input.item_id} がありません`)
  // 担当が書き換えたあとの古い画面で押した操作は、新しい版に効かせない。
  if (input.type !== 'undo' && card.rev !== input.item_rev) throw conflict(`「${card.title}」は担当が書き換えました。読み直してからもう一度押してください`)
  // 片付いた・顧客待ち・決めて受け取り待ちのカードに、もう一度片付ける操作を重ねない（ログと状態が食い違うため）。
  const status = overlay(cockpit, log).find((v) => v.card.id === card.id)?.status
  if (CLOSING.has(input.type) && (status === 'closed' || status === 'waiting')) throw conflict(`「${card.title}」はもう片付いています`)
  const bad = textError(input.text)
  if (bad) throw invalid(bad)
  if (card.kind === 'permit' && card.manual && (input.type === 'decide' || input.type === 'accept' || input.type === 'delegate')) throw invalid(`「${card.title}」は手作業の頼みです。済ませたら「済ませた」を押してください`)
  if (input.type === 'decide' && input.option_id === OTHER && !input.text?.trim()) throw invalid('別の答えを書いてください')
  if (input.type === 'decide' && input.option_id !== OTHER && !card.options?.some((o) => o.id === input.option_id))
    throw invalid(`${KIND_LABEL[card.kind]}「${card.title}」に選択肢 ${String(input.option_id)} がありません`)
  if (input.type === 'revert' && (input.target === undefined || !card.done?.[input.target])) throw invalid('戻す項目がありません')
  if (input.type === 'undo' && input.undo_of === undefined) throw invalid('取り消す操作がありません')
}

/** cockpit.user.json への追記と、移し替え（window/migrate.ts）が同じロックを取る。 */
export const lockLog = (root: string) => lock(path.join(root, '.orca', 'cockpit.user.json.lock'))
/** cockpit.json を書く道具（window/write.ts）と移し替え（migrate-v3）が取るロック。 */
export const lockCockpit = (root: string) => lock(path.join(root, '.orca', 'cockpit.json.lock'))
/** 郵便受けの控え（dir/mailbox.json）を決めるロック。窓と cockpit-mail が取る。 */
// 持っている間に orca を 2 回（terminal list・create、各 15 秒まで）呼ぶので、待ちと古いと見なすまでをそれより長くとる（生きている持ち主のロックを奪わない）。
export const lockMailbox = (dir: string) => lock(path.join(dir, 'mailbox.json.lock'), 60_000, 45_000)

/**
 * パネルの worker と窓の常駐のプロセスは別のプロセスなので、同じログへの追記をロックファイルで 1 つずつにする
 * （同時に読んで同じ op_id を付け、後の rename が先の操作を消すのを防ぐ）。落ちたプロセスが残したロックは 10 秒で外す。
 */
async function lock(file: string, staleMs = 10_000, waitMs = 3_000): Promise<() => Promise<void>> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      await (await fsp.open(file, 'wx')).close()
      return () => fsp.rm(file, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const age = Date.now() - ((await fsp.stat(file).catch(() => null))?.mtimeMs ?? Date.now())
      if (age > staleMs) await fsp.rm(file, { force: true })
      else if (i > waitMs / 20) throw conflict('ほかの画面が記録中です。もう一度押してください')
      else await new Promise((r) => setTimeout(r, 20))
    }
  }
}

/** 窓口の Run に orchestration の知らせを送る（郵便受けの端末を送り手にする。window/mail.ts）。 */
export type SendRun = (runId: string, subject: string, body: string) => Promise<NotifyResult>

export function runSignalBody(cockpit: Cockpit, ops: Op[]): string {
  const said = ops.filter(saidOp).at(-1)
  const text = said?.text?.trim()
  return [`${cockpit.workspace.name} の操縦席の窓から: ${signalText(ops)}`, ...(text ? ['', '書いた文（全文）:', text] : []), '', '未反映の操作を cockpit skill の手順で反映してください。'].join('\n')
}

/**
 * 窓口に合図を送る。端末の窓口にもチャットの窓口にも、main.run_id の Run への orchestration の知らせ 1 本で送る（R191）。
 * ops は signalPlan の due（送る時機の来た操作だけ）。送れたら、その最後の op_id を返す。
 */
export async function notifyMain(cockpit: Cockpit | undefined, ops: Op[], sendRun: SendRun): Promise<NotifyResult & { lastOp?: number }> {
  const run = cockpit?.main?.run_id
  if (!cockpit || !run) return { sent: false, reason: 'cockpit.json の main に run_id がありません' }
  try {
    const r = await sendRun(run, SIGNAL, runSignalBody(cockpit, ops))
    if (!r.sent) return r
  } catch (e) {
    return { sent: false, reason: (e as Error).message }
  }
  return { sent: true, lastOp: ops.reduce((n, o) => Math.max(n, o.op_id), 0) || undefined }
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
 * 未反映どうしの取り消しの組は除く。話したいも同じく猶予のあとに送る（本文の頭を合図に載せる）。送るのは窓の常駐のプロセスだけ。
 */
export function signalPlan(c: Cockpit, log: UserLog, notified: number, now: number): { due: Op[]; nextAt?: number } {
  const un = unappliedOps(c, log)
  const cancelled = new Set(un.filter((o) => o.type === 'undo' && un.some((x) => x.op_id === o.undo_of)).flatMap((o) => [o.op_id, o.undo_of!]))
  const due: Op[] = []
  let nextAt: number | undefined
  let held = Infinity
  for (const o of un) {
    // 「これで決める」は返しが届いてから窓口が反映するので、窓口の本線に合図を送らない（返しは hook が窓口の Run に知らせる。R105）。
    if (o.op_id <= notified || cancelled.has(o.op_id) || o.type === 'ask_decide' || (o.type === 'undo' && un.some((x) => x.op_id === o.undo_of && x.type === 'ask_decide'))) continue
    const at = Date.parse(o.at) + UNDO_GRACE_MS
    if (at <= now) due.push(o)
    else {
      nextAt = Math.min(nextAt ?? Infinity, at)
      held = Math.min(held, o.op_id)
    }
  }
  // 送った位置は op_id の 1 つの数で持つので、猶予中の操作より後の操作は、その操作と一緒に送る（先に送ると猶予中の操作を飛ばす）。
  return { due: due.filter((o) => o.op_id < held), nextAt }
}

/** どの操作までメインに知らせたか（~/Library/Application Support/cockpit/notified.json。送るのは窓だけ）。 */
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
  // 案件ごとの位置を 1 つのファイルに持つので、窓の案件どうしが同時に書くと先の書き込みが消える。
  const release = await lock(`${file}.lock`)
  try {
    let v: Record<string, number> = {}
    try {
      v = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      // 無い・壊れているときは作り直す（失うのは「どこまで知らせたか」だけで、もう一度合図が届くだけ）。
    }
    v[root] = Math.max(v[root] ?? 0, op)
    await writeAtomic(file, JSON.stringify(v) + '\n')
  } finally {
    await release()
  }
}

/**
 * 窓が consult --ask で立てた質問のタブの端末（窓の置き場所の asktabs.json、案件ごとに 質問 id → handle）。
 * 自動で閉じるのは、題が合い、かつここに記録した handle の端末だけ（同じ題で人が開いたタブを閉じない。Codex 36 重大 1）。
 */
export async function readAskTabs(dir: string): Promise<Record<string, Record<string, string>>> {
  try {
    const v = JSON.parse(await fsp.readFile(path.join(dir, 'asktabs.json'), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) {
    // 無い・壊れたものは空から作り直す（失うのは自動で閉じる記録だけ）。読めなかったときは、書き込みで他の案件の記録を消さないよう投げる。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return {}
    throw e
  }
}

export async function writeAskTab(dir: string, root: string, id: string, handle: string | null): Promise<void> {
  const file = path.join(dir, 'asktabs.json')
  const release = await lock(`${file}.lock`)
  try {
    const v = await readAskTabs(dir)
    const mine = (v[root] ??= {})
    if (handle) mine[id] = handle
    else delete mine[id]
    await writeAtomic(file, JSON.stringify(v) + '\n')
  } finally {
    await release()
  }
}

/**
 * 窓が質問のタブに「返しを書いて（op n）」を届けた op（窓の置き場所の asksent.json、案件ごとに op_id の並び）。
 * 届けられなかった op を窓が送り直すときに、同じ op を 2 回送らないために読む。
 */
export async function readAskSent(dir: string): Promise<Record<string, number[]>> {
  try {
    const v = JSON.parse(await fsp.readFile(path.join(dir, 'asksent.json'), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) {
    // 無い・壊れたものは空から作り直す（失うのは届けた記録だけで、返しの無い op にもう一度知らせが届くだけ）。読めなかったときは、書き込みで他の案件の記録を消さないよう投げる。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return {}
    throw e
  }
}

export async function addAskSent(dir: string, root: string, op: number): Promise<void> {
  const file = path.join(dir, 'asksent.json')
  const release = await lock(`${file}.lock`)
  try {
    const v = await readAskSent(dir)
    const mine = Array.isArray(v[root]) ? v[root] : []
    if (!mine.includes(op)) v[root] = [...mine, op]
    await writeAtomic(file, JSON.stringify(v) + '\n')
  } finally {
    await release()
  }
}

/** 「path:12」を ファイルと行に分ける。行の無いパスと、名前に : を含むだけのパスはそのまま。 */
export function splitLine(href: string): { file: string; line?: number } {
  const m = /^(.*\S):(\d+)$/.exec(href)
  return m ? { file: m[1]!, line: Number(m[2]) } : { file: href }
}

/**
 * at も created_at も無い開いたカードに、最初に見つけた時刻を付けて .orca/cockpit/firstseen.json に書く（窓の常駐のプロセスだけが呼ぶ）。
 * 片付いたカードの分は消す。書き足すものが無ければ書かない。
 */
export async function recordFirstSeen(root: string, files: Files, now: number): Promise<Record<string, string>> {
  const open = (files.cockpit?.cards ?? []).filter((c) => c.state === 'open' && !c.at)
  const next = Object.fromEntries(open.map((c) => [c.id, files.firstSeen[c.id] ?? new Date(now).toISOString()]))
  const same = Object.keys(next).length === Object.keys(files.firstSeen).length && Object.entries(next).every(([k, v]) => files.firstSeen[k] === v)
  if (!same) await writeAtomic(path.join(root, '.orca', 'cockpit', 'firstseen.json'), JSON.stringify(next, null, 1) + '\n')
  return next
}

const parseTaskSeen = (v: unknown): TaskSeen =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, { sig: string; at: string }] => typeof e[1]?.sig === 'string' && typeof e[1]?.at === 'string' && Number.isFinite(Date.parse(e[1].at))))
    : {}

/**
 * 済んでいないタスクの中身が変わった時刻を .orca/cockpit/taskseen.json に覚える（窓の常駐のプロセスだけが呼ぶ）。帳簿のタスクに更新の時刻が無いため。
 * 初めて見たタスクは今の時刻にする（入れた直後に古いタスクを全部放置と出さない）。済んだタスクの分は消す。変わりが無ければ書かない。
 */
export async function recordTaskSeen(root: string, files: Files, now: number): Promise<TaskSeen> {
  const live = (files.cockpit?.tasks ?? []).filter((t) => t.state !== 'ok')
  const next: TaskSeen = Object.fromEntries(live.map((t) => {
    const sig = taskSig(t)
    const old = files.taskSeen[t.id]
    return [t.id, old?.sig === sig ? old : { sig, at: new Date(now).toISOString() }]
  }))
  const same = Object.keys(next).length === Object.keys(files.taskSeen).length && Object.entries(next).every(([k, v]) => files.taskSeen[k] === v)
  if (!same) await writeAtomic(path.join(root, '.orca', 'cockpit', 'taskseen.json'), JSON.stringify(next, null, 1) + '\n')
  return next
}
